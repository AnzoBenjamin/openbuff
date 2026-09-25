import { jsonToolResult } from '@codebuff/common/util/messages'
import {
  decodeJsonObjectString,
  normalizeStructuredOutputValue,
} from '@codebuff/common/tools/params/tool/set-output'

import { getAgentTemplate } from '../../../templates/agent-registry'
import { formatValueForError } from '../../../util/format-value'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type {
  AgentTemplate,
  Logger,
} from '@codebuff/common/types/agent-template'
import type { FetchAgentFromDatabaseFn } from '@codebuff/common/types/contracts/database'
import type { AgentState } from '@codebuff/common/types/session-state'

type ToolName = 'set_output'

/**
 * Hard ceiling on the serialized JSON text accepted in the set_output `data`
 * field. Oversized payloads historically slipped through decoding and vanished
 * downstream as transport-truncated garbage, so the oversized case is rejected
 * here — before any decode attempt — with explicit recovery guidance instead of
 * failing silently (M0-T3 sub-agent output durability).
 */
export const MAX_SET_OUTPUT_JSON_CHARS = 1_000_000

export const handleSetOutput = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>

  agentState: AgentState
  apiKey: string
  databaseAgentCache: Map<string, AgentTemplate | null>
  localAgentTemplates: Record<string, AgentTemplate>
  logger: Logger
  fetchAgentFromDatabase: FetchAgentFromDatabaseFn
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const { previousToolCallFinished, toolCall, agentState, logger } = params
  await previousToolCallFinished

  const rawOutput = toolCall.input as Record<string, unknown>
  // Reject oversized string payloads BEFORE any decode/parse attempt: a giant
  // inlined payload is far more likely to be cut off in transport than to be
  // intentionally encoded as one string, and the caller needs explicit bound +
  // recovery guidance instead of a generic malformed-JSON rejection.
  const rawOutputData = rawOutput?.data
  if (
    typeof rawOutputData === 'string' &&
    rawOutputData.length > MAX_SET_OUTPUT_JSON_CHARS
  ) {
    const oversizedMessage = `Output was not set because the set_output data string was ${rawOutputData.length} characters, exceeding the ${MAX_SET_OUTPUT_JSON_CHARS}-character payload limit; split the result across multiple smaller set_output calls, or persist it to a file and reference the path instead of inlining it.`
    // Recorded on agent state because this rejection also ends the turn
    // (set_output is in TOOLS_WHICH_WONT_FORCE_NEXT_STEP), so the loop's
    // missing-output retry is the only place that can report it to the model.
    agentState.lastSetOutputError = oversizedMessage
    return {
      output: jsonToolResult({ message: oversizedMessage }),
    }
  }
  const decodedData = decodeJsonObjectString(rawOutput?.data)
  if (typeof rawOutput?.data === 'string' && decodedData === rawOutput.data) {
    const baseGuidance =
      'Output was not set because data contained malformed or incomplete JSON text. Retry set_output with a real object value, not JSON.stringify(...). Keep findings and evidence concise enough to complete one tool call.'
    // Distinguish LIKELY TRANSPORT TRUNCATION from plain malformed JSON: a
    // payload ending mid-structure (open bracket or open string) almost
    // certainly lost its tail in transit, and the caller needs chunking /
    // smaller-payload guidance rather than only a formatting retry.
    const malformedJsonMessage = looksLikeTransportTruncation(rawOutput.data)
      ? `${baseGuidance} The payload appears to have been truncated in transport (partial) — send a smaller payload: split the result across multiple smaller set_output calls or persist it to a file and reference the path.`
      : baseGuidance
    // Recorded on agent state because this rejection also ends the turn
    // (set_output is in TOOLS_WHICH_WONT_FORCE_NEXT_STEP), so the loop's
    // missing-output retry is the only place that can report it to the model.
    agentState.lastSetOutputError = malformedJsonMessage
    return {
      output: jsonToolResult({ message: malformedJsonMessage }),
    }
  }
  const decodedOutput =
    decodedData === rawOutput?.data
      ? rawOutput
      : { ...rawOutput, data: decodedData }
  const decodedDataRecord =
    decodedOutput.data &&
    typeof decodedOutput.data === 'object' &&
    !Array.isArray(decodedOutput.data)
      ? (decodedOutput.data as Record<string, unknown>)
      : undefined
  const shouldNormalizeReviewerOutput =
    agentState.agentType?.toLowerCase().includes('reviewer') === true ||
    decodedOutput.family === 'reviewer' ||
    decodedDataRecord?.family === 'reviewer'

  let agentTemplate = null
  if (agentState.agentType) {
    agentTemplate = await getAgentTemplate({
      ...params,
      agentId: agentState.agentType,
    })
  }

  const decodedNestedOutputRecord =
    decodedOutput.output &&
    typeof decodedOutput.output === 'object' &&
    !Array.isArray(decodedOutput.output)
      ? (decodedOutput.output as Record<string, unknown>)
      : undefined
  const agentLooksLikeEditor =
    agentState.agentType?.toLowerCase().includes('editor') === true
  const nestedOutputHasEditorStatus =
    typeof decodedNestedOutputRecord?.status === 'string' &&
    (decodedNestedOutputRecord.status === 'completed' ||
      decodedNestedOutputRecord.status === 'partial' ||
      decodedNestedOutputRecord.status === 'blocked')
  const shouldTryNestedOutput =
    !!decodedNestedOutputRecord &&
    (agentLooksLikeEditor || nestedOutputHasEditorStatus)

  let finalOutput: unknown
  if (agentTemplate?.outputSchema) {
    const candidates: Array<{
      source:
        | 'output'
        | 'normalized-output'
        | 'data'
        | 'normalized-data'
        | 'nested-output'
        | 'normalized-nested-output'
      value: unknown
    }> = [{ source: 'output', value: decodedOutput }]
    if (shouldNormalizeReviewerOutput) {
      candidates.push({
        source: 'normalized-output',
        value: normalizeStructuredOutputValue(decodedOutput),
      })
    }
    if (decodedDataRecord) {
      candidates.push({ source: 'data', value: decodedDataRecord })
      if (shouldNormalizeReviewerOutput) {
        candidates.push({
          source: 'normalized-data',
          value: normalizeStructuredOutputValue(decodedDataRecord),
        })
      }
    }
    // Editor/repair-editor often wrap the receipt as `{ output: { status, ... } }`.
    // Prefer that nested object after top-level/data candidates fail schema parse.
    if (shouldTryNestedOutput && decodedNestedOutputRecord) {
      candidates.push({
        source: 'nested-output',
        value: decodedNestedOutputRecord,
      })
      if (shouldNormalizeReviewerOutput) {
        candidates.push({
          source: 'normalized-nested-output',
          value: normalizeStructuredOutputValue(decodedNestedOutputRecord),
        })
      }
    }
    const failures: Array<{
      source: (typeof candidates)[number]['source']
      error: unknown
    }> = []
    for (const candidate of candidates) {
      try {
        finalOutput = agentTemplate.outputSchema.parse(candidate.value)
        failures.length = 0
        break
      } catch (error) {
        failures.push({ source: candidate.source, error })
      }
    }
    if (failures.length > 0) {
      const bestFailure = failures.reduce((best, failure) =>
        getZodIssueCount(failure.error) < getZodIssueCount(best.error)
          ? failure
          : best,
      )
      const usedData = bestFailure.source.endsWith('data')
      const usedNestedOutput = bestFailure.source.includes('nested-output')
      const prefix = usedData
        ? 'Output validation error: Your output was found inside the `data` field but still failed validation. Please fix the reported fields and retry with native object/array values. Issues: '
        : usedNestedOutput
          ? 'Output validation error: Your output was found inside the nested `output` field but still failed validation. Please fix the reported fields and retry with native object/array values. Issues: '
          : 'Output validation error: Output failed to match the output schema and was ignored. Please fix the reported fields and retry with native object/array values. Issues: '
      const errorMessage = `${prefix}${bestFailure.error}\n\nOriginal output value:\n${formatValueForError(decodedOutput)}`
      logger.error(
        {
          outputShape: {
            keys: Object.keys(decodedOutput),
            dataType: Array.isArray(decodedOutput.data)
              ? 'array'
              : typeof decodedOutput.data,
          },
          agentType: agentState.agentType,
          agentId: agentState.agentId,
          validationFailures: failures,
          selectedFailureSource: bestFailure.source,
        },
        'set_output validation error',
      )
      agentState.lastSetOutputError = errorMessage
      return { output: jsonToolResult({ message: errorMessage }) }
    }
  } else {
    // When no outputSchema, use the data field if it is the only field
    // otherwise use the entire output object
    const keys = Object.keys(decodedOutput)
    const hasOnlyDataField = keys.length === 1 && keys[0] === 'data'
    finalOutput = hasOnlyDataField ? decodedOutput.data : decodedOutput
  }

  // Set the output (completely replaces previous output)
  agentState.output = finalOutput as Record<string, unknown>
  // A successful receipt supersedes any earlier rejection, so a later generic
  // missing-output retry can never quote a stale one.
  agentState.lastSetOutputError = undefined

  return { output: jsonToolResult({ message: 'Output set' }) }
}) satisfies CodebuffToolHandlerFunction<ToolName>

/**
 * Scans a raw JSON-text string for signs it was cut off mid-structure: tracks
 * string state by counting unescaped quotes (escape-aware, so a valid string
 * containing `\"` never toggles state) and tracks `{`/`[` depth outside
 * strings. A payload that ends inside an open string or with any open bracket
 * almost certainly lost its tail in transport rather than being deliberately
 * malformed JSON. Only ever called on strings that already failed to decode,
 * so it can never misclassify a valid document.
 */
function looksLikeTransportTruncation(text: string): boolean {
  let inString = false
  let escaped = false
  let depth = 0
  for (const char of text) {
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
    } else if (char === '{' || char === '[') {
      depth += 1
    } else if (char === '}' || char === ']') {
      depth -= 1
    }
  }
  return depth > 0 || inString
}

function getZodIssueCount(error: unknown): number {
  if (
    error != null &&
    typeof error === 'object' &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown }).issues)
  ) {
    return (error as { issues: unknown[] }).issues.length
  }
  return Infinity
}
