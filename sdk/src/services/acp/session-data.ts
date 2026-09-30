import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'

import {
  capabilityMapV1Schema,
  toWireMutation as toWireMutationV1,
  type CapabilityMapV1,
  type GateStateV1,
  type LaneV1,
  type WireFileMutationResultV1,
} from '@codebuff/common/protocol/acp-ext-v1'
import type {
  FileMutationActionV1,
  FileMutationResultV1,
} from '@codebuff/common/tools/results/filesystem'

import { defaultCapabilityMapV1 } from './ext-methods'

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
  | { kind: 'capabilities'; capabilities: CapabilityMapV1 }

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
  mutation: WireFileMutationResultV1
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
  | 'skipped'
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
 * Allowlist gate for interpolating a session id into a journal path. The
 * ACP client fully controls the id via session/load (loadSession accepts
 * any string), so only single-segment filename-safe ids may ever reach the
 * filesystem: alphanumerics plus `.`, `_`, `~`, `-` — never a path
 * separator, never the traversal tokens `.`/`..`, bounded to one NAME_MAX
 * component. Ids issued by session/new are UUIDs and always pass.
 */
const JOURNAL_SAFE_SESSION_ID_RE = /^[A-Za-z0-9._~-]+$/

function isJournalSafeSessionId(sessionId: string): boolean {
  return (
    sessionId.length <= 255 &&
    sessionId !== '.' &&
    sessionId !== '..' &&
    JOURNAL_SAFE_SESSION_ID_RE.test(sessionId)
  )
}

/**
 * GV-07 replay gate for journal-restored receipt envelopes: the journal lives
 * under the project root, which serve mode treats as untrusted, so a replayed
 * envelope is accepted only when it is ALREADY redaction-clean — every action
 * must lack the content-bearing fields (`afterContent`, `patch`,
 * `editAnchor`) and `freshCapabilities` must be exactly empty. The ext-v1
 * dispatcher re-validates the full `receiptEnvelopeV1Schema` again at serve
 * time; this gate keeps content-bearing journal bytes out of the store in the
 * first place.
 */
function isRedactionCleanWireEnvelope(
  value: Record<string, unknown>,
): value is AcpWireReceiptEnvelope {
  if (
    value.kind !== 'openbuff.receipt_envelope' ||
    value.version !== 1 ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0 ||
    value.laneId !== 'main'
  ) {
    return false
  }
  if (value.toolCallId !== undefined && typeof value.toolCallId !== 'string') {
    return false
  }
  const mutation = value.mutation
  if (
    !isPlainRecord(mutation) ||
    mutation.kind !== 'file_mutation_result' ||
    mutation.version !== 1 ||
    !Array.isArray(mutation.actions)
  ) {
    return false
  }
  for (const action of mutation.actions) {
    if (!isPlainRecord(action)) return false
    if ('afterContent' in action || 'patch' in action || 'editAnchor' in action) {
      return false
    }
  }
  const freshCapabilities = mutation.freshCapabilities
  if (!Array.isArray(freshCapabilities) || freshCapabilities.length !== 0) {
    return false
  }
  return true
}

/**
 * Builds the wire mutation for a receipt envelope: the published §6.2
 * projection drops the content-bearing fields (`afterContent`, `patch`,
 * `editAnchor`) from every action, pins `freshCapabilities` to the empty
 * tuple, and keeps `authorityReceipt` verbatim (it holds only ids, hashes,
 * tiers, and statuses).
 */
export function toWireMutation(
  mutation: FileMutationResultV1,
): WireFileMutationResultV1 {
  // The published §6.2 wire projection (in @codebuff/common) is the single
  // source of truth: it REBUILDS the mutation field-by-field against the
  // strict wire allowlist instead of spreading the internal shape, so no
  // field outside wireFileMutationResultV1Schema survives into the stored
  // envelope. Every envelope the store records — including one recorded
  // through the public recordReceipt path carrying content-bearing fields or
  // fresh capabilities — therefore parses against the ext-v1 receipt
  // contract at serve time instead of collapsing to receipt_not_found.
  return toWireMutationV1(mutation)
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
  if (status === 'skipped') {
    // A skip is its own recorded status (the ext-v1 gate contract carries
    // 'skipped' plus skipReason), distinct from a failure.
    return 'skipped'
  }
  if (status === 'failed') {
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
 * Projects the latest gate snapshot onto the ext-v1 GateStateV1 (§6.4). The
 * published `<gate-state>` block carries no file lists, so `pendingFiles` and
 * `passedFiles` are honest empties, and every optional field is omitted
 * unless the snapshot actually recorded it.
 */
function projectGateStateV1(
  snapshot: AcpGateStateSnapshot | undefined,
  sessionId: string,
): GateStateV1 {
  let status: GateStateV1['status']
  switch (snapshot?.phase) {
    case 'final_response_allowed':
      status = 'passed'
      break
    case 'skipped':
      // The ext-v1 contract defines 'skipped' (plus an optional skipReason) as
      // its own status: a deliberately skipped gate must not carry failure
      // semantics to ext-v1 consumers.
      status = 'skipped'
      break
    case 'blocked':
      status = 'failed'
      break
    case 'validating':
      status = 'validating'
      break
    case 'reviewing':
      status = 'reviewing'
      break
    default:
      status = 'idle'
  }
  return {
    kind: 'openbuff.gate_state',
    version: 1,
    sessionId,
    status,
    pendingFiles: [],
    passedFiles: [],
    // The producer's `details` line IS the published skip explanation (the
    // gate-state block emitter records the skip reason as `details`), so a
    // skipped snapshot surfaces it as the contract's optional skipReason;
    // nothing is invented when the producer recorded none.
    ...(snapshot?.phase === 'skipped' && snapshot.details.length > 0
      ? { skipReason: snapshot.details }
      : {}),
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
  /** Latest ext-v1 capability map per session (one per session, replace-on-set). */
  private readonly capabilitiesBySession = new Map<string, CapabilityMapV1>()
  /** Latest confirmed workspace revision per session (drives the main lane). */
  private readonly workspaceRevisionBySession = new Map<string, number>()
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

  /**
   * Resolves the session's journal path, or undefined when journaling is
   * disabled OR the session id is unsafe to interpolate into a path. Every
   * journal read/write goes through this gate so a client-controlled
   * sessionId (`session/load` accepts any id) can never escape `journalDir`
   * into an append/create write or read of `.jsonl` files elsewhere. Fails
   * closed: the in-memory store keeps working, only the journal IO is
   * skipped.
   */
  private journalFilePathFor(sessionId: string): string | undefined {
    const dir = this.journalDir
    if (dir === undefined || !isJournalSafeSessionId(sessionId)) {
      return undefined
    }
    return `${dir}/${sessionId}.jsonl`
  }

  /** Appends one complete JSON line (atomic enough for a single process). */
  private appendJournalLine(sessionId: string, line: JournalLine): void {
    const dir = this.journalDir
    const filePath = this.journalFilePathFor(sessionId)
    if (dir === undefined || filePath === undefined) return
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
    const filePath = this.journalFilePathFor(sessionId)
    if (dir === undefined || filePath === undefined) return
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
    const capabilities = this.capabilitiesBySession.get(sessionId)
    if (capabilities) {
      const line: JournalLine = { kind: 'capabilities', capabilities }
      lines.push(JSON.stringify(line))
    }
    const contents = lines.length > 0 ? `${lines.join('\n')}\n` : ''
    this.queueJournalWrite(async () => {
      await this.ensureJournalDir(dir)
      await writeFile(filePath, contents, 'utf8')
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
    this.trackWorkspaceRevision(sessionId, mutation.workspaceRevision)
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
      // The envelope carries the §6.2 wire projection (freshCapabilities is
      // the empty tuple the wire schema pins), so the typed store shape and
      // the published ext-v1 contract cannot drift.
      mutation: toWireMutation(mutation),
    }
    if (toolCallId !== undefined) {
      envelope.toolCallId = toolCallId
    }
    this.trackWorkspaceRevision(sessionId, event.workspaceRevision)
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
   * Tracks the latest confirmed workspace revision for a session (the main
   * lane's `baseRevision`, §6.3). Monotonic: a lower revision never rewinds
   * the recorded value.
   */
  private trackWorkspaceRevision(
    sessionId: string,
    revision: number | undefined,
  ): void {
    if (
      typeof revision !== 'number' ||
      !Number.isFinite(revision) ||
      revision < 0
    ) {
      return
    }
    const current = this.workspaceRevisionBySession.get(sessionId)
    if (current === undefined || revision > current) {
      this.workspaceRevisionBySession.set(sessionId, revision)
    }
  }

  /**
   * Stores the session's ext-v1 capability map (§6.1, replace-on-set) and
   * journals it so a restored session keeps its advertised snapshot.
   */
  setCapabilities(sessionId: string, capabilities: CapabilityMapV1): void {
    this.capabilitiesBySession.set(sessionId, capabilities)
    this.appendJournalLine(sessionId, { kind: 'capabilities', capabilities })
  }

  /** Returns the session's ext-v1 capability map, or undefined when never set. */
  getCapabilities(sessionId: string): CapabilityMapV1 | undefined {
    return this.capabilitiesBySession.get(sessionId)
  }

  /**
   * Whether this store mirrors to a durable journal directory. Drives the
   * §6.1 capability map's honest `journal` flags: a purely in-memory store
   * must not advertise resume/replay that `session/load` cannot honor.
   */
  hasJournal(): boolean {
    return this.journalDir !== undefined
  }

  /**
   * Fetches one full redacted receipt envelope by its mutation receiptId
   * (§6.2). Envelopes recorded without a receiptId are NOT fetchable by id —
   * they only surface in the `openbuff/getReceipts` list projection. The same
   * applies to envelopes recorded without a `toolCallId`: the published
   * ext-v1 result contract (`receiptEnvelopeV1Schema`) requires one, so a
   * tool-less envelope has no wire representation and is not addressable by
   * `_openbuff.dev/receipts/get`.
   */
  getReceipt(
    sessionId: string,
    receiptId: string,
  ): AcpWireReceiptEnvelope | undefined {
    const receipts = this.receiptsBySession.get(sessionId) ?? []
    return receipts.find(
      (envelope) =>
        envelope.mutation.receiptId === receiptId &&
        envelope.toolCallId !== undefined,
    )
  }

  /**
   * The single P1 lane (§6.3): `main`, active, baseRevision = the latest
   * confirmed workspace revision (0 before any mutation is confirmed).
   */
  getMainLane(sessionId: string): LaneV1 {
    return {
      kind: 'openbuff.lane',
      version: 1,
      laneId: 'main',
      status: 'active',
      baseRevision: this.workspaceRevisionBySession.get(sessionId) ?? 0,
      agentIds: [],
    }
  }

  /**
   * Projects the session's latest gate snapshot onto the ext-v1 GateStateV1
   * (§6.4). A session with no published block reports `idle`.
   */
  getGateStateV1(sessionId: string): GateStateV1 {
    return projectGateStateV1(this.gateStateBySession.get(sessionId), sessionId)
  }

  /**
   * Replays `<journalDir>/<sessionId>.jsonl` into the in-memory maps so a
   * `session/load`-restored session recovers its receipt history and last
   * gate-state snapshot. Receipts replay newest-last capped at
   * MAX_RECEIPTS_PER_SESSION; the snapshot is the last valid `gate_state`
   * line. Malformed lines are skipped fail-closed and any read failure
   * degrades to "no journal" — this never throws. Receipt envelopes are
   * replayed only when already redaction-clean (GV-07), and capability
   * lines re-derive the honest baseline map instead of serving the
   * replayed bytes verbatim.
   *
   * Returns whether a journal file existed for the session.
   */
  async restoreFromJournal(sessionId: string): Promise<boolean> {
    // The same gate guards the READ side: replaying a traversal id must
    // not read outside the journal directory either.
    const filePath = this.journalFilePathFor(sessionId)
    if (filePath === undefined) return false
    let text: string
    try {
      text = await readFile(filePath, 'utf8')
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
      // The journal lives under the project root, which serve mode treats
      // as untrusted. Receipt envelopes are accepted only when proven
      // redaction-clean (the gate above); gate-state lines restore
      // best-effort (the plain-object check only bridges the JSON
      // round-trip); capability lines only validate the SHAPE — the stored
      // map is re-derived from this store's real posture, never served from
      // the replayed bytes (a schema-valid line from a tampered journal must
      // not become a security advertisement).
      if (
        parsed.kind === 'receipt_envelope' &&
        isPlainRecord(parsed.envelope)
      ) {
        if (!isRedactionCleanWireEnvelope(parsed.envelope)) continue
        receipts.push(parsed.envelope)
        if (receipts.length > MAX_RECEIPTS_PER_SESSION) {
          receipts.splice(0, receipts.length - MAX_RECEIPTS_PER_SESSION)
        }
      } else if (
        parsed.kind === 'gate_state' &&
        isPlainRecord(parsed.snapshot)
      ) {
        snapshot = parsed.snapshot as AcpGateStateSnapshot
      } else if (parsed.kind === 'capabilities') {
        const replayed = capabilityMapV1Schema.safeParse(parsed.capabilities)
        if (replayed.success) {
          // Honest re-derivation: journal replay exists so a restored session
          // HAS a capability map (§6.1) — its journal flags come from THIS
          // store, and every other field is the honest P1 serve default. The
          // replayed values are validated but never trusted.
          this.capabilitiesBySession.set(
            sessionId,
            defaultCapabilityMapV1({ journalAvailable: this.hasJournal() }),
          )
        }
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
