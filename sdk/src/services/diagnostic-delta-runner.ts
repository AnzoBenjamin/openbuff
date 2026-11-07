import { preflightDiagnosticDelta } from './diagnostic-delta'
import { getSystemProcessEnv } from '../env'

import type { ChildProcess } from 'node:child_process'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type {
  DiagnosticCapture,
  DiagnosticCommandRunner,
  DiagnosticRunResult,
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
 * Grace period between the deadline SIGTERM and the SIGKILL escalation
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
 * seam. The command strings come from the fixed `DIAGNOSTIC_COMMANDS` table in
 * services/diagnostic-delta.ts and are never interpolated with tool, file, or
 * user input, so a whitespace split yields the exact argv — the process is
 * spawned directly (argv array), never through a shell.
 *
 * Per the runner contract, honors `timeoutSeconds` (SIGTERM at the deadline,
 * escalating to SIGKILL after a short unref'd grace so a SIGTERM-ignoring
 * child is reaped instead of leaking with live pipes on the hot file-change
 * path, + `timedOut`) and treats a missing/failing tool as a non-fatal
 * `errorMessage` result rather than a rejection, so an absent linter can
 * never fabricate diagnostics.
 */
export function createDiagnosticCommandRunner(params: {
  spawn: CodebuffSpawn
  /** Injected for tests to shorten the SIGTERM→SIGKILL grace window. */
  sigtermGraceMs?: number
}): DiagnosticCommandRunner {
  const spawn = params.spawn
  const sigtermGraceMs = params.sigtermGraceMs ?? DIAGNOSTIC_SIGTERM_GRACE_MS
  return ({ command, cwd, timeoutSeconds, env, signal }) =>
    new Promise<DiagnosticRunResult>((resolve) => {
      const argv = command.split(/\s+/).filter(Boolean)
      const file = argv.shift()
      if (!file) {
        resolve({
          errorMessage: 'empty diagnostic command',
          errorCode: 'EMPTY_COMMAND',
        })
        return
      }
      const stdoutCapture = new BoundedStreamCapture()
      const stderrCapture = new BoundedStreamCapture()
      let settled = false
      let deadlineExpired = false
      let timer: ReturnType<typeof setTimeout> | undefined
      // Tracked in the outer scope so finish() can cancel it (P3 audit): a
      // child that exits before the SIGTERM→SIGKILL grace elapses must not
      // leave a dangling escalation timer — the same settle() shape the
      // sibling semgrep runner (makeSpawnRunner) enforces.
      let escalate: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const finish = (result: DiagnosticRunResult) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (escalate) clearTimeout(escalate)
        if (onAbort) signal?.removeEventListener('abort', onAbort)
        resolve({
          ...result,
          ...(deadlineExpired ? { timedOut: true } : {}),
          stdout: result.stdout ?? stdoutCapture.text(),
          stderr: result.stderr ?? stderrCapture.text(),
          outputTruncated: stdoutCapture.truncated || stderrCapture.truncated,
        })
      }
      if (signal?.aborted) {
        finish({
          cancelled: true,
          errorMessage: 'diagnostic command cancelled before spawn',
        })
        return
      }
      let child: ChildProcess
      try {
        child = spawn(file, argv, {
          cwd,
          ...(env ? { env: { ...getSystemProcessEnv(), ...env } } : {}),
          ...(signal ? { signal } : {}),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        finish({
          errorMessage: error instanceof Error ? error.message : String(error),
          errorCode: (error as NodeJS.ErrnoException)?.code,
          cancelled:
            signal?.aborted ||
            (error instanceof Error && error.name === 'AbortError'),
        })
        return
      }
      onAbort = () =>
        finish({
          cancelled: true,
          errorMessage: 'diagnostic command cancelled',
        })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      timer = setTimeout(() => {
        deadlineExpired = true
        try {
          child.kill('SIGTERM')
        } catch {
          // The child already exited; the close handler settles the result.
        }
        finish({
          timedOut: true,
          errorMessage: `diagnostic command timed out after ${timeoutSeconds}s`,
        })
        // SIGKILL escalation (perf:
        // diagnostic-runner-timeout-no-sigkill-escalation): a child that
        // ignores SIGTERM would otherwise leak with live pipes on the hot
        // file-change path. A short unref'd grace timer reaps it — the same
        // guard the sibling semgrep runner (makeSpawnRunner) enforces. The
        // result is already settled above, so the escalation never delays
        // callers; it only bounds the leaked child's lifetime.
        escalate = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }, sigtermGraceMs)
        escalate.unref?.()
      }, timeoutSeconds * 1000)
      timer.unref?.()
      // Raw-byte accumulation with ONE decode at stream end (perf:
      // diagnostic-capture-utf8-chunk-split): per-chunk toString() split
      // multibyte UTF-8 sequences at chunk boundaries, and the old cap
      // compared UTF-16 string length instead of bytes.
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdoutCapture.push(chunk)
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrCapture.push(chunk)
      })
      child.on('error', (error: Error) => {
        // Missing tool (ENOENT) and similar spawn failures: no diagnostics,
        // never a fabricated rejection.
        finish({
          errorMessage: error.message,
          errorCode: (error as NodeJS.ErrnoException).code,
          cancelled: signal?.aborted || error.name === 'AbortError',
        })
      })
      child.on('close', (code: number | null, terminationSignal?: string) => {
        finish({
          exitCode: code ?? undefined,
          cancelled: signal?.aborted,
          ...(terminationSignal
            ? {
                errorMessage: `diagnostic command terminated by ${terminationSignal}`,
              }
            : {}),
          stdout: stdoutCapture.text(),
          stderr: stderrCapture.text(),
        })
      })
    })
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
  }) =>
    | Promise<DiagnosticCapture | LanguageDiagnostic[] | undefined>
    | DiagnosticCapture
    | LanguageDiagnostic[]
    | undefined
}): DiagnosticDeltaHook {
  const runCommand = createDiagnosticCommandRunner(params)
  const preflight = params.preflight ?? preflightDiagnosticDelta
  return async ({ files, cwd, env, signal }) => {
    try {
      let baseline: DiagnosticCapture | LanguageDiagnostic[] | undefined
      try {
        baseline = await params.getBaseline?.({ files, cwd, env, signal })
      } catch {
        return {
          rejected: false,
          diagnosticStatus: signal?.aborted ? 'cancelled' : 'unknown',
          observations: { basis: 'unknown', reason: 'baseline_capture_failed' },
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
      })
    } catch {
      // Work may continue, but missing observation never becomes passed evidence.
      return {
        rejected: false,
        diagnosticStatus: signal?.aborted ? 'cancelled' : 'unknown',
        observations: { basis: 'unknown', reason: 'preflight_failed' },
      }
    }
  }
}
