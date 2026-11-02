import { realClock } from '@codebuff/common/deps/real-runtime-deps'
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
import { reviewerVerdictIssue } from '../../../util/reviewer-output'
import { formatValueForError } from '../../../util/format-value'
import {
  forgetLiveArtifact,
  hashOversizeArtifactPayload,
  OVERSIZE_ARTIFACT_SWEEP_MAX_ENTRIES,
  PARENT_AGENT_OUTPUT_HIGH_FIDELITY_STRING_CHARS,
  PARENT_AGENT_OUTPUT_MAX_CHARS,
  persistOversizeArtifact,
  resetOversizeArtifactState,
} from './oversize-artifact'

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
import type { Clock } from '@codebuff/common/types/contracts/agent-runtime'

type ToolName = 'set_output'

/**
 * Inline salvage threshold for strings that cannot be decoded to an object.
 * Complete JSON objects follow normal schema validation at any size; undecodable
 * oversized text is retained in a full artifact and represented by a pointer.
 */
export const MAX_SET_OUTPUT_JSON_CHARS = MODEL_PAYLOAD_JSON_CHAR_LIMIT

/**
 * Downstream budgets are owned by the shared leaf `oversize-artifact.ts`.
 * Importing them from spawn-agent-utils would pull the agent loop back into
 * this handler and leave the module-scope derivations below in a TDZ cycle.
 * spawn-agent-utils re-exports the same bindings for existing consumers.
 */

/**
 * Bounded head/tail kept inside the oversized salvage record. The full text
 * lives in the artifact; the head usually shows WHICH part of the payload
 * overran and the tail carries the closing structure. Both are DERIVED from
 * the parent leaf budget imported above (never larger than one
 * high-fidelity string leaf, so compaction cannot clip them) and their sum plus
 * the pointer-field reserve is asserted to stay under the parent payload
 * budget.
 */
const OVERSIZED_OUTPUT_HEAD_REQUEST_CHARS = 40_000
const OVERSIZED_OUTPUT_TAIL_REQUEST_CHARS = 8_000
export const OVERSIZED_OUTPUT_HEAD_CHARS = Math.min(
  OVERSIZED_OUTPUT_HEAD_REQUEST_CHARS,
  PARENT_AGENT_OUTPUT_HIGH_FIDELITY_STRING_CHARS,
)
export const OVERSIZED_OUTPUT_TAIL_CHARS = Math.min(
  OVERSIZED_OUTPUT_TAIL_REQUEST_CHARS,
  PARENT_AGENT_OUTPUT_HIGH_FIDELITY_STRING_CHARS,
)

/**
 * Static reserve for the rest of the record (`truncated`, `truncation`,
 * `artifactPath`, `artifactCreatedAt`, `artifactBytes`, `family`, ...). The
 * head+tail+reserve sum is the hard upper bound on a salvage record's
 * serialized length; the pinned fixture asserts it stays under
 * `PARENT_AGENT_OUTPUT_MAX_CHARS` (and, for real records, well under it).
 */
const OVERSIZED_SALVAGE_POINTER_RESERVE_CHARS = 2_000
export const OVERSIZED_SALVAGE_RECORD_MAX_CHARS =
  OVERSIZED_OUTPUT_HEAD_CHARS +
  OVERSIZED_OUTPUT_TAIL_CHARS +
  OVERSIZED_SALVAGE_POINTER_RESERVE_CHARS

/**
 * Artifact directory for oversized set_output payloads. Retention (24h TTL,
 * 50-entry per-call window), permissions (0o700 dir / 0o600 file), the sweep
 * cursor and the live-path registry all live in the shared `oversize-artifact`
 * module, which `spawn-agent-utils.ts` uses for its own artifacts too. There is
 * deliberately no second copy here: one implementation means a fix to the TTL,
 * the window, the permissions or the pointer-record shape applies everywhere.
 */
const SET_OUTPUT_ARTIFACT_DIR_NAME = 'openbuff-set-output'
/**
 * Exported so the fixed-baseline sweep fixture in `__tests__/set-output.test.ts`
 * derives its expired-entry count and expected call count from the production
 * stride instead of a hand-copied literal. Raising the window now makes the
 * fixture's forward-progress baseline fail against the sweep that actually
 * runs, rather than against a number this module no longer uses.
 */
export const SET_OUTPUT_ARTIFACT_SWEEP_MAX_ENTRIES =
  OVERSIZE_ARTIFACT_SWEEP_MAX_ENTRIES

/**
 * Persist the FULL oversized `data` string to an owner-only scratch artifact
 * via the shared `oversize-artifact` primitive, then hand back a bounded
 * POINTER record instead of an error.
 *
 * Naming is `unique` here: the filename keeps the content hash AND a per-call
 * uuid, so a returned `artifactPath` is uniquely OWNED by the record naming it
 * and one record's sweep can never invalidate another's pointer. The primitive
 * writes with `{ flag: 'wx' }`, so an existing path is never overwritten and
 * never claimed as this call's write.
 *
 * Delegation matters here for more than DRY: retention (24h TTL), the 50-entry
 * per-call sweep window, the 0o700/0o600 permissions, the sweep cursor and the
 * live-path registry are the SAME implementation `spawn-agent-utils.ts` uses for
 * its own artifacts, so a fix to any of them applies to both at once instead of
 * drifting in two copies.
 *
 * Returns `undefined` on ANY error; the caller then accepts the payload with an
 * explicit `artifactPersisted: false` note rather than failing the tool call.
 * There is deliberately no shared critical section around the payload write:
 * the salvage exists for subagent fan-out, where many children cross
 * MAX_SET_OUTPUT_JSON_CHARS at once, so queuing their writes behind one another
 * would make aggregate latency sum(write_i) rather than max(write_i). The only
 * bookkeeping that needs atomicity is in-memory and synchronous, so it needs no
 * lock at all.
 */
async function persistOversizedSetOutputArtifact(
  serialized: string,
  contentHash: string,
  now: number,
  owner: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ artifactPath: string; createdAt: string } | undefined> {
  try {
    return await persistOversizeArtifact(serialized, contentHash, {
      dirName: SET_OUTPUT_ARTIFACT_DIR_NAME,
      naming: 'unique',
      now,
      owner,
      signal,
    })
  } catch {
    return undefined
  }
}

/**
 * Content identity (sha256) of an oversized payload, resolved through the
 * shared lazy Node seam so no `node:crypto` import sits at module scope.
 * Resolves to `undefined` on a host without Node built-ins, where the payload
 * takes the no-persist fallback record instead of failing the tool call.
 */
const hashOversizedSetOutputPayload = hashOversizeArtifactPayload

/**
 * Reset the module-level salvage bookkeeping: the shared artifact retention
 * state (sweep rotation cursors and the live-path registry) plus this module's
 * rejected-payload markers. Any consumer that releases an owning agent state
 * calls this so retention depends on live records rather than on unbounded
 * process history; tests call it so sweep assertions never depend on
 * ordering-dependent global state left by an earlier test.
 */
export function resetSetOutputArtifactSweepState(): void {
  resetOversizeArtifactState()
  rejectedOversizedPayloads.clear()
}

/**
 * Drop one artifact's liveness protection. Called when the salvage record that
 * named it is superseded by a normal output, so a released record no longer
 * pins a file past the TTL the sweep is allowed to reclaim.
 */
export const forgetLiveSetOutputArtifact = forgetLiveArtifact

/**
 * Lossless salvage for an oversized `data` string: persist the whole payload,
 * then hand back a bounded POINTER record instead of an error. The record
 * deliberately carries NO top-level `verdict`/`snapshotFingerprint` key — it
 * must never read as a receipt to the receipt walker — while `truncated: true`
 * and `truncation.reason` name the clipping honestly. When persistence fails
 * the record says so explicitly (`artifactPersisted: false`) instead of
 * implying a recoverable artifact that does not exist. The caller adds the
 * `family` key (when the payload is reviewer/advisory-family) BEFORE gating on
 * the record, so the gate always inspects the exact object that is stored.
 *
 * Provenance is stated, never inferred: `artifactCreatedAt` and
 * `artifactWrittenByThisCall` accompany the pointer, and the filename carries a
 * per-salvage uuid (`<sha256>-<uuid>.json`) so the path is uniquely owned by
 * the record naming it instead of being shared with any other agent that emits
 * the same bytes.
 */
async function buildOversizedSetOutputSalvage(
  data: string,
  contentHash: string | undefined,
  now: number,
  owner?: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const persisted = contentHash
    ? await persistOversizedSetOutputArtifact(
        data,
        contentHash,
        now,
        owner,
        signal,
      )
    : undefined
  const head = data.slice(0, OVERSIZED_OUTPUT_HEAD_CHARS)
  const tail = data.slice(-OVERSIZED_OUTPUT_TAIL_CHARS)
  // WHY the reason discriminates recoverability: the record is persisted to
  // `agentState.output`, so it outlives this call and the replay guard later
  // reads it back. With every branch stamping `reason: 'oversized_payload'`,
  // `artifactPersisted: false` (bytes DROPPED) was indistinguishable from a
  // stored pointer, so the next identical oversized retry was ACKed as an
  // already-stored duplicate — silently discarding the child's payload instead
  // of re-attempting or surfacing an error. The reason now states which of the
  // three cases produced the record, and only `oversized_payload` (an artifact
  // actually on disk) counts as a stored pointer.
  const cancelled = persisted === undefined && signal?.aborted === true
  const artifactFields = persisted
    ? {
        artifactPath: persisted.artifactPath,
        artifactCreatedAt: persisted.createdAt,
        artifactWrittenByThisCall: true,
        artifactBytes: data.length,
        artifact:
          'Full oversized payload persisted verbatim by this call; read it with read_files using artifactPath.',
      }
    : {
        artifactPersisted: false,
        artifactWrittenByThisCall: false,
        artifactError: cancelled
          ? 'The oversized payload was NOT persisted because this call was cancelled before any write; only the bounded head and tail below survive, and everything between them was dropped and is NOT recoverable via read_files.'
          : 'The full oversized payload could NOT be persisted to the scratch artifact directory (tmp unwritable), so only the bounded head and tail below survive; everything between them was dropped and is NOT recoverable via read_files.',
      }
  return {
    truncated: true,
    contentHash,
    ...artifactFields,
    truncation: {
      // Three distinct, self-describing outcomes: a stored pointer, a payload
      // the call could not write, and a payload it was cancelled before
      // writing. Only the FIRST is a recoverable pointer record.
      reason: persisted
        ? 'oversized_payload'
        : cancelled
          ? 'oversized_payload_cancelled'
          : 'oversized_payload_unpersisted',
      totalChars: data.length,
      keptChars: head.length + tail.length,
    },
    data: head,
    dataTail: tail,
  }
}

/**
 * Whether a stored output value is a RECOVERABLE oversized-salvage pointer
 * record, i.e. the payload was already salvaged and its bytes really are on
 * disk. Used to make re-entry non-destructive instead of writing one more copy
 * of the payload per retry.
 *
 * Recoverability is required, not inferred: a record whose bytes were never
 * written (`artifactPersisted: false`, and the matching
 * `oversized_payload_unpersisted` / `oversized_payload_cancelled` reason) is NOT
 * an already-stored pointer, so a retry of that payload must be re-attempted (or
 * surfaced as an error) rather than ACKed as a benign duplicate that permanently
 * discards the child's output.
 */
function isOversizedSetOutputSalvage(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  if (record.truncated !== true) return false
  if (record.artifactPersisted === false) return false
  const truncation = record.truncation
  return (
    truncation !== null &&
    typeof truncation === 'object' &&
    (truncation as Record<string, unknown>).reason === 'oversized_payload'
  )
}

/**
 * Release the artifact a SUPERSEDED salvage record pointed at: once a normal
 * output has actually REPLACED the pointer record, nothing in this process
 * names that file any more, so it must stop being protected from the TTL sweep.
 * Keeps the liveness map describing live records instead of process history.
 *
 * Takes the PREVIOUS value explicitly instead of re-reading `agentState.output`,
 * so the caller can only run this AFTER the new record is assigned and the store
 * is committed to return. Releasing before the assignment de-protected the
 * record that was still the stored one if anything in between failed.
 */
function releaseSupersededSalvageRecord(previousOutput: unknown): void {
  if (!isOversizedSetOutputSalvage(previousOutput)) return
  const artifactPath = (previousOutput as Record<string, unknown>).artifactPath
  if (typeof artifactPath === 'string') {
    forgetLiveSetOutputArtifact(artifactPath)
  }
}

/** Keep rejected work recoverable while leaving the published output unchanged. */
function retainedSalvageArtifactNote(record: Record<string, unknown>): string {
  if (typeof record.artifactPath !== 'string') {
    return ' The full payload could not be persisted; no recovery file is available.'
  }
  // Retain rejected work for the artifact TTL without pinning it indefinitely.
  forgetLiveSetOutputArtifact(record.artifactPath)
  return ` Full payload preserved verbatim at ${record.artifactPath}. Read that file with read_files to recover the work and produce a valid receipt.`
}

/**
 * Rejected payloads are keyed by agent identity and full SHA-256, with the
 * rejection message (including its retained artifact path). Full hashes keep
 * corrections that change only the middle distinct from earlier rejections.
 * Both the agent count and hashes per agent are bounded.
 */
const SET_OUTPUT_REJECTED_PAYLOAD_MEMORY = 512
const SET_OUTPUT_REJECTED_PAYLOAD_HASH_MEMORY = 8

type RejectedOversizedPayloadsForAgent = Map<string, string>

const rejectedOversizedPayloads = new Map<
  string,
  RejectedOversizedPayloadsForAgent
>()

function rejectedOversizedPayloadKey(
  agentState: AgentState,
): string | undefined {
  const key = agentState.agentId ?? agentState.runId
  return typeof key === 'string' && key.length > 0 ? key : undefined
}

/**
 * The specific rejection message recorded for this payload, or undefined when
 * this (agent, payload) pair was never rejected.
 */
function getRejectedOversizedPayload(
  agentState: AgentState,
  payloadFingerprint: string,
): string | undefined {
  const key = rejectedOversizedPayloadKey(agentState)
  if (key === undefined) return undefined
  return rejectedOversizedPayloads.get(key)?.get(payloadFingerprint)
}

function rememberRejectedOversizedPayload(
  agentState: AgentState,
  payloadFingerprint: string,
  message: string,
): void {
  const key = rejectedOversizedPayloadKey(agentState)
  if (key === undefined) return
  // Delete first so a re-set key moves to the tail and eviction stays
  // oldest-first by insertion order (both the per-agent fingerprint LRU and the
  // agent LRU).
  const existing = rejectedOversizedPayloads.get(key)
  rejectedOversizedPayloads.delete(key)
  const fingerprints: RejectedOversizedPayloadsForAgent = existing ?? new Map()
  fingerprints.delete(payloadFingerprint)
  fingerprints.set(payloadFingerprint, message)
  while (fingerprints.size > SET_OUTPUT_REJECTED_PAYLOAD_HASH_MEMORY) {
    const oldest = fingerprints.keys().next()
    if (oldest.done) break
    fingerprints.delete(oldest.value)
  }
  rejectedOversizedPayloads.set(key, fingerprints)
  while (rejectedOversizedPayloads.size > SET_OUTPUT_REJECTED_PAYLOAD_MEMORY) {
    const oldest = rejectedOversizedPayloads.keys().next()
    if (oldest.done) break
    rejectedOversizedPayloads.delete(oldest.value)
  }
}

function forgetRejectedOversizedPayload(agentState: AgentState): void {
  const key = rejectedOversizedPayloadKey(agentState)
  if (key === undefined) return
  rejectedOversizedPayloads.delete(key)
}

/**
 * ACK returned when an oversized payload arrives while a salvage record is
 * ALREADY stored for this agent. Mirrors RECEIPT_GUARD_ACK: the existing record
 * is left untouched — no second artifact, no second copy of the payload — and
 * the call is explicitly reported as `status: 'ignored'` so a retry loop can
 * tell a repeated call apart from an accepted one.
 *
 * The result additionally carries `salvaged: true`, the machine-readable
 * discriminator shared with the success ACK below. Without it a caller cannot
 * tell "my payload IS the stored output" from "my payload was only kept as a
 * pointer record", because an already-stored ACK and a fresh ACK are otherwise
 * distinguishable only by the `status: 'ignored'` string. This ACK path also
 * leaves `agentState.lastSetOutputError` untouched, so a caller (or the
 * runtime's retry loop) that has not yet observed a recorded rejection still
 * finds it here instead of having it cleared by a benign duplicate.
 */
export const OVERSIZED_SALVAGE_GUARD_ACK = `Your output is already stored only as a BOUNDED SALVAGE RECORD: a pointer record holding a bounded head/tail plus the artifactPath of the persisted full payload, NOT your receipt. This additional oversized set_output call was ignored and no second artifact was written. If your full output must be stored, resend the COMPLETE receipt within ${MAX_SET_OUTPUT_JSON_CHARS} chars: keep findings and evidence concise, and move long details into a file your schema can reference.`

/**
 * ACK returned when the SAME oversized payload that was already rejected is
 * retried. Nothing is re-hashed beyond the identity check and nothing is
 * written.
 *
 * This is a TERMINAL result, not a benign duplicate: the retry is surfaced as
 * the call's ERROR (never as the `status: 'ignored'` shape an already-stored
 * duplicate uses) and `agentState.lastSetOutputError` is deliberately KEPT set,
 * so the runtime's missing-output retry can report a hard, non-retryable
 * failure. Clearing the marker or the error instead turned the previous
 * unbounded WRITE loop into an unbounded no-write loop that never converged on
 * anything the loop could surface.
 */
export const OVERSIZED_SALVAGE_REJECTED_REPEAT_ACK = `This exact oversized payload (${MAX_SET_OUTPUT_JSON_CHARS}+ chars) was already rejected for this agent: resending it unchanged will never be accepted and no second artifact was written. Emit a COMPLETE receipt within ${MAX_SET_OUTPUT_JSON_CHARS} chars — keep findings and evidence concise, and persist long details to a file your schema can reference.`

/**
 * ACK for a successful salvage. It must not read like the plain 'Output set'
 * confirmation, because `agentState.output` is now a bounded pointer record
 * rather than the child's payload; the 'Output set' prefix is preserved so
 * existing acknowledgment detection keeps working. The claim stays true because
 * the record is only built when THIS call wrote the artifact itself (unique
 * filename + `wx` write).
 *
 * The result carries the same `salvaged: true` discriminator as the
 * already-stored guard ACK, so a retry loop and the parent can tell a pointer
 * record apart from a real stored output by inspecting the result shape rather
 * than by parsing prose.
 */
export const OVERSIZED_SALVAGE_ACK = `Output set as a BOUNDED SALVAGE RECORD, not as your full payload: the stored output is a pointer record (truncated: true, truncation.reason "oversized_payload") holding only a bounded head/tail plus artifactPath, artifactCreatedAt and artifactBytes. The artifact was written by this call; read artifactPath with read_files to recover the complete text.`

/**
 * ACK for an oversized payload that was NOT stored because the call was
 * cancelled before any write.
 *
 * Reported as the call's ERROR and `agentState.output` is left exactly as it
 * was. The previous behavior published a pointer-less salvage record with
 * `truncated: true` on a cancelled call, which both claimed a stored output the
 * child never produced and made the next identical retry look like an
 * already-stored duplicate. A cancelled call now says so, and the payload stays
 * fully retryable.
 */
export const OVERSIZED_SALVAGE_CANCELLED_ACK =
  'Output was NOT stored because this set_output call was cancelled before the oversized payload could be written. Nothing was recorded as your output and no artifact was created; retry the call if the output is still needed.'

/**
 * ACK for an oversized payload whose artifact could NOT be written (e.g. an
 * unwritable temp directory). Distinct from `OVERSIZED_SALVAGE_ACK` because the
 * claim that the artifact exists is false: only the bounded head/tail survived,
 * and the record's `truncation.reason` is `oversized_payload_unpersisted` so a
 * retry re-attempts the write instead of being ACKed as an already-stored copy.
 */
export const OVERSIZED_SALVAGE_UNPERSISTED_ACK =
  'Output set only as a DEGRADED SALVAGE RECORD: the oversized payload could NOT be written to the scratch artifact directory, so the stored output holds a bounded head/tail (truncation.reason "oversized_payload_unpersisted") and the middle of your payload is NOT recoverable via read_files. Resend a COMPLETE receipt within the limit, or persist long details to a file your schema can reference.'

/**
 * Ack returned when a receipt-bearing reviewer's second set_output call carries
 * a degenerate, verdict-less payload (typically the `{ message: 'Output set' }
 * tool ACK echoed back as a payload). The existing receipt is intentionally NOT
 * overwritten, and this ack teaches the model the difference between the
 * tool-confirmation and a receipt payload so it does not repeat the echo.
 */
export const RECEIPT_GUARD_ACK =
  'Your structured receipt was already published successfully; this additional set_output call was ignored because it did not carry a full receipt (verdict + snapshotFingerprint). Do not echo the {"message":"Output set"} confirmation back as a payload. If your review outcome changed, re-emit the COMPLETE receipt object (every required schema field).'

/**
 * Terminal, O(1) replay outcomes for an oversized payload.
 *
 * Evaluated BEFORE template resolution (a possibly-async registry/DB lookup)
 * and BEFORE any payload digest. Both retry-loop shapes this handler documents
 * — "the identical retry costs one fingerprint and no write" and "an already
 * stored salvage record gets no second artifact" — are decided here from
 * bounded in-memory state, so the loop the salvage exists to make terminal no
 * longer pays `O(retries x payload)` for a full sha256 (up to 1M chars) plus a
 * template lookup on every iteration. The real digest is computed later, and
 * only once this call is actually going to persist.
 */
function oversizedSetOutputReplay(
  agentState: AgentState,
  contentHash: string,
): { output: CodebuffToolOutput<ToolName> } | undefined {
  const rejectedMessage = getRejectedOversizedPayload(agentState, contentHash)
  if (rejectedMessage !== undefined) {
    // TERMINAL: the marker is kept (so every further retry of ANY payload in
    // the alternation cycle lands here instead of writing another artifact) and
    // the ERROR shape is returned rather than the benign `status: 'ignored'`
    // duplicate shape, so the loop can distinguish "already stored" from
    // "permanently rejected" and stop. The SPECIFIC rejection recorded by the
    // first attempt is re-emitted (the settle path reads it as the
    // `schema_invalid` diagnostic detail) with the "resending it unchanged"
    // guidance appended.
    const repeatMessage = `${rejectedMessage} ${OVERSIZED_SALVAGE_REJECTED_REPEAT_ACK}`
    agentState.lastSetOutputError = rejectedMessage
    return {
      output: jsonToolResult({
        message: repeatMessage,
        errorMessage: repeatMessage,
      }),
    }
  }
  if (
    isOversizedSetOutputSalvage(agentState.output) &&
    (agentState.output as Record<string, unknown>).contentHash === contentHash
  ) {
    // `lastSetOutputError` is deliberately NOT cleared here: a caller that has
    // not yet observed a recorded rejection still finds it, instead of having a
    // benign duplicate erase the signal the loop reports. `salvaged: true` is
    // the machine-readable discriminator for a pointer record.
    return {
      output: jsonToolResult({
        message: OVERSIZED_SALVAGE_GUARD_ACK,
        status: 'ignored',
        salvaged: true,
      }),
    }
  }
  return undefined
}

export const handleSetOutput = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>

  agentState: AgentState
  apiKey: string
  databaseAgentCache: Map<string, AgentTemplate | null>
  localAgentTemplates: Record<string, AgentTemplate>
  logger: Logger
  fetchAgentFromDatabase: FetchAgentFromDatabaseFn
  /**
   * Cancellation hook for this tool call. An oversized payload is the one
   * set_output shape with real I/O (up to a 1M-char write plus a sweep), so a
   * cancelled child must not pay for it: the signal aborts the artifact write
   * and the sweep before they run.
   */
  signal?: AbortSignal
  clock?: Clock
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const { previousToolCallFinished, toolCall, agentState, logger, signal } =
    params
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
  const unwrappedEnvelope = unwrapArbitraryEnvelope(envelopeOutput)
  const rawOutput: Record<string, unknown> = unwrappedEnvelope ?? envelopeOutput

  // Oversized string payloads are SALVAGED, never rejected — but they are also
  // NOT a fast path out of the handler. Such a string cannot be decoded inside
  // the envelope-unwrap parse bound, and rejecting it destroyed the child's
  // entire output; instead the full text is persisted to an owner-only
  // artifact and `agentState.output` becomes a bounded pointer record. The
  // salvage is applied BELOW, after template resolution, the receipt-downgrade
  // guard and `reviewerVerdictIssue`, exactly like every other accept path. It
  // used to return success right here, which let a reviewer-family child
  // publish a verdict-less, schema-invalid record that permanently replaced an
  // already-published verdict-bearing receipt (the oracle failure those guards
  // exist to prevent) and re-armed the parent's re-review loop.
  const rawOutputData = rawOutput?.data
  // Complete large JSON still follows the agent's normal schema validation.
  // Salvage is only necessary when the string cannot be decoded to an object.
  const decodedData = decodeJsonObjectString(rawOutputData)
  const oversizedOutputData =
    typeof decodedData === 'string' &&
    decodedData.length > MAX_SET_OUTPUT_JSON_CHARS
      ? decodedData
      : undefined
  if (
    !oversizedOutputData &&
    typeof rawOutput?.data === 'string' &&
    decodedData === rawOutput.data
  ) {
    const baseGuidance =
      'Output was not set because data contained malformed or incomplete JSON text. Retry set_output with a real object value, not JSON.stringify(...). Keep findings and evidence concise enough to complete one tool call.'
    // Distinguish LIKELY TRANSPORT TRUNCATION from plain malformed JSON: a
    // payload ending mid-structure (open bracket or open string) almost
    // certainly lost its tail in transit, and the caller needs chunking /
    // smaller-payload guidance rather than only a formatting retry.
    const malformedJsonMessage = detectTransportTruncation(rawOutput.data)
      ? `${baseGuidance} The payload appears to have been truncated in transport (partial). Shorten the receipt and resend it as one complete object, or persist details to a file and reference the path if the output schema permits it. Each set_output call replaces the previous output.`
      : baseGuidance
    // Recorded on agent state because this rejection also ends the turn
    // (set_output is in TOOLS_WHICH_WONT_FORCE_NEXT_STEP), so the loop's
    // missing-output retry is the only place that can report it to the model.
    agentState.lastSetOutputError = malformedJsonMessage
    return {
      output: jsonToolResult({
        message: malformedJsonMessage,
        errorMessage: malformedJsonMessage,
      }),
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
  const shouldNormalizeStructuredReceipt =
    shouldNormalizeReviewerOutput ||
    decodedOutput.family === 'advisory' ||
    decodedDataRecord?.family === 'advisory'

  // Hash the entire string once so changed payloads remain distinguishable.
  const oversizedPayloadHash =
    oversizedOutputData && !signal?.aborted
      ? await hashOversizedSetOutputPayload(oversizedOutputData)
      : undefined
  if (oversizedOutputData && oversizedPayloadHash) {
    const replay = oversizedSetOutputReplay(agentState, oversizedPayloadHash)
    if (replay) return replay
  }

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
      output: jsonToolResult({
        message: unresolvableTemplateMessage,
        errorMessage: unresolvableTemplateMessage,
      }),
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
      receiptProtected:
        shouldNormalizeReviewerOutput ||
        (isReceiptShape(agentState.output) &&
          (agentState.output as Record<string, unknown>).family === 'reviewer'),
    })
  ) {
    // A repeated bogus call must not resurrect a stale rejection.
    agentState.lastSetOutputError = undefined
    return {
      output: jsonToolResult({ message: RECEIPT_GUARD_ACK, status: 'ignored' }),
    }
  }

  // Oversized salvage, now that the output contract has had its say: template
  // resolution (fail-closed on unresolvable agent types) and the raw
  // receipt-downgrade guard above have both run.
  //
  // Re-entry is NON-DESTRUCTIVE: a retry loop that re-sends an oversized
  // payload after a salvage record is already stored must not append another
  // full copy of the artifact, and must not ACK as though the child's real
  // output had been stored. It gets the same explicit `status: 'ignored'` shape
  // the receipt-downgrade guard uses.
  //
  // ONE REACHABLE TERMINAL SHAPE PER (agent identity, payload hash): the
  // rejected-payload marker is consulted FIRST, before the already-stored
  // salvage guard, because a previously REJECTED payload is terminal regardless
  // of what `agentState.output` happens to hold. Evaluating the guard first made
  // the same (agent, payload) pair return the benign `status: 'ignored'`
  // duplicate shape on some call orders and the hard error shape on others, so a
  // retry loop had no single signal to converge on.
  if (oversizedOutputData) {
    // Cancel-BEFORE-write, decided before any I/O: nothing was persisted, so
    // there is no pointer to publish and no salvage worth storing. Leave
    // `agentState.output` untouched (the previous behavior published a
    // pointer-less salvage record claiming `truncated: true`, i.e. a stored
    // output the child never produced) and report the cancellation explicitly
    // so the payload stays retryable.
    if (signal?.aborted) {
      agentState.lastSetOutputError = OVERSIZED_SALVAGE_CANCELLED_ACK
      return {
        output: jsonToolResult({
          message: OVERSIZED_SALVAGE_CANCELLED_ACK,
          errorMessage: OVERSIZED_SALVAGE_CANCELLED_ACK,
        }),
      }
    }
    // Build the salvage record FIRST and gate on that exact object, so the
    // verdict check provably inspects the value that will be stored instead of
    // a parallel literal whose key order could silently satisfy it.
    const salvageRecord = await buildOversizedSetOutputSalvage(
      oversizedOutputData,
      oversizedPayloadHash,
      (params.clock ?? realClock).now(),
      rejectedOversizedPayloadKey(agentState),
      signal,
    )
    if (shouldNormalizeReviewerOutput) {
      salvageRecord.family = 'reviewer'
    } else if (shouldNormalizeStructuredReceipt) {
      salvageRecord.family = 'advisory'
    }
    // The salvage record is deliberately verdict-less — it must never read as a
    // receipt to the receipt walker — so `reviewerVerdictIssue` rejects it for
    // a reviewer-protected child, exactly like the sibling rejection paths,
    // instead of publishing a schema-invalid receipt and burning another round.
    const salvageVerdictIssue = reviewerVerdictIssue(
      agentState.agentType,
      salvageRecord,
    )
    if (salvageVerdictIssue) {
      // Reject the invalid receipt while retaining its work for recovery.
      const artifactPointer = retainedSalvageArtifactNote(salvageRecord)
      const oversizedRejectionMessage = `${salvageVerdictIssue} The payload was also too large (${oversizedOutputData.length} chars) to store as your output, so nothing was recorded as your output.${artifactPointer} Publish a complete native object satisfying your output schema, using the retained work above.`
      // Recorded on agent state because this rejection also ends the turn
      // (set_output is in TOOLS_WHICH_WONT_FORCE_NEXT_STEP), so the loop's
      // missing-output retry is the only place that can report it to the model.
      agentState.lastSetOutputError = oversizedRejectionMessage
      // Nothing was stored, so the re-entry guard cannot fire: record the
      // rejected payload's fingerprint AND the reason so ANY later retry of this
      // payload terminates with this same, specific message — including the
      // alternating A↔B retry cycle a single-slot marker could not stop.
      rememberRejectedOversizedPayload(
        agentState,
        oversizedPayloadHash ?? '',
        oversizedRejectionMessage,
      )
      return {
        output: jsonToolResult({
          message: oversizedRejectionMessage,
          errorMessage: oversizedRejectionMessage,
        }),
      }
    }
    // A schema-declaring agent is the ONLY class that reaches this branch, so
    // skipping its field-level validation would put a record with none of the
    // declared fields into `agentState.output` while the tool reported success.
    // Validate the salvage record against the agent's own contract and reject
    // explicitly when it does not fit, pointing the parent at the persisted
    // artifact instead of silently storing a shape the schema rejects.
    if (agentTemplate?.outputSchema) {
      try {
        agentTemplate.outputSchema.parse(salvageRecord)
      } catch (error) {
        // Preserve the full text even though its pointer fails this schema.
        const artifactPointer = retainedSalvageArtifactNote(salvageRecord)
        const schemaRejectionMessage = `Your output was too large (${oversizedOutputData.length} chars) to store as this agent's contract-shaped output, and the bounded salvage record itself does not satisfy the agent's output schema, so nothing was recorded as your output.${artifactPointer} Publish a complete native object satisfying your output schema, using the retained work above. Issues: ${error}`
        // Recorded on agent state because this rejection also ends the turn
        // (set_output is in TOOLS_WHICH_WONT_FORCE_NEXT_STEP), so the loop's
        // missing-output retry is the only place that can report it to the model.
        agentState.lastSetOutputError = schemaRejectionMessage
        // Same reason as the verdict rejection above: nothing was stored, so
        // the rejected payload's fingerprint and reason are the only things that
        // stop a retry loop (including an alternating one) from re-persisting
        // the same oversized artifact forever.
        rememberRejectedOversizedPayload(
          agentState,
          oversizedPayloadHash ?? '',
          schemaRejectionMessage,
        )
        logger.error(
          {
            agentType: agentState.agentType,
            agentId: agentState.agentId,
            oversizedChars: oversizedOutputData.length,
            artifactPath: salvageRecord.artifactPath,
          },
          'set_output oversized salvage record did not satisfy the agent output schema',
        )
        return {
          output: jsonToolResult({
            message: schemaRejectionMessage,
            errorMessage: schemaRejectionMessage,
          }),
        }
      }
    }
    // The pointer record is stored exactly as built, never as the schema's
    // stripped output: `truncated`/`artifactPath` ARE the pointer, so the
    // validation above is a gate rather than a transform.
    //
    // ORDER: capture the previous record, assign the new one, and only THEN drop
    // the superseded record's protection. Releasing before the assignment (or
    // before this call can still fail) de-protected the record that was still
    // the stored one, so an intermediate failure left the previous pointer
    // unprotected while `agentState.output` had already moved on.
    const supersededOutput = agentState.output
    agentState.output = salvageRecord
    // A successful (salvaged) set_output supersedes any earlier rejection, so
    // a later missing-output retry can never quote a stale one.
    agentState.lastSetOutputError = undefined
    forgetRejectedOversizedPayload(agentState)
    releaseSupersededSalvageRecord(supersededOutput)
    // The ACK must match the record that was actually stored: claiming a
    // written artifact for a record whose `artifactPersisted` is false is the
    // provenance lie this handler's ACK text explicitly forbids.
    return {
      output: jsonToolResult({
        message:
          typeof salvageRecord.artifactPath === 'string'
            ? OVERSIZED_SALVAGE_ACK
            : OVERSIZED_SALVAGE_UNPERSISTED_ACK,
        salvaged: true,
      }),
    }
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
    // Converted JSON schemas may pass through undeclared properties rather
    // than stripping them. Detect whether a sole data envelope contains a
    // declared output field, while preserving schemas that declare `data`.
    const schemaShape = (
      agentTemplate.outputSchema as unknown as {
        shape?: Record<string, unknown>
      }
    ).shape
    const dataContainsDeclaredFields =
      schemaShape != null &&
      typeof schemaShape === 'object' &&
      !Object.prototype.hasOwnProperty.call(schemaShape, 'data') &&
      decodedDataRecord !== undefined &&
      Object.keys(decodedDataRecord).some((key) =>
        Object.prototype.hasOwnProperty.call(schemaShape, key),
      )
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
    if (shouldNormalizeStructuredReceipt) {
      candidates.push({
        source: 'normalized-output',
        value: normalizeStructuredOutputValue(decodedOutput),
      })
    }
    if (decodedDataRecord) {
      candidates.push({ source: 'data', value: decodedDataRecord })
      if (shouldNormalizeStructuredReceipt) {
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
      if (shouldNormalizeStructuredReceipt) {
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
        const parsedOutput = agentTemplate.outputSchema.parse(candidate.value)
        // With an all-optional object schema, parsing { data: receipt } at
        // the top level can succeed as {} after unknown-key stripping. That
        // silently discards the entire receipt. Try the data candidate unless
        // the schema actually retained a declared/passthrough data field.
        if (
          (candidate.source === 'output' ||
            candidate.source === 'normalized-output') &&
          decodedDataRecord &&
          Object.keys(decodedOutput).length === 1 &&
          parsedOutput !== null &&
          typeof parsedOutput === 'object' &&
          !Array.isArray(parsedOutput) &&
          (!Object.prototype.hasOwnProperty.call(parsedOutput, 'data') ||
            dataContainsDeclaredFields)
        ) {
          continue
        }
        finalOutput = parsedOutput
        failures.length = 0
        break
      } catch (error) {
        // One deterministic repair round before giving up on the candidate:
        // the most common structured-output mistake is an enum field carrying
        // justification prose ("pass: no new packages..."), which the schema
        // wants as the BARE value. Repaired candidates that still fail fall
        // back to the ORIGINAL failure, so the error the model sees describes
        // its own output, not the repair's.
        const repaired = repairEnumProseValues(candidate.value, error)
        if (repaired) {
          try {
            finalOutput = agentTemplate.outputSchema.parse(repaired.value)
            failures.length = 0
            logger.warn(
              {
                agentType: agentState.agentType,
                agentId: agentState.agentId,
                source: candidate.source,
                coercedPaths: repaired.coercedPaths,
              },
              'set_output enum-prose repair applied',
            )
            break
          } catch {
            // fall through to record the original failure
          }
        }
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
      // Models shown only the enum's allowed values still resubmit
      // `"pass: <prose>"` shapes; the hint names the contract explicitly.
      const enumHint = hasEnumValueIssue(bestFailure.error)
        ? '\nEnum fields take the BARE value only (e.g. "pass", not "pass: <justification>"); put justifications in the schema\'s evidence/notes fields, never inside the enum value.'
        : ''
      const errorMessage = `${prefix}${bestFailure.error}${enumHint}\n\nOriginal output value:\n${formatValueForError(decodedOutput)}`
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
      return { output: jsonToolResult({ message: errorMessage, errorMessage }) }
    }
  } else {
    // When no outputSchema, use the data field if it is the only field
    // otherwise use the entire output object
    const keys = Object.keys(decodedOutput)
    const hasOnlyDataField = keys.length === 1 && keys[0] === 'data'
    finalOutput = hasOnlyDataField ? decodedOutput.data : decodedOutput
  }

  // A degraded or absent schema must not let a reviewer publish a receipt the
  // parent will reject only after the child and its review context have ended.
  const verdictIssue = reviewerVerdictIssue(agentState.agentType, finalOutput)
  if (verdictIssue) {
    agentState.lastSetOutputError = verdictIssue
    return {
      output: jsonToolResult({
        message: verdictIssue,
        errorMessage: verdictIssue,
      }),
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
  if (
    isReceiptDowngradeBlocked({
      existingOutput: agentState.output,
      nextOutput: finalOutput,
      receiptProtected:
        shouldNormalizeReviewerOutput ||
        (isReceiptShape(agentState.output) &&
          (agentState.output as Record<string, unknown>).family === 'reviewer'),
    })
  ) {
    // A repeated bogus call must not resurrect a stale rejection.
    agentState.lastSetOutputError = undefined
    return {
      output: jsonToolResult({ message: RECEIPT_GUARD_ACK, status: 'ignored' }),
    }
  }
  // Set the output (completely replaces previous output)
  // A normal output supersedes any earlier salvage record. Assign FIRST and
  // release the superseded pointer afterwards, so protection is only dropped
  // once nothing here still names it.
  const supersededOutput = agentState.output
  agentState.output = finalOutput as Record<string, unknown>
  // A successful receipt supersedes any earlier rejection, so a later generic
  // missing-output retry can never quote a stale one.
  agentState.lastSetOutputError = undefined
  // The rejected-payload marker for the previous rejection is cleared here (the
  // defined helper), so a later oversized payload is not short-circuited by a
  // rejection a successful normal output already superseded.
  forgetRejectedOversizedPayload(agentState)
  releaseSupersededSalvageRecord(supersededOutput)

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

/**
 * Whether any zod issue in the failure is an enum rejection, used to target
 * the retry hint: the model repeatedly resubmits `"pass: <prose>"` shapes
 * unless the error itself demonstrates the bare-value contract.
 */
function hasEnumValueIssue(error: unknown): boolean {
  return zodIssues(error).some(
    (issue) => issue.code === 'invalid_value' && Array.isArray(issue.values),
  )
}

function zodIssues(error: unknown): Array<Record<string, unknown>> {
  if (
    error != null &&
    typeof error === 'object' &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown }).issues)
  ) {
    return (error as { issues: Array<Record<string, unknown>> }).issues.filter(
      (issue) => issue && typeof issue === 'object',
    )
  }
  return []
}

/**
 * Deterministic repair for the dominant structured-output failure mode: an
 * enum field submitted as `"pass: <justification prose>"` where the schema
 * wants the BARE enum value. For every zod `invalid_value` issue whose current
 * value is a string that starts with one of the allowed enum values followed
 * by a separator, the clone is rewritten to the bare allowed value — the prose
 * tail belongs in the schema's evidence/justification fields, which the model
 * fills separately. Only JSON-like values (the candidates all decode from the
 * model's JSON output) are navigated; anything else is left untouched.
 * Returns undefined when nothing was repairable, so the caller keeps the
 * original failure untouched.
 */
function repairEnumProseValues(
  value: unknown,
  error: unknown,
): { value: unknown; coercedPaths: string[] } | undefined {
  const clone = cloneJsonLike(value)
  if (clone === undefined) return undefined
  const coercedPaths: string[] = []
  for (const issue of zodIssues(error)) {
    if (issue.code !== 'invalid_value' || !Array.isArray(issue.values)) continue
    const allowed = issue.values.filter(
      (entry): entry is string => typeof entry === 'string',
    )
    if (allowed.length === 0) continue
    const path = Array.isArray(issue.path) ? issue.path : []
    if (
      !path.every((key) => typeof key === 'string' || typeof key === 'number')
    ) {
      continue
    }
    const current = getPathValue(clone, path)
    if (typeof current !== 'string') continue
    // Longest allowed value first, so overlapping enums (e.g. "pass" and
    // "passed") prefer the longest match.
    const prefixed = allowed
      .slice()
      .sort((left, right) => right.length - left.length)
      .find(
        (entry) =>
          current.toLowerCase().startsWith(entry.toLowerCase()) &&
          /^[\s:—-]/.test(current.slice(entry.length)),
      )
    if (prefixed === undefined) continue
    if (setPathValue(clone, path, prefixed)) {
      coercedPaths.push(path.join('.') || '<root>')
    }
  }
  return coercedPaths.length > 0 ? { value: clone, coercedPaths } : undefined
}

/** Deep-clone a JSON-like value; undefined means "not cloneable, give up". */
function cloneJsonLike(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const cloned = cloneJsonLike(entry)
      return cloned === undefined ? entry : cloned
    })
  }
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const cloned = cloneJsonLike(entry)
    out[key] = cloned === undefined ? entry : cloned
  }
  return out
}

function getPathValue(value: unknown, path: Array<string | number>): unknown {
  let current: unknown = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key as string]
  }
  return current
}

function setPathValue(
  value: unknown,
  path: Array<string | number>,
  replacement: unknown,
): boolean {
  if (path.length === 0) return false
  let current: unknown = value
  for (const key of path.slice(0, -1)) {
    if (current === null || typeof current !== 'object') return false
    current = (current as Record<string, unknown>)[key as string]
  }
  const lastKey = path[path.length - 1]!
  if (current === null || typeof current !== 'object') return false
  const holder = current as Record<string, unknown>
  if (!((lastKey as string) in holder)) return false
  holder[lastKey as string] = replacement
  return true
}

// Moved verbatim to common/src/util/model-payload-recovery.ts (C1 of the
// json-overhaul) so the receipt-shape concept has one canonical home.
// Re-exported so existing importers of this module keep working.
export { unwrapArbitraryEnvelope }
