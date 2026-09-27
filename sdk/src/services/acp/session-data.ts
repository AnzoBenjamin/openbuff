import type {
  FileMutationActionV1,
  FileMutationResultV1,
} from '@codebuff/common/tools/results/filesystem'

/**
 * Bounded per-session live data backing the read-only Openbuff ACP extension
 * methods (`openbuff/getReceipts`, `openbuff/gateState`). The P1-T2 run loop
 * records real `FileMutationResultV1` receipts and published gate-state
 * blocks here; `AcpAgent` serves projections of this store when no static
 * `extensionHandler` is injected.
 *
 * Bounded by design: at most `MAX_RECEIPTS_PER_SESSION` receipts per session
 * (newest wins) and exactly one gate-state snapshot per session (the latest
 * published block).
 */

/** Receipts retained per session; recording beyond the cap drops the oldest. */
const MAX_RECEIPTS_PER_SESSION = 256
/** Default and maximum `limit` served by `openbuff/getReceipts`. */
const DEFAULT_RECEIPT_LIMIT = 50
const MAX_RECEIPT_LIMIT = 256

/**
 * The redacted receipt envelope wire shape (P1-T2-DESIGN §6.2): the mutation
 * is projected to its identifying/hashing surface. Content-bearing fields
 * (`afterContent`, `patch`, `editAnchor`) and fresh `cap.v3` capability
 * tokens never leave the core — redaction here is normative, not cosmetic.
 * `authorityReceipt` is kept verbatim: it already holds only ids, hashes,
 * tiers, and statuses.
 */
export type AcpWireReceiptEnvelope = {
  kind: 'openbuff.receipt_envelope'
  version: 1
  sessionId: string
  toolCallId?: string
  laneId: 'main'
  mutation: FileMutationResultV1
}

/** Projected receipt row served by `openbuff/getReceipts`. */
export type AcpWireReceipt = {
  operationId: string
  receiptId: string
  paths: string[]
  actionIds: string[]
}

export type AcpReceiptsResult = { receipts: AcpWireReceipt[] }

/**
 * Phases the published gate-state block projects onto. `idle` is the
 * no-snapshot answer; the rest come from the block payload.
 */
export type AcpGatePhase =
  | 'idle'
  | 'validating'
  | 'reviewing'
  | 'blocked'
  | 'final_response_allowed'

export type AcpGateStateResult = {
  phase: AcpGatePhase
  currentTask: string | null
}

/**
 * The latest parsed `<gate-state>` payload for a session. Producer:
 * `formatGateStateBlock` in agents/base2/base2.ts, which emits
 * `<gate-state>{...}</gate-state>` with `gate`/`status`/`details` always
 * present and `repairRound`/`maxRepairRounds`/`advisories`/`workflow`
 * optional and additive. `phase` is this store's projection of the payload.
 */
export type AcpGateStateSnapshot = {
  gate: string
  status: string
  details: string
  repairRound?: number
  maxRepairRounds?: number
  advisories?: string[]
  workflow?: {
    completedCount: number
    totalCount: number
    nextWorkflowAction: string
  }
  phase: Exclude<AcpGatePhase, 'idle'>
}

/**
 * Non-greedy block extraction, mirroring the CLI's producer-consumer
 * contract: the producer escapes `</` as `<\/` inside its JSON payload, so
 * a literal `</gate-state>` inside reviewer-authored text cannot terminate
 * a block early and the non-greedy match is safe. Last match wins.
 */
const GATE_STATE_BLOCK_RE = /<gate-state>([\s\S]*?)<\/gate-state>/g

const KNOWN_GATES = new Set(['validation', 'reviewer', 'validation/reviewer'])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Builds the wire mutation for a receipt envelope: drops the
 * content-bearing fields (`afterContent`, `patch`, `editAnchor`) from every
 * action and replaces `freshCapabilities` with `[]` so cap.v3 tokens never
 * leave the core. The action schema is a single object shape whose optional
 * content fields may be populated by any `action` kind, so destructuring the
 * three keys covers every variant; `authorityReceipt` is untouched.
 */
export function toWireMutation(
  mutation: FileMutationResultV1,
): FileMutationResultV1 {
  const redactedActions: FileMutationActionV1[] = mutation.actions.map(
    (action) => {
      const {
        afterContent: _afterContent,
        editAnchor: _editAnchor,
        patch: _patch,
        ...rest
      } = action
      return rest
    },
  )
  return { ...mutation, actions: redactedActions, freshCapabilities: [] }
}

/** Builds the redacted receipt envelope for one recorded mutation. */
export function toWireReceipt(
  mutation: FileMutationResultV1,
  sessionId: string,
  toolCallId?: string,
): AcpWireReceiptEnvelope {
  const envelope: AcpWireReceiptEnvelope = {
    kind: 'openbuff.receipt_envelope',
    version: 1,
    sessionId,
    laneId: 'main',
    mutation: toWireMutation(mutation),
  }
  if (toolCallId !== undefined) {
    envelope.toolCallId = toolCallId
  }
  return envelope
}

function projectGatePhase(
  gate: string,
  status: string,
): Exclude<AcpGatePhase, 'idle'> {
  if (status === 'passed') {
    return 'final_response_allowed'
  }
  if (status === 'failed' || status === 'skipped') {
    return 'blocked'
  }
  // Non-terminal (or unrecognized) status: the gate alone decides, and the
  // combined validation/reviewer gate is a reviewer-side wait.
  return gate === 'validation' ? 'validating' : 'reviewing'
}

function parseWorkflowProgress(value: unknown): AcpGateStateSnapshot['workflow'] {
  if (!isPlainRecord(value)) return undefined
  const { completedCount, totalCount, nextWorkflowAction } = value
  if (
    typeof completedCount !== 'number' ||
    !Number.isFinite(completedCount) ||
    typeof totalCount !== 'number' ||
    !Number.isFinite(totalCount) ||
    typeof nextWorkflowAction !== 'string'
  ) {
    return undefined
  }
  return { completedCount, totalCount, nextWorkflowAction }
}

/**
 * Extracts and leniently validates the last `<gate-state>` block in `text`.
 * Plain-object checks only (the strict CLI parser lives in cli/ and is not
 * importable from sdk/): unknown or malformed payloads return null so the
 * caller keeps its previous snapshot instead of throwing.
 */
export function parseGateStateBlock(
  blockText: string,
): AcpGateStateSnapshot | null {
  const matches = [...blockText.matchAll(GATE_STATE_BLOCK_RE)]
  const last = matches.at(-1)
  if (!last) return null

  let payload: unknown
  try {
    payload = JSON.parse(last[1].trim())
  } catch {
    return null
  }
  if (!isPlainRecord(payload)) return null

  const { gate, status } = payload
  if (typeof gate !== 'string' || !KNOWN_GATES.has(gate)) return null
  if (typeof status !== 'string' || status.length === 0) return null

  const snapshot: AcpGateStateSnapshot = {
    gate,
    status,
    details: typeof payload.details === 'string' ? payload.details : '',
    phase: projectGatePhase(gate, status),
  }
  if (
    typeof payload.repairRound === 'number' &&
    Number.isFinite(payload.repairRound)
  ) {
    snapshot.repairRound = payload.repairRound
  }
  if (
    typeof payload.maxRepairRounds === 'number' &&
    Number.isFinite(payload.maxRepairRounds)
  ) {
    snapshot.maxRepairRounds = payload.maxRepairRounds
  }
  if (
    Array.isArray(payload.advisories) &&
    payload.advisories.every((advisory) => typeof advisory === 'string')
  ) {
    snapshot.advisories = payload.advisories
  }
  const workflow = parseWorkflowProgress(payload.workflow)
  if (workflow) {
    snapshot.workflow = workflow
  }
  return snapshot
}

function projectEnvelopeReceipt(envelope: AcpWireReceiptEnvelope): AcpWireReceipt {
  const paths: string[] = []
  const actionIds: string[] = []
  for (const action of envelope.mutation.actions) {
    if (!paths.includes(action.path)) {
      paths.push(action.path)
    }
    if (
      action.destinationPath !== undefined &&
      !paths.includes(action.destinationPath)
    ) {
      paths.push(action.destinationPath)
    }
    if (!actionIds.includes(action.actionId)) {
      actionIds.push(action.actionId)
    }
  }
  return {
    operationId: envelope.mutation.operationId,
    // Envelopes recorded before a receiptId existed still surface on the
    // wire; the extension contract requires a string, so fall back to ''.
    receiptId: envelope.mutation.receiptId ?? '',
    paths,
    actionIds,
  }
}

/**
 * Bounded live-data store for ACP sessions. One instance serves the whole
 * agent process; sessions are keyed by ACP session id.
 */
export class AcpSessionData {
  /** Newest-last; capped at MAX_RECEIPTS_PER_SESSION by recordReceipt. */
  private readonly receiptsBySession = new Map<string, AcpWireReceiptEnvelope[]>()
  /** Latest gate-state snapshot per session (one per session, replace-on-update). */
  private readonly gateStateBySession = new Map<string, AcpGateStateSnapshot>()

  /**
   * Records a redacted receipt envelope for a real file mutation. Unknown
   * session ids are fine — the store creates the bucket lazily.
   */
  recordReceipt(
    sessionId: string,
    mutation: FileMutationResultV1,
    toolCallId?: string,
  ): void {
    let receipts = this.receiptsBySession.get(sessionId)
    if (!receipts) {
      receipts = []
      this.receiptsBySession.set(sessionId, receipts)
    }
    receipts.push(toWireReceipt(mutation, sessionId, toolCallId))
    if (receipts.length > MAX_RECEIPTS_PER_SESSION) {
      receipts.splice(0, receipts.length - MAX_RECEIPTS_PER_SESSION)
    }
  }

  /**
   * Parses a published `<gate-state>` block and replaces this session's
   * snapshot. A malformed or missing block keeps the previous snapshot
   * (fail closed, no throw).
   *
   * Note: the published block does NOT carry the current-task pointer —
   * `formatGateStateBlock` emits only gate/status/details/repairRound/
   * maxRepairRounds/advisories/workflow — so the projection honestly
   * reports `currentTask: null` rather than guessing.
   */
  updateGateStateFromBlock(sessionId: string, blockText: string): void {
    const snapshot = parseGateStateBlock(blockText)
    if (snapshot) {
      this.gateStateBySession.set(sessionId, snapshot)
    }
  }

  /**
   * Projects the session's receipts to the `openbuff/getReceipts` result
   * shape, newest first. `limit` defaults to 50 and is capped at 256.
   */
  getReceipts(sessionId: string, limit?: number): AcpReceiptsResult {
    const requested =
      typeof limit === 'number' && Number.isFinite(limit)
        ? Math.floor(limit)
        : DEFAULT_RECEIPT_LIMIT
    const boundedLimit = Math.min(Math.max(requested, 0), MAX_RECEIPT_LIMIT)
    const receipts = this.receiptsBySession.get(sessionId) ?? []
    return {
      receipts: receipts
        .slice()
        .reverse()
        .slice(0, boundedLimit)
        .map(projectEnvelopeReceipt),
    }
  }

  /** Projects the session's gate snapshot to the `openbuff/gateState` shape. */
  getGateState(sessionId: string): AcpGateStateResult {
    const snapshot = this.gateStateBySession.get(sessionId)
    return {
      phase: snapshot?.phase ?? 'idle',
      // The published block carries no current-task pointer (see
      // updateGateStateFromBlock), so this stays null by construction.
      currentTask: null,
    }
  }
}
