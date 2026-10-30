/**
 * Permanent in-tree benchmark (not part of the test suite; retained so the
 * persisted before/after history in measure-send-freeze-results.json stays
 * regenerable and performance-review spawns can re-verify the arms).
 * Measures the synchronous per-send costs on the TUI send path:
 *
 *  1. sdk validateAgents() over the bundled agent definitions (per send)
 *  2. journal open+close against synthetic dbs of increasing size — the
 *     CLI opens/closes the journal once per send under
 *     RUN_JOURNAL_DEFAULT_RETENTION (imported from
 *     cli/src/utils/run-journal-path.ts, never re-typed). After the
 *     deferred-seed/side-table fixes, open performs no payload scan.
 *  3. The PRODUCTION per-send shape — open → append ONE small event to an
 *     EXISTING runId → close — at mid/big multi-run dbs, a hot (~250MB
 *     single run) near-cap db, and byte-over (~600MB single run) dbs in
 *     TWO payload shapes: few-rows (500KB rows, ~1.0k retained rows
 *     post-enforcement) and many-rows (27KB rows, ~19.9k retained — the
 *     WORST-CASE retained-row count the production caps allow, so any
 *     per-append O(retained) term is maximally visible in its medians) —
 *     each built over the 512MiB byte cap, i.e. exactly the state where
 *     enforceRetention's over-cap path runs on every append.
 *  4. loadProviderConfigSync() cached fast path.
 *  5. The byte dimension DISABLED (RUN_JOURNAL_DEFAULT_RETENTION minus
 *     maxBytes) on the same dbs — a diagnostic UPPER BOUND on what byte
 *     retention costs, NOT 'before' evidence: disabling maxBytes also
 *     skips all byte-side maintenance, so no concrete fix can claim these
 *     numbers.
 *  6. A count-over db: ONE runId built PAST the production maxEvents cap
 *     (22,000 x 200B events, BOTH dimensions disabled during the build so
 *     the cap cannot delete mid-build), then measured with the production
 *     retention — every measured append re-crosses the count cap, so the
 *     timed open+close and per-send arms PERSIST the per-append cost of
 *     count over-cap enforcement (the authoritative pre-delete COUNT(*)
 *     plus the O(excess) boundary walk) for a run sitting at the cap.
 *
 * MEASUREMENT DESIGN: every journal arm's timed window covers the FULL
 * lifecycle — createRunJournal(), the optional append, and the AWAITED
 * async close() (no fire-and-forget teardown outside the timed region,
 * so one arm's teardown can never overlap the next arm's timed open);
 * the db-BUILD teardown is likewise awaited (buildSyntheticJournal's
 * close), so no build connection stays open into the first timed arm.
 * Arms are interleaved with one discarded warm-up each and a rotating
 * start order (n=30 per journal arm, n=30 validateAgents iterations).
 *
 * BEFORE/AFTER PAIRING: every arm record carries a stable `stableKey`
 * (e.g. 'open+close:byte-on:mid'); the persisted history's beforeBaseline
 * uses the SAME keys, so the pair is machine-diffable without fuzzy
 * label matching, and runs whose measurements were superseded are
 * excluded by their structured `superseded` flag — not by note text.
 * BEFORE medians (n=15, pre-fix, pre awaited-close era —
 * their timed window covered only close INITIATION, so absolute values
 * are not directly comparable to the current awaited-close arms; the
 * O(n)-vs-O(1) scaling conclusion is unaffected): 12.4ms mid, 43.1ms big.
 *
 * Run: bun scripts/measure-send-freeze.bench.ts
 * Safe: journals are written to a fresh mkdtemp under os.tmpdir() and
 * removed at the end; the over-cap dbs (~600MB each, two shapes) also
 * live there.
 * Evidence: every timed arm's summary (stableKey, label, n, median, min,
 * max, p95) is MERGED into the persistent run history at
 * scripts/measure-send-freeze-results.json (each merge re-reads its own
 * write, repairing a record drop it can see and failing loudly when it
 * cannot verify one; superseded runs are stamped with a machine-readable
 * `superseded: true` flag; beforeBaseline is seeded exactly once) so
 * before/after runs can be diffed after the tmp dir is removed.
 */
import { Database } from 'bun:sqlite'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { bundledAgents } from '../cli/src/agents/bundled-agents.generated'
import { validateAgents as sdkValidateAgents } from '../sdk/src/validate-agents'
import { loadProviderConfigSync } from '../sdk/src/provider-config'
import { RUN_JOURNAL_DEFAULT_RETENTION } from '../cli/src/utils/run-journal-path'
import {
  createRunJournal,
  type RunJournalRetention,
} from '../packages/agent-runtime/src/util/run-journal'

// Diagnostic upper bound ONLY: RUN_JOURNAL_DEFAULT_RETENTION with the byte
// dimension explicitly disabled (absent maxBytes => maxBytesCap undefined),
// derived from the production default so this arm can never silently drift
// from what production uses.
const BYTE_DIMENSION_DISABLED: RunJournalRetention = {
  ...RUN_JOURNAL_DEFAULT_RETENTION,
  maxBytes: undefined,
}
// The over-cap db is BUILT with the byte cap disabled: building with the
// cap ON would delete rows during the build. Measurement journals then
// open with RUN_JOURNAL_DEFAULT_RETENTION so every measured append lands
// over the cap.
const BUILD_NO_BYTE_CAP: RunJournalRetention = BYTE_DIMENSION_DISABLED
// The many-rows over-cap db is BUILT with BOTH dimensions disabled: its
// 22,000-event build exceeds maxEvents too, so keeping the count cap on
// (as BUILD_NO_BYTE_CAP does) would delete rows mid-build and silently
// shrink the over-cap state before it is ever measured.
const BUILD_NO_RETENTION: RunJournalRetention = {
  maxEvents: undefined,
  maxBytes: undefined,
}

// Byte-over db SHAPES: ONE runId built over the production byte cap per
// shape. Each shape's build AND per-send arm share its constants (the arm
// appends exactly one build row's worth of payload bytes so every measured
// append re-crosses the cap), and the loud probes after each build fail the
// bench when the built total does not exceed the cap — or when a
// floor-carrying shape cannot hold its worst-case retained-row count — so
// the arms' over-cap validity is enforced by CODE, never by a lockstep
// comment. The per-send stableKeys are VERSIONED with the payload shape so
// before/after pairing across the persisted history stays apples-to-apples
// (the pre-lockstep unversioned key recorded a different — under-cap
// fast-path — measurement shape). TWO shapes:
//   - few-rows: 1200 x 500_000B ~= 572MiB; post-enforcement the retained
//     window holds ~1.0k rows (~cap/500KB) — the historical shape, kept
//     under its existing stableKeys for history continuity.
//   - many-rows: 22_000 x 27_000B ~= 566MiB; post-enforcement the retained
//     window holds ~19.9k rows (~cap/27KB) — the WORST-CASE retained-row
//     count the production caps allow (bounded by maxEvents under the
//     512MiB cap), so any per-append O(retained) term on the over-cap path
//     is maximally visible in the measured per-send medians. Its
//     22,000-event build also exceeds maxEvents, so it is BUILT with BOTH
//     dimensions disabled (the count cap would otherwise delete rows
//     mid-build and silently shrink the over-cap state).
type ByteOverShape = {
  /** stableKey fragment + db-file suffix for this shape */
  key: string
  label: string
  events: number
  eventBytes: number
  buildRetention: RunJournalRetention
  openCloseStableKey: string
  perSendStableKey: string
  /**
   * Worst-case retained-row floor: the bench FAILS when the shape cannot
   * hold at least this many rows post-enforcement (~cap/eventBytes), so
   * per-append O(retained) terms can never be silently under-exercised.
   * 0 = no floor (the historical few-rows shape).
   */
  minRetainedRows: number
}
const BYTE_OVER_RUN_ID = 'byte-over-run'
// Count-over db constants (count-over-cap-per-send-untimed): ONE runId
// built PAST the production maxEvents cap so the timed count-over arms
// persist the per-append cost of count over-cap enforcement for a run
// sitting at the cap. The build exceeds maxEvents, so it is BUILT with
// BOTH dimensions disabled (a capped build would delete its own rows
// mid-build); the 200B payload keeps the db small (only the count
// dimension is under test).
const COUNT_OVER_RUN_ID = 'count-over-run'
const COUNT_OVER_EVENTS = 22_000
const COUNT_OVER_EVENT_BYTES = 200
const BYTE_OVER_SHAPES: ByteOverShape[] = [
  {
    key: '500kb',
    label: 'byte-over (~600MB single run)',
    events: 1_200,
    eventBytes: 500_000,
    buildRetention: BUILD_NO_BYTE_CAP,
    openCloseStableKey: 'open+close:byte-on:byte-over',
    perSendStableKey: 'per-send-append:byte-on:byte-over:500kb',
    minRetainedRows: 0,
  },
  {
    key: '27kb',
    label: 'byte-over many-rows (~566MB, worst-case ~19.9k retained rows)',
    events: 22_000,
    eventBytes: 27_000,
    buildRetention: BUILD_NO_RETENTION,
    openCloseStableKey: 'open+close:byte-on:byte-over:27kb',
    perSendStableKey: 'per-send-append:byte-on:byte-over:27kb',
    minRetainedRows: 19_000,
  },
]

const JOURNAL_OPEN_ITERATIONS = 30
const VALIDATE_AGENTS_ITERATIONS = 30

const fmt = (ms: number) => `${ms.toFixed(1)}ms`

/**
 * Stable in-tree HISTORY path (next to this script): main() merges this
 * run's record into `runs` (prior records always survive) and
 * `beforeBaseline` — the machine-readable pre-fix medians — is seeded
 * exactly once, so the before/after pair stays diffable after the tmp
 * journal dir is removed.
 */
const RESULTS_PATH = path.join(
  path.dirname(process.argv[1] ?? process.cwd()),
  'measure-send-freeze-results.json',
)

/** One machine-readable arm summary persisted to RESULTS_PATH at the end. */
type BenchResult = {
  stableKey: string
  label: string
  n: number
  median: number
  min: number
  max: number
  p95: number
}

/** One run record in the persisted history's append-only `runs` array. */
type PersistedBenchRun = {
  recordedAt: string
  iterations: { journalOpen: number; validateAgents: number }
  arms: BenchResult[]
  /**
   * Optional run-level provenance/validity annotation (e.g. a payload
   * shape change or known measurement contamination) — free text for
   * HUMANS; the machine-readable validity signal a stableKey-pairing
   * consumer filters on is the structured `superseded` field below.
   */
  note?: string
  /**
   * Structured validity flag: `true` marks this run's measurements as
   * superseded by a later run's (a changed measurement shape that no
   * longer pairs, or a contaminated measurement), so a consumer pairing
   * stableKeys across the history tells valid entries from superseded
   * ones by filtering on this field — never by fuzzy note-text matching.
   * Absent/undefined means the run is valid.
   */
  superseded?: boolean
}

/**
 * Persisted append-only history: beforeBaseline is seeded exactly once
 * (only when the loaded history has none); every run appends to `runs`.
 */
type PersistedBenchHistory = {
  beforeBaseline: {
    note: string
    arms: Array<{
      stableKey: string
      label: string
      medianMs: number
      n: number
    }>
  } | null
  runs: PersistedBenchRun[]
}

/** All arm summaries for this run: report() appends, and main() merges the
 * array into the persisted history at the end. */
const results: BenchResult[] = []

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

function report(stableKey: string, label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? NaN
  const min = sorted[0] ?? NaN
  const max = sorted[sorted.length - 1] ?? NaN
  const p95 = percentile95(sorted)
  console.log(
    `${label}: median ${fmt(median)} (p95 ${fmt(p95)}, min ${fmt(min)}, max ${fmt(max)}, n=${samples.length})`,
  )
  results.push({ stableKey, label, n: samples.length, median, min, max, p95 })
}

function benchSync(
  stableKey: string,
  label: string,
  fn: () => void,
  iterations: number,
): void {
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    fn()
    samples.push(performance.now() - start)
  }
  report(stableKey, label, samples)
}

/**
 * Time multiple arms against the same target with the ordering bias
 * removed, covering each arm's FULL lifecycle inside its timed window:
 * every arm gets one discarded warm-up run first (equalizing page-cache /
 * WAL state so no arm is ever timed cold), then the arms are interleaved
 * every iteration with the starting arm rotating deterministically. Each
 * arm body is awaited, so an async close() completes INSIDE the timed
 * region — no teardown can overlap the next arm's timed open.
 */
async function benchArmsInterleavedAsync(
  arms: Array<{
    stableKey: string
    label: string
    run: () => void | Promise<void>
  }>,
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
  arms.forEach((arm, index) =>
    report(arm.stableKey, arm.label, samples[index]),
  )
}

async function benchAsync(
  stableKey: string,
  label: string,
  fn: () => Promise<unknown>,
  iterations: number,
): Promise<void> {
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    await fn()
    samples.push(performance.now() - start)
  }
  report(stableKey, label, samples)
}

/**
 * Fill synthetic runs into a journal at `dbPath` under `retention`,
 * seeding the db before any arm measures against it. The journal's
 * close() is AWAITED before returning so measured arms reopen the db
 * fresh (the reopen-exactness contract under test) — enforced by the
 * harness's await, not by close()'s body happening to contain no
 * awaits.
 */
async function buildSyntheticJournal(
  dbPath: string,
  runs: number,
  eventsPerRun: number,
  payloadBytes: number,
  runIdOf: (runIndex: number) => string = (r) => `bench-run-${r}`,
  retention: RunJournalRetention = RUN_JOURNAL_DEFAULT_RETENTION,
): Promise<void> {
  const journal = createRunJournal({ path: dbPath, retention })
  try {
    const filler = 'x'.repeat(payloadBytes)
    for (let r = 0; r < runs; r++) {
      const runId = runIdOf(r)
      for (let e = 0; e < eventsPerRun; e++) {
        journal.append(runId, {
          eventType: 'tool_result',
          stepNumber: e,
          correlation: `bench-${r}-${e}`,
          payload: { toolName: 'read_files', value: filler },
        })
      }
    }
  } finally {
    await journal.close()
  }
}

/**
 * Load the persisted history at RESULTS_PATH. Only a MISSING file
 * bootstraps an empty history (the first run — the merge below creates
 * the file); anything else unreadable (an I/O error, malformed JSON, or
 * an unrecognized shape) THROWS instead: the merge must never overwrite
 * — and so never silently destroy — a history it could not read, which
 * is the loud-failure edge of the 'prior records always survive'
 * contract. The legacy single-run bare-array format upgrades into
 * runs[0].
 */
function loadPersistedHistory(): PersistedBenchHistory {
  let raw: string
  try {
    raw = fs.readFileSync(RESULTS_PATH, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { beforeBaseline: null, runs: [] }
    }
    throw error
  }
  const parsed = JSON.parse(raw) as unknown
  if (Array.isArray(parsed)) {
    // Legacy single-run bare-array format: upgrade into runs[0].
    return {
      beforeBaseline: null,
      runs: [
        {
          recordedAt: 'unknown (legacy single-run format)',
          iterations: { journalOpen: -1, validateAgents: -1 },
          arms: parsed as BenchResult[],
        },
      ],
    }
  }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { runs?: unknown }).runs)
  ) {
    return parsed as PersistedBenchHistory
  }
  throw new Error(
    `${RESULTS_PATH} is not a recognized bench history (expected { beforeBaseline, runs }): refusing to overwrite it`,
  )
}

/** Bounded attempts for mergeRunIntoHistory's lost-update-checked merge. */
const HISTORY_MERGE_ATTEMPTS = 3

/**
 * MERGE `run` into the history at RESULTS_PATH, verifying 'prior records
 * always survive' BY CODE instead of leaving it to write-ordering luck:
 * the merge is a read-modify-write over one JSON file, so an overlapping
 * bench run could interleave writes and drop records (last writer wins).
 * Every attempt loads the CURRENT file, seeds beforeBaseline exactly
 * once (only when the loaded history has none), appends the run
 * IDEMPOTENTLY (a record already present under this recordedAt is not
 * appended twice, so a retry after losing a write race never duplicates
 * the run), writes, and re-reads to verify every record the attempt saw
 * — prior and new — survived; a detected drop or an unreadable re-read
 * retries from the fresh state. Exhausting the attempts THROWS with the
 * last failure embedded: a history this run cannot merge without
 * dropping or un-verifying a record must fail the bench loudly, never
 * persist quietly. (Every drop a live writer can see is repaired — the
 * losing writer re-appends its own record on retry; the residual window
 * — a concurrent run whose write lands entirely after this merge's
 * verification — is exactly why a concurrently-contaminated run is a
 * measurement-validity event the history marks `superseded` rather
 * than evidence.)
 */
function mergeRunIntoHistory(run: PersistedBenchRun): void {
  let lastFailure: unknown
  for (let attempt = 1; attempt <= HISTORY_MERGE_ATTEMPTS; attempt++) {
    try {
      const history = loadPersistedHistory()
      const priorRecordedAt = history.runs.map(
        (priorRun) => priorRun.recordedAt,
      )
      if (!history.beforeBaseline) {
        history.beforeBaseline = {
          note: 'Measured by the pre-fix run of this bench before the deferred-seed/side-table fixes landed (interleaved arms, n=15, paired by stableKey; their timed window covered close INITIATION only — the pre awaited-close era — so absolute values are not directly comparable to the current awaited-close arms, while the O(n)-vs-O(1) scaling conclusion is unaffected). Not re-runnable post-fix; preserved machine-readably so the before/after pair is diffable in-tree.',
          arms: [
            {
              stableKey: 'open+close:byte-on:mid',
              label: 'journal open+close, byte cap ON [mid (~50MB)]',
              medianMs: 12.4,
              n: 15,
            },
            {
              stableKey: 'open+close:byte-on:big',
              label: 'journal open+close, byte cap ON [big (~160MB)]',
              medianMs: 43.1,
              n: 15,
            },
          ],
        }
      }
      if (!priorRecordedAt.includes(run.recordedAt)) {
        history.runs.push(run)
      }
      fs.writeFileSync(RESULTS_PATH, JSON.stringify(history, null, 2))
      // Lost-update check: a concurrent run that wrote between the load
      // above and this write would have been dropped by it.
      const after = loadPersistedHistory()
      const afterRecordedAt = after.runs.map(
        (persisted) => persisted.recordedAt,
      )
      const allSurvived =
        priorRecordedAt.every((recordedAt) =>
          afterRecordedAt.includes(recordedAt),
        ) && afterRecordedAt.includes(run.recordedAt)
      if (allSurvived) return
      lastFailure = new Error(
        'a concurrent bench run replaced the history between the merge write and its verification',
      )
    } catch (error) {
      lastFailure = error
    }
  }
  throw new Error(
    `could not verify a record-preserving merge into ${RESULTS_PATH} after ${HISTORY_MERGE_ATTEMPTS} attempts` +
      (lastFailure === undefined
        ? ''
        : `: ${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)}`),
  )
}

const main = async (): Promise<void> => {
  const definitions = Object.values(bundledAgents).map((def) => ({ ...def }))
  console.log(`bundled agent definitions: ${definitions.length}`)

  // Warm-up: module init + first json-schema→zod conversions are one-time.
  const warm = await sdkValidateAgents(definitions, { remote: false })
  console.log(
    `validateAgents warm-up: success=${warm.success} errors=${warm.validationErrors.length}`,
  )
  await benchAsync(
    'validate-agents:local',
    'validateAgents(local) per send',
    () => sdkValidateAgents(definitions, { remote: false }),
    VALIDATE_AGENTS_ITERATIONS,
  )

  benchSync(
    'load-provider-config:cached',
    'loadProviderConfigSync() cached',
    () => {
      loadProviderConfigSync()
    },
    200,
  )

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-send-freeze-bench-'))
  try {
    const sizes = [
      {
        key: 'tiny',
        label: 'tiny (~0.1MB)',
        runs: 5,
        events: 20,
        payload: 1024,
        perSendRunId: 'bench-run-0',
      },
      {
        key: 'mid',
        label: 'mid (~50MB)',
        runs: 150,
        events: 40,
        payload: 8192,
        perSendRunId: 'bench-run-0',
      },
      {
        key: 'big',
        label: 'big (~160MB)',
        runs: 400,
        events: 50,
        payload: 8192,
        perSendRunId: 'bench-run-0',
      },
    ]
    for (const size of sizes) {
      const dbPath = path.join(
        dir,
        `journal-${size.runs}-${size.events}-${size.payload}.db`,
      )
      const buildStart = performance.now()
      await buildSyntheticJournal(dbPath, size.runs, size.events, size.payload)
      const buildMs = performance.now() - buildStart
      const mb = (fs.statSync(dbPath).size / (1024 * 1024)).toFixed(1)
      console.log(
        `built ${size.label} journal in ${(buildMs / 1000).toFixed(1)}s (${mb}MB on disk)`,
      )
      // tiny stays an ON-only sanity anchor (no fake ON/OFF comparison at
      // a size where both arms would measure the same nothing).
      if (size.key === 'tiny') {
        await benchArmsInterleavedAsync(
          [
            {
              stableKey: `open+close:byte-on:${size.key}`,
              label: `journal open+close (awaited), byte cap ON [${size.label}]`,
              run: async () => {
                const j = createRunJournal({
                  path: dbPath,
                  retention: RUN_JOURNAL_DEFAULT_RETENTION,
                })
                await j.close()
              },
            },
          ],
          JOURNAL_OPEN_ITERATIONS,
        )
        continue
      }
      let perSendIteration = 0
      await benchArmsInterleavedAsync(
        [
          {
            stableKey: `open+close:byte-on:${size.key}`,
            label: `journal open+close (awaited), byte cap ON [${size.label}]`,
            run: async () => {
              const j = createRunJournal({
                path: dbPath,
                retention: RUN_JOURNAL_DEFAULT_RETENTION,
              })
              await j.close()
            },
          },
          {
            // Production per-send shape: the timed window covers open,
            // ONE append to the EXISTING runId, and the awaited close.
            stableKey: `per-send-append:byte-on:${size.key}`,
            label: `journal open+append(existing runId)+close (per-send shape) [${size.label}]`,
            run: async () => {
              const j = createRunJournal({
                path: dbPath,
                retention: RUN_JOURNAL_DEFAULT_RETENTION,
              })
              j.append(size.perSendRunId, {
                eventType: 'tool_result',
                stepNumber: 0,
                correlation: `per-send-${size.key}-${perSendIteration++}`,
                payload: { note: 'per-send probe' },
              })
              await j.close()
            },
          },
          {
            // Diagnostic upper bound ONLY: disabling the byte dimension
            // also skips all byte-side maintenance, so these numbers are
            // not 'before' evidence for any concrete fix.
            stableKey: `open+close:byte-disabled:${size.key}`,
            label: `journal open+close (awaited), byte dimension disabled [${size.label}] (upper bound)`,
            run: async () => {
              const j = createRunJournal({
                path: dbPath,
                retention: BYTE_DIMENSION_DISABLED,
              })
              await j.close()
            },
          },
        ],
        JOURNAL_OPEN_ITERATIONS,
      )
    }

    // Hot db: ONE runId near the byte cap (~250MB vs the 512MiB cap) — the
    // per-send shape against a single large persistent runId.
    const hotDbPath = path.join(dir, 'journal-hot.db')
    const hotLabel = 'hot (~250MB single run)'
    const hotBuildStart = performance.now()
    await buildSyntheticJournal(
      hotDbPath,
      1,
      1000,
      250_000,
      () => 'hot-run',
    )
    const hotBuildMs = performance.now() - hotBuildStart
    const hotMb = (fs.statSync(hotDbPath).size / (1024 * 1024)).toFixed(1)
    console.log(
      `built hot journal in ${(hotBuildMs / 1000).toFixed(1)}s (${hotMb}MB on disk)`,
    )
    let hotPerSendIteration = 0
    await benchArmsInterleavedAsync(
      [
        {
          stableKey: 'open+close:byte-on:hot',
          label: `journal open+close (awaited), byte cap ON [${hotLabel}]`,
          run: async () => {
            const j = createRunJournal({
              path: hotDbPath,
              retention: RUN_JOURNAL_DEFAULT_RETENTION,
            })
            await j.close()
          },
        },
        {
          stableKey: 'per-send-append:byte-on:hot',
          label: `journal open+append(existing runId)+close (per-send shape) [${hotLabel}]`,
          run: async () => {
            const j = createRunJournal({
              path: hotDbPath,
              retention: RUN_JOURNAL_DEFAULT_RETENTION,
            })
            j.append('hot-run', {
              eventType: 'tool_result',
              stepNumber: 0,
              correlation: `per-send-hot-${hotPerSendIteration++}`,
              payload: { note: 'per-send probe' },
            })
            await j.close()
          },
        },
        {
          stableKey: 'open+close:byte-disabled:hot',
          label: `journal open+close (awaited), byte dimension disabled [${hotLabel}] (upper bound)`,
          run: async () => {
            const j = createRunJournal({
              path: hotDbPath,
              retention: BYTE_DIMENSION_DISABLED,
            })
            await j.close()
          },
        },
      ],
      JOURNAL_OPEN_ITERATIONS,
    )

    // Byte-over dbs: ONE runId per shape whose payload total EXCEEDS the
    // 512MiB byte cap, BUILT with that shape's build retention so the build
    // deletes nothing, then measured with the production retention — every
    // measured append lands OVER the byte cap, exercising enforceRetention's
    // over-cap path on the per-send shape. TWO shapes cover both retained-
    // window regimes: the few-rows shape holds ~1.0k rows post-enforcement
    // (the historical 500KB shape), and the many-rows shape holds ~19.9k
    // rows — the WORST-CASE retained-row count the production caps allow
    // (~cap/27KB, bounded by maxEvents under the 512MiB cap) — so any
    // per-append O(retained) term on the over-cap path is maximally visible
    // in the measured per-send medians.
    for (const shape of BYTE_OVER_SHAPES) {
      const overDbPath = path.join(dir, `journal-byte-over-${shape.key}.db`)
      const overBuildStart = performance.now()
      await buildSyntheticJournal(
        overDbPath,
        1,
        shape.events,
        shape.eventBytes,
        () => BYTE_OVER_RUN_ID,
        shape.buildRetention,
      )
      const overBuildMs = performance.now() - overBuildStart
      const overMb = (fs.statSync(overDbPath).size / (1024 * 1024)).toFixed(1)
      console.log(
        `built byte-over (${shape.key}) journal in ${(overBuildMs / 1000).toFixed(1)}s (${overMb}MB on disk)`,
      )
      // Loud preconditions, mirroring the diag's over-cap probes. FIRST: if
      // the built db does not exceed the production byte cap, both
      // byte-over arms silently measure the under-cap fast path and record
      // numbers that prove nothing. Constant drift or a production-cap
      // change must fail the bench HERE — never silently in the persisted
      // artifact.
      const overProbe = new Database(overDbPath)
      try {
        const overProbeRow = overProbe
          .query(
            'SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS total FROM run_events WHERE run_id = ?',
          )
          .get(BYTE_OVER_RUN_ID) as { total: number } | undefined
        const builtBytes = overProbeRow?.total ?? 0
        const productionByteCap = RUN_JOURNAL_DEFAULT_RETENTION.maxBytes
        if (productionByteCap === undefined || builtBytes <= productionByteCap) {
          throw new Error(
            `byte-over (${shape.key}) journal built at ${builtBytes} payload bytes, not over the ${productionByteCap}-byte production cap: the byte-over arms would measure the under-cap fast path`,
          )
        }
        // SECOND: a shape with a retained-row floor must actually be able
        // to hold it post-enforcement — the retained window is ~cap/
        // eventBytes rows — and must have been built with enough rows, so
        // shape or cap drift fails the bench HERE instead of silently
        // under-exercising the per-append O(retained) terms the many-rows
        // shape exists to expose.
        if (shape.minRetainedRows > 0) {
          const expectedRetained = Math.floor(
            productionByteCap / shape.eventBytes,
          )
          const builtRowsRow = overProbe
            .query('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?')
            .get(BYTE_OVER_RUN_ID) as { n: number } | undefined
          const builtRows = builtRowsRow?.n ?? 0
          if (
            expectedRetained < shape.minRetainedRows ||
            builtRows <= shape.minRetainedRows
          ) {
            throw new Error(
              `byte-over (${shape.key}) shape holds ${builtRows} built rows with ~${expectedRetained} post-enforcement retained rows, below the ${shape.minRetainedRows}-row worst-case floor: per-append O(retained) terms would be under-exercised`,
            )
          }
          console.log(
            `byte-over (${shape.key}) worst-case shape: ${builtRows} built rows, ~${expectedRetained} post-enforcement retained rows (floor ${shape.minRetainedRows})`,
          )
        }
        console.log(
          `byte-over (${shape.key}) built at ${(builtBytes / (1024 * 1024)).toFixed(1)}MiB of payload bytes, over the ${(productionByteCap / (1024 * 1024)).toFixed(0)}MiB cap`,
        )
      } finally {
        overProbe.close()
      }
      let overPerSendIteration = 0
      await benchArmsInterleavedAsync(
        [
          {
            stableKey: shape.openCloseStableKey,
            label: `journal open+close (awaited), byte cap ON [${shape.label}]`,
            run: async () => {
              const j = createRunJournal({
                path: overDbPath,
                retention: RUN_JOURNAL_DEFAULT_RETENTION,
              })
              await j.close()
            },
          },
          {
            // The per-send shape in the OVER-CAP state. The appended payload
            // is ONE BUILD ROW'S SIZE — the shape's eventBytes constant, the
            // exact shape the db was built with — NOT a tiny probe: after an
            // enforcement pass the retained total sits under the cap with
            // less than one build row of slack, so a build-row-sized append
            // re-crosses the cap on EVERY iteration and each one runs the
            // over-cap enforcement. The stableKey is versioned with the
            // payload shape so history pairing stays apples-to-apples.
            stableKey: shape.perSendStableKey,
            label: `journal open+append(existing runId)+close (per-send shape) [${shape.label}]`,
            run: async () => {
              const j = createRunJournal({
                path: overDbPath,
                retention: RUN_JOURNAL_DEFAULT_RETENTION,
              })
              j.append(BYTE_OVER_RUN_ID, {
                eventType: 'tool_result',
                stepNumber: 0,
                correlation: `per-send-byte-over-${shape.key}-${overPerSendIteration++}`,
                payload: {
                  toolName: 'read_files',
                  value: 'x'.repeat(shape.eventBytes),
                },
              })
              await j.close()
            },
          },
        ],
        JOURNAL_OPEN_ITERATIONS,
      )
    }

    // Count-over db (count-over-cap-per-send-untimed): ONE runId built
    // PAST the production maxEvents cap (BOTH dimensions disabled during
    // the build so the cap cannot delete mid-build), then measured with
    // the production retention — the run sits at the count cap, so every
    // measured append re-crosses it and pays the full count over-cap
    // path (authoritative pre-delete COUNT(*) + the O(excess) boundary
    // walk + the DELETE + the arithmetic re-persist). The PERSISTED
    // per-send arm quantifies the per-append cost of count over-cap
    // enforcement for a run sitting at the cap — the state the timed
    // byte-over arms never exercise (their retained count sits under
    // the cap after warm-up).
    const countOverDbPath = path.join(dir, 'journal-count-over.db')
    const countOverBuildStart = performance.now()
    await buildSyntheticJournal(
      countOverDbPath,
      1,
      COUNT_OVER_EVENTS,
      COUNT_OVER_EVENT_BYTES,
      () => COUNT_OVER_RUN_ID,
      BUILD_NO_RETENTION,
    )
    const countOverBuildMs = performance.now() - countOverBuildStart
    const countOverMb = (
      fs.statSync(countOverDbPath).size / (1024 * 1024)
    ).toFixed(1)
    console.log(
      `built count-over journal in ${(countOverBuildMs / 1000).toFixed(1)}s (${countOverMb}MB on disk)`,
    )
    // Loud precondition, mirroring the byte-over probes: if the built run
    // does not exceed the production event cap, both count-over arms
    // silently measure the under-cap fast path. Constant drift or a
    // production-cap change must fail the bench HERE — never silently in
    // the persisted artifact.
    const countOverProbe = new Database(countOverDbPath)
    try {
      const countOverProbeRow = countOverProbe
        .query('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?')
        .get(COUNT_OVER_RUN_ID) as { n: number } | undefined
      const builtCountOverRows = countOverProbeRow?.n ?? 0
      const productionEventCap = RUN_JOURNAL_DEFAULT_RETENTION.maxEvents
      if (
        productionEventCap === undefined ||
        builtCountOverRows <= productionEventCap
      ) {
        throw new Error(
          `count-over journal built at ${builtCountOverRows} events, not over the ${productionEventCap}-event production cap: the count-over arms would measure the under-cap fast path`,
        )
      }
      console.log(
        `count-over run built at ${builtCountOverRows} events, over the ${productionEventCap}-event cap`,
      )
    } finally {
      countOverProbe.close()
    }
    let countOverPerSendIteration = 0
    await benchArmsInterleavedAsync(
      [
        {
          stableKey: 'open+close:count-over',
          label: 'journal open+close (awaited), production caps ON [count-over (~22k events, at the 20k cap)]',
          run: async () => {
            const j = createRunJournal({
              path: countOverDbPath,
              retention: RUN_JOURNAL_DEFAULT_RETENTION,
            })
            await j.close()
          },
        },
        {
          // The per-send shape in the COUNT-OVER steady state: the run
          // sits at the event cap after the first enforcement pass, so
          // every append re-crosses it and each one pays the full count
          // over-cap enforcement. The payload is small — only the count
          // dimension is under test; the byte cap is never approached.
          stableKey: 'per-send-append:count-over',
          label: 'journal open+append(existing runId)+close (per-send shape) [count-over steady state]',
          run: async () => {
            const j = createRunJournal({
              path: countOverDbPath,
              retention: RUN_JOURNAL_DEFAULT_RETENTION,
            })
            j.append(COUNT_OVER_RUN_ID, {
              eventType: 'tool_result',
              stepNumber: 0,
              correlation: `per-send-count-over-${countOverPerSendIteration++}`,
              payload: { note: 'per-send count-over probe' },
            })
            await j.close()
          },
        },
      ],
      JOURNAL_OPEN_ITERATIONS,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // Persisted evidence: MERGE this run into the history at RESULTS_PATH.
  // mergeRunIntoHistory seeds beforeBaseline exactly once (only when the
  // loaded history has none), appends this run, and re-reads its own
  // write — repairing any record drop it can see and failing the bench
  // loudly when it cannot verify the merge. This run is a VALID run, so
  // it carries no `superseded` flag (absent/undefined = valid).
  mergeRunIntoHistory({
    recordedAt: new Date().toISOString(),
    iterations: {
      journalOpen: JOURNAL_OPEN_ITERATIONS,
      validateAgents: VALIDATE_AGENTS_ITERATIONS,
    },
    arms: results,
    note: 'byte-over per-send arms append one build row per shape (500kb few-rows + 27kb worst-case many-rows; each shape stableKey is versioned with its payload shape); count-over arms time the steady-state count-cap per-send path at the production 20k-event cap',
  })
  console.log(`wrote ${results.length} arm summaries to ${RESULTS_PATH}`)
}

void main()
