/**
 * P2-T2 slices 1-4: append-only run journal on bun:sqlite (WAL).
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
 *
 * Slice 4 (additive): OPTIONAL per-run retention (bounded event count /
 * payload bytes; the OLDEST rows are deleted and surviving seq numbers are
 * never rewritten — gaps are expected, which is why classifyRunResume orders
 * by seq, not row count) and OPTIONAL hot-path batching (appends buffer in
 * memory and drain on a count/delay schedule via an unref'd timer;
 * flush()/close() drain). Both are opt-in via createRunJournal params: a
 * journal created without them behaves byte-identically to slices 1-3
 * (flush-per-append, unbounded).
 */

import { realClock } from '@codebuff/common/deps/real-runtime-deps'

import type {
  Clock,
  JournalEvent,
  JournalEventRow,
  JournalReader,
  JournalWriter,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { AgentState } from '@codebuff/common/types/session-state'
import { stableHash } from '@codebuff/common/util/stable-hash'

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

/**
 * Combined writer+reader over a project-scoped or in-memory db. The slice-4
 * members (flush/close/pruneRuns) are OPTIONAL, mirroring the
 * deliberately-optional treatment JournalWriter got in the contracts file:
 * an existing implementor of this exported interface must never be broken by
 * an added required member. A per-append writer flushes eagerly (flush() is
 * a no-op for it) and a writer that closes synchronously simply omits
 * close(); `createRunJournal` returns the `CreatedRunJournal` superset whose
 * slice-4 members are required because the built-in implementation always
 * provides them.
 */
export interface RunJournal extends JournalWriter, JournalReader {
  /**
   * Optional (slice 4): drain any hot-path-batched events so every event
   * appended so far is durably committed. Optional so an existing implementor
   * that flushes per append is unaffected (its flush() is a no-op).
   */
  flush?(): Promise<void>
  /**
   * Optional (slice 4): flush any batched events, then close the underlying
   * storage. Optional, mirroring JournalWriter.close, so an implementor
   * without a close keeps satisfying this interface.
   */
  close?(): Promise<void>
  /**
   * Optional (slice 4 rotation): deletes rows for every runId NOT in
   * keepRunIds (see createRunJournal).
   */
  pruneRuns?(keepRunIds: string[]): void
}

/**
 * The concrete journal `createRunJournal` builds: the implementor-friendly
 * `RunJournal` contract with the slice-4 members required, because the
 * built-in implementation always provides them and its callers rely on that
 * (close() flushes any batched events — a no-op without batching — and
 * returns a promise so a batched writer can be awaited before process exit,
 * while callers that ignore the return value keep working unchanged).
 */
export type CreatedRunJournal = RunJournal & {
  flush(): Promise<void>
  close(): Promise<void>
  pruneRuns(keepRunIds: string[]): void
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
  created_at: number
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
 * SQLITE_BUSY (or a busy-timeout exhaustion) raised by a concurrent writer
 * holding the write lock. Only this class of error is retried in append();
 * anything else propagates immediately.
 */
function isSqliteBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /SQLITE_BUSY|database is locked|database table is locked/i.test(
      error.message,
    )
  )
}

/**
 * Whether a ROLLBACK failure means there is simply no transaction left to
 * unwind (e.g. the COMMIT already ended it): the connection is clean either
 * way, so the caller can safely issue another BEGIN IMMEDIATE.
 */
function isNoActiveTransactionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /no transaction is active|cannot rollback/i.test(error.message)
  )
}

/**
 * P2-T2-DESIGN §5 (replay requires reproducible ids): canonicalize a tool
 * input to a deterministic string for the toolResultForInput key. Recurses
 * with object keys SORTED, so the live dispatch input and the journaled
 * payload — both plain JSON values — produce the same key across a process
 * restart even when the input's keys were enumerated in a different order.
 * Never relies on bare JSON.stringify key order, which is not guaranteed.
 * Non-JSON values (undefined/functions/symbols) are elided (object values) or
 * rendered null (array items), matching JSON semantics; cyclic inputs fall
 * back to a constant marker so a pathological input cannot throw on the
 * synchronous hot path.
 */
function canonicalizeJournalJson(value: unknown): string {
  const seen = new Set<object>()
  const encode = (v: unknown): string => {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') {
      return JSON.stringify(v)
    }
    if (typeof v === 'string') {
      return JSON.stringify(v)
    }
    if (typeof v === 'bigint') {
      return JSON.stringify(v.toString())
    }
    if (Array.isArray(v)) {
      if (seen.has(v)) return 'null'
      seen.add(v)
      const out = `[${v.map((item) => encode(item ?? null)).join(',')}]`
      seen.delete(v)
      return out
    }
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '{}'
      seen.add(v as object)
      const keys = Object.keys(v as Record<string, unknown>).sort()
      const parts = keys
        .filter((key) => {
          const item = (v as Record<string, unknown>)[key]
          return (
            item !== undefined &&
            typeof item !== 'function' &&
            typeof item !== 'symbol'
          )
        })
        .map(
          (key) =>
            `${JSON.stringify(key)}:${encode((v as Record<string, unknown>)[key])}`,
        )
      seen.delete(v as object)
      return `{${parts.join(',')}}`
    }
    // undefined / function / symbol at the top level.
    return 'null'
  }
  return encode(value)
}

/**
 * Deterministic key for a journaled tool_call's (toolName, input) pair, used
 * by toolResultForInput (P2-T2-DESIGN §5). NUL separates the toolName from the
 * canonicalized input; tool names never contain NUL. Hashed with the canonical
 * FNV-1a stableHash so the key is a compact, collision-bounded string.
 */
function journalToolInputKey(toolName: string, input: unknown): string {
  return stableHash(`${toolName}\u0000${canonicalizeJournalJson(input)}`)
}

/**
 * Roll the current transaction back, retrying while the ROLLBACK itself
 * fails with SQLITE_BUSY (a concurrent writer can hold the write lock the
 * rollback needs; the connection's busy_timeout bounds each wait). Returns
 * true only when the transaction is confirmed closed — the rollback
 * succeeded, or there was no transaction left to unwind — so the caller can
 * safely issue another BEGIN IMMEDIATE.
 */
function rollbackTransaction(db: SqliteDb, attempts = 3): boolean {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      db.run('ROLLBACK;')
      return true
    } catch (rollbackError) {
      if (isNoActiveTransactionError(rollbackError)) return true
      if (!isSqliteBusyError(rollbackError)) return false
    }
  }
  return false
}

/** Default hot-path batching caps (P2-T2 slice 4). */
const DEFAULT_MAX_BATCH_EVENTS = 32
const DEFAULT_MAX_BATCH_DELAY_MS = 50

/**
 * Optional per-run retention bounds (P2-T2 slice 4). Both caps are opt-in;
 * when set, the OLDEST rows beyond the cap are deleted on every append (or
 * batch flush). Surviving seq numbers are never rewritten — deletion leaves
 * gaps at the low end and appends keep minting MAX(seq) + 1, which is why
 * classifyRunResume orders by seq (not row count) and stays correct.
 */
export type RunJournalRetention = {
  /** Keep at most this many NEWEST events per runId (must be >= 1). */
  maxEvents?: number
  /**
   * Keep at most this many serialized-payload bytes per runId (must be >= 1).
   * Counted as UTF-8 BYTES (SQLite LENGTH over a BLOB cast), not characters:
   * LENGTH on a TEXT column counts characters, which under-counts multibyte
   * payloads and would let the retained tail exceed this byte budget.
   * Payload bytes are the dominant per-row term; fixed column overhead is
   * not counted. The newest row is always retained, even when it alone
   * exceeds this cap, so a kill-9'd tail event is never deleted out from
   * under the resume classifier.
   */
  maxBytes?: number
}

/**
 * Optional hot-path batching (P2-T2 slice 4). When set, `append` buffers
 * events in memory and drains the buffer once `maxBatchEvents` (default 32)
 * events have buffered or `maxBatchDelayMs` (default 50, an unref'd timer
 * that never holds the process open) elapse; `flush()`/`close()` (close
 * flushes) drain explicitly. WITHOUT this option every append commits
 * synchronously — byte-identical to slices 1-3.
 */
export type RunJournalBatching = {
  /** Drain the buffer once this many events are buffered (default 32). */
  maxBatchEvents?: number
  /** Drain the buffer after this many ms (default 50; 0 flushes ASAP). */
  maxBatchDelayMs?: number
}

/**
 * Build/open a journal. `path` ':memory:' for tests; `opts.createDatabase` is
 * the injectable seam. Constructs the schema idempotently and injects the
 * Clock for created_at (default realClock). `retention` bounds each run's
 * table (oldest rows deleted; seq gaps are expected); `batching` buffers
 * appends and drains them on a count/delay schedule (default: flush per
 * append).
 */
export function createRunJournal(params: {
  path: string
  clock?: Clock
  createDatabase?: (path: string) => unknown
  retention?: RunJournalRetention
  batching?: RunJournalBatching
}): CreatedRunJournal {
  const { path } = params
  const clock = params.clock ?? realClock
  const create = params.createDatabase ?? defaultCreateDatabase
  const db = create(path) as SqliteDb

  // Retention caps: absent or non-positive values disable that dimension
  // rather than bounding the journal to empty.
  const retention = params.retention
  const maxEventsCap =
    retention?.maxEvents != null && retention.maxEvents >= 1
      ? Math.floor(retention.maxEvents)
      : undefined
  const maxBytesCap =
    retention?.maxBytes != null && retention.maxBytes >= 1
      ? Math.floor(retention.maxBytes)
      : undefined

  // Batching config: clamped to safe minimums so a misconfigured cap cannot
  // disable flushing entirely.
  const batching = params.batching
    ? {
        maxBatchEvents: Math.max(
          1,
          Math.floor(params.batching.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS),
        ),
        maxBatchDelayMs: Math.max(
          0,
          Math.floor(
            params.batching.maxBatchDelayMs ?? DEFAULT_MAX_BATCH_DELAY_MS,
          ),
        ),
      }
    : undefined

  // Bound how long a write waits on a lock held by a concurrent writer (e.g.
  // another process reading/resuming the same project journal) instead of
  // surfacing SQLITE_BUSY as a throw on the synchronous append hot path.
  // Harmless for :memory: databases.
  db.run('PRAGMA busy_timeout = 5000;')

  // WAL + NORMAL durability for on-disk dbs; harmless to skip for :memory:.
  if (path !== ':memory:') {
    db.run('PRAGMA journal_mode=WAL;')
    db.run('PRAGMA synchronous=NORMAL;')
  }
  db.run(SCHEMA_SQL)

  const parseRow = (row: RunEventRow): JournalEventRow => ({
    eventType: row.event_type,
    stepNumber: row.step_number,
    correlation: row.correlation,
    payload: JSON.parse(row.payload),
    seq: row.seq,
    // Surface the persisted wall-clock timestamp so consumers (the dash
    // provider) can show a REAL timestamp instead of a synthetic ordering
    // label; epoch ms per the schema (created_at INTEGER NOT NULL).
    createdAt: row.created_at,
  })

  // Connection-level state, NOT per-call state: when an append attempt
  // fails and its ROLLBACK cannot close the transaction (bounded SQLITE_BUSY
  // retries exhausted while a concurrent writer holds the write lock), the
  // connection is left with a still-open transaction. The NEXT append on
  // this journal must unwind it before issuing BEGIN IMMEDIATE — or that
  // BEGIN throws a non-busy "cannot start a transaction within a
  // transaction" error that poisons the connection for the process lifetime,
  // even after the concurrent writer releases the lock.
  let strandedTransaction = false
  let lastError: unknown

  /**
   * Slice 4: enforce the per-run retention bounds by deleting the OLDEST
   * rows beyond the cap. Surviving seq numbers are NEVER rewritten: deletion
   * leaves gaps at the low end and the next append still mints MAX(seq) + 1,
   * which is why classifyRunResume (and every reader here) orders by seq —
   * lastEvent is ORDER BY seq DESC LIMIT 1, not a row count — and keeps
   * classifying the retained tail correctly. The NEWEST row is always
   * retained even when it alone exceeds maxBytes, so a kill-9'd tail event
   * (e.g. an in-flight tool_call) is never deleted out from under the resume
   * classifier.
   */
  const enforceRetention = (runId: string): void => {
    if (maxEventsCap === undefined && maxBytesCap === undefined) return
    // Best-effort by design: the append (or flush) that triggered retention
    // has already committed durably, so a retention failure (e.g. transient
    // SQLITE_BUSY on the DELETE) must not surface as a failed append. The
    // next append re-runs enforcement, so a skipped pass only delays the
    // bound by one event.
    try {
      if (maxEventsCap !== undefined) {
        // The (maxEvents)-th newest row bounds the kept window; delete
        // everything strictly older (one indexed scan + one range DELETE).
        const boundary = db
          .query(
            'SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?',
          )
          .get(runId, maxEventsCap - 1) as { seq: number } | undefined
        if (boundary) {
          db.run(
            'DELETE FROM run_events WHERE run_id = ? AND seq < ?',
            runId,
            boundary.seq,
          )
        }
      }
      if (maxBytesCap !== undefined) {
        // Byte budget over serialized payload sizes (the dominant per-row
        // term; fixed column overhead is not counted). LENGTH(CAST(payload
        // AS BLOB)) counts UTF-8 BYTES, not characters: bare LENGTH on a
        // TEXT column counts characters, so multibyte payloads would be
        // under-counted and the retained tail could exceed the byte budget.
        // Delete the oldest rows greedily until the remaining payload bytes
        // fit the cap, keeping as many NEWEST rows as possible and never
        // deleting the newest row.
        const rows = db
          .query(
            'SELECT seq, LENGTH(CAST(payload AS BLOB)) AS len FROM run_events WHERE run_id = ? ORDER BY seq ASC',
          )
          .all(runId) as Array<{ seq: number; len: number }>
        let total = 0
        for (const row of rows) total += row.len
        let deletedBytes = 0
        let cutSeq = -1
        for (let i = 0; i < rows.length; i++) {
          if (total - deletedBytes <= maxBytesCap) break
          if (i === rows.length - 1) break // never delete the newest row
          deletedBytes += rows[i].len
          cutSeq = rows[i].seq
        }
        if (cutSeq >= 0) {
          db.run(
            'DELETE FROM run_events WHERE run_id = ? AND seq <= ?',
            runId,
            cutSeq,
          )
        }
      }
    } catch {
      // Skip this enforcement pass; the next append retries.
    }
  }

  /**
   * One durable append: mints the next gap-free seq for runId inside a
   * BEGIN IMMEDIATE transaction and commits it before returning. Extracted
   * verbatim from `append` so the batching drain can replay buffered events
   * through the identical path (slices 1-3 behavior, unchanged).
   */
  const insertEvent = (runId: string, event: JournalEvent): void => {
    // Next seq is monotonic gap-free per runId. The read-then-insert is
    // wrapped in a BEGIN IMMEDIATE transaction so two appends cannot mint
    // the same seq (a PK violation on (run_id, seq)) or interleave rows.
    // BEGIN IMMEDIATE takes the write lock up front, so the MAX read is
    // guaranteed to see the transaction's own writes under SQLite's
    // serialized write model; WAL + NORMAL durability stays unchanged.
    // A concurrent writer holding the write lock surfaces as SQLITE_BUSY:
    // the connection's busy_timeout makes BEGIN IMMEDIATE wait instead of
    // throwing, and this small bounded retry absorbs any residual busy
    // error instead of aborting the journal append mid-run.
    const maxAttempts = 3
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (strandedTransaction) {
        if (!rollbackTransaction(db)) {
          // The transaction could not be unwound after bounded retries:
          // surface the original busy error — matching this loop's retry
          // contract — instead of letting BEGIN IMMEDIATE throw a
          // non-busy "cannot start a transaction within a transaction"
          // error that would poison the connection.
          throw lastError
        }
        strandedTransaction = false
      }
      try {
        db.run('BEGIN IMMEDIATE;')
        try {
          const maxRow = db
            .query(
              'SELECT MAX(seq) AS max_seq FROM run_events WHERE run_id = ?',
            )
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
          db.run('COMMIT;')
          return
        } catch (error) {
          // A failed INSERT/COMMIT leaves the transaction open, and the
          // rollback below can itself fail with SQLITE_BUSY while a
          // concurrent writer holds the write lock — which would strand
          // the open transaction (see strandedTransaction above).
          strandedTransaction = !rollbackTransaction(db)
          throw error
        }
      } catch (error) {
        lastError = error
        if (!isSqliteBusyError(error)) throw error
      }
    }
    throw lastError
  }

  // --- Slice 4: hot-path batching -------------------------------------
  // Buffered events are drained SYNCHRONOUSLY (the underlying bun:sqlite
  // writes are synchronous), so a drain is atomic with respect to the event
  // loop: two flushes can never interleave or double-flush, and a reader
  // never observes a partially-applied batch.
  let pending: Array<{ runId: string; event: JournalEvent }> = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const clearFlushTimer = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  const drainPending = (): void => {
    if (pending.length === 0) {
      clearFlushTimer()
      return
    }
    const batch = pending
    // Clear the buffer BEFORE inserting: a failed insert propagates to the
    // caller (or is dropped by the timer path below) without re-inserting
    // already-committed events on a retry.
    pending = []
    clearFlushTimer()
    const affectedRunIds = new Set<string>()
    for (const { runId, event } of batch) {
      insertEvent(runId, event)
      affectedRunIds.add(runId)
    }
    // Retention runs BETWEEN appends, never during a reader iteration: the
    // deletes happen synchronously here, after the whole batch is committed
    // and before control returns to any reader.
    for (const runId of affectedRunIds) enforceRetention(runId)
  }

  const scheduleFlushTimer = (delayMs: number): void => {
    if (flushTimer !== null) return
    const timer = setTimeout(() => {
      flushTimer = null
      // A timer-driven drain cannot surface a throw to a caller: propagating
      // one out of a timer callback would crash the process on a transient
      // SQLITE_BUSY. Bounded busy-retries inside insertEvent already absorb
      // transient lock contention; a residual failure drops this batch
      // rather than crashing. Explicit flush()/append-triggered drains still
      // propagate errors to their caller.
      try {
        drainPending()
      } catch {
        // Best-effort flush; nothing further to do this tick.
      }
    }, delayMs)
    // Never hold the process open for a pending batch: an unref'd timer must
    // not keep an otherwise-idle process alive (kill-9 semantics).
    ;(timer as unknown as { unref?: () => void }).unref?.()
    flushTimer = timer
  }

  return {
    append(runId: string, event: JournalEvent): void {
      if (batching) {
        pending.push({ runId, event })
        if (pending.length >= batching.maxBatchEvents) {
          // Batch full: drain synchronously so the events become durable
          // before this append returns (the durability contract at the batch
          // boundary matches a flush-per-append writer).
          drainPending()
        } else {
          scheduleFlushTimer(batching.maxBatchDelayMs)
        }
        return
      }
      // Default (no batching option): flush-per-append, byte-identical to
      // slices 1-3 — the event is durably committed when append returns.
      insertEvent(runId, event)
      enforceRetention(runId)
    },

    /**
     * Slice 4: drain any buffered events (a no-op without batching) and
     * resolve once every event appended so far is durably committed. The
     * drain is fully synchronous over this journal's single connection, so
     * there is always at most one drain in flight and concurrent flushes
     * can never interleave or double-flush.
     */
    flush(): Promise<void> {
      drainPending()
      return Promise.resolve()
    },

    /**
     * Slice 4 rotation: the injected `createDatabase` seam means production
     * wiring creates one journal file per runId, so per-run retention bounds
     * the whole file. But nothing structural stops ONE RunJournal (and its
     * database) from serving MULTIPLE runIds — the tests do exactly that for
     * a parent run and its children — and in that shared-db case per-run
     * retention alone cannot bound the file. pruneRuns completes the
     * rotation story: it deletes every row whose run_id is NOT in
     * keepRunIds (enumerating the distinct runIds actually present, so no
     * unbounded NOT IN (...) host-parameter list), and drops still-buffered
     * events for pruned runs so a later flush cannot resurrect them.
     */
    pruneRuns(keepRunIds: string[]): void {
      const keep = new Set(keepRunIds)
      const runIds = db
        .query('SELECT DISTINCT run_id FROM run_events')
        .all() as Array<{ run_id: string }>
      for (const { run_id: existingRunId } of runIds) {
        if (!keep.has(existingRunId)) {
          db.run('DELETE FROM run_events WHERE run_id = ?', existingRunId)
        }
      }
      pending = pending.filter((item) => keep.has(item.runId))
    },

    lastEvent(runId: string): JournalEventRow | undefined {
      const row = db
        .query(
          'SELECT seq, step_number, event_type, correlation, payload, created_at FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1',
        )
        .get(runId) as RunEventRow | undefined
      return row ? parseRow(row) : undefined
    },

    events(runId: string): JournalEventRow[] {
      const rows = db
        .query(
          'SELECT seq, step_number, event_type, correlation, payload, created_at FROM run_events WHERE run_id = ? ORDER BY seq ASC',
        )
        .all(runId) as RunEventRow[]
      return rows.map(parseRow)
    },

    toolResultFor(runId: string, toolCallId: string): unknown | undefined {
      // Correlation-reuse guard — the reader-side mirror of the guard
      // classifyRunResume applies. A retried tool call reuses the same
      // correlation, so the newest tool_result with a matching correlation
      // can be an EARLIER attempt's result: only a tool_result recorded
      // AFTER the latest tool_call carrying that correlation completes THAT
      // attempt, and anything earlier must resolve to undefined so the
      // replay cross-check re-executes a genuinely in-flight tool call under
      // live control instead of silently reusing a stale result. Fail
      // closed: no tool_call with this correlation at all means the journal
      // cannot prove any attempt of this call completed.
      const callRow = db
        .query(
          "SELECT seq FROM run_events WHERE run_id = ? AND event_type = 'tool_call' AND correlation = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(runId, toolCallId) as { seq: number } | undefined
      if (!callRow) return undefined
      const row = db
        .query(
          "SELECT payload FROM run_events WHERE run_id = ? AND event_type = 'tool_result' AND correlation = ? AND seq > ? ORDER BY seq DESC LIMIT 1",
        )
        .get(runId, toolCallId, callRow.seq) as { payload: string } | undefined
      return row ? JSON.parse(row.payload) : undefined
    },

    toolResultForInput(
      runId: string,
      toolName: string,
      input: unknown,
      occurrence: number,
    ): unknown | undefined {
      // P2-T2-DESIGN §5 (replay requires reproducible ids): unlike
      // toolResultFor, which keys on the caller-minted toolCallId, this lookup
      // keys on the journaled tool_call PAYLOAD (toolName + structurally-equal
      // input), so it reproduces across a process restart where
      // idGen.uuid() mints a fresh, never-matching id. The caller consumes
      // occurrences in order (0, 1, ...), so the same tool called twice with
      // an identical input in one run resolves deterministically to distinct
      // results: the Nth journaled COMPLETED match answers the Nth live
      // dispatch.
      //
      // Only an attempt that COMPLETED — a matched tool_call with a non-null
      // correlation and a later tool_result carrying that correlation (the
      // same seq-bounded, per-correlation guard toolResultFor applies) —
      // counts toward `occurrence` and can answer a dispatch. A matched
      // tool_call that is still in-flight (no completing tool_result), or
      // whose correlation is null, is SKIPPED rather than counted: it has no
      // result to replay, and counting it would let a kill-9'd attempt
      // permanently shadow the completed re-execution journaled after it
      // under a fresh correlation — a resumed process restarts its occurrence
      // counter at 0, so the shadowed result would never be reached and every
      // resume would re-run the side-effecting tool. When no completed match
      // answers the requested occurrence the lookup resolves undefined, so
      // the caller re-executes live rather than reusing a stale result or
      // skipping a side-effecting call.
      const rows = db
        .query(
          "SELECT seq, correlation, payload FROM run_events WHERE run_id = ? AND event_type = 'tool_call' ORDER BY seq ASC",
        )
        .all(runId) as Array<{
        seq: number
        correlation: string | null
        payload: string
      }>
      const wantedKey = journalToolInputKey(toolName, input)
      let completed = 0
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as {
          toolName?: unknown
          input?: unknown
        }
        if (payload.toolName !== toolName) continue
        if (journalToolInputKey(toolName, payload.input) !== wantedKey) continue
        // Fail closed like toolResultFor: only a tool_result recorded AFTER
        // this tool_call under its OWN correlation proves this attempt
        // completed; an in-flight or null-correlation match is skipped.
        const correlation = row.correlation
        if (correlation == null) continue
        const resultRow = db
          .query(
            "SELECT payload FROM run_events WHERE run_id = ? AND event_type = 'tool_result' AND correlation = ? AND seq > ? ORDER BY seq DESC LIMIT 1",
          )
          .get(runId, correlation, row.seq) as { payload: string } | undefined
        if (!resultRow) continue
        if (completed !== occurrence) {
          completed += 1
          continue
        }
        return JSON.parse(resultRow.payload)
      }
      return undefined
    },

    /**
     * Slice 4: flush any buffered events, cancel the pending delay timer,
     * and close the database. Returns a promise so a batched writer can be
     * awaited before process exit; existing callers that ignore the return
     * value keep working unchanged.
     */
    close(): Promise<void> {
      drainPending()
      clearFlushTimer()
      db.close()
      return Promise.resolve()
    },
  }
}

/**
 * Pure crash classifier (design §4a). Reads the journal tail and decides how a
 * run should resume:
 * - tool_call tail with no matching tool_result → in_flight_tool (the kill-9
 *   window: the tool may or may not have applied, so replay must consult
 *   `toolResultFor` before re-executing). A tool_call tail with a null
 *   correlation is also in_flight_tool: with no correlation no later
 *   tool_result can ever match, so the call can never be proven complete.
 * - llm_request tail with no matching llm_response → in_flight_llm.
 * - anything else (tool_result/step_boundary tail, or empty) → clean.
 *
 * Only events AFTER the tail event's seq count as the match: a retry that
 * reuses the same toolCallId/correlation must not let an EARLIER attempt's
 * result classify a re-executed, still-in-flight call as clean.
 */
export function classifyRunResume(
  reader: JournalReader,
  runId: string,
): RunResumeClassification {
  const last = reader.lastEvent(runId)
  if (!last) return { kind: 'clean' }

  if (last.eventType === 'tool_call') {
    const correlation = last.correlation
    // Correlation reuse guard: only a tool_result recorded AFTER this
    // tool_call's seq can complete it. An earlier attempt's result (same
    // correlation, retried call) must not satisfy the check, or a genuinely
    // in-flight re-executed tool call would be misclassified as clean and
    // the resume path would skip the toolResultFor cross-check.
    const hasResult =
      correlation != null &&
      reader
        .events(runId)
        .some(
          (e) =>
            e.seq > last.seq &&
            e.eventType === 'tool_result' &&
            e.correlation === correlation,
        )
    if (!hasResult) {
      // A tool_call tail with no later matching tool_result is in-flight —
      // including a null correlation: with no correlation no later tool_result
      // can ever match, so the call can never be proven complete and must not
      // be classified clean (that would skip the toolResultFor cross-check
      // and could re-execute a side-effecting tool call). The empty toolCallId
      // keeps the replay cross-check fail-closed: toolResultFor finds nothing
      // for '', so the call is re-executed under live control instead of
      // being silently skipped.
      return { kind: 'in_flight_tool', toolCallId: correlation ?? '' }
    }
    return { kind: 'clean' }
  }

  if (last.eventType === 'llm_request') {
    const correlation = last.correlation
    // Same correlation-reuse guard as the tool_call branch above: only an
    // llm_response recorded AFTER this llm_request's seq can complete it, and
    // a null correlation can never match — with `null === null` any later
    // null-correlation llm_response (e.g. from a different request) would
    // otherwise satisfy the check and misclassify a genuinely in-flight
    // request as clean, so the resume path would skip in_flight_llm handling
    // and resume the loop with a response that never arrived.
    const hasResponse =
      correlation != null &&
      reader
        .events(runId)
        .some(
        (e) =>
          e.seq > last.seq &&
          e.eventType === 'llm_response' &&
          e.correlation === correlation,
      )
    if (!hasResponse) return { kind: 'in_flight_llm' }
    return { kind: 'clean' }
  }

  return { kind: 'clean' }
}

/**
 * P2-T2-DESIGN §4d: disposition of a SINGLE child run, read from the child's
 * own journal (the child's runId = the parent journal's spawn `correlation`).
 */
export type ChildRunDisposition =
  | { kind: 'child_completed'; lastEventSeq: number }
  | { kind: 'child_in_flight_tool'; childRunId: string; toolCallId: string }
  | { kind: 'child_in_flight_llm'; childRunId: string }
  | { kind: 'child_incomplete_tail'; childRunId: string }
  | { kind: 'child_unknown'; childRunId: string }

/**
 * P2-T2-DESIGN §4d: classify a SINGLE child run by reading its own journal
 * (the child's runId = the parent journal's spawn `correlation` key).
 * - A TERMINAL tail — a step_boundary — counts as child_completed
 *   (lastEventSeq = that tail's seq).
 * - child_in_flight_tool / child_in_flight_llm mirror classifyRunResume but
 *   return the childRunId verbatim.
 * - child_incomplete_tail: the child journaled progress but its tail is NOT a
 *   terminal step_boundary (e.g. a tool_result tail: the child was killed in
 *   the window between its last tool_result and the next llm_request).
 *   classifyRunResume's 'clean' is a resume-SAFETY verdict (safe to resume
 *   from the tail), not a run-COMPLETION verdict — equating the two would
 *   replay the child as finished and silently drop its final output, so a
 *   non-terminal tail must stay un-completed.
 * - child_unknown: the child journal has NO events at all for the childRunId
 *   (recording intent without any child progress).
 */
export function classifyChildRun(
  reader: JournalReader,
  childRunId: string,
): ChildRunDisposition {
  const inner = classifyRunResume(reader, childRunId)
  if (inner.kind === 'in_flight_tool') {
    return {
      kind: 'child_in_flight_tool',
      childRunId,
      toolCallId: inner.toolCallId,
    }
  }
  if (inner.kind === 'in_flight_llm') {
    return { kind: 'child_in_flight_llm', childRunId }
  }
  const last = reader.lastEvent(childRunId)
  if (last === undefined) return { kind: 'child_unknown', childRunId }
  // Only a terminal step_boundary tail proves the child run finished: a
  // tool_result (or llm_response) tail means the child was killed mid-run —
  // between its last tool_result and the next llm_request — and its final
  // output was never produced.
  if (last.eventType !== 'step_boundary') {
    return { kind: 'child_incomplete_tail', childRunId }
  }
  return { kind: 'child_completed', lastEventSeq: last.seq }
}

/**
 * P2-T2-DESIGN §4d: parent-side plan for resuming with children.
 * - live_continue: no in-flight children; the parent can resume from its own
 *   tail.
 * - needs_children: the parent must first reconcile children — inFlight are
 *   still running/in-flight (and may require live re-execution per §8),
 *   awaiting are child_completed children whose results must be cross-checked
 *   and fed back into the parent loop.
 */
export type ResumePlan =
  | { kind: 'live_continue' }
  | {
      kind: 'needs_children'
      inFlight: Array<ChildRunDisposition>
      awaiting: Array<{ childRunId: string; childLastSeq: number }>
    }

/**
 * P2-T2-DESIGN §4d: scan the parent run's journal for `spawn` events
 * (correlation = childRunId) whose childRunId does NOT ALSO have a matching
 * terminal `step_boundary` after it in the parent journal — the practical
 * signal that the child's terminal step boundary was never journaled because
 * the process died before the child (or the parent recording it) finished.
 * A spawn WITH a later `step_boundary` sharing that correlation is already
 * reconciled → skipped (not included in the plan). Spawn events without a
 * correlation cannot identify a child and are skipped.
 *
 * For each unreconciled childRunId, classify the CHILD journal via
 * classifyChildRun and fold into a ResumePlan.
 */
export function planChildResume(
  reader: JournalReader,
  parentRunId: string,
): ResumePlan {
  const events = reader.events(parentRunId)
  const inFlight: Array<ChildRunDisposition> = []
  const awaiting: Array<{ childRunId: string; childLastSeq: number }> = []

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event.eventType !== 'spawn') continue
    const childRunId = event.correlation
    if (childRunId == null) continue
    if (hasTerminalStepBoundaryAfter(events, childRunId, i + 1)) continue

    const disposition = classifyChildRun(reader, childRunId)
    if (disposition.kind === 'child_completed') {
      awaiting.push({
        childRunId,
        childLastSeq: disposition.lastEventSeq,
      })
    } else {
      inFlight.push(disposition)
    }
  }

  if (inFlight.length === 0 && awaiting.length === 0) {
    return { kind: 'live_continue' }
  }
  return { kind: 'needs_children', inFlight, awaiting }
}

/**
 * P2-T2-DESIGN §4d helper: does the parent journal contain a terminal
 * `step_boundary` whose correlation matches childRunId at or after fromIndex?
 */
function hasTerminalStepBoundaryAfter(
  events: Array<JournalEvent & { seq: number }>,
  childRunId: string,
  fromIndex: number,
): boolean {
  for (let i = fromIndex; i < events.length; i++) {
    const e = events[i]
    if (e.eventType === 'step_boundary' && e.correlation === childRunId) {
      return true
    }
  }
  return false
}

/**
 * P2-T2-DESIGN §4d replay-leg outcome for one child run.
 */
export type ChildReplayOutcome =
  | { kind: 'replayed_completed'; childRunId: string; lastSeq: number }
  | { kind: 'live_execution_required'; childRunId: string }
  | { kind: 'child_unknown'; childRunId: string }

/**
 * P2-T2-DESIGN §4d: drive ONE child's completion from its own journal (the
 * replay leg): infer its recorded state (lastEvent tail + toolResultFor)
 * without executing anything. Returns replayed_completed when the child
 * journal shows a clean terminal tail; live_execution_required for an
 * in-flight tool/llm that must be re-executed by the parent's restart logic
 * (the residual risk §8 names); child_unknown when the child journaled
 * nothing.
 */
export function executeChildReplay(
  reader: JournalReader,
  childRunId: string,
): ChildReplayOutcome {
  const disposition = classifyChildRun(reader, childRunId)
  switch (disposition.kind) {
    case 'child_completed':
      return {
        kind: 'replayed_completed',
        childRunId,
        lastSeq: disposition.lastEventSeq,
      }
    case 'child_in_flight_tool':
    case 'child_in_flight_llm':
    case 'child_incomplete_tail':
      return { kind: 'live_execution_required', childRunId }
    case 'child_unknown':
      return { kind: 'child_unknown', childRunId }
  }
}

/** One durable background-agent intent persisted on the parent AgentState. */
export type BackgroundAgentIntent = NonNullable<
  AgentState['backgroundAgentJobs']
>[number]

/**
 * P2-T2-DESIGN §4d idempotency guard: read-only agent types whose
 * re-execution has no workspace side effects, so an interrupted intent can be
 * re-spawned without confirmation.
 */
export const DEFAULT_RERUNNABLE_BACKGROUND_AGENT_TYPES: ReadonlySet<string> =
  new Set([
    'file-picker',
    'researcher-web',
    'researcher-docs',
    'librarian',
    'thinker',
    'code-reviewer',
  ])

export type BackgroundResumeDecision =
  | { kind: 'respawn'; jobId: string; agentType: string }
  | { kind: 'already_respawned'; jobId: string; respawnSpawnSeq: number }
  | {
      kind: 'needs_confirmation'
      jobId: string
      agentType: string
      reason: string
    }
  | {
      kind: 'skip_terminal'
      jobId: string
      status: 'completed' | 'error' | 'cancelled'
    }
  | { kind: 'still_running'; jobId: string }

/**
 * Whether a journaled respawn marker is settled: the respawned child's own
 * run reached a TERMINAL journal tail (classifyChildRun → child_completed).
 * A parent `spawn` event carrying `respawnOf` proves only the INTENT to
 * respawn — the child can die between the marker being journaled and its
 * first journal append, or crash after journaling a single in-flight event
 * (e.g. a lone llm_request with no matching response) — and since
 * resume-from-own-journal for background agents is deferred, a marker settled
 * on anything less would classify the intent already_respawned forever and
 * silently drop the job on every subsequent resume. An in-flight (or
 * event-free) child keeps the marker unsettled so the intent keeps
 * re-planning (respawn / needs_confirmation) and the job is re-driven instead
 * of lost; once the child's tail is terminal the marker settles and
 * re-planning becomes idempotent. When the marker carries no child runId in
 * its correlation, or no reader is wired to cross-check the child's run, the
 * marker cannot be falsified and stays authoritative.
 */
function respawnMarkerIsSettled(
  respawn: JournalEvent & { seq: number },
  reader?: JournalReader,
): boolean {
  if (!reader) return true
  const childRunId = respawn.correlation
  if (typeof childRunId !== 'string' || childRunId.length === 0) return true
  // Only a terminal child tail (a step_boundary) proves the respawned run
  // finished. An in-flight, mid-run, or empty child journal must keep
  // re-planning so an interrupted background job is never silently dropped
  // across repeated resumes.
  return classifyChildRun(reader, childRunId).kind === 'child_completed'
}

/**
 * P2-T2-DESIGN §4d / §9 slice 3: background-agent resume policy.
 *
 * Background agents are process-scoped, so a kill-9 destroys the coroutine.
 * The default policy is re-spawn-from-intent: an `interrupted` intent (see
 * reconcileInterruptedBackgroundAgentIntents, which the caller must run first;
 * this planner never mutates state) is re-spawned when its agent type is known
 * to be idempotent, otherwise it needs confirmation. A caller that re-spawns
 * must journal a parent `spawn` event whose payload includes
 * `respawnOf: <original jobId>` and whose correlation is the respawned
 * child's runId; the marker makes re-planning idempotent once the respawned
 * child's own run has reached a TERMINAL journal tail (see
 * respawnMarkerIsSettled) — an in-flight child tail keeps the intent
 * re-planning so an interrupted job is never silently dropped.
 * EVERY matching marker is scanned, so an early unsettled marker cannot mask
 * a later settled one: a settled marker permanently suppresses re-respawn,
 * and while no marker is settled the intent keeps re-planning from itself.
 * Resume-from-own-journal for background agents is deferred until background
 * coroutines journal their own stream.
 */
export function planBackgroundAgentResume(params: {
  intents: ReadonlyArray<BackgroundAgentIntent>
  reader?: JournalReader
  parentRunId?: string
  isRerunnable?: (agentType: string) => boolean
}): BackgroundResumeDecision[] {
  const isRerunnable =
    params.isRerunnable ??
    ((agentType: string) =>
      DEFAULT_RERUNNABLE_BACKGROUND_AGENT_TYPES.has(agentType))
  const parentSpawns =
    params.reader && params.parentRunId
      ? params.reader
          .events(params.parentRunId)
          .filter((event) => event.eventType === 'spawn')
      : []

  return params.intents.map((intent): BackgroundResumeDecision => {
    switch (intent.status) {
      case 'running':
        return { kind: 'still_running', jobId: intent.jobId }
      case 'completed':
      case 'error':
      case 'cancelled':
        return {
          kind: 'skip_terminal',
          jobId: intent.jobId,
          status: intent.status,
        }
      case 'interrupted': {
        // Scan EVERY respawn marker for this job, not just the first: the
        // first marker must not mask a later settled one. An early marker
        // whose respawned child never reached a terminal journal tail stays
        // unsettled, but a later resume's marker whose child completed
        // settles the intent — resolving only the first marker would
        // re-classify the job as 'respawn' on every subsequent resume and
        // duplicate a respawn that already happened, unbounded across
        // resumes.
        const settledRespawn = parentSpawns.find((event) => {
          const payload = event.payload
          return (
            typeof payload === 'object' &&
            payload !== null &&
            (payload as Record<string, unknown>).respawnOf === intent.jobId &&
            respawnMarkerIsSettled(event, params.reader)
          )
        })
        if (settledRespawn) {
          return {
            kind: 'already_respawned',
            jobId: intent.jobId,
            respawnSpawnSeq: settledRespawn.seq,
          }
        }
        // No settled respawn marker: every matching marker is intent-only
        // evidence (the respawned child never reached a terminal tail), so
        // treating any of them as proof of completion would silently drop the
        // job on every subsequent resume. Fall through and re-plan from the
        // intent instead.
        if (isRerunnable(intent.agentType)) {
          return {
            kind: 'respawn',
            jobId: intent.jobId,
            agentType: intent.agentType,
          }
        }
        return {
          kind: 'needs_confirmation',
          jobId: intent.jobId,
          agentType: intent.agentType,
          reason:
            'agent type is not known to be idempotent; re-running may repeat workspace side effects',
        }
      }
    }
  })
}

/** Combined resume view of one run: own tail, children, background intents. */
export type RunResumeReport = {
  runId: string
  self: RunResumeClassification
  children: ResumePlan
  background: BackgroundResumeDecision[]
}

/**
 * P2-T2 loop-entry resume report: folds classifyRunResume, planChildResume and
 * planBackgroundAgentResume into one pure, read-only view so the live loop can
 * surface what a resume would do. It never executes or mutates anything; the
 * replay driver that acts on it is a later slice.
 */
export function buildRunResumeReport(params: {
  reader: JournalReader
  runId: string
  intents?: ReadonlyArray<BackgroundAgentIntent>
  isRerunnable?: (agentType: string) => boolean
}): RunResumeReport {
  const { reader, runId } = params
  return {
    runId,
    self: classifyRunResume(reader, runId),
    children: planChildResume(reader, runId),
    background: planBackgroundAgentResume({
      intents: params.intents ?? [],
      reader,
      parentRunId: runId,
      isRerunnable: params.isRerunnable,
    }),
  }
}

/** True when the report shows nothing to resume (fresh or cleanly finished run). */
export function isRunResumeReportClean(report: RunResumeReport): boolean {
  return (
    report.self.kind === 'clean' &&
    report.children.kind === 'live_continue' &&
    report.background.every(
      (decision) =>
        decision.kind === 'skip_terminal' ||
        decision.kind === 'already_respawned',
    )
  )
}

/**
 * P2-T2 final REPLAY SLICE (design §4d/§9): the planning→execution seam that
 * ACTS on a RunResumeReport. `planReplayActions` is pure — it derives a
 * bounded, ordered action list from the report without reading files or
 * mutating anything — and `executeReplayActions` drives that list through
 * caller-injected seams. The CALLER owns HOW a child is re-driven or a
 * background job is respawned; the driver only invokes the seam. Every seam
 * is additive-optional: an unwired run skips the action instead of failing,
 * so runs without the replay driver wired behave byte-identically. In
 * particular the background respawn seam must NOT re-run
 * reconcileInterruptedBackgroundAgentIntents, which the caller has already
 * executed before planning (a second pass would double-respawn).
 */

/** One bounded action the replay driver may take for an interrupted run. */
export type ReplayAction =
  | {
      kind: 'replay_child'
      childRunId: string
      verdict:
        | 'replayed_completed'
        | 'live_execution_required'
        | 'child_unknown'
    }
  | { kind: 'respawn_background'; jobId: string; agentType: string }
  | {
      kind: 'needs_confirmation'
      jobId: string
      agentType: string
      reason: string
    }

/** The planner's output: ordered actions plus optional truncation evidence. */
export type ReplayPlan = {
  actions: ReplayAction[]
  /** Set only when bounded planning dropped children beyond the cap. */
  truncated?: { kind: 'children'; firstDroppedChildRunId: string }
}

/** Default cap on replay_child actions per plan (design §9: bounded planning). */
const DEFAULT_MAX_REPLAYS = 8

/**
 * Pure planner over a RunResumeReport (design §4d/§9). Never reads files,
 * never mutates, and is deterministic: the action order follows the report's
 * own order (awaiting children, then in-flight children, then background
 * decisions), so repeated planning of the same report yields identical plans.
 *
 * - `awaiting` children were already classified child_completed by
 *   planChildResume, so they plan as replay_child/replayed_completed — the
 *   planner does not re-derive what the classifier computed.
 * - `inFlight` dispositions map through the same disposition→verdict mapping
 *   executeChildReplay uses: an in-flight tool/llm tail or an incomplete tail
 *   is live_execution_required; an unknown child is child_unknown.
 * - background decisions of kind 'respawn' plan as respawn_background and
 *   'needs_confirmation' pass through verbatim; skip_terminal,
 *   already_respawned, and still_running need no action.
 *
 * Bounded: at most `maxReplays` (default 8) replay_child actions are emitted;
 * children beyond the cap are dropped in planner order and the FIRST dropped
 * childRunId is recorded on the plan. Background actions are never truncated.
 */
export function planReplayActions(
  report: RunResumeReport,
  opts: { maxReplays?: number } = {},
): ReplayPlan {
  const maxReplays = opts.maxReplays ?? DEFAULT_MAX_REPLAYS
  const actions: ReplayAction[] = []
  let truncated: ReplayPlan['truncated']
  let childActionCount = 0

  const pushChild = (
    childRunId: string,
    verdict: 'replayed_completed' | 'live_execution_required' | 'child_unknown',
  ): boolean => {
    if (childActionCount >= maxReplays) {
      truncated ??= { kind: 'children', firstDroppedChildRunId: childRunId }
      return false
    }
    actions.push({ kind: 'replay_child', childRunId, verdict })
    childActionCount += 1
    return true
  }

  if (report.children.kind === 'needs_children') {
    for (const child of report.children.awaiting) {
      if (!pushChild(child.childRunId, 'replayed_completed')) break
    }
    for (const disposition of report.children.inFlight) {
      // planChildResume never folds a child_completed disposition into
      // inFlight; this guard only narrows the union so childRunId is readable.
      if (disposition.kind === 'child_completed') continue
      const verdict =
        disposition.kind === 'child_unknown'
          ? 'child_unknown'
          : 'live_execution_required'
      if (!pushChild(disposition.childRunId, verdict)) break
    }
  }

  for (const decision of report.background) {
    if (decision.kind === 'respawn') {
      actions.push({
        kind: 'respawn_background',
        jobId: decision.jobId,
        agentType: decision.agentType,
      })
    } else if (decision.kind === 'needs_confirmation') {
      actions.push({
        kind: 'needs_confirmation',
        jobId: decision.jobId,
        agentType: decision.agentType,
        reason: decision.reason,
      })
    }
  }

  const plan: ReplayPlan = { actions }
  if (truncated) plan.truncated = truncated
  return plan
}

/** Caller-injected seams the executor drives; every seam is optional. */
export type ReplayDeps = {
  /**
   * How to re-drive one child run (the CALLER owns how — live re-drive,
   * replay-from-journal, or queueing). The driver only invokes the seam with
   * the planner's verdict.
   */
  replayChild?: (childRunId: string, verdict: string) => Promise<void>
  /**
   * How to respawn one background job. Must NOT re-run
   * reconcileInterruptedBackgroundAgentIntents: the caller has already
   * reconciled intents before planning, and a second pass would
   * double-respawn.
   */
  respawnBackground?: (jobId: string, agentType: string) => Promise<void>
  /**
   * Confirmation gate for needs_confirmation actions. Returning false — or
   * leaving the seam unwired — SKIPS the action: a non-idempotent background
   * job is never auto-run.
   */
  requestConfirmation?: (
    jobId: string,
    agentType: string,
    reason: string,
  ) => Promise<boolean>
  logger: Logger
}

/** Bounded outcome of driving a ReplayPlan's actions through the seams. */
export type ReplayExecutionResult = {
  /** Actions for which a seam was actually invoked (skips do not count). */
  attempted: number
  /**
   * Attempted actions whose seam resolved successfully; a declined
   * confirmation is a skip, not a success.
   */
  succeeded: number
  /** Attempted actions whose seam threw, with bounded error messages. */
  failed: Array<{ action: ReplayAction; error: string }>
}

/** Upper bound on a recorded seam error message (design §9: bounded surface). */
const MAX_REPLAY_ERROR_LENGTH = 300

function boundedReplayErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= MAX_REPLAY_ERROR_LENGTH
    ? message
    : `${message.slice(0, MAX_REPLAY_ERROR_LENGTH)}...`
}

/**
 * Execute a ReplayPlan's actions through the injected seams, in order. A seam
 * absence skips its action (additive-optional: an unwired run performs no
 * replay work and stays byte-identical); a declined confirmation likewise
 * SKIPS — needs_confirmation actions are never auto-run. A seam that throws
 * is recorded in `failed` with a bounded message and does not abort the
 * remaining actions.
 */
export async function executeReplayActions(
  actions: ReadonlyArray<ReplayAction>,
  deps: ReplayDeps,
): Promise<ReplayExecutionResult> {
  const { logger } = deps
  const result: ReplayExecutionResult = {
    attempted: 0,
    succeeded: 0,
    failed: [],
  }

  for (const action of actions) {
    switch (action.kind) {
      case 'replay_child': {
        if (!deps.replayChild) {
          logger.debug(
            { childRunId: action.childRunId },
            'Replay seam not wired; skipping replay_child',
          )
          continue
        }
        result.attempted += 1
        try {
          await deps.replayChild(action.childRunId, action.verdict)
          result.succeeded += 1
        } catch (error) {
          result.failed.push({
            action,
            error: boundedReplayErrorMessage(error),
          })
        }
        break
      }
      case 'respawn_background': {
        if (!deps.respawnBackground) {
          logger.debug(
            { jobId: action.jobId },
            'Respawn seam not wired; skipping respawn_background',
          )
          continue
        }
        result.attempted += 1
        try {
          await deps.respawnBackground(action.jobId, action.agentType)
          result.succeeded += 1
        } catch (error) {
          result.failed.push({
            action,
            error: boundedReplayErrorMessage(error),
          })
        }
        break
      }
      case 'needs_confirmation': {
        if (!deps.requestConfirmation) {
          logger.debug(
            { jobId: action.jobId },
            'Confirmation seam not wired; skipping needs_confirmation (never auto-run)',
          )
          continue
        }
        result.attempted += 1
        try {
          const confirmed = await deps.requestConfirmation(
            action.jobId,
            action.agentType,
            action.reason,
          )
          if (confirmed) {
            result.succeeded += 1
          } else {
            logger.debug(
              { jobId: action.jobId },
              'Confirmation declined; needs_confirmation action skipped',
            )
          }
        } catch (error) {
          result.failed.push({
            action,
            error: boundedReplayErrorMessage(error),
          })
        }
        break
      }
    }
  }

  return result
}
