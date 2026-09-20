import { isProtectedToolResult } from './tool-result-lifecycle'
import { countTokensJson } from './token-counter'

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
 * Replace the bodies of stale tool results with short tombstones. Pure with
 * respect to the input array (never mutates it); returns the same reference
 * when nothing was worth evicting.
 */
export function evictStaleToolResults(
  messages: Message[],
  opts?: { keepRecentSteps?: number; minSavingsTokens?: number },
): ToolResultEvictionResult {
  const keepRecentSteps = opts?.keepRecentSteps ?? EVICTION_KEEP_RECENT_STEPS
  const minSavingsTokens =
    opts?.minSavingsTokens ?? EVICTION_MIN_SAVINGS_TOKENS

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