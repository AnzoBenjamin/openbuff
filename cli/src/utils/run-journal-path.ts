import fs from 'node:fs'
import path from 'node:path'

import { createRunJournal } from '@codebuff/agent-runtime/util/run-journal'
import { getHarnessStateDir } from '@openbuff/sdk'

import type {
  CreatedRunJournal,
  RunJournalRetention,
} from '@codebuff/agent-runtime/util/run-journal'

/**
 * Default on-disk location of the P2-T2 run journal (WAL sqlite), shared by
 * the live-run wiring (TUI send + headless run), `openbuff replay`, and
 * `openbuff dash`. Resolved lazily by every caller (never at module load) so
 * tests that inject a journal path never touch the real config directory.
 */
export function resolveRunJournalPath(): string {
  return path.join(getHarnessStateDir(), 'run-journal.db')
}

/**
 * Write-side retention caps applied by default to the LIVE-run journal:
 * per-run history is bounded to the newest 20k events / 512 MiB of
 * serialized payloads, which also bounds the `toolResultForInput`
 * full-history scan. WRITE-SIDE ONLY — readers (`openbuff dash`,
 * `openbuff replay`) open the same journal WITHOUT retention and never
 * delete.
 *
 * Honest tradeoff: a run longer than 20k journaled events keeps only its
 * newest 20k, so replay of the very early steps of a huge run sees the
 * retained tail. classifyRunResume keys on seq (not row count) and is
 * unaffected — retention never deletes the newest row.
 */
export const RUN_JOURNAL_DEFAULT_RETENTION: RunJournalRetention = {
  maxEvents: 20_000,
  maxBytes: 512 * 1024 * 1024,
}

/**
 * File-size trigger for write-side journal maintenance (default 512 MiB —
 * the same bound RUN_JOURNAL_DEFAULT_RETENTION documents per run): a
 * journal file under this size is left alone, and
 * maintainRunJournalIfNeeded returns after one O(1) stat without ever
 * opening the db. WRITE-SIDE ONLY: readers never trigger maintenance.
 */
export const RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES = 512 * 1024 * 1024

/**
 * Default maintenance parameters maintainRunJournalIfNeeded forwards to
 * the journal's maintain(): keep the newest 10 runs (by first-event
 * order) and VACUUM the file after pruning so the pruned pages are
 * actually returned to the filesystem. WRITE-SIDE ONLY — readers
 * (`openbuff dash`, `openbuff replay`) never run maintenance and never
 * delete.
 */
export const RUN_JOURNAL_DEFAULT_MAINTENANCE: {
  keepRuns: number
  vacuum: boolean
} = { keepRuns: 10, vacuum: true }

/**
 * P2-T7: open the run journal for a LIVE run, fail-open. Callers invoke this
 * only when a run actually starts (never at startup), so a TUI/CLI session
 * that never runs the agent never creates the journal db. When opening
 * throws, the caller's `warn` is invoked once and the run proceeds WITHOUT
 * journaling — a journaling outage can never break a user turn.
 *
 * Retention defaults to RUN_JOURNAL_DEFAULT_RETENTION (write-side only;
 * readers never delete). Batching stays opt-in (never set here):
 * flush-per-append is the kill-9 crash-resume durability contract.
 */
export function openRunJournalForRun(params: {
  path?: string
  warn: (message: string) => void
  /** Injectable factory seam; defaults to the real createRunJournal. */
  createRunJournal?: typeof createRunJournal
  /** Write-side retention caps; defaults to RUN_JOURNAL_DEFAULT_RETENTION. */
  retention?: RunJournalRetention
}): CreatedRunJournal | undefined {
  const create = params.createRunJournal ?? createRunJournal
  try {
    return create({
      path: params.path ?? resolveRunJournalPath(),
      retention: params.retention ?? RUN_JOURNAL_DEFAULT_RETENTION,
    })
  } catch (error) {
    params.warn(
      `run journal unavailable, continuing without journaling: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return undefined
  }
}

/**
 * Default maintenance-marker reader for the hysteresis gate: the byte
 * size recorded in `<journalPath>.maintained`, or undefined when the
 * marker is absent, unreadable, or corrupt (empty / non-numeric /
 * non-finite content) — every marker failure is fail-open, so an
 * unusable marker simply means the pass runs. Non-file journal paths
 * (`:memory:`) never have a marker: the read degrades to undefined
 * without touching the filesystem.
 */
function defaultReadMaintenanceMarker(
  journalPath: string,
): number | undefined {
  if (journalPath === ':memory:') return undefined
  try {
    const raw = fs.readFileSync(`${journalPath}.maintained`, 'utf8').trim()
    if (raw.length === 0) return undefined
    const recorded = Number(raw)
    return Number.isFinite(recorded) ? recorded : undefined
  } catch {
    return undefined
  }
}

/**
 * Default maintenance-marker writer: records `sizeInBytes` as string
 * content in `<journalPath>.maintained`. Non-file journal paths
 * (`:memory:`) never get a marker (a stray `:memory:.maintained` next to
 * the process CWD would be nonsense), so the write is a no-op for them.
 * The CALLER absorbs write failures — the marker is advisory hysteresis,
 * never part of the pass result.
 */
function defaultWriteMaintenanceMarker(
  journalPath: string,
  sizeInBytes: number,
): void {
  if (journalPath === ':memory:') return
  fs.writeFileSync(`${journalPath}.maintained`, String(sizeInBytes))
}

/**
 * Scheduler yield maintainRunJournalIfNeeded takes immediately BEFORE the
 * expensive maintenance work. The pass is async, but everything from the
 * createRunJournal open through maintain()'s per-run DELETEs and the
 * full-file VACUUM is synchronous main-thread work (bun:sqlite has no
 * async API), so without this await the whole over-trigger pass would run
 * inside the caller's own synchronous tick and a fire-and-forget kick
 * during CLI boot would freeze the terminal before the first frame. A
 * MACROTASK is required, never a microtask: microtasks drain before the
 * caller's own next await, so only a macrotask actually hands the event
 * loop back first.
 */
function yieldToScheduler(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * WRITE-SIDE file-level journal maintenance, fail-open: when the shared
 * run-journal file is over RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES, open it
 * via the injectable createRunJournal seam, run ONE maintain() pass (prune
 * old runs, VACUUM the file), and close it. Per-run retention bounds each
 * runId's ROWS but never the number of RUNS a shared file accumulates,
 * and a WAL sqlite file never shrinks on DELETE alone — this is the
 * file-level counterpart. WRITE-SIDE ONLY: readers (`openbuff dash`,
 * `openbuff replay`) never trigger it and never delete.
 *
 * The common path is O(1): one stat check returns WITHOUT opening the db
 * when the file is under the trigger or missing (a stat failure — there is
 * nothing to observe, and nothing to create or open for it, either), and
 * the maintenance-marker hysteresis gate keeps an UNCHANGED over-trigger
 * journal from opening the db on every boot: a sidecar marker file
 * `<journalPath>.maintained` records the journal's byte size at the last
 * pass, and when its recorded size >= the current size the pass returns
 * { maintained: false, reason: 'unchanged-since-maintenance' } WITHOUT
 * opening the db. EVERY marker read/write failure is fail-open (an
 * unreadable or corrupt marker is ignored and the pass runs; a failed
 * marker write still returns the successful pass result), and both
 * marker seams are injectable so tests stay hermetic.
 *
 * The over-trigger pass YIELDS to the scheduler before it opens the db:
 * the open, maintain()'s per-run DELETEs, and the VACUUM are all
 * synchronous main-thread work (bun:sqlite has no async API), so without
 * that await the async-marked pass would still run entirely inside the
 * caller's synchronous tick — a fire-and-forget boot kick would freeze
 * the terminal before the first frame. After the yield the heavy work is
 * still synchronous (that is sqlite's contract), but it starts in a
 * LATER macrotask; only the O(1) gates above run in the caller's own
 * tick.
 *
 * Honest tradeoff: the marker is recorded after EVERY maintained pass —
 * including one whose VACUUM was busy — so an unchanged journal skips
 * until it GROWS past the recorded size again. That retry timing is
 * correct: growth is exactly when new prunable content appears, and
 * maintain() only attempts VACUUM when the journal has free pages to
 * reclaim, so there is nothing more to reclaim on an unchanged file.
 * EVERY failure path is fail-open, so a maintenance outage can never
 * throw onto the caller that kicked it.
 */
export async function maintainRunJournalIfNeeded(params?: {
  path?: string
  statFn?: (p: string) => { size: number }
  createRunJournal?: typeof createRunJournal
  retention?: RunJournalRetention
  maintenance?: { keepRuns?: number; vacuum?: boolean }
  /**
   * Injectable marker seams for the hysteresis gate (defaults use
   * node:fs against `<journalPath>.maintained`): reading returns the
   * recorded byte size, or undefined when there is no usable marker.
   */
  readMaintenanceMarker?: (journalPath: string) => number | undefined
  /** Records the post-pass byte size; a throw is absorbed fail-open. */
  writeMaintenanceMarker?: (journalPath: string, sizeInBytes: number) => void
}): Promise<{
  maintained: boolean
  prunedRunCount?: number
  vacuumed?: boolean
  reason?: string
}> {
  const stat = params?.statFn ?? ((p: string) => fs.statSync(p))
  const create = params?.createRunJournal ?? createRunJournal
  const maintenance = params?.maintenance ?? RUN_JOURNAL_DEFAULT_MAINTENANCE
  const readMarker =
    params?.readMaintenanceMarker ?? defaultReadMaintenanceMarker
  const writeMarker =
    params?.writeMaintenanceMarker ?? defaultWriteMaintenanceMarker
  // O(1) common path: one stat decides WITHOUT opening the db — undefined
  // means the file is missing or unstat-able, so there is nothing to
  // observe (and nothing to create or open for it, either).
  const sizeOf = (p: string): number | undefined => {
    try {
      return stat(p).size
    } catch {
      return undefined
    }
  }
  let journal: CreatedRunJournal | undefined
  try {
    const journalPath = params?.path ?? resolveRunJournalPath()
    const size = sizeOf(journalPath)
    if (size === undefined) return { maintained: false, reason: 'missing' }
    if (size < RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES) {
      return { maintained: false, reason: 'under-trigger' }
    }
    // Hysteresis gate, still BEFORE opening the db: a sidecar marker
    // records the journal size at the last pass, so an UNCHANGED
    // over-trigger journal (e.g. one whose retained runs alone exceed
    // the trigger) skips instead of paying a pass on every boot. A
    // throwing or unusable marker read is fail-open: the pass runs.
    let recordedSize: number | undefined
    try {
      recordedSize = readMarker(journalPath)
    } catch {
      // Fail-open: an unreadable marker cannot gate the pass.
      recordedSize = undefined
    }
    if (recordedSize !== undefined && recordedSize >= size) {
      return { maintained: false, reason: 'unchanged-since-maintenance' }
    }
    // Over the trigger: open via the injectable seam (retention defaults
    // to RUN_JOURNAL_DEFAULT_RETENTION, mirroring openRunJournalForRun —
    // write-side only; readers never delete), run one fail-open
    // maintain() pass, and close. maintain() itself never throws; the
    // guards below keep the seam's own failures equally fail-open.
    // Yield to the scheduler BEFORE any of that: the open, maintain()'s
    // per-run DELETEs and the full-file VACUUM are synchronous main-thread
    // work (bun:sqlite has no async API), so without this await the pass
    // would run entirely inside the caller's synchronous tick and a
    // fire-and-forget boot kick would freeze the terminal before the
    // first frame. The O(1) gates above are all that still runs in the
    // caller's own tick.
    await yieldToScheduler()
    journal = create({
      path: journalPath,
      retention: params?.retention ?? RUN_JOURNAL_DEFAULT_RETENTION,
    })
    const { prunedRunCount, vacuumed } = journal.maintain(maintenance)
    // Record the marker AFTER the pass, with the POST-PASS size (the
    // next gate compares against what this pass left behind), even when
    // the pass's VACUUM was busy — see the doc comment's tradeoff.
    // Best-effort: a write failure never turns a successful pass into a
    // failure, and an unstat-able post-pass size simply skips the write.
    const postSize = sizeOf(journalPath)
    if (postSize !== undefined) {
      try {
        writeMarker(journalPath, postSize)
      } catch {
        // Fail-open: the marker is advisory hysteresis only.
      }
    }
    return { maintained: true, prunedRunCount, vacuumed }
  } catch (error) {
    return {
      maintained: false,
      reason: `run journal maintenance unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  } finally {
    // Release the handle on every exit path (the early returns above
    // never opened one); the close is itself absorbed so cleanup can never
    // turn a fail-open result into a throw.
    try {
      await journal?.close()
    } catch {
      // Best-effort close; maintenance is fail-open by contract.
    }
  }
}

/**
 * Fire-and-forget wrapper so a caller (e.g. startup wiring) can kick
 * journal maintenance without awaiting it. The kick is genuinely
 * non-blocking: maintainRunJournalIfNeeded's only synchronous work is the
 * O(1) stat/marker gates — it yields to the scheduler before it opens the
 * db — so the heavy over-trigger pass (per-run DELETEs plus a full-file
 * VACUUM) starts in a LATER macrotask. Callers that care about the first
 * frame kick this AFTER that frame is painted (cli/src/index.tsx does, on
 * the renderer path). The returned promise is explicitly discarded with a
 * `.catch(() => {})`: the pass is fail-open by contract, and the
 * belt-and-braces catch keeps even an unexpected rejection from surfacing
 * as an unhandled rejection in the caller's process.
 */
export function scheduleRunJournalMaintenance(): void {
  void maintainRunJournalIfNeeded().catch(() => {})
}
