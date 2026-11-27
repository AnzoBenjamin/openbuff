import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MemoryAppendRequestSchema,
  MemoryEventDraftSchema,
  MemoryObservationSchema,
  MemoryRetrievalRequestSchema,
  type ArtifactClassification,
  type MemoryEventDraft,
  type MemoryObservation,
  type MemoryRetrievalResult,
} from '../../../../../common/src/types/memory-v2'
import { getExactContentHash } from '../../../../../common/src/util/content-hash'
import { memorySelectorKey } from '../../../../../common/src/util/memory-selector-key'
import { BunSQLiteMemoryRepository } from '../bun-sqlite-memory-repository'

const AT = '2026-11-01T00:00:00.000Z'
const PROJECT = 'project-b12-explicit-knowledge'
const SOURCE = 'export const memoryRouting = true\n'
const KINDS = ['fact', 'decision', 'constraint'] as const
const TEXT = {
  fact: {
    summary: 'Memory routing uses repository-local SQLite storage.',
    rationale: 'Repository-local storage keeps remembered knowledge project-scoped.',
  },
  decision: {
    summary: 'Persist memory routing decisions in SQLite rather than an event-tail cache.',
    rationale: 'A bounded event tail can lose an older applicable decision.',
  },
  constraint: {
    summary: 'Memory routing must keep remembered knowledge separate from edit authority.',
    rationale: 'Remembered claims do not replace supporting-selector verification.',
  },
}
const roots: string[] = []
const repositories: BunSQLiteMemoryRepository[] = []

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openbuff-b12-explicit-knowledge-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/memory-routing.ts'), SOURCE)
  const opened = await BunSQLiteMemoryRepository.open({ repositoryRoot: root })
  if (opened.status !== 'ok') throw new Error(opened.error.message)
  repositories.push(opened.repository)
  expect(opened.repository.databasePath).toBe(
    join(root, '.openbuff', 'memory', 'memory-v2.sqlite'),
  )
  return opened.repository
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) await repository.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function event(type: string, id: string, payload: unknown): MemoryEventDraft {
  return MemoryEventDraftSchema.parse({
    schemaVersion: 2,
    eventSchemaVersion: 1,
    eventType: type,
    eventId: id,
    projectId: PROJECT,
    sessionId: 'session-original',
    occurredAt: AT,
    payload,
  })
}

function observation(
  id: string,
  kind: MemoryObservation['kind'],
  options: {
    summary?: string
    detail?: string
    taskId?: string
    path?: string
    artifactKind?: ArtifactClassification['kind']
  } = {},
): MemoryObservation {
  const path = options.path ?? 'src/memory-routing.ts'
  const selector = { kind: 'file', path }
  const text =
    kind === 'fact' || kind === 'decision' || kind === 'constraint'
      ? TEXT[kind]
      : {
          summary: `Memory routing ${kind} record.`,
          rationale: 'Retain supporting evidence.',
        }
  const provenance = {
    origin: 'tool',
    recordedBy: 'b12-sqlite-test',
    toolName: 'record_decision',
    sourceEventIds: [],
    metadata: {},
  }
  return MemoryObservationSchema.parse({
    observationId: id,
    taskId: options.taskId ?? 'task-original',
    kind,
    summary: options.summary ?? text.summary,
    detail: options.detail ?? `Detail for ${id}.\nRationale: ${text.rationale}`,
    confidence: 0.95,
    tags: [],
    observedAt: AT,
    selectors: [selector],
    provenance,
    evidence: [
      {
        selector,
        artifact: {
          artifactId: `artifact-${id}`,
          location: path,
          classification: {
            kind: options.artifactKind ?? 'source',
            generated: false,
            sensitivity: 'internal',
            labels: [],
          },
        },
        provenance,
        capturedAt: AT,
        contentDigest: getExactContentHash(SOURCE),
      },
    ],
  })
}

function recorded(obs: MemoryObservation) {
  return event('observation.recorded', `event-record-${obs.observationId}`, {
    payloadSchemaVersion: 1,
    observation: obs,
  })
}

function pinned(obs: MemoryObservation) {
  return event('claim.pinned', `event-pin-${obs.observationId}`, {
    payloadSchemaVersion: 1,
    observationId: obs.observationId,
    reason: 'Keep applicable knowledge available.',
    pinnedBy: 'operator',
    pinnedAt: AT,
  })
}

async function append(
  repository: BunSQLiteMemoryRepository,
  events: MemoryEventDraft[],
) {
  const outcome = await repository.append(
    MemoryAppendRequestSchema.parse({
      schemaVersion: 2,
      projectId: PROJECT,
      events,
    }),
  )
  expect(outcome.outcome).toBe('appended')
  if (outcome.outcome !== 'appended') throw new Error(outcome.error.message)
}

function request(queryId: string, extra: Record<string, unknown> = {}) {
  return MemoryRetrievalRequestSchema.parse({
    schemaVersion: 2,
    queryId,
    projectId: PROJECT,
    sessionId: 'session-next',
    query: 'memory routing',
    selectors: [],
    artifactKinds: [],
    includeHistorical: false,
    maxResultsPerCategory: 10,
    ...extra,
  })
}

async function query(
  repository: BunSQLiteMemoryRepository,
  queryId: string,
  extra: Record<string, unknown> = {},
) {
  const outcome = await repository.query(request(queryId, extra))
  expect(outcome.outcome).toBe('result')
  if (outcome.outcome !== 'result') throw new Error(outcome.error.message)
  return outcome.result
}

function reusableIds(result: MemoryRetrievalResult) {
  return result.reusableDiscovery
    .map(({ observation }) => observation.observationId)
    .sort()
}

function expectUnverified(result: MemoryRetrievalResult, obs: MemoryObservation) {
  expect(result.verifiedKnowledge).toEqual([])
  expect(result.reusableDiscovery).toHaveLength(1)
  const entry = result.reusableDiscovery[0]!
  expect(entry.observation).toEqual(obs)
  expect(entry.reuseGuidance.toLowerCase()).toContain(`unverified ${obs.kind}`)
  expect(entry.reuseGuidance.toLowerCase()).toContain(
    'verify supporting selectors before reuse',
  )
  expect(entry.reuseGuidance).not.toContain('discovery')
  expect(
    entry.reasons.some(({ code }) => code === 'verified-evidence'),
  ).toBe(false)
  expect(entry).not.toHaveProperty('verifiedAt')
  expect(entry).not.toHaveProperty('verifiedEvidence')
  return entry
}

describe('B12 explicit knowledge lexical reuse (SQLite unit boundary)', () => {
  test.each(KINDS)('%s retains its own summary, detail and rationale without inventing verification', async (kind) => {
    const repository = await fixture()
    const obs = observation(`observation-${kind}`, kind)
    await append(repository, [recorded(obs)])
    const selector = obs.selectors![0]!
    for (const [id, applicability] of [
      ['lexical', { query: 'memory routing', selectors: [] }],
      ['selector', { query: 'quasarxylophone', selectors: [selector] }],
    ] as const) {
      const result = await query(repository, `query-${kind}-${id}`, {
        ...applicability,
        workspaceRevision: 3,
        workspaceSnapshotId: 'workspace-next',
        dependencyDigests: {
          [memorySelectorKey(selector)]: obs.evidence[0]!.contentDigest!,
        },
      })
      const entry = expectUnverified(result, obs)
      expect(entry.observation.summary).toBe(TEXT[kind].summary)
      expect(entry.observation.detail).toContain(TEXT[kind].rationale)
      expect(result.rereadRequired).toHaveLength(1)
      expect(result.rereadRequired[0]).toMatchObject({
        observationId: obs.observationId,
        selector,
        reason: 'never-verified',
      })
      expect(result.historicalContext).toEqual([])
    }
    await append(repository, [pinned(obs)])
    const pinnedEntry = expectUnverified(
      await query(repository, `query-${kind}-pinned`),
      obs,
    )
    expect(pinnedEntry.reuseGuidance).toContain('Pinned')
    const events = await repository.listEvents()
    expect(events.status).toBe('ok')
    if (events.status !== 'ok') throw new Error(events.error.message)
    expect(events.events.map(({ eventType }) => eventType)).toEqual([
      'observation.recorded',
      'claim.pinned',
    ])
  })

  test('preserves query, project, task and artifact applicability for explicit knowledge', async () => {
    const repository = await fixture()
    const fact = observation('fact-source', 'fact', { taskId: 'task-fact' })
    const decision = observation('decision-config', 'decision', {
      taskId: 'task-decision',
      artifactKind: 'configuration',
    })
    const constraint = observation('constraint-test', 'constraint', {
      taskId: 'task-constraint',
      artifactKind: 'test',
    })
    const unrelated = observation('unrelated-fact', 'fact', {
      summary: 'Orchid irrigation schedule.',
      detail: 'Water seedlings overnight.',
      path: 'garden/seedlings.plan',
    })
    await append(
      repository,
      [fact, decision, constraint, unrelated].map(recorded),
    )
    const applicable = await query(repository, 'query-applicable')
    expect(reusableIds(applicable)).toEqual(
      [constraint.observationId, decision.observationId, fact.observationId].sort(),
    )
    expect(applicable.verifiedKnowledge).toEqual([])
    expect(
      reusableIds(await query(repository, 'query-task', { taskId: 'task-constraint' })),
    ).toEqual([constraint.observationId])
    expect(
      reusableIds(await query(repository, 'query-artifact', { artifactKinds: ['source'] })),
    ).toEqual([fact.observationId])
    const noMatch = await query(repository, 'query-unrelated', { query: 'quasarxylophone' })
    expect(noMatch.reusableDiscovery).toEqual([])
    expect(noMatch.verifiedKnowledge).toEqual([])
    expect(noMatch.rereadRequired).toEqual([])
    const foreign = await repository.query(
      request('query-foreign', { projectId: 'project-unrelated' }),
    )
    expect(foreign.outcome).toBe('rejected')
  })

  test.each(KINDS)('%s forgotten, superseded and corrected records remain historical only, even when pinned', async (kind) => {
    const repository = await fixture()
    const retracted = ['forgotten', 'superseded', 'corrected'].map((status) =>
      observation(`${status}-${kind}`, kind, {
        summary: `${TEXT[kind].summary} (${status})`,
      }),
    )
    const [forgotten, superseded, corrected] = retracted
    const replacement = observation(`replacement-${kind}`, kind)
    const correction = observation(`correction-${kind}`, kind)
    await append(repository, [
      ...[...retracted, replacement].map(recorded),
      event('claim.forgotten', 'event-forget', {
        payloadSchemaVersion: 1,
        observationIds: [forgotten!.observationId],
        reason: 'user-request',
        requestedBy: 'operator',
        evidenceDisposition: 'retain-artifacts',
      }),
      event('claim.superseded', 'event-supersede', {
        payloadSchemaVersion: 1,
        observationId: superseded!.observationId,
        supersededByObservationId: replacement.observationId,
        reason: 'A newer applicable claim replaces the old one.',
      }),
      event('claim.corrected', 'event-correct', {
        payloadSchemaVersion: 1,
        observationId: corrected!.observationId,
        correction,
        reason: 'Correct the original claim.',
      }),
      ...retracted.map(pinned),
    ])
    for (const includeHistorical of [false, true]) {
      const result = await query(
        repository,
        `query-${kind}-history-${includeHistorical}`,
        { includeHistorical },
      )
      const activeIds = [replacement.observationId, correction.observationId].sort()
      expect(reusableIds(result)).toEqual(activeIds)
      expect(result.verifiedKnowledge).toEqual([])
      expect(
        result.rereadRequired.map(({ observationId }) => observationId).sort(),
      ).toEqual(activeIds)
      expect(
        result.historicalContext.map(({ summary }) => summary).sort(),
      ).toEqual(
        includeHistorical ? retracted.map(({ summary }) => summary).sort() : [],
      )
    }
  })

  test.each(['outcome', 'warning'] as const)('%s does not enter lexical reuse, while discovery keeps its existing guidance', async (kind) => {
    const repository = await fixture()
    const excluded = observation(`excluded-${kind}`, kind)
    const discovery = observation('active-discovery', 'discovery')
    await append(repository, [
      recorded(excluded),
      pinned(excluded),
      recorded(discovery),
    ])
    const result = await query(repository, `query-exclude-${kind}`)
    expect(reusableIds(result)).toEqual([discovery.observationId])
    expect(result.reusableDiscovery[0]!.reuseGuidance).toBe(
      'Verify selectors before reusing this discovery.',
    )
    expect(
      result.rereadRequired.map(({ observationId }) => observationId),
    ).toContain(excluded.observationId)
    expect(result.verifiedKnowledge).toEqual([])
  })

  test.each(KINDS)('%s invalidated evidence retains text but still requires a changed-selector reread', async (kind) => {
    const repository = await fixture()
    const obs = observation(`stale-${kind}`, kind)
    const evidence = obs.evidence[0]!
    await append(repository, [
      recorded(obs),
      event('evidence.verified', 'event-verified', {
        payloadSchemaVersion: 1,
        observationId: obs.observationId,
        selector: evidence.selector,
        observedDigest: evidence.contentDigest,
        verifier: 'exact-read-fixture',
        verifiedAt: AT,
      }),
      event('evidence.invalidated', 'event-invalidated', {
        payloadSchemaVersion: 1,
        observationId: obs.observationId,
        selector: evidence.selector,
        reason: 'changed',
        detail: 'The supporting source changed.',
        invalidatedAt: '2026-11-01T00:00:01.000Z',
      }),
    ])
    const result = await query(repository, `query-stale-${kind}`)
    expectUnverified(result, obs)
    expect(result.rereadRequired).toHaveLength(1)
    expect(result.rereadRequired[0]).toMatchObject({
      observationId: obs.observationId,
      reason: 'changed',
    })
    expect(result.rereadRequired[0]!.detail).toContain(
      'invalidated; reread before use',
    )
  })

  test('category clipping keeps the existing ranked prefix, scores and cap degradation', async () => {
    const repository = await fixture()
    const strongDecision = observation('strong-decision', 'decision', {
      summary: 'Routing topology follows the request frontier.',
      detail: 'Routing topology explanation.',
    })
    const others = (['fact', 'constraint', 'discovery'] as const).map((kind) =>
      observation(`weak-${kind}`, kind, {
        summary: 'Routing color palette.',
        detail: 'Routing description.',
      }),
    )
    await append(repository, [strongDecision, ...others].map(recorded))
    const full = await query(repository, 'query-ranked-full', {
      query: 'routing topology',
    })
    expect(full.reusableDiscovery).toHaveLength(4)
    expect(full.reusableDiscovery[0]!.observation.observationId).toBe(
      strongDecision.observationId,
    )
    expect(full.degradation.state).toBe('none')
    const clipped = await query(repository, 'query-ranked-clipped', {
      query: 'routing topology',
      maxResultsPerCategory: 1,
    })
    expect(clipped.reusableDiscovery).toEqual(full.reusableDiscovery.slice(0, 1))
    expect(clipped.rereadRequired).toEqual(full.rereadRequired.slice(0, 1))
    expect(clipped.verifiedKnowledge).toEqual([])
    expect(clipped.degradation).toMatchObject({
      state: 'degraded',
      reasons: [{ code: 'result-cap-reached' }],
    })
    for (const entry of full.reusableDiscovery) {
      expect(entry.score).toBeGreaterThanOrEqual(0)
      expect(entry.score).toBeLessThanOrEqual(1)
      expect(entry.reasons.length).toBeLessThanOrEqual(16)
    }
  })
})
