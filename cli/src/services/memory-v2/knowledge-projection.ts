import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { memorySelectorKey as knowledgeSelectorKey } from '../../../../common/src/util/memory-selector-key'
export { memorySelectorKey as knowledgeSelectorKey } from '../../../../common/src/util/memory-selector-key'
import {
  MemoryObservationSchema,
  type MemoryEventEnvelope,
  type MemoryObservation,
  type MemorySelector,
} from '../../../../common/src/types/memory-v2'

export const KNOWLEDGE_PRODUCER_VERSION = 'current-knowledge-2'
export const KNOWLEDGE_PROJECTION_DDL = `
CREATE TABLE IF NOT EXISTS memory_knowledge (
  observation_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  pinned INTEGER NOT NULL,
  source_sequence INTEGER NOT NULL,
  source_event_id TEXT NOT NULL,
  updated_sequence INTEGER NOT NULL,
  exact_identity TEXT NOT NULL,
  search_text TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK(json_valid(state_json))
);
CREATE INDEX IF NOT EXISTS memory_knowledge_project_state ON memory_knowledge(project_id, lifecycle, kind);
CREATE INDEX IF NOT EXISTS memory_knowledge_task ON memory_knowledge(project_id, task_id);
CREATE INDEX IF NOT EXISTS memory_knowledge_pinned ON memory_knowledge(project_id, pinned, lifecycle);
CREATE INDEX IF NOT EXISTS memory_knowledge_identity ON memory_knowledge(project_id, exact_identity, lifecycle);
CREATE TABLE IF NOT EXISTS memory_knowledge_selectors (
  observation_id TEXT NOT NULL REFERENCES memory_knowledge(observation_id) ON DELETE CASCADE,
  selector_key TEXT NOT NULL,
  artifact_kind TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(observation_id, selector_key, artifact_kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_knowledge_selector_lookup ON memory_knowledge_selectors(selector_key, observation_id);
CREATE TABLE IF NOT EXISTS memory_knowledge_tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  search_text TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK(json_valid(state_json))
);
CREATE INDEX IF NOT EXISTS memory_knowledge_tasks_project ON memory_knowledge_tasks(project_id, task_id);
CREATE TABLE IF NOT EXISTS memory_knowledge_coverage (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  PRIMARY KEY(project_id, task_id, dimension)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS memory_knowledge_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
INSERT OR IGNORE INTO memory_knowledge_metadata(key,value) VALUES ('cursor','0');
INSERT OR IGNORE INTO memory_knowledge_metadata(key,value) VALUES ('cursorEventId','');
INSERT OR IGNORE INTO memory_knowledge_metadata(key,value) VALUES ('producer','${KNOWLEDGE_PRODUCER_VERSION}');
INSERT OR IGNORE INTO memory_knowledge_metadata(key,value) VALUES ('generatedAt','1970-01-01T00:00:00.000Z');
`

export const KNOWLEDGE_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_knowledge_fts USING fts5(search_text, content='memory_knowledge', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS memory_knowledge_ai AFTER INSERT ON memory_knowledge BEGIN
  INSERT INTO memory_knowledge_fts(rowid, search_text) VALUES (new.rowid,new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS memory_knowledge_ad AFTER DELETE ON memory_knowledge BEGIN
  INSERT INTO memory_knowledge_fts(memory_knowledge_fts,rowid,search_text) VALUES ('delete',old.rowid,old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS memory_knowledge_au AFTER UPDATE OF search_text ON memory_knowledge WHEN new.search_text != old.search_text BEGIN
  INSERT INTO memory_knowledge_fts(memory_knowledge_fts,rowid,search_text) VALUES ('delete',old.rowid,old.search_text);
  INSERT INTO memory_knowledge_fts(rowid,search_text) VALUES (new.rowid,new.search_text);
END;
`

export interface KnowledgeFreshness {
  state: 'verified' | 'invalid'
  at: string
  reason?: string
  observedDigest?: string
  workspaceRevision?: number
  workspaceSnapshotId?: string
  selector?: MemorySelector
}

export interface KnowledgeObservationState {
  observation: MemoryObservation
  sourceSequence: number
  sourceEventId: string
  forgotten: boolean
  superseded: boolean
  corrected: boolean
  pinned: boolean
  used: number
  ignored: number
  reinforced: number
  freshness: Record<string, KnowledgeFreshness>
  supersededBy?: string
  lastUsage?: { mechanism: string; turnId: string; sequence: number }
}

export interface KnowledgeTaskState {
  taskId: string
  title: string
  objective: string
  status:
    | 'created'
    | 'active'
    | 'blocked'
    | 'completed'
    | 'failed'
    | 'cancelled'
  sourceSequence: number
  eventId: string
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Exact content AND dependency identity; a similarly worded claim is never merged. */
export function exactKnowledgeIdentity(observation: MemoryObservation): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        kind: observation.kind,
        summary: observation.summary.trim().replace(/\s+/g, ' '),
        detail: observation.detail.trim().replace(/\s+/g, ' '),
        origin: observation.provenance?.origin ?? 'unknown',
        tags: [...observation.tags].sort(),
        scope: observation.provenance?.metadata.scope ?? null,
        audience: observation.provenance?.metadata.audience ?? null,
        selectors: (
          observation.selectors ?? observation.evidence.map((e) => e.selector)
        )
          .map(canonicalJson)
          .sort(),
        dependencies: observation.evidence
          .map((e) => ({
            selector: canonicalJson(e.selector),
            digest: e.contentDigest ?? null,
            artifactKind: e.artifact.classification.kind,
            dependencies: e.provenance.metadata.dependencies ?? null,
            producer: e.provenance.metadata.producer ?? null,
          }))
          .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
      }),
    )
    .digest('hex')
}

/** Internal evidence identity preserves distinct symbol occurrences. */
export function knowledgeFreshnessKey(selector: MemorySelector): string {
  const key = knowledgeSelectorKey(selector)
  return selector.kind === 'symbol'
    ? `${key}#occurrence:${selector.occurrence}`
    : key
}

export function readKnowledgeState(
  database: Database,
  observationId: string,
): KnowledgeObservationState | undefined {
  const row = database
    .query('SELECT state_json FROM memory_knowledge WHERE observation_id=?1')
    .get(observationId) as { state_json: string } | null
  if (!row) return undefined
  const state = JSON.parse(row.state_json) as KnowledgeObservationState
  MemoryObservationSchema.parse(state.observation)
  if (!state.freshness || typeof state.freshness !== 'object')
    throw new Error('Invalid knowledge freshness projection')
  return state
}

function storeKnowledgeState(
  database: Database,
  projectId: string,
  state: KnowledgeObservationState,
  sequence: number,
): void {
  const observation = state.observation
  const selectors =
    observation.selectors ?? observation.evidence.map((e) => e.selector)
  const lifecycle = state.forgotten
    ? 'forgotten'
    : state.superseded
      ? 'superseded'
      : state.corrected
        ? 'corrected'
        : 'active'
  const searchText = `${observation.taskId} ${observation.kind} ${observation.summary} ${observation.detail} ${selectors.map(knowledgeSelectorKey).join(' ')} ${observation.evidence.map((e) => e.excerpt ?? '').join(' ')}`
  database
    .query(
      `INSERT INTO memory_knowledge(observation_id,project_id,task_id,kind,lifecycle,pinned,source_sequence,source_event_id,updated_sequence,exact_identity,search_text,state_json)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
    ON CONFLICT(observation_id) DO UPDATE SET task_id=excluded.task_id,kind=excluded.kind,lifecycle=excluded.lifecycle,pinned=excluded.pinned,
      source_sequence=excluded.source_sequence,source_event_id=excluded.source_event_id,updated_sequence=excluded.updated_sequence,
      exact_identity=excluded.exact_identity,search_text=excluded.search_text,state_json=excluded.state_json`,
    )
    .run(
      observation.observationId,
      projectId,
      observation.taskId,
      observation.kind,
      lifecycle,
      state.pinned ? 1 : 0,
      state.sourceSequence,
      state.sourceEventId,
      sequence,
      exactKnowledgeIdentity(observation),
      searchText,
      JSON.stringify(state),
    )
  database
    .query('DELETE FROM memory_knowledge_selectors WHERE observation_id=?1')
    .run(observation.observationId)
  const insert = database.query(
    'INSERT OR IGNORE INTO memory_knowledge_selectors(observation_id,selector_key,artifact_kind) VALUES (?1,?2,?3)',
  )
  for (const selector of selectors)
    insert.run(observation.observationId, knowledgeSelectorKey(selector), '')
  for (const evidence of observation.evidence)
    insert.run(
      observation.observationId,
      knowledgeSelectorKey(evidence.selector),
      evidence.artifact.classification.kind,
    )
}

function initialState(
  observation: MemoryObservation,
  event: MemoryEventEnvelope,
): KnowledgeObservationState {
  return {
    observation,
    sourceSequence: event.sequence,
    sourceEventId: event.eventId,
    forgotten: false,
    superseded: false,
    corrected: false,
    pinned: false,
    used: 0,
    ignored: 0,
    reinforced: 0,
    freshness: {},
  }
}

/** Called in the canonical append/replay transaction. Only touched records are rewritten. */
export function applyKnowledgeEvent(
  database: Database,
  event: MemoryEventEnvelope,
): void {
  const mutate = (
    id: string,
    update: (state: KnowledgeObservationState) => void,
  ) => {
    const state = readKnowledgeState(database, id)
    if (!state) return
    update(state)
    storeKnowledgeState(database, event.projectId, state, event.sequence)
  }
  switch (event.eventType) {
    case 'task.created': {
      const task: KnowledgeTaskState = {
        ...event.payload,
        status: event.payload.initialStatus,
        sourceSequence: event.sequence,
        eventId: event.eventId,
      }
      database
        .query(
          'INSERT INTO memory_knowledge_tasks(task_id,project_id,search_text,state_json) VALUES (?1,?2,?3,?4) ON CONFLICT(task_id) DO UPDATE SET search_text=excluded.search_text,state_json=excluded.state_json',
        )
        .run(
          task.taskId,
          event.projectId,
          `${task.taskId} ${task.title} ${task.objective}`,
          JSON.stringify(task),
        )
      break
    }
    case 'task.transitioned': {
      const row = database
        .query('SELECT state_json FROM memory_knowledge_tasks WHERE task_id=?1')
        .get(event.payload.taskId) as { state_json: string } | null
      if (row) {
        const state: KnowledgeTaskState = {
          ...JSON.parse(row.state_json),
          status: event.payload.toStatus,
          sourceSequence: event.sequence,
          eventId: event.eventId,
        }
        database
          .query(
            'UPDATE memory_knowledge_tasks SET state_json=?1 WHERE task_id=?2',
          )
          .run(JSON.stringify(state), state.taskId)
      }
      break
    }
    case 'coverage.recorded':
      database
        .query(
          'INSERT INTO memory_knowledge_coverage(project_id,task_id,dimension,event_json) VALUES (?1,?2,?3,?4) ON CONFLICT(project_id,task_id,dimension) DO UPDATE SET event_json=excluded.event_json',
        )
        .run(
          event.projectId,
          event.payload.taskId,
          event.payload.dimension,
          JSON.stringify(event),
        )
      break
    case 'observation.recorded':
      storeKnowledgeState(
        database,
        event.projectId,
        initialState(event.payload.observation, event),
        event.sequence,
      )
      break
    case 'claim.consolidated':
      for (const id of event.payload.sourceObservationIds)
        mutate(id, (state) => {
          state.superseded = true
          state.supersededBy = event.payload.canonicalObservation.observationId
        })
      storeKnowledgeState(
        database,
        event.projectId,
        initialState(event.payload.canonicalObservation, event),
        event.sequence,
      )
      break
    case 'claim.corrected': {
      const prior = readKnowledgeState(database, event.payload.observationId)
      mutate(event.payload.observationId, (state) => {
        state.corrected = true
        state.supersededBy = event.payload.correction.observationId
      })
      const replacement = initialState(event.payload.correction, event)
      replacement.pinned = prior?.pinned ?? false
      storeKnowledgeState(
        database,
        event.projectId,
        replacement,
        event.sequence,
      )
      break
    }
    case 'claim.forgotten':
      for (const id of event.payload.observationIds)
        mutate(id, (state) => {
          state.forgotten = true
        })
      break
    case 'claim.superseded': {
      const source = readKnowledgeState(database, event.payload.observationId)
      const head = readKnowledgeState(
        database,
        event.payload.supersededByObservationId,
      )
      // An exact duplicate fold preserves corroboration, usefulness and the
      // freshest dependency state instead of dropping it with the source.
      if (
        source &&
        head &&
        !source.superseded &&
        !source.forgotten &&
        !source.corrected &&
        exactKnowledgeIdentity(source.observation) ===
          exactKnowledgeIdentity(head.observation)
      ) {
        head.used += source.used
        head.ignored += source.ignored
        head.reinforced += source.reinforced
        head.pinned = head.pinned || source.pinned
        if (
          source.lastUsage &&
          (!head.lastUsage ||
            head.lastUsage.sequence < source.lastUsage.sequence)
        )
          head.lastUsage = source.lastUsage
        for (const [key, value] of Object.entries(source.freshness)) {
          if (!head.freshness[key] || head.freshness[key]!.at < value.at)
            head.freshness[key] = value
        }
        storeKnowledgeState(database, event.projectId, head, event.sequence)
      }
      mutate(event.payload.observationId, (state) => {
        state.superseded = true
        state.supersededBy = event.payload.supersededByObservationId
      })
      break
    }
    case 'claim.pinned':
      mutate(event.payload.observationId, (state) => {
        state.pinned = true
      })
      break
    case 'claim.reinforced':
      mutate(event.payload.observationId, (state) => {
        state.reinforced++
      })
      break
    case 'evidence.attached':
      mutate(event.payload.observationId, (state) => {
        state.observation = {
          ...state.observation,
          evidence: [
            ...state.observation.evidence,
            ...event.payload.evidence,
          ].slice(0, 32),
        }
      })
      break
    case 'evidence.verified':
      mutate(event.payload.observationId, (state) => {
        state.freshness[knowledgeFreshnessKey(event.payload.selector)] = {
          state: 'verified',
          at: event.payload.verifiedAt,
          observedDigest: event.payload.observedDigest,
          workspaceRevision: event.payload.workspaceRevision,
          workspaceSnapshotId: event.payload.workspaceSnapshotId,
          selector: event.payload.selector,
        }
      })
      break
    case 'evidence.invalidated':
      mutate(event.payload.observationId, (state) => {
        state.freshness[knowledgeFreshnessKey(event.payload.selector)] = {
          state: 'invalid',
          at: event.payload.invalidatedAt,
          reason: event.payload.reason,
        }
      })
      break
    case 'evidence.rebound':
      mutate(event.payload.observationId, (state) => {
        const previous = knowledgeSelectorKey(event.payload.previousSelector)
        state.observation = {
          ...state.observation,
          evidence: [
            ...state.observation.evidence.filter(
              (e) => knowledgeSelectorKey(e.selector) !== previous,
            ),
            event.payload.evidence,
          ],
        }
        delete state.freshness[
          knowledgeFreshnessKey(event.payload.previousSelector)
        ]
      })
      break
    case 'observation.reused':
      for (const entry of event.payload.used)
        mutate(entry.observationId, (state) => {
          state.used++
          state.lastUsage = {
            mechanism: entry.mechanism,
            turnId: event.payload.turnId,
            sequence: event.sequence,
          }
        })
      for (const entry of event.payload.ignored)
        mutate(entry.observationId, (state) => {
          state.ignored++
          state.lastUsage = {
            mechanism: entry.mechanism,
            turnId: event.payload.turnId,
            sequence: event.sequence,
          }
        })
      break
  }
}

export function knowledgeCursor(database: Database): number {
  const row = database
    .query("SELECT value FROM memory_knowledge_metadata WHERE key='cursor'")
    .get() as { value: string } | null
  const value = Number(row?.value ?? 0)
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid knowledge projection cursor')
  return value
}

export function advanceKnowledgeCursor(
  database: Database,
  sequence: number,
  at?: string,
  eventId?: string,
): void {
  database
    .query("UPDATE memory_knowledge_metadata SET value=?1 WHERE key='cursor'")
    .run(String(sequence))
  if (at)
    database
      .query(
        "UPDATE memory_knowledge_metadata SET value=max(value,?1) WHERE key='generatedAt'",
      )
      .run(at)
  if (eventId !== undefined)
    database
      .query(
        "UPDATE memory_knowledge_metadata SET value=?1 WHERE key='cursorEventId'",
      )
      .run(eventId)
}

export function clearKnowledgeProjection(database: Database): void {
  database.exec(
    'DELETE FROM memory_knowledge; DELETE FROM memory_knowledge_tasks; DELETE FROM memory_knowledge_coverage;',
  )
  advanceKnowledgeCursor(database, 0, undefined, '')
  database
    .query(
      "UPDATE memory_knowledge_metadata SET value='1970-01-01T00:00:00.000Z' WHERE key='generatedAt'",
    )
    .run()
}
