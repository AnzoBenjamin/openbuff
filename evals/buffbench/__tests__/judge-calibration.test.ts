import { expect, describe, test } from 'bun:test'
import fs from 'fs'
import path from 'path'

import { evaluateCalibration } from '../judge-calibration'
import { judgeCommitResult } from '../judge'

import type { CalibrationCase, CalibrationResult } from '../judge-calibration'
import type { OpenbuffClient } from '@openbuff/sdk'
import type { EvalCommitV2 } from '../types'

interface GoldSetFile {
  comment: string
  cases: Array<
    CalibrationCase & {
      recordedJudgeOverallScore: number
      /**
       * Optional final-check outputs the case replays through the runner so a
       * broken-build case can exercise the deterministic clamp path too.
       */
      finalCheckOutputs?: Array<{
        command: string
        exitCode: number
        stdout: string
        stderr: string
      }>
    }
  >
}

const CALIBRATION_THRESHOLD = 0.75

const goldSet: GoldSetFile = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'judge-gold-set.json'),
    'utf8',
  ),
) as GoldSetFile

function makeCommit(calibrationCase: GoldSetFile['cases'][0]): EvalCommitV2 {
  return {
    id: calibrationCase.id,
    sha: 'abc123',
    parentSha: 'def456',
    spec: calibrationCase.taskSpec,
    prompt: calibrationCase.taskPrompt,
    supplementalFiles: [],
    fileDiffs: [],
  }
}

/**
 * Fake OpenbuffClient (DI, no module mocking, no network): replays the
 * recorded structured judge outputs from the gold set back through
 * judgeCommitResult, exactly in the style of the existing judgeCommitResult
 * tests. Each judgeCommitResult call consumes two judge outputs (judge-gpt,
 * judge-gemini), so the queue shifts twice per case.
 */
function makeReplayClient(
  queue: Array<GoldSetFile['cases'][0]['recordedJudgeOverallScore']>,
): OpenbuffClient {
  return {
    run: async () => {
      const score = queue.shift()
      if (score === undefined) {
        throw new Error('fake judge queue exhausted — fixture/case mismatch')
      }
      return {
        output: {
          type: 'structuredOutput' as const,
          value: {
            analysis: `recorded judge analysis for score ${score}`,
            strengths: [],
            weaknesses: [],
            completionScore: score,
            codeQualityScore: score,
            overallScore: score,
          },
        },
      }
    },
  } as unknown as OpenbuffClient
}

describe('evaluateCalibration (pure helper)', () => {
  test('agrees when every actual score falls inside its expected range', () => {
    const cases: CalibrationCase[] = [
      {
        id: 'a',
        taskPrompt: 'p',
        taskSpec: 's',
        agentDiff: 'd',
        expectedRange: { min: 7, max: 10 },
      },
      {
        id: 'b',
        taskPrompt: 'p',
        taskSpec: 's',
        agentDiff: 'd',
        expectedRange: { min: 0, max: 3 },
      },
    ]
    const result = evaluateCalibration(
      cases,
      [{ overallScore: 8 }, { overallScore: 2 }],
      CALIBRATION_THRESHOLD,
    )

    expect(result.agreementRate).toBe(1)
    expect(result.threshold).toBe(CALIBRATION_THRESHOLD)
    expect(result.passes).toBe(true)
    expect(result.perCase.map((entry) => entry.agree)).toEqual([true, true])
  })

  test('disagrees when a score lands outside its expected range', () => {
    const cases: CalibrationCase[] = [
      {
        id: 'a',
        taskPrompt: 'p',
        taskSpec: 's',
        agentDiff: 'd',
        expectedRange: { min: 7, max: 10 },
      },
    ]
    const result = evaluateCalibration(
      cases,
      [{ overallScore: 3 }],
      CALIBRATION_THRESHOLD,
    )

    expect(result.agreementRate).toBe(0)
    expect(result.passes).toBe(false)
  })

  test('boundary scores count as agreement (inclusive min/max)', () => {
    const cases: CalibrationCase[] = [
      {
        id: 'a',
        taskPrompt: 'p',
        taskSpec: 's',
        agentDiff: 'd',
        expectedRange: { min: 3, max: 6 },
      },
    ]
    const atBounds = evaluateCalibration(cases, [{ overallScore: 3 }])
    expect(atBounds.perCase[0]?.agree).toBe(true)

    const atUpper = evaluateCalibration(cases, [{ overallScore: 6 }])
    expect(atUpper.perCase[0]?.agree).toBe(true)
  })

  test('throws on mismatched case/measurement counts instead of truncating', () => {
    const cases: CalibrationCase[] = [
      {
        id: 'a',
        taskPrompt: 'p',
        taskSpec: 's',
        agentDiff: 'd',
        expectedRange: { min: 0, max: 10 },
      },
      {
        id: 'b',
        taskPrompt: 'p',
        taskSpec: 's',
        agentDiff: 'd',
        expectedRange: { min: 0, max: 10 },
      },
    ]
    expect(() => evaluateCalibration(cases, [{ overallScore: 5 }])).toThrow(
      /expected 2 measurement\(s\)/,
    )
  })
})

describe('judge gold-set calibration', () => {
  test('gold-set fixture is well-formed and uses in-repo diffs only', () => {
    expect(goldSet.cases.length).toBeGreaterThanOrEqual(3)
    for (const calibrationCase of goldSet.cases) {
      expect(calibrationCase.id).toBeTruthy()
      expect(calibrationCase.taskPrompt).toBeTruthy()
      expect(calibrationCase.taskSpec).toBeTruthy()
      expect(calibrationCase.agentDiff).toContain('diff --git')
      expect(calibrationCase.expectedRange.min).toBeLessThanOrEqual(
        calibrationCase.expectedRange.max,
      )
      // R3 non-goal: no network-backed evals in the gold set.
      expect(JSON.stringify(calibrationCase)).not.toContain('repoUrl')
      expect(typeof calibrationCase.recordedJudgeOverallScore).toBe('number')
    }
  })

  test('recorded judge outputs over the gold set meet the agreement threshold', async () => {
    // Deterministic replay: for each case, feed judgeCommitResult two judges
    // (the run of record) with the recorded overall score. With 2 judges the
    // lower median narrative is the first (lower) judge — but only the averaged
    // scores are asserted by the calibration, and the average of two identical
    // scores is the score itself.
    const measured: Array<{ overallScore: number }> = []
    for (const calibrationCase of goldSet.cases) {
      const client = makeReplayClient([
        calibrationCase.recordedJudgeOverallScore,
        calibrationCase.recordedJudgeOverallScore,
      ])
      const result = await judgeCommitResult({
        client,
        commit: makeCommit(calibrationCase),
        contextFiles: {},
        agentDiff: calibrationCase.agentDiff,
        finalCheckOutputsStructured: calibrationCase.finalCheckOutputs?.map(
          (output) => ({ ...output }),
        ),
      })
      measured.push({ overallScore: result.overallScore })
    }

    const calibration: CalibrationResult = evaluateCalibration(
      goldSet.cases,
      measured,
      CALIBRATION_THRESHOLD,
    )

    expect(calibration.passes).toBe(true)
    expect(calibration.agreementRate).toBeGreaterThanOrEqual(
      CALIBRATION_THRESHOLD,
    )
  })

  test('the broken-build gold case exercises the deterministic clamp end-to-end', async () => {
    const brokenBuildCase = goldSet.cases.find(
      (calibrationCase) => calibrationCase.id === 'gold-broken-build',
    )
    if (!brokenBuildCase?.finalCheckOutputs) {
      throw new Error('gold-broken-build case must carry finalCheckOutputs')
    }

    const client = makeReplayClient([
      9,
      9, // an over-lenient judge: only the clamp brings the score into range
    ])
    const result = await judgeCommitResult({
      client,
      commit: makeCommit(brokenBuildCase),
      contextFiles: {},
      agentDiff: brokenBuildCase.agentDiff,
      finalCheckOutputsStructured: brokenBuildCase.finalCheckOutputs.map(
        (output) => ({ ...output }),
      ),
    })

    expect(result.overallScore).toBe(3)
    expect(result.scoringStatus).toBe('scored')
  })
})
