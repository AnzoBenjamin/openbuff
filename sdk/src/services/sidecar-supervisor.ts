import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { getChildProcessEnv } from '../env'

const DEFAULT_RESTART_BACKOFF_MS = 200
const DEFAULT_MAX_RESTART_ATTEMPTS = 3
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const MAX_PENDING_REQUESTS = 256
const BACKOFF_CAP_MULTIPLIER = 10
const STDERR_TAIL_LIMIT = 4_096
/**
 * Upper bound on the stdout line-reassembly buffer. Bytes buffered without a
 * newline cannot become a valid line-delimited JSON-RPC message, so a
 * sidecar that crashes mid-line, emits binary garbage, or streams one
 * pathological multi-MB line must not grow host memory without bound: the
 * overflow is discarded (counted in `stdoutBufferDrops`) instead of retained.
 */
const MAX_STDOUT_BUFFER_BYTES = 1_048_576
const HANDSHAKE_REQUEST_ID = 1
const KILL_GRACE_MS = 500

export type SidecarSupervisorState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'stopped'

export type SidecarSupervisorEvent =
  | { kind: 'handshake'; protocolVersion: string; attempt: number }
  | { kind: 'restart'; attempt: number; delayMs: number; reason: string }
  | { kind: 'gave-up'; attempts: number; reason: string }
  | { kind: 'stopped' }

export type StartedSidecar = {
  pid: number | undefined
  protocolVersion: string
}

export type SidecarSupervisorOptions = {
  sidecarPath: string
  args?: string[]
  env?: Record<string, string>
  protocolVersion: string
  restartBackoffMs?: number
  maxRestartAttempts?: number
  requestTimeoutMs?: number
  onEvent?: (event: SidecarSupervisorEvent) => void
}

export type SidecarRequestFailureReason =
  | 'invalid-state'
  | 'restarting'
  | 'not-running'
  | 'timeout'
  | 'pending-limit'
  | 'protocol'
  | 'child-exited'
  | 'stopped'

export class SidecarHandshakeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SidecarHandshakeError'
  }
}

export class SidecarRequestError extends Error {
  readonly reason: SidecarRequestFailureReason

  constructor(
    message: string,
    options: ErrorOptions & { reason: SidecarRequestFailureReason },
  ) {
    super(message, options)
    this.name = 'SidecarRequestError'
    this.reason = options.reason
  }
}

type PendingEntryKind = 'handshake' | 'request'

type PendingEntry = {
  kind: PendingEntryKind
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type ExitInfo = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  error?: unknown
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

function formatExit(info: ExitInfo): string {
  if (info.error !== undefined) {
    return `spawn error: ${
      info.error instanceof Error ? info.error.message : describeValue(info.error)
    }`
  }
  return info.signal !== null
    ? `signal ${info.signal}`
    : `exit code ${info.exitCode}`
}

// The sdk tsconfig pulls in DOM lib alongside node types, so `setTimeout` may
// resolve to a plain number; unref only when the runtime provides it.
function unrefTimer(timer: unknown): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    const unrefable = timer as { unref: () => void }
    unrefable.unref()
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    unrefTimer(setTimeout(resolve, milliseconds))
  })
}

/**
 * Spawns, health-checks, restarts, and version-negotiates a stdio JSON-RPC
 * sidecar process. Line-delimited JSON-RPC over the child's stdin/stdout with
 * correlated ids; every state transition happens on the single `currentState`
 * field, and every restart or failure is reported through `onEvent`.
 */
export class SidecarSupervisor {
  private currentState: SidecarSupervisorState = 'idle'
  private child: ChildProcess | null = null
  private readonly pending = new Map<number, PendingEntry>()
  private nextRequestId = HANDSHAKE_REQUEST_ID + 1
  private stdoutBuffer: Buffer = Buffer.alloc(0)
  private stdoutBufferDropCount = 0
  private stderrTail = ''
  private stopPromise: Promise<void> | null = null
  // Set while a supervisor-initiated kill is in flight so the child's exit
  // event is never mistaken for an unexpected crash worth restarting from.
  private stopRequested = false

  private readonly sidecarPath: string
  private readonly args: readonly string[]
  private readonly env: Record<string, string> | undefined
  private readonly protocolVersion: string
  private readonly restartBackoffMs: number
  private readonly maxRestartAttempts: number
  private readonly requestTimeoutMs: number
  private readonly onEvent?: (event: SidecarSupervisorEvent) => void

  constructor(options: SidecarSupervisorOptions) {
    this.sidecarPath = options.sidecarPath
    this.args = options.args ?? []
    this.env = options.env
    this.protocolVersion = options.protocolVersion
    this.restartBackoffMs =
      options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
    this.maxRestartAttempts =
      options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.onEvent = options.onEvent
  }

  get state(): SidecarSupervisorState {
    return this.currentState
  }

  /**
   * How many times the stdout reassembly buffer exceeded
   * MAX_STDOUT_BUFFER_BYTES without a newline and was discarded, for the
   * current child (diagnostic counter for the bounded-buffer guard).
   */
  get stdoutBufferDrops(): number {
    return this.stdoutBufferDropCount
  }

  /** Spawns the sidecar and completes the `initialize` handshake. */
  async start(): Promise<StartedSidecar> {
    if (
      this.currentState === 'starting' ||
      this.currentState === 'running' ||
      this.currentState === 'restarting'
    ) {
      throw new SidecarRequestError(
        `Sidecar is already ${this.currentState}; start() cannot be called again.`,
        { reason: 'invalid-state' },
      )
    }
    this.currentState = 'starting'
    try {
      const child = this.spawnChild()
      const protocolVersion = await this.handshake(child)
      this.currentState = 'running'
      this.emit({ kind: 'handshake', protocolVersion, attempt: 1 })
      return { pid: child.pid, protocolVersion }
    } catch (error) {
      this.currentState = 'stopped'
      await this.killChild()
      this.rejectAllPending(
        error instanceof Error
          ? error
          : new SidecarRequestError(String(error), { reason: 'protocol' }),
      )
      throw error
    }
  }

  /** Sends a JSON-RPC request and awaits the correlated response. */
  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.currentState === 'restarting') {
      throw new SidecarRequestError(
        `Sidecar is restarting; request '${method}' was rejected instead of queued.`,
        { reason: 'restarting' },
      )
    }
    if (this.currentState !== 'running') {
      throw new SidecarRequestError(
        `Sidecar is not running (state '${this.currentState}'); request '${method}' was rejected.`,
        { reason: 'not-running' },
      )
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new SidecarRequestError(
        `Sidecar pending-request limit of ${MAX_PENDING_REQUESTS} reached.`,
        { reason: 'pending-limit' },
      )
    }
    const child = this.child
    if (!child) {
      throw new SidecarRequestError(
        `Sidecar process is unavailable; request '${method}' was rejected.`,
        { reason: 'not-running' },
      )
    }
    const id = this.nextRequestId++
    const message: Record<string, unknown> = { jsonrpc: '2.0', id, method }
    if (params !== undefined) {
      message['params'] = params
    }
    return this.send(child, id, message, 'request', method)
  }

  /** Kills the child, rejects every pending request, and reports `stopped`. */
  async stop(): Promise<void> {
    this.stopPromise ??= this.performStop()
    await this.stopPromise
  }

  private async performStop(): Promise<void> {
    const wasLive =
      this.currentState === 'starting' ||
      this.currentState === 'running' ||
      this.currentState === 'restarting'
    this.currentState = 'stopped'
    // Mark the exit as self-initiated before killing so handleChildGone can
    // never classify our own kill as an unexpected crash.
    this.stopRequested = true
    this.rejectAllPending(
      new SidecarRequestError('Sidecar was stopped with requests in flight.', {
        reason: 'stopped',
      }),
    )
    await this.killChild()
    this.stdoutBuffer = Buffer.alloc(0)
    if (wasLive) {
      this.emit({ kind: 'stopped' })
    }
  }

  private spawnChild(): ChildProcess {
    // Each spawned child begins a fresh lifecycle: a stop request from a
    // previous run does not carry over into start() or restart attempts.
    this.stopRequested = false
    const child = spawn(this.sidecarPath, this.args, {
      env: { ...getChildProcessEnv(), ...(this.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    // Each spawned child begins with fresh stream state: a partial line left
    // behind by a crashed predecessor must never corrupt the new child's
    // first messages.
    this.stdoutBuffer = Buffer.alloc(0)
    this.stdoutBufferDropCount = 0
    this.stderrTail = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      this.consumeStdout(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(
        -STDERR_TAIL_LIMIT,
      )
    })
    // Write failures surface through the child's exit event, which rejects
    // every pending entry; the duplicate stdin stream error is swallowed.
    child.stdin?.on('error', () => undefined)
    child.once('exit', (exitCode, signal) => {
      this.handleChildGone(child, { exitCode, signal })
    })
    child.once('error', (error) => {
      this.handleChildGone(child, { exitCode: null, signal: null, error })
    })
    return child
  }

  private async handshake(child: ChildProcess): Promise<string> {
    const result = await this.send(
      child,
      HANDSHAKE_REQUEST_ID,
      {
        jsonrpc: '2.0',
        id: HANDSHAKE_REQUEST_ID,
        method: 'initialize',
        params: { protocolVersion: this.protocolVersion },
      },
      'handshake',
      'initialize',
    )
    if (!isRecord(result) || typeof result['protocolVersion'] !== 'string') {
      throw new SidecarHandshakeError(
        `Sidecar handshake response did not include a protocolVersion result: ${describeValue(result)}`,
      )
    }
    if (result['protocolVersion'] !== this.protocolVersion) {
      throw new SidecarHandshakeError(
        `Sidecar negotiated protocol version '${result['protocolVersion']}' but '${this.protocolVersion}' was requested.`,
      )
    }
    return result['protocolVersion']
  }

  private send(
    child: ChildProcess,
    id: number,
    message: Record<string, unknown>,
    kind: PendingEntryKind,
    methodLabel: string,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          kind === 'handshake'
            ? new SidecarHandshakeError(
                `Sidecar handshake timed out after ${this.requestTimeoutMs}ms.`,
              )
            : new SidecarRequestError(
                `Sidecar request '${methodLabel}' timed out after ${this.requestTimeoutMs}ms.`,
                { reason: 'timeout' },
              ),
        )
      }, this.requestTimeoutMs)
      unrefTimer(timer)
      this.pending.set(id, {
        kind,
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
        this.writeMessage(child, message)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(
          kind === 'handshake'
            ? new SidecarHandshakeError(
                `Failed to send the sidecar handshake: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                { cause: error },
              )
            : new SidecarRequestError(
                `Failed to send sidecar request '${methodLabel}'.`,
                { reason: 'child-exited', cause: error },
              ),
        )
      }
    })
  }

  private writeMessage(
    child: ChildProcess,
    message: Record<string, unknown>,
  ): void {
    const stdin = child.stdin
    if (!stdin || child.exitCode !== null) {
      throw new Error('Sidecar stdin is not available.')
    }
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdoutBuffer =
      this.stdoutBuffer.length === 0
        ? chunk
        : Buffer.concat([this.stdoutBuffer, chunk])
    let newlineIndex = this.stdoutBuffer.indexOf(0x0a)
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer
        .subarray(0, newlineIndex)
        .toString('utf8')
      this.stdoutBuffer = this.stdoutBuffer.subarray(newlineIndex + 1)
      this.handleLine(line)
      newlineIndex = this.stdoutBuffer.indexOf(0x0a)
    }
    // Bounded reassembly: with no newline left in the buffer these bytes
    // cannot become a valid line-delimited JSON-RPC message, so a sidecar
    // that crashes mid-line, emits binary garbage, or streams one
    // pathological multi-MB line must not grow host memory without bound —
    // discard the partial data instead of retaining it.
    if (this.stdoutBuffer.length > MAX_STDOUT_BUFFER_BYTES) {
      this.stdoutBuffer = Buffer.alloc(0)
      this.stdoutBufferDropCount++
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let message: unknown
    try {
      message = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!isRecord(message)) return
    const id = message['id']
    if (typeof id !== 'number') return
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    const errorPayload = message['error']
    if (errorPayload !== undefined && errorPayload !== null) {
      entry.reject(
        entry.kind === 'handshake'
          ? new SidecarHandshakeError(
              `Sidecar rejected the initialize handshake: ${describeValue(errorPayload)}`,
              { cause: errorPayload },
            )
          : new SidecarRequestError(
              `Sidecar returned an error for request id ${id}: ${describeValue(errorPayload)}`,
              { reason: 'protocol', cause: errorPayload },
            ),
      )
      return
    }
    entry.resolve(message['result'])
  }

  private handleChildGone(child: ChildProcess, info: ExitInfo): void {
    // Stale events from a previously replaced or deliberately killed child.
    if (this.child !== child) return
    this.child = null
    const cause: Record<string, unknown> = {
      exitCode: info.exitCode,
      signal: info.signal,
      stderrTail: this.stderrTail,
    }
    if (info.error !== undefined) {
      cause['error'] = info.error
    }
    const exitDescription = formatExit(info)
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      entry.reject(
        entry.kind === 'handshake'
          ? new SidecarHandshakeError(
              `Sidecar process died during the handshake (${exitDescription}).`,
              { cause },
            )
          : new SidecarRequestError(
              `Sidecar process died before responding to request id ${id} (${exitDescription}).`,
              { reason: 'child-exited', cause },
            ),
      )
    }
    // Restart only for unexpected exits of a running sidecar: never when the
    // supervisor itself initiated the stop, and never from other states.
    if (!this.stopRequested && this.currentState === 'running') {
      void this.restartLoop(
        `Sidecar exited unexpectedly (${exitDescription}).`,
      )
    }
  }

  private async restartLoop(initialReason: string): Promise<void> {
    this.currentState = 'restarting'
    let reason = initialReason
    for (let attempt = 1; attempt <= this.maxRestartAttempts; attempt++) {
      const delayMs = Math.min(
        this.restartBackoffMs * 2 ** (attempt - 1),
        this.restartBackoffMs * BACKOFF_CAP_MULTIPLIER,
      )
      this.emit({ kind: 'restart', attempt, delayMs, reason })
      await sleep(delayMs)
      if (this.currentState !== 'restarting') return
      try {
        const child = this.spawnChild()
        const protocolVersion = await this.handshake(child)
        this.currentState = 'running'
        this.emit({ kind: 'handshake', protocolVersion, attempt: attempt + 1 })
        return
      } catch (error) {
        if (this.currentState !== 'restarting') return
        await this.killChild()
        if (this.currentState !== 'restarting') return
        reason = error instanceof Error ? error.message : String(error)
      }
    }
    this.emit({ kind: 'gave-up', attempts: this.maxRestartAttempts, reason })
    this.currentState = 'stopped'
  }

  private rejectAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      entry.reject(error)
    }
    this.pending.clear()
  }

  private async killChild(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child) return
    child.stdin?.end()
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, KILL_GRACE_MS)
      unrefTimer(timer)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill()
    })
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }

  private emit(event: SidecarSupervisorEvent): void {
    this.onEvent?.(event)
  }
}
