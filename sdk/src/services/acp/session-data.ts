import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'

import type {
  FileMutationActionV1,
  FileMutationResultV1,
} from '@codebuff/common/tools/results/filesystem'

/**
 * Structural mirror of the run loop's `FilesystemMutationEvent`
 * (sdk/src/run.ts). Declared locally rather than imported to avoid an sdk
 * run.ts → session-data.ts import cycle: run.ts pulls in the entire tool
 * surface, so even a type-only import risks a cycle, and the shape here is
 * tiny and stable. This is the run-loop's confirmed-mutation channel
 * (workspaceRevision/snapshotId correlated); it carries only paths/hashes/ids
 * and already excludes `afterContent`/`patch`/`editAnchor`, so recording it is
 * redaction-preserving by construction.
 */
type FilesystemMutationEventLike = {
  toolName: string
  callId: string
  operationId: string
  receiptId?: string
  workspaceRevision: number
  workspaceSnapshotId: string
  actions: Array<{
    action: 'create' | 'update' | 'delete' | 'move'
    path: string
    destinationPath?: string
    beforeHash: string | null
    afterHash: string | null
  }>
}

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
 * Constructor options for `AcpSessionData`. Everything is optional so the
 * no-journal construction stays byte-identical to the pure in-memory store
 * (the env-architecture checks forbid reading `process.env` in this layer,
 * so the journal directory is always injected by the caller).
 */
export type AcpSessionDataOptions = {
  /**
   * When set, receipts and gate-state snapshots are mirrored to an
   * append-only JSONL journal (`<journalDir>/<sessionId>.jsonl`) so a
   * session restored via `session/load` can replay its history across
   * process restarts. Omitted → no filesystem access at all.
   */
  journalDir?: string
}

/**
 * One JSONL journal record. Receipts persist the ALREADY-REDACTED envelope
 * returned by `toWireReceipt` (redaction is normative: what hits disk is
 * exactly what the wire would see); gate snapshots persist the parsed
 * `AcpGateStateSnapshot`, never the raw block text.
 */
type JournalLine =
  | { kind: 'receipt_envelope'; envelope: AcpWireReceiptEnvelope }
  | { kind: 'gate_state'; snapshot: AcpGateStateSnapshot }

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
 * agent process; sessions are keyed by ACP session id. When constructed
 * with a `journalDir`, every receipt/gate-state mutation is mirrored to a
 * durable per-session JSONL journal (replayed via `restoreFromJournal`);
 * without one the store stays purely in-memory with zero filesystem access.
 */
export class AcpSessionData {
  /** Newest-last; capped at MAX_RECEIPTS_PER_SESSION by recordReceipt. */
  private readonly receiptsBySession = new Map<string, AcpWireReceiptEnvelope[]>()
  /** Latest gate-state snapshot per session (one per session, replace-on-update). */
  private readonly gateStateBySession = new Map<string, AcpGateStateSnapshot>()
  /** Injected journal directory; undefined keeps the store purely in-memory. */
  private readonly journalDir?: string
  /** Directories already mkdir'd (lazy, recursive, once per journal dir). */
  private readonly journalDirsCreated = new Set<string>()
  /**
   * Serializes all journal writes for this instance. Independent
   * fire-and-forget writes could otherwise race the bounded rewrite (a late
   * append could resurrect a dropped receipt or land after a truncating
   * rewrite), so every write is chained behind the previous one.
   */
  private journalQueue: Promise<void> = Promise.resolve()

  constructor(options?: AcpSessionDataOptions) {
    this.journalDir = options?.journalDir
  }

  /** Journal IO is best-effort: failures are swallowed, never rethrown. */
  private queueJournalWrite(write: () => Promise<void>): void {
    this.journalQueue = this.journalQueue.then(write).catch(() => {})
  }

  /** Lazily creates the journal directory (recursive mkdir, once per dir). */
  private async ensureJournalDir(dir: string): Promise<void> {
    if (this.journalDirsCreated.has(dir)) return
    await mkdir(dir, { recursive: true })
    this.journalDirsCreated.add(dir)
  }

  /** Appends one complete JSON line (atomic enough for a single process). */
  private appendJournalLine(sessionId: string, line: JournalLine): void {
    const dir = this.journalDir
    if (!dir) return
    const filePath = `${dir}/${sessionId}.jsonl`
    const encoded = `${JSON.stringify(line)}\n`
    this.queueJournalWrite(async () => {
      await this.ensureJournalDir(dir)
      await appendFile(filePath, encoded, 'utf8')
    })
  }

  /**
   * Rewrites the session's journal from current in-memory state (newest
   * MAX_RECEIPTS_PER_SESSION envelopes + latest snapshot), truncating the
   * SAME file so it cannot grow without bound once receipts start dropping.
   */
  private rewriteJournal(sessionId: string): void {
    const dir = this.journalDir
    if (!dir) return
    const receipts = this.receiptsBySession.get(sessionId) ?? []
    const snapshot = this.gateStateBySession.get(sessionId)
    const lines = receipts.map((envelope) => {
      const line: JournalLine = { kind: 'receipt_envelope', envelope }
      return JSON.stringify(line)
    })
    if (snapshot) {
      const line: JournalLine = { kind: 'gate_state', snapshot }
      lines.push(JSON.stringify(line))
    }
    const contents = lines.length > 0 ? `${lines.join('\n')}\n` : ''
    this.queueJournalWrite(async () => {
      await this.ensureJournalDir(dir)
      await writeFile(`${dir}/${sessionId}.jsonl`, contents, 'utf8')
    })
  }

  /**
   * Records a redacted receipt envelope for a real file mutation. Unknown
   * session ids are fine — the store creates the bucket lazily. When a
   * journalDir is configured, the already-redacted envelope is persisted:
   * appended as one line, or (when this record dropped an older receipt in
   * memory) the whole journal is rewritten from the bounded in-memory state
   * so the file cannot grow without bound.
   */
  recordReceipt(
    sessionId: string,
    mutation: FileMutationResultV1,
    toolCallId?: string,
  ): void {
    this.pushEnvelope(sessionId, toWireReceipt(mutation, sessionId, toolCallId))
  }

  /**
   * Records a redacted receipt directly from the run loop's
   * `FilesystemMutationEvent` — its confirmed-mutation channel
   * (workspaceRevision/snapshotId correlated). That event already carries no
   * content-bearing fields (`afterContent`/`patch`/`editAnchor` are excluded by
   * construction) — only paths, hashes, and ids — so projecting it into an
   * envelope is redaction-preserving with nothing content-bearing to drop. The
   * event's actions have no `actionId`, so a stable synthetic id
   * (`${operationId}:${index}`) is used, and `freshCapabilities` is `[]` since
   * no cap.v3 token ever rides this channel.
   */
  recordReceiptFromMutationEvent(
    sessionId: string,
    event: FilesystemMutationEventLike,
    toolCallId?: string,
  ): void {
    const actions: FileMutationActionV1[] = event.actions.map(
      (action, index) => ({
        actionId: `${event.operationId}:${index}`,
        index,
        action: action.action,
        path: action.path,
        ...(action.destinationPath !== undefined
          ? { destinationPath: action.destinationPath }
          : {}),
        outcome: 'applied' as const,
        beforeHash: action.beforeHash,
        afterHash: action.afterHash,
      }),
    )
    const mutation: FileMutationResultV1 = {
      kind: 'file_mutation_result',
      version: 1,
      operationId: event.operationId,
      outcome: 'applied',
      actions,
      authorityTier: 'conditional_commit',
      ...(event.receiptId !== undefined ? { receiptId: event.receiptId } : {}),
      workspaceRevision: event.workspaceRevision,
      workspaceSnapshotId: event.workspaceSnapshotId,
      errors: [],
      freshCapabilities: [],
    }
    const envelope: AcpWireReceiptEnvelope = {
      kind: 'openbuff.receipt_envelope',
      version: 1,
      sessionId,
      laneId: 'main',
      mutation,
    }
    if (toolCallId !== undefined) {
      envelope.toolCallId = toolCallId
    }
    this.pushEnvelope(sessionId, envelope)
  }

  /**
   * Shared receipt-storage tail for `recordReceipt` and
   * `recordReceiptFromMutationEvent`: appends the already-redacted envelope to
   * the bounded per-session buffer (newest wins, capped at
   * MAX_RECEIPTS_PER_SESSION) and mirrors it to the journal — a plain append,
   * or a full rewrite from the bounded in-memory state whenever this push
   * dropped an older receipt so the file cannot grow without bound.
   */
  private pushEnvelope(
    sessionId: string,
    envelope: AcpWireReceiptEnvelope,
  ): void {
    let receipts = this.receiptsBySession.get(sessionId)
    if (!receipts) {
      receipts = []
      this.receiptsBySession.set(sessionId, receipts)
    }
    receipts.push(envelope)
    if (receipts.length > MAX_RECEIPTS_PER_SESSION) {
      receipts.splice(0, receipts.length - MAX_RECEIPTS_PER_SESSION)
      this.rewriteJournal(sessionId)
      return
    }
    this.appendJournalLine(sessionId, {
      kind: 'receipt_envelope',
      envelope,
    })
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
      // Persist the parsed snapshot, never the raw block text.
      this.appendJournalLine(sessionId, { kind: 'gate_state', snapshot })
    }
  }

  /**
   * Replays `<journalDir>/<sessionId>.jsonl` into the in-memory maps so a
   * `session/load`-restored session recovers its receipt history and last
   * gate-state snapshot. Receipts replay newest-last capped at
   * MAX_RECEIPTS_PER_SESSION; the snapshot is the last valid `gate_state`
   * line. Malformed lines are skipped fail-closed and any read failure
   * degrades to "no journal" — this never throws.
   *
   * Returns whether a journal file existed for the session.
   */
  async restoreFromJournal(sessionId: string): Promise<boolean> {
    const dir = this.journalDir
    if (!dir) return false
    let text: string
    try {
      text = await readFile(`${dir}/${sessionId}.jsonl`, 'utf8')
    } catch {
      return false
    }
    const receipts: AcpWireReceiptEnvelope[] = []
    let snapshot: AcpGateStateSnapshot | undefined
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (!isPlainRecord(parsed)) continue
      // Journal lines were written by this class, so the persisted record
      // shapes are trusted after the plain-object shape check; the casts
      // only restore the static types JSON round-tripping erased.
      if (
        parsed.kind === 'receipt_envelope' &&
        isPlainRecord(parsed.envelope)
      ) {
        receipts.push(parsed.envelope as AcpWireReceiptEnvelope)
        if (receipts.length > MAX_RECEIPTS_PER_SESSION) {
          receipts.splice(0, receipts.length - MAX_RECEIPTS_PER_SESSION)
        }
      } else if (
        parsed.kind === 'gate_state' &&
        isPlainRecord(parsed.snapshot)
      ) {
        snapshot = parsed.snapshot as AcpGateStateSnapshot
      }
    }
    if (receipts.length > 0) {
      this.receiptsBySession.set(sessionId, receipts)
    }
    if (snapshot) {
      this.gateStateBySession.set(sessionId, snapshot)
    }
    return true
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
