import { markAllMCPConfigOrigins } from '@codebuff/common/mcp/client'

import { sanitizeOutbound } from './outbound-filter'

import type { AcpPromptHandler } from '../services/acp/acp-agent'
import type { AcpSessionData } from '../services/acp/session-data'
import type {
  FilesystemMutationEvent,
  OpenbuffClientOptions,
  RunOptions,
} from '../run'
import type { RunState } from '../run-state'
import type { McpServer } from '@agentclientprotocol/sdk'
import type { MCPConfig } from '@codebuff/common/types/mcp'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

/**
 * The structural slice of `OpenbuffClient` the bridge needs: just `.run`. The
 * production `openbuff serve` CLI (a LATER wave) passes a real
 * `OpenbuffClient`; unit tests pass a fake whose `.run` invokes the supplied
 * `handleEvent`/`onFilesystemMutation` and resolves a `RunState`. Typed as the
 * exact production run signature so a real client is assignable without a cast.
 */
export type ServeBridgeClient = {
  run: (runOptions: RunOptions & OpenbuffClientOptions) => Promise<RunState>
}

export type ServeBridgeOptions = {
  /** Structurally-typed run seam (see {@link ServeBridgeClient}). */
  client: ServeBridgeClient
  /**
   * The LIVE per-session store the ACP extension methods
   * (`openbuff/getReceipts`, `openbuff/gateState`) read. The bridge records
   * confirmed receipts and published gate-state here as the turn streams.
   */
  sessionData: AcpSessionData
  /**
   * Which Openbuff agent each prompt turn runs. Defaults to `'base'`.
   */
  agentId?: string
  /**
   * Lets the host mark which MCP servers the client advertised as untrusted
   * ('client' origin) at ingest, so any such server the host later attaches to
   * a run is already treated as untrusted by the run loop's per-tool approval
   * gate and SSRF guard. Everything reaches the bridge via options — this layer
   * never reads `process.env`. The bridge marks and forwards the servers here;
   * the core RunOptions has no mcpServers param, so attaching them is the
   * host's job.
   */
  markClientMcpServers?: (mcpServers: Record<string, MCPConfig>) => void
  /** Optional structured logger forwarded by the host; unused in Wave-1 core. */
  logger?: Logger
}

/**
 * The seam the `openbuff serve` CLI (LATER wave) instantiates: it binds the
 * ACP `AcpPromptHandler` to the real `OpenbuffClient.run()` loop and feeds the
 * live `AcpSessionData` store the read-only ACP extension methods serve.
 *
 * Security posture (P1-T1-DESIGN §12.1 SEC-1):
 * - The bridge NEVER forwards `tool_call`/`tool_result` events or raw tool
 *   output to the client — those are structurally DROPPED. Only model-visible
 *   assistant text (`PrintModeEvent` of type `'text'`) is forwarded, and when
 *   unsure whether an event carries such text the bridge DROPS it.
 * - Every forwarded chunk passes through {@link sanitizeOutbound} before it
 *   crosses the ACP wire, so a cap.v3 token or provider secret that slipped
 *   into assistant text is redacted as a last line of defense.
 * - Confirmed filesystem mutations and published `<gate-state>` blocks are
 *   recorded into the injected LIVE store, which is exactly what the ACP
 *   extension methods project back to the client.
 *
 * The bridge is transport-agnostic and free of process spawning: it only wires
 * callbacks. The CLI wave supplies the real client and the stdio transport.
 */
export function createServeBridge(options: ServeBridgeOptions): {
  promptHandler: AcpPromptHandler
  sessionData: AcpSessionData
} {
  const { client, sessionData } = options
  const agentId = options.agentId ?? 'base'

  const promptHandler: AcpPromptHandler = async (input) => {
    /**
     * Forwards ONLY model-visible assistant text. `tool_call`/`tool_result`
     * and every other variant are dropped (return without forwarding). The
     * raw text feeds gate-state parsing (a no-op when there is no block), and
     * the sanitized copy is what crosses the wire.
     */
    const handleEvent = async (event: PrintModeEvent): Promise<void> => {
      const text = extractForwardableText(event)
      if (text === undefined) return
      // Record any published gate-state block from the model-visible text; the
      // store's parser is a no-op when the chunk carries no block.
      sessionData.updateGateStateFromBlock(input.sessionId, text)
      await input.update(sanitizeOutbound(text))
    }

    // Ingest trust boundary (P1-T2 SEC): mark every client-advertised MCP
    // server 'client' origin BEFORE the run so any such server the host later
    // attaches is already untrusted for the run loop's per-tool approval gate
    // and SSRF guard. Marking is idempotent (an existing 'client' mark is never
    // upgraded), so re-marking across turns is safe. The core RunOptions has no
    // mcpServers param — the bridge ONLY marks them client-origin and hands
    // them to the host via markClientMcpServers; attaching them is the host's
    // job.
    if (
      options.markClientMcpServers &&
      Array.isArray(input.mcpServers) &&
      input.mcpServers.length > 0
    ) {
      const clientMcpServers = acpMcpServersToConfigRecord(input.mcpServers)
      markAllMCPConfigOrigins(clientMcpServers, 'client')
      options.markClientMcpServers(clientMcpServers)
    }

    await client.run({
      agent: agentId,
      prompt: input.promptText,
      handleEvent,
      onFilesystemMutation: (event: FilesystemMutationEvent) =>
        sessionData.recordReceiptFromMutationEvent(input.sessionId, event),
      signal: input.signal,
    })

    // A run that ended via the abort signal maps to 'cancelled'; a naturally
    // settled run is 'end_turn'.
    return { stopReason: input.signal.aborted ? 'cancelled' : 'end_turn' }
  }

  return { promptHandler, sessionData }
}

/**
 * Extracts the model-visible assistant text from a `PrintModeEvent`, or
 * `undefined` when the event carries none. Conservative by design: only the
 * `'text'` variant (the assistant message-text chunk) is forwardable. Every
 * other variant — including `tool_call`, `tool_result`, and reasoning deltas —
 * returns `undefined` so the caller drops it.
 */
function extractForwardableText(event: PrintModeEvent): string | undefined {
  if (event.type === 'text' && typeof event.text === 'string') {
    return event.text
  }
  return undefined
}

/**
 * Folds an ACP `{ name, value }[]` list (stdio `env` / remote `headers`) into
 * the `Record<string, string>` shape the core {@link MCPConfig} uses. Later
 * entries win on a duplicate name.
 */
function acpEntriesToRecord(
  entries: Array<{ name: string; value: string }>,
): Record<string, string> {
  // Null-prototype for the same reason as acpMcpServersToConfigRecord: an
  // attacker-controlled env/header name must never reach an inherited setter.
  const record: Record<string, string> = Object.create(null)
  for (const { name, value } of entries) {
    record[name] = value
  }
  return record
}

/**
 * Converts client-advertised ACP `McpServer[]` into the core
 * `Record<string, MCPConfig>` keyed by each server's `name`. Only the
 * transports the core {@link MCPConfig} union actually supports are emitted:
 * - `stdio` (the ACP variant with no `type` discriminant) → core stdio config,
 *   with `env` folded into a record;
 * - `http` / `sse` → core remote config, with `headers` folded into a record
 *   (`params` is empty — ACP advertises none);
 * - `acp` → SKIPPED: the core union has no ACP-transport equivalent.
 *
 * Pure and synchronous so it can run inline before the async `client.run`.
 * Unknown/empty inputs simply produce no entries.
 */
function acpMcpServersToConfigRecord(
  servers: McpServer[],
): Record<string, MCPConfig> {
  // Null-prototype so an attacker-controlled server name like '__proto__',
  // 'constructor', or 'prototype' becomes a plain own key instead of hitting
  // an inherited setter (which would silently drop the entry from
  // Object.values/entries and thus from the client-origin marking pass).
  const record: Record<string, MCPConfig> = Object.create(null)
  for (const server of servers) {
    if ('type' in server) {
      // http | sse | acp — the variants carrying the ACP `type` discriminant.
      if (server.type === 'http' || server.type === 'sse') {
        record[server.name] = {
          type: server.type,
          url: server.url,
          params: {},
          headers: acpEntriesToRecord(server.headers),
        }
      }
      // 'acp': skipped — no core equivalent transport.
      continue
    }
    // McpServerStdio is the only ACP variant without a `type` discriminant.
    record[server.name] = {
      type: 'stdio',
      command: server.command,
      args: [...server.args],
      env: acpEntriesToRecord(server.env),
    }
  }
  return record
}
