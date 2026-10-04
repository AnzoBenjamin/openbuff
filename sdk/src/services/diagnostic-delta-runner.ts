import { preflightDiagnosticDelta } from './diagnostic-delta'
import { getSystemProcessEnv } from '../env'

import type { ChildProcess } from 'node:child_process'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type {
  DiagnosticCommandRunner,
  DiagnosticRunResult,
} from './diagnostic-delta'
import type { DiagnosticDeltaHook } from '../tools/file-change-hooks'

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

  push(chunk: Buffer | string): void {
    if (this.retained >= MAX_CAPTURED_STREAM_BYTES) return
    const bytes =
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const take = Math.min(
      MAX_CAPTURED_STREAM_BYTES - this.retained,
      bytes.length,
    )
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
        resolve({ errorMessage: 'empty diagnostic command' })
        return
      }
      const stdoutCapture = new BoundedStreamCapture()
      const stderrCapture = new BoundedStreamCapture()
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: DiagnosticRunResult) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(result)
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
        })
        return
      }
      timer = setTimeout(() => {
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
        const escalate = setTimeout(() => {
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
        finish({ errorMessage: error.message })
      })
      child.on('close', (code: number | null) => {
        finish({
          exitCode: code ?? 1,
          stdout: stdoutCapture.text(),
          stderr: stderrCapture.text(),
        })
      })
    })
}

/**
 * The `diagnosticDelta` injector runFileChangeHooks consumes. Fail-open: any
 * error inside the preflight resolves to `undefined`, which the hook executor
 * treats as "no preflight result", so a broken preflight never breaks hooks.
 * The flag check lives inside runFileChangeHooks, so this injector can be
 * passed unconditionally and flag-off behavior stays byte-identical.
 */
export function createDiagnosticDeltaHook(params: {
  spawn: CodebuffSpawn
  /** Injected for tests so a throwing preflight can prove the fail-open path. */
  preflight?: typeof preflightDiagnosticDelta
}): DiagnosticDeltaHook {
  const runCommand = createDiagnosticCommandRunner(params)
  const preflight = params.preflight ?? preflightDiagnosticDelta
  return async ({ files, cwd, env, signal }) => {
    try {
      // File-change hooks observe already-changed files, so no pre-edit
      // baseline exists on this seam: the preflight captures the current state
      // as its own baseline with a no-op applyEdit. It therefore reports
      // acceptance unless its capture machinery itself breaks (fail-open
      // below) and never fabricates a rejection; a true before/after delta
      // needs the mutation-broker path that owns the pre-edit snapshot.
      return await preflight({
        files,
        cwd,
        runCommand,
        applyEdit: () => {},
        // The applyEdit above is a no-op: hooks observe already-changed files,
        // so a second full capture of the diagnostic command set (compile-scale
        // commands like tsc --noEmit) would be guaranteed redundant work on the
        // hot file-change path. Reuse the baseline capture instead.
        skipSecondCapture: true,
        env,
        signal,
      })
    } catch {
      // Fail-open: a broken preflight must never break the hooks.
      return undefined
    }
  }
}
