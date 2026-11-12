import { spawn } from 'node:child_process'

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'
import type {
  CleanupResult,
  OwnedProcessScope,
  ScopeOutput,
} from '@codebuff/common/types/contracts/process-scope'
import { createNodeProcessScope } from '@codebuff/common/util/node-process-scope'
import { isExecutionDeadlineSignal } from '@codebuff/common/util/execution-context'
import { createDirectHostExecution } from '../../sdk/src/host-execution'

const captureLimitBytes = 10 * 1024 * 1024
const childScopes = new WeakMap<ChildProcess, OwnedProcessScope>()
const childRemainingMs = new WeakMap<ChildProcess, () => number | null>()
const managedScopes = new Map<string, OwnedProcessScope>()
const managedScopeHomes = new Map<string, string>()
const retainedRootCleanup = new Map<string, Set<() => void | Promise<void>>>()

export type EvaluationCommandOptions = SpawnOptions & {
  execution?: ExecutionAdapterContext
  /** Supplemental evaluator identity; never counted as a primary B19 branch. */
  branchId: string
  shellExecutable?: string
  captureLimitBytes?: number
  /** Host observation hooks; these do not grant authority over another child. */
  onProcessScope?: (scope: OwnedProcessScope, child: ChildProcess) => void
  onProcessCleanup?: (result: CleanupResult) => void
  processScopeOutput?: () => ScopeOutput
}

export type EvaluationCaptureResult = {
  stdout: string
  stderr: string
  commandExitCode: number | null
  processCleanup: CleanupResult
  outputCapture: ScopeOutput
}

/** Lookup requires the actual runtime handle, rather than serialized PID facts. */
export function evaluationProcessScope(
  child: ChildProcess,
): OwnedProcessScope | undefined {
  return childScopes.get(child)
}

/** Failed/unknown cleanup remains reachable until the host observes recovery. */
export async function retryEvaluationCleanup(): Promise<CleanupResult[]> {
  return Promise.all(
    [...managedScopes.values()]
      .filter((scope) => scope.currentCleanup()?.cleanupAuthorityRetained)
      .map((scope) => scope.retryCleanup(true)),
  )
}

/** Only an actual retained receipt can keep an owned root until recovery. */
function retainedCleanupScope(error: unknown): OwnedProcessScope | undefined {
  try {
    if (!error || typeof error !== 'object') return undefined
    const receipt = (error as { processCleanup?: CleanupResult }).processCleanup
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      typeof receipt.scopeId !== 'string'
    )
      return undefined
    const scope = managedScopes.get(receipt.scopeId)
    return scope &&
      scope.currentCleanup() === receipt &&
      receipt.cleanupAuthorityRetained
      ? scope
      : undefined
  } catch {
    return undefined
  }
}

export function isEvaluationCleanupRetained(error: unknown): boolean {
  return !!retainedCleanupScope(error)
}

export function retainEvaluationRootUntilCleanup(
  error: unknown,
  cleanupRoot: () => void | Promise<void>,
): boolean {
  const scope = retainedCleanupScope(error)
  if (!scope) return false
  const callbacks =
    retainedRootCleanup.get(scope.scopeId) ??
    new Set<() => void | Promise<void>>()
  callbacks.add(cleanupRoot)
  retainedRootCleanup.set(scope.scopeId, callbacks)
  return true
}

/** HOME is associated with the actual captured launch, never a result summary. */
export function retainEvaluationEnvironmentUntilCleanup(
  home: string,
  cleanupRoot: () => void | Promise<void>,
  error?: unknown,
): boolean {
  const scopes = new Set<OwnedProcessScope>()
  for (const [scopeId, ownedHome] of managedScopeHomes) {
    if (ownedHome === home) {
      const scope = managedScopes.get(scopeId)
      if (scope) scopes.add(scope)
    }
  }
  const failed = retainedCleanupScope(error)
  if (failed) scopes.add(failed)
  if (!scopes.size) return false
  const remaining = new Set([...scopes].map((scope) => scope.scopeId))
  for (const scope of scopes) {
    const callbacks =
      retainedRootCleanup.get(scope.scopeId) ??
      new Set<() => void | Promise<void>>()
    callbacks.add(() => {
      remaining.delete(scope.scopeId)
      if (!remaining.size) return cleanupRoot()
    })
    retainedRootCleanup.set(scope.scopeId, callbacks)
    // Completion of the environment ends this evaluator's ownership. Join an
    // existing attempt, or reconcile an operation that settled before its scope.
    if (!scope.currentCleanup()) void scope.requestStop('owner-shutdown')
  }
  return true
}

/** The evaluator host expressly selects its benchmark commands and workspace. */
export function createEvaluationExecution(options: {
  cwd: string
  env?: Readonly<Record<string, string | undefined>>
  inheritEnv?: boolean
  signal?: AbortSignal
  durationMs?: number
}): ExecutionAdapterContext {
  const captured = createDirectHostExecution({
    ...options,
    limit:
      options.durationMs === undefined
        ? { kind: 'unbounded' }
        : { kind: 'finite', durationMs: options.durationMs },
    profile: {
      policy: 'full-access',
      preferredBackend: 'portable-ts',
      required: ['exact-env'],
      allowBackendFallback: false,
    },
    approvalMode: 'allow-all',
  })
  if (!captured.ok) throw refusal(captured)
  return captured.value.executionContext
}

/**
 * Await admission first, then return a synchronous, single-use dispatch. The
 * caller attaches output/close listeners in the same stack as actual spawn.
 */
export async function prepareEvaluationCommand(
  command: string,
  args: readonly string[],
  options: EvaluationCommandOptions,
): Promise<(onResourceSignal?: (signal: AbortSignal) => void) => ChildProcess> {
  const {
    execution,
    branchId,
    shellExecutable,
    captureLimitBytes: _captureLimitBytes,
    onProcessScope,
    onProcessCleanup,
    processScopeOutput,
    ...spawnOptions
  } = options
  const attachScope = (
    child: ChildProcess,
    lifecycle: Parameters<typeof createNodeProcessScope>[1],
    home?: string,
  ) => {
    const scope = createNodeProcessScope(child, {
      ...lifecycle,
      termGraceMs: 200,
      killGraceMs: 200,
      observationMs: 1_000,
      output: processScopeOutput,
      onCleanup: (result) => {
        if (result.status === 'complete') {
          managedScopes.delete(result.scopeId)
          managedScopeHomes.delete(result.scopeId)
          const callbacks = retainedRootCleanup.get(result.scopeId)
          retainedRootCleanup.delete(result.scopeId)
          for (const cleanupRoot of callbacks ?? []) {
            try {
              void Promise.resolve(cleanupRoot()).catch(() => undefined)
            } catch {
              /* root remains available for host filesystem recovery */
            }
          }
        }
        onProcessCleanup?.(result)
      },
    })
    childScopes.set(child, scope)
    if (lifecycle.remainingMs)
      childRemainingMs.set(child, lifecycle.remainingMs)
    managedScopes.set(scope.scopeId, scope)
    if (home) managedScopeHomes.set(scope.scopeId, home)
    onProcessScope?.(scope, child)
    return scope
  }
  if (!execution)
    return (onResourceSignal) => {
      if (spawnOptions.signal) onResourceSignal?.(spawnOptions.signal)
      const child = spawn(command, args, spawnOptions)
      attachScope(
        child,
        {
          detached: spawnOptions.detached === true,
          signal: spawnOptions.signal,
        },
        spawnOptions.env?.HOME,
      )
      return child
    }
  const shell = options.shell
    ? (shellExecutable ??
      (process.platform === 'win32' ? undefined : '/bin/sh'))
    : undefined
  if (options.shell && !shell)
    throw new Error(
      'Evaluator shell execution requires a captured shell executable on this platform',
    )
  const executable = shell ?? command
  if (shell && args.length)
    throw new Error(
      'Evaluator shell commands must provide exact raw command bytes',
    )
  const argv = shell
    ? process.platform === 'win32'
      ? ['/d', '/s', '/c', command]
      : ['-c', command]
    : [...args]
  const rawStdio = spawnOptions.stdio ?? 'pipe'
  if (
    Array.isArray(rawStdio) &&
    rawStdio.some((entry) => entry !== null && typeof entry === 'object')
  )
    throw new Error(
      'Evaluator mediation requires explicit stdio modes or file descriptors',
    )
  const stdio = Array.isArray(rawStdio) ? [...rawStdio] : rawStdio
  const detached = options.detached === true
  const windowsHide = options.windowsHide === true
  const prepared = execution.execution.prepareTarget({
    target: {
      executable,
      argv,
      ...(shell ? { shellCommandBytes: command } : {}),
      cwd:
        typeof options.cwd === 'string' ? options.cwd : execution.projectRoot,
      projectRoot: execution.projectRoot,
      allowedPaths: execution.allowedPaths,
      mode: execution.mode,
      processType: 'SYNC',
      profile: execution.profile,
      family: 'sync-shell',
      branchId,
      environmentOverlay: options.env,
      adapterOptions: {
        runtime: 'node',
        shell: false,
        stdio: JSON.stringify(stdio),
        detached,
        windowsHide,
        scopeTier:
          detached && process.platform === 'linux'
            ? 'posix-owned-group'
            : 'direct-child',
      },
    },
  })
  if (!prepared.ok) throw refusal(prepared)
  const admitted = await prepared.value.admit()
  if (!admitted.ok) throw refusal(admitted)
  return (onResourceSignal) => {
    const dispatched = prepared.value.dispatchNow(
      admitted.value.permit,
      (input, observer) => {
        onResourceSignal?.(input.resourceSignal)
        const capturedAtMs = performance.now()
        const capturedRemainingMs = input.resourceRemainingMs
        const child = (execution.spawn ?? spawn)(input.executable, input.argv, {
          cwd: input.cwd,
          env: input.env,
          signal: input.resourceSignal,
          stdio,
          shell: false,
          detached: input.adapterOptions.detached === true,
          windowsHide: input.adapterOptions.windowsHide === true,
        })
        const scope = attachScope(
          child,
          {
            detached: input.adapterOptions.detached === true,
            signal: input.resourceSignal,
            originalDeadline: input.deadlines.resourceLifetime,
            launchFacts: () => prepared.value.facts(),
            onStop: () => { observer.cleanupCommitted() },
            remainingMs: () =>
              capturedRemainingMs === null
                ? null
                : Math.max(
                    0,
                    capturedRemainingMs - (performance.now() - capturedAtMs),
                  ),
          },
          input.env.HOME,
        )
        child.once('spawn', () => {
          let failure: string | undefined
          if (
            typeof child.pid === 'number' &&
            Number.isInteger(child.pid) &&
            child.pid > 0
          ) {
            const observed = observer.spawnObserved({
              source: 'node-spawn-event',
              pid: child.pid,
            })
            if (!observed.ok) failure = observed.cause
          } else {
            observer.failure({
              source: 'adapter-observation-error',
              cause: 'Evaluator child has no valid runtime PID',
            })
            failure = 'Evaluator child has no valid runtime PID'
          }
          if (failure) {
            child.emit(
              'error',
              Object.assign(new Error(failure), {
                name: 'ExecutionObservationError',
              }),
            )
            void scope.requestStop('adapter-error', true)
            try {
              child.kill('SIGTERM')
            } catch {
              /* termination request only */
            }
          }
        })
        child.on('error', (error: NodeJS.ErrnoException) =>
          observer.failure({
            source: 'node-error-event',
            errorCode: error.code,
            cause: error.message,
          }),
        )
        return child
      },
    )
    if (!dispatched.ok) throw refusal(dispatched)
    return dispatched.value.handle
  }
}

/** Retain bounded bytes while draining owned pipes through physical cleanup. */
export async function captureEvaluationCommand(
  command: string,
  args: readonly string[],
  options: EvaluationCommandOptions,
): Promise<EvaluationCaptureResult> {
  const limit = options.captureLimitBytes ?? captureLimitBytes
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error(
      'Evaluation capture limit must be a positive finite byte count',
    )
  const stdout = new ByteCapture()
  const stderr = new ByteCapture()
  let stdoutSeenBytes = 0
  let stderrSeenBytes = 0
  let retainedBytes = 0
  let stdoutEnded = false
  let stderrEnded = false
  let taskError: Error | undefined
  let exitCode: number | null = null
  let leaderExitObserved = false
  let scope: OwnedProcessScope | undefined
  let capturedChild: ChildProcess | undefined
  let resourceSignal: AbortSignal | undefined
  let resolveCleanup!: (result: CleanupResult) => void
  const cleanupFinished = new Promise<CleanupResult>((resolve) => {
    resolveCleanup = resolve
  })
  const output = (): ScopeOutput => ({
    stdoutSeenBytes,
    stderrSeenBytes,
    retainedBytes,
    droppedBytes: stdoutSeenBytes + stderrSeenBytes - retainedBytes,
    complete: stdoutEnded && stderrEnded,
  })
  const cancel = () => {
    if (!leaderExitObserved)
      taskError ??= Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
      })
    const deadlineExpired =
      (!!resourceSignal && isExecutionDeadlineSignal(resourceSignal)) ||
      (!!capturedChild &&
        (childRemainingMs.get(capturedChild)?.() ?? Infinity) <= 0)
    void scope?.requestStop(
      deadlineExpired ? 'deadline' : 'owner-cancel',
      !!deadlineExpired,
    )
  }
  const signals: AbortSignal[] = []
  const dispatch = await prepareEvaluationCommand(command, args, {
    ...options,
    // Group/stdio selection is bound before the existing B19 admission.
    detached: options.detached ?? process.platform === 'linux',
    stdio: ['ignore', 'pipe', 'pipe'],
    processScopeOutput: output,
    onProcessCleanup: (result) => {
      resolveCleanup(result)
      options.onProcessCleanup?.(result)
    },
    onProcessScope: (ownedScope, child) => {
      scope = ownedScope
      capturedChild = child
      for (const name of ['stdout', 'stderr'] as const) {
        const stream = child[name]
        const capture = name === 'stdout' ? stdout : stderr
        if (!stream) {
          if (name === 'stdout') stdoutEnded = true
          else stderrEnded = true
        }
        stream?.on('data', (raw: Buffer | string) => {
          const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw
          if (name === 'stdout') stdoutSeenBytes += chunk.length
          else stderrSeenBytes += chunk.length
          const keep = Math.min(chunk.length, limit - retainedBytes)
          capture.append(chunk, keep)
          retainedBytes += keep
          if (stdoutSeenBytes + stderrSeenBytes > limit) {
            taskError ??= Object.assign(
              new Error('Evaluation command output exceeds capture limit'),
              {
                name: 'EvaluationOutputLimitError',
                code: 'EVAL_OUTPUT_LIMIT',
              },
            )
            void ownedScope.requestStop('output-limit')
          }
        })
        stream?.once('end', () => {
          if (name === 'stdout') stdoutEnded = true
          else stderrEnded = true
        })
        stream?.once('error', (error) => {
          taskError ??= error
          void ownedScope.requestStop('adapter-error')
        })
      }
      child.once('exit', (code) => {
        leaderExitObserved = true
        exitCode = code
        if (code !== 0)
          taskError ??= Object.assign(new Error(`Command exited ${code}`), {
            code,
          })
      })
      child.once('error', (error) => {
        const aborted =
          error.name === 'AbortError' ||
          (error as NodeJS.ErrnoException).code === 'ABORT_ERR'
        if (!aborted || !leaderExitObserved) taskError ??= error
        const deadlineExpired =
          (!!resourceSignal && isExecutionDeadlineSignal(resourceSignal)) ||
          (childRemainingMs.get(child)?.() ?? Infinity) <= 0
        void ownedScope.requestStop(
          aborted
            ? deadlineExpired
              ? 'deadline'
              : 'owner-cancel'
            : 'adapter-error',
          aborted && deadlineExpired,
        )
      })
      for (const signal of new Set([
        options.signal,
        options.execution?.signal,
        resourceSignal,
      ])) {
        if (!signal) continue
        signals.push(signal)
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
      }
      try {
        options.onProcessScope?.(ownedScope, child)
      } catch (error) {
        taskError ??= error instanceof Error ? error : new Error(String(error))
        void ownedScope.requestStop('adapter-error', true)
      }
    },
  })
  dispatch((signal) => {
    resourceSignal = signal
  })
  const processCleanup = await cleanupFinished
  for (const signal of signals) signal.removeEventListener('abort', cancel)
  const outputCapture = processCleanup.output
  const result = {
    stdout: stdout.text(),
    stderr: stderr.text(),
    commandExitCode: exitCode,
    processCleanup,
    outputCapture,
  }
  if (taskError || exitCode !== 0 || processCleanup.status !== 'complete') {
    throw Object.assign(
      taskError ??
        Object.assign(
          new Error(
            processCleanup.status !== 'complete'
              ? `Evaluation process cleanup ${processCleanup.status}: ${processCleanup.cause}`
              : `Command exited ${exitCode}`,
          ),
          {
            name:
              processCleanup.status !== 'complete'
                ? 'EvaluationCleanupError'
                : 'Error',
          },
        ),
      result,
      { outputTruncated: outputCapture.droppedBytes > 0 },
    )
  }
  return result
}

/** Fixed-size pages bound capture metadata even for very small writes. */
class ByteCapture {
  private readonly pages: Buffer[] = []
  private lastUsed = 0
  private size = 0

  append(chunk: Buffer, count: number): void {
    let offset = 0
    while (offset < count) {
      let page = this.pages.at(-1)
      if (!page || this.lastUsed === page.length) {
        page = Buffer.allocUnsafe(64 * 1024)
        this.pages.push(page)
        this.lastUsed = 0
      }
      const length = Math.min(count - offset, page.length - this.lastUsed)
      chunk.copy(page, this.lastUsed, offset, offset + length)
      offset += length
      this.lastUsed += length
      this.size += length
    }
  }

  text(): string {
    if (!this.size) return ''
    const last = this.pages.length - 1
    return Buffer.concat(
      this.pages.map((page, index) =>
        index === last ? page.subarray(0, this.lastUsed) : page,
      ),
      this.size,
    ).toString('utf8')
  }
}

export function deriveEvaluationExecution(
  context: ExecutionAdapterContext | undefined,
  memoKey: string,
  durationMs?: number,
): ExecutionAdapterContext | undefined {
  if (!context) return undefined
  const derived = context.execution.derive({
    memoKey,
    limit:
      durationMs === undefined
        ? { kind: 'unbounded' }
        : { kind: 'finite', durationMs },
  })
  if (!derived.ok) throw refusal(derived)
  return {
    ...context,
    execution: derived.value,
    signal: derived.value.signal ?? context.signal,
  }
}

export function isExecutionRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExecutionAdmissionError'
}

function refusal(result: { reason: string; cause: string }): Error {
  return Object.assign(new Error(`${result.reason}: ${result.cause}`), {
    name: 'ExecutionAdmissionError',
    executionRefusal: result,
  })
}
