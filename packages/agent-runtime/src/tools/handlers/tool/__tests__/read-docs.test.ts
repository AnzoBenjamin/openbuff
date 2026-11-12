import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { handleReadDocs } from '../read-docs'

import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'

/**
 * N04 (read_docs): a missing key, rate limit or outage is not reported as
 * "No documentation found".
 */

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

let savedKey: string | undefined
beforeEach(() => {
  savedKey = process.env['CONTEXT7_API_KEY']
  delete process.env['CONTEXT7_API_KEY']
})
afterEach(() => {
  if (savedKey === undefined) delete process.env['CONTEXT7_API_KEY']
  else process.env['CONTEXT7_API_KEY'] = savedKey
})

async function runReadDocs(
  fetchImpl: typeof globalThis.fetch,
  extra: Record<string, unknown> = {},
) {
  const toolCall: CodebuffToolCall<'read_docs'> = {
    toolName: 'read_docs',
    toolCallId: 'tc-1',
    input: { libraryTitle: 'React', topic: 'hooks' } as never,
  }
  const { output } = await handleReadDocs({
    previousToolCallFinished: Promise.resolve(),
    toolCall,
    agentStepId: 's',
    clientSessionId: 'c',
    fingerprintId: 'f',
    logger: noopLogger,
    repoId: undefined,
    userId: undefined,
    userInputId: 'u',
    fetch: fetchImpl,
    signal: new AbortController().signal,
    ...extra,
  } as Parameters<typeof handleReadDocs>[0])
  return output[0].value as Record<string, unknown>
}

describe('read_docs typed failures (N04)', () => {
  test('no key + 401: auth_required naming CONTEXT7_API_KEY, no Bearer undefined', async () => {
    const seen: RequestInit[] = []
    const value = await runReadDocs((async (_url: URL, init?: RequestInit) => {
      seen.push(init ?? {})
      return new Response('unauthorized', { status: 401 })
    }) as unknown as typeof globalThis.fetch)

    expect(value.status).toBe('auth_required')
    expect(String(value.reason)).toContain('CONTEXT7_API_KEY')
    expect(String(value.nextStep)).toContain('Set CONTEXT7_API_KEY')
    expect(String(value.errorMessage)).not.toContain('No documentation found')
    expect(seen.length).toBeGreaterThan(0)
    for (const init of seen) {
      expect(new Headers(init.headers).has('authorization')).toBe(false)
    }
  })

  test('the runtime provider apiKey is never sent to Context7', async () => {
    const seen: RequestInit[] = []
    await runReadDocs(
      (async (_url: URL, init?: RequestInit) => {
        seen.push(init ?? {})
        return new Response('unauthorized', { status: 401 })
      }) as unknown as typeof globalThis.fetch,
      { apiKey: 'sk-provider-fake-key' },
    )
    for (const init of seen) {
      const values: string[] = []
      new Headers(init.headers).forEach((value) => values.push(value))
      expect(values.join(' ')).not.toContain('sk-provider-fake-key')
    }
  })

  test('429 is rate_limited, 503 is unavailable, and neither says "no documentation"', async () => {
    const limited = await runReadDocs(
      (async () =>
        new Response('slow', {
          status: 429,
          headers: { 'retry-after': '5' },
        })) as unknown as typeof globalThis.fetch,
    )
    expect(limited).toMatchObject({
      status: 'rate_limited',
      retryAfterSeconds: 5,
    })
    expect(String(limited.errorMessage)).not.toContain('No documentation found')

    const down = await runReadDocs(
      (async () =>
        new Response('down', {
          status: 503,
        })) as unknown as typeof globalThis.fetch,
    )
    expect(down).toMatchObject({ status: 'unavailable', httpStatus: 503 })
    expect(String(down.nextStep).length).toBeGreaterThan(0)
  })

  test('an empty search is not_found and keeps the "No documentation found" wording', async () => {
    const value = await runReadDocs((async () =>
      Response.json({ results: [] })) as unknown as typeof globalThis.fetch)
    expect(value.status).toBe('not_found')
    expect(String(value.errorMessage)).toContain(
      'No documentation found for "React"',
    )
  })
})
