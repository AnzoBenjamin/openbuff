import { createServeBridge } from './bridge'
import { serveAcpOverSocket } from './socket-listener'
import { collectCredentialValues } from './outbound'
import { serveAcpOverStdio } from '../services/acp/acp-agent'

import type { ServeBridgeClient } from './bridge'
import type { AcpSessionData } from '../services/acp/session-data'
import type { Logger } from '@codebuff/common/types/contracts/logger'

/**
 * Programmatic entry the `openbuff serve` CLI invokes. It wires the Wave-1
 * serve bridge (`createServeBridge`) to the chosen transport:
 *  - `stdio` (default): serves ACP over the process stdio streams; the
 *    transport's lifetime IS the process, so `close` is a no-op.
 *  - `socket`: serves ACP over a SEC-4-authenticated unix domain socket and
 *    returns that listener's real `close`.
 *
 * The CLI owns the pieces this layer never constructs: the real
 * `OpenbuffClient`, a journal-backed `AcpSessionData`, and the socket token.
 * They arrive through options — this layer never reads `process.env`.
 */
export type RunServeOptions = {
  /** Structurally-typed run seam bound to the real OpenbuffClient by the CLI. */
  client: ServeBridgeClient
  /** Live per-session store backing the read-only ACP extension methods. */
  sessionData: AcpSessionData
  /** Which Openbuff agent each prompt turn runs in the bridge. Defaults to 'base'. */
  agentId?: string
  /**
   * NEW-3 (§12.8): the environment the host runs with, consulted ONLY for
   * the configured credential env keys the streaming holdback must never
   * split. Collected with `collectCredentialValues` and handed to the serve
   * bridge as `credentialValues`; omitted → no value-level holdback (the
   * 256-char cap.v3 floor still applies). This layer never reads
   * `process.env` itself — the host passes the environment in.
   */
  credentialEnv?: Record<string, string | undefined>
  /** Transport selection: stdio (default) or a unix domain socket. NO TCP. */
  transport:
    | { kind: 'stdio' }
    | { kind: 'socket'; socketPath: string; token: string }
  /** Optional structured logger forwarded into the bridge. */
  logger?: Logger
  /** Aborts the socket transport (ignored by stdio, whose lifetime is the process). */
  signal?: AbortSignal
  /**
   * SEC-7 (§12.5) containment anchor: the project root `session/new` /
   * `session/load` cwd values must be absolute and inside (after symlink
   * dereference), enforced by `createAcpAgent` on BOTH transports. When
   * supplied, it is bound once at serve start and also threaded into the
   * serve bridge so `tool_call` locations resolve against it. When omitted,
   * runServe logs a warning through the injected logger and defaults the
   * containment root to `process.cwd()` — never silently permissive.
   */
  projectRoot?: string
  /**
   * SEC-7 allowlist for client-supplied `additionalDirectories` entries
   * (`--add-dir`), resolved to absolute form by the host. An entry not in
   * this list is rejected (-32602), never silently admitted.
   */
  allowedAdditionalDirectories?: string[]
  /**
   * GV-18 opt-in (additive, default false): when set, the SOCKET transport
   * accepts client-supplied `mcpServers` in `session/new` like stdio does.
   * Unset (the default) keeps client MCP servers DISABLED on the socket
   * transport — a session/new carrying mcpServers is rejected -32602 with
   * data['openbuff.dev'].code = 'client_mcp_disabled' before any process is
   * spawned. stdio is unaffected: it keeps today's permissive behavior.
   */
  allowClientMcp?: boolean
}

/**
 * Builds the serve bridge and starts the selected transport.
 *
 * @returns `{ close }` — a no-op for stdio (process-scoped), or the socket
 * listener's idempotent close for socket mode.
 */
export function runServe(options: RunServeOptions): {
  close: () => Promise<void>
} {
  const { client, sessionData, transport, logger, signal, agentId } = options
  // SEC-7 (audit HIGH #1): the containment decision is made EXACTLY ONCE,
  // here at serve start — never per connection (the socket transport resolves
  // paths late, so a per-connection decision could drift). An explicitly
  // supplied projectRoot binds the boundary; an omitted one fails LOUDLY (a
  // warning through the injected logger) and defaults to process.cwd()
  // instead of silently degrading to the pre-SEC-7 permissive posture.
  const containmentRoot = resolveServeContainmentRoot({
    projectRoot: options.projectRoot,
    logger,
  })
  const { promptHandler } = createServeBridge({
    client,
    sessionData,
    logger,
    agentId,
    // When the host supplied a project root, the bridge also resolves
    // `tool_call` locations against it; omitted keeps locations relative
    // (the bridge's own default), so only the containment boundary changes.
    projectRoot: options.projectRoot,
    // NEW-3 (§12.8): collect the configured credential VALUES from the
    // host-supplied environment so the streaming holdback can enforce the
    // no-split invariant for real credentials (an empty environment yields
    // the bridge's default empty list).
    credentialValues: collectCredentialValues(options.credentialEnv ?? {}),
  })
  // Both transports spread these into AcpAgentOptions, where createAcpAgent
  // enforces SEC-7 cwd containment and the additionalDirectories allowlist
  // on session/new and session/load.
  const containmentOptions = {
    projectRoot: containmentRoot,
    allowedAdditionalDirectories: options.allowedAdditionalDirectories,
  }

  if (transport.kind === 'stdio') {
    // serveAcpOverStdio applies resolveAcpServeOptions internally (confirmed in
    // acp-agent.ts), so the journal-backed session/load restore is wired.
    // stdio keeps the PERMISSIVE GV-18 posture: allowClientMcpServers is left
    // unset so client-supplied mcpServers are still accepted (the default).
    serveAcpOverStdio({ promptHandler, sessionData, ...containmentOptions })
    return { close: async () => {} }
  }

  // GV-18: the socket transport REFUSES client-supplied mcpServers unless
  // the host explicitly opted in with allowClientMcp.
  return serveAcpOverSocket({
    promptHandler,
    sessionData,
    socketPath: transport.socketPath,
    token: transport.token,
    signal,
    ...containmentOptions,
    allowClientMcpServers: options.allowClientMcp === true,
  })
}

/**
 * Resolves the SEC-7 containment root for one {@link runServe} call — the
 * decision is made exactly once, at serve start. An explicit `projectRoot`
 * binds the boundary to that root; an omitted one logs a warning through the
 * injected logger and defaults to `process.cwd()`, so containment is never
 * silently permissive.
 */
function resolveServeContainmentRoot(options: {
  projectRoot?: string
  logger?: Logger
}): string {
  if (options.projectRoot !== undefined) return options.projectRoot
  // No raw host paths in the payload: this warning may be shared, and the
  // codebase convention keeps raw paths out of shared logs.
  options.logger?.warn(
    {},
    'runServe: no projectRoot was supplied; defaulting the SEC-7 containment root to process.cwd(). Pass projectRoot explicitly to bind containment to the served project.',
  )
  return process.cwd()
}
