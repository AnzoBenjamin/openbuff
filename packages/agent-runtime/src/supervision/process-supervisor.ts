/**
 * D36 (P2-T8 slice 1): process-based subagent supervision harness.
 *
 * `spawnSettledSubagent` spawns ONE Bun child process per subagent and settles
 * it into a validated PR-T1 receipt envelope. The envelope shape and the
 * outcome enum are REUSED verbatim from `agentReceiptSchema`
 * (common/src/types/agent-handoff.ts) — no second schema is introduced here.
 *
 * SCOPE / NON-GOAL: this slice builds the supervisor + settle contract only.
 * Production spawn paths (spawn-agent-utils.ts / tool-executor.ts) are NOT
 * rewired; adoption rides a later flag-gated slice.
 *
 * Contract:
 *  - Child contract: exactly ONE newline-terminated JSON line on stdout — an
 *    `agentReceiptSchema` envelope. Non-zero exit, timeout, or no/invalid
 *    stdout maps to crashed/missing_output/schema_invalid with the PR-T1
 *    precedence: crashed > missing_output > schema_invalid > truncated > ok.
 *  - Settle semantics: stdout/stderr are drained to EOF (so the child can
 *    never deadlock on a full pipe) with bounded capture. On timeout the
 *    child is SIGTERMed, then SIGKILLed after a grace window, and the settle
 *    outcome is crashed 'timeout'. On spawn failure the outcome is crashed
 *    'spawn_failed'. SIGTERM/SIGKILL target the direct child pid; full
 *    process-group teardown rides the flag-gated adoption slice (the fixture
 *    children have no grandchildren).
 *  - Caps: stdout capture 8 MiB (bytes beyond the cap are counted and
 *    discarded → outcome 'truncated'); stderr capture 64 KiB, bounded-log
 *    diagnostics ONLY — stderr is NEVER parsed into the receipt.
 *  - Env architecture: the child env comes ONLY from the injected `env`
 *    allowlist param (empty when omitted); ambient environment keys are never
 *    forwarded. The default seam invokes the child through the absolute
 *    `process.execPath`, so no PATH inheritance is required.
 *  - `memoryLimitMb` is accepted for contract completeness in this slice;
 *    enforcement (a portable per-child memory cap) rides the flag-gated
 *    adoption slice because Bun.spawn exposes no portable per-child memory
 *    limit.
 *  - Returns a structured outcome; never throws.
 */
import { agentReceiptSchema } from '@codebuff/common/types/agent-handoff'
import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'

import { formatValidationIssues } from '../util/format-validation-issues'

/** Bounded stdout capture: 8 MiB. */
export const SETTLE_STDOUT_CAP_BYTES = 8 * 1024 * 1024

/** Bounded stderr capture: 64 KiB (bounded-log only). */
export const SETTLE_STDERR_CAP_BYTES = 64 * 1024

/** Grace window between SIGTERM and SIGKILL when settling a timed-out child. */
export const SETTLE_KILL_GRACE_MS = 2_000

/** Default settle deadline: 10 minutes. */
export const SETTLE_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** The PR-T1 receipt outcome enum, reused verbatim — never redefined. */
export type ReceiptOutcome = NonNullable<AgentReceipt['outcome']>

/** Request the supervisor hands to the injected spawn seam. */
export type SettleSpawnRequest = {
  cmd: string[]
  /** Exactly the allowlisted keys — never the ambient environment. */
  env: Record<string, string>
  /**
   * Child working directory. Defaults to the caller's cwd; an explicit empty
   * sandbox is how callers keep the child runtime from auto-loading a repo
   * `.env` on top of the allowlist (bun loads `.env` from the child's cwd).
   */
  cwd?: string
  stdin: 'ignore'
  stdout: 'pipe'
  stderr: 'pipe'
}

/** Minimal subprocess surface the supervisor settles against. Injectable so
 * tests can stub spawns without a real child process. */
export type SettleChildProcess = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  /** Resolves with the exit code, or null when the child died by signal. */
  exited: Promise<number | null>
  kill: (signal?: 'SIGTERM' | 'SIGKILL') => void
}

export type SettleSpawnSeam = (request: SettleSpawnRequest) => SettleChildProcess

export type SettleCrashReason =
  | 'timeout'
  | 'spawn_failed'
  | 'nonzero_exit'
  | 'internal_error'

export type SpawnSettledSubagentParams = {
  childModulePath: string
  args?: string[]
  timeoutMs?: number
  /** Accepted for contract completeness; enforcement rides the adoption slice (see module doc). */
  memoryLimitMb?: number
  /** Spawn seam; defaults to a thin Bun.spawn wrapper. */
  spawn?: SettleSpawnSeam
  /** Env allowlist forwarded verbatim to the child — never the ambient env. */
  env?: Record<string, string>
  /**
   * Child working directory (defaults to the caller's cwd). Pass an empty
   * temp dir when the allowlist must be the ONLY env source: the child
   * runtime auto-loads `.env` from its cwd otherwise.
   */
  cwd?: string
  /** Injectable monotonic clock for durationMs (see NOTE below). */
  now?: () => number
}

export type SettledSubagentResult = {
  /** Process-level settle outcome (transport truth). When a valid envelope
   * arrived, the child's self-declared `receipt.outcome` is preserved on
   * `receipt` untouched for downstream PR-T1 reconciliation. */
  outcome: ReceiptOutcome
  crashReason?: SettleCrashReason
  receipt?: AgentReceipt
  /** Present only when outcome is 'schema_invalid'. */
  schemaError?: string
  exitCode: number | null
  durationMs: number
  /** Total bytes the child wrote to stdout, before the capture cap discard. */
  stdoutBytes: number
  /** True when the supervisor killed the child (timeout settle). */
  killed: boolean
  /** Bounded-log stderr tail (<= 64 KiB); never parsed into the receipt. */
  stderrTail: string
}

function defaultSpawnSeam(request: SettleSpawnRequest): SettleChildProcess {
  const proc = Bun.spawn(request.cmd, {
    env: request.env,
    ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
    stdin: request.stdin,
    stdout: request.stdout,
    stderr: request.stderr,
  })
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited.then((code) =>
      typeof code === 'number' ? code : null,
    ),
    kill: (signal) => {
      // process.kill is used instead of proc.kill so the signal type is
      // portable across Bun versions; ESRCH after exit is swallowed upstream.
      process.kill(proc.pid, signal ?? 'SIGTERM')
    },
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0)
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Drains the stream to EOF, keeping at most `capBytes` and counting the
 * rest. Always draining is what prevents a chatty child from deadlocking on
 * a full pipe after the capture cap is hit. */
async function captureStream(
  stream: ReadableStream<Uint8Array>,
  capBytes: number,
): Promise<{ bytes: Uint8Array; totalBytes: number }> {
  const chunks: Uint8Array[] = []
  let kept = 0
  let totalBytes = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue
    totalBytes += value.byteLength
    if (kept < capBytes) {
      const room = capBytes - kept
      const keep = room >= value.byteLength ? value : value.subarray(0, room)
      chunks.push(keep)
      kept += keep.byteLength
    }
  }
  return { bytes: concatChunks(chunks), totalBytes }
}

/**
 * Spawns ONE Bun child process for a subagent and settles it into a
 * validated PR-T1 receipt envelope. Never throws — every failure mode
 * resolves to a structured outcome.
 */
export async function spawnSettledSubagent(
  params: SpawnSettledSubagentParams,
): Promise<SettledSubagentResult> {
  const timeoutMs = params.timeoutMs ?? SETTLE_DEFAULT_TIMEOUT_MS
  // NOTE (determinism guard): durationMs is a performance.now delta — a
  // monotonic interval, never a Date.now-derived absolute timestamp.
  // Injectable via params.now so tests stay deterministic.
  const now = params.now ?? (() => performance.now())
  const startedAt = now()

  const crashResult = (
    crashReason: SettleCrashReason,
    exitCode: number | null,
    overrides?: Partial<SettledSubagentResult>,
  ): SettledSubagentResult => ({
    outcome: 'crashed',
    crashReason,
    exitCode,
    durationMs: now() - startedAt,
    stdoutBytes: 0,
    killed: false,
    stderrTail: '',
    ...overrides,
  })

  let proc: SettleChildProcess
  try {
    proc = (params.spawn ?? defaultSpawnSeam)({
      cmd: [
        process.execPath,
        'run',
        params.childModulePath,
        ...(params.args ?? []),
      ],
      // Env architecture: allowlist only. An omitted allowlist means an
      // EMPTY child env — ambient keys are never forwarded.
      env: params.env ?? {},
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    return crashResult('spawn_failed', null)
  }

  let timedOut = false
  let killed = false
  let termTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const clearTimers = () => {
    if (termTimer !== undefined) clearTimeout(termTimer)
    if (killTimer !== undefined) clearTimeout(killTimer)
  }

  termTimer = setTimeout(() => {
    timedOut = true
    killed = true
    try {
      proc.kill('SIGTERM')
    } catch {
      // Child already exited between timer fire and kill.
    }
    killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // Child already gone.
      }
    }, SETTLE_KILL_GRACE_MS)
  }, timeoutMs)

  try {
    const [stdoutCapture, stderrCapture] = await Promise.all([
      captureStream(proc.stdout, SETTLE_STDOUT_CAP_BYTES),
      captureStream(proc.stderr, SETTLE_STDERR_CAP_BYTES),
    ])
    const rawExit = await proc.exited
    clearTimers()

    const exitCode = typeof rawExit === 'number' ? rawExit : null
    // PR-T1 precedence: crashed wins over everything (timeout, signal death,
    // or non-zero exit all count as crashed here).
    const crashReason: SettleCrashReason | undefined = timedOut
      ? 'timeout'
      : exitCode === null || exitCode !== 0
        ? 'nonzero_exit'
        : undefined

    const base = {
      exitCode,
      durationMs: now() - startedAt,
      stdoutBytes: stdoutCapture.totalBytes,
      killed,
      stderrTail: new TextDecoder().decode(stderrCapture.bytes),
    }
    if (crashReason !== undefined) {
      return crashResult(crashReason, exitCode, base)
    }

    const text = new TextDecoder().decode(stdoutCapture.bytes)
    const lines = text.split('\n')
    // A trailing segment without a newline is an INCOMPLETE line (the child
    // contract requires newline-terminated JSON lines) — drop it. This is
    // also what keeps a cap-cut tail from being parsed as a complete line.
    if (text.length > 0 && !text.endsWith('\n')) lines.pop()
    const lastLine = [...lines]
      .reverse()
      .find((line) => line.trim().length > 0)

    const baseWithStdout = { ...base, stdoutBytes: stdoutCapture.totalBytes }
    if (lastLine === undefined) {
      return { outcome: 'missing_output', ...baseWithStdout }
    }

    let parsed:
      | { receipt: AgentReceipt }
      | { error: string }
      | undefined
    try {
      const candidate = agentReceiptSchema.safeParse(JSON.parse(lastLine))
      parsed = candidate.success
        ? { receipt: candidate.data }
        : {
            error: formatValidationIssues({ issues: candidate.error.issues }),
          }
    } catch (error) {
      parsed = { error: error instanceof Error ? error.message : String(error) }
    }

    if (parsed === undefined || 'error' in parsed) {
      return {
        outcome: 'schema_invalid',
        ...(parsed !== undefined ? { schemaError: parsed.error } : {}),
        ...baseWithStdout,
      }
    }
    // Validated envelope + stdout cap exceeded → 'truncated' (still above
    // 'ok' in the PR-T1 precedence).
    if (stdoutCapture.totalBytes > SETTLE_STDOUT_CAP_BYTES) {
      return { outcome: 'truncated', receipt: parsed.receipt, ...baseWithStdout }
    }
    return { outcome: 'ok', receipt: parsed.receipt, ...baseWithStdout }
  } catch {
    clearTimers()
    // Total settle: even an unexpected supervisor-internal failure resolves
    // as a structured crash instead of throwing.
    return crashResult('internal_error', null, { killed })
  }
}
