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

/**
 * P2-T2-DESIGN §4d: disposition of a SINGLE child run, read from the child's
 * own journal (the child's runId = the parent journal's spawn `correlation`).
 */
export type ChildRunDisposition =
  | { kind: 'child_completed'; lastEventSeq: number }
  | { kind: 'child_in_flight_tool'; childRunId: string; toolCallId: string }
  | { kind: 'child_in_flight_llm'; childRunId: string }
  | { kind: 'child_unknown'; childRunId: string }

/**
 * P2-T2-DESIGN §4d: classify a SINGLE child run by reading its own journal
 * (the child's runId = the parent journal's spawn `correlation` key).
 * - A clean classification (step_boundary/tool_result tail) counts as
 *   child_completed (lastEventSeq = that tail's seq).
 * - child_in_flight_tool / child_in_flight_llm mirror classifyRunResume but
 *   return the childRunId verbatim.
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
 * P2-T2-DESIGN §4d / §9 slice 3: background-agent resume policy.
 *
 * Background agents are process-scoped, so a kill-9 destroys the coroutine.
 * The default policy is re-spawn-from-intent: an `interrupted` intent (see
 * reconcileInterruptedBackgroundAgentIntents, which the caller must run first;
 * this planner never mutates state) is re-spawned when its agent type is known
 * to be idempotent, otherwise it needs confirmation. A caller that re-spawns
 * must journal a parent `spawn` event whose payload includes
 * `respawnOf: <original jobId>`; that marker makes re-planning idempotent.
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
        const respawn = parentSpawns.find((event) => {
          const payload = event.payload
          return (
            typeof payload === 'object' &&
            payload !== null &&
            (payload as Record<string, unknown>).respawnOf === intent.jobId
          )
        })
        if (respawn) {
          return {
            kind: 'already_respawned',
            jobId: intent.jobId,
            respawnSpawnSeq: respawn.seq,
          }
        }
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
