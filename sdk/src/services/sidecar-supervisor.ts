import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createNodeProcessScope } from '@codebuff/common/util/node-process-scope'
import type { NodeProcessScopeOptions } from '@codebuff/common/util/node-process-scope'
import type {
  CleanupResult,
  OwnedProcessScope,
  ScopeStreams,
  StopReason,
} from '@codebuff/common/types/contracts/process-scope'
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
const KILL_GRACE_MS = 200

export type SidecarSupervisorState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'stopping'
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
  /** Trusted host seams. Injected children do not establish real group coverage. */
  spawn?: typeof spawn
  createProcessScope?: (
    child: ChildProcess,
    options: NodeProcessScopeOptions,
  ) => OwnedProcessScope
  cleanupPolicy?: Pick<
    NodeProcessScopeOptions,
    'termGraceMs' | 'killGraceMs' | 'observationMs' | 'probeTimeoutMs'
  >
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

type SidecarGeneration = {
  id: number
  epoch: number
  child: ChildProcess
  scope: OwnedProcessScope
  pending: Map<number, PendingEntry>
  nextRequestId: number
  stdoutBuffer: Buffer
  stdoutBufferDropCount: number
  stdoutSeenBytes: number
  stderrSeenBytes: number
  stderrTail: Buffer
  stdoutState: ScopeStreams['stdout']
  stderrState: ScopeStreams['stderr']
  protocolActive: boolean
  stopRequested: boolean
  cleanupPromise: Promise<void> | null
  stopPromise: Promise<void> | null
  cancelBackoff?: () => void
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
      info.error instanceof Error
        ? info.error.message
        : describeValue(info.error)
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

/**
 * Spawns, health-checks, restarts, and version-negotiates a stdio JSON-RPC
 * sidecar process. Line-delimited JSON-RPC over the child's stdin/stdout with
 * correlated ids; every state transition happens on the single `currentState`
 * field, and every restart or failure is reported through `onEvent`.
 */
export class SidecarSupervisor {
  private currentState: SidecarSupervisorState = 'idle'
  private current: SidecarGeneration | null = null
  private epoch = 0
  private nextGeneration = 0

  private readonly sidecarPath: string
  private readonly args: readonly string[]
  private readonly env: Record<string, string> | undefined
  private readonly protocolVersion: string
  private readonly restartBackoffMs: number
  private readonly maxRestartAttempts: number
  private readonly requestTimeoutMs: number
  private readonly onEvent?: (event: SidecarSupervisorEvent) => void
  private readonly spawnProcess: typeof spawn
  private readonly createProcessScope: NonNullable<
    SidecarSupervisorOptions['createProcessScope']
  >
  private readonly cleanupPolicy: SidecarSupervisorOptions['cleanupPolicy']

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
    this.spawnProcess = options.spawn ?? spawn
    this.createProcessScope =
      options.createProcessScope ?? createNodeProcessScope
    this.cleanupPolicy = options.cleanupPolicy
    for (const value of Object.values(options.cleanupPolicy ?? {})) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError('Invalid sidecar cleanup policy.')
      }
    }
  }

  get state(): SidecarSupervisorState {
    return this.currentState
  }

  /** Diagnostic drops for the current child, never a predecessor's stream. */
  get stdoutBufferDrops(): number {
    return this.current?.stdoutBufferDropCount ?? 0
  }

  /** Physical cleanup evidence; a failed/unknown scope remains reachable here. */
  get cleanup(): CleanupResult | undefined {
    return this.current?.scope.currentCleanup()
  }

  /** Spawns the sidecar and completes the `initialize` handshake. */
  async start(): Promise<StartedSidecar> {
    if (
      this.currentState === 'starting' ||
      this.currentState === 'running' ||
      this.currentState === 'restarting' ||
      this.currentState === 'stopping' ||
      this.hasOpenScope()
    ) {
      throw new SidecarRequestError(
        `Sidecar is already ${this.currentState}; start() cannot be called again.`,
        { reason: 'invalid-state' },
      )
    }
    const epoch = ++this.epoch
    this.currentState = 'starting'
    let generation: SidecarGeneration | undefined
    try {
      generation = this.spawnChild(epoch)
      const protocolVersion = await this.handshake(generation)
      if (!this.isProtocolCurrent(generation)) {
        throw new SidecarRequestError('Sidecar start was stopped.', {
          reason: 'stopped',
        })
      }
      this.currentState = 'running'
      this.emit({ kind: 'handshake', protocolVersion, attempt: 1 })
      return { pid: generation.child.pid, protocolVersion }
    } catch (error) {
      if (epoch === this.epoch) {
        if (generation && this.current === generation) {
          generation.protocolActive = false
          generation.stopRequested = true
          this.currentState = 'stopping'
          this.rejectAllPending(generation, this.asError(error))
          await this.cleanupGeneration(generation, 'adapter-error')
        }
        if (epoch === this.epoch) this.currentState = 'stopped'
      }
      throw error
    }
  }

  private hasOpenScope(): boolean {
    return (
      this.current !== null &&
      this.current.scope.currentCleanup()?.status !== 'complete'
    )
  }

  private isCurrent(generation: SidecarGeneration): boolean {
    return (
      this.current === generation &&
      this.epoch === generation.epoch &&
      this.current.child === generation.child
    )
  }

  private isProtocolCurrent(generation: SidecarGeneration): boolean {
    return this.isCurrent(generation) && generation.protocolActive
  }

  /** Sends a JSON-RPC request and awaits the correlated response. */
  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.currentState === 'restarting') {
      throw new SidecarRequestError(
        `Sidecar is restarting; request '${method}' was rejected instead of queued.`,
        { reason: 'restarting' },
      )
    }
    const generation = this.current
    if (
      this.currentState !== 'running' ||
      !generation ||
      !this.isProtocolCurrent(generation)
    ) {
      throw new SidecarRequestError(
        `Sidecar is not running (state '${this.currentState}'); request '${method}' was rejected.`,
        { reason: 'not-running' },
      )
    }
    if (generation.pending.size >= MAX_PENDING_REQUESTS) {
      throw new SidecarRequestError(
        `Sidecar pending-request limit of ${MAX_PENDING_REQUESTS} reached.`,
        { reason: 'pending-limit' },
      )
    }
    const id = generation.nextRequestId++
    const message: Record<string, unknown> = { jsonrpc: '2.0', id, method }
    if (params !== undefined) message['params'] = params
    return this.send(generation, id, message, 'request', method)
  }

  /** Rejects protocol work promptly, then joins physical scope cleanup. */
  stop(): Promise<void> {
    const generation = this.current
    // Do not cache a stop promise while idle: an immediate start is a new run.
    if (!generation) return Promise.resolve()
    const previous = generation.scope.currentCleanup()
    if (
      generation.stopPromise &&
      (generation.cleanupPromise !== null ||
        !previous ||
        previous.status === 'complete')
    ) {
      return generation.stopPromise
    }
    const wasLive =
      this.currentState === 'starting' ||
      this.currentState === 'running' ||
      this.currentState === 'restarting'
    const epoch = ++this.epoch
    this.currentState = 'stopping'
    generation.protocolActive = false
    generation.stopRequested = true
    generation.cancelBackoff?.()
    this.rejectAllPending(
      generation,
      new SidecarRequestError('Sidecar was stopped with requests in flight.', {
        reason: 'stopped',
      }),
    )
    // Reserve the public stop promise before invoking the scope or callbacks.
    const stop = Promise.resolve().then(async () => {
      await this.cleanupGeneration(
        generation,
        'owner-shutdown',
        false,
        previous !== undefined && previous.status !== 'complete',
      )
      if (this.current === generation && this.epoch === epoch) {
        generation.stdoutBuffer = Buffer.alloc(0)
        this.currentState = 'stopped'
        if (wasLive) this.emit({ kind: 'stopped' })
      }
    })
    generation.stopPromise = stop
    return stop
  }

  private spawnChild(epoch: number): SidecarGeneration {
    if (this.hasOpenScope()) {
      throw new SidecarRequestError(
        'Prior sidecar scope cleanup is incomplete.',
        { reason: 'invalid-state' },
      )
    }
    const child = this.spawnProcess(this.sidecarPath, this.args, {
      env: { ...getChildProcessEnv(), ...(this.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Trusted-host selection. Production B19 launchers bind this before admission.
      detached: process.platform !== 'win32',
    })
    let generation: SidecarGeneration | undefined
    const scope = this.createProcessScope(child, {
      detached: process.platform !== 'win32',
      termGraceMs: KILL_GRACE_MS,
      killGraceMs: 200,
      observationMs: 1_000,
      ...this.cleanupPolicy,
      output: () => {
        const stdoutSeenBytes = generation?.stdoutSeenBytes ?? 0
        const stderrSeenBytes = generation?.stderrSeenBytes ?? 0
        const retainedBytes =
          (generation?.stdoutBuffer.length ?? 0) +
          (generation?.stderrTail.length ?? 0)
        return {
          stdoutSeenBytes,
          stderrSeenBytes,
          retainedBytes,
          droppedBytes: Math.max(
            0,
            stdoutSeenBytes + stderrSeenBytes - retainedBytes,
          ),
          complete:
            generation?.stdoutState === 'drained' &&
            generation?.stderrState === 'drained',
        }
      },
    })
    generation = {
      id: ++this.nextGeneration,
      epoch,
      child,
      scope,
      pending: new Map(),
      nextRequestId: HANDSHAKE_REQUEST_ID + 1,
      stdoutBuffer: Buffer.alloc(0),
      stdoutBufferDropCount: 0,
      stdoutSeenBytes: 0,
      stderrSeenBytes: 0,
      stderrTail: Buffer.alloc(0),
      stdoutState:
        !child.stdout || child.stdout.readableEnded ? 'drained' : 'open',
      stderrState:
        !child.stderr || child.stderr.readableEnded ? 'drained' : 'open',
      protocolActive: true,
      stopRequested: false,
      cleanupPromise: null,
      stopPromise: null,
    }
    const owned = generation
    this.current = owned
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      owned.stdoutSeenBytes += bytes.length
      if (this.isProtocolCurrent(owned)) this.consumeStdout(owned, bytes)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      owned.stderrSeenBytes += bytes.length
      // Old streams remain drained by their own scope and bounded retained sink.
      owned.stderrTail =
        bytes.length >= STDERR_TAIL_LIMIT
          ? Buffer.from(bytes.subarray(-STDERR_TAIL_LIMIT))
          : Buffer.concat([
              owned.stderrTail.subarray(
                Math.max(
                  0,
                  owned.stderrTail.length + bytes.length - STDERR_TAIL_LIMIT,
                ),
              ),
              bytes,
            ])
    })
    for (const name of ['stdout', 'stderr'] as const) {
      const stream = child[name]
      const state = name === 'stdout' ? 'stdoutState' : 'stderrState'
      stream?.once('end', () => {
        if (owned[state] !== 'closed-incomplete') owned[state] = 'drained'
      })
      stream?.once('close', () => {
        if (owned[state] === 'open')
          owned[state] = stream.readableEnded ? 'drained' : 'closed-incomplete'
      })
      stream?.once('error', () => {
        owned[state] = 'closed-incomplete'
      })
    }
    child.stdin?.on('error', () => undefined)
    child.once('exit', (exitCode, signal) =>
      this.handleChildGone(owned, { exitCode, signal }),
    )
    child.once('error', (error) => {
      if (!this.isCurrent(owned)) return
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        owned.protocolActive = false
        owned.stopRequested = true
        this.currentState = 'stopping'
        this.rejectAllPending(
          owned,
          new SidecarRequestError(
            'Sidecar process error; exit is unconfirmed.',
            { reason: 'protocol', cause: error },
          ),
        )
        void this.cleanupGeneration(owned, 'adapter-error', true).then(
          () => {
            if (this.isCurrent(owned)) this.currentState = 'stopped'
          },
          () => undefined,
        )
        return
      }
      this.handleChildGone(owned, { exitCode: null, signal: null, error })
    })
    return owned
  }

  private async handshake(generation: SidecarGeneration): Promise<string> {
    const result = await this.send(
      generation,
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
    generation: SidecarGeneration,
    id: number,
    message: Record<string, unknown>,
    kind: PendingEntryKind,
    methodLabel: string,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.isProtocolCurrent(generation)) {
        reject(
          new SidecarRequestError('Sidecar generation was stopped.', {
            reason: 'stopped',
          }),
        )
        return
      }
      const timer = setTimeout(() => {
        if (
          !this.isProtocolCurrent(generation) ||
          generation.pending.get(id) !== entry
        )
          return
        generation.pending.delete(id)
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
      const entry: PendingEntry = {
        kind,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      generation.pending.set(id, entry)
      try {
        this.writeMessage(generation.child, message)
      } catch (error) {
        if (generation.pending.get(id) === entry) generation.pending.delete(id)
        clearTimeout(timer)
        reject(
          kind === 'handshake'
            ? new SidecarHandshakeError(
                `Failed to send the sidecar handshake: ${error instanceof Error ? error.message : String(error)}`,
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
    if (!child.stdin || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Sidecar stdin is not available.')
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private consumeStdout(generation: SidecarGeneration, chunk: Buffer): void {
    generation.stdoutBuffer =
      generation.stdoutBuffer.length === 0
        ? chunk
        : Buffer.concat([generation.stdoutBuffer, chunk])
    let newlineIndex = generation.stdoutBuffer.indexOf(0x0a)
    while (newlineIndex !== -1 && this.isProtocolCurrent(generation)) {
      const line = generation.stdoutBuffer
        .subarray(0, newlineIndex)
        .toString('utf8')
      generation.stdoutBuffer = generation.stdoutBuffer.subarray(
        newlineIndex + 1,
      )
      this.handleLine(generation, line)
      newlineIndex = generation.stdoutBuffer.indexOf(0x0a)
    }
    if (generation.stdoutBuffer.length > MAX_STDOUT_BUFFER_BYTES) {
      generation.stdoutBuffer = Buffer.alloc(0)
      generation.stdoutBufferDropCount++
    }
  }

  private handleLine(generation: SidecarGeneration, line: string): void {
    if (!this.isProtocolCurrent(generation)) return
    const trimmed = line.trim()
    if (!trimmed) return
    let message: unknown
    try {
      message = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!isRecord(message) || typeof message['id'] !== 'number') return
    const id = message['id']
    const entry = generation.pending.get(id)
    if (!entry) return
    generation.pending.delete(id)
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

  private handleChildGone(generation: SidecarGeneration, info: ExitInfo): void {
    if (!this.isCurrent(generation)) return
    generation.protocolActive = false
    const cause = {
      exitCode: info.exitCode,
      signal: info.signal,
      stderrTail: generation.stderrTail.toString('utf8'),
      ...(info.error !== undefined ? { error: info.error } : {}),
    }
    const description = formatExit(info)
    for (const [id, entry] of generation.pending) {
      generation.pending.delete(id)
      entry.reject(
        entry.kind === 'handshake'
          ? new SidecarHandshakeError(
              `Sidecar process died during the handshake (${description}).`,
              { cause },
            )
          : new SidecarRequestError(
              `Sidecar process died before responding to request id ${id} (${description}).`,
              { reason: 'child-exited', cause },
            ),
      )
    }
    if (!generation.stopRequested && this.currentState === 'running') {
      this.currentState = 'restarting'
      void this.restartLoop(
        `Sidecar exited unexpectedly (${description}).`,
        generation,
      )
    }
  }

  private async restartLoop(
    initialReason: string,
    previous: SidecarGeneration,
  ): Promise<void> {
    const epoch = previous.epoch
    let reason = initialReason
    try {
      // Leader close cannot release the old scope or cancel escalation.
      await this.cleanupGeneration(previous, 'normal-leader-exit')
    } catch (error) {
      if (this.isCurrent(previous)) {
        this.currentState = 'stopping'
        this.emit({
          kind: 'gave-up',
          attempts: 0,
          reason: this.asError(error).message,
        })
      }
      return
    }
    let generation = previous
    for (let attempt = 1; attempt <= this.maxRestartAttempts; attempt++) {
      if (!this.isCurrent(generation) || this.currentState !== 'restarting')
        return
      const delayMs = Math.min(
        this.restartBackoffMs * 2 ** (attempt - 1),
        this.restartBackoffMs * BACKOFF_CAP_MULTIPLIER,
      )
      this.emit({ kind: 'restart', attempt, delayMs, reason })
      if (!this.isCurrent(generation) || this.currentState !== 'restarting')
        return
      if (!(await this.waitBackoff(generation, delayMs))) return
      try {
        generation = this.spawnChild(epoch)
        const protocolVersion = await this.handshake(generation)
        if (
          !this.isProtocolCurrent(generation) ||
          this.currentState !== 'restarting'
        )
          return
        this.currentState = 'running'
        this.emit({ kind: 'handshake', protocolVersion, attempt: attempt + 1 })
        return
      } catch (error) {
        if (!this.isCurrent(generation) || this.currentState !== 'restarting')
          return
        generation.protocolActive = false
        generation.stopRequested = true
        this.rejectAllPending(generation, this.asError(error))
        try {
          await this.cleanupGeneration(generation, 'adapter-error')
        } catch (cleanupError) {
          if (this.isCurrent(generation)) {
            this.currentState = 'stopping'
            this.emit({
              kind: 'gave-up',
              attempts: attempt,
              reason: this.asError(cleanupError).message,
            })
          }
          return
        }
        reason = this.asError(error).message
      }
    }
    if (!this.isCurrent(generation) || this.currentState !== 'restarting')
      return
    this.currentState = 'stopped'
    this.emit({ kind: 'gave-up', attempts: this.maxRestartAttempts, reason })
  }

  private waitBackoff(
    generation: SidecarGeneration,
    milliseconds: number,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const finish = (elapsed: boolean) => {
        clearTimeout(timer)
        if (generation.cancelBackoff === cancel)
          generation.cancelBackoff = undefined
        resolve(
          elapsed &&
            this.isCurrent(generation) &&
            this.currentState === 'restarting',
        )
      }
      const cancel = () => finish(false)
      const timer = setTimeout(() => finish(true), milliseconds)
      unrefTimer(timer)
      generation.cancelBackoff = cancel
    })
  }

  private rejectAllPending(generation: SidecarGeneration, error: Error): void {
    const entries = [...generation.pending.values()]
    generation.pending.clear()
    for (const entry of entries) entry.reject(error)
  }

  private cleanupGeneration(
    generation: SidecarGeneration,
    reason: StopReason,
    force = false,
    retry = false,
  ): Promise<void> {
    if (generation.cleanupPromise) {
      if (force) void generation.scope.requestStop(reason, true)
      return generation.cleanupPromise
    }
    const cleanup = Promise.resolve()
      .then(() =>
        retry
          ? generation.scope.retryCleanup(force)
          : generation.scope.requestStop(reason, force),
      )
      .then((result) => {
        if (result.status !== 'complete') {
          throw new SidecarRequestError(
            'Sidecar cleanup could not confirm process exit and scope drainage.',
            { reason: 'child-exited', cause: result },
          )
        }
      })
    generation.cleanupPromise = cleanup
    void cleanup
      .finally(() => {
        if (generation.cleanupPromise === cleanup)
          generation.cleanupPromise = null
      })
      .catch(() => undefined)
    return cleanup
  }

  private asError(error: unknown): Error {
    return error instanceof Error
      ? error
      : new SidecarRequestError(String(error), { reason: 'protocol' })
  }

  private emit(event: SidecarSupervisorEvent): void {
    this.onEvent?.(event)
  }
}
