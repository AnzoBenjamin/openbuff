import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { compareBuffbenchRuns } from '../compare-buffbench-runs'

function withAttempts(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
  check: (beforeDir: string, afterDir: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'buffbench-comparison-'))
  try {
    for (const [side, attempts] of [
      ['before', before],
      ['after', after],
    ] as const) {
      const directory = join(root, side)
      mkdirSync(directory)
      attempts.forEach((extra, repeat) => {
        writeFileSync(
          join(directory, `ANALYSIS-${repeat}.json`),
          JSON.stringify({
            commitSha: 'fixed',
            results: [
              {
                agentId: 'fixture',
                taskId: 'fixed',
                repeat,
                languages: ['typescript'],
                providerRoute: 'offline',
                experimentId: 'fixed',
                workloadHash: 'fixed',
                measurementConfigHash: 'fixed',
                evaluatorVersion: 'fixed',
                overallScore: 8,
                cost: 1,
                durationMs: 1,
                scoringStatus: 'scored',
                costEvidence: { status: 'reported' },
                ...extra,
              },
            ],
          }),
          { flag: 'wx' },
        )
      })
    }
    check(join(root, 'before'), join(root, 'after'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('compareBuffbenchRuns measured populations and monetary totals', () => {
  test.each([{}, { error: undefined }, { error: null }])(
    'preserves healthy legacy/error compatibility: %j',
    (extra) => {
      const attempts = [{ ...extra, overallScore: 0 }, extra]
      withAttempts(attempts, attempts, (before, after) => {
        const result = compareBuffbenchRuns(before, after)
        expect(result.results[0]).toMatchObject({
          pairCount: 2,
          averageBefore: 4,
          averageAfter: 4,
        })
        expect(result.populations.before).toEqual({
          attempts: 2,
          eligibleScores: 2,
          totalCost: 2,
          unknownCostAttempts: 0,
        })
        expect(result.populations.after).toEqual(result.populations.before)
      })
    },
  )

  test('excludes empty-error scores from pairs while retaining paid attempts', () => {
    const attempts = [
      { overallScore: 0 },
      {},
      { error: '', cost: 3 },
      { error: '', cost: 3, costEvidence: { status: 'unknown' } },
    ]
    withAttempts(attempts, attempts, (before, after) => {
      const result = compareBuffbenchRuns(before, after)
      expect(result.results[0]).toMatchObject({
        pairCount: 2,
        averageBefore: 4,
        averageAfter: 4,
      })
      expect(result.populations.before).toEqual({
        attempts: 4,
        eligibleScores: 2,
        totalCost: 8,
        unknownCostAttempts: 1,
      })
      expect(result.populations.after).toEqual(result.populations.before)
      expect(result.attempts.before).toHaveLength(4)
      expect(result.attempts.after).toHaveLength(4)
    })
  })

  test('rejects comparisons without eligible pairs', () => {
    const attempts = [{ error: '' }, { error: '' }]
    withAttempts(attempts, attempts, (before, after) => {
      expect(() => compareBuffbenchRuns(before, after)).toThrow(
        'Insufficient eligible paired evidence',
      )
    })
  })

  test.each(['before', 'after', 'both'])(
    'rejects finite-input monetary overflow on %s',
    (side) => {
      const overflow = [{ cost: Number.MAX_VALUE }, { cost: Number.MAX_VALUE }]
      const healthy = [{}, {}]
      withAttempts(
        side === 'after' ? healthy : overflow,
        side === 'before' ? healthy : overflow,
        (before, after) => {
          expect(() => compareBuffbenchRuns(before, after)).toThrow(
            /Aggregate monetary cost must be finite/,
          )
        },
      )
    },
  )
})
