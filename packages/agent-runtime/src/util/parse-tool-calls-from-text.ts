import {
  startToolTag,
  endToolTag,
  toolNameParam,
} from '@codebuff/common/tools/constants'
import { parseJsonStringWithRepair } from '@codebuff/common/tools/params/utils'
import { escapeRegexForLiteral as escapeRegex } from '@codebuff/common/util/language-profiles'

// Module-level constant: building the extraction RegExp inside
// parseTextWithToolCalls allocated a fresh RegExp per assistant-text parse in
// the hot tool-call path. The tag literals are fixed at module load, so the
// pattern never varies between calls. matchAll requires lastIndex=0 before
// each run because a 'g'-flagged regex retains lastIndex across uses.
// Exported as the measurement seam for the CASE 2 after row in
// scripts/measure-perf-guards-baseline.ts: that row times THIS shipped pattern
// (after-rows-measure-mirrors / case2-after-row-local-pattern-mirror), never a
// local rebuild of it.
export const TOOL_EXTRACTION_PATTERN = new RegExp(
  `${escapeRegex(startToolTag)}([\\s\\S]*?)${escapeRegex(endToolTag)}`,
  'gs',
)

export type ParsedToolCallFromText = {
  type: 'tool_call'
  toolName: string
  input: Record<string, unknown>
}

export type ParsedTextSegment = {
  type: 'text'
  text: string
}

export type ParsedToolCallParseError = {
  type: 'parse_error'
  message: string
}

export type ParsedSegment =
  | ParsedToolCallFromText
  | ParsedTextSegment
  | ParsedToolCallParseError

/**
 * Parses text containing tool calls in the <codebuff_tool_call> XML format,
 * returning interleaved text and tool call segments in order.
 *
 * Example input:
 * ```
 * Some text before
 * <codebuff_tool_call>
 * {
 *   "cb_tool_name": "read_files",
 *   "paths": ["file.ts"]
 * }
 * </codebuff_tool_call>
 * Some text after
 * ```
 *
 * @param text - The text containing tool calls in XML format
 * @returns Array of segments (text and tool calls) in order of appearance
 */
export function parseTextWithToolCalls(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = []

  // Match <codebuff_tool_call>...</codebuff_tool_call> blocks
  TOOL_EXTRACTION_PATTERN.lastIndex = 0

  let lastIndex = 0

  for (const match of text.matchAll(TOOL_EXTRACTION_PATTERN)) {
    // Add any text before this tool call. The raw slice is preserved so leading
    // indentation / blank lines / fenced-code boundaries the model emitted are
    // not silently dropped from the transcript (audit shard-runtime-loop
    // parse-tool-calls-from-text.ts:62). Only the presence check keeps its
    // trim; the emitted segment is the untrimmed slice.
    if (match.index !== undefined && match.index > lastIndex) {
      const textBefore = text.slice(lastIndex, match.index)
      if (textBefore.trim() !== '') {
        segments.push({ type: 'text', text: textBefore })
      }
    }

    const jsonContent = match[1].trim()

    try {
      const parsed = parseJsonStringWithRepair(jsonContent)

      if (!isRecord(parsed)) {
        segments.push({
          type: 'parse_error',
          message:
            'Ignored codebuff_tool_call content because it did not parse to a JSON object.',
        })
      } else {
        const toolName = parsed[toolNameParam]

        if (typeof toolName === 'string') {
          // Remove the tool name param from the input
          const input = { ...parsed }
          delete input[toolNameParam]

          // Also remove cb_easp if present
          delete input['cb_easp']

          segments.push({
            type: 'tool_call',
            toolName,
            input,
          })
        } else {
          segments.push({
            type: 'parse_error',
            message:
              'Ignored codebuff_tool_call content because cb_tool_name was missing or not a string.',
          })
        }
      }
    } catch (err) {
      segments.push({
        type: 'parse_error',
        message: `Ignored codebuff_tool_call content because JSON parsing failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      })
    }

    // Update lastIndex to after this match
    if (match.index !== undefined) {
      lastIndex = match.index + match[0].length
    }
  }

  // Add any remaining text after the last tool call
  if (lastIndex < text.length) {
    const textAfter = text.slice(lastIndex)
    if (textAfter.trim() !== '') {
      segments.push({ type: 'text', text: textAfter })
    }
  }

  return segments
}

/**
 * Parses tool calls from text in the <codebuff_tool_call> XML format.
 * This is a convenience function that returns only tool calls (no text segments).
 *
 * @param text - The text containing tool calls in XML format
 * @returns Array of parsed tool calls with toolName and input
 */
export function parseToolCallsFromText(
  text: string,
): Omit<ParsedToolCallFromText, 'type'>[] {
  return parseTextWithToolCalls(text)
    .filter(
      (segment): segment is ParsedToolCallFromText =>
        segment.type === 'tool_call',
    )
    .map(({ toolName, input }) => ({ toolName, input }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
