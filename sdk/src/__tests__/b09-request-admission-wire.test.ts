import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { userMessage } from '@codebuff/common/util/messages'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

import { promptAiSdkStream } from '../impl/llm'
import { providerContextFor, silentLogger } from './fixtures/fake-llm-server'
import {
  centsToUsdMicros,
  createRequestAdmissionStore,
} from '../services/request-admission-store'

import type { LlmHostDeps } from '../impl/llm'
import type { SpendingPolicy } from '@codebuff/common/types/request-admission'

const strictPolicy: SpendingPolicy = {
  mode: 'strict-capped',
  capCents: 0.5,
  currency: 'USD',
}
const estimatedPolicy: SpendingPolicy = {
  mode: 'estimated-capped',
  capCents: 0.5,
  currency: 'USD',
  estimator: {
    id: 'wire-fixed-v1',
    reservationCents: 0.3,
    maxConcurrentAttempts: 2,
  },
}

function streamResponse(params?: {
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}): Response {
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  return new Response(
    data({
      id: 'admission-wire',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'ok' },
          finish_reason: null,
        },
      ],
    }) +
      data({
        id: 'admission-wire',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }) +
      (params?.usage
        ? data({ id: 'admission-wire', choices: [], usage: params.usage })
        : '') +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

async function consumeRequest(params: {
  context: ReturnType<typeof providerContextFor>['context']
  store?: ReturnType<typeof createRequestAdmissionStore>
  authorityId?: string
  policy?: SpendingPolicy
  runId: string
  messages?: Message[]
  maxRetries?: number
  retryPolicy?: {
    maxRetries: number
    baseDelayMs: number
    maxDelayMs: number
    jitterFraction: number
    maxTotalDelayMs: number
    retryAfterMaxDelayMs: number
  }
}): Promise<void> {
  const deps = {
    providerContext: params.context,
    ...(params.store ? { requestAdmission: params.store } : {}),
  } as LlmHostDeps
  for await (const _chunk of promptAiSdkStream(
    {
      apiKey: 'fixture',
      runId: params.runId,
      clientSessionId: 'admission-wire',
      fingerprintId: 'admission-wire',
      userInputId: 'admission-wire',
      agentId: 'fixture',
      userId: undefined,
      messages: params.messages ?? [userMessage({ content: 'Say ok.' })],
      signal: new AbortController().signal,
      logger: silentLogger,
      trackEvent() {},
      sendAction() {},
      maxRetries: params.maxRetries ?? 0,
      ...(params.retryPolicy ? { retryPolicy: params.retryPolicy } : {}),
      ...(params.policy ? { spendingPolicy: params.policy } : {}),
      ...(params.authorityId
        ? { requestAdmissionAuthorityId: params.authorityId }
        : {}),
    } as Parameters<typeof promptAiSdkStream>[0],
    deps,
  )) {
  }
}

describe('B09 provider request admission wire', () => {
  let directory: string
  const cleanups: Array<() => void> = []

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-request-admission-wire-'),
    )
  })

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  function configuredContext(fetchImpl: typeof fetch) {
    const previousFetch = globalThis.fetch
    globalThis.fetch = fetchImpl
    cleanups.push(() => {
      globalThis.fetch = previousFetch
    })
    const fixture = providerContextFor({
      defaultModel: 'fixture/model',
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: 'https://fixture.example/v1',
          models: ['model'],
          defaultCapabilities: {
            context: { windowTokens: 1_000, outputTokens: 100 },
            pricing: {
              inputPerMillionTokens: 3,
              outputPerMillionTokens: 15,
              currency: 'USD',
            },
          },
        },
      },
    })
    cleanups.push(fixture.cleanup)
    return fixture.context
  }

  test('missing usage keeps the strict reservation held and refuses the next request before HTTP dispatch', async () => {
    let requests = 0
    const context = configuredContext(
      Object.assign(
        async () => {
          requests++
          return streamResponse()
        },
        { preconnect: globalThis.fetch.preconnect },
      ) as typeof fetch,
    )
    const store = createRequestAdmissionStore({ directory })
    store.initialize({ authorityId: 'strict-held', policy: strictPolicy })

    await consumeRequest({
      context,
      store,
      authorityId: 'strict-held',
      policy: strictPolicy,
      runId: 'root',
    })
    expect(store.snapshot('strict-held')).toMatchObject({
      heldUsdMicros: centsToUsdMicros(0.45),
      reconciledUsdMicros: 0,
      activeAttempts: 0,
      attempts: [{ state: 'held-inactive', incompleteReason: 'missing-usage' }],
    })
    await expect(
      consumeRequest({
        context,
        store,
        authorityId: 'strict-held',
        policy: strictPolicy,
        runId: 'child',
      }),
    ).rejects.toMatchObject({ code: 'request_spend_refused' })
    expect(requests).toBe(1)
  })

  test('late complete usage reconciles one reservation and records local pricing provenance', async () => {
    let requests = 0
    const context = configuredContext(
      Object.assign(
        async () => {
          requests++
          return streamResponse({
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          })
        },
        { preconnect: globalThis.fetch.preconnect },
      ) as typeof fetch,
    )
    const store = createRequestAdmissionStore({ directory })
    store.initialize({ authorityId: 'late-usage', policy: strictPolicy })

    await consumeRequest({
      context,
      store,
      authorityId: 'late-usage',
      policy: strictPolicy,
      runId: 'root',
    })
    expect(requests).toBe(1)
    expect(store.snapshot('late-usage')).toMatchObject({
      heldUsdMicros: 0,
      reconciledUsdMicros: centsToUsdMicros(0.0018),
      attempts: [
        {
          state: 'reconciled',
          provenance: 'usage-plus-configured-pricing',
        },
      ],
    })
  })

  test('two concurrent descendants share one atomic strict balance', async () => {
    let requests = 0
    const context = configuredContext(
      Object.assign(
        async () => {
          requests++
          await Bun.sleep(30)
          return streamResponse()
        },
        { preconnect: globalThis.fetch.preconnect },
      ) as typeof fetch,
    )
    const store = createRequestAdmissionStore({ directory })
    store.initialize({ authorityId: 'siblings', policy: strictPolicy })

    const outcomes = await Promise.allSettled([
      consumeRequest({
        context,
        store,
        authorityId: 'siblings',
        policy: strictPolicy,
        runId: 'child-a',
      }),
      consumeRequest({
        context,
        store,
        authorityId: 'siblings',
        policy: strictPolicy,
        runId: 'child-b',
      }),
    ])
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1)
    expect(requests).toBe(1)
  })

  test('mixed-window failover trims and reserves against the same conservative window', async () => {
    const originalMessages = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0
        ? userMessage({ content: `user-${index}-${'x'.repeat(1_000)}` })
        : ({
            role: 'assistant' as const,
            content: [
              {
                type: 'text' as const,
                text: `assistant-${index}-${'y'.repeat(1_000)}`,
              },
            ],
          } satisfies Message),
    )
    const captured: Array<Record<string, unknown>> = []
    const previousFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init)
        const body = (await request.clone().json()) as Record<string, unknown>
        captured.push(body)
        if (body.model === 'primary')
          return new Response('primary unavailable', { status: 503 })
        return streamResponse({
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
      { preconnect: previousFetch.preconnect },
    ) as typeof fetch
    cleanups.push(() => {
      globalThis.fetch = previousFetch
    })
    const fixture = providerContextFor({
      defaultModel: 'fixture/primary',
      failoverModels: ['fixture/backup'],
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: 'https://fixture.example/v1',
          models: ['primary', 'backup'],
          modelCapabilities: {
            primary: {
              context: { windowTokens: 3_000, outputTokens: 100 },
              pricing: {
                inputPerMillionTokens: 0.1,
                outputPerMillionTokens: 1,
                currency: 'USD',
              },
            },
            backup: {
              context: { windowTokens: 10_000, outputTokens: 100 },
              pricing: {
                inputPerMillionTokens: 0.1,
                outputPerMillionTokens: 1,
                currency: 'USD',
              },
            },
          },
        },
      },
    })
    cleanups.push(fixture.cleanup)
    const policy: SpendingPolicy = {
      mode: 'strict-capped',
      capCents: 0.1,
      currency: 'USD',
    }
    const store = createRequestAdmissionStore({ directory })
    store.initialize({ authorityId: 'mixed-window', policy })

    await consumeRequest({
      context: fixture.context,
      store,
      authorityId: 'mixed-window',
      policy,
      runId: 'root',
      messages: originalMessages,
      retryPolicy: {
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterFraction: 0,
        maxTotalDelayMs: 0,
        retryAfterMaxDelayMs: 0,
      },
    })
    expect(captured.map((body) => body.model)).toEqual(['primary', 'backup'])
    const backupMessages = captured[1]?.messages as unknown[]
    expect(backupMessages.length).toBeLessThan(originalMessages.length)
    expect(store.snapshot('mixed-window')).toMatchObject({
      heldUsdMicros: centsToUsdMicros(0.04),
    })
  })

  test('failed first attempt keeps its reservation and cannot obtain an uncapped retry', async () => {
    let requests = 0
    const context = configuredContext(
      Object.assign(
        async () => {
          requests++
          return new Response('overloaded', { status: 503 })
        },
        { preconnect: globalThis.fetch.preconnect },
      ) as typeof fetch,
    )
    const store = createRequestAdmissionStore({ directory })
    store.initialize({ authorityId: 'retry-held', policy: strictPolicy })

    await expect(
      consumeRequest({
        context,
        store,
        authorityId: 'retry-held',
        policy: strictPolicy,
        runId: 'root',
        maxRetries: 1,
        retryPolicy: {
          maxRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterFraction: 0,
          maxTotalDelayMs: 0,
          retryAfterMaxDelayMs: 0,
        },
      }),
    ).rejects.toMatchObject({ code: 'request_spend_refused' })
    expect(requests).toBe(1)
    expect(store.snapshot('retry-held')).toMatchObject({
      heldUsdMicros: centsToUsdMicros(0.45),
      activeAttempts: 0,
    })
  })

  test('estimated-capped explicitly admits an unknown-price route with degraded provenance', async () => {
    let requests = 0
    const previousFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async () => {
        requests++
        return streamResponse()
      },
      { preconnect: previousFetch.preconnect },
    ) as typeof fetch
    cleanups.push(() => {
      globalThis.fetch = previousFetch
    })
    const fixture = providerContextFor({
      defaultModel: 'fixture/model',
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: 'https://fixture.example/v1',
          models: ['model'],
        },
      },
    })
    cleanups.push(fixture.cleanup)
    const store = createRequestAdmissionStore({ directory })
    store.initialize({ authorityId: 'estimated', policy: estimatedPolicy })

    await consumeRequest({
      context: fixture.context,
      store,
      authorityId: 'estimated',
      policy: estimatedPolicy,
      runId: 'root',
    })
    expect(requests).toBe(1)
    expect(store.snapshot('estimated')).toMatchObject({
      degraded: true,
      heldUsdMicros: centsToUsdMicros(0.3),
      attempts: [
        {
          state: 'held-inactive',
          basis: {
            kind: 'estimated-reservation',
            estimatorId: 'wire-fixed-v1',
          },
        },
      ],
    })
  })

  test('uncapped remains usable without an admission store or known pricing', async () => {
    let requests = 0
    const previousFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async () => {
        requests++
        return streamResponse()
      },
      { preconnect: previousFetch.preconnect },
    ) as typeof fetch
    cleanups.push(() => {
      globalThis.fetch = previousFetch
    })
    const fixture = providerContextFor({
      defaultModel: 'fixture/model',
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: 'https://fixture.example/v1',
          models: ['model'],
        },
      },
    })
    cleanups.push(fixture.cleanup)
    await consumeRequest({ context: fixture.context, runId: 'uncapped' })
    expect(requests).toBe(1)
  })
})
