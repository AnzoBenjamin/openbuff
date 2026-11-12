import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import * as zlib from 'node:zlib'

/**
 * Pinned-address HTTP(S) requests (N05, generalized from the MCP NEW-7
 * design in `common/src/mcp/dns-pinning.ts`).
 *
 * A caller resolves a hostname once, validates every resolved address, and
 * then dials the validated address here, so the check and the connection use
 * the same lookup and a low-TTL DNS rebind cannot move the socket.
 *
 * Two transports keep TLS certificate validation against the original name:
 *
 * - Bun: `fetch` to the IP literal, with the original `Host` header and the
 *   Bun-only `tls.serverName` RequestInit extension for SNI and certificate
 *   checks ({@link buildPinnedRequest}).
 * - Other runtimes (Node/undici ignore `tls.serverName`): `node:http(s)`
 *   with a `lookup` hook that always answers with the pinned address
 *   ({@link nodePinnedRequest}). The request keeps its real hostname, so SNI,
 *   `Host` and certificate validation are unchanged.
 *
 * Redirects are never followed here; callers re-validate each hop.
 */

/**
 * True when this runtime honors the Bun-only `tls` RequestInit extension
 * (`tls.serverName`). Bun defines the global; Node/undici does not.
 */
export const runtimeSupportsTlsServerName = (): boolean =>
  (globalThis as { Bun?: unknown }).Bun !== undefined

const stripBrackets = (host: string): string => host.replace(/^\[|\]$/g, '')

const authorityFor = (host: string, port: string): string =>
  port ? `${host}:${port}` : host

/**
 * Rewrites `requestUrl` to dial `address` while preserving the original
 * authority in the `Host` header and, for https, in `tls.serverName`.
 * Forces `redirect: 'manual'`.
 */
export function buildPinnedRequest(
  requestUrl: URL,
  address: string,
  init: RequestInit = {},
  port: string = requestUrl.port,
): { url: URL; init: RequestInit & { tls?: { serverName?: string } } } {
  const pinnedUrl = new URL(requestUrl.href)
  pinnedUrl.hostname = isIP(address) === 6 ? `[${address}]` : address
  if (port) {
    pinnedUrl.port = port
  }
  const headers = new Headers(init.headers)
  const originalHost = stripBrackets(requestUrl.hostname)
  if (!headers.has('host')) {
    headers.set('host', authorityFor(requestUrl.hostname, requestUrl.port))
  }
  const pinnedInit: RequestInit & { tls?: { serverName?: string } } = {
    ...init,
    headers,
    redirect: 'manual',
  }
  if (requestUrl.protocol === 'https:') {
    const existing = (init as { tls?: { serverName?: string } }).tls ?? {}
    pinnedInit.tls = { ...existing, serverName: originalHost }
  }
  return { url: pinnedUrl, init: pinnedInit }
}

export interface NodePinnedRequestInit {
  method?: string
  headers?: HeadersInit
  body?: string
  signal?: AbortSignal
}

const decodeBody = (
  stream: Readable,
  encoding: string | null,
): { stream: Readable; decoded: boolean } => {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return { stream: stream.pipe(zlib.createGunzip()), decoded: true }
    case 'deflate':
      return { stream: stream.pipe(zlib.createInflate()), decoded: true }
    case 'br':
      return {
        stream: stream.pipe(zlib.createBrotliDecompress()),
        decoded: true,
      }
    default:
      return { stream, decoded: false }
  }
}

/**
 * Issues one request through `node:http`/`node:https` with DNS answered by
 * `address`. Never follows redirects. Returns a WHATWG `Response`.
 */
export async function nodePinnedRequest(
  requestUrl: URL,
  address: string,
  init: NodePinnedRequestInit = {},
): Promise<Response> {
  const isHttps = requestUrl.protocol === 'https:'
  const mod = isHttps ? await import('node:https') : await import('node:http')
  const family = isIP(address)
  if (family === 0) {
    throw new Error('Pinned address is not an IP literal')
  }
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value
  })
  if (!('accept-encoding' in headers)) {
    headers['accept-encoding'] = 'gzip, deflate, br'
  }

  return new Promise<Response>((resolve, reject) => {
    const req = mod.request(
      requestUrl,
      {
        method: init.method ?? 'GET',
        headers,
        signal: init.signal,
        lookup: (
          _hostname: string,
          options: { all?: boolean } | number | undefined,
          callback: (...args: unknown[]) => void,
        ) => {
          if (typeof options === 'object' && options?.all) {
            callback(null, [{ address, family }])
          } else {
            callback(null, address, family)
          }
        },
        ...(isHttps ? { servername: stripBrackets(requestUrl.hostname) } : {}),
      } as Parameters<typeof mod.request>[1],
      (res) => {
        const status = res.statusCode ?? 0
        if (status < 200 || status > 599) {
          res.destroy()
          reject(new Error(`Unsupported HTTP status ${status}`))
          return
        }
        const responseHeaders = new Headers()
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1])
        }
        const noBody =
          status === 204 || status === 304 || (init.method ?? 'GET') === 'HEAD'
        let body: ReadableStream<Uint8Array> | null = null
        if (noBody) {
          res.resume()
        } else {
          const { stream, decoded } = decodeBody(
            res,
            responseHeaders.get('content-encoding'),
          )
          if (decoded) {
            responseHeaders.delete('content-encoding')
            responseHeaders.delete('content-length')
          }
          body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
        }
        resolve(
          new Response(body, {
            status,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(init.body)
  })
}

export interface PinnedFetchOptions {
  /** Defaults to {@link runtimeSupportsTlsServerName}. */
  supportsTlsServerName?: boolean
  /** Defaults to the current `globalThis.fetch` (looked up per call). */
  fetchImpl?: typeof globalThis.fetch
}

/**
 * Fetches `requestUrl` while connecting only to `address`. http and Bun https
 * use `fetch` with a rewritten authority; https on runtimes without
 * `tls.serverName` uses {@link nodePinnedRequest}.
 */
export async function fetchPinnedAddress(
  requestUrl: URL,
  address: string,
  init: NodePinnedRequestInit = {},
  options: PinnedFetchOptions = {},
): Promise<Response> {
  const supportsTlsServerName =
    options.supportsTlsServerName ?? runtimeSupportsTlsServerName()
  if (requestUrl.protocol === 'https:' && !supportsTlsServerName) {
    return nodePinnedRequest(requestUrl, address, init)
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const pinned = buildPinnedRequest(requestUrl, address, init)
  return fetchImpl(pinned.url, pinned.init)
}
