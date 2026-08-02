import type { JobEvent, JobState } from './job-registry'

export type PendingBucket = 'none' | '<10' | '<100' | '<1k' | '1k+'

/** Count pending output lines relative to a consumer cursor. */
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

/** Prefer running/non-terminal, then by startedAt desc; cap at LIST_JOBS_MAX_ROWS. */
export function selectListJobsRows(rows: ListJobsViewRow[]): {
  rows: ListJobsViewRow[]
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

/** Stable fingerprint for change-gating tests / future use. */
export function fingerprintListJobsRows(rows: ListJobsViewRow[]): string {
  return [...rows]
    .sort((a, b) => a.jobId.localeCompare(b.jobId))
    .map(
      (row) =>
        `${row.jobId}|${row.status}|${row.pending}|${row.gap}|${row.completedAt ?? ''}`,
    )
    .join('\n')
}

/** Build the json value shape for list_jobs. */
export function buildListJobsValue(params: {
  rows: ListJobsViewRow[]
}): {
  jobs: ListJobsViewRow[]
  truncatedCount?: number
  note: typeof LIST_JOBS_NO_ACTION_LINE
} {
  const selected = selectListJobsRows(params.rows)
  return {
    jobs: selected.rows,
    ...(selected.truncatedCount > 0
      ? { truncatedCount: selected.truncatedCount }
      : {}),
    note: LIST_JOBS_NO_ACTION_LINE,
  }
}
