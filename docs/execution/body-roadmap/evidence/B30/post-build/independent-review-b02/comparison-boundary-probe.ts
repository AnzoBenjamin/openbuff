import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repository = path.resolve(import.meta.dirname, '../../../../../../..')
const { compareBuffbenchRuns } = await import(
  path.join(repository, 'scripts/compare-buffbench-runs.ts')
)
const { isMeasuredScoreEligible } = await import(
  path.join(repository, 'evals/buffbench/statistics.ts')
)
const { summarizeAgentRuns } = await import(
  path.join(repository, 'evals/buffbench/run-buffbench.ts')
)

const root = path.join(import.meta.dirname, 'comparison-boundary-fixtures')
fs.mkdirSync(root, { recursive: true })
const observations: Record<string, unknown>[] = []
for (const [name, extra, accepted] of [
  ['healthy', {}, true],
  ['explicit-empty-error', { error: '' }, false],
  ['finite-cost-aggregate-overflow', { cost: Number.MAX_VALUE }, false],
] as const) {
  const before = path.join(root, name, 'before')
  const after = path.join(root, name, 'after')
  for (const directory of [before, after]) {
    fs.mkdirSync(directory, { recursive: true })
    for (let repeat = 0; repeat < 2; repeat++) {
      fs.writeFileSync(
        path.join(directory, `ANALYSIS-${repeat}.json`),
        JSON.stringify({
          commitSha: 'fixed',
          results: [{
            agentId: 'fixture', taskId: 'fixed', repeat,
            languages: ['typescript'], providerRoute: 'offline',
            experimentId: 'fixed', workloadHash: 'fixed',
            measurementConfigHash: 'fixed', evaluatorVersion: 'fixed',
            overallScore: 8, cost: 1, durationMs: 1,
            scoringStatus: 'scored', costEvidence: { status: 'reported' },
            ...extra,
          }],
        }),
        { flag: 'wx' },
      )
    }
  }
  let actualAccepted = false
  let result: ReturnType<typeof compareBuffbenchRuns> | undefined
  let failure: string | undefined
  try {
    result = compareBuffbenchRuns(before, after)
    actualAccepted = true
  } catch (error) {
    failure = String(error)
  }
  assert.equal(actualAccepted, accepted, name)
  if (result) {
    assert.equal(result.results.length, 1)
    assert.equal(result.populations.before.attempts, 2)
    assert.equal(result.populations.before.eligibleScores, 2)
    assert.equal(result.populations.before.totalCost, 2)
    assert.equal(result.populations.after.totalCost, 2)
    assert(Number.isFinite(result.populations.before.totalCost))
    assert(Number.isFinite(result.populations.after.totalCost))
  }
  observations.push({ name, accepted: actualAccepted, populations: result?.populations, error: failure })
}

assert.equal(isMeasuredScoreEligible({ error: '', overallScore: 8 }), false)
assert.equal(isMeasuredScoreEligible({ overallScore: 8 }), true)
assert.equal(isMeasuredScoreEligible({ overallScore: 0 }), true)
const judged = {
  agentId: 'fixture', cost: 1, durationMs: 1,
  judging: { overallScore: 8, completionScore: 8, codeQualityScore: 8 },
}
const summaryRows = [
  { ...judged },
  { ...judged, error: '' },
  { ...judged, judging: { ...judged.judging, scoringStatus: 'all_judges_failed' } },
]
const summary = summarizeAgentRuns({ runs: summaryRows } as any)
assert.equal(summary.validRuns.length, 2)
assert.equal(summary.runsExcludingFailures.length, 2)
assert.equal(summary.measuredRuns.length, 1)
assert.equal(summaryRows.length, 3)
assert.equal(summaryRows[1].error, '')
observations.push({
  name: 'direct-eligibility-and-summary',
  emptyErrorEligible: false, zeroScoreEligible: true,
  attempted: 3, valid: 2, measured: 1,
  intentionalAllJudgesFailedSummaryRetained: true,
  rawEmptyErrorRetained: true,
})
fs.writeFileSync(
  path.join(import.meta.dirname, 'comparison-boundary-probe.json'),
  JSON.stringify({ allPassed: true, observations, scope: 'Independent healthy and empty-error/finite-overflow source consumer controls; no model/provider/empirical claim.' }, null, 2) + '\n',
  { flag: 'wx' },
)
console.log(JSON.stringify(observations, null, 2))
