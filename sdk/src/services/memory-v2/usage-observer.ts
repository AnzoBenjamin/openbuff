import type {
  MemoryReuseReceiptV1,
  MemoryTurnContextV2,
} from '@codebuff/common/types/memory-v2'

export type UsageSignal = {
  observationId: string
  kind: 'used' | 'ignored'
  mechanism: 'gate-skip' | 'reread-despite'
}

const MAX_CHUNK_KEYS = 256
const MAX_SIGNALS = 128

/**
 * Pure, deterministic usage correlation (P4). Set-correlates the turn's
 * injected memory set against the per-turn reuse receipt: observations whose
 * evidence chunk covered a gate skip/narrow are 'used' via 'gate-skip'; when
 * the turn still took at least one full read, remaining injected observations
 * are 'ignored' via 'reread-despite'. No IO and no clock: the same inputs
 * always produce the same output. Best-effort: any missing or invalid input
 * yields [] and never throws.
 */
export function correlateUsage(params: {
  context: MemoryTurnContextV2
  receipt: MemoryReuseReceiptV1
}): UsageSignal[] {
  try {
    const { context, receipt } = params
    if (!context || typeof context !== 'object') return []
    if (!receipt || typeof receipt !== 'object') return []
    const byTool = Array.isArray(receipt.byTool) ? receipt.byTool : []
    if (byTool.length === 0) return []

    const result = context.result
    const verifiedKnowledge = Array.isArray(result?.verifiedKnowledge)
      ? result.verifiedKnowledge
      : []
    const reusableDiscovery = Array.isArray(result?.reusableDiscovery)
      ? result.reusableDiscovery
      : []
    if (verifiedKnowledge.length === 0 && reusableDiscovery.length === 0) {
      return []
    }

    // chunkId -> injected observation ids, bounded at 256 chunk keys.
    // Deterministic insertion order: verifiedKnowledge before reusableDiscovery.
    const chunksByObservation = new Map<string, Set<string>>()
    const addObservation = (observation: unknown) => {
      if (!observation || typeof observation !== 'object') return
      const record = observation as {
        observationId?: unknown
        evidence?: unknown
      }
      if (typeof record.observationId !== 'string') return
      const evidence = Array.isArray(record.evidence) ? record.evidence : []
      for (const item of evidence) {
        if (!item || typeof item !== 'object') continue
        const selector = (item as { selector?: unknown }).selector
        if (!selector || typeof selector !== 'object') continue
        const selectorRecord = selector as {
          kind?: unknown
          chunkId?: unknown
        }
        if (selectorRecord.kind !== 'chunk') continue
        const chunkId = selectorRecord.chunkId
        if (typeof chunkId !== 'string' || chunkId.length === 0) continue
        if (chunksByObservation.size >= MAX_CHUNK_KEYS && !chunksByObservation.has(chunkId)) {
          continue
        }
        const observations = chunksByObservation.get(chunkId) ?? new Set<string>()
        observations.add(record.observationId)
        chunksByObservation.set(chunkId, observations)
      }
    }
    for (const item of verifiedKnowledge) {
      if (item && typeof item === 'object') {
        addObservation((item as { observation?: unknown }).observation)
      }
    }
    for (const item of reusableDiscovery) {
      if (item && typeof item === 'object') {
        addObservation((item as { observation?: unknown }).observation)
      }
    }
    if (chunksByObservation.size === 0) return []

    const signals = new Map<string, UsageSignal>()
    const addSignal = (
      observationId: string,
      kind: UsageSignal['kind'],
      mechanism: UsageSignal['mechanism'],
    ) => {
      const key = `${observationId}\u0000${kind}`
      if (signals.has(key)) return
      signals.set(key, { observationId, kind, mechanism })
    }

    // used: every observation whose evidence chunk covered a skip/narrow gate.
    const usedObservationIds = new Set<string>()
    for (const entry of byTool) {
      if (!entry || typeof entry !== 'object') continue
      const decision = (entry as { decision?: unknown }).decision
      if (decision !== 'skip' && decision !== 'narrow') continue
      const covered = (entry as { coveredStableChunkIds?: unknown })
        .coveredStableChunkIds
      if (!Array.isArray(covered) || covered.length === 0) continue
      for (const rawChunkId of covered) {
        if (typeof rawChunkId !== 'string' || rawChunkId.length === 0) continue
        const observations = chunksByObservation.get(rawChunkId)
        if (!observations) continue
        for (const observationId of observations) {
          usedObservationIds.add(observationId)
          addSignal(observationId, 'used', 'gate-skip')
        }
      }
    }

    // ignored: only when the turn still performed at least one full read,
    // every remaining injected observation counts as reread-despite. Used
    // observations are never double-marked.
    if (receipt.full >= 1) {
      for (const item of verifiedKnowledge) {
        if (!item || typeof item !== 'object') continue
        const observation = (item as { observation?: unknown }).observation
        if (!observation || typeof observation !== 'object') continue
        const observationId = (observation as { observationId?: unknown })
          .observationId
        if (
          typeof observationId !== 'string' ||
          usedObservationIds.has(observationId)
        ) {
          continue
        }
        addSignal(observationId, 'ignored', 'reread-despite')
      }
      for (const item of reusableDiscovery) {
        if (!item || typeof item !== 'object') continue
        const observation = (item as { observation?: unknown }).observation
        if (!observation || typeof observation !== 'object') continue
        const observationId = (observation as { observationId?: unknown })
          .observationId
        if (
          typeof observationId !== 'string' ||
          usedObservationIds.has(observationId)
        ) {
          continue
        }
        addSignal(observationId, 'ignored', 'reread-despite')
      }
    }

    return [...signals.values()]
      .sort((a, b) =>
        a.observationId < b.observationId
          ? -1
          : a.observationId > b.observationId
            ? 1
            : a.kind < b.kind
              ? -1
              : a.kind > b.kind
                ? 1
                : 0,
      )
      .slice(0, MAX_SIGNALS)
  } catch {
    // Best-effort: usage correlation must never break finishTurn.
    return []
  }
}
