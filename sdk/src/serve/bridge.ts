import { markAllMCPConfigOrigins } from '@codebuff/common/mcp/client'

import {
  OPENBUFF_CAPABILITIES_CHANGED_NOTIFICATION,
  OPENBUFF_GATE_STATE_NOTIFICATION,
  defaultCapabilityMapV1,
} from '../services/acp/ext-methods'
import { OutboundHoldback } from './outbound'

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
  /**
   * NEW-3 (§12.8): the configured credential VALUES the streaming holdback
   * must never split across chunk frames. Injected by the host (the CLI
   * collects them from its configured env keys) — this layer NEVER reads
   * `process.env`. Empty by default; the holdback still retains its 256-char
   * floor so cap.v3 tokens cannot straddle frames.
   */
  credentialValues?: string[]
  /** Optional structured logger forwarded by the host; unused in Wave-1 core. */
  logger?: Logger
}

/** §12.8 NEW-3: the idle flush window (ms), driven by one unref'd timer. */
const IDLE_FLUSH_MS = 250
/** §6.1 rate limit: at most one capabilities_changed push per 250 ms. */
const CAPABILITIES_PUSH_MIN_INTERVAL_MS = 250

/**
 * The honest P1 serve capability map (§6.1) is built per session by
 * `defaultCapabilityMapV1` (in ../services/acp/ext-methods): it is derived
 * from the serving process's REAL posture — in particular `journal.resume`/
 * `journal.replay` come from whether the backing store actually mirrors to a
 * durable journal, so a host using a purely in-memory `AcpSessionData` never
 * advertises resume/replay that `session/load` cannot honor.
 */

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
  const credentialValues = options.credentialValues ?? []
  // NEW-3 (§12.8): per-(sessionId, messageId) streaming holdbacks. The two
  // single-sink instances keep flush routing trivial: message pieces route to
  // `input.update`, thought pieces to `onSessionUpdate`.
  const messageHoldback = new OutboundHoldback()
  const thoughtHoldback = new OutboundHoldback()
  /** Last-notified ext-v1 gate-state projection JSON per session. */
  const lastGateStateJson = new Map<string, string>()
  /** Last-notified capability map JSON per session. */
  const lastCapabilitiesJson = new Map<string, string>()
  /** Rate-limit timestamp for the capabilities_changed push, per session. */
  const lastCapabilitiesPushAt = new Map<string, number>()

  /**
   * §6.1: pushes `_openbuff.dev/capabilities_changed` when the session's map
   * changed since the last push, rate-limited to one push per 250 ms and
   * always sending the full map. A no-op without `onSessionUpdate`.
   */
  const maybeNotifyCapabilitiesChanged = async (
    sessionId: string,
  ): Promise<void> => {
    if (!options.onSessionUpdate) return
    const capabilities = sessionData.getCapabilities(sessionId)
    if (capabilities === undefined) return
    const json = JSON.stringify(capabilities)
    if (lastCapabilitiesJson.get(sessionId) === json) return
    const now = Date.now()
    const last = lastCapabilitiesPushAt.get(sessionId)
    if (last !== undefined && now - last < CAPABILITIES_PUSH_MIN_INTERVAL_MS) {
      // Rate-limited: keep the previous notified JSON so the next call can
      // retry the push after the window.
      return
    }
    lastCapabilitiesPushAt.set(sessionId, now)
    lastCapabilitiesJson.set(sessionId, json)
    await options.onSessionUpdate({
      method: OPENBUFF_CAPABILITIES_CHANGED_NOTIFICATION,
      params: { capabilities },
    })
  }

  /**
   * §6.4: pushes `_openbuff.dev/gate_state {state}` whenever the projected
   * ext-v1 gate state differs from the last push for the session. A no-op
   * without `onSessionUpdate`.
   */
  const maybeNotifyGateState = async (sessionId: string): Promise<void> => {
    if (!options.onSessionUpdate) return
    const state = sessionData.getGateStateV1(sessionId)
    const json = JSON.stringify(state)
    if (lastGateStateJson.get(sessionId) === json) return
    lastGateStateJson.set(sessionId, json)
    await options.onSessionUpdate({
      method: OPENBUFF_GATE_STATE_NOTIFICATION,
      params: { state },
    })
  }

  const promptHandler: AcpPromptHandler = async (input) => {
    /**
     * NEW-3 (§12.8) flush helpers, scoped to this prompt turn AND this
     * session: one bridge instance serves every socket connection, so held
     * windows are keyed by (sessionId, messageId) and every flush releases
     * ONLY the OWNING session's windows through this turn's sinks — a
     * concurrent turn for a different session must never have its held text
     * released here (reviewer finding shared-holdback-cross-turn-flush /
     * RF-12).
     * - flushHoldbacks releases this session's held windows, routing message
     *   pieces to `input.update` and thought pieces to `onSessionUpdate`
     *   (flushed thought pieces are emitted as fresh `agent_thought_chunk`
     *   payloads).
     * - ensureIdleFlusher lazily starts ONE unref'd interval per turn that
     *   releases THIS session's windows idle for IDLE_FLUSH_MS;
     *   stopIdleFlusher clears it in the turn's finally so no per-chunk
     *   timer ever exists.
     */
    const flushHoldbacks = async (): Promise<void> => {
      const now = Date.now()
      for (const piece of messageHoldback.flushSession(input.sessionId, now)) {
        await input.update(piece)
      }
      for (const piece of thoughtHoldback.flushSession(input.sessionId, now)) {
        await options.onSessionUpdate?.({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: piece },
        })
      }
    }
    let idleTimer: ReturnType<typeof setInterval> | undefined
    const ensureIdleFlusher = (): void => {
      if (idleTimer !== undefined) return
      idleTimer = setInterval(() => {
        const now = Date.now()
        for (const piece of messageHoldback.flushIdleSession(
          input.sessionId,
          now,
          IDLE_FLUSH_MS,
        )) {
          void input.update(piece)
        }
        for (const piece of thoughtHoldback.flushIdleSession(
          input.sessionId,
          now,
          IDLE_FLUSH_MS,
        )) {
          void options.onSessionUpdate?.({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: piece },
          })
        }
      }, IDLE_FLUSH_MS)
      // A flush timer must never keep the process alive on its own.
      idleTimer.unref?.()
    }
    const stopIdleFlusher = (): void => {
      if (idleTimer === undefined) return
      clearInterval(idleTimer)
      idleTimer = undefined
    }

    /**
     * Maps every event through the §4.2 event bridge and forwards the
     * resulting payloads. `agent_message_chunk` text flows through the
     * message holdback (pieces are already sanitized by the holdback's emit
     * path) and out via `update`; `agent_thought_chunk` text flows through
     * the thought holdback and out via `onSessionUpdate`. Every other payload
     * goes to the optional `onSessionUpdate` seam — dropped when the host did
     * not supply it, which reproduces the Wave-1 text-only behavior. A
     * `tool_call`/`tool_call_update` payload is a §12.8 flush trigger: held
     * text is released BEFORE the tool card so the wire order stays
     * text → tool. The raw (unsanitized) text feeds gate-state parsing by
     * design — redacting the block would break the parser — while the
     * holdback's emit path and the NEW-4 chokepoint still redact the
     * outbound copy.
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
        if (!isPlainRecord(payload)) {
          await options.onSessionUpdate?.(payload)
          continue
        }
        const isMessageChunk = payload.sessionUpdate === 'agent_message_chunk'
        const isThoughtChunk = payload.sessionUpdate === 'agent_thought_chunk'
        if (
          !isMessageChunk &&
          !isThoughtChunk &&
          (payload.sessionUpdate === 'tool_call' ||
            payload.sessionUpdate === 'tool_call_update')
        ) {
          // Flush trigger (§12.8): release held text before the tool card.
          await flushHoldbacks()
        }
        if (isMessageChunk) {
          const text = extractForwardableText(payload)
          if (text === undefined) {
            await options.onSessionUpdate?.(payload)
            continue
          }
          // Record any published gate-state block from the model-visible text;
          // the store's parser is a no-op when the chunk carries no block.
          sessionData.updateGateStateFromBlock(input.sessionId, text)
          await maybeNotifyGateState(input.sessionId)
          ensureIdleFlusher()
          for (const piece of messageHoldback.push(
            input.sessionId,
            messageIdKey(payload),
            text,
            credentialValues,
            Date.now(),
          )) {
            await input.update(piece)
          }
          continue
        }
        if (isThoughtChunk) {
          const thought = extractThoughtText(payload)
          if (thought === undefined) {
            await options.onSessionUpdate?.(payload)
            continue
          }
          ensureIdleFlusher()
          for (const piece of thoughtHoldback.push(
            input.sessionId,
            messageIdKey(payload),
            thought,
            credentialValues,
            Date.now(),
          )) {
            await options.onSessionUpdate?.({
              ...payload,
              content: { type: 'text', text: piece },
            })
          }
          continue
        }
        await options.onSessionUpdate?.(payload)
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

    // §6.1: a session with no stored capability map gets the honest P1 serve
    // default BEFORE the first turn, so `_openbuff.dev/capabilities/get`
    // never fails for an open session and the change push has a baseline.
    // The journal flags are derived from the store's real posture, not
    // hardcoded (a purely in-memory store advertises no resume/replay).
    if (sessionData.getCapabilities(input.sessionId) === undefined) {
      sessionData.setCapabilities(
        input.sessionId,
        defaultCapabilityMapV1({ journalAvailable: sessionData.hasJournal() }),
      )
    }
    await maybeNotifyCapabilitiesChanged(input.sessionId)

    try {
      await client.run({
        agent: agentId,
        prompt: input.promptText,
        handleEvent,
        onFilesystemMutation: (event: FilesystemMutationEvent) =>
          sessionData.recordReceiptFromMutationEvent(input.sessionId, event),
        signal: input.signal,
        ...(clientMcpServers ? { mcpServers: clientMcpServers } : {}),
      })
    } finally {
      // §12.8 NEW-3 flush contract: turn end AND cancel release everything
      // held; the idle timer is stopped so no per-turn timer outlives the turn.
      stopIdleFlusher()
      await flushHoldbacks()
    }

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

/** The holdback window key for a chunk payload: its messageId, else 'default'. */
function messageIdKey(payload: Record<string, unknown>): string {
  return typeof payload.messageId === 'string' ? payload.messageId : 'default'
}

/** Extracts the text of an `agent_thought_chunk` payload, else undefined. */
function extractThoughtText(
  payload: Record<string, unknown>,
): string | undefined {
  const content = payload.content
  if (!isPlainRecord(content)) return undefined
  if (content.type !== 'text' || typeof content.text !== 'string') {
    return undefined
  }
  return content.text
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
