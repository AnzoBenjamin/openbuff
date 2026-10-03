/**
 * Smoke test for the fixed-baseline perf benchmark runner.
 *
 * The script's defaults (5 runs × per-case iteration counts) are a real
 * measurement baseline and far too slow for CI, so runPerfGuardsBaseline is
 * driven here with 1 timed run, 0 warmups, and every case scaled to a single
 * timed op. The assertion is behavioral, not numeric: the full case list
 * (CASE 1-9, including the X-2 token-count / code-search / X-2a hot-path /
 * stream-parse rows) completes without throwing and returns measured rows.
 */
import { describe, expect, test } from 'bun:test'

import {
  runPerfGuardsBaseline,
} from '../measure-perf-guards-baseline'

describe('measure-perf-guards-baseline runner smoke', () => {
  test('completes every case and returns measured rows', async () => {
    const rows = await runPerfGuardsBaseline({
      runs: 1,
      warmups: 0,
      // Collapse every case to a single timed op (measure() floors the
      // scaled iteration count at 1).
      iterationsScale: 0.01,
    })

    expect(Array.isArray(rows)).toBe(true)
    // Cases 1-5 each push at least one CaseRow (CASE 1, 2, 3, 3c, 3d, 4,
    // 4d, 5); the X-2 cases (6-9) print absolute rows without pushing.
    expect(rows.length).toBeGreaterThanOrEqual(8)
    const cases = new Set(rows.map((row) => row.case))
    for (const expected of ['CASE 1', 'CASE 2', 'CASE 3', 'CASE 4', 'CASE 5']) {
      expect(cases.has(expected)).toBe(true)
    }
    for (const row of rows) {
      expect(row.before.medianMsPerOp).toBeGreaterThan(0)
      expect(row.after.medianMsPerOp).toBeGreaterThan(0)
    }
  })
})
