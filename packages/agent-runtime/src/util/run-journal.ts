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

import { Buffer } from 'node:buffer'

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
 * Narrow structural subset of one prepared bun:sqlite statement. `run` is
 * OPTIONAL so a hand-rolled test double that only stubs all/get still
 * satisfies the database shape; prepared-statement reuse probes for it and
 * falls back to the connection-level run() when absent.
 */
type SqliteStatement = {
  all: (...params: unknown[]) => unknown[]
  get: (...params: unknown[]) => unknown
  run?: (...params: unknown[]) => unknown
}

/**
 * Narrow structural subset of the bun:sqlite `Database` API this module uses,
 * so packages whose tsconfig lacks bun-types still typecheck; the acquired
 * database is narrowed to this shape before use. Mirrors archive-recall-index.
 */
type SqliteDb = {
  run: (sql: string, ...params: unknown[]) => unknown
  query: (sql: string) => SqliteStatement
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
/**
 * Bounded per-run aggregate for journal enumeration consumers (P2-T7 dash):
 * the event count plus the FIRST event's timestamp (MIN(created_at)) per
 * runId — everything a run listing needs without hydrating the run's event
 * list.
 */
export type JournalRunSummary = {
  runId: string
  eventCount: number
  /** Epoch ms of the run's FIRST event, when the journal carries one. */
  firstCreatedAt?: number
}

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
  /**
   * Optional (P2-T7 dash) extension: enumerate the DISTINCT runIds present
   * in the journal, NEWEST FIRST (each run's FIRST event — MIN(created_at) —
   * descending), so consumers that must list runs (the `openbuff dash`
   * provider) need no out-of-band id list. MIN (not MAX) is the contract: a
   * later append to an OLD run must not promote it above runs whose first
   * events are newer. Optional so an existing implementor of this
   * interface is never broken by an added member; consumers must probe for
   * it structurally and surface no runs when it is absent.
   */
  runIds?(): string[]
  /**
   * Optional (P2-T7 dash) extension: per-run COUNT + MIN(created_at)
   * aggregates, NEWEST FIRST (MIN(created_at) descending — the same order
   * runIds() documents), so consumers that list runs (the `openbuff dash`
   * provider) never hydrate every event of every run per poll. Optional so
   * an existing implementor is never broken by an added member; consumers
   * must probe for it structurally and fall back to per-run events() when
   * it is absent, keeping results identical.
   */
  runSummaries?(): JournalRunSummary[]
  /**
   * Optional write-side FILE-LEVEL maintenance: prune old RUNS from the
   * journal — keeping the newest `keepRuns` runs by first-event order via
   * the existing runIds()/pruneRuns() pair — and optionally VACUUM the
   * shared file so a WAL sqlite db actually shrinks after deletes
   * (per-run retention bounds each runId's ROWS but never the number of
   * runs a shared file accumulates). WRITE-SIDE ONLY: readers (`openbuff
   * dash`, `openbuff replay`) never call it and stay non-deleting. Never
   * throws onto the caller; optional so an existing implementor of this
   * interface is never broken by an added required member.
   */
  maintain?(params?: {
    keepRuns?: number
    vacuum?: boolean
  }): { prunedRunCount: number; vacuumed: boolean }
  /**
   * Optional (slice-4 hardening): force-drain any hot-path-batched events so
   * everything appended so far is durably committed BEFORE a side-effecting
   * tool executes — closing the kill-9 replay double-execution window that
   * batching otherwise opens (a batching writer defers the tool_call
   * completion-marker commit past tool execution). The built-in journal
   * drains synchronously, so the marker is committed before the caller
   * proceeds. Optional so an existing implementor is never broken by an
   * added member (a per-append writer has nothing buffered; its drain is a
   * no-op). Callers must probe structurally (`typeof writer.forceFlush ===
   * 'function'`), mirroring the runIds treatment.
   */
  forceFlush?(): Promise<void>
  /**
   * Optional (slice-4 hardening) bounded read: the LAST `limit` events for
   * runId, NEWEST FIRST (ORDER BY seq DESC LIMIT ...). Consumers that only
   * inspect a run's tail (classifyRunResume) use this instead of
   * materializing the full event list; they must probe for it structurally
   * and fall back to events() when it is absent, keeping results identical.
   */
  recentEvents?(runId: string, limit: number): JournalEventRow[]
  /**
   * Optional (slice-4 hardening) targeted read: EVERY event of one eventType
   * for runId in seq ASC order, served by the (run_id, event_type, seq)
   * index. Consumers that only need one event type (planChildResume's
   * spawn/step_boundary scan) use this instead of loading and filtering the
   * full event list; they must probe for it structurally and fall back to
   * events() when it is absent, keeping results identical.
   */
  eventsOfType?(
    runId: string,
    eventType: JournalEvent['eventType'],
  ): JournalEventRow[]
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
  /** P2-T7 dash extension: always provided by the built-in journal. */
  runIds(): string[]
  /** P2-T7 dash extension: always provided by the built-in journal. */
  runSummaries(): JournalRunSummary[]
  /**
   * Write-side file-level maintenance: always provided by the built-in
   * journal. `prunedRunCount` counts RUNS deleted (runs present minus
   * kept), not rows; `vacuumed` is true only when VACUUM completed.
   */
  maintain(params?: {
    keepRuns?: number
    vacuum?: boolean
  }): { prunedRunCount: number; vacuumed: boolean }
  /** Slice-4 hardening: always provided by the built-in journal. */
  forceFlush(): Promise<void>
  /** Slice-4 hardening bounded read: always provided by the built-in journal. */
  recentEvents(runId: string, limit: number): JournalEventRow[]
  /** Slice-4 hardening targeted read: always provided by the built-in journal. */
  eventsOfType(
    runId: string,
    eventType: JournalEvent['eventType'],
  ): JournalEventRow[]
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

/** Cast shapes for the prepared hot-path statements' single-row reads. */
type MaxSeqRow = { max_seq: number | null } | undefined
type SideTotalRow = { total_bytes: number } | undefined
type EventCountRow = { event_count: number } | undefined
type CountRow = { count: number } | undefined

/**
 * Structural probe for the OPTIONAL bounded-read extensions the built-in
 * sqlite journal provides (mirroring how the P2-T7 `runIds` extension is
 * probed): consumers must check `typeof reader.recentEvents === 'function'`
 * before calling, and fall back to a full `events()` load when the extension
 * is absent, keeping results identical.
 */
type BoundedReadJournalReader = JournalReader & {
  /** Last `limit` events for runId, NEWEST FIRST (ORDER BY seq DESC LIMIT). */
  recentEvents?(runId: string, limit: number): JournalEventRow[]
  /** Every event of one eventType for runId, seq ASC (index-served). */
  eventsOfType?(
    runId: string,
    eventType: JournalEvent['eventType'],
  ): JournalEventRow[]
}

/**
 * Schema, applied when the db is not yet marked initialized (the
 * PRAGMA user_version gate in createRunJournal — the CREATE ... IF NOT
 * EXISTS statements are idempotent, so a legacy db predating the marker is
 * also brought up safely on its first reopen). run_byte_totals is the
 * persisted per-run payload-byte-total side table backing the byte-cap
 * dimension of retention: it is maintained transactionally per append by
 * byte-capped writers (inside the same BEGIN IMMEDIATE...COMMIT as the
 * run_events INSERT), read lazily per runId on first use, and keeps both
 * open and the common append O(1) with exact historical totals across
 * reopen. Writers without a byte cap never touch it. A crash between a
 * retention DELETE and the side-row write leaves a bounded, self-healing
 * staleness — the first enforcement pass that runs the byte-cap greedy scan
 * recomputes the exact total from the scanned rows and rewrites the side
 * row, even when that pass deletes nothing (scan-only) — the same
 * durability class as the rest of retention. run_event_counts is the
 * persisted per-run event-count side table backing the maxEvents dimension
 * of retention, with the same contract: it is maintained transactionally
 * per append by event-capped writers (inside the same
 * BEGIN IMMEDIATE...COMMIT as the run_events INSERT), read lazily per
 * runId on first use, and keeps the per-append maxEvents enforcement O(1)
 * (one PK read + one UPDATE instead of an OFFSET boundary walk over the
 * run's index entries). Writers without an event cap never touch it; a
 * crash between a retention DELETE and the side-row write leaves the same
 * bounded, self-healing staleness — the next over-cap enforcement pass
 * derives the delete boundary from the authoritative COUNT(*) and rewrites
 * the side row.
 */
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
CREATE INDEX IF NOT EXISTS idx_run_events_run_type_seq ON run_events (run_id, event_type, seq);
CREATE TABLE IF NOT EXISTS run_byte_totals (run_id TEXT PRIMARY KEY, total_bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS run_event_counts (run_id TEXT PRIMARY KEY, event_count INTEGER NOT NULL);
`

/**
 * Persistence marker for the per-send open gate: the open that applies
 * SCHEMA_SQL (and journal_mode=WAL) stamps PRAGMA user_version with this
 * value, and every later open of the same file skips both after a single
 * cheap marker read. The marker is stamped ONLY after the schema it vouches
 * for, so a crash in between leaves it at 0 and the next open re-runs the
 * idempotent schema instead of trusting a half-initialized db. Legacy dbs
 * written before this marker read 0 and self-heal the same way. Bumped
 * 1 → 2 when run_event_counts was added: a db initialized before that
 * table existed carries marker 1 < 2, so its next open re-runs the
 * idempotent schema once — creating the new table — and re-stamps the
 * marker.
 */
const SCHEMA_USER_VERSION = 2

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
 * Default run count kept by maintain(): a maintenance pass keeps the newest
 * 10 runs by first-event order (see maintain).
 */
const DEFAULT_MAINTAIN_KEEP_RUNS = 10

/**
 * Bounded tail window for classifyRunResume (slice-4 hardening): the resume
 * match predicates only ever fire for events AFTER the tail event's seq, and
 * the built-in reader's lastEvent IS the max-seq row, so a bounded
 * newest-first window (ORDER BY seq DESC LIMIT, via the optional
 * recentEvents extension) decides the classification without materializing
 * the run's full event list. Readers without recentEvents fall back to a
 * full events() load with identical results.
 */
const RESUME_TAIL_EVENT_LIMIT = 64

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
 * the injectable seam. Constructs the schema when the db is not yet marked
 * initialized (a PRAGMA user_version gate skips the persistent SCHEMA_SQL
 * DDL and journal_mode=WAL on an already-initialized db, so the per-send
 * open pays one cheap marker read instead of re-running them) and injects the
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

  // synchronous (like busy_timeout above) is a CONNECTION-scoped setting that
  // resets on every new connection: both are in-memory flags with no I/O
  // cost, so they are re-applied on EVERY open. Skipping them would silently
  // change durability (synchronous) and lock-wait (busy_timeout) behavior
  // for every reopened connection; only the PERSISTENT fixed I/O below is
  // gated per send.
  if (path !== ':memory:') {
    db.run('PRAGMA synchronous=NORMAL;')
  }

  // Per-send open gate: SCHEMA_SQL (6 CREATE ... IF NOT EXISTS statements)
  // and journal_mode=WAL are PERSISTENT database state — once applied they
  // cost real I/O on every reopen while changing nothing. Gate both on the
  // cheap PRAGMA user_version marker so an already-initialized db pays one
  // marker read instead of re-running the DDL round-trip. :memory: dbs are
  // always fresh (the marker is never stamped for them) and keep the
  // unconditional path.
  let schemaInitialized = false
  if (path !== ':memory:') {
    const marker = db
      .query('PRAGMA user_version')
      .get() as { user_version: number } | undefined
    schemaInitialized = (marker?.user_version ?? 0) >= SCHEMA_USER_VERSION
  }
  if (!schemaInitialized) {
    // WAL is persisted in the db header, so re-issuing it on an already-WAL
    // db is pure per-send overhead. The marker below is stamped only after
    // WAL + SCHEMA_SQL succeeded on this same open, so marker >= 1 proves
    // both are already in place.
    if (path !== ':memory:') {
      db.run('PRAGMA journal_mode=WAL;')
    }
    db.run(SCHEMA_SQL)
    if (path !== ':memory:') {
      // Stamp the marker ONLY after the schema it vouches for is applied: a
      // crash between the two leaves it at 0 and the next open re-runs the
      // idempotent schema instead of trusting a half-initialized db.
      db.run(`PRAGMA user_version = ${SCHEMA_USER_VERSION};`)
    }
  }

  // Hot per-append/retention statements (P2 perf): prepared ONCE per
  // connection and reused by insertEvent/enforceRetention/getRunPayloadBytes
  // instead of re-issuing db.query(...) — a fresh query object — on every
  // append attempt or enforcement pass. Prepared AFTER the schema gate above
  // so the referenced tables exist on a fresh db (SQLite resolves tables at
  // prepare time). Each retention dimension's statements are prepared only
  // when that dimension's cap is set: a writer without the cap never touches
  // that dimension's side table and never pays the prepare. The UPDATE /
  // INSERT writes execute through the prepared statement's run() when the
  // underlying statement exposes one (the real bun:sqlite statement does); a
  // structural double that only stubs all/get falls back to the
  // connection-level run, keeping that path behavior-identical. The over-cap
  // retention DELETE both dimensions share is prepared LAZILY on the first
  // deleting pass (see runDeleteRunEventsPrefix) — the same run()-or-fallback
  // execution — so a writer that never crosses a cap never pays its prepare.
  const selectMaxSeq = db.query(
    'SELECT MAX(seq) AS max_seq FROM run_events WHERE run_id = ?',
  )
  // The main run_events INSERT is the highest-frequency statement on the
  // per-send path, so it is prepared once per connection like every other
  // hot statement (no cap gating: the INSERT is unconditional). A
  // structural double whose statement lacks run() falls back to the
  // connection-level run, keeping that path behavior-identical.
  const insertRunEventSql =
    'INSERT INTO run_events (run_id, seq, step_number, event_type, correlation, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  const insertRunEvent = db.query(insertRunEventSql)
  const runInsertEvent = (...params: unknown[]): void => {
    if (typeof insertRunEvent.run === 'function') {
      insertRunEvent.run(...params)
      return
    }
    db.run(insertRunEventSql, ...params)
  }
  const selectSideRowTotal =
    maxBytesCap !== undefined
      ? db.query('SELECT total_bytes FROM run_byte_totals WHERE run_id = ?')
      : undefined
  const updateSideRowTotalSql =
    'UPDATE run_byte_totals SET total_bytes = ? WHERE run_id = ?'
  const updateSideRowTotal =
    maxBytesCap !== undefined ? db.query(updateSideRowTotalSql) : undefined
  const runSideRowUpdate = (...params: unknown[]): void => {
    if (updateSideRowTotal && typeof updateSideRowTotal.run === 'function') {
      updateSideRowTotal.run(...params)
      return
    }
    db.run(updateSideRowTotalSql, ...params)
  }
  // The byte side-row UPSERT (the seed branch and EVERY over-cap
  // steady-state re-persist — it executes on each deleting append) is the
  // UPDATE's twin: prepared ONCE per connection behind the same cap gate and
  // the same structural-double fallback, so no per-append or per-enforcement
  // pass re-parses its SQL through a connection-level db.run.
  const insertSideRowTotalSql =
    'INSERT OR REPLACE INTO run_byte_totals (run_id, total_bytes) VALUES (?, ?)'
  const insertSideRowTotal =
    maxBytesCap !== undefined ? db.query(insertSideRowTotalSql) : undefined
  const runSideRowInsert = (...params: unknown[]): void => {
    if (insertSideRowTotal && typeof insertSideRowTotal.run === 'function') {
      insertSideRowTotal.run(...params)
      return
    }
    db.run(insertSideRowTotalSql, ...params)
  }
  const selectEventCount =
    maxEventsCap !== undefined
      ? db.query('SELECT event_count FROM run_event_counts WHERE run_id = ?')
      : undefined
  const updateEventCountSql =
    'UPDATE run_event_counts SET event_count = ? WHERE run_id = ?'
  const updateEventCount =
    maxEventsCap !== undefined ? db.query(updateEventCountSql) : undefined
  const runEventCountUpdate = (...params: unknown[]): void => {
    if (updateEventCount && typeof updateEventCount.run === 'function') {
      updateEventCount.run(...params)
      return
    }
    db.run(updateEventCountSql, ...params)
  }
  const insertEventCountRowSql =
    'INSERT OR REPLACE INTO run_event_counts (run_id, event_count) VALUES (?, ?)'
  const insertEventCountRow =
    maxEventsCap !== undefined ? db.query(insertEventCountRowSql) : undefined
  const runEventCountInsert = (...params: unknown[]): void => {
    if (insertEventCountRow && typeof insertEventCountRow.run === 'function') {
      insertEventCountRow.run(...params)
      return
    }
    db.run(insertEventCountRowSql, ...params)
  }
  const countRunEvents =
    maxEventsCap !== undefined
      ? db.query('SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?')
      : undefined
  const selectExcessBoundary =
    maxEventsCap !== undefined
      ? db.query(
          'SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq ASC LIMIT 1 OFFSET ?',
        )
      : undefined
  // Byte-cap walk statements, TWO-PHASE so the walk's byte work is
  // bounded by the rows it CONSUMES, never by a page's payload bytes:
  // phase 1 pages SEQ ONLY (a covering (run_id, seq) index scan — no
  // payload byte is touched), phase 2 reads ONE row's payload LENGTH by
  // primary key per row the walk actually consumes. A combined
  // (seq, LENGTH) page evaluates LENGTH on EVERY row of each page — on
  // ~500KB payloads that is ~256MB of payload touches per append even
  // when the steady-state cut lands on the first row, reintroducing the
  // per-append full scan the side tables exist to eliminate. Both are
  // prepared LAZILY on the first walk (memoized for the connection's
  // lifetime) so under-cap writers never prepare statements they never
  // execute — the same once-per-connection contract as the eager
  // statements above without the eager prepare cost.
  const BYTE_WALK_PAGE_SIZE = 512
  let bytePrefixSeqPageStmt: SqliteStatement | undefined
  const getBytePrefixSeqPage = (): SqliteStatement => {
    if (!bytePrefixSeqPageStmt) {
      bytePrefixSeqPageStmt = db.query(
        'SELECT seq FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
      )
    }
    return bytePrefixSeqPageStmt
  }
  let byteRowLenStmt: SqliteStatement | undefined
  const getByteRowLen = (): SqliteStatement => {
    if (!byteRowLenStmt) {
      byteRowLenStmt = db.query(
        'SELECT LENGTH(CAST(payload AS BLOB)) AS len FROM run_events WHERE run_id = ? AND seq = ?',
      )
    }
    return byteRowLenStmt
  }
  // The shared over-cap retention DELETE ('DELETE FROM run_events WHERE
  // run_id = ? AND seq <= ?' — issued by BOTH cap branches' deleting paths, at
  // the same per-deleting-append frequency as the re-persists that run beside
  // it) is prepared LAZILY on the first deleting pass and memoized for the
  // connection's lifetime, so an uncapped or never-over-cap writer never pays
  // the prepare — the same once-per-connection contract as the eager
  // statements above. It then executes through the prepared statement's
  // run(), mirroring runSideRowInsert/runEventCountInsert; a structural
  // double whose statement lacks run() falls back to the connection-level
  // run, keeping that path behavior-identical.
  const deleteRunEventsPrefixSql =
    'DELETE FROM run_events WHERE run_id = ? AND seq <= ?'
  let deleteRunEventsPrefixStmt: SqliteStatement | undefined
  const runDeleteRunEventsPrefix = (runId: string, seq: number): void => {
    if (!deleteRunEventsPrefixStmt) {
      deleteRunEventsPrefixStmt = db.query(deleteRunEventsPrefixSql)
    }
    const stmt = deleteRunEventsPrefixStmt
    if (typeof stmt.run === 'function') {
      stmt.run(runId, seq)
      return
    }
    db.run(deleteRunEventsPrefixSql, runId, seq)
  }

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
   * Cached per-run payload-byte totals, backed by the persisted
   * run_byte_totals side table: the side row is the durable source of truth
   * (maintained inside the same transaction as each append by byte-capped
   * writers, so a runId's total is exact — historical rows included — and
   * survives reopen), while this in-memory map is the O(1) hot mirror read
   * and written on the append and retention paths. The map is seeded lazily
   * per runId on first use — from the side row when one exists (one PK
   * read), else from the exact per-run SQL SUM (legacy dbs predating the
   * side table, or a brand-new runId) — then maintained: insertEvent adds
   * each committed event's serialized byte length inside its own
   * transaction, and any retention DELETE recomputes the exact total from
   * SQL and re-persists it. Without a per-run total cache EVERY append with
   * byte retention ran a full per-run ordered scan (O(n) per append), and
   * the old eager open-time seed additionally scanned ALL runs ever
   * journaled, making open O(total journal size); open is now O(1) and each
   * run only pays for itself when its byte cap is first enforced.
   */
  const runPayloadBytes = new Map<string, number>()
  const recomputeRunPayloadBytes = (runId: string): number => {
    const row = db
      .query(
        'SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS total FROM run_events WHERE run_id = ?',
      )
      .get(runId) as { total: number } | undefined
    return row?.total ?? 0
  }

  /**
   * Side-table-first lazy read: the cached total for runId, or undefined
   * when neither the in-memory mirror nor the persisted side table has one
   * (the signal enforceRetention uses to fall back to the exact SQL SUM
   * recompute, kept unchanged below). O(1) on a map hit, one PK read on a
   * side-table hit — never a payload scan.
   */
  const getRunPayloadBytes = (runId: string): number | undefined => {
    const cached = runPayloadBytes.get(runId)
    if (cached !== undefined) return cached
    const row = selectSideRowTotal?.get(runId) as SideTotalRow
    if (row) {
      runPayloadBytes.set(runId, row.total_bytes)
      return row.total_bytes
    }
    return undefined
  }

  /**
   * Cached per-run event counts, backed by the persisted run_event_counts
   * side table: the same contract as the byte total above — the side row is
   * the durable source of truth (maintained inside the same transaction as
   * each append by event-capped writers, so a runId's count is exact and
   * survives reopen), while this in-memory map is the O(1) hot mirror read
   * and written on the append and retention paths, seeded lazily per runId
   * on first use (from the side row when one exists — one PK read — else
   * from the exact per-run SQL COUNT for a legacy db predating the side
   * table). Without it every maxEvents-capped append walked up to cap-1
   * (run_id, seq) index entries through an OFFSET boundary query; with it an
   * under-cap append performs no boundary walk at all.
   */
  const runEventCounts = new Map<string, number>()

  /**
   * Side-table-first lazy read mirroring getRunPayloadBytes: the cached
   * count for runId, or undefined when neither the in-memory mirror nor the
   * persisted side table has one (the signal enforceRetention uses to fall
   * back to the exact SQL COUNT below). O(1) on a map hit, one PK read on a
   * side-table hit — never an index walk.
   */
  const getRunEventCount = (runId: string): number | undefined => {
    const cached = runEventCounts.get(runId)
    if (cached !== undefined) return cached
    const row = selectEventCount?.get(runId) as EventCountRow
    if (row) {
      runEventCounts.set(runId, row.event_count)
      return row.event_count
    }
    return undefined
  }

  /**
   * Bounded oldest-first TWO-PHASE walk backing byte-cap enforcement and
   * byte accounting: phase 1 pages SEQ ONLY (a covering (run_id, seq)
   * index scan — no payload byte is touched), phase 2 reads one row's
   * payload LENGTH by primary key per row the walk actually CONSUMES, so
   * the byte work is O(rows consumed) — never a page of payload LENGTH
   * evaluations (a combined (seq, LENGTH) page pays LENGTH on EVERY row
   * of each page: on ~500KB payloads that is ~256MB of payload touches
   * per append even when the steady-state cut lands on the first row,
   * reintroducing the per-append full scan the side tables exist to
   * eliminate). The walk stops at the first row whose cumulative sum
   * reaches `excessBytes` (the cut boundary — that row is the LAST
   * DELETED), at the newest row (never deleted), or at the end of the
 * run. Returns the cut seq, the authoritative bytes of the walked
 * prefix (the deleted rows when a cut was found), the exact bytes of
 * EVERY row walked (the surviving run's exact total when the newest
 * row was reached), the NUMBER OF ROWS the walk visited (the base for
 * the count side row's O(1) post-delete re-persist: visited minus the
 * newest row when the walk stopped at it is exactly the rows with
 * seq <= cutSeq), whether the newest row stopped the walk, and the
 * last walked seq below the newest row (the cut for the
 * newest-row-alone-over-cap case). O(rows walked) — bounded by the
 * rows being deleted, never by the retained window.
   */
  const walkBytePrefix = (
    runId: string,
    excessBytes: number,
    newestSeq: number,
  ): {
    cutSeq: number
    prefixBytes: number
    walkedBytes: number
    walkedRows: number
    hitNewest: boolean
    lastBelowNewest: number
  } => {
    let lastSeq = -1
    let cumulative = 0
    let walkedBytes = 0
    let walkedRows = 0
    let cutSeq = -1
    let hitNewest = false
    while (!hitNewest && cutSeq < 0) {
      const page = (getBytePrefixSeqPage().all(
        runId,
        lastSeq,
        BYTE_WALK_PAGE_SIZE,
      ) ?? []) as Array<{ seq: number }>
      if (page.length === 0) break
      for (const row of page) {
        const lenRow = getByteRowLen().get(runId, row.seq) as
          | { len: number }
          | undefined
        const len = lenRow?.len ?? 0
        walkedBytes += len
        walkedRows += 1
        if (row.seq === newestSeq) {
          hitNewest = true
          break
        }
        cumulative += len
        lastSeq = row.seq
        if (cumulative >= excessBytes) {
          cutSeq = row.seq
          break
        }
      }
    }
    return {
      cutSeq,
      prefixBytes: cumulative,
      walkedBytes,
      walkedRows,
      hitNewest,
      lastBelowNewest: lastSeq,
    }
  }

  /**
   * Slice 4: enforce the per-run retention bounds by deleting the OLDEST
   * rows beyond the cap. Surviving seq numbers are NEVER rewritten: deletion
   * leaves gaps at the low end and the next append still mints MAX(seq) + 1,
   * which is why classifyRunResume (and every reader here) orders by seq —
   * lastEvent is ORDER BY seq DESC LIMIT 1, not a row count — and keeps
   * classifying the retained tail correctly. The NEWEST row is always
   * retained even when it alone exceeds maxBytes, so a kill-9'd tail event
   * (e.g. an in-flight tool_call) is never deleted out from under the resume
   * classifier. BOTH dimensions read their per-run aggregate
   * side-table-first (persisted in run_byte_totals / run_event_counts inside
   * each append's transaction, mirrored in the in-memory caches) and only
   * pay scan/COUNT work when the aggregate is actually over the cap, so
   * retention stays O(1) per append in the common case for BOTH the byte
   * and the event-count dimension. A crash between a retention DELETE and a
   * side-row re-persist leaves a bounded, self-healing staleness: the next
   * enforcement pass that finds the aggregate over the cap recomputes the
   * exact value from SQL and rewrites the side row.
   */
  const enforceRetention = (runId: string): void => {
    if (maxEventsCap === undefined && maxBytesCap === undefined) return
    // Best-effort by design: the append (or flush) that triggered retention
    // has already committed durably, so a retention failure (e.g. transient
    // SQLITE_BUSY on the DELETE) must not surface as a failed append. The
    // next append re-runs enforcement, so a skipped pass only delays the
    // bound by one event.
    try {
      let deletedRows = false
      // Byte-cap accounting for the O(1) post-delete re-persist (see the
      // shared re-persist below): the count branch contributes the walked
      // bytes of the rows IT deleted (bounded by the count excess), the
      // byte branch contributes its own walked prefix, and
      // effectiveByteTotal is the surviving set's byte total those
      // subtractions apply to (the side total minus the count-deleted
      // bytes, corrected in place when a walk observes the exact total).
      let countDeletedBytes: number | undefined = undefined
      let byteDeletedBytes: number | undefined = undefined
      let effectiveByteTotal = 0
      // Deleted-ROW counts for the O(1) count re-persist below: the count
      // branch contributes its excess (the rows with seq <= boundary.seq),
      // the byte branch the rows its final cut walk consumed — so the
      // post-delete count is exact by subtraction, never a second
      // O(retained) COUNT(*).
      let countDeletedRows = 0
      let byteDeletedRowsCount = 0
      // The count branch's aggregates, hoisted for the shared re-persist:
      // passCount is the fast-path (side/cached) count this pass started
      // from, exactCountAtPass the authoritative pre-delete COUNT(*) when
      // the count was over the cap. Either is an exact subtraction base.
      let passCount: number | undefined = undefined
      let exactCountAtPass: number | undefined = undefined
      if (maxEventsCap !== undefined) {
        // Event-count fast path: the per-run event count is read
        // side-table-first (persisted in run_event_counts inside each
        // append's transaction, mirrored in the in-memory cache), so an
        // under-cap append performs NO boundary walk at all — O(1) per
        // append. Only an over-cap count pays the enforcement work below.
        let count = getRunEventCount(runId)
        if (count === undefined) {
          // Legacy db (no side row yet) or a never-seeded runId: one exact
          // COUNT, then the map caches it (the side row itself is seeded by
          // the next append's insertEvent maintenance).
          const row = countRunEvents?.get(runId) as CountRow
          count = row?.count ?? 0
          runEventCounts.set(runId, count)
        }
        // The fast-path count for this pass — the post-delete arithmetic's
        // base whenever the count never went over the cap.
        passCount = count
        if (count > maxEventsCap) {
          // AUTHORITATIVE count for the delete decision: the cached/side
          // count is only the fast-path check and must never drive deletes
          // (a stale count could over-delete), mirroring the byte
          // dimension's rule.
          const exactRow = countRunEvents?.get(runId) as CountRow
          const exactCount = exactRow?.count ?? 0
          // The authoritative pre-delete base for the post-delete arithmetic.
          exactCountAtPass = exactCount
          const excess = exactCount - maxEventsCap
          if (excess > 0) {
            // The excess-th OLDEST row bounds the deleted window: the ASC
            // OFFSET(excess - 1) walk's length is the number of rows being
            // DELETED (amortized O(1) per deletion) instead of always ~cap,
            // and OFFSET beyond the row count is impossible because
            // excess <= exactCount - 1 < exactCount — so a stale inflated
            // count can never over-delete, and the newest row (OFFSET
            // exactCount - 1) is never the boundary.
            const boundary = selectExcessBoundary?.get(
              runId,
              excess - 1,
            ) as { seq: number } | undefined
            if (boundary) {
              if (maxBytesCap !== undefined) {
                // Byte accounting for the rows this count-delete is about
                // to remove: one bounded oldest-first walk over exactly the
                // deleted prefix (its length IS the count excess) BEFORE
                // the delete (the rows are gone afterwards), so the shared
                // re-persist below can update the byte side row in O(1)
                // instead of an O(retained) SUM after a count delete too.
                let sumSeq = -1
                let summed = 0
                for (;;) {
                  const page = (getBytePrefixSeqPage().all(
                    runId,
                    sumSeq,
                    BYTE_WALK_PAGE_SIZE,
                  ) ?? []) as Array<{ seq: number }>
                  if (page.length === 0) break
                  let summedPage = false
                  for (const row of page) {
                    const lenRow = getByteRowLen().get(runId, row.seq) as
                      | { len: number }
                      | undefined
                    summed += lenRow?.len ?? 0
                    sumSeq = row.seq
                    if (row.seq >= boundary.seq) {
                      summedPage = true
                      break
                    }
                  }
                  if (summedPage) break
                }
                countDeletedBytes = summed
              }
              runDeleteRunEventsPrefix(runId, boundary.seq)
              deletedRows = true
              // The rows this count-delete removed — exactly the excess
              // (the boundary walk's OFFSET guaranteed they exist).
              countDeletedRows = excess
            }
          }
          // Self-heal a stale side row: a crash between a retention DELETE
          // and the side-row re-persist can leave an inflated
          // run_event_counts row. That staleness is bounded and self-healing
          // on the next over-cap pass: the authoritative pre-delete COUNT
          // this pass already ran exposes it, and the rewrite below happens
          // once per staleness event, never per append (the deletedRows
          // block below re-persists the post-delete count ARITHMETICALLY
          // when this pass deleted rows).
          if (exactCount !== count) {
            runEventCounts.set(runId, exactCount)
            // The heal fires ONCE per staleness event; route it through the
            // once-prepared run_event_counts upsert (mirroring the byte
            // side's runSideRowInsert heal) instead of re-parsing the SQL
            // through a connection-level db.run.
            runEventCountInsert(runId, exactCount)
          }
        }
      }
      if (maxBytesCap !== undefined) {
        // Byte budget over serialized payload sizes (the dominant per-row
        // term; fixed column overhead is not counted). LENGTH(CAST(payload
        // AS BLOB)) counts UTF-8 BYTES, not characters: bare LENGTH on a
        // TEXT column counts characters, so multibyte payloads would be
        // under-counted and the retained tail could exceed the byte budget.
        //
        // The per-run total is read side-table-first (one PK read from the
        // persisted run_byte_totals on a cold cache, then the in-memory
        // mirror), so historical bytes committed by earlier sessions are
        // ALWAYS included for a runId that already has rows — the byte cap
        // stays enforceable across kill-9 resume and per-send reopen. The
        // recompute right below runs only for a runId with no side row and
        // no cache entry, the common append never runs a full ordered scan,
        // and open stays O(1) instead of scanning every run ever journaled
        // at open. Over cap, a BOUNDED oldest-first walk replaces the old
        // full-run scan: it consumes only the rows being DELETED (steady
        // state re-crosses the cap by ~one event, so ~one row per append),
        // its own prefix sums drive the cut, and the exact remaining total
        // is re-persisted in O(1) from the walked bytes after any delete.
        // The newest row is never deleted: the walk stops AT it and cuts
        // below it instead, keeping as many NEWEST rows as the cap allows.
        let total = getRunPayloadBytes(runId)
        if (total === undefined) {
          total = recomputeRunPayloadBytes(runId)
          runPayloadBytes.set(runId, total)
        }
        // The count branch may have already deleted rows this pass: their
        // bytes are still in the side total, so the surviving set's total
        // subtracts them before the byte walk decides anything.
        const countBytes = countDeletedBytes ?? 0
        const survivingTotal = total - countBytes
        effectiveByteTotal = survivingTotal
        if (survivingTotal > maxBytesCap) {
          // Bounded oldest-first walk — O(rows DELETED), never O(retained):
          // steady state re-crosses the cap by ~one event's bytes, so the
          // walk consumes ~one row and never touches the retained suffix.
          // The cached/side total is only the fast-path trigger; the
          // walk's own prefix sums drive the cut, and the newest row is
          // never deleted (the walk stops AT it and cuts below it).
          const newestSeq =
            (selectMaxSeq.get(runId) as MaxSeqRow)?.max_seq ?? -1
          const excess = survivingTotal - maxBytesCap
          const first = walkBytePrefix(runId, excess, newestSeq)
          let cutSeq = first.cutSeq
          let prefixBytes = first.prefixBytes
          // The walk whose cut wins also supplies the deleted-ROW count for
          // the O(1) count re-persist below: rows visited minus the newest
          // row when the walk stopped at it is exactly the rows with
          // seq <= cutSeq.
          let cutWalk = first
          if (first.hitNewest && cutSeq < 0) {
            // The walk reached the NEWEST row without crossing the assumed
            // excess, so walkedBytes is the EXACT surviving total (every
            // row was consumed): either the side row was stale-inflated or
            // the newest row alone exceeds the cap. Self-heal the side row
            // from the walked exact value first — the scan-only heal — so
            // a stale-over-cap / exact-under-cap state costs one full walk
            // ONCE (the staleness event) instead of on every append.
            if (first.walkedBytes !== survivingTotal) {
              effectiveByteTotal = first.walkedBytes
              runPayloadBytes.set(runId, first.walkedBytes)
              runSideRowInsert(runId, first.walkedBytes)
            }
            if (first.walkedBytes > maxBytesCap) {
              const exactExcess = first.walkedBytes - maxBytesCap
              if (exactExcess < excess) {
                // Stale-inflated side row: re-walk with the EXACT excess
                // so the inflated assumption can never over-delete (this
                // pass already paid the once-per-staleness-event full
                // walk; the re-walk is bounded by the true deleted prefix).
                const second = walkBytePrefix(runId, exactExcess, newestSeq)
                cutSeq = second.cutSeq
                prefixBytes = second.prefixBytes
                cutWalk = second
                if (second.hitNewest && cutSeq < 0) {
                  cutSeq = second.lastBelowNewest
                }
              } else {
                // Side row was exact: the newest row alone exceeds the cap
                // — delete everything older than it.
                cutSeq = first.lastBelowNewest
              }
            }
          }
          if (cutSeq >= 0) {
            runDeleteRunEventsPrefix(runId, cutSeq)
            deletedRows = true
            byteDeletedBytes = prefixBytes
            // The rows this byte-delete removed, from the walk whose cut
            // won: visited rows minus the newest row when the walk stopped
            // at it — exactly the rows with seq <= cutSeq.
            byteDeletedRowsCount =
              cutWalk.walkedRows - (cutWalk.hitNewest ? 1 : 0)
          }
        }
      }
      // Any DELETE (from either cap) invalidates the cached byte total:
      // re-persist the exact remaining total so the next append's O(1)
      // increment stays accurate AND survives reopen. Every deleting
      // branch contributed the AUTHORITATIVE walked bytes of exactly the
      // rows it deleted, so the remaining total is the (walk-corrected)
      // surviving total minus those — O(1), with no O(retained) SUM
      // recompute on any steady-state over-cap path. A crash between the
      // DELETE and this write leaves a bounded, self-healing staleness:
      // the next enforcement pass's walk observes the exact surviving
      // total and rewrites the side row.
      if (deletedRows && maxBytesCap !== undefined) {
        const exact = effectiveByteTotal - (byteDeletedBytes ?? 0)
        runPayloadBytes.set(runId, exact)
        runSideRowInsert(runId, exact)
      }
      // A retention DELETE (from either cap) also changes ROW counts: when
      // the event cap is set, re-persist the run_event_counts side row so
      // the next append's O(1) increment and the under-cap fast path stay
      // accurate. The post-delete count is EXACT BY SUBTRACTION — never a
      // second O(retained) COUNT(*): the base is the count branch's
      // authoritative pre-delete COUNT(*) when the count went over the
      // cap, else its fast-path (side/cached) count, and each deleting
      // branch contributed the exact number of rows it removed (the count
      // branch's excess; the byte walk's consumed rows) — the same O(1)
      // re-persist contract the byte side row already follows.
      if (deletedRows && maxEventsCap !== undefined) {
        const base = exactCountAtPass ?? passCount ?? 0
        const next = base - countDeletedRows - byteDeletedRowsCount
        runEventCounts.set(runId, next)
        runEventCountInsert(runId, next)
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
          const maxRow = selectMaxSeq.get(runId) as MaxSeqRow
          const nextSeq = (maxRow?.max_seq ?? -1) + 1
          // Serialize ONCE and reuse: the persisted per-run byte total must
          // count the SAME serialization that is inserted
          // (Buffer.byteLength of this string equals LENGTH(CAST(payload AS
          // BLOB)) in SQLite).
          const serializedPayload = JSON.stringify(event.payload)
          runInsertEvent(
            runId,
            nextSeq,
            event.stepNumber,
            event.eventType,
            event.correlation ?? null,
            serializedPayload,
            clock.now(),
          )
          // Maintain the PERSISTED per-run byte total inside the same
          // transaction as the append so the total is always exact and
          // survives reopen: the cap stays enforceable for resumed and
          // persistent runIds (historical bytes included) while steady-state
          // appends stay O(1) (one PK read + one UPDATE; no payload scan).
          // Guarded on the byte cap being set: without byte retention this
          // is a no-op and the default path stays byte-identical.
          if (maxBytesCap !== undefined) {
            const newBytes = Buffer.byteLength(serializedPayload, 'utf8')
            const sideRow = selectSideRowTotal?.get(runId) as SideTotalRow
            if (sideRow) {
              const next = sideRow.total_bytes + newBytes
              runSideRowUpdate(next, runId)
              runPayloadBytes.set(runId, next)
            } else {
              // Seed branch, once per runId per db (legacy dbs predating the
              // side table, or a brand-new runId): run_events already
              // includes the just-inserted event inside this transaction, so
              // the SUM is the complete exact total — historical rows
              // included.
              const exact = recomputeRunPayloadBytes(runId)
              runSideRowInsert(runId, exact)
              runPayloadBytes.set(runId, exact)
            }
          }
          // Maintain the PERSISTED per-run event count inside the same
          // transaction as the append — the same contract as the byte side
          // table: exact, transactional, survives reopen, O(1) steady state
          // (one PK read + one UPDATE; no COUNT scan, no boundary walk).
          // Guarded on the event cap being set: without maxEvents retention
          // this is a no-op and the default path stays byte-identical.
          if (maxEventsCap !== undefined) {
            const countRow = selectEventCount?.get(runId) as EventCountRow
            if (countRow) {
              const next = countRow.event_count + 1
              runEventCountUpdate(next, runId)
              runEventCounts.set(runId, next)
            } else {
              // Seed branch, once per runId per db (legacy dbs predating the
              // side table, or a brand-new runId): run_events already
              // includes the just-inserted event inside this transaction, so
              // the COUNT is the complete exact total.
              const exactRow = countRunEvents?.get(runId) as CountRow
              const exact = exactRow?.count ?? 0
              // Param order matches the SQL's (run_id, event_count) columns:
              // the key comes FIRST. A swapped order here inserts rows keyed
              // by the count, so every lookup by runId misses and re-seeds.
              runEventCountInsert(runId, exact)
              runEventCounts.set(runId, exact)
            }
          }
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
  // Connection-lifetime flag (P2-T7 background-children close race): once
  // close() has run, the sqlite connection is gone. A detached background
  // subagent launched during the closed turn can outlive it and still
  // journal under its own runId — every post-close write must be a
  // fail-open no-op, never a throw on the closed connection.
  let closed = false

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
      // Fail-open after close: a detached background child that outlives the
      // turn whose promise chain closed the journal still appends under its
      // own runId. Dropping the event (instead of throwing on the closed
      // connection) keeps journaling fail-open — the same contract as the
      // unopenable-journal path — so a journaling outage can never fail the
      // background job itself.
      if (closed) return
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
      // Post-close no-op: nothing can be pending after close drained it, and
      // touching the closed connection must never throw.
      if (closed) return Promise.resolve()
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
          // The pruned run's cached byte total is stale after the delete;
          // drop the in-memory mirror and the persisted run_byte_totals side
          // row so a later append recomputes from SQL instead of
          // over-counting deleted bytes.
          runPayloadBytes.delete(existingRunId)
          db.run('DELETE FROM run_byte_totals WHERE run_id = ?', existingRunId)
          // The pruned run's cached event count is stale after the delete;
          // drop the in-memory mirror and the persisted run_event_counts
          // side row alongside the byte side row (a no-op when the run never
          // had an event-capped writer).
          runEventCounts.delete(existingRunId)
          db.run(
            'DELETE FROM run_event_counts WHERE run_id = ?',
            existingRunId,
          )
        }
      }
      pending = pending.filter((item) => keep.has(item.runId))
    },

    /**
     * P2-T7 dash extension: the DISTINCT runIds present in the journal,
     * NEWEST FIRST — ordered by each run's FIRST event (MIN(created_at)),
     * descending (`GROUP BY run_id ORDER BY MIN(created_at) DESC`). MIN (not
     * MAX) is the dash contract: a later append to an OLD run (e.g. a
     * late-arriving child event) must not promote it above runs whose first
     * events are newer. Read-only: it never writes or prunes.
     */
    runIds(): string[] {
      const rows = db
        .query(
          'SELECT run_id FROM run_events GROUP BY run_id ORDER BY MIN(created_at) DESC',
        )
        .all() as Array<{ run_id: string }>
      return rows.map((row) => row.run_id)
    },

    /**
     * P2-T7 dash extension: ONE bounded aggregate query — COUNT(*) plus
     * MIN(created_at) per runId, newest first — so a run listing stays
     * O(runs) even when runs are huge. Read-only: it never writes or prunes.
     */
    runSummaries(): JournalRunSummary[] {
      const rows = db
        .query(
          'SELECT run_id, COUNT(*) AS event_count, MIN(created_at) AS first_created_at FROM run_events GROUP BY run_id ORDER BY MIN(created_at) DESC',
        )
        .all() as Array<{
        run_id: string
        event_count: number
        first_created_at: number
      }>
      return rows.map((row) => ({
        runId: row.run_id,
        eventCount: row.event_count,
        ...(typeof row.first_created_at === 'number'
          ? { firstCreatedAt: row.first_created_at }
          : {}),
      }))
    },

    /**
     * Write-side FILE-LEVEL maintenance: prune old RUNS from the journal
     * and (by default) VACUUM the shared file so the space the pruned rows
     * occupied is actually returned to the filesystem — a WAL sqlite
     * file never shrinks on DELETE alone. Per-run retention bounds each
     * runId's ROWS (maxEvents/maxBytes) but never the number of runs a
     * shared file accumulates, so this is the file-level counterpart the
     * shared journal still needs. WRITE-SIDE ONLY: readers (`openbuff
     * dash`, `openbuff replay`) never call it and stay non-deleting.
     *
     * Keeps the NEWEST `keepRuns` (default 10) runs by FIRST-event order:
     * runIds() — newest first by MIN(created_at), its documented contract
     * — enumerates the runs present, and the EXISTING pruneRuns() performs
     * the delete with the first `keepRuns` ids (run_events rows plus the
     * run_byte_totals / run_event_counts side rows and still-buffered
     * events), so this method adds no pruning logic of its own.
     * `prunedRunCount` counts RUNS deleted — runs present minus kept —
     * never rows. Idempotent: when runs present <= keepRuns it is 0 and
     * the freelist-gated VACUUM below only runs when the journal has
     * free pages to reclaim.
     *
     * A NON-FINITE `keepRuns` never empties the journal: NaN and
     * -Infinity fall back to the default (10), and +Infinity keeps every
     * run present. Without that fallback a type-valid NaN bypasses the
     * clamp (Math.floor(NaN) and Math.max(1, NaN) stay NaN,
     * present.slice(0, NaN) is [], and pruneRuns([]) would delete EVERY
     * run — an irreversible wipe returned as a successful result), so
     * the keep set is never empty for any `keepRuns` a caller can pass.
     *
     * `vacuum` (default true) reclaims the pruned rows' pages by running
     * VACUUM on this journal's OWN single connection (no second
     * connection is opened), OUTSIDE any transaction — maintain opens
     * none — but ONLY when the journal actually has free pages to
     * reclaim: `PRAGMA freelist_count` is read on that same connection
     * first, and an EMPTY freelist (nothing was ever pruned, or the
     * deletes freed no whole pages) skips VACUUM entirely and reports
     * `vacuumed: false` — a full-file VACUUM must not repeat on every
     * pass for a journal whose retained runs alone exceed the caller's
     * size trigger. When free pages DO exist, VACUUM needs exclusive
     * access, so SQLITE_BUSY from a concurrent writer/reader is the
     * EXPECTED degradation (e.g. the TUI's own writer is open): it
     * resolves to `vacuumed: false` without throwing, and the prune
     * outcome is kept either way.
     *
     * Fail-open: ANY error inside maintain degrades to a returned result
     * — it never throws onto the caller, so a maintenance outage can
     * never break the caller that kicked it.
     */
    maintain(params?: {
      keepRuns?: number
      vacuum?: boolean
    }): { prunedRunCount: number; vacuumed: boolean } {
      // Post-close no-op, mirroring flush/forceFlush: the connection is
      // gone and maintenance must never throw on it.
      if (closed) return { prunedRunCount: 0, vacuumed: false }
      // Non-finite keepRuns must never produce an EMPTY keep set:
      // Math.floor(NaN) and Math.max(1, NaN) stay NaN, present.slice(0,
      // NaN) is [], and pruneRuns([]) would then delete EVERY run — an
      // irreversible wipe returned as a successful result. NaN (and
      // -Infinity) fall back to the default; +Infinity keeps every run
      // present. Either way the keep set is never empty, and a finite
      // value still clamps to a safe minimum so a misconfigured
      // non-positive keepRuns keeps the newest run instead of emptying
      // the journal.
      const requestedKeepRuns = params?.keepRuns
      const finiteKeepRuns =
        typeof requestedKeepRuns === 'number' &&
        Number.isFinite(requestedKeepRuns)
          ? requestedKeepRuns
          : DEFAULT_MAINTAIN_KEEP_RUNS
      const keepRuns =
        requestedKeepRuns === Number.POSITIVE_INFINITY
          ? Number.POSITIVE_INFINITY
          : Math.max(1, Math.floor(finiteKeepRuns))
      const shouldVacuum = params?.vacuum ?? true
      let prunedRunCount = 0
      let vacuumed = false
      try {
        const present = this.runIds()
        const keep = present.slice(0, keepRuns)
        // pruneRuns deletes every run NOT in keep (side tables and
        // still-buffered events included), so the pruned runs are exactly
        // the newest-first enumeration's tail beyond the first keepRuns
        // ids — no duplicated pruning logic here.
        this.pruneRuns(keep)
        prunedRunCount = Math.max(0, present.length - keep.length)
        if (shouldVacuum) {
          // Freelist gate: VACUUM rewrites the WHOLE file, so a pass whose
          // deletes freed no whole pages (or deleted nothing at all) must
          // not pay it on every call. Only a journal with free pages to
          // reclaim — read on this SAME connection — attempts VACUUM; an
          // empty freelist reports vacuumed: false without trying.
          const freelistRow = db.query('PRAGMA freelist_count').get() as
            | { freelist_count: number }
            | undefined
          const freePages = freelistRow?.freelist_count ?? 0
          if (freePages > 0) {
            try {
              db.run('VACUUM;')
              vacuumed = true
            } catch (error) {
              // The EXPECTED degradation: a concurrent writer/reader holds
              // the exclusive access VACUUM needs. Anything else falls to
              // the fail-open catch below.
              if (!isSqliteBusyError(error)) throw error
            }
          }
        }
      } catch {
        // Fail-open: maintenance is best-effort by design — degrade to
        // the outcome accumulated so far instead of throwing onto the
        // caller.
      }
      return { prunedRunCount, vacuumed }
    },

    /**
     * Slice-4 hardening: force-drain any hot-path-batched events so every
     * event appended so far is durably committed — the tool-execution path
     * calls this BEFORE a side-effecting tool runs so the tool_call
     * completion marker can never lag the side effect (closing the kill-9
     * replay double-execution window batching otherwise opens). Synchronous
     * drain over this journal's single connection, so there is always at
     * most one drain in flight. Post-close no-op.
     */
    forceFlush(): Promise<void> {
      if (closed) return Promise.resolve()
      drainPending()
      return Promise.resolve()
    },

    /**
     * Slice-4 hardening bounded read: the LAST `limit` events for runId,
     * NEWEST FIRST (ORDER BY seq DESC LIMIT) — an indexed top-N scan instead
     * of materializing the run's full event list. `limit` is clamped to >= 0.
     */
    recentEvents(runId: string, limit: number): JournalEventRow[] {
      const rows = db
        .query(
          'SELECT seq, step_number, event_type, correlation, payload, created_at FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT ?',
        )
        .all(runId, Math.max(0, Math.floor(limit))) as RunEventRow[]
      return rows.map(parseRow)
    },

    /**
     * Slice-4 hardening targeted read: every event of ONE eventType for
     * runId in seq ASC order, served by the (run_id, event_type, seq) index
     * instead of loading and filtering the full event list.
     */
    eventsOfType(
      runId: string,
      eventType: JournalEvent['eventType'],
    ): JournalEventRow[] {
      const rows = db
        .query(
          'SELECT seq, step_number, event_type, correlation, payload, created_at FROM run_events WHERE run_id = ? AND event_type = ? ORDER BY seq ASC',
        )
        .all(runId, eventType) as RunEventRow[]
      return rows.map(parseRow)
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
      // Targeted query (slice-4 hardening): the (run_id, event_type, seq)
      // index serves the tool_call rows and json_extract pre-filters them to
      // this toolName, so the per-row JSON.parse below only sees candidates
      // for THIS tool instead of every tool_call the run ever journaled.
      const rows = db
        .query(
          "SELECT seq, correlation, payload FROM run_events WHERE run_id = ? AND event_type = 'tool_call' AND json_extract(payload, '$.toolName') = ? ORDER BY seq ASC",
        )
        .all(runId, toolName) as Array<{
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
     *
     * Idempotent: a second close() resolves without touching the database.
     * After close, writes are fail-open no-ops (append drops the event,
     * flush resolves) so a detached background child that outlives the turn
     * which closed the journal keeps running — it just stops journaling,
     * exactly like the unopenable-journal fail-open path.
     */
    async close(): Promise<void> {
      if (closed) return
      // try/finally (slice-4 hardening): a failing final drain (e.g. SQLITE_BUSY
      // exhausting the bounded retries inside insertEvent) must still release
      // the sqlite handle and clear the pending delay timer — otherwise close()
      // leaks both on the throw path. The async body surfaces that drain
      // failure as a REJECTED promise — the declared Promise<void> contract
      // awaited callers and the close-on-throw test rely on — instead of a
      // synchronous throw that would bypass .catch()/await error handling.
      try {
        drainPending()
      } finally {
        clearFlushTimer()
        db.close()
        closed = true
      }
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

  // Bounded tail (slice-4 hardening): the match predicates below only count
  // events AFTER the tail event's seq, and the built-in reader's lastEvent IS
  // the max-seq row, so a newest-first window (ORDER BY seq DESC LIMIT via the
  // optional recentEvents extension) decides the classification without
  // materializing the run's full event list. Readers without the extension
  // fall back to a full events() load — identical results, seq gaps included
  // (ordering is by seq, never row count).
  const bounded = reader as BoundedReadJournalReader
  const tailWindow =
    typeof bounded.recentEvents === 'function'
      ? bounded.recentEvents(runId, RESUME_TAIL_EVENT_LIMIT)
      : reader.events(runId)

  if (last.eventType === 'tool_call') {
    const correlation = last.correlation
    // Correlation reuse guard: only a tool_result recorded AFTER this
    // tool_call's seq can complete it. An earlier attempt's result (same
    // correlation, retried call) must not satisfy the check, or a genuinely
    // in-flight re-executed tool call would be misclassified as clean and
    // the resume path would skip the toolResultFor cross-check.
    const hasResult =
      correlation != null &&
      tailWindow.some(
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
      tailWindow.some(
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
  // Targeted scan (slice-4 hardening): when the reader exposes the optional
  // eventsOfType extension, only the `spawn` and `step_boundary` rows are
  // fetched (served by the (run_id, event_type, seq) index) instead of
  // materializing the full event list and filtering in memory. Results are
  // identical: both lists are seq ASC, and the seq-relative "boundary AFTER
  // the spawn" guard mirrors the index-based one (the (run_id, seq) PRIMARY
  // KEY makes seq order == position order). Readers without the extension
  // keep the full-list path byte-identical.
  const bounded = reader as BoundedReadJournalReader
  const targeted =
    typeof bounded.eventsOfType === 'function'
      ? {
          spawns: bounded.eventsOfType(parentRunId, 'spawn'),
          boundaries: bounded.eventsOfType(parentRunId, 'step_boundary'),
        }
      : undefined
  const events = targeted ? targeted.spawns : reader.events(parentRunId)
  const inFlight: Array<ChildRunDisposition> = []
  const awaiting: Array<{ childRunId: string; childLastSeq: number }> = []

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (!targeted && event.eventType !== 'spawn') continue
    const childRunId = event.correlation
    if (childRunId == null) continue
    const reconciled = targeted
      ? targeted.boundaries.some(
          (e) => e.seq > event.seq && e.correlation === childRunId,
        )
      : hasTerminalStepBoundaryAfter(events, childRunId, i + 1)
    if (reconciled) continue

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
