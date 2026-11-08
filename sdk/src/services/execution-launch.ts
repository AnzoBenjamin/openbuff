import { spawn } from 'node:child_process'

import { isExecutionDeadlineSignal } from '@codebuff/common/util/execution-context'

import type { ChildProcess } from 'node:child_process'
import type {
  ExactLaunchInput,
  ExecutionAdapterContext,
  Family,
  LaunchFacts,
  Limit,
  PreparedLaunch,
  Refusal,
  Result,
  Scheduler,
  TargetDescription,
  TargetPermit,
} from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

export class ExecutionRefusalError extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.cause)
    this.name = 'ExecutionRefusalError'
  }
}

export function isExecutionRefusalError(error: unknown): error is ExecutionRefusalError {
  return error instanceof ExecutionRefusalError
}

export function executionRefusal(reason: Refusal['reason'], cause: string): Refusal {
  return Object.freeze({ ok: false, reason, cause })
}

export function refusalForSignal(signal: AbortSignal): Refusal {
  if (isExecutionDeadlineSignal(signal)) {
    return executionRefusal('deadline-exhausted', 'Execution deadline exhausted')
  }
  return executionRefusal(
    'cancelled',
    signal.reason instanceof Error ? signal.reason.message : 'Execution request cancelled',
  )
}

export function executionLimitMs(durationMs: number | undefined): Result<Limit> {
  if (durationMs === undefined || durationMs === -1) {
    return { ok: true, value: Object.freeze({ kind: 'unbounded' }) }
  }
  if (durationMs === 0) {
    return executionRefusal('deadline-exhausted', 'Execution local limit is exhausted')
  }
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    return executionRefusal('invalid-context', 'Execution duration must be a positive whole number of milliseconds or -1')
  }
  return { ok: true, value: Object.freeze({ kind: 'finite', durationMs }) }
}

export function executionLimitSeconds(seconds: number): Result<Limit> {
  return executionLimitMs(seconds === -1 ? -1 : seconds * 1000)
}

export function deriveExecutionContext(
  context: ExecutionAdapterContext | undefined,
  memoKey: string,
  limit: Limit,
): Result<ExecutionAdapterContext> {
  if (!context) return executionRefusal('unavailable', 'Captured execution context is unavailable')
  if (context.signal?.aborted) return refusalForSignal(context.signal)
  try {
    const derived = context.execution.derive({ memoKey, limit })
    return derived.ok
      ? {
          ok: true,
          value: Object.freeze({
            ...context,
            execution: derived.value,
            signal: derived.value.signal ?? context.signal,
          }),
        }
      : derived
  } catch {
    return executionRefusal('invalid-context', 'Execution budget facade is invalid')
  }
}

export type NodeTargetInput = Readonly<{
  executionContext?: ExecutionAdapterContext
  executable: string
  argv: readonly string[]
  cwd: string
  branchId: string
  family?: Family
  processType?: 'SYNC' | 'BACKGROUND'
  shellCommandBytes?: string
  environmentOverlay?: Readonly<Record<string, string | undefined>>
  adapterOptions: Readonly<Record<string, string | number | boolean | null>>
}>

/** Capture all policy-relevant Node options before admission or other awaits. */
export function captureNodeTarget(input: NodeTargetInput): Result<TargetDescription> {
  const context = input.executionContext
  if (!context) return executionRefusal('unavailable', 'Captured execution context is unavailable')
  if (context.signal?.aborted) return refusalForSignal(context.signal)
  if (!input.branchId) return executionRefusal('invalid-context', 'Execution branch identity is unavailable')
  try { return {
    ok: true,
    value: Object.freeze({
      executable: input.executable,
      argv: Object.freeze([...input.argv]),
      ...(input.shellCommandBytes !== undefined ? { shellCommandBytes: input.shellCommandBytes } : {}),
      cwd: input.cwd,
      projectRoot: context.projectRoot,
      allowedPaths: Object.freeze([...context.allowedPaths]),
      mode: context.mode,
      processType: input.processType ?? 'SYNC',
      profile: Object.freeze({ ...context.profile, required: Object.freeze([...context.profile.required]) }),
      family: input.family ?? 'sync-shell',
      branchId: input.branchId,
      ...(input.environmentOverlay ? { environmentOverlay: Object.freeze({ ...input.environmentOverlay }) } : {}),
      adapterOptions: Object.freeze({ ...input.adapterOptions, runtime: 'node' }),
    }),
  } } catch {
    return executionRefusal('invalid-context', 'Captured Node execution context is invalid')
  }
}

export function prepareNodeLaunch(input: NodeTargetInput): Result<PreparedLaunch> {
  const target = captureNodeTarget(input)
  if (!target.ok) return target
  try {
    return input.executionContext!.execution.prepareTarget({ target: target.value })
  } catch {
    return executionRefusal('invalid-context', 'Execution launch facade is invalid')
  }
}

export type AdmittedNodeLaunch = Readonly<{
  launch: PreparedLaunch
  permit: TargetPermit
}>

export async function admitNodeLaunch(
  launch: PreparedLaunch,
  signal?: AbortSignal,
): Promise<Result<AdmittedNodeLaunch>> {
  if (signal?.aborted) return refusalForSignal(signal)
  try {
    const admission = await launch.admit()
    if (!admission.ok) return admission
    // Cancellation between policy completion and actual dispatch still grants
    // no spawn. A consumed permit is never renewed by this adapter.
    if (signal?.aborted) return refusalForSignal(signal)
    return { ok: true, value: Object.freeze({ launch, permit: admission.value.permit }) }
  } catch {
    return executionRefusal('invalid-context', 'Execution admission facade failed')
  }
}

export type NodeDispatchHandle = Readonly<{
  child: ChildProcess
  input: ExactLaunchInput
  facts: () => LaunchFacts
  started: Promise<Result<Readonly<{ pid: number }>>>
  observation: () => Result<Readonly<{ pid: number }>>
  resourceRefusal: () => Refusal | undefined
  remainingResourceMs: () => number | null
}>

export type NodeDispatchResult = Result<NodeDispatchHandle> | (Refusal & Readonly<{ dispatchFailed: true }>)

export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

const nodeDeadlineScheduler: Scheduler = {
  set(delay, callback) {
    const timer = setTimeout(callback, delay)
    timer.unref?.()
    return timer
  },
  clear(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>) },
}

/** Bounded wakeups recheck one captured deadline without renewing its duration. */
export function scheduleNodeDeadline(
  remainingMs: () => number | null,
  onDeadline: () => void,
  scheduler: Scheduler = nodeDeadlineScheduler,
): () => void {
  let timer: unknown
  let cancelled = false
  const arm = () => {
    if (cancelled) return
    const remaining = remainingMs()
    if (remaining === null) return
    // Node maps overflowing or sub-millisecond delays to about one millisecond.
    // Recheck at wakeup, including exhausted input, without synchronous callbacks.
    const delay = Math.max(1, Math.min(MAX_NODE_TIMER_DELAY_MS, Math.ceil(remaining)))
    timer = scheduler.set(delay, wake)
  }
  const wake = () => {
    timer = undefined
    if (cancelled) return
    const remaining = remainingMs()
    if (remaining === null) return
    if (remaining > 0) { arm(); return }
    cancelled = true
    onDeadline()
  }
  arm()
  return () => {
    if (cancelled) return
    cancelled = true
    if (timer !== undefined) scheduler.clear(timer)
    timer = undefined
  }
}

export type NodeTerminationOptions = Readonly<{
  terminate?: (child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL') => boolean
  sigtermGraceMs?: number
}>

export function trustedNodeSpawn(context?: ExecutionAdapterContext): CodebuffSpawn {
  return context?.spawn ?? ((command, args = [], options) => spawn(command, [...args], options ?? {}))
}

/** Attach the bound observer inside dispatch, before callers use the child. */
export function dispatchNodeLaunch(
  admitted: AdmittedNodeLaunch,
  createChild: (input: ExactLaunchInput) => ChildProcess,
  termination: NodeTerminationOptions = {},
): NodeDispatchResult {
  const { launch, permit } = admitted
  try {
    const dispatched = launch.dispatchNow(permit, (input, observer): NodeDispatchHandle => {
      let child: ChildProcess | undefined
      let closed = false
      let cancelDeadlineTimer: (() => void) | undefined
      let cancelEscalationTimer: (() => void) | undefined
      let lifetimeRefusal: Refusal | undefined
      let killRequested = false
      const startedAt = performance.now()
      const terminate = (signal: 'SIGTERM' | 'SIGKILL') => {
        if (!child || closed) return false
        // Resource expiry and the local deadline backstop can arrive together.
        // One kill request is enough; settlement does not prove process death.
        if (signal === 'SIGKILL') {
          if (killRequested) return false
          killRequested = true
        }
        try { return termination.terminate ? termination.terminate(child, signal) : child.kill(signal) }
        catch { return false }
      }
      const remaining = () => input.resourceRemainingMs === null ? Infinity
        : Math.max(0, input.resourceRemainingMs - (performance.now() - startedAt))
      const remainingResourceMs = () => input.resourceRemainingMs === null ? null : remaining()
      const onResourceAbort = () => {
        if (!child || closed) return
        lifetimeRefusal = refusalForSignal(input.resourceSignal)
        if (refusalForSignal(input.resourceSignal).reason === 'deadline-exhausted' || remaining() <= 0) {
          terminate('SIGKILL')
          return
        }
        const graceMs = Math.min(termination.sigtermGraceMs ?? 5_000, remaining())
        const graceStartedAt = performance.now()
        const signalled = terminate('SIGTERM')
        if (closed) return
        if (!signalled || graceMs <= 0) {
          terminate('SIGKILL')
          return
        }
        cancelEscalationTimer = scheduleNodeDeadline(
          () => Math.max(0, graceMs - (performance.now() - graceStartedAt)),
          () => terminate('SIGKILL'),
        )
      }
      const clearLifetime = () => {
        cancelDeadlineTimer?.()
        cancelEscalationTimer?.()
        input.resourceSignal.removeEventListener('abort', onResourceAbort)
      }
      // Node may synchronously emit AbortError from its own signal listener.
      // Install physical termination first; output/error settlement does not
      // disarm this resource's lifetime before actual close.
      input.resourceSignal.addEventListener('abort', onResourceAbort, { once: true })
      let observed: Result<Readonly<{ pid: number }>> = executionRefusal(
        'unavailable', 'Node process start has not been observed',
      )
      let startSettled = false
      let settleStart!: (result: Result<Readonly<{ pid: number }>>) => void
      const started = new Promise<Result<Readonly<{ pid: number }>>>((resolve) => { settleStart = resolve })
      const finishStart = (result: Result<Readonly<{ pid: number }>>) => {
        observed = result
        if (startSettled) return
        startSettled = true
        settleStart(result)
      }
      try { child = createChild(input) }
      catch (error) { clearLifetime(); throw error }
      const nodeChild = child
      // Observe the child immediately. A signal may abort inside an injected
      // spawn seam, and its termination may synchronously close the child.
      // Install all start/failure observers before handling that abort.
      nodeChild.once('spawn', () => {
        const observation = observer.spawnObserved({ source: 'node-spawn-event', pid: nodeChild.pid ?? -1 })
        finishStart(observation.ok
          ? { ok: true, value: Object.freeze({ pid: nodeChild.pid! }) }
          : observation)
      })
      nodeChild.once('error', (error: NodeJS.ErrnoException) => {
        const recorded = observer.failure({
          source: 'node-error-event',
          ...(error.code ? { errorCode: error.code } : {}),
          cause: error.message,
        })
        finishStart(!recorded.ok ? recorded : input.resourceSignal.aborted
          ? refusalForSignal(input.resourceSignal)
          : executionRefusal('unavailable', error.message))
      })
      nodeChild.once('close', () => {
        closed = true
        clearLifetime()
        if (startSettled) return
        const cause = 'Node process closed without a validated spawn event and PID'
        const recorded = observer.failure({ source: 'adapter-observation-error', cause })
        finishStart(recorded.ok ? lifetimeRefusal ?? (input.resourceSignal.aborted
          ? refusalForSignal(input.resourceSignal) : executionRefusal('unavailable', cause)) : recorded)
      })
      if (input.resourceRemainingMs !== null) {
        cancelDeadlineTimer = scheduleNodeDeadline(remainingResourceMs, () => {
          lifetimeRefusal = input.resourceSignal.aborted ? refusalForSignal(input.resourceSignal)
            : lifetimeRefusal ?? executionRefusal('deadline-exhausted', 'Execution resource deadline exhausted')
          terminate('SIGKILL')
        })
      }
      if (input.resourceSignal.aborted) onResourceAbort()
      return Object.freeze({ child: nodeChild, input, facts: () => launch.facts(), started,
        observation: () => observed, resourceRefusal: () => lifetimeRefusal, remainingResourceMs })
    })
    if (dispatched.ok) return { ok: true, value: dispatched.value.handle }
    return dispatched.reason === 'dispatch-failed'
      ? { ...executionRefusal('unavailable', dispatched.cause), dispatchFailed: true }
      : dispatched
  } catch {
    return executionRefusal('invalid-context', 'Execution dispatch facade failed')
  }
}
