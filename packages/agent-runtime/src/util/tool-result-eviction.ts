import {
  commitReceiptV1Schema,
  fileMutationResultV1Schema,
} from '@codebuff/common/tools/results/filesystem'

import { looksLikeProjectPath } from './project-path-policy'
import { isProtectedToolResult } from './tool-result-lifecycle'
import { countTokensJson } from './token-counter'

import type { TaskMemoryV1 } from '@codebuff/common/types/task-memory'
import type { Message, ToolMessage } from '@codebuff/common/types/messages/codebuff-message'

/**
 * Deterministic, zero-LLM-cost tool-result eviction — the "continuous light
 * consolidation" layer of the compaction pipeline.
 *
 * WHY: the semantic (LLM) pruner pass costs a full model call over the whole
 * transcript. Old tool-result bodies (file reads, command output, search
 * hits) are usually the bulk of that transcript and carry almost no forward
 * value once their step is over. Evicting them deterministically — every
 * iteration above the eviction floor (see `getSemanticEvictionFloorTokens`),
 * BEFORE the governor ever announces an LLM pass — frequently pulls context
 * below the semantic trigger for free, so the expensive pass becomes a last
 * resort rather than the first response to context pressure.
 *
 * Safety rules (all enforced below):
 *  - The most recent `EVICTION_KEEP_RECENT_STEPS` steps are never touched.
 *  - Protected results (`keepDuringTruncation`, high-importance or pinned
 *    tags — the same eligibility model the mechanical trim uses) are never
 *    touched, via `isProtectedToolResult`.
 *  - Already-evicted results are skipped (the tombstone marker is detected),
 *    so calling this every iteration is idempotent.
 *  - Mutation receipts survive eviction: a stale `edit_transaction`
 *    `file_mutation_result` carrying an `authorityReceipt` is replaced with a
 *    SLIMMED parseable copy (dropping per-action afterContent / patch /
 *    editAnchor and emptying freshCapabilities) instead of a tombstone, and
 *    `commit_receipt` results are left untouched — their JSON bodies are the
 *    evidence `buildRuntimeAgentReceipt` needs at settle time.
 *  - If the whole-array token delta is below `EVICTION_MIN_SAVINGS_TOKENS`,
 *    the ORIGINAL array reference is returned unchanged: the caller relies on
 *    reference inequality to decide whether history was rewritten, and
 *    rewriting history for a few hundred tokens would only churn prompt
 *    caches.
 */

/** Tool results from the N most recent steps are always kept full. */
export const EVICTION_KEEP_RECENT_STEPS = 6

/** Do not rewrite history when the eviction would save fewer tokens than this. */
export const EVICTION_MIN_SAVINGS_TOKENS = 4_000

/** Bound the importance-derived path set so the per-candidate substring scan stays cheap. */
const MAX_PROTECTED_PATHS = 512

/**
 * Task-memory list entries are sometimes kind-prefixed tokens (e.g.
 * 'read:src/a.ts' in filesInspected) rather than bare paths; strip a leading
 * '<kind>:' before the path check so those entries still protect their file.
 */
const stripEvidenceKindPrefix = (value: string): string =>
  value.replace(/^(read|edit|validation|review|note|decision|blocker|handoff|requirement):/, '')

const TOMBSTONE_MARKER = '[tool result evicted to free context'

const buildTombstone = (tokensSaved: number): string =>
  `${TOMBSTONE_MARKER} (~${Math.max(1, Math.round(tokensSaved / 1000))}k tokens) — re-run the tool if you need this output again]`

/**
 * Full tombstone SHAPE, not a prefix: a genuine tool result can legitimately
 * begin with the tombstone wording (e.g. a result that quotes an earlier
 * tombstone), and a prefix match would misclassify it as already-evicted and
 * silently skip eviction. Only the exact `buildTombstone` structure —
 * marker, k-token figure, trailing instruction, closing bracket — counts.
 */
const TOMBSTONE_PATTERN =
  /^\[tool result evicted to free context \(~\d+k tokens\) — re-run the tool if you need this output again\]$/

const isEvicted = (message: ToolMessage): boolean =>
  message.content.some(
    (part) => part.type === 'json' &&
      typeof part.value === 'string' &&
      TOMBSTONE_PATTERN.test(part.value),
  )

/**
 * R4: a tool result whose json content is a commit_receipt is small
 * control-plane evidence; leave it untouched rather than evicting it.
 */
const isCommitReceiptOnlyResult = (message: ToolMessage): boolean =>
  message.content.length > 0 &&
  message.content.every(
    (part) =>
      part.type === 'json' &&
      typeof part.value !== 'string' &&
      commitReceiptV1Schema.safeParse(part.value).success,
  )

/**
 * R4 receipt-preserving eviction: slim an authority-backed
 * `file_mutation_result` to its receipt-bearing core instead of tombstoning
 * it. Drops the bulky per-action `afterContent` / `patch` / `editAnchor`
 * payloads and empties `freshCapabilities` while preserving everything the
 * mutation-attestation extractor needs (kind/version/operationId/outcome/
 * actions, authorityTier/receiptId/workspaceRevision/workspaceSnapshotId/
 * authorityReceipt/errors). Returns undefined when the value is not an
 * authority-backed file_mutation_result or the slimmed copy would fail the
 * schema — callers then fall back to the tombstone behavior.
 */
export function slimMutationReceiptForEviction(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (record.kind !== 'file_mutation_result') return undefined
  const parsed = fileMutationResultV1Schema.safeParse(value)
  if (!parsed.success || !parsed.data.authorityReceipt) return undefined
  const slimmed = {
    ...parsed.data,
    actions: parsed.data.actions.map((action) => {
      const {
        afterContent: _afterContent,
        patch: _patch,
        editAnchor: _editAnchor,
        ...rest
      } = action
      return rest
    }),
    freshCapabilities: [],
  }
  const reparsed = fileMutationResultV1Schema.safeParse(slimmed)
  return reparsed.success ? reparsed.data : undefined
}

/**
 * R4 idempotency: a mutation receipt that has already been slimmed carries no
 * heavy payload to reclaim, and re-slimming it every iteration would rewrite
 * history (churning prompt caches) without saving anything. Such results are
 * skipped exactly like already-tombstoned ones.
 */
const isSlimmedMutationResult = (message: ToolMessage): boolean =>
  message.content.some((part) => {
    if (part.type !== 'json' || typeof part.value === 'string') return false
    const parsed = fileMutationResultV1Schema.safeParse(part.value)
    if (!parsed.success || !parsed.data.authorityReceipt) return false
    const hasHeavyPayload = parsed.data.actions.some(
      (action) =>
        action.afterContent !== undefined ||
        action.editAnchor !== undefined ||
        action.patch !== undefined,
    )
    return !hasHeavyPayload && parsed.data.freshCapabilities.length === 0
  })

/**
 * Per-part slimmed replacement content for a tool message, or undefined when
 * no json part carried a slimable authority-backed mutation receipt (the
 * caller then applies the whole-message tombstone as before).
 */
const slimmedContentForMessage = (
  message: ToolMessage,
): ToolMessage['content'] | undefined => {
  let changed = false
  const parts = message.content.map((part) => {
    if (part.type !== 'json' || typeof part.value === 'string') return part
    const slimmed = slimMutationReceiptForEviction(part.value)
    if (slimmed === undefined) return part
    changed = true
    return { type: 'json' as const, value: slimmed } as typeof part
  })
  return changed ? parts : undefined
}

export type ToolResultEvictionResult = {
  messages: Message[]
  tokensSaved: number
  evictedCount: number
  /**
   * D26: full pre-tombstone copies of each evicted candidate (identity, FULL
   * original content, and step provenance) for the archive leg
   * (`archiveEvictedToolResults`). Omitted on the no-op paths — no candidates,
   * or savings below the floor — so existing callers and tests see no change;
   * the recorded content is never the tombstone or slimmed replacement.
   */
  evicted?: Array<{
    toolCallId: string
    toolName: string
    content: ToolMessage['content']
    stepIndex: number
  }>
}

/**
 * M3-T2 bound on the protection scan: a pathological multi-megabyte tool
 * result no longer gets an unbounded substring scan over every protected
 * path. Above the cap only the first bounded region is searched; a path
 * cited beyond that point may be evicted (fail-OPEN for eviction so the
 * history-rewrite savings are preserved), but the result is recoverable via
 * re-read and the pinned-test semantics for normal-size results are byte-
 * identical.
 */
const MAX_PROTECTED_CONTENT_SCAN_CHARS = 5_000_000

/**
 * Precompute the protection matcher ONCE per step. The historical
 * implementation re-scanned every candidate against up to MAX_PROTECTED_PATHS
 * paths with one substring pass each (a 512-path scan per candidate, every
 * step); a single alternation RegExp over the escaped path set preserves the
 * exact any-path-substring-match semantics with ONE scan per candidate.
 */
const buildProtectedPathsPattern = (
  protectedPaths: ReadonlySet<string> | undefined,
): RegExp | undefined => {
  if (protectedPaths === undefined || protectedPaths.size === 0) {
    return undefined
  }
  const escaped = [...protectedPaths].map((path) =>
    path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )
  return new RegExp(escaped.join('|'))
}

/**
 * Whether a tool result's serialized content references any importance-
 * derived path. Substring matching is deliberate: a tool result that embeds
 * a recorded path anywhere in its output (file bodies, command output,
 * search hits) is exactly the content whose loss would orphan the memory
 * that cites it.
 *
 * Perf (eviction hot path): the caller serializes each candidate's content
 * exactly once per step and passes the PRECOMPUTED per-step pattern, so this
 * helper is a single bounded scan with no per-candidate set spread or
 * re-serialization.
 */
const contentReferencesProtectedPath = (
  serializedContent: string,
  protectedPathsPattern: RegExp | undefined,
): boolean => {
  if (protectedPathsPattern === undefined) return false
  // M3-T2: bounded scan region — compact results (the norm) scan fully and
  // keep byte-identical protection semantics; only pathological oversized
  // results get their scan cost capped.
  const scanRegion =
    serializedContent.length > MAX_PROTECTED_CONTENT_SCAN_CHARS
      ? serializedContent.slice(0, MAX_PROTECTED_CONTENT_SCAN_CHARS)
      : serializedContent
  return protectedPathsPattern.test(scanRegion)
}

/**
 * Replace the bodies of stale tool results with short tombstones — except
 * mutation receipts, which are slimmed to a parseable receipt-bearing copy
 * instead (see `slimMutationReceiptForEviction`). Pure with respect to the
 * input array (never mutates it); returns the same reference when nothing was
 * worth evicting.
 */
export function evictStaleToolResults(
  messages: Message[],
  opts?: {
    keepRecentSteps?: number
    minSavingsTokens?: number
    /**
     * Paths whose tool results stay full regardless of age (importance-aware
     * protection, derived from task memory via `deriveProtectedEvictionPaths`).
     * Recency-blind eviction would otherwise strip exactly the stale result a
     * pinned decision or unverified edit anchor still depends on; the
     * read-authorization revoke lets the agent RECOVER evicted content, but
     * only when it knows to look — the paths memory cites are that knowledge.
     */
    protectedPaths?: ReadonlySet<string>
  },
): ToolResultEvictionResult {
  const keepRecentSteps = opts?.keepRecentSteps ?? EVICTION_KEEP_RECENT_STEPS
  const minSavingsTokens =
    opts?.minSavingsTokens ?? EVICTION_MIN_SAVINGS_TOKENS
  const protectedPaths = opts?.protectedPaths
  // Precompute BOTH per-step artifacts once, before the candidate walk: the
  // protection matcher (one regex over all protected paths) so the candidate
  // filter below never re-derives it per candidate.
  const protectedPathsPattern = buildProtectedPathsPattern(protectedPaths)

  // Walk the history, numbering each step (one assistant message plus the
  // tool results following it) so the recency window is step-based, not
  // message-based: a step with ten tool calls is still "one step ago".
  const stepIndexOf = new Map<Message, number>()
  let stepIndex = -1
  for (const message of messages) {
    if (message.role === 'assistant') stepIndex += 1
    stepIndexOf.set(message, Math.max(0, stepIndex))
  }
  const newestStep = Math.max(0, stepIndex)

  // Per-message size estimate for the tombstone label. Cheap and monotonic in
  // real size; the authoritative accounting is the per-candidate token delta
  // below.
  const approximateTokens = (message: Message): number =>
    Math.max(1, Math.floor(JSON.stringify(message).length * 0.25))

  const candidates = messages.filter((message): message is ToolMessage => {
    if (message.role !== 'tool') return false
    if (isEvicted(message)) return false
    if (isSlimmedMutationResult(message)) return false
    if ((newestStep - (stepIndexOf.get(message) ?? 0)) < keepRecentSteps) {
      return false
    }
    if (
      isProtectedToolResult({
        keepDuringTruncation: message.keepDuringTruncation,
        tags: message.tags,
      })
    ) {
      return false
    }
    if (isCommitReceiptOnlyResult(message)) {
      return false
    }
    if (
      contentReferencesProtectedPath(
        JSON.stringify(message.content),
        protectedPathsPattern,
      )
    ) {
      return false
    }
    return true
  })

  if (candidates.length === 0) {
    return { messages, tokensSaved: 0, evictedCount: 0 }
  }

  const tombstonesByMessage = new Map<ToolMessage, string>()
  const slimmedContentByMessage = new Map<ToolMessage, ToolMessage['content']>()
  // D26: candidates are already collected, so capture each one's identity,
  // FULL original content, and step provenance (the same `stepIndexOf` map
  // the filter used) BEFORE tombstoning replaces the body in the returned
  // history. The input messages are never mutated, so `candidate.content` is
  // the original body.
  const evictedCandidates: NonNullable<ToolResultEvictionResult['evicted']> =
    candidates.map((candidate) => ({
      toolCallId: candidate.toolCallId,
      toolName: candidate.toolName,
      content: candidate.content,
      stepIndex: stepIndexOf.get(candidate) ?? 0,
    }))
  for (const candidate of candidates) {
    const slimmedContent = slimmedContentForMessage(candidate)
    if (slimmedContent !== undefined) {
      slimmedContentByMessage.set(candidate, slimmedContent)
      continue
    }
    tombstonesByMessage.set(
      candidate,
      buildTombstone(approximateTokens(candidate)),
    )
  }

  const replacementByMessage = new Map<ToolMessage, Message>()
  const nextMessages = messages.map((message) => {
    const slimmedContent = slimmedContentByMessage.get(message as ToolMessage)
    if (slimmedContent !== undefined) {
      const replacement = {
        ...(message as ToolMessage),
        content: slimmedContent,
      }
      replacementByMessage.set(message as ToolMessage, replacement)
      return replacement
    }
    const tombstone = tombstonesByMessage.get(message as ToolMessage)
    if (tombstone === undefined) return message
    const evicted: ToolMessage = {
      ...(message as ToolMessage),
      content: [{ type: 'json', value: tombstone }],
    }
    replacementByMessage.set(message as ToolMessage, evicted)
    return evicted
  })

  // Perf (eviction hot path): tokenize each candidate's original body and its
  // replacement ONCE per step instead of re-encoding the FULL transcript array
  // twice (plus its per-candidate serializations) on every iteration. The
  // array-wrapper serialization overhead is identical on both sides (same
  // message count), so the summed per-candidate delta equals the historical
  // whole-array delta.
  let tokensSaved = 0
  for (const candidate of candidates) {
    const replacement = replacementByMessage.get(candidate)
    if (replacement === undefined) continue
    tokensSaved += countTokensJson(candidate) - countTokensJson(replacement)
  }
  if (tokensSaved < minSavingsTokens) {
    // Below the savings floor the rewrite is not worth the cache churn:
    // return the untouched input so the caller sees a no-op by reference.
    return { messages, tokensSaved: 0, evictedCount: 0 }
  }

  return {
    messages: nextMessages,
    tokensSaved,
    evictedCount: candidates.length,
    evicted: evictedCandidates,
  }
}

/**
 * Derive the importance-aware protection set for `evictStaleToolResults` from
 * task memory: every path the durable record cites (evidence paths/sources,
 * inspected files, edited files) marks tool content that must not be evicted
 * behind the memory's back. Duplicates collapse; the set is capped at
 * MAX_PROTECTED_PATHS in insertion order; non-path-like or unsafe entries
 * (absolute, traversal, glob syntax) are dropped rather than guessed at.
 * Undefined/empty memory yields an empty set — the caller then behaves
 * exactly like the previous recency-only evictor.
 */
export function deriveProtectedEvictionPaths(
  taskMemory: TaskMemoryV1 | undefined,
): ReadonlySet<string> {
  const paths = new Set<string>()
  if (!taskMemory) return paths

  const consider = (raw: unknown): void => {
    if (typeof raw !== 'string' || paths.size >= MAX_PROTECTED_PATHS) return
    const candidate = stripEvidenceKindPrefix(raw)
    if (looksLikeProjectPath(candidate)) paths.add(candidate)
  }

  for (const entry of taskMemory.evidence ?? []) {
    consider(entry.path)
    consider(entry.source)
  }
  for (const entry of taskMemory.filesInspected ?? []) consider(entry)
  for (const entry of taskMemory.editsMade ?? []) consider(entry)
  return paths
}