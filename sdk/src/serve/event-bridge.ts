import path from 'path'

import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

/**
 * Pure, transport-free ACP event bridge (P1-T2b, NORMATIVE contract §4.2 of
 * `.agents/sessions/polyglot-roadmap-v2/P1-T1-DESIGN.md`). Maps a
 * `PrintModeEvent` from the core run loop onto the `session/update` payload
 * shapes the ACP client consumes. The function performs NO I/O: it owns no
 * connection, spawns no process, and reads no environment — the host supplies
 * everything ambient through {@link EventBridgeContext}.
 *
 * Security posture inherited from §12.1 (SEC-1/SEC-6):
 * - `rawOutput` is NEVER attached to any emitted payload.
 * - Tool results are surfaced only as bounded `content` text (capped at 64 KiB
 *   with a truncation marker); final `sanitizeOutbound` redaction stays at the
 *   transport chokepoint.
 * - Auto-recovering errors are never emitted; terminal errors are mapped by
 *   {@link printModeErrorToRpcError} instead of a session update.
 */
export type EventBridgeContext = {
  sessionId: string
  /** Run id stamped onto `agent_message_chunk`/`agent_thought_chunk` `messageId`. */
  runId: string | undefined
  /**
   * `'acp'` (default) keeps subagent text and telemetry variants off the wire;
   * `'full'` enables them per §4.2.
   */
  eventsMode: 'acp' | 'full'
  /** Root `tool_call` locations are resolved against. */
  projectRoot: string
  /**
   * §4.6 tool `kind` mapping, supplied by the host so this module stays
   * decoupled from the parallel stream's module layout.
   */
  toolKind: (
    toolName: string,
    mutation?: { actions: Array<{ action: string }> },
  ) => string
}

/**
 * Thrown by the exhaustiveness default branch when a `PrintModeEvent` variant
 * has no §4.2 mapping. Typed so callers can distinguish contract drift from a
 * mapping bug.
 */
export class UnhandledPrintModeVariantError extends Error {
  readonly variant: string
  constructor(variant: string) {
    super(
      `printModeToSessionUpdates has no §4.2 mapping for PrintModeEvent variant '${variant}'`,
    )
    this.name = 'UnhandledPrintModeVariantError'
    this.variant = variant
  }
}

/** JSON-RPC error shape §4.2 prescribes for a terminal error on `session/prompt`. */
export type PrintModeRpcError = {
  code: number
  data: { 'openbuff.dev': { message: string } }
}

/**
 * Maps a terminal `error` event (one WITHOUT `autoRecovering: true`) onto the
 * JSON-RPC error §4.2 prescribes for `session/prompt`: -32603 with
 * `data["openbuff.dev"].message = userMessage ?? message`. Auto-recovering
 * errors are never emitted and never reach this function.
 */
export function printModeErrorToRpcError(
  event: Extract<PrintModeEvent, { type: 'error' }>,
): PrintModeRpcError {
  return {
    code: -32603,
    data: {
      'openbuff.dev': { message: event.userMessage ?? event.message },
    },
  }
}

/** The `_openbuff.dev/event` ext notification method (§4.2, events=`full`). */
const EXT_EVENT_METHOD = '_openbuff.dev/event'

/**
 * Input keys treated as filesystem paths when building `tool_call`
 * `locations`. Values are made absolute against `ctx.projectRoot`.
 */
const PATH_PARAM_KEYS = [
  'path',
  'paths',
  'filePath',
  'filePaths',
  'targetPath',
  'destinationPath',
] as const

/** §12.1: tool results cross as sanitized text capped at 64 KiB. */
const TOOL_RESULT_CONTENT_MAX_BYTES = 64 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Builds `tool_call` `locations` from the event's path-shaped input params,
 * made absolute against `projectRoot` and de-duplicated.
 */
function collectLocations(
  input: Record<string, unknown>,
  projectRoot: string,
): Array<{ path: string }> {
  const locations: Array<{ path: string }> = []
  const seen = new Set<string>()
  for (const key of PATH_PARAM_KEYS) {
    const value = input[key]
    if (value === undefined) continue
    for (const candidate of Array.isArray(value) ? value : [value]) {
      if (typeof candidate !== 'string' || candidate.length === 0) continue
      // An empty projectRoot (the host has not supplied a root yet) keeps the
      // path relative instead of silently resolving against process.cwd().
      const absolute =
        projectRoot === '' ? candidate : path.resolve(projectRoot, candidate)
      if (seen.has(absolute)) continue
      seen.add(absolute)
      locations.push({ path: absolute })
    }
  }
  return locations
}

type MutationActionSummary = {
  outcome: string
  path: string
  afterContent: string | undefined
}

type MutationResultSummary = {
  outcome: string
  actions: MutationActionSummary[]
}

/**
 * Structurally narrows an output JSON value onto the slice of
 * `FileMutationResultV1` the mapping needs, without importing the runtime
 * result module into this transport-free layer.
 */
function asMutationResult(value: unknown): MutationResultSummary | undefined {
  if (!isRecord(value) || value.kind !== 'file_mutation_result') return undefined
  if (typeof value.outcome !== 'string' || !Array.isArray(value.actions)) {
    return undefined
  }
  const actions: MutationActionSummary[] = []
  for (const element of value.actions) {
    if (!isRecord(element)) continue
    if (
      typeof element.outcome !== 'string' ||
      typeof element.path !== 'string'
    ) {
      continue
    }
    actions.push({
      outcome: element.outcome,
      path: element.path,
      afterContent:
        typeof element.afterContent === 'string'
          ? element.afterContent
          : undefined,
    })
  }
  return { outcome: value.outcome, actions }
}

/** The JSON values of a tool_result output (media parts are never emitted). */
function jsonValuesOf(output: ToolResultOutput[]): unknown[] {
  const values: unknown[] = []
  for (const part of output) {
    // `media` parts carry raw output bytes; they are never emitted (§12.1).
    if (part.type === 'json') values.push(part.value)
  }
  return values
}

/** Caps serialized tool-result text at `maxBytes` UTF-8 with a marker (§12.1). */
function capUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength <= maxBytes) return text
  let truncated = text
  while (
    truncated.length > 0 &&
    encoder.encode(truncated).byteLength > maxBytes
  ) {
    truncated = truncated.slice(0, Math.ceil(truncated.length / 2))
  }
  return `${truncated}\n[truncated]`
}

type PlanEntry = {
  content: string
  priority: 'medium'
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * Builds §4.2 `plan` entries from a `write_todos` result's `currentTodos`
 * (`{task, completed}[]`): each todo becomes
 * `{content: task, priority: 'medium', status: completed ? 'completed' : 'pending'}`
 * and the FIRST incomplete todo becomes `in_progress`. Returns `undefined`
 * when the output carries no todo list at all.
 */
function planEntriesFromWriteTodos(
  values: unknown[],
): PlanEntry[] | undefined {
  for (const value of values) {
    if (!isRecord(value) || !Array.isArray(value.currentTodos)) continue
    const entries: PlanEntry[] = []
    let markedFirstIncomplete = false
    for (const todo of value.currentTodos) {
      if (!isRecord(todo) || typeof todo.task !== 'string') continue
      if (todo.completed === true) {
        entries.push({ content: todo.task, priority: 'medium', status: 'completed' })
        continue
      }
      if (!markedFirstIncomplete) {
        markedFirstIncomplete = true
        entries.push({ content: todo.task, priority: 'medium', status: 'in_progress' })
        continue
      }
      entries.push({ content: todo.task, priority: 'medium', status: 'pending' })
    }
    return entries
  }
  return undefined
}

/**
 * Maps one `PrintModeEvent` onto zero or more ACP `session/update` payloads
 * per §4.2. Payload shapes are the ACP `SessionUpdate` union members (a
 * `sessionUpdate` discriminant) plus the `_openbuff.dev/event` ext
 * notification, emitted as `{ method, params }` so the host can dispatch it
 * as a notification rather than a session update.
 *
 * Variants with no §4.2 row (`start`) emit nothing; an UNKNOWN variant throws
 * {@link UnhandledPrintModeVariantError} naming it.
 */
export function printModeToSessionUpdates(
  event: PrintModeEvent,
  ctx: EventBridgeContext,
): Array<unknown> {
  switch (event.type) {
    case 'text': {
      // Subagent text is forwarded only when events=`full`. The real `text`
      // variant carries `agentId` but no `parentAgentId`, so only `agentId`
      // is forwarded in `_meta` rather than invented.
      const isSubagent = event.agentId !== undefined
      if (isSubagent && ctx.eventsMode !== 'full') return []
      const payload: Record<string, unknown> = {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: event.text },
      }
      if (ctx.runId !== undefined) payload.messageId = ctx.runId
      if (isSubagent) {
        payload._meta = { 'openbuff.dev': { agentId: event.agentId } }
      }
      return [payload]
    }
    case 'reasoning_delta': {
      // `ancestorRunIds` is empty exactly for the root run, so root-only means
      // an empty lineage unless events=`full`.
      if (event.ancestorRunIds.length > 0 && ctx.eventsMode !== 'full') {
        return []
      }
      const payload: Record<string, unknown> = {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: event.text },
      }
      if (ctx.runId !== undefined) payload.messageId = ctx.runId
      return [payload]
    }
    case 'tool_call': {
      const locations = collectLocations(event.input, ctx.projectRoot)
      const payload: Record<string, unknown> = {
        sessionUpdate: 'tool_call',
        toolCallId: event.toolCallId,
        // The tool registry's display label is not reachable from a pure,
        // transport-free function, so the tool name stands in as the title.
        title: event.toolName,
        kind: ctx.toolKind(event.toolName),
        status: 'pending',
      }
      if (locations.length > 0) payload.locations = locations
      // `rawInput` is deliberately not attached here: §12.1 requires input to
      // pass the full outbound redaction pass before emission, which the
      // transport chokepoint owns.
      return [payload]
    }
    case 'tool_start': {
      return [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolCallId,
          status: 'in_progress',
        },
      ]
    }
    case 'tool_result': {
      // Internal (subagent-forwarded) tool results are never surfaced, even
      // with events=`full` — the parent's spawn tool card carries the
      // subagent UI instead (GV-16).
      if (event.parentAgentId !== undefined) return []

      const values = jsonValuesOf(event.output)
      const planEntries =
        event.toolName === 'write_todos'
          ? planEntriesFromWriteTodos(values)
          : undefined
      if (planEntries !== undefined) {
        return [{ sessionUpdate: 'plan', entries: planEntries }]
      }

      let failed = false
      let mutation: MutationResultSummary | undefined
      for (const value of values) {
        if (!isRecord(value)) continue
        const errorMessage = value.errorMessage
        if (typeof errorMessage === 'string' && errorMessage.length > 0) {
          failed = true
        }
        // A native tool-result error carries `error.message`, not
        // `errorMessage`, but is by definition a failed result.
        if (value.kind === 'native_tool_result_error') failed = true
        const parsed = asMutationResult(value)
        if (parsed !== undefined) {
          // §4.2: a mutation outcome outside {applied} fails the tool card.
          if (parsed.outcome !== 'applied') failed = true
          mutation = parsed
        }
      }

      const content: Array<unknown> = []
      const text = capUtf8(
        values.map((value) => JSON.stringify(value)).join('\n'),
        TOOL_RESULT_CONTENT_MAX_BYTES,
      )
      if (text.length > 0) content.push({ type: 'text', text })
      if (mutation !== undefined) {
        for (const action of mutation.actions) {
          // Mutations add `diff` content when after-text is available
          // (`afterContent` present, §4.2). The tool_result variant carries
          // no before-text, so the block omits `oldText` rather than
          // inventing it.
          if (action.afterContent !== undefined) {
            content.push({
              type: 'diff',
              path: action.path,
              newText: action.afterContent,
            })
          }
        }
      }

      const payload: Record<string, unknown> = {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.toolCallId,
        status: failed ? 'failed' : 'completed',
      }
      if (content.length > 0) payload.content = content
      // `rawOutput` is deliberately never attached (§12.1).
      return [payload]
    }
    case 'subagent_start': {
      // Without the parent's spawn toolCallId there is no card to attach to,
      // so nothing is emitted rather than inventing an id.
      if (event.spawnToolCallId === undefined) return []
      return [
        {
          sessionUpdate: 'tool_call',
          toolCallId: event.spawnToolCallId,
          title: event.displayName,
          kind: ctx.toolKind('spawn_agents'),
          status: 'pending',
          _meta: {
            'openbuff.dev': {
              agent: {
                agentId: event.agentId,
                agentType: event.agentType,
                displayName: event.displayName,
              },
            },
          },
        },
      ]
    }
    case 'subagent_finish': {
      if (event.spawnToolCallId === undefined) return []
      return [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.spawnToolCallId,
          status: event.error !== undefined ? 'failed' : 'completed',
          _meta: {
            'openbuff.dev': {
              agent: {
                agentId: event.agentId,
                agentType: event.agentType,
                displayName: event.displayName,
              },
            },
          },
        },
      ]
    }
    case 'context_window': {
      // The variant carries `used`/`max` (and optional compaction telemetry
      // this mapping does not surface), so only used/size are emitted.
      return [
        {
          sessionUpdate: 'usage_update',
          used: event.used,
          size: event.max,
        },
      ]
    }
    case 'finish': {
      // `totalCost` is required on the variant; cost is local estimation only.
      return [
        {
          sessionUpdate: 'usage_update',
          cost: { amount: event.totalCost, currency: 'USD' },
        },
      ]
    }
    case 'error': {
      // Auto-recovering errors are never emitted (§4.2); terminal errors are
      // mapped to the `session/prompt` JSON-RPC error by
      // printModeErrorToRpcError, not to a session update.
      return []
    }
    case 'start': {
      // No §4.2 row maps `start` onto any client-visible message.
      return []
    }
    case 'job_update':
    case 'provider_status':
    case 'phase':
    case 'context_compaction':
    case 'context_compaction_status':
    case 'context_compaction_progress':
    case 'context_request_trim':
    case 'memory_reuse':
    case 'download': {
      // §4.2: telemetry variants reach the client ONLY as the
      // `_openbuff.dev/event` ext notification when events=`full`, and never
      // as `tool_call`/`tool_result`.
      if (ctx.eventsMode !== 'full') return []
      return [
        {
          method: EXT_EVENT_METHOD,
          params: { sessionId: ctx.sessionId, event },
        },
      ]
    }
    default: {
      const unhandled = event as { type?: unknown }
      const unhandledType = unhandled.type
      throw new UnhandledPrintModeVariantError(
        typeof unhandledType === 'string'
          ? unhandledType
          : String(unhandledType),
      )
    }
  }
}
