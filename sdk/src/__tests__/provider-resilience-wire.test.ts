/**
 * N07 wire tests: provider resilience on the streaming agent loop.
 *
 * Real `promptAiSdkStream` and real model builders against a local fake
 * Anthropic-compatible server (`fixtures/fake-llm-server.ts`). Backoff waits
 * go through the injected `retrySleep`, so no test really sleeps.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { systemMessage, userMessage } from '@codebuff/common/util/messages'

import { createRouteHealthRegistry } from '../impl/failover'
import { promptAiSdkStream } from '../impl/llm'
import { RETRY_POLICY } from '../retry-config'
import {
  providerContextFor,
  silentLogger,
  startFakeLlmServer,
} from './fixtures/fake-llm-server'

import type { FakeLlmServer } from './fixtures/fake-llm-server'
import type { RouteHealthRegistry } from '../impl/failover'
import type { LlmHostDeps } from '../impl/llm'
import type { RetryPolicy } from '../retry-config'

type ProviderStatus = {
  type: 'provider_status'
  status: string
  model?: string
  nextModel?: string
  delayMs?: number
  statusCode?: number
  providerId?: string
  degraded?: boolean
}

let server: FakeLlmServer | undefined
const cleanups: Array<() => void> = []
afterEach(() => {
  server?.stop()
  server = undefined
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup(params: { failover?: boolean; routeHealth?: RouteHealthRegistry } = {}) {
  server = startFakeLlmServer()
  const { context, cleanup } = providerContextFor({
    defaultModel: 'fakeanth/primary',
    ...(params.failover ? { failoverModels: ['fakeanth/backup'] } : {}),
    providers: {
      fakeanth: { type: 'anthropic-compatible', baseURL: server.baseURL, models: ['primary', 'backup'] },
    },
  })
  cleanups.push(cleanup)
  const deps: LlmHostDeps = {
    providerContext: context,
    routeHealth: params.routeHealth ?? createRouteHealthRegistry(),
  }
  return { server, deps }
}

async function run(deps: LlmHostDeps, policy: RetryPolicy = RETRY_POLICY) {
  const statuses: ProviderStatus[] = []
  const sleeps: number[] = []
  const chunks: Array<{ type: string; text?: string }> = []
  let thrown: unknown
  try {
    for await (const chunk of promptAiSdkStream(
      {
        apiKey: 'fixture-key', runId: 'n07', clientSessionId: 'n07', fingerprintId: 'n07', userInputId: 'n07',
        userId: undefined, agentId: 'fixture',
        messages: [systemMessage('You are a coding agent.'), userMessage({ content: 'hello', tags: ['USER_PROMPT'] })],
        includeCacheControl: true,
        signal: new AbortController().signal, maxRetries: 0,
        logger: silentLogger, trackEvent() {},
        sendAction({ action }: { action: { chunk?: ProviderStatus } }) {
          if (action.chunk?.type === 'provider_status') statuses.push(action.chunk)
        },
        retryPolicy: policy,
        retrySleep: async (ms: number) => { sleeps.push(ms) },
      } as never,
      deps,
    )) chunks.push(chunk as { type: string; text?: string })
  } catch (error) {
    thrown = error
  }
  const text = chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')
  return { statuses, sleeps, text, thrown }
}

const models = (fake: FakeLlmServer) => fake.requests.map((r) => r.body.model)

describe('N07: overload is retryable and failover-eligible', () => {
  test('HTTP 529 then 200 recovers on the same model', async () => {
    const { server, deps } = setup()
    server.script.push({ kind: 'status', status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } })
    const result = await run(deps)

    expect(result.thrown).toBeUndefined()
    expect(result.text).toBe('ok')
    expect(models(server)).toEqual(['primary', 'primary'])
    expect(result.statuses.map((s) => [s.status, s.statusCode])).toEqual([['retrying', 529], ['recovered', undefined]])
  })

  test('SSE overloaded_error on a 200 stream retries and recovers', async () => {
    const { server, deps } = setup()
    server.script.push({ kind: 'sse-overloaded' })
    const result = await run(deps)

    expect(result.thrown).toBeUndefined()
    expect(result.text).toBe('ok')
    expect(models(server)).toEqual(['primary', 'primary'])
    expect(result.statuses[0]).toMatchObject({ status: 'retrying', statusCode: 529 })
  })

  test('529 three times with a backup configured fails over to the backup', async () => {
    const { server, deps } = setup({ failover: true })
    for (let i = 0; i < 3; i++) server.script.push({ kind: 'status', status: 529 })
    const result = await run(deps, { ...RETRY_POLICY, maxRetries: 2 })

    expect(result.thrown).toBeUndefined()
    expect(result.text).toBe('ok')
    expect(models(server)).toEqual(['primary', 'primary', 'primary', 'backup'])
    const failover = result.statuses.find((s) => s.status === 'failover')
    expect(failover).toMatchObject({ model: 'fakeanth/primary', nextModel: 'fakeanth/backup', statusCode: 529 })
    // Overload is transient: it does not demote the route for the session.
    expect(failover?.degraded).toBeUndefined()
  })
})

describe('N07: Retry-After', () => {
  test('a 45 s delta-seconds Retry-After is honoured and reported in the retry event', async () => {
    const { server, deps } = setup()
    server.script.push({ kind: 'status', status: 429, headers: { 'retry-after': '45' } })
    const result = await run(deps)

    expect(result.text).toBe('ok')
    expect(result.sleeps).toEqual([45_000])
    expect(result.statuses[0]).toMatchObject({ status: 'retrying', statusCode: 429, delayMs: 45_000 })
  })

  test('an HTTP-date Retry-After 45 s ahead of the injected clock is honoured', async () => {
    const { server, deps } = setup()
    const now = Date.UTC(2026, 10, 12, 9, 0, 0)
    server.script.push({ kind: 'status', status: 503, headers: { 'retry-after': new Date(now + 45_000).toUTCString() } })
    const result = await run(deps, { ...RETRY_POLICY, now: () => now })

    expect(result.text).toBe('ok')
    expect(result.sleeps).toEqual([45_000])
  })

  test('a Retry-After beyond 120 s is clamped to 120 s', async () => {
    const { server, deps } = setup()
    server.script.push({ kind: 'status', status: 429, headers: { 'retry-after': '3600' } })
    const result = await run(deps)

    expect(result.text).toBe('ok')
    expect(result.sleeps).toEqual([120_000])
  })
})

describe('N07: a 401 failover demotes the primary for the session', () => {
  test('later requests go straight to the backup until the registry is cleared', async () => {
    const routeHealth = createRouteHealthRegistry()
    const { server, deps } = setup({ failover: true, routeHealth })
    server.script.push({ kind: 'status', status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } })

    const first = await run(deps)
    expect(first.text).toBe('ok')
    expect(models(server)).toEqual(['primary', 'backup'])
    expect(first.statuses.find((s) => s.status === 'failover')).toMatchObject({
      model: 'fakeanth/primary',
      nextModel: 'fakeanth/backup',
      statusCode: 401,
      providerId: 'fakeanth',
      degraded: true,
    })
    expect(routeHealth.get('fakeanth/primary')).toMatchObject({ statusCode: 401, replacementModel: 'fakeanth/backup' })

    const second = await run(deps)
    expect(second.text).toBe('ok')
    // No second 401 round trip to the dead primary.
    expect(models(server)).toEqual(['primary', 'backup', 'backup'])
    expect(second.statuses).toEqual([])

    // `/provider` (clearDegradedProviderRoutes) or a restart resets it.
    routeHealth.clear()
    await run(deps)
    expect(models(server).at(-1)).toBe('primary')
  })
})
