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

const isEvicted = (message: ToolMessage): boolean =>
  message.content.some(
    (part) => part.type === 'json' &&
      typeof part.value === 'string' &&
      part.value.startsWith(TOMBSTONE_MARKER),
  )

export type ToolResultEvictionResult = {
  messages: Message[]
  tokensSaved: number
  evictedCount: number
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
 * Whether a tool result's content references any importance-derived path.
 * Serializes the candidate's content once; the whole-array token accounting
 * below already pays a serialization pass, so this adds no asymptotic cost.
 * Substring matching is deliberate: a tool result that embeds a recorded
 * path anywhere in its output (file bodies, command output, search hits) is
 * exactly the content whose loss would orphan the memory that cites it.
 */
const contentReferencesProtectedPath = (
  message: ToolMessage,
  protectedPaths: ReadonlySet<string>,
): boolean => {
  const serialized = JSON.stringify(message.content)
  // M3-T2: bounded scan region — compact results (the norm) scan fully and
  // keep byte-identical protection semantics; only pathological oversized
  // results get their scan cost capped.
  const scanRegion =
    serialized.length > MAX_PROTECTED_CONTENT_SCAN_CHARS
      ? serialized.slice(0, MAX_PROTECTED_CONTENT_SCAN_CHARS)
      : serialized
  for (const path of protectedPaths) {
    if (scanRegion.includes(path)) return true
  }
  return false
}

/**
 * Replace the bodies of stale tool results with short tombstones. Pure with
 * respect to the input array (never mutates it); returns the same reference
 * when nothing was worth evicting.
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
  // real size; the authoritative accounting is the whole-array delta below.
  const approximateTokens = (message: Message): number =>
    Math.max(1, Math.floor(JSON.stringify(message).length * 0.25))

  const candidates = messages.filter((message): message is ToolMessage => {
    if (message.role !== 'tool') return false
    if (isEvicted(message)) return false
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
    if (
      protectedPaths !== undefined &&
      protectedPaths.size > 0 &&
      contentReferencesProtectedPath(message, protectedPaths)
    ) {
      return false
    }
    return true
  })

  if (candidates.length === 0) {
    return { messages, tokensSaved: 0, evictedCount: 0 }
  }

  const tombstonesByMessage = new Map<ToolMessage, string>()
  for (const candidate of candidates) {
    tombstonesByMessage.set(
      candidate,
      buildTombstone(approximateTokens(candidate)),
    )
  }

  const nextMessages = messages.map((message) => {
    const tombstone = tombstonesByMessage.get(message as ToolMessage)
    if (tombstone === undefined) return message
    const evicted: ToolMessage = {
      ...(message as ToolMessage),
      content: [{ type: 'json', value: tombstone }],
    }
    return evicted
  })

  const tokensSaved =
    countTokensJson(messages) - countTokensJson(nextMessages)
  if (tokensSaved < minSavingsTokens) {
    // Below the savings floor the rewrite is not worth the cache churn:
    // return the untouched input so the caller sees a no-op by reference.
    return { messages, tokensSaved: 0, evictedCount: 0 }
  }

  return { messages: nextMessages, tokensSaved, evictedCount: candidates.length }
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