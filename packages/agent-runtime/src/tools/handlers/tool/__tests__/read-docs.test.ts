import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

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

const CONTEXT7_TEST_KEY = 'ctx7-test-fake-key'
const PROVIDER_TEST_KEY = 'sk-provider-fake-key'

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
  fetchImpl: (url: URL, init?: RequestInit) => Promise<Response>,
  extra: { context7ApiKey?: string; apiKey?: string } = {},
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
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    signal: new AbortController().signal,
    ...extra,
  } as Parameters<typeof handleReadDocs>[0])
  return output[0].value as Record<string, unknown>
}

describe('read_docs typed failures (N04)', () => {
  test.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace-only', ' \t\n '],
  ] as const)(
    'Context7 key %s: auth_required without a request',
    async (_label, key) => {
      if (key !== undefined) process.env['CONTEXT7_API_KEY'] = key
      const fetchMock = mock(async () => Response.json({ results: [] }))
      const value = await runReadDocs(fetchMock, { apiKey: PROVIDER_TEST_KEY })

      expect(value).toMatchObject({
        status: 'auth_required',
        reason: expect.stringContaining('CONTEXT7_API_KEY is not set'),
        nextStep: expect.stringMatching(/Set CONTEXT7_API_KEY.*web_search/),
        errorMessage: expect.stringContaining('Could not fetch documentation'),
      })
      expect(value).not.toHaveProperty('httpStatus')
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test('uses only the injected Context7 key on both requests for valid docs', async () => {
    const fetchMock = mock(async (url: URL, _init?: RequestInit) => {
      if (url.pathname === '/api/v1/search') {
        return Response.json({
          results: [
            {
              id: '/facebook/react',
              title: 'React',
              description: '',
              branch: 'main',
              lastUpdateDate: '2026-01-01',
              state: 'finalized',
              totalTokens: 100,
              totalSnippets: 1,
              totalPages: 1,
            },
          ],
        })
      }
      return new Response('# React Hooks')
    })

    const value = await runReadDocs(fetchMock, {
      context7ApiKey: CONTEXT7_TEST_KEY,
      apiKey: PROVIDER_TEST_KEY,
    })
    expect(value).toMatchObject({
      documentation: '# React Hooks',
      library: { id: '/facebook/react', title: 'React' },
    })
    expect(value).not.toHaveProperty('status')
    expect(fetchMock.mock.calls.map(([url]) => url.pathname)).toEqual([
      '/api/v1/search',
      '/api/v1//facebook/react',
    ])
    for (const [url, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers)
      expect(url.origin).toBe('https://context7.com')
      expect(headers.get('authorization')).toBe(`Bearer ${CONTEXT7_TEST_KEY}`)
      expect(JSON.stringify([url.href, init])).not.toContain(PROVIDER_TEST_KEY)
      headers.forEach((value) => expect(value).not.toContain(PROVIDER_TEST_KEY))
    }
    expect(JSON.stringify(value)).not.toContain(PROVIDER_TEST_KEY)
  })

  test('429 is rate_limited, 503 is unavailable, and neither says "no documentation"', async () => {
    const limited = await runReadDocs(
      async () =>
        new Response('slow', {
          status: 429,
          headers: { 'retry-after': '5' },
        }),
      { context7ApiKey: CONTEXT7_TEST_KEY },
    )
    expect(limited).toMatchObject({
      status: 'rate_limited',
      httpStatus: 429,
      retryAfterSeconds: 5,
      reason: expect.stringContaining('HTTP 429'),
      nextStep: expect.stringContaining('Wait about 5s'),
    })
    expect(String(limited.errorMessage)).not.toContain('No documentation found')

    const down = await runReadDocs(
      async () => new Response('down', { status: 503 }),
      { context7ApiKey: CONTEXT7_TEST_KEY },
    )
    expect(down).toMatchObject({
      status: 'unavailable',
      httpStatus: 503,
      reason: expect.stringContaining('HTTP 503'),
      nextStep: expect.stringContaining('Retry later'),
    })
    expect(String(down.errorMessage)).not.toContain('No documentation found')
  })

  test('an authenticated empty search is not_found and keeps the "No documentation found" wording', async () => {
    const value = await runReadDocs(
      async () => Response.json({ results: [] }),
      { context7ApiKey: CONTEXT7_TEST_KEY },
    )
    expect(value).toMatchObject({
      status: 'not_found',
      reason: expect.stringContaining('no library matching "React"'),
      nextStep: expect.stringContaining('Try the official library name'),
      errorMessage: expect.stringContaining(
        'No documentation found for "React"',
      ),
    })
  })
})
