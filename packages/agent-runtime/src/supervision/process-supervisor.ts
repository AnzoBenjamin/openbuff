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
 *  - Parent cancellation (cancel-softlock fix): an optional `signal` param
 *    carries the PARENT's AbortSignal. When it aborts, the child's WHOLE
 *    process group is killed via the SAME SIGTERM → SIGKILL grace
 *    escalation (no new wall-clock watchdog), the killed child settles with
 *    the honest signal-death reason (never a fabricated 'timeout'), and the
 *    abort listener is removed on every settle path. Omitted ⇒
 *    byte-identical behavior.
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
 *  - P2-T8d SELF-EXEC: `SpawnSettledSubagentParams` gains an optional
 *    `cmdOverride`. When supplied it is used VERBATIM as the spawned command
 *    (self-exec mode: the parent binary re-executes itself as the child via
 *    the shared `SUPERVISED_SELF_EXEC_FLAG`); when absent the default
 *    bun-source cmd below is byte-identical to before. Everything else —
 *    env, cwd, stdin/stdout/stderr, group kill, timeout — is unchanged.
 *  - Returns a structured outcome; never throws.
 */
import { BYOK_OPENROUTER_ENV_VAR } from '@codebuff/common/constants/byok'
import { realIdGen } from '@codebuff/common/deps/real-runtime-deps'
import {
  CHATGPT_OAUTH_TOKEN_ENV_VAR,
  OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR,
} from '@codebuff/common/constants/chatgpt-oauth'
import { agentReceiptSchema } from '@codebuff/common/types/agent-handoff'
import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'
import type { IdGen } from '@codebuff/common/types/contracts/agent-runtime'
import type {
  AbsoluteDeadline,
  ExecutionAdapterContext,
  LaunchObserver,
  Refusal,
} from '@codebuff/common/types/contracts/execution-context'
import type {
  CleanupResult,
  OwnedProcessScope,
  ProcessScopeDriver,
  ProcessScopeOptions,
  ScopeObservation,
  ScopeStreams,
  ScopeTier,
} from '@codebuff/common/types/contracts/process-scope'
import { captureLinuxProcessGroup } from '@codebuff/common/util/linux-process-scope'
import {
  createOwnedProcessScope,
  processScopeClock,
} from '@codebuff/common/util/owned-process-scope'
import { SUPERVISED_CHILD_RUNTIME_ENV_KEYS } from './supervised-child-env-keys'
import { formatValidationIssues } from '../util/format-validation-issues'

// The SDK declaration build (sdk/tsconfig.build.json) transitively
// typechecks this file under `types: ["node"]` — WITHOUT bun-types — so the
// Bun-global `Bun.spawn` below would fail TS2868 there. The Bun runtime
// supplies the global at runtime; this module-scope `declare const` (never
// exported) gives the build only the narrow structural surface this module
// actually uses, mirroring the same pattern in
// util/preflight-syntax-validation.ts and process-str-replace.ts.
declare const Bun: {
  spawn: (
    cmd: string[],
    options: {
      env: Record<string, string>
      cwd?: string
      stdin: 'ignore'
      stdout: 'pipe'
      stderr: 'pipe'
      /** Group leader: enables the negative-pid group kill on timeout. */
      detached?: boolean
    },
  ) => {
    pid: number
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
  }
}

/** Bounded stdout capture: 8 MiB. */
export const SETTLE_STDOUT_CAP_BYTES = 8 * 1024 * 1024

/** Bounded stderr capture: 64 KiB (bounded-log only). */
export const SETTLE_STDERR_CAP_BYTES = 64 * 1024

/** Grace window between SIGTERM and SIGKILL when settling a timed-out child. */
export const SETTLE_KILL_GRACE_MS = 200

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
  /** Host-only observation capability; never serialized into the child request. */
  observer?: LaunchObserver
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
  /** Captured before admission and consumed verbatim by the runtime seam. */
  detached: boolean
}

/** Minimal subprocess surface the supervisor settles against. Injectable so
 * tests can stub spawns without a real child process. */
export type SettleChildProcess = {
  /** Runtime-owned PID, used for the default Bun launch observation only. */
  pid?: number
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
  /** Runtime-neutral ownership/observation seam. Bare fake seams use injected coverage. */
  processScopeDriver?: Readonly<{ tier: ScopeTier; driver: ProcessScopeDriver }>
}

export type SettleSpawnSeam = (
  request: SettleSpawnRequest,
) => SettleChildProcess

export type SettleCrashReason =
  | 'timeout'
  | 'spawn_failed'
  | 'nonzero_exit'
  | 'internal_error'

export type SpawnSettledSubagentParams = {
  execution?: ExecutionAdapterContext
  branchId?:
    | 'supervised.source.initial'
    | 'supervised.source.retry'
    | 'supervised.self-exec.initial'
    | 'supervised.self-exec.retry'
  childModulePath: string
  args?: string[]
  /**
   * P2-T8d SELF-EXEC: when supplied, used VERBATIM as the spawn cmd
   * (`args` is ignored) — the flag-gated default seam passes
   * `[process.execPath, SUPERVISED_SELF_EXEC_FLAG, requestPath]` so a
   * compiled binary re-executes ITSELF as the supervised child. Additive
   * only: omitted means the byte-identical default bun-source cmd.
   */
  cmdOverride?: string[]
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
  /** Trusted host ID source; never serialized into the child request. */
  idGen?: Pick<IdGen, 'uuid'>
  /**
   * cancel-softlock fix: the PARENT's AbortSignal. When it aborts — or is
   * already aborted at spawn time — the child's WHOLE process group is
   * killed via the same SIGTERM → SIGKILL grace escalation the deadline
   * path uses (shared killCommitted latch — never a double kill), with NO
   * new wall-clock watchdog, and the settle keeps the honest signal-death
   * reason (never a fabricated 'timeout'). The listener is removed on every
   * settle path. Omitted ⇒ byte-identical behavior (no listener, no kill).
   */
  signal?: AbortSignal
  /** When set, the deadline is an INACTIVITY window reset on each activity
   *  event (see onActivity); omitted → the single wall-clock timeoutMs timer. */
  idleTimeoutMs?: number
  /** Absolute, never-resettable lifetime cap. Default undefined (off). */
  maxLifetimeMs?: number
  /** Subscribe to external activity (e.g. bridge requests); returns an
   *  unsubscribe. Fired listeners reset the idle window. Omitted → no external
   *  activity source. */
  onActivity?: (listener: () => void) => () => void
  cleanupPolicy?: Pick<
    ProcessScopeOptions,
    | 'termGraceMs'
    | 'killGraceMs'
    | 'observationMs'
    | 'probeTimeoutMs'
    | 'pollMs'
  >
}

// Structurally identical to the seam contract in common
// (`@codebuff/common/types/contracts/agent-runtime`); the concrete `receipt`
// field is the narrowed `AgentReceipt` this module validates.
export type SettledSubagentResult = {
  /** A refused dispatch is distinguishable from a runtime spawn failure. */
  executionRefusal?: Refusal
  cleanup?: CleanupResult
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
  /** True when the supervisor killed the child (timeout or parent-abort settle). */
  killed: boolean
  /** Bounded-log stderr tail (<= 64 KiB); never parsed into the receipt. */
  stderrTail: string
}

const managedSupervisedScopes = new Map<
  OwnedProcessScope,
  ExecutionAdapterContext['execution'] | undefined
>()

/** Trusted-host handles retained until physical cleanup, including failed attempts. */
export function retainedSupervisedProcessScopes(): readonly OwnedProcessScope[] {
  return [...managedSupervisedScopes.keys()]
}

/** Own stream EOF and runtime wait separately from covered-group membership. */
function ownSettleChild(
  raw: SettleChildProcess,
  runtime?: Readonly<{ pid: number; detached: boolean }>,
): SettleChildProcess {
  const tier: ScopeTier = runtime
    ? runtime.detached && process.platform === 'linux'
      ? 'posix-owned-group'
      : 'direct-child'
    : 'injected'
  const group =
    tier === 'posix-owned-group' && runtime
      ? captureLinuxProcessGroup(runtime.pid)
      : undefined
  let reaped = false
  let exitUnknown = false
  const streams: {
    stdin: ScopeStreams['stdin']
    stdout: ScopeStreams['stdout']
    stderr: ScopeStreams['stderr']
  } = {
    stdin: 'closed',
    stdout: 'open',
    stderr: 'open',
  }
  let resolveStreams!: (value: ScopeStreams) => void
  const streamsFinished = new Promise<ScopeStreams>((resolve) => {
    resolveStreams = resolve
  })
  const checkStreams = () => {
    if (streams.stdout !== 'open' && streams.stderr !== 'open')
      resolveStreams({ ...streams })
  }
  const ownStream = (
    source: ReadableStream<Uint8Array>,
    name: 'stdout' | 'stderr',
  ) => {
    const reader = source.getReader()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let closed = false
    const mark = (state: ScopeStreams[typeof name]) => {
      streams[name] = state
      checkStreams()
    }
    const abandon = () => {
      if (closed) return
      closed = true
      mark('closed-incomplete')
      controller.close()
      // Cancellation is observed as incomplete output. Never await an unbounded cancel hook.
      void reader.cancel().catch(() => undefined)
    }
    const stream = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value
        },
        async pull() {
          try {
            const { done, value } = await reader.read()
            if (closed) return
            if (done) {
              closed = true
              mark('drained')
              controller.close()
            } else if (value) controller.enqueue(value)
          } catch (error) {
            if (closed) return
            closed = true
            mark('closed-incomplete')
            controller.error(error)
          }
        },
        cancel() {
          if (closed) return
          closed = true
          mark('closed-incomplete')
          return reader.cancel()
        },
      },
      { highWaterMark: 64 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
    )
    return { stream, abandon }
  }
  const stdout = ownStream(raw.stdout, 'stdout')
  const stderr = ownStream(raw.stderr, 'stderr')
  const exited = raw.exited.then(
    (code) => {
      reaped = true
      return typeof code === 'number' ? code : null
    },
    (error) => {
      exitUnknown = true
      throw error
    },
  )
  // The generic scope observes this rejection; do not expose a transient unhandled promise.
  void exited.catch(() => undefined)
  const driver: ProcessScopeDriver = {
    leaderExited: exited.then(() => 'exited-reaped'),
    streamsFinished,
    async observe() {
      const presence = group?.observe() ?? {
        scopePresence: exitUnknown
          ? ('unknown' as const)
          : reaped
            ? ('absent' as const)
            : ('living' as const),
        members: [],
        membershipComplete: !exitUnknown,
        identity: 'verified' as const,
      }
      if (
        group &&
        reaped &&
        presence.identity === 'verified' &&
        presence.membershipComplete &&
        (presence.scopePresence === 'absent' ||
          presence.scopePresence === 'zombie-only')
      )
        group.seal()
      return {
        sampledAtMs: processScopeClock.nowMs(),
        clockDomainId: processScopeClock.domainId,
        leader: reaped ? 'exited-reaped' : exitUnknown ? 'unknown' : 'running',
        ...presence,
        streams: { ...streams },
      }
    },
    async signal(name) {
      const atMs = processScopeClock.nowMs()
      if (group?.identity) {
        if (reaped) {
          const presence = group.observe()
          if (
            presence.identity === 'verified' &&
            presence.membershipComplete &&
            (presence.scopePresence === 'absent' ||
              presence.scopePresence === 'zombie-only')
          )
            group.seal()
        }
        return { ...group.signal(name), atMs }
      }
      const base = {
        signal: name,
        atMs,
        targetTier:
          tier === 'posix-owned-group' ? ('direct-child' as const) : tier,
      }
      if (reaped) return { ...base, result: 'already-absent' }
      try {
        // Missing initial group identity never grants broadcast authority.
        // The owned runtime child remains available for direct cancellation.
        if (tier === 'posix-owned-group') raw.kill(name)
        else if (raw.killGroup) raw.killGroup(name)
        else raw.kill(name)
        return { ...base, result: 'delivered' }
      } catch (error) {
        const errorCode = (error as NodeJS.ErrnoException).code
        return {
          ...base,
          result: errorCode === 'ESRCH' ? 'already-absent' : 'unknown',
          ...(errorCode ? { errorCode } : {}),
        }
      }
    },
    closeInput() {}, // stdin was selected as ignore before dispatch.
    abandonStreams() {
      stdout.abandon()
      stderr.abandon()
    },
  }
  return {
    ...raw,
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited,
    processScopeDriver: { tier, driver },
  }
}

function defaultSpawnSeam(request: SettleSpawnRequest): SettleChildProcess {
  const proc = Bun.spawn(request.cmd, {
    env: request.env,
    ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
    stdin: request.stdin,
    stdout: request.stdout,
    stderr: request.stderr,
    detached: request.detached,
  })
  return ownSettleChild(
    {
      pid: proc.pid,
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited: proc.exited.then((code) =>
        typeof code === 'number' ? code : null,
      ),
      kill: (signal) => {
        process.kill(proc.pid, signal ?? 'SIGTERM')
      },
      ...(request.detached
        ? {
            killGroup: (signal?: 'SIGTERM' | 'SIGKILL') => {
              process.kill(-proc.pid, signal ?? 'SIGTERM')
            },
          }
        : {}),
    },
    { pid: proc.pid, detached: request.detached },
  )
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
  onActivity?: () => void,
  onProgress?: (kept: number, totalBytes: number) => void,
  onError?: (error: unknown) => void,
  onReader?: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
): Promise<{ bytes: Uint8Array; totalBytes: number; failed?: true }> {
  const chunks: Uint8Array[] = []
  let kept = 0
  let totalBytes = 0
  const reader = stream.getReader()
  onReader?.(reader)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      // Chunk arrival is a secondary activity signal (resets the idle window).
      onActivity?.()
      totalBytes += value.byteLength
      if (kept < capBytes) {
        const room = capBytes - kept
        const keep = room >= value.byteLength ? value : value.slice(0, room)
        chunks.push(keep)
        kept += keep.byteLength
      }
      onProgress?.(kept, totalBytes)
    }
  } catch (error) {
    onError?.(error)
    return { bytes: concatChunks(chunks), totalBytes, failed: true }
  } finally {
    reader.releaseLock()
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
  const now = params.now ?? (() => performance.now())
  const startedAt = now()
  const startedClockAt = processScopeClock.nowMs()
  const timeoutMs = params.execution ? undefined : params.timeoutMs
  const idleWindowMs = params.execution ? undefined : params.idleTimeoutMs
  const maximumLifetimeMs = params.execution ? undefined : params.maxLifetimeMs
  let processSignal = params.signal
  let proc: SettleChildProcess | undefined
  let scope: OwnedProcessScope | undefined
  let exitCode: number | null = null
  let timedOut = false
  let killed = false
  let stopCommitted = false
  let captureFailed = false
  let forcedOutputClosure = false
  let termTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let maxTimer: ReturnType<typeof setTimeout> | undefined
  let unsubscribeActivity: (() => void) | undefined
  let resolveCleanup!: (value: CleanupResult) => void
  const cleanupFinished = new Promise<CleanupResult>((resolve) => {
    resolveCleanup = resolve
  })
  const stdoutProgress = { kept: 0, total: 0 }
  const stderrProgress = { kept: 0, total: 0 }
  type Capture = Awaited<ReturnType<typeof captureStream>>
  let stdoutPromise: Promise<Capture> | undefined
  let stderrPromise: Promise<Capture> | undefined
  let stdoutReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let stderrReader: ReadableStreamDefaultReader<Uint8Array> | undefined

  const crashResult = (
    crashReason: SettleCrashReason,
    code: number | null,
    overrides?: Partial<SettledSubagentResult>,
  ): SettledSubagentResult => ({
    outcome: 'crashed',
    crashReason,
    exitCode: code,
    durationMs: now() - startedAt,
    stdoutBytes: stdoutProgress.total,
    killed,
    stderrTail: '',
    ...overrides,
  })
  const clearTimers = () => {
    if (termTimer !== undefined) clearTimeout(termTimer)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    if (maxTimer !== undefined) clearTimeout(maxTimer)
    termTimer = idleTimer = maxTimer = undefined
    const unsubscribe = unsubscribeActivity
    unsubscribeActivity = undefined
    try {
      unsubscribe?.()
    } catch {
      /* activity callbacks cannot release physical ownership */
    }
    processSignal?.removeEventListener('abort', onParentAbort)
  }
  const commitKill = (markTimedOut = true, force = false) => {
    if (markTimedOut) timedOut = true
    if (stopCommitted && !force) return
    stopCommitted = true
    killed = true
    clearTimers()
    void scope?.requestStop(
      markTimedOut ? 'deadline' : force ? 'adapter-error' : 'owner-cancel',
      force,
    )
  }
  const armIdle = () => {
    idleTimer = setTimeout(() => commitKill(), idleWindowMs as number)
  }
  const markActivity = () => {
    if (idleWindowMs === undefined || stopCommitted) return
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    armIdle()
  }
  const onParentAbort = () => {
    commitKill(false)
  }
  const captureError = () => {
    captureFailed = true
    commitKill(false, true)
  }

  // Refuse a retry under the same admitted execution port when its previous
  // scope has published a failed/unknown cleanup attempt.
  if (
    params.execution &&
    [...managedSupervisedScopes].some(
      ([owned, execution]) =>
        execution === params.execution!.execution &&
        owned.currentCleanup() &&
        owned.currentCleanup()!.status !== 'complete',
    )
  ) {
    return crashResult('spawn_failed', null, {
      executionRefusal: {
        ok: false,
        reason: 'unavailable',
        cause: 'A prior supervised process scope still requires cleanup',
      },
    })
  }
  for (const value of Object.values(params.cleanupPolicy ?? {})) {
    if (!Number.isSafeInteger(value) || value < 0)
      return crashResult('spawn_failed', null)
  }

  const attach = (
    raw: SettleChildProcess,
    scopeId: string,
    options: Pick<
      ProcessScopeOptions,
      'originalDeadline' | 'remainingMs' | 'launchFacts' | 'onStop'
    > = {},
  ): SettleChildProcess => {
    const owned = raw.processScopeDriver ? raw : ownSettleChild(raw)
    proc = owned
    const capability = owned.processScopeDriver!
    const driver: ProcessScopeDriver = {
      leaderExited: capability.driver.leaderExited,
      streamsFinished: capability.driver.streamsFinished,
      observe: () => capability.driver.observe(),
      signal: (signal) => capability.driver.signal(signal),
      closeInput: () => capability.driver.closeInput(),
      abandonStreams() {
        forcedOutputClosure = true
        try {
          capability.driver.abandonStreams?.()
        } finally {
          // Own the readers even when the injected driver's optional hook is absent.
          for (const reader of [stdoutReader, stderrReader]) {
            try {
              void reader?.cancel().catch(() => undefined)
            } catch {}
          }
        }
      },
    }
    const absoluteBounds = [timeoutMs, maximumLifetimeMs].filter(
      (value): value is number => value !== undefined,
    )
    const originalDeadline: AbsoluteDeadline = absoluteBounds.length
      ? {
          kind: 'finite',
          limitId: scopeId,
          domainId: processScopeClock.domainId,
          expiresAtMs: startedClockAt + Math.min(...absoluteBounds),
        }
      : { kind: 'unbounded', limitId: scopeId }
    scope = createOwnedProcessScope({
      scopeId,
      tier: capability.tier,
      driver,
      signal: processSignal,
      originalDeadline,
      termGraceMs: SETTLE_KILL_GRACE_MS,
      killGraceMs: 200,
      observationMs: 1_000,
      ...params.cleanupPolicy,
      ...options,
      output: () => ({
        stdoutSeenBytes: stdoutProgress.total,
        stderrSeenBytes: stderrProgress.total,
        retainedBytes: stdoutProgress.kept + stderrProgress.kept,
        droppedBytes:
          stdoutProgress.total +
          stderrProgress.total -
          stdoutProgress.kept -
          stderrProgress.kept,
        complete: !captureFailed && !forcedOutputClosure,
      }),
      onCleanup(result) {
        stopCommitted = true
        killed ||= result.signals.some(
          (signal) => signal.result === 'delivered',
        )
        clearTimers()
        if (result.status === 'complete') managedSupervisedScopes.delete(scope!)
        resolveCleanup(result)
      },
    })
    managedSupervisedScopes.set(scope, params.execution?.execution)
    // Readers are established inside dispatch, before any observation or await.
    stdoutPromise = captureStream(
      owned.stdout,
      SETTLE_STDOUT_CAP_BYTES,
      markActivity,
      (kept, total) => {
        stdoutProgress.kept = kept
        stdoutProgress.total = total
      },
      captureError,
      (reader) => {
        stdoutReader = reader
      },
    )
    stderrPromise = captureStream(
      owned.stderr,
      SETTLE_STDERR_CAP_BYTES,
      markActivity,
      (kept, total) => {
        stderrProgress.kept = kept
        stderrProgress.total = total
      },
      captureError,
      (reader) => {
        stderrReader = reader
      },
    )
    void owned.exited.then((code) => {
      exitCode = code
      // Productive work has ended; only the common physical cleanup schedule
      // remains. Final stream bytes continue draining without renewing activity.
      stopCommitted = true
      clearTimers()
    }, captureError)
    return owned
  }

  try {
    const scopeId = `supervised:${(params.idGen ?? realIdGen).uuid()}`
    const spawnRequest: SettleSpawnRequest = {
      cmd: params.cmdOverride ?? [
        process.execPath,
        ...(params.execution ? ['--no-env-file'] : []),
        'run',
        params.childModulePath,
        ...(params.args ?? []),
      ],
      env: params.env ?? {},
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: process.platform !== 'win32',
    }
    if (params.execution) {
      const context = params.execution
      const prepared = context.execution.prepareTarget({
        target: {
          executable: spawnRequest.cmd[0],
          argv: spawnRequest.cmd.slice(1),
          cwd: params.cwd ?? context.projectRoot,
          projectRoot: context.projectRoot,
          allowedPaths: context.allowedPaths,
          mode: context.mode,
          processType: 'SYNC',
          profile: context.profile,
          family: 'supervised-child',
          branchId: params.branchId ?? 'supervised.source.initial',
          environmentOverlay: spawnRequest.env,
          adapterOptions: {
            runtime: 'bun',
            stdio: 'ignore,pipe,pipe',
            detached: spawnRequest.detached,
          },
        },
      })
      if (!prepared.ok)
        return crashResult('spawn_failed', null, { executionRefusal: prepared })
      const admitted = await prepared.value.admit()
      if (!admitted.ok)
        return crashResult('spawn_failed', null, { executionRefusal: admitted })
      const dispatched = prepared.value.dispatchNow(
        admitted.value.permit,
        (input, observer) => {
          processSignal = input.resourceSignal
          const capturedAt = processScopeClock.nowMs()
          const remainingMs = () =>
            input.resourceRemainingMs === null
              ? null
              : Math.max(
                  0,
                  input.resourceRemainingMs -
                    (processScopeClock.nowMs() - capturedAt),
                )
          const child = attach(
            (params.spawn ?? defaultSpawnSeam)({
              ...spawnRequest,
              cmd: [input.executable, ...input.argv],
              env: { ...input.env },
              cwd: input.cwd,
              observer,
              detached: input.adapterOptions.detached === true,
            }),
            scopeId,
            {
              originalDeadline: input.deadlines.resourceLifetime,
              remainingMs,
              launchFacts: () => prepared.value.facts(),
              onStop: () => { observer.cleanupCommitted() },
            },
          )
          if (!params.spawn) {
            const pid = child.pid
            if (!Number.isSafeInteger(pid) || (pid ?? -1) <= 0) {
              observer.failure({
                source: 'adapter-observation-error',
                cause: 'Bun child has no valid runtime PID',
              })
              throw new Error('Bun child has no valid runtime PID')
            }
            const observed = observer.spawnObserved({
              source: 'bun-spawn-result',
              pid: pid!,
            })
            if (!observed.ok) throw new Error(observed.cause)
          }
          return child
        },
      )
      if (!dispatched.ok) {
        const cleanup = scope
          ? await scope.requestStop('adapter-error', true)
          : undefined
        return crashResult('spawn_failed', exitCode, {
          ...(cleanup ? { cleanup } : {}),
          ...(dispatched.reason === 'dispatch-failed'
            ? {}
            : { executionRefusal: dispatched }),
        })
      }
    } else attach((params.spawn ?? defaultSpawnSeam)(spawnRequest), scopeId)
  } catch {
    const cleanup = scope
      ? await scope.requestStop('adapter-error', true)
      : undefined
    return crashResult(
      'spawn_failed',
      exitCode,
      cleanup ? { cleanup } : undefined,
    )
  }

  const scheduleAbsolute = (
    expiresAtMs: number,
    setTimer: (timer: ReturnType<typeof setTimeout>) => void,
  ) => {
    const arm = () => {
      const remaining = expiresAtMs - processScopeClock.nowMs()
      const timer = setTimeout(
        () => {
          if (stopCommitted) return
          if (processScopeClock.nowMs() >= expiresAtMs) commitKill()
          else arm()
        },
        Math.max(1, Math.min(2_147_483_647, Math.ceil(remaining))),
      )
      setTimer(timer)
    }
    arm()
  }
  if (!stopCommitted) {
    if (idleWindowMs !== undefined) armIdle()
    else if (timeoutMs !== undefined)
      scheduleAbsolute(startedClockAt + timeoutMs, (timer) => {
        termTimer = timer
      })
    if (maximumLifetimeMs !== undefined)
      scheduleAbsolute(startedClockAt + maximumLifetimeMs, (timer) => {
        maxTimer = timer
      })
    try {
      unsubscribeActivity = params.onActivity?.(markActivity)
    } catch {
      captureError()
    }
    if (processSignal?.aborted) onParentAbort()
    else processSignal?.addEventListener('abort', onParentAbort, { once: true })
  }

  // This promise resolves at the scope's bounded physical cleanup result,
  // even when exited/EOF never arrives. The scope retains failed authority.
  const cleanup = await cleanupFinished
  const [stdoutCapture, stderrCapture] = await Promise.all([
    stdoutPromise!,
    stderrPromise!,
  ])
  clearTimers()
  const base = {
    exitCode,
    durationMs: now() - startedAt,
    stdoutBytes: stdoutCapture.totalBytes,
    killed,
    stderrTail: new TextDecoder().decode(stderrCapture.bytes),
    cleanup,
  }
  const crashReason: SettleCrashReason | undefined = timedOut
    ? 'timeout'
    : captureFailed ||
        stdoutCapture.failed ||
        stderrCapture.failed ||
        cleanup.status !== 'complete'
      ? 'internal_error'
      : exitCode === null || exitCode !== 0 || processSignal?.aborted
        ? 'nonzero_exit'
        : undefined
  if (crashReason !== undefined) return crashResult(crashReason, exitCode, base)

  const text = new TextDecoder().decode(stdoutCapture.bytes)
  const lines = text.split('\n')
  if (text.length > 0 && !text.endsWith('\n')) lines.pop()
  const lastLine = [...lines].reverse().find((line) => line.trim().length > 0)
  if (lastLine === undefined) {
    if (stdoutCapture.totalBytes === 0)
      return { outcome: 'missing_output', ...base }
    return {
      outcome: 'schema_invalid',
      schemaError: 'child stdout had bytes but no newline-terminated JSON line',
      ...base,
    }
  }
  let parsed: { receipt: AgentReceipt } | { error: string }
  try {
    const candidate = agentReceiptSchema.safeParse(JSON.parse(lastLine))
    parsed = candidate.success
      ? { receipt: candidate.data }
      : { error: formatValidationIssues({ issues: candidate.error.issues }) }
  } catch (error) {
    parsed = { error: error instanceof Error ? error.message : String(error) }
  }
  if ('error' in parsed)
    return { outcome: 'schema_invalid', schemaError: parsed.error, ...base }
  if (stdoutCapture.totalBytes > SETTLE_STDOUT_CAP_BYTES) {
    return { outcome: 'truncated', receipt: parsed.receipt, ...base }
  }
  return { outcome: 'ok', receipt: parsed.receipt, ...base }
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
   * Explicit pass-through of the closed runtime key universe
   * {@link SUPERVISED_CHILD_RUNTIME_ENV_KEYS}: the provider-config endpoint
   * override (`OPENBUFF_PROVIDER_CONFIG` — the provider layer resolves every
   * baseURL/apiKeyEnv from the config file it points to), proxy configuration
   * (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` in both cases), `TMPDIR`, the
   * locale set (`LANG`/`LC_ALL`/`LC_CTYPE`), and the ripgrep override
   * `CODEBUFF_RG_PATH`. Only keys in the universe are honored, and only
   * values the caller seeded explicitly are forwarded — never ambient env
   * wholesale.
   */
  passthroughEnv?: Partial<
    Record<(typeof SUPERVISED_CHILD_RUNTIME_ENV_KEYS)[number], string>
  >
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

/**
 * Re-exported for the supervision test suite; the list itself lives in
 * ./supervised-child-env-keys (a leaf module with no imports) so the SDK
 * seam can enumerate it WITHOUT evaluating this module — supervised-spawn.ts
 * deliberately keeps the supervisor (and the receipt-schema imports it
 * pulls) lazy behind its dynamic import.
 */
export { SUPERVISED_CHILD_RUNTIME_ENV_KEYS }

/** Exact env allowlist for a supervised child; asserted by tests. */
export const SUPERVISED_CHILD_ENV_ALLOWLIST = [
  'OPENBUFF_API_KEY',
  BYOK_OPENROUTER_ENV_VAR,
  CHATGPT_OAUTH_TOKEN_ENV_VAR,
  OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR,
  'NODE_ENV',
  'PATH',
  'HOME',
  ...SUPERVISED_CHILD_RUNTIME_ENV_KEYS,
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
  // Runtime pass-through: only the closed key universe is honored, and only
  // values the caller seeded explicitly — never ambient env keys.
  for (const key of SUPERVISED_CHILD_RUNTIME_ENV_KEYS) {
    const value = seed.passthroughEnv?.[key]
    if (value) env[key] = value
  }
  return env
}

// P2-T8: `SupervisedSpawnRequest` is the seam contract from common,
// re-exported above. Scope note: the flag applies at the `executeSubagent`
// choke point, so it covers spawn-agents background + foreground,
// spawn-agent-inline, AND the two programmatic call sites
// (util/context-consolidation-runner.ts, util/runtime-semantic-compaction.ts)
// — one gate, no second flag.
