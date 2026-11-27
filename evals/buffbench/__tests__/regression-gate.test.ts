import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  DEFAULT_NOISE_BAND,
  evaluateRegressionGate,
  parseResultsFile,
  resolveResultsPath,
  runRegressionGateCli,
  type ResultsFile,
} from '../regression-gate'

import type { AgentQualityMetrics } from '../quality-metrics'
import type { AgentEvalResults, EvalRun } from '../types'

function run(score: number, error?: string): EvalRun {
  return {
    commitSha: 'abc',
    prompt: 'p',
    diff: '',
    judging: {
      analysis: '',
      strengths: [],
      weaknesses: [],
      completionScore: score,
      codeQualityScore: score,
      overallScore: score,
    },
    cost: 1,
    durationMs: 1000,
    ...(error && { error }),
  }
}

function quality(
  overrides: Partial<AgentQualityMetrics> = {},
): AgentQualityMetrics {
  return {
    runCount: 3,
    toolCallCount: 30,
    toolResultCount: 30,
    toolErrorCount: 3,
    editResultCount: 10,
    editCommittedCount: 9,
    lspCallCount: 0,
    editCommitRate: 0.9,
    toolErrorRate: 0.1,
    lspCallRate: 0,
    staticPromptTokens: 35_000,
    ...overrides,
  }
}

function agent(
  scores: number[],
  q: Partial<AgentQualityMetrics> = {},
  errors = 0,
): AgentEvalResults {
  const runs = [
    ...scores.map((s) => run(s)),
    ...Array.from({ length: errors }, () => run(0, 'boom')),
  ]
  const average = scores.length
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : 0
  return {
    agentId: 'base2',
    runs,
    averageScore: average,
    averageScoreExcludingFailures: average,
    averageCost: 1,
    averageDuration: 1000,
    measuredRunCount: scores.length,
    qualityMetrics: quality(q),
  }
}

function results(base2: AgentEvalResults, workloadHash = 'w1'): ResultsFile {
  return { metadata: { workloadHash }, agents: { base2 } }
}

const BASELINE = results(agent([7, 7, 7]))

describe('evaluateRegressionGate (N10)', () => {
  test('passes an identical run', () => {
    const gate = evaluateRegressionGate(BASELINE, BASELINE)
    expect(gate.regressed).toBe(false)
    expect(gate.reasons).toEqual([])
  })

  test('tolerates a score drop inside the noise band', () => {
    const gate = evaluateRegressionGate(
      BASELINE,
      results(agent([6.7, 6.7, 6.7])),
    )
    expect(gate.regressed).toBe(false)
  })

  test('fails a score drop past the noise band', () => {
    const gate = evaluateRegressionGate(BASELINE, results(agent([6, 6, 6])))
    expect(gate.regressed).toBe(true)
    expect(gate.reasons[0]).toContain('base2: score 7.00 → 6.00')
  })

  test('a deliberately broken prompt change fails the gate', () => {
    // A broken prompt bloats the static prompt and wrecks edits even when the
    // judge score happens to hold.
    const broken = results(
      agent([7, 7, 7], {
        staticPromptTokens: 52_000,
        editCommitRate: 0.4,
        toolErrorRate: 0.45,
      }),
    )
    const gate = evaluateRegressionGate(BASELINE, broken)
    expect(gate.regressed).toBe(true)
    expect(gate.reasons.join('\n')).toContain(
      'static prompt tokens 35000 → 52000',
    )
    expect(gate.reasons.join('\n')).toContain('edit-commit rate 90.0% → 40.0%')
    expect(gate.reasons.join('\n')).toContain('tool error rate 10.0% → 45.0%')
  })

  test('fails more errored runs than the band allows', () => {
    const gate = evaluateRegressionGate(BASELINE, results(agent([7], {}, 2)))
    expect(gate.reasons.join('\n')).toContain('errored runs 0 → 2')
  })

  test('fails an agent that disappeared or has no measured runs', () => {
    const missing = evaluateRegressionGate(BASELINE, {
      agents: { other: { ...agent([7]), agentId: 'other' } },
    })
    expect(missing.reasons).toContain('base2: missing from the current run')
    const allErrored = evaluateRegressionGate(
      BASELINE,
      results(agent([], {}, 3)),
    )
    expect(allErrored.reasons[0]).toContain('no measured runs')
  })

  test('fails an empty current run', () => {
    const gate = evaluateRegressionGate(BASELINE, { agents: {} })
    expect(gate.reasons).toEqual(['current run has no agent runs'])
  })

  test('warns when the task sets differ', () => {
    const gate = evaluateRegressionGate(
      BASELINE,
      results(agent([7, 7, 7]), 'w2'),
    )
    expect(gate.regressed).toBe(false)
    expect(gate.warnings[0]).toContain('workloadHash differs')
  })

  test('the band is configurable', () => {
    const gate = evaluateRegressionGate(BASELINE, results(agent([6, 6, 6])), {
      ...DEFAULT_NOISE_BAND,
      scoreDrop: 1.5,
    })
    expect(gate.regressed).toBe(false)
  })
})

describe('parseResultsFile', () => {
  test('reads the namespaced and the legacy top-level shapes', () => {
    const a = agent([5])
    expect(
      Object.keys(parseResultsFile({ agents: { base2: a } }).agents),
    ).toEqual(['base2'])
    expect(
      Object.keys(parseResultsFile({ metadata: {}, base2: a }).agents),
    ).toEqual(['base2'])
  })
})

describe('regression gate CLI exit codes', () => {
  let dir: string
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  function write(name: string, value: unknown): string {
    const file = path.join(dir, name, 'FINAL_RESULTS.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value))
    return file
  }

  test('0 on pass, 1 on regression, 0 with no baseline, 2 on bad input', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-gate-'))
    const baseline = write('baseline', BASELINE)
    const good = write('good', BASELINE)
    const bad = write('bad', results(agent([5, 5, 5])))

    expect(
      runRegressionGateCli(['--current', good, '--baseline', baseline])
        .exitCode,
    ).toBe(0)
    const regressed = runRegressionGateCli([
      '--current',
      bad,
      '--baseline',
      baseline,
    ])
    expect(regressed.exitCode).toBe(1)
    expect(regressed.report).toContain('# Eval regression gate: REGRESSION')
    expect(regressed.report).toContain(
      'Harness quality (current run, per model)',
    )

    // Baseline directory exists but holds no results yet (first run).
    fs.mkdirSync(path.join(dir, 'empty'))
    const first = runRegressionGateCli([
      '--current',
      good,
      '--baseline',
      path.join(dir, 'empty'),
    ])
    expect(first.exitCode).toBe(0)
    expect(first.report).toContain('none found')

    expect(
      runRegressionGateCli(['--current', path.join(dir, 'nope')]).exitCode,
    ).toBe(2)
    expect(
      runRegressionGateCli(['--current', good, '--score-band', '-1']).exitCode,
    ).toBe(2)
  })

  test('finds FINAL_RESULTS.json inside a downloaded artifact directory', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-gate-dir-'))
    const file = write('artifact/nested', BASELINE)
    expect(resolveResultsPath(path.join(dir, 'artifact'))).toBe(file)
  })

  test('the script exits non-zero on regression as a process', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-gate-proc-'))
    const baseline = write('baseline', BASELINE)
    const bad = write('bad', results(agent([5, 5, 5])))
    const report = path.join(dir, 'GATE_REPORT.md')
    const proc = spawnSync(
      process.execPath,
      [
        path.join(__dirname, '..', 'regression-gate.ts'),
        '--current',
        bad,
        '--baseline',
        baseline,
        '--report',
        report,
      ],
      { encoding: 'utf8' },
    )
    expect(proc.status).toBe(1)
    expect(fs.readFileSync(report, 'utf8')).toContain('REGRESSION')
  })
})
