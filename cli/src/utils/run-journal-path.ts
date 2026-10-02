import path from 'node:path'

import { createRunJournal } from '@codebuff/agent-runtime/util/run-journal'
import { getHarnessStateDir } from '@openbuff/sdk'

import type { CreatedRunJournal } from '@codebuff/agent-runtime/util/run-journal'

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
 * P2-T7: open the run journal for a LIVE run, fail-open. Callers invoke this
 * only when a run actually starts (never at startup), so a TUI/CLI session
 * that never runs the agent never creates the journal db. When opening
 * throws, the caller's `warn` is invoked once and the run proceeds WITHOUT
 * journaling — a journaling outage can never break a user turn.
 */
export function openRunJournalForRun(params: {
  path?: string
  warn: (message: string) => void
}): CreatedRunJournal | undefined {
  try {
    return createRunJournal({ path: params.path ?? resolveRunJournalPath() })
  } catch (error) {
    params.warn(
      `run journal unavailable, continuing without journaling: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return undefined
  }
}
