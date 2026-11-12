import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'

import {
  searchLibraries,
  fetchContext7LibraryDocumentation,
} from '../context7-api'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

function makeResponse(
  body: unknown,
  opts: { ok?: boolean; status?: number; statusText?: string } = {},
) {
  const isOk = opts.ok ?? true
  const status = opts.status ?? 200
  const isJson = typeof body !== 'string'
  return {
    ok: isOk,
    status,
    statusText: opts.statusText ?? (isOk ? 'OK' : 'Error'),
    json: async () => (isJson ? body : JSON.parse(body as string)),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

beforeEach(() => {
  // Ensure CONTEXT7_API_KEY is absent so tests that omit `context7ApiKey`
  // exercise the no-key path deterministically.
  delete process.env['CONTEXT7_API_KEY']
})

afterEach(() => {
  mock.restore()
})

describe('searchLibraries', () => {
  test('returns results on a 200 response', async () => {
    const fetchMock = mock(async (_url: URL | string) =>
      makeResponse({
        results: [
          {
            id: '/react',
            title: 'React',
            description: 'A JS library',
            branch: 'main',
            lastUpdateDate: '2026-01-01',
            state: 'finalized',
            totalTokens: 10000,
            totalSnippets: 50,
            totalPages: 5,
          },
        ],
      }),
    )

    const out = await searchLibraries({
      query: 'react',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })

    expect(out).toHaveLength(1)
    expect(out![0].id).toBe('/react')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = new URL(fetchMock.mock.calls[0][0].toString())
    expect(url.searchParams.get('query')).toBe('react')
    expect(url.pathname).toBe('/api/v1/search')
  })

  test('returns null on a non-OK status', async () => {
    const fetchMock = mock(async () =>
      makeResponse('error', { ok: false, status: 500 }),
    )
    const out = await searchLibraries({
      query: 'x',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toBeNull()
  })

  test('returns null when fetch throws', async () => {
    const fetchMock = mock(async () => {
      throw new Error('network down')
    })
    const out = await searchLibraries({
      query: 'x',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toBeNull()
  })

  test('returns empty array when results array is empty', async () => {
    const fetchMock = mock(async () => makeResponse({ results: [] }))
    const out = await searchLibraries({
      query: 'x',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toEqual([])
  })

  test('returns null when results key is missing from response', async () => {
    const fetchMock = mock(async () => makeResponse({ other: 'stuff' }))
    const out = await searchLibraries({
      query: 'x',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    // M3-T1: an invalid response shape fails closed to null instead of
    // returning an unvalidated value.
    expect(out).toBeNull()
  })

  test('returns null when results is a truthy non-array of the wrong shape', async () => {
    const fetchMock = mock(async () => makeResponse({ results: 'oops' }))
    const out = await searchLibraries({
      query: 'x',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toBeNull()
  })

  test('returns null when a result entry is missing required fields', async () => {
    const fetchMock = mock(async () =>
      makeResponse({ results: [{ id: '/x' }] }),
    )
    const out = await searchLibraries({
      query: 'x',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toBeNull()
  })
})

describe('fetchContext7LibraryDocumentation', () => {
  test('returns documentation text when search finds a library and fetch succeeds', async () => {
    const searchResponse = makeResponse({
      results: [
        {
          id: '/react',
          title: 'React',
          description: '',
          branch: 'main',
          lastUpdateDate: '2026-01-01',
          state: 'finalized',
          totalTokens: 10000,
          totalSnippets: 50,
          totalPages: 5,
        },
      ],
    })
    const docResponse = makeResponse('# React Docs\n\nUseful content.')

    const fetchMock = mock(async (url: URL | string) => {
      const u = new URL(url.toString())
      if (u.pathname === '/api/v1/search') return searchResponse
      if (u.pathname === '/api/v1//react') return docResponse
      throw new Error(`unexpected url: ${u.toString()}`)
    })

    const out = await fetchContext7LibraryDocumentation({
      query: 'react',
      tokens: 5000,
      topic: 'hooks',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })

    expect(out).toMatchObject({
      documentation: '# React Docs\n\nUseful content.',
      selectedLibrary: { id: '/react', title: 'React' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Verify the doc URL carries the optional query params and type=txt.
    const docUrl = new URL(
      (fetchMock.mock.calls[1][0] as unknown as URL).toString(),
    )
    expect(docUrl.pathname).toBe('/api/v1//react')
    expect(docUrl.searchParams.get('tokens')).toBe('5000')
    expect(docUrl.searchParams.get('topic')).toBe('hooks')
    expect(docUrl.searchParams.get('type')).toBe('txt')
  })

  test('ranks an exact library title above an ambiguous first result and preserves alternatives', async () => {
    const base = {
      description: '',
      branch: 'main',
      lastUpdateDate: '2026-01-01',
      state: 'finalized',
      totalTokens: 100,
      totalSnippets: 2,
      totalPages: 1,
    }
    const fetchMock = mock(async (url: URL | string) => {
      const parsed = new URL(url.toString())
      if (parsed.pathname === '/api/v1/search') {
        return makeResponse({
          results: [
            { ...base, id: '/other/react-tools', title: 'React Tools' },
            { ...base, id: '/facebook/react', title: 'React' },
          ],
        })
      }
      if (parsed.pathname === '/api/v1//facebook/react') {
        return makeResponse('official docs')
      }
      throw new Error(`unexpected url: ${parsed}`)
    })

    const out = await fetchContext7LibraryDocumentation({
      query: 'React',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    if (!out.ok) throw new Error(`expected docs, got ${out.status}`)
    expect(out.selectedLibrary.id).toBe('/facebook/react')
    expect(out.alternatives[0]?.id).toBe('/other/react-tools')
  })

  test('returns not_found when no libraries are found by search', async () => {
    const fetchMock = mock(async () => makeResponse({ results: [] }))
    const out = await fetchContext7LibraryDocumentation({
      query: 'nope',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toMatchObject({ ok: false, status: 'not_found' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('returns unavailable (not "no documentation") when search fails with 500', async () => {
    const fetchMock = mock(async () =>
      makeResponse('err', { ok: false, status: 500 }),
    )
    const out = await fetchContext7LibraryDocumentation({
      query: 'react',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toMatchObject({
      ok: false,
      status: 'unavailable',
      httpStatus: 500,
    })
  })

  test('returns not_found when the doc endpoint responds with "No content available"', async () => {
    const searchResponse = makeResponse({
      results: [
        {
          id: '/lib',
          title: 'Lib',
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
    const fetchMock = mock(async (url: URL | string) => {
      const u = new URL(url.toString())
      if (u.pathname === '/api/v1/search') return searchResponse
      return makeResponse('No content available')
    })

    const out = await fetchContext7LibraryDocumentation({
      query: 'lib',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toMatchObject({ ok: false, status: 'not_found' })
  })

  test('returns unavailable when the doc endpoint responds with 503', async () => {
    const searchResponse = makeResponse({
      results: [
        {
          id: '/lib',
          title: 'Lib',
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
    const fetchMock = mock(async (url: URL | string) => {
      const u = new URL(url.toString())
      if (u.pathname === '/api/v1/search') return searchResponse
      return makeResponse('error', { ok: false, status: 503 })
    })

    const out = await fetchContext7LibraryDocumentation({
      query: 'lib',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toMatchObject({
      ok: false,
      status: 'unavailable',
      httpStatus: 503,
    })
  })

  test('returns network_error when the doc fetch throws', async () => {
    const searchResponse = makeResponse({
      results: [
        {
          id: '/lib',
          title: 'Lib',
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
    let callCount = 0
    const fetchMock = mock(async (url: URL | string) => {
      callCount++
      if (callCount === 1) return searchResponse
      throw new Error('doc fetch failed')
    })

    const out = await fetchContext7LibraryDocumentation({
      query: 'lib',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toMatchObject({ ok: false, status: 'network_error' })
  })
})

describe('Context7 typed failures and key handling (N04)', () => {
  const lib = {
    id: '/lib',
    title: 'Lib',
    description: '',
    branch: 'main',
    lastUpdateDate: '2026-01-01',
    state: 'finalized',
    totalTokens: 100,
    totalSnippets: 1,
    totalPages: 1,
  }

  const headersOf = (call: unknown[]): Headers =>
    new Headers((call[1] as RequestInit | undefined)?.headers)

  test('no key: sends no Authorization header (never "Bearer undefined") and a 401 is auth_required', async () => {
    const fetchMock = mock(async (_url: URL | string, _init?: RequestInit) =>
      makeResponse('unauthorized', {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      }),
    )
    const out = await fetchContext7LibraryDocumentation({
      query: 'react',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toMatchObject({
      ok: false,
      status: 'auth_required',
      httpStatus: 401,
    })
    if (out.ok) throw new Error('expected failure')
    expect(out.reason).toContain('CONTEXT7_API_KEY is not set')
    expect(out.nextStep).toContain('Set CONTEXT7_API_KEY')
    const headers = headersOf(fetchMock.mock.calls[0])
    expect(headers.has('authorization')).toBe(false)
    for (const call of fetchMock.mock.calls) {
      expect(JSON.stringify(call[1] ?? {})).not.toContain('Bearer undefined')
    }
  })

  test('blank CONTEXT7_API_KEY counts as unset', async () => {
    process.env['CONTEXT7_API_KEY'] = '   '
    const fetchMock = mock(async (_url: URL | string, _init?: RequestInit) =>
      makeResponse({ results: [] }),
    )
    await searchLibraries({
      query: 'x',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(headersOf(fetchMock.mock.calls[0]).has('authorization')).toBe(false)
  })

  test('configured key: sends Bearer key on both requests; 403 says the key was rejected', async () => {
    const fetchMock = mock(async (url: URL | string, _init?: RequestInit) => {
      const u = new URL(url.toString())
      if (u.pathname === '/api/v1/search')
        return makeResponse({ results: [lib] })
      return makeResponse('forbidden', { ok: false, status: 403 })
    })
    const out = await fetchContext7LibraryDocumentation({
      query: 'lib',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      context7ApiKey: 'ctx7-test-fake-key',
    })
    expect(out).toMatchObject({
      ok: false,
      status: 'auth_required',
      httpStatus: 403,
    })
    if (out.ok) throw new Error('expected failure')
    expect(out.reason).toContain('rejected the configured CONTEXT7_API_KEY')
    for (const call of fetchMock.mock.calls) {
      expect(headersOf(call).get('authorization')).toBe(
        'Bearer ctx7-test-fake-key',
      )
    }
  })

  test('429 is rate_limited with Retry-After', async () => {
    const fetchMock = mock(async () => {
      const response = new Response('slow down', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '17' },
      })
      return response
    })
    const out = await fetchContext7LibraryDocumentation({
      query: 'react',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toMatchObject({
      ok: false,
      status: 'rate_limited',
      httpStatus: 429,
      retryAfterSeconds: 17,
    })
  })

  test('timeout is distinct from network failure', async () => {
    const fetchMock = mock(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    })
    const out = await fetchContext7LibraryDocumentation({
      query: 'react',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toMatchObject({ ok: false, status: 'timeout' })
  })

  test('invalid response shape is invalid_response', async () => {
    const fetchMock = mock(async () => makeResponse({ results: 'oops' }))
    const out = await fetchContext7LibraryDocumentation({
      query: 'react',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    })
    expect(out).toMatchObject({ ok: false, status: 'invalid_response' })
  })

  test('the caller signal is forwarded and an abort is reported as cancelled', async () => {
    const controller = new AbortController()
    const fetchMock = mock(
      (_url: URL | string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const pending = fetchContext7LibraryDocumentation({
      query: 'react',
      logger: noopLogger,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      signal: controller.signal,
    })
    controller.abort()
    const out = await pending
    expect(out).toMatchObject({ ok: false, status: 'cancelled' })
  })
})
