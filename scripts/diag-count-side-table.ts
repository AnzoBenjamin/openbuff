/**
 * Permanent in-tree diagnostic (not part of the test suite; retained so
 * performance-review spawns can re-run the run-journal side-table
 * invariants). Diagnoses the persisted per-run side tables of run-journal
 * retention (packages/agent-runtime/src/util/run-journal.ts): the
 * run_event_counts table backing the maxEvents dimension, and (phase 5
 * below) the run_byte_totals table backing the maxBytes dimension:
 *
 *  1. EXACTNESS: after per-send appends AND an over-cap enforcement phase,
 *     every run_event_counts row must be keyed by a real run_events.run_id
 *     and equal the authoritative COUNT(*) for that runId. The keyed-by-
 *     run_id check guards the swapped-parameter signature (rows keyed by
 *     the COUNT value — the historical bug noted at the count maintenance
 *     site in run-journal.ts): such rows make every lookup by runId miss
 *     and re-seed. The count must stay exact across reopen too — side rows
 *     survive, so the cap stays enforceable for the CLI's per-send reopen
 *     of a persistent runId (historical events included).
 *  2. OVER-CAP SELF-HEAL: appending past the cap must delete the OLDEST
 *     rows, hold the run AT the cap, and leave the side row exact — the
 *     bounded, self-healing staleness contract.
 *  3. LAZY RESEED: wiping run_event_counts out-of-band and appending once
 *     must re-seed the row exactly (one COUNT inside the append
 *     transaction) — the open-time eager seed is gone, so open is O(1) and
 *     each run pays only when its cap is first enforced. The NEXT append
 *     must then take the O(1) UPDATE path against the reseeded row.
 *  4. O(1) PER-SEND SHAPE: interleaved arms (one discarded warm-up per
 *     arm, rotating start, n=30) against the same near-cap db —
 *     open+close with the count cap ON, the production per-send
 *     open→append-to-EXISTING-runId→close (one PK read + one UPDATE inside
 *     the append transaction), and the same append with the count
 *     dimension DISABLED as the diagnostic upper bound on what count
 *     maintenance costs. The disabled arm appends to 'off-run', hot-run's
 *     SAME-SHAPE twin (identical row count and payload, built under the
 *     disabled retention), so the ON-vs-disabled delta is count
 *     maintenance ALONE — never target-run b-tree insert/WAL locality.
 *     NOT 'before' evidence: the pre-side-table path paid a per-append
 *     OFFSET boundary walk over the run's (run_id, seq) index entries,
 *     which no longer exists to run. The near-cap per-send median must
 *     stay flat vs the mid-size run: the side-table path never walks the
 *     run's index. EVERY arm's timed window covers the FULL journal
 *     lifecycle — open, the arm's work, and the AWAITED close() (close is
 *     async: a void close would leave the teardown outside the timed
 *     region, free to overlap the next arm's timed open).
 *  4b. COUNT-OVER STEADY STATE (timed): after the over-cap phase leaves
 *     'hot-run' AT the cap, the same interleaved per-send shape runs
 *     against it — every capped append re-crosses the cap and pays the
 *     full count over-cap path (authoritative pre-delete COUNT(*), the
 *     O(excess) boundary walk, the DELETE, the arithmetic re-persist) —
 *     against a count-disabled same-shape twin ('off-run' topped up to
 *     the same row count), so the per-append cost of count over-cap
 *     enforcement for a run sitting at the cap is QUANTIFIED, not just
 *     exercised (count-over-cap-per-send-untimed).
 *  5. BYTE OVER-CAP (the maxBytes mirror of 2, against run_byte_totals),
 *     in TWO payload shapes: a runId built PAST the production byte cap
 *     with BOTH dimensions DISABLED during the build (a capped build would
 *     delete its own rows mid-build), then opened with the cap ON: the
 *     first capped append must seed the side row, run the enforceRetention
 *     over-cap greedy scan, delete the OLDEST rows, bring the retained
 *     bytes back UNDER the cap, keep the NEWEST row, and leave
 *     run_byte_totals exactly equal to the retained SUM. Asserted loudly
 *     after that append AND after the interleaved byte timing arms
 *     (open+close, the per-send
 *     open→append-to-EXISTING-over-cap-runId→close whose payload is one
 *     build row's size so EVERY append re-crosses the cap, and a
 *     byte-dimension-DISABLED upper bound appending to the SAME-SHAPE
 *     twin run built per shape — identical events and payload bytes
 *     under the disabled retention — so the ON-vs-disabled delta is byte
 *     maintenance ALONE), n=30. The few-rows shape
 *     (500KB rows) holds ~1.0k retained rows post-enforcement; the
 *     many-rows shape (27KB rows) holds ~19.9k — the WORST-CASE
 *     retained-row count the production caps allow — so any per-append
 *     O(retained) term on the over-cap path is maximally visible in the
 *     timed medians (a loud floor probe fails the diag when the shape
 *     cannot hold it).
 *
 * Run: bun scripts/diag-count-side-table.ts
 * Safe: journals are written to a fresh mkdtemp under os.tmpdir() and
 * removed on EVERY exit path — the phases run inside a try/finally, and
 * SIGINT/SIGTERM handlers best-effort-clean before re-raising, so a
 * failed invariant (the diag's designed loud failure) or an interrupt
 * never leaks the build. The peak is ~2.4GB: both shapes' capped runs
 * AND their same-shape twins are built into the same db file with nothing
 * removed between shapes; the raw bun:sqlite handles only SELECT — except
 * the one explicit run_event_counts wipe that sets up the reseed check.
 * Any invariant violation throws: a failed diagnostic must fail loudly,
 * not print and exit 0.
 */
import { Database } from 'bun:sqlite'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { RUN_JOURNAL_DEFAULT_RETENTION } from '../cli/src/utils/run-journal-path'
import {
  createRunJournal,
  type RunJournalRetention,
} from '../packages/agent-runtime/src/util/run-journal'

// Production baseline for the measured count cap: the CLI's own single
// source of truth (cli/src/utils/run-journal-path.ts), imported — never
// re-typed here — so a CLI default change cannot silently diag a
// non-production cap. COUNT_RETENTION is that cap with the byte dimension
// explicitly disabled (absent maxBytes => maxBytesCap undefined) so the
// measurement isolates the count dimension; COUNT_RETENTION_DISABLED is
// that same shape with the count dimension also disabled (absent maxEvents
// => maxEventsCap undefined), derived from it so the diagnostic arm can
// never silently drift from production.
const RUN_JOURNAL_DEFAULT_MAX_EVENTS = RUN_JOURNAL_DEFAULT_RETENTION.maxEvents
if (RUN_JOURNAL_DEFAULT_MAX_EVENTS === undefined) {
  throw new Error(
    'RUN_JOURNAL_DEFAULT_RETENTION.maxEvents is unset: the count side-table diagnostic needs the production event cap',
  )
}
// Declared `number` (not the optional import shape) so every use below —
// including inside HOISTED function bodies (topUpOffRunToCap,
// runCountOverTimingArms), where the guard above cannot follow — is
// statically required to be a number. The same pattern as BYTE_CAP below.
const COUNT_CAP: number = RUN_JOURNAL_DEFAULT_MAX_EVENTS

const COUNT_RETENTION: RunJournalRetention = {
  maxEvents: COUNT_CAP,
  maxBytes: undefined,
}
const COUNT_RETENTION_DISABLED: RunJournalRetention = {
  ...COUNT_RETENTION,
  maxEvents: undefined,
}

// Production baseline for the measured byte cap: the same single source of
// truth (cli/src/utils/run-journal-path.ts), imported — never re-typed here
// — so a CLI default change cannot silently diag a non-production byte cap.
// BYTE_RETENTION is that cap with the count dimension explicitly disabled
// (absent maxEvents => maxEventsCap undefined) so the byte arms isolate the
// byte dimension; BYTE_RETENTION_DISABLED is that same shape with the byte
// dimension also disabled (absent maxBytes => maxBytesCap undefined),
// derived from it so the byte-disabled arm AND the over-cap build (which
// must NOT delete while building) can never silently drift from
// production.
const RUN_JOURNAL_DEFAULT_MAX_BYTES = RUN_JOURNAL_DEFAULT_RETENTION.maxBytes
if (RUN_JOURNAL_DEFAULT_MAX_BYTES === undefined) {
  throw new Error(
    'RUN_JOURNAL_DEFAULT_RETENTION.maxBytes is unset: the byte side-table diagnostic needs the production payload-byte cap',
  )
}
// Declared `number` (not the optional import shape) so every use below —
// including inside function bodies, where the guard above cannot follow —
// is statically required to be a number.
const BYTE_CAP: number = RUN_JOURNAL_DEFAULT_MAX_BYTES

const BYTE_RETENTION: RunJournalRetention = {
  maxEvents: undefined,
  maxBytes: BYTE_CAP,
}
const BYTE_RETENTION_DISABLED: RunJournalRetention = {
  ...BYTE_RETENTION,
  maxBytes: undefined,
}

// One runId per shape built OVER the byte cap, in TWO payload shapes so
// the worst-case retained-row count is actually exercised:
//   - few-rows: 1200 x 500KB ~= 600MB; post-enforcement the retained window
//     holds ~1.0k rows (~cap/500KB) — the historical shape.
//   - many-rows: 22_000 x 27KB ~= 566MB; post-enforcement the retained
//     window holds ~19.9k rows (~cap/27KB) — the WORST-CASE retained-row
//     count the production caps allow (bounded by maxEvents under the byte
//     cap), so any per-append O(retained) term on the over-cap path is
//     maximally visible in the timed medians. Both shapes BUILD with
//     BYTE_RETENTION_DISABLED (BOTH dimensions off: an uncapped writer
//     never deletes, and the many-rows build also exceeds maxEvents).
type ByteOverShape = {
  /** runId suffix + label fragment for this shape */
  key: string
  events: number
  eventBytes: number
  /**
   * Worst-case retained-row floor (0 = none): the diag FAILS when the
   * shape cannot hold at least this many rows post-enforcement
   * (~cap/eventBytes), so per-append O(retained) terms can never be
   * silently under-exercised.
   */
  minRetainedRows: number
}
const BYTE_OVER_SHAPES: ByteOverShape[] = [
  { key: '500kb', events: 1_200, eventBytes: 500_000, minRetainedRows: 0 },
  { key: '27kb', events: 22_000, eventBytes: 27_000, minRetainedRows: 19_000 },
]

// Correlation of the newest event ever appended to the current byte-over
// shape's runId by a byte-capped writer, so the byte verification can
// assert the NEWEST row survived the greedy over-cap scan (which must
// never delete it). Phases run one shape at a time with verification
// between, so the global always reflects the shape being verified.
let lastByteAppendCorrelation = ''

const JOURNAL_ITERATIONS = 30

const fmt = (ms: number) => `${ms.toFixed(1)}ms`

/**
 * Nearest-rank p95 of ALREADY-SORTED samples (the dispersion readout next
 * to the median): for n=30 this is the 29th ordered sample, so a single
 * cold outlier cannot hide between the median and the max.
 */
function percentile95(sorted: number[]): number {
  if (sorted.length === 0) return NaN
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  return sorted[index] ?? NaN
}

function report(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? NaN
  const min = sorted[0] ?? NaN
  const max = sorted[sorted.length - 1] ?? NaN
  const p95 = percentile95(sorted)
  console.log(
    `${label}: median ${fmt(median)} (p95 ${fmt(p95)}, min ${fmt(min)}, max ${fmt(max)}, n=${samples.length})`,
  )
}

/**
 * Time multiple arms against the same target with the ordering bias removed:
 * each arm gets one discarded warm-up run first (equalizing page-cache/WAL
 * state so no arm is ever timed cold), then the arms are interleaved every
 * iteration with the starting arm rotating deterministically, so residual
 * time-ordered drift (cache warmth, WAL growth) cannot favor whichever arm
 * happens to run first.
 *
 * Arms may be async and are AWAITED inside the timed window: a journal
 * arm's open, its work, and its close() all complete before the sample is
 * taken, so no arm's teardown can overlap the next arm's timed open.
 * Callers must await the returned promise.
 */
async function benchArmsInterleavedSync(
  arms: Array<{ label: string; run: () => void | Promise<void> }>,
  iterations: number,
): Promise<void> {
  for (const arm of arms) await arm.run() // warm-up, discarded
  const samples: number[][] = arms.map(() => [])
  for (let i = 0; i < iterations; i++) {
    for (let k = 0; k < arms.length; k++) {
      const index = (i + k) % arms.length
      const start = performance.now()
      await arms[index].run()
      samples[index].push(performance.now() - start)
    }
  }
  arms.forEach((arm, index) => report(arm.label, samples[index]))
}

/**
 * Fill ONE runId with `events` events of `payloadBytes`-byte payloads under
 * `retention`, seeding a journal before measuring. The journal's close()
 * is AWAITED before returning so later phases reopen the db fresh (the
 * reopen-exactness contract under test).
 */
async function buildSyntheticRun(
  dbPath: string,
  runId: string,
  events: number,
  payloadBytes: number,
  retention: RunJournalRetention,
): Promise<void> {
  const journal = createRunJournal({ path: dbPath, retention })
  try {
    const filler = 'x'.repeat(payloadBytes)
    for (let e = 0; e < events; e++) {
      journal.append(runId, {
        eventType: 'tool_result',
        stepNumber: e,
        correlation: `diag-${runId}-${e}`,
        payload: { toolName: 'read_files', value: filler },
      })
    }
  } finally {
    await journal.close()
  }
}

type SideRow = { run_id: string; event_count: number }

function readSideRows(db: Database): SideRow[] {
  return db
    .query('SELECT run_id, event_count FROM run_event_counts ORDER BY run_id')
    .all() as SideRow[]
}

function readDistinctRunIds(db: Database): Set<string> {
  const rows = db
    .query('SELECT run_id FROM run_events GROUP BY run_id')
    .all() as Array<{ run_id: string }>
  return new Set(rows.map((row) => row.run_id))
}

function readExactCount(db: Database, runId: string): number {
  const row = db
    .query('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?')
    .get(runId) as { n: number } | undefined
  return row?.n ?? 0
}

/**
 * Exact per-run payload-byte total, using the SAME byte accounting as the
 * journal's own retention (LENGTH(CAST(payload AS BLOB)) — UTF-8 bytes,
 * not characters), so the byte verification compares run_byte_totals
 * against the identical SUM the journal itself would recompute.
 */
function readRunPayloadBytes(db: Database, runId: string): number {
  const row = db
    .query(
      'SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS total FROM run_events WHERE run_id = ?',
    )
    .get(runId) as { total: number } | undefined
  return row?.total ?? 0
}

/**
 * The core invariant: EVERY persisted run_event_counts row is keyed by a
 * real run_events.run_id and carries the authoritative COUNT(*) for that
 * runId. Throws on the first mismatch — a failed diagnostic must fail
 * loudly, not print and exit 0.
 */
function verifySideTableExact(db: Database, context: string): void {
  const sideRows = readSideRows(db)
  const runIds = readDistinctRunIds(db)
  for (const { run_id, event_count } of sideRows) {
    if (!runIds.has(run_id)) {
      throw new Error(
        `[${context}] run_event_counts row keyed by '${run_id}' matches no run_events.run_id (swapped-parameter signature: rows keyed by the count)`,
      )
    }
    const exact = readExactCount(db, run_id)
    if (event_count !== exact) {
      throw new Error(
        `[${context}] run_event_counts['${run_id}'] = ${event_count} but exact COUNT(*) = ${exact}`,
      )
    }
  }
  console.log(
    `[${context}] run_event_counts exact: ${sideRows.length} side row(s), ${runIds.size} run(s)`,
  )
}

/**
 * Arm 4: the interleaved per-send measurements against ONE db holding a
 * near-cap run ('hot-run'), a mid-size run ('mid-run'), and 'off-run' —
 * hot-run's SAME-SHAPE uncapped twin (identical row count and payload).
 * Each arm re-opens the journal per iteration — the
 * production per-send shape — so open cost is part of every arm equally.
 * Every arm's timed window covers the FULL journal lifecycle: open, the
 * arm's work, and the AWAITED close() (the harness awaits each arm).
 */
async function runTimingArms(dbPath: string): Promise<void> {
  let perSendIteration = 0
  let disabledIteration = 0
  await benchArmsInterleavedSync(
    [
      {
        label: 'journal open+close, count cap ON  [hot near-cap run]',
        run: async () => {
          const j = createRunJournal({
            path: dbPath,
            retention: COUNT_RETENTION,
          })
          await j.close()
        },
      },
      {
        // Production per-send shape: open → append ONE small event to an
        // EXISTING near-cap runId (the CLI re-opens the same journal per
        // send and appends to the persistent runId) → close. With the
        // persisted run_event_counts side row this must stay flat O(1):
        // one PK read + one UPDATE inside the append transaction — never a
        // boundary walk over the run's (run_id, seq) index entries.
        label:
          'journal open+append(existing near-cap runId)+close (per-send shape, count cap ON)',
        run: async () => {
          const j = createRunJournal({
            path: dbPath,
            retention: COUNT_RETENTION,
          })
          j.append('hot-run', {
            eventType: 'tool_result',
            stepNumber: 0,
            correlation: `per-send-${perSendIteration++}`,
            payload: { toolName: 'read_files', value: 'per-send' },
          })
          await j.close()
        },
      },
      {
        // Diagnostic upper bound ONLY: this arm disables the whole count
        // dimension (absent maxEvents => maxEventsCap undefined skips BOTH
        // the side-row maintenance and enforcement), so its numbers bound
        // the per-append cost of count maintenance — not 'before' evidence.
        // It appends to 'off-run' (hot-run's SAME-SHAPE twin), so the
        // ON-vs-disabled delta cannot conflate maintenance cost with
        // target-run b-tree insert/WAL locality.
        label:
          'journal open+append(existing runId)+close, count dimension disabled (upper bound)',
        run: async () => {
          const j = createRunJournal({
            path: dbPath,
            retention: COUNT_RETENTION_DISABLED,
          })
          j.append('off-run', {
            eventType: 'tool_result',
            stepNumber: 0,
            correlation: `disabled-${disabledIteration++}`,
            payload: { toolName: 'read_files', value: 'per-send' },
          })
          await j.close()
        },
      },
    ],
    JOURNAL_ITERATIONS,
  )
}

/**
 * Exercise 2: drive 'hot-run' PAST the cap. The per-send arm leaves it
 * COUNT_CAP - 69 events; these appends cross the cap mid-phase, so every
 * later append must delete the OLDEST row(s), hold the run at the cap, and
 * leave the side row exact (the self-heal contract).
 */
async function runOverCapPhase(dbPath: string): Promise<void> {
  const j = createRunJournal({ path: dbPath, retention: COUNT_RETENTION })
  try {
    for (let i = 0; i < 150; i++) {
      j.append('hot-run', {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: `over-cap-${i}`,
        payload: { toolName: 'read_files', value: 'over-cap' },
      })
    }
  } finally {
    await j.close()
  }
}

/**
 * Verification pass 1: exactness across ALL side rows after the per-send
 * and over-cap phases, plus the cap-hold invariant on 'hot-run' (enforcement
 * must have held it AT COUNT_CAP, never above).
 */
function verifyAfterOverCap(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    verifySideTableExact(db, 'after per-send + over-cap appends')
    const hotExact = readExactCount(db, 'hot-run')
    if (hotExact !== COUNT_CAP) {
      throw new Error(
        `over-cap enforcement did not hold hot-run at the ${COUNT_CAP}-event cap: exact COUNT(*) = ${hotExact}`,
      )
    }
    console.log(
      `[over-cap] hot-run held at the ${COUNT_CAP}-event cap with an exact side row`,
    )
  } finally {
    db.close()
  }
}

/**
 * Top 'off-run' — the count-disabled arm's same-shape twin — up to exactly
 * COUNT_CAP rows, hot-run's post-over-cap row count, so the count-over
 * steady-state arms below compare IDENTICAL targets
 * (count-over-cap-per-send-untimed +
 * disabled-upper-bound-arm-target-confound): the twin is built under the
 * disabled retention (it never deletes and never touches the side tables),
 * so the top-up appends through a disabled-retention journal and a loud
 * parity probe fails the diag when either run drifts off the cap.
 */
async function topUpOffRunToCap(dbPath: string): Promise<void> {
  const probe = new Database(dbPath)
  let offRows: number
  try {
    offRows = readExactCount(probe, 'off-run')
  } finally {
    probe.close()
  }
  if (offRows > COUNT_CAP) {
    throw new Error(
      `off-run holds ${offRows} rows, over the ${COUNT_CAP}-event cap: the disabled twin must be topped up, never truncated`,
    )
  }
  const j = createRunJournal({
    path: dbPath,
    retention: COUNT_RETENTION_DISABLED,
  })
  try {
    for (let i = 0; i < COUNT_CAP - offRows; i++) {
      j.append('off-run', {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: `off-top-up-${i}`,
        payload: { toolName: 'read_files', value: 'top-up' },
      })
    }
  } finally {
    await j.close()
  }
  const parity = new Database(dbPath)
  try {
    const hotRows = readExactCount(parity, 'hot-run')
    const twinRows = readExactCount(parity, 'off-run')
    if (hotRows !== COUNT_CAP || twinRows !== COUNT_CAP) {
      throw new Error(
        `count-over twin parity failed: hot-run holds ${hotRows} rows and off-run ${twinRows}, expected exactly ${COUNT_CAP} each`,
      )
    }
    console.log(
      `[count-over] hot-run and off-run both hold ${COUNT_CAP} rows (same-shape twins for the steady-state arms)`,
    )
  } finally {
    parity.close()
  }
}

/**
 * Arm 4b (count-over steady state, count-over-cap-per-send-untimed): the
 * interleaved per-send measurements against the OVER-CAP count run. The
 * over-cap phase left 'hot-run' AT the cap, so every capped append
 * re-crosses it and pays the full count over-cap path — the authoritative
 * pre-delete COUNT(*), the O(excess) boundary walk, the DELETE, and the
 * arithmetic re-persist — the per-append cost the untimed over-cap phase
 * exercised but never quantified. The disabled arm appends to 'off-run'
 * (hot-run's same-shape twin, topped up to the same row count), so the
 * ON-vs-disabled delta is count over-cap maintenance ALONE — never
 * target-run b-tree insert/WAL locality. Each arm re-opens the journal
 * per iteration; every timed window covers open, the append, and the
 * AWAITED close.
 */
async function runCountOverTimingArms(dbPath: string): Promise<void> {
  let perSendIteration = 0
  let disabledIteration = 0
  await benchArmsInterleavedSync(
    [
      {
        label:
          'journal open+append(existing over-cap runId)+close (per-send shape, count cap ON)  [count-over steady state]',
        run: async () => {
          const j = createRunJournal({
            path: dbPath,
            retention: COUNT_RETENTION,
          })
          j.append('hot-run', {
            eventType: 'tool_result',
            stepNumber: 0,
            correlation: `count-over-per-send-${perSendIteration++}`,
            payload: { toolName: 'read_files', value: 'count-over' },
          })
          await j.close()
        },
      },
      {
        // Diagnostic upper bound ONLY: this arm disables the whole count
        // dimension, so its numbers bound the per-append cost of count
        // over-cap maintenance — not 'before' evidence. It appends to
        // 'off-run' (hot-run's same-shape twin at the same row count), so
        // the delta cannot conflate maintenance cost with target-run
        // b-tree insert/WAL locality.
        label:
          'journal open+append(same-shape twin runId)+close, count dimension disabled (upper bound)  [count-over steady state]',
        run: async () => {
          const j = createRunJournal({
            path: dbPath,
            retention: COUNT_RETENTION_DISABLED,
          })
          j.append('off-run', {
            eventType: 'tool_result',
            stepNumber: 0,
            correlation: `count-over-disabled-${disabledIteration++}`,
            payload: { toolName: 'read_files', value: 'count-over' },
          })
          await j.close()
        },
      },
    ],
    JOURNAL_ITERATIONS,
  )
}

/**
 * Verification after the count-over steady-state arms: 'hot-run' must STILL
 * hold exactly COUNT_CAP rows with every side row exact — each timed
 * capped append re-crossed the cap and deleted exactly the OLDEST row.
 */
function verifyCountOverSteadyState(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    verifySideTableExact(db, 'after count-over steady-state arms')
    const hotExact = readExactCount(db, 'hot-run')
    if (hotExact !== COUNT_CAP) {
      throw new Error(
        `count-over steady-state enforcement did not hold hot-run at the ${COUNT_CAP}-event cap: exact COUNT(*) = ${hotExact}`,
      )
    }
    console.log(
      `[count-over steady state] hot-run held at the ${COUNT_CAP}-event cap across every timed append`,
    )
  } finally {
    db.close()
  }
}

/**
 * Exercise 3: wipe the side rows out-of-band, then append to an existing
 * runId — the first append must re-seed the row exactly (the seed branch
 * inside the append transaction; no open-time eager scan), and the next
 * append must keep it exact through the O(1) UPDATE path. The wipe is
 * intentionally destructive: only 'mid-run' is re-touched afterwards, so
 * the final verification pass sees exactly the reseeded row (hot-run's row
 * stays absent until a capped writer touches it again — the lazy-seed
 * design, not staleness).
 */
async function runReseedPhase(dbPath: string): Promise<void> {
  const wipe = new Database(dbPath)
  try {
    wipe.run('DELETE FROM run_event_counts')
  } finally {
    wipe.close()
  }
  const j = createRunJournal({ path: dbPath, retention: COUNT_RETENTION })
  try {
    j.append('mid-run', {
      eventType: 'tool_result',
      stepNumber: 0,
      correlation: 'reseed-0',
      payload: { toolName: 'read_files', value: 'reseed' },
    })
    j.append('mid-run', {
      eventType: 'tool_result',
      stepNumber: 0,
      correlation: 'reseed-1',
      payload: { toolName: 'read_files', value: 'reseed' },
    })
  } finally {
    await j.close()
  }
  const db = new Database(dbPath)
  try {
    const reseeded = readSideRows(db).find((row) => row.run_id === 'mid-run')
    if (!reseeded) {
      throw new Error(
        '[reseed] first post-wipe append did not re-seed the mid-run side row',
      )
    }
    const exact = readExactCount(db, 'mid-run')
    if (reseeded.event_count !== exact) {
      throw new Error(
        `[reseed] reseeded run_event_counts['mid-run'] = ${reseeded.event_count} but exact COUNT(*) = ${exact}`,
      )
    }
    console.log(
      `[reseed] mid-run side row re-seeded exact after the wipe: ${reseeded.event_count} events`,
    )
    verifySideTableExact(db, 'final')
  } finally {
    db.close()
  }
}

/**
 * Exercise 5 (byte dimension): drive the shape's runId past the
 * production byte cap for the first time with a byte-CAPPED writer. The
 * build wrote it with BOTH dimensions DISABLED (an uncapped writer never
 * deletes and never touches run_byte_totals), so its payload total sits
 * over the cap with no side row: this first capped append must seed the
 * side row from the exact SQL SUM, find the total over the cap, and run
 * the greedy oldest-first scan that deletes the OLDEST rows until the
 * retained bytes fit the cap.
 */
async function runByteOverCapPhase(
  dbPath: string,
  runId: string,
  eventBytes: number,
  minRetainedRows: number,
): Promise<void> {
  // Loud preconditions: the built run must actually sit OVER the byte cap,
  // or the phase below would silently exercise the under-cap path; a
  // floor-carrying shape must also be able to HOLD its worst-case
  // retained-row count post-enforcement (~cap/eventBytes rows), so shape
  // or cap drift fails HERE instead of under-exercising the over-cap path.
  const probe = new Database(dbPath)
  try {
    const built = readRunPayloadBytes(probe, runId)
    if (built <= BYTE_CAP) {
      throw new Error(
        `${runId} built at ${built} payload bytes, not over the ${BYTE_CAP}-byte cap: the byte over-cap phase would exercise nothing`,
      )
    }
    if (minRetainedRows > 0) {
      const expectedRetained = Math.floor(BYTE_CAP / eventBytes)
      const builtRows = readExactCount(probe, runId)
      if (
        expectedRetained < minRetainedRows ||
        builtRows <= minRetainedRows
      ) {
        throw new Error(
          `${runId} shape holds ${builtRows} built rows with ~${expectedRetained} post-enforcement retained rows, below the ${minRetainedRows}-row worst-case floor: per-append O(retained) terms would be under-exercised`,
        )
      }
      console.log(
        `${runId} worst-case shape: ${builtRows} built rows, ~${expectedRetained} post-enforcement retained rows (floor ${minRetainedRows})`,
      )
    }
    console.log(
      `${runId} built at ${(built / (1024 * 1024)).toFixed(1)}MiB of payload bytes, over the ${(BYTE_CAP / (1024 * 1024)).toFixed(0)}MiB cap`,
    )
  } finally {
    probe.close()
  }
  const j = createRunJournal({ path: dbPath, retention: BYTE_RETENTION })
  try {
    j.append(runId, {
      eventType: 'tool_result',
      stepNumber: 0,
      correlation: `${runId}-over-cap-0`,
      payload: {
        toolName: 'read_files',
        value: 'x'.repeat(eventBytes),
      },
    })
    lastByteAppendCorrelation = `${runId}-over-cap-0`
  } finally {
    await j.close()
  }
}

/**
 * Verification pass for the byte dimension (the mirror of
 * verifyAfterOverCap): after byte-capped appends against the over-cap
 * 'byte-over-run', the retained payload bytes must FIT the cap, the
 * NEWEST row must have survived the greedy over-cap scan (it is never
 * deleted), and the persisted run_byte_totals side row must EQUAL the
 * exact retained SUM. Throws on the first violation — the same loud
 * contract as the count-side checks.
 */
function verifyByteOverCap(dbPath: string, runId: string, context: string): void {
  const db = new Database(dbPath)
  try {
    const retained = readRunPayloadBytes(db, runId)
    if (retained > BYTE_CAP) {
      throw new Error(
        `[${context}] byte over-cap enforcement left ${runId} at ${retained} payload bytes, over the ${BYTE_CAP}-byte cap`,
      )
    }
    const newest = db
      .query(
        'SELECT seq, correlation FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1',
      )
      .get(runId) as
      | { seq: number; correlation: string | null }
      | undefined
    if (!newest) {
      throw new Error(
        `[${context}] ${runId} retained no rows: the newest row did not survive`,
      )
    }
    if (newest.correlation !== lastByteAppendCorrelation) {
      throw new Error(
        `[${context}] newest ${runId} row is '${newest.correlation}' (seq ${newest.seq}), not the last appended '${lastByteAppendCorrelation}': the over-cap scan deleted the newest row`,
      )
    }
    const sideRow = db
      .query('SELECT total_bytes FROM run_byte_totals WHERE run_id = ?')
      .get(runId) as { total_bytes: number } | undefined
    if (!sideRow) {
      throw new Error(
        `[${context}] no run_byte_totals row for ${runId}: the byte-capped writer never seeded the side row`,
      )
    }
    if (sideRow.total_bytes !== retained) {
      throw new Error(
        `[${context}] run_byte_totals['${runId}'] = ${sideRow.total_bytes} but exact retained SUM = ${retained}`,
      )
    }
    console.log(
      `[${context}] ${runId} held at ${(retained / (1024 * 1024)).toFixed(1)}MiB under the ${(BYTE_CAP / (1024 * 1024)).toFixed(0)}MiB cap, newest row intact, side row exact`,
    )
  } finally {
    db.close()
  }
}

/**
 * Arm 5 (byte dimension): the interleaved per-send measurements against
 * the OVER-CAP byte run — the state where every capped append runs the
 * enforceRetention over-cap byte scan. Each arm re-opens the journal per
 * iteration (the production per-send shape) and its timed window covers
 * open, the append, and the AWAITED close. The byte-disabled arm appends
 * to disabledRunId — the capped run's SAME-SHAPE twin (identical events
 * and payload bytes, built under the disabled retention so it never
 * touches the side tables) — so the ON-vs-disabled delta is byte
 * maintenance ALONE, never target-run b-tree insert/WAL locality
 * (disabled-upper-bound-arm-target-confound) — never 'before' evidence.
 */
async function runByteTimingArms(
  dbPath: string,
  runId: string,
  disabledRunId: string,
  eventBytes: number,
  shapeKey: string,
): Promise<void> {
  let perSendIteration = 0
  let disabledIteration = 0
  const shapeTag = `[over-cap ${shapeKey} single run]`
  await benchArmsInterleavedSync(
    [
      {
        label: `journal open+close, byte cap ON  ${shapeTag}`,
        run: async () => {
          const j = createRunJournal({
            path: dbPath,
            retention: BYTE_RETENTION,
          })
          await j.close()
        },
      },
      {
        // Production per-send shape against the OVER-CAP run. The appended
        // payload is one build row's size: the post-enforcement slack
        // under the cap is less than one row, so EVERY append re-crosses
        // the cap and runs the over-cap greedy scan — a tiny append would
        // land under the cap and skip the scan entirely.
        label:
          `journal open+append(existing over-cap runId)+close (per-send shape, byte cap ON)  ${shapeTag}`,
        run: async () => {
          const j = createRunJournal({
            path: dbPath,
            retention: BYTE_RETENTION,
          })
          const correlation = `byte-per-send-${shapeKey}-${perSendIteration++}`
          j.append(runId, {
            eventType: 'tool_result',
            stepNumber: 0,
            correlation,
            payload: {
              toolName: 'read_files',
              value: 'x'.repeat(eventBytes),
            },
          })
          lastByteAppendCorrelation = correlation
          await j.close()
        },
      },
      {
        // Diagnostic upper bound ONLY: this arm disables the byte dimension
        // (absent maxBytes => maxBytesCap undefined skips BOTH the side-row
        // maintenance and enforcement), so its numbers bound the per-append
        // cost of byte maintenance — not 'before' evidence. It appends to
        // the capped run's SAME-SHAPE twin, so the delta cannot conflate
        // maintenance cost with target-run b-tree insert/WAL locality.
        label:
          `journal open+append(same-shape twin runId)+close, byte dimension disabled (upper bound)  [byte-over ${shapeKey} phase]`,
        run: async () => {
          const j = createRunJournal({
            path: dbPath,
            retention: BYTE_RETENTION_DISABLED,
          })
          j.append(disabledRunId, {
            eventType: 'tool_result',
            stepNumber: 0,
            correlation: `byte-disabled-${shapeKey}-${disabledIteration++}`,
            payload: {
              toolName: 'read_files',
              value: 'x'.repeat(eventBytes),
            },
          })
          await j.close()
        },
      },
    ],
    JOURNAL_ITERATIONS,
  )
}

const main = async (): Promise<void> => {
  console.log(
    `count cap under test: ${COUNT_CAP} events (RUN_JOURNAL_DEFAULT_RETENTION.maxEvents, byte dimension disabled)`,
  )

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-count-side-table-diag-'))
  const dbPath = path.join(dir, 'journal-count-diag.db')

  // Cleanup contract (diag-tmpdir-leak-on-loud-failure): the diag's
  // DESIGNED failure mode is a thrown invariant (the loud probes), and a
  // failed or interrupted run must not leak its multi-GB build into
  // os.tmpdir(). The finally below runs on every path — success, thrown
  // invariant, anything between — mirroring the sibling bench's pattern;
  // the SIGINT/SIGTERM handlers cover interrupts, which bypass finally
  // blocks (each re-raises the signal after the best-effort cleanup so the
  // process still terminates with the default disposition).
  const cleanupDir = (): void => {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const onInterruptSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    cleanupDir()
    process.kill(process.pid, signal)
  }
  const onSigint = (): void => onInterruptSignal('SIGINT')
  const onSigterm = (): void => onInterruptSignal('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)

  try {
    // Seed three runs: 'hot-run' just under the cap (the near-cap per-send
    // arm), 'mid-run' (the flatness comparison), both under COUNT_RETENTION so
    // their side rows are maintained transactionally per append; 'off-run'
    // under the disabled retention (an uncapped writer never touches the side
    // tables — the disabled arm below needs an EXISTING runId of the same
    // shape to compare against).
    await buildSyntheticRun(
      dbPath,
      'hot-run',
      COUNT_CAP - 100,
      200,
      COUNT_RETENTION,
    )
    await buildSyntheticRun(dbPath, 'mid-run', 2_000, 200, COUNT_RETENTION)
    // 'off-run' is the SAME-SHAPE twin of 'hot-run' — identical row count
    // and payload size, built under the disabled retention so it never
    // touches the side tables. The count-disabled arm appends to it, so its
    // numbers differ from the capped arm's by count maintenance ALONE —
    // never by target-run b-tree insert/WAL locality
    // (disabled-upper-bound-arm-target-confound).
    await buildSyntheticRun(
      dbPath,
      'off-run',
      COUNT_CAP - 100,
      200,
      COUNT_RETENTION_DISABLED,
    )
    const mb = (fs.statSync(dbPath).size / (1024 * 1024)).toFixed(1)
    console.log(
      `built hot-run(${COUNT_CAP - 100}) mid-run(2000) off-run(${COUNT_CAP - 100}, hot-run's same-shape twin) in ${mb}MB on disk`,
    )

    await runTimingArms(dbPath)
    await runOverCapPhase(dbPath)
    verifyAfterOverCap(dbPath)
    // Count-over steady state (count-over-cap-per-send-untimed): with
    // hot-run sitting AT the cap, the timed per-send arms quantify the
    // per-append cost of count over-cap enforcement against its same-shape
    // disabled twin.
    await topUpOffRunToCap(dbPath)
    await runCountOverTimingArms(dbPath)
    verifyCountOverSteadyState(dbPath)
    await runReseedPhase(dbPath)

    // Byte-dimension phases: per shape, build one runId OVER the production
    // byte cap with BOTH dimensions DISABLED during the build (a capped build
    // would delete its own rows mid-build), then verify and time against it
    // with the cap ON — the enforceRetention over-cap byte scan. The
    // many-rows shape holds the WORST-CASE retained-row count the production
    // caps allow, so any per-append O(retained) term on the over-cap path is
    // maximally visible in the timed medians.
    console.log(
      `byte cap under test: ${BYTE_CAP} bytes (RUN_JOURNAL_DEFAULT_RETENTION.maxBytes, count dimension disabled in the byte arms)`,
    )
    for (const shape of BYTE_OVER_SHAPES) {
      const runId = `byte-over-${shape.key}`
      await buildSyntheticRun(
        dbPath,
        runId,
        shape.events,
        shape.eventBytes,
        BYTE_RETENTION_DISABLED,
      )
      // The disabled arm's SAME-SHAPE twin: identical events and payload
      // bytes, built under the disabled retention (never touches the side
      // tables). The loud parity probe below fails the diag when the twin
      // drifts from the capped run's shape.
      const twinRunId = `${runId}-twin`
      await buildSyntheticRun(
        dbPath,
        twinRunId,
        shape.events,
        shape.eventBytes,
        BYTE_RETENTION_DISABLED,
      )
      const twinProbe = new Database(dbPath)
      try {
        const twinBytes = readRunPayloadBytes(twinProbe, twinRunId)
        const cappedBytes = readRunPayloadBytes(twinProbe, runId)
        if (twinBytes !== cappedBytes) {
          throw new Error(
            `${twinRunId} built at ${twinBytes} payload bytes but ${runId} at ${cappedBytes}: the disabled arm's twin must be the same shape as the capped run`,
          )
        }
        console.log(
          `built ${twinRunId}(${shape.events} x ${shape.eventBytes}B, same shape as ${runId})`,
        )
      } finally {
        twinProbe.close()
      }
      const shapeDbMb = (fs.statSync(dbPath).size / (1024 * 1024)).toFixed(1)
      console.log(
        `built ${runId}(${shape.events} x ${shape.eventBytes}B, both dimensions disabled during build; db now ${shapeDbMb}MB on disk)`,
      )
      await runByteOverCapPhase(dbPath, runId, shape.eventBytes, shape.minRetainedRows)
      verifyByteOverCap(dbPath, runId, `${runId}: after first byte over-cap append`)
      await runByteTimingArms(dbPath, runId, twinRunId, shape.eventBytes, shape.key)
      verifyByteOverCap(dbPath, runId, `${runId}: after byte over-cap timing arms`)
    }

    console.log('side-table diagnostic: PASS (count + byte invariants held)')
  } finally {
    // Runs on EVERY path — success, a thrown invariant (the diag's designed
    // loud failure), or anything between — so the tmp build never leaks.
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    cleanupDir()
  }
}

main().catch((error) => {
  // A failed diagnostic must fail loudly, not print and exit 0: main is
  // async (the timing arms are awaited inside it), so an invariant
  // violation surfaces here as a rejected promise — re-raise it as a
  // non-zero exit code.
  console.error(error)
  process.exitCode = 1
})
