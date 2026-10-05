/**
 * P2-T8 adoption slice: parent-side default seam for flag-gated process
 * supervision.
 *
 * `buildDefaultSpawnSupervised` returns the `spawnSupervised` seam wired to
 * `spawnSettledSubagent` (process-supervisor.ts) + the child entrypoint
 * (child-entry.ts):
 *  - the JSON-serialized `SupervisedSpawnRequest` is persisted to a 0o600
 *    file INSIDE the 0700 mkdtemp sandbox dir (never the shared tmpdir
 *    root); its path is the child's only argv (stdin is 'ignore' in the
 *    supervisor);
 *  - the child env is EXACTLY `buildSupervisedChildEnv(seed)` — ambient env
 *    keys are never forwarded; the seed is supplied by the caller (the SDK
 *    impl seam, the only place ambient `process.env` may be read for this
 *    feature);
 *  - the child cwd is a fresh EMPTY temp dir so the child runtime cannot
 *    auto-load a repo `.env` on top of the allowlist;
 *  - the request file and the sandbox dir are removed after settle.
 *
 * DEFAULTS: `timeoutMs` defaults to the supervisor's 10-minute deadline
 * (SETTLE_DEFAULT_TIMEOUT_MS) — supervised spawns gain a wall-clock deadline
 * in-process spawns do not have; callers override via the request's
 * `timeoutMs`. NOTE: on timeout the supervisor tears down the child's WHOLE
 * process group (the default seam spawns the child as a group leader via
 * `detached: true`, and SIGTERM/SIGKILL go to the group by negative-pid
 * kill), so shell grandchildren die too; only custom seams without a
 * `killGroup` fall back to the direct-pid kill.
 *
 * P2-T8b RPC BRIDGE (optional `handlers` param): when a parent handler table
 * is supplied, the seam starts a parent-bridge-server on a Unix socket INSIDE
 * the 0700 mkdtemp sandbox (`rpc.sock`), awaits its readiness BEFORE spawning
 * the child, passes the socket path to the child via the additive
 * `rpcSocketPath` request field, and ALWAYS closes the server in the finally
 * block (also when the spawn throws). The socket file lives inside the
 * sandbox and is removed with it. Without handlers the seam keeps today's
 * exact behavior: no socket is created, no `rpcSocketPath` is added to the
 * request, and the child stays on the honest 'unsupported-deps' path.
 *
 * The supervisor module itself is loaded LAZILY: the static import above is
 * TYPE-ONLY (erased at compile time, so it never evaluates the module), and
 * the only runtime load path is the dynamic import inside the returned seam
 * — the flag-off hot path never touches the supervisor module (nor the
 * common schema imports it pulls in). The bridge server module is loaded
 * lazily the same way: only when a handler table was actually supplied. The
 * handler table itself may be supplied as a THUNK
 * ({@link ParentBridgeHandlersSource}), which is how the SDK composition root
 * avoids statically importing parent-bridge-server.ts at all — the table
 * construction (and the bridge module it pulls: node:net,
 * zod-from-json-schema) is evaluated only on the flag-on spawn path.
 *
 * P2-T8c RESTART POLICY (optional third `options` argument): when
 * `options.restart` is supplied, a RESTARTABLE crash — `outcome ===
 * 'crashed'` whose `crashReason` is a transport-level failure
 * ('spawn_failed', 'internal_error', or 'nonzero_exit' WITHOUT a valid
 * receipt envelope) — triggers a bounded number of FULL-seam restarts with
 * exponential backoff: each restart sleeps
 * `backoffMs * backoffMultiplier ** (attempt - 1)` (defaults 250ms, ×2),
 * fires the optional `onRestart({ attempt, crashReason })` observer with the
 * 1-based restart number and the PREVIOUS attempt's crash reason, then
 * re-runs the WHOLE seam body with the SAME original request — a FRESH
 * mkdtemp sandbox, a FRESH bridge server on a FRESH socket, a FRESH request
 * file. The finally (bridge close + sandbox removal) runs PER ATTEMPT, never
 * once overall. Once `maxAttempts` restarts are exhausted, the LAST settled
 * result is returned unchanged (it already carries the crash reason). NOT
 * restartable — the loop ends immediately and the settled result is returned
 * as-is:
 *  - `timeout`: the wall-clock deadline is authoritative; restarting would
 *    double the time budget,
 *  - `nonzero_exit` WITH a valid receipt envelope
 *    (`result.receipt !== undefined`): an agent-level failure, not a
 *    transport crash,
 *  - a free-form `crashReason` (e.g. the non-JSON-serializable request
 *    crash below): a deterministic input bug retrying cannot fix,
 *  - every non-crashed outcome (ok / missing_output / schema_invalid /
 *    truncated).
 *
 * Honest budget note: each attempt receives a FRESH full
 * `request.timeoutMs` deadline — the restart policy multiplies the
 * worst-case wall-clock spend (up to maxAttempts + 1 full deadlines); it
 * does NOT share or shave one deadline across attempts. Child-crash state
 * note: the child may have partially applied work before crashing, but tool
 * handlers execute PARENT-side atomically via the SDK mutation broker — the
 * broker's journal guarantees no partial commits, so a crashed child cannot
 * leave half-applied file edits behind.
 *
 * Guardrails: `maxAttempts` is REQUIRED (no default — callers opt into the
 * bound explicitly, so nobody gets silent unbounded retries) and must be a
 * finite number >= 0; 0 makes the policy inert (single spawn, zero
 * restarts), and invalid values degrade to 0 rather than retrying
 * unboundedly. `backoffMs` / `backoffMultiplier` clamp to their defaults
 * when non-finite or negative. The backoff sleep is injectable for
 * fault-injection tests via the TEST-ONLY `options._scheduleRestart`
 * (default: a plain `setTimeout`-backed sleep).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  SettledSubagentResult,
  SupervisedRestartPolicy,
} from '@codebuff/common/types/contracts/agent-runtime'
import type {
  SpawnSettledSubagentParams,
  SupervisedChildEnvSeed,
  SupervisedSpawnRequest,
} from './process-supervisor'
import type {
  ParentBridgeHandlers,
  ParentBridgeServer,
  SupervisedBridgeHandlerTable,
} from './parent-bridge-server'

/**
 * P2-T8c: the restart policy CONTRACT is declared in common's
 * dependency-free agent-runtime contracts and merely re-exported here, so
 * callers typing a policy against this seam never need a second import
 * site.
 */
export type {
  SupervisedRestartPolicy,
} from '@codebuff/common/types/contracts/agent-runtime'

/** The seam `SubagentContextParams.spawnSupervised` expects. */
export type SpawnSupervisedFn = (
  request: SupervisedSpawnRequest,
) => Promise<SettledSubagentResult>

/**
 * The parent-side RPC handler table, supplied either directly or as a THUNK.
 * The thunk form lets a composition root (sdk/src/impl/agent-runtime.ts)
 * defer the construction of the table — and the static import of
 * parent-bridge-server.ts it would otherwise require — until the flag-on
 * spawn path actually runs; the flag-off hot path then never evaluates (or
 * even module-loads) the bridge.
 */
export type ParentBridgeHandlersSource =
  | ParentBridgeHandlers
  | (() => ParentBridgeHandlers | Promise<ParentBridgeHandlers>)

/**
 * P2-T8c: additive third-parameter options for
 * {@link buildDefaultSpawnSupervised}. Everything is optional; when
 * `restart` is omitted the seam keeps its single-spawn behavior byte for
 * byte (one spawn, no sleeps, no restart bookkeeping, no wrapper).
 */
export interface SupervisedSpawnOptions {
  /**
   * Opt-in restart policy (P2-T8c) — the contract is
   * {@link SupervisedRestartPolicy} in common's dependency-free agent-runtime
   * contracts, re-exported from this module. See that type for what counts
   * as a restartable crash; on a restartable crash the seam re-runs the
   * WHOLE body (fresh sandbox / socket / request file) with the SAME
   * original request and returns the LAST settled result once the budget is
   * exhausted.
   */
  restart?: SupervisedRestartPolicy
  /**
   * P2-T8c, TEST-ONLY: injectable restart-backoff sleep, awaited with the
   * computed delay between a restartable crash and the next attempt so a
   * fault-injection test can prove bounded exponential backoff without real
   * wall-clock waits. Defaults to a plain `setTimeout`-backed sleep (the
   * Bun.sleep equivalent). Production callers must not pass it.
   */
  _scheduleRestart?: (delayMs: number) => Promise<void>
  /**
   * P2-T8c, TEST-ONLY: injectable replacement for the dynamically imported
   * `spawnSettledSubagent` (process-supervisor.ts), used by a
   * fault-injection test to drive the per-attempt settled-outcome SEQUENCE
   * without spawning a real child process. Defaults to the real dynamically
   * imported `spawnSettledSubagent`; production callers must not pass it, and
   * when absent the per-attempt body is byte-identical to today.
   */
  _spawnSettledSubagent?: (
    params: SpawnSettledSubagentParams,
  ) => Promise<SettledSubagentResult>
}

/** P2-T8c defaults: the FIRST restart waits 250ms, growing ×2 per restart. */
const RESTART_DEFAULT_BACKOFF_MS = 250
const RESTART_DEFAULT_BACKOFF_MULTIPLIER = 2

/**
 * P2-T8c: the ONLY crash reasons a restart can plausibly fix — the
 * transport-level crash names the supervisor settles with: `spawn_failed`
 * (the child never started), `internal_error` (the parent-side transport/
 * bridge machinery), and `nonzero_exit` WITHOUT a receipt envelope (the
 * child process died before settling an agent-level result). Everything
 * else settles as-is: `timeout` (the wall-clock deadline is authoritative —
 * restarting would double the budget), any free-form `crashReason` (e.g.
 * the non-JSON-serializable request crash — a deterministic input bug),
 * `nonzero_exit` WITH a receipt (an agent-level, settled failure), and
 * every non-crashed outcome.
 */
const RESTARTABLE_CRASH_REASONS: ReadonlySet<string> = new Set([
  'spawn_failed',
  'internal_error',
  'nonzero_exit',
])

/**
 * The caller policy with contract-optional members resolved to their
 * defaults — or `undefined` when the policy is ABSENT or INERT (effective
 * maxAttempts 0), in which case the seam returns its single-attempt closure
 * directly.
 */
interface NormalizedRestartPolicy {
  maxAttempts: number
  backoffMs: number
  backoffMultiplier: number
  onRestart?: (info: { attempt: number; crashReason: string }) => void
}

/**
 * P2-T8c: normalize + guard the caller-supplied policy. Fail-closed: a
 * missing, non-finite, or negative `maxAttempts` degrades to 0 (policy
 * inert — a single spawn, NEVER unbounded retries), fractional attempts
 * floor, and non-finite / negative backoff scalars clamp to their defaults.
 */
function normalizeRestartPolicy(
  policy: SupervisedRestartPolicy | undefined,
): NormalizedRestartPolicy | undefined {
  if (policy === undefined || typeof policy !== 'object') {
    return undefined
  }
  const rawMaxAttempts: unknown = policy.maxAttempts
  const maxAttempts =
    typeof rawMaxAttempts === 'number' &&
    Number.isFinite(rawMaxAttempts) &&
    rawMaxAttempts >= 0
      ? Math.floor(rawMaxAttempts)
      : 0
  if (maxAttempts === 0) {
    // maxAttempts 0: policy inert — identical behavior to omitting restart.
    return undefined
  }
  return {
    maxAttempts,
    backoffMs: clampBackoffScalar(
      policy.backoffMs,
      RESTART_DEFAULT_BACKOFF_MS,
    ),
    backoffMultiplier: clampBackoffScalar(
      policy.backoffMultiplier,
      RESTART_DEFAULT_BACKOFF_MULTIPLIER,
    ),
    onRestart:
      typeof policy.onRestart === 'function' ? policy.onRestart : undefined,
  }
}

/** Guards one backoff scalar against non-finite / negative junk (→ default). */
function clampBackoffScalar(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback
  }
  return value
}

/**
 * P2-T8c: wall-clock delay before the `attempt`-th restart (1-based):
 * `backoffMs * backoffMultiplier ** (attempt - 1)` — the FIRST restart
 * waits exactly `backoffMs`. Capped at Number.MAX_SAFE_INTEGER because
 * `setTimeout(Infinity)` fires IMMEDIATELY (a huge multiplier blowing past
 * the safe range would silently drop the backoff; the attempt bound, not
 * the delay, is what bounds total wall-clock cost).
 */
function computeRestartDelayMs(
  policy: NormalizedRestartPolicy,
  attempt: number,
): number {
  const rawDelay = policy.backoffMs * policy.backoffMultiplier ** (attempt - 1)
  if (!Number.isFinite(rawDelay) || rawDelay > Number.MAX_SAFE_INTEGER) {
    return Number.MAX_SAFE_INTEGER
  }
  return Math.max(0, rawDelay)
}

/**
 * P2-T8c: the DEFAULT restart-backoff sleep — a plain wall-clock
 * `setTimeout` wait (the `await Bun.sleep(delayMs)` equivalent); replaced
 * by the test-only `options._scheduleRestart` in fault-injection tests.
 */
const defaultRestartSleeper = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })

/**
 * P2-T8c: a settled result is RESTARTABLE only when it is a TRANSPORT-level
 * crash: `outcome === 'crashed'`, NO valid receipt envelope (an envelope
 * means the agent settled real work — that failure is agent-level, not a
 * transport crash a respawn could fix), and a `crashReason` in
 * {@link RESTARTABLE_CRASH_REASONS}. The predicate narrows `crashReason`
 * to string so the restart loop can report it without a cast.
 */
function isRestartableCrash(
  result: SettledSubagentResult,
): result is SettledSubagentResult & { crashReason: string } {
  if (result.outcome !== 'crashed') {
    return false
  }
  if (result.receipt !== undefined) {
    return false
  }
  return (
    typeof result.crashReason === 'string' &&
    RESTARTABLE_CRASH_REASONS.has(result.crashReason)
  )
}

/**
 * Builds the default supervised-spawn seam. `seed` is the env allowlist
 * source — pass the explicitly-resolved credential values (never a wholesale
 * ambient env copy).
 *
 * P2-T8b: `handlers` optionally supplies the parent-side RPC handler table
 * (built by `buildSupervisedBridgeHandlers` in
 * supervision/parent-bridge-server.ts from the deps available at the SDK
 * seam), directly or as a lazily-evaluated thunk (see
 * {@link ParentBridgeHandlersSource}). When present, a bridge server is
 * started on a Unix socket INSIDE the sandbox before the child is spawned,
 * `rpcSocketPath` is added to the serialized request, and the server is
 * ALWAYS closed in the finally block.
 *
 * P2-T8c: `options` additionally carries the opt-in restart policy
 * ({@link SupervisedSpawnOptions.restart}) and the test-only backoff seeder
 * ({@link SupervisedSpawnOptions._scheduleRestart}); see the module
 * docblock's P2-T8c section. Omitting `options` (or `options.restart`)
 * preserves today's exact single-spawn behavior.
 */
export function buildDefaultSpawnSupervised(
  seed: SupervisedChildEnvSeed = {},
  handlers?: ParentBridgeHandlersSource,
  options?: SupervisedSpawnOptions,
): SpawnSupervisedFn {
  // P2-T8c: ONE full seam attempt — lazy supervisor load, fresh 0700
  // mkdtemp sandbox, (optional) bridge server on a fresh socket, fresh
  // request file, spawn + settle — with ALL of its finally cleanup (bridge
  // close + sandbox removal) running PER ATTEMPT, so a restart re-acquires a
  // fresh sandbox/socket/request file and can never reuse (or leak) an
  // earlier attempt's. This closure alone IS the flags-off seam.
  const runSettledAttempt = async (
    request: SupervisedSpawnRequest,
  ): Promise<SettledSubagentResult> => {
    // Lazy on purpose: the supervisor module (Bun.spawn, the receipt schema
    // imports it pulls, and the env allowlist builder included) is evaluated
    // only when the flag is actually on — this dynamic import is the
    // module's ONLY runtime load path from here.
    const { spawnSettledSubagent, buildSupervisedChildEnv } = await import(
      './process-supervisor'
    )
    // Empty sandbox cwd: the child runtime auto-loads `.env` from its cwd,
    // which would leak repo env keys past the spawn allowlist.
    const sandboxCwd = mkdtempSync(join(tmpdir(), 'openbuff-supervised-cwd-'))
    const requestPath = join(sandboxCwd, 'openbuff-supervised-request.json')
    // P2-T8b: the bridge socket lives INSIDE the 0700 sandbox (owner-only,
    // per-spawn ephemeral — removed with the sandbox below), so no extra
    // auth token is needed. The server starts BEFORE the child is spawned
    // and is closed in the finally below, also when the spawn throws.
    let bridge: ParentBridgeServer | undefined
    // P2-T8b: the bridge socket lives INSIDE the 0700 sandbox (owner-only,
    // per-spawn ephemeral — removed with the sandbox below), so no extra
    // auth token is needed. The server starts BEFORE the child is spawned
    // and is closed in the finally below, also when the spawn throws.
    let socketPath: string | undefined
    // P2-T8b collision-proof bridge sentinel: the per-table marker nonce
    // minted by buildSupervisedBridgeHandlers, stamped into the request
    // envelope below so the child sanitizer emits nonce-stamped markers the
    // parent recognizes on an EXACT match only (see bridge-protocol.ts).
    let bridgeNonce: string | undefined
    try {
      if (handlers) {
        // Lazy like the supervisor: the bridge module (node:net) is loaded
        // only when a handler table was actually supplied — and with the
        // thunk form the table itself is built only here, on the flag-on
        // spawn path, so the composition root needs no static
        // parent-bridge-server import at all.
        const { startParentBridgeServer } = await import(
          './parent-bridge-server'
        )
        const table =
          typeof handlers === 'function' ? await handlers() : handlers
        // A table built by buildSupervisedBridgeHandlers carries the
        // per-table marker nonce; stamp it into the request envelope so the
        // child sanitizer emits nonce-stamped markers. A RAW handler table
        // (no bridgeNonce) leaves the request without one: markers cross the
        // bridge as data, exactly like agent-authored values.
        const tableNonce = (
          table as Partial<SupervisedBridgeHandlerTable>
        ).bridgeNonce
        if (typeof tableNonce === 'string' && tableNonce.length > 0) {
          bridgeNonce = tableNonce
        }
        socketPath = join(sandboxCwd, 'rpc.sock')
        bridge = startParentBridgeServer(table, socketPath)
        await bridge.ready
      }
      const wireRequest =
        bridge && socketPath
          ? {
              ...request,
              rpcSocketPath: socketPath,
              ...(bridgeNonce ? { rpcBridgeNonce: bridgeNonce } : {}),
            }
          : request
      // The request file carries the user prompt, the child systemPrompt, and
      // child agent state, so it is written INSIDE the 0700 mkdtemp sandbox
      // (never the shared tmpdir root) with mode 0o600 — only the owning user
      // can read it for the spawn's duration.
      // A non-JSON-serializable request (e.g. a circular child-state field)
      // must settle a structured 'crashed' result exactly like any other
      // spawn failure — never an uncaught throw across the spawnSupervised
      // seam (the in-process path cannot throw here).
      // P2-T8c: this crash is intentionally NON-restartable — its
      // crashReason is free-form (a deterministic input bug in the caller's
      // request), so respawning with the same request could never fix it.
      let serializedRequest: string
      try {
        serializedRequest = JSON.stringify(wireRequest)
      } catch (error) {
        return {
          outcome: 'crashed',
          crashReason: `supervised request is not JSON-serializable: ${
            error instanceof Error ? error.message : String(error)
          }`,
          exitCode: null,
          durationMs: 0,
          stdoutBytes: 0,
          killed: false,
          stderrTail: '',
        }
      }
      // P2-T8c TEST-ONLY: a fault-injection test may inject the spawn via
      // options._spawnSettledSubagent; production uses the dynamically
      // imported real one (byte-identical when the hook is absent).
      const spawnSettled =
        options?._spawnSettledSubagent ?? spawnSettledSubagent
      writeFileSync(requestPath, serializedRequest, { mode: 0o600 })
      return await spawnSettled({
        childModulePath: join(
          dirname(fileURLToPath(import.meta.url)),
          'child-entry.ts',
        ),
        args: [requestPath],
        env: buildSupervisedChildEnv(seed),
        cwd: sandboxCwd,
        timeoutMs: request.timeoutMs,
      })
    } finally {
      // Close the bridge server unconditionally — success, spawn throw, or
      // bridge-start failure alike. Pending in-flight handlers are killed
      // with the typed BridgeClosedError; an in-flight promptAiSdkStream
      // collector first cancels its underlying provider iterator (abort the
      // rehydrated signal + `iterator.return()` — see
      // SupervisedBridgeHandlerTable.cancelInFlightStreams) so a killed
      // stream stops consuming the provider stream with no consumer; the
      // socket file is unlinked.
      if (bridge) {
        await bridge.close()
      }
      // The request file lives inside the sandbox, so the recursive sandbox
      // removal cleans up both.
      rmSync(sandboxCwd, { recursive: true, force: true })
    }
  }

  // P2-T8c: the restart policy is OPT-IN — when `restart` is absent, or
  // inert after normalization (invalid or explicit maxAttempts 0), the
  // single-attempt closure IS the seam: one spawn, no sleeps, no loop, no
  // wrapper overhead — byte-identical to the pre-P2-T8c behavior.
  const policy = normalizeRestartPolicy(options?.restart)
  if (!policy) {
    return runSettledAttempt
  }

  // Test-injectable backoff sleep (see SupervisedSpawnOptions._scheduleRestart).
  const scheduleRestart =
    typeof options?._scheduleRestart === 'function'
      ? options._scheduleRestart
      : defaultRestartSleeper

  // P2-T8c bounded RESTART loop. attemptNumber counts RESTARTS, 1-based:
  // maxAttempts 0 never reaches this loop (inert policies normalize away),
  // and maxAttempts 2 means up to 3 total spawns. Per restart, in order:
  // (1) sleep `backoffMs * backoffMultiplier ** (attemptNumber - 1)` — the
  // backoff happens BEFORE the next attempt, so the final crash within the
  // budget settles with no trailing sleep; (2) fire the optional
  // onRestart({ attempt, crashReason }) observer with the previous crash;
  // (3) re-run the WHOLE seam body with the SAME original request. Any
  // result that is not a restartable crash (or an exhausted budget) returns
  // the LAST settled result UNCHANGED — it already carries the crash
  // reason. An attempt that THROWS (e.g. a failed bridge bind) is not a
  // crash: the rejection propagates exactly as in the flags-off seam.
  return async (request) => {
    let result = await runSettledAttempt(request)
    let attemptNumber = 0
    while (attemptNumber < policy.maxAttempts && isRestartableCrash(result)) {
      attemptNumber += 1
      await scheduleRestart(computeRestartDelayMs(policy, attemptNumber))
      policy.onRestart?.({
        attempt: attemptNumber,
        crashReason: result.crashReason,
      })
      result = await runSettledAttempt(request)
    }
    return result
  }
}
