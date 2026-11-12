import { spawn as nodeSpawn } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js'
import { createNodeProcessScope } from '../util/node-process-scope'
import { isExecutionDeadlineSignal } from '../util/execution-context'

import type { ChildProcess } from 'node:child_process'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type {
  PreparedLaunch,
  Result,
  LaunchObserver,
} from '../types/contracts/execution-context'
import type { CodebuffSpawn } from '../types/spawn'
import type {
  CleanupResult,
  OwnedProcessScope,
  ScopeObservation,
  StopReason,
} from '../types/contracts/process-scope'
import type { NodeProcessScopeOptions } from '../util/node-process-scope'

type ScopedStdioTransportOptions = Readonly<{
  spawn?: CodebuffSpawn
  /** Maximum retained bytes for one newline-delimited protocol frame. */
  maxMessageBytes?: number
  cleanupPolicy?: Pick<
    NodeProcessScopeOptions,
    | 'termGraceMs'
    | 'killGraceMs'
    | 'observationMs'
    | 'probeTimeoutMs'
    | 'pollMs'
  >
  /** Trusted driver seam for cleanup failure controls. */
  createScope?: typeof createNodeProcessScope
  onCleanup?: (result: CleanupResult) => void
}>

/** The callback is bound by the host to a registered resource and request lease. */
export type OwnedStdioTransportOptions = ScopedStdioTransportOptions &
  Readonly<{
    prepareLaunch: () => Result<PreparedLaunch>
  }>

export class McpStdioCleanupError extends Error {
  readonly name = 'McpStdioCleanupError'

  constructor(readonly cleanup: CleanupResult) {
    super(`MCP child cleanup unconfirmed: ${cleanup.cause ?? cleanup.status}`)
  }
}

export class McpStdioFrameLimitError extends Error {
  readonly name = 'McpStdioFrameLimitError'

  constructor(readonly limitBytes: number) {
    super(`MCP stdio frame exceeded ${limitBytes} bytes`)
  }
}

/**
 * Own the actual delayed spawn so the admitted environment is the complete
 * environment. The vendor transport merges ambient defaults at this boundary.
 * Protocol close precedes bounded physical scope cleanup. Failed cleanup keeps
 * the original scope reachable; ordinary close joins its immutable result.
 */
abstract class ScopedStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private readonly buffer = new ReadBuffer()
  private bufferedBytes = 0
  private bufferHighWaterBytes = 0
  private stdoutSeenBytes = 0
  private stderrSeenBytes = 0
  private droppedBytes = 0
  private outputIncomplete = false
  private stdoutDrained = false
  private stderrDrained = false
  private child?: ChildProcess
  private started = false
  protected closed = false
  private closeReported = false
  private scope?: OwnedProcessScope
  private closePromise?: Promise<void>
  private retryPromise?: Promise<void>
  private startupSettled = false
  private resolveStart?: () => void
  private rejectStart?: (error: Error) => void

  protected constructor(
    protected readonly options: ScopedStdioTransportOptions,
  ) {
    if (!Number.isSafeInteger(this.messageLimit) || this.messageLimit <= 0)
      throw new Error('Invalid MCP stdio frame limit')
    for (const value of Object.values(options.cleanupPolicy ?? {})) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new Error('Invalid MCP process cleanup policy')
    }
  }

  protected beginStart(): void {
    if (this.started || this.closed)
      throw new Error('MCP stdio transport cannot be started again')
    this.started = true
  }

  abstract start(): Promise<void>

  protected waitForStart(dispatch: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve
      this.rejectStart = reject
      try {
        dispatch()
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  protected attachChild(
    child: ChildProcess,
    scopeOptions: NodeProcessScopeOptions,
    observer?: LaunchObserver,
  ): ChildProcess {
    this.child = child
    this.stdoutDrained = !child.stdout
    this.stderrDrained = !child.stderr
    this.scope = (this.options.createScope ?? createNodeProcessScope)(child, {
      ...this.options.cleanupPolicy,
      ...scopeOptions,
      onStop: () => { observer?.cleanupCommitted() },
      output: () => ({
        stdoutSeenBytes: this.stdoutSeenBytes,
        stderrSeenBytes: this.stderrSeenBytes,
        retainedBytes: this.bufferedBytes,
        droppedBytes: this.droppedBytes,
        complete:
          !this.outputIncomplete && this.stdoutDrained && this.stderrDrained,
      }),
      onCleanup: (result) => {
        if (this.child !== child) return
        if (result.status === 'complete') {
          this.child = undefined
          this.closed = true
          this.clearReadBuffer()
          this.reportClose()
        }
        this.options.onCleanup?.(result)
      },
    })
    child.once('spawn', () => {
      if (this.child !== child) return
      if (
        typeof child.pid !== 'number' ||
        !Number.isInteger(child.pid) ||
        child.pid <= 0
      ) {
        observer?.failure({
          source: 'adapter-observation-error',
          cause: 'MCP child has no valid runtime PID',
        })
        this.fail(new Error('MCP child has no valid runtime PID'))
        return
      }
      const observed = observer?.spawnObserved({
        source: 'node-spawn-event',
        pid: child.pid,
      })
      if (observed && !observed.ok) {
        this.fail(launchError(observed))
        return
      }
      if (!this.startupSettled) {
        this.startupSettled = true
        this.resolveStart?.()
      }
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (this.child !== child) return
      observer?.failure({
        source: 'node-error-event',
        errorCode: error.code,
        cause: error.message,
      })
      // Node's signal listener can emit AbortError before the scope's abort
      // listener runs. Keep the admitted lifetime cause for that same attempt.
      const reason = scopeOptions.signal?.aborted
        ? isExecutionDeadlineSignal(scopeOptions.signal) ||
          (scopeOptions.remainingMs?.() ?? Infinity) <= 0
          ? 'deadline'
          : 'owner-cancel'
        : 'adapter-error'
      this.fail(error, reason)
    })
    child.once('close', () => {
      if (this.child !== child) return
      if (!this.startupSettled) {
        this.startupSettled = true
        this.rejectStart?.(
          new Error('MCP stdio child closed before observed start'),
        )
      }
      this.closed = true
      this.clearReadBuffer()
      this.reportClose()
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      // Closed protocol streams continue draining through their physical scope.
      if (this.child !== child) return
      this.stdoutSeenBytes += chunk.length
      this.readChunk(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrSeenBytes += chunk.length
    })
    child.stdout?.once('end', () => {
      this.stdoutDrained = true
    })
    child.stderr?.once('end', () => {
      this.stderrDrained = true
    })
    const streamError = (error: Error) => {
      if (this.child === child && !this.closed) this.fail(error)
    }
    child.stdout?.on('error', streamError)
    child.stdin?.on('error', streamError)
    return child
  }

  protected fail(error: Error, reason: StopReason = 'adapter-error'): void {
    if (!this.startupSettled) {
      this.startupSettled = true
      this.rejectStart?.(error)
    }
    // Errors never dispose the physical owner or disarm escalation.
    void this.scope?.requestStop(reason, reason === 'deadline')
    this.onerror?.(error)
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const input = this.child?.stdin
    if (this.closed || !input)
      throw new Error('MCP stdio transport is not connected')
    await new Promise<void>((resolve, reject) => {
      input.write(serializeMessage(message), (error) =>
        error ? reject(error) : resolve(),
      )
    })
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.clearReadBuffer()
    // Publish before onclose can reenter through the SDK client registry.
    const pending = Promise.resolve().then(async () => {
      if (!this.scope) return
      this.requireCleanup(await this.scope.requestStop('owner-shutdown'))
    })
    this.closePromise = pending
    this.reportClose()
    return pending
  }

  /** An explicit new attempt can recover the retained physical owner. */
  retryCleanup(): Promise<void> {
    if (this.retryPromise) return this.retryPromise
    const pending = Promise.resolve().then(async () => {
      if (!this.scope) return
      this.requireCleanup(await this.scope.retryCleanup(true))
    })
    this.retryPromise = pending
    void pending
      .finally(() => {
        if (this.retryPromise === pending) this.retryPromise = undefined
      })
      .catch(() => {})
    return pending
  }

  currentCleanup(): CleanupResult | undefined {
    return this.scope?.currentCleanup()
  }

  observeScope(): Promise<ScopeObservation | undefined> {
    return this.scope?.observe() ?? Promise.resolve(undefined)
  }

  private requireCleanup(result: CleanupResult): void {
    if (result.status !== 'complete') throw new McpStdioCleanupError(result)
  }

  bufferUsage(): Readonly<{
    limitBytes: number
    bufferedBytes: number
    highWaterBytes: number
  }> {
    return {
      limitBytes: this.messageLimit,
      bufferedBytes: this.bufferedBytes,
      highWaterBytes: this.bufferHighWaterBytes,
    }
  }

  private get messageLimit(): number {
    return this.options.maxMessageBytes ?? 10 * 1024 * 1024
  }

  private clearReadBuffer(): void {
    if (this.bufferedBytes) {
      this.droppedBytes += this.bufferedBytes
      this.outputIncomplete = true
    }
    this.bufferedBytes = 0
    this.buffer.clear()
  }

  private readChunk(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.length && !this.closed) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline + 1
      const bytes = end - offset
      if (this.bufferedBytes + bytes > this.messageLimit) {
        this.closed = true
        this.clearReadBuffer()
        this.fail(
          new McpStdioFrameLimitError(this.messageLimit),
          'output-limit',
        )
        this.reportClose()
        break
      }
      this.buffer.append(chunk.subarray(offset, end))
      this.bufferedBytes += bytes
      this.bufferHighWaterBytes = Math.max(
        this.bufferHighWaterBytes,
        this.bufferedBytes,
      )
      offset = end
      if (newline >= 0) {
        this.bufferedBytes = 0
        this.readMessages()
      }
    }
    if (offset < chunk.length) {
      this.droppedBytes += chunk.length - offset
      this.outputIncomplete = true
    }
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  private reportClose(): void {
    if (this.closeReported) return
    this.closeReported = true
    this.onclose?.()
  }

  private readMessages(): void {
    while (!this.closed) {
      try {
        const message = this.buffer.readMessage()
        if (message === null) return
        this.onmessage?.(message)
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        )
      }
    }
  }
}

export class OwnedStdioTransport extends ScopedStdioTransport {
  constructor(private readonly launch: OwnedStdioTransportOptions) {
    super(launch)
  }

  async start(): Promise<void> {
    this.beginStart()
    const prepared = this.launch.prepareLaunch()
    if (!prepared.ok) throw launchError(prepared)
    const admission = await prepared.value.admit()
    if (!admission.ok) throw launchError(admission)
    if (this.closed)
      throw new Error('MCP stdio transport closed before dispatch')
    return this.waitForStart(() => {
      const dispatched = prepared.value.dispatchNow(
        admission.value.permit,
        (input, observer) => {
          const child = (this.options.spawn ?? nodeSpawn)(
            input.executable,
            input.argv,
            {
              cwd: input.cwd,
              env: input.env,
              signal: input.resourceSignal,
              shell: false,
              stdio: ['pipe', 'pipe', 'ignore'],
              detached: input.adapterOptions.detached === true,
              windowsHide: input.adapterOptions.windowsHide === true,
            },
          )
          const capturedAt = performance.now()
          const capturedRemainingMs = input.resourceRemainingMs
          return this.attachChild(
            child,
            {
              detached: input.adapterOptions.detached === true,
              signal: input.resourceSignal,
              remainingMs: () =>
                capturedRemainingMs === null
                  ? null
                  : Math.max(
                      0,
                      capturedRemainingMs - (performance.now() - capturedAt),
                    ),
              originalDeadline:
                prepared.value.facts().deadlines.resourceLifetime,
              launchFacts: () => prepared.value.facts(),
            },
            observer,
          )
        },
      )
      if (!dispatched.ok) this.fail(launchError(dispatched))
    })
  }
}

/** Legacy callers have direct-child coverage without invented B19 authority. */
export class CompatibilityStdioTransport extends ScopedStdioTransport {
  constructor(
    private readonly server: Readonly<{
      command: string
      args: readonly string[]
      env: Readonly<Record<string, string>>
    }> &
      ScopedStdioTransportOptions,
  ) {
    super(server)
  }

  async start(): Promise<void> {
    this.beginStart()
    return this.waitForStart(() => {
      const child = (this.options.spawn ?? crossSpawn)(
        this.server.command,
        this.server.args,
        {
          env: { ...getDefaultEnvironment(), ...this.server.env },
          shell: false,
          stdio: ['pipe', 'pipe', 'ignore'],
          detached: false,
          windowsHide: process.platform === 'win32' && 'type' in process,
        },
      )
      this.attachChild(child, { detached: false })
    })
  }
}

function launchError(result: { reason: string; cause: string }): Error {
  return Object.assign(new Error(result.cause), {
    name: 'ExecutionAdmissionError',
    executionRefusal: result,
  })
}
