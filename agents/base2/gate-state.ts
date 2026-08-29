import type { SpecialistReviewerAgent } from '@codebuff/common/agents/specialist-risk-router'

export type Base2ActiveWorkPhase =
  | 'idle'
  | 'awaiting_validation'
  | 'repair_loop'
  | 'awaiting_review'
  | 'blocked'
  | 'final_response_allowed'

export type Base2WorkflowTodo = {
  content: string
  status: string
  completed: boolean
}

export type Base2WorkflowTodoProgress = {
  todos: Base2WorkflowTodo[]
  completedCount: number
  totalCount: number
  nextWorkflowAction: string
}

export type Base2ReviewReceipt = {
  gateId: string
  reviewer: string
  verdict: 'LOOKS_GOOD' | 'NON_BLOCKING'
  snapshotFingerprint: string
  reviewedFiles: string[]
  reviewedFileCount?: number
  coverage?: 'covered' | 'missing' | 'n/a'
  dimensions: Record<string, string>
  findings: Array<{
    id: string
    text: string
    severity?: string
    dimension?: string
    evidence: string[]
    evidenceCount?: number
    evidenceTruncated?: boolean
    correction?: string
    correctionTruncated?: boolean
  }>
  findingCount?: number
  /**
   * Non-blocking observations: recorded and displayed, never repair targets.
   * Stored verbatim; the `<gate-state>` emitter escapes `</` as `<\/` (a legal
   * JSON string escape) so advisory text containing the literal closing
   * delimiter cannot truncate that tag-delimited block for its readers.
   */
  advisories?: string[]
  advisoryCount?: number
  requirementCoverage: Array<{
    requirement: string
    status: string
    evidence: string[]
    evidenceCount?: number
    evidenceTruncated?: boolean
  }>
  requirementCoverageCount?: number
  receiptTruncated?: boolean
  recordedAt: string
}

// Typed runtime-owned gate state. Field names are kept identical to the
// historical Base2ActiveWorkState shape so existing serialized
// base2ActiveWork objects keep round-tripping. The new
// gatePassedFingerprint is required for durable gate-pass reuse. States
// that lack a fingerprint (older serialized state, or any pass that did
// not capture working-tree content hashes) fail closed and rerun the
// validation/reviewer gate instead of reusing the stored pass.
export type Base2GateState = {
  pendingGateFiles: string[]
  gatePassedFiles: string[]
  gatePassedPendingFiles: string[]
  gatePassedReviewerVerdict: string
  gatePassedValidationSummary: string
  gatePassedFingerprint: string
  /**
   * Per-file content markers for every file currently credited into
   * gatePassedFiles. Maps a normalized project-relative file path to the
   * content marker (see readGateFileContentMarker) captured at the moment the
   * file was credited. Used by the generalized per-file eviction guard to
   * detect that a credited file drifted after crediting and reopen the gate
   * for exactly that file. Backward-compatible: older serialized state lacks
   * this field, so it is treated as `{}`; a credited file with no stored
   * marker is treated as drifted (fail closed). MUST stay a plain
   * JSON-serializable record (never a Map/Set).
   */
  gatePassedFileMarkers?: Record<string, string>
  /**
   * Content fingerprint of the reviewable-source subset the last time the
   * final code-reviewer gate passed. Used to skip re-review when a
   * subsequent turn (e.g. a git-action turn with no new source edits)
   * reopens the gate on an unchanged reviewable set. Backward-compatible:
   * older serialized state lacks this field (treated as unset).
   */
  reviewedReviewableFingerprint?: string
  lastReviewerGateSkipReason: string
  /**
   * Durable one-line mid-turn gate-progress note (e.g. "gate: validation
   * passed; reviewer code-reviewer running"). Written through the inline
   * setGateProgress helper in base2.ts, except on the gate-pass path, which
   * resets the field directly. Rendered by buildPinnedActiveWorkMessage as a
   * "Gate progress:" line in the pinned active-work message; when it is the
   * only change since the last emitted pinned block, base2.ts yields a
   * delta-only add_message carrying just that line instead of the full block.
   * Reset to '' when the gate passes so the next edit cycle starts fresh.
   * Backward-compatible: older serialized state lacks this field (treated as
   * unset).
   */
  gateProgressLine?: string
}

export type Base2ActiveWorkState = Base2GateState & {
  touchedFiles: string[]
  changedFiles: string[]
  currentPhase: Base2ActiveWorkPhase
  latestWorkSummary: string
  openReviewerBlockers: string[]
  openReviewerFindings?: Array<{
    id: string
    gateId: string
    text: string
    status: 'open' | 'resolved' | 'condoned'
    taskId?: string
    files: string[]
    snapshotFingerprint: string
    /** Reviewer family that produced this blocking finding. */
    reviewer?: 'code-reviewer' | 'security-reviewer' | SpecialistReviewerAgent
    createdAt: string
  }>
  /**
   * Finding texts that a repair-editor has already reported as addressed via
   * findingsAddressed, but a fresh reviewer re-returned with identical text.
   * These are 'condoned' — no longer re-elevated as blockers — so the
   * reviewer → repair → re-review loop converges instead of looping forever
   * on the same NON_BLOCKING architectural commentary. Reset when the gate
   * passes. Backward-compatible: older serialized state lacks this field
   * (treated as empty). Bounded to the most recent 200 entries at every write
   * site (like `reviewReceipts`) so durable state cannot grow without bound
   * across default-unlimited repair rounds. MUST stay a plain
   * JSON-serializable array.
   */
  condonedFindingTexts?: string[]
  /**
   * T1.5: condone keys of the form `<verdictClass>::text:<strippedText>` and
   * `<verdictClass>::id:<reviewerSuppliedId>`, where verdictClass is
   * `NON_BLOCKING`, `BLOCKING`, or `*` for a text that carries no verdict
   * prefix (legacy serialized state only — every reviewer path now stores the
   * prefixed blocker string). Matching is per class with ONE-DIRECTIONAL
   * de-escalation: a `*` entry condones only another `*` finding, a `BLOCKING`
   * entry ALSO condones a `NON_BLOCKING` re-raise of the same identity (a
   * de-escalated re-raise carries no new information, so the reviewer → repair
   * → re-review loop still converges instead of spawning a repair round whose
   * already-applied repair trips the no-progress guard), and a `NON_BLOCKING`
   * entry NEVER condones a `BLOCKING` re-raise. `condonedFindingTexts` alone
   * strips the prefix before comparing, so a nit condoned as NON_BLOCKING was
   * silently swallowed when a later review re-raised the SAME text as BLOCKING;
   * an escalation is new information and must reopen the gate. Reset when the
   * gate passes. Backward-compatible: older serialized state lacks this field,
   * and the legacy text path is consulted only while this list is empty (fail
   * closed). Bounded to the most recent 200 entries at every write site (like
   * `reviewReceipts`). MUST stay a plain JSON-serializable array.
   */
  condonedFindingKeys?: string[]
  /**
   * Reviewer family that must re-attest after a runtime-attested repair changes
   * the workspace and validation passes. Missing legacy provenance fails closed
   * into the code-reviewer path rather than permitting finalization.
   */
  requiredReviewerRevalidation?:
    | 'code-reviewer'
    | 'security-reviewer'
    | SpecialistReviewerAgent
  validationEvidence?: Array<{
    gateId: string
    files: string[]
    snapshotFingerprint: string
    summary: string
    assurance: 'full' | 'reduced' | 'none'
    recordedAt: string
  }>
  lastValidationSummary: string
  nextRequiredAction: string
  lastPinnedStateMessage: string
  workflowTodoProgress?: Base2WorkflowTodoProgress
  /**
   * Number of automated repair-editor rounds that have run for the current
   * batch of pending gate files. Reset to 0 whenever the gate passes or a
   * fresh set of edits is recorded. Telemetry/counter only by default:
   * repair loops are progress-gated and unlimited unless an optional cap is
   * set (option maxRepairRounds / env OPENBUFF_MAX_REPAIR_ROUNDS, max 20).
   * Backward-compatible: older serialized state without this field is
   * treated as 0.
   */
  repairRoundCount?: number
  /**
   * Durable token of the active repair session. Set when the repair loop
   * begins (first round) and cleared only when the gate passes. While a
   * session is active, recordChangedFiles does NOT reset repairRoundCount,
   * preventing reset-on-edit circumvention where a spurious non-repair edit
   * to a failing file would silently reset the repair budget. Backward-
   * compatible: older serialized state lacks this field (treated as no
   * active session).
   */
  repairSessionId?: string
  /**
   * Legacy flag from the removed post-budget escalation editor path. Kept for
   * serialized-state compatibility; the default unlimited repair loop no
   * longer sets or depends on this. Backward-compatible.
   */
  repairEscalationDone?: boolean
  /**
   * Legacy alias for securityReviewGateDone retained for serialized-state
   * compatibility. The automated security gate is post-edit.
   */
  preEditSecurityReviewDone?: boolean
  /**
   * True after the automated post-edit security-reviewer gate has
   * fired for the current pending gate file set. Reset to false whenever the
   * pending gate file set changes (detected via auxGatesLastPendingFiles vs
   * gateFileSetsEqual). Backward-compatible: older serialized state lacks
   * this field (treated as false).
   */
  securityReviewGateDone?: boolean
  /** Number of consecutive final-reviewer crashes for the pending file set. */
  reviewerCrashCount?: number
  /** Number of automatic reviewer retries caused by protocol/attestation errors. */
  reviewerProtocolRetryCount?: number
  /**
   * Number of reviewer-finding repair rounds for the current snapshot family.
   * Telemetry/counter only by default (unlimited / progress-gated). Optional
   * hard cap via maxReviewerRepairRounds / OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS
   * (max 20). NON_BLOCKING findings also burn rounds under LOOKS_GOOD-only
   * finalization.
   */
  reviewerRepairRoundCount?: number
  /** Number of consecutive schema-valid agent runs that produced no verdict. */
  reviewerNoVerdictCount?: number
  /** One-use, snapshot-bound reviewer bypass challenge. */
  reviewerBypassChallenge?: {
    id: string
    fingerprint: string
    issuedAfterMessageIndex: number
    consumed: boolean
  }
  /** Durable reason when the user explicitly authorizes a reviewer bypass. */
  reviewerGateBypassReason?: string
  /** Durable audit record for an explicitly authorized gate bypass. */
  reviewerGateBypassRecord?: {
    reason: string
    authorizedAt: string
    pendingFiles: string[]
    fingerprint: string
    validationSummary: string
  }
  /** Assurance level from configured validation evidence. */
  validationAssurance?: 'full' | 'reduced' | 'none'
  /** Snapshot whose validation failed for infrastructure/policy reasons rather than source diagnostics. */
  validationInfrastructureBypassFingerprint?: string
  /**
   * M3 (R1b) — true after the automated post-edit test-writer gate has fired
   * for the current pending gate file set. Reset on pending-file-set change.
   * Backward-compatible.
   */
  testWriterGateDone?: boolean
  /**
   * M3 (R1c) — true after the automated post-edit doc-writer gate has fired
   * for the current pending gate file set. Reset on pending-file-set change.
   * Backward-compatible.
   */
  docWriterGateDone?: boolean
  /** Reviewer-family specialist gates completed for the current pending set. */
  specialistReviewGatesDone?: string[]
  /**
   * Every reviewer family that still owes a fresh re-attestation. Superset of
   * requiredReviewerRevalidation, which is retained as the first entry for
   * serialized-state compatibility. Missing/legacy state is rehydrated from
   * openReviewerFindings, so an owed reviewer can never be silently dropped.
   * MUST stay a plain array (never a Set) so the state round-trips as JSON.
   */
  owedReviewerRevalidations?: Array<
    'code-reviewer' | 'security-reviewer' | SpecialistReviewerAgent
  >
  /**
   * Content fingerprint of the reviewable pending subset at the moment each
   * specialist in specialistReviewGatesDone was credited. A credited
   * specialist with no stored fingerprint (legacy state) or a mismatched
   * fingerprint is treated as uncredited (fail closed), so a path-scoped
   * legacy receipt can never attest bytes it did not review. MUST stay a plain
   * JSON-serializable record (never a Map).
   */
  specialistReviewGateFingerprints?: Record<string, string>
  /**
   * Same snapshot binding for the security aux gate credit. Missing or
   * mismatched (including a non-attestable sentinel) reopens the security
   * gate rather than reusing unearned credit.
   */
  securityReviewGateFingerprint?: string
  /**
   * Repair rounds for the specialist -> repair -> re-review loop. Telemetry
   * only by default (unlimited / progress-gated via no-progress and incomplete
   * receipt exits). Optional hard cap via maxSpecialistRepairRounds /
   * OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS (max 20). Absent legacy state is
   * treated as 0.
   */
  specialistRepairRoundCount?: number
  /**
   * Per-specialist consecutive no-verdict runs. Bounded by
   * MAX_SPECIALIST_NO_VERDICT_RETRIES; while under the cap the specialist is
   * NOT credited (fail closed) and re-runs, and once over the cap it is
   * credited with reduced assurance so the gate cannot spin forever. MUST stay
   * a plain JSON-serializable record.
   */
  specialistNoVerdictCounts?: Record<string, number>
  /** Compact source-backed receipts from successful reviewer passes. */
  reviewReceipts?: Base2ReviewReceipt[]
  /**
   * M3 (R1d) — snapshot of the pendingGateFiles used to detect that the
   * pending gate file set has changed, so the three aux-gate done-flags above
   * can be reset via gateFileSetsEqual. Backward-compatible: older serialized
   * state lacks this field (treated as empty).
   */
  auxGatesLastPendingFiles?: string[]
  /**
   * Pin/lag UX: count of task-related dirty reviewable files in the latest
   * dirty snapshot (gate-passed and unreviewed). Optional for round-trip.
   */
  dirtyReviewableCount?: number
  /**
   * Pin/lag UX: task-related dirty reviewable files not yet in gatePassedFiles.
   * When non-empty the gate must not present as clean PASSED.
   */
  unreviewedDirtyReviewableFiles?: string[]
  /**
   * Pin/lag UX: task-related dirty non-reviewable paths (docs/session/jsonl).
   * Surfaced as excluded from the gate, not as validated or blocking commit.
   */
  nonReviewableDirtyTaskFiles?: string[]
}
