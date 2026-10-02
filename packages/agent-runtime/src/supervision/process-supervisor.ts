/**
 * D36 (P2-T8 slice 1): process-based subagent supervision harness.
 *
 * `spawnSettledSubagent` spawns ONE Bun child process per subagent and settles
 * it into a validated PR-T1 receipt envelope. The envelope shape and the
 * outcome enum are REUSED verbatim from `agentReceiptSchema`
 * (common/src/types/agent-handoff.ts) — no second schema is introduced here.
 *
 * ADOPTION (P2-T8): production spawns reach this supervisor through the
 * flag-gated `spawnSupervised` seam on `SubagentContextParams`
 * (spawn-agent-utils.ts), seeded from `OPENBUFF_PROCESS_SUPERVISION` at the
 * SDK impl entry seam. Flag off (the default) keeps the in-process spawn
 * path byte-identical.
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
 *    'spawn_failed'. Process-group teardown SHIPS: the default seam spawns
 *    the child as a group leader (Bun.spawn `detached: true`) and the
 *    timeout path SIGTERMs then SIGKILLs the WHOLE group (negative-pid
 *    kill) so shell grandchildren die too; injected seams without a
 *    `killGroup` fall back to the direct-pid kill.
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
import { BYOK_OPENROUTER_ENV_VAR } from '@codebuff/common/constants/byok'
import {
  CHATGPT_OAUTH_TOKEN_ENV_VAR,
  OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR,
} from '@codebuff/common/constants/chatgpt-oauth'
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

// P2-T8 adoption slice: the seam REQUEST contract lives in common (so the
// contract never depends on this package) and is re-exported here as the
// canonical agent-runtime surface. The concrete `SettledSubagentResult`
// below is declared structurally identical to common's, so the two stay
// assignable without a nominal link.
export type { SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'

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
  /**
   * Kill the child's WHOLE process group (negative-pid kill). Present only
   * when the child was spawned as a group leader (`detached: true`); seams
   * without it fall back to the direct `kill` above.
   */
  killGroup?: (signal?: 'SIGTERM' | 'SIGKILL') => void
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

// Structurally identical to the seam contract in common
// (`@codebuff/common/types/contracts/agent-runtime`); the concrete `receipt`
// field is the narrowed `AgentReceipt` this module validates.
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
    // Group leader: makes the child a process-group leader so the timeout
    // path can kill the WHOLE group (shell grandchildren included) via a
    // negative-pid kill.
    detached: true,
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
    killGroup: (signal) => {
      // Negative pid targets the child's process group; ESRCH after the
      // group is gone is swallowed like the direct kill above.
      try {
        process.kill(-proc.pid, signal ?? 'SIGTERM')
      } catch {
        // Group already gone.
      }
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

  // Process-group teardown when the seam provides killGroup (the default
  // seam does): both the SIGTERM and the escalation SIGKILL target the
  // WHOLE group so shell grandchildren die too; seams without killGroup
  // fall back to the direct-pid kill.
  const killChild = (signal: 'SIGTERM' | 'SIGKILL'): void => {
    const groupKill = proc.killGroup
    if (groupKill !== undefined) {
      groupKill(signal)
    } else {
      proc.kill(signal)
    }
  }

  termTimer = setTimeout(() => {
    timedOut = true
    killed = true
    try {
      killChild('SIGTERM')
    } catch {
      // Child already exited between timer fire and kill.
    }
    killTimer = setTimeout(() => {
      try {
        killChild('SIGKILL')
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
      // ONLY a truly EMPTY stdout settles as missing_output. Stdout bytes
      // with no complete newline-terminated line mean the child wrote
      // something that never formed the contracted single JSON envelope:
      // garbage output is never ok and never missing_output (security
      // contract — garbage stdout settles crashed/truncated/schema_invalid,
      // never ok).
      if (stdoutCapture.totalBytes === 0) {
        return { outcome: 'missing_output', ...baseWithStdout }
      }
      return {
        outcome: 'schema_invalid',
        schemaError:
          'child stdout had bytes but no newline-terminated JSON line',
        ...baseWithStdout,
      }
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

// ── P2-T8 adoption slice: supervised spawn request + env allowlist ────────
// Additive only: the settle contract above is unchanged. These types and the
// env allowlist builder serve the flag-gated branch in spawn-agent-utils and
// the default seam in supervision/supervised-spawn.ts.

/**
 * Env allowlist seed for a supervised child (P2-T8). Values are supplied
 * EXPLICITLY by the caller — sourced at the SDK seam, the only place ambient
 * `process.env` may be read for this feature (agent-runtime production files
 * never read ambient env) — never scraped wholesale from the environment.
 */
export type SupervisedChildEnvSeed = {
  /** Resolved Openbuff API key; `codebuffApiKey` is the legacy fallback. */
  openbuffApiKey?: string
  codebuffApiKey?: string
  /** BYOK OpenRouter key (forwarded under `CODEBUFF_BYOK_OPENROUTER`). */
  byokOpenrouterApiKey?: string
  /** ChatGPT OAuth token, canonical + openbuff spellings. */
  chatGptOauthToken?: string
  openbuffChatGptOauthToken?: string
  nodeEnv?: string
  /**
   * PATH/HOME are forwarded ONLY when the caller explicitly seeds them, and
   * the caller must do so ONLY when the child may run native tools (bundled
   * ripgrep, tree-sitter WASM): the default seam invokes the child through
   * the absolute `process.execPath`, so no PATH inheritance is required for
   * the Bun runtime itself. Every other ambient key stays excluded — ambient
   * keys are never forwarded wholesale.
   */
  path?: string
  home?: string
}

/** Exact env allowlist for a supervised child; asserted by tests. */
export const SUPERVISED_CHILD_ENV_ALLOWLIST = [
  'OPENBUFF_API_KEY',
  BYOK_OPENROUTER_ENV_VAR,
  CHATGPT_OAUTH_TOKEN_ENV_VAR,
  OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR,
  'NODE_ENV',
  'PATH',
  'HOME',
] as const

/**
 * Builds the child env from the explicit seed: EXACTLY the allowlisted keys
 * that carry a seeded value, nothing else. The child sees no ambient key.
 */
export function buildSupervisedChildEnv(
  seed: SupervisedChildEnvSeed,
): Record<string, string> {
  const apiKey = seed.openbuffApiKey ?? seed.codebuffApiKey
  const env: Record<string, string> = {}
  if (apiKey) env['OPENBUFF_API_KEY'] = apiKey
  if (seed.byokOpenrouterApiKey) {
    env[BYOK_OPENROUTER_ENV_VAR] = seed.byokOpenrouterApiKey
  }
  if (seed.chatGptOauthToken) {
    env[CHATGPT_OAUTH_TOKEN_ENV_VAR] = seed.chatGptOauthToken
  }
  if (seed.openbuffChatGptOauthToken) {
    env[OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR] = seed.openbuffChatGptOauthToken
  }
  if (seed.nodeEnv) env['NODE_ENV'] = seed.nodeEnv
  if (seed.path) env['PATH'] = seed.path
  if (seed.home) env['HOME'] = seed.home
  return env
}

// P2-T8: `SupervisedSpawnRequest` is the seam contract from common,
// re-exported above. Scope note: the flag applies at the `executeSubagent`
// choke point, so it covers spawn-agents background + foreground,
// spawn-agent-inline, AND the two programmatic call sites
// (util/context-consolidation-runner.ts, util/runtime-semantic-compaction.ts)
// — one gate, no second flag.
