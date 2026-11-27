/**
 * Gated buffbench entry used by the nightly and PR-subset workflows (N10).
 *
 * Runs `base2` on an eval subset, copies FINAL_RESULTS.json to a stable
 * `--results-out` path for the workflow to upload as an artifact, prints a
 * summary with per-model harness quality metrics, and exits non-zero when
 * no run produced a measured score. The comparison against the last green
 * run is done by regression-gate.ts in the workflow.
 *
 * Usage:
 *   bun buffbench/main-nightly.ts [--subset nightly|pr] [--tasks a,b]
 *     [--agent base2] [--results-out <path>] [--task-concurrency N]
 *     [--save-traces] [--dry-run]
 *
 * `--dry-run` validates the eval file, task ids and agent id and reports the
 * agent's static prompt tokens without any LLM call.
 */
import fs from 'fs'
import path from 'path'

import { loadLocalAgents } from '@openbuff/sdk'

import { formatQualityMetricsTable } from './quality-metrics'
import { EvalDataV2Schema, runBuffBench } from './run-buffbench'
import {
  computeStaticPromptTokens,
  type StaticPromptDefinition,
} from './static-prompt-tokens'

import type { AgentEvalResults } from './types'

export interface EvalSubset {
  evalFile: string
  /** Undefined runs every task in the eval file. */
  taskIds?: string[]
  taskConcurrency: number
}

/**
 * Fixed subsets. The PR subset holds the three smallest-diff tasks of
 * eval-codebuff.json (agent and tool code in this repo), cheap enough to run
 * on every PR that touches prompts or tool schemas.
 */
export const EVAL_SUBSETS: Record<'nightly' | 'pr', EvalSubset> = {
  nightly: { evalFile: 'eval-codebuff.json', taskConcurrency: 5 },
  pr: {
    evalFile: 'eval-codebuff.json',
    taskIds: ['autodetect-knowledge', 'update-tool-gen', 'fix-agent-steps'],
    taskConcurrency: 3,
  },
}

export const DEFAULT_AGENT = 'base2'

export interface NightlyOptions {
  subset: keyof typeof EVAL_SUBSETS
  agent: string
  taskIds?: string[]
  resultsOut: string
  taskConcurrency?: number
  saveTraces: boolean
  dryRun: boolean
}

export function parseNightlyArgs(argv: string[]): NightlyOptions {
  const get = (flag: string) => {
    const inline = argv.find((arg) => arg.startsWith(`${flag}=`))
    if (inline) return inline.slice(flag.length + 1)
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const subset = (get('--subset') ?? 'nightly') as NightlyOptions['subset']
  if (!(subset in EVAL_SUBSETS)) {
    throw new Error(`Unknown --subset ${subset}; expected nightly or pr`)
  }
  const tasks = get('--tasks')
  const concurrency = get('--task-concurrency')
  return {
    subset,
    agent: get('--agent') ?? DEFAULT_AGENT,
    taskIds: tasks
      ? tasks
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined,
    resultsOut:
      get('--results-out') ??
      path.join(__dirname, 'results', subset, 'FINAL_RESULTS.json'),
    taskConcurrency: concurrency ? Number.parseInt(concurrency, 10) : undefined,
    saveTraces: argv.includes('--save-traces'),
    dryRun: argv.includes('--dry-run'),
  }
}

export interface NightlyDeps {
  runBuffBench: (options: Parameters<typeof runBuffBench>[0]) => Promise<{
    metadata: { logsDirectory: string }
    agents: Record<string, AgentEvalResults>
  }>
  loadAgents: () => Promise<Record<string, unknown>>
  log: (message: string) => void
}

const defaultDeps: NightlyDeps = {
  runBuffBench,
  loadAgents: async () =>
    (await loadLocalAgents({
      agentsPath: path.join(__dirname, '../../agents'),
    })) as Record<string, unknown>,
  log: (message) => console.log(message),
}

/** Returns the process exit code. */
export async function runNightly(
  options: NightlyOptions,
  deps: NightlyDeps = defaultDeps,
): Promise<number> {
  const subset = EVAL_SUBSETS[options.subset]
  const evalPath = path.join(__dirname, subset.evalFile)
  const taskIds = options.taskIds ?? subset.taskIds
  const parsed = EvalDataV2Schema.safeParse(
    JSON.parse(fs.readFileSync(evalPath, 'utf8')),
  )
  if (!parsed.success) {
    deps.log(`Invalid eval file ${subset.evalFile}`)
    return 1
  }
  const known = new Set(parsed.data.evalCommits.map((commit) => commit.id))
  const unknown = (taskIds ?? []).filter((id) => !known.has(id))
  if (unknown.length > 0) {
    deps.log(`Unknown task id(s) in ${subset.evalFile}: ${unknown.join(', ')}`)
    return 1
  }
  const agents = await deps.loadAgents()
  const definition = agents[options.agent] as StaticPromptDefinition | undefined
  if (!definition) {
    deps.log(`Agent ${options.agent} is not defined under agents/`)
    return 1
  }

  const taskCount = taskIds?.length ?? parsed.data.evalCommits.length
  deps.log(
    `Buffbench ${options.subset}: agent ${options.agent}, ${taskCount} task(s) from ${subset.evalFile}`,
  )

  if (options.dryRun) {
    const tokens = await computeStaticPromptTokens(definition)
    deps.log(
      JSON.stringify(
        {
          dryRun: true,
          subset: options.subset,
          agent: options.agent,
          evalFile: subset.evalFile,
          taskIds: taskIds ?? 'all',
          taskCount,
          staticPromptTokens: tokens,
          resultsOut: options.resultsOut,
        },
        null,
        2,
      ),
    )
    return 0
  }

  const results = await deps.runBuffBench({
    evalDataPaths: [evalPath],
    agents: [options.agent],
    taskIds,
    taskConcurrency: options.taskConcurrency ?? subset.taskConcurrency,
    saveTraces: options.saveTraces,
  })

  const source = path.join(results.metadata.logsDirectory, 'FINAL_RESULTS.json')
  fs.mkdirSync(path.dirname(options.resultsOut), { recursive: true })
  fs.copyFileSync(source, options.resultsOut)
  deps.log(`Results written to ${options.resultsOut}`)

  for (const [agentId, data] of Object.entries(results.agents)) {
    const errored = data.runs.filter((run) => run.error).length
    deps.log(
      `${agentId}: score ${data.averageScore.toFixed(2)}/10 over ${data.measuredRunCount ?? data.runs.length - errored} measured run(s); ${errored} errored; avg cost ${data.averageCost.toFixed(4)}`,
    )
  }
  deps.log(
    formatQualityMetricsTable(
      Object.fromEntries(
        Object.entries(results.agents).map(([id, a]) => [id, a.qualityMetrics]),
      ),
    ),
  )

  const measured = Object.values(results.agents).reduce(
    (sum, data) =>
      sum +
      (data.measuredRunCount ?? data.runs.filter((run) => !run.error).length),
    0,
  )
  if (measured === 0) {
    deps.log('No run produced a measured score; failing the eval job.')
    return 1
  }
  return 0
}

if (import.meta.main) {
  runNightly(parseNightlyArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error('Error running nightly buffbench:', error)
      process.exit(1)
    })
}
