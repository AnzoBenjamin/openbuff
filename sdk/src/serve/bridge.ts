import { RequestError } from '@agentclientprotocol/sdk'
import { markAllMCPConfigOrigins } from '@codebuff/common/mcp/client'

import {
  OPENBUFF_CAPABILITIES_CHANGED_NOTIFICATION,
  OPENBUFF_GATE_STATE_NOTIFICATION,
  defaultCapabilityMapV1,
} from '../services/acp/ext-methods'
import { OutboundHoldback } from './outbound'

import type {
  AcpPromptHandler,
  AcpReverseRequests,
} from '../services/acp/acp-agent'
import type { AcpSessionData } from '../services/acp/session-data'
import type { HarnessApprovalRequest } from '../services/harness-enforcement'
import type {
  FilesystemMutationEvent,
  OpenbuffClientOptions,
  RunOptions,
} from '../run'
import type { RunState } from '../run-state'
import type {
  CreateElicitationRequest,
  ElicitationPropertySchema,
  McpServer,
  RequestPermissionRequest,
} from '@agentclientprotocol/sdk'
import type { MCPConfig } from '@codebuff/common/types/mcp'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import {
  printModeErrorToRpcError,
  printModeToSessionUpdates,
} from './event-bridge'
import type { PrintModeRpcError } from './event-bridge'

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
  /**
   * Client-side reverse-request seam (P1-T2 §5/§4.2), bound by the host to
   * the owning ACP connection. Required to bridge the core `requestApproval`
   * callback to `session/request_permission`; without it approvals fail
   * closed to `false` (a high-impact action is denied rather than silently
   * approved). Also used for the `elicitation.form` ask_user path.
   */
  reverseRequests?: AcpReverseRequests
  /**
   * Approval timeout (§12.4 `serve.approvalTimeoutMs`), defaulting to 30 min.
   * On expiry the approval resolves `false` and `$/cancel_request` is sent
   * for the outstanding request. The ask_user elicitation waits honor the
   * same timeout so a prompt never blocks forever.
   */
  approvalTimeoutMs?: number
  /**
   * The negotiated client capabilities snapshot (§4.2). When
   * `elicitation.form` is set, the core `ask_user` tool is mapped to an
   * `elicitation/create` reverse-request; otherwise the `events` extension
   * (when enabled) carries `_openbuff.dev/ask_user`; otherwise the tool
   * returns a skipped result.
   */
  clientCapabilities?: { elicitation?: { form?: unknown } }
  /**
   * Whether the `events` Openbuff extension was negotiated (§3.2). Gates the
   * `_openbuff.dev/ask_user` fallback: extension requests are sent only for
   * enabled extensions, so a false/absent value falls through to the skipped
   * result.
   */
  eventsExtensionEnabled?: boolean
  /**
   * Reverse-request seam for one client-bound JSON-RPC request/response
   * pair, used to carry `_openbuff.dev/ask_user` (a method the typed
   * {@link AcpReverseRequests} surface does not declare). Distinct from
   * `onSessionUpdate`, which is notification-shaped (fire-and-forget) and
   * cannot yield an answer. Returning a rejected promise maps to `skipped`.
   */
  onReverseRequest?: (method: string, params: unknown) => Promise<unknown>
  /**
   * Reverse-request cancellation seam (§12.4): sends `$/cancel_request` for
   * an outstanding request id. Fired on approval timeout so the client can
   * tear down the pending permission UI.
   */
  onCancelRequest?: (requestId: string) => void | Promise<void>
}

/** §12.8 NEW-3: the idle flush window (ms), driven by one unref'd timer. */
const IDLE_FLUSH_MS = 250
/** §6.1 rate limit: at most one capabilities_changed push per 250 ms. */
const CAPABILITIES_PUSH_MIN_INTERVAL_MS = 250
/** §12.4 `serve.approvalTimeoutMs` default: 30 minutes. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000

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
     * §5/§4.2 production wiring: ONE bridge instance serves every ACP
     * connection, so the reverse-request seams are selected PER TURN — the
     * transports bind them to the OWNING connection (see
     * `reverseRequestsFromConnection` in ../services/acp/acp-agent) and
     * supply them on the prompt-handler input; the static options remain the
     * fallback for hosts that wire a single connection directly.
     */
    const reverseRequests = input.reverseRequests ?? options.reverseRequests
    const clientCapabilities =
      input.clientCapabilities ?? options.clientCapabilities
    const eventsExtensionEnabled =
      input.eventsExtensionEnabled ?? options.eventsExtensionEnabled
    const onReverseRequest = input.onReverseRequest ?? options.onReverseRequest
    const onCancelRequest = input.onCancelRequest ?? options.onCancelRequest

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
     * §12.4: pending approvals/elicitations for THIS turn, keyed by the
     * reverse-request id. The map drives three fail-closed paths: a
     * duplicate/unknown-id response is a no-op (GV-24, the entry is already
     * gone), session/cancel or owner disconnect resolves every entry `false`
     * (GV-23), and the timeout resolves `false` after sending
     * `$/cancel_request`. The owning-connection close cannot be observed from
     * inside a turn, so it is modeled exactly as the cancel path it triggers
     * (§4.1: a client closing mid-turn MUST answer pending permission
     * requests cancelled).
     */
    const pendingReverseRequests = new Map<
      string,
      {
        resolve: (value: boolean) => void
        settled: boolean
        timeout: ReturnType<typeof setTimeout>
      }
    >()
    /**
     * Settles one pending reverse-request EXACTLY once (GV-24): the first
     * resolution wins, the entry is dropped, and its timer is cleared, so a
     * duplicate or unknown-id response for the same id finds no entry and is
     * ignored.
     */
    const settleReverseRequest = (requestId: string, value: boolean): void => {
      const entry = pendingReverseRequests.get(requestId)
      if (entry === undefined || entry.settled) return
      entry.settled = true
      pendingReverseRequests.delete(requestId)
      clearTimeout(entry.timeout)
      entry.resolve(value)
    }
    /**
     * GV-23: resolves every still-pending approval/elicitation `false`. Wired
     * to the turn's abort signal (session/cancel and owner-disconnect both
     * abort it), and re-checked before any `true` resolution so a response
     * that arrives after the abort can never approve.
     */
    const cancelAllPendingReverseRequests = (): void => {
      for (const requestId of [...pendingReverseRequests.keys()]) {
        settleReverseRequest(requestId, false)
      }
    }
    input.signal.addEventListener('abort', cancelAllPendingReverseRequests)
    /**
     * Terminal-error slot: the FIRST terminal `error` PrintModeEvent is
     * recorded (via `handleEvent`) and thrown after the run settles so the
     * prompt handler rejects with the -32603 `PrintModeRpcError` shape §4.2
     * prescribes for `session/prompt`. Later terminal errors keep the first
     * (the one that actually ended the run).
     */
    let terminalError: PrintModeRpcError | undefined
    let reverseRequestCounter = 0

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
      // Terminal-error surfacing (§4.2): an `error` event WITHOUT
      // `autoRecovering: true` is terminal. It is never emitted as a session
      // update; instead it is recorded so the turn rejects the
      // `session/prompt` call with the -32603 shape
      // `printModeErrorToRpcError` produces. The FIRST terminal error wins.
      if (event.type === 'error' && event.autoRecovering !== true) {
        if (terminalError === undefined) {
          terminalError = printModeErrorToRpcError(event)
        }
      }
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

    /**
     * §5/§12.4: bridges one core `requestApproval` host callback onto
     * `session/request_permission`. Fail-closed on every axis: no
     * reverse-request seam → `false`; a rejected/transport-lost promise →
     * `false`; a non-`allow_once` or cancelled outcome → `false` (GV-22);
     * session/cancel or owner disconnect → `false` AND the run aborts
     * `cancelled` (GV-23); the timeout resolves `false` after sending
     * `$/cancel_request`. A `true` resolution additionally requires the turn
     * signal to still be live (the request is still pending on the owning
     * connection).
     */
    const requestApproval = async (
      request: HarnessApprovalRequest,
    ): Promise<boolean> => {
      if (!reverseRequests) return false
      const requestId = `approval-${reverseRequestCounter++}`
      // GV-21 display sanitization is applied inside
      // `buildApprovalPermissionRequest` BEFORE anything is emitted, so no
      // control/bidi/zero-width char ever reaches the permission UI.
      const params = buildApprovalPermissionRequest(input.sessionId, request)
      const outcomePromise = reverseRequests.requestPermission(params)
      const timeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
      return await new Promise<boolean>((resolve) => {
        let settled = false
        const timeout = setTimeout(() => {
          // §12.4 timeout: resolve false and ask the client to cancel the
          // outstanding request.
          settleReverseRequest(requestId, false)
          void onCancelRequest?.(requestId)
        }, timeoutMs)
        timeout.unref?.()
        pendingReverseRequests.set(requestId, {
          resolve: (value) => {
            if (settled) return
            settled = true
            resolve(value)
          },
          settled: false,
          timeout,
        })
        outcomePromise.then(
          (response) => {
            // GV-22/GV-24: resolve true ONLY for a selected `allow_once`
            // outcome on a request that is still pending (not
            // cancelled/disconnected). The ACP SDK does not check `optionId`
            // against the offered options, so this layer must. A late or
            // duplicate response finds no entry and is ignored by
            // `settleReverseRequest`.
            const allow =
              response !== undefined &&
              response !== null &&
              response.outcome !== undefined &&
              response.outcome.outcome === 'selected' &&
              (response.outcome as { optionId?: string }).optionId ===
                'allow_once' &&
              pendingReverseRequests.has(requestId) &&
              !input.signal.aborted
            settleReverseRequest(requestId, allow)
          },
          () => {
            // A rejected promise (transport loss / connection close) fails
            // closed.
            settleReverseRequest(requestId, false)
          },
        )
      })
    }

    /**
     * §4.2: bridges the core `ask_user` tool onto the client. The mapping is
     * capability-driven: `elicitation.form` → `elicitation/create`; else the
     * `events` extension → `_openbuff.dev/ask_user`; else a skipped result.
     * Cancel is honored — an abort (session/cancel or disconnect) resolves
     * `skipped` so the tool never blocks the turn forever, and the approval
     * timeout bounds the wait the same way.
     */
    const handleAskUser = async (input0: {
      questions: Array<{
        question: string
        header?: string
        options: Array<{ label: string; description?: string }>
        multiSelect: boolean
      }>
    }): Promise<ToolResultOutput[]> => {
      const skippedResult: ToolResultOutput[] = [
        { type: 'json', value: { skipped: true } },
      ]
      const timeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
      const elicitationForm =
        clientCapabilities?.elicitation?.form !== undefined

      // Await one reverse-request payload, honoring cancel + the approval
      // timeout. Resolves the payload on success, `undefined` when the wait
      // is cancelled, times out, or the request fails (→ skipped result).
      const awaitReverseAnswer = (
        method: 'elicitation' | 'ask_user',
        invoke: () => Promise<unknown>,
      ): Promise<unknown> => {
        const requestId = `${method}-${reverseRequestCounter++}`
        let settled = false
        let resolveWait: (value: unknown) => void = () => {}
        const wait = new Promise<unknown>((resolve) => {
          resolveWait = resolve
        })
        const timeout = setTimeout(() => {
          settled = true
          pendingReverseRequests.delete(requestId)
          resolveWait(undefined)
          void onCancelRequest?.(requestId)
        }, timeoutMs)
        timeout.unref?.()
        pendingReverseRequests.set(requestId, {
          resolve: () => {
            // A cancel resolves the wait as skipped.
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolveWait(undefined)
          },
          settled: false,
          timeout,
        })
        void Promise.resolve()
          .then(invoke)
          .then(
            (payload) => {
              if (settled || input.signal.aborted) {
                settleReverseRequest(requestId, false)
                return
              }
              settled = true
              pendingReverseRequests.delete(requestId)
              clearTimeout(timeout)
              resolveWait(payload)
            },
            () => {
              settleReverseRequest(requestId, false)
            },
          )
        return wait
      }

      // The elicitation/form path needs an elicitation reverse-request seam.
      // `AcpReverseRequests` (owned by acp-agent.ts) does not declare one, so
      // the bridge drives `elicitation/create` through the generic
      // `onReverseRequest` channel when the client negotiated form support.
      if (elicitationForm && onReverseRequest !== undefined) {
        const response = (await awaitReverseAnswer('elicitation', () =>
          onReverseRequest(
            'elicitation/create',
            buildAskUserElicitation(input.sessionId, input0),
          ),
        )) as { action?: string; content?: Record<string, unknown> } | null
        if (
          response === null ||
          response === undefined ||
          response.action !== 'accept' ||
          !isPlainRecord(response.content)
        ) {
          return skippedResult
        }
        return [
          {
            type: 'json',
            value: {
              answers: elicitationContentToAskUserAnswers(
                input0.questions,
                response.content,
              ),
            },
          },
        ]
      }

      if (eventsExtensionEnabled && onReverseRequest !== undefined) {
        const response = await awaitReverseAnswer('ask_user', () =>
          onReverseRequest('_openbuff.dev/ask_user', {
            sessionId: input.sessionId,
            questions: sanitizeAskUserQuestions(input0.questions),
          }),
        )
        if (!isPlainRecord(response) || response.skipped === true) {
          return skippedResult
        }
        if (Array.isArray(response.answers)) {
          return [{ type: 'json', value: { answers: response.answers } }]
        }
        return skippedResult
      }

      return skippedResult
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
        // §5: bridge the core approval callback to session/request_permission.
        // Without a reverseRequests seam the callback resolves `false`, so a
        // high-impact action is denied rather than silently approved.
        requestApproval,
        // §4.2: bridge the ask_user tool onto elicitation / the events ext /
        // a skipped result, honoring cancel.
        overrideTools: { ask_user: handleAskUser },
        ...(clientMcpServers ? { mcpServers: clientMcpServers } : {}),
      })
    } finally {
      // §12.8 NEW-3 flush contract: turn end AND cancel release everything
      // held; the idle timer is stopped so no per-turn timer outlives the turn.
      stopIdleFlusher()
      await flushHoldbacks()
      // Turn teardown: detach the cancel listener and resolve every still-
      // pending approval/elicitation `false` so no timer or promise outlives
      // the turn.
      input.signal.removeEventListener('abort', cancelAllPendingReverseRequests)
      cancelAllPendingReverseRequests()
    }

    // §4.2 terminal-error surfacing: a terminal error answers `session/prompt`
    // with the -32603 error (data["openbuff.dev"].message = userMessage ??
    // message), NOT a normal stopReason. The payload is thrown as a REAL
    // RequestError instance — never a bare PrintModeRpcError object — because
    // the ACP wire layer maps a thrown RequestError onto the JSON-RPC error
    // response directly, while many JSON-RPC implementations wrap or discard
    // plain-object (non-Error) throws, which would silently turn the
    // terminal error into a generic failure without the openbuff.dev data.
    if (terminalError !== undefined) {
      throw new RequestError(
        terminalError.code,
        terminalError.data['openbuff.dev'].message,
        terminalError.data,
      )
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

// ---------------------------------------------------------------------------
// §5/§12.4 approval + §4.2 ask_user helpers (module-level, pure)
// ---------------------------------------------------------------------------

/**
 * §12.4 display-sanitization character set: C0/C1 controls, ESC, U+2028/2029,
 * bidi controls (U+202A–U+202E, U+2066–U+2069), and zero-width chars
 * (U+200B–U+200D, U+FEFF). Each is replaced with U+FFFD (GV-21). Bounded
 * character-class matches only, so this stays linear on adversarial input.
 */
const DISPLAY_UNSAFE_RE =
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/g

/** §12.4: `title` display cap, in characters. */
const APPROVAL_TITLE_MAX_CHARS = 200
/** §12.4: `command` cap on the approval `_meta`, in UTF-8 bytes. */
const APPROVAL_COMMAND_MAX_BYTES = 4 * 1024

/**
 * Replaces every display-unsafe character (C0/C1, ESC, U+2028/2029, bidi,
 * zero-width) with U+FFFD (GV-21). Pure and never throws.
 */
function sanitizeDisplayText(value: string): string {
  if (value.length === 0) return value
  return value.replace(DISPLAY_UNSAFE_RE, '\uFFFD')
}

/** Caps a string at `maxChars` characters (GV-21 `title` cap). */
function capChars(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value
}

/**
 * §12.4 command binding: truncates `command` at 4 KiB UTF-8, appending a
 * truncation marker, so the approval `_meta` carries the normalized command
 * without unbounded growth.
 */
function capCommandForApproval(command: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(command).byteLength <= APPROVAL_COMMAND_MAX_BYTES) {
    return command
  }
  let truncated = command
  while (
    truncated.length > 0 &&
    encoder.encode(truncated).byteLength > APPROVAL_COMMAND_MAX_BYTES
  ) {
    truncated = truncated.slice(0, Math.ceil(truncated.length / 2))
  }
  return `${truncated}\n[truncated]`
}

/**
 * Builds the §5 `session/request_permission` params for one
 * `HarnessApprovalRequest`. Every display field (`title`, `target`, `branch`,
 * `command`) passes through GV-21 sanitization BEFORE emission; `title` is
 * capped at 200 chars and `command` at 4 KiB. The `_meta["openbuff.dev"]
 * .approval` carries the (sanitized, capped) `command` plus the verbatim
 * `commandHash` binding (§12.4). Only the one-shot `allow_once` / `reject_once`
 * options are offered — there is no `allow_always` (GV-22).
 */
function buildApprovalPermissionRequest(
  sessionId: string,
  request: HarnessApprovalRequest,
): RequestPermissionRequest {
  const action = sanitizeDisplayText(String(request.action))
  const target = sanitizeDisplayText(String(request.target))
  const title = capChars(`Approve ${action}: ${target}`, APPROVAL_TITLE_MAX_CHARS)
  // The core HarnessApprovalRequest binds the command via commandHash (the
  // raw command is not carried across the contract); the human-readable
  // display derives from the classified target.
  const command = sanitizeDisplayText(
    capCommandForApproval(String(request.target)),
  )
  const approval: Record<string, unknown> = {
    action,
    target,
    risk: request.risk,
    reason: sanitizeDisplayText(String(request.reason)),
    command,
    commandHash: request.commandHash,
  }
  if (request.branch !== undefined) {
    approval.branch = sanitizeDisplayText(String(request.branch))
  }
  return {
    sessionId,
    toolCall: {
      toolCallId: `approval-${request.commandHash}`,
      title,
      kind: 'execute',
      status: 'pending',
    },
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    ],
    _meta: { 'openbuff.dev': { approval } },
  }
}

/** One ask_user question as the bridge needs it (subset of the tool schema). */
type AskUserQuestion = {
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}

/**
 * §4.2/GV-21: sanitizes the ask_user question list before it crosses the wire.
 * Question text, headers, option labels, and descriptions all pass through the
 * display sanitizer; structure and `multiSelect` are preserved.
 */
function sanitizeAskUserQuestions(
  questions: AskUserQuestion[],
): AskUserQuestion[] {
  return questions.map((question) => ({
    question: sanitizeDisplayText(question.question),
    ...(question.header !== undefined
      ? { header: sanitizeDisplayText(question.header) }
      : {}),
    options: question.options.map((option) => ({
      label: sanitizeDisplayText(option.label),
      ...(option.description !== undefined
        ? { description: sanitizeDisplayText(option.description) }
        : {}),
    })),
    multiSelect: question.multiSelect,
  }))
}

/**
 * Builds the `elicitation/create` form-mode request for one ask_user call
 * (§4.2). Each question becomes one property keyed `q<index>`: a titled
 * single-select (`oneOf`) string, or a multi-select (`array`) whose items are
 * the titled options. Question text is the property title; option labels are
 * the enum consts. All text passes through GV-21 sanitization.
 */
function buildAskUserElicitation(
  sessionId: string,
  input: { questions: AskUserQuestion[] },
): CreateElicitationRequest {
  const questions = sanitizeAskUserQuestions(input.questions)
  const properties: Record<string, ElicitationPropertySchema> = {}
  const required: string[] = []
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index]
    const key = `q${index}`
    required.push(key)
    const title = question.header ?? question.question
    if (question.multiSelect) {
      properties[key] = {
        type: 'array',
        title,
        description: question.question,
        items: {
          anyOf: question.options.map((option) => ({
            const: option.label,
            title: option.label,
            ...(option.description !== undefined
              ? { description: option.description }
              : {}),
          })),
        },
      }
    } else {
      properties[key] = {
        type: 'string',
        title,
        description: question.question,
        oneOf: question.options.map((option) => ({
          const: option.label,
          title: option.label,
          ...(option.description !== undefined
            ? { description: option.description }
            : {}),
        })),
      }
    }
  }
  return {
    mode: 'form',
    sessionId,
    message:
      questions.length === 1
        ? questions[0].question
        : `Answer ${questions.length} questions`,
    requestedSchema: {
      type: 'object',
      title: 'Questions',
      properties,
      required,
    },
  }
}

/** One ask_user answer: a JSON-safe projection of an elicitation response. */
type AskUserAnswer = {
  questionIndex: number
  selectedOption?: string
  selectedOptions?: string[]
}

/**
 * Maps an `elicitation/create` accepted `content` object back onto the
 * ask_user `answers` result shape. Single-select questions read a string at
 * `q<index>`; multi-select read a string array. A non-matching value yields
 * no answer for that question (the tool schema allows partial answers).
 */
function elicitationContentToAskUserAnswers(
  questions: AskUserQuestion[],
  content: Record<string, unknown>,
): AskUserAnswer[] {
  const answers: AskUserAnswer[] = []
  for (let index = 0; index < questions.length; index++) {
    const value = content[`q${index}`]
    if (questions[index].multiSelect) {
      if (Array.isArray(value)) {
        answers.push({
          questionIndex: index,
          selectedOptions: value.filter((entry) => typeof entry === 'string'),
        })
      }
      continue
    }
    if (typeof value === 'string') {
      answers.push({ questionIndex: index, selectedOption: value })
    }
  }
  return answers
}
