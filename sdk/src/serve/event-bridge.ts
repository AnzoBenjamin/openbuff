import path from 'path'

import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type {
  CommitReceiptV1,
  FileMutationActionV1,
  FileMutationResultV1,
} from '@codebuff/common/tools/results/filesystem'
import { toWireMutation } from '@codebuff/common/protocol/acp-ext-v1'
import { getConfirmedAppliedActionsV1, isFileMutationResultV1 } from '@codebuff/common/tools/results/filesystem'

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
   * The active tool call id, stamped onto the receipt envelope's `toolCallId`
   * (§6.2). Only meaningful while a `tool_result` is being mapped.
   */
  toolCallId?: string
  /**
   * §4.6 tool `kind` mapping, supplied by the host so this module stays
   * decoupled from the parallel stream's module layout.
   */
  toolKind: (
    toolName: string,
    mutation?: { actions: Array<{ action: string }> },
  ) => string
  /**
   * NEW-3 (§12.8): the configured credential VALUES the streaming holdback
   * redacts from chunk text. The holdback does NOT cover `tool_call`
   * rawInput, so the same value substitution is applied here over every
   * rawInput string field before emission. Omitted/empty → no credential
   * redaction (matching the holdback's default posture).
   */
  credentialValues?: readonly string[]
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

/**
 * NEW-6 (§12.8, GV-25): paths whose basename marks credential material.
 * Case-insensitive on the basename: `.env`/`.env.*`, `*.pem`, `*.key`,
 * `id_rsa`/`id_rsa.*`, `id_ed25519`/`id_ed25519.*`, `.git-credentials`,
 * `.netrc`, `credentials`, and `secrets.*`.
 */
export function isSensitivePath(p: string): boolean {
  const basename = p.split(/[\\/]/).pop() ?? p
  const lower = basename.toLowerCase()
  if (lower === '.env' || lower.startsWith('.env.')) return true
  if (lower.endsWith('.pem') || lower.endsWith('.key')) return true
  if (lower === 'id_rsa' || lower.startsWith('id_rsa.')) return true
  if (lower === 'id_ed25519' || lower.startsWith('id_ed25519.')) return true
  if (
    lower === '.git-credentials' ||
    lower === '.netrc' ||
    // Package-registry auth files carry tokens; a card touching one must not
    // leak the registry credentials it writes.
    lower === '.npmrc' ||
    lower === '.pypirc' ||
    lower === 'credentials'
  ) {
    return true
  }
  return lower.startsWith('secrets.')
}

/** The placeholder NEW-6 substitutes into content-bearing rawInput fields. */
const SENSITIVE_PLACEHOLDER = '[sensitive]'

/** Top-level rawInput string fields redacted for a sensitive path. */
const RAW_INPUT_CONTENT_KEYS = [
  'content',
  'newString',
  'oldString',
  'diff',
  // `replace_range` carries its replacement text in `newContent`; a card
  // touching a sensitive path must never leak it (NEW-6/GV-25).
  'newContent',
]

/** rawInput list fields whose element string values are redacted at every depth. */
const RAW_INPUT_LIST_KEYS = ['replacements', 'edits']

/**
 * NEW-6 element-level redaction: EVERY string value at EVERY depth inside a
 * `replacements`/`edits` element becomes "[sensitive]". Edit elements carry
 * file content in nested positions a flat field list cannot cover — a
 * `structured` edit's `operation.text`/`importStatement`, a
 * `replace_range` edit's `occurrence.match`, or any future nested
 * content-bearing field — so the element rule is shape-recursive, not
 * field-listed. Arrays and plain objects are rebuilt; everything else passes
 * through.
 */
function redactAllStringsDeep(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return SENSITIVE_PLACEHOLDER
  }
  if (depth >= REDACT_WALK_MAX_DEPTH) {
    // Same fail-closed shape as redactCredentialValuesDeep: a capped subtree
    // is serialized rather than passed through, and redact-all-strings of
    // that serialized form is the marker itself.
    return SENSITIVE_PLACEHOLDER
  }
  if (Array.isArray(value)) {
    return value.map((element) => redactAllStringsDeep(element, depth + 1))
  }
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {}
    for (const [field, fieldValue] of Object.entries(value)) {
      copy[field] = redactAllStringsDeep(fieldValue, depth + 1)
    }
    return copy
  }
  return value
}

/**
 * Builds the NEW-6 redacted rawInput copy: top-level content-bearing string
 * fields become "[sensitive]", and EVERY string value of every
 * `replacements`/`edits` element becomes "[sensitive]" at EVERY nesting
 * depth (covering nested `content`/`newString`/`oldString`/`newContent`
 * inside edit elements, plus the nested content positions of structured and
 * occurrence-targeted edits). All other top-level fields — paths, ids,
 * flags — pass through untouched.
 */
function redactSensitiveRawInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...input }
  for (const key of RAW_INPUT_CONTENT_KEYS) {
    if (typeof redacted[key] === 'string') {
      redacted[key] = SENSITIVE_PLACEHOLDER
    }
  }
  for (const key of RAW_INPUT_LIST_KEYS) {
    const list = redacted[key]
    if (!Array.isArray(list)) continue
    redacted[key] = list.map((element) =>
      isRecord(element) ? redactAllStringsDeep(element, 0) : element,
    )
  }
  return redacted
}

/** The NEW-3 substitution literal, identical to OutboundHoldback's emit path. */
const CREDENTIAL_VALUE_REDACTED = '[REDACTED_SECRET]'

/**
 * Recursion bound shared by the deep-redaction walks (credential-value and
 * sensitive-string) over a hostile nested rawInput. At the cap a walk does
 * NOT pass the remaining subtree through: it is serialized and the
 * serialized text is redacted instead (fail-closed).
 */
const REDACT_WALK_MAX_DEPTH = 32

/** Applies the credential-value substitution to one serialized text blob. */
function redactCredentialValuesInString(
  text: string,
  credentials: readonly string[],
): string {
  let redacted = text
  for (const credential of credentials) {
    if (credential.length === 0) continue
    redacted = redacted.split(credential).join(CREDENTIAL_VALUE_REDACTED)
  }
  return redacted
}

/**
 * NEW-3 (§12.8): substitutes every configured credential VALUE found in any
 * string at any depth of a rawInput payload with "[REDACTED_SECRET]"
 * (mirroring OutboundHoldback's emit path, which only covers streaming chunk
 * text — rawInput bypassed the holdback entirely). Depth-bounded so a
 * hostile deep payload cannot overflow the stack; at the depth cap the
 * remaining subtree is serialized and the serialized text is redacted rather
 * than passed through unredacted (EV-2, fail-closed).
 */
function redactCredentialValuesDeep(
  value: unknown,
  credentials: readonly string[],
  depth: number,
): unknown {
  if (typeof value === 'string') {
    return redactCredentialValuesInString(value, credentials)
  }
  if (depth >= REDACT_WALK_MAX_DEPTH) {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string'
      ? redactCredentialValuesInString(serialized, credentials)
      : value
  }
  if (Array.isArray(value)) {
    return value.map((element) =>
      redactCredentialValuesDeep(element, credentials, depth + 1),
    )
  }
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {}
    for (const [field, fieldValue] of Object.entries(value)) {
      copy[field] = redactCredentialValuesDeep(
        fieldValue,
        credentials,
        depth + 1,
      )
    }
    return copy
  }
  return value
}

/** Whether any collected tool_call location points at a sensitive path. */
function anyLocationSensitive(locations: Array<{ path: string }>): boolean {
  return locations.some((location) => isSensitivePath(location.path))
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
 * `FileMutationResultV1` the diff/`failed` mapping needs. Deliberately loose
 * (it does NOT require the full result schema) so an existing tool_result
 * that carries only outcome/path/afterContent still drives the tool card's
 * status and diff content. Receipt attachment uses the strictly-validated
 * {@link asConfirmedMutation} instead.
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

/**
 * Strictly narrows an output JSON value onto a schema-clean
 * `FileMutationResultV1`, or `undefined`. Only a fully-validated mutation is
 * projected onto a §6.2 receipt envelope (cap.v3 authority is at stake).
 */
function asConfirmedMutation(value: unknown): FileMutationResultV1 | undefined {
  return isFileMutationResultV1(value) ? value : undefined
}

/** NEW-6/GV-25: the literal substituted for every redacted hash (§12.1). */
const REDACTED_HASH = 'sha256:redacted'

/** The NEW-6 placeholder text block substituted for a sensitive-path diff. */
function sensitiveDiffPlaceholder(path: string): Record<string, unknown> {
  // The text is constant-shape (no file content), so it leaks nothing beyond
  // the already-disclosed fact that this path changed.
  return { type: 'text', text: `[sensitive file changed: ${path}]` }
}

/**
 * NEW-6 (§12.1, GV-25): the content block for one mutation action. A
 * non-sensitive action with after-text yields a `diff` block; a sensitive-path
 * action yields the `[sensitive file changed]` text placeholder instead of any
 * diff content (the post-edit content must never reach the wire for a
 * sensitive path).
 */
function mutationActionBlock(
  action: MutationActionSummary,
): Record<string, unknown> | undefined {
  if (isSensitivePath(action.path)) {
    return sensitiveDiffPlaceholder(action.path)
  }
  if (action.afterContent !== undefined) {
    return { type: 'diff', path: action.path, newText: action.afterContent }
  }
  return undefined
}

/** Content-bearing mutation-result fields redacted for a sensitive-path action. */
const MUTATION_RESULT_CONTENT_KEYS = [
  'afterContent',
  'beforeContent',
  'patch',
  'content',
] as const

/**
 * EV-1: returns `values` with the content-bearing fields of every
 * sensitive-path mutation action replaced with "[sensitive]" (the same
 * placeholder the diff block's convention uses) so the raw-JSON
 * `tool_result` text block never echoes post-edit file content for a
 * sensitive path. Values without a sensitive-path mutation pass through
 * unchanged (the same array when nothing is sensitive), and every serialized
 * line stays JSON.parse-able.
 */
function redactSensitiveMutationValues(values: unknown[]): unknown[] {
  const sensitivePaths = new Set<string>()
  for (const value of values) {
    const parsed = asMutationResult(value)
    if (parsed === undefined) continue
    for (const action of parsed.actions) {
      if (isSensitivePath(action.path)) sensitivePaths.add(action.path)
    }
  }
  if (sensitivePaths.size === 0) return values
  return values.map((value) => {
    if (
      !isRecord(value) ||
      value.kind !== 'file_mutation_result' ||
      !Array.isArray(value.actions)
    ) {
      return value
    }
    return {
      ...value,
      actions: value.actions.map((action) => {
        if (!isRecord(action) || !sensitivePaths.has(String(action.path)))
          return action
        const redacted = { ...action }
        for (const key of MUTATION_RESULT_CONTENT_KEYS) {
          if (typeof redacted[key] === 'string') {
            redacted[key] = SENSITIVE_PLACEHOLDER
          }
        }
        return redacted
      }),
    }
  })
}

/**
 * Builds the redacted §6.2 receipt envelope for a confirmed mutation, with
 * NEW-6 hash redaction applied to the mutation projection and its kept-verbatim
 * `authorityReceipt.finalHashes`. Mirrors `toWireReceipt` (the envelope
 * `toWireMutation` projection already drops `afterContent`/`patch`/`editAnchor`
 * and pins `freshCapabilities: []`), then rewrites the hashes of every
 * sensitive-path action to `"sha256:redacted"`.
 */
function buildReceiptEnvelope(
  mutation: FileMutationResultV1,
  ctx: EventBridgeContext,
): Record<string, unknown> {
  const wire = toWireMutation(mutation)
  const sensitivePaths = new Set(
    mutation.actions
      .filter((action: FileMutationActionV1) => isSensitivePath(action.path))
      .map((action: FileMutationActionV1) => action.path),
  )
  if (sensitivePaths.size > 0) {
    for (const action of wire.actions) {
      if (!sensitivePaths.has(action.path)) continue
      action.beforeHash = action.beforeHash === null ? null : REDACTED_HASH
      action.afterHash = action.afterHash === null ? null : REDACTED_HASH
    }
    const receipt = wire.authorityReceipt
    if (receipt !== undefined) {
      wire.authorityReceipt = {
        ...receipt,
        actions: receipt.actions.map((action: CommitReceiptV1['actions'][number]) =>
          sensitivePaths.has(action.path)
            ? {
                ...action,
                beforeHash: action.beforeHash === null ? null : REDACTED_HASH,
                afterHash: action.afterHash === null ? null : REDACTED_HASH,
              }
            : action,
        ),
        finalHashes: Object.fromEntries(
          Object.entries(receipt.finalHashes).map(([path, hash]) => [
            path,
            sensitivePaths.has(path) && hash !== null ? REDACTED_HASH : hash,
          ]),
        ),
      } satisfies CommitReceiptV1
    }
  }
  const envelope: Record<string, unknown> = {
    kind: 'openbuff.receipt_envelope',
    version: 1,
    sessionId: ctx.sessionId,
    toolCallId: ctx.toolCallId,
    laneId: 'main',
    mutation: wire,
  }
  return envelope
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
      // NEW-6 (§12.8): rawInput rides every tool card. When any collected
      // location path is sensitive, the content-bearing input fields are
      // replaced with "[sensitive]" (GV-25) before emission; the §12.1
      // transport chokepoint stays the last line of defense for the rest.
      // NEW-6 (§12.8): rawInput rides every tool card. When any collected
      // location path is sensitive, the content-bearing input fields are
      // replaced with "[sensitive]" (GV-25) before emission; the §12.1
      // transport chokepoint stays the last line of defense for the rest.
      // NEW-3 (§12.8): the streaming holdback only covers chunk text, so the
      // credential-value substitution is applied to rawInput here too — any
      // configured credential value embedded in the tool input is replaced
      // with "[REDACTED_SECRET]" before the card crosses the wire.
      const rawInput = anyLocationSensitive(locations)
        ? redactSensitiveRawInput(event.input)
        : event.input
      const credentials = ctx.credentialValues ?? []
      payload.rawInput = credentials.some((value) => value.length > 0)
        ? redactCredentialValuesDeep(rawInput, credentials, 0)
        : rawInput
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
      // The strictly-validated confirmed mutation that earns a §6.2 receipt
      // envelope (undefined unless a schema-clean mutation has at least one
      // confirmed applied action).
      let confirmedMutation: FileMutationResultV1 | undefined
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
        const confirmed = asConfirmedMutation(value)
        if (
          confirmed !== undefined &&
          getConfirmedAppliedActionsV1(confirmed).length > 0
        ) {
          confirmedMutation = confirmed
        }
      }

      const content: Array<unknown> = []
      // EV-1: the raw-JSON text block must not echo full post-edit file
      // content for a sensitive-path action — the separate diff block already
      // substitutes "[sensitive file changed]", so the content-bearing fields
      // of any sensitive-path action are replaced with "[sensitive]" before
      // serialization (each line stays JSON.parse-able).
      const text = capUtf8(
        redactSensitiveMutationValues(values)
          .map((value) => JSON.stringify(value))
          .join('\n'),
        TOOL_RESULT_CONTENT_MAX_BYTES,
      )
      if (text.length > 0) content.push({ type: 'text', text })
      if (mutation !== undefined) {
        for (const action of mutation.actions) {
          // Mutations add `diff` content when after-text is available
          // (`afterContent` present, §4.2). The tool_result variant carries
          // no before-text, so the block omits `oldText` rather than
          // inventing it. NEW-6 (§12.1, GV-25): a sensitive-path action emits
          // a `[sensitive file changed]` text placeholder instead of any
          // `diff` content, and its hashes are redacted on the receipt.
          const block = mutationActionBlock(action)
          if (block !== undefined) content.push(block)
        }
      }

      const payload: Record<string, unknown> = {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.toolCallId,
        status: failed ? 'failed' : 'completed',
      }
      if (content.length > 0) payload.content = content
      // §4.2/§6.2: a confirmed mutation attaches the redacted receipt
      // envelope to `_meta["openbuff.dev"].receipt` (cap.v3 tokens never
      // leave the core — toWireMutation drops afterContent/patch/editAnchor
      // and pins freshCapabilities to []).
      if (confirmedMutation !== undefined) {
        payload._meta = {
          'openbuff.dev': {
            receipt: buildReceiptEnvelope(confirmedMutation, {
              ...ctx,
              toolCallId: event.toolCallId,
            }),
          },
        }
      }
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
