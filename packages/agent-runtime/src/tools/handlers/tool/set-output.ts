import {
  decodeJsonObjectString,
  normalizeStructuredOutputValue,
} from '@codebuff/common/tools/params/tool/set-output'
import { detectTransportTruncation } from '@codebuff/common/tools/params/utils'
import { jsonToolResult } from '@codebuff/common/util/messages'
import {
  isReceiptDowngradeBlocked,
  isReceiptShape,
  MODEL_PAYLOAD_JSON_CHAR_LIMIT,
  unwrapArbitraryEnvelope,
} from '@codebuff/common/util/model-payload-recovery'

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
export const MAX_SET_OUTPUT_JSON_CHARS = MODEL_PAYLOAD_JSON_CHAR_LIMIT

/**
 * Ack returned when a receipt-bearing reviewer's second set_output call carries
 * a degenerate, verdict-less payload (typically the `{ message: 'Output set' }
 * tool ACK echoed back as a payload). The existing receipt is intentionally NOT
 * overwritten, and this ack teaches the model the difference between the
 * tool-confirmation and a receipt payload so it does not repeat the echo.
 */
export const RECEIPT_GUARD_ACK =
  'Your structured receipt was already published successfully; this additional set_output call was ignored because it did not carry a full receipt (verdict + snapshotFingerprint). Do not echo the {"message":"Output set"} confirmation back as a payload. If your review outcome changed, re-emit the COMPLETE receipt object (every required schema field).'

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

  const envelopeOutput = toolCall.input as Record<string, unknown>
  // Unwrap a model-supplied keyless JSON envelope UP FRONT: some models deliver
  // the receipt as `{ jsonKey: 'output', value: JSON.stringify(receipt) }` (or
  // `value` as a native receipt). When this envelope is not decoded here, it
  // falls through to schema validation as-is and FAILS (jsonKey-envelope
  // rejected at schema validation → retry loop; observed 2026-10-19 on
  // compatibility-reviewer), so the model repeats set_output and often
  // degenerates into a bare `{ message: 'Output set' }` echo. Decoding the
  // envelope first makes the FIRST call succeed and avoids the retry loop.
  const unwrappedEnvelope =
    unwrapArbitraryEnvelope(envelopeOutput)
  const rawOutput: Record<string, unknown> =
    unwrappedEnvelope ?? envelopeOutput

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
    const malformedJsonMessage = detectTransportTruncation(rawOutput.data)
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

  // Fail closed when an agent type is declared but the template could not be
  // resolved: the output schema is then UNKNOWN, and the passthrough `else`
  // branch below would store whatever arrived with NO validation at all. That
  // is exactly how a reviewer-family child publishes a verdict-less receipt —
  // the receipt is never validated on the way in, the gate's verdict guard then
  // classifies it `schema_invalid`, and the parent re-reviews forever. A
  // template that RESOLVES but simply declares no outputSchema stays a
  // legitimate passthrough (the `else` branch below); only the unresolvable
  // case is rejected here. The check sits immediately after resolution so it
  // covers every downstream validation path.
  if (agentState.agentType && !agentTemplate) {
    const unresolvableTemplateMessage = `Output was NOT stored because the agent template for agent type "${agentState.agentType}" could not be resolved, so the output schema is unknown. This is a runtime/configuration problem (a missing or unregistered agent template), not a problem with your payload: re-emitting set_output with different fields will not fix it. Report that the agent template could not be resolved so the caller can repair the agent registration/resolution path.`
    // Recorded on agent state because this rejection also ends the turn
    // (set_output is in TOOLS_WHICH_WONT_FORCE_NEXT_STEP), so the loop's
    // missing-output retry is the only place that can report it to the model.
    agentState.lastSetOutputError = unresolvableTemplateMessage
    logger.error(
      { agentType: agentState.agentType, agentId: agentState.agentId },
      'set_output could not validate its payload because the agent template for the declared agent type could not be resolved',
    )
    return {
      output: jsonToolResult({ message: unresolvableTemplateMessage }),
    }
  }

  // Receipt-overwrite guard (Phase 3): the decision is delegated to the shared
  // `isReceiptDowngradeBlocked` helper in model-payload-recovery.ts so any
  // consumer can adopt the same policy. The policy: a reviewer-family child's
  // verdict-less follow-up — usually the `{ message: 'Output set' }` tool ACK
  // echoed back as a payload — cannot destroy a published verdict-bearing
  // receipt. Detection stays content-addressed (isReceiptShape), never keyed
  // on envelope/field names. A full receipt replacement (both sides
  // receipt-shaped) still replaces — corrections keep working; non-reviewer
  // agents keep the exact replace-always behavior.
  // Evaluated on the RAW decoded payload and BEFORE outputSchema validation on
  // purpose: a degenerate echo can never satisfy a receipt schema, so
  // validating it first would surface it as a validation rejection, record
  // lastSetOutputError, and re-arm the missing-output retry loop this guard
  // exists to prevent. The downgrade attempt must be ACKed instead, leaving
  // the published receipt untouched. The identical guard below (on the
  // post-validation `finalOutput`) stays as defense in depth for the
  // template-resolved-but-no-outputSchema passthrough path.
  if (
    isReceiptDowngradeBlocked({
      existingOutput: agentState.output,
      nextOutput: decodedOutput,
      receiptProtected: shouldNormalizeReviewerOutput ||
        (isReceiptShape(agentState.output) &&
          (agentState.output as Record<string, unknown>).family ===
            'reviewer'),
    })
  ) {
    // A repeated bogus call must not resurrect a stale rejection.
    agentState.lastSetOutputError = undefined
    return { output: jsonToolResult({ message: RECEIPT_GUARD_ACK }) }
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

  // Receipt-overwrite guard (Phase 3): the decision is delegated to the shared
  // `isReceiptDowngradeBlocked` helper in model-payload-recovery.ts so any
  // consumer can adopt the same policy. The policy: a reviewer-family child's
  // verdict-less follow-up — usually the `{ message: 'Output set' }` tool ACK
  // echoed back as a payload — cannot destroy a published verdict-bearing
  // receipt. Detection stays content-addressed (isReceiptShape), never keyed
  // on envelope/field names. A full receipt replacement (both sides
  // receipt-shaped) still replaces — corrections keep working; non-reviewer
  // agents keep the exact replace-always behavior.
  if (
    isReceiptDowngradeBlocked({
      existingOutput: agentState.output,
      nextOutput: finalOutput,
      receiptProtected: shouldNormalizeReviewerOutput ||
        (isReceiptShape(agentState.output) &&
          (agentState.output as Record<string, unknown>).family ===
            'reviewer'),
    })
  ) {
    // A repeated bogus call must not resurrect a stale rejection.
    agentState.lastSetOutputError = undefined
    return { output: jsonToolResult({ message: RECEIPT_GUARD_ACK }) }
  }
  // Set the output (completely replaces previous output)
  agentState.output = finalOutput as Record<string, unknown>
  // A successful receipt supersedes any earlier rejection, so a later generic
  // missing-output retry can never quote a stale one.
  agentState.lastSetOutputError = undefined

  return { output: jsonToolResult({ message: 'Output set' }) }
}) satisfies CodebuffToolHandlerFunction<ToolName>

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

// Moved verbatim to common/src/util/model-payload-recovery.ts (C1 of the
// json-overhaul) so the receipt-shape concept has one canonical home.
// Re-exported so existing importers of this module keep working.
export { unwrapArbitraryEnvelope }
