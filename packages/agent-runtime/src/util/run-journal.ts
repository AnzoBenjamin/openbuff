/**
 * P2-T2 slice 1: append-only run journal on bun:sqlite (WAL).
 *
 * WHY: durable, append-only record of a run's LLM requests/responses, tool
 * calls/results, spawns, and step boundaries so a run killed mid-flight (e.g.
 * kill -9 during a side-effecting tool call) can be classified and resumed
 * WITHOUT re-executing work that already completed. The journal is
 * ADDITIVE-AND-OPTIONAL: a run with no writer/reader wired behaves
 * byte-identically to today (see AgentRuntimeDeps.journalWriter/journalReader).
 *
 * WHY bun:sqlite SYNC: `append` is synchronous (it is on the hot path and must
 * commit its completion-marker boundary before the tool executes), so the
 * factory is synchronous and acquires the database synchronously — via the
 * injected `createDatabase` seam (the guaranteed-clean path the tests use) or
 * a synchronous `require('bun:sqlite')`. It deliberately does NOT use a
 * dynamic `await import`.
 *
 * The bun:sqlite acquisition + structural `SqliteDb` narrowing + injectable
 * `createDatabase` seam mirror `archive-recall-index.ts`; bun-types is not
 * added to tsconfig.
 */

import { realClock } from '@codebuff/common/deps/real-runtime-deps'

import type {
  Clock,
  JournalEvent,
  JournalReader,
  JournalWriter,
} from '@codebuff/common/types/contracts/agent-runtime'

/**
 * Narrow structural subset of the bun:sqlite `Database` API this module uses,
 * so packages whose tsconfig lacks bun-types still typecheck; the acquired
 * database is narrowed to this shape before use. Mirrors archive-recall-index.
 */
type SqliteDb = {
  run: (sql: string, ...params: unknown[]) => unknown
  query: (sql: string) => {
    all: (...params: unknown[]) => unknown[]
    get: (...params: unknown[]) => unknown
  }
  close: () => void
}

type BunSqliteModule = {
  Database: new (path: string) => SqliteDb
}

/** Combined writer+reader over a project-scoped or in-memory db. */
export interface RunJournal extends JournalWriter, JournalReader {
  close(): void
}

export type RunResumeClassification =
  | { kind: 'clean' }
  | { kind: 'in_flight_tool'; toolCallId: string }
  | { kind: 'in_flight_llm' }

/** Snake_case row shape returned by the run_events SELECTs. */
type RunEventRow = {
  seq: number
  step_number: number
  event_type: JournalEvent['eventType']
  correlation: string | null
  payload: string
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  step_number INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  correlation TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_run_events_run_step ON run_events (run_id, step_number, seq);
CREATE INDEX IF NOT EXISTS idx_run_events_correlation ON run_events (run_id, correlation);
`

/**
 * Synchronous default database acquisition. bun supports
 * `require('bun:sqlite')` synchronously, which is what `append` needs (the
 * factory is not async). The tests inject `createDatabase` using
 * `import { Database } from 'bun:sqlite'`, so this require-based production
 * seam is the only path that must survive typecheck without bun-types.
 */
function defaultCreateDatabase(path: string): SqliteDb {
  // @ts-ignore -- bun:sqlite has no type declarations without bun-types, and
  // `require` is provided by the bun runtime that ships bun:sqlite.
  const mod = require('bun:sqlite') as unknown as BunSqliteModule
  return new mod.Database(path)
}

/**
 * Build/open a journal. `path` ':memory:' for tests; `opts.createDatabase` is
 * the injectable seam. Constructs the schema idempotently and injects the
 * Clock for created_at (default realClock).
 */
export function createRunJournal(params: {
  path: string
  clock?: Clock
  createDatabase?: (path: string) => unknown
}): RunJournal {
  const { path } = params
  const clock = params.clock ?? realClock
  const create = params.createDatabase ?? defaultCreateDatabase
  const db = create(path) as SqliteDb

  // WAL + NORMAL durability for on-disk dbs; harmless to skip for :memory:.
  if (path !== ':memory:') {
    db.run('PRAGMA journal_mode=WAL;')
    db.run('PRAGMA synchronous=NORMAL;')
  }
  db.run(SCHEMA_SQL)

  const parseRow = (
    row: RunEventRow,
  ): JournalEvent & { seq: number } => ({
    eventType: row.event_type,
    stepNumber: row.step_number,
    correlation: row.correlation,
    payload: JSON.parse(row.payload),
    seq: row.seq,
  })

  return {
    append(runId: string, event: JournalEvent): void {
      // Next seq is monotonic gap-free per runId: coalesce null MAX to -1, +1.
      const maxRow = db
        .query('SELECT MAX(seq) AS max_seq FROM run_events WHERE run_id = ?')
        .get(runId) as { max_seq: number | null } | undefined
      const nextSeq = (maxRow?.max_seq ?? -1) + 1
      db.run(
        'INSERT INTO run_events (run_id, seq, step_number, event_type, correlation, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        runId,
        nextSeq,
        event.stepNumber,
        event.eventType,
        event.correlation ?? null,
        JSON.stringify(event.payload),
        clock.now(),
      )
    },

    lastEvent(runId: string): (JournalEvent & { seq: number }) | undefined {
      const row = db
        .query(
          'SELECT seq, step_number, event_type, correlation, payload FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1',
        )
        .get(runId) as RunEventRow | undefined
      return row ? parseRow(row) : undefined
    },

    events(runId: string): Array<JournalEvent & { seq: number }> {
      const rows = db
        .query(
          'SELECT seq, step_number, event_type, correlation, payload FROM run_events WHERE run_id = ? ORDER BY seq ASC',
        )
        .all(runId) as RunEventRow[]
      return rows.map(parseRow)
    },

    toolResultFor(runId: string, toolCallId: string): unknown | undefined {
      const row = db
        .query(
          "SELECT payload FROM run_events WHERE run_id = ? AND event_type = 'tool_result' AND correlation = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(runId, toolCallId) as { payload: string } | undefined
      return row ? JSON.parse(row.payload) : undefined
    },

    close(): void {
      db.close()
    },
  }
}

/**
 * Pure crash classifier (design §4a). Reads the journal tail and decides how a
 * run should resume:
 * - tool_call tail with no matching tool_result → in_flight_tool (the kill-9
 *   window: the tool may or may not have applied, so replay must consult
 *   `toolResultFor` before re-executing).
 * - llm_request tail with no matching llm_response → in_flight_llm.
 * - anything else (tool_result/step_boundary tail, or empty) → clean.
 */
export function classifyRunResume(
  reader: JournalReader,
  runId: string,
): RunResumeClassification {
  const last = reader.lastEvent(runId)
  if (!last) return { kind: 'clean' }

  if (last.eventType === 'tool_call') {
    const correlation = last.correlation
    const hasResult =
      correlation != null &&
      reader
        .events(runId)
        .some(
          (e) =>
            e.eventType === 'tool_result' && e.correlation === correlation,
        )
    if (!hasResult && correlation != null) {
      return { kind: 'in_flight_tool', toolCallId: correlation }
    }
    return { kind: 'clean' }
  }

  if (last.eventType === 'llm_request') {
    const correlation = last.correlation
    const hasResponse = reader
      .events(runId)
      .some(
        (e) =>
          e.eventType === 'llm_response' && e.correlation === correlation,
      )
    if (!hasResponse) return { kind: 'in_flight_llm' }
    return { kind: 'clean' }
  }

  return { kind: 'clean' }
}
