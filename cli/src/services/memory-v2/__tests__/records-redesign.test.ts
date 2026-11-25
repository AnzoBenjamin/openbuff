import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryAppendRequestSchema,
  MemoryEventDraftSchema,
  MemoryRetrievalRequestSchema,
  ProjectIdSchema,
  type MemoryEventDraft,
  type MemoryObservation,
  type MemorySelector,
} from '../../../../../common/src/types/memory-v2'
import type { ContextArchiveSnapshot } from '../../../../../common/src/types/context-archive'
import type { ToolMessage } from '../../../../../common/src/types/messages/codebuff-message'
import { getExactContentHash } from '../../../../../common/src/util/content-hash'
import { memorySelectorKey } from '../../../../../common/src/util/memory-selector-key'
import {
  computeTriggerSignature,
  type PlaybookTrigger,
} from '../../../../../common/src/types/memory-playbook'
import {
  BunSQLiteMemoryRepository,
  type BunSQLiteMemoryRepositoryOptions,
} from '../bun-sqlite-memory-repository'
import {
  collectArchiveOrphans,
  migrateArchivePage,
} from '../context-archive-store'
import {
  expandConceptRecall,
  openConceptDatabase,
  type ConceptEmbedFn,
} from '../concept-index'
import { knowledgeQueryPlan, readKnowledgeQuery } from '../knowledge-query'

const roots: string[] = []
const repositories: BunSQLiteMemoryRepository[] = []
const AT = '2026-11-01T00:00:00.000Z'

async function fixture(
  options: Omit<BunSQLiteMemoryRepositoryOptions, 'repositoryRoot'> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'openbuff-record-redesign-'))
  roots.push(root)
  const opened = await BunSQLiteMemoryRepository.open({
    repositoryRoot: root,
    ...options,
  })
  if (opened.status !== 'ok') throw new Error(opened.error.kind)
  repositories.push(opened.repository)
  return { root, repository: opened.repository }
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) await repository.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function event(
  type: string,
  id: string,
  payload: unknown,
  task = 'session-original',
): MemoryEventDraft {
  return MemoryEventDraftSchema.parse({
    schemaVersion: 2,
    eventSchemaVersion: 1,
    eventType: type,
    eventId: id,
    projectId: 'project-records',
    sessionId: task,
    occurredAt: AT,
    payload,
  })
}

function observation(
  id: string,
  options: {
    task?: string
    digest?: string
    selector?: MemorySelector
    tool?: string
    summary?: string
  } = {},
): MemoryObservation {
  const selector = options.selector ?? { kind: 'file', path: 'src/feature.ts' }
  return {
    observationId: id as MemoryObservation['observationId'],
    taskId: (options.task ?? 'task-original') as MemoryObservation['taskId'],
    kind: 'discovery',
    summary: options.summary ?? 'Durable feature routing architecture',
    detail:
      'Requests pass through feature routing into the repository service.',
    confidence: 0.95,
    tags: ['architecture'],
    observedAt: AT,
    selectors: [selector],
    provenance: {
      origin: 'repository',
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {},
    },
    evidence: [
      {
        selector,
        artifact: {
          artifactId: 'artifact-feature',
          location: 'src/feature.ts',
          classification: {
            kind: 'source',
            generated: false,
            sensitivity: 'internal',
            labels: options.tool ? ['workspace-state'] : [],
          },
        },
        provenance: {
          origin: 'repository',
          recordedBy: 'test',
          sourceEventIds: [],
          metadata: {},
          ...(options.tool ? { toolName: options.tool } : {}),
        },
        capturedAt: AT,
        contentDigest:
          options.digest ?? getExactContentHash('export const route = 1\n'),
      },
    ],
  }
}

async function append(
  repository: BunSQLiteMemoryRepository,
  events: MemoryEventDraft[],
) {
  const result = await repository.append(
    MemoryAppendRequestSchema.parse({
      schemaVersion: 2,
      projectId: 'project-records',
      events,
    }),
  )
  expect(result.outcome).toBe('appended')
  if (result.outcome !== 'appended') throw new Error(result.error.message)
}

function query(queryId: string, extra: Record<string, unknown> = {}) {
  return MemoryRetrievalRequestSchema.parse({
    schemaVersion: 2,
    queryId,
    projectId: 'project-records',
    sessionId: 'session-new',
    query: 'Durable feature routing architecture',
    selectors: [{ kind: 'file', path: 'src/feature.ts' }],
    artifactKinds: [],
    includeHistorical: false,
    maxResultsPerCategory: 10,
    ...extra,
  })
}

function verification(obs: MemoryObservation, id: string) {
  return event('evidence.verified', id, {
    payloadSchemaVersion: 1,
    observationId: obs.observationId,
    selector: obs.evidence[0]!.selector,
    observedDigest: obs.evidence[0]!.contentDigest,
    verifiedAt: AT,
    verifier: 'exact-read',
    workspaceRevision: 1,
    workspaceSnapshotId: 'workspace-one',
  })
}

test('old pinned verified knowledge survives both former admission limits, reopen and repair', async () => {
  const { root, repository } = await fixture()
  const obs = observation('observation-old-anchor')
  await append(repository, [
    event('observation.recorded', 'event-old-anchor', {
      payloadSchemaVersion: 1,
      observation: obs,
    }),
    event('claim.pinned', 'event-pin-anchor', {
      payloadSchemaVersion: 1,
      observationId: obs.observationId,
      reason: 'operator architecture anchor',
      pinnedBy: 'operator',
      pinnedAt: AT,
    }),
    verification(obs, 'event-verify-anchor'),
  ])
  const raw = new Database(repository.databasePath)
  try {
    const insert = raw.query(
      'INSERT INTO memory_events(event_id,idempotency_key,event_type,occurred_at,payload_json,metadata_json,task_id,session_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
    )
    const metadata = JSON.stringify({
      schemaVersion: 2,
      eventSchemaVersion: 1,
      projectId: 'project-records',
      sessionId: 'session-noise',
    })
    raw
      .transaction(() => {
        for (let i = 0; i < 10_050; i++) {
          const id = `task-noise-${i}`
          insert.run(
            `event-noise-${i}`,
            `key-noise-${i}`,
            'task.created',
            AT,
            JSON.stringify({
              payloadSchemaVersion: 1,
              taskId: id,
              title: 'Unrelated activity',
              objective: 'irrelevant '.repeat(110),
              initialStatus: 'created',
            }),
            metadata,
            id,
            'session-noise',
          )
        }
      })
      .immediate()
    const counts = raw
      .query(
        'SELECT count(*) AS events,sum(length(CAST(payload_json AS BLOB))+length(CAST(metadata_json AS BLOB))) AS bytes FROM memory_events',
      )
      .get() as { events: number; bytes: number }
    expect(counts.events).toBeGreaterThan(10_000)
    expect(counts.bytes).toBeGreaterThan(8 * 1024 * 1024)
  } finally {
    raw.close()
  }
  const check = async (repo: BunSQLiteMemoryRepository, id: string) => {
    const result = await repo.query(
      query(id, { workspaceRevision: 1, workspaceSnapshotId: 'workspace-one' }),
    )
    expect(result.outcome).toBe('result')
    if (result.outcome !== 'result') throw new Error('Projection query failed')
    expect(
      result.result.verifiedKnowledge.map((k) => k.observation.observationId),
    ).toEqual([obs.observationId])
    expect(result.result.reusableDiscovery[0]?.reuseGuidance).toContain(
      'Pinned',
    )
    expect(result.result.degradation.state).toBe('none')
  }
  await check(repository, 'query-before-reopen')
  await repository.close()
  const reopened = await BunSQLiteMemoryRepository.open({
    repositoryRoot: root,
  })
  if (reopened.status !== 'ok') throw new Error(reopened.error.kind)
  repositories.push(reopened.repository)
  await check(reopened.repository, 'query-after-reopen')
  const rebuilt = await reopened.repository.rebuildProjections()
  expect(rebuilt.status).toBe('ok')
  await check(reopened.repository, 'query-after-resumable-repair')
}, 20_000)

test('current dependency hashes preserve unrelated-workspace reuse and invalidate a relevant change', async () => {
  const { root, repository } = await fixture()
  mkdirSync(join(root, 'src'))
  const original = 'export const route = 1\n'
  writeFileSync(join(root, 'src/feature.ts'), original)
  const obs = observation('observation-digest', {
    digest: getExactContentHash(original),
  })
  await append(repository, [
    event('observation.recorded', 'event-digest', {
      payloadSchemaVersion: 1,
      observation: obs,
    }),
    verification(obs, 'event-digest-verified'),
  ])
  writeFileSync(
    join(root, 'src/unrelated.ts'),
    'export const unrelated = true\n',
  )
  const current = () =>
    getExactContentHash(readFileSync(join(root, 'src/feature.ts'), 'utf8'))
  const result = await repository.query(
    query('query-unrelated', {
      workspaceRevision: 2,
      workspaceSnapshotId: 'workspace-two',
      dependencyDigests: { 'src/feature.ts': current() },
    }),
  )
  expect(
    result.outcome === 'result' ? result.result.verifiedKnowledge.length : 0,
  ).toBe(1)
  expect(
    result.outcome === 'result' ? result.result.rereadRequired : [],
  ).toEqual([])
  writeFileSync(join(root, 'src/feature.ts'), 'export const route = 2\n')
  const changed = await repository.query(
    query('query-relevant', {
      workspaceRevision: 3,
      workspaceSnapshotId: 'workspace-three',
      dependencyDigests: { 'src/feature.ts': current() },
    }),
  )
  expect(
    changed.outcome === 'result' ? changed.result.verifiedKnowledge : [],
  ).toEqual([])
  expect(
    changed.outcome === 'result'
      ? changed.result.rereadRequired[0]?.reason
      : '',
  ).toBe('changed')
})

test('operational workspace assertions remain bound to the producing workspace', async () => {
  const { repository } = await fixture()
  const obs = observation('observation-clean-worktree', { tool: 'git_status' })
  await append(repository, [
    event('observation.recorded', 'event-clean', {
      payloadSchemaVersion: 1,
      observation: obs,
    }),
    verification(obs, 'event-clean-verified'),
  ])
  const changed = await repository.query(
    query('query-operational', {
      workspaceRevision: 2,
      workspaceSnapshotId: 'workspace-two',
      dependencyDigests: { 'src/feature.ts': obs.evidence[0]!.contentDigest! },
    }),
  )
  expect(
    changed.outcome === 'result' ? changed.result.verifiedKnowledge : [],
  ).toEqual([])
  expect(
    changed.outcome === 'result' ? changed.result.rereadRequired.length : 0,
  ).toBe(1)
})

test('late reinforcement, supersession and forgetting are reflected independently of log admission', async () => {
  const { repository } = await fixture()
  const a = observation('observation-first'),
    b = observation('observation-second', {
      summary: 'Replacement durable feature routing architecture',
    })
  await append(repository, [
    event('observation.recorded', 'event-first', {
      payloadSchemaVersion: 1,
      observation: a,
    }),
    event('observation.recorded', 'event-second', {
      payloadSchemaVersion: 1,
      observation: b,
    }),
    event('claim.reinforced', 'event-first-reinforced', {
      payloadSchemaVersion: 1,
      observationId: a.observationId,
      claimId: 'a'.repeat(64),
      reason: 'corroboration',
      reinforcedAt: AT,
    }),
    event('claim.superseded', 'event-first-superseded', {
      payloadSchemaVersion: 1,
      observationId: a.observationId,
      supersededByObservationId: b.observationId,
      reason: 'new evidence',
    }),
    event('claim.pinned', 'event-second-pinned', {
      payloadSchemaVersion: 1,
      observationId: b.observationId,
      reason: 'operator pin',
      pinnedBy: 'operator',
      pinnedAt: AT,
    }),
    event('claim.forgotten', 'event-second-forgotten', {
      payloadSchemaVersion: 1,
      observationIds: [b.observationId],
      reason: 'user-request',
      requestedBy: 'operator',
      evidenceDisposition: 'retain-artifacts',
    }),
  ])
  const current = await repository.query(query('query-retractions'))
  expect(
    current.outcome === 'result' ? current.result.reusableDiscovery : [],
  ).toEqual([])
  expect(
    current.outcome === 'result' ? current.result.rereadRequired : [],
  ).toEqual([])
  const historical = await repository.query(
    query('query-history', { includeHistorical: true }),
  )
  expect(
    historical.outcome === 'result'
      ? historical.result.historicalContext.length
      : 0,
  ).toBe(2)
  await append(repository, [
    event('claim.pinned', 'event-forgotten-pinned-again', {
      payloadSchemaVersion: 1,
      observationId: b.observationId,
      reason: 'later pin cannot undo forgetting',
      pinnedBy: 'operator',
      pinnedAt: AT,
    }),
  ])
  expect(
    await repository.getObservationStatus({
      projectId: ProjectIdSchema.parse('project-records'),
      observationIds: [a.observationId, b.observationId],
    }),
  ).toMatchObject({
    status: 'ok',
    entries: [
      { observationId: a.observationId, status: 'retracted' },
      { observationId: b.observationId, status: 'retracted' },
    ],
  })
  const repinned = await repository.query(query('query-forgotten-pin'))
  expect(
    repinned.outcome === 'result' ? repinned.result.reusableDiscovery : [],
  ).toEqual([])
})

test('exact cross-task consolidation preserves verification and usage while changed dependencies stay distinct', async () => {
  const { root, repository } = await fixture()
  const a = observation('observation-canonical', { task: 'task-one' }),
    b = observation('observation-duplicate', { task: 'task-two' }),
    c = observation('observation-different-dependency', {
      task: 'task-three',
      digest: getExactContentHash('different'),
    })
  await append(repository, [
    event('observation.recorded', 'event-canonical', {
      payloadSchemaVersion: 1,
      observation: a,
    }),
    event('observation.recorded', 'event-duplicate', {
      payloadSchemaVersion: 1,
      observation: b,
    }),
    event('observation.recorded', 'event-distinct', {
      payloadSchemaVersion: 1,
      observation: c,
    }),
    verification(b, 'event-duplicate-verified'),
    event('observation.reused', 'event-duplicate-used', {
      payloadSchemaVersion: 1,
      turnId: 'turn-used',
      used: [{ observationId: b.observationId, mechanism: 'cited' }],
      ignored: [],
    }),
  ])
  expect(
    await repository.consolidateExact({
      projectId: 'project-records',
      now: Date.parse(AT),
    }),
  ).toEqual({ status: 'ok', reinforced: 1, superseded: 1 })
  expect(
    await repository.consolidateExact({
      projectId: 'project-records',
      now: Date.parse(AT),
    }),
  ).toEqual({ status: 'ok', reinforced: 0, superseded: 0 })
  const result = await repository.query(
    query('query-consolidated', {
      workspaceRevision: 2,
      workspaceSnapshotId: 'workspace-two',
      dependencyDigests: { 'src/feature.ts': a.evidence[0]!.contentDigest! },
    }),
  )
  expect(
    result.outcome === 'result'
      ? result.result.verifiedKnowledge.map((k) => k.observation.observationId)
      : [],
  ).toEqual([a.observationId])
  expect(
    result.outcome === 'result'
      ? result.result.reusableDiscovery.map((k) => k.observation.observationId)
      : [],
  ).toEqual([a.observationId, c.observationId])
  const raw = new Database(repository.databasePath)
  try {
    const state = JSON.parse(
      (
        raw
          .query(
            'SELECT state_json FROM memory_knowledge WHERE observation_id=?1',
          )
          .get(a.observationId) as { state_json: string }
      ).state_json,
    )
    expect(state.used).toBe(1)
    expect(state.reinforced).toBe(1)
  } finally {
    raw.close()
  }
  expect(
    await repository.getUsage({
      projectId: 'project-records',
      observationIds: [a.observationId],
    }),
  ).toMatchObject({
    status: 'ok',
    usage: [
      {
        observationId: a.observationId,
        usedCount: 1,
        ignoredCount: 0,
        lastMechanism: 'cited',
        lastTurnId: 'turn-used',
      },
    ],
  })
  await repository.close()
  const reopened = await BunSQLiteMemoryRepository.open({
    repositoryRoot: root,
  })
  if (reopened.status !== 'ok') throw new Error(reopened.error.kind)
  repositories.push(reopened.repository)
  expect(
    await reopened.repository.consolidateExact({
      projectId: 'project-records',
    }),
  ).toEqual({ status: 'ok', reinforced: 0, superseded: 0 })
})

test('bounded exact maintenance skips pin-only groups and reaches unpinned sources beyond sixteen pins', async () => {
  const { repository } = await fixture()
  const pinnedOnly = Array.from({ length: 2 }, (_, index) =>
    observation(`observation-pin-only-${index}`, {
      task: `task-pin-only-${index}`,
      summary: 'Pinned-only routing facts',
    }),
  )
  const pinned = Array.from({ length: 17 }, (_, index) =>
    observation(`observation-pin-many-${index}`, {
      task: `task-pin-many-${index}`,
      summary: 'Pinned feature routing facts',
    }),
  )
  const duplicate = observation('observation-unpinned-after-many-pins', {
    task: 'task-unpinned-last',
    summary: 'Pinned feature routing facts',
  })
  await append(
    repository,
    [...pinnedOnly, ...pinned]
      .flatMap((observation) => [
        event('observation.recorded', `event-${observation.observationId}`, {
          payloadSchemaVersion: 1,
          observation,
        }),
        event('claim.pinned', `event-pin-${observation.observationId}`, {
          payloadSchemaVersion: 1,
          observationId: observation.observationId,
          reason: 'Operator pinned this source independently',
          pinnedBy: 'operator',
          pinnedAt: AT,
        }),
      ])
      .concat(
        event('observation.recorded', 'event-unpinned-after-many-pins', {
          payloadSchemaVersion: 1,
          observation: duplicate,
        }),
      ),
  )
  expect(
    await repository.consolidateExact({
      projectId: 'project-records',
      maxGroups: 1,
      now: Date.parse(AT),
    }),
  ).toEqual({ status: 'ok', reinforced: 1, superseded: 1 })
  expect(
    await repository.consolidateExact({
      projectId: 'project-records',
      maxGroups: 1,
      now: Date.parse(AT),
    }),
  ).toEqual({ status: 'ok', reinforced: 0, superseded: 0 })
  const status = await repository.getObservationStatus({
    projectId: ProjectIdSchema.parse('project-records'),
    observationIds: [...pinnedOnly, ...pinned, duplicate].map(
      (observation) => observation.observationId,
    ),
  })
  expect(status.status).toBe('ok')
  if (status.status !== 'ok')
    throw new Error('Exact maintenance status is unavailable')
  expect(
    status.entries.filter((entry) => entry.status === 'active'),
  ).toHaveLength(19)
  expect(
    status.entries.find(
      (entry) => entry.observationId === duplicate.observationId,
    )?.status,
  ).toBe('retracted')
})

function tool(id: string, text: string): ToolMessage {
  return {
    role: 'tool',
    toolName: 'read_files',
    toolCallId: id,
    content: [{ type: 'json', value: { text } }],
  }
}
function snapshot(
  at: number,
  messages: ToolMessage[],
  action: ContextArchiveSnapshot['action'] = 'semantic_compaction',
): ContextArchiveSnapshot {
  return {
    archivedAt: at,
    action,
    keepRecentSteps: 2,
    stepBase: 7,
    ...(action === 'tool_result_eviction'
      ? {
          steps: messages.map((_, index) => 10 + index),
          reason: 'evicted older tool bodies',
        }
      : {}),
    messages,
  }
}

describe('single-copy archive objects', () => {
  test('repeated snapshots grow by new content and references; reference-safe GC and FTS repair roundtrip', async () => {
    const { repository } = await fixture()
    const now = Date.now(),
      shared = tool(
        'call-shared',
        'shared architecture archive fact ' + 'payload '.repeat(300),
      ),
      fresh = tool('call-new', 'new archive feature detail')
    const a = snapshot(now - 1000, [shared]),
      b = snapshot(now, [shared, fresh], 'tool_result_eviction')
    expect(
      await repository.persistContextArchiveSnapshots({
        runId: 'run-one',
        snapshots: [a],
      }),
    ).toMatchObject({ persisted: 1, status: 'ok' })
    const raw = new Database(repository.databasePath)
    const metrics = () =>
      raw
        .query(
          'SELECT (SELECT count(*) FROM context_archive_bodies) AS bodies,(SELECT count(*) FROM context_archive_messages) AS messages,(SELECT count(*) FROM context_archive_memberships) AS refs,(SELECT sum(length(CAST(body AS BLOB))) FROM context_archive_bodies) AS bytes',
        )
        .get() as {
        bodies: number
        messages: number
        refs: number
        bytes: number
      }
    try {
      const before = metrics()
      expect(
        await repository.persistContextArchiveSnapshots({
          runId: 'run-one',
          snapshots: [a, b],
        }),
      ).toMatchObject({ persisted: 2, status: 'ok' })
      const after = metrics()
      expect(after.bodies).toBe(2)
      expect(after.messages).toBe(2)
      expect(after.refs).toBe(3)
      expect(after.bytes - before.bytes).toBeLessThan(200)
      await repository.persistContextArchiveSnapshots({
        runId: 'run-one',
        snapshots: [a, b],
      })
      expect(metrics()).toEqual(after)
      expect(
        raw
          .query(
            "SELECT name FROM sqlite_master WHERE name='context_archive_fts_content'",
          )
          .get(),
      ).toBeNull()
      const load = await repository.loadContextArchiveSnapshots({
        runId: 'run-one',
      })
      expect(load.status).toBe('ok')
      expect(
        load.snapshots.map(({ snapshotId, ...snapshot }) => snapshot),
      ).toEqual([
        { ...b, runId: 'run-one' },
        { ...a, runId: 'run-one' },
      ])
      const hit = await repository.searchContextArchive({
        query: 'new archive feature detail',
      })
      expect(hit.status).toBe('ok')
      expect(hit.matches[0]).toMatchObject({
        runId: 'run-one',
        archivedAt: now,
        step: 11,
        toolName: 'read_files',
        toolCallId: 'call-new',
      })
      await repository.persistContextArchiveSnapshots({
        runId: 'run-two',
        snapshots: [snapshot(now + 1, [shared])],
      })
      await repository.persistContextArchiveSnapshots({
        runId: 'run-one',
        snapshots: [snapshot(now + 2, [fresh])],
      })
      expect(metrics().bodies).toBe(2)
      expect(
        (
          await repository.searchContextArchive({
            query: 'shared architecture archive fact',
          })
        ).matches.some((hit) => hit.runId === 'run-two'),
      ).toBe(true)
      raw.exec(
        "INSERT INTO context_archive_fts(context_archive_fts) VALUES ('delete-all')",
      )
      expect(
        (
          await repository.searchContextArchive({
            query: 'shared architecture archive fact',
          })
        ).matches,
      ).toEqual([])
      expect(await repository.repairContextArchive()).toEqual({ status: 'ok' })
      expect(
        (
          await repository.searchContextArchive({
            query: 'shared architecture archive fact',
          })
        ).matches.some((hit) => hit.runId === 'run-two'),
      ).toBe(true)
    } finally {
      raw.close()
    }
  })

  test('TTL removes a snapshot but retains content referenced by a live snapshot', async () => {
    const { repository } = await fixture(),
      now = Date.now(),
      shared = tool('shared-call', 'retained shared archive evidence')
    await repository.persistContextArchiveSnapshots({
      runId: 'run-old',
      snapshots: [snapshot(now - 31 * 24 * 3600 * 1000, [shared])],
    })
    await repository.persistContextArchiveSnapshots({
      runId: 'run-live',
      snapshots: [snapshot(now, [shared])],
    })
    expect(
      (await repository.loadContextArchiveSnapshots({ runId: 'run-old' }))
        .snapshots,
    ).toEqual([])
    expect(
      (await repository.loadContextArchiveSnapshots({ runId: 'run-live' }))
        .snapshots[0]?.messages,
    ).toEqual([shared])
    expect(
      (
        await repository.searchContextArchive({
          query: 'retained shared archive evidence',
        })
      ).matches[0]?.runId,
    ).toBe('run-live')
  })

  test('same-run same-time actions and changed manifests retain separate immutable snapshots', async () => {
    const { root, repository } = await fixture(),
      now = Date.now()
    const first = snapshot(now, [
      tool('same-time-first', 'first archive compaction evidence'),
    ])
    const eviction = snapshot(
      now,
      [tool('same-time-eviction', 'eviction archive lineage evidence')],
      'tool_result_eviction',
    )
    const changed = snapshot(now, [
      tool('same-time-changed', 'changed compaction archive evidence'),
    ])
    const outcome = await repository.persistContextArchiveSnapshots({
      runId: 'run-colliding',
      snapshots: [first, eviction, changed],
    })
    expect(outcome).toMatchObject({ persisted: 3, status: 'ok' })
    const loaded = await repository.loadContextArchiveSnapshots({
      runId: 'run-colliding',
    })
    expect(loaded.status).toBe('ok')
    expect(loaded.snapshots).toHaveLength(3)
    expect(
      new Set(loaded.snapshots.map((snapshot) => snapshot.snapshotId)).size,
    ).toBe(3)
    expect(loaded.snapshots.flatMap((snapshot) => snapshot.messages)).toEqual(
      expect.arrayContaining([
        ...first.messages,
        ...eviction.messages,
        ...changed.messages,
      ]),
    )
    for (const query of [
      'first archive compaction evidence',
      'eviction archive lineage evidence',
      'changed compaction archive evidence',
    ])
      expect(
        (await repository.searchContextArchive({ query })).matches,
      ).toHaveLength(1)
    const raw = new Database(repository.databasePath)
    try {
      const before = raw
        .query(
          'SELECT snapshot_id,manifest_hash FROM context_archive_snapshots ORDER BY snapshot_id',
        )
        .all()
      await repository.persistContextArchiveSnapshots({
        runId: 'run-colliding',
        snapshots: [first, eviction, changed],
      })
      expect(
        raw
          .query(
            'SELECT snapshot_id,manifest_hash FROM context_archive_snapshots ORDER BY snapshot_id',
          )
          .all(),
      ).toEqual(before)
    } finally {
      raw.close()
    }
    await repository.close()
    const reopened = await BunSQLiteMemoryRepository.open({
      repositoryRoot: root,
    })
    if (reopened.status !== 'ok') throw new Error(reopened.error.kind)
    repositories.push(reopened.repository)
    expect(
      (
        await reopened.repository.loadContextArchiveSnapshots({
          runId: 'run-colliding',
        })
      ).snapshots,
    ).toEqual(loaded.snapshots)
  })

  test("hydrated historical snapshots keep their owner and do not erase that owner's other snapshots", async () => {
    const { repository } = await fixture(),
      now = Date.now()
    const older = snapshot(now - 1, [
        tool('historical-older', 'older historical archive evidence'),
      ]),
      sharedTime = snapshot(now, [
        tool('historical-now', 'source historical archive evidence'),
      ])
    const peer = snapshot(now, [
      tool('peer-now', 'peer same time archive evidence'),
    ])
    await repository.persistContextArchiveSnapshots({
      runId: 'run-original',
      snapshots: [older, sharedTime],
    })
    await repository.persistContextArchiveSnapshots({
      runId: 'run-peer',
      snapshots: [peer],
    })
    const durable = await repository.loadContextArchiveSnapshots({ limit: 10 })
    expect(
      durable.snapshots
        .filter((snapshot) => snapshot.archivedAt === now)
        .map((snapshot) => snapshot.runId)
        .sort(),
    ).toEqual(['run-original', 'run-peer'])
    const historical = durable.snapshots.find(
      (snapshot) =>
        snapshot.runId === 'run-original' && snapshot.archivedAt === now,
    )!
    const own = snapshot(now + 1, [tool('new-run', 'new run archive evidence')])
    await repository.persistContextArchiveSnapshots({
      runId: 'run-restored',
      snapshots: [historical, own],
    })
    await repository.persistContextArchiveSnapshots({
      runId: 'run-restored',
      snapshots: [historical, own],
    })
    expect(
      (
        await repository.loadContextArchiveSnapshots({ runId: 'run-original' })
      ).snapshots.map((snapshot) => snapshot.archivedAt),
    ).toEqual([now, now - 1])
    expect(
      (await repository.loadContextArchiveSnapshots({ runId: 'run-peer' }))
        .snapshots,
    ).toHaveLength(1)
    expect(
      (
        await repository.loadContextArchiveSnapshots({ runId: 'run-restored' })
      ).snapshots.map((snapshot) => snapshot.archivedAt),
    ).toEqual([now + 1])
    const raw = new Database(repository.databasePath)
    try {
      expect(
        raw
          .query(
            'SELECT run_id,max_archived_at FROM context_archive_watermarks ORDER BY run_id',
          )
          .all(),
      ).toEqual([
        { run_id: 'run-original', max_archived_at: now },
        { run_id: 'run-peer', max_archived_at: now },
        { run_id: 'run-restored', max_archived_at: now + 1 },
      ])
    } finally {
      raw.close()
    }
  })

  test('degraded FTS and unavailable storage are distinguishable from successful empty', async () => {
    const { repository } = await fixture(),
      now = Date.now()
    await repository.persistContextArchiveSnapshots({
      runId: 'run-status',
      snapshots: [
        snapshot(now, [tool('status-call', 'status archive evidence')]),
      ],
    })
    const empty = await repository.searchContextArchive({
      query: 'does-not-exist',
    })
    expect(empty).toMatchObject({
      matches: [],
      snapshotsSearched: 0,
      status: 'ok',
    })
    expect(empty.retention?.status).toBe('ok')

    const raw = new Database(repository.databasePath)
    raw.exec('DROP TABLE context_archive_fts')
    raw.close()
    const fallback = await repository.searchContextArchive({
      query: 'status archive evidence',
    })
    expect(fallback.status).toBe('degraded')
    expect(fallback.reasons).toContain('fts-unavailable')
    expect(fallback.matches).toHaveLength(1)
    expect(
      await repository.persistContextArchiveSnapshots({
        runId: 'run-status',
        snapshots: [
          snapshot(now + 1, [
            tool('new-status-call', 'additional archive evidence'),
          ]),
        ],
      }),
    ).toMatchObject({ persisted: 1, status: 'degraded' })
    await repository.close()
    expect(
      (
        await repository.searchContextArchive({
          query: 'status archive evidence',
        })
      ).status,
    ).toBe('unavailable')
  })

  test('legacy snapshots migrate resumably with checked bodies, order, lineage and no canonical-event loss', async () => {
    const { root, repository } = await fixture(),
      now = Date.now(),
      messages = [
        tool('legacy-a', 'legacy ordered architecture anchor'),
        tool('legacy-b', 'legacy second record'),
      ]
    const obs = observation('observation-migration')
    await append(repository, [
      event('observation.recorded', 'event-migration', {
        payloadSchemaVersion: 1,
        observation: obs,
      }),
    ])
    await repository.close()
    const path = join(root, '.openbuff', 'memory', 'memory-v2.sqlite'),
      raw = new Database(path)
    try {
      raw.exec(
        'DROP TABLE context_archive_original_refs;DROP TABLE context_archive_originals;DROP TABLE context_archive_original_bodies;DROP TABLE context_archive_cutoffs;DROP TRIGGER context_archive_bodies_ai;DROP TRIGGER context_archive_bodies_ad;DROP TRIGGER context_archive_bodies_au;DROP TABLE context_archive_fts;DROP TABLE context_archive_memberships;DROP TABLE context_archive_snapshots;DROP TABLE context_archive_messages;DROP TABLE context_archive_bodies;',
      )
      raw.exec(
        'CREATE TABLE context_archive_snapshots(run_id TEXT,archived_at REAL,action TEXT,keep_recent_steps INTEGER,step_base INTEGER,reason TEXT,messages_json TEXT,steps_json TEXT,created_at TEXT,PRIMARY KEY(run_id,archived_at));CREATE TABLE context_archive_messages(run_id TEXT,archived_at REAL,msg_index INTEGER,tool_call_id TEXT,tool_name TEXT,step INTEGER,body TEXT,PRIMARY KEY(run_id,archived_at,msg_index));CREATE VIRTUAL TABLE context_archive_fts USING fts5(run_id UNINDEXED,archived_at UNINDEXED,msg_index UNINDEXED,body);PRAGMA user_version=4;',
      )
      const insert = raw.query(
        'INSERT INTO context_archive_snapshots VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)',
      )
      for (let i = 0; i < 7; i++)
        insert.run(
          'run-legacy',
          now + i,
          i === 0 ? 'semantic_compaction' : 'tool_result_eviction',
          1,
          i === 0 ? null : 4,
          i === 0 ? null : 'legacy eviction',
          JSON.stringify(messages),
          i === 0 ? null : JSON.stringify([20, 24]),
          AT,
        )
    } finally {
      raw.close()
    }
    const reopened = await BunSQLiteMemoryRepository.open({
      repositoryRoot: root,
    })
    if (reopened.status !== 'ok') throw new Error(reopened.error.kind)
    repositories.push(reopened.repository)
    const partiallyMigrated = new Database(path)
    try {
      const page = migrateArchivePage(partiallyMigrated, 2)
      expect(page.migrated).toBe(2)
      expect(page.remaining).toBe(true)
    } finally {
      partiallyMigrated.close()
    }
    await reopened.repository.close()
    const resumed = await BunSQLiteMemoryRepository.open({
      repositoryRoot: root,
    })
    if (resumed.status !== 'ok') throw new Error(resumed.error.kind)
    repositories.push(resumed.repository)
    const loaded = await resumed.repository.loadContextArchiveSnapshots({
      runId: 'run-legacy',
      limit: 20,
    })
    expect(loaded.status).toBe('ok')
    expect(loaded.snapshots).toHaveLength(7)
    expect(loaded.snapshots[0]?.messages).toEqual(messages)
    expect(loaded.snapshots[0]?.steps).toEqual([20, 24])
    expect(loaded.snapshots[6]?.stepBase).toBeUndefined()
    expect(loaded.snapshots[6]?.reason).toBeUndefined()
    const hit = await resumed.repository.searchContextArchive({
      query: 'legacy ordered architecture anchor',
    })
    expect(hit.status).toBe('ok')
    expect(hit.matches[0]).toMatchObject({
      runId: 'run-legacy',
      step: 20,
      toolCallId: 'legacy-a',
    })
    const check = new Database(path)
    try {
      expect(
        (
          check.query('SELECT count(*) AS count FROM memory_events').get() as {
            count: number
          }
        ).count,
      ).toBe(1)
      expect(
        (
          check
            .query('SELECT count(*) AS count FROM context_archive_bodies')
            .get() as { count: number }
        ).count,
      ).toBe(2)
      expect(
        check
          .query(
            "SELECT 1 FROM sqlite_master WHERE name='context_archive_legacy_snapshots'",
          )
          .get(),
      ).toBeNull()
    } finally {
      check.close()
    }
  })

  test('normalized v5 snapshot references migrate in resumable checked pages without orphaning staged bodies', async () => {
    const { root, repository } = await fixture(),
      now = Date.now(),
      shared = tool('v5-shared', 'shared normalized archive evidence')
    const snapshots = Array.from({ length: 7 }, (_, index) =>
      snapshot(
        now + index,
        [shared, tool(`v5-${index}`, `normalized archive source ${index}`)],
        'tool_result_eviction',
      ),
    )
    await repository.persistContextArchiveSnapshots({
      runId: 'run-normalized',
      snapshots,
    })
    const original = (
      await repository.loadContextArchiveSnapshots({ runId: 'run-normalized' })
    ).snapshots
    await repository.close()
    const raw = new Database(repository.databasePath)
    try {
      raw.exec(`
        DROP TABLE context_archive_original_refs;
        DROP TABLE context_archive_originals;
        DROP TABLE context_archive_original_bodies;
        DROP TABLE context_archive_cutoffs;
        ALTER TABLE context_archive_memberships RENAME TO fixture_v6_memberships;
        ALTER TABLE context_archive_snapshots RENAME TO fixture_v6_snapshots;
        DROP INDEX context_archive_memberships_message;
        DROP INDEX context_archive_snapshots_time;
        DROP INDEX context_archive_snapshots_run_time;
        CREATE TABLE context_archive_snapshots (
          run_id TEXT NOT NULL,archived_at REAL NOT NULL,action TEXT NOT NULL,
          keep_recent_steps INTEGER NOT NULL,step_base INTEGER,reason TEXT,steps_json TEXT,
          manifest_hash TEXT NOT NULL,message_count INTEGER NOT NULL,created_at TEXT NOT NULL,
          PRIMARY KEY(run_id,archived_at)
        ) WITHOUT ROWID;
        INSERT INTO context_archive_snapshots SELECT run_id,archived_at,action,keep_recent_steps,step_base,reason,steps_json,manifest_hash,message_count,created_at FROM fixture_v6_snapshots;
        CREATE TABLE context_archive_memberships (
          run_id TEXT NOT NULL,archived_at REAL NOT NULL,msg_index INTEGER NOT NULL,message_id TEXT NOT NULL,step INTEGER,
          PRIMARY KEY(run_id,archived_at,msg_index),
          FOREIGN KEY(run_id,archived_at) REFERENCES context_archive_snapshots(run_id,archived_at) ON DELETE CASCADE
        ) WITHOUT ROWID;
        INSERT INTO context_archive_memberships SELECT s.run_id,s.archived_at,r.msg_index,r.message_id,r.step FROM fixture_v6_memberships r JOIN fixture_v6_snapshots s ON s.snapshot_id=r.snapshot_id;
        DROP TABLE fixture_v6_memberships;
        DROP TABLE fixture_v6_snapshots;
        PRAGMA user_version=5;
      `)
    } finally {
      raw.close()
    }
    const opened = await BunSQLiteMemoryRepository.open({
      repositoryRoot: root,
    })
    if (opened.status !== 'ok') throw new Error(opened.error.kind)
    repositories.push(opened.repository)
    const partial = new Database(repository.databasePath)
    try {
      expect(migrateArchivePage(partial, 2)).toEqual({
        migrated: 2,
        remaining: true,
        invalid: 0,
      })
      collectArchiveOrphans(partial)
      expect(
        (
          partial
            .query('SELECT count(*) AS count FROM context_archive_bodies')
            .get() as { count: number }
        ).count,
      ).toBe(8)
      expect(
        (
          partial
            .query('SELECT count(*) AS count FROM context_archive_v5_snapshots')
            .get() as { count: number }
        ).count,
      ).toBe(5)
      partial
        .query(
          'UPDATE context_archive_v5_memberships SET step=99 WHERE run_id=?1 AND archived_at=?2 AND msg_index=1',
        )
        .run('run-normalized', now + 6)
    } finally {
      partial.close()
    }
    await opened.repository.close()
    const resumed = await BunSQLiteMemoryRepository.open({
      repositoryRoot: root,
    })
    if (resumed.status !== 'ok') throw new Error(resumed.error.kind)
    repositories.push(resumed.repository)
    const degraded = await resumed.repository.loadContextArchiveSnapshots({
      runId: 'run-normalized',
    })
    expect(degraded.status).toBe('degraded')
    expect(degraded.reasons).toContain('legacy-migration-incomplete')
    expect(degraded.snapshots).toHaveLength(6)
    const staged = new Database(repository.databasePath)
    try {
      collectArchiveOrphans(staged)
      expect(
        (
          staged
            .query('SELECT count(*) AS count FROM context_archive_bodies')
            .get() as { count: number }
        ).count,
      ).toBe(8)
      expect(
        (
          staged
            .query('SELECT count(*) AS count FROM context_archive_v5_snapshots')
            .get() as { count: number }
        ).count,
      ).toBe(1)
      staged
        .query(
          'UPDATE context_archive_v5_memberships SET step=11 WHERE run_id=?1 AND archived_at=?2 AND msg_index=1',
        )
        .run('run-normalized', now + 6)
    } finally {
      staged.close()
    }
    expect(await resumed.repository.repairContextArchive()).toEqual({
      status: 'ok',
    })
    const loaded = await resumed.repository.loadContextArchiveSnapshots({
      runId: 'run-normalized',
    })
    expect(loaded.status).toBe('ok')
    expect(loaded.snapshots).toEqual(original)
    expect(
      (
        await resumed.repository.searchContextArchive({
          query: 'normalized archive source 6',
        })
      ).matches[0],
    ).toMatchObject({ runId: 'run-normalized', step: 11, toolCallId: 'v5-6' })
    const check = new Database(repository.databasePath)
    try {
      expect(
        check
          .query(
            "SELECT 1 FROM sqlite_master WHERE name='context_archive_v5_snapshots'",
          )
          .get(),
      ).toBeNull()
      expect(check.query('PRAGMA foreign_key_check').all()).toEqual([])
      expect(
        (
          check
            .query('SELECT count(*) AS count FROM context_archive_bodies')
            .get() as { count: number }
        ).count,
      ).toBe(8)
    } finally {
      check.close()
    }
  })
})

test('the same symbol key cannot reuse verification from another occurrence', async () => {
  const { root, repository } = await fixture()
  const selector: MemorySelector = {
    kind: 'symbol',
    path: 'src/feature.ts',
    symbol: 'route',
    occurrence: 1,
  }
  const first = observation('observation-symbol', { selector })
  first.evidence.push({
    ...first.evidence[0]!,
    selector: { ...selector, occurrence: 2 },
  })
  expect(memorySelectorKey(first.evidence[0]!.selector)).toBe(
    memorySelectorKey(first.evidence[1]!.selector),
  )
  await append(repository, [
    event('observation.recorded', 'event-symbol', {
      payloadSchemaVersion: 1,
      observation: first,
    }),
    verification(first, 'event-symbol-verified'),
  ])
  const result = await repository.query(
    query('query-symbol', {
      workspaceRevision: 1,
      workspaceSnapshotId: 'workspace-one',
    }),
  )
  expect(
    result.outcome === 'result'
      ? result.result.verifiedKnowledge[0]?.verifiedEvidence.map(
          (e) => e.selector,
        )
      : [],
  ).toEqual([selector])
  const second = first.evidence[1]!
  await append(repository, [
    event('evidence.verified', 'event-symbol-occurrence-two-verified', {
      payloadSchemaVersion: 1,
      observationId: first.observationId,
      selector: second.selector,
      observedDigest: second.contentDigest,
      verifiedAt: AT,
      verifier: 'exact-read',
      workspaceRevision: 1,
      workspaceSnapshotId: 'workspace-one',
    }),
  ])
  const both = await repository.query(
    query('query-both-symbols', {
      workspaceRevision: 1,
      workspaceSnapshotId: 'workspace-one',
    }),
  )
  expect(
    both.outcome === 'result'
      ? both.result.verifiedKnowledge[0]?.verifiedEvidence.map(
          (e) => e.selector,
        )
      : [],
  ).toEqual([selector, second.selector])
  await repository.close()
  const legacy = new Database(repository.databasePath)
  try {
    const row = legacy
      .query('SELECT state_json FROM memory_knowledge WHERE observation_id=?1')
      .get(first.observationId) as { state_json: string }
    const state = JSON.parse(row.state_json)
    state.freshness = {
      [memorySelectorKey(second.selector)]: Object.values(state.freshness).at(
        -1,
      ),
    }
    legacy
      .query(
        'UPDATE memory_knowledge SET state_json=?1 WHERE observation_id=?2',
      )
      .run(JSON.stringify(state), first.observationId)
    legacy
      .query(
        "UPDATE memory_knowledge_metadata SET value='current-knowledge-1' WHERE key='producer'",
      )
      .run()
    legacy.exec('PRAGMA user_version=5')
  } finally {
    legacy.close()
  }
  const reopened = await BunSQLiteMemoryRepository.open({
    repositoryRoot: root,
  })
  if (reopened.status !== 'ok') throw new Error(reopened.error.kind)
  repositories.push(reopened.repository)
  const repaired = await reopened.repository.query(
    query('query-symbol-producer-upgrade', {
      workspaceRevision: 1,
      workspaceSnapshotId: 'workspace-one',
    }),
  )
  expect(
    repaired.outcome === 'result'
      ? repaired.result.verifiedKnowledge[0]?.verifiedEvidence.map(
          (evidence) => evidence.selector,
        )
      : [],
  ).toEqual([selector, second.selector])
})

test('FTS relevance admits an older strong match before the bounded lexical candidate cutoff', async () => {
  const { repository } = await fixture()
  const target = observation('observation-old-lexical-target', {
    summary: 'Routing topology follows the request frontier',
  })
  await append(repository, [
    event('observation.recorded', 'event-old-lexical-target', {
      payloadSchemaVersion: 1,
      observation: target,
    }),
  ])
  const noise = Array.from({ length: 425 }, (_, index) =>
    observation(`observation-lexical-noise-${index}`, {
      summary: `Routing color palette ${index}`,
    }),
  )
  for (let index = 0; index < noise.length; index += 100)
    await append(
      repository,
      noise.slice(index, index + 100).map((observation) =>
        event('observation.recorded', `event-${observation.observationId}`, {
          payloadSchemaVersion: 1,
          observation,
        }),
      ),
    )
  const request = query('query-ranked-lexical', {
    query: 'routing topology',
    selectors: [],
    maxResultsPerCategory: 1,
  })
  const raw = new Database(repository.databasePath)
  try {
    const rows = readKnowledgeQuery(raw, knowledgeQueryPlan(request, false))
    expect(rows.lexicalFallback).toBe(false)
    expect(rows.candidateCapReached).toBe(true)
    expect(
      JSON.parse(rows.observations[0]!.state_json).observation.observationId,
    ).toBe(target.observationId)
  } finally {
    raw.close()
  }
  const result = await repository.query(request)
  expect(
    result.outcome === 'result'
      ? result.result.reusableDiscovery[0]?.observation.observationId
      : '',
  ).toBe(target.observationId)
})

const legacySeedEvidence: PlaybookTrigger['requireEvidence'] = [
  {
    kind: 'toolSucceeded',
    tool: 'run_terminal_command',
    commandPattern: '*check:ci-local*',
    withinMs: 14_400_000,
  },
]
const currentSeedEvidence: PlaybookTrigger['requireEvidence'] = [
  {
    kind: 'validationSucceeded',
    validationKinds: ['ci-local', 'package-checks'],
    withinMs: 1_800_000,
  },
]

test('owned seed migration preserves operator text, lifecycle and quality while user legacy rules stay untouched', async () => {
  const { repository } = await fixture(),
    scope = { repos: [] }
  const spawn: PlaybookTrigger = {
    tool: 'spawn_agents',
    spawnAgentType: 'git-committer',
    requireEvidence: legacySeedEvidence,
  }
  const push: PlaybookTrigger = {
    tool: 'run_terminal_command',
    terminalAction: 'git-push',
    requireEvidence: legacySeedEvidence,
  }
  const owned = await repository.upsertPlaybookByTriggerSignature({
    workspaceId: 'project-records',
    title: 'Operator edited seed title',
    instruction: 'Operator edited seed instruction must survive.',
    trigger: spawn,
    scope,
    status: 'retired',
    enforcement: 'block',
    provenance: {
      origin: 'migration',
      recordedBy: 'bun-sqlite-memory-v2',
      sourceEventIds: [],
      metadata: { operatorNote: 'preserve' },
    },
  })
  const user = await repository.upsertPlaybookByTriggerSignature({
    workspaceId: 'project-records',
    title: 'User legacy policy',
    instruction: 'User policy text.',
    trigger: push,
    scope,
    status: 'verified',
    enforcement: 'inject-only',
    provenance: {
      origin: 'user',
      recordedBy: 'operator',
      sourceEventIds: [],
      metadata: {},
    },
  })
  await repository.recordPlaybookGateOutcome(owned.playbookId, 'blocked')
  const raw = new Database(repository.databasePath)
  try {
    const beforeOwned = raw
      .query('SELECT * FROM memory_playbooks WHERE playbook_id=?1')
      .get(owned.playbookId) as Record<string, unknown>
    const beforeUser = raw
      .query('SELECT * FROM memory_playbooks WHERE playbook_id=?1')
      .get(user.playbookId)
    await repository.ensureSeedPlaybooks('project-records')
    const upgraded = raw
      .query('SELECT * FROM memory_playbooks WHERE playbook_id=?1')
      .get(owned.playbookId) as Record<string, unknown>
    expect(upgraded).toMatchObject({
      title: owned.title,
      instruction: owned.instruction,
      status: 'retired',
      enforcement: 'block',
      counters_json: beforeOwned.counters_json,
      created_at: beforeOwned.created_at,
    })
    expect(JSON.parse(upgraded.trigger_json as string).requireEvidence).toEqual(
      currentSeedEvidence,
    )
    expect(upgraded.trigger_signature).toBe(
      computeTriggerSignature(
        { ...spawn, requireEvidence: currentSeedEvidence },
        scope,
      ),
    )
    expect(JSON.parse(upgraded.provenance_json as string).metadata).toEqual({
      operatorNote: 'preserve',
      seedMigration: 'validation-receipts-1',
    })
    expect(
      raw
        .query('SELECT * FROM memory_playbooks WHERE playbook_id=?1')
        .get(user.playbookId),
    ).toEqual(beforeUser)
    const rows = raw
      .query('SELECT * FROM memory_playbooks ORDER BY playbook_id')
      .all()
    expect(rows).toHaveLength(3)
    await repository.ensureSeedPlaybooks('project-records')
    expect(
      raw.query('SELECT * FROM memory_playbooks ORDER BY playbook_id').all(),
    ).toEqual(rows)
  } finally {
    raw.close()
  }
})

test('owned seed signature collisions merge counters without duplicate active rules', async () => {
  const { repository } = await fixture(),
    scope = { repos: [] }
  await repository.ensureSeedPlaybooks('project-records')
  const current = (await repository.listPlaybooks('project-records')).find(
    (playbook) => playbook.trigger.tool === 'spawn_agents',
  )!
  await repository.recordPlaybookGateOutcome(current.playbookId, 'warned')
  const trigger: PlaybookTrigger = {
    tool: 'spawn_agents',
    spawnAgentType: 'git-committer',
    requireEvidence: legacySeedEvidence,
  }
  const legacy = await repository.upsertPlaybookByTriggerSignature({
    workspaceId: 'project-records',
    title: 'Preserved legacy seed',
    instruction: 'Preserved operator instructions.',
    trigger,
    scope,
    status: 'verified',
    enforcement: 'block',
    provenance: {
      origin: 'migration',
      recordedBy: 'bun-sqlite-memory-v2',
      sourceEventIds: [],
      metadata: {},
    },
  })
  await repository.recordPlaybookGateOutcome(legacy.playbookId, 'blocked')
  await repository.ensureSeedPlaybooks('project-records')
  const listed = await repository.listPlaybooks('project-records')
  expect(listed).toHaveLength(2)
  expect(
    listed.find((playbook) => playbook.trigger.tool === 'spawn_agents'),
  ).toMatchObject({
    playbookId: legacy.playbookId,
    title: legacy.title,
    instruction: legacy.instruction,
    status: 'verified',
    enforcement: 'block',
    counters: { fired: 2, blocked: 1 },
  })
  const raw = new Database(repository.databasePath)
  try {
    expect(
      (
        raw
          .query(
            'SELECT count(*) AS count FROM memory_playbooks WHERE trigger_signature=?1',
          )
          .get(
            computeTriggerSignature(
              { ...trigger, requireEvidence: currentSeedEvidence },
              scope,
            ),
          ) as { count: number }
      ).count,
    ).toBe(1)
  } finally {
    raw.close()
  }
})

test('an existing user policy owns a migrated seed signature and keeps its text and status', async () => {
  const { repository } = await fixture(),
    scope = { repos: [] }
  const trigger: PlaybookTrigger = {
    tool: 'spawn_agents',
    spawnAgentType: 'git-committer',
    requireEvidence: legacySeedEvidence,
  }
  const legacy = await repository.upsertPlaybookByTriggerSignature({
    workspaceId: 'project-records',
    title: 'Legacy owned seed',
    instruction: 'Historical instructions.',
    trigger,
    scope,
    status: 'verified',
    enforcement: 'warn',
    provenance: {
      origin: 'migration',
      recordedBy: 'bun-sqlite-memory-v2',
      sourceEventIds: [],
      metadata: {},
    },
  })
  const user = await repository.upsertPlaybookByTriggerSignature({
    workspaceId: 'project-records',
    title: 'Current operator policy',
    instruction: 'Current operator policy instructions.',
    trigger: { ...trigger, requireEvidence: currentSeedEvidence },
    scope,
    status: 'verified',
    enforcement: 'block',
    provenance: {
      origin: 'user',
      recordedBy: 'operator',
      sourceEventIds: [],
      metadata: {},
    },
  })
  await repository.ensureSeedPlaybooks('project-records')
  expect(
    (await repository.listPlaybooks('project-records')).find(
      (playbook) => playbook.trigger.tool === 'spawn_agents',
    ),
  ).toEqual(user)
  const raw = new Database(repository.databasePath)
  try {
    const row = raw
      .query(
        'SELECT status,provenance_json FROM memory_playbooks WHERE playbook_id=?1',
      )
      .get(legacy.playbookId) as { status: string; provenance_json: string }
    expect(row.status).toBe('retired')
    expect(JSON.parse(row.provenance_json).metadata.legacyStatus).toBe(
      'verified',
    )
    await repository.ensureSeedPlaybooks('project-records')
    expect(
      raw
        .query(
          'SELECT status,provenance_json FROM memory_playbooks WHERE playbook_id=?1',
        )
        .get(legacy.playbookId),
    ).toEqual(row)
  } finally {
    raw.close()
  }
})

test('optional semantic retrieval persists and searches the whole eligible corpus beyond 256 records', async () => {
  let root = ''
  const embed: ConceptEmbedFn = async (texts) =>
    texts.map((text) =>
      text.startsWith('query ') || text.includes('leaked descriptors')
        ? [1, 0]
        : [0, 1],
    )
  embed.cacheKey = 'full-corpus-model'
  const created = await fixture({
    recallExpander: (params) =>
      expandConceptRecall({
        projectRoot: root,
        embed,
        request: params.request,
        corpus: params.corpus,
        maxNewEmbeddings: 400,
        maxResults: 1,
      }),
  })
  root = created.root
  const records = Array.from({ length: 300 }, (_, i) =>
    observation(`observation-${String(i).padStart(4, '0')}`, {
      task: `task-${i}`,
      summary: 'Color palettes and rendering styles',
    }),
  )
  const target = observation('zz-observation-semantic-target', {
    task: 'task-target',
    summary: 'Graceful shutdown avoids leaked descriptors',
  })
  for (let i = 0; i < records.length; i += 100)
    await append(
      created.repository,
      records.slice(i, i + 100).map((obs) =>
        event('observation.recorded', `event-${obs.observationId}`, {
          payloadSchemaVersion: 1,
          observation: obs,
        }),
      ),
    )
  await append(created.repository, [
    event('observation.recorded', 'event-semantic-target', {
      payloadSchemaVersion: 1,
      observation: target,
    }),
  ])
  const result = await created.repository.query(
    query('query-full-semantic', {
      query: 'resource reclamation',
      selectors: [],
    }),
  )
  expect(
    result.outcome === 'result'
      ? result.result.reusableDiscovery.map(
          (item) => item.observation.observationId,
        )
      : [],
  ).toEqual([target.observationId])
  expect(
    result.outcome === 'result'
      ? result.result.reusableDiscovery[0]?.reasons[0]?.code
      : '',
  ).toBe('concept-advisory')
  const database = openConceptDatabase(root)
  if (!database) throw new Error('Concept store unavailable')
  try {
    expect(
      (
        database
          .query('SELECT count(*) AS count FROM concept_records')
          .get() as { count: number }
      ).count,
    ).toBe(301)
  } finally {
    database.close()
  }
  await append(created.repository, [
    event('claim.forgotten', 'event-semantic-forgotten', {
      payloadSchemaVersion: 1,
      observationIds: [target.observationId],
      reason: 'user-request',
      requestedBy: 'operator',
      evidenceDisposition: 'retain-artifacts',
    }),
  ])
  const forgotten = await created.repository.query(
    query('query-full-semantic-after-forget', {
      query: 'resource reclamation',
      selectors: [],
    }),
  )
  expect(
    forgotten.outcome === 'result'
      ? forgotten.result.reusableDiscovery.some(
          (item) => item.observation.observationId === target.observationId,
        )
      : true,
  ).toBe(false)
})
