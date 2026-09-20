import type { ContextArchiveSnapshot } from '@codebuff/common/types/context-archive'
import type { ContextConsolidation } from '@codebuff/common/types/context-consolidation'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

/**
 * Background LLM consolidation of archived pre-compaction snapshots — the
 * PROTOTYPE leg of the compaction fidelity pipeline, canary-gated OFF by
 * default (`programmaticConfig.backgroundSnapshotConsolidation === true`).
 * Eviction tombstones and the verbatim archive recover exact content; this
 * leg adds what they cannot: a bounded SUMMARY of what a compaction pass
 * removed, written by a background prompt-only LLM child after the
 * turn-moving work is done (fire-and-forget; failure is logged and dropped).
 * Bounds: at most MAX_CONSOLIDATIONS stored summaries of at most
 * MAX_CONSOLIDATION_CHARS each; the child prompt is char-budgeted
 * newest-first; the child has NO tools and NO transcript write-back, so its
 * only product is the summary string.
 */
export const MAX_CONSOLIDATIONS = 8
export const MAX_CONSOLIDATION_CHARS = 6_000
export const CONSOLIDATION_PROMPT_CHARS = 24_000
/** Snapshots summarized per consolidation run (oldest first). */
export const MAX_SNAPSHOTS_PER_RUN = 3
export const CONSOLIDATOR_AGENT_ID = 'context-consolidator'

export const CONSOLIDATOR_SYSTEM_PROMPT =
  'You are a background transcript consolidator. You read removed conversation content and write a dense factual summary so a coding agent can recover the gist of what it lost. Preserve verbatim: file paths, identifiers, commands, error messages, and numeric values. No prose padding. Output only the summary.'

const PROMPT_HEADER =
  'Summarize the following removed transcript content for a coding agent that may need it later. Preserve verbatim: file paths, identifiers, commands, error messages, and numeric values. Be dense and factual; no prose padding.\n\n<removed-transcript>\n'
const PROMPT_FOOTER = '\n</removed-transcript>'

/**
 * Pick archive snapshots not yet covered by any stored consolidation, oldest
 * first, so the oldest removed context is summarized first. Pure.
 */
export function selectUnconsolidatedSnapshots(
  archive: ContextArchiveSnapshot[] | undefined,
  consolidations: ContextConsolidation[] | undefined,
): ContextArchiveSnapshot[] {
  if (!archive || archive.length === 0) return []
  // Coverage is tracked per OCCURRENCE of `archivedAt` in sourceArchivedAts,
  // not with a set keyed by the timestamp: snapshots archived in the same
  // millisecond (e.g. a semantic pass plus a mechanical trim in one
  // iteration) share a timestamp, so set-keying would silently mark BOTH as
  // covered once a consolidation covered one, and the other would never be
  // consolidated. Consuming counts in archive order (oldest-first append
  // order) keeps provenance aligned with how consolidations were recorded.
  const coveredCounts = new Map<number, number>()
  for (const c of consolidations ?? []) {
    for (const at of c.sourceArchivedAts) {
      coveredCounts.set(at, (coveredCounts.get(at) ?? 0) + 1)
    }
  }
  return archive
    .filter((s) => {
      if (s.messages.length === 0) return false
      const remaining = coveredCounts.get(s.archivedAt) ?? 0
      if (remaining > 0) {
        coveredCounts.set(s.archivedAt, remaining - 1)
        return false
      }
      return true
    })
    .slice(0, MAX_SNAPSHOTS_PER_RUN)
}

const messageLine = (message: Message): string => {
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    const texts = message.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
    const calls = message.content
      .filter(
        (p): p is {
          type: 'tool-call'
          toolCallId: string
          toolName: string
          input: Record<string, unknown>
        } => p.type === 'tool-call',
      )
      .map((p) => `${p.toolName}(${JSON.stringify(p.input)})`)
    return `[assistant] ${[...texts, ...calls].join(' ').trim()}\n`
  }
  if (message.role === 'tool') {
    const text = message.content
      .map((part) => (part.type === 'json' ? JSON.stringify(part.value) : '[media]'))
      .join(' ')
    return `[tool:${message.toolName}] ${text.trim()}\n`
  }
  return `[${message.role}] ${JSON.stringify(message.content).slice(0, 2_000)}\n`
}

/** Char-budgeted newest-first transcript over the given snapshots. Pure. */
export function buildConsolidationPrompt(
  snapshots: ContextArchiveSnapshot[],
): string {
  let body = ''
  for (const snapshot of [...snapshots].reverse()) {
    for (let i = snapshot.messages.length - 1; i >= 0; i--) {
      const line = messageLine(snapshot.messages[i])
      if (body.length + line.length > CONSOLIDATION_PROMPT_CHARS) continue
      body += line
    }
  }
  return `${PROMPT_HEADER}${body}${PROMPT_FOOTER}`
}

/** Last assistant text in a child history — the consolidator's product. */
export function extractLastText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    const text = m.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

/** Append capped (count and summary length). Pure w.r.t. the input array. */
export function recordConsolidation(
  agentState: { contextConsolidations?: ContextConsolidation[] },
  consolidation: ContextConsolidation,
): void {
  const summary = consolidation.summary.slice(0, MAX_CONSOLIDATION_CHARS)
  agentState.contextConsolidations = [
    ...(agentState.contextConsolidations ?? []),
    { ...consolidation, summary },
  ].slice(-MAX_CONSOLIDATIONS)
}

export type ConsolidationHit = {
  consolidatedAt: number
  action: ContextConsolidation['action']
  /** Source snapshots (by archivedAt) the summary covers — staleness provenance. */
  sourceArchivedAts: number[]
  coveredMessages: number
  summary: string
}

/**
 * Keyword search over stored consolidations. Unlike the verbatim archive's
 * AND semantics, summaries use OR-match ranked by matched-term count: they
 * are prose, so requiring every term would make them nearly unfindable.
 * Pure; bounded to the 3 best hits, newest-first within a rank.
 */
export function searchConsolidations(
  consolidations: ContextConsolidation[] | undefined,
  query: string,
): ConsolidationHit[] {
  if (!consolidations || consolidations.length === 0) return []
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (terms.length === 0) return []
  const scored: Array<ConsolidationHit & { matched: number }> = []
  for (let i = consolidations.length - 1; i >= 0; i--) {
    const c = consolidations[i]
    const lowered = c.summary.toLowerCase()
    const matched = terms.filter((t) => lowered.includes(t)).length
    if (matched > 0) {
      scored.push({
        consolidatedAt: c.consolidatedAt,
        action: c.action,
        sourceArchivedAts: c.sourceArchivedAts,
        coveredMessages: c.coveredMessages,
        summary: c.summary,
        matched,
      })
    }
  }
  return scored
    .sort((a, b) => b.matched - a.matched)
    .slice(0, 3)
    .map((hit) => ({
      consolidatedAt: hit.consolidatedAt,
      action: hit.action,
      sourceArchivedAts: hit.sourceArchivedAts,
      coveredMessages: hit.coveredMessages,
      summary: hit.summary,
    }))
}
