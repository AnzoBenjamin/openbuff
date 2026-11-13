import { withTimeout } from '@codebuff/common/util/promise'

import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsOf } from '@codebuff/common/types/function-params'
import { z } from 'zod/v4'

const CONTEXT7_API_BASE_URL = 'https://context7.com/api/v1'
const DEFAULT_TYPE = 'txt'
const FETCH_TIMEOUT_MS = 10_000
// M3-T1 (finite timeouts): the timeout above bounds only the fetch() promise
// (response headers). Remote body reads (json()/text()) are additionally
// bounded by BODY_READ_TIMEOUT_MS so a stalled/trickling server body cannot
// hang the read-docs tool call and the whole agent step indefinitely.
const BODY_READ_TIMEOUT_MS = 10_000

// M3-T1 (fail closed on invalid shape): the search response is remote JSON
// cast blindly before, so a truthy non-array `results` (API change, hijacked
// or mistyped response) crashed `libraries.map` outside any try. The module
// schema validates the shape before use; an invalid response logs and returns
// null like every other failure mode.
const SearchResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      branch: z.string(),
      lastUpdateDate: z.string(),
      state: z.enum(['initial', 'finalized', 'error', 'delete']),
      totalTokens: z.number(),
      totalSnippets: z.number(),
      totalPages: z.number(),
      stars: z.number().optional(),
      trustScore: z.number().optional(),
    }),
  ),
})

export interface SearchResponse {
  results: Array<{
    id: string
    title: string
    description: string
    branch: string
    lastUpdateDate: string
    state: DocumentState
    totalTokens: number
    totalSnippets: number
    totalPages: number
    stars?: number
    trustScore?: number
  }>
}

type DocumentState = 'initial' | 'finalized' | 'error' | 'delete'
export interface SearchResult {
  id: string
  title: string
  description: string
  branch: string
  lastUpdateDate: string
  state: DocumentState
  totalTokens: number
  totalSnippets: number
  totalPages: number
  stars?: number
  trustScore?: number
}

export interface Context7DocumentationResult {
  documentation: string
  selectedLibrary: SearchResult
  alternatives: SearchResult[]
}

function rankLibraryCandidate(candidate: SearchResult, query: string): number {
  const normalizedQuery = query.trim().toLowerCase()
  const normalizedTitle = candidate.title.trim().toLowerCase()
  const normalizedId = candidate.id.toLowerCase()
  let score = 0
  if (normalizedTitle === normalizedQuery) score += 10_000
  else if (normalizedTitle.startsWith(normalizedQuery)) score += 2_000
  else if (normalizedTitle.includes(normalizedQuery)) score += 1_000
  if (normalizedId.endsWith(`/${normalizedQuery}`)) score += 500
  score += Math.round((candidate.trustScore ?? 0) * 10)
  score += Math.min(250, Math.log10((candidate.stars ?? 0) + 1) * 50)
  return score
}

/**
 * Typed Context7 failure (N04). Each failure names its cause so the model
 * does not conclude a library is undocumented when the key is missing, the
 * API is rate limiting, or the network failed.
 */
export type Context7FailureStatus =
  | 'auth_required'
  | 'rate_limited'
  | 'timeout'
  | 'cancelled'
  | 'network_error'
  | 'unavailable'
  | 'invalid_response'
  | 'not_found'

export interface Context7Failure {
  ok: false
  status: Context7FailureStatus
  reason: string
  nextStep: string
  httpStatus?: number
  retryAfterSeconds?: number
}

export type Context7DocumentationOutcome =
  | ({ ok: true } & Context7DocumentationResult)
  | Context7Failure

export const CONTEXT7_API_KEY_ENV = 'CONTEXT7_API_KEY'

/** Reads the Context7 key from an env snapshot; blank values count as unset. */
export function readContext7ApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env[CONTEXT7_API_KEY_ENV]?.trim()
  return value ? value : undefined
}

const buildHeaders = (
  apiKey: string | undefined,
  extra: Record<string, string> = {},
): Record<string, string> =>
  // Never send `Bearer undefined`: omit Authorization when no key is set.
  apiKey ? { ...extra, Authorization: `Bearer ${apiKey}` } : { ...extra }

const parseRetryAfterSeconds = (value: string | null | undefined) => {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  // NOTE(P2-T1): wall clock converts an HTTP-date Retry-After into seconds; not persisted.
  return Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

const failure = (
  status: Context7FailureStatus,
  reason: string,
  nextStep: string,
  extra: { httpStatus?: number; retryAfterSeconds?: number } = {},
): Context7Failure => ({ ok: false, status, reason, nextStep, ...extra })

function failureFromResponse(
  response: Response,
  apiKey: string | undefined,
  what: string,
): Context7Failure {
  const httpStatus = response.status
  const label = `${what} failed with HTTP ${httpStatus}${
    response.statusText ? ` ${response.statusText}` : ''
  }`
  if (httpStatus === 401 || httpStatus === 403) {
    return failure(
      'auth_required',
      apiKey
        ? `${label}: Context7 rejected the configured ${CONTEXT7_API_KEY_ENV}.`
        : `${label}: Context7 requires an API key and ${CONTEXT7_API_KEY_ENV} is not set.`,
      apiKey
        ? `Check that ${CONTEXT7_API_KEY_ENV} is a valid Context7 key, or use web_search to read the library's docs site.`
        : `Set ${CONTEXT7_API_KEY_ENV} (free key from https://context7.com/dashboard) and retry, or use web_search to read the library's docs site.`,
      { httpStatus },
    )
  }
  if (httpStatus === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(
      response.headers?.get?.('retry-after'),
    )
    return failure(
      'rate_limited',
      `${label}: Context7 is rate limiting requests.`,
      `${
        retryAfterSeconds !== undefined
          ? `Wait about ${retryAfterSeconds}s before retrying`
          : 'Wait before retrying'
      }${apiKey ? '' : `, or set ${CONTEXT7_API_KEY_ENV} for a higher limit`}. Use web_search for the docs site meanwhile.`,
      {
        httpStatus,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      },
    )
  }
  if (httpStatus === 404) {
    return failure(
      'not_found',
      `${label}.`,
      'Try the official library name, or use web_search for the docs site.',
      { httpStatus },
    )
  }
  return failure(
    'unavailable',
    `${label}: the Context7 service is unavailable.`,
    'Retry later, or use web_search to read the library docs site.',
    { httpStatus },
  )
}

function failureFromError(
  error: unknown,
  signal: AbortSignal | undefined,
  what: string,
): Context7Failure {
  const message = error instanceof Error ? error.message : String(error)
  if (signal?.aborted) {
    return failure('cancelled', `${what} was cancelled.`, 'No action needed.')
  }
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || /timed out/i.test(message)) {
    return failure(
      'timeout',
      `${what} timed out: ${message}`,
      'Retry once, or use web_search to read the library docs site.',
    )
  }
  return failure(
    'network_error',
    `${what} failed: ${message}`,
    'Check network access to context7.com, or use web_search for the docs site.',
  )
}

const requestSignal = (signal: AbortSignal | undefined): AbortSignal =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(FETCH_TIMEOUT_MS)

/**
 * Searches Context7 for libraries matching `query`, returning a typed
 * outcome. `searchLibraries` is the null-on-failure wrapper.
 */
export async function searchLibrariesOutcome(params: {
  query: string
  logger: Logger
  fetch: typeof globalThis.fetch
  /**
   * Context7 key. Omit to read CONTEXT7_API_KEY; pass undefined for "no key".
   * Named distinctly from the runtime's provider `apiKey` so the LLM key is
   * never forwarded to Context7.
   */
  context7ApiKey?: string
  signal?: AbortSignal
}): Promise<{ ok: true; results: SearchResult[] } | Context7Failure> {
  const { query, logger, fetch, signal } = params
  const apiKey =
    'context7ApiKey' in params ? params.context7ApiKey : readContext7ApiKey()

  const searchStartTime = Date.now()
  const searchContext = {
    query,
    queryLength: query.length,
    hasApiKey: Boolean(apiKey),
  }

  try {
    const url = new URL(`${CONTEXT7_API_BASE_URL}/search`)
    url.searchParams.set('query', query)

    const fetchStartTime = Date.now()
    const response = await withTimeout(
      fetch(url, {
        headers: buildHeaders(apiKey),
        signal: requestSignal(signal),
      }),
      FETCH_TIMEOUT_MS,
    )
    const fetchDuration = Date.now() - fetchStartTime

    if (!response.ok) {
      logger.error(
        {
          ...searchContext,
          status: response.status,
          statusText: response.statusText,
          fetchDuration,
          totalDuration: Date.now() - searchStartTime,
        },
        `Library search failed with status ${response.status}`,
      )
      return failureFromResponse(response, apiKey, 'Context7 library search')
    }

    const parseStartTime = Date.now()
    // M3-T1: bounded body read + zod validation (fail closed).
    const responseBody = await withTimeout(
      response.json(),
      BODY_READ_TIMEOUT_MS,
    )
    const parsedResponse = SearchResponseSchema.safeParse(responseBody)
    if (!parsedResponse.success) {
      logger.error(
        {
          ...searchContext,
          issues: parsedResponse.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          totalDuration: Date.now() - searchStartTime,
        },
        'Library search returned an invalid response shape',
      )
      return failure(
        'invalid_response',
        'Context7 library search returned a response in an unexpected shape.',
        'Retry later, or use web_search to read the library docs site.',
      )
    }
    const projects = parsedResponse.data
    logger.debug(
      {
        ...searchContext,
        fetchDuration,
        parseDuration: Date.now() - parseStartTime,
        totalDuration: Date.now() - searchStartTime,
        resultsCount: projects.results?.length || 0,
        success: true,
      },
      'Library search completed successfully',
    )

    return { ok: true, results: projects.results }
  } catch (error) {
    logger.error(
      {
        ...searchContext,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error,
        totalDuration: Date.now() - searchStartTime,
        success: false,
      },
      'Error during library search',
    )
    return failureFromError(error, signal, 'Context7 library search')
  }
}

/**
 * Lists matching documentation projects from Context7.
 * @returns Array of projects with their metadata, or null if the request fails
 */
export async function searchLibraries(
  params: ParamsOf<typeof searchLibrariesOutcome>,
): Promise<SearchResult[] | null> {
  const outcome = await searchLibrariesOutcome(params)
  return outcome.ok ? outcome.results : null
}

/**
 * Fetches documentation context for the best-matching library.
 * Returns the documentation, or a typed {@link Context7Failure}.
 */
export async function fetchContext7LibraryDocumentation(
  params: {
    query: string
    tokens?: number
    topic?: string
    folders?: string
    logger: Logger
    fetch: typeof globalThis.fetch
    context7ApiKey?: string
    signal?: AbortSignal
  } & ParamsOf<typeof searchLibrariesOutcome>,
): Promise<Context7DocumentationOutcome> {
  const { query, tokens, topic, folders, logger, fetch, signal } = params
  const apiKey =
    'context7ApiKey' in params ? params.context7ApiKey : readContext7ApiKey()

  const apiStartTime = Date.now()
  const apiContext = {
    query,
    requestedTokens: tokens,
    topic,
    folders,
    hasApiKey: Boolean(apiKey),
  }

  const searchStartTime = Date.now()
  const search = await searchLibrariesOutcome({
    query,
    logger,
    fetch,
    signal,
    context7ApiKey: apiKey,
  })
  const searchDuration = Date.now() - searchStartTime

  if (!search.ok) {
    return search
  }
  const libraries = search.results
  if (libraries.length === 0) {
    logger.warn(
      {
        ...apiContext,
        searchDuration,
        // NOTE(P2-T1): log-only duration telemetry; not persisted.
        totalDuration: Date.now() - apiStartTime,
        librariesFound: 0,
      },
      'No libraries found for query',
    )
    return failure(
      'not_found',
      `Context7 has no library matching "${query}".`,
      'Try the official library name (e.g. "Next.js"), or use web_search to read the docs site.',
    )
  }

  const rankedLibraries = libraries
    .map((library, originalIndex) => ({
      library,
      originalIndex,
      score: rankLibraryCandidate(library, query),
    }))
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
  const selectedLibrary = rankedLibraries[0].library
  const libraryId = selectedLibrary.id

  logger.debug(
    {
      ...apiContext,
      searchDuration,
      librariesFound: libraries.length,
      selectedLibrary: {
        id: selectedLibrary.id,
        title: selectedLibrary.title,
        totalTokens: selectedLibrary.totalTokens,
        stars: selectedLibrary.stars,
      },
    },
    'Selected library for documentation fetch',
  )

  try {
    const url = new URL(`${CONTEXT7_API_BASE_URL}/${libraryId}`)
    if (tokens) url.searchParams.set('tokens', tokens.toString())
    if (topic) url.searchParams.set('topic', topic)
    if (folders) url.searchParams.set('folders', folders)
    url.searchParams.set('type', DEFAULT_TYPE)

    const fetchStartTime = Date.now()
    const response = await withTimeout(
      fetch(url, {
        headers: buildHeaders(apiKey, { 'X-Context7-Source': 'codebuff' }),
        signal: requestSignal(signal),
      }),
      FETCH_TIMEOUT_MS,
    )
    const fetchDuration = Date.now() - fetchStartTime

    if (!response.ok) {
      logger.error(
        {
          ...apiContext,
          libraryId,
          status: response.status,
          statusText: response.statusText,
          searchDuration,
          fetchDuration,
          totalDuration: Date.now() - apiStartTime,
        },
        `Failed to fetch documentation with status ${response.status}`,
      )
      return failureFromResponse(
        response,
        apiKey,
        `Context7 documentation fetch for ${libraryId}`,
      )
    }

    const parseStartTime = Date.now()
    // M3-T1: bounded body read (the fetch timeout only covered the headers).
    const text = await withTimeout(response.text(), BODY_READ_TIMEOUT_MS)
    const parseDuration = Date.now() - parseStartTime
    const totalDuration = Date.now() - apiStartTime

    if (
      !text ||
      text === 'No content available' ||
      text === 'No context data available'
    ) {
      logger.warn(
        {
          ...apiContext,
          libraryId,
          searchDuration,
          fetchDuration,
          parseDuration,
          totalDuration,
          responseLength: text?.length || 0,
          emptyResponse: true,
        },
        'Received empty or no-content response',
      )
      return failure(
        'not_found',
        `Context7 has no documentation content for ${libraryId}${
          topic ? ` (topic: ${topic})` : ''
        }.`,
        'Try a broader topic or another listed library, or use web_search for the docs site.',
      )
    }

    const estimatedTokens = Math.ceil(text.length / 4) // Rough token estimate
    logger.info(
      {
        ...apiContext,
        libraryId,
        libraryTitle: selectedLibrary.title,
        searchDuration,
        fetchDuration,
        parseDuration,
        totalDuration,
        responseLength: text.length,
        estimatedTokens,
        success: true,
      },
      'Documentation fetch completed successfully',
    )

    return {
      ok: true,
      documentation: text,
      selectedLibrary,
      alternatives: rankedLibraries.slice(1, 5).map(({ library }) => library),
    }
  } catch (error) {
    logger.error(
      {
        ...apiContext,
        libraryId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error,
        searchDuration,
        totalDuration: Date.now() - apiStartTime,
        success: false,
      },
      'Error fetching library documentation',
    )
    return failureFromError(
      error,
      signal,
      `Context7 documentation fetch for ${libraryId}`,
    )
  }
}
