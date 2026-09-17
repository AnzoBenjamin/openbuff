import { describe, expect, test } from 'bun:test'

import {
  MemoryAppendRequestSchema,
  MemoryEventEnvelopeSchema,
  MemoryEventIdSchema,
  MemorySessionIdSchema,
  ProjectIdSchema,
  TaskIdSchema,
  type MemoryEventEnvelope,
} from '@codebuff/common/types/memory-v2'
import {
  taskMemoryDraftV1Schema,
  type TaskMemoryV1,
} from '@codebuff/common/types/task-memory'
import { stableHash } from '@codebuff/common/util/stable-hash'

import {
  auditTaskMemoryV1Migration,
  getV1MigrationIdentity,
  importTaskMemoryV1,
  type V1MigrationAuditReader,
} from '../v1-migration'
import type { MemoryRepositoryV2 } from '../types'

const projectId = ProjectIdSchema.parse('project:migration-test')
const sessionId = MemorySessionIdSchema.parse('session:migration-test')
const updatedAt = Date.parse('2026-09-10T19:41:53.753Z')

const defaultDraft = {
  schemaVersion: 1 as const,
  goal: 'Never import this goal',
  requirements: ['requirement'],
  decisions: ['decision'],
  filesInspected: ['src/read.ts'],
  editsMade: ['src/edit.ts'],
  validationResults: ['validation'],
  reviewReceipts: ['review'],
  blockers: ['blocker'],
  nextActions: ['next'],
  historicalSummary: 'history',
  evidence: [
    {
      id: 'fresh',
      kind: 'read' as const,
      summary: 'fresh',
      path: 'src/live.ts',
      stale: false,
    },
    {
      id: 'stale',
      kind: 'read' as const,
      summary: 'stale',
      path: 'src/stale.ts',
      stale: true,
    },
    {
      id: 'private',
      kind: 'read' as const,
      summary: 'private',
      path: '.env',
      stale: false,
    },
  ],
}

function memory(overrides: Partial<TaskMemoryV1> = {}): TaskMemoryV1 {
  const {
    revision = 3,
    updatedAt: sourceUpdatedAt = updatedAt,
    checksum: checksumOverride,
    ...draftOverrides
  } = overrides
  const draft = taskMemoryDraftV1Schema.parse({
    ...defaultDraft,
    ...draftOverrides,
  })
  const checksum =
    checksumOverride ??
    stableHash(
      JSON.stringify({ revision, updatedAt: sourceUpdatedAt, memory: draft }),
    )
  return { ...draft, revision, updatedAt: sourceUpdatedAt, checksum }
}

class Repository implements MemoryRepositoryV2 {
  events = new Map<string, MemoryEventEnvelope>()
  sequence = 0
  appendCalls = 0
  exportCalls = 0
  failAppendCall: number | undefined
  failAppendAsConflict = false
  beforeFailedAppend?: (repository: Repository) => void
  appendRequests: Array<ReturnType<typeof MemoryAppendRequestSchema.parse>> = []

  async append(input: Parameters<MemoryRepositoryV2['append']>[0]) {
    const request = MemoryAppendRequestSchema.parse(input)
    this.appendCalls++
    this.appendRequests.push(request)
    if (this.appendCalls === this.failAppendCall) {
      this.beforeFailedAppend?.(this)
      return this.failAppendAsConflict
        ? {
            outcome: 'rejected' as const,
            error: {
              code: 'conflict' as const,
              message: 'cursor conflict',
              retryable: true,
            },
          }
        : {
            outcome: 'failed' as const,
            error: {
              code: 'unavailable' as const,
              message: 'offline',
              retryable: true,
            },
          }
    }

    const canonicalTail = [...this.events.values()].at(-1)?.eventId
    const expectedTail =
      request.expectedTail ??
      (request.expectedLastEventId === undefined
        ? { kind: 'any' as const }
        : { kind: 'event' as const, eventId: request.expectedLastEventId })
    const tailMatches =
      expectedTail.kind === 'any' ||
      (expectedTail.kind === 'empty' && canonicalTail === undefined) ||
      (expectedTail.kind === 'event' && expectedTail.eventId === canonicalTail)
    if (!tailMatches) {
      return {
        outcome: 'rejected' as const,
        error: {
          code: 'conflict' as const,
          message: 'cursor conflict',
          retryable: true,
        },
      }
    }

    const staged = new Map(this.events)
    const entries: Array<{
      eventId: MemoryEventEnvelope['eventId']
      sequence: number
      duplicate: boolean
    }> = []
    let sequence = this.sequence
    for (const event of request.events) {
      const existing = staged.get(event.eventId)
      if (existing) {
        const { sequence: _sequence, ...existingDraft } = existing
        if (JSON.stringify(existingDraft) !== JSON.stringify(event)) {
          return {
            outcome: 'rejected' as const,
            error: {
              code: 'conflict' as const,
              message: 'event content conflict',
              retryable: false,
            },
          }
        }
        entries.push({
          eventId: event.eventId,
          sequence: existing.sequence,
          duplicate: true,
        })
        continue
      }
      const envelope = { ...event, sequence: ++sequence } as MemoryEventEnvelope
      staged.set(event.eventId, envelope)
      entries.push({ eventId: event.eventId, sequence, duplicate: false })
    }
    this.events = staged
    this.sequence = sequence
    return {
      outcome: 'appended' as const,
      entries,
      lastEventId: [...this.events.values()].at(-1)!.eventId,
    }
  }

  async export(input: Parameters<MemoryRepositoryV2['export']>[0]) {
    this.exportCalls++
    const events = [...this.events.values()]
    const afterIndex = input.afterEventId
      ? events.findIndex((event) => event.eventId === input.afterEventId)
      : -1
    const page = events.slice(afterIndex + 1, afterIndex + 1 + input.limit)
    const hasMore = afterIndex + 1 + page.length < events.length
    return {
      outcome: 'page' as const,
      events: page,
      nextAfterEventId: hasMore ? page.at(-1)!.eventId : null,
    }
  }

  async query(): Promise<never> {
    throw new Error('unused')
  }
  async verify(): Promise<never> {
    throw new Error('unused')
  }
  async rebuild(): Promise<never> {
    throw new Error('unused')
  }
  async health(): Promise<never> {
    throw new Error('unused')
  }
}

const run = (repository: Repository, value?: TaskMemoryV1) =>
  importTaskMemoryV1({ memory: value, projectId, sessionId, repository })

const audit = (repository: V1MigrationAuditReader, value?: TaskMemoryV1) =>
  auditTaskMemoryV1Migration({ memory: value, projectId, repository })

const cloneEvent = (
  event: MemoryEventEnvelope,
  overrides: Partial<MemoryEventEnvelope>,
): MemoryEventEnvelope =>
  MemoryEventEnvelopeSchema.parse({ ...event, ...overrides })

const migrationReservations = (repository: Repository) =>
  [...repository.events.values()].filter(
    (event) => event.eventType === 'migration.v1.reserved',
  )

const migrationMarkers = (repository: Repository) =>
  [...repository.events.values()].filter(
    (event) => event.eventType === 'migration.v1.imported',
  )

describe('V1 memory migration', () => {
  test('imports every legacy category with source metadata and preserves source', async () => {
    const repository = new Repository()
    const source = memory()
    const before = structuredClone(source)
    const outcome = await run(repository, source)
    expect(outcome.outcome).toBe('imported')
    expect(source).toEqual(before)

    const events = [...repository.events.values()]
    expect(events[0]!.eventType).toBe('migration.v1.reserved')
    expect(migrationReservations(repository)).toHaveLength(1)
    const observations = events.filter(
      (event) => event.eventType === 'observation.recorded',
    )
    const categories = observations.map((event) =>
      event.eventType === 'observation.recorded'
        ? event.payload.observation.provenance?.metadata.category
        : undefined,
    )
    expect(categories).toEqual(
      expect.arrayContaining([
        'requirements',
        'decisions',
        'files-inspected',
        'edits-made',
        'validation-results',
        'review-receipts',
        'blockers',
        'next-actions',
        'historical-summary',
        'path-evidence',
      ]),
    )
    expect(JSON.stringify(events)).not.toContain(source.goal)
    expect(
      events.some((event) => event.eventType === 'evidence.verified'),
    ).toBe(false)
    expect(JSON.stringify(events)).not.toContain('src/stale.ts')
    expect(JSON.stringify(events)).not.toContain('.env')

    if (outcome.outcome === 'imported') {
      expect(outcome.warnings).toEqual(
        expect.arrayContaining([
          'goal-excluded',
          'legacy-evidence-unverified',
          'stale-evidence-omitted',
          'unsafe-path-omitted',
        ]),
      )
      expect(outcome.lastEventId).toBe(events.at(-1)!.eventId)
      expect(outcome.sourceItemCounts).toEqual({
        requirements: 1,
        decisions: 1,
        'files-inspected': 1,
        'edits-made': 1,
        'validation-results': 1,
        'review-receipts': 1,
        blockers: 1,
        'next-actions': 1,
        'historical-summary': 1,
        'path-evidence': 1,
      })
      expect(outcome.truncatedFields).toBe(0)
    }

    const marker = migrationMarkers(repository)[0]
    expect(marker?.eventType).toBe('migration.v1.imported')
    if (
      marker?.eventType === 'migration.v1.imported' &&
      outcome.outcome === 'imported'
    ) {
      expect(marker.payload.sourceItemCounts).toEqual(outcome.sourceItemCounts)
      expect(marker.payload.truncatedFields).toBe(0)
      expect(marker.payload.omittedFields).toBe(outcome.omittedFields)
    }
  })

  test('rejects checksum mismatch without writes and reports no record', async () => {
    const repository = new Repository()
    expect(await run(repository)).toEqual({ outcome: 'no-record' })
    const invalid = memory({ checksum: 'invalid' })
    const before = structuredClone(invalid)
    expect(await run(repository, invalid)).toMatchObject({
      outcome: 'rejected',
      reason: 'checksum-mismatch',
    })
    expect(repository.events.size).toBe(0)
    expect(invalid).toEqual(before)
  })

  test('returns the canonical tail for an exact-repeat no-op', async () => {
    const repository = new Repository()
    const first = memory()
    const imported = await run(repository, first)
    expect(imported.outcome).toBe('imported')
    const eventCount = repository.events.size

    const repeated = await run(repository, first)
    expect(repeated.outcome).toBe('no-op')
    if (repeated.outcome === 'no-op' && imported.outcome === 'imported') {
      expect(repeated.importedObservationIds).toEqual(
        imported.importedObservationIds,
      )
      expect(repeated.sourceItemCounts).toEqual(imported.sourceItemCounts)
      expect(repeated.truncatedFields).toBe(imported.truncatedFields)
      expect(repeated.lastEventId).toBe(
        [...repository.events.values()].at(-1)!.eventId,
      )
    }
    expect(repository.events.size).toBe(eventCount)
  })

  test('binds an ordinary exact-repeat no-op to the marker whose complete body was audited', async () => {
    const repository = new Repository()
    const source = memory()
    const imported = await run(repository, source)
    expect(imported.outcome).toBe('imported')
    const canonicalMarker = migrationMarkers(repository)[0]!
    if (
      canonicalMarker.eventType !== 'migration.v1.imported' ||
      imported.outcome !== 'imported'
    )
      return

    const forgedMarker = MemoryEventEnvelopeSchema.parse({
      ...canonicalMarker,
      eventId: 'event:later-forged-exact-source-marker',
      payload: {
        ...canonicalMarker.payload,
        importedTaskId: 'task:forged',
        importedObservationIds: [],
        omittedFields: 99,
        sourceItemCounts: { requirements: 99 },
        truncatedFields: 99,
        warnings: [],
      },
      sequence: repository.sequence + 1,
    })
    repository.events.set(forgedMarker.eventId, forgedMarker)
    repository.sequence = forgedMarker.sequence
    const eventCount = repository.events.size

    const repeated = await run(repository, source)

    expect(repeated.outcome).toBe('no-op')
    if (repeated.outcome === 'no-op') {
      expect(repeated.importedTaskId).toBe(imported.importedTaskId)
      expect(repeated.importedObservationIds).toEqual(
        imported.importedObservationIds,
      )
      expect(repeated.omittedFields).toBe(imported.omittedFields)
      expect(repeated.sourceItemCounts).toEqual(imported.sourceItemCounts)
      expect(repeated.truncatedFields).toBe(imported.truncatedFields)
      expect(repeated.importedTaskId).not.toBe('task:forged')
    }
    expect(repository.events.size).toBe(eventCount)
  })

  test('repairs missing body evidence despite a matching persisted marker', async () => {
    const repository = new Repository()
    const source = memory()
    expect((await run(repository, source)).outcome).toBe('imported')
    const missing = [...repository.events.values()].find(
      (event) => event.eventType === 'task.created',
    )!
    repository.events.delete(missing.eventId)

    expect(await run(repository, source)).toMatchObject({ outcome: 'imported' })
    expect(await audit(repository, source)).toMatchObject({ outcome: 'exact' })
    const eventCount = repository.events.size
    expect(await run(repository, source)).toMatchObject({ outcome: 'no-op' })
    expect(repository.events.size).toBe(eventCount)
    expect(migrationMarkers(repository)).toHaveLength(2)
  })

  test('repairs a tampered marker even when its deterministic body remains complete', async () => {
    const repository = new Repository()
    const source = memory()
    expect((await run(repository, source)).outcome).toBe('imported')
    const marker = migrationMarkers(repository)[0]!
    if (marker.eventType !== 'migration.v1.imported') return
    repository.events.set(
      marker.eventId,
      MemoryEventEnvelopeSchema.parse({
        ...marker,
        payload: { ...marker.payload, omittedFields: 99 },
      }),
    )

    const repaired = await run(repository, source)

    expect(repaired).toMatchObject({ outcome: 'imported' })
    expect(await audit(repository, source)).toMatchObject({ outcome: 'exact' })
    expect(migrationMarkers(repository)).toHaveLength(2)
  })

  test('repairs incompatible deterministic body evidence with new event IDs', async () => {
    const repository = new Repository()
    const source = memory()
    expect((await run(repository, source)).outcome).toBe('imported')
    const original = [...repository.events.values()].find(
      (event) => event.eventType === 'observation.recorded',
    )!
    if (original.eventType !== 'observation.recorded') return
    repository.events.set(
      original.eventId,
      MemoryEventEnvelopeSchema.parse({
        ...original,
        payload: {
          ...original.payload,
          observation: {
            ...original.payload.observation,
            summary: 'older incompatible representation',
          },
        },
      }),
    )

    expect(await run(repository, source)).toMatchObject({ outcome: 'imported' })
    expect(await audit(repository, source)).toMatchObject({ outcome: 'exact' })
    expect(migrationMarkers(repository)).toHaveLength(2)
  })

  test('fails closed when a resumed deterministic event ID has corrupt content', async () => {
    const repository = new Repository()
    const source = memory()
    repository.failAppendCall = 3
    expect(await run(repository, source)).toMatchObject({ outcome: 'failed' })
    const task = [...repository.events.values()].find(
      (event) => event.eventType === 'task.created',
    )!
    repository.events.set(
      task.eventId,
      MemoryEventEnvelopeSchema.parse({
        ...task,
        payload: { ...task.payload, title: 'non-migration data' },
      }),
    )
    repository.failAppendCall = undefined
    const eventCount = repository.events.size

    expect(await run(repository, source)).toMatchObject({
      outcome: 'failed',
      reason: 'repository-failed',
    })
    expect(repository.events.size).toBe(eventCount)
    expect(migrationMarkers(repository)).toHaveLength(0)
  })

  test('does not accept an incomplete exact marker discovered during conflict recovery', async () => {
    const repository = new Repository()
    const source = memory()
    const concurrent = new Repository()
    expect((await run(concurrent, source)).outcome).toBe('imported')
    const concurrentMarker = migrationMarkers(concurrent)[0]!
    repository.failAppendCall = 1
    repository.failAppendAsConflict = true
    repository.beforeFailedAppend = (target) => {
      target.events.set(concurrentMarker.eventId, concurrentMarker)
      target.sequence = concurrentMarker.sequence
    }

    expect(await run(repository, source)).toMatchObject({
      outcome: 'failed',
      reason: 'repository-failed',
    })
    expect(
      [...repository.events.values()].filter(
        (event) =>
          event.eventType === 'task.created' ||
          event.eventType === 'observation.recorded',
      ),
    ).toHaveLength(0)
  })

  test('binds conflict recovery no-op fields to the validated complete marker', async () => {
    const repository = new Repository()
    const source = memory()
    const concurrent = new Repository()
    const imported = await run(concurrent, source)
    expect(imported.outcome).toBe('imported')
    const canonicalMarker = migrationMarkers(concurrent)[0]!
    if (canonicalMarker.eventType !== 'migration.v1.imported') return
    const forgedMarker = MemoryEventEnvelopeSchema.parse({
      ...canonicalMarker,
      eventId: 'event:concurrent-forged-marker',
      payload: {
        ...canonicalMarker.payload,
        importedTaskId: 'task:forged',
        importedObservationIds: [],
      },
      sequence: concurrent.sequence + 1,
    })

    repository.failAppendCall = 1
    repository.failAppendAsConflict = true
    repository.beforeFailedAppend = (target) => {
      for (const event of concurrent.events.values()) {
        target.events.set(event.eventId, event)
      }
      target.events.set(forgedMarker.eventId, forgedMarker)
      target.sequence = forgedMarker.sequence
    }

    const recovered = await run(repository, source)
    expect(recovered.outcome).toBe('no-op')
    if (recovered.outcome === 'no-op' && imported.outcome === 'imported') {
      expect(recovered.importedTaskId).toBe(imported.importedTaskId)
      expect(recovered.importedObservationIds).toEqual(
        imported.importedObservationIds,
      )
      expect(recovered.importedTaskId).not.toBe('task:forged')
    }
  })

  test('records all bounded text truncation in the marker and outcome', async () => {
    const repository = new Repository()
    const source = memory({
      requirements: [
        'x'.repeat(1_100),
        ...Array.from({ length: 17 }, () => 'y'.repeat(1_000)),
      ],
      historicalSummary: 'h'.repeat(1_100),
      evidence: [
        {
          id: 'long-summary',
          kind: 'read',
          summary: 'e'.repeat(1_100),
          path: 'src/long.ts',
          stale: false,
        },
      ],
    })

    const outcome = await run(repository, source)
    expect(outcome.outcome).toBe('imported')
    if (outcome.outcome === 'imported') {
      expect(outcome.truncatedFields).toBe(4)
      expect(outcome.omittedFields).toBe(4)
      expect(outcome.warnings).toContain('text-truncated')
      expect(outcome.sourceItemCounts?.requirements).toBe(18)
      expect(outcome.sourceItemCounts?.['path-evidence']).toBe(1)
    }

    const marker = migrationMarkers(repository)[0]
    if (marker?.eventType === 'migration.v1.imported') {
      expect(marker.payload.truncatedFields).toBe(4)
      expect(marker.payload.omittedFields).toBe(4)
      expect(marker.payload.warnings).toContain('text-truncated')
      expect(marker.payload.sourceItemCounts?.requirements).toBe(18)
    }
    for (const event of repository.events.values()) {
      if (event.eventType === 'observation.recorded') {
        expect(event.payload.observation.detail.length).toBeLessThanOrEqual(
          16_384,
        )
      }
    }
  })

  test('a newer revision retires prior imported observations with deterministic lifecycle events', async () => {
    const repository = new Repository()
    const first = await run(repository, memory())
    expect(first.outcome).toBe('imported')
    const second = await run(repository, memory({ revision: 4 }))
    expect(second.outcome).toBe('imported')

    if (first.outcome === 'imported' && second.outcome === 'imported') {
      const forgotten = [...repository.events.values()].filter(
        (event) => event.eventType === 'claim.forgotten',
      )
      expect(forgotten).toHaveLength(first.importedObservationIds.length)
      expect(
        forgotten.flatMap((event) =>
          event.eventType === 'claim.forgotten'
            ? event.payload.observationIds
            : [],
        ),
      ).toEqual(first.importedObservationIds)
      for (const event of forgotten) {
        if (event.eventType === 'claim.forgotten') {
          expect(event.payload).toMatchObject({
            reason: 'duplicate',
            evidenceDisposition: 'remove-references',
          })
          expect(event.payload.requestedBy.length).toBeLessThanOrEqual(256)
          for (const observationId of event.payload.observationIds) {
            expect(second.importedObservationIds).not.toContain(observationId)
          }
        }
      }
      expect(
        [...repository.events.values()].findIndex(
          (event) =>
            event.eventType === 'migration.v1.imported' &&
            event.payload.sourceRevision === 4,
        ),
      ).toBeGreaterThan(
        [...repository.events.values()].findLastIndex(
          (event) => event.eventType === 'claim.forgotten',
        ),
      )
    }
  })

  test('does not retire claims from a lower-revision marker with forged observation references', async () => {
    const repository = new Repository()
    expect((await run(repository, memory())).outcome).toBe('imported')
    const marker = migrationMarkers(repository)[0]!
    if (marker.eventType !== 'migration.v1.imported') return
    repository.events.set(
      marker.eventId,
      MemoryEventEnvelopeSchema.parse({
        ...marker,
        payload: {
          ...marker.payload,
          importedObservationIds: ['observation:user-owned'],
        },
      }),
    )

    expect((await run(repository, memory({ revision: 4 }))).outcome).toBe(
      'imported',
    )
    expect(
      [...repository.events.values()].filter(
        (event) => event.eventType === 'claim.forgotten',
      ),
    ).toEqual([])
  })

  test('does not retire claims from a lower-revision marker without deterministic migration identity', async () => {
    const repository = new Repository()
    expect((await run(repository, memory())).outcome).toBe('imported')
    const marker = migrationMarkers(repository)[0]!
    if (marker.eventType !== 'migration.v1.imported') return
    repository.events.set(
      marker.eventId,
      MemoryEventEnvelopeSchema.parse({
        ...marker,
        payload: {
          ...marker.payload,
          legacyRecordKey: 'v1:forged-lower-revision-marker',
        },
      }),
    )

    expect((await run(repository, memory({ revision: 4 }))).outcome).toBe(
      'imported',
    )
    expect(
      [...repository.events.values()].filter(
        (event) => event.eventType === 'claim.forgotten',
      ),
    ).toEqual([])
  })

  test('does not retire claims when a lower-revision marker has no migration reservation', async () => {
    const repository = new Repository()
    expect((await run(repository, memory())).outcome).toBe('imported')
    const reservation = migrationReservations(repository)[0]!
    repository.events.delete(reservation.eventId)

    expect((await run(repository, memory({ revision: 4 }))).outcome).toBe(
      'imported',
    )
    expect(
      [...repository.events.values()].filter(
        (event) => event.eventType === 'claim.forgotten',
      ),
    ).toEqual([])
  })

  test('does not retire claims when a referenced observation is not migration-owned', async () => {
    const repository = new Repository()
    expect((await run(repository, memory())).outcome).toBe('imported')
    const observation = [...repository.events.values()].find(
      (event) => event.eventType === 'observation.recorded',
    )!
    if (observation.eventType !== 'observation.recorded') return
    repository.events.set(
      observation.eventId,
      MemoryEventEnvelopeSchema.parse({
        ...observation,
        payload: {
          ...observation.payload,
          observation: {
            ...observation.payload.observation,
            provenance: {
              ...observation.payload.observation.provenance,
              recordedBy: 'user-authored',
            },
          },
        },
      }),
    )

    expect((await run(repository, memory({ revision: 4 }))).outcome).toBe(
      'imported',
    )
    expect(
      [...repository.events.values()].filter(
        (event) => event.eventType === 'claim.forgotten',
      ),
    ).toEqual([])
  })

  test('reports imported when retry commits a marker after the body already committed', async () => {
    const repository = new Repository()
    const source = memory()
    repository.failAppendCall = 3
    expect(await run(repository, source)).toMatchObject({
      outcome: 'failed',
      reason: 'repository-failed',
    })
    const bodyIds = [...repository.events.keys()]
    expect(bodyIds.length).toBeGreaterThan(0)
    expect(migrationMarkers(repository)).toHaveLength(0)

    repository.failAppendCall = undefined
    const recovered = await run(repository, source)
    expect(recovered).toMatchObject({ outcome: 'imported' })
    if (recovered.outcome === 'imported') {
      expect(recovered.lastEventId).toBe(
        [...repository.events.values()].at(-1)!.eventId,
      )
    }
    expect([...repository.events.keys()].slice(0, bodyIds.length)).toEqual(
      bodyIds,
    )
    expect(new Set(repository.events.keys()).size).toBe(repository.events.size)
    expect(migrationMarkers(repository)).toHaveLength(1)
  })

  test('rejects the same revision with a different checksum before appending', async () => {
    const repository = new Repository()
    const first = memory()
    expect((await run(repository, first)).outcome).toBe('imported')
    const eventCount = repository.events.size
    const appendCalls = repository.appendCalls
    const changed = memory({
      revision: first.revision,
      updatedAt: first.updatedAt + 1,
      decisions: [...first.decisions, 'different source contents'],
    })
    expect(
      getV1MigrationIdentity({
        projectId,
        revision: first.revision,
        checksum: first.checksum,
      }),
    ).toBe(
      getV1MigrationIdentity({
        projectId,
        revision: changed.revision,
        checksum: changed.checksum,
      }),
    )

    expect(await run(repository, changed)).toMatchObject({
      outcome: 'rejected',
      reason: 'checksum-mismatch',
      revision: first.revision,
      checksum: changed.checksum,
    })
    expect(repository.appendCalls).toBe(appendCalls)
    expect(repository.events.size).toBe(eventCount)
  })

  test('recovers deterministically without duplicating body or marker events', async () => {
    const recovering = new Repository()
    recovering.failAppendCall = 3
    const source = memory()
    await run(recovering, source)
    recovering.failAppendCall = undefined
    const recovered = await run(recovering, source)

    const clean = new Repository()
    const imported = await run(clean, source)
    expect(recovered).toEqual(imported)
    expect([...recovering.events.keys()]).toEqual([...clean.events.keys()])
    expect(
      [...recovering.events.values()].map(
        ({ sequence: _sequence, ...event }) => event,
      ),
    ).toEqual(
      [...clean.events.values()].map(
        ({ sequence: _sequence, ...event }) => event,
      ),
    )
  })

  test('a different checksum cannot append body after another checksum owns the revision', async () => {
    const repository = new Repository()
    repository.failAppendCall = 2
    const first = memory()
    expect(await run(repository, first)).toMatchObject({ outcome: 'failed' })
    expect(migrationReservations(repository)).toHaveLength(1)
    expect(
      [...repository.events.values()].filter(
        (event) => event.eventType !== 'migration.v1.reserved',
      ),
    ).toHaveLength(0)

    repository.failAppendCall = undefined
    const changed = memory({
      revision: first.revision,
      updatedAt: first.updatedAt + 1,
      decisions: [...first.decisions, 'competing checksum'],
    })
    expect(await run(repository, changed)).toMatchObject({
      outcome: 'rejected',
      reason: 'checksum-mismatch',
    })
    expect(
      [...repository.events.values()].filter(
        (event) => event.eventType !== 'migration.v1.reserved',
      ),
    ).toHaveLength(0)
    expect(await run(repository, first)).toMatchObject({ outcome: 'imported' })
  })

  test('accepts an old completed import without a reservation as ownership', async () => {
    const repository = new Repository()
    const source = memory()
    expect((await run(repository, source)).outcome).toBe('imported')
    const reservationId = migrationReservations(repository)[0]!.eventId
    repository.events.delete(reservationId)
    const beforeCalls = repository.appendCalls
    expect(await run(repository, source)).toMatchObject({ outcome: 'no-op' })
    expect(repository.appendCalls).toBe(beforeCalls)
  })

  test('reserves the revision first and alone, then chains every body page and marker with explicit CAS', async () => {
    const repository = new Repository()
    const evidence = Array.from({ length: 100 }, (_, index) => ({
      id: `evidence-${index}`,
      kind: 'read' as const,
      summary: `evidence ${index}`,
      path: `src/evidence-${index}.ts`,
      stale: false,
    }))
    const outcome = await run(repository, memory({ evidence }))
    expect(outcome.outcome).toBe('imported')
    expect(repository.appendRequests).toHaveLength(4)

    const [reservationPage, firstPage, secondPage, markerPage] =
      repository.appendRequests
    expect(reservationPage.events).toHaveLength(1)
    expect(reservationPage.events[0]!.eventType).toBe('migration.v1.reserved')
    expect(reservationPage.expectedTail).toEqual({ kind: 'empty' })
    expect(firstPage.expectedTail).toEqual({
      kind: 'event',
      eventId: reservationPage.events[0]!.eventId,
    })
    expect(secondPage.expectedTail).toEqual({
      kind: 'event',
      eventId: firstPage.events.at(-1)!.eventId,
    })
    expect(markerPage.expectedTail).toEqual({
      kind: 'event',
      eventId: secondPage.events.at(-1)!.eventId,
    })
    if (outcome.outcome === 'imported') {
      expect(outcome.lastEventId).toBe(markerPage.events[0]!.eventId)
    }
  })
})

describe('V1 memory migration audit', () => {
  test('no record and checksum mismatch make no repository calls', async () => {
    const repository = new Repository()
    expect(await audit(repository)).toEqual({ outcome: 'no-record' })
    expect(
      await audit(repository, memory({ checksum: 'invalid' })),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'checksum-mismatch',
    })
    expect(repository.exportCalls).toBe(0)
    expect(repository.appendCalls).toBe(0)
  })

  test('reports not-migrated from a complete empty scan', async () => {
    const repository = new Repository()
    const source = memory()
    expect(await audit(repository, source)).toEqual({
      outcome: 'not-migrated',
      revision: source.revision,
      checksum: source.checksum,
    })
    expect(repository.appendCalls).toBe(0)
  })

  test('certifies an imported body without writes and preserves lossy metadata', async () => {
    const repository = new Repository()
    const source = memory({ historicalSummary: 'h'.repeat(1_100) })
    const imported = await run(repository, source)
    expect(imported.outcome).toBe('imported')
    const appendCalls = repository.appendCalls

    const outcome = await audit(repository, source)
    expect(outcome).toMatchObject({
      outcome: 'exact',
      revision: source.revision,
      checksum: source.checksum,
      identity: getV1MigrationIdentity({
        projectId,
        revision: source.revision,
        checksum: source.checksum,
      }),
      repositoryLastEventId: [...repository.events.values()].at(-1)!.eventId,
      warnings: expect.arrayContaining([
        'goal-excluded',
        'legacy-evidence-unverified',
        'text-truncated',
      ]),
      truncatedFields: 1,
    })
    if (outcome.outcome === 'exact' && imported.outcome === 'imported') {
      expect(outcome.markerEventId).toBe(
        [...migrationMarkers(repository)][0]!.eventId,
      )
      expect(outcome.importedTaskId).toBe(imported.importedTaskId)
      expect(outcome.importedObservationIds).toEqual(
        imported.importedObservationIds,
      )
      expect(outcome.omittedFields).toBe(imported.omittedFields)
      expect(outcome.sourceItemCounts).toEqual(imported.sourceItemCounts)
    }
    expect(repository.appendCalls).toBe(appendCalls)
  })

  test('certifies exact after a JSON round-trip that sorts record-valued payload keys', async () => {
    // Regression: the Bun SQLite repository persists payloads via stableJson,
    // which recursively sorts object keys, and export() re-parses from that
    // sorted JSON. The marker's sourceItemCounts (a z.record) therefore comes
    // back in alphabetical order while the in-memory draft keeps insertion
    // order. equalEventDraft must compare content, not key order, or the real
    // provider always reports imported-body-mismatch. This subclass mimics
    // that round-trip by re-parsing each exported event with sorted keys.
    class SortedJsonRepository extends Repository {
      override async export(
        input: Parameters<MemoryRepositoryV2['export']>[0],
      ) {
        const page = await super.export(input)
        if (page.outcome !== 'page') return page
        return {
          ...page,
          events: page.events.map((event) =>
            MemoryEventEnvelopeSchema.parse(
              JSON.parse(
                JSON.stringify(event, (_key, value) =>
                  value !== null &&
                  typeof value === 'object' &&
                  !Array.isArray(value)
                    ? Object.fromEntries(
                        Object.entries(value as Record<string, unknown>).sort(
                          ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
                        ),
                      )
                    : value,
                ),
              ),
            ),
          ),
        }
      }
    }

    const repository = new SortedJsonRepository()
    const source = memory({ requirements: ['req-1'], decisions: ['dec-1'] })
    expect((await run(repository, source)).outcome).toBe('imported')
    expect(await audit(repository, source)).toMatchObject({
      outcome: 'exact',
      revision: source.revision,
      checksum: source.checksum,
    })
  })

  test('reports a reservation-only partial import as incomplete', async () => {
    const repository = new Repository()
    const source = memory()
    repository.failAppendCall = 2
    expect(await run(repository, source)).toMatchObject({ outcome: 'failed' })

    expect(await audit(repository, source)).toMatchObject({
      outcome: 'incomplete',
      reason: 'reservation-only',
      repositoryLastEventId: migrationReservations(repository)[0]!.eventId,
    })
  })

  test('reports same-revision checksum ownership as a mismatch', async () => {
    const repository = new Repository()
    const first = memory()
    expect((await run(repository, first)).outcome).toBe('imported')
    const changed = memory({
      revision: first.revision,
      updatedAt: first.updatedAt + 1,
      decisions: [...first.decisions, 'changed'],
    })

    expect(await audit(repository, changed)).toMatchObject({
      outcome: 'mismatch',
      reason: 'checksum-conflict',
      checksum: changed.checksum,
    })
  })

  test('detects missing imported task and observation bodies', async () => {
    const missingTaskRepository = new Repository()
    const source = memory()
    const taskImport = await run(missingTaskRepository, source)
    expect(taskImport.outcome).toBe('imported')
    const taskEvent = [...missingTaskRepository.events.values()].find(
      (event) => event.eventType === 'task.created',
    )!
    missingTaskRepository.events.delete(taskEvent.eventId)
    expect(await audit(missingTaskRepository, source)).toMatchObject({
      outcome: 'incomplete',
      reason: 'missing-imported-task',
    })

    const repository = new Repository()
    const imported = await run(repository, source)
    expect(imported.outcome).toBe('imported')
    if (imported.outcome !== 'imported') return
    const removed = [...repository.events.values()].find(
      (event) =>
        event.eventType === 'observation.recorded' &&
        event.payload.observation.observationId ===
          imported.importedObservationIds[0],
    )!
    repository.events.delete(removed.eventId)

    expect(await audit(repository, source)).toMatchObject({
      outcome: 'incomplete',
      reason: 'missing-imported-observations',
    })
  })

  test('detects mismatched imported observation provenance', async () => {
    const repository = new Repository()
    const source = memory()
    const imported = await run(repository, source)
    expect(imported.outcome).toBe('imported')
    if (imported.outcome !== 'imported') return
    const original = [...repository.events.values()].find(
      (event) =>
        event.eventType === 'observation.recorded' &&
        event.payload.observation.observationId ===
          imported.importedObservationIds[0],
    )!
    if (original.eventType !== 'observation.recorded') return
    const mutated = MemoryEventEnvelopeSchema.parse({
      ...original,
      payload: {
        ...original.payload,
        observation: {
          ...original.payload.observation,
          provenance: {
            ...original.payload.observation.provenance,
            metadata: {
              ...original.payload.observation.provenance?.metadata,
              checksum: 'different',
            },
          },
        },
      },
    })
    repository.events.set(original.eventId, mutated)

    expect(await audit(repository, source)).toMatchObject({
      outcome: 'mismatch',
      reason: 'imported-body-mismatch',
    })
  })

  test('detects full deterministic task, observation, header, and marker tampering', async () => {
    const source = memory()
    const assertTamper = async (
      select: (repository: Repository) => MemoryEventEnvelope,
      mutate: (event: MemoryEventEnvelope) => unknown,
    ) => {
      const repository = new Repository()
      expect((await run(repository, source)).outcome).toBe('imported')
      const original = select(repository)
      const replacement = MemoryEventEnvelopeSchema.parse(mutate(original))
      repository.events.set(original.eventId, replacement)
      expect(await audit(repository, source)).toMatchObject({
        outcome: 'mismatch',
        reason: 'imported-body-mismatch',
      })
    }
    const task = (repository: Repository) =>
      [...repository.events.values()].find(
        (event) => event.eventType === 'task.created',
      )!
    const observation = (repository: Repository) =>
      [...repository.events.values()].find(
        (event) => event.eventType === 'observation.recorded',
      )!
    const marker = (repository: Repository) => migrationMarkers(repository)[0]!

    for (const payload of [
      { title: 'tampered' },
      { objective: 'tampered' },
      { initialStatus: 'created' as const, taskId: 'task:tampered' },
      { payloadSchemaVersion: 1 as const, title: 'tampered' },
    ]) {
      await assertTamper(task, (event) => ({
        ...event,
        payload: { ...event.payload, ...payload },
      }))
    }
    for (const header of [
      { sessionId: 'session:tampered' },
      { occurredAt: '2027-01-01T00:00:00.000Z' },
      { projectId: 'project:tampered' },
    ]) {
      await assertTamper(task, (event) => ({ ...event, ...header }))
    }

    const observationMutations: Array<
      (value: Record<string, unknown>) => Record<string, unknown>
    > = [
      (value) => ({ ...value, observationId: 'observation:tampered' }),
      (value) => ({ ...value, taskId: 'task:tampered' }),
      (value) => ({ ...value, kind: 'fact' }),
      (value) => ({ ...value, summary: 'tampered' }),
      (value) => ({ ...value, detail: 'tampered' }),
      (value) => ({ ...value, confidence: 0.5 }),
      (value) => ({
        ...value,
        evidence: [
          {
            artifact: {
              artifactId: 'artifact:tampered',
              location: 'src/tampered.ts',
              classification: {
                kind: 'source',
                generated: false,
                sensitivity: 'internal',
                labels: [],
              },
            },
            selector: { kind: 'file', path: 'src/tampered.ts' },
            provenance: {
              origin: 'migration',
              recordedBy: 'tampered',
              sourceEventIds: [],
              sourceSessionId: sessionId,
              metadata: {},
            },
            capturedAt: '2026-09-10T19:41:53.753Z',
          },
        ],
      }),
      (value) => ({
        ...value,
        selectors: [{ kind: 'file', path: 'tampered.ts' }],
      }),
      (value) => ({
        ...value,
        provenance: { ...(value.provenance as object), origin: 'derived' },
      }),
      (value) => ({
        ...value,
        provenance: { ...(value.provenance as object), recordedBy: 'tampered' },
      }),
      (value) => ({
        ...value,
        provenance: {
          ...(value.provenance as object),
          sourceEventIds: ['event:tampered'],
        },
      }),
      (value) => ({
        ...value,
        provenance: {
          ...(value.provenance as object),
          sourceSessionId: 'session:tampered',
        },
      }),
      (value) => ({
        ...value,
        provenance: {
          ...(value.provenance as object),
          metadata: {
            category: 'tampered',
            revision: 3,
            checksum: source.checksum,
          },
        },
      }),
      (value) => ({ ...value, tags: ['tampered'] }),
      (value) => ({ ...value, observedAt: '2027-01-01T00:00:00.000Z' }),
    ]
    for (const mutate of observationMutations) {
      await assertTamper(observation, (event) => {
        if (event.eventType !== 'observation.recorded') return event
        return {
          ...event,
          payload: {
            ...event.payload,
            observation: mutate(
              event.payload.observation as unknown as Record<string, unknown>,
            ),
          },
        }
      })
    }

    for (const payload of [
      { importedTaskId: 'task:tampered' },
      { importedObservationIds: [] },
      { importedObservationIds: ['observation:tampered'] },
      { omittedFields: 99 },
      { warnings: [] },
      { sourceItemCounts: { requirements: 99 } },
      { truncatedFields: 99 },
      { legacyRecordKey: 'tampered' },
    ]) {
      await assertTamper(marker, (event) => ({
        ...event,
        payload: { ...event.payload, ...payload },
      }))
    }
  })

  test('allows unrelated events but fails duplicate deterministic IDs', async () => {
    const source = memory()
    const repository = new Repository()
    expect((await run(repository, source)).outcome).toBe('imported')
    const template = [...repository.events.values()].find(
      (event) => event.eventType === 'task.created',
    )!
    repository.events.set(
      'event:unrelated',
      MemoryEventEnvelopeSchema.parse({
        ...template,
        eventId: 'event:unrelated',
        payload: { ...template.payload, taskId: 'task:unrelated' },
        sequence: repository.sequence + 1,
      }),
    )
    expect(await audit(repository, source)).toMatchObject({ outcome: 'exact' })

    const events = [...repository.events.values()]
    const reader: V1MigrationAuditReader = {
      async export() {
        return {
          outcome: 'page',
          events: [...events, template],
          nextAfterEventId: null,
        }
      },
    }
    expect(await audit(reader, source)).toMatchObject({
      outcome: 'mismatch',
      reason: 'imported-body-mismatch',
    })
  })

  test('treats a legacy marker without source proof as unverifiable', async () => {
    const repository = new Repository()
    const source = memory()
    expect((await run(repository, source)).outcome).toBe('imported')
    const marker = migrationMarkers(repository)[0]!
    if (marker.eventType !== 'migration.v1.imported') return
    const {
      sourceRevision: _sourceRevision,
      sourceChecksum: _sourceChecksum,
      ...legacyPayload
    } = marker.payload
    repository.events.set(
      marker.eventId,
      MemoryEventEnvelopeSchema.parse({ ...marker, payload: legacyPayload }),
    )

    expect(await audit(repository, source)).toMatchObject({
      outcome: 'incomplete',
      reason: 'legacy-marker-unverifiable',
      markerEventId: marker.eventId,
    })
  })

  test('maps repository failures and fails closed on malformed or wrong-project output', async () => {
    const source = memory()
    const repository = new Repository()
    await run(repository, source)
    const event = [...repository.events.values()][0]!
    const otherProjectEvent = cloneEvent(event, {
      projectId: ProjectIdSchema.parse('project:other'),
    })
    const cases: Array<{
      reader: V1MigrationAuditReader
      expected: { outcome: string; reason: string }
    }> = [
      {
        reader: {
          async export() {
            return {
              outcome: 'rejected',
              error: {
                code: 'invalid-request',
                message: 'no',
                retryable: false,
              },
            }
          },
        },
        expected: { outcome: 'rejected', reason: 'repository-rejected' },
      },
      {
        reader: {
          async export() {
            return {
              outcome: 'failed',
              error: { code: 'unavailable', message: 'no', retryable: true },
            }
          },
        },
        expected: { outcome: 'failed', reason: 'repository-failed' },
      },
      {
        reader: {
          async export(): Promise<never> {
            throw new Error('private failure')
          },
        },
        expected: { outcome: 'failed', reason: 'repository-failed' },
      },
      {
        reader: {
          async export() {
            return {
              outcome: 'page',
              events: 'invalid',
              nextAfterEventId: null,
            }
          },
        } as unknown as V1MigrationAuditReader,
        expected: { outcome: 'failed', reason: 'invalid-export' },
      },
      {
        reader: {
          async export() {
            return {
              outcome: 'page',
              events: [otherProjectEvent],
              nextAfterEventId: null,
            }
          },
        },
        expected: { outcome: 'failed', reason: 'wrong-project' },
      },
    ]

    for (const { reader, expected } of cases) {
      expect(await audit(reader, source)).toMatchObject(expected)
    }
  })

  test('rejects empty, non-tail, and repeated pagination cursors', async () => {
    const source = memory()
    const repository = new Repository()
    await run(repository, source)
    const first = [...repository.events.values()][0]!
    const second = cloneEvent(first, {
      eventId: MemoryEventIdSchema.parse('event:audit-second'),
      sequence: first.sequence + 1,
    })
    const cursor = first.eventId
    const readers: V1MigrationAuditReader[] = [
      {
        async export() {
          return { outcome: 'page', events: [], nextAfterEventId: cursor }
        },
      },
      {
        async export() {
          return {
            outcome: 'page',
            events: [first],
            nextAfterEventId: second.eventId,
          }
        },
      },
      {
        async export(request) {
          return request.afterEventId
            ? { outcome: 'page', events: [second], nextAfterEventId: cursor }
            : { outcome: 'page', events: [first], nextAfterEventId: cursor }
        },
      },
      {
        async export(request) {
          return request.afterEventId
            ? { outcome: 'page', events: [first], nextAfterEventId: null }
            : { outcome: 'page', events: [first], nextAfterEventId: cursor }
        },
      },
    ]
    for (const reader of readers) {
      expect(await audit(reader, source)).toMatchObject({
        outcome: 'failed',
        reason: 'pagination-invalid',
      })
    }
  })

  test('fails rather than certifying a scan with a tenth continuation page', async () => {
    const source = memory()
    const repository = new Repository()
    await run(repository, source)
    const template = [...repository.events.values()][0]!
    let page = 0
    const reader: V1MigrationAuditReader = {
      async export() {
        const event = cloneEvent(template, {
          eventId: MemoryEventIdSchema.parse(`event:audit-page-${page}`),
          sequence: page + 1,
        })
        page++
        return {
          outcome: 'page',
          events: [event],
          nextAfterEventId: event.eventId,
        }
      },
    }

    expect(await audit(reader, source)).toMatchObject({
      outcome: 'failed',
      reason: 'page-limit-exceeded',
    })
    expect(page).toBe(10)
  })

  test('allows a full final page to be followed by an empty terminal page', async () => {
    const source = memory()
    const repository = new Repository()
    expect((await run(repository, source)).outcome).toBe('imported')
    const canonical = [...repository.events.values()]
    const template = canonical.find(
      (event) => event.eventType === 'task.created',
    )!
    const padding = Array.from(
      { length: 1_000 - canonical.length },
      (_, index) =>
        cloneEvent(template, {
          eventId: MemoryEventIdSchema.parse(`event:audit-padding-${index}`),
          sequence: canonical.length + index + 1,
          sessionId: MemorySessionIdSchema.parse(
            `session:audit-padding-${index}`,
          ),
          payload: {
            ...template.payload,
            taskId: TaskIdSchema.parse(`task:audit-padding-${index}`),
          },
        }),
    )
    const events = [...canonical, ...padding]
    let calls = 0
    const reader: V1MigrationAuditReader = {
      async export(request) {
        calls++
        return request.afterEventId
          ? { outcome: 'page', events: [], nextAfterEventId: null }
          : {
              outcome: 'page',
              events,
              nextAfterEventId: events.at(-1)!.eventId,
            }
      },
    }

    expect(await audit(reader, source)).toMatchObject({ outcome: 'exact' })
    expect(calls).toBe(2)
  })

  test('migrates V1 blockers as warning and decisions as discovery to preserve audit exactness', async () => {
    const repository = new Repository()
    const source = memory()
    expect((await run(repository, source)).outcome).toBe('imported')
    const byCategory = new Map<string, string>()
    for (const event of repository.events.values()) {
      if (event.eventType !== 'observation.recorded') continue
      byCategory.set(
        String(event.payload.observation.provenance?.metadata.category),
        String(event.payload.observation.kind),
      )
    }
    expect(byCategory.get('decisions')).toBe('discovery')
    expect(byCategory.get('blockers')).toBe('warning')
    expect(byCategory.get('requirements')).toBe('discovery')
    expect(await audit(repository, source)).toMatchObject({ outcome: 'exact' })
  })

  test('blockers compatibility window certifies legacy discovery imports as exact', async () => {
    const repository = new Repository()
    const source = memory()
    expect((await run(repository, source)).outcome).toBe('imported')
    for (const event of repository.events.values()) {
      if (
        event.eventType !== 'observation.recorded' ||
        event.payload.observation.provenance?.metadata.category !== 'blockers'
      )
        continue
      repository.events.set(
        event.eventId,
        MemoryEventEnvelopeSchema.parse({
          ...event,
          payload: {
            ...event.payload,
            observation: { ...event.payload.observation, kind: 'discovery' },
          },
        }),
      )
    }
    expect(await audit(repository, source)).toMatchObject({ outcome: 'exact' })
    expect((await run(repository, source)).outcome).toBe('no-op')
  })
})
