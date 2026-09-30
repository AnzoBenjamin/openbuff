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
import { printModeToSessionUpdates } from './event-bridge'

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
  /**
   * ACP event richness (P1-T2b, §4.2). `'acp'` (the default) keeps subagent
   * text, nested-run reasoning, and telemetry variants off the wire; `'full'`
   * enables subagent text and the `_openbuff.dev/event` ext notifications.
   */
  eventsMode?: 'acp' | 'full'
  /**
   * Seam for every non-text payload the §4.2 event bridge emits (tool_call,
   * tool_call_update, plan, usage_update, agent_thought_chunk) plus
   * `{ method, params }` `_openbuff.dev/event` ext notifications. When
   * absent, non-text payloads are dropped and the bridge keeps the Wave-1
   * text-only behavior. Emitting to the real ACP connection is a later wave;
   * this callback is the transport-free seam.
   */
  onSessionUpdate?: (payload: unknown) => void | Promise<void>
  /**
   * Absolute project root `tool_call` locations are resolved against. When
   * omitted, location paths stay relative instead of being silently resolved
   * against the process cwd.
   */
  projectRoot?: string
  /** Optional structured logger forwarded by the host; unused in Wave-1 core. */
  logger?: Logger
}

/**
 * The seam the `openbuff serve` CLI (LATER wave) instantiates: it binds the
 * ACP `AcpPromptHandler` to the real `OpenbuffClient.run()` loop and feeds the
 * live `AcpSessionData` store the read-only ACP extension methods serve.
 *
 * Security posture (P1-T1-DESIGN §12.1 SEC-1):
 * - By default (no `onSessionUpdate`), the bridge NEVER forwards
 *   `tool_call`/`tool_result` events or raw tool output to the client — those
 *   are structurally DROPPED. Only model-visible assistant text
 *   (`PrintModeEvent` of type `'text'`) is forwarded, and when unsure whether
 *   an event carries such text the bridge DROPS it.
 * - When the host supplies `onSessionUpdate` (P1-T2b), the §4.2-mapped tool
 *   cards, plan entries, usage updates, and `_openbuff.dev/event` ext
 *   notifications flow through that seam; `rawOutput` is still never emitted
 *   and tool results cross only as capped `content` text.
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
  const eventsMode = options.eventsMode ?? 'acp'
  const projectRoot = options.projectRoot ?? ''

  const promptHandler: AcpPromptHandler = async (input) => {
    /**
     * Maps every event through the §4.2 event bridge and forwards the
     * resulting payloads: `agent_message_chunk` text goes out via `update`
     * (sanitized), and every other payload goes to the optional
     * `onSessionUpdate` seam — dropped when the host did not supply it, which
     * reproduces the Wave-1 text-only behavior. The raw text feeds gate-state
     * parsing (a no-op when there is no block), and the sanitized copy is
     * what crosses the wire.
     */
    const handleEvent = async (event: PrintModeEvent): Promise<void> => {
      const payloads = printModeToSessionUpdates(event, {
        sessionId: input.sessionId,
        // The run id is not carried on the prompt-handler input yet; the CLI
        // wave supplies it, so `messageId` is omitted for now.
        runId: undefined,
        eventsMode,
        projectRoot,
        toolKind: acpToolKind,
      })
      for (const payload of payloads) {
        const text = extractForwardableText(payload)
        if (text === undefined) {
          await options.onSessionUpdate?.(payload)
          continue
        }
        // Record any published gate-state block from the model-visible text; the
        // store's parser is a no-op when the chunk carries no block.
        sessionData.updateGateStateFromBlock(input.sessionId, text)
        await input.update(sanitizeOutbound(text))
      }
    }

    // Ingest trust boundary (P1-T2 SEC): mark every client-advertised MCP
    // server 'client' origin BEFORE the run so any such server that reaches the
    // run loop is already untrusted for the per-tool approval gate and SSRF
    // guard. Marking is idempotent (an existing 'client' mark is never
    // upgraded), so re-marking across turns is safe.
    //
    // The bridge now ATTACHES these client-advertised servers to the run via
    // client.run({ mcpServers }) at 'client' origin (previously they were only
    // handed to the host via markClientMcpServers). The SAME marked record is
    // both attached to the run and passed to the optional markClientMcpServers
    // observability hook, so the WeakMap origin marks — keyed by config object
    // identity — survive to the run loop's getMCPToolData /
    // resolveMCPConfigOrigin. When the client advertised no servers, nothing is
    // attached and that path is unchanged.
    let clientMcpServers: Record<string, MCPConfig> | undefined
    if (Array.isArray(input.mcpServers) && input.mcpServers.length > 0) {
      clientMcpServers = acpMcpServersToConfigRecord(input.mcpServers)
      markAllMCPConfigOrigins(clientMcpServers, 'client')
      options.markClientMcpServers?.(clientMcpServers)
    }

    await client.run({
      agent: agentId,
      prompt: input.promptText,
      handleEvent,
      onFilesystemMutation: (event: FilesystemMutationEvent) =>
        sessionData.recordReceiptFromMutationEvent(input.sessionId, event),
      signal: input.signal,
      ...(clientMcpServers ? { mcpServers: clientMcpServers } : {}),
    })

    // A run that ended via the abort signal maps to 'cancelled'; a naturally
    // settled run is 'end_turn'.
    return { stopReason: input.signal.aborted ? 'cancelled' : 'end_turn' }
  }

  return { promptHandler, sessionData }
}

/**
 * Extracts the model-visible assistant text from a mapped `agent_message_chunk`
 * payload, or `undefined` when the payload carries none. Conservative by
 * design: only the text content of an `agent_message_chunk` is forwardable
 * through the streaming `update` seam; every other payload is handed to the
 * optional `onSessionUpdate` seam instead.
 */
function extractForwardableText(payload: unknown): string | undefined {
  if (!isPlainRecord(payload)) return undefined
  if (payload.sessionUpdate !== 'agent_message_chunk') return undefined
  const content = payload.content
  if (!isPlainRecord(content)) return undefined
  if (content.type !== 'text' || typeof content.text !== 'string') {
    return undefined
  }
  return content.text
}

/** Type guard for the plain-object payloads the event bridge emits. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The §4.6 tool `kind` mapping — the single table in code, pinned by the
 * design contract. Tool names reach this table from model-controlled tool
 * calls, so the record has a null prototype: a name like `'__proto__'` must
 * never hit an inherited setter.
 */
const TOOL_KINDS: Record<string, string> = Object.assign(Object.create(null), {
  read_files: 'read',
  read_outline: 'read',
  read_subtree: 'read',
  read_image: 'read',
  read_logs: 'read',
  list_directory: 'read',
  git_status: 'read',
  code_search: 'search',
  glob: 'search',
  query_index: 'search',
  find_files: 'search',
  find_files_matching_content: 'search',
  str_replace: 'edit',
  write_file: 'edit',
  edit_transaction: 'edit',
  replace_range: 'edit',
  rewrite_symbol: 'edit',
  create_plan: 'edit',
  update_plan_status: 'edit',
  run_terminal_command: 'execute',
  run_file_change_hooks: 'execute',
  run_targeted_validation: 'execute',
  kill_job: 'execute',
  web_search: 'fetch',
  read_docs: 'fetch',
  browser_logs: 'fetch',
  think_deeply: 'think',
})

/**
 * Resolves the §4.6 `kind` for a tool call. A mutation whose only action is
 * `delete` → `'delete'`; whose only action is `move` → `'move'`. The
 * `inspect_*` prefix family maps to `'read'`; everything else — including
 * `spawn_agents` and MCP/custom tools — is `'other'`.
 */
function acpToolKind(
  toolName: string,
  mutation?: { actions: Array<{ action: string }> },
): string {
  if (mutation !== undefined && mutation.actions.length > 0) {
    const actions = new Set(mutation.actions.map((entry) => entry.action))
    if (actions.size === 1 && actions.has('delete')) return 'delete'
    if (actions.size === 1 && actions.has('move')) return 'move'
  }
  if (toolName.startsWith('inspect_')) return 'read'
  return TOOL_KINDS[toolName] ?? 'other'
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
