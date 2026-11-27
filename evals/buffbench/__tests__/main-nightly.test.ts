import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, test } from 'bun:test'

import { createBase2 } from '../../../agents/base2/base2'
import {
  DEFAULT_AGENT,
  EVAL_SUBSETS,
  parseNightlyArgs,
  runNightly,
  type NightlyDeps,
} from '../main-nightly'
import { runRegressionGateCli } from '../regression-gate'
import { runBuffBench } from '../run-buffbench'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { OpenbuffClient } from '@openbuff/sdk'

let root: string
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

const TRACE = [
  {
    type: 'tool_call',
    toolCallId: '1',
    toolName: 'go_to_definition',
    input: {},
  },
  {
    type: 'tool_result',
    toolCallId: '1',
    toolName: 'go_to_definition',
    output: [{ type: 'json', value: { locations: [] } }],
  },
  {
    type: 'tool_call',
    toolCallId: '2',
    toolName: 'edit_transaction',
    input: {},
  },
  {
    type: 'tool_result',
    toolCallId: '2',
    toolName: 'edit_transaction',
    output: [{ type: 'json', value: { message: 'ok', files: [] } }],
  },
] as PrintModeEvent[]

/** Offline runBuffBench: a fake agent runner and a fake judge client. */
function offlineRunBuffBench(
  artifactsRoot: string,
  score: number,
): NightlyDeps['runBuffBench'] {
  const client = {
    run: async () => ({
      output: {
        type: 'structuredOutput',
        value: {
          analysis: 'fixture',
          strengths: [],
          weaknesses: [],
          completionScore: score,
          codeQualityScore: score,
          overallScore: score,
        },
      },
    }),
  } as unknown as OpenbuffClient
  return (options) =>
    runBuffBench({
      ...options,
      client,
      artifactsRoot,
      disableAnalysis: true,
      runAgentOnCommitImpl: async () => ({
        diff: '',
        contextFiles: {},
        durationMs: 1,
        cost: 0.01,
        trace: TRACE,
        runOutcome: { termination: 'completed' },
        costEvidence: { status: 'reported' },
        retrievalFlow: {
          queryCallCount: 0,
          queryResultPaths: [],
          successfulReadPaths: [],
          relevantReadPaths: [],
          irrelevantReadPaths: [],
        },
      }),
    }) as ReturnType<NightlyDeps['runBuffBench']>
}

const fakeAgents: NightlyDeps['loadAgents'] = async () => ({
  base2: createBase2('default'),
})

describe('main-nightly args (N10)', () => {
  test('defaults to base2 on the nightly set', () => {
    const options = parseNightlyArgs([])
    expect(DEFAULT_AGENT).toBe('base2')
    expect(options.agent).toBe('base2')
    expect(options.subset).toBe('nightly')
    expect(options.resultsOut).toEndWith(
      path.join('results', 'nightly', 'FINAL_RESULTS.json'),
    )
  })

  test('parses subset, tasks, results path and dry run', () => {
    const options = parseNightlyArgs([
      '--subset',
      'pr',
      '--tasks',
      'a, b',
      '--results-out=/tmp/x.json',
      '--dry-run',
    ])
    expect(options).toMatchObject({
      subset: 'pr',
      taskIds: ['a', 'b'],
      resultsOut: '/tmp/x.json',
      dryRun: true,
    })
    expect(() => parseNightlyArgs(['--subset', 'weekly'])).toThrow(
      'Unknown --subset',
    )
  })

  test('the PR subset tasks exist in its eval file', async () => {
    const logs: string[] = []
    const code = await runNightly(
      { ...parseNightlyArgs(['--subset', 'pr']), dryRun: true },
      {
        runBuffBench: async () => {
          throw new Error('no run in dry mode')
        },
        loadAgents: fakeAgents,
        log: (m) => logs.push(m),
      },
    )
    expect(code).toBe(0)
    const plan = JSON.parse(logs.at(-1) ?? '{}')
    expect(plan.taskIds).toEqual(EVAL_SUBSETS.pr.taskIds)
    expect(plan.staticPromptTokens.total).toBeGreaterThan(0)
  })

  test('rejects unknown tasks and unknown agents before any run', async () => {
    const deps: NightlyDeps = {
      runBuffBench: async () => {
        throw new Error('must not run')
      },
      loadAgents: fakeAgents,
      log: () => {},
    }
    expect(
      await runNightly({ ...parseNightlyArgs(['--tasks', 'nope']) }, deps),
    ).toBe(1)
    expect(
      await runNightly(
        { ...parseNightlyArgs(['--agent', 'base2-free']) },
        deps,
      ),
    ).toBe(1)
  })
})

describe('main-nightly offline two-task run (N10)', () => {
  test('writes a results artifact with per-model metrics that the gate reads', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-offline-'))
    const tasks = ['autodetect-knowledge', 'update-tool-gen']
    const baselineOut = path.join(root, 'baseline', 'FINAL_RESULTS.json')
    const currentOut = path.join(root, 'current', 'FINAL_RESULTS.json')
    const logs: string[] = []
    const deps = (score: number): NightlyDeps => ({
      runBuffBench: offlineRunBuffBench(path.join(root, 'artifacts'), score),
      loadAgents: fakeAgents,
      log: (m) => logs.push(m),
    })

    const base = parseNightlyArgs(['--tasks', tasks.join(',')])
    expect(
      await runNightly({ ...base, resultsOut: baselineOut }, deps(8)),
    ).toBe(0)
    expect(await runNightly({ ...base, resultsOut: currentOut }, deps(8))).toBe(
      0,
    )

    const saved = JSON.parse(fs.readFileSync(currentOut, 'utf8'))
    expect(saved.metadata.agentsTested).toEqual(['base2'])
    expect(saved.metadata.commitsEvaluated).toBe(2)
    const q = saved.agents.base2.qualityMetrics
    expect(q.runCount).toBe(2)
    expect(q.editCommitRate).toBe(1)
    expect(q.toolErrorRate).toBe(0)
    expect(q.lspCallRate).toBe(0.5)
    expect(q.staticPromptTokens).toBeGreaterThan(0)
    expect(logs.join('\n')).toContain('Edit-commit rate')

    expect(
      runRegressionGateCli(['--current', currentOut, '--baseline', baselineOut])
        .exitCode,
    ).toBe(0)

    // A regressed run (judge score 8 → 3) fails the gate.
    const regressedOut = path.join(root, 'regressed', 'FINAL_RESULTS.json')
    expect(
      await runNightly({ ...base, resultsOut: regressedOut }, deps(3)),
    ).toBe(0)
    const gate = runRegressionGateCli([
      '--current',
      regressedOut,
      '--baseline',
      baselineOut,
    ])
    expect(gate.exitCode).toBe(1)
    expect(gate.report).toContain('base2: score 8.00 → 3.00')
  }, 60_000)
})
