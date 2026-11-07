import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { isBlockedMcpAddress } from './client'

/**
 * NEW-7 DNS-rebinding pinning for client-origin (untrusted) http/sse MCP
 * servers.
 *
 * The literal-hostname check in `isBlockedMcpAddress` runs before a transport
 * is constructed, but it does not resolve DNS: a hostname that resolves to a
 * public IP at check time can be re-resolved to a private/metadata IP by the
 * time the socket opens (a TOCTOU / DNS-rebinding gap). This module closes
 * that gap for the http/sse fetch path by:
 *
 * 1. Resolving the configured hostname ONCE via `node:dns/promises` lookup
 *    (all records, v4 + v6),
 * 2. validating EVERY resolved address against the same blocklist
 *    (`isBlockedMcpAddress`) — refusing when resolution fails or ANY address
 *    is blocked (fail closed), unless the address is allowlisted via
 *    `serve.allowedLoopbackMcp`, and
 * 3. PINNING the connection to a validated address by rewriting the request
 *    authority to that address while preserving the original `Host` header
 *    and TLS SNI (`tls.serverName`), so a later re-resolution to a private
 *    IP cannot be used. Redirects are NOT followed (`redirect: 'manual'`), so
 *    a redirect to an attacker-rebindable host never re-enters resolution.
 *
 * The available fetch runtimes (Bun fetch / undici) do NOT expose undici's
 * `connect.lookup` through the fetch `RequestInit`, so the pin is applied at
 * the URL-authority layer: the socket connects to the pinned IP literal and
 * the original hostname is carried only by SNI/Host. The `tls` RequestInit
 * extension that preserves SNI for a pinned-IP https URL is Bun-only, so
 * https pinning is applied ONLY on a runtime that honors it
 * ({@link runtimeSupportsTlsServerName}); on Node/undici a pinned-IP https
 * URL dials with no serverName and certificate validation would fail for
 * EVERY pinned https server, while keeping the ORIGINAL https URL would
 * skip the authority pin and reopen the check-then-connect rebinding gap.
 * https there therefore FAILS CLOSED: {@link createPinnedMcpFetch} throws
 * {@link McpDnsRebindingError} (naming the host) instead of dialing
 * unpinned — the only exception is an explicitly allowlisted loopback
 * address (`serve.allowedLoopbackMcp`), which proceeds through the pinned
 * path (http keeps the authority pin, which needs no SNI). No address is
 * leaked into the refusal error message beyond the blocked host itself.
 */

export interface DnsPinningOptions {
  /**
   * Loopback `host:port` authorities explicitly allowlisted via
   * `serve.allowedLoopbackMcp`. An address is exempt from the blocklist only
   * when its `host:port` appears here.
   */
  allowedLoopbackMcp?: readonly string[]
  /**
   * Whether the runtime honors the Bun-only `tls` RequestInit extension
   * (`tls.serverName`), which preserves certificate validation for a
   * pinned-IP https URL. Defaults to {@link runtimeSupportsTlsServerName};
   * injectable so the Node/undici behavior (no SNI extension) is exercisable
   * under a Bun test runner. When false, non-allowlisted https requests fail
   * closed: {@link createPinnedMcpFetch} throws {@link McpDnsRebindingError}
   * rather than dialing https without the authority pin.
   */
  supportsTlsServerName?: boolean
  /**
   * DNS resolution override, injectable for tests. Defaults to
   * `node:dns/promises` `lookup` with `{ all: true, verbatim: true }`.
   */
  resolveHost?: (hostname: string) => Promise<string[]>
}

type LookupResult = Array<{ address: string; family: number }>

const defaultResolveHost = async (hostname: string): Promise<string[]> => {
  const results: LookupResult = await lookup(hostname, {
    all: true,
    verbatim: true,
  })
  return results.map((r) => r.address)
}

/**
 * Thrown when a client-origin remote MCP server fails DNS-resolution
 * validation: the hostname cannot be resolved, or at least one resolved
 * address is a blocked private/loopback/link-local/CGNAT/metadata address
 * that is not allowlisted. The error never embeds a resolved IP address.
 */
export class McpDnsRebindingError extends Error {
  readonly hostname: string

  constructor(hostname: string, reason: string) {
    super(
      `MCP client-origin server host "${hostname}" refused: ${reason}. ` +
        `Allowlist loopback addresses via the OPENBUFF_ALLOWED_LOOPBACK_MCP ` +
        `environment variable (comma-separated host:port entries) to permit ` +
        `a local server.`,
    )
    this.name = 'McpDnsRebindingError'
    this.hostname = hostname
  }
}

const authorityFor = (host: string, port: string): string =>
  port ? `${host}:${port}` : host

/**
 * True when `host:port` appears in the `serve.allowedLoopbackMcp` allowlist.
 * Shared by the synchronous literal guard in `client.ts` and the
 * DNS-resolution path here so both apply identical allowlist semantics.
 */
export const isAllowedLoopbackMcpAuthority = (
  address: string,
  port: string,
  allowed: readonly string[] | undefined,
): boolean => {
  if (!allowed || allowed.length === 0) {
    return false
  }
  const host = address.toLowerCase()
  return allowed.some(
    (entry) => entry.toLowerCase() === authorityFor(host, port),
  )
}

/**
 * True when this runtime honors the Bun-only `tls` RequestInit extension
 * (`tls.serverName`): the extension lets a fetch to a pinned-IP https URL
 * still present the original hostname, so certificate validation keeps
 * working. Bun defines the global; Node/undici does not (and silently
 * ignores the extension, leaving a pinned-IP https request with no SNI).
 */
export const runtimeSupportsTlsServerName = (): boolean =>
  (globalThis as { Bun?: unknown }).Bun !== undefined

/**
 * Reads the OPENBUFF_ALLOWED_LOOPBACK_MCP environment variable — the
 * process-level config surface for `serve.allowedLoopbackMcp` — as
 * comma-separated `host:port` entries. Returns undefined when the variable
 * is unset, blank, or yields no non-empty entries, so callers fall back to
 * "no allowlist" (fail closed) rather than an empty-entry artifact.
 */
export function allowedLoopbackMcpFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | undefined {
  const raw = env.OPENBUFF_ALLOWED_LOOPBACK_MCP
  if (raw === undefined || raw.trim().length === 0) {
    return undefined
  }
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return entries.length > 0 ? entries : undefined
}

/**
 * Returns the literal host (`hostname` with any IPv6 brackets stripped) and
 * port for an http/sse URL, or null for a non-http(s) scheme (which is not a
 * remote MCP URL and is left to the caller's normal handling).
 */
const parseHttpUrl = (
  url: URL,
): { host: string; port: string } | null => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port }
}

/**
 * Resolves `url`'s hostname once and returns a validated, pin-ready plan:
 * the original URL (for `Host`/SNI) plus the pinned literal address to dial.
 *
 * Fail-closed rules, in order:
 * - a non-http(s) URL is not a remote MCP server and returns null (the
 *   caller keeps its normal handling);
 * - a hostname that is already an IP literal (or a blocked literal name per
 *   `isBlockedMcpAddress`) needs no resolution: it is validated directly;
 * - DNS resolution failure throws {@link McpDnsRebindingError};
 * - ANY resolved address that `isBlockedMcpAddress` blocks, and that is not
 *   allowlisted via `allowedLoopbackMcp` (matched as `host:port`), throws.
 *
 * The first validated, non-blocked address is the pin target.
 */
export async function resolvePinnedMcpAddress(
  url: URL,
  options: DnsPinningOptions = {},
): Promise<{ address: string; port: string } | null> {
  const parsed = parseHttpUrl(url)
  if (!parsed) {
    return null
  }
  const { host, port } = parsed
  const allowed = options.allowedLoopbackMcp ?? []

  // A literal IP (or numeric-IPv4 shorthand / blocked hostname) is validated
  // directly; there is nothing to resolve and nothing to re-pin.
  if (isIP(host) !== 0 || isBlockedMcpAddress(host)) {
    if (isBlockedMcpAddress(host) && !isAllowedLoopbackMcpAuthority(host, port, allowed)) {
      throw new McpDnsRebindingError(
        host,
        'host is a private/loopback/link-local/metadata address',
      )
    }
    return isIP(host) !== 0 ? { address: host, port } : null
  }

  const resolveHost = options.resolveHost ?? defaultResolveHost
  let addresses: string[]
  try {
    addresses = await resolveHost(host)
  } catch {
    // Fail closed: do not leak resolver detail (or any partial address).
    throw new McpDnsRebindingError(host, 'DNS resolution failed')
  }
  if (!addresses || addresses.length === 0) {
    throw new McpDnsRebindingError(host, 'DNS resolution returned no addresses')
  }

  // Validate EVERY resolved address before choosing a pin target: a hostname
  // with even one blocked address is refused outright, so an attacker cannot
  // race the resolver across check and connect.
  // Track the two pin-target classes separately so the documented invariant
  // holds regardless of resolution order: an allowlisted loopback record is
  // permitted but NEVER selected as a pin target when a public address is
  // also present, even if the loopback record resolves first.
  let publicTarget: string | null = null
  let allowlistedTarget: string | null = null
  for (const address of addresses) {
    if (isBlockedMcpAddress(address)) {
      if (!isAllowedLoopbackMcpAuthority(address, port, allowed)) {
        throw new McpDnsRebindingError(
          host,
          'hostname resolves to a private/loopback/link-local/metadata address',
        )
      }
      // Allowlisted loopback: permitted, but never selected as a pin target
      // when a public address is also present.
      allowlistedTarget ??= address
      continue
    }
    publicTarget ??= address
  }
  const pinTarget = publicTarget ?? allowlistedTarget

  // Unreachable in practice (length checked above) but keeps the invariant
  // explicit and total.
  if (pinTarget === null) {
    throw new McpDnsRebindingError(host, 'DNS resolution returned no usable address')
  }
  return { address: pinTarget, port }
}

/**
 * Builds the `fetch` implementation handed to a client-origin
 * `StreamableHTTPClientTransport` / `SSEClientTransport`. Every request the
 * transport makes (POST send, GET/SSE stream, and the SSE `EventSource`
 * connection, which the SDK routes through this same fetch) is:
 *
 * - resolved + validated via {@link resolvePinnedMcpAddress} (refusing BEFORE
 *   any socket opens when resolution fails or any address is blocked),
 * - pinned to the validated address by rewriting the URL authority while
 *   preserving the original `Host` header and TLS SNI, and
 * - issued with `redirect: 'manual'`, so redirects are never followed, and
 * - on a runtime WITHOUT the Bun-only `tls` RequestInit extension, https is
 *   REFUSED (fail closed, {@link McpDnsRebindingError}) unless the resolved
 *   address is an explicitly allowlisted loopback, because a pinned-IP
 *   https URL there cannot preserve SNI and keeping the original URL would
 *   skip the authority pin.
 *
 * The returned function is stable for the lifetime of one transport: the pin
 * is re-validated per request, so a re-resolution between requests cannot
 * silently move the connection to a blocked address.
 */
export function createPinnedMcpFetch(
  options: DnsPinningOptions = {},
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const requestUrl =
      typeof input === 'string'
        ? new URL(input)
        : input instanceof URL
          ? new URL(input.href)
          : new URL(input.url)

    const pin = await resolvePinnedMcpAddress(requestUrl, options)

    // Redirects are never followed: a redirect to an attacker-rebindable
    // host must not re-enter DNS resolution and bypass the pin.
    const requestInit: RequestInit = { ...init, redirect: 'manual' }

    if (!pin) {
      return fetch(input, requestInit)
    }

    // Runtime-aware https pin (NEW-7): on a runtime WITHOUT the Bun-only
    // `tls` RequestInit extension (Node/undici), a pinned-IP https URL dials
    // with no SNI/serverName and certificate validation would fail for EVERY
    // pinned https server — while keeping the ORIGINAL https URL would skip
    // the authority pin and reopen the check-then-connect DNS-rebinding
    // TOCTOU. Fail closed instead: refuse unpinned https outright, EXCEPT
    // for an explicitly allowlisted loopback address
    // (`serve.allowedLoopbackMcp`), which falls through to the pinned path
    // below. http keeps the authority pin, which needs no SNI.
    const supportsTlsServerName =
      options.supportsTlsServerName ?? runtimeSupportsTlsServerName()
    if (
      requestUrl.protocol === 'https:' &&
      !supportsTlsServerName &&
      !isAllowedLoopbackMcpAuthority(
        pin.address,
        pin.port,
        options.allowedLoopbackMcp,
      )
    ) {
      throw new McpDnsRebindingError(
        requestUrl.hostname.replace(/^\[|\]$/g, ''),
        'pinned https dial is unsupported on this runtime: connecting without the authority pin would reopen DNS rebinding',
      )
    }

    const pinnedUrl = new URL(requestUrl.href)
    pinnedUrl.hostname = isIP(pin.address) === 6 ? `[${pin.address}]` : pin.address
    if (pin.port) {
      pinnedUrl.port = pin.port
    }

    // Preserve the original authority for Host-based routing and TLS SNI: the
    // socket dials the pinned IP literal, but the server still sees the
    // configured hostname (and the certificate is validated against it).
    const headers = new Headers(init.headers)
    if (!headers.has('host')) {
      headers.set('host', authorityFor(requestUrl.hostname.replace(/^\[|\]$/g, ''), requestUrl.port))
    }
    requestInit.headers = headers

    const bunInit = requestInit as RequestInit & {
      tls?: { serverName?: string }
    }
    if (requestUrl.protocol === 'https:') {
      bunInit.tls = {
        ...(bunInit.tls ?? {}),
        serverName: requestUrl.hostname.replace(/^\[|\]$/g, ''),
      }
    }

    return fetch(pinnedUrl, bunInit)
  }
}
