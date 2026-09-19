import {
  ageBucketDays,
  deriveUsefulnessTier,
  scoreUsefulness,
  type UsefulnessTier,
} from './usefulness-scorer'

/**
 * P6 relevance-based compaction eligibility. Pure and deterministic: every
 * decision derives from the envelope batch and the two wall clocks passed in
 * (NO Date.now anywhere in this module).
 */

export const COMPACTION_EVICTION_FLOOR = 0
export const COMPACTION_MIN_AGE_DAYS = 30
export const COMPACTION_IGNORE_THRESHOLD = 3
export const COMPACTION_ORPHAN_MIN_AGE_DAYS = 30
export const COMPACTION_ELIGIBILITY_MODEL_VERSION = 'compaction-eligibility-v1'

export type CompactionBranch = 'retracted' | 'orphan' | 'lowScore' | null

export interface CompactionObservationInput {
  observationId: string
  createdAtWall: string
  tier: UsefulnessTier
  used: number
  ignored: number
  pinned: boolean
  retracted: boolean
  hasVerifiedEvidence: boolean
}

export type GCRelevantEnvelope = {
  eventType: string
  eventId: string
  sequence: number
  occurredAt: string
  payload: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!)
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index]! - rightPoints[index]!
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

/**
 * An observation is an orphan when it was never retracted and carries no
 * verified evidence: nothing anchors it to current, trusted knowledge.
 */
export function isOrphan(input: {
  retracted: boolean
  hasVerifiedEvidence: boolean
}): boolean {
  return !input.retracted && !input.hasVerifiedEvidence
}

/**
 * Relevance-based eligibility for one observation. Branch precedence is
 * retracted > orphan > lowScore; a pinned observation is never eligible and an
 * ineligible observation always reports a null branch.
 */
export function compactionEligibility(input: {
  observation: CompactionObservationInput
  asOfTurnWall: string
}): { eligible: boolean; branch: CompactionBranch; score: number } {
  const observation = input.observation
  const score = scoreUsefulness({
    used: observation.used,
    ignored: observation.ignored,
    staled: 0,
    reinforced: 0,
    pinned: observation.pinned ? 1 : 0,
    createdAtWall: observation.createdAtWall,
    asOfTurnWall: input.asOfTurnWall,
    tier: observation.tier,
  }).score
  const ageDays = ageBucketDays(observation.createdAtWall, input.asOfTurnWall)
  const orphan = isOrphan(observation)
  let branch: CompactionBranch = null
  if (observation.retracted) {
    branch = 'retracted'
  } else if (
    orphan &&
    // SPEC invariant 11 + P6 DoD: age-driven heuristics never evict an
    // unsuperseded agent-explicit decision, and a reused observation is
    // never evicted by a heuristic branch (same guards as lowScore).
    observation.used === 0 &&
    observation.tier !== 'explicit' &&
    ageDays > COMPACTION_ORPHAN_MIN_AGE_DAYS
  ) {
    branch = 'orphan'
  } else if (
    score <= 0 &&
    observation.used === 0 &&
    ageDays > COMPACTION_MIN_AGE_DAYS &&
    observation.ignored >= COMPACTION_IGNORE_THRESHOLD &&
    observation.tier !== 'explicit'
  ) {
    branch = 'lowScore'
  }
  const eligible = !observation.pinned && branch !== null
  return { eligible, branch: eligible ? branch : null, score }
}

const safeString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const safeStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []

const entryObservationIds = (value: unknown): string[] => {
  const ids: string[] = []
  for (const entry of Array.isArray(value) ? value : []) {
    if (!isRecord(entry)) continue
    const id = safeString(entry.observationId)
    if (id) ids.push(id)
  }
  return ids
}

/**
 * Best-effort pure extraction of the observation ids an event references.
 * Tolerant of malformed payloads: any structural surprise yields [] (or the
 * subset of ids that are well-formed strings), never a throw.
 */
export function observationIdsReferencedBy(
  eventType: string,
  payload: unknown,
): string[] {
  if (!isRecord(payload)) return []
  switch (eventType) {
    case 'claim.forgotten':
      return safeStringArray(payload.observationIds)
    case 'claim.consolidated': {
      const ids = safeStringArray(payload.sourceObservationIds)
      if (isRecord(payload.canonicalObservation)) {
        const canonical = safeString(
          payload.canonicalObservation.observationId,
        )
        if (canonical) ids.push(canonical)
      }
      return ids
    }
    case 'claim.corrected': {
      const ids: string[] = []
      const target = safeString(payload.observationId)
      if (target) ids.push(target)
      if (isRecord(payload.correction)) {
        const correction = safeString(payload.correction.observationId)
        if (correction) ids.push(correction)
      }
      return ids
    }
    case 'observation.reused':
      return [
        ...entryObservationIds(payload.used),
        ...entryObservationIds(payload.ignored),
      ]
    case 'claim.superseded':
    case 'claim.pinned':
    case 'evidence.attached':
    case 'evidence.verified':
    case 'evidence.invalidated':
    case 'evidence.rebound':
      return safeString(payload.observationId)
        ? [payload.observationId as string]
        : []
    case 'observation.recorded': {
      if (!isRecord(payload.observation)) return []
      const id = safeString(payload.observation.observationId)
      return id ? [id] : []
    }
    default:
      return []
  }
}

const SHARED_COMPACTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'claim.forgotten',
  'claim.consolidated',
  'claim.corrected',
  'observation.reused',
])

const BRANCH_RANK: Record<'retracted' | 'orphan' | 'lowScore', number> = {
  retracted: 0,
  orphan: 1,
  lowScore: 2,
}

interface SelectionGroupEvent {
  eventId: string
  sequence: number
}

interface SelectionGroup {
  observationId: string
  events: SelectionGroupEvent[]
  hasAnchor: boolean
  createdAtWall: string
  tier: UsefulnessTier
  used: number
  ignored: number
  pinned: boolean
  retracted: boolean
  hasVerifiedEvidence: boolean
}

function partitionEnvelopes(
  envelopes: GCRelevantEnvelope[],
): {
  groups: Map<string, SelectionGroup>
  shared: GCRelevantEnvelope[]
} {
  const groups = new Map<string, SelectionGroup>()
  const shared: GCRelevantEnvelope[] = []
  const groupFor = (observationId: string): SelectionGroup => {
    const existing = groups.get(observationId)
    if (existing) return existing
    const created: SelectionGroup = {
      observationId,
      events: [],
      hasAnchor: false,
      createdAtWall: '1970-01-01T00:00:00.000Z',
      tier: 'derived',
      used: 0,
      ignored: 0,
      pinned: false,
      retracted: false,
      hasVerifiedEvidence: false,
    }
    groups.set(observationId, created)
    return created
  }
  for (const envelope of envelopes) {
    if (envelope.eventType === 'claim.archived') continue
    const ids = observationIdsReferencedBy(envelope.eventType, envelope.payload)
    if (envelope.eventType === 'observation.recorded') {
      if (ids.length !== 1) continue
      const group = groupFor(ids[0]!)
      group.events.push({ eventId: envelope.eventId, sequence: envelope.sequence })
      group.hasAnchor = true
      const payload = envelope.payload as Record<string, unknown>
      const observation = isRecord(payload.observation) ? payload.observation : {}
      const kind = typeof observation.kind === 'string' ? observation.kind : ''
      const provenance = isRecord(observation.provenance)
        ? {
            toolName:
              typeof observation.provenance.toolName === 'string'
                ? observation.provenance.toolName
                : undefined,
          }
        : null
      group.tier = deriveUsefulnessTier({ kind, provenance })
      group.createdAtWall = envelope.occurredAt
      continue
    }
    if (envelope.eventType === 'observation.reused') {
      const payload = envelope.payload as Record<string, unknown>
      const reusedPayload = isRecord(payload) ? payload : {}
      for (const entry of Array.isArray(reusedPayload.used) ? reusedPayload.used : []) {
        if (!isRecord(entry)) continue
        const id = safeString(entry.observationId)
        if (!id) continue
        groupFor(id).used += 1
      }
      for (const entry of Array.isArray(reusedPayload.ignored) ? reusedPayload.ignored : []) {
        if (!isRecord(entry)) continue
        const id = safeString(entry.observationId)
        if (!id) continue
        groupFor(id).ignored += 1
      }
      shared.push(envelope)
      continue
    }
    if (SHARED_COMPACTION_EVENT_TYPES.has(envelope.eventType)) {
      shared.push(envelope)
      continue
    }
    // Exclusive single-observation events attach to their group.
    if (ids.length !== 1) continue
    const group = groupFor(ids[0]!)
    group.events.push({ eventId: envelope.eventId, sequence: envelope.sequence })
    switch (envelope.eventType) {
      case 'claim.superseded':
      case 'claim.corrected':
        group.retracted = true
        break
      case 'claim.pinned':
        group.pinned = true
        break
      case 'evidence.verified':
        group.hasVerifiedEvidence = true
        break
      default:
        break
    }
  }
  for (const envelope of shared) {
    if (envelope.eventType === 'observation.reused') continue
    const payload = envelope.payload as Record<string, unknown>
    if (envelope.eventType === 'claim.forgotten') {
      for (const id of observationIdsReferencedBy(envelope.eventType, envelope.payload)) {
        groupFor(id).retracted = true
      }
    } else if (envelope.eventType === 'claim.consolidated') {
      const sourceIds = isRecord(payload)
        ? safeStringArray(payload.sourceObservationIds)
        : []
      for (const id of sourceIds) groupFor(id).retracted = true
    } else if (envelope.eventType === 'claim.corrected') {
      const target = isRecord(payload) ? safeString(payload.observationId) : null
      if (target) groupFor(target).retracted = true
    }
  }
  return { groups, shared }
}

const sharedEventReferences = (envelope: GCRelevantEnvelope): string[] =>
  envelope.eventType === 'observation.reused'
    ? observationIdsReferencedBy(envelope.eventType, envelope.payload)
    : envelope.eventType === 'claim.forgotten' ||
        envelope.eventType === 'claim.consolidated' ||
        envelope.eventType === 'claim.corrected'
      ? observationIdsReferencedBy(envelope.eventType, envelope.payload)
      : []

/**
 * Shared P6 compaction-candidate selection over a bounded GC-relevant
 * envelope batch. Deterministic: whole observation groups (never split) are
 * ordered by branch precedence, then createdAtWall, then observationId
 * (code-point), accumulated up to maxEvents; shared events follow only when
 * every referenced observation was archived. The closure fixpoint removes
 * eligible groups that a shared event could resurrect or corrupt.
 */
export function selectCompactionCandidates(params: {
  envelopes: GCRelevantEnvelope[]
  maxEvents: number
  asOfTurnWall: string
}): {
  eventIds: string[]
  branchCounts: { retracted: number; orphan: number; lowScore: number }
} {
  const { groups, shared } = partitionEnvelopes(params.envelopes)
  const evaluated = new Map<string, CompactionBranch>()
  const createdAt = new Map<string, string>()
  for (const group of groups.values()) {
    if (!group.hasAnchor) continue
    const eligibility = compactionEligibility({
      observation: {
        observationId: group.observationId,
        createdAtWall: group.createdAtWall,
        tier: group.tier,
        used: group.used,
        ignored: group.ignored,
        pinned: group.pinned,
        retracted: group.retracted,
        hasVerifiedEvidence: group.hasVerifiedEvidence,
      },
      asOfTurnWall: params.asOfTurnWall,
    })
    if (!eligibility.eligible) continue
    evaluated.set(group.observationId, eligibility.branch)
    createdAt.set(group.observationId, group.createdAtWall)
  }
  // Closure fixpoint: remove any group referenced by a shared event that also
  // references at least one observation whose group is NOT in the set.
  // Finite and deterministic: the candidate set only shrinks each pass.
  const sharedReferences = shared.map((envelope) => ({
    eventId: envelope.eventId,
    sequence: envelope.sequence,
    references: sharedEventReferences(envelope),
  }))
  let survivors = new Set(evaluated.keys())
  let changed = true
  while (changed) {
    changed = false
    for (const { references } of sharedReferences) {
      const outside = references.some((id) => !survivors.has(id))
      if (!outside) continue
      for (const id of references) {
        if (survivors.delete(id)) changed = true
      }
    }
  }
  const ordered = [...survivors]
    .map((observationId) => ({
      observationId,
      branch: evaluated.get(observationId)!,
      createdAtWall: createdAt.get(observationId) ?? '1970-01-01T00:00:00.000Z',
    }))
    .sort(
      (left, right) =>
        BRANCH_RANK[left.branch] - BRANCH_RANK[right.branch] ||
        compareCodePoints(left.createdAtWall, right.createdAtWall) ||
        compareCodePoints(left.observationId, right.observationId),
    )
  const archived = new Map<
    string,
    { branch: 'retracted' | 'orphan' | 'lowScore'; eventIds: string[] }
  >()
  let total = 0
  for (const item of ordered) {
    const group = groups.get(item.observationId)!
    const size = group.events.length
    if (total + size > params.maxEvents) break
    total += size
    archived.set(item.observationId, {
      branch: item.branch,
      eventIds: group.events.map(({ eventId }) => eventId),
    })
  }
  const archivedObservationIds = new Set(archived.keys())
  const sharedCandidates = sharedReferences
    .filter(
      ({ references }) =>
        references.length > 0 &&
        references.every((id) => archivedObservationIds.has(id)),
    )
    .sort(
      (left, right) =>
        left.sequence - right.sequence ||
        compareCodePoints(left.eventId, right.eventId),
    )
  const eventIds: string[] = []
  for (const group of archived.values()) eventIds.push(...group.eventIds)
  for (const candidate of sharedCandidates) {
    if (total + 1 > params.maxEvents) break
    eventIds.push(candidate.eventId)
    total += 1
  }
  const branchCounts = { retracted: 0, orphan: 0, lowScore: 0 }
  for (const group of archived.values()) branchCounts[group.branch] += 1
  return { eventIds, branchCounts }
}
