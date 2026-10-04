import fs from 'node:fs'
import path from 'node:path'

import { getLanguageToolSpecs } from '@codebuff/common/util/language-capabilities'
import { LANGUAGE_CAPABILITY_REGISTRY } from '@codebuff/common/util/language-capabilities'

import type { ChildProcess } from 'node:child_process'
import type {
  LanguageToolSpec,
  SupportedLanguageId,
} from '@codebuff/common/util/language-capabilities'

/**
 * P3-T1 (LI-01): LSP multiplexer.
 *
 * One warm language-server process per (languageId, projectRoot), selected from
 * the LanguageToolSpec registry. LSP uses `Content-Length: <n>\r\n\r\n<json>`
 * framing over stdio (NOT line-delimited JSON like the sidecar supervisor), so
 * this module owns its own framed transport. Every external effect — process
 * spawn, root discovery — sits behind an injected seam so unit tests are
 * hermetic and never spawn a real tsserver/pyright/etc.
 *
 * Design/bounds:
 * - Lazy cold start with a bounded initialize timeout (typed error).
 * - LRU eviction across warm servers (`maxServers`); evicting stops the server.
 * - Per-request timeout and a bounded pending-request map.
 * - Bounded frame-reassembly buffer (fail closed on a runaway peer).
 * - A crashed server is restarted once (with backoff) before failing.
 * - `syncFile` is the seam the mutation broker calls for didOpen/didChange/
 *   didClose; it is intentionally a no-op-safe standalone method.
 */

const DEFAULT_MAX_SERVERS = 4
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_MAX_PENDING_REQUESTS = 256
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024
const RESTART_BACKOFF_MS = 200
/** Poll interval while an evictor waits for reserved-but-starting slots to settle. */
const EVICT_WAIT_POLL_MS = 25
const INITIALIZE_REQUEST_ID = 1

export type LspPosition = { line: number; character: number }
export type LspRange = { start: LspPosition; end: LspPosition }
export type LspLocation = { uri: string; range: LspRange }

export type LspHover = {
  contents: unknown
  range?: LspRange
}

export type LspSymbolKind = number
export type LspDocumentSymbol = {
  name: string
  kind: LspSymbolKind
  range: LspRange
  selectionRange: LspRange
  detail?: string
  children?: LspDocumentSymbol[]
}

export type LspWorkspaceSymbol = {
  name: string
  kind: LspSymbolKind
  location: LspLocation
  containerName?: string
}

export type LspServerUnavailableReason =
  | 'unsupported-language'
  | 'no-server-spec'
  | 'tcp-transport'

export type LspServerFailureReason =
  | 'spawn-failed'
  | 'timeout'
  | 'crashed'
  | 'unavailable'
  | 'protocol'
  | 'pending-limit'
  | 'stopped'
  | 'disposed'

export class LspServerUnavailableError extends Error {
  readonly reason: LspServerUnavailableReason
  readonly languageId?: SupportedLanguageId

  constructor(
    message: string,
    options: ErrorOptions & {
      reason: LspServerUnavailableReason
      languageId?: SupportedLanguageId
    },
  ) {
    super(message, options)
    this.name = 'LspServerUnavailableError'
    this.reason = options.reason
    this.languageId = options.languageId
  }
}

export class LspServerError extends Error {
  readonly reason: LspServerFailureReason

  constructor(
    message: string,
    options: ErrorOptions & { reason: LspServerFailureReason },
  ) {
    super(message, options)
    this.name = 'LspServerError'
    this.reason = options.reason
  }
}

export type LspSpawnSpec = {
  argv: readonly string[]
  cwd: string
}

/**
 * The only external effect: spawn a language-server process. Injected so tests
 * supply a fake Duplex-backed child. The returned object only needs the
 * stdin/stdout/kill surface the multiplexer drives.
 */
export type LspSpawner = (spec: LspSpawnSpec) => LspChildHandle

export type LspChildHandle = {
  pid?: number
  stdin: { write(chunk: string): void; end(): void }
  stdout: {
    on(event: 'data', listener: (chunk: Buffer) => void): void
  }
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
  on(event: 'error', listener: (error: unknown) => void): void
  kill(signal?: string): void
}

/** Discovers the project root for a file (drives per-root server keying). */
export type LspRootResolver = (params: {
  filePath: string
  rootMarkers: readonly string[]
}) => string

export type LspMultiplexerOptions = {
  spawner: LspSpawner
  rootResolver?: LspRootResolver
  maxServers?: number
  requestTimeoutMs?: number
  startupTimeoutMs?: number
  maxPendingRequests?: number
  maxFrameBytes?: number
  onEvent?: (event: LspMultiplexerEvent) => void
}

export type LspMultiplexerEvent =
  | { kind: 'started'; key: string; languageId: SupportedLanguageId; rootUri: string }
  | { kind: 'evicted'; key: string }
  | { kind: 'restart'; key: string; reason: string }
  | { kind: 'gave-up'; key: string; reason: string }
  | { kind: 'disposed' }

type PendingEntry = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  method: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function unrefTimer(timer: unknown): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer as { unref: () => void }).unref()
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    unrefTimer(setTimeout(resolve, milliseconds))
  })
}

function filePathToUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${withSlash
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/g, ':'))
    .join('/')}`
}

/**
 * One warm language-server connection: owns the framed transport, the
 * initialize handshake, per-request correlation/timeouts, and the document
 * sync notifications for a single (languageId, rootUri).
 */
class LspServerConnection {
  private child: LspChildHandle | null = null
  private readonly pending = new Map<number, PendingEntry>()
  private nextRequestId = INITIALIZE_REQUEST_ID + 1
  private frameBuffer: Buffer = Buffer.alloc(0)
  private running = false
  private readonly opened = new Map<string, number>()
  private readonly spawner: LspSpawner
  private readonly spawnSpec: LspSpawnSpec
  private readonly requestTimeoutMs: number
  private readonly startupTimeoutMs: number
  private readonly maxPendingRequests: number
  private readonly maxFrameBytes: number
  private readonly onCrash: (reason: string) => void
  private stopRequested = false

  constructor(params: {
    spawner: LspSpawner
    spawnSpec: LspSpawnSpec
    requestTimeoutMs: number
    startupTimeoutMs: number
    maxPendingRequests: number
    maxFrameBytes: number
    onCrash: (reason: string) => void
  }) {
    this.spawner = params.spawner
    this.spawnSpec = params.spawnSpec
    this.requestTimeoutMs = params.requestTimeoutMs
    this.startupTimeoutMs = params.startupTimeoutMs
    this.maxPendingRequests = params.maxPendingRequests
    this.maxFrameBytes = params.maxFrameBytes
    this.onCrash = params.onCrash
  }

  get isRunning(): boolean {
    return this.running
  }

  async start(rootUri: string): Promise<void> {
    const child = this.spawner(this.spawnSpec)
    this.child = child
    this.frameBuffer = Buffer.alloc(0)
    child.stdout.on('data', (chunk) => this.consume(chunk))
    child.on('exit', (code, signal) => {
      this.handleGone(`exit code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`)
    })
    child.on('error', (error) => {
      this.handleGone(
        `spawn error: ${error instanceof Error ? error.message : describeValue(error)}`,
      )
    })
    await this.send(
      INITIALIZE_REQUEST_ID,
      {
        jsonrpc: '2.0',
        id: INITIALIZE_REQUEST_ID,
        method: 'initialize',
        params: {
          processId: null,
          rootUri,
          capabilities: {
            textDocument: {
              synchronization: { didSave: false, dynamicRegistration: false },
              definition: { dynamicRegistration: false },
              references: { dynamicRegistration: false },
              hover: { dynamicRegistration: false },
              documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
            },
          },
        },
      },
      'initialize',
      this.startupTimeoutMs,
    ).catch((error) => {
      this.killChild()
      throw error instanceof LspServerError
        ? error
        : new LspServerError('LSP initialize handshake failed.', {
            reason: 'protocol',
            cause: error,
          })
    })
    this.notify('initialized', {})
    this.running = true
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.running || !this.child) {
      throw new LspServerError(`LSP server is not running; '${method}' rejected.`, {
        reason: 'stopped',
      })
    }
    if (this.pending.size >= this.maxPendingRequests) {
      throw new LspServerError(
        `LSP pending-request limit of ${this.maxPendingRequests} reached.`,
        { reason: 'pending-limit' },
      )
    }
    const id = this.nextRequestId++
    return this.send(id, { jsonrpc: '2.0', id, method, params }, method, this.requestTimeoutMs)
  }

  notify(method: string, params: unknown): void {
    const child = this.child
    if (!child) return
    try {
      this.write(child, { jsonrpc: '2.0', method, params })
    } catch {
      // A write failure surfaces through the exit/error event which rejects
      // pending requests; the notification is best-effort by LSP contract.
    }
  }

  didOpen(uri: string, languageId: string, version: number, text: string): void {
    this.opened.set(uri, version)
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text },
    })
  }

  didChange(uri: string, version: number, text: string): void {
    this.opened.set(uri, version)
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    })
  }

  didClose(uri: string): void {
    this.opened.delete(uri)
    this.notify('textDocument/didClose', { textDocument: { uri } })
  }

  versionOf(uri: string): number | undefined {
    return this.opened.get(uri)
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    this.running = false
    if (this.child) {
      try {
        this.notify('exit', undefined)
      } catch {
        /* best-effort */
      }
    }
    this.rejectAll(
      new LspServerError('LSP server stopped with requests in flight.', {
        reason: 'stopped',
      }),
    )
    await this.killChild()
    this.frameBuffer = Buffer.alloc(0)
    this.opened.clear()
  }

  private send(
    id: number,
    message: Record<string, unknown>,
    method: string,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const child = this.child
      if (!child) {
        reject(
          new LspServerError(`LSP child unavailable for '${method}'.`, {
            reason: 'stopped',
          }),
        )
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new LspServerError(
            `LSP request '${method}' timed out after ${timeoutMs}ms.`,
            { reason: 'timeout' },
          ),
        )
      }, timeoutMs)
      unrefTimer(timer)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.write(child, message)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(
          new LspServerError(`Failed to send LSP request '${method}'.`, {
            reason: 'crashed',
            cause: error,
          }),
        )
      }
    })
  }

  private write(child: LspChildHandle, message: Record<string, unknown>): void {
    const body = JSON.stringify(message)
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
  }

  private consume(chunk: Buffer): void {
    this.frameBuffer =
      this.frameBuffer.length === 0 ? chunk : Buffer.concat([this.frameBuffer, chunk])
    // Fail closed on a runaway peer before parsing further.
    if (this.frameBuffer.length > this.maxFrameBytes) {
      this.handleGone(`frame buffer exceeded ${this.maxFrameBytes} bytes`)
      return
    }
    for (;;) {
      const headerEnd = this.frameBuffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.frameBuffer.subarray(0, headerEnd).toString('utf8')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        // Fail closed on a malformed header: a header block with no parseable
        // Content-Length means the peer is not speaking LSP framing (corrupt
        // or hostile server). Resynchronizing mid-stream would let arbitrary
        // bytes be reinterpreted as frames, so the connection is torn down.
        this.handleGone('malformed LSP header: missing Content-Length')
        return
      }
      const length = Number(match[1])
      if (!Number.isFinite(length) || length < 0 || length > this.maxFrameBytes) {
        this.handleGone(`invalid Content-Length ${match[1]}`)
        return
      }
      const messageStart = headerEnd + 4
      if (this.frameBuffer.length < messageStart + length) return // partial frame
      const body = this.frameBuffer
        .subarray(messageStart, messageStart + length)
        .toString('utf8')
      this.frameBuffer = this.frameBuffer.subarray(messageStart + length)
      this.handleMessage(body)
    }
  }

  private handleMessage(body: string): void {
    let message: unknown
    try {
      message = JSON.parse(body)
    } catch {
      return
    }
    if (!isRecord(message)) return
    const id = message['id']
    if (typeof id !== 'number') return // a server->client notification/request
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    const errorPayload = message['error']
    if (errorPayload !== undefined && errorPayload !== null) {
      entry.reject(
        new LspServerError(
          `LSP server returned an error for '${entry.method}': ${describeValue(errorPayload)}`,
          { reason: 'protocol', cause: errorPayload },
        ),
      )
      return
    }
    entry.resolve(message['result'])
  }

  private handleGone(reason: string): void {
    const wasRunning = this.running
    this.running = false
    this.child = null
    this.rejectAll(
      new LspServerError(`LSP server died (${reason}).`, { reason: 'crashed' }),
    )
    if (wasRunning && !this.stopRequested) {
      this.onCrash(reason)
    }
  }

  private rejectAll(error: Error): void {
    for (const [, entry] of this.pending) entry.reject(error)
    this.pending.clear()
  }

  private async killChild(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin.end()
    } catch {
      /* ignore */
    }
    child.kill()
  }
}

type ServerEntry = {
  key: string
  languageId: SupportedLanguageId
  rootUri: string
  connection: LspServerConnection
  restarting: Promise<void> | null
}

/** Upper bound on the upward rootMarker walk (monorepo depth safety). */
const MAX_ROOT_WALK_DEPTH = 32

/**
 * Memoized directory→root resolutions for the default root resolver
 * (perf: root-resolver-unmemoized-sync-walk-per-acquire). The upward
 * fs.existsSync walk is a sync syscall chain — up to MAX_ROOT_WALK_DEPTH
 * levels per marker — and acquire() runs it on every LSP request, so results
 * are memoized per (start directory, marker list) with a short TTL: repeated
 * definition/hover/references calls against the same subtree pay the walk
 * once per TTL window instead of once per request. Mirrors the
 * buildGraphCache pattern in build-graph.ts (bounded entries, insert-order
 * eviction); tests reset it via clearRootResolutionCache.
 */
const rootResolutionCacheTtlMs = 5_000
const rootResolutionCacheMaxEntries = 512
const rootResolutionCache = new Map<
  string,
  { expiresAt: number; root: string }
>()

/** Drop the memoized directory→root resolutions (tests, workspace changes). */
export function clearRootResolutionCache(): void {
  rootResolutionCache.clear()
}

/**
 * Default root resolution (P3 audit fix): walk upward from the file's
 * directory looking for the spec's rootMarkers — the first marker in array
 * order wins — so a monorepo gets one warm server per project root instead of
 * one per directory (which thrashed the maxServers LRU). When no marker is
 * found within the bounded walk (or the spec declares none), fall back to the
 * file's parent directory, matching the previous behavior. Results are
 * memoized per (start directory, marker list) for rootResolutionCacheTtlMs
 * (bounded at rootResolutionCacheMaxEntries entries, insert-order eviction).
 * Exported for direct tests of the walk + memo contract.
 */
export function defaultRootResolver(params: {
  filePath: string
  rootMarkers: readonly string[]
}): string {
  const normalized = params.filePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  const parentDir = index === -1 ? '.' : normalized.slice(0, index)
  if (parentDir === '') return parentDir
  const cacheKey = `${parentDir}\u0000${params.rootMarkers.join('\u0001')}`
  const now = Date.now()
  const cached = rootResolutionCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.root
  let root = parentDir
  for (const marker of params.rootMarkers) {
    let dir = parentDir
    for (let depth = 0; depth < MAX_ROOT_WALK_DEPTH; depth++) {
      if (fs.existsSync(path.join(dir, marker))) {
        root = dir
        break
      }
      const parent = path.dirname(dir)
      if (parent === dir) break // filesystem root
      dir = parent
    }
    if (root !== parentDir) break
  }
  rootResolutionCache.delete(cacheKey)
  if (rootResolutionCache.size >= rootResolutionCacheMaxEntries) {
    const oldest = rootResolutionCache.keys().next()
    if (!oldest.done) rootResolutionCache.delete(oldest.value)
  }
  rootResolutionCache.set(cacheKey, {
    expiresAt: now + rootResolutionCacheTtlMs,
    root,
  })
  return root
}

export type LspMultiplexer = {
  definition(params: {
    filePath: string
    position: LspPosition
  }): Promise<LspLocation | LspLocation[] | null>
  references(params: {
    filePath: string
    position: LspPosition
  }): Promise<LspLocation[] | null>
  hover(params: { filePath: string; position: LspPosition }): Promise<LspHover | null>
  documentSymbol(params: {
    filePath: string
  }): Promise<LspDocumentSymbol[] | null>
  workspaceSymbol(query: string): Promise<LspWorkspaceSymbol[] | null>
  syncFile(params: {
    filePath: string
    version: number
    text: string
    open?: boolean
    close?: boolean
  }): Promise<void>
  warmServerCount(): number
  dispose(): Promise<void>
}

/**
 * Creates the multiplexer. `spawner` is required; every other behavior has a
 * bounded default. Selection, cold start, eviction, restart, and document sync
 * are all driven through the registry ToolSpecs.
 */
export function createLspMultiplexer(options: LspMultiplexerOptions): LspMultiplexer {
  const maxServers = options.maxServers ?? DEFAULT_MAX_SERVERS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  const rootResolver = options.rootResolver ?? defaultRootResolver
  const servers = new Map<string, ServerEntry>()
  // In-flight cold starts keyed by (languageId, rootUri): concurrent acquire()
  // callers join the winner's start instead of spawning duplicate servers
  // whose losing child process would leak.
  const starting = new Map<string, Promise<ServerEntry>>()
  let disposed = false
  // Registration critical section (perf: lsp-coldstart-evict-overshoot):
  // concurrent cold starts for distinct (language, root) keys used to each
  // observe room after evictIfNeeded (which awaited connection.stop()
  // outside any lock) and then both register, transiently exceeding
  // maxServers. Eviction + slot reservation are serialized through this
  // promise chain, and the slot is reserved by inserting the entry BEFORE
  // the child starts, so the server count can never exceed the bound.
  let registrationChain: Promise<void> = Promise.resolve()
  const reserveServerSlot = (
    entry: ServerEntry,
    key: string,
  ): Promise<void> => {
    const run = registrationChain.then(async () => {
      if (disposed) {
        throw new LspServerError('LSP multiplexer is disposed.', {
          reason: 'disposed',
        })
      }
      await evictIfNeeded()
      servers.set(key, entry)
    })
    registrationChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function emit(event: LspMultiplexerEvent): void {
    options.onEvent?.(event)
  }

  function resolveLanguage(filePath: string): SupportedLanguageId {
    const normalized = filePath.toLowerCase()
    const dot = normalized.lastIndexOf('.')
    const extension = dot === -1 ? '' : normalized.slice(dot)
    for (const id of Object.keys(
      LANGUAGE_CAPABILITY_REGISTRY,
    ) as SupportedLanguageId[]) {
      if (
        (LANGUAGE_CAPABILITY_REGISTRY[id].extensions as readonly string[]).includes(
          extension,
        )
      ) {
        return id
      }
    }
    throw new LspServerUnavailableError(
      `No supported language for file '${filePath}'.`,
      { reason: 'unsupported-language' },
    )
  }

  function selectServerSpec(languageId: SupportedLanguageId): LanguageToolSpec {
    const spec = getLanguageToolSpecs(languageId).find(
      (candidate) => candidate.role === 'languageServer',
    )
    if (!spec) {
      throw new LspServerUnavailableError(
        `Language '${languageId}' has no languageServer tool spec.`,
        { reason: 'no-server-spec', languageId },
      )
    }
    if ((spec.transport ?? 'stdio') !== 'stdio' || spec.argv.length === 0) {
      throw new LspServerUnavailableError(
        `Language '${languageId}' server '${spec.argv.join(' ') || '(tcp)'}' is not a stdio-launchable server.`,
        { reason: 'tcp-transport', languageId },
      )
    }
    return spec
  }

  async function evictIfNeeded(): Promise<void> {
    for (;;) {
      if (servers.size < maxServers) return
      // Prefer evicting a warm (running) server: a reserved-but-still-starting
      // slot is owned by an in-flight cold start, which re-reserves when its
      // slot is stolen. Keys iterate in LRU (insertion) order, so the first
      // running entry is the oldest warm one.
      let oldestKey: string | undefined
      for (const candidate of servers.keys()) {
        if (servers.get(candidate)?.connection.isRunning) {
          oldestKey = candidate
          break
        }
      }
      if (oldestKey !== undefined) {
        const oldest = servers.get(oldestKey)
        servers.delete(oldestKey)
        if (oldest) {
          await oldest.connection.stop()
          emit({ kind: 'evicted', key: oldestKey })
        }
        continue
      }
      // Every registered entry is reserved-but-still-starting (only reachable
      // when concurrent distinct-key cold starts exceed the cap). Stealing a
      // starting slot would orphan its live child and churn respawn loops, so
      // wait for the oldest reservation to settle instead: a start is bounded
      // by startupTimeoutMs, so the entry either becomes a warm (evictable)
      // server or is removed by its failed start within that bound.
      await sleep(EVICT_WAIT_POLL_MS)
    }
  }

  async function acquire(filePath: string): Promise<ServerEntry> {
    if (disposed) {
      throw new LspServerError('LSP multiplexer is disposed.', { reason: 'disposed' })
    }
    const languageId = resolveLanguage(filePath)
    const spec = selectServerSpec(languageId)
    const root = rootResolver({ filePath, rootMarkers: spec.rootMarkers ?? [] })
    const rootUri = filePathToUri(root)
    const key = `${languageId}:${rootUri}`
    const existing = servers.get(key)
    if (existing) {
      // LRU touch: re-insert to move to the most-recent position.
      servers.delete(key)
      servers.set(key, existing)
      if (existing.restarting) await existing.restarting
      return existing
    }
    // Single-flight cold start: concurrent acquire() calls for the same
    // (languageId, root) key join one in-flight start instead of each
    // spawning a duplicate server. The bounded-parallel syncMutatedFiles
    // path (concurrency 4) makes this race reachable on every multi-file
    // mutation commit, and the losing child process of a duplicated cold
    // start used to leak permanently.
    const inFlight = starting.get(key)
    if (inFlight) {
      const entry = await inFlight
      // LRU touch on the winner's freshly started entry.
      servers.delete(key)
      servers.set(key, entry)
      return entry
    }
    const startPromise = (async (): Promise<ServerEntry> => {
      const buildEntry = (): ServerEntry => {
        const entry: ServerEntry = {
          key,
          languageId,
          rootUri,
          restarting: null,
          connection: new LspServerConnection({
            spawner: options.spawner,
            spawnSpec: { argv: spec.argv, cwd: root },
            requestTimeoutMs,
            startupTimeoutMs,
            maxPendingRequests,
            maxFrameBytes,
            onCrash: (reason) => {
              emit({ kind: 'restart', key, reason })
              entry.restarting = (async () => {
                await sleep(RESTART_BACKOFF_MS)
                try {
                  const fresh = new LspServerConnection({
                    spawner: options.spawner,
                    spawnSpec: { argv: spec.argv, cwd: root },
                    requestTimeoutMs,
                    startupTimeoutMs,
                    maxPendingRequests,
                    maxFrameBytes,
                    onCrash: (again) => {
                      emit({ kind: 'gave-up', key, reason: again })
                    },
                  })
                  await fresh.start(rootUri)
                  entry.connection = fresh
                } catch {
                  emit({ kind: 'gave-up', key, reason })
                } finally {
                  entry.restarting = null
                }
              })()
            },
          }),
        }
        return entry
      }
      let entry = buildEntry()
      for (;;) {
        await reserveServerSlot(entry, key)
        try {
          await entry.connection.start(rootUri)
        } catch (error) {
          if (servers.get(key) === entry) servers.delete(key)
          throw error
        }
        if (servers.get(key) === entry) break
        // The reserved slot was stolen by a newer cold start while this one
        // was still starting (only reachable when concurrent cold starts
        // exceed the cap): stop the orphan child and re-reserve instead of
        // registering past the bound or leaking the process.
        await entry.connection.stop()
        entry = buildEntry()
      }
      if (disposed) {
        // dispose() ran while this cold start was in flight: stop the child
        // instead of registering a server nobody will ever dispose.
        if (servers.get(key) === entry) servers.delete(key)
        await entry.connection.stop()
        throw new LspServerError('LSP multiplexer is disposed.', {
          reason: 'disposed',
        })
      }
      emit({ kind: 'started', key, languageId, rootUri })
      return entry
    })()
    starting.set(key, startPromise)
    try {
      return await startPromise
    } finally {
      if (starting.get(key) === startPromise) starting.delete(key)
    }
  }

  async function withServer<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | null> {
    const entry = await acquire(filePath)
    if (entry.restarting) await entry.restarting
    const result = (await entry.connection.request(method, params)) as T | null
    return result ?? null
  }

  function positionParams(filePath: string, position: LspPosition) {
    return {
      textDocument: { uri: filePathToUri(filePath) },
      position,
    }
  }

  const WARM_ANCHOR_POLL_MS = 50
  const WARM_ANCHOR_TIMEOUT_MS = 2_000

  /**
   * Returns the most-recently-warm server entry so workspace/symbol can reuse
   * it directly. The server map key ('<languageId>:<rootUri>') is NOT a
   * resolvable file path, so routing it back through `withServer`→`acquire`
   * would make `resolveLanguage` throw
   * LspServerUnavailableError('unsupported-language') on the only path where a
   * server is actually warm. This bypasses `acquire` entirely: it never
   * cold-starts a server (workspace/symbol is a warm-server query, per P3-T2)
   * and performs the same LRU touch + restart-await as the warm-hit branch of
   * `acquire`. Bounded wait: returns undefined when no server becomes warm
   * within the timeout so a bare workspace/symbol never hangs.
   */
  async function warmEntryForWorkspaceSymbol(): Promise<ServerEntry | undefined> {
    const deadline = Date.now() + WARM_ANCHOR_TIMEOUT_MS
    for (;;) {
      let latest: ServerEntry | undefined
      for (const entry of servers.values()) {
        // Reserved-but-still-starting entries are not warm yet: answering a
        // workspace/symbol query against one would reject with 'stopped'.
        if (entry.connection.isRunning) latest = entry
      }
      if (latest) {
        // LRU touch: re-insert to move to the most-recent position.
        servers.delete(latest.key)
        servers.set(latest.key, latest)
        if (latest.restarting) await latest.restarting
        return latest
      }
      if (disposed || Date.now() >= deadline) return undefined
      await sleep(WARM_ANCHOR_POLL_MS)
    }
  }

  return {
    definition: ({ filePath, position }) =>
      withServer<LspLocation | LspLocation[]>(
        filePath,
        'textDocument/definition',
        positionParams(filePath, position),
      ),
    references: ({ filePath, position }) =>
      withServer<LspLocation[]>(filePath, 'textDocument/references', {
        ...positionParams(filePath, position),
        context: { includeDeclaration: true },
      }),
    hover: ({ filePath, position }) =>
      withServer<LspHover>(filePath, 'textDocument/hover', positionParams(filePath, position)),
    documentSymbol: ({ filePath }) =>
      withServer<LspDocumentSymbol[]>(filePath, 'textDocument/documentSymbol', {
        textDocument: { uri: filePathToUri(filePath) },
      }),
    // workspace/symbol is issued against the already-warm server for the
    // workspace. The `query` text is NOT a file path, so the warm server
    // entry is selected directly — never via `withServer`→`acquire`, which
    // would misclassify the server map key as a file path and throw
    // 'unsupported-language'. This keeps workspace/symbol a true warm-server
    // query (per P3-T2) that never cold-starts a server just to answer a
    // symbol search. A server that lacks workspace/symbol support resolves
    // to an empty result rather than throwing.
    workspaceSymbol: async (query) => {
      const entry = await warmEntryForWorkspaceSymbol()
      if (!entry) return null
      try {
        const result = (await entry.connection.request('workspace/symbol', {
          query,
        })) as LspWorkspaceSymbol[] | null
        return result ?? null
      } catch (error) {
        if (
          error instanceof LspServerError &&
          (error.reason === 'protocol' || error.reason === 'unavailable')
        ) {
          return null
        }
        throw error
      }
    },
    async syncFile({ filePath, version, text, open, close }) {
      const entry = await acquire(filePath)
      const uri = filePathToUri(filePath)
      if (close) {
        entry.connection.didClose(uri)
        return
      }
      const known = entry.connection.versionOf(uri)
      if (open || known === undefined) {
        entry.connection.didOpen(uri, entry.languageId, version, text)
      } else {
        entry.connection.didChange(uri, version, text)
      }
    },
    warmServerCount: () => servers.size,
    async dispose() {
      disposed = true
      for (const [, entry] of servers) {
        await entry.connection.stop()
      }
      servers.clear()
      emit({ kind: 'disposed' })
    },
  }
}

export type { ChildProcess as LspChildProcess }
