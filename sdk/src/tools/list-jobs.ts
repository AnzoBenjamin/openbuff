import {
  LIST_JOBS_MAX_TAIL_LINES,
  bucketPendingLines,
  buildListJobsValue,
  countPendingOutputLines,
  type ListJobsViewRow,
} from '@codebuff/common/util/list-jobs-view'
import {
  isTerminalJobState,
  jobRegistry,
  type JobEvent,
} from '@codebuff/common/util/job-registry'

import {
  getBackgroundJobForRegistryId,
  peekJobLineCarry,
} from './background-jobs'

import type { BackgroundJobOwner } from './background-jobs'
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
  const owner = {
    clientSessionId: params.owner.clientSessionId,
    rootRunId: params.owner.rootRunId,
  }
  // Both shell (`process`) and background-agent (`agent`) jobs share the
  // registry; list every owned job so rediscovery matches docs/schema and
  // runtime end_turn warnings. Ownership is (clientSessionId, rootRunId).
  // Do NOT advance lastCheckCursor — list_jobs is a read-only digest.
  const rows: ListJobsViewRow[] = jobRegistry.list(owner).map((entry) => {
    // Resolve process adapters by *registry* id (not a direct Map get on the
    // registry id alone). Live spawns share one id; recovered /
    // `__registerJobForTest` remaps (Map key = user/disk jobId,
    // registryJobId = fresh registry id). Reverse-scan so lastCheckCursor and
    // lineCarry are visible, and emit the user-facing adapter.jobId so
    // rediscovered ids work with check_job/kill_job.
    //
    // `pending` line buckets count only registry events with
    // `payload.type === 'output'` relative to the process adapter's
    // `lastCheckCursor` (advanced solely by `check_job`). Agent jobs typically
    // have no process adapter (miss → cursor 0) and emit `agent_chunk` (not
    // `output`), so line-based `pending` stays `'none'`; agents are
    // rediscovered via status/kind, not pending lines. `gap` still reflects
    // ring truncation at the snapshot cursor for any kind.
    //
    // countPendingOutputLines tallies '\n' in buffered output events plus an
    // optional non-empty lineCarry (+1). A registry chunk that ends mid-line
    // without carry would under-count relative to tail extraction; process
    // adapters avoid that by line-splitting at emit (`emitJobOutputLines`)
    // and retaining the unterminated fragment in lineCarry (or force-flushing
    // past MAX_LINE_BYTES / on settle). Agent/non-process output is not
    // line-bucketed the same way.
    const adapter = getBackgroundJobForRegistryId(entry.jobId)
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
    // Prefer user-facing adapter.jobId when remapped; agents/no-adapter keep
    // the registry id (the only id they have).
    const row: ListJobsViewRow = {
      jobId: adapter?.jobId ?? entry.jobId,
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

  const value = buildListJobsValue({ rows })
  return [{ type: 'json', value }]
}
