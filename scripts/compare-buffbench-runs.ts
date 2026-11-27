#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isMeasuredScoreEligible,
  mean,
  sumFiniteCosts,
  pairedBootstrapMeanDiffCI,
  wilcoxonSignedRankTest,
} from '../evals/buffbench/statistics'

interface Attempt {
  agentId: string
  commitSha: string
  taskId?: string
  repeat?: number
  languages?: string[]
  providerRoute?: string
  experimentId?: string
  workloadHash?: string
  measurementConfigHash?: string
  evaluatorVersion?: string
  overallScore: number
  cost: number
  durationMs: number
  error?: string | null
  scoringStatus?: string
  runOutcome?: { termination: string }
  costEvidence?: { status: string }
}

function loadAttempts(directory: string): Attempt[] {
  return readdirSync(directory)
    .filter((file) => file.includes('ANALYSIS') && file.endsWith('.json'))
    .sort()
    .flatMap((file) => {
      const analysis = JSON.parse(readFileSync(join(directory, file), 'utf8'))
      if (
        !analysis ||
        !Array.isArray(analysis.results) ||
        typeof analysis.commitSha !== 'string'
      )
        throw new Error(`Invalid analysis artifact ${file}`)
      return analysis.results.map((result: Attempt) => {
        const attempt: Attempt = {
          ...analysis,
          ...result,
          commitSha: analysis.commitSha,
        }
        if (
          attempt.runOutcome !== undefined &&
          (!attempt.runOutcome ||
            ![
              'completed',
              'failed',
              'cancelled',
              'budget_exhausted',
              'step_exhausted',
              'deadline_exhausted',
              'resource_failure',
              'cleanup_failure',
            ].includes(attempt.runOutcome.termination))
        )
          throw new Error(`Invalid typed run outcome in ${file}`)
        if (
          [
            attempt.taskId,
            attempt.providerRoute,
            attempt.experimentId,
            attempt.workloadHash,
            attempt.measurementConfigHash,
            attempt.evaluatorVersion,
          ].some((value) => value !== undefined && typeof value !== 'string')
        )
          throw new Error(`Invalid attempt identity in ${file}`)
        if (
          typeof attempt.agentId !== 'string' ||
          !attempt.agentId ||
          !Number.isFinite(attempt.overallScore) ||
          attempt.overallScore < 0 ||
          attempt.overallScore > 10 ||
          !Number.isFinite(attempt.cost) ||
          attempt.cost < 0 ||
          !Number.isFinite(attempt.durationMs) ||
          attempt.durationMs < 0 ||
          (attempt.repeat !== undefined &&
            (!Number.isSafeInteger(attempt.repeat) || attempt.repeat < 0)) ||
          (attempt.languages !== undefined &&
            (!Array.isArray(attempt.languages) ||
              attempt.languages.some(
                (language) => typeof language !== 'string',
              )))
        ) {
          throw new Error(`Invalid or nonfinite attempt evidence in ${file}`)
        }
        return attempt
      })
    })
}

function pairKey(attempt: Attempt): string {
  // Unreported legacy strata stay visible. Duplicate legacy repeats are refused.
  return JSON.stringify([
    attempt.commitSha,
    attempt.taskId ?? '',
    attempt.agentId,
    attempt.repeat ?? 0,
    [...(attempt.languages ?? [])].sort(),
    attempt.providerRoute ?? 'unreported',
    attempt.experimentId ?? 'unreported',
    attempt.workloadHash ?? 'unreported',
    attempt.measurementConfigHash ?? 'unreported',
    attempt.evaluatorVersion ?? 'unreported',
  ])
}

function indexAttempts(attempts: Attempt[]): Map<string, Attempt> {
  const index = new Map<string, Attempt>()
  for (const attempt of attempts) {
    const key = pairKey(attempt)
    if (index.has(key))
      throw new Error(
        'Duplicate or ambiguous task/repeat identity; comparison refuses overwritten repeats',
      )
    index.set(key, attempt)
  }
  return index
}

export function compareBuffbenchRuns(beforeDir: string, afterDir: string) {
  const beforeAttempts = loadAttempts(beforeDir)
  const afterAttempts = loadAttempts(afterDir)
  const before = indexAttempts(beforeAttempts)
  const after = indexAttempts(afterAttempts)
  if (
    before.size !== after.size ||
    [...before.keys()].some((key) => !after.has(key))
  ) {
    throw new Error(
      'Incomparable workload/repeat/language/provider/experiment populations',
    )
  }
  const pairsByAgent = new Map<string, { before: number; after: number }[]>()
  for (const [key, previous] of before) {
    const next = after.get(key)!
    if (!isMeasuredScoreEligible(previous) || !isMeasuredScoreEligible(next))
      continue
    const pairs = pairsByAgent.get(previous.agentId) ?? []
    pairs.push({ before: previous.overallScore, after: next.overallScore })
    pairsByAgent.set(previous.agentId, pairs)
  }
  const population = (attempts: Attempt[]) => ({
    attempts: attempts.length,
    eligibleScores: attempts.filter(isMeasuredScoreEligible).length,
    totalCost: sumFiniteCosts(attempts.map((attempt) => attempt.cost)),
    unknownCostAttempts: attempts.filter(
      (attempt) => attempt.costEvidence?.status !== 'reported',
    ).length,
  })
  const populations = {
    before: population(beforeAttempts),
    after: population(afterAttempts),
  }
  console.log(`Complete attempt populations: ${JSON.stringify(populations)}`)
  const results = [...pairsByAgent].map(([agentId, pairs]) => {
    if (pairs.length < 2)
      throw new Error(`Insufficient paired evidence for ${agentId}`)
    const ci = pairedBootstrapMeanDiffCI(pairs)
    const wilcoxon = wilcoxonSignedRankTest(pairs)
    const averageBefore = mean(pairs.map((pair) => pair.before))
    const averageAfter = mean(pairs.map((pair) => pair.after))
    console.log(
      `${agentId}: Overall Score: ${averageBefore.toFixed(2)} → ${averageAfter.toFixed(2)} (${ci.meanDiff.toFixed(2)}); paired repeats=${pairs.length}`,
    )
    console.log(
      `  Significance: ${wilcoxon.applicable ? `p=${wilcoxon.pValueTwoSided.toFixed(4)}` : `rejected (${wilcoxon.reason})`}`,
    )
    return {
      agentId,
      pairCount: pairs.length,
      averageBefore,
      averageAfter,
      ci,
      wilcoxon,
    }
  })
  if (results.length === 0)
    throw new Error('Insufficient eligible paired evidence')
  return {
    populations,
    results,
    attempts: { before: beforeAttempts, after: afterAttempts },
  }
}

if (import.meta.main) {
  if (process.argv.includes('--help') || !process.argv[2] || !process.argv[3]) {
    console.log(
      'Usage: bun scripts/compare-buffbench-runs.ts <log-dir-before> <log-dir-after>',
    )
  } else {
    try {
      compareBuffbenchRuns(process.argv[2], process.argv[3])
    } catch (error) {
      console.error(
        `Comparison rejected: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exitCode = 1
    }
  }
}
