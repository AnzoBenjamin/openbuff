import type { JobEvent, JobState } from './job-registry'

export type PendingBucket = 'none' | '<10' | '<100' | '<1k' | '1k+'

/**
 * Count pending output lines relative to a consumer cursor.
 *
 * Tallies '\n' in buffered output events plus an optional non-empty lineCarry
 * (+1). A registry chunk that ends mid-line without carry would under-count
 * relative to tail extraction; process adapters avoid that by line-splitting
 * at emit (`emitJobOutputLines`) and retaining the unterminated fragment in
 * lineCarry (or force-flushing past MAX_LINE_BYTES / on settle).
 *
 * Agent `agent_chunk` events each count as 1 pending unit (agents stream
 * structured chunks, not line-split output, so newline counting alone would
 * always read zero). Output counting is unchanged.
 */
export function countPendingOutputLines(params: {
  eventsAfterCursor: ReadonlyArray<
    Pick<JobEvent, 'payload'> | { payload: { type: string; data?: unknown } }
  >
  lineCarry?: string
}): number {
  let count = 0
  for (const event of params.eventsAfterCursor) {
    if (event.payload.type === 'output') {
      const data =
        typeof (event.payload as { data?: unknown }).data === 'string'
          ? (event.payload as { data: string }).data
          : ''
      for (let i = 0; i < data.length; i++) {
        if (data[i] === '\n') count += 1
      }
      continue
    }
    // Each agent chunk is one pending unit, regardless of data shape.
    // No byte scan, so huge structured payloads stay bounded.
    if (event.payload.type === 'agent_chunk') {
      count += 1
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
  /** Short agent progress hint (≤160 chars), only when provided. */
  lastSummary?: string
}

export const LIST_JOBS_MAX_ROWS = 10
/**
 * Consumed by `extractTailLines` in `sdk/src/tools/list-jobs.ts` to cap the
 * terminal tail (`lines.slice(-LIST_JOBS_MAX_TAIL_LINES)`) — not a dead export.
 */
export const LIST_JOBS_MAX_TAIL_LINES = 10
/** Max chars for ListJobsViewRow.lastSummary (bounded truncation). */
export const LIST_JOBS_LAST_SUMMARY_MAX_CHARS = 160
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
>(
  rows: T[],
): {
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
 * Extract a short human-readable summary from agent events.
 *
 * Scans in reverse for the last `agent_chunk` with string text data (or a
 * `status` message), collapses whitespace, and truncates to
 * LIST_JOBS_LAST_SUMMARY_MAX_CHARS. Non-text chunks resolve to their
 * chunkType so tool_call/tool_result progress still surfaces. Returns
 * undefined when no event carries summary text. Bounded: object payloads are
 * never JSON-serialized; only direct string fields are read.
 */
export function summarizeAgentEvents(
  events: ReadonlyArray<
    Pick<JobEvent, 'payload'> | { payload: { type: string; data?: unknown } }
  >,
): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i]!.payload as {
      type: string
      data?: unknown
      chunkType?: unknown
      message?: unknown
    }
    let text: string | undefined
    if (payload.type === 'agent_chunk') {
      const data = (payload as { data?: unknown }).data
      if (typeof data === 'string') {
        text = data
      } else if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>
        if (typeof record.text === 'string') text = record.text
        else if (typeof record.message === 'string') text = record.message
        else if (typeof payload.chunkType === 'string') text = payload.chunkType
      } else if (typeof payload.chunkType === 'string') {
        text = payload.chunkType
      }
    } else if (payload.type === 'status') {
      if (typeof payload.message === 'string') text = payload.message
    }
    if (text === undefined) continue
    const collapsed = text.replace(/\s+/g, ' ').trim()
    if (collapsed.length === 0) continue
    return collapsed.length > LIST_JOBS_LAST_SUMMARY_MAX_CHARS
      ? collapsed.slice(0, LIST_JOBS_LAST_SUMMARY_MAX_CHARS)
      : collapsed
  }
  return undefined
}

/**
 * Last ≤LIST_JOBS_MAX_TAIL_LINES non-empty text lines from agent_chunk
 * string data. Bounded: per-event text is capped to its last 20k chars
 * before splitting so a huge chunk cannot blow up the digest; events with
 * non-string data are skipped without serialization.
 */
export function extractAgentTailLines(
  events: ReadonlyArray<
    Pick<JobEvent, 'payload'> | { payload: { type: string; data?: unknown } }
  >,
): string[] {
  const lines: string[] = []
  for (const event of events) {
    const payload = event.payload as { type: string; data?: unknown }
    if (payload.type !== 'agent_chunk') continue
    let text: string | undefined
    if (typeof payload.data === 'string') {
      text = payload.data
    } else if (payload.data && typeof payload.data === 'object') {
      const record = payload.data as Record<string, unknown>
      if (typeof record.text === 'string') text = record.text
    }
    if (text === undefined || text.length === 0) continue
    const bounded = text.length > 20_000 ? text.slice(-20_000) : text
    for (const line of bounded.split('\n')) {
      if (line.length > 0) lines.push(line)
    }
  }
  return lines.slice(-LIST_JOBS_MAX_TAIL_LINES)
}

/**
 * Stable fingerprint for change-gating tests / future use.
 *
 * exitCode is included because it is a meaningful terminal signal (a
 * completed job whose exitCode differs must bust the gate); tail/startedAt
 * and lastSummary remain intentionally ignored as churn.
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
