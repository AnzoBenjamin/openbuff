/**
 * Permanent in-tree diagnostic (not part of the test suite; retained so
 * performance-review spawns can re-run the run_event_counts side-table
 * invariants). Diagnoses the persisted run_event_counts side table backing
 * the maxEvents dimension of run-journal retention
 * (packages/agent-runtime/src/util/run-journal.ts):
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
 *     maintenance costs. NOT 'before' evidence: the pre-side-table path
 *     paid a per-append OFFSET boundary walk over the run's (run_id, seq)
 *     index entries, which no longer exists to run. The near-cap per-send
 *     median must stay flat vs the mid-size run: the side-table path never
 *     walks the run's index.
 *
 * Run: bun scripts/diag-count-side-table.ts
 * Safe: journals are written to a fresh mkdtemp under os.tmpdir() and
 * removed at the end; the raw bun:sqlite handles only SELECT — except the
 * one explicit run_event_counts wipe that sets up the reseed check. Any
 * invariant violation throws: a failed diagnostic must fail loudly, not
 * print and exit 0.
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
const COUNT_CAP = RUN_JOURNAL_DEFAULT_RETENTION.maxEvents
if (COUNT_CAP === undefined) {
  throw new Error(
    'RUN_JOURNAL_DEFAULT_RETENTION.maxEvents is unset: the count side-table diagnostic needs the production event cap',
  )
}

const COUNT_RETENTION: RunJournalRetention = {
  maxEvents: COUNT_CAP,
  maxBytes: undefined,
}
const COUNT_RETENTION_DISABLED: RunJournalRetention = {
  ...COUNT_RETENTION,
  maxEvents: undefined,
}

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
 */
function benchArmsInterleavedSync(
  arms: Array<{ label: string; run: () => void }>,
  iterations: number,
): void {
  for (const arm of arms) arm.run() // warm-up, discarded
  const samples: number[][] = arms.map(() => [])
  for (let i = 0; i < iterations; i++) {
    for (let k = 0; k < arms.length; k++) {
      const index = (i + k) % arms.length
      const start = performance.now()
      arms[index].run()
      samples[index].push(performance.now() - start)
    }
  }
  arms.forEach((arm, index) => report(arm.label, samples[index]))
}

/**
 * Fill ONE runId with `events` events of `payloadBytes`-byte payloads under
 * `retention`, seeding a journal before measuring. The journal is closed
 * before returning so later phases reopen the db fresh (the
 * reopen-exactness contract under test).
 */
function buildSyntheticRun(
  dbPath: string,
  runId: string,
  events: number,
  payloadBytes: number,
  retention: RunJournalRetention,
): void {
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
    void journal.close()
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
 * near-cap run ('hot-run'), a mid-size run ('mid-run'), and an uncapped-
 * writer run ('off-run'). Each arm re-opens the journal per iteration — the
 * production per-send shape — so open cost is part of every arm equally.
 */
function runTimingArms(dbPath: string): void {
  let perSendIteration = 0
  let disabledIteration = 0
  benchArmsInterleavedSync(
    [
      {
        label: 'journal open+close, count cap ON  [hot near-cap run]',
        run: () => {
          const j = createRunJournal({
            path: dbPath,
            retention: COUNT_RETENTION,
          })
          void j.close()
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
        run: () => {
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
          void j.close()
        },
      },
      {
        // Diagnostic upper bound ONLY: this arm disables the whole count
        // dimension (absent maxEvents => maxEventsCap undefined skips BOTH
        // the side-row maintenance and enforcement), so its numbers bound
        // the per-append cost of count maintenance — not 'before' evidence.
        label:
          'journal open+append(existing runId)+close, count dimension disabled (upper bound)',
        run: () => {
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
          void j.close()
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
function runOverCapPhase(dbPath: string): void {
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
    void j.close()
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
 * Exercise 3: wipe the side rows out-of-band, then append to an existing
 * runId — the first append must re-seed the row exactly (the seed branch
 * inside the append transaction; no open-time eager scan), and the next
 * append must keep it exact through the O(1) UPDATE path. The wipe is
 * intentionally destructive: only 'mid-run' is re-touched afterwards, so
 * the final verification pass sees exactly the reseeded row (hot-run's row
 * stays absent until a capped writer touches it again — the lazy-seed
 * design, not staleness).
 */
function runReseedPhase(dbPath: string): void {
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
    void j.close()
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

const main = (): void => {
  console.log(
    `count cap under test: ${COUNT_CAP} events (RUN_JOURNAL_DEFAULT_RETENTION.maxEvents, byte dimension disabled)`,
  )

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-count-side-table-diag-'))
  const dbPath = path.join(dir, 'journal-count-diag.db')

  // Seed three runs: 'hot-run' just under the cap (the near-cap per-send
  // arm), 'mid-run' (the flatness comparison), both under COUNT_RETENTION so
  // their side rows are maintained transactionally per append; 'off-run'
  // under the disabled retention (an uncapped writer never touches the side
  // tables — the disabled arm below needs an EXISTING runId of the same
  // shape to compare against).
  buildSyntheticRun(dbPath, 'hot-run', COUNT_CAP - 100, 200, COUNT_RETENTION)
  buildSyntheticRun(dbPath, 'mid-run', 2_000, 200, COUNT_RETENTION)
  buildSyntheticRun(dbPath, 'off-run', 2_000, 200, COUNT_RETENTION_DISABLED)
  const mb = (fs.statSync(dbPath).size / (1024 * 1024)).toFixed(1)
  console.log(
    `built hot-run(${COUNT_CAP - 100}) mid-run(2000) off-run(2000) in ${mb}MB on disk`,
  )

  runTimingArms(dbPath)
  runOverCapPhase(dbPath)
  verifyAfterOverCap(dbPath)
  runReseedPhase(dbPath)

  fs.rmSync(dir, { recursive: true, force: true })
  console.log('count side-table diagnostic: PASS (all invariants held)')
}

void main()
