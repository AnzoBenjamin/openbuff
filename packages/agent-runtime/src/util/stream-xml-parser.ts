/**
 * Stateful stream XML parser that extracts tool calls from <codebuff_tool_call> XML
 * and filters them out of the text stream.
 *
 * Handles partial tags at chunk boundaries using a stateful approach.
 */

import { toolXmlName } from '@codebuff/common/tools/constants'
import {
  MAX_REPAIRABLE_JSON_LENGTH,
  PAYLOAD_TRUNCATED_ERROR_CODE,
  parseJsonStringWithRepair,
} from '@codebuff/common/tools/params/utils'
import {
  recoverTruncatedJsonObjectFields,
} from '@codebuff/common/util/model-payload-recovery'

import {
  MISSING_TOOL_NAME_REASON,
  resolveToolName,
  stripToolNameKeys,
} from './tool-name-key'

// Use flexible tag matching without requiring specific newlines
const startToolTag = `<${toolXmlName}>`
const endToolTag = `</${toolXmlName}>`
const DEFAULT_MAX_TOOL_CALL_BUFFER_LENGTH = 64 * 1024

/**
 * Salvage ceiling for overflowing unterminated tool-call payloads: instead of
 * destroying a JSON-shaped payload at the configured 64 KiB buffer limit, the
 * parser keeps buffering up to this bounded 1 MiB ceiling (imported from
 * common/src/tools/params/utils.ts so ONE constant governs both the recovery
 * helpers' repair bound and the stream parser's salvage ceiling) and attempts
 * one bounded salvage of the modeled bytes at the overflow event.
 */
export const MAX_TOOL_CALL_SALVAGE_LENGTH = MAX_REPAIRABLE_JSON_LENGTH

/**
 * Marker appended when a recoveredPayload exceeds the salvage budget, built
 * from PAYLOAD_TRUNCATED_ERROR_CODE so the same payload_truncated code that
 * common/src/tools/params/utils.ts uses for transport-truncated tool
 * arguments also labels the capped salvaged payload here.
 */
export const RECOVERED_PAYLOAD_TRUNCATION_MARKER = ` [${PAYLOAD_TRUNCATED_ERROR_CODE}]`

/**
 * Caps a JSON-stringified recovered payload to the same salvage budget the
 * recovery scan respects. Content at or under MAX_TOOL_CALL_SALVAGE_LENGTH
 * characters is returned verbatim; longer content keeps the first 1 MiB and
 * appends the payload_truncated-style marker plus a count of the dropped
 * characters, so the error message cannot balloon past the budget.
 */
export function toBoundedRecoveredPayload(payload: string): string {
  if (payload.length <= MAX_TOOL_CALL_SALVAGE_LENGTH) {
    return payload
  }
  const truncated = payload.length - MAX_TOOL_CALL_SALVAGE_LENGTH
  return `${payload.slice(0, MAX_TOOL_CALL_SALVAGE_LENGTH)}${RECOVERED_PAYLOAD_TRUNCATION_MARKER} [${truncated} chars truncated]`
}

export type ParsedToolCall = {
  toolName: string
  input: Record<string, unknown>
}

export type StreamParserError = {
  code:
    | 'tool_call_buffer_exceeded'
    | 'tool_call_unterminated_eof'
    | 'invalid_tool_call_json'
    | 'missing_tool_name'
  message: string
  bufferedLength?: number
  maxBufferLength?: number
  /**
   * Bounded excerpt of the raw tool-call bytes that failed to parse, quoted
   * back to the model at the emission boundaries so it can diff its broken
   * JSON instead of repeating the identical malformed shape
   * (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
   */
  rawExcerpt?: string
  /**
   * Salvaged survivor of a tool_call_buffer_exceeded overflow: the
   * JSON-stringified complete top-level fields recovered from the
   * unterminated payload (recoverTruncatedJsonObjectFields, no
   * reviewer-receipt gate), or absent when nothing usable could be salvaged.
   * Capped to the salvage budget with the ` [payload_truncated]`-style marker
   * derived from PAYLOAD_TRUNCATED_ERROR_CODE so downstream edit-transaction
   * recovery helpers can rebuild without unbounded error growth.
   */
  recoveredPayload?: string
}

export type StreamParserState = {
  /**
   * Carry-over bytes the next chunk may still affect. Outside a tool call this
   * is at most a partial tag suffix, so it is bounded by
   * `MAX_TAG_TAIL_CARRYOVER`. Inside a tool call it holds unterminated
   * tool-call payload, bounded by `maxToolCallBufferLength`.
   */
  buffer: string
  /** Whether we're currently inside a tool call tag */
  insideToolCall: boolean
  /** Maximum buffered XML tool-call content before truncating with an error */
  maxToolCallBufferLength: number
  /**
   * After a tool_call_buffer_exceeded overflow: stay "inside" the tag purely
   * for scanning purposes but DISCARD all content (including the eventual end
   * tag) until the end tag is seen, so a later </codebuff_tool_call> never
   * leaks into the visible text stream and one oversized call cannot corrupt
   * the framing of the rest of the output.
   */
  discardingUntilEndTag: boolean
}

export type ParseResult = {
  /** Filtered text with tool call XML removed */
  filteredText: string
  /** Tool calls extracted from this chunk */
  toolCalls: ParsedToolCall[]
  /** Structured parser errors encountered while extracting tool calls */
  errors: StreamParserError[]
}

/**
 * Hard cap on `rawExcerpt`: raw tool-call bytes are model-controlled and a
 * single 64 KiB overflow must not balloon the error message or the
 * transcript, so every excerpt is hard-capped at 500 characters
 * (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
 */
export const MAX_TOOL_CALL_RAW_EXCERPT_LENGTH = 500

/**
 * Bounded excerpt of raw tool-call bytes for error reporting. Content up to
 * `MAX_TOOL_CALL_RAW_EXCERPT_LENGTH` characters is returned verbatim; longer
 * content keeps the first and last 250 characters around a
 * `…[N chars truncated]…` marker (N = length − 500), so both the opening and
 * the failure point of a large payload stay visible.
 */
export function toBoundedRawExcerpt(content: string): string {
  if (content.length <= MAX_TOOL_CALL_RAW_EXCERPT_LENGTH) {
    return content
  }
  const half = MAX_TOOL_CALL_RAW_EXCERPT_LENGTH / 2
  const truncated = content.length - MAX_TOOL_CALL_RAW_EXCERPT_LENGTH
  const head = content.slice(0, half)
  const tail = content.slice(-half)
  return `${head}…[${truncated} chars truncated]…${tail}`
}

/**
 * Carry-over budget: only this many trailing bytes near the scanned end can
 * still host a tag boundary split across chunk boundaries, so beyond this
 * window every byte is committed (emitted, or retained as tool-call payload)
 * and never rescanned. Tag literals are fixed, so this is a module constant
 * and the per-chunk rescan window — outside a call for the start tag, inside
 * a call for the end tag (in-call-payload-replayed-per-chunk / RF-11) — stays
 * O(tag length), not O(payload).
 */
const MAX_TAG_TAIL_CARRYOVER =
  Math.max(startToolTag.length, endToolTag.length) - 1

/**
 * One bounded salvage-error emit per stream: recoverTruncatedJsonObjectFields
 * is O(buffer) per attempt and the first SUCCESSFUL recovery is the one that
 * carries the survivor bytes downstream, so this commit records that a
 * salvaged error was already emitted (and suppresses per-chunk rescans and
 * duplicate salvage errors) while the ceiling gate keeps attempts bounded.
 * Weak keys: the set itself never accumulates state across streams.
 */
const salvageAttemptedStates = new WeakSet<StreamParserState>()

/**
 * Creates initial parser state
 */
export function createStreamParserState(options?: {
  maxToolCallBufferLength?: number
}): StreamParserState {
  return {
    buffer: '',
    insideToolCall: false,
    discardingUntilEndTag: false,
    maxToolCallBufferLength:
      options?.maxToolCallBufferLength ?? DEFAULT_MAX_TOOL_CALL_BUFFER_LENGTH,
  }
}

/**
 * Whether the buffered tool-call payload starts like a JSON object, allowing
 * leading whitespace, so the overflow branch can raise the effective cap for
 * JSON-shaped payloads. Bounded prefix scan instead of a full trimStart
 * copy: only shapes establishable within the first characters matter, and a
 * payload with more leading whitespace than the scan window keeps today's
 * exact discard behavior (never becomes salvage-eligible).
 */
function isJsonShapedBuffer(content: string): boolean {
  const prefixLimit = Math.min(content.length, 64)
  for (let index = 0; index < prefixLimit; index++) {
    const char = content[index]
    if (char === '{') return true
    if (char !== undefined && !/\s/.test(char)) return false
  }
  return false
}

/**
 * Parses a stream chunk, extracting tool calls and filtering out the XML.
 *
 * Scan budget (in-call-payload-replayed-per-chunk / RF-11): every scan covers
 * at most the MAX_TAG_TAIL_CARRYOVER tail window of already-buffered bytes
 * plus the fresh chunk — never the whole accumulated payload. Outside a call
 * the carry is only a partial-tag suffix; inside a call the unterminated
 * payload is still retained in `state.buffer` (it is the eventual tool-call
 * content) but only its tag-tail window takes part in the end-tag scan, so
 * per-chunk work stays linear in chunk size and total work stays linear in
 * payload size.
 *
 * @param chunk - The incoming text chunk
 * @param state - Mutable parser state (updated in place)
 * @returns Filtered text and any extracted tool calls
 */
export function parseStreamChunk(
  chunk: string,
  state: StreamParserState,
): ParseResult {
  if (!chunk) {
    return { filteredText: '', toolCalls: [], errors: [] }
  }

  let filteredText = ''
  const toolCalls: ParsedToolCall[] = []
  const errors: StreamParserError[] = []

  // Fresh bytes not yet scanned/committed. `state.buffer` holds the carry:
  // outside a call a partial-tag suffix (bounded by MAX_TAG_TAIL_CARRYOVER);
  // inside a call the still-unterminated tool-call payload, whose already
  // scanned body is never replayed — only its tag-tail window joins the next
  // scan (the overlap with the fresh chunk is scanned exactly once more).
  let pending = chunk

  while (pending.length > 0) {
    if (state.insideToolCall) {
      if (state.discardingUntilEndTag) {
        // Overflow recovery (active): the retained content is garbage and must
        // NOT be parsed (that would emit a bogus invalid_tool_call_json error)
        // nor leaked as filteredText. Only a partial-end-tag suffix is carried
        // so an end tag split across chunk boundaries is still fully consumed,
        // and the end tag is then consumed silently. The buffer-length check
        // MUST NOT fire in this state: a split '</codebuff_' prefix is itself
        // longer than a tiny maxToolCallBufferLength, and re-entering the
        // overflow branch would reset discardingUntilEndTag=false and leak the
        // remainder of the split tag into the text stream.
        const scan = state.buffer + pending
        const endIndex = scan.indexOf(endToolTag)
        if (endIndex !== -1) {
          pending = scan.slice(endIndex + endToolTag.length)
          state.buffer = ''
          state.insideToolCall = false
          state.discardingUntilEndTag = false
        } else {
          const partialEnd = findPartialTagMatch(scan, endToolTag)
          state.buffer = partialEnd > 0 ? scan.slice(-partialEnd) : ''
          pending = ''
        }
        continue
      }

      // Inside a tool call: look for the end tag, scanning ONLY the tag-tail
      // window of the accumulated payload plus the fresh bytes. Every byte
      // before the tail window has already been scanned end-to-end and cannot
      // start a complete end tag, so dropping it from the rescan loses nothing
      // (in-call-payload-replayed-per-chunk: the pre-fix shape re-concatenated
      // and rescanned the ENTIRE payload with each chunk).
      const tail = state.buffer.slice(-MAX_TAG_TAIL_CARRYOVER)
      const scan = tail + pending
      const endIndex = scan.indexOf(endToolTag)

      if (endIndex !== -1) {
        // Found end tag - rebuild the payload once from the retained buffer
        // and the scanned prefix, then parse it.
        const toolCallContent =
          state.buffer.slice(0, state.buffer.length - tail.length) +
          scan.slice(0, endIndex)
        const parsedToolCall = parseToolCallContent(toolCallContent)
        if (parsedToolCall.toolCall) {
          toolCalls.push(parsedToolCall.toolCall)
        }
        if (parsedToolCall.error) {
          errors.push(parsedToolCall.error)
        }

        pending = scan.slice(endIndex + endToolTag.length)
        state.buffer = ''
        state.insideToolCall = false
        continue
      }

      const bufferedLength = state.buffer.length + pending.length
      if (bufferedLength > state.maxToolCallBufferLength) {
        // Invariant: the buffer limit bounds BUFFERED (unterminated) bytes
        // only. A call whose end tag is found in the same scan (the endIndex
        // branch above) parses and is emitted regardless of size — the limit
        // never fires for a complete call, only for one still waiting for
        // its closing tag.
        // Salvage-first overflow handling: a JSON-shaped unterminated payload
        // gets a raised, BOUNDED effective cap — the 1 MiB
        // MAX_REPAIRABLE_JSON_LENGTH salvage ceiling imported from
        // common/src/tools/params/utils.ts — so a large tool call whose
        // closing tag is merely slow to arrive keeps buffering (and parses
        // normally when the end tag arrives below the ceiling) instead of
        // being destroyed at the configured buffer limit. Non-JSON-shaped
        // content and content above the salvage ceiling keep today's exact
        // discard behavior, so growth stays strictly bounded.
        const salvageCommitted = salvageAttemptedStates.has(state)
        const underSalvageCeiling =
          bufferedLength <= MAX_TOOL_CALL_SALVAGE_LENGTH
        let discard = true

        const discardOverflow = (): void => {
          // Full O(payload) concat only when the content is actually needed
          // (excerpt capture BEFORE the discard reset destroys it); the
          // keep-buffering paths never pay for it.
          const bufferedContent = state.buffer + pending
          // Overflow recovery: stay insideToolCall purely for scoping but
          // enter discard mode so the eventual end tag is consumed SILENTLY —
          // the buffered garbage is never parsed (that would emit a bogus
          // invalid_tool_call_json error) and never leaks into the visible
          // text stream. A trailing partial end tag survives as the
          // discard-mode carry so an end tag split exactly across this
          // boundary is still fully consumed.
          // Capture the bounded excerpt from the buffered payload BEFORE the
          // discard reset below destroys it: once `state.buffer` is reduced
          // to the partial-tag carry the payload is unrecoverable, and the
          // excerpt is the only surviving evidence of what the model emitted
          // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
          errors.push({
            code: 'tool_call_buffer_exceeded',
            message: `Discarded unterminated ${toolXmlName} content after ${bufferedLength} buffered characters (limit ${state.maxToolCallBufferLength}). Discarding content until the end tag.`,
            bufferedLength,
            maxBufferLength: state.maxToolCallBufferLength,
            rawExcerpt: toBoundedRawExcerpt(bufferedContent),
          })
          state.discardingUntilEndTag = true
          const partialEnd = findPartialTagMatch(scan, endToolTag)
          state.buffer = partialEnd > 0 ? scan.slice(-partialEnd) : ''
          pending = ''
        }

        if (underSalvageCeiling) {
          // JSON-shape check reads only the bounded payload head —
          // state.buffer holds every in-call byte seen so far, so its head
          // IS the payload head — never an O(payload) concat just to test
          // the first character.
          const payloadHead = state.buffer.length > 0 ? state.buffer : pending
          if (salvageCommitted) {
            // A salvaged error was already emitted for this stream: keep
            // buffering with no per-chunk payload rescan; growth stays
            // bounded by the ceiling (a later scan past it discards below).
            discard = false
          } else if (isJsonShapedBuffer(payloadHead)) {
            // ONE bounded O(payload) salvage scan per overflow event, only
            // while under the ceiling. The ungated
            // recoverTruncatedJsonObjectFields (no reviewer-receipt
            // requirement) is what makes a truncated edit_transaction
            // payload recoverable; the salvageAttemptedStates commit on the
            // successful path below suppresses DUPLICATE salvage errors,
            // not the keep-buffering on the unsuccessful one.
            const bufferedContent = state.buffer + pending
            const recovered = recoverTruncatedJsonObjectFields(bufferedContent)
            if (recovered !== undefined) {
              // At least one complete top-level field survived the
              // truncated payload: emit the existing
              // tool_call_buffer_exceeded error code plus the
              // JSON-stringified recovered content (capped to the same
              // salvage budget with the payload_truncated-style marker) so
              // downstream edit-transaction recovery helpers can rebuild.
              salvageAttemptedStates.add(state)
              errors.push({
                code: 'tool_call_buffer_exceeded',
                message: `Salvaged unterminated ${toolXmlName} content after ${bufferedLength} buffered characters (limit ${state.maxToolCallBufferLength}) into recoveredPayload; continuing to buffer until the end tag or the ${MAX_TOOL_CALL_SALVAGE_LENGTH}-character salvage ceiling.`,
                bufferedLength,
                maxBufferLength: state.maxToolCallBufferLength,
                rawExcerpt: toBoundedRawExcerpt(bufferedContent),
                recoveredPayload: toBoundedRecoveredPayload(
                  JSON.stringify(recovered),
                ),
              })
              discard = false
            }
            // recovered === undefined: KEEP BUFFERING, never a permanent
            // discard (salvage-first-overflow-discard). A JSON-shaped payload
            // whose buffered prefix has not yet closed any complete top-level
            // field — e.g. a large edit payload whose big string field opens
            // before cb_tool_name closes — used to be destroyed at the FIRST
            // overflow event purely because of field ordering and the chunk
            // boundary, while the identical payload with cb_tool_name first
            // was recoverable. Instead, later overflow events re-attempt
            // salvage and the end tag (or EOF handling) decides with the
            // full payload. Costs stay bounded: each attempt is
            // O(buffer) and only runs on overflow events under the 1 MiB
            // ceiling, never per unterminated chunk otherwise.
            discard = false
          }
        }

        if (discard) {
          discardOverflow()
          continue
        }
      }

      // No end tag yet: retain the payload — it is the eventual tool-call
      // content — and wait for more bytes. The already-scanned body is only
      // appended (never rescanned); the next scan starts at the tail window.
      state.buffer += pending
      pending = ''
      continue
    }

    // Outside a tool call: look for the start tag. The carry holds only a
    // partial-tag suffix, so anything beyond the tag-length window is
    // already-committed filtered text and may be dropped from the rescan.
    if (state.buffer.length > MAX_TAG_TAIL_CARRYOVER) {
      state.buffer = state.buffer.slice(-MAX_TAG_TAIL_CARRYOVER)
    }
    const scan = state.buffer + pending
    state.buffer = ''

    const startIndex = scan.indexOf(startToolTag)
    if (startIndex !== -1) {
      // Found start tag - emit text before it, then enter tool call
      filteredText += scan.slice(0, startIndex)
      pending = scan.slice(startIndex + startToolTag.length)
      state.insideToolCall = true
    } else {
      // No start tag. A suffix no longer than MAX_TAG_TAIL_CARRYOVER could
      // still be a partial start tag split across chunk boundaries; emit
      // everything before that suffix and carry only the suffix forward.
      const partialStart = findPartialTagMatch(scan, startToolTag)
      if (partialStart > 0) {
        filteredText += scan.slice(0, -partialStart)
        state.buffer = scan.slice(-partialStart)
      } else {
        filteredText += scan
      }
      pending = ''
    }
  }

  return { filteredText, toolCalls, errors }
}

/**
 * Finalize the parser state at end of stream.
 *
 * Closes the silent end-of-stream gaps: an unterminated
 * <codebuff_tool_call> whose closing tag never arrives used to be dropped
 * with ZERO feedback unless it overflowed the buffer (only then
 * tool_call_buffer_exceeded fired), and the outside-call partial-tag carry
 * vanished at EOF
 * (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
 *
 * - Inside a call, not discarding: report one tool_call_unterminated_eof
 *   error carrying the buffered length and a bounded excerpt of the payload.
 *   The payload must NOT leak as filteredText — it is reported dropped
 *   tool-call content, never prose.
 * - Inside a call while discarding after a buffer overflow: the overflow
 *   already reported this content, so emit NO duplicate error and leak
 *   nothing — just reset.
 * - Outside a call with a held partial-tag carry: flush it as filteredText
 *   so real prose bytes like a trailing '<' do not vanish at EOF.
 *
 * @param state - Mutable parser state (reset in place)
 * @returns Final filtered text (only the outside-call carry) and any errors
 */
export function finalizeStreamParserState(state: StreamParserState): {
  filteredText: string
  errors: StreamParserError[]
} {
  if (state.insideToolCall) {
    const errors: StreamParserError[] = []
    if (!state.discardingUntilEndTag) {
      // Capture the bounded excerpt BEFORE the reset below destroys the
      // buffered payload: it is the only surviving evidence of what the
      // model emitted, and without an EOF report the dropped call was
      // indistinguishable from a successful one
      // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
      errors.push({
        code: 'tool_call_unterminated_eof',
        message: `Discarded unterminated ${toolXmlName} content at end of stream after ${state.buffer.length} buffered characters: the response ended before the closing tag.`,
        bufferedLength: state.buffer.length,
        rawExcerpt: toBoundedRawExcerpt(state.buffer),
      })
    }
    // Reset in both inside-call cases: the buffered payload is dropped
    // tool-call content, never prose, so it never returns as filteredText.
    // In discard mode the tool_call_buffer_exceeded overflow already
    // reported it, hence no duplicate error above.
    state.buffer = ''
    state.insideToolCall = false
    state.discardingUntilEndTag = false
    return { filteredText: '', errors }
  }

  // Outside a call the buffer holds a partial-tag suffix of real prose
  // bytes; flush it so a trailing '<' does not vanish at EOF.
  if (state.buffer) {
    const filteredText = state.buffer
    state.buffer = ''
    return { filteredText, errors: [] }
  }

  return { filteredText: '', errors: [] }
}

/**
 * Parse the JSON content inside a tool call tag.
 */
function parseToolCallContent(content: string): {
  toolCall?: ParsedToolCall
  error?: StreamParserError
} {
  // Bounded excerpt of the raw block, captured once so every error site can
  // quote the offending bytes back to the model: without them the model
  // cannot diff its broken JSON and repeats the identical malformed shape
  // (.agents/sessions/degeneration-followups-2026-10/findings/error-feedback-loop.md).
  const rawExcerpt = toBoundedRawExcerpt(content)
  const normalized = normalizeToolCallJsonContent(content)
  if (normalized === null) {
    return {
      error: {
        code: 'invalid_tool_call_json',
        message: `Ignored empty ${toolXmlName} content.`,
        rawExcerpt,
      },
    }
  }

  try {
    // Single-parse hot path (tool-call-json-parsed-twice): when the candidate
    // scan already produced the JSON object, reuse it instead of parsing the
    // identical bytes again. Only the no-candidate fallback parses here.
    const parsed = normalized.parsed ?? parseToolCallJson(normalized.text)
    if (!isRecord(parsed)) {
      return {
        error: {
          code: 'invalid_tool_call_json',
          message: `Ignored ${toolXmlName} content because it did not parse to a JSON object.`,
          rawExcerpt,
        },
      }
    }

    // Alias-aware resolution, shared with the text parser: models respell the
    // injected canonical key constantly, so a block whose name arrived as
    // tool_name / toolName / tool / name is a legitimate call, not a reason to
    // drop it (the streaming path used to discard exactly those calls).
    const resolved = resolveToolName(parsed)

    if (resolved === undefined) {
      return {
        error: {
          code: 'missing_tool_name',
          message: `Ignored ${toolXmlName} content because ${MISSING_TOOL_NAME_REASON}`,
          rawExcerpt,
        },
      }
    }

    const input = stripToolNameKeys(parsed, resolved)

    return { toolCall: { toolName: resolved.toolName, input } }
  } catch (err) {
    return {
      error: {
        code: 'invalid_tool_call_json',
        message: `Ignored ${toolXmlName} content because JSON parsing failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        rawExcerpt,
      },
    }
  }
}

function parseToolCallJson(normalized: string): unknown {
  return parseJsonStringWithRepair(normalized)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

type NormalizedToolCallJson = {
  text: string
  /**
   * The JSON object already parsed out of `text` by the candidate scan, when
   * there was one — parseToolCallContent reuses it (tool-call-json-parsed-twice).
   */
  parsed?: Record<string, unknown>
}

function normalizeToolCallJsonContent(
  content: string,
): NormalizedToolCallJson | null {
  let normalized = content.trim()
  if (!normalized) {
    return null
  }

  // Models often wrap the JSON in a markdown fence even though the XML tag is
  // already the delimiter. Strip common fences before parsing.
  const fenceMatch = normalized.match(
    /^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i,
  )
  if (fenceMatch) {
    normalized = fenceMatch[1].trim()
  }

  // If the model includes explanatory text inside the XML tag, keep the JSON
  // object itself. A single balanced scan from the FIRST '{' is not enough:
  // in "use {x} like this: {\"cb_tool_name\": ...}" the first balanced group
  // is the prose brace token '{x}', not the payload. So try every balanced
  // candidate from each '{' in document order and pick the FIRST candidate
  // that actually parses as a JSON object; when none does, fall back to the
  // conservative first/last slice.
  const jsonCandidate = extractFirstJsonObjectCandidate(normalized)
  if (jsonCandidate !== undefined) {
    return { text: jsonCandidate.candidate, parsed: jsonCandidate.parsed }
  }

  return { text: normalized }
}

/**
 * Extracted budget for the candidate loop in normalizeToolCallJsonContent:
 * one pre-validation parse per candidate must never turn a pathological
 * payload into an unbounded scan — cap the number of '{' candidates tried at
 * 32, which is already far beyond any realistic prose+payload mix.
 *
 * Worst-case bound: a candidate's balanced scan can walk the remaining
 * payload to its very end before giving up, so pathological input costs at
 * most `maxCandidates` full-payload balanced scans — O(maxCandidates·N) —
 * which is 32·N in production.
 */
const MAX_JSON_CANDIDATES = 32

/**
 * A balanced '{...}' candidate that parses to a JSON object, together with
 * that parsed object so callers never re-parse the identical bytes
 * (tool-call-json-parsed-twice).
 */
export type JsonObjectCandidate = {
  candidate: string
  parsed: Record<string, unknown>
}

/**
 * Returns the first balanced '{...}' span in `content` whose bytes parse to a
 * real JSON object — with the object already parsed — or `undefined` when no
 * candidate qualifies (including when there is no '{' at all).
 *
 * `maxCandidates` bounds how many '{' candidates are tried; it exists as the
 * measurement seam for the CASE 4d before row in
 * scripts/measure-perf-guards-baseline.ts (the pre-cap unbounded loop shape).
 * Production callers use the shipped MAX_JSON_CANDIDATES budget.
 */
export function extractFirstJsonObjectCandidate(
  content: string,
  maxCandidates: number = MAX_JSON_CANDIDATES,
): JsonObjectCandidate | undefined {
  let candidates = 0
  for (
    let open = content.indexOf('{');
    open !== -1;
    open = content.indexOf('{', open + 1)
  ) {
    if (candidates >= maxCandidates) break
    candidates++
    const span = findBalancedObjectEnd(content, open)
    if (span.end === -1) continue
    const candidate = content.slice(open, span.end + 1)
    try {
      // repairMalformedJsonSeparators can only rewrite out-of-string commas,
      // so a comma-free span never changes under repair: skip its repair pass
      // (and the re-parse it can trigger) outright (tool-call-json-parsed-twice).
      const parsed = span.hasOutOfStringComma
        ? parseJsonStringWithRepair(candidate)
        : JSON.parse(candidate)
      if (isRecord(parsed)) return { candidate, parsed }
    } catch {
      // Not valid JSON by itself; try the next balanced candidate.
    }
  }
  return undefined
}

/**
 * Returns the index of the '}' that closes the outer JSON object that starts
 * at `openBrace` (tracking strings/escapes so braces inside string literals
 * and escape sequences do not terminate the object early) along with whether
 * the span contains an out-of-string ',' — the only characters
 * repairMalformedJsonSeparators can rewrite, so callers can skip its repair
 * pass for comma-free spans. `end` is -1 when the object never closes
 * (unbalanced content).
 */
function findBalancedObjectEnd(
  text: string,
  openBrace: number,
): { end: number; hasOutOfStringComma: boolean } {
  let depth = 0
  let inString = false
  let escaped = false
  let hasOutOfStringComma = false
  for (let index = openBrace; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === ',') {
      hasOutOfStringComma = true
      continue
    }
    if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) return { end: index, hasOutOfStringComma }
    }
  }
  return { end: -1, hasOutOfStringComma }
}

/**
 * Find if the end of `text` is a partial match for the beginning of `tag`.
 * Returns the length of the overlap, or 0 if no overlap.
 */
function findPartialTagMatch(text: string, tag: string): number {
  const maxOverlap = Math.min(text.length, tag.length - 1)

  for (let len = maxOverlap; len > 0; len--) {
    const suffix = text.slice(-len)
    const prefix = tag.slice(0, len)
    if (suffix === prefix) {
      return len
    }
  }

  return 0
}
