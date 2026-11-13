import { describe, expect, test } from 'bun:test'

import { isDuckDuckGoBlockedPage } from '../web-search-utils'
import { handleWebSearch } from '../web-search'

import type { WebEgressOptions } from '../web-search-utils'
import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'

/**
 * N04 (web part): a DuckDuckGo bot check or rate limit is reported as a typed
 * `blocked` status, distinct from a real "no results" answer.
 */

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

// Shape of the page DuckDuckGo serves instead of results when it suspects a bot.
const DDG_ANOMALY_PAGE = `<!DOCTYPE html><html><body>
<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
<div class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</div>
<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html"></form>
</body></html>`

const DDG_EMPTY_RESULTS_PAGE = `<!DOCTYPE html><html><body>
<div class="no-results">No results.</div></body></html>`

const egressWith = (response: () => Response): WebEgressOptions => ({
  resolveHost: async () => ['52.142.124.215'],
  supportsTlsServerName: true,
  fetchImpl: (async () => response()) as unknown as typeof globalThis.fetch,
})

async function runSearch(egress: WebEgressOptions) {
  const toolCall: CodebuffToolCall<'web_search'> = {
    toolName: 'web_search',
    toolCallId: 'tc-1',
    input: { query: 'bun test runner', depth: 'standard' } as never,
  }
  const { output } = await handleWebSearch({
    previousToolCallFinished: Promise.resolve(),
    toolCall,
    logger: noopLogger,
    signal: new AbortController().signal,
    agentStepId: 's',
    clientSessionId: 'c',
    fingerprintId: 'f',
    repoId: undefined,
    userInputId: 'u',
    userId: undefined,
    webEgress: egress,
  })
  return output[0].value as Record<string, unknown>
}

describe('web_search typed failures (N04)', () => {
  test('a DuckDuckGo anomaly page (HTTP 202) is blocked, with a reason and next step', async () => {
    const value = await runSearch(
      egressWith(() => new Response(DDG_ANOMALY_PAGE, { status: 202 })),
    )
    expect(value.status).toBe('blocked')
    expect(String(value.reason)).toContain('bot-check')
    expect(String(value.nextStep)).toContain('Wait')
    expect(String(value.errorMessage)).not.toContain('No search results')
  })

  test('the anomaly page is blocked even when served with HTTP 200', async () => {
    const value = await runSearch(
      egressWith(() => new Response(DDG_ANOMALY_PAGE, { status: 200 })),
    )
    expect(value.status).toBe('blocked')
  })

  test('HTTP 429 with Retry-After is blocked and carries the delay', async () => {
    const value = await runSearch(
      egressWith(
        () =>
          new Response('rate limited', {
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'retry-after': '30' },
          }),
      ),
    )
    expect(value).toMatchObject({ status: 'blocked', retryAfterSeconds: 30 })
    expect(String(value.nextStep)).toContain('30s')
  })

  test('a real empty results page stays no_results', async () => {
    const value = await runSearch(
      egressWith(() => new Response(DDG_EMPTY_RESULTS_PAGE, { status: 200 })),
    )
    expect(value.status).toBe('no_results')
    expect(String(value.errorMessage)).toContain('No search results found')
  })

  test('results pages are returned normally', async () => {
    const value = await runSearch(
      egressWith(
        () =>
          new Response(
            `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs">Bun docs</a>
             <a class="result__snippet">The bun test runner.</a>`,
            { status: 200 },
          ),
      ),
    )
    expect(value.status).toBeUndefined()
    expect(String(value.result)).toContain('https://bun.sh/docs')
  })

  test('isDuckDuckGoBlockedPage does not flag an ordinary page', () => {
    expect(isDuckDuckGoBlockedPage(DDG_ANOMALY_PAGE)).toBe(true)
    expect(isDuckDuckGoBlockedPage(DDG_EMPTY_RESULTS_PAGE)).toBe(false)
  })

  test('URL mode refuses a mapped loopback URL through the handler', async () => {
    const toolCall: CodebuffToolCall<'web_search'> = {
      toolName: 'web_search',
      toolCallId: 'tc-2',
      input: { url: 'http://[::ffff:127.0.0.1]:8080/' } as never,
    }
    const { output } = await handleWebSearch({
      previousToolCallFinished: Promise.resolve(),
      toolCall,
      logger: noopLogger,
      signal: new AbortController().signal,
      agentStepId: 's',
      clientSessionId: 'c',
      fingerprintId: 'f',
      repoId: undefined,
      userInputId: 'u',
      userId: undefined,
    })
    expect(
      String((output[0].value as { errorMessage?: string }).errorMessage),
    ).toContain('non-public address')
  })
})
