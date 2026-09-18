import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MemoryAppendOutcomeSchema,
  MemoryAppendRequestSchema,
  MemoryEventDraftSchema,
  MemoryExportOutcomeSchema,
  MemoryExportRequestSchema,
  MemoryHealthRequestSchema,
  MemoryHealthSchema,
  MemoryQueryOutcomeSchema,
  MemoryRebuildOutcomeSchema,
  MemoryRebuildRequestSchema,
  MemoryRetrievalRequestSchema,
  MemoryVerifyOutcomeSchema,
  MemoryVerifyRequestSchema,
  ProjectIdSchema,
  TaskIdSchema,
  type MemoryAppendRequest,
  type MemoryEventDraft,
} from '../../../../../common/src/types/memory-v2'

import {
  BunSQLiteMemoryRepository,
  SQLITE_OPEN_POSTURE,
  openBunSQLiteMemoryRepository,
  type MemoryV2EventInput,
} from '../bun-sqlite-memory-repository'

const repositories: BunSQLiteMemoryRepository[] = []

function temporaryRepository(): string {
  return mkdtempSync(join(tmpdir(), 'openbuff-memory-v2-'))
}

function event(
  eventId: string,
  overrides: Partial<MemoryV2EventInput> = {},
): MemoryV2EventInput {
  return {
    eventId,
    idempotencyKey: `key-${eventId}`,
    eventType: 'task.updated',
    occurredAt: '2025-01-02T03:04:05.000Z',
    payload: { taskId: 'task-1', value: eventId },
    taskId: 'task-1',
    ...overrides,
  }
}

function draft(eventId: string, projectId = 'project-1'): MemoryEventDraft {
  return MemoryEventDraftSchema.parse({
    schemaVersion: 2,
    eventSchemaVersion: 1,
    eventType: 'task.created',
    eventId,
    projectId,
    sessionId: 'session-1',
    occurredAt: '2025-01-02T03:04:05.000Z',
    payload: {
      payloadSchemaVersion: 1,
      taskId: `task-${eventId}`,
      title: `Task ${eventId}`,
      objective: 'Exercise the public Memory V2 port.',
      initialStatus: 'created',
    },
  })
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

function evidenceFixture(
  path = 'src/example.ts',
  digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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

const V1_SCHEMA = `
  CREATE TABLE memory_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    task_id TEXT, session_id TEXT, artifact_id TEXT
  );
  CREATE TRIGGER memory_events_no_update BEFORE UPDATE ON memory_events
  BEGIN SELECT RAISE(ABORT, 'canonical memory events are append only'); END;
  CREATE TRIGGER memory_events_no_delete BEFORE DELETE ON memory_events
  BEGIN SELECT RAISE(ABORT, 'canonical memory events are append only'); END;
  CREATE TABLE memory_projection_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  INSERT INTO memory_projection_metadata(key, value) VALUES ('cursor', '0');
  CREATE TABLE memory_store_capabilities (
    name TEXT PRIMARY KEY, available INTEGER NOT NULL CHECK (available IN (0, 1)),
    fallback TEXT, value TEXT NOT NULL
  ) WITHOUT ROWID;
  PRAGMA user_version = 1;
`

function insertStoredDraft(
  database: Database,
  value: MemoryEventDraft,
  payloadOverride?: unknown,
): void {
  database
    .query(
      `INSERT INTO memory_events (
       event_id, idempotency_key, event_type, occurred_at, payload_json,
       metadata_json, task_id, session_id, artifact_id
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)`,
    )
    .run(
      value.eventId,
      `event:${value.eventId}`,
      value.eventType,
      value.occurredAt,
      JSON.stringify(payloadOverride ?? value.payload),
      JSON.stringify({
        schemaVersion: value.schemaVersion,
        eventSchemaVersion: value.eventSchemaVersion,
        projectId: value.projectId,
        sessionId: value.sessionId,
      }),
      'taskId' in value.payload ? value.payload.taskId : null,
      value.sessionId,
    )
}

function createV1Fixture(
  root: string,
  value: MemoryEventDraft,
  payloadOverride?: unknown,
): string {
  const memory = join(root, '.openbuff', 'memory')
  mkdirSync(memory, { recursive: true })
  const path = join(memory, 'memory-v2.sqlite')
  const database = new Database(path, { create: true })
  try {
    database.exec(V1_SCHEMA)
    insertStoredDraft(database, value, payloadOverride)
  } finally {
    database.close()
  }
  return path
}

function rewriteStoredProject(
  path: string,
  eventId: string,
  projectId: unknown,
): void {
  const database = new Database(path)
  try {
    database.exec('DROP TRIGGER memory_events_no_update')
    const metadata =
      projectId === undefined
        ? { schemaVersion: 2, eventSchemaVersion: 1, sessionId: 'session-1' }
        : {
            schemaVersion: 2,
            eventSchemaVersion: 1,
            projectId,
            sessionId: 'session-1',
          }
    database
      .query('UPDATE memory_events SET metadata_json = ?1 WHERE event_id = ?2')
      .run(JSON.stringify(metadata), eventId)
    database.exec(`CREATE TRIGGER memory_events_no_update BEFORE UPDATE ON memory_events
      BEGIN SELECT RAISE(ABORT, 'canonical memory events are append only'); END;`)
  } finally {
    database.close()
  }
}

async function openResult(root: string) {
  return BunSQLiteMemoryRepository.open({ repositoryRoot: root })
}

async function open(
  root: string,
  busyTimeoutMs?: number,
): Promise<BunSQLiteMemoryRepository> {
  const result = await BunSQLiteMemoryRepository.open({
    repositoryRoot: root,
    busyTimeoutMs,
  })
  if (result.status === 'error') throw new Error(result.error.message)
  repositories.push(result.repository)
  return result.repository
}

function projectBindingState(repository: BunSQLiteMemoryRepository): {
  events: number
  tasks: number
  projectId: string | null
} {
  const database = new Database(repository.databasePath)
  try {
    const events = database
      .query('SELECT COUNT(*) AS count FROM memory_events')
      .get() as { count: number }
    const tasks = database
      .query('SELECT COUNT(*) AS count FROM memory_tasks')
      .get() as { count: number }
    const binding = database
      .query(
        "SELECT value FROM memory_projection_metadata WHERE key = 'project_id'",
      )
      .get() as { value: string } | null
    return {
      events: events.count,
      tasks: tasks.count,
      projectId: binding?.value ?? null,
    }
  } finally {
    database.close()
  }
}

afterEach(async () => {
  while (repositories.length > 0) await repositories.pop()?.close()
})

describe('BunSQLiteMemoryRepository', () => {
  test('creates the contained default database with schema version 2 and append-only tables', async () => {
    const root = temporaryRepository()
    const repository = await open(root)
    const databasePath = join(root, '.openbuff', 'memory', 'memory-v2.sqlite')
    expect(repository.databasePath).toBe(databasePath)

    const database = new Database(databasePath)
    try {
      const version = database.query('PRAGMA user_version').get() as {
        user_version: number
      }
      expect(version.user_version).toBe(2)
      const names = (
        database
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map(({ name }) => name)
      expect(names).toEqual(
        expect.arrayContaining([
          'memory_events',
          'memory_tasks',
          'memory_sessions',
          'memory_artifacts',
          'memory_claims',
          'memory_evidence',
          'memory_discoveries',
          'memory_projection_metadata',
          'memory_store_capabilities',
        ]),
      )
    } finally {
      database.close()
    }
  })

  test('appends in monotonic order and treats exact retries as idempotent', async () => {
    const repository = await open(temporaryRepository())
    const first = await repository.appendEvents([event('one'), event('two')])
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    expect(first.events.map(({ sequence }) => sequence)).toEqual([1, 2])
    expect(first.appendedCount).toBe(2)

    const duplicate = await repository.appendEvents([event('one')])
    expect(duplicate).toEqual({
      status: 'ok',
      events: [{ eventId: 'one', sequence: 1, duplicate: true }],
      appendedCount: 0,
      duplicateCount: 1,
      lastSequence: 1,
    })

    const listed = await repository.listEvents()
    expect(listed.status).toBe('ok')
    if (listed.status === 'ok') {
      expect(listed.events.map(({ eventId }) => eventId)).toEqual([
        'one',
        'two',
      ])
    }
  })

  test('rejects conflicting idempotency and rolls back an invalid batch', async () => {
    const repository = await open(temporaryRepository())
    const invalid = await repository.appendEvents([
      event('valid'),
      event('invalid', { payload: Symbol('not-json') }),
    ])
    expect(invalid.status).toBe('error')
    if (invalid.status === 'error') expect(invalid.error.kind).toBe('invalid')
    const empty = await repository.listEvents()
    expect(empty).toEqual({ status: 'ok', events: [] })

    expect((await repository.appendEvents([event('original')])).status).toBe(
      'ok',
    )
    const conflict = await repository.appendEvents([
      event('different-id', { idempotencyKey: 'key-original' }),
    ])
    expect(conflict.status).toBe('error')
    if (conflict.status === 'error') expect(conflict.error.kind).toBe('invalid')

    const sameIdConflict = await repository.appendEvents([
      event('original', { idempotencyKey: 'different-key' }),
    ])
    expect(sameIdConflict.status).toBe('error')
    if (sameIdConflict.status === 'error')
      expect(sameIdConflict.error.kind).toBe('invalid')
    expect(conflict.status).toBe('error')
    if (conflict.status === 'error') expect(conflict.error.kind).toBe('invalid')
  })

  test('rejects same-request event and idempotency collisions before binding or mutation', async () => {
    for (const batch of [
      [event('same'), event('same')],
      [
        event('same-id'),
        event('same-id', { payload: { taskId: 'task-1', value: 'different' } }),
      ],
      [
        event('first-key'),
        event('second-key', { idempotencyKey: 'key-first-key' }),
      ],
    ]) {
      const repository = await open(temporaryRepository())
      const rejected = await repository.appendEvents(
        batch.map((entry) => ({
          ...entry,
          metadata: {
            projectId: 'project-1',
            schemaVersion: 2,
            eventSchemaVersion: 1,
          },
        })),
      )
      expect(rejected).toMatchObject({
        status: 'error',
        error: { kind: 'invalid', retryable: false },
      })
      expect(projectBindingState(repository)).toEqual({
        events: 0,
        tasks: 0,
        projectId: null,
      })
    }
  })

  test('persists canonical events across close and reopen', async () => {
    const root = temporaryRepository()
    const repository = await open(root)
    expect((await repository.appendEvents([event('persisted')])).status).toBe(
      'ok',
    )
    await repository.close()

    const reopened = await open(root)
    const listed = await reopened.listEvents()
    expect(listed.status).toBe('ok')
    if (listed.status === 'ok')
      expect(listed.events[0]?.eventId).toBe('persisted')
  })

  test('uses owner-only directory and SQLite file permissions', async () => {
    const root = temporaryRepository()
    const repository = await open(root)
    expect(statSync(join(root, '.openbuff')).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, '.openbuff', 'memory')).mode & 0o777).toBe(0o700)
    expect(statSync(repository.databasePath).mode & 0o777).toBe(0o600)
    for (const sibling of [
      `${repository.databasePath}-wal`,
      `${repository.databasePath}-shm`,
    ]) {
      try {
        expect(statSync(sibling).mode & 0o777).toBe(0o600)
      } catch {
        // SQLite may not retain empty WAL siblings.
      }
    }
  })

  test('tightens permissive pre-existing memory directories and database', async () => {
    const root = temporaryRepository()
    const openbuff = join(root, '.openbuff')
    const memory = join(openbuff, 'memory')
    mkdirSync(memory, { recursive: true, mode: 0o777 })
    chmodSync(openbuff, 0o777)
    chmodSync(memory, 0o777)
    const databasePath = join(memory, 'memory-v2.sqlite')
    const fixture = new Database(databasePath, { create: true })
    fixture.close()
    chmodSync(databasePath, 0o666)

    const repository = await open(root)
    expect(statSync(openbuff).mode & 0o777).toBe(0o700)
    expect(statSync(memory).mode & 0o777).toBe(0o700)
    expect(statSync(repository.databasePath).mode & 0o777).toBe(0o600)
  })

  test('records FTS5 detection and deterministic lexical fallback metadata', async () => {
    const repository = await open(temporaryRepository())
    const result = await repository.getCapabilities()
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const fts = result.capabilities.find(({ name }) => name === 'fts5')
    const fallback = result.capabilities.find(
      ({ name }) => name === 'lexical_fallback',
    )
    expect(fts).toBeDefined()
    expect(fts?.available || fts?.fallback === 'lexical-scan-v1').toBe(true)
    expect(fallback).toEqual({
      name: 'lexical_fallback',
      available: true,
      fallback: null,
      value: 'unicode-codepoint-order-v1',
    })
  })

  test('rebuilds disposable projections deterministically from the event cursor', async () => {
    const root = temporaryRepository()
    const repository = await open(root)
    await repository.appendEvents([
      event('first', { payload: { taskId: 'task-1', state: 'started' } }),
      event('second', { payload: { taskId: 'task-1', state: 'done' } }),
      event('claim', {
        eventType: 'claim.created',
        payload: { claimId: 'claim-1', text: 'deterministic' },
      }),
    ])
    const before = await repository.getProjectionSnapshot()
    expect(before.status).toBe('ok')
    if (before.status !== 'ok') return
    expect(before.cursor).toBe(3)

    const database = new Database(repository.databasePath)
    try {
      database.exec('DELETE FROM memory_tasks; DELETE FROM memory_claims;')
      database
        .query(
          "UPDATE memory_projection_metadata SET value = '0' WHERE key = 'cursor'",
        )
        .run()
    } finally {
      database.close()
    }

    const rebuilt = await repository.rebuildProjections()
    expect(rebuilt).toEqual({
      status: 'ok',
      cursor: 3,
      projectedEvents: 3,
      truncated: false,
    })
    const after = await repository.getProjectionSnapshot()
    expect(after).toEqual(before)
  })

  test('rebuilds a store under the replay cap with cursor at the tail and no truncation', async () => {
    const repository = await open(temporaryRepository())
    await repository.appendEvents([
      event('under-cap-one'),
      event('under-cap-two'),
    ])
    const listed = await repository.listEvents()
    expect(listed.status).toBe('ok')
    const tail = listed.status === 'ok' ? listed.events.at(-1)!.sequence : -1
    expect(tail).toBe(2)
    const rebuilt = await repository.rebuildProjections()
    expect(rebuilt.status).toBe('ok')
    if (rebuilt.status !== 'ok') return
    expect(rebuilt.truncated).toBe(false)
    expect(rebuilt.projectedEvents).toBe(2)
    expect(rebuilt.cursor).toBe(tail)
    expect(rebuilt.cursor).toBe(2)
  })

  test('truncates a rebuild beyond the replay event budget and signals degradation without claiming the tail', async () => {
    const repository = await open(temporaryRepository())
    const database = new Database(repository.databasePath)
    try {
      const insert = database.query(
        `INSERT INTO memory_events (
           event_id, idempotency_key, event_type, occurred_at, payload_json,
           metadata_json, task_id, session_id, artifact_id
         ) VALUES (?1, ?2, 'task.updated', '2025-01-02T03:04:05.000Z', ?3, '{}', 'task-1', 'session-1', NULL)`,
      )
      database.exec('BEGIN IMMEDIATE')
      for (let index = 0; index < 10_250; index++) {
        insert.run(
          `replay-cap-${index}`,
          `key-replay-cap-${index}`,
          JSON.stringify({ taskId: 'task-1', value: index }),
        )
      }
      database.exec('COMMIT')
    } finally {
      database.close()
    }

    const rebuilt = await repository.rebuildProjections()
    expect(rebuilt.status).toBe('ok')
    if (rebuilt.status !== 'ok') return
    // Deterministic degradation signal: the replay budget bounded the rebuild.
    expect(rebuilt.truncated).toBe(true)
    expect(rebuilt.projectedEvents).toBe(10_000)
    // The cursor must NOT falsely claim the real tail (10_250).
    expect(rebuilt.cursor).toBe(10_000)
    expect(rebuilt.cursor).not.toBe(10_250)

    const snapshot = await repository.getProjectionSnapshot()
    expect(snapshot.status).toBe('ok')
    if (snapshot.status !== 'ok') return
    expect(snapshot.cursor).toBe(10_000)

    const verification = new Database(repository.databasePath)
    try {
      const tail = (
        verification
          .query(
            'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM memory_events',
          )
          .get() as { sequence: number }
      ).sequence
      const cursor = (
        verification
          .query(
            "SELECT value FROM memory_projection_metadata WHERE key = 'cursor'",
          )
          .get() as { value: string }
      ).value
      expect(tail).toBe(10_250)
      expect(cursor).toBe('10000')
      expect(cursor).not.toBe(String(tail))
    } finally {
      verification.close()
    }
  })

  test('reduces canonical lifecycle chains and rebuilds the exact normalized state', async () => {
    const repository = await open(temporaryRepository())
    const sourceOne = observationFixture('source-one')
    const sourceTwo = observationFixture('source-two', [])
    const canonical = observationFixture('canonical', [])
    const events = [
      draft('canonical-task'),
      canonicalDraft('task.transitioned', 'task-transitioned', {
        payloadSchemaVersion: 1,
        taskId: 'task-canonical-task',
        fromStatus: 'created',
        toStatus: 'completed',
        reason: 'done',
      }),
      canonicalDraft(
        'session.started',
        'session-started',
        {
          payloadSchemaVersion: 1,
          startedAt: '2025-01-02T03:04:05.000Z',
        },
        'canonical-session',
      ),
      canonicalDraft(
        'session.ended',
        'session-ended',
        {
          payloadSchemaVersion: 1,
          status: 'completed',
          endedAt: '2025-01-02T04:04:05.000Z',
        },
        'canonical-session',
      ),
      canonicalDraft('observation.recorded', 'observation-one', {
        payloadSchemaVersion: 1,
        observation: sourceOne,
      }),
      canonicalDraft('observation.recorded', 'observation-two', {
        payloadSchemaVersion: 1,
        observation: sourceTwo,
      }),
      canonicalDraft('evidence.attached', 'evidence-attached', {
        payloadSchemaVersion: 1,
        observationId: 'source-one',
        evidence: sourceOne.evidence,
      }),
      canonicalDraft('claim.pinned', 'claim-pinned', {
        payloadSchemaVersion: 1,
        observationId: 'source-one',
        reason: 'keep',
        pinnedBy: 'test',
        pinnedAt: '2025-01-02T03:04:05.000Z',
      }),
      canonicalDraft('evidence.verified', 'evidence-verified', {
        payloadSchemaVersion: 1,
        observationId: 'source-one',
        selector: sourceOne.evidence[0]!.selector,
        verifier: 'test',
        verifiedAt: '2025-01-02T03:05:05.000Z',
        observedDigest: sourceOne.evidence[0]!.contentDigest,
      }),
      canonicalDraft('evidence.invalidated', 'evidence-invalidated', {
        payloadSchemaVersion: 1,
        observationId: 'source-one',
        selector: sourceOne.evidence[0]!.selector,
        reason: 'changed',
        detail: 'changed',
        invalidatedAt: '2025-01-02T03:06:05.000Z',
      }),
      canonicalDraft('evidence.rebound', 'evidence-rebound', {
        payloadSchemaVersion: 1,
        observationId: 'source-one',
        previousSelector: { kind: 'file', path: 'src/old-example.ts' },
        evidence: sourceOne.evidence[0],
        reason: 'moved',
      }),
      canonicalDraft('claim.corrected', 'claim-corrected', {
        payloadSchemaVersion: 1,
        observationId: 'source-two',
        correction: observationFixture('corrected', []),
        reason: 'corrected',
      }),
      canonicalDraft('claim.superseded', 'claim-superseded', {
        payloadSchemaVersion: 1,
        observationId: 'corrected',
        supersededByObservationId: 'canonical',
        reason: 'newer',
      }),
      canonicalDraft('claim.forgotten', 'claim-forgotten', {
        payloadSchemaVersion: 1,
        observationIds: ['corrected'],
        reason: 'duplicate',
        requestedBy: 'test',
        evidenceDisposition: 'retain-artifacts',
      }),
      canonicalDraft('claim.consolidated', 'claim-consolidated', {
        payloadSchemaVersion: 1,
        sourceObservationIds: ['source-one', 'source-two'],
        canonicalObservation: canonical,
        reason: 'merge',
      }),
    ]
    const appended = await repository.append(
      MemoryAppendRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        events,
      }),
    )
    expect(appended.outcome).toBe('appended')
    const before = await repository.getProjectionSnapshot()
    expect(before.status).toBe('ok')
    if (before.status !== 'ok') return
    expect(before.tasks[0]?.state).toMatchObject({
      title: 'Task canonical-task',
      objective: 'Exercise the public Memory V2 port.',
      status: 'completed',
    })
    expect(before.sessions[0]).toMatchObject({
      entityId: 'canonical-session',
      state: {
        sessionId: 'canonical-session',
        status: 'completed',
        startedAt: '2025-01-02T03:04:05.000Z',
        endedAt: '2025-01-02T04:04:05.000Z',
      },
    })
    const attachedEvidence = before.evidence.find(
      ({ state }) =>
        (state as { evidence?: { selector?: { path?: string } } }).evidence
          ?.selector?.path === 'src/example.ts',
    )
    expect(attachedEvidence?.state).toMatchObject({
      lifecycle: 'attached',
      evidence: sourceOne.evidence[0],
      freshness: {},
    })
    const reboundEvidence = before.evidence.find(
      ({ state }) =>
        (state as { evidence?: { selector?: { path?: string } } }).evidence
          ?.selector?.path !== 'src/example.ts',
    )
    expect(reboundEvidence?.state).toMatchObject({
      lifecycle: 'rebound',
      freshness: {},
    })
    expect(
      before.discoveries.find(({ entityId }) => entityId === 'source-one')
        ?.state,
    ).toMatchObject({ lifecycle: 'superseded' })
    expect(
      before.claims.find(({ entityId }) => entityId === 'source-one')?.state,
    ).toMatchObject({ lifecycle: 'superseded' })
    expect(
      before.claims.find(({ entityId }) => entityId === 'canonical')?.state,
    ).toMatchObject({ lifecycle: 'consolidated', observationId: 'canonical' })

    const database = new Database(repository.databasePath)
    try {
      database.exec(`DELETE FROM memory_tasks; DELETE FROM memory_sessions; DELETE FROM memory_artifacts;
        DELETE FROM memory_claims; DELETE FROM memory_evidence; DELETE FROM memory_discoveries;`)
      database
        .query(
          "UPDATE memory_projection_metadata SET value = '0' WHERE key = 'cursor'",
        )
        .run()
    } finally {
      database.close()
    }
    expect((await repository.rebuildProjections()).status).toBe('ok')
    expect(await repository.getProjectionSnapshot()).toEqual(before)
  })

  test('iterates canonical events from an exclusive cursor', async () => {
    const repository = await open(temporaryRepository())
    await repository.appendEvents([event('one'), event('two'), event('three')])
    const ids: string[] = []
    for await (const stored of repository.iterateEvents({ afterSequence: 1 })) {
      ids.push(stored.eventId)
    }
    expect(ids).toEqual(['two', 'three'])
  })

  test('reports WAL health or its visible degraded fallback and closed health', async () => {
    const repository = await open(temporaryRepository())
    const health = await repository.kernelHealth()
    expect(['healthy', 'degraded']).toContain(health.status)
    expect(health.schemaVersion).toBe(2)
    expect(health.journalMode).toBeTruthy()
    expect(health.synchronous).toBeTruthy()

    await repository.close()
    const closed = await repository.kernelHealth()
    expect(closed.status).toBe('unavailable')
    expect(closed.failure).toEqual({
      kind: 'closed',
      message: 'The memory store is closed.',
      retryable: false,
    })
    const closedAppend = await repository.appendEvents([event('after-close')])
    expect(closedAppend).toMatchObject({
      status: 'error',
      error: { kind: 'closed', retryable: false },
    })
    if (closedAppend.status === 'error')
      expect(closedAppend.error.message).not.toContain(repository.databasePath)
  })

  test('classifies a generic local filesystem failure as bounded nonretryable I/O', async () => {
    const root = temporaryRepository()
    const fileRoot = join(root, 'not-a-directory')
    writeFileSync(fileRoot, 'occupied')
    const opened = await BunSQLiteMemoryRepository.open({
      repositoryRoot: fileRoot,
    })
    expect(opened).toMatchObject({
      status: 'error',
      error: { kind: 'io', retryable: false },
    })
    if (opened.status === 'error') {
      expect(opened.error.message.length).toBeLessThan(256)
      expect(opened.error.message).not.toContain(root)
    }
  })

  test('transactionally backfills a real schema-v1 store and reopens idempotently', async () => {
    const root = temporaryRepository()
    const path = createV1Fixture(root, draft('v1-task'))
    const before = readFileSync(path)
    const readSemanticState = () => {
      const database = new Database(path, { readonly: true })
      try {
        const canonicalEvents = database
          .query(
            `SELECT sequence, event_id AS eventId, idempotency_key AS idempotencyKey
             FROM memory_events ORDER BY sequence`,
          )
          .all() as Array<{
          sequence: number
          eventId: string
          idempotencyKey: string
        }>
        const canonicalEventCount = (
          database
            .query('SELECT COUNT(*) AS count FROM memory_events')
            .get() as { count: number }
        ).count
        const binding = database
          .query(
            "SELECT value FROM memory_projection_metadata WHERE key = 'project_id'",
          )
          .get() as { value: string } | null
        const capabilities = database
          .query(
            'SELECT name, available, fallback, value FROM memory_store_capabilities ORDER BY name',
          )
          .all() as Array<{
          name: string
          available: number
          fallback: string | null
          value: string
        }>
        const projectionCursor = (
          database
            .query(
              "SELECT value FROM memory_projection_metadata WHERE key = 'cursor'",
            )
            .get() as { value: string }
        ).value
        const userVersion = (
          database.query('PRAGMA user_version').get() as {
            user_version: number
          }
        ).user_version
        const quickCheck = (
          database.query('PRAGMA quick_check(1)').get() as {
            quick_check: string
          }
        ).quick_check
        return {
          canonicalEvents,
          canonicalEventCount,
          projectBinding: binding?.value ?? null,
          capabilities,
          projectionCursor,
          userVersion,
          quickCheck,
        }
      } finally {
        database.close()
      }
    }

    const repository = await open(root)
    const snapshot = await repository.getProjectionSnapshot()
    expect(snapshot.status).toBe('ok')
    if (snapshot.status === 'ok') {
      expect(snapshot.cursor).toBe(1)
      expect(snapshot.tasks.map(({ entityId }) => entityId)).toEqual([
        'task-v1-task',
      ])
    }
    await repository.close()
    const afterMigration = readFileSync(path)
    const migratedState = readSemanticState()
    expect(migratedState.canonicalEventCount).toBe(1)
    expect(migratedState.canonicalEvents).toEqual([
      { sequence: 1, eventId: 'v1-task', idempotencyKey: 'event:v1-task' },
    ])
    expect(migratedState.projectBinding).toBe('project-1')
    expect(migratedState.capabilities.length).toBeGreaterThan(0)
    expect(migratedState.projectionCursor).toBe('1')
    expect(migratedState.userVersion).toBe(2)
    expect(migratedState.quickCheck).toBe('ok')

    const reopened = await open(root)
    const reopenedSnapshot = await reopened.getProjectionSnapshot()
    await reopened.close()
    const reopenedState = readSemanticState()
    expect(reopenedSnapshot).toEqual(snapshot)
    expect(reopenedState.canonicalEventCount).toBe(
      migratedState.canonicalEventCount,
    )
    expect(reopenedState.canonicalEvents).toEqual(migratedState.canonicalEvents)
    expect(reopenedState.projectBinding).toBe(migratedState.projectBinding)
    expect(reopenedState.capabilities).toEqual(migratedState.capabilities)
    expect(reopenedState.projectionCursor).toBe(migratedState.projectionCursor)
    expect(reopenedState.userVersion).toBe(2)
    expect(reopenedState.quickCheck).toBe('ok')
    expect(afterMigration).not.toEqual(before)
  })

  test('rejects missing, malformed, and mixed persisted project identities on reopen', async () => {
    for (const mode of ['missing', 'invalid', 'mixed'] as const) {
      const root = temporaryRepository()
      const first = draft(`${mode}-first`)
      const path = createV1Fixture(root, first)
      if (mode === 'mixed') {
        const database = new Database(path)
        try {
          database.exec('DROP TRIGGER memory_events_no_update')
          insertStoredDraft(database, draft('mixed-second', 'project-2'))
          database.exec(`CREATE TRIGGER memory_events_no_update BEFORE UPDATE ON memory_events
            BEGIN SELECT RAISE(ABORT, 'canonical memory events are append only'); END;`)
        } finally {
          database.close()
        }
      } else {
        rewriteStoredProject(
          path,
          first.eventId,
          mode === 'missing' ? undefined : 'not a valid project',
        )
      }
      const before = readFileSync(path)
      const opened = await openResult(root)
      expect(opened).toMatchObject({
        status: 'error',
        error: { kind: 'incompatible', retryable: false },
      })
      expect(readFileSync(path)).toEqual(before)
    }
  })

  test('rolls back schema-v1 DDL, binding, cursor, and projections when replay fails', async () => {
    const root = temporaryRepository()
    const path = createV1Fixture(root, draft('bad-v1'), {
      payloadSchemaVersion: 1,
      taskId: 'task-bad-v1',
    })
    const before = readFileSync(path)
    const opened = await openResult(root)
    expect(opened).toMatchObject({
      status: 'error',
      error: { kind: 'incompatible', retryable: false },
    })
    expect(readFileSync(path)).toEqual(before)
    const database = new Database(path, { readonly: true })
    try {
      expect(
        (
          database.query('PRAGMA user_version').get() as {
            user_version: number
          }
        ).user_version,
      ).toBe(1)
      expect(
        (
          database
            .query(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'memory_tasks'",
            )
            .get() as { count: number }
        ).count,
      ).toBe(0)
      expect(
        database
          .query(
            "SELECT value FROM memory_projection_metadata WHERE key = 'project_id'",
          )
          .get(),
      ).toBeNull()
      expect(
        (
          database
            .query(
              "SELECT value FROM memory_projection_metadata WHERE key = 'cursor'",
            )
            .get() as { value: string }
        ).value,
      ).toBe('0')
      expect(
        (
          database
            .query('SELECT COUNT(*) AS count FROM memory_events')
            .get() as { count: number }
        ).count,
      ).toBe(1)
    } finally {
      database.close()
    }
  })

  test('classifies incompatible and corrupt databases without exposing their paths', async () => {
    const incompatibleRoot = temporaryRepository()
    const incompatiblePath = join(incompatibleRoot, 'future.sqlite')
    const future = new Database(incompatiblePath, { create: true })
    future.exec('PRAGMA user_version = 99')
    future.close()

    const incompatible = await BunSQLiteMemoryRepository.open({
      repositoryRoot: incompatibleRoot,
      databasePath: 'future.sqlite',
    })
    expect(incompatible.status).toBe('error')
    if (incompatible.status === 'error') {
      expect(incompatible.error.kind).toBe('incompatible')
      expect(incompatible.error.message).not.toContain(incompatibleRoot)
    }

    const corruptRoot = temporaryRepository()
    const corruptPath = join(corruptRoot, 'corrupt.sqlite')
    writeFileSync(corruptPath, 'this is not sqlite')
    const corrupt = await BunSQLiteMemoryRepository.open({
      repositoryRoot: corruptRoot,
      databasePath: 'corrupt.sqlite',
    })
    expect(corrupt.status).toBe('error')
    if (corrupt.status === 'error') {
      expect(corrupt.error.kind).toBe('corrupt')
      expect(corrupt.error.message).not.toContain(corruptRoot)
    }
    expect(readFileSync(corruptPath, 'utf8')).toBe('this is not sqlite')
  })

  test('classifies a deterministic competing writer as busy', async () => {
    const root = temporaryRepository()
    const repository = await open(root, 1)
    const competing = new Database(repository.databasePath)
    competing.exec('PRAGMA busy_timeout = 1; BEGIN IMMEDIATE')
    try {
      const result = await repository.appendEvents([event('blocked')])
      expect(result.status).toBe('error')
      if (result.status === 'error') {
        expect(result.error.kind).toBe('busy')
        expect(result.error.retryable).toBe(true)
      }
    } finally {
      competing.exec('ROLLBACK')
      competing.close()
    }
  })

  test('rejects paths outside the repository and exposes unsupported semantics', async () => {
    const root = temporaryRepository()
    const escaped = await BunSQLiteMemoryRepository.open({
      repositoryRoot: root,
      databasePath: join(root, '..', 'escaped.sqlite'),
    })
    expect(escaped.status).toBe('error')
    if (escaped.status === 'error')
      expect(escaped.error.kind).toBe('incompatible')

    const repository = await open(root)
    expect(await repository.search()).toEqual({
      status: 'unsupported',
      capability: 'semantic-search',
      message:
        'Memory V2 semantic-search is not implemented by the Bun SQLite kernel.',
    })
  })

  test('implements validated public append, CAS, canonical export, rebuild, and health', async () => {
    const repository = await open(temporaryRepository())
    const request: MemoryAppendRequest = MemoryAppendRequestSchema.parse({
      schemaVersion: 2,
      projectId: 'project-1',
      events: [draft('public-one'), draft('public-two')],
    })
    const appended = await repository.append(request)
    const parsedAppend = MemoryAppendOutcomeSchema.parse(appended)
    expect(parsedAppend.outcome).toBe('appended')
    if (parsedAppend.outcome !== 'appended') return
    expect(
      parsedAppend.entries.map(({ eventId, sequence, duplicate }) => ({
        eventId: String(eventId),
        sequence,
        duplicate,
      })),
    ).toEqual([
      { eventId: 'public-one', sequence: 1, duplicate: false },
      { eventId: 'public-two', sequence: 2, duplicate: false },
    ])
    expect(String(parsedAppend.lastEventId)).toBe('public-two')

    const duplicate = await repository.append(
      MemoryAppendRequestSchema.parse({
        ...request,
        events: [draft('public-one')],
      }),
    )
    expect(duplicate.outcome).toBe('appended')
    if (duplicate.outcome !== 'appended') return
    expect(
      duplicate.entries.map(
        ({ eventId, sequence, duplicate: isDuplicate }) => ({
          eventId: String(eventId),
          sequence,
          duplicate: isDuplicate,
        }),
      ),
    ).toEqual([{ eventId: 'public-one', sequence: 1, duplicate: true }])
    expect(String(duplicate.lastEventId)).toBe('public-two')

    const exported = await repository.export(
      MemoryExportRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        limit: 1,
      }),
    )
    expect(MemoryExportOutcomeSchema.safeParse(exported).success).toBe(true)
    expect(exported.outcome).toBe('page')
    if (exported.outcome !== 'page') return
    expect(String(exported.events[0]?.eventId)).toBe('public-one')
    expect(exported.events[0]?.sequence).toBe(1)
    expect(String(exported.nextAfterEventId)).toBe('public-one')

    const secondPage = await repository.export(
      MemoryExportRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        afterEventId: 'public-one',
        limit: 10,
      }),
    )
    expect(secondPage.outcome).toBe('page')
    if (secondPage.outcome === 'page') {
      expect(
        secondPage.events.map(({ eventId, sequence }) => [
          String(eventId),
          sequence,
        ]),
      ).toEqual([['public-two', 2]])
      expect(secondPage.nextAfterEventId).toBeNull()
    }

    const invalidRequest = await repository.append({
      schemaVersion: 2,
      projectId: 'project-1',
      events: [],
    } as unknown as MemoryAppendRequest)
    expect(invalidRequest.outcome).toBe('rejected')
    expect(
      MemoryAppendRequestSchema.safeParse({
        ...request,
        events: [{ ...draft('producer-sequence'), sequence: 99 }],
      }).success,
    ).toBe(false)

    const conflict = await repository.append(
      MemoryAppendRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        expectedTail: { kind: 'event', eventId: 'public-one' },
        events: [draft('public-three')],
      }),
    )
    expect(conflict.outcome).toBe('rejected')
    if (conflict.outcome === 'rejected') {
      expect(conflict.error.code).toBe('conflict')
      expect(conflict.error.retryable).toBe(true)
    }

    const wrongProject = await repository.append({
      schemaVersion: 2,
      projectId: 'project-1',
      events: [draft('foreign', 'project-2')],
    } as unknown as MemoryAppendRequest)
    expect(wrongProject.outcome).toBe('rejected')

    const rebuilt = await repository.rebuild(
      MemoryRebuildRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        rebuildId: 'rebuild-1',
        projectionNames: ['tasks'],
      }),
    )
    const parsedRebuild = MemoryRebuildOutcomeSchema.parse(rebuilt)
    expect(parsedRebuild.outcome).toBe('rebuilt')
    if (parsedRebuild.outcome !== 'rebuilt') return
    expect(String(parsedRebuild.rebuildId)).toBe('rebuild-1')
    expect(parsedRebuild.processedEvents).toBe(2)
    const health = await repository.health(
      MemoryHealthRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
      }),
    )
    expect(MemoryHealthSchema.safeParse(health).success).toBe(true)
  })

  test('enforces empty, event, any, legacy, and equivalent dual tail preconditions atomically', async () => {
    const repository = await open(temporaryRepository())
    const append = (value: Record<string, unknown>) =>
      repository.append(
        MemoryAppendRequestSchema.parse({
          schemaVersion: 2,
          projectId: 'project-1',
          ...value,
        }),
      )
    expect(
      (
        await append({
          expectedTail: { kind: 'empty' },
          events: [draft('tail-one')],
        })
      ).outcome,
    ).toBe('appended')

    for (const request of [
      { expectedTail: { kind: 'empty' }, events: [draft('tail-empty-stale')] },
      {
        expectedTail: { kind: 'event', eventId: 'missing' },
        events: [draft('tail-event-stale')],
      },
      { expectedLastEventId: 'missing', events: [draft('tail-legacy-stale')] },
    ]) {
      const outcome = await append(request)
      expect(outcome).toMatchObject({
        outcome: 'rejected',
        error: { code: 'conflict', retryable: true },
      })
    }

    expect(
      (
        await append({
          expectedTail: { kind: 'any' },
          events: [draft('tail-any')],
        })
      ).outcome,
    ).toBe('appended')
    expect((await append({ events: [draft('tail-omitted')] })).outcome).toBe(
      'appended',
    )
    const tail = 'tail-omitted'
    expect(
      (
        await append({
          expectedTail: { kind: 'event', eventId: tail },
          expectedLastEventId: tail,
          events: [draft('tail-dual')],
        })
      ).outcome,
    ).toBe('appended')
    expect(
      MemoryAppendRequestSchema.safeParse({
        schemaVersion: 2,
        projectId: 'project-1',
        expectedTail: { kind: 'empty' },
        expectedLastEventId: 'tail-dual',
        events: [draft('tail-invalid-dual')],
      }).success,
    ).toBe(false)
  })

  test('keeps deterministic event ID content conflicts hard under a matching tail', async () => {
    const repository = await open(temporaryRepository())
    const first = await repository.append(
      MemoryAppendRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        expectedTail: { kind: 'empty' },
        events: [draft('same-id')],
      }),
    )
    expect(first.outcome).toBe('appended')
    const conflicting = draft('same-id')
    if (conflicting.eventType !== 'task.created')
      throw new Error('invalid fixture')
    conflicting.payload.title = 'Different deterministic content'
    const outcome = await repository.append(
      MemoryAppendRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        expectedTail: { kind: 'event', eventId: 'same-id' },
        events: [conflicting],
      }),
    )
    expect(outcome).toMatchObject({
      outcome: 'rejected',
      error: { retryable: false },
    })
  })

  test('binds the database to the first public project before any foreign mutation', async () => {
    const repository = await open(temporaryRepository())
    const first = await repository.append(
      MemoryAppendRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        events: [draft('bound')],
      }),
    )
    expect(first.outcome).toBe('appended')

    const foreignAppend = await repository.append(
      MemoryAppendRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-2',
        events: [draft('foreign', 'project-2')],
      }),
    )
    expect(foreignAppend.outcome).toBe('rejected')
    const unscopedAppend = await repository.appendEvents([
      event('unscoped-after-binding'),
    ])
    expect(unscopedAppend.status).toBe('error')
    if (unscopedAppend.status === 'error')
      expect(unscopedAppend.error.kind).toBe('invalid')
    const foreignQuery = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'foreign-query',
        projectId: 'project-2',
        sessionId: 'session-1',
        query: 'Task',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 10,
      }),
    )
    expect(foreignQuery.outcome).toBe('rejected')
    const foreignExport = await repository.export(
      MemoryExportRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-2',
        limit: 10,
      }),
    )
    expect(foreignExport.outcome).toBe('rejected')
    const foreignRebuild = await repository.rebuild(
      MemoryRebuildRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-2',
        rebuildId: 'foreign-rebuild',
        projectionNames: ['tasks'],
      }),
    )
    expect(foreignRebuild.outcome).toBe('rejected')
    const foreignVerify = await repository.verify(
      MemoryVerifyRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-2',
        sessionId: 'session-1',
        action: {
          kind: 'verify',
          observationId: 'observation-1',
          selector: { kind: 'file', path: 'src/example.ts' },
          observedDigest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      }),
    )
    expect(foreignVerify.outcome).toBe('rejected')

    const inventory = await repository.listEvents({ limit: 10 })
    expect(
      inventory.status === 'ok'
        ? inventory.events.map(({ eventId }) => eventId)
        : [],
    ).toEqual(['bound'])
    const projection = await repository.getProjectionSnapshot()
    expect(
      projection.status === 'ok'
        ? projection.tasks.map(({ entityId }) => entityId)
        : [],
    ).toEqual(['task-bound'])
  })

  test('retrieves idempotent verification retries after more than one thousand events', async () => {
    const repository = await open(temporaryRepository())
    const request = MemoryVerifyRequestSchema.parse({
      schemaVersion: 2,
      projectId: 'project-1',
      sessionId: 'session-1',
      action: {
        kind: 'verify',
        observationId: 'observation-1',
        selector: { kind: 'file', path: 'src/example.ts' },
        observedDigest:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    })
    const first = MemoryVerifyOutcomeSchema.parse(
      await repository.verify(request),
    )
    expect(first.outcome).toBe('recorded')
    const fillers = Array.from({ length: 1_001 }, (_, index) =>
      draft(`after-verify-${index}`),
    )
    for (let offset = 0; offset < fillers.length; offset += 100) {
      const appended = await repository.append(
        MemoryAppendRequestSchema.parse({
          schemaVersion: 2,
          projectId: 'project-1',
          events: fillers.slice(offset, offset + 100),
        }),
      )
      expect(appended.outcome).toBe('appended')
    }
    const retry = MemoryVerifyOutcomeSchema.parse(
      await repository.verify(request),
    )
    expect(retry.outcome).toBe('recorded')
    if (first.outcome === 'recorded' && retry.outcome === 'recorded') {
      expect(retry.event.eventId).toBe(first.event.eventId)
      expect(retry.event.sequence).toBe(first.event.sequence)
    }
  })

  test('rejects an existing database-path symlink before opening SQLite', async () => {
    const root = temporaryRepository()
    const target = join(root, 'target.sqlite')
    const database = new Database(target, { create: true })
    database.close()
    symlinkSync(target, join(root, 'linked.sqlite'))
    const opened = await BunSQLiteMemoryRepository.open({
      repositoryRoot: root,
      databasePath: 'linked.sqlite',
    })
    expect(opened.status).toBe('error')
    if (opened.status === 'error') {
      expect(opened.error.kind).toBe('incompatible')
      expect(opened.error.message).not.toContain(root)
    }
  })

  test('rejects dangling database and sidecar symlinks before writable open', async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const root = temporaryRepository()
      const memory = join(root, '.openbuff', 'memory')
      mkdirSync(memory, { recursive: true })
      const path = join(memory, 'memory-v2.sqlite')
      if (suffix) {
        const database = new Database(path, { create: true })
        database.close()
      }
      symlinkSync(join(root, 'missing-target'), `${path}${suffix}`)
      const opened = await openResult(root)
      expect(opened).toMatchObject({
        status: 'error',
        error: { kind: 'incompatible', retryable: false },
      })
    }
  })

  test('returns schema-valid public query and verify outcomes', async () => {
    const repository = await open(temporaryRepository())
    const queried = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'query-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        query: 'What changed?',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 10,
      }),
    )
    expect(MemoryQueryOutcomeSchema.safeParse(queried).success).toBe(true)
    expect(queried.outcome).toBe('result')

    const verified = await repository.verify(
      MemoryVerifyRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        sessionId: 'session-1',
        action: {
          kind: 'verify',
          observationId: 'observation-1',
          selector: { kind: 'file', path: 'src/example.ts' },
          observedDigest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      }),
    )
    expect(MemoryVerifyOutcomeSchema.safeParse(verified).success).toBe(true)
    expect(verified.outcome).toBe('recorded')
  })

  test('rejects path verification without a digest before appending', async () => {
    const repository = await open(temporaryRepository())
    const request = MemoryVerifyRequestSchema.parse({
      schemaVersion: 2,
      projectId: 'project-1',
      sessionId: 'session-1',
      action: {
        kind: 'verify',
        observationId: 'observation-1',
        selector: { kind: 'file', path: 'src/example.ts' },
      },
    })
    const rejected = await repository.verify(request)
    expect(rejected.outcome).toBe('rejected')
    if (rejected.outcome === 'rejected')
      expect(rejected.error.code).toBe('invalid-request')
    const listed = await repository.listEvents()
    expect(listed.status === 'ok' ? listed.events : []).toEqual([])
  })

  test('records schema-valid append-only verification events idempotently', async () => {
    const repository = await open(temporaryRepository())
    const request = MemoryVerifyRequestSchema.parse({
      schemaVersion: 2,
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceRevision: 1,
      workspaceSnapshotId: 'snapshot-1',
      action: {
        kind: 'verify',
        observationId: 'observation-1',
        selector: { kind: 'file', path: 'src/example.ts' },
        observedDigest:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    })
    const first = MemoryVerifyOutcomeSchema.parse(
      await repository.verify(request),
    )
    const second = MemoryVerifyOutcomeSchema.parse(
      await repository.verify(request),
    )
    expect(first.outcome).toBe('recorded')
    expect(second.outcome).toBe('recorded')
    if (first.outcome === 'recorded' && second.outcome === 'recorded') {
      expect(second.event.eventId).toBe(first.event.eventId)
      expect(second.event.sequence).toBe(first.event.sequence)
      expect(first.event.eventType).toBe('evidence.verified')
      if (first.event.eventType === 'evidence.verified') {
        expect(first.event.payload.observedDigest).toBe(
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        )
        expect(first.event.payload.workspaceRevision).toBe(1)
        expect(first.event.payload.workspaceSnapshotId).toBe('snapshot-1')
      }
    }
    const listed = await repository.listEvents()
    expect(listed.status === 'ok' ? listed.events.length : -1).toBe(1)
  })

  test('applies digest and paired workspace freshness contexts exactly', async () => {
    const repository = await open(temporaryRepository())
    const evidence = evidenceFixture()
    const observation = observationFixture('freshness', [evidence])
    const recorded = canonicalDraft(
      'observation.recorded',
      'freshness-observation',
      {
        payloadSchemaVersion: 1,
        observation,
      },
    )
    const verified = canonicalDraft('evidence.verified', 'freshness-verified', {
      payloadSchemaVersion: 1,
      observationId: 'freshness',
      selector: evidence.selector,
      verifier: 'test',
      verifiedAt: '2025-01-02T03:05:05.000Z',
      observedDigest: evidence.contentDigest,
    })
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [recorded, verified],
          }),
        )
      ).outcome,
    ).toBe('appended')

    const query = async (
      queryId: string,
      context: Record<string, unknown> = {},
    ) =>
      repository.query(
        MemoryRetrievalRequestSchema.parse({
          schemaVersion: 2,
          queryId,
          projectId: 'project-1',
          sessionId: 'session-1',
          query: 'Discovery freshness',
          selectors: [],
          artifactKinds: [],
          includeHistorical: false,
          maxResultsPerCategory: 10,
          ...context,
        }),
      )
    const noContext = await query('fresh-none')
    expect(
      noContext.outcome === 'result'
        ? noContext.result.verifiedKnowledge.length
        : 0,
    ).toBe(1)
    for (const [eventId, observedDigest] of [
      [
        'freshness-mismatch',
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ],
      ['freshness-missing', undefined],
    ] as const) {
      expect(
        (
          await repository.append(
            MemoryAppendRequestSchema.parse({
              schemaVersion: 2,
              projectId: 'project-1',
              events: [
                canonicalDraft('evidence.verified', eventId, {
                  payloadSchemaVersion: 1,
                  observationId: 'freshness',
                  selector: evidence.selector,
                  verifier: 'test',
                  verifiedAt: '2025-01-02T03:05:30.000Z',
                  ...(observedDigest ? { observedDigest } : {}),
                }),
              ],
            }),
          )
        ).outcome,
      ).toBe('appended')
      const result = await query(`${eventId}-query`)
      expect(
        result.outcome === 'result' ? result.result.verifiedKnowledge : [],
      ).toEqual([])
      expect(
        result.outcome === 'result' ? result.result.rereadRequired.length : 0,
      ).toBe(1)
    }
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [
              canonicalDraft('evidence.verified', 'freshness-context', {
                payloadSchemaVersion: 1,
                observationId: 'freshness',
                selector: evidence.selector,
                verifier: 'test',
                verifiedAt: '2025-01-02T03:06:05.000Z',
                observedDigest: evidence.contentDigest,
                workspaceRevision: 7,
                workspaceSnapshotId: 'snapshot-7',
              }),
            ],
          }),
        )
      ).outcome,
    ).toBe('appended')
    const exact = await query('fresh-exact', {
      workspaceRevision: 7,
      workspaceSnapshotId: 'snapshot-7',
    })
    expect(
      exact.outcome === 'result' ? exact.result.verifiedKnowledge.length : 0,
    ).toBe(1)
    for (const [queryId, context] of [
      [
        'fresh-revision-mismatch',
        { workspaceRevision: 8, workspaceSnapshotId: 'snapshot-7' },
      ],
      [
        'fresh-snapshot-mismatch',
        { workspaceRevision: 7, workspaceSnapshotId: 'snapshot-8' },
      ],
      ['fresh-pair-revision-only', { workspaceRevision: 7 }],
      ['fresh-pair-snapshot-only', { workspaceSnapshotId: 'snapshot-7' }],
    ] as const) {
      const result = await query(queryId, context)
      expect(
        result.outcome === 'result' ? result.result.verifiedKnowledge : [],
      ).toEqual([])
      expect(
        result.outcome === 'result' ? result.result.rereadRequired.length : 0,
      ).toBe(1)
    }
  })

  test('applies chunk selector digest (chunk.hash) and paired workspace freshness exactly', async () => {
    const repository = await open(temporaryRepository())
    const chunkDigest =
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const chunkSelector = {
      kind: 'chunk' as const,
      path: 'src/example.ts',
      chunkId: 'chunk-1',
      qualifiedName: 'example.chunk',
      startLine: 1,
      endLine: 10,
    }
    const chunkEvidence = {
      ...evidenceFixture('src/example.ts', chunkDigest),
      selector: chunkSelector,
      excerpt: 'chunk excerpt deterministic tokens',
    }
    const observation = observationFixture('chunk-freshness', [chunkEvidence])
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [
              canonicalDraft('observation.recorded', 'chunk-observation', {
                payloadSchemaVersion: 1,
                observation,
              }),
              canonicalDraft('evidence.verified', 'chunk-verified', {
                payloadSchemaVersion: 1,
                observationId: 'chunk-freshness',
                selector: chunkSelector,
                verifier: 'test',
                verifiedAt: '2025-01-02T03:05:05.000Z',
                observedDigest: chunkDigest,
              }),
            ],
          }),
        )
      ).outcome,
    ).toBe('appended')

    const query = async (
      queryId: string,
      context: Record<string, unknown> = {},
    ) =>
      repository.query(
        MemoryRetrievalRequestSchema.parse({
          schemaVersion: 2,
          queryId,
          projectId: 'project-1',
          sessionId: 'session-1',
          query: 'Chunk freshness deterministic',
          selectors: [],
          artifactKinds: [],
          includeHistorical: false,
          maxResultsPerCategory: 10,
          ...context,
        }),
      )
    // Same-snapshot (no-context) chunk verification counts as verified.
    const noContext = await query('chunk-fresh-none')
    expect(
      noContext.outcome === 'result'
        ? noContext.result.verifiedKnowledge.length
        : 0,
    ).toBe(1)
    if (noContext.outcome === 'result') {
      const [entry] = noContext.result.verifiedKnowledge
      expect(entry?.score).toBeGreaterThanOrEqual(0)
      expect(entry?.score).toBeLessThanOrEqual(1)
      // Digest-freshness boost is an explicit bounded verified-evidence
      // reason; the chunk contentDigest (chunk.hash) must match exactly.
      expect(
        entry?.reasons.some(
          ({ code, contribution }) =>
            code === 'verified-evidence' && contribution === 0.03,
        ),
      ).toBe(true)
    }
    // Any digest drift (mismatch or missing observedDigest) invalidates the
    // chunk: verified=0 and reread=1.
    for (const [eventId, observedDigest] of [
      [
        'chunk-mismatch',
        'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      ],
      ['chunk-missing', undefined],
    ] as const) {
      expect(
        (
          await repository.append(
            MemoryAppendRequestSchema.parse({
              schemaVersion: 2,
              projectId: 'project-1',
              events: [
                canonicalDraft('evidence.verified', eventId, {
                  payloadSchemaVersion: 1,
                  observationId: 'chunk-freshness',
                  selector: chunkSelector,
                  verifier: 'test',
                  verifiedAt: '2025-01-02T03:05:30.000Z',
                  ...(observedDigest ? { observedDigest } : {}),
                }),
              ],
            }),
          )
        ).outcome,
      ).toBe('appended')
      const result = await query(`${eventId}-query`)
      expect(
        result.outcome === 'result' ? result.result.verifiedKnowledge : [],
      ).toEqual([])
      expect(
        result.outcome === 'result' ? result.result.rereadRequired.length : 0,
      ).toBe(1)
    }
    // Paired revision/snapshot context: exact match verifies, any drift
    // (rev8, snap8, rev-only, snap-only) rereads.
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [
              canonicalDraft('evidence.verified', 'chunk-context', {
                payloadSchemaVersion: 1,
                observationId: 'chunk-freshness',
                selector: chunkSelector,
                verifier: 'test',
                verifiedAt: '2025-01-02T03:06:05.000Z',
                observedDigest: chunkDigest,
                workspaceRevision: 7,
                workspaceSnapshotId: 'snapshot-7',
              }),
            ],
          }),
        )
      ).outcome,
    ).toBe('appended')
    const exact = await query('chunk-fresh-exact', {
      workspaceRevision: 7,
      workspaceSnapshotId: 'snapshot-7',
    })
    expect(
      exact.outcome === 'result' ? exact.result.verifiedKnowledge.length : 0,
    ).toBe(1)
    for (const [queryId, context] of [
      [
        'chunk-revision-mismatch',
        { workspaceRevision: 8, workspaceSnapshotId: 'snapshot-7' },
      ],
      [
        'chunk-snapshot-mismatch',
        { workspaceRevision: 7, workspaceSnapshotId: 'snapshot-8' },
      ],
      ['chunk-pair-revision-only', { workspaceRevision: 7 }],
      ['chunk-pair-snapshot-only', { workspaceSnapshotId: 'snapshot-7' }],
    ] as const) {
      const result = await query(queryId, context)
      expect(
        result.outcome === 'result' ? result.result.verifiedKnowledge : [],
      ).toEqual([])
      expect(
        result.outcome === 'result' ? result.result.rereadRequired.length : 0,
      ).toBe(1)
    }
  })

  test('returns schema-valid empty lexical categories and advertises query and verify', async () => {
    const repository = await open(temporaryRepository())
    const queried = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'query-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        query: 'What changed?',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 10,
      }),
    )
    expect(MemoryQueryOutcomeSchema.safeParse(queried).success).toBe(true)
    expect(queried.outcome).toBe('result')
    if (queried.outcome === 'result') {
      expect(queried.result.verifiedKnowledge).toEqual([])
      expect(queried.result.rereadRequired).toEqual([])
    }
    const health = await repository.health(
      MemoryHealthRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
      }),
    )
    expect(health.backend.capabilities).toEqual(
      expect.arrayContaining(['query', 'verify']),
    )
  })

  test('returns a partial query when the aggregate payload budget is reached', async () => {
    const repository = await open(temporaryRepository())
    const large = 'x'.repeat(1024 * 1024)
    for (let index = 0; index < 9; index++) {
      const appended = await repository.appendEvents([
        event(`large-${index}`, {
          payload: { taskId: 'task-1', value: large },
          metadata: {
            projectId: 'project-1',
            schemaVersion: 2,
            eventSchemaVersion: 1,
          },
        }),
      ])
      expect(appended.status).toBe('ok')
    }
    const queried = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'budget-query',
        projectId: 'project-1',
        sessionId: 'session-1',
        query: 'large',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 10,
      }),
    )
    expect(queried.outcome).toBe('result')
    if (queried.outcome === 'result') {
      expect(queried.result.matchedTasks).toEqual([])
      expect(queried.result.degradation.state).toBe('degraded')
      if (queried.result.degradation.state === 'degraded') {
        expect(
          queried.result.degradation.reasons.map(({ code }) => code),
        ).toContain('resource-budget')
      }
    }
  })

  test('rejects malformed rows that claim a recognized canonical event type', async () => {
    const repository = await open(temporaryRepository())
    const appended = await repository.appendEvents([
      event('malformed-canonical', {
        eventType: 'task.created',
        payload: { taskId: 'task-1' },
        metadata: {
          projectId: 'project-1',
          schemaVersion: 2,
          eventSchemaVersion: 1,
          sessionId: 'session-1',
        },
      }),
    ])
    expect(appended.status).toBe('ok')

    const queried = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'malformed-query',
        projectId: 'project-1',
        sessionId: 'session-1',
        query: 'task',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 10,
      }),
    )
    expect(queried.outcome).toBe('failed')
  })

  test('omits absent optional metadata fields in low-level storage', async () => {
    const repository = await open(temporaryRepository())
    expect((await repository.appendEvents([event('metadata')])).status).toBe(
      'ok',
    )
    const database = new Database(repository.databasePath)
    try {
      const row = database
        .query('SELECT metadata_json FROM memory_events')
        .get() as {
        metadata_json: string
      }
      expect(row.metadata_json).toBe('{}')
    } finally {
      database.close()
    }
  })

  test('allows an exact lost-response retry despite a stale tail but rejects a mixed retry', async () => {
    const repository = await open(temporaryRepository())
    const append = (
      events: MemoryEventDraft[],
      expectedTail: Record<string, unknown>,
    ) =>
      repository.append(
        MemoryAppendRequestSchema.parse({
          schemaVersion: 2,
          projectId: 'project-1',
          events,
          expectedTail,
        }),
      )
    expect(
      (await append([draft('retry-one')], { kind: 'empty' })).outcome,
    ).toBe('appended')
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [draft('later')],
          }),
        )
      ).outcome,
    ).toBe('appended')
    const retry = await append([draft('retry-one')], { kind: 'empty' })
    expect(retry).toMatchObject({
      outcome: 'appended',
      entries: [{ duplicate: true }],
    })
    const mixed = await append([draft('retry-one'), draft('new-in-mixed')], {
      kind: 'empty',
    })
    expect(mixed).toMatchObject({
      outcome: 'rejected',
      error: { code: 'conflict' },
    })
    const listed = await repository.listEvents()
    expect(
      listed.status === 'ok' ? listed.events.map(({ eventId }) => eventId) : [],
    ).toEqual(['retry-one', 'later'])
  })

  test('binds a valid project-scoped low-level V2 append immediately', async () => {
    const repository = await open(temporaryRepository())
    const appended = await repository.appendEvents([
      event('canonical-low-level', {
        metadata: {
          projectId: 'project-1',
          schemaVersion: 2,
          eventSchemaVersion: 1,
        },
      }),
    ])
    expect(appended.status).toBe('ok')
    expect(projectBindingState(repository)).toEqual({
      events: 1,
      tasks: 0,
      projectId: 'project-1',
    })
  })

  test('keeps legacy writes unbound until canonical binding and then rejects unscoped writes', async () => {
    const repository = await open(temporaryRepository())
    expect(
      (await repository.appendEvents([event('legacy-before-binding')])).status,
    ).toBe('ok')
    expect(projectBindingState(repository).projectId).toBeNull()

    expect(
      (
        await repository.appendEvents([
          event('canonical-after-legacy', {
            metadata: {
              projectId: 'project-1',
              schemaVersion: 2,
              eventSchemaVersion: 1,
            },
          }),
        ])
      ).status,
    ).toBe('ok')
    expect(projectBindingState(repository).projectId).toBe('project-1')

    const unscoped = await repository.appendEvents([
      event('legacy-after-binding'),
    ])
    expect(unscoped).toMatchObject({
      status: 'error',
      error: { kind: 'invalid' },
    })
    expect(projectBindingState(repository)).toEqual({
      events: 2,
      tasks: 1,
      projectId: 'project-1',
    })
  })

  test('rejects malformed and mixed low-level project identities atomically', async () => {
    const batches: MemoryV2EventInput[][] = [
      [
        event('missing-project', {
          metadata: { schemaVersion: 2, eventSchemaVersion: 1 },
        }),
      ],
      [
        event('invalid-project', {
          metadata: {
            projectId: 'not a valid project',
            schemaVersion: 2,
            eventSchemaVersion: 1,
          },
        }),
      ],
      [
        event('mixed-project-one', {
          metadata: {
            projectId: 'project-1',
            schemaVersion: 2,
            eventSchemaVersion: 1,
          },
        }),
        event('mixed-project-two', {
          metadata: {
            projectId: 'project-2',
            schemaVersion: 2,
            eventSchemaVersion: 1,
          },
        }),
      ],
      [
        event('valid-before-missing', {
          metadata: {
            projectId: 'project-1',
            schemaVersion: 2,
            eventSchemaVersion: 1,
          },
        }),
        event('missing-after-valid', {
          metadata: { schemaVersion: 2, eventSchemaVersion: 1 },
        }),
      ],
      [
        event('canonical-before-unscoped', {
          metadata: {
            projectId: 'project-1',
            schemaVersion: 2,
            eventSchemaVersion: 1,
          },
        }),
        event('unscoped-legacy-in-canonical-batch'),
      ],
    ]

    for (const batch of batches) {
      const repository = await open(temporaryRepository())
      const rejected = await repository.appendEvents(batch)
      expect(rejected).toMatchObject({
        status: 'error',
        error: { kind: 'invalid' },
      })
      expect(projectBindingState(repository)).toEqual({
        events: 0,
        tasks: 0,
        projectId: null,
      })
    }
  })

  test('uses UTF-8 byte admission and does not parse an excluded oversized newest row', async () => {
    const repository = await open(temporaryRepository())
    expect(
      (
        await repository.appendEvents([
          event('valid-small', {
            metadata: {
              projectId: 'project-1',
              schemaVersion: 2,
              eventSchemaVersion: 1,
            },
          }),
        ])
      ).status,
    ).toBe('ok')
    expect(
      (
        await repository.appendEvents([
          event('oversized-malformed', {
            eventType: 'task.created',
            payload: { taskId: 'task-1', value: '😀'.repeat(2_100_000) },
            metadata: {
              projectId: 'project-1',
              schemaVersion: 2,
              eventSchemaVersion: 1,
              sessionId: 'session-1',
            },
          }),
        ])
      ).status,
    ).toBe('ok')
    const queried = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'oversized-query',
        projectId: 'project-1',
        sessionId: 'session-1',
        query: 'valid',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 10,
      }),
    )
    expect(queried.outcome).toBe('result')
    if (queried.outcome === 'result') {
      expect(queried.result.degradation).toMatchObject({
        state: 'degraded',
        reasons: [{ code: 'resource-budget' }],
      })
    }
  })

  test('admits the deterministic newest ten thousand events and reports the event cap', async () => {
    const root = temporaryRepository()
    const repository = await open(root)
    const database = new Database(repository.databasePath)
    try {
      const insert = database.query(
        `INSERT INTO memory_events (
           event_id, idempotency_key, event_type, occurred_at, payload_json,
           metadata_json, task_id, session_id, artifact_id
         ) VALUES (?1, ?2, ?3, '2025-01-02T03:04:05.000Z', ?4, ?5, ?6, 'session-1', NULL)`,
      )
      database.exec('BEGIN IMMEDIATE')
      const metadata = JSON.stringify({
        schemaVersion: 2,
        eventSchemaVersion: 1,
        projectId: 'project-1',
        sessionId: 'session-1',
      })
      insert.run(
        'cap-oldest',
        'key-cap-oldest',
        'task.created',
        JSON.stringify({
          payloadSchemaVersion: 1,
          taskId: 'task-oldest',
          title: 'Excluded oldest',
          objective:
            'This semantic candidate must be outside the newest-first admission set.',
          initialStatus: 'created',
        }),
        metadata,
        'task-oldest',
      )
      for (let index = 0; index < 10_000; index++) {
        insert.run(
          `cap-${index}`,
          `key-cap-${index}`,
          'unsupported.low-level',
          '{}',
          metadata,
          null,
        )
      }
      database
        .query(
          "INSERT INTO memory_projection_metadata(key, value) VALUES ('project_id', 'project-1')",
        )
        .run()
      database.exec('COMMIT')
    } finally {
      database.close()
    }
    const queried = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'cap-query',
        projectId: 'project-1',
        sessionId: 'session-1',
        query: 'unsupported',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 10,
      }),
    )
    expect(queried.outcome).toBe('result')
    if (queried.outcome === 'result') {
      expect(queried.result.matchedTasks).toEqual([])
      expect(queried.result.verifiedKnowledge).toEqual([])
      expect(queried.result.degradation).toMatchObject({
        state: 'degraded',
        reasons: [{ code: 'result-cap-reached' }],
      })
    }
  })

  test('rejects malformed claimed-v2 schema before mutating database bytes', async () => {
    for (const damage of [
      'DROP TRIGGER memory_events_no_update',
      'DROP TABLE memory_store_capabilities',
      'ALTER TABLE memory_sessions RENAME COLUMN task_id TO missing_task_id',
    ]) {
      const root = temporaryRepository()
      const repository = await open(root)
      const path = repository.databasePath
      await repository.close()
      const database = new Database(path)
      database.exec(damage)
      database.close()
      const before = readFileSync(path)
      const opened = await openResult(root)
      expect(opened).toMatchObject({
        status: 'error',
        error: { kind: 'incompatible', retryable: false },
      })
      expect(readFileSync(path)).toEqual(before)
    }
  })

  test('rejects nonregular database sidecars before opening', async () => {
    const root = temporaryRepository()
    const memory = join(root, '.openbuff', 'memory')
    mkdirSync(memory, { recursive: true })
    const path = join(memory, 'memory-v2.sqlite')
    const database = new Database(path, { create: true })
    database.close()
    mkdirSync(`${path}-wal`)
    const opened = await BunSQLiteMemoryRepository.open({
      repositoryRoot: root,
    })
    expect(opened).toMatchObject({
      status: 'error',
      error: { kind: 'incompatible' },
    })
  })

  test('canonical rows cannot be updated or deleted', async () => {
    const repository = await open(temporaryRepository())
    await repository.appendEvents([event('immutable')])
    const database = new Database(repository.databasePath)
    try {
      expect(() =>
        database.exec("UPDATE memory_events SET event_type = 'changed'"),
      ).toThrow('canonical memory events are append only')
      expect(() => database.exec('DELETE FROM memory_events')).toThrow(
        'canonical memory events are append only',
      )
    } finally {
      database.close()
    }
  })

  test('returns latest coverage per dimension with exact workspace context', async () => {
    const repository = await open(temporaryRepository())
    const coverage = (eventId: string, dimension: string, state: string) =>
      canonicalDraft('coverage.recorded', eventId, {
        payloadSchemaVersion: 1,
        taskId: 'task-1',
        dimension,
        state,
        selectors: [],
        notes: `${dimension}-${state}-notes`,
        workspaceRevision: 3,
        workspaceSnapshotId: 'snapshot-3',
      })
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [
              coverage('coverage-tests-old', 'tests', 'partial'),
              coverage('coverage-tests-new', 'tests', 'covered'),
              coverage('coverage-risk', 'risk', 'partial'),
            ],
          }),
        )
      ).outcome,
    ).toBe('appended')

    const matching = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'coverage-match',
        projectId: 'project-1',
        sessionId: 'session-1',
        query: 'coverage',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 10,
        workspaceRevision: 3,
        workspaceSnapshotId: 'snapshot-3',
      }),
    )
    expect(matching.outcome).toBe('result')
    if (matching.outcome !== 'result') return
    const taskId = TaskIdSchema.parse('task-1')
    expect(matching.result.currentCoverage).toEqual([
      {
        dimension: 'risk',
        state: 'partial',
        taskId,
        notes: 'risk-partial-notes',
        workspaceRevision: 3,
        workspaceSnapshotId: 'snapshot-3',
      },
      {
        dimension: 'tests',
        state: 'covered',
        taskId,
        notes: 'tests-covered-notes',
        workspaceRevision: 3,
        workspaceSnapshotId: 'snapshot-3',
      },
    ])

    const mismatched = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'coverage-mismatch',
        projectId: 'project-1',
        sessionId: 'session-1',
        query: 'coverage',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 10,
        workspaceRevision: 4,
        workspaceSnapshotId: 'snapshot-3',
      }),
    )
    expect(mismatched.outcome).toBe('result')
    if (mismatched.outcome !== 'result') return
    expect(mismatched.result.currentCoverage).toEqual([])
  })

  test('tolerantly skips and counts an unknown-type row so an older reader can export a newer store', async () => {
    const repository = await open(temporaryRepository())
    const appended = await repository.append(
      MemoryAppendRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        events: [draft('known-one')],
      }),
    )
    expect(appended.outcome).toBe('appended')

    // Direct raw INSERT of a future/unknown event type carrying valid
    // schemaVersion-2 metadata for the SAME project. INSERT (not UPDATE or
    // DELETE) is permitted by the append-only triggers.
    const database = new Database(repository.databasePath)
    try {
      database
        .query(
          `INSERT INTO memory_events (
             event_id, idempotency_key, event_type, occurred_at, payload_json,
             metadata_json, task_id, session_id, artifact_id
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .run(
          'future-unknown-1',
          'key-future-unknown-1',
          'future.unknown.event',
          '2025-01-02T03:04:05.000Z',
          '{}',
          JSON.stringify({
            schemaVersion: 2,
            eventSchemaVersion: 1,
            projectId: 'project-1',
            sessionId: 'session-1',
          }),
          null,
          'session-1',
          null,
        )
    } finally {
      database.close()
    }

    const exported = await repository.export(
      MemoryExportRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        limit: 100,
      }),
    )
    expect(MemoryExportOutcomeSchema.safeParse(exported).success).toBe(true)
    expect(exported.outcome).toBe('page')
    if (exported.outcome !== 'page') return
    const ids = exported.events.map(({ eventId }) => String(eventId))
    expect(ids).toContain('known-one')
    expect(ids).not.toContain('future-unknown-1')
    expect(exported.skippedUnknownCount).toBe(1)
  })

  test('fails the export (never silently drops) when a KNOWN canonical-type row cannot be strict-decoded, while still skip-and-counting unknown types', async () => {
    const repository = await open(temporaryRepository())
    const appended = await repository.append(
      MemoryAppendRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        events: [draft('known-one')],
      }),
    )
    expect(appended.outcome).toBe('appended')

    // Raw INSERT a row claiming a KNOWN canonical event_type
    // ('migration.v1.imported') but carrying a malformed payload that fails
    // strict envelope reconstruction, plus a genuinely UNKNOWN type row. A
    // known-type strict-decode failure must be a hard error (non-'page'
    // outcome), never a silent skip-and-count that would hide a migration
    // marker.
    const database = new Database(repository.databasePath)
    try {
      database
        .query(
          `INSERT INTO memory_events (
             event_id, idempotency_key, event_type, occurred_at, payload_json,
             metadata_json, task_id, session_id, artifact_id
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .run(
          'future-unknown-marker',
          'key-future-unknown-marker',
          'future.unknown.event',
          '2025-01-02T03:04:05.000Z',
          '{}',
          JSON.stringify({
            schemaVersion: 2,
            eventSchemaVersion: 1,
            projectId: 'project-1',
            sessionId: 'session-1',
          }),
          null,
          'session-1',
          null,
        )
      database
        .query(
          `INSERT INTO memory_events (
             event_id, idempotency_key, event_type, occurred_at, payload_json,
             metadata_json, task_id, session_id, artifact_id
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .run(
          'malformed-known-marker',
          'key-malformed-known-marker',
          'migration.v1.imported',
          '2025-01-02T03:04:06.000Z',
          '{"totally":"malformed"}',
          JSON.stringify({
            schemaVersion: 2,
            eventSchemaVersion: 1,
            projectId: 'project-1',
            sessionId: 'session-1',
          }),
          null,
          'session-1',
          null,
        )
    } finally {
      database.close()
    }

    const exported = await repository.export(
      MemoryExportRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        limit: 100,
      }),
    )
    expect(MemoryExportOutcomeSchema.safeParse(exported).success).toBe(true)
    // The known-type strict-decode failure surfaces loudly rather than being
    // silently dropped from events[].
    expect(exported.outcome).not.toBe('page')
    expect(['failed', 'rejected']).toContain(exported.outcome)
  })

  test('exports known current query.* and projection.rebuild.* envelopes without dropping or miscounting them', async () => {
    const repository = await open(temporaryRepository())
    const appended = await repository.append(
      MemoryAppendRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        events: [
          draft('current-task'),
          canonicalDraft('query.started', 'current-query-started', {
            payloadSchemaVersion: 1,
            queryId: 'query-1',
            taskId: 'task-current',
            userInputId: 'input-1',
            mode: 'inject',
            startedAt: '2025-01-02T03:04:05.000Z',
          }),
          canonicalDraft('query.completed', 'current-query-completed', {
            payloadSchemaVersion: 1,
            queryId: 'query-1',
            taskId: 'task-current',
            completedAt: '2025-01-02T03:04:06.000Z',
            counts: {
              matchedTasks: 0,
              verifiedKnowledge: 0,
              reusableDiscovery: 0,
              rereadRequired: 0,
              historicalContext: 0,
            },
            degradation: { state: 'none' },
          }),
          canonicalDraft('query.failed', 'current-query-failed', {
            payloadSchemaVersion: 1,
            queryId: 'query-2',
            taskId: 'task-current',
            failedAt: '2025-01-02T03:04:07.000Z',
            error: 'deterministic failure',
            retryable: false,
          }),
          canonicalDraft(
            'projection.rebuild.requested',
            'current-rebuild-requested',
            {
              payloadSchemaVersion: 1,
              rebuildId: 'rebuild-1',
              projectionNames: ['tasks'],
              requestedBy: 'test',
            },
          ),
          canonicalDraft(
            'projection.rebuild.completed',
            'current-rebuild-completed',
            {
              payloadSchemaVersion: 1,
              rebuildId: 'rebuild-1',
              projectionNames: ['tasks'],
              processedEvents: 1,
              completedAt: '2025-01-02T03:04:08.000Z',
            },
          ),
          canonicalDraft('projection.rebuild.failed', 'current-rebuild-failed', {
            payloadSchemaVersion: 1,
            rebuildId: 'rebuild-2',
            projectionNames: ['tasks'],
            error: 'deterministic rebuild failure',
            retryable: true,
            failedAt: '2025-01-02T03:04:09.000Z',
          }),
        ],
      }),
    )
    expect(appended.outcome).toBe('appended')

    const exported = await repository.export(
      MemoryExportRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        limit: 100,
      }),
    )
    expect(MemoryExportOutcomeSchema.safeParse(exported).success).toBe(true)
    expect(exported.outcome).toBe('page')
    if (exported.outcome !== 'page') return
    const ids = exported.events.map(({ eventId }) => String(eventId))
    expect(ids).toEqual([
      'current-task',
      'current-query-started',
      'current-query-completed',
      'current-query-failed',
      'current-rebuild-requested',
      'current-rebuild-completed',
      'current-rebuild-failed',
    ])
    // Known current envelope types are never treated as unknown/future types.
    expect(exported.skippedUnknownCount).toBe(0)
  })

  test('legally returns an empty export page paired with a non-null advancing cursor and the raw tail id when a full page is skipped', async () => {
    const repository = await open(temporaryRepository())
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [draft('known-head')],
          }),
        )
      ).outcome,
    ).toBe('appended')

    // Raw-insert a contiguous block of future/unknown-type rows for the SAME
    // project between two known events. INSERT is permitted by the append-only
    // triggers. With a limit of 2 the middle page is a full page of only
    // dropped rows. export() is now a SINGLE raw page per call, so that page
    // legally surfaces events: [] with a non-null advancing cursor and a
    // rawTailEventId carrying the last raw row id; consumers page on the
    // cursor, never on events.length.
    const database = new Database(repository.databasePath)
    try {
      const insert = database.query(
        `INSERT INTO memory_events (
           event_id, idempotency_key, event_type, occurred_at, payload_json,
           metadata_json, task_id, session_id, artifact_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      const metadata = JSON.stringify({
        schemaVersion: 2,
        eventSchemaVersion: 1,
        projectId: 'project-1',
        sessionId: 'session-1',
      })
      for (let index = 0; index < 3; index++) {
        insert.run(
          `future-${index}`,
          `key-future-${index}`,
          'future.unknown.event',
          '2025-01-02T03:04:05.000Z',
          '{}',
          metadata,
          null,
          'session-1',
          null,
        )
      }
    } finally {
      database.close()
    }
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [draft('known-tail')],
          }),
        )
      ).outcome,
    ).toBe('appended')

    const seen: string[] = []
    let totalSkipped = 0
    let sawEmptyAdvancingPage = false
    let afterEventId: string | undefined
    for (let page = 0; page < 20; page++) {
      const outcome = await repository.export(
        MemoryExportRequestSchema.parse({
          schemaVersion: 2,
          projectId: 'project-1',
          ...(afterEventId ? { afterEventId } : {}),
          limit: 2,
        }),
      )
      expect(MemoryExportOutcomeSchema.safeParse(outcome).success).toBe(true)
      expect(outcome.outcome).toBe('page')
      if (outcome.outcome !== 'page') return
      const skipped = outcome.skippedUnknownCount ?? 0
      totalSkipped += skipped
      // A full page of only dropped rows is now LEGAL: empty events[] paired
      // with a non-null advancing cursor and a rawTailEventId == last raw id.
      if (outcome.events.length === 0 && outcome.nextAfterEventId) {
        sawEmptyAdvancingPage = true
        expect(String(outcome.rawTailEventId)).toBe(
          String(outcome.nextAfterEventId),
        )
      }
      for (const event of outcome.events) seen.push(String(event.eventId))
      if (!outcome.nextAfterEventId) break
      afterEventId = String(outcome.nextAfterEventId)
    }
    expect(seen).toEqual(['known-head', 'known-tail'])
    expect(totalSkipped).toBe(3)
    expect(sawEmptyAdvancingPage).toBe(true)
  })

  test('returns a single raw page with rawTailEventId == the last raw row id on terminal and decoded-tail-skipped pages', async () => {
    const repository = await open(temporaryRepository())
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [draft('raw-tail-head')],
          }),
        )
      ).outcome,
    ).toBe('appended')
    // Raw-insert a future/unknown-type row as the store tail: it is the last
    // raw row but is skipped from events[].
    const database = new Database(repository.databasePath)
    try {
      database
        .query(
          `INSERT INTO memory_events (
             event_id, idempotency_key, event_type, occurred_at, payload_json,
             metadata_json, task_id, session_id, artifact_id
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .run(
          'raw-tail-future',
          'key-raw-tail-future',
          'future.unknown.event',
          '2025-01-02T03:04:05.000Z',
          '{}',
          JSON.stringify({
            schemaVersion: 2,
            eventSchemaVersion: 1,
            projectId: 'project-1',
            sessionId: 'session-1',
          }),
          null,
          'session-1',
          null,
        )
    } finally {
      database.close()
    }

    // Terminal page (limit exceeds row count): cursor is null, rawTailEventId
    // is the last RAW row (the skipped future row), NOT the last decoded event.
    const terminal = await repository.export(
      MemoryExportRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        limit: 100,
      }),
    )
    expect(terminal.outcome).toBe('page')
    if (terminal.outcome !== 'page') return
    expect(terminal.events.map(({ eventId }) => String(eventId))).toEqual([
      'raw-tail-head',
    ])
    expect(terminal.nextAfterEventId).toBeNull()
    expect(String(terminal.rawTailEventId)).toBe('raw-tail-future')
    expect(terminal.skippedUnknownCount).toBe(1)

    // Decoded-tail-skipped full page (limit === row count): the decoded tail
    // is the head event, but rawTailEventId is the skipped future row and the
    // cursor advances to it.
    const fullPage = await repository.export(
      MemoryExportRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        limit: 2,
      }),
    )
    expect(fullPage.outcome).toBe('page')
    if (fullPage.outcome !== 'page') return
    expect(fullPage.events.map(({ eventId }) => String(eventId))).toEqual([
      'raw-tail-head',
    ])
    expect(String(fullPage.nextAfterEventId)).toBe('raw-tail-future')
    expect(String(fullPage.rawTailEventId)).toBe('raw-tail-future')
    expect(fullPage.skippedUnknownCount).toBe(1)
  })

  test('omits rawTailEventId on an empty store export', async () => {
    const repository = await open(temporaryRepository())
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [draft('empty-store-anchor')],
          }),
        )
      ).outcome,
    ).toBe('appended')
    // Page after the only row observes zero raw rows.
    const exported = await repository.export(
      MemoryExportRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        afterEventId: 'empty-store-anchor',
        limit: 100,
      }),
    )
    expect(MemoryExportOutcomeSchema.safeParse(exported).success).toBe(true)
    expect(exported.outcome).toBe('page')
    if (exported.outcome !== 'page') return
    expect(exported.events).toEqual([])
    expect(exported.nextAfterEventId).toBeNull()
    expect(exported.rawTailEventId).toBeUndefined()
    expect('rawTailEventId' in exported).toBe(false)
  })
})

describe('BunSQLiteMemoryRepository privileged GC', () => {
  test('getStoreStats returns non-negative counts and grows with appends', async () => {
    const repository = await open(temporaryRepository())
    const empty = await repository.getStoreStats({ projectId: 'project-1' })
    expect(empty.eventCount).toBe(0)
    expect(empty.bytes).toBeGreaterThanOrEqual(0)
    const appended = await repository.append(
      MemoryAppendRequestSchema.parse({
        schemaVersion: 2,
        projectId: 'project-1',
        events: [draft('gc-stats-one'), draft('gc-stats-two')],
      }),
    )
    expect(appended.outcome).toBe('appended')
    const after = await repository.getStoreStats({ projectId: 'project-1' })
    expect(after.eventCount).toBe(2)
    expect(after.bytes).toBeGreaterThanOrEqual(0)
    expect(after.bytes).toBeGreaterThanOrEqual(empty.bytes)
  })

  test('selectGCandidates returns stale and old events, excludes archived, and respects maxEvents', async () => {
    const repository = await open(temporaryRepository())
    const now = new Date().toISOString()
    const oldObservation = canonicalDraft('observation.recorded', 'event:gc-old-1', {
      payloadSchemaVersion: 1,
      observation: observationFixture('gc-old-1', []),
    })
    const staleForgotten = MemoryEventDraftSchema.parse({
      schemaVersion: 2,
      eventSchemaVersion: 1,
      eventType: 'claim.forgotten',
      eventId: 'event:gc-forgotten-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      occurredAt: now,
      payload: {
        payloadSchemaVersion: 1,
        observationIds: ['gc-old-1'],
        reason: 'user-request',
        requestedBy: 'test',
        evidenceDisposition: 'retain-artifacts',
      },
    })
    const freshTask = MemoryEventDraftSchema.parse({
      schemaVersion: 2,
      eventSchemaVersion: 1,
      eventType: 'task.created',
      eventId: 'event:gc-fresh-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      occurredAt: now,
      payload: {
        payloadSchemaVersion: 1,
        taskId: 'task-gc-fresh-1',
        title: 'Fresh task',
        objective: 'Not eligible for GC.',
        initialStatus: 'created',
      },
    })
    const archivedHash = `sha256:${'a'.repeat(64)}`
    const archivedAt = now
    const archivedClaim = MemoryEventDraftSchema.parse({
      schemaVersion: 2,
      eventSchemaVersion: 1,
      eventType: 'claim.archived',
      eventId: 'event:gc-archived-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      occurredAt: now,
      payload: {
        payloadSchemaVersion: 1,
        archivedEventIds: ['event:gc-old-1'],
        archivePath: '.openbuff/memory/archive/gc-select.jsonl',
        archiveHash: archivedHash,
        reason: 'seed archived event',
        archivedAt,
      },
    })
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [oldObservation, staleForgotten, freshTask, archivedClaim],
          }),
        )
      ).outcome,
    ).toBe('appended')
    const selected = await repository.selectGCandidates({
      projectId: 'project-1',
      olderThanDays: 30,
      maxEvents: 10,
    })
    expect(selected.eventIds.map(String)).toContain('event:gc-old-1')
    expect(selected.eventIds.map(String)).toContain('event:gc-forgotten-1')
    expect(selected.eventIds.map(String)).not.toContain('event:gc-fresh-1')
    expect(selected.eventIds.map(String)).not.toContain('event:gc-archived-1')
    const capped = await repository.selectGCandidates({
      projectId: 'project-1',
      olderThanDays: 30,
      maxEvents: 1,
    })
    expect(capped.eventIds).toHaveLength(1)
  })

  test('selectGCandidates validates olderThanDays and maxEvents bounds', async () => {
    const repository = await open(temporaryRepository())
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events: [draft('gc-bounds')],
          }),
        )
      ).outcome,
    ).toBe('appended')
    for (const request of [
      { projectId: 'project-1', olderThanDays: 0, maxEvents: 10 },
      { projectId: 'project-1', olderThanDays: 400, maxEvents: 10 },
      { projectId: 'project-1', olderThanDays: 30, maxEvents: 0 },
      { projectId: 'project-1', olderThanDays: 30, maxEvents: 20000 },
    ]) {
      const failure = await repository
        .selectGCandidates(request)
        .then(() => null)
        .catch((error: unknown) => error as { failure: { kind: string } })
      expect(failure?.failure?.kind).toBe('invalid')
    }
  })

  test('privilegedCompact archives eligible events and keeps the store readable', async () => {
    const repository = await open(temporaryRepository())
    const events = [
      canonicalDraft('observation.recorded', 'event:gc-compact-1', {
        payloadSchemaVersion: 1,
        observation: observationFixture('gc-compact-1', []),
      }),
      canonicalDraft('observation.recorded', 'event:gc-compact-2', {
        payloadSchemaVersion: 1,
        observation: observationFixture('gc-compact-2', []),
      }),
      canonicalDraft('claim.forgotten', 'event:gc-compact-forgotten', {
        payloadSchemaVersion: 1,
        observationIds: ['gc-compact-1'],
        reason: 'duplicate',
        requestedBy: 'test',
        evidenceDisposition: 'retain-artifacts',
      }),
    ]
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events,
          }),
        )
      ).outcome,
    ).toBe('appended')
    const eventIds = [
      'event:gc-compact-1',
      'event:gc-compact-2',
      'event:gc-compact-forgotten',
    ] as const
    const archiveLines = eventIds.map((eventId) => JSON.stringify({ eventId }))
    const archiveHash = `sha256:${createHash('sha256').update(JSON.stringify(archiveLines)).digest('hex')}`
    const archivedAt = new Date().toISOString()
    const archivePath = '.openbuff/memory/archive/gc-compact.jsonl'
    const archiveClaimDraft = MemoryEventDraftSchema.parse({
      schemaVersion: 2,
      eventSchemaVersion: 1,
      eventType: 'claim.archived',
      eventId: 'event:gc-compact-archive',
      projectId: 'project-1',
      sessionId: 'session-1',
      occurredAt: archivedAt,
      payload: {
        payloadSchemaVersion: 1,
        archivedEventIds: [...eventIds],
        archivePath,
        archiveHash,
        reason: 'Privileged compaction test',
        archivedAt,
      },
    })
    const result = await repository.privilegedCompact({
      projectId: ProjectIdSchema.parse('project-1'),
      eventIds: [...eventIds] as unknown as Parameters<BunSQLiteMemoryRepository['privilegedCompact']>[0]['eventIds'],
      archiveClaimDraft,
      archiveLines,
      archivePath,
      archiveHash,
    })
    expect(result.archivedEventIds.map(String)).toEqual([...eventIds])
    expect(result.beforeCount).toBe(3)
    expect(result.afterCount).toBe(1)
    expect(result.beforeBytes).toBeGreaterThanOrEqual(0)
    expect(result.afterBytes).toBeGreaterThanOrEqual(0)
    const listed = await repository.listEvents()
    expect(listed.status).toBe('ok')
    if (listed.status !== 'ok') return
    const remainingIds = listed.events.map(({ eventId }) => eventId)
    for (const eventId of eventIds) expect(remainingIds).not.toContain(eventId)
    expect(remainingIds).toContain('event:gc-compact-archive')
    expect(
      listed.events.find(({ eventId }) => eventId === 'event:gc-compact-archive')?.eventType,
    ).toBe('claim.archived')
    const snapshot = await repository.getProjectionSnapshot()
    expect(snapshot.status).toBe('ok')
    if (snapshot.status !== 'ok') return
    for (const eventId of eventIds) {
      const row = snapshot.claims.find(({ entityId }) => entityId === eventId)
      expect(row?.state).toMatchObject({ lifecycle: 'archived' })
    }
    const probe = new Database(repository.databasePath)
    try {
      expect(() => probe.exec('DELETE FROM memory_events')).toThrow(
        'canonical memory events are append only',
      )
    } finally {
      probe.close()
    }
    const readable = await repository.listEvents()
    expect(readable.status).toBe('ok')
    expect(await repository.getStoreStats({ projectId: 'project-1' })).toMatchObject({
      eventCount: 1,
    })
  })

  test('privilegedCompact rejects hash mismatch and unknown ids without mutation', async () => {
    const repository = await open(temporaryRepository())
    const events = [
      canonicalDraft('observation.recorded', 'event:gc-reject-1', {
        payloadSchemaVersion: 1,
        observation: observationFixture('gc-reject-1', []),
      }),
      canonicalDraft('observation.recorded', 'event:gc-reject-2', {
        payloadSchemaVersion: 1,
        observation: observationFixture('gc-reject-2', []),
      }),
    ]
    expect(
      (
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId: 'project-1',
            events,
          }),
        )
      ).outcome,
    ).toBe('appended')
    const countEvents = async () => {
      const listed = await repository.listEvents()
      return listed.status === 'ok' ? listed.events.map(({ eventId }) => eventId) : []
    }
    const beforeIds = await countEvents()
    expect(beforeIds).toHaveLength(2)
    const archiveLines = ['event:gc-reject-1', 'event:gc-reject-2'].map((eventId) =>
      JSON.stringify({ eventId }),
    )
    const goodHash = `sha256:${createHash('sha256').update(JSON.stringify(archiveLines)).digest('hex')}`
    const archivedAt = new Date().toISOString()
    const buildClaim = (archiveHash: string, archivedEventIds: string[], eventId: string) =>
      MemoryEventDraftSchema.parse({
        schemaVersion: 2,
        eventSchemaVersion: 1,
        eventType: 'claim.archived',
        eventId,
        projectId: 'project-1',
        sessionId: 'session-1',
        occurredAt: archivedAt,
        payload: {
          payloadSchemaVersion: 1,
          archivedEventIds,
          archivePath: '.openbuff/memory/archive/gc-reject.jsonl',
          archiveHash,
          reason: 'Privileged compaction reject test',
          archivedAt,
        },
      })
    const badHash = `sha256:${'b'.repeat(64)}`
    const badClaim = buildClaim(badHash, ['event:gc-reject-1', 'event:gc-reject-2'], 'event:gc-reject-bad')
    const badFailure = await repository
      .privilegedCompact({
        projectId: ProjectIdSchema.parse('project-1'),
        eventIds: ['event:gc-reject-1', 'event:gc-reject-2'] as unknown as Parameters<BunSQLiteMemoryRepository['privilegedCompact']>[0]['eventIds'],
        archiveClaimDraft: badClaim,
        archiveLines,
        archivePath: '.openbuff/memory/archive/gc-reject.jsonl',
        archiveHash: badHash,
      })
      .then(() => null)
      .catch((error: unknown) => error as { failure: { kind: string } })
    expect(badFailure?.failure?.kind).toBe('invalid')
    expect(await countEvents()).toEqual(beforeIds)
    const unknownIds = ['event:gc-missing-1']
    const unknownLines = unknownIds.map((eventId) => JSON.stringify({ eventId }))
    const unknownHash = `sha256:${createHash('sha256').update(JSON.stringify(unknownLines)).digest('hex')}`
    const unknownClaim = buildClaim(unknownHash, unknownIds, 'event:gc-reject-unknown')
    const unknownFailure = await repository
      .privilegedCompact({
        projectId: ProjectIdSchema.parse('project-1'),
        eventIds: [...unknownIds] as unknown as Parameters<BunSQLiteMemoryRepository['privilegedCompact']>[0]['eventIds'],
        archiveClaimDraft: unknownClaim,
        archiveLines: unknownLines,
        archivePath: '.openbuff/memory/archive/gc-reject.jsonl',
        archiveHash: unknownHash,
      })
      .then(() => null)
      .catch((error: unknown) => error as { failure: { kind: string } })
    expect(unknownFailure?.failure?.kind).toBe('invalid')
    expect(await countEvents()).toEqual(beforeIds)
    expect(goodHash).not.toBe(badHash)
  })
})

describe('BunSQLiteMemoryRepository strict secure-open gate', () => {
  test('fails closed with a typed non-retryable unsupported-open error and performs no SQLite mutation', async () => {
    const root = temporaryRepository()
    const result = await openBunSQLiteMemoryRepository({
      repositoryRoot: root,
      requireSecureOpen: true,
    })
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.error.kind).toBe('unsupported-open')
    expect(result.error.retryable).toBe(false)
    expect(result.error.message).toContain(
      'bun:sqlite opens the database and its -wal/-shm sidecars by pathname',
    )
    expect(result.error.message).toContain('fail-closed')
    expect(result.error.message).not.toContain(root)
    expect(existsSync(join(root, '.openbuff'))).toBe(false)
  })

  test('leaves a pre-existing store byte-identical when the strict open is refused', async () => {
    const root = temporaryRepository()
    const repository = await open(root)
    expect(
      (await repository.appendEvents([event('pre-existing')])).status,
    ).toBe('ok')
    await repository.close()
    const databasePath = join(root, '.openbuff', 'memory', 'memory-v2.sqlite')
    const before = readFileSync(databasePath)

    const result = await openBunSQLiteMemoryRepository({
      repositoryRoot: root,
      requireSecureOpen: true,
    })
    expect(result).toMatchObject({
      status: 'error',
      error: { kind: 'unsupported-open', retryable: false },
    })
    expect(readFileSync(databasePath)).toEqual(before)
  })

  test('opens by default and reports the honest best-effort open posture on the result and in kernel health', async () => {
    const root = temporaryRepository()
    const result = await openBunSQLiteMemoryRepository({ repositoryRoot: root })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    repositories.push(result.repository)
    expect(result.openPosture).toBe(SQLITE_OPEN_POSTURE)
    expect(SQLITE_OPEN_POSTURE).toBe('pathname-best-effort-unverified-open')
    const health = await result.repository.kernelHealth()
    expect(health.openPosture).toBe(SQLITE_OPEN_POSTURE)
    expect(
      existsSync(join(root, '.openbuff', 'memory', 'memory-v2.sqlite')),
    ).toBe(true)
  })
})
