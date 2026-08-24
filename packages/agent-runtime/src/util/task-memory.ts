import {
  taskMemoryDraftV1Schema,
  taskMemoryV1Schema,
} from '@codebuff/common/types/task-memory'
import { stableHash } from '@codebuff/common/util/stable-hash'

import type {
  TaskMemoryDraftV1,
  TaskMemoryEvidenceV1,
  TaskMemoryV1,
} from '@codebuff/common/types/task-memory'
import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { WorkspaceStateV1 } from '@codebuff/common/types/workspace-state'

const ROOT_CONTEXT_CHARS = 36_000
const CHILD_CONTEXT_CHARS = 14_000
const TASK_MEMORY_REVIEW_RECEIPT_MAX_CHARS = 4_000

// Kept equal to TASK_MEMORY_LIST_CAPS.evidence in
// @codebuff/common/types/task-memory so persisted evidence never exceeds what
// the schema accepts.
const TASK_MEMORY_EVIDENCE_TOTAL_CAP = 256

// Per-kind caps intentionally sum above the total cap. Their job is not to
// shrink the budget but to stop one kind from consuming all of it: a single
// reviewer receipt contributes up to 256 `review` entries at once, which used
// to evict every read/edit/decision entry before the global trim ran.
const TASK_MEMORY_EVIDENCE_KIND_CAPS: Record<
  TaskMemoryEvidenceV1['kind'],
  number
> = {
  read: 64,
  edit: 64,
  requirement: 32,
  decision: 32,
  validation: 32,
  review: 32,
  blocker: 32,
  handoff: 32,
  note: 16,
}

// Hoisted so the per-item freshness filter allocates nothing per evidence entry.
const REVISION_GUARDED_EVIDENCE_KINDS: ReadonlySet<string> = new Set([
  'read',
  'edit',
  'validation',
  'review',
])

function boundText(value: string, maxChars: number): string {
  const normalized = value.trim()
  if (normalized.length <= maxChars) return normalized
  if (maxChars <= 24) return normalized.slice(0, maxChars)
  return `${normalized.slice(0, maxChars - 15)}...[truncated]`
}

function findStructuredReviewOutput(
  value: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  if (!value || depth > 8) return undefined
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = findStructuredReviewOutput(value[index], depth + 1)
      if (found) return found
    }
    return undefined
  }
  if (typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.verdict === 'string') return record
  for (const nested of Object.values(record)) {
    const found = findStructuredReviewOutput(nested, depth + 1)
    if (found) return found
  }
  return undefined
}

function boundedStringList(
  values: unknown,
  maxItems: number,
  maxChars: number,
): string[] {
  if (!Array.isArray(values)) return []
  return values
    .flatMap((value) =>
      typeof value === 'string' && value.trim()
        ? [boundText(value, maxChars)]
        : [],
    )
    .slice(0, maxItems)
}

function serializeReviewReceiptForTaskMemory(receipt: AgentReceipt): string {
  const review = findStructuredReviewOutput(receipt.output)
  const reviewedFiles = boundedStringList(review?.reviewedFiles, 4, 160)
  const findings = Array.isArray(review?.findings) ? review.findings : []
  const findingIds = findings
    .flatMap((finding) => {
      if (typeof finding === 'string') return []
      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
        return []
      }
      const id = (finding as Record<string, unknown>).id
      return typeof id === 'string' && id.trim() ? [boundText(id, 120)] : []
    })
    .slice(0, 4)
  const findingIdCount = findings.filter(
    (finding) =>
      finding &&
      typeof finding === 'object' &&
      !Array.isArray(finding) &&
      typeof (finding as Record<string, unknown>).id === 'string' &&
      ((finding as Record<string, unknown>).id as string).trim(),
  ).length
  const requirementCoverage = Array.isArray(review?.requirementCoverage)
    ? review.requirementCoverage
    : []
  const requirementStatuses = requirementCoverage.reduce(
    (counts, entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return counts
      }
      const status = (entry as Record<string, unknown>).status
      if (status === 'satisfied') counts.satisfied += 1
      else if (status === 'missing') counts.missing += 1
      else if (status === 'uncertain') counts.uncertain += 1
      return counts
    },
    { satisfied: 0, missing: 0, uncertain: 0 },
  )

  const summary = {
    schemaVersion: 1,
    receiptId: boundText(receipt.receiptId, 96),
    taskId: boundText(receipt.taskId, 96),
    role: receipt.role,
    agentId: boundText(receipt.agentId, 96),
    status: receipt.status,
    ...(receipt.workspaceRevision !== undefined
      ? { workspaceRevision: receipt.workspaceRevision }
      : {}),
    ...(receipt.workspaceSnapshotId
      ? {
          workspaceSnapshotId: boundText(receipt.workspaceSnapshotId, 160),
        }
      : {}),
    review: review
      ? {
          verdict:
            typeof review.verdict === 'string'
              ? boundText(review.verdict, 32)
              : undefined,
          snapshotFingerprint:
            typeof review.snapshotFingerprint === 'string'
              ? boundText(review.snapshotFingerprint, 256)
              : undefined,
          coverage:
            typeof review.coverage === 'string'
              ? boundText(review.coverage, 32)
              : undefined,
          reviewedFiles,
          reviewedFileCount: Array.isArray(review.reviewedFiles)
            ? review.reviewedFiles.length
            : 0,
          findingIds,
          findingCount: findings.length,
          requirementCount: requirementCoverage.length,
          requirementStatuses,
        }
      : undefined,
    changedFiles: receipt.changedFiles
      .map((file) => boundText(file.path, 160))
      .slice(0, 4),
    changedFileCount: receipt.changedFiles.length,
    evidenceCount: receipt.evidence.length,
    unresolved: receipt.unresolved
      .map((value) => boundText(value, 160))
      .slice(0, 2),
    unresolvedCount: receipt.unresolved.length,
    requestedValidation: receipt.requestedValidation
      .map((value) => boundText(value, 160))
      .slice(0, 2),
    errorMessages: receipt.errors
      .map((error) => boundText(error.message, 160))
      .slice(0, 2),
    errorCount: receipt.errors.length,
    truncated:
      reviewedFiles.length <
        (Array.isArray(review?.reviewedFiles)
          ? review.reviewedFiles.length
          : 0) ||
      findingIds.length < findingIdCount ||
      receipt.changedFiles.length > 4 ||
      receipt.unresolved.length > 2 ||
      receipt.requestedValidation.length > 2 ||
      receipt.errors.length > 2,
  }
  const serialized = JSON.stringify(summary)
  if (serialized.length <= TASK_MEMORY_REVIEW_RECEIPT_MAX_CHARS) {
    return serialized
  }

  return JSON.stringify({
    schemaVersion: 1,
    receiptId: boundText(receipt.receiptId, 64),
    taskId: boundText(receipt.taskId, 64),
    role: receipt.role,
    agentId: boundText(receipt.agentId, 64),
    status: receipt.status,
    ...(receipt.workspaceRevision !== undefined
      ? { workspaceRevision: receipt.workspaceRevision }
      : {}),
    review: review
      ? {
          verdict:
            typeof review.verdict === 'string'
              ? boundText(review.verdict, 32)
              : undefined,
          snapshotFingerprint:
            typeof review.snapshotFingerprint === 'string'
              ? boundText(review.snapshotFingerprint, 160)
              : undefined,
          coverage:
            typeof review.coverage === 'string'
              ? boundText(review.coverage, 32)
              : undefined,
          reviewedFileCount: Array.isArray(review.reviewedFiles)
            ? review.reviewedFiles.length
            : 0,
          findingCount: findings.length,
          requirementCount: requirementCoverage.length,
          requirementStatuses,
        }
      : undefined,
    changedFileCount: receipt.changedFiles.length,
    evidenceCount: receipt.evidence.length,
    unresolvedCount: receipt.unresolved.length,
    requestedValidationCount: receipt.requestedValidation.length,
    errorCount: receipt.errors.length,
    truncated: true,
  })
}

function uniqueRecent(values: string[], limit: number): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]?.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    output.unshift(value)
    if (output.length >= limit) break
  }
  return output
}

function normalizeEvidence(
  evidence: TaskMemoryEvidenceV1[],
): TaskMemoryEvidenceV1[] {
  const byId = new Map<string, TaskMemoryEvidenceV1>()
  for (const item of evidence) {
    const previous = byId.get(item.id)
    if (!previous || (item.verifiedAt ?? 0) >= (previous.verifiedAt ?? 0)) {
      byId.set(item.id, { ...item })
    }
  }
  const superseded = new Set(
    [...byId.values()].flatMap((item) => item.supersedes ?? []),
  )
  // Sort ascending first so "newest" means the same thing for both trims below.
  const sorted = [...byId.values()]
    .map((item) =>
      superseded.has(item.id) && item.stale !== false
        ? { ...item, stale: true }
        : item,
    )
    .sort((a, b) => (a.verifiedAt ?? 0) - (b.verifiedAt ?? 0))

  // Partition the budget by kind before the global trim: a burst of one kind
  // (typically reviewer receipts, all sharing one verifiedAt) would otherwise
  // fill the whole cap and drop the read/edit/decision entries the next
  // session needs. Newest-wins per kind, matching uniqueRecent's iteration.
  const perKindCount = new Map<string, number>()
  const kept: TaskMemoryEvidenceV1[] = []
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const item = sorted[index]!
    const used = perKindCount.get(item.kind) ?? 0
    // No `??` fallback: the map is an exhaustive Record over the kind union, so
    // a future missing kind must fail typecheck here instead of silently
    // picking up a default cap.
    if (used >= TASK_MEMORY_EVIDENCE_KIND_CAPS[item.kind]) continue
    perKindCount.set(item.kind, used + 1)
    kept.unshift(item)
  }
  return kept.slice(-TASK_MEMORY_EVIDENCE_TOTAL_CAP)
}

function normalizeDraft(draft: TaskMemoryDraftV1): TaskMemoryDraftV1 {
  return taskMemoryDraftV1Schema.parse({
    ...draft,
    goal: draft.goal.trim(),
    requirements: uniqueRecent(draft.requirements, 64),
    decisions: uniqueRecent(draft.decisions, 64),
    filesInspected: uniqueRecent(draft.filesInspected, 128),
    editsMade: uniqueRecent(draft.editsMade, 128),
    validationResults: uniqueRecent(draft.validationResults, 64),
    reviewReceipts: uniqueRecent(draft.reviewReceipts, 64),
    blockers: uniqueRecent(draft.blockers, 64),
    nextActions: uniqueRecent(draft.nextActions, 32),
    historicalSummary: draft.historicalSummary.trim(),
    evidence: normalizeEvidence(draft.evidence),
  })
}

export function commitTaskMemory(params: {
  current?: TaskMemoryV1
  draft: TaskMemoryDraftV1
  expectedRevision?: number
  now?: number
}): TaskMemoryV1 {
  const { current, expectedRevision } = params
  if (current) {
    if (expectedRevision !== current.revision) {
      throw new Error(
        `Task memory revision conflict: expected ${expectedRevision ?? 'missing'}, current ${current.revision}.`,
      )
    }
  } else if (expectedRevision !== undefined && expectedRevision !== -1) {
    throw new Error(
      `Task memory revision conflict: expected ${expectedRevision}, but no task memory exists.`,
    )
  }
  const normalized = normalizeDraft(params.draft)
  const revision = current ? current.revision + 1 : 0
  const updatedAt = params.now ?? Date.now()
  const checksum = stableHash(
    JSON.stringify({ revision, updatedAt, memory: normalized }),
  )
  return taskMemoryV1Schema.parse({
    ...normalized,
    revision,
    updatedAt,
    checksum,
  })
}

export function mergeTaskMemoryDraft(
  current: TaskMemoryV1 | undefined,
  incoming: TaskMemoryDraftV1,
): TaskMemoryDraftV1 {
  if (!current) return normalizeDraft(incoming)
  return normalizeDraft({
    ...incoming,
    goal: incoming.goal || current.goal,
    requirements: [...current.requirements, ...incoming.requirements],
    decisions: [...current.decisions, ...incoming.decisions],
    filesInspected: [...current.filesInspected, ...incoming.filesInspected],
    editsMade: [...current.editsMade, ...incoming.editsMade],
    validationResults: [
      ...current.validationResults,
      ...incoming.validationResults,
    ],
    reviewReceipts: [...current.reviewReceipts, ...incoming.reviewReceipts],
    blockers: [...current.blockers, ...incoming.blockers],
    nextActions: [...current.nextActions, ...incoming.nextActions],
    historicalSummary: incoming.historicalSummary || current.historicalSummary,
    evidence: [...current.evidence, ...incoming.evidence],
    workspaceRevision: incoming.workspaceRevision ?? current.workspaceRevision,
    workspaceSnapshotId:
      incoming.workspaceSnapshotId ?? current.workspaceSnapshotId,
  })
}

export function mergeAgentReceiptIntoTaskMemory(params: {
  current?: TaskMemoryV1
  receipt: AgentReceipt
  objective?: string
}): TaskMemoryV1 {
  const { current, receipt } = params
  const evidence: TaskMemoryEvidenceV1[] = receipt.evidence
    .slice(-256)
    .map((item) => ({
      id: boundText(item.id, 160) || 'receipt-evidence',
      kind: item.kind === 'artifact' ? 'handoff' : item.kind,
      summary: boundText(item.summary, 2_000),
      source: boundText(
        item.source ?? `${receipt.role}:${receipt.agentId}`,
        1_000,
      ),
      freshnessHash: item.freshnessHash
        ? boundText(item.freshnessHash, 256)
        : undefined,
      workspaceRevision: item.workspaceRevision ?? receipt.workspaceRevision,
      verifiedAt: Date.now(),
    }))
  const blockers =
    receipt.status === 'blocked' || receipt.status === 'failed'
      ? [
          ...receipt.unresolved.map((value) => boundText(value, 2_000)),
          ...receipt.errors.map((error) => boundText(error.message, 2_000)),
        ]
      : receipt.unresolved.map((value) => boundText(value, 2_000))
  const incoming = taskMemoryDraftV1Schema.parse({
    schemaVersion: 1,
    goal: current?.goal ?? boundText(params.objective ?? '', 8_000),
    requirements: current?.requirements ?? [],
    decisions: [],
    filesInspected: evidence
      .filter((item) => item.kind === 'read')
      .slice(-128)
      .map((item) => item.summary),
    editsMade: receipt.changedFiles
      .slice(-128)
      .map((file) => boundText(file.path, 1_500)),
    // Requested commands are pending work, not completed validation evidence.
    validationResults: [],
    reviewReceipts:
      receipt.role === 'reviewer' || receipt.role === 'security-reviewer'
        ? [serializeReviewReceiptForTaskMemory(receipt)]
        : [],
    blockers: blockers.slice(-64),
    nextActions: receipt.requestedValidation
      .slice(-32)
      .map((value) => boundText(value, 2_000)),
    historicalSummary: current?.historicalSummary ?? '',
    evidence,
    workspaceRevision: receipt.workspaceRevision ?? current?.workspaceRevision,
    workspaceSnapshotId:
      receipt.workspaceSnapshotId !== undefined
        ? boundText(receipt.workspaceSnapshotId, 256)
        : current?.workspaceSnapshotId,
  })
  const merged = mergeTaskMemoryDraft(current, incoming)
  return commitTaskMemory({
    current,
    draft: merged,
    expectedRevision: current?.revision ?? -1,
  })
}

/**
 * Captures the request goal outside compaction. `deriveTaskMemoryDraftFromMessages`
 * only runs when a session compacts, so a session that never compacts used to
 * persist a record with an empty goal — unusable for the next session.
 *
 * Returns `undefined` when there is nothing worth committing (no goal observed
 * and no existing memory), and returns `current` unchanged once a goal is
 * already stored so repeat steps burn no revision.
 */
export function ensureTaskMemoryGoal(params: {
  current?: TaskMemoryV1
  goal: string
  workspaceState?: WorkspaceStateV1
}): TaskMemoryV1 | undefined {
  const { current, workspaceState } = params
  const goal = boundText(params.goal, 8_000)
  if (!goal && !current) return undefined
  // Identity return: the caller compares by reference and skips the write, so
  // an already-captured goal costs no revision, checksum, or updatedAt churn.
  if (current?.goal) return current
  const incoming = taskMemoryDraftV1Schema.parse({
    schemaVersion: 1,
    goal,
    ...(workspaceState
      ? {
          workspaceRevision: workspaceState.revision,
          workspaceSnapshotId: boundText(workspaceState.snapshotId, 256),
        }
      : {}),
  })
  return commitTaskMemory({
    current,
    draft: mergeTaskMemoryDraft(current, incoming),
    expectedRevision: current?.revision ?? -1,
  })
}

// Evidence derived from one tool result is capped defensively, and each loop
// below keeps its OWN counter: one read_files or edit_transaction call can touch
// far more files than a single memory commit should record, and a 32-result
// read payload must never starve the mutation loop of the same output. No tool
// returns both kinds today, but the cap must not silently depend on that.
const TOOL_EVIDENCE_PER_RESULT_CAP = 32

/**
 * Upper bound on derived entries buffered for one step before further entries
 * are dropped, so a runaway step cannot accumulate evidence without limit. The
 * per-kind and total caps in `normalizeEvidence` discard the overflow at commit
 * time anyway.
 */
const MAX_BUFFERED_STEP_EVIDENCE = 512

const FRESHNESS_HASH_PREFIX = 'sha256:'

/**
 * Canonical `freshnessHash` spelling, agreed with the only consumer: `hashFile`
 * in sdk/src/services/task-memory-store.ts emits a bare lowercase sha256 hex
 * digest with no `sha256:` prefix, and `reconcileTaskMemoryEvidence` compares it
 * with `digest === item.freshnessHash`. Runtime producers emit the prefixed
 * spelling (`getContentHash` for a read anchor, `getExactContentHash` /
 * `hashFileContent` for a mutation `afterHash`), so the prefix is stripped here
 * at record time; without that, every entry this path records would reconcile
 * `stale: true` on the next session and then be dropped by `evidenceIsFresh`,
 * `deriveTaskMemoryFocusPaths`, and `pruneStaleTaskMemoryEvidence`.
 *
 * Two hash NAMESPACES share that single spelling and must never be conflated,
 * which is why the ids below keep separate `read:` / `edit:` prefixes:
 *  - `read:<path>` stores a whole-file read anchor hash, taken over
 *    LF-normalized content. It matches the store's raw-byte digest for LF files
 *    (the canonical committed form here); a CRLF working copy reconciles stale
 *    rather than falsely fresh.
 *  - `edit:<path>` stores a mutation `afterHash`, taken over the exact bytes
 *    just written, so it reconciles byte-for-byte.
 * The store also digests only the leading MAX_EVIDENCE_HASH_BYTES of a file, so
 * evidence for a larger file reconciles stale for the same fail-closed reason.
 */
function toStoredFreshnessHash(hash: string): string {
  return boundText(
    hash.startsWith(FRESHNESS_HASH_PREFIX)
      ? hash.slice(FRESHNESS_HASH_PREFIX.length)
      : hash,
    256,
  )
}

function findToolResultValueByKind(
  output: unknown,
  kind: 'read_files_result' | 'file_mutation_result',
): Record<string, unknown> | undefined {
  if (!Array.isArray(output)) return undefined
  for (const part of output) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue
    const record = part as Record<string, unknown>
    if (record.type !== 'json') continue
    const value = record.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if ((value as Record<string, unknown>).kind === kind) {
      return value as Record<string, unknown>
    }
  }
  return undefined
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? [item as Record<string, unknown>]
      : [],
  )
}

/**
 * True when a derived entry is byte-identical to what is already stored: same
 * id, kind, path, summary and a defined, matching `freshnessHash`, with the
 * path already present in the matching list. Only then can the commit be
 * skipped without losing information. An entry without a hash (a delete, or an
 * anchorless payload) can never be proven unchanged.
 */
function storedEvidenceIsUnchanged(
  current: TaskMemoryV1,
  storedById: Map<string, TaskMemoryEvidenceV1>,
  item: TaskMemoryEvidenceV1,
): boolean {
  const previous = storedById.get(item.id)
  if (!previous || previous.stale === true) return false
  if (
    previous.kind !== item.kind ||
    previous.path !== item.path ||
    previous.summary !== item.summary
  ) {
    return false
  }
  if (!item.freshnessHash || previous.freshnessHash !== item.freshnessHash) {
    return false
  }
  if (!item.path) return false
  const recorded =
    item.kind === 'edit' ? current.editsMade : current.filesInspected
  return recorded.includes(item.path)
}

type DerivedToolEvidence = {
  evidence: TaskMemoryEvidenceV1[]
  filesInspected: string[]
  editsMade: string[]
}

/**
 * Derives — but deliberately does not commit — the read/edit evidence a single
 * tool result proves. No zod parse and no checksum happen here, so this stays
 * cheap enough to run on every tool result while the expensive commit
 * (`normalizeDraft` + `JSON.stringify` + `stableHash` over the whole memory)
 * runs once per step.
 */
function deriveToolEvidence(params: {
  toolName: string
  callId: string
  output: unknown
  workspaceState?: WorkspaceStateV1
}): DerivedToolEvidence {
  const { toolName, callId, output, workspaceState } = params
  const verifiedAt = Date.now()
  const source = boundText(`${toolName}:${callId}`, 1_000)
  const evidence: TaskMemoryEvidenceV1[] = []
  const filesInspected: string[] = []
  const editsMade: string[] = []

  // Ids are deliberately stable per path (`read:<path>` / `edit:<path>`):
  // `normalizeEvidence` dedupes by id keeping the newest `verifiedAt`, so
  // re-reading or re-editing a file replaces its stale entry instead of
  // accumulating one duplicate per tool call. The two prefixes are also the two
  // hash namespaces documented on `toStoredFreshnessHash`: a read anchor hash is
  // LF-normalized while a mutation `afterHash` is byte-exact, so the same file
  // yields two different digests that must never be compared as one.
  const readResult =
    toolName === 'read_files'
      ? findToolResultValueByKind(output, 'read_files_result')
      : undefined
  // Per-loop counter, so a 32-result read payload cannot consume the mutation
  // loop's budget in the same output.
  let readCount = 0
  for (const item of asRecordArray(readResult?.results)) {
    if (readCount >= TOOL_EVIDENCE_PER_RESULT_CAP) break
    // Only a COMPLETE WHOLE-FILE `ok` result carries a hash the next session can
    // re-verify. `reconcileTaskMemoryEvidence` re-hashes the whole file, so a
    // range/symbol slice anchor (the digest of that slice alone) could never
    // match it, and partial/error/anchorless items carry no trustworthy digest
    // at all — recording either would store permanently stale evidence.
    if (
      item.status !== 'ok' ||
      item.selector !== 'file' ||
      item.complete !== true ||
      typeof item.path !== 'string' ||
      !item.path
    ) {
      continue
    }
    const anchor =
      item.editAnchor && typeof item.editAnchor === 'object'
        ? (item.editAnchor as Record<string, unknown>)
        : undefined
    if (!anchor || typeof anchor.contentHash !== 'string') continue
    const path = boundText(item.path, 1_000)
    const startLine =
      typeof anchor.startLine === 'number' ? anchor.startLine : '?'
    const endLine = typeof anchor.endLine === 'number' ? anchor.endLine : '?'
    evidence.push({
      id: boundText(`read:${path}`, 160),
      kind: 'read',
      summary: boundText(`Read ${path} lines ${startLine}-${endLine}`, 2_000),
      source,
      path,
      freshnessHash: toStoredFreshnessHash(anchor.contentHash),
      verifiedAt,
      workspaceRevision: workspaceState?.revision,
    })
    filesInspected.push(path)
    readCount += 1
  }

  // Guard on the payload shape, not the tool name: every mutating tool
  // (edit_transaction, str_replace, write_file, replace_range, create_plan)
  // returns this kind, and an override returning something else is skipped.
  const mutation = findToolResultValueByKind(output, 'file_mutation_result')
  const mutationApplied = mutation?.outcome === 'applied'
  let editCount = 0
  for (const action of asRecordArray(mutation?.actions)) {
    if (editCount >= TOOL_EVIDENCE_PER_RESULT_CAP) break
    // Trust a per-action outcome when the payload carries one; without it only
    // a fully applied mutation confirms the action landed.
    const applied =
      typeof action.outcome === 'string'
        ? action.outcome === 'applied'
        : mutationApplied
    if (!applied || typeof action.path !== 'string' || !action.path) continue
    const path = boundText(action.path, 1_000)
    const actionKind =
      typeof action.action === 'string' ? boundText(action.action, 32) : 'edit'
    evidence.push({
      id: boundText(`edit:${path}`, 160),
      kind: 'edit',
      summary: boundText(`${actionKind} ${path}`, 2_000),
      source,
      path,
      // A deleted file has no post-state to hash, so record the edit without a
      // freshnessHash rather than storing one that can never re-verify.
      freshnessHash:
        actionKind === 'delete' || typeof action.afterHash !== 'string'
          ? undefined
          : toStoredFreshnessHash(action.afterHash),
      verifiedAt,
      workspaceRevision: workspaceState?.revision,
    })
    editsMade.push(path)
    editCount += 1
  }

  return { evidence, filesInspected, editsMade }
}

/**
 * Commits one batch of derived evidence as a single task-memory revision.
 *
 * Returns `undefined` when the batch is empty (any other tool, or a custom/MCP
 * tool with an unrelated payload) so the caller can skip the write entirely, and
 * returns `current` unchanged when every derived entry is byte-identical to what
 * is already stored so repeat reads of an unchanged file cost no revision.
 */
function commitDerivedToolEvidence(params: {
  current?: TaskMemoryV1
  derived: DerivedToolEvidence
  workspaceState?: WorkspaceStateV1
}): TaskMemoryV1 | undefined {
  const { current, derived, workspaceState } = params
  const { evidence } = derived
  if (evidence.length === 0) return undefined

  // Identity return, mirroring `ensureTaskMemoryGoal`: re-reading an unchanged
  // file derives the same evidence, and committing it would re-normalize and
  // re-checksum the whole memory (hundreds of KB at the evidence cap) to store
  // nothing new. Any workspace movement still commits so the memory's own
  // revision and snapshot id stay current.
  if (current) {
    const storedById = new Map(
      current.evidence.map((item) => [item.id, item] as const),
    )
    const workspaceUnchanged =
      workspaceState === undefined ||
      (current.workspaceRevision === workspaceState.revision &&
        current.workspaceSnapshotId ===
          boundText(workspaceState.snapshotId, 256))
    if (
      workspaceUnchanged &&
      evidence.every((item) =>
        storedEvidenceIsUnchanged(current, storedById, item),
      )
    ) {
      return current
    }
  }

  const incoming = taskMemoryDraftV1Schema.parse({
    schemaVersion: 1,
    goal: current?.goal ?? '',
    // A whole step can derive more than one list cap's worth of paths, so the
    // incoming draft is bounded here (newest wins) rather than letting the
    // schema reject the batch and lose every entry in it.
    filesInspected: uniqueRecent(derived.filesInspected, 128),
    editsMade: uniqueRecent(derived.editsMade, 128),
    historicalSummary: current?.historicalSummary ?? '',
    evidence: normalizeEvidence(evidence),
    ...(workspaceState
      ? {
          workspaceRevision: workspaceState.revision,
          workspaceSnapshotId: boundText(workspaceState.snapshotId, 256),
        }
      : {}),
  })
  return commitTaskMemory({
    current,
    draft: mergeTaskMemoryDraft(current, incoming),
    expectedRevision: current?.revision ?? -1,
  })
}

/**
 * Records the reads and edits an agent performed itself as task-memory evidence,
 * committing one tool result immediately. Only child agents report through
 * `mergeAgentReceiptIntoTaskMemory`, so without this the root agent's own
 * exploration and edits are never remembered, and the stored `freshnessHash`
 * values use the store's canonical form (see {@link toStoredFreshnessHash}) so
 * they reconcile fresh — and therefore stay useful — in the next session.
 *
 * For callers that observe several results per step concurrently, prefer
 * {@link bufferToolEvidenceForStep} plus
 * {@link flushBufferedToolEvidenceIntoTaskMemory}: one commit per step keeps the
 * whole-memory normalize/checksum off the per-result path and leaves exactly one
 * writer per step.
 */
export function recordToolEvidenceInTaskMemory(params: {
  current?: TaskMemoryV1
  toolName: string
  callId: string
  output: unknown
  workspaceState?: WorkspaceStateV1
}): TaskMemoryV1 | undefined {
  const { current, toolName, callId, output, workspaceState } = params
  return commitDerivedToolEvidence({
    current,
    derived: deriveToolEvidence({ toolName, callId, output, workspaceState }),
    workspaceState,
  })
}

/**
 * Derived evidence awaiting this step's single commit, keyed by the agent state
 * object that owns the calls. A WeakMap so an abandoned step's buffer is
 * collected with its agent state instead of leaking.
 */
const BUFFERED_STEP_EVIDENCE = new WeakMap<object, DerivedToolEvidence>()

/**
 * Derives the evidence one tool result proves and buffers it for this step's
 * single commit. Only the cheap derivation runs per result; nothing is
 * normalized, checksummed, or assigned to the agent state here, so concurrent
 * tool calls in one step cannot each derive revision N+1 and clobber one
 * another.
 */
export function bufferToolEvidenceForStep(params: {
  owner: object
  toolName: string
  callId: string
  output: unknown
  workspaceState?: WorkspaceStateV1
}): void {
  const { owner, toolName, callId, output, workspaceState } = params
  const derived = deriveToolEvidence({
    toolName,
    callId,
    output,
    workspaceState,
  })
  if (derived.evidence.length === 0) return
  const buffered = BUFFERED_STEP_EVIDENCE.get(owner)
  if (!buffered) {
    BUFFERED_STEP_EVIDENCE.set(owner, derived)
    return
  }
  if (buffered.evidence.length >= MAX_BUFFERED_STEP_EVIDENCE) return
  buffered.evidence.push(...derived.evidence)
  buffered.filesInspected.push(...derived.filesInspected)
  buffered.editsMade.push(...derived.editsMade)
}

/**
 * Commits everything {@link bufferToolEvidenceForStep} buffered for this step as
 * ONE revision and clears the buffer. The caller is the only writer at this
 * point, so the returned memory (when it differs from `current`) can be assigned
 * without a retry loop; `undefined` means nothing was buffered.
 */
export function flushBufferedToolEvidenceIntoTaskMemory(params: {
  owner: object
  current?: TaskMemoryV1
  workspaceState?: WorkspaceStateV1
}): TaskMemoryV1 | undefined {
  const buffered = BUFFERED_STEP_EVIDENCE.get(params.owner)
  if (!buffered) return undefined
  const result = commitDerivedToolEvidence({
    current: params.current,
    derived: buffered,
    workspaceState: params.workspaceState,
  })
  BUFFERED_STEP_EVIDENCE.delete(params.owner)
  return result
}

function extractSection(block: string, header: string, nextHeaders: string[]) {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lookahead = nextHeaders
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const match = block.match(
    new RegExp(`${escaped}:\\s*([\\s\\S]*?)(?=\\n(?:${lookahead}):|$)`),
  )
  return match?.[1]?.trim() ?? ''
}

function parseListSection(
  block: string,
  header: string,
  nextHeaders: string[],
) {
  return extractSection(block, header, nextHeaders)
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean)
}

export function deriveTaskMemoryDraftFromMessages(params: {
  messages: Message[]
  workspaceState?: WorkspaceStateV1
  fallbackSummary?: string
}): TaskMemoryDraftV1 {
  let block = ''
  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const message = params.messages[index]
    if (!Array.isArray(message.content)) continue
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    const match = text.match(/<knowledge_memory>([\s\S]*?)<\/knowledge_memory>/)
    if (match) {
      block = match[1]
      break
    }
  }
  const headers = [
    'Goal',
    'Requirements',
    'Decisions',
    'Files Inspected',
    'Edits Made',
    'Validation Results',
    'Review Receipts',
    'Blockers',
    'Next Action',
  ]
  const goal = extractSection(block, 'Goal', headers.slice(1))
  const decisions = parseListSection(block, 'Decisions', headers.slice(3))
  const filesInspected = parseListSection(
    block,
    'Files Inspected',
    headers.slice(4),
  )
  const editsMade = parseListSection(block, 'Edits Made', headers.slice(5))
  const validationResults = parseListSection(
    block,
    'Validation Results',
    headers.slice(6),
  )
  const reviewReceipts = parseListSection(
    block,
    'Review Receipts',
    headers.slice(7),
  )
  const blockers = parseListSection(block, 'Blockers', headers.slice(8))
  const nextAction = extractSection(block, 'Next Action', [])
  return normalizeDraft({
    schemaVersion: 1,
    goal,
    requirements: parseListSection(block, 'Requirements', headers.slice(2)),
    decisions,
    filesInspected,
    editsMade,
    validationResults,
    reviewReceipts,
    blockers,
    nextActions: nextAction ? [nextAction] : [],
    historicalSummary: params.fallbackSummary ?? '',
    evidence: [],
    ...(params.workspaceState
      ? {
          workspaceRevision: params.workspaceState.revision,
          workspaceSnapshotId: params.workspaceState.snapshotId,
        }
      : {}),
  })
}

function truncateMemoryText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  if (maxChars <= 32) return value.slice(0, maxChars)
  const head = Math.max(1, Math.floor(maxChars * 0.72))
  const tail = Math.max(1, maxChars - head - 24)
  return `${value.slice(0, head)}...[truncated]...${value.slice(-tail)}`
}

function boundedMemoryList(
  values: string[],
  params: { maxItems: number; maxItemChars: number; maxTotalChars: number },
): string[] {
  const selected = values.slice(-params.maxItems)
  const output: string[] = []
  let used = 0
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const value = truncateMemoryText(selected[index]!, params.maxItemChars)
    if (used + value.length > params.maxTotalChars && output.length > 0) {
      // Budget exhausted at the first non-fitting newer entry: stop rather
      // than backfilling older smaller entries, which would invert the
      // newest-first priority this list exists to preserve.
      break
    }
    const remaining = Math.max(1, params.maxTotalChars - used)
    output.unshift(truncateMemoryText(value, remaining))
    used += Math.min(value.length, remaining)
    if (used >= params.maxTotalChars) break
  }
  return output
}

function evidenceIsFresh(
  item: TaskMemoryEvidenceV1,
  workspaceRevision: number | undefined,
): boolean {
  if (item.stale) return false
  // A path means `reconcileTaskMemoryEvidence` (task-memory-store.ts, run at
  // session start) re-hashed this entry against disk and already wrote the
  // authoritative verdict into `stale`. Do not re-add a revision check here:
  // workspaceRevision bumps on every unrelated mutation anywhere in the repo,
  // so it would discard hash-verified evidence.
  //
  // In-session contract: nothing re-reconciles mid-session, so an entry recorded
  // earlier in THIS session stays trusted even after the same session edits that
  // file. Entries carry no file content (only a summary and a digest), so the
  // worst case is a stale pointer rather than stale content — the compiled
  // banner in `compileTaskMemoryContext` states exactly that scope instead of
  // promising session-wide freshness.
  if (item.path) return true
  // Pathless observations cannot be hash-verified, so the revision counter
  // stays their only guard.
  if (workspaceRevision === undefined || item.workspaceRevision === undefined) {
    return true
  }
  if (!REVISION_GUARDED_EVIDENCE_KINDS.has(item.kind)) {
    return true
  }
  return item.workspaceRevision === workspaceRevision
}

/**
 * True when `summary` mentions `focus` as a whole path rather than as the prefix
 * of a longer one, so focus `src/a.ts` is not scored by a summary that only
 * talks about `src/a.tsx`.
 */
function summaryMentionsFocusPath(summary: string, focus: string): boolean {
  for (
    let index = summary.indexOf(focus);
    index !== -1;
    index = summary.indexOf(focus, index + 1)
  ) {
    const next = summary[index + focus.length]
    if (next === undefined || !/[A-Za-z0-9_./\\-]/.test(next)) return true
  }
  return false
}

function evidenceRelevanceScore(
  item: TaskMemoryEvidenceV1,
  focusPaths: string[],
): number {
  let score = 0
  for (const focus of focusPaths) {
    if (!focus) continue
    if (item.path === focus) return 2
    // Exact equality above plus a SEGMENT-AWARE prefix here: a directory focus
    // (`src/a`) still scores the files under it, while a near-miss filename
    // (`src/a.tsx` for focus `src/a.ts`) scores nothing and cannot dilute the
    // ranking.
    if (
      item.path?.startsWith(`${focus}/`) ||
      summaryMentionsFocusPath(item.summary, focus)
    ) {
      score = 1
    }
  }
  return score
}

/**
 * Focus paths for `compileTaskMemoryContext`: the files the current request is
 * actually working on, newest first, taken from the most recent non-stale
 * read/edit evidence (`recordToolEvidenceInTaskMemory` writes one entry per
 * path). Ranking against these keeps older validation, review, and decision
 * evidence about those same files, which pure recency drops.
 */
export function deriveTaskMemoryFocusPaths(
  memory: TaskMemoryV1 | undefined,
  limit = 8,
): string[] {
  if (!memory) return []
  const seen = new Set<string>()
  const paths: string[] = []
  // `normalizeEvidence` stores evidence ascending by verifiedAt, so walking
  // backwards yields newest-first without another sort.
  for (let index = memory.evidence.length - 1; index >= 0; index -= 1) {
    const item = memory.evidence[index]!
    if (item.stale || !item.path) continue
    if (item.kind !== 'read' && item.kind !== 'edit') continue
    if (seen.has(item.path)) continue
    seen.add(item.path)
    paths.push(item.path)
    if (paths.length >= limit) break
  }
  return paths
}

function compileBoundedMemoryObject(params: {
  memory: TaskMemoryV1
  agentType?: string | null
  contextWindowTokens?: number
  rootAgent?: boolean
  focusPaths?: string[]
  maxChars: number
}): Record<string, unknown> {
  const { memory, maxChars, rootAgent } = params
  const scale = Math.max(0.22, Math.min(1, maxChars / ROOT_CONTEXT_CHARS))
  const list = (
    values: string[],
    rootItems: number,
    childItems: number,
    fraction: number,
    maxItemChars: number,
  ) =>
    boundedMemoryList(values, {
      maxItems: Math.max(
        1,
        Math.floor((rootAgent ? rootItems : childItems) * scale),
      ),
      maxItemChars: Math.max(120, Math.floor(maxItemChars * scale)),
      maxTotalChars: Math.max(240, Math.floor(maxChars * fraction)),
    })

  const evidenceLimit = Math.max(2, Math.floor((rootAgent ? 64 : 20) * scale))
  const fresh = memory.evidence.filter((item) =>
    evidenceIsFresh(item, memory.workspaceRevision),
  )
  const focusPaths = params.focusPaths
  // Recency alone drops evidence about the files this request is actually
  // about, so rank by relevance when the caller names focus paths. Ties break
  // on verifiedAt then original index, so equal-timestamp receipt bursts stay
  // deterministic; emission order is still oldest -> newest either way.
  const selectedEvidence =
    focusPaths && focusPaths.length > 0
      ? fresh
          .map((item, index) => ({
            item,
            index,
            score: evidenceRelevanceScore(item, focusPaths),
          }))
          .sort(
            (a, b) =>
              b.score - a.score ||
              (b.item.verifiedAt ?? 0) - (a.item.verifiedAt ?? 0) ||
              b.index - a.index,
          )
          .slice(0, evidenceLimit)
          .sort(
            (a, b) =>
              (a.item.verifiedAt ?? 0) - (b.item.verifiedAt ?? 0) ||
              a.index - b.index,
          )
          .map((entry) => entry.item)
      : fresh.slice(-evidenceLimit)
  const evidence = selectedEvidence.map((item) => ({
    ...item,
    summary: truncateMemoryText(item.summary, Math.max(160, 600 * scale)),
    ...(item.source
      ? {
          source: truncateMemoryText(item.source, Math.max(100, 280 * scale)),
        }
      : {}),
  }))

  return {
    schemaVersion: memory.schemaVersion,
    revision: memory.revision,
    checksum: memory.checksum,
    workspaceRevision: memory.workspaceRevision,
    workspaceSnapshotId: memory.workspaceSnapshotId,
    agentType: params.agentType,
    contextWindowTokens: params.contextWindowTokens,
    goal: truncateMemoryText(
      memory.goal,
      Math.max(400, Math.floor(maxChars * 0.12)),
    ),
    requirements: list(memory.requirements, 64, 24, 0.2, 700),
    decisions: list(memory.decisions, 32, 12, 0.1, 520),
    blockers: list(memory.blockers, 24, 12, 0.13, 620),
    nextActions: list(memory.nextActions, 12, 6, 0.11, 620),
    filesInspected: list(memory.filesInspected, 64, 20, 0.07, 300),
    editsMade: list(memory.editsMade, 64, 20, 0.07, 300),
    validationResults: list(memory.validationResults, 24, 8, 0.07, 420),
    reviewReceipts: list(memory.reviewReceipts, 16, 6, 0.06, 420),
    evidence,
  }
}

export function compileTaskMemoryContext(params: {
  memory: TaskMemoryV1
  agentType?: string | null
  contextWindowTokens?: number
  rootAgent?: boolean
  focusPaths?: string[]
}): string {
  const fixedMax = params.rootAgent ? ROOT_CONTEXT_CHARS : CHILD_CONTEXT_CHARS
  const modelScaledMax = params.contextWindowTokens
    ? Math.max(2_400, Math.floor(params.contextWindowTokens * 4 * 0.1))
    : fixedMax
  const maxChars = Math.min(fixedMax, modelScaledMax)
  const compact = compileBoundedMemoryObject({ ...params, maxChars })
  const serialized = JSON.stringify(compact, null, 2)
  return [
    '<task_memory>',
    'Authoritative structured operational memory compiled for this request. Evidence that failed re-verification against disk at session start is excluded; entries recorded earlier in this same session are not re-verified, so verify live files before mutation.',
    serialized,
    '</task_memory>',
  ].join('\n')
}
