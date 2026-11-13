import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// X-5: checksum-verified sidecar artifact resolver feeding
// SidecarSupervisor's `sidecarPath` injection point. Sha256 is the only trust
// anchor here — signature verification (Sigstore) rides the release flow and
// is intentionally out of scope for this slice. The resolver never executes
// or parses the binary; it only materializes and verifies bytes.

/** Upper bound on downloaded sidecar artifacts, enforced incrementally. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'openbuff-sidecars')
const SIDECAR_CACHE_DIR_ENV = 'OPENBUFF_SIDECAR_CACHE_DIR'
const ARTIFACT_FILE_MODE = 0o600
const SHA256_HEX_LENGTH = 64

export type SidecarArtifactErrorReason =
  | 'checksum-mismatch'
  | 'missing'
  | 'network'
  | 'too-large'
  | 'invalid-source'

export class SidecarArtifactError extends Error {
  readonly reason: SidecarArtifactErrorReason

  constructor(
    message: string,
    options: ErrorOptions & { reason: SidecarArtifactErrorReason },
  ) {
    super(message, options)
    this.name = 'SidecarArtifactError'
    this.reason = options.reason
  }
}

export type SidecarArtifactSource =
  | { kind: 'local'; path: string; expectedSha256?: string }
  | { kind: 'download'; url: string; sha256: string }

/**
 * Minimal `node:fs/promises` subset the resolver needs. Injectable so tests
 * run without touching the real filesystem (DI-over-mocking, matching the
 * SidecarSupervisor options style).
 */
export interface SidecarArtifactFsSeam {
  readFile(path: string): Promise<Buffer>
  writeFile(
    path: string,
    data: Buffer,
    options: { mode: number },
  ): Promise<void>
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>
  stat(path: string): Promise<{ isFile(): boolean }>
  unlink(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export interface SidecarArtifactDeps {
  /** Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Defaults to `node:fs/promises`. */
  fsSeam?: SidecarArtifactFsSeam
  /** Defaults to `process.env`; consulted for SIDECAR_CACHE_DIR_ENV. */
  env?: (name: string) => string | undefined
  /** Defaults to SIDECAR_CACHE_DIR_ENV or os.tmpdir()/openbuff-sidecars. */
  cacheDir?: string
  /**
   * Test seam: lowers the download size cap. Production callers always get
   * the 256 MiB MAX_DOWNLOAD_BYTES default.
   */
  maxDownloadBytes?: number
}

const nodeFsSeam: SidecarArtifactFsSeam = {
  readFile: (filePath) => readFile(filePath),
  writeFile: (filePath, data, options) => writeFile(filePath, data, options),
  mkdir: (dirPath, options) => mkdir(dirPath, options),
  stat: (filePath) => stat(filePath),
  unlink: (filePath) => unlink(filePath),
  rename: (from, to) => rename(from, to),
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function isSha256Hex(value: string): boolean {
  return (
    value.length === SHA256_HEX_LENGTH && /^[0-9a-f]+$/.test(value)
  )
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function cacheBasename(url: string): string {
  const base = path.basename(new URL(url).pathname)
  return base.length > 0 ? base : 'sidecar'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null &&
    Symbol.asyncIterator in value
}

async function tryReadFile(
  fs: SidecarArtifactFsSeam,
  filePath: string,
): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath)
  } catch {
    return null
  }
}

async function removeQuietly(
  fs: SidecarArtifactFsSeam,
  filePath: string,
): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch {
    // Nothing to clean up (or the host denies unlinking): the artifact is
    // never served from a path we did not just verify, so a failed cleanup
    // cannot turn into an unverified serve.
  }
}

async function resolveLocalArtifact(
  source: Extract<SidecarArtifactSource, { kind: 'local' }>,
  fs: SidecarArtifactFsSeam,
): Promise<{ path: string }> {
  if (!path.isAbsolute(source.path)) {
    throw new SidecarArtifactError(
      `Sidecar artifact path '${source.path}' must be absolute.`,
      { reason: 'invalid-source' },
    )
  }
  const expectedSha256 = source.expectedSha256?.toLowerCase()
  if (expectedSha256 !== undefined && !isSha256Hex(expectedSha256)) {
    throw new SidecarArtifactError(
      `Sidecar artifact sha256 '${source.expectedSha256}' must be a ${SHA256_HEX_LENGTH}-character hex digest.`,
      { reason: 'invalid-source' },
    )
  }
  try {
    const info = await fs.stat(source.path)
    if (!info.isFile()) {
      throw new SidecarArtifactError(
        `Sidecar artifact '${source.path}' is not a regular file.`,
        { reason: 'missing' },
      )
    }
  } catch (error) {
    if (error instanceof SidecarArtifactError) throw error
    throw new SidecarArtifactError(
      `Sidecar artifact does not exist at '${source.path}': ${describeError(error)}`,
      { reason: 'missing', cause: error },
    )
  }
  if (expectedSha256 !== undefined) {
    let content: Buffer
    try {
      content = await fs.readFile(source.path)
    } catch (error) {
      throw new SidecarArtifactError(
        `Failed to read sidecar artifact '${source.path}': ${describeError(error)}`,
        { reason: 'missing', cause: error },
      )
    }
    const actualSha256 = sha256Hex(content)
    if (actualSha256 !== expectedSha256) {
      throw new SidecarArtifactError(
        `Sidecar artifact '${source.path}' checksum mismatch: expected ${expectedSha256}, got ${actualSha256}.`,
        {
          reason: 'checksum-mismatch',
          cause: { expected: expectedSha256, actual: actualSha256 },
        },
      )
    }
  }
  return { path: source.path }
}

async function fetchResponse(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Response> {
  let response: Response
  try {
    response = await fetchImpl(url)
  } catch (error) {
    throw new SidecarArtifactError(
      `Failed to download sidecar artifact from '${url}': ${describeError(error)}`,
      { reason: 'network', cause: error },
    )
  }
  if (!response.ok) {
    throw new SidecarArtifactError(
      `Sidecar artifact download from '${url}' failed with HTTP status ${response.status}.`,
      { reason: 'network' },
    )
  }
  return response
}

/**
 * Streams the response body while accumulating chunks, aborting as soon as
 * the accumulated size would exceed the cap so host memory is never asked to
 * buffer an unbounded body.
 */
async function readBodyWithCap(
  response: Response,
  maxDownloadBytes: number,
  url: string,
): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > maxDownloadBytes) {
    throw new SidecarArtifactError(
      `Sidecar artifact from '${url}' reports ${contentLength} bytes, exceeding the ${maxDownloadBytes}-byte download cap.`,
      { reason: 'too-large' },
    )
  }
  const body = response.body
  const chunks: Buffer[] = []
  let total = 0
  try {
    if (isAsyncIterable(body)) {
      for await (const chunk of body) {
        const bytes = Buffer.from(chunk)
        if (total + bytes.length > maxDownloadBytes) {
          throw new SidecarArtifactError(
            `Sidecar artifact from '${url}' exceeded the ${maxDownloadBytes}-byte download cap.`,
            { reason: 'too-large' },
          )
        }
        total += bytes.length
        chunks.push(bytes)
      }
    } else if (body !== null) {
      // Fallback for runtimes whose Response body is not async-iterable;
      // the Node/Bun fetch path above always streams.
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > maxDownloadBytes) {
        throw new SidecarArtifactError(
          `Sidecar artifact from '${url}' exceeded the ${maxDownloadBytes}-byte download cap.`,
          { reason: 'too-large' },
        )
      }
      chunks.push(bytes)
    }
  } catch (error) {
    if (error instanceof SidecarArtifactError) throw error
    throw new SidecarArtifactError(
      `Failed to stream the sidecar artifact from '${url}': ${describeError(error)}`,
      { reason: 'network', cause: error },
    )
  }
  return Buffer.concat(chunks)
}

async function resolveDownloadArtifact(
  source: Extract<SidecarArtifactSource, { kind: 'download' }>,
  deps: SidecarArtifactDeps,
  fs: SidecarArtifactFsSeam,
): Promise<{ path: string }> {
  if (!isHttpUrl(source.url)) {
    throw new SidecarArtifactError(
      `Sidecar artifact URL '${source.url}' must be an http(s) URL.`,
      { reason: 'invalid-source' },
    )
  }
  const expectedSha256 = source.sha256.toLowerCase()
  if (!isSha256Hex(expectedSha256)) {
    throw new SidecarArtifactError(
      `Sidecar artifact sha256 '${source.sha256}' must be a ${SHA256_HEX_LENGTH}-character hex digest.`,
      { reason: 'invalid-source' },
    )
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  // No direct process.env default (env-architecture rule): the env seam is
  // caller-supplied only. Without an injected env the optional
  // SIDECAR_CACHE_DIR_ENV override is skipped and the default cache dir is
  // used; production callers wire the seam where env access is sanctioned.
  const cacheDir =
    deps.cacheDir ?? deps.env?.(SIDECAR_CACHE_DIR_ENV) ?? DEFAULT_CACHE_DIR
  const maxDownloadBytes = deps.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES
  const cachePath = path.join(
    cacheDir,
    `${sha256Hex(source.url)}-${cacheBasename(source.url)}`,
  )

  // Serve from cache ONLY after a passing sha256 check: a corrupt entry is
  // discarded and re-downloaded, never served unverified.
  const cached = await tryReadFile(fs, cachePath)
  if (cached !== null) {
    if (sha256Hex(cached) === expectedSha256) {
      return { path: cachePath }
    }
    await removeQuietly(fs, cachePath)
  }

  const response = await fetchResponse(fetchImpl, source.url)
  const bytes = await readBodyWithCap(response, maxDownloadBytes, source.url)
  const actualSha256 = sha256Hex(bytes)
  if (actualSha256 !== expectedSha256) {
    // Delete-any-partial hygiene: nothing was written yet in this buffered
    // path, but a stale cache entry under the same key must never survive a
    // failed verification for a future unverified serve.
    await removeQuietly(fs, cachePath)
    throw new SidecarArtifactError(
      `Sidecar artifact from '${source.url}' checksum mismatch: expected ${expectedSha256}, got ${actualSha256}.`,
      {
        reason: 'checksum-mismatch',
        cause: { expected: expectedSha256, actual: actualSha256 },
      },
    )
  }

  // Atomic publish: bytes are hashed and verified BEFORE any disk write, then
  // land in a 0o600 tmp file renamed over the cache entry so readers never
  // observe a half-written artifact.
  const tmpPath = `${cachePath}.tmp-${randomBytes(8).toString('hex')}`
  try {
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(tmpPath, bytes, { mode: ARTIFACT_FILE_MODE })
    await fs.rename(tmpPath, cachePath)
  } catch (error) {
    await removeQuietly(fs, tmpPath)
    throw new SidecarArtifactError(
      `Failed to persist the sidecar artifact cache at '${cachePath}': ${describeError(error)}`,
      // The fixed reason union has no 'io' discriminant; an unwritable cache
      // means the artifact cannot be materialized, surfaced with the
      // underlying error as cause.
      { reason: 'invalid-source', cause: error },
    )
  }
  return { path: cachePath }
}

/**
 * Resolves a sidecar artifact spec to a locally readable path. Downloaded
 * bytes are only ever exposed after a passing sha256 check; the binary is
 * never executed or parsed here.
 */
export async function resolveSidecarArtifact(
  source: SidecarArtifactSource,
  deps: SidecarArtifactDeps = {},
): Promise<{ path: string }> {
  const fs = deps.fsSeam ?? nodeFsSeam
  if (source.kind === 'local') {
    return resolveLocalArtifact(source, fs)
  }
  return resolveDownloadArtifact(source, deps, fs)
}
