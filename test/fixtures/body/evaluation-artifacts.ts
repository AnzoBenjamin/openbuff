import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createArtifactSink } from '../../../evals/buffbench/evaluation-artifacts'
import { runBuffBench } from '../../../evals/buffbench/run-buffbench'
import { compareBuffbenchRuns } from '../../../scripts/compare-buffbench-runs'

/** No model requests: trusted-task DI fixture plus actual local comparison CLI. */
export async function runEvaluationArtifactFixture(root: string) {
  fs.mkdirSync(root, { recursive: true })
  const evalFile = path.join(root, 'fixture-eval.json')
  fs.writeFileSync(
    evalFile,
    JSON.stringify({
      repoUrl: 'offline-fixture',
      evalCommits: ['typescript', 'python'].map((language) => ({
        id: language,
        sha: `${language}-sha`,
        parentSha: 'parent',
        spec: 'offline fixture',
        prompt: 'offline fixture',
        supplementalFiles: [],
        fileDiffs: [],
        languages: [language],
      })),
    }),
  )
  const client = {
    run: async (input: { agent?: string }) =>
      input.agent === 'judge-gemini'
        ? {
            output: {
              type: 'error',
              message: 'paid auxiliary judge fixture error',
            },
            sessionState: { mainAgentState: { creditsUsed: 25 } },
          }
        : {
            output: {
              type: 'structuredOutput',
              value: {
                analysis: 'offline judge fixture',
                strengths: [],
                weaknesses: [],
                completionScore: 10,
                codeQualityScore: 10,
                overallScore: 10,
              },
            },
          },
  } as any
  const options = {
    evalDataPaths: [evalFile],
    agents: ['agent-a', 'agent-b'],
    repeats: 2,
    seed: 11,
    taskConcurrency: 2,
    client,
    artifactsRoot: path.join(root, 'orchestrator'),
    now: () => new Date(0),
    disableAnalysis: true,
    providerRoutes: {
      'agent-a': 'offline/provider-a',
      'agent-b': 'offline/provider-b',
    },
    executionScope: 'trusted_task' as const,
    runAgentOnCommitImpl: async ({
      agentId,
      commit,
    }: {
      agentId: string
      commit: { id: string }
    }) => ({
      diff: '',
      contextFiles: {},
      durationMs: 10,
      cost: agentId === 'agent-a' ? 1 : 2,
      trace: [],
      runOutcome: {
        termination: (agentId === 'agent-a'
          ? commit.id === 'python'
            ? 'cancelled'
            : 'completed'
          : commit.id === 'python'
            ? 'budget_exhausted'
            : 'failed') as 'completed',
      },
      costEvidence: { status: 'reported' as const },
      retrievalFlow: {
        queryCallCount: 0,
        queryResultPaths: [],
        successfulReadPaths: [],
        relevantReadPaths: [],
        irrelevantReadPaths: [],
      },
    }),
  }
  const manifests = await Promise.all([
    runBuffBench(options),
    runBuffBench(options),
  ])
  if (
    manifests[0]!.metadata.logsDirectory ===
    manifests[1]!.metadata.logsDirectory
  )
    throw new Error('Fixed-clock run roots collided')
  const population = manifests.map((manifest) => ({
    runId: manifest.metadata.runId,
    artifactRoot: manifest.metadata.logsDirectory,
    attempts: Object.values(manifest.agents).flatMap((agent) => agent.runs),
    costs: Object.fromEntries(
      Object.entries(manifest.agents).map(([id, agent]) => [
        id,
        {
          totalCost: agent.totalCost,
          averageCost: agent.averageCost,
          costComplete: agent.costComplete,
          attempts: agent.attemptCount,
          measured: agent.measuredRunCount,
        },
      ]),
    ),
    spend: manifest.spend,
    modelAttempts: manifest.modelAttempts,
  }))
  if (
    population.some(
      (run) =>
        run.modelAttempts.length !== 16 ||
        run.spend.availableAuxiliaryCostUsd !== 2 ||
        run.spend.unknownAuxiliaryCostAttempts !== 8 ||
        run.spend.wholeExperimentCostComplete,
    )
  )
    throw new Error('Auxiliary paid/errors or unknown spend disappeared')
  if (
    population.some(
      (run) =>
        run.attempts.length !== 8 ||
        run.attempts.filter(
          (attempt) => attempt.runOutcome?.termination === 'completed',
        ).length !== 2,
    )
  )
    throw new Error('Attempt population lost failed or incomplete work')
  const before = createArtifactSink(path.join(root, 'before'))
  const after = createArtifactSink(path.join(root, 'after'))
  const attempt = (
    agentId: string,
    repeat: number,
    score: number,
    termination = 'completed',
  ) => ({
    agentId,
    repeat,
    taskId: agentId,
    languages: ['typescript'],
    providerRoute: 'offline/provider',
    experimentId: 'comparison-fixture',
    overallScore: score,
    completionScore: score,
    codeQualityScore: score,
    cost: termination === 'completed' ? 1 : 5,
    durationMs: 10,
    scoringStatus: 'scored',
    runOutcome: { termination },
    costEvidence: { status: 'reported' },
  })
  for (const [filenameIndex, repeat] of [1, 0].entries()) {
    const file = `${filenameIndex}-ANALYSIS.json`
    before.writeJson(file, {
      commitSha: 'same-sha',
      results: [
        attempt('repeat-agent', repeat, 8),
        attempt('zero-agent', repeat, 0),
        attempt('paid-failure', repeat, 10, 'failed'),
      ],
    })
    after.writeJson(file, {
      commitSha: 'same-sha',
      results: [
        attempt('repeat-agent', repeat, repeat === 0 ? 9 : 0.5),
        attempt('zero-agent', repeat, repeat === 0 ? 0.5 : 0),
        attempt('paid-failure', repeat, 10, 'cancelled'),
      ],
    })
  }
  const comparison = compareBuffbenchRuns(before.root, after.root)
  const repeated = comparison.results.find(
    (result) => result.agentId === 'repeat-agent',
  )!
  if (
    repeated.averageBefore !== 8 ||
    repeated.averageAfter !== 4.75 ||
    repeated.pairCount !== 2
  )
    throw new Error('Repeat population reversed the regression')
  const cli = path.resolve('scripts/compare-buffbench-runs.ts')
  const stdout = execFileSync(
    process.execPath,
    [cli, before.root, after.root],
    { encoding: 'utf8' },
  )
  fs.writeFileSync(path.join(root, 'comparison-cli.log'), stdout)
  fs.writeFileSync(path.join(root, 'comparison-cli.exit'), '0\n')
  const invalid = createArtifactSink(path.join(root, 'invalid'))
  invalid.writeJson('0-ANALYSIS.json', {
    commitSha: 'same-sha',
    results: [attempt('repeat-agent', 0, NaN)],
  })
  fs.writeFileSync(
    path.join(invalid.root, '0-ANALYSIS.json'),
    fs
      .readFileSync(path.join(invalid.root, '0-ANALYSIS.json'), 'utf8')
      .replace('"overallScore": null', '"overallScore": 1e999'),
  )
  const insufficient = createArtifactSink(path.join(root, 'insufficient'))
  insufficient.writeJson('0-ANALYSIS.json', {
    commitSha: 'same-sha',
    results: [attempt('repeat-agent', 0, 8)],
  })
  const refusals = [
    { name: 'invalid-nonfinite', left: invalid.root, right: invalid.root },
    { name: 'insufficient', left: insufficient.root, right: insufficient.root },
    {
      name: 'incomparable-population',
      left: before.root,
      right: insufficient.root,
    },
  ].map((scenario) => {
    try {
      execFileSync(process.execPath, [cli, scenario.left, scenario.right], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      throw new Error(`CLI accepted ${scenario.name}`)
    } catch (error: any) {
      if (error.status !== 1) throw error
      fs.writeFileSync(
        path.join(root, `${scenario.name}.log`),
        `${error.stdout ?? ''}${error.stderr ?? ''}`,
      )
      fs.writeFileSync(
        path.join(root, `${scenario.name}.exit`),
        `${error.status}\n`,
      )
      return { name: scenario.name, exit: error.status }
    }
  })
  const report = {
    population,
    comparison,
    refusals,
    cli: { stdout, exit: 0 },
    scope:
      'trusted_task; DI models and no provider requests; environment isolation is proven by separate real SDK worker fixture',
  }
  fs.writeFileSync(
    path.join(root, 'fixture-report.json'),
    JSON.stringify(report, null, 2),
  )
  return report
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error('Provide an owned artifact root')
  await runEvaluationArtifactFixture(path.resolve(process.argv[2]))
}
