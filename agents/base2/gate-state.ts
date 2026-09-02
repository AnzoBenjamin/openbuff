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

/**
 * Gate-issued per-task validation receipt for one EXECUTE_PLAN plan task.
 *
 * This is the evidence `update_plan_status` verifies a `checkpoint.receiptIds`
 * entry against before a PLAN.md task may move to `done`. The runtime's
 * `validatePlanTransition` already refused a `done` transition without a passed
 * validation checkpoint carrying at least one receipt ID, but those IDs were
 * entirely model-supplied, so an invented string satisfied the rule. A receipt
 * here is minted ONLY by base2's own fresh validation/reviewer gate pass, which
 * is what ties task completion to real gate evidence.
 *
 * EVIDENCE KINDS. A plan task whose gate cycle produced no reviewable diff must
 * still be completable, and its receipt must not claim content evidence it does
 * not have, so `evidence` records exactly what the cycle covered:
 *   - `'reviewed-diff'`: the reviewable subset the reviewer attested; `files` is
 *     that subset.
 *   - `'unreviewed-scope'`: pending files existed but NONE of them were
 *     reviewable (docs-only / `.md` / `.agents/`), so the reviewer was skipped.
 *     `files` is the VALIDATED pending set and the receipt claims no content
 *     review. Without this kind the mint produced a receipt whose fingerprint
 *     was the hash of an EMPTY file list — a constant — while presenting as
 *     reviewed-diff evidence.
 *   - `'no-diff'`: the cycle had no pending files at all (work that is pure
 *     verification, or whose only output is a non-reviewable artifact). `files`
 *     is empty, so this fingerprint is a CONSTANT by construction.
 *
 * `files` is the gate-covered set this receipt attests — for
 * `'unreviewed-scope'` that is the validated pending set, not a reviewed subset.
 * The invariant that makes verification uniform across all three kinds is
 * `snapshotFingerprint === hashGateSnapshotDetails(buildGateSnapshotDetails(files, ''))`:
 * content only, with an EMPTY summary component. For `'reviewed-diff'` that is
 * exactly the reviewable-set fingerprint base2 computed for the review.
 *
 * Why `receiptId` is GATE-COMPUTED rather than reviewer-reported: it embeds the
 * prefix of the fingerprint base2 hashed itself, the same provenance rule that
 * makes `Base2ReviewReceipt.gateId` trustworthy. A reviewer-REPORTED
 * `snapshotFingerprint` is deliberately drift-tolerated by the attestation path,
 * so deriving the receipt from it would let a reviewer (or a model quoting one)
 * choose its own receipt ID and forge completion evidence. A non-attestable
 * fingerprint (a stable `unreadable:*` marker) is an error string rather than
 * content evidence and never mints a receipt, for any kind.
 *
 * LIFETIME. At most ONE receipt is live per `taskId`: a newly minted receipt
 * REPLACES the task's previous one instead of appending, so the printed ID is
 * unambiguous. Two complementary mechanisms retire a receipt that has stopped
 * being true, keeping the published ledger to receipts that hold right now:
 *   1. Content verification (`prunePlanTaskGateReceipts` in base2.ts, at turn
 *      start and immediately before the mint): recompute
 *      `hashGateSnapshotDetails(buildGateSnapshotDetails(files, ''))` and drop
 *      the receipt unless the recomputation is attestable AND equal to
 *      `snapshotFingerprint`. Structurally invalid entries are dropped too.
 *   2. Change supersession (`supersedePlanTaskGateReceiptsForChangedFiles` in
 *      base2.ts, called from `recordChangedFiles` and from the credited-file
 *      eviction ledger): drop every receipt whose `files` intersect the changed
 *      paths, plus EVERY receipt whose `evidence` is not `'reviewed-diff'` —
 *      those have no verifiable content identity (a `'no-diff'` fingerprint is a
 *      constant and can never fail verification), so only supersession can
 *      retire them. Legacy receipts serialized before `evidence` existed are
 *      retired the same way (fail closed).
 *
 * BOUND ON THE GUARANTEE: the runtime handler reads the LIVE
 * `agentState.base2ActiveWork` during a step, so the ledger it sees is whatever
 * base2 wrote at the last gate pass. A model that edits files and marks the task
 * done inside the SAME step is therefore still outside supersession's reach.
 * The property is "this receipt was true as of the last gate pass", not an
 * airtight proof at the moment of the transition.
 *
 * PRODUCTION READERS (no field here is documented-but-unread):
 *   - base2.ts `prunePlanTaskGateReceipts` reads `receiptId`, `taskId`, `files`,
 *     and `snapshotFingerprint`;
 *   - base2.ts `supersedePlanTaskGateReceiptsForChangedFiles` reads `evidence`
 *     and `files`;
 *   - base2.ts's gate-pass mint site reads `taskId` (one live receipt per task)
 *     and `receiptId` (an identical ID is the idempotent repeat pass and is left
 *     untouched rather than churning `recordedAt`);
 *   - base2.ts's gate-pass `add_message` reads `taskId`, `receiptId`,
 *     `evidence`, and `files.length` for the printed evidence sentence;
 *   - base2.ts `buildPinnedActiveWorkMessage` reads `receiptId`, `taskId`, and
 *     `evidence` for the durable recovery line (pinned state survives context
 *     compaction, which is what makes a superseded ID recoverable);
 *   - the runtime `update_plan_status` handler's
 *     `readGateIssuedPlanTaskReceipts` reads `receiptId` and `taskId`, and
 *     `validatePlanTransition` matches them against `checkpoint.receiptIds` and
 *     lists the live IDs for the task when it rejects.
 * `validationSummary`, `reviewerVerdict`, and `recordedAt` are durable audit
 * fields surfaced through gate state itself; no decision branches on them.
 */
export type Base2PlanTaskGateReceipt = {
  /**
   * Gate-issued receipt id, derived from the fingerprint base2 computed itself:
   * `plan-gate:<taskId>:<fp16>` for `'reviewed-diff'`,
   * `plan-gate:<taskId>:unreviewed-scope:<fp16>`, or
   * `plan-gate:<taskId>:no-diff:<fp16>`, where `<fp16>` is the first 16 chars of
   * `snapshotFingerprint`. The kind is part of the id for the two non-reviewed
   * kinds so a receipt that claims no content review can never be mistaken for
   * one that does.
   */
  receiptId: string
  /** Stable PLAN.md task ID this gate cycle covered. */
  taskId: string
  /** What the gate cycle actually covered; see the docblock above. */
  evidence: 'reviewed-diff' | 'unreviewed-scope' | 'no-diff'
  /** Always `hashGateSnapshotDetails(buildGateSnapshotDetails(files, ''))`. */
  snapshotFingerprint: string
  /** The gate-covered set this receipt attests (empty for `'no-diff'`). */
  files: string[]
  validationSummary: string
  reviewerVerdict: string
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
   * final code-reviewer gate passed.
   *
   * SOFT-DEPRECATED and WRITE-ONLY as of the receipt-driven reviewer skip.
   *
   * Readers: NONE. There is no production reader of this field anywhere —
   * base2.ts only writes it on the gate-pass path and defaults it to `''` when
   * hydrating serialized state, and no CLI/renderer/telemetry surface reads it
   * (the pinned active-work message and the gate telemetry payload are built
   * from `gatePassedFingerprint`, `gatePassedFiles`, `pendingGateFiles`,
   * `currentPhase`, and `reviewReceipts`). It is referenced only by test
   * fixtures that seed serialized state.
   *
   * Why it lost its reader: it used to be a required conjunct of the reviewer
   * skip, but a single scalar is overwritten on every gate pass, so an earlier
   * wave's reviewable set re-arming produced false misses. That decision now
   * reads the durable `reviewReceipts` ledger, matching a LOOKS_GOOD receipt by
   * its GATE-COMPUTED `gateId` (`${reviewer}:${expectedFingerprint}`) plus the
   * reviewed file set, and an attestability check on the current fingerprint.
   * The reviewer-reported `snapshotFingerprint` on a receipt is drift-tolerated
   * and is deliberately NOT used as content evidence.
   *
   * Migration/removal path for consumers:
   * 1. Do not add new readers. Anything that needs "was this reviewable set
   *    already reviewed?" must match a `reviewReceipts` entry on `gateId` +
   *    `reviewedFiles`, exactly like base2's reviewer-skip rule.
   * 2. The field stays written for one deprecation window so a session
   *    serialized by an older base2 keeps round-tripping unchanged (no
   *    migration step, no rollback risk: it is additive and optional).
   * 3. Removal: once no serialized state in circulation is read by a base2 that
   *    still declares it, drop the write in base2.ts's gate-pass path, drop the
   *    `??= ''` default, drop this field, and drop the test-fixture seeds. Older
   *    serialized state stays loadable because unknown persisted keys are
   *    ignored.
   *
   * Backward-compatible: older serialized state lacks this field (treated as
   * unset).
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
   * Stable PLAN.md task ID currently claimed by the model, extracted from
   * successful `update_plan_status` tool calls in message history (the
   * `currentTask` pointer, else the last `updates` entry moved to
   * `in_progress`). Normalized to its leading stable-ID token, so
   * `"P2-T3 Implement the thing"` is stored as `"P2-T3"` — the same form
   * `validatePlanTransition` matches a `currentTask` pointer against a task id.
   * Cleared when a successful call empties `currentTask` or moves the claimed
   * task to `done`/`cancelled`. "Successful" includes the handler's POINTER-only
   * messages (`Current task -> "<task>".` / `Current task pointer cleared.`),
   * which carry none of the shared success verbs and are opted in explicitly at
   * the extraction site. Execution-tracking state, NOT gate credit,
   * which is why it lives here and not on `Base2GateState`.
   * Backward-compatible: older serialized state lacks it (treated as no claim).
   */
  activePlanTaskId?: string
  /**
   * Gate-issued per-task validation receipts (see `Base2PlanTaskGateReceipt`),
   * written only on base2's FRESH validation/reviewer gate-pass path while a
   * plan task is claimed. MUST stay a plain JSON-serializable array (never a
   * Map/Set) and is bounded to the most recent 24 entries at every write site,
   * the same convention as `reviewReceipts`, so durable state cannot grow
   * without bound across a long plan run. base2's hydration ENFORCES that
   * shape: a present-but-non-array value (corrupt or hand-edited serialized
   * state) is normalized to an EMPTY array instead of being left intact, so
   * every reader fails closed instead of throwing a TypeError mid-turn while
   * the key stays PRESENT and gate-issued verification stays active (see
   * below).
   *
   * This is a ledger of receipts that are TRUE RIGHT NOW, not an append-only
   * history: at most one receipt is live per task (a new mint replaces that
   * task's previous one over the remaining entries), content verification drops
   * any receipt whose covered bytes no longer hash to its `snapshotFingerprint`,
   * and change supersession drops receipts a recorded change invalidated. Both
   * mechanisms PRUNE the array; neither ever deletes the key, because presence
   * is what keeps verification active (see below).
   *
   * Its PRESENCE is the signal that gate-issued verification is active: the
   * `update_plan_status` handler forwards this array to
   * `validatePlanTransition`, which then requires the checkpoint to cite a
   * gate-issued receipt ID for the task being completed. A PRESENT array —
   * including an EMPTY one — rejects (the gate is active but has issued no
   * evidence yet). When the key is ABSENT the handler falls back to the
   * pre-existing "any non-empty receiptIds" rule, which is what keeps non-base2
   * agents and a base2 run with the validation gate disabled
   * (`hasNoValidation` / plan-only, where no receipt could ever be minted) able
   * to complete plan tasks. base2 therefore initializes this key only when the
   * gate actually runs, and DELETES an inherited key on a gate-disabled turn:
   * the invariant is "present ⇔ the gate is active for THIS run", not "present ⇔
   * the gate ran at some point in this session". Without that deletion a session
   * that published the key under EXECUTE_PLAN/base2 and later resumed through a
   * gate-disabled variant would restore verification with no way to mint
   * evidence, making every new plan task impossible to move to `done`. Dropping
   * the stale ledger is safe: the next fresh gate pass re-mints a receipt for
   * whatever task is claimed then.
   */
  planTaskGateReceipts?: Base2PlanTaskGateReceipt[]
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
