#!/usr/bin/env bun
/**
 * N10 eval regression gate.
 *
 * Compares a buffbench FINAL_RESULTS.json against the last green run's
 * FINAL_RESULTS.json (via compare-runs.ts) and exits non-zero when any agent
 * regresses past the noise band. Used by the nightly and the PR subset
 * workflows.
 *
 * Usage:
 *   bun buffbench/regression-gate.ts --current <file|dir> [--baseline <file|dir>]
 *     [--report <out.md>] [--score-band 0.5] [--error-band 1]
 *     [--edit-commit-band 0.1] [--tool-error-band 0.1] [--prompt-token-band 0.1]
 *
 * Exit codes: 0 pass (or no baseline yet), 1 regression, 2 bad input.
 */
import fs from 'fs'
import path from 'path'

import { compareRuns, formatComparisonReport } from './compare-runs'
import { formatQualityMetricsTable } from './quality-metrics'

import type { ComparisonResult } from './compare-runs'
import type { AgentEvalResults } from './types'

export interface NoiseBand {
  /** Average score drop (0-10 scale) tolerated as noise. */
  scoreDrop: number
  /** Extra errored runs tolerated as noise. */
  errorRunIncrease: number
  /** Absolute edit-commit rate drop tolerated (0.1 = 10 points). */
  editCommitRateDrop: number
  /** Absolute tool error rate increase tolerated. */
  toolErrorRateIncrease: number
  /** Relative static prompt token growth tolerated (0.1 = +10%). */
  staticPromptTokenGrowth: number
}

/**
 * Default band for the small, cheap subsets the gate runs on (2-8 tasks,
 * one attempt each): judge scores on a single attempt move by roughly half a
 * point between identical runs, so smaller drops are not treated as signal.
 */
export const DEFAULT_NOISE_BAND: NoiseBand = {
  scoreDrop: 0.5,
  errorRunIncrease: 1,
  editCommitRateDrop: 0.1,
  toolErrorRateIncrease: 0.1,
  staticPromptTokenGrowth: 0.1,
}

export interface ResultsFile {
  metadata?: { workloadHash?: string; timestamp?: string; runId?: string }
  agents: Record<string, AgentEvalResults>
}

export interface GateResult {
  regressed: boolean
  reasons: string[]
  warnings: string[]
  comparison?: ComparisonResult
}

/** Accept the current `{ agents }` shape and the legacy top-level shape. */
export function parseResultsFile(raw: unknown): ResultsFile {
  if (!raw || typeof raw !== 'object') {
    throw new Error('results file is not a JSON object')
  }
  const record = raw as Record<string, unknown>
  const candidate =
    record.agents && typeof record.agents === 'object'
      ? (record.agents as Record<string, unknown>)
      : Object.fromEntries(
          Object.entries(record).filter(
            ([key]) => key !== 'metadata' && key !== 'metaAnalysis',
          ),
        )
  const agents: Record<string, AgentEvalResults> = {}
  for (const [agentId, value] of Object.entries(candidate)) {
    const result = value as Partial<AgentEvalResults> | null
    if (
      result &&
      typeof result === 'object' &&
      Array.isArray(result.runs) &&
      typeof result.averageScore === 'number'
    ) {
      agents[agentId] = { ...(result as AgentEvalResults), agentId }
    }
  }
  return {
    metadata: record.metadata as ResultsFile['metadata'],
    agents,
  }
}

function errorCount(result: AgentEvalResults): number {
  return result.runs.filter((run) => run.error).length
}

function fmt(value: number, digits = 2): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`
}

export function evaluateRegressionGate(
  baseline: ResultsFile,
  current: ResultsFile,
  band: NoiseBand = DEFAULT_NOISE_BAND,
): GateResult {
  const reasons: string[] = []
  const warnings: string[] = []
  const currentAgents = Object.values(current.agents)
  if (
    currentAgents.length === 0 ||
    currentAgents.every((a) => a.runs.length === 0)
  ) {
    return {
      regressed: true,
      reasons: ['current run has no agent runs'],
      warnings,
    }
  }
  if (
    baseline.metadata?.workloadHash &&
    current.metadata?.workloadHash &&
    baseline.metadata.workloadHash !== current.metadata.workloadHash
  ) {
    warnings.push(
      'baseline and current ran different task sets (workloadHash differs); deltas mix workload and agent changes',
    )
  }

  const comparison = compareRuns(
    Object.values(baseline.agents),
    currentAgents,
    { scoreNoise: band.scoreDrop, errorNoise: band.errorRunIncrease },
  )

  for (const [agentId, before] of Object.entries(baseline.agents)) {
    const after = current.agents[agentId]
    if (!after) {
      reasons.push(`${agentId}: missing from the current run`)
      continue
    }
    const measured =
      after.measuredRunCount ?? after.runs.length - errorCount(after)
    if (after.runs.length > 0 && measured === 0) {
      reasons.push(
        `${agentId}: no measured runs (${after.runs.length} errored)`,
      )
      continue
    }
    const scoreDelta = after.averageScore - before.averageScore
    if (scoreDelta < -band.scoreDrop) {
      reasons.push(
        `${agentId}: score ${before.averageScore.toFixed(2)} → ${after.averageScore.toFixed(2)} (${fmt(scoreDelta)}, band -${band.scoreDrop})`,
      )
    }
    const errorDelta = errorCount(after) - errorCount(before)
    if (errorDelta > band.errorRunIncrease) {
      reasons.push(
        `${agentId}: errored runs ${errorCount(before)} → ${errorCount(after)} (band +${band.errorRunIncrease})`,
      )
    }
    const qb = before.qualityMetrics
    const qa = after.qualityMetrics
    if (qb?.editCommitRate !== undefined && qa?.editCommitRate !== undefined) {
      const delta = qa.editCommitRate - qb.editCommitRate
      if (delta < -band.editCommitRateDrop) {
        reasons.push(
          `${agentId}: edit-commit rate ${(qb.editCommitRate * 100).toFixed(1)}% → ${(qa.editCommitRate * 100).toFixed(1)}% (band -${band.editCommitRateDrop * 100} pts)`,
        )
      }
    }
    if (qb?.toolErrorRate !== undefined && qa?.toolErrorRate !== undefined) {
      const delta = qa.toolErrorRate - qb.toolErrorRate
      if (delta > band.toolErrorRateIncrease) {
        reasons.push(
          `${agentId}: tool error rate ${(qb.toolErrorRate * 100).toFixed(1)}% → ${(qa.toolErrorRate * 100).toFixed(1)}% (band +${band.toolErrorRateIncrease * 100} pts)`,
        )
      }
    }
    if (
      qb?.staticPromptTokens !== undefined &&
      qa?.staticPromptTokens !== undefined &&
      qb.staticPromptTokens > 0
    ) {
      const growth = qa.staticPromptTokens / qb.staticPromptTokens - 1
      if (growth > band.staticPromptTokenGrowth) {
        reasons.push(
          `${agentId}: static prompt tokens ${qb.staticPromptTokens} → ${qa.staticPromptTokens} (+${(growth * 100).toFixed(1)}%, band +${band.staticPromptTokenGrowth * 100}%)`,
        )
      }
    }
  }

  return { regressed: reasons.length > 0, reasons, warnings, comparison }
}

export function formatGateReport(
  gate: GateResult,
  current: ResultsFile,
  baselineLabel: string,
): string {
  const lines = [
    `# Eval regression gate: ${gate.regressed ? 'REGRESSION' : 'pass'}`,
    '',
    `Baseline: ${baselineLabel}`,
    '',
  ]
  if (gate.reasons.length > 0) {
    lines.push('## Regressions', '', ...gate.reasons.map((r) => `- ${r}`), '')
  }
  if (gate.warnings.length > 0) {
    lines.push('## Warnings', '', ...gate.warnings.map((w) => `- ${w}`), '')
  }
  if (gate.comparison) lines.push(formatComparisonReport(gate.comparison), '')
  lines.push(
    '## Harness quality (current run, per model)',
    '',
    formatQualityMetricsTable(
      Object.fromEntries(
        Object.entries(current.agents).map(([id, a]) => [id, a.qualityMetrics]),
      ),
    ),
  )
  return lines.join('\n') + '\n'
}

/** Resolve a FINAL_RESULTS.json from a file path or a directory tree. */
export function resolveResultsPath(target: string): string | undefined {
  if (!fs.existsSync(target)) return undefined
  if (fs.statSync(target).isFile()) return target
  const matches = (
    fs.readdirSync(target, { recursive: true, encoding: 'utf8' }) as string[]
  )
    .filter((entry) => path.basename(entry) === 'FINAL_RESULTS.json')
    .map((entry) => path.join(target, entry))
    .sort()
  return matches.at(-1)
}

function readResults(filePath: string): ResultsFile {
  return parseResultsFile(JSON.parse(fs.readFileSync(filePath, 'utf8')))
}

export interface GateCliResult {
  exitCode: 0 | 1 | 2
  report: string
}

export function parseGateArgs(argv: string[]): {
  current?: string
  baseline?: string
  report?: string
  band: NoiseBand
} {
  const get = (flag: string) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const num = (flag: string, fallback: number) => {
    const value = get(flag)
    if (value === undefined) return fallback
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`${flag} must be a non-negative number, got ${value}`)
    }
    return parsed
  }
  return {
    current: get('--current'),
    baseline: get('--baseline'),
    report: get('--report'),
    band: {
      scoreDrop: num('--score-band', DEFAULT_NOISE_BAND.scoreDrop),
      errorRunIncrease: num(
        '--error-band',
        DEFAULT_NOISE_BAND.errorRunIncrease,
      ),
      editCommitRateDrop: num(
        '--edit-commit-band',
        DEFAULT_NOISE_BAND.editCommitRateDrop,
      ),
      toolErrorRateIncrease: num(
        '--tool-error-band',
        DEFAULT_NOISE_BAND.toolErrorRateIncrease,
      ),
      staticPromptTokenGrowth: num(
        '--prompt-token-band',
        DEFAULT_NOISE_BAND.staticPromptTokenGrowth,
      ),
    },
  }
}

export function runRegressionGateCli(argv: string[]): GateCliResult {
  let args: ReturnType<typeof parseGateArgs>
  try {
    args = parseGateArgs(argv)
  } catch (error) {
    return { exitCode: 2, report: `${(error as Error).message}\n` }
  }
  const currentPath = args.current && resolveResultsPath(args.current)
  if (!currentPath) {
    return {
      exitCode: 2,
      report: `No current FINAL_RESULTS.json found at ${args.current ?? '(missing --current)'}\n`,
    }
  }
  let current: ResultsFile
  try {
    current = readResults(currentPath)
  } catch (error) {
    return {
      exitCode: 2,
      report: `Invalid current results ${currentPath}: ${(error as Error).message}\n`,
    }
  }
  const baselinePath = args.baseline && resolveResultsPath(args.baseline)
  if (!baselinePath) {
    // First run (or the baseline artifact expired): nothing to compare.
    // Still fail an empty run so a broken pipeline never reads as green.
    const empty = evaluateRegressionGate({ agents: {} }, current, args.band)
    const report = formatGateReport(
      empty,
      current,
      'none found (this run can become the baseline)',
    )
    return { exitCode: empty.regressed ? 1 : 0, report }
  }
  let baseline: ResultsFile
  try {
    baseline = readResults(baselinePath)
  } catch (error) {
    return {
      exitCode: 2,
      report: `Invalid baseline results ${baselinePath}: ${(error as Error).message}\n`,
    }
  }
  const gate = evaluateRegressionGate(baseline, current, args.band)
  const label = `${baselinePath}${baseline.metadata?.timestamp ? ` (${baseline.metadata.timestamp})` : ''}`
  return {
    exitCode: gate.regressed ? 1 : 0,
    report: formatGateReport(gate, current, label),
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const result = runRegressionGateCli(argv)
  const reportIndex = argv.indexOf('--report')
  if (reportIndex >= 0 && argv[reportIndex + 1]) {
    fs.mkdirSync(path.dirname(path.resolve(argv[reportIndex + 1])), {
      recursive: true,
    })
    fs.writeFileSync(argv[reportIndex + 1], result.report)
  }
  ;(result.exitCode === 0 ? console.log : console.error)(result.report)
  process.exit(result.exitCode)
}
