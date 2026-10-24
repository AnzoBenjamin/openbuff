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
