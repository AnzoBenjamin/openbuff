import {
  LIST_JOBS_MAX_TAIL_LINES,
  bucketPendingLines,
  buildListJobsValue,
  countPendingOutputLines,
  selectListJobsRows,
  type ListJobsViewRow,
} from '@codebuff/common/util/list-jobs-view'
import {
  isTerminalJobState,
  jobRegistry,
  type JobEvent,
} from '@codebuff/common/util/job-registry'

import {
  getBackgroundJobAdapter,
  peekJobLineCarry,
  type BackgroundJobOwner,
} from './background-jobs'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'

/** Last ≤10 non-empty output lines from buffered events (terminal peek only). */
function extractTailLines(events: ReadonlyArray<JobEvent>): string[] {
  const lines: string[] = []
  for (const event of events) {
    if (event.payload.type !== 'output') continue
    const data = event.payload.data
    for (const line of data.split('\n')) {
      if (line.length > 0) lines.push(line)
    }
  }
  return lines.slice(-LIST_JOBS_MAX_TAIL_LINES)
}

export async function listJobs(params: {
  /**
   * REQUIRED trusted owner, injected from run/session state by the caller
   * (never from model/tool input). list_jobs can never list unscoped.
   */
  owner: BackgroundJobOwner
}): Promise<CodebuffToolOutput<'list_jobs'>> {
  // Narrow the trusted owner to the registry's ownership key: list_jobs is
  // scoped by (clientSessionId, rootRunId) only; parentRunId/parentAgentId are
  // diagnostic and deliberately excluded from the ownership filter.
  const scopeOwner = {
    clientSessionId: params.owner.clientSessionId,
    rootRunId: params.owner.rootRunId,
  }
  // Both shell (`process`) and background-agent (`agent`) jobs share the
  // registry; list every owned job so rediscovery matches docs/schema and
  // runtime end_turn warnings. Ownership is (clientSessionId, rootRunId).
  // Do NOT advance lastCheckCursor — list_jobs is a read-only digest.
  //
  // Cap on lightweight registry data first: candidates carry only the fields
  // selectListJobsRows orders by (state → status, startedAt ?? createdAt —
  // the same fallback the row build below uses, keeping order/tie-break
  // parity), so adapter reverse-resolution, snapshot, pending, and tail work
  // runs only for the ≤LIST_JOBS_MAX_ROWS rows actually emitted.
  const candidates = jobRegistry.list(scopeOwner).map((entry) => ({
    entry,
    status: entry.state,
    startedAt: entry.startedAt ?? entry.createdAt,
  }))
  const selected = selectListJobsRows(candidates)
  const rows: ListJobsViewRow[] = selected.rows.map(({ entry }) => {
    // Resolve process adapters by jobId (Map key = registry id = jobId).
    //
    // `pending` line buckets count only registry events with
    // `payload.type === 'output'` relative to the process adapter's
    // `lastCheckCursor` (advanced solely by `check_job`). Agent jobs typically
    // have no process adapter (miss → cursor 0) and emit `agent_chunk` (not
    // `output`), so line-based `pending` stays `'none'`; agents are
    // rediscovered via status/kind, not pending lines. `gap` still reflects
    // ring truncation at the snapshot cursor for any kind.
    //
    // The lineCarry +1 counting rationale lives on `countPendingOutputLines`.
    const adapter = getBackgroundJobAdapter(entry.jobId)
    const cursor = adapter?.lastCheckCursor ?? 0
    const snap = jobRegistry.snapshot(entry.jobId, cursor)
    const lineCarry =
      adapter !== undefined ? peekJobLineCarry(adapter) : undefined
    const pending = bucketPendingLines(
      countPendingOutputLines({
        eventsAfterCursor: snap?.events ?? [],
        lineCarry,
      }),
    )
    const gap = snap?.truncated ?? false
    const row: ListJobsViewRow = {
      // Single-id invariant: the adapter Map key, the registry id, and the
      // user-facing jobId are the same string, so emit entry.jobId directly.
      jobId: entry.jobId,
      kind: entry.kind,
      command: entry.label,
      status: entry.state,
      startedAt: entry.startedAt ?? entry.createdAt,
      pending,
      gap,
      ...(entry.completedAt !== undefined
        ? { completedAt: entry.completedAt }
        : {}),
    }
    if (entry.exitCode !== undefined) {
      row.exitCode = entry.exitCode
    }
    if (isTerminalJobState(entry.state)) {
      // Prefer events after the consumer cursor; if empty, peek from 0 for a
      // short terminal tail without dumping megabytes (already-buffered only).
      const tailSource =
        snap && snap.events.length > 0
          ? snap.events
          : (jobRegistry.snapshot(entry.jobId, 0)?.events ?? [])
      const tail = extractTailLines(tailSource)
      if (tail.length > 0) {
        row.tail = tail
      }
    }
    return row
  })

  const value = buildListJobsValue({
    rows,
    truncatedCount: selected.truncatedCount,
  })
  return [{ type: 'json', value }]
}
