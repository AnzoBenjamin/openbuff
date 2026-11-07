import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as ai from 'ai'

import { getErrorStatusCode } from '../error-utils'
import { classifyRetryableError } from '../retry-config'
import {
  getModelForRequest,
  resolveModelContextWindow,
  resolveModelContextWindows,
} from '../impl/model-provider'
import { promptAiSdkStream } from '../impl/llm'
import { clearProviderConfigCacheForTest } from '../provider-config'
import * as credentials from '../credentials'
import * as routing from '../impl/model-provider'
import { OpenAICompatibleChatLanguageModel } from '@codebuff/internal/openai-compatible/index'

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
  clearProviderConfigCacheForTest()
})

function configure(value: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b08-provider-contract-'))
  const file = path.join(root, 'provider.json')
  fs.writeFileSync(file, JSON.stringify(value))
  const previous = process.env.OPENBUFF_PROVIDER_CONFIG
  process.env.OPENBUFF_PROVIDER_CONFIG = file
  cleanup.push(() => {
    if (previous === undefined) delete process.env.OPENBUFF_PROVIDER_CONFIG
    else process.env.OPENBUFF_PROVIDER_CONFIG = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
  clearProviderConfigCacheForTest()
}

const sse = (events: unknown[], headers: Record<string, string> = {}) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream', ...headers } },
  )
const logger = { debug() {}, info() {}, warn() {}, error() {} }

describe('[B08] actual provider contracts', () => {
  test('retains wrapped HTTP status without accepting prose or nonfinite values', () => {
    const error = Object.assign(new Error('Retry wrapper'), {
      lastError: Object.assign(new Error('Unavailable'), { statusCode: 503 }),
    })
    expect(getErrorStatusCode(error)).toBe(503)
    const cyclic: { cause?: unknown; lastError?: unknown } = {}
    cyclic.cause = cyclic
    cyclic.lastError = { statusCode: 429 }
    expect(getErrorStatusCode(cyclic)).toBe(429)
    expect(getErrorStatusCode({ statusCode: Infinity })).toBeUndefined()
    expect(getErrorStatusCode(new Error('503 unavailable'))).toBeUndefined()
  })

  test('an abort with a retryable cause is never retried', () => {
    const error = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      cause: { statusCode: 503 },
    })
    expect(classifyRetryableError(error)).toEqual({ retryable: false })
  })

  test('context metadata resolves healthy primary and dormant backup without missing-key validation', () => {
    const envName = 'B08_UNSELECTED_MISSING_API_KEY'
    const previous = process.env[envName]
    delete process.env[envName]
    cleanup.push(() => {
      if (previous !== undefined) process.env[envName] = previous
    })
    configure({
      defaultModel: 'primary/model',
      failoverModels: ['backup/model'],
      providers: {
        primary: {
          type: 'openai-compatible',
          baseURL: 'https://primary.b08.invalid/v1',
          models: ['model'],
          defaultCapabilities: { context: { windowTokens: 200000 } },
        },
        backup: {
          type: 'openai-compatible',
          baseURL: 'https://backup.b08.invalid/v1',
          models: ['model'],
          apiKeyEnv: envName,
          defaultCapabilities: { context: { windowTokens: 32000 } },
        },
      },
    })
    expect(resolveModelContextWindow({ agentId: 'fixture' })).toBe(200000)
    expect(resolveModelContextWindows({ agentId: 'fixture' })).toEqual({
      primary: 200000,
      failoverFloor: 32000,
    })
  })

  test('configured OAuth skip selects BYOK backup without touching excluded credentials', async () => {
    configure({
      defaultModel: 'codex/gpt-5.5',
      failoverModels: ['local/model'],
      providers: {
        codex: { type: 'chatgpt-oauth', models: ['gpt-5.5'] },
        local: {
          type: 'openai-compatible',
          baseURL: 'https://backup.b08.invalid/v1',
          models: ['model'],
        },
      },
    })
    const credentialGetter = spyOn(
      credentials,
      'getValidChatGptOAuthCredentials',
    ).mockImplementation(async () => {
      throw new Error('Excluded OAuth credential getter was invoked')
    })
    cleanup.push(() => credentialGetter.mockRestore())
    const selected = await getModelForRequest({
      apiKey: '',
      agentId: 'fixture',
      skipChatGptOAuth: true,
    })
    expect(selected.isChatGptOAuth).toBe(false)
    expect(selected.effectiveModel).toBe('local/model')
    expect(credentialGetter).not.toHaveBeenCalled()
  })

  test('actual configured arbitrary provider sends selected reasoning effort', async () => {
    configure({
      defaultModel: 'custom-gateway/model',
      defaultReasoningEffort: 'high',
      providers: {
        'custom-gateway': {
          type: 'openai-compatible',
          baseURL: 'https://reasoning.b08.invalid/v1',
          models: ['model'],
          defaultCapabilities: {
            reasoning: { supported: true, efforts: ['high', 'medium', 'low'] },
          },
        },
      },
    })
    const previous = globalThis.fetch
    let body: Record<string, unknown> | undefined
    globalThis.fetch = Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body))
        return sse([
          {
            choices: [{ delta: { content: 'healthy' }, finish_reason: 'stop' }],
          },
        ])
      },
      previous,
    )
    cleanup.push(() => {
      globalThis.fetch = previous
    })
    const chunks = []
    for await (const chunk of promptAiSdkStream({
      apiKey: 'fixture',
      runId: 'b08',
      clientSessionId: 'b08',
      fingerprintId: 'b08',
      userInputId: 'b08',
      userId: undefined,
      agentId: 'fixture',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'fixture' }] },
      ],
      signal: new AbortController().signal,
      maxRetries: 0,
      logger,
      trackEvent() {},
      sendAction() {},
      onError() {},
    } as never))
      chunks.push(chunk)
    expect(chunks.some((chunk) => chunk.type === 'text')).toBe(true)
    expect(body?.reasoning_effort).toBe('high')
  })

  test('actual SSE error keeps typed status, provider code and response headers', async () => {
    const model = new OpenAICompatibleChatLanguageModel('model', {
      provider: 'custom-gateway',
      headers: () => ({}),
      url: () => 'https://sse.b08.invalid/v1/chat/completions',
      fetch: Object.assign(
        async () =>
          sse(
            [
              {
                error: {
                  message: 'Upstream unavailable',
                  status: '503',
                  code: 'upstream_error',
                },
              },
            ],
            { 'retry-after': '9' },
          ),
        globalThis.fetch,
      ),
    })
    const result = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
    })
    const reader = result.stream.getReader()
    let observed: unknown
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (next.value.type === 'error') observed = next.value.error
    }
    expect(getErrorStatusCode(observed)).toBe(503)
    expect(observed).toMatchObject({
      code: 'upstream_error',
      responseHeaders: { 'retry-after': '9' },
    })
  })

  test('retry metadata names the actual configured vision route', async () => {
    configure({
      defaultModel: 'primary/model',
      visionModel: 'vision/model',
      providers: {
        primary: {
          type: 'openai-compatible',
          baseURL: 'https://primary.b08.invalid/v1',
          models: ['model'],
          defaultCapabilities: { input: { image: false } },
        },
        vision: {
          type: 'openai-compatible',
          baseURL: 'https://reasoning.b08.invalid/v1',
          models: ['model'],
          defaultCapabilities: { input: { image: true } },
        },
      },
    })
    const original = routing.getModelForRequest
    const routeSpy = spyOn(routing, 'getModelForRequest').mockImplementation(
      (input) => original({ ...input, requiresVision: true }),
    )
    cleanup.push(() => routeSpy.mockRestore())
    const previous = globalThis.fetch
    let attempts = 0
    globalThis.fetch = Object.assign(async (url: unknown) => {
      expect(String(url)).toContain('reasoning.b08.invalid')
      return ++attempts === 1
        ? new Response(JSON.stringify({ error: { message: 'unavailable' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        : sse([
            {
              choices: [
                { delta: { content: 'healthy' }, finish_reason: 'stop' },
              ],
            },
          ])
    }, previous)
    cleanup.push(() => {
      globalThis.fetch = previous
    })
    const statuses: Array<{
      action: { chunk: { type: string; model?: string; status?: string } }
    }> = []
    for await (const _chunk of promptAiSdkStream({
      apiKey: '',
      runId: 'b08',
      clientSessionId: 'b08',
      fingerprintId: 'b08',
      userInputId: 'b08',
      userId: undefined,
      agentId: 'fixture',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'fixture' }] },
      ],
      signal: new AbortController().signal,
      logger,
      trackEvent() {},
      sendAction(action: (typeof statuses)[number]) {
        statuses.push(action)
      },
      onError() {},
      retrySleep: async () => {},
      retryPolicy: {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterFraction: 0,
      },
    } as never)) {
    }
    expect(attempts).toBe(2)
    expect(
      statuses.find((row) => row.action.chunk.status === 'retrying')?.action
        .chunk.model,
    ).toBe('vision/model')
  })

  test('vision failover retains the actual route in status and analytics', async () => {
    const provider = (host: string, image: boolean) => ({
      type: 'openai-compatible',
      baseURL: `https://${host}.b08.invalid/v1`,
      models: ['model'],
      defaultCapabilities: { input: { image } },
    })
    configure({
      defaultModel: 'primary/model',
      visionModel: 'vision/model',
      failoverModels: ['backup/model'],
      providers: {
        primary: provider('primary', false),
        vision: provider('vision', true),
        backup: provider('backup', true),
      },
    })
    const previous = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = Object.assign(async (input: unknown) => {
      const host = new URL(String(input)).hostname
      expect(['vision.b08.invalid', 'backup.b08.invalid']).toContain(host)
      requests.push(host)
      return host === 'vision.b08.invalid'
        ? new Response(JSON.stringify({ error: { message: 'unavailable' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        : sse([
            {
              choices: [
                { delta: { content: 'healthy' }, finish_reason: 'stop' },
              ],
            },
          ])
    }, previous)
    cleanup.push(() => {
      globalThis.fetch = previous
    })
    const statuses: Array<{
      action: {
        chunk: { status?: string; model?: string; nextModel?: string }
      }
    }> = []
    const events: Array<{
      properties?: { fromModel?: string; toModel?: string }
    }> = []
    const waits: number[] = []
    const text: string[] = []
    for await (const chunk of promptAiSdkStream({
      apiKey: '',
      runId: 'b08',
      clientSessionId: 'b08',
      fingerprintId: 'b08',
      userInputId: 'b08',
      userId: undefined,
      agentId: 'fixture',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect image' },
            {
              type: 'image',
              image: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
              mediaType: 'image/png',
            },
          ],
        },
      ],
      signal: new AbortController().signal,
      logger,
      trackEvent(event: (typeof events)[number]) {
        events.push(event)
      },
      sendAction(action: (typeof statuses)[number]) {
        statuses.push(action)
      },
      onError() {},
      retrySleep: async (delayMs: number) => {
        waits.push(delayMs)
      },
      retryPolicy: {
        maxRetries: 2,
        backupMaxRetries: 0,
        maxTotalAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 200,
        maxTotalDelayMs: 600,
        jitterFraction: 0,
      },
    } as never)) {
      if (chunk.type === 'text') text.push(chunk.text)
    }
    expect(requests).toEqual([
      'vision.b08.invalid',
      'vision.b08.invalid',
      'vision.b08.invalid',
      'backup.b08.invalid',
    ])
    expect(waits).toEqual([100, 200])
    expect(text.join('')).toBe('healthy')
    expect(
      statuses
        .filter((row) => row.action.chunk.status === 'retrying')
        .map((row) => row.action.chunk.model),
    ).toEqual(['vision/model', 'vision/model'])
    expect(
      statuses.find((row) => row.action.chunk.status === 'failover')?.action
        .chunk,
    ).toMatchObject({ model: 'vision/model', nextModel: 'backup/model' })
    expect(
      events.find((event) => event.properties?.fromModel !== undefined)
        ?.properties,
    ).toMatchObject({ fromModel: 'vision/model', toModel: 'backup/model' })
  })

  test('recursive OAuth refresh cannot reset the total attempt allowance', async () => {
    configure({
      defaultModel: 'codex/gpt-5.5',
      failoverModels: ['backup/model'],
      providers: {
        codex: { type: 'chatgpt-oauth', models: ['gpt-5.5'] },
        backup: {
          type: 'openai-compatible',
          baseURL: 'https://backup.b08.invalid/v1',
          models: ['model'],
        },
      },
    })
    const modelSpy = spyOn(routing, 'getModelForRequest').mockImplementation(
      async (input) => ({
        model: { provider: 'synthetic' } as never,
        isChatGptOAuth: !input.skipChatGptOAuth,
        effectiveModel: input.skipChatGptOAuth
          ? 'backup/model'
          : 'codex/gpt-5.5',
        compatibility: {
          supportsTools: true,
          stripProviderMetadata: true,
          stripCacheControl: true,
          supportsRequiredToolChoice: true,
          stringifyTextContent: true,
          supportsStopSequences: false,
        },
      }),
    )
    cleanup.push(() => modelSpy.mockRestore())
    const refreshSpy = spyOn(
      credentials,
      'refreshChatGptOAuthToken',
    ).mockImplementation(async () => true as never)
    cleanup.push(() => refreshSpy.mockRestore())
    let attempts = 0
    const unauthorized = Object.assign(new Error('Unauthorized'), {
      statusCode: 401,
    })
    const streamSpy = spyOn(ai, 'streamText').mockImplementation((() => {
      attempts++
      return {
        fullStream: (async function* () {
          yield { type: 'error', error: unauthorized }
        })(),
      }
    }) as unknown as typeof ai.streamText)
    cleanup.push(() => streamSpy.mockRestore())
    let observed: unknown
    try {
      for await (const _chunk of promptAiSdkStream({
        apiKey: '',
        runId: 'b08',
        clientSessionId: 'b08',
        fingerprintId: 'b08',
        userInputId: 'b08',
        userId: undefined,
        agentId: 'fixture',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'fixture' }] },
        ],
        signal: new AbortController().signal,
        logger,
        trackEvent() {},
        sendAction() {},
        onError() {},
        retryPolicy: {
          maxRetries: 2,
          backupMaxRetries: 0,
          maxTotalAttempts: 2,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterFraction: 0,
        },
      } as never)) {
      }
    } catch (error) {
      observed = error
    }
    expect(observed).toBe(unauthorized)
    expect(attempts).toBe(2)
    expect(modelSpy).toHaveBeenCalledTimes(2)
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(
      streamSpy.mock.calls.every(([input]) => input.maxRetries === 0),
    ).toBe(true)
  })

  test('scrubbed offline configured-adapter fault matrix passes with exact attempt ledgers', () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../..',
    )
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'b08-fault-matrix-'))
    const home = path.join(output, 'home')
    fs.mkdirSync(home)
    cleanup.push(() => fs.rmSync(output, { recursive: true, force: true }))
    execFileSync(
      process.execPath,
      ['--no-env-file', 'test/fixtures/body/provider-retry.ts', output],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USER: 'b08-fixture',
          OPENBUFF_TELEMETRY: '0',
          DO_NOT_TRACK: '1',
          NEXT_PUBLIC_CODEBUFF_APP_URL: 'https://fixture.invalid',
        },
        timeout: 20000,
        stdio: 'pipe',
      },
    )
    const observed = JSON.parse(
      fs.readFileSync(path.join(output, 'observations.json'), 'utf8'),
    )
    expect(observed.refusedFetches).toBe(0)
    expect(observed.controls.length).toBeGreaterThanOrEqual(40)
    expect(
      observed.controls.every((control: { passed: boolean }) => control.passed),
    ).toBe(true)
  })
})
