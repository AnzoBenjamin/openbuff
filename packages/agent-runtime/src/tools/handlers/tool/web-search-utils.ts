import { lookup } from 'node:dns/promises'

import {
  classifyHost,
  classifyIpAddress,
} from '@codebuff/common/util/ip-address-policy'
import { fetchPinnedAddress } from '@codebuff/common/util/pinned-fetch'

export const WEBSEARCH_TIMEOUT_MS = 30_000
export const MAX_WEB_FETCH_BYTES = 2_000_000
export const MAX_WEB_FETCH_REDIRECTS = 5

/**
 * Injectable egress seams (N05). Production uses the system resolver and the
 * runtime's fetch; tests inject a resolver to simulate DNS rebinding and a
 * fetch to observe which address was dialed.
 */
export interface WebEgressOptions {
  /** Resolves a hostname to every address (v4 and v6). */
  resolveHost?: (hostname: string) => Promise<string[]>
  /** Fetch used for http and Bun https. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof globalThis.fetch
  /** Overrides runtime detection of Bun's `tls.serverName` support. */
  supportsTlsServerName?: boolean
}

const defaultResolveHost = async (hostname: string): Promise<string[]> => {
  const results = await lookup(hostname, { all: true, verbatim: true })
  return results.map((entry) => entry.address)
}

/**
 * True when an address must not be fetched. Uses the shared egress classifier
 * (`@codebuff/common/util/ip-address-policy`), the same one MCP uses. Text
 * that is not an IP literal is blocked (fail closed).
 */
export function isBlockedWebAddress(address: string): boolean {
  return classifyIpAddress(address).blocked
}

/**
 * Validates a URL for public egress and resolves its host once. Returns the
 * parsed URL and the validated address that the connection must use.
 *
 * Every resolved address is classified; one blocked address refuses the
 * whole host, so a mixed public/private answer cannot be raced.
 */
export async function resolveSafePublicWebTarget(
  rawUrl: string,
  options: WebEgressOptions = {},
): Promise<{ url: URL; address: string }> {
  const parsed = new URL(rawUrl)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only public HTTP(S) URLs may be fetched')
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs containing credentials are not allowed')
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const host = classifyHost(hostname)
  if (host.isIpLiteral) {
    if (host.blocked || !host.address) {
      throw new Error(`Refusing to fetch non-public address: ${hostname}`)
    }
    return { url: parsed, address: host.address }
  }
  if (host.blocked) {
    throw new Error(`Refusing to fetch non-public host: ${hostname}`)
  }

  const resolveHost = options.resolveHost ?? defaultResolveHost
  let resolved: string[]
  try {
    resolved = await resolveHost(hostname)
  } catch (error) {
    throw new Error(
      `Host did not resolve: ${hostname}${
        error instanceof Error && error.message ? ` (${error.message})` : ''
      }`,
    )
  }
  if (resolved.length === 0) {
    throw new Error(`Host did not resolve: ${hostname}`)
  }
  if (resolved.some((address) => isBlockedWebAddress(address))) {
    throw new Error(
      `Refusing to fetch host ${hostname}: resolved to non-public address`,
    )
  }
  return { url: parsed, address: resolved[0] }
}

/** Validates a URL for public egress (resolving DNS) and returns it. */
export async function assertSafePublicWebUrl(
  rawUrl: string,
  options: WebEgressOptions = {},
): Promise<URL> {
  return (await resolveSafePublicWebTarget(rawUrl, options)).url
}

/**
 * Fetches a public URL. Each hop (the first request and every redirect) is
 * validated, resolved once, and dialed at the validated address, so neither
 * a redirect nor a DNS rebind can reach a private address.
 */
export async function fetchPublicWebUrl(params: {
  url: string
  signal: AbortSignal
  headers?: Record<string, string>
  maxRedirects?: number
  egress?: WebEgressOptions
}): Promise<{ response: Response; finalUrl: URL }> {
  const maxRedirects = params.maxRedirects ?? MAX_WEB_FETCH_REDIRECTS
  const egress = params.egress ?? {}
  let target = await resolveSafePublicWebTarget(params.url, egress)

  for (let redirectCount = 0; ; redirectCount++) {
    const response = await fetchPinnedAddress(
      target.url,
      target.address,
      { headers: params.headers, signal: params.signal },
      {
        fetchImpl: egress.fetchImpl,
        supportsTlsServerName: egress.supportsTlsServerName,
      },
    )
    if (response.status < 300 || response.status >= 400) {
      return { response, finalUrl: target.url }
    }
    if (redirectCount >= maxRedirects) {
      await response.body?.cancel()
      throw new Error(`Too many redirects (maximum ${maxRedirects})`)
    }
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location) {
      throw new Error(`Redirect response ${response.status} omitted Location`)
    }
    target = await resolveSafePublicWebTarget(
      new URL(location, target.url).href,
      egress,
    )
  }
}

export async function readResponseTextWithLimit(params: {
  response: Response
  maxBytes?: number
}): Promise<{ text: string; truncated: boolean }> {
  const maxBytes = params.maxBytes ?? MAX_WEB_FETCH_BYTES
  // Declared content-length above the cap is not a hard error: stream and
  // soft-truncate so callers still get a usable prefix with truncated=true.
  // (Matching the no-content-length path.)

  if (!params.response.body) return { text: '', truncated: false }
  const reader = params.response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''
  let truncated = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maxBytes - bytesRead
      if (remaining <= 0) {
        truncated = true
        await reader.cancel()
        break
      }
      const accepted =
        value.byteLength > remaining ? value.subarray(0, remaining) : value
      bytesRead += accepted.byteLength
      text += decoder.decode(accepted, { stream: true })
      if (accepted.byteLength < value.byteLength) {
        truncated = true
        await reader.cancel()
        break
      }
    }
    text += decoder.decode()
    return { text, truncated }
  } finally {
    reader.releaseLock()
  }
}

export type WebSearchResult = {
  title: string
  url: string
  description: string
}

/**
 * Typed web search failure (N04). `blocked` means DuckDuckGo served a bot
 * check, CAPTCHA or rate-limit response instead of results, which is distinct
 * from a query that genuinely has no results.
 */
export type WebSearchFailure = {
  error: string
  status: 'blocked' | 'error'
  reason: string
  nextStep: string
  httpStatus?: number
  retryAfterSeconds?: number
}

const DDG_BLOCK_MARKERS = [
  /anomaly-modal/i,
  /anomaly\.js/i,
  /bots use duckduckgo too/i,
  /challenge-form/i,
  /\bcaptcha\b/i,
  /confirm this search was made by a human/i,
  /unusual traffic/i,
]

/** True when a DuckDuckGo HTML page is a bot check rather than results. */
export function isDuckDuckGoBlockedPage(html: string): boolean {
  return DDG_BLOCK_MARKERS.some((marker) => marker.test(html))
}

const parseRetryAfterSeconds = (value: string | null): number | undefined => {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

const blockedFailure = (
  reason: string,
  httpStatus: number,
  retryAfterSeconds?: number,
): WebSearchFailure => ({
  error: `DuckDuckGo blocked the search request: ${reason}`,
  status: 'blocked',
  reason,
  nextStep:
    retryAfterSeconds !== undefined
      ? `Wait about ${retryAfterSeconds}s before searching again, or fetch a known documentation URL directly with the url parameter.`
      : 'Wait a minute before searching again, or fetch a known documentation URL directly with the url parameter. Do not treat this as "no results".',
  httpStatus,
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
})

/** Execute a bounded, abortable DuckDuckGo HTML search without a subprocess. */
export const executeWebSearch = async (
  query: string,
  depth: 'standard' | 'deep' = 'standard',
  signal: AbortSignal = AbortSignal.timeout(WEBSEARCH_TIMEOUT_MS),
  egress: WebEgressOptions = {},
): Promise<{ results: WebSearchResult[] } | WebSearchFailure> => {
  const limit = depth === 'deep' ? 10 : 5

  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const { response } = await fetchPublicWebUrl({
      url: searchUrl,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; Openbuff/1.0; +https://openbuff.dev)',
      },
      signal,
      egress,
    })
    const retryAfterSeconds = parseRetryAfterSeconds(
      response.headers.get('retry-after'),
    )
    if (response.status === 429 || response.status === 403) {
      await response.body?.cancel()
      return blockedFailure(
        `HTTP ${response.status} ${response.statusText}`.trim(),
        response.status,
        retryAfterSeconds,
      )
    }
    if (!response.ok) {
      await response.body?.cancel()
      return {
        error: `DuckDuckGo search failed: HTTP ${response.status} ${response.statusText}`,
        status: 'error',
        reason: `HTTP ${response.status} ${response.statusText}`.trim(),
        nextStep: 'Retry the search later or fetch a known URL directly.',
        httpStatus: response.status,
      }
    }
    const { text } = await readResponseTextWithLimit({ response })
    const results = parseDuckDuckGoHtml(text)
    // DuckDuckGo answers a bot check with HTTP 202 and an "anomaly" page.
    if (
      results.length === 0 &&
      (response.status === 202 || isDuckDuckGoBlockedPage(text))
    ) {
      return blockedFailure(
        'the response was a bot-check (anomaly/CAPTCHA) page, not results',
        response.status,
        retryAfterSeconds,
      )
    }
    return { results: results.slice(0, limit) }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Unknown web search error: ${String(error)}`
    return {
      error: message,
      status: 'error',
      reason: message,
      nextStep: 'Retry the search later or fetch a known URL directly.',
    }
  }
}

export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const anchor =
    /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchor.exec(html)) !== null) {
    const rawHref = decodeHtmlEntities(match[1] ?? '')
    const title = stripHtml(decodeHtmlEntities(match[2] ?? ''))
    let url = rawHref
    try {
      const parsed = new URL(rawHref, 'https://html.duckduckgo.com')
      url = parsed.searchParams.get('uddg') ?? parsed.href
    } catch {
      continue
    }
    if (!/^https?:\/\//i.test(url)) continue
    const following = html.slice(anchor.lastIndex, anchor.lastIndex + 4_000)
    const snippet = following.match(
      /<(?:a|div)\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i,
    )
    results.push({
      title,
      url,
      description: snippet
        ? stripHtml(decodeHtmlEntities(snippet[1] ?? ''))
        : '',
    })
  }
  return results
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
}

/**
 * Strip HTML tags and decode common entities from an HTML string,
 * returning clean plain text suitable for LLM consumption.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export type PageLink = { href: string; text: string }

/**
 * Extract links from raw HTML, resolving relative URLs against baseUrl.
 * Filters out fragment-only anchors and javascript: links.
 * Deduplicates by href and caps at maxLinks.
 */
export function extractLinks(
  html: string,
  baseUrl: string,
  maxLinks: number,
): PageLink[] {
  const seen = new Set<string>()
  const links: PageLink[] = []
  const re = /<a[^>]+href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return []
  }
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null && links.length < maxLinks) {
    const rawHref = match[1]?.trim()
    const rawText = match[2]
      ?.replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!rawHref || rawHref.startsWith('javascript:')) continue
    let href: string
    try {
      href = new URL(rawHref, base).href
    } catch {
      continue
    }
    if (seen.has(href)) continue
    seen.add(href)
    links.push({ href, text: rawText ?? '' })
  }
  return links
}

/**
 * If the URL is a github.com/{owner}/{repo} repo page, returns the raw
 * README URL at raw.githubusercontent.com/{owner}/{repo}/HEAD/README.md.
 * Returns null for any other URL.
 */
export function resolveGitHubUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== 'github.com') return null
  // Path should be /{owner}/{repo} optionally followed by /tree/{branch} or nothing further
  const parts = parsed.pathname.replace(/^\//, '').split('/')
  if (parts.length < 2 || !parts[0] || !parts[1]) return null
  const owner = parts[0]
  const repo = parts[1]
  // For blob/{branch}/{path} — convert to raw file URL
  if (parts.length > 4 && parts[2] === 'blob' && parts[3] && parts[4]) {
    const branch = parts[3]
    const filePath = parts.slice(4).join('/')
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`
  }
  // Only handle root repo pages or /tree/* — not issues, pulls, blob without path, etc.
  if (parts.length > 2 && parts[2] !== 'tree') return null
  return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`
}
