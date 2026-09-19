import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  COMPACTION_EVICTION_FLOOR,
  COMPACTION_MIN_AGE_DAYS,
  COMPACTION_IGNORE_THRESHOLD,
  COMPACTION_ORPHAN_MIN_AGE_DAYS,
  COMPACTION_ELIGIBILITY_MODEL_VERSION,
  compactionEligibility,
  isOrphan,
  observationIdsReferencedBy,
  selectCompactionCandidates,
  type GCRelevantEnvelope,
} from './compaction-eligibility'

const CREATED_OLD = '2025-01-01T00:00:00.000Z'
const AS_OF = '2025-03-05T00:00:00.000Z'

const recorded = (
  eventId: string,
  sequence: number,
  observationId: string,
  createdAt = CREATED_OLD,
): GCRelevantEnvelope => ({
  eventType: 'observation.recorded',
  eventId,
  sequence,
  occurredAt: createdAt,
  payload: {
    payloadSchemaVersion: 1,
    observation: {
      observationId,
      kind: 'fact',
      provenance: { toolName: 'test' },
    },
  },
})

const forgotten = (
  eventId: string,
  sequence: number,
  observationIds: string[],
): GCRelevantEnvelope => ({
  eventType: 'claim.forgotten',
  eventId,
  sequence,
  occurredAt: CREATED_OLD,
  payload: { payloadSchemaVersion: 1, observationIds },
})

describe('isOrphan', () => {
  test('is true only when never retracted and without verified evidence', () => {
    expect(isOrphan({ retracted: false, hasVerifiedEvidence: false })).toBe(true)
    expect(isOrphan({ retracted: true, hasVerifiedEvidence: false })).toBe(false)
    expect(isOrphan({ retracted: false, hasVerifiedEvidence: true })).toBe(false)
    expect(isOrphan({ retracted: true, hasVerifiedEvidence: true })).toBe(false)
  })
})

describe('compactionEligibility', () => {
  test('retracted observations are eligible with branch precedence', () => {
    const outcome = compactionEligibility({
      observation: {
        observationId: 'obs:a',
        createdAtWall: CREATED_OLD,
        tier: 'derived',
        used: 5,
        ignored: 0,
        pinned: false,
        retracted: true,
        hasVerifiedEvidence: true,
      },
      asOfTurnWall: AS_OF,
    })
    expect(outcome.eligible).toBe(true)
    expect(outcome.branch).toBe('retracted')
  })

  test('pinned observations are never eligible even when retracted', () => {
    const outcome = compactionEligibility({
      observation: {
        observationId: 'obs:a',
        createdAtWall: CREATED_OLD,
        tier: 'derived',
        used: 0,
        ignored: 0,
        pinned: true,
        retracted: true,
        hasVerifiedEvidence: false,
      },
      asOfTurnWall: AS_OF,
    })
    expect(outcome.eligible).toBe(false)
    expect(outcome.branch).toBeNull()
  })

  test('orphans are eligible only beyond the orphan age floor', () => {
    const young = compactionEligibility({
      observation: {
        observationId: 'obs:a',
        createdAtWall: AS_OF,
        tier: 'derived',
        used: 0,
        ignored: 0,
        pinned: false,
        retracted: false,
        hasVerifiedEvidence: false,
      },
      asOfTurnWall: AS_OF,
    })
    expect(young.eligible).toBe(false)
    const old = compactionEligibility({
      observation: {
        observationId: 'obs:a',
        createdAtWall: CREATED_OLD,
        tier: 'derived',
        used: 0,
        ignored: 0,
        pinned: false,
        retracted: false,
        hasVerifiedEvidence: false,
      },
      asOfTurnWall: AS_OF,
    })
    expect(old.eligible).toBe(true)
    expect(old.branch).toBe('orphan')
  })

  test('lowScore branch requires score<=0, no uses, old age, ignored threshold, and non-explicit tier', () => {
    const lowScore = compactionEligibility({
      observation: {
        observationId: 'obs:a',
        createdAtWall: CREATED_OLD,
        tier: 'derived',
        used: 0,
        ignored: COMPACTION_IGNORE_THRESHOLD,
        pinned: false,
        retracted: false,
        hasVerifiedEvidence: true,
      },
      asOfTurnWall: AS_OF,
    })
    expect(lowScore.eligible).toBe(true)
    expect(lowScore.branch).toBe('lowScore')

    // Explicit tier keeps its agent-explicit score floor and never compacts
    // through the lowScore branch.
    const explicit = compactionEligibility({
      observation: {
        observationId: 'obs:a',
        createdAtWall: CREATED_OLD,
        tier: 'explicit',
        used: 0,
        ignored: COMPACTION_IGNORE_THRESHOLD,
        pinned: false,
        retracted: false,
        hasVerifiedEvidence: true,
      },
      asOfTurnWall: AS_OF,
    })
    expect(explicit.eligible).toBe(false)
    expect(explicit.branch).toBeNull()
  })
})

describe('observationIdsReferencedBy', () => {
  test('extracts ids per event type', () => {
    expect(observationIdsReferencedBy('claim.forgotten', { observationIds: ['a', 'b'] }))
      .toEqual(['a', 'b'])
    expect(
      observationIdsReferencedBy('claim.consolidated', {
        sourceObservationIds: ['a'],
        canonicalObservation: { observationId: 'c' },
      }),
    ).toEqual(['a', 'c'])
    expect(
      observationIdsReferencedBy('claim.corrected', {
        observationId: 'a',
        correction: { observationId: 'b' },
      }),
    ).toEqual(['a', 'b'])
    expect(
      observationIdsReferencedBy('observation.reused', {
        used: [{ observationId: 'a' }],
        ignored: [{ observationId: 'b' }],
      }),
    ).toEqual(['a', 'b'])
    for (const eventType of [
      'claim.superseded',
      'claim.pinned',
      'evidence.attached',
      'evidence.verified',
      'evidence.invalidated',
      'evidence.rebound',
    ]) {
      expect(observationIdsReferencedBy(eventType, { observationId: 'a' })).toEqual(['a'])
    }
    expect(
      observationIdsReferencedBy('observation.recorded', {
        observation: { observationId: 'a' },
      }),
    ).toEqual(['a'])
    expect(observationIdsReferencedBy('task.created', {})).toEqual([])
  })

  test('is tolerant of malformed payloads', () => {
    expect(observationIdsReferencedBy('claim.forgotten', 'not-an-object')).toEqual([])
    expect(observationIdsReferencedBy('claim.forgotten', { observationIds: 'nope' })).toEqual([])
    expect(
      observationIdsReferencedBy('claim.forgotten', { observationIds: ['a', 7, null] }),
    ).toEqual(['a'])
    expect(observationIdsReferencedBy('observation.recorded', { observation: {} })).toEqual([])
  })
})

describe('selectCompactionCandidates', () => {
  test('archives whole retracted groups and appends their shared forgotten event', () => {
    const selection = selectCompactionCandidates({
      envelopes: [
        recorded('event:a', 1, 'obs:a'),
        recorded('event:b', 2, 'obs:b'),
        forgotten('event:f', 3, ['obs:a', 'obs:b']),
      ],
      maxEvents: 10,
      asOfTurnWall: AS_OF,
    })
    expect(selection.eventIds).toEqual(['event:a', 'event:b', 'event:f'])
    expect(selection.branchCounts).toEqual({ retracted: 2, orphan: 0, lowScore: 0 })
  })

  test('never archives pinned groups', () => {
    const selection = selectCompactionCandidates({
      envelopes: [
        recorded('event:a', 1, 'obs:a'),
        {
          eventType: 'claim.pinned',
          eventId: 'event:p',
          sequence: 2,
          occurredAt: CREATED_OLD,
          payload: { payloadSchemaVersion: 1, observationId: 'obs:a' },
        },
        forgotten('event:f', 3, ['obs:a']),
      ],
      maxEvents: 10,
      asOfTurnWall: AS_OF,
    })
    expect(selection.eventIds).toEqual([])
    expect(selection.branchCounts).toEqual({ retracted: 0, orphan: 0, lowScore: 0 })
  })

  test('never splits a group across the maxEvents boundary', () => {
    const selection = selectCompactionCandidates({
      envelopes: [
        recorded('event:a', 1, 'obs:a'),
        recorded('event:b', 2, 'obs:b'),
        forgotten('event:f', 3, ['obs:a', 'obs:b']),
      ],
      maxEvents: 1,
      asOfTurnWall: AS_OF,
    })
    expect(selection.eventIds).toEqual(['event:a'])
    expect(selection.branchCounts).toEqual({ retracted: 1, orphan: 0, lowScore: 0 })
  })

  test('closure fixpoint removes groups a shared event could corrupt', () => {
    // obs:a is an old orphan (eligible); obs:b is young (ineligible). The
    // shared reuse event references both, so archiving obs:a would corrupt
    // the shared event: the fixpoint must remove obs:a.
    const selection = selectCompactionCandidates({
      envelopes: [
        recorded('event:a', 1, 'obs:a'),
        recorded('event:b', 2, 'obs:b', AS_OF),
        {
          eventType: 'observation.reused',
          eventId: 'event:r',
          sequence: 3,
          occurredAt: AS_OF,
          payload: {
            payloadSchemaVersion: 1,
            turnId: 'turn:1',
            used: [{ observationId: 'obs:a', mechanism: 'query' }],
            ignored: [{ observationId: 'obs:b', mechanism: 'query' }],
          },
        },
      ],
      maxEvents: 10,
      asOfTurnWall: AS_OF,
    })
    expect(selection.eventIds).toEqual([])
    expect(selection.branchCounts).toEqual({ retracted: 0, orphan: 0, lowScore: 0 })
  })

  test('ignores claim.archived and malformed envelopes deterministically', () => {
    const selection = selectCompactionCandidates({
      envelopes: [
        recorded('event:a', 1, 'obs:a'),
        forgotten('event:f', 2, ['obs:a']),
        {
          eventType: 'claim.archived',
          eventId: 'event:archived',
          sequence: 3,
          occurredAt: CREATED_OLD,
          payload: { payloadSchemaVersion: 1, archivedEventIds: ['event:a'] },
        },
        { eventType: 'claim.forgotten', eventId: 'event:bad', sequence: 4, occurredAt: CREATED_OLD, payload: 'garbage' },
      ],
      maxEvents: 10,
      asOfTurnWall: AS_OF,
    })
    expect(selection.eventIds).toEqual(['event:a', 'event:f'])
    expect(selection.branchCounts).toEqual({ retracted: 1, orphan: 0, lowScore: 0 })
  })

  test('exposes the locked constants and model version', () => {
    expect(COMPACTION_EVICTION_FLOOR).toBe(0)
    expect(COMPACTION_MIN_AGE_DAYS).toBe(30)
    expect(COMPACTION_IGNORE_THRESHOLD).toBe(3)
    expect(COMPACTION_ORPHAN_MIN_AGE_DAYS).toBe(30)
    expect(COMPACTION_ELIGIBILITY_MODEL_VERSION).toBe('compaction-eligibility-v1')
  })
})

describe('P9 invariant enforcement (eligibility)', () => {
  test('INV11: an old ignored unsuperseded explicit observation is never eligible on any age-driven branch', () => {
    // Old orphan with heavy ignores: age alone can never evict an
    // unsuperseded agent-explicit decision (SPEC invariant 11).
    const outcome = compactionEligibility({
      observation: {
        observationId: 'obs:explicit',
        createdAtWall: CREATED_OLD,
        tier: 'explicit',
        used: 0,
        ignored: 10,
        pinned: false,
        retracted: false,
        hasVerifiedEvidence: false,
      },
      asOfTurnWall: AS_OF,
    })
    expect(outcome.eligible).toBe(false)
    expect(outcome.branch).toBeNull()
  })

  test('a reused observation is never evicted by a heuristic branch', () => {
    const outcome = compactionEligibility({
      observation: {
        observationId: 'obs:reused',
        createdAtWall: CREATED_OLD,
        tier: 'derived',
        used: 1,
        ignored: 10,
        pinned: false,
        retracted: false,
        hasVerifiedEvidence: false,
      },
      asOfTurnWall: AS_OF,
    })
    expect(outcome.eligible).toBe(false)
    expect(outcome.branch).toBeNull()
  })

  test('a heavily reinforced never-used claim is never evicted by a heuristic branch and its score reflects the reinforcement', () => {
    // GC scoring must honor the same reinforced signal retrieval scoring
    // rewards (w_reinf=6): a heavily reinforced, never-used claim is not
    // evictable on the orphan or lowScore branch.
    const reinforced = compactionEligibility({
      observation: {
        observationId: 'obs:reinforced',
        createdAtWall: CREATED_OLD,
        tier: 'derived',
        used: 0,
        ignored: 10,
        reinforced: 3,
        pinned: false,
        retracted: false,
        hasVerifiedEvidence: false,
      },
      asOfTurnWall: AS_OF,
    })
    expect(reinforced.eligible).toBe(false)
    expect(reinforced.branch).toBeNull()
    // The folded signal raises the reported score by 18 (3 x w_reinf=6).
    // Measured at age 0 with no ignores so the [0,1000] clamp cannot hide
    // the delta (an old heavily-ignored observation clamps to 0 either way).
    const freshBaseline = compactionEligibility({
      observation: {
        observationId: 'obs:reinforced',
        createdAtWall: AS_OF,
        tier: 'derived',
        used: 0,
        ignored: 0,
        pinned: false,
        retracted: false,
        hasVerifiedEvidence: false,
      },
      asOfTurnWall: AS_OF,
    })
    const freshReinforced = compactionEligibility({
      observation: {
        observationId: 'obs:reinforced',
        createdAtWall: AS_OF,
        tier: 'derived',
        used: 0,
        ignored: 0,
        reinforced: 3,
        pinned: false,
        retracted: false,
        hasVerifiedEvidence: false,
      },
      asOfTurnWall: AS_OF,
    })
    expect(freshReinforced.score).toBe(freshBaseline.score + 18)
  })

  test('selectCompactionCandidates never selects a heavily reinforced never-used derived group', () => {
    // Same store as the reused-observation selection test: an old orphan
    // with heavy ignores plus reinforcement must stay out of the batch.
    const selection = selectCompactionCandidates({
      envelopes: [
        recorded('event:obs', 1, 'obs:a'),
        {
          eventType: 'claim.reinforced',
          eventId: 'event:reinforced-1',
          sequence: 2,
          occurredAt: CREATED_OLD,
          payload: {
            payloadSchemaVersion: 1,
            observationId: 'obs:a',
            claimId: 'a'.repeat(64),
            reason: 'duplicate decision capture',
            reinforcedAt: CREATED_OLD,
          },
        },
        {
          eventType: 'observation.reused',
          eventId: 'event:reused-1',
          sequence: 3,
          occurredAt: CREATED_OLD,
          payload: {
            payloadSchemaVersion: 1,
            turnId: 'turn:1',
            used: [],
            ignored: [{ observationId: 'obs:a', mechanism: 'query' },
              { observationId: 'obs:a', mechanism: 'query' },
              { observationId: 'obs:a', mechanism: 'query' }],
          },
        },
      ],
      maxEvents: 10,
      asOfTurnWall: AS_OF,
    })
    expect(selection.eventIds).toEqual([])
    expect(selection.branchCounts).toEqual({ retracted: 0, orphan: 0, lowScore: 0 })
  })

  test('INV6 purity: the module never consults an ambient clock', () => {
    const source = readFileSync(
      join(import.meta.dir, 'compaction-eligibility.ts'),
      'utf8',
    )
    // Strip line and block comments first: the module's header comment names
    // 'Date.now' in prose, and the invariant bans its EXECUTION, not its mention.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(code.includes('Date.now')).toBe(false)
  })
})
