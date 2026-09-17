import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MemoryAppendRequestSchema,
  MemoryEventDraftSchema,
  MemoryRetrievalRequestSchema,
  MemoryVerifyRequestSchema,
  ObservationIdSchema,
  type MemoryEventDraft,
} from '../../../../../common/src/types/memory-v2'

import { BunSQLiteMemoryRepository } from '../bun-sqlite-memory-repository'

const repositories: BunSQLiteMemoryRepository[] = []

function temporaryRepository(): string {
  return mkdtempSync(join(tmpdir(), 'openbuff-memory-v2-'))
}

function canonicalDraft(
  eventType: string,
  eventId: string,
  payload: unknown,
  sessionId = 'session-1',
  projectId = 'project-1',
): MemoryEventDraft {
  return MemoryEventDraftSchema.parse({
    schemaVersion: 2,
    eventSchemaVersion: 1,
    eventType,
    eventId,
    projectId,
    sessionId,
    occurredAt: '2025-01-02T03:04:05.000Z',
    payload,
  })
}

const FRESH_DIGEST =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const STALE_DIGEST =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function evidenceFixture(
  path = 'src/example.ts',
  digest = FRESH_DIGEST,
) {
  return {
    artifact: {
      artifactId: `artifact-${path}`,
      location: path,
      classification: {
        kind: 'source' as const,
        generated: false,
        sensitivity: 'internal' as const,
        labels: [],
      },
    },
    selector: { kind: 'file' as const, path },
    provenance: {
      origin: 'repository' as const,
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {},
    },
    capturedAt: '2025-01-02T03:04:05.000Z',
    contentDigest: digest,
    excerpt: 'deterministic evidence',
  }
}

function observationFixture(
  observationId: string,
  evidence: any[] = [evidenceFixture()],
) {
  return {
    observationId,
    taskId: 'task-1',
    kind: 'discovery' as const,
    summary: `Discovery ${observationId}`,
    detail: 'A deterministic canonical observation.',
    confidence: 0.9,
    evidence,
    selectors: evidence.map(({ selector }) => selector),
    provenance: {
      origin: 'repository' as const,
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {},
    },
    tags: ['deterministic'],
    observedAt: '2025-01-02T03:04:05.000Z',
  }
}

async function open(root: string): Promise<BunSQLiteMemoryRepository> {
  const result = await BunSQLiteMemoryRepository.open({ repositoryRoot: root })
  if (result.status === 'error') throw new Error(result.error.message)
  repositories.push(result.repository)
  return result.repository
}

async function close(
  repository: BunSQLiteMemoryRepository,
): Promise<void> {
  const index = repositories.indexOf(repository)
  if (index >= 0) repositories.splice(index, 1)
  await repository.close()
}

afterEach(async () => {
  while (repositories.length > 0) await repositories.pop()?.close()
})

describe('two-session cold-start (P4)', () => {
  test('cold-reopened session reuses fresh verified knowledge without re-exploration', async () => {
    const root = temporaryRepository()
    const session1 = await open(root)
    const evidence = evidenceFixture('src/example.ts', FRESH_DIGEST)
    const observation = observationFixture('obs-cold-start', [evidence])
    const appended = await session1.append(
      MemoryAppendRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        events: [
          canonicalDraft('observation.recorded', 'obs-cold-recorded', {
            payloadSchemaVersion: 1,
            observation,
          }),
          canonicalDraft('evidence.verified', 'obs-cold-verified', {
            payloadSchemaVersion: 1,
            observationId: 'obs-cold-start',
            selector: evidence.selector,
            verifier: 'test',
            verifiedAt: '2025-01-02T03:05:05.000Z',
            observedDigest: FRESH_DIGEST,
          }),
        ],
      }),
    )
    expect(appended.outcome).toBe('appended')
    await close(session1)

    const session2 = await open(root)
    const queried = await session2.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'query:cold-fresh',
        projectId: 'project-1',
        sessionId: 'session-2',
        query: 'Discovery obs-cold-start',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 10,
      }),
    )
    expect(queried.outcome).toBe('result')
    if (queried.outcome !== 'result') return
    expect(queried.result.verifiedKnowledge.length).toBe(1)
    expect(queried.result.rereadRequired.length).toBe(0)
    expect(
      queried.result.verifiedKnowledge[0]?.observation.observationId,
    ).toBe(ObservationIdSchema.parse('obs-cold-start'))
  })

  test('mismatched digest is never silently reused as fresh (verified 0, reread 1)', async () => {
    const root = temporaryRepository()
    const repository = await open(root)
    const evidence = evidenceFixture('src/example.ts', FRESH_DIGEST)
    const observation = observationFixture('obs-stale', [evidence])
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [
              canonicalDraft('observation.recorded', 'obs-stale-recorded', {
                payloadSchemaVersion: 1,
                observation,
              }),
            ],
          }),
        )
      ).outcome,
    ).toBe('appended')

    const freshVerify = await repository.verify(
      MemoryVerifyRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        sessionId: 'session-1',
        action: {
          kind: 'verify',
          observationId: 'obs-stale',
          selector: evidence.selector,
          observedDigest: FRESH_DIGEST,
        },
      }),
    )
    expect(freshVerify.outcome).toBe('recorded')

    const freshQuery = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'query:stale-fresh',
        projectId: 'project-1',
        sessionId: 'session-1',
        query: 'Discovery obs-stale',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 10,
      }),
    )
    expect(freshQuery.outcome).toBe('result')
    if (freshQuery.outcome !== 'result') return
    expect(freshQuery.result.verifiedKnowledge.length).toBe(1)
    expect(freshQuery.result.rereadRequired.length).toBe(0)

    const staleVerify = await repository.verify(
      MemoryVerifyRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        sessionId: 'session-1',
        action: {
          kind: 'verify',
          observationId: 'obs-stale',
          selector: evidence.selector,
          observedDigest: STALE_DIGEST,
        },
      }),
    )
    expect(staleVerify.outcome).toBe('recorded')
    if (freshVerify.outcome === 'recorded' && staleVerify.outcome === 'recorded') {
      expect(staleVerify.event.eventId).not.toBe(freshVerify.event.eventId)
      const repeat = await repository.verify(
        MemoryVerifyRequestSchema.parse({
          schemaVersion: 2,
          projectId: 'project-1',
          sessionId: 'session-1',
          action: {
            kind: 'verify',
            observationId: 'obs-stale',
            selector: evidence.selector,
            observedDigest: STALE_DIGEST,
          },
        }),
      )
      expect(repeat.outcome).toBe('recorded')
      if (repeat.outcome === 'recorded') {
        expect(repeat.event.eventId).toBe(staleVerify.event.eventId)
      }
    }

    const staleQuery = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'query:stale-after-mismatch',
        projectId: 'project-1',
        sessionId: 'session-1',
        query: 'Discovery obs-stale',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 10,
      }),
    )
    expect(staleQuery.outcome).toBe('result')
    if (staleQuery.outcome !== 'result') return
    expect(staleQuery.result.verifiedKnowledge).toEqual([])
    expect(staleQuery.result.rereadRequired.length).toBe(1)
    expect(staleQuery.result.rereadRequired[0]?.observationId).toBe(
      ObservationIdSchema.parse('obs-stale'),
    )
  })

  test('forgotten claim suppresses retrieval but preserves historical context (no physical delete)', async () => {
    const root = temporaryRepository()
    const repository = await open(root)
    const evidence = evidenceFixture('src/example.ts', FRESH_DIGEST)
    const observation = observationFixture('obs-forgotten', [evidence])
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [
              canonicalDraft('observation.recorded', 'obs-forgotten-recorded', {
                payloadSchemaVersion: 1,
                observation,
              }),
              canonicalDraft('evidence.verified', 'obs-forgotten-verified', {
                payloadSchemaVersion: 1,
                observationId: 'obs-forgotten',
                selector: evidence.selector,
                verifier: 'test',
                verifiedAt: '2025-01-02T03:05:05.000Z',
                observedDigest: FRESH_DIGEST,
              }),
            ],
          }),
        )
      ).outcome,
    ).toBe('appended')

    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [
              canonicalDraft('claim.forgotten', 'obs-forgotten-forgotten', {
                payloadSchemaVersion: 1,
                observationIds: ['obs-forgotten'],
                reason: 'duplicate',
                requestedBy: 'test',
                evidenceDisposition: 'retain-artifacts',
              }),
            ],
          }),
        )
      ).outcome,
    ).toBe('appended')

    const suppressed = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'query:forgotten-suppressed',
        projectId: 'project-1',
        sessionId: 'session-1',
        query: 'Discovery obs-forgotten',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 10,
      }),
    )
    expect(suppressed.outcome).toBe('result')
    if (suppressed.outcome !== 'result') return
    expect(suppressed.result.verifiedKnowledge).toEqual([])
    expect(suppressed.result.reusableDiscovery).toEqual([])
    expect(suppressed.result.historicalContext).toEqual([])

    const historical = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'query:forgotten-historical',
        projectId: 'project-1',
        sessionId: 'session-1',
        query: 'Discovery obs-forgotten',
        selectors: [],
        artifactKinds: [],
        includeHistorical: true,
        maxResultsPerCategory: 10,
      }),
    )
    expect(historical.outcome).toBe('result')
    if (historical.outcome !== 'result') return
    expect(historical.result.verifiedKnowledge).toEqual([])
    expect(historical.result.reusableDiscovery).toEqual([])
    expect(historical.result.historicalContext.length).toBe(1)
    expect(historical.result.historicalContext[0]?.summary).toContain(
      'Discovery obs-forgotten',
    )

    const listed = await repository.listEvents()
    expect(listed.status).toBe('ok')
    if (listed.status !== 'ok') return
    expect(listed.events.map(({ eventId }) => eventId)).toEqual([
      'obs-forgotten-recorded',
      'obs-forgotten-verified',
      'obs-forgotten-forgotten',
    ])
  })
})
