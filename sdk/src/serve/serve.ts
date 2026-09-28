import { createServeBridge } from './bridge'
import { serveAcpOverSocket } from './socket-listener'
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
  /** Transport selection: stdio (default) or a unix domain socket. NO TCP. */
  transport:
    | { kind: 'stdio' }
    | { kind: 'socket'; socketPath: string; token: string }
  /** Optional structured logger forwarded into the bridge. */
  logger?: Logger
  /** Aborts the socket transport (ignored by stdio, whose lifetime is the process). */
  signal?: AbortSignal
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
  const { promptHandler } = createServeBridge({
    client,
    sessionData,
    logger,
    agentId,
  })

  if (transport.kind === 'stdio') {
    // serveAcpOverStdio applies resolveAcpServeOptions internally (confirmed in
    // acp-agent.ts), so the journal-backed session/load restore is wired.
    serveAcpOverStdio({ promptHandler, sessionData })
    return { close: async () => {} }
  }

  return serveAcpOverSocket({
    promptHandler,
    sessionData,
    socketPath: transport.socketPath,
    token: transport.token,
    signal,
  })
}
