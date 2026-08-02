import type { JobEvent, JobState } from './job-registry'

export type PendingBucket = 'none' | '<10' | '<100' | '<1k' | '1k+'

/**
 * Count pending output lines relative to a consumer cursor.
 *
 * Tallies '\n' in buffered output events plus an optional non-empty lineCarry
 * (+1). A registry chunk that ends mid-line without carry would under-count
 * relative to tail extraction; process adapters avoid that by line-splitting
 * at emit (`emitJobOutputLines`) and retaining the unterminated fragment in
 * lineCarry (or force-flushing past MAX_LINE_BYTES / on settle). Agent/
 * non-process output is not line-bucketed the same way.
 */
export function countPendingOutputLines(params: {
  eventsAfterCursor: ReadonlyArray<Pick<JobEvent, 'payload'> | { payload: { type: string; data?: unknown } }>
  lineCarry?: string
}): number {
  let count = 0
  for (const event of params.eventsAfterCursor) {
    if (event.payload.type !== 'output') continue
    const data =
      typeof (event.payload as { data?: unknown }).data === 'string'
        ? ((event.payload as { data: string }).data)
        : ''
    for (let i = 0; i < data.length; i++) {
      if (data[i] === '\n') count += 1
    }
  }
  // A non-empty partial trailing line (not yet terminated) counts as +1.
  if (params.lineCarry && params.lineCarry.length > 0) {
    count += 1
  }
  return count
}

export function bucketPendingLines(n: number): PendingBucket {
  if (n <= 0) return 'none'
  if (n < 10) return '<10'
  if (n < 100) return '<100'
  if (n < 1000) return '<1k'
  return '1k+'
}

export type ListJobsViewRow = {
  jobId: string
  kind: 'process' | 'agent'
  command: string
  status: JobState
  startedAt: number
  completedAt?: number
  pending: PendingBucket
  gap: boolean
  exitCode?: number | null
  /** ≤10 lines, only when provided (typically terminal peek). */
  tail?: string[]
}

export const LIST_JOBS_MAX_ROWS = 10
/**
 * Consumed by `extractTailLines` in `sdk/src/tools/list-jobs.ts` to cap the
 * terminal tail (`lines.slice(-LIST_JOBS_MAX_TAIL_LINES)`) — not a dead export.
 */
export const LIST_JOBS_MAX_TAIL_LINES = 10
export const LIST_JOBS_NO_ACTION_LINE =
  'No action required unless you need this output.'

const TERMINAL_STATUSES = new Set<JobState>([
  'completed',
  'error',
  'stopped',
  'lost',
  'cancelled',
])

function isNonTerminalStatus(status: JobState): boolean {
  return !TERMINAL_STATUSES.has(status)
}

/**
 * Prefer running/non-terminal, then by startedAt desc (stable for equal
 * startedAt); cap at LIST_JOBS_MAX_ROWS. Generic over the row shape so callers
 * can pre-select on lightweight data (status/startedAt only) and enrich just
 * the selected rows.
 */
export function selectListJobsRows<
  T extends Pick<ListJobsViewRow, 'status' | 'startedAt'>,
>(rows: T[]): {
  rows: T[]
  truncatedCount: number
} {
  const sorted = [...rows].sort((a, b) => {
    const aLive = isNonTerminalStatus(a.status) ? 0 : 1
    const bLive = isNonTerminalStatus(b.status) ? 0 : 1
    if (aLive !== bLive) return aLive - bLive
    return b.startedAt - a.startedAt
  })
  const selected = sorted.slice(0, LIST_JOBS_MAX_ROWS)
  return {
    rows: selected,
    truncatedCount: Math.max(0, sorted.length - selected.length),
  }
}

/**
 * Stable fingerprint for change-gating tests / future use.
 *
 * exitCode is included because it is a meaningful terminal signal (a
 * completed job whose exitCode differs must bust the gate); tail/startedAt
 * remain intentionally ignored as churn.
 */
export function fingerprintListJobsRows(rows: ListJobsViewRow[]): string {
  return [...rows]
    .sort((a, b) => a.jobId.localeCompare(b.jobId))
    .map(
      (row) =>
        `${row.jobId}|${row.status}|${row.pending}|${row.gap}|${row.completedAt ?? ''}|${row.exitCode ?? ''}`,
    )
    .join('\n')
}

/** Build the json value shape for list_jobs. */
export function buildListJobsValue(params: {
  rows: ListJobsViewRow[]
  /**
   * Precomputed truncation when `rows` was already capped via
   * selectListJobsRows (e.g. selected on lightweight data before expensive
   * enrichment). When provided, `rows` is emitted as-is, not re-selected.
   */
  truncatedCount?: number
}): {
  jobs: ListJobsViewRow[]
  truncatedCount?: number
  note: typeof LIST_JOBS_NO_ACTION_LINE
} {
  const selected =
    params.truncatedCount !== undefined
      ? { rows: params.rows, truncatedCount: params.truncatedCount }
      : selectListJobsRows(params.rows)
  return {
    jobs: selected.rows,
    ...(selected.truncatedCount > 0
      ? { truncatedCount: selected.truncatedCount }
      : {}),
    note: LIST_JOBS_NO_ACTION_LINE,
  }
}
