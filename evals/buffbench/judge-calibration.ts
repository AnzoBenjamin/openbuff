/**
 * M5-T7-R3: Gold-set judge calibration.
 *
 * A calibration harness that runs the judge pipeline over a small pinned
 * in-repo gold set (`__tests__/fixtures/judge-gold-set.json`) and asserts the
 * judge's scores agree with per-case expected ranges. Judge quality is thereby
 * measured in CI; a judge-prompt or model drift that degrades agreement fails
 * loudly instead of silently.
 *
 * `evaluateCalibration` is a pure aggregation helper (no I/O) so it is
 * trivially unit-testable and reusable over any score source. The test wiring
 * uses a fake OpenbuffClient (DI, same style as the judgeCommitResult tests);
 * there is no network access and no module mocking anywhere in this flow.
 */

/** One pinned gold-set case with the score range a correct judge should emit. */
export interface CalibrationCase {
  id: string
  taskPrompt: string
  taskSpec: string
  agentDiff: string
  expectedRange: { min: number; max: number }
}

/** Minimal per-case judge measurement this helper consumes. */
export interface CalibrationMeasurement {
  overallScore: number
}

export interface CalibrationCaseResult {
  id: string
  expected: [number, number]
  actual: number
  agree: boolean
}

export interface CalibrationResult {
  perCase: CalibrationCaseResult[]
  /** Fraction of cases where the judge's score fell inside the expected range. */
  agreementRate: number
  /** Minimum agreementRate for the calibration to pass. */
  threshold: number
  passes: boolean
}

/**
 * Compare judge measurements against per-case expected ranges.
 *
 * Pure: no I/O, no side effects. `cases` and `results` must be parallel arrays
 * (results[i] is the judge measurement for cases[i]); mismatched lengths throw
 * rather than silently truncating the comparison.
 */
export function evaluateCalibration(
  cases: readonly CalibrationCase[],
  results: readonly CalibrationMeasurement[],
  threshold = 0.75,
): CalibrationResult {
  if (results.length !== cases.length) {
    throw new Error(
      `evaluateCalibration: expected ${cases.length} measurement(s) for ${cases.length} case(s), got ${results.length}`,
    )
  }

  const perCase: CalibrationCaseResult[] = cases.map((calibrationCase, i) => {
    const measurement = results[i]
    if (!measurement) {
      throw new Error(
        `evaluateCalibration: missing measurement for case ${calibrationCase.id}`,
      )
    }
    const actual = measurement.overallScore
    const { min, max } = calibrationCase.expectedRange
    return {
      id: calibrationCase.id,
      expected: [min, max],
      actual,
      agree: actual >= min && actual <= max,
    }
  })

  const agreementRate =
    perCase.length === 0
      ? 1
      : perCase.filter((entry) => entry.agree).length / perCase.length

  return {
    perCase,
    agreementRate,
    threshold,
    passes: agreementRate >= threshold,
  }
}
