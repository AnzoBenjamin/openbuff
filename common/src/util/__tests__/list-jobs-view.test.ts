import { describe, expect, test } from 'bun:test'

import {
  LIST_JOBS_MAX_ROWS,
  LIST_JOBS_NO_ACTION_LINE,
  bucketPendingLines,
  buildListJobsValue,
  countPendingOutputLines,
  fingerprintListJobsRows,
  selectListJobsRows,
  type ListJobsViewRow,
} from '../list-jobs-view'

function row(
  overrides: Partial<ListJobsViewRow> & Pick<ListJobsViewRow, 'jobId'>,
): ListJobsViewRow {
  return {
    kind: 'process',
    command: 'cmd',
    status: 'running',
    startedAt: 1,
    pending: 'none',
    gap: false,
    ...overrides,
  }
}

describe('bucketPendingLines', () => {
  test('boundaries', () => {
    expect(bucketPendingLines(0)).toBe('none')
    expect(bucketPendingLines(9)).toBe('<10')
    expect(bucketPendingLines(10)).toBe('<100')
    expect(bucketPendingLines(99)).toBe('<100')
    expect(bucketPendingLines(100)).toBe('<1k')
    expect(bucketPendingLines(999)).toBe('<1k')
    expect(bucketPendingLines(1000)).toBe('1k+')
  })
})

describe('countPendingOutputLines', () => {
  test('multi-line events + carry adds 1; empty → 0', () => {
    expect(
      countPendingOutputLines({
        eventsAfterCursor: [],
      }),
    ).toBe(0)

    expect(
      countPendingOutputLines({
        eventsAfterCursor: [
          { payload: { type: 'output', data: 'a\nb\n' } },
          { payload: { type: 'lifecycle', data: 'ignored' } },
          { payload: { type: 'output', data: 'c\n' } },
        ],
      }),
    ).toBe(3)

    expect(
      countPendingOutputLines({
        eventsAfterCursor: [{ payload: { type: 'output', data: 'a\nb\n' } }],
        lineCarry: 'partial',
      }),
    ).toBe(3)

    expect(
      countPendingOutputLines({
        eventsAfterCursor: [],
        lineCarry: '',
      }),
    ).toBe(0)
  })
})

describe('selectListJobsRows', () => {
  test('caps at 10, prefers running over completed, truncatedCount', () => {
    const rows: ListJobsViewRow[] = []
    for (let i = 0; i < 8; i++) {
      rows.push(
        row({
          jobId: `done-${i}`,
          status: 'completed',
          startedAt: 1000 + i,
        }),
      )
    }
    for (let i = 0; i < 5; i++) {
      rows.push(
        row({
          jobId: `run-${i}`,
          status: 'running',
          startedAt: 2000 + i,
        }),
      )
    }

    const selected = selectListJobsRows(rows)
    expect(selected.rows).toHaveLength(LIST_JOBS_MAX_ROWS)
    expect(selected.truncatedCount).toBe(3)
    expect(selected.rows.slice(0, 5).every((r) => r.status === 'running')).toBe(
      true,
    )
    expect(selected.rows[0].jobId).toBe('run-4')
  })
})

describe('fingerprintListJobsRows', () => {
  test('stable for same rows different order; changes when pending changes', () => {
    const a = row({ jobId: 'a', pending: 'none', status: 'running' })
    const b = row({ jobId: 'b', pending: '<10', status: 'completed' })
    expect(fingerprintListJobsRows([a, b])).toBe(fingerprintListJobsRows([b, a]))

    const changed = row({ ...a, pending: '<10' })
    expect(fingerprintListJobsRows([changed, b])).not.toBe(
      fingerprintListJobsRows([a, b]),
    )
  })
})

describe('buildListJobsValue', () => {
  test('always includes note line', () => {
    const value = buildListJobsValue({ rows: [] })
    expect(value.note).toBe(LIST_JOBS_NO_ACTION_LINE)
    expect(value.jobs).toEqual([])
    expect(value.truncatedCount).toBeUndefined()

    const many = Array.from({ length: 12 }, (_, i) =>
      row({ jobId: `j-${i}`, startedAt: i }),
    )
    const capped = buildListJobsValue({ rows: many })
    expect(capped.note).toBe(LIST_JOBS_NO_ACTION_LINE)
    expect(capped.jobs).toHaveLength(LIST_JOBS_MAX_ROWS)
    expect(capped.truncatedCount).toBe(2)
  })
})
