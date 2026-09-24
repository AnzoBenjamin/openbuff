/**
 * Stateful stream XML parser that extracts tool calls from <codebuff_tool_call> XML
 * and filters them out of the text stream.
 *
 * Handles partial tags at chunk boundaries using a stateful approach.
 */

import { toolNameParam, toolXmlName } from '@codebuff/common/tools/constants'
import { parseJsonStringWithRepair } from '@codebuff/common/tools/params/utils'

// Use flexible tag matching without requiring specific newlines
const startToolTag = `<${toolXmlName}>`
const endToolTag = `</${toolXmlName}>`
const DEFAULT_MAX_TOOL_CALL_BUFFER_LENGTH = 64 * 1024

export type ParsedToolCall = {
  toolName: string
  input: Record<string, unknown>
}

export type StreamParserError = {
  code:
    | 'tool_call_buffer_exceeded'
    | 'invalid_tool_call_json'
    | 'missing_tool_name'
  message: string
  bufferedLength?: number
  maxBufferLength?: number
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
        // Overflow recovery: the unterminated payload exceeded the budget.
        // Stay insideToolCall purely for scoping but enter discard mode so the
        // eventual end tag is consumed SILENTLY — the buffered garbage is never
        // parsed (that would emit a bogus invalid_tool_call_json error) and
        // never leaks into the visible text stream. A trailing partial end tag
        // survives as the discard-mode carry so an end tag split exactly across
        // this boundary is still fully consumed.
        errors.push({
          code: 'tool_call_buffer_exceeded',
          message: `Discarded unterminated ${toolXmlName} content after ${bufferedLength} buffered characters (limit ${state.maxToolCallBufferLength}). Discarding content until the end tag.`,
          bufferedLength,
          maxBufferLength: state.maxToolCallBufferLength,
        })
        state.discardingUntilEndTag = true
        const partialEnd = findPartialTagMatch(scan, endToolTag)
        state.buffer = partialEnd > 0 ? scan.slice(-partialEnd) : ''
        pending = ''
        continue
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
 * Parse the JSON content inside a tool call tag.
 */
function parseToolCallContent(content: string): {
  toolCall?: ParsedToolCall
  error?: StreamParserError
} {
  const normalized = normalizeToolCallJsonContent(content)
  if (normalized === null) {
    return {
      error: {
        code: 'invalid_tool_call_json',
        message: `Ignored empty ${toolXmlName} content.`,
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
        },
      }
    }

    const toolName = parsed[toolNameParam]

    if (typeof toolName !== 'string') {
      return {
        error: {
          code: 'missing_tool_name',
          message: `Ignored ${toolXmlName} content because ${toolNameParam} was missing or not a string.`,
        },
      }
    }

    // Remove internal params from the input
    const input = { ...parsed }
    delete input[toolNameParam]
    delete input['cb_easp'] // endsAgentStepParam

    return { toolCall: { toolName, input } }
  } catch (err) {
    return {
      error: {
        code: 'invalid_tool_call_json',
        message: `Ignored ${toolXmlName} content because JSON parsing failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
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
