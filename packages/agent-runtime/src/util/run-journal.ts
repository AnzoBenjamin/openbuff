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
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { AgentState } from '@codebuff/common/types/session-state'

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

  const parseRow = (
    row: RunEventRow,
  ): JournalEvent & { seq: number } => ({
    eventType: row.event_type,
    stepNumber: row.step_number,
    correlation: row.correlation,
    payload: JSON.parse(row.payload),
    seq: row.seq,
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

  return {
    append(runId: string, event: JournalEvent): void {
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
