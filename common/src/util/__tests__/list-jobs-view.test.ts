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
    expect(fingerprintListJobsRows([a, b])).toBe(
      fingerprintListJobsRows([b, a]),
    )

    const changed = row({ ...a, pending: '<10' })
    expect(fingerprintListJobsRows([changed, b])).not.toBe(
      fingerprintListJobsRows([a, b]),
    )
  })

  test('changes when exitCode changes; null/undefined normalize the same', () => {
    const settled = row({ jobId: 'a', status: 'completed', completedAt: 2 })
    const exitZero = row({ ...settled, exitCode: 0 })
    const exitOne = row({ ...settled, exitCode: 1 })
    expect(fingerprintListJobsRows([exitZero])).not.toBe(
      fingerprintListJobsRows([exitOne]),
    )
    expect(fingerprintListJobsRows([exitZero])).not.toBe(
      fingerprintListJobsRows([settled]),
    )
    // `?? ''` normalization: null and undefined fingerprint identically.
    expect(fingerprintListJobsRows([row({ ...settled, exitCode: null })])).toBe(
      fingerprintListJobsRows([settled]),
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

  test('explicit truncatedCount emits rows as-is (no re-select, re-sort, or re-cap)', () => {
    // startedAt ascending: a re-selection would sort descending and cap at
    // LIST_JOBS_MAX_ROWS, so preserved order + full length prove pass-through.
    const many = Array.from({ length: 12 }, (_, i) =>
      row({ jobId: `j-${i}`, startedAt: i }),
    )

    const value = buildListJobsValue({ rows: many, truncatedCount: 2 })
    expect(value.jobs).toHaveLength(many.length)
    expect(value.jobs.map((r) => r.jobId)).toEqual(many.map((r) => r.jobId))
    expect(value.truncatedCount).toBe(2)
    expect(value.note).toBe(LIST_JOBS_NO_ACTION_LINE)

    // Contrast: without truncatedCount the same rows are re-selected and capped.
    const capped = buildListJobsValue({ rows: many })
    expect(capped.jobs).toHaveLength(LIST_JOBS_MAX_ROWS)
    expect(capped.jobs[0].jobId).toBe('j-11')
    expect(capped.truncatedCount).toBe(2)
  })

  test('explicit truncatedCount: 0 is honored (not treated as absent)', () => {
    // The pass-through guard is `truncatedCount !== undefined`, so a falsy
    // zero must still skip re-selection; an `||`/truthiness regression would
    // re-sort and re-cap these rows.
    const many = Array.from({ length: 12 }, (_, i) =>
      row({ jobId: `j-${i}`, startedAt: i }),
    )

    const value = buildListJobsValue({ rows: many, truncatedCount: 0 })
    expect(value.jobs).toHaveLength(many.length)
    expect(value.jobs.map((r) => r.jobId)).toEqual(many.map((r) => r.jobId))
    // Zero truncation means the field is omitted from the value, but the
    // rows were still passed through untouched.
    expect(value.truncatedCount).toBeUndefined()
    expect(value.note).toBe(LIST_JOBS_NO_ACTION_LINE)
  })
})
