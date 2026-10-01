import { run } from '../run'

import type { OpenbuffClientOptions, RunOptions } from '../run'
import type { RunState } from '../run-state'

/**
 * Pluggable execution backend behind `OpenbuffClient.run()` (P1-T3).
 *
 * A backend owns WHERE a run executes: the default {@link InProcessBackend}
 * dispatches to the in-process agent runtime (today's `run()`), while
 * `AcpRemoteBackend` (./acp-client) drives a live `openbuff serve` process
 * over ACP. The seam is additive and optional: `OpenbuffClientOptions.backend`
 * defaults to the in-process backend, so every existing consumer keeps the
 * exact pre-seam behavior.
 *
 * The session lifecycle methods are OPTIONAL. A backend that supports
 * detach/reattach (the ACP-remote one) implements them; the in-process
 * backend has no remote session to detach from, so it does not.
 */
export interface ClientBackend {
  /**
   * Executes one run. Implementations receive the fully merged
   * `RunOptions & OpenbuffClientOptions` record (including `handleEvent` and
   * `signal`) and resolve a RunState-compatible result.
   */
  run(options: RunOptions & OpenbuffClientOptions): Promise<RunState>
  /**
   * Detaches from the live session WITHOUT cancelling the in-flight run: the
   * remote agent keeps working and the session id is returned so a later
   * {@link ClientBackend.attach} (or a fresh client) can reattach to it.
   * Returns `undefined` when there is no live session to detach from.
   */
  detach?(): Promise<string | undefined>
  /**
   * Reattaches to a previously detached live session via `session/load`.
   */
  attach?(sessionId: string): Promise<void>
  /**
   * Releases the underlying transport (socket/stdio). MUST be idempotent so
   * detach/reattach cycles and final teardown never leak a connection.
   */
  close?(): Promise<void>
}

/**
 * The default backend: byte-identical to today's behavior, delegating
 * straight to the in-process {@link run}. It deliberately implements no
 * detach/attach/close surface — there is no remote session or transport.
 */
export class InProcessBackend implements ClientBackend {
  run(options: RunOptions & OpenbuffClientOptions): Promise<RunState> {
    return run(
      options as RunOptions &
        OpenbuffClientOptions & { apiKey: string; fingerprintId: string },
    )
  }
}

/**
 * Resolves the effective backend for one merged options record: the injected
 * `backend` wins, otherwise the in-process default. Centralized so
 * `OpenbuffClient.run()` and `run()` can never diverge on the default.
 */
export function resolveClientBackend(
  options: OpenbuffClientOptions,
): ClientBackend {
  return options.backend ?? new InProcessBackend()
}
