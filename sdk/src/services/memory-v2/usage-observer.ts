import type {
  MemoryReuseReceiptV1,
  MemoryTurnContextV2,
} from '@codebuff/common/types/memory-v2'

export type UsageSignal = {
  observationId: string
  kind: 'used' | 'ignored'
  mechanism: 'gate-skip' | 'reread-despite'
}
const MAX_SIGNALS = 128

/**
 * Usage is a source-specific efficiency observation, never proof a claim was
 * false. Unknown, unrendered, changed and necessary-refresh reads earn no
 * negative signal. Legacy aggregate full counts are deliberately insufficient.
 */
export function correlateUsage(params: {
  context: MemoryTurnContextV2
  receipt: MemoryReuseReceiptV1
  emittedObservationIds?: readonly string[]
}): UsageSignal[] {
  try {
    const emitted = new Set(params.emittedObservationIds ?? [])
    if (!emitted.size || !Array.isArray(params.receipt?.byTool)) return []
    const result = params.context?.result
    const observations = [
      ...(result?.verifiedKnowledge ?? []).map((item) => ({
        observation: item.observation,
        evidence: item.verifiedEvidence,
      })),
      ...(result?.reusableDiscovery ?? []).map((item) => ({
        observation: item.observation,
        evidence: item.observation.evidence,
      })),
    ]
      .filter((item) => emitted.has(item.observation.observationId))
      .slice(0, 256)
    const signals = new Map<string, UsageSignal>()
    for (const item of observations) {
      const id = item.observation.observationId
      const chunks = new Set(
        item.evidence.flatMap((evidence) =>
          evidence.selector.kind === 'chunk' ? [evidence.selector.chunkId] : [],
        ),
      )
      const used = params.receipt.byTool.some(
        (entry) =>
          (entry.decision === 'skip' || entry.decision === 'narrow') &&
          entry.coveredStableChunkIds?.some((chunk) => chunks.has(chunk)),
      )
      if (used) {
        signals.set(id, {
          observationId: id,
          kind: 'used',
          mechanism: 'gate-skip',
        })
        continue
      }
      const redundant = params.receipt.byTool.some(
        (entry) =>
          entry.tool === 'read_files' &&
          entry.decision === 'full' &&
          entry.observedReads?.some(
            (read) =>
              read.reason === 'unchanged-reread' &&
              item.evidence.some((evidence) => {
                const selector = evidence.selector
                if (
                  !('path' in selector) ||
                  selector.path !== read.path ||
                  evidence.contentDigest !== read.contentDigest
                )
                  return false
                if (selector.kind === 'file')
                  return (
                    read.startLine === undefined && read.endLine === undefined
                  )
                return (
                  (selector.kind === 'chunk' ||
                    selector.kind === 'line-range') &&
                  selector.startLine === read.startLine &&
                  selector.endLine === read.endLine
                )
              }),
          ),
      )
      if (redundant)
        signals.set(id, {
          observationId: id,
          kind: 'ignored',
          mechanism: 'reread-despite',
        })
    }
    return [...signals.values()]
      .sort((a, b) =>
        a.observationId < b.observationId
          ? -1
          : a.observationId > b.observationId
            ? 1
            : 0,
      )
      .slice(0, MAX_SIGNALS)
  } catch {
    return []
  }
}
