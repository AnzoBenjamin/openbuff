import { capturedDiagnosticInvocation, preflightDiagnosticDelta } from './diagnostic-delta'
import {
  admitNodeLaunch,
  deriveExecutionContext,
  dispatchNodeLaunch,
  executionLimitSeconds,
  executionRefusal,
  isExecutionRefusalError,
  prepareNodeLaunch,
  refusalForSignal,
  scheduleNodeDeadline,
} from './execution-launch'

import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { ExecutionAdapterContext, Refusal } from '@codebuff/common/types/contracts/execution-context'
import type {
  DiagnosticCapture,
  DiagnosticCommandRunner,
  DiagnosticRunResult,
  DeltaMatchMode,
} from './diagnostic-delta'
import type { DiagnosticDeltaHook } from '../tools/file-change-hooks'
import type { LanguageDiagnostic } from '../tools/language-diagnostics'

/**
 * Production wiring for the diagnostic-delta preflight (audit item B).
 *
 * {@link preflightDiagnosticDelta} never spawns directly — it executes its
 * diagnostic commands through the injected {@link DiagnosticCommandRunner}
 * seam. This module provides the production runner (an argv-array adapter over
 * the same `CodebuffSpawn` child-process seam run.ts already uses) and the
 * fail-open `diagnosticDelta` hook injector that run.ts threads into
 * run_file_change_hooks and run_targeted_validation.
 */

/**
 * Bounded output: cap captured stdout/stderr per diagnostic command run,
 * counted in BYTES (perf: diagnostic-capture-utf8-chunk-split — the previous
 * cap compared UTF-16 code units despite this constant's name, so a
 * multibyte-heavy stream could blow past the intended byte budget). Exported
 * for the fixed perf baseline (CASE 10) and tests.
 */
export const MAX_CAPTURED_STREAM_BYTES = 2 * 1024 * 1024

/**
 * Grace between resource cancellation and SIGKILL escalation. An exhausted
 * resource deadline kills immediately.
 * (perf: diagnostic-runner-timeout-no-sigkill-escalation) — the same guard
 * shape the sibling semgrep runner (makeSpawnRunner) enforces. Injectable per
 * runner for tests.
 */
export const DIAGNOSTIC_SIGTERM_GRACE_MS = 5_000

/**
 * Byte-bounded stream capture (perf: diagnostic-capture-utf8-chunk-split):
 * child output is accumulated as RAW BYTES and decoded exactly once at stream
 * end, so a multibyte UTF-8 sequence split across stream-chunk boundaries is
 * never mangled by per-chunk `chunk.toString()`. Retains only the first
 * {@link MAX_CAPTURED_STREAM_BYTES} bytes per stream; later chunks are
 * dropped. Exported for the fixed perf baseline (CASE 10) and tests.
 */
export class BoundedStreamCapture {
  private chunks: Buffer[] = []
  private retained = 0
  truncated = false

  push(chunk: Buffer | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const take = Math.min(
      MAX_CAPTURED_STREAM_BYTES - this.retained,
      bytes.length,
    )
    if (take < bytes.length) this.truncated = true
    if (take <= 0) return
    this.chunks.push(bytes.subarray(0, take))
    this.retained += take
  }

  /** Decode the retained byte prefix exactly once (multibyte-safe). */
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/**
 * Spawn-agnostic {@link DiagnosticCommandRunner} over the run's child-process
 * seam. Exact argv comes from the frozen diagnostic invocation table. Command
 * text is retained for presentation; it is never split or reparsed for spawn.
 *
 * Honors the captured resource deadline with immediate SIGKILL and `timedOut`.
 * Request cancellation keeps a bounded SIGTERM-to-SIGKILL grace until close.
 * A missing/failing tool produces a non-fatal
 * `errorMessage` result rather than a rejection, so an absent linter can
 * never fabricate diagnostics.
 */
export function createDiagnosticCommandRunner(params: {
  spawn: CodebuffSpawn
  /** Injected for tests to shorten the SIGTERM→SIGKILL grace window. */
  sigtermGraceMs?: number
}): DiagnosticCommandRunner {
  const factorySpawn = params.spawn
  const sigtermGraceMs = params.sigtermGraceMs ?? DIAGNOSTIC_SIGTERM_GRACE_MS
  return async ({ command, cwd, timeoutSeconds, env, signal, executionContext, phase = 'current' }) => {
    const refused = (refusal: Refusal): DiagnosticRunResult => ({
      errorMessage: refusal.cause, executionRefusal: refusal,
      ...(refusal.reason === 'cancelled' ? { cancelled: true } : {}),
      ...(refusal.reason === 'deadline-exhausted' ? { timedOut: true } : {}),
    })
    const invocation = capturedDiagnosticInvocation(command)
    if (!invocation) return {
      ...refused(executionRefusal('unavailable', 'Exact diagnostic command argv is unavailable')),
      errorCode: command.trim() ? 'UNSUPPORTED_COMMAND' : 'EMPTY_COMMAND',
    }
    if (signal?.aborted) return refused(refusalForSignal(signal))
    if (!Number.isSafeInteger(sigtermGraceMs) || sigtermGraceMs < 0) {
      return refused(executionRefusal('invalid-context', 'Diagnostic termination grace is invalid'))
    }
    const capturedEnv = env ? { ...env } : undefined
    const spawn = executionContext?.spawn ?? factorySpawn
    const limit = executionLimitSeconds(timeoutSeconds)
    if (!limit.ok) return refused(limit)
    const context = deriveExecutionContext(executionContext, `diagnostic:${invocation.id}:${phase}`, limit.value)
    if (!context.ok) return refused(context)
    const launch = prepareNodeLaunch({
      executionContext: context.value,
      executable: invocation.executable, argv: invocation.argv, cwd,
      branchId: `diagnostic.${invocation.id}.${phase}`,
      family: 'diagnostic-build-version-scip',
      environmentOverlay: capturedEnv,
      adapterOptions: {
        stdio: 'ignore-pipe-pipe', shell: false, detached: false,
        windowsHide: false, sigtermGraceMs, phase,
      },
    })
    if (!launch.ok) return refused(launch)
    const admitted = await admitNodeLaunch(launch.value, context.value.signal ?? signal)
    if (!admitted.ok) return refused(admitted)
    const dispatched = dispatchNodeLaunch(admitted.value, (input) => spawn(input.executable, input.argv, {
      cwd: input.cwd, env: input.env, signal: input.resourceSignal,
      stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: false, windowsHide: false,
    }), { sigtermGraceMs })
    if (!dispatched.ok) return refused(dispatched)
    const node = dispatched.value
    const child = node.child
    const resourceSignal = node.input.resourceSignal
    return await new Promise<DiagnosticRunResult>((resolve) => {
      const stdoutCapture = new BoundedStreamCapture()
      const stderrCapture = new BoundedStreamCapture()
      let settled = false
      let cancelTimer: (() => void) | undefined
      const finish = (result: DiagnosticRunResult) => {
        if (settled) return
        settled = true
        cancelTimer?.()
        resourceSignal.removeEventListener('abort', onAbort)
        const refusal = result.executionRefusal ?? node.resourceRefusal()
        resolve({
          ...result,
          ...(refusal ? refused(refusal) : {}),
          stdout: result.stdout ?? stdoutCapture.text(),
          stderr: result.stderr ?? stderrCapture.text(),
          outputTruncated: stdoutCapture.truncated || stderrCapture.truncated,
        })
      }
      const onAbort = () => finish(refused(refusalForSignal(resourceSignal)))
      if (node.input.resourceRemainingMs !== null) {
        cancelTimer = scheduleNodeDeadline(node.remainingResourceMs, () => finish(refused(
          node.resourceRefusal() ?? (resourceSignal.aborted ? refusalForSignal(resourceSignal)
            : executionRefusal('deadline-exhausted', 'Diagnostic resource deadline exhausted')),
        )))
      }
      child.stdout?.on('data', (chunk: Buffer | string) => { if (!settled) stdoutCapture.push(chunk) })
      child.stderr?.on('data', (chunk: Buffer | string) => { if (!settled) stderrCapture.push(chunk) })
      child.on('error', (error: NodeJS.ErrnoException) => {
        const observation = node.observation()
        finish({
          ...refused(node.resourceRefusal() ?? (!observation.ok ? observation
            : executionRefusal('unavailable', error.message))),
          ...(error.code ? { errorCode: error.code } : {}),
        })
      })
      child.on('close', (code: number | null, terminationSignal?: string) => {
        const observation = node.observation()
        if (!observation.ok) { finish(refused(observation)); return }
        finish({
          exitCode: code ?? undefined,
          ...(terminationSignal ? { errorMessage: `diagnostic command terminated by ${terminationSignal}` } : {}),
        })
      })
      resourceSignal.addEventListener('abort', onAbort, { once: true })
      if (resourceSignal.aborted) onAbort()
    })
  }
}

/**
 * Optional validation injector. Work may continue after an observer failure,
 * while its unknown/unsuccessful evidence stays visible to hooks and clients.
 * No-baseline captures can certify an empty current check; observed errors
 * without a pre-edit basis cannot be declared pre-existing.
 */
export function createDiagnosticDeltaHook(params: {
  spawn: CodebuffSpawn
  /** Injected for tests so a throwing preflight can prove the fail-open path. */
  preflight?: typeof preflightDiagnosticDelta
  /** Captured host mode; child env cannot choose the delta policy. */
  deltaMode?: DeltaMatchMode
  /**
   * Optional pre-edit baseline provider (P3 audit fix D). When the caller
   * captured diagnostics BEFORE the mutating tool ran, the provider returns
   * that snapshot and the hook uses it as the preflight `baseline` — the
   * after-capture then runs for real, so a NEW error in the after-state can
   * actually produce a rejection. When the provider yields no baseline
   * (not supplied), capture the current state once. A failed baseline
   * provider is retained as unknown evidence, never replaced with success.
   */
  getBaseline?: (ctx: {
    files: string[]
    cwd: string
    env?: Record<string, string | undefined>
    signal?: AbortSignal
    executionContext?: ExecutionAdapterContext
  }) =>
    | Promise<DiagnosticCapture | LanguageDiagnostic[] | undefined>
    | DiagnosticCapture
    | LanguageDiagnostic[]
    | undefined
}): DiagnosticDeltaHook {
  const runCommand = createDiagnosticCommandRunner(params)
  const preflight = params.preflight ?? preflightDiagnosticDelta
  const deltaMode = params.deltaMode ?? 'tolerant'
  const getBaseline = params.getBaseline
  return async input => {
    const files = [...input.files]
    const cwd = input.cwd
    const env = input.env ? { ...input.env } : undefined
    const executionContext = input.executionContext
    const signal = executionContext?.signal ?? input.signal
    try {
      let baseline: DiagnosticCapture | LanguageDiagnostic[] | undefined
      try {
        baseline = await getBaseline?.({ files, cwd, env, signal, executionContext })
      } catch (error) {
        return {
          rejected: false,
          diagnosticStatus: signal?.aborted ? 'cancelled' : 'unknown',
          observations: { basis: 'unknown', reason: 'baseline_capture_failed' },
          ...(isExecutionRefusalError(error) ? { executionRefusal: error.refusal } : {}),
        }
      }
      // File-change hooks observe already-changed files. Without a pre-edit
      // baseline the preflight captures the current state as its own baseline
      // with a no-op applyEdit. A complete error-free current observation can
      // pass; observed errors without a pre-edit basis remain unknown. A true
      // before/after delta needs the caller's captured baseline.
      // WITH a baseline (P3 audit fix D), skipSecondCapture must NOT be
      // passed — the after-capture runs for real so a genuine delta against
      // the pre-edit snapshot can produce a rejection.
      return await preflight({
        files,
        cwd,
        runCommand,
        applyEdit: () => {},
        ...(baseline !== undefined
          ? { baseline }
          : {
              // The applyEdit above is a no-op: hooks observe already-changed
              // files, so a second full capture of the diagnostic command set
              // (compile-scale commands like tsc --noEmit) would be guaranteed
              // redundant work on the hot file-change path. Reuse the baseline
              // capture instead.
              skipSecondCapture: true,
            }),
        env,
        signal,
        executionContext,
        deltaMode,
      })
    } catch (error) {
      // Work may continue, but missing observation never becomes passed evidence.
      return {
        rejected: false,
        diagnosticStatus: signal?.aborted ? 'cancelled' : 'unknown',
        observations: { basis: 'unknown', reason: 'preflight_failed' },
        ...(isExecutionRefusalError(error) ? { executionRefusal: error.refusal } : {}),
      }
    }
  }
}
