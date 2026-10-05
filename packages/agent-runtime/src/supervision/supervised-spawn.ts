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
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SettledSubagentResult } from '@codebuff/common/types/contracts/agent-runtime'
import type {
  SupervisedChildEnvSeed,
  SupervisedSpawnRequest,
} from './process-supervisor'
import type {
  ParentBridgeHandlers,
  ParentBridgeServer,
  SupervisedBridgeHandlerTable,
} from './parent-bridge-server'

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
 */
export function buildDefaultSpawnSupervised(
  seed: SupervisedChildEnvSeed = {},
  handlers?: ParentBridgeHandlersSource,
): SpawnSupervisedFn {
  return async (request) => {
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
      writeFileSync(requestPath, serializedRequest, { mode: 0o600 })
      return await spawnSettledSubagent({
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
}
