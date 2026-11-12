import { withEvaluationEnvironment } from './evaluation-environment'
import {
  createIsolatedEvaluationClient,
  isIsolatedEvaluationClient,
} from './isolated-sdk-client'
import { recordEvaluatorModelAttempts } from './evaluation-model-attempts'
import { createHash, randomUUID } from 'node:crypto'
import {
  artifactId,
  createArtifactSink,
  createRunArtifactSink,
  type EvaluationArtifactSink,
} from './evaluation-artifacts'
import type { EvalAttemptEvidence } from './types'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { OpenbuffClient, loadLocalAgents } from '@openbuff/sdk'
import pLimit from 'p-limit'
import { z } from 'zod/v4'

import { runAgentOnCommit, type ExternalAgentType } from './agent-runner'
import type { ComparisonResult } from './compare-runs'
import { formatTaskResults } from './format-output'
import { judgeCommitResult, type JudgingResult } from './judge'
import { extractAgentLessons, saveAgentLessons } from './lessons-extractor'
import { applyProposals, decideProposalPromotion } from './proposals'
import {
  standardError,
  isEvaluationExecutionEligible,
  isMeasuredScoreEligible,
  sumFiniteCosts,
} from './statistics'
import { analyzeAgentTraces, type AgentTraceData } from './trace-analyzer'
import {
  aggregateQualityMetrics,
  computeRunQualityMetrics,
  formatQualityMetricsTable,
} from './quality-metrics'
import {
  computeStaticPromptTokens,
  type StaticPromptDefinition,
} from './static-prompt-tokens'
import { logger } from '../logger'
import { analyzeAllTasks } from './meta-analyzer'

import type {
  AgentEvalResults,
  EvalDataV2,
  EvalCommitV2,
  EvalRun,
  ProposalDryRunReport,
} from './types'
import {
  computeIdiomTraceabilitySignals,
  evaluateIdiomTraceability,
} from './idiom-traceability-signals'
import type { IdiomTraceabilityEvaluation } from './idiom-traceability-signals'
import {
  detectIdiomPatternSignals,
  type IdiomPatternFinding,
} from './idiom-pattern-signals'
import {
  computeThinkerHarvestSignals,
  evaluateThinkerHarvest,
} from './thinker-harvest-signals'

function parseAgentId(agent: string): {
  agentId: string
  externalAgentType?: ExternalAgentType
} {
  if (agent.startsWith('external:')) {
    const externalType = agent.slice('external:'.length) as ExternalAgentType
    if (
      externalType !== 'claude' &&
      externalType !== 'codex' &&
      externalType !== 'opencode'
    ) {
      throw new Error(
        `Unknown external agent type: ${externalType}. Supported: claude, codex, opencode`,
      )
    }
    return { agentId: agent, externalAgentType: externalType }
  }
  return { agentId: agent }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error
    ? `${error.message}\n${error.stack}`
    : String(error)
}

function failedJudgingResult(error: string): JudgingResult {
  return {
    analysis: `Agent evaluation failed before judging completed: ${error}`,
    strengths: [],
    weaknesses: [error],
    completionScore: 0,
    codeQualityScore: 0,
    overallScore: 0,
    // The agent crashed before any judge could run — these all-zero scores are
    // synthetic, NOT a measured 0/10. Match the all-judges-failed signal so
    // downstream consumers can exclude this run from averages.
    scoringStatus: 'all_judges_failed',
  }
}

export function summarizeAgentRuns(agentData: AgentEvalResults): {
  validRuns: EvalRun[]
  runsExcludingFailures: EvalRun[]
  measuredRuns: EvalRun[]
} {
  const validRuns = agentData.runs.filter(isEvaluationExecutionEligible)

  return {
    validRuns,
    // Kept as an alias of validRuns to preserve the declared shape. The old
    // overallScore > 1.0 magic threshold here silently discarded genuine low
    // measured scores (e.g. 0.5-1.0) while still counting synthetic zeros.
    runsExcludingFailures: validRuns,
    // M5-T7-R2: synthetic all-zero runs (scoringStatus 'all_judges_failed' —
    // documented as NOT a measured 0/10) must never enter measured averages.
    measuredRuns: validRuns.filter(isMeasuredScoreEligible),
  }
}

function formatIdiomPatternFinding(finding: IdiomPatternFinding): string {
  return `${finding.patternId} (${finding.path}:${finding.lineNumber}): ${finding.message}`
}

export function mergeIdiomPatternFindings(
  judging: JudgingResult,
  findings: IdiomPatternFinding[],
): JudgingResult {
  if (findings.length === 0) return judging

  const nonIdiomaticPatternsDetected = Array.from(
    new Set([
      ...(judging.nonIdiomaticPatternsDetected ?? []),
      ...findings.map(formatIdiomPatternFinding),
    ]),
  )

  return {
    ...judging,
    nonIdiomaticPatternsDetected,
  }
}

export async function runTask(
  options: Parameters<typeof runTaskWithEnvironment>[0],
) {
  if (
    options.executionScope === 'key_free_environment' &&
    options.runAgentOnCommitImpl
  )
    throw new Error(
      'Key-free evaluation refuses in-process execution overrides',
    )
  if (
    options.executionScope === 'key_free_environment' &&
    !isIsolatedEvaluationClient(options.client)
  )
    throw new Error('Key-free evaluation requires the isolated SDK adapter')
  return withEvaluationEnvironment(
    options.executionScope ?? 'trusted_task',
    options.env,
    (env) => runTaskWithEnvironment({ ...options, env }),
  )
}

async function runTaskWithEnvironment(options: {
  client: OpenbuffClient
  commit: EvalDataV2['evalCommits'][0]
  agents: string[]
  repoUrl: string
  initCommand?: string
  env?: Record<string, string>
  logsDir: string
  artifactSink?: EvaluationArtifactSink
  lessonsDir?: string
  attempt?: EvalAttemptEvidence
  providerRoutes?: Record<string, string>
  executionScope?: EvalAttemptEvidence['executionScope']
  index: number
  totalTasks: number
  analyzerContext: {
    agentDefinitions: any[]
    agentTypeDefinition: string
    testedAgentIds: string[]
  }
  localAgentDefinitions: any[]
  extractLessons: boolean
  printEvents: boolean
  finalCheckCommands?: EvalDataV2['finalCheckCommands']
  cacheRecallEval?: EvalDataV2['cacheRecallEval']
  disableAnalysis?: boolean
  saveTraces?: boolean
  runAgentOnCommitImpl?: typeof runAgentOnCommit
}) {
  const {
    client,
    commit,
    agents,
    repoUrl,
    initCommand,
    env,
    logsDir,
    index,
    totalTasks,
    analyzerContext,
    localAgentDefinitions,
    extractLessons,
    printEvents,
    finalCheckCommands,
    cacheRecallEval,
    disableAnalysis,
    saveTraces = false,
    runAgentOnCommitImpl = runAgentOnCommit,
  } = options

  console.log(
    `\n=== Task ${index + 1}/${totalTasks}: ${commit.id} (${commit.sha.slice(0, 7)}) ===`,
  )

  // Store trace data for this commit to analyze later
  const commitTraces: AgentTraceData[] = []
  const sink = options.artifactSink ?? createArtifactSink(logsDir)
  const taskAttemptId = randomUUID()
  const taskEvidence: EvalAttemptEvidence = {
    runId: options.attempt?.runId ?? taskAttemptId,
    experimentId: options.attempt?.experimentId ?? 'unreported',
    taskId: commit.id,
    repeat: options.attempt?.repeat ?? 0,
    languages: [...(commit.languages ?? [])],
    executionScope: options.executionScope ?? 'trusted_task',
    ...options.attempt,
  }
  const modelRecorder = recordEvaluatorModelAttempts(
    client,
    createArtifactSink(path.join(sink.root, 'sdk-attempts')),
    agents,
    taskEvidence,
    options.providerRoutes,
  )
  const evaluationClient = modelRecorder.client
  const lessonsDir = options.lessonsDir ?? path.join(sink.root, 'lessons')

  const agentPromises = agents.map(async (agent) => {
    let agentId = agent
    const evidence: EvalAttemptEvidence = {
      ...taskEvidence,
      attemptId: randomUUID(),
      providerRoute:
        options.providerRoutes?.[agent] ??
        options.attempt?.providerRoute ??
        'unreported',
    }
    let retainedResult: Awaited<ReturnType<typeof runAgentOnCommit>> | undefined
    const artifactPrefix = `${index + 1}-${artifactId(commit.id)}-${artifactId(agent)}-${artifactId(commit.sha.slice(0, 7))}-${evidence.attemptId}`
    try {
      const { agentId: parsedAgentId, externalAgentType } = parseAgentId(agent)
      agentId = parsedAgentId

      const agentResult = await runAgentOnCommitImpl({
        client: evaluationClient,
        agentId,
        commit,
        repoUrl,
        initCommand,
        env,
        localAgentDefinitions,
        printEvents,
        finalCheckCommands,
        cacheRecallEval,
        externalAgentType,
        artifactSink: sink,
        executionScope: options.executionScope,
      })
      retainedResult = agentResult
      evidence.runOutcome = agentResult.runOutcome
      evidence.costEvidence = agentResult.costEvidence
      const executionError =
        agentResult.error ??
        (agentResult.runOutcome &&
        agentResult.runOutcome.termination !== 'completed'
          ? (agentResult.runOutcome.cause?.message ??
            `Run ${agentResult.runOutcome.termination}`)
          : undefined)

      const judgeResult = mergeIdiomPatternFindings(
        await judgeCommitResult({
          env,
          inheritEnv: options.executionScope !== 'key_free_environment',
          client: evaluationClient,
          artifactSink: sink,
          attemptId: evidence.attemptId,
          commit,
          contextFiles: agentResult.contextFiles,
          agentDiff: agentResult.diff,
          error: executionError,
          finalCheckOutputs: agentResult.finalCheckOutputs
            ? agentResult.finalCheckOutputs
                .map(
                  (output) =>
                    `### ${output.command}\n\`\`\`\n${output.stdout}${output.stderr ? '\nSTDERR:\n' + output.stderr : ''}\n\`\`\``,
                )
                .join('\n\n')
            : undefined,
          finalCheckOutputsStructured: agentResult.finalCheckOutputs,
        }),
        detectIdiomPatternSignals(agentResult.diff),
      )

      let proposalDryRun: ProposalDryRunReport | undefined

      // Extract and append agent lessons
      if (extractLessons) {
        console.log(`[${commit.id}] Extracting lessons for ${agentId}...`)
        const { lessons, proposals } = await extractAgentLessons({
          env,
          inheritEnv: options.executionScope !== 'key_free_environment',
          client: evaluationClient,
          localAgentDefinitions,
          prompt: commit.prompt,
          groundTruthFileDiffs: commit.fileDiffs,
          contextFiles: agentResult.contextFiles,
          agentDiff: agentResult.diff,
          agentTrace: agentResult.trace,
          judgeResult,
          error: executionError,
        })

        if (proposals.length > 0) {
          const dryRun = applyProposals({
            proposals,
            agentDefinitions: localAgentDefinitions,
            dryRun: true,
          })
          // Audit MEDIUM (promotion gate never invoked in the live pipeline):
          // decideProposalPromotion previously ran only in unit tests. Fire it
          // here on every live dry-run and RECORD the decision — never
          // auto-apply (actual promotion belongs to the P8-T5 candidate
          // channel). No before/after ComparisonResult exists inside a single
          // live run, so the comparison is constructed from this run's own
          // scores with before == after (== judgeResult.overallScore): the
          // zero delta fails the gate's minTotalScoreDelta check instead of
          // inventing an improvement. Paired per-task before/after scores are
          // likewise unavailable in a single run, so they are omitted and
          // requireSignificance blocks promotion with the gate's own
          // 'significance required but no paired per-task scores provided'
          // reason — the gate must FIRE, fail-closed, not be skipped.
          const gateComparison: ComparisonResult = {
            agentDeltas: [
              {
                agentId,
                scoreDelta: 0,
                scoreExcludingFailuresDelta: 0,
                costDelta: 0,
                durationDelta: 0,
                errorCountDelta: 0,
                beforeRunCount: 1,
                afterRunCount: 1,
                regression: false,
                summary:
                  'single-run promotion gate check: no before run to compare against',
              },
            ],
            overall: {
              totalScoreDelta: 0,
              totalCostDelta: 0,
              totalDurationDelta: 0,
              totalErrorDelta: 0,
              totalBeforeRuns: 1,
              totalAfterRuns: 1,
              regressedAgentIds: [],
              improvedAgentIds: [],
            },
            hasRegressions: false,
          }
          const promotionDecision = decideProposalPromotion({
            dryRun,
            comparison: gateComparison,
            policy: { requireSignificance: true, maxPValue: 0.05 },
          })
          logger.info(
            {
              agentId,
              commitId: commit.id,
              accepted: promotionDecision.accepted,
            },
            `Proposal promotion gate: ${promotionDecision.accepted ? 'PROMOTE' : 'REJECT'} — ${promotionDecision.reasons[0]}`,
          )
          proposalDryRun = {
            proposals,
            appliedCount: dryRun.appliedCount,
            skippedCount: dryRun.skippedCount,
            summary: dryRun.summary,
            perProposal: dryRun.perProposal,
            promotionDecision,
          }
        }

        saveAgentLessons({
          agentId,
          commitId: commit.id,
          commitSha: commit.sha,
          prompt: commit.prompt,
          lessons,
          proposalDryRun,
          lessonsDir,
        })
      }

      const idiomTraceability = evaluateIdiomTraceability(
        computeIdiomTraceabilitySignals(agentResult.trace),
      )

      const thinkerHarvest = evaluateThinkerHarvest({
        signals: computeThinkerHarvestSignals({ events: agentResult.trace }),
      })

      const evalRun: EvalRun = {
        ...evidence,
        commitSha: commit.sha,
        prompt: commit.prompt,
        diff: agentResult.diff,
        judging: judgeResult,
        // Surface the judging signal at the top level for ergonomic meta-analysis
        // filtering. Default to 'scored' for back-compat with old trace files.
        scoringStatus: judgeResult.scoringStatus ?? 'scored',
        cost: agentResult.cost,
        durationMs: agentResult.durationMs,
        error: executionError,
        finalCheckOutputs: agentResult.finalCheckOutputs,
        cacheRecallEval: agentResult.cacheRecallEval,
        retrievalFlow: agentResult.retrievalFlow,
        qualityMetrics: computeRunQualityMetrics(agentResult.trace),
        idiomTraceability,
        thinkerHarvest,
        proposalDryRun,
      }

      // Save trace to logs directory
      const safeTaskId = commit.id.replace(/[^a-zA-Z0-9-]/g, '_')
      const safeAgentId = agentId.replace(/[^a-zA-Z0-9-]/g, '_')
      const safeCommitShort = commit.sha.slice(0, 7)
      const traceFilename = `${artifactPrefix}.json`
      const tracePath = path.join(logsDir, traceFilename)

      // Store judging result and trace for combined output later. Bind the
      // entry to a local const: writing commitTraces[commitTraces.length - 1]
      // read from a shared array mutated by concurrent agent callbacks, so any
      // await inserted between push and write could serialize ANOTHER agent's
      // trace under this agent's filename.
      const traceEntry: AgentTraceData = {
        ...evidence,
        agentId,
        commitSha: commit.sha,
        prompt: commit.prompt,
        trace: agentResult.trace,
        diff: agentResult.diff,
        judgeResult,
        cost: agentResult.cost,
        durationMs: agentResult.durationMs,
        error: executionError,
        timestamp: new Date().toISOString(),
        finalCheckOutputs: agentResult.finalCheckOutputs,
        cacheRecallEval: agentResult.cacheRecallEval,
        retrievalFlow: agentResult.retrievalFlow,
        idiomTraceability,
        thinkerHarvest,
        proposalDryRun,
      }
      commitTraces.push(traceEntry)

      // Save judge traces to separate files if saveTraces is enabled
      if (saveTraces) {
        const tracesDir = path.join(logsDir, 'traces')
        if (!fs.existsSync(tracesDir)) {
          fs.mkdirSync(tracesDir, { recursive: true })
        }

        // Save agent trace only (not judge traces)
        const agentTracePath = path.join(
          tracesDir,
          `${artifactPrefix}-agent.json`,
        )
        createArtifactSink(tracesDir).writeJson(
          path.basename(agentTracePath),
          agentResult.trace,
        )
      }

      sink.writeJson(path.basename(tracePath), traceEntry)

      return { agentId, evalRun }
    } catch (error) {
      const message = formatUnknownError(error)
      console.error(`[${commit.id}] Agent ${agentId} failed:`, message)
      const judgeResult = failedJudgingResult(message)
      const evalRun: EvalRun = {
        ...evidence,
        commitSha: commit.sha,
        prompt: commit.prompt,
        diff: retainedResult?.diff ?? '',
        judging: judgeResult,
        // The agent itself crashed before judging — mirror the synthetic-zero
        // signal so this run is excluded from measured averages.
        scoringStatus: 'all_judges_failed',
        cost: retainedResult?.cost ?? 0,
        durationMs: retainedResult?.durationMs ?? 0,
        costEvidence: retainedResult?.costEvidence ?? { status: 'unknown' },
        error: message,
      }
      // M5-T7: crash runs get a trace artifact too — formatTaskResults prints
      // a traceFilePath for them, so the file must exist. Bind the entry to a
      // local const for the same concurrency reason as the success path.
      const safeTaskId = commit.id.replace(/[^a-zA-Z0-9-]/g, '_')
      const safeAgentId = agentId.replace(/[^a-zA-Z0-9-]/g, '_')
      const safeCommitShort = commit.sha.slice(0, 7)
      const tracePath = path.join(logsDir, `${artifactPrefix}.json`)
      const traceEntry: AgentTraceData = {
        ...evidence,
        agentId,
        commitSha: commit.sha,
        prompt: commit.prompt,
        trace: retainedResult?.trace ?? [],
        diff: retainedResult?.diff ?? '',
        judgeResult,
        cost: retainedResult?.cost ?? 0,
        durationMs: retainedResult?.durationMs ?? 0,
        costEvidence: retainedResult?.costEvidence ?? { status: 'unknown' },
        error: message,
        timestamp: new Date().toISOString(),
      }
      commitTraces.push(traceEntry)
      sink.writeJson(path.basename(tracePath), traceEntry)
      return { agentId, evalRun }
    }
  })

  const agentResults = await Promise.all(agentPromises)

  // After all agents complete for this commit, run trace analysis
  const traceAnalysis = disableAnalysis
    ? undefined
    : await analyzeAgentTraces({
        env,
        inheritEnv: options.executionScope !== 'key_free_environment',
        client: evaluationClient,
        traces: commitTraces,
        codingAgentPrompt: commit.prompt,
        analyzerContext,
      }).catch((error) => {
        sink.writeJson(`${taskAttemptId}-analysis-error.json`, {
          error: formatUnknownError(error),
          attempts: commitTraces,
        })
        return undefined
      })

  const analysisData = {
    ...taskEvidence,
    commitSha: commit.sha,
    timestamp: new Date().toISOString(),
    ...(traceAnalysis ?? {
      traceAnalysisStatus: disableAnalysis
        ? 'analysis_disabled'
        : 'analysis_failed',
    }),
    modelAttempts: modelRecorder.attempts,
    results: commitTraces.map((t) => ({
      ...t,
      agentId: t.agentId,
      ...t.judgeResult,
      cost: t.cost,
      durationMs: t.durationMs,
      error: t.error,
      idiomTraceability: t.idiomTraceability,
      thinkerHarvest: t.thinkerHarvest,
      proposalDryRun: t.proposalDryRun,
    })),
    prompt: commit.prompt,
  }

  // Save analysis to logs directory
  const safeTaskId = commit.id.replace(/[^a-zA-Z0-9-]/g, '_')
  const analysisCommitShort = artifactId(commit.sha.slice(0, 7))
  const analysisFilename = `${index + 1}-${artifactId(commit.id)}-ANALYSIS-${analysisCommitShort}-${taskAttemptId}.json`
  const analysisPath = path.join(logsDir, analysisFilename)
  sink.writeJson(path.basename(analysisPath), analysisData)

  // Print all agent results with their judging, then trace analysis together
  console.log(
    formatTaskResults({
      commit,
      taskNumber: index + 1,
      totalTasks,
      agentResults: commitTraces.map((trace) => ({
        agentId: trace.agentId,
        judging: trace.judgeResult,
        cost: trace.cost,
        durationMs: trace.durationMs,
        error: trace.error,
        traceFilePath: path.join(
          logsDir,
          `${index + 1}-${artifactId(commit.id)}-${artifactId(trace.agentId)}-${artifactId(commit.sha.slice(0, 7))}-${trace.attemptId}.json`,
        ),
        idiomTraceability: trace.idiomTraceability,
        thinkerHarvest: trace.thinkerHarvest,
      })),
      traceAnalysis,
    }),
  )

  return {
    commit,
    agentResults,
    commitTraces,
    modelAttempts: modelRecorder.attempts,
  }
}

export const BinInstallSchema = z.object({
  name: z.string().min(1).max(200),
  installScript: z.string().min(1).max(2000),
  binPath: z.string().min(1).max(500),
})

// M5-T7: eval data files are untrusted input (they drive repo clones, install
// scripts, and shell-adjacent flows), so they must be schema-validated at load
// time instead of relying on TypeScript's compile-time-only guarantee over a
// bare JSON.parse cast. The schema pins the fields the runner actually reads;
// it is intentionally loose so optional config keys (env, cacheRecallEval,
// binInstalls, ...) survive validation unchanged.
const FileDiffSchema = z.object({
  path: z.string().min(1),
  status: z.enum(['modified', 'added', 'deleted', 'renamed']),
  oldPath: z.string().optional(),
  diff: z.string(),
})

export const EvalCommitV2Schema = z.looseObject({
  id: z.string().min(1),
  sha: z.string().min(1),
  parentSha: z.string(),
  spec: z.string(),
  prompt: z.string(),
  supplementalFiles: z.array(z.string()),
  fileDiffs: z.array(FileDiffSchema),
  languages: z.array(z.string().min(1)).optional(),
})

export const EvalDataV2Schema = z.looseObject({
  repoUrl: z.string().min(1),
  // generationDate is runner-irrelevant metadata: validated as a string when
  // present but never required, so eval files that predate the field still
  // load (the runner never reads it).
  generationDate: z.string().optional(),
  evalCommits: z.array(EvalCommitV2Schema),
})

// Minimal allowlist env for the untrusted install process: PATH + HOME keep
// npm/bun functional and INSTALL_DIR is the existing install contract. The
// full parent environment (tokens, credentials) is never spread in.
type ExecInstallEnv = {
  PATH: string
  HOME: string
  INSTALL_DIR: string
}

type ExecInstallFn = (
  file: string,
  args: string[],
  options: { cwd: string; stdio: 'ignore'; env: ExecInstallEnv },
) => unknown

/**
 * Parse an installScript from eval data into a safe argv array. Only simple
 * `npm install <pkgs>` / `bun add <pkgs>` one-liners are allowed; anything
 * else (pipes, chains, quotes, other binaries) is rejected — never executed.
 */
export function parseInstallScriptArgv(
  installScript: string,
  source: string,
): string[] {
  const argv = installScript.trim().split(/\s+/)
  const [bin, subcommand, ...args] = argv
  if (bin !== 'npm' && bin !== 'bun') {
    throw new Error(
      `Invalid ${source}: first token must be exactly 'npm' or 'bun', got ${JSON.stringify(bin)}`,
    )
  }
  if (subcommand !== 'install' && subcommand !== 'add') {
    throw new Error(
      `Invalid ${source}: second token must be exactly 'install' or 'add', got ${JSON.stringify(subcommand)}`,
    )
  }
  if (args.length === 0) {
    throw new Error(
      `Invalid ${source}: expected at least one package to install`,
    )
  }
  // Set-based metachar scan instead of a character-class regex: a leading `]`
  // in a JS character class forms an EMPTY class (matches nothing), which made
  // the previous regex a dead check that admitted `&&`/`|` chains. An explicit
  // Set cannot silently fail to match.
  const shellMetachars = new Set([
    ';',
    '&',
    '|',
    '<',
    '>',
    '$',
    '`',
    '"',
    "'",
    '\\',
  ])
  for (const arg of args) {
    for (const char of arg) {
      if (shellMetachars.has(char)) {
        throw new Error(
          `Invalid ${source}: shell metacharacters are not allowed in install scripts`,
        )
      }
    }
  }
  return argv
}

/**
 * Install binaries specified in binInstalls config to a temporary directory
 * Returns the temporary directory path and updated env with PATH
 */
export function installBinaries(
  binInstalls: EvalDataV2['binInstalls'],
  execInstall: ExecInstallFn = execFileSync,
): {
  tempDir: string | null
  env: Record<string, string>
} {
  if (!binInstalls || binInstalls.length === 0) {
    return { tempDir: null, env: {} }
  }

  // Validate every entry (schema + safe argv form) BEFORE creating any
  // directories or executing anything.
  const parsedBins: Array<{ name: string; binPath: string; argv: string[] }> =
    binInstalls.map((rawBin) => {
      const parsed = BinInstallSchema.safeParse(rawBin)
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')
        throw new Error(
          `Invalid binInstalls entry for ${JSON.stringify((rawBin as { name?: unknown }).name)}: ${issues}`,
        )
      }
      return {
        name: parsed.data.name,
        binPath: parsed.data.binPath,
        argv: parseInstallScriptArgv(
          parsed.data.installScript,
          'binInstalls[].installScript',
        ),
      }
    })

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuff-bins-'))

  const binPaths: string[] = []

  const installEnv: ExecInstallEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? os.homedir(),
    INSTALL_DIR: tempDir,
  }

  for (const bin of parsedBins) {
    // Containment check BEFORE executing anything: binPath comes from
    // untrusted eval data, so a '../../evil' binPath must never place a
    // directory outside tempDir on PATH.
    const fullBinPath = path.join(tempDir, bin.binPath)
    const relative = path.relative(tempDir, path.resolve(fullBinPath))
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `Invalid binInstalls entry for ${JSON.stringify(bin.name)}: binPath escapes the installation directory: ${bin.binPath}`,
      )
    }
    try {
      // Execute via an argv array (no shell): the install script comes from
      // untrusted eval data and must never be interpolated into a shell line.
      execInstall(bin.argv[0]!, bin.argv.slice(1), {
        cwd: tempDir,
        stdio: 'ignore',
        env: installEnv,
      })

      if (fs.existsSync(fullBinPath)) {
        binPaths.push(path.dirname(fullBinPath))
        console.log(`✓ ${bin.name} installed at ${fullBinPath}`)
      } else {
        console.warn(
          `Warning: Expected binary not found at ${fullBinPath} after installing ${bin.name}`,
        )
      }
    } catch (error) {
      console.error(`Error installing ${bin.name}:`, error)
      throw error
    }
  }

  // Prepend all bin paths to PATH
  const updatedPath = [...binPaths, process.env.PATH].filter(Boolean).join(':')

  return {
    tempDir,
    env: { PATH: updatedPath },
  }
}

interface CommitWithSource {
  commit: EvalCommitV2
  evalData: EvalDataV2
  evalDataPath: string
  repeat?: number
}

export async function runBuffBench(
  options: Parameters<typeof runBuffBenchWithEnvironment>[0],
) {
  if (
    options.executionScope === 'key_free_environment' &&
    options.runAgentOnCommitImpl
  )
    throw new Error(
      'Key-free evaluation refuses in-process execution overrides',
    )
  if (
    options.executionScope === 'key_free_environment' &&
    options.client &&
    !isIsolatedEvaluationClient(options.client)
  )
    throw new Error('Key-free evaluation refuses injected in-process clients')
  return withEvaluationEnvironment(
    options.executionScope ?? 'trusted_task',
    undefined,
    (env) => runBuffBenchWithEnvironment({ ...options, evaluatorEnv: env }),
  )
}

async function runBuffBenchWithEnvironment(options: {
  evalDataPaths: string[]
  agents: string[]
  taskConcurrency?: number
  client?: OpenbuffClient
  taskIds?: string[]
  extractLessons?: boolean
  disableAnalysis?: boolean
  saveTraces?: boolean
  repeats?: number
  seed?: number
  evaluatorEnv?: Record<string, string>
  artifactsRoot?: string
  lessonsDir?: string
  now?: () => Date
  experimentId?: string
  providerRoutes?: Record<string, string>
  executionScope?: EvalAttemptEvidence['executionScope']
  runAgentOnCommitImpl?: typeof runAgentOnCommit
}) {
  const {
    evalDataPaths,
    agents,
    taskConcurrency = 1,
    taskIds,
    extractLessons = false,
    disableAnalysis = false,
    saveTraces = false,
    repeats = 1,
    seed = 1,
  } = options

  if (evalDataPaths.length === 0) {
    throw new Error('At least one eval data path is required')
  }
  if (
    !Number.isSafeInteger(repeats) ||
    repeats < 1 ||
    repeats > 1000 ||
    !Number.isSafeInteger(seed)
  ) {
    throw new Error('Invalid evaluation repeats or seed')
  }

  // Load all eval files and create a mapping of commits to their source eval data
  const allCommitsWithSource: CommitWithSource[] = []
  const loadedEvalFiles: { path: string; data: EvalDataV2 }[] = []

  for (const evalDataPath of evalDataPaths) {
    const raw = JSON.parse(fs.readFileSync(evalDataPath, 'utf-8')) as unknown
    const parsed = EvalDataV2Schema.safeParse(raw)
    if (!parsed.success) {
      // Fail before installBinaries runs: aggregate every issue into one
      // error so a version-drifted or malformed file names all of its
      // problems instead of throwing a raw 'Unexpected token' or failing
      // deep inside runTask.
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
      throw new Error(`Invalid eval data file ${evalDataPath}: ${issues}`)
    }
    // Build the typed value instead of casting: the loose schema validates
    // the fields the runner reads but deliberately does not require
    // EvalDataV2's generationDate metadata, so a direct `as EvalDataV2` cast
    // is unsound (TS2352). Spreading the validated object keeps every
    // optional config key (env, binInstalls, finalCheckCommands, ...) that
    // survived validation; generationDate passes through when present.
    const evalData: EvalDataV2 = {
      ...parsed.data,
      generationDate: parsed.data.generationDate ?? '',
    }
    loadedEvalFiles.push({ path: evalDataPath, data: evalData })

    for (const commit of evalData.evalCommits) {
      allCommitsWithSource.push({
        commit,
        evalData,
        evalDataPath,
      })
    }
  }

  console.log(
    `Loaded ${loadedEvalFiles.length} eval file(s) with ${allCommitsWithSource.length} total tasks`,
  )
  for (const { path: p, data } of loadedEvalFiles) {
    console.log(`  - ${path.basename(p)}: ${data.evalCommits.length} tasks`)
  }

  // Collect all unique binInstalls from all eval files
  const allBinInstalls = loadedEvalFiles.flatMap(
    (f) => f.data.binInstalls ?? [],
  )
  const uniqueBinInstalls = allBinInstalls.filter(
    (bin, index, self) => index === self.findIndex((b) => b.name === bin.name),
  )

  // Install binaries once at the beginning
  if (
    options.executionScope === 'key_free_environment' &&
    uniqueBinInstalls.length > 0
  ) {
    throw new Error(
      'Key-free environment evaluation requires preinstalled tools; trusted binary installers are unsupported',
    )
  }
  const { tempDir: binsTempDir, env: binsEnv } =
    installBinaries(uniqueBinInstalls)

  let commitsToRun: CommitWithSource[]
  if (taskIds && taskIds.length > 0) {
    const foundCommits: CommitWithSource[] = []
    const notFoundIds: string[] = []

    for (const taskId of taskIds) {
      const found = allCommitsWithSource.find((c) => c.commit.id === taskId)
      if (found) {
        foundCommits.push(found)
      } else {
        notFoundIds.push(taskId)
      }
    }

    if (notFoundIds.length > 0) {
      const availableIds = allCommitsWithSource
        .map((c) => c.commit.id)
        .join(', ')
      throw new Error(
        `Task ID(s) not found: ${notFoundIds.join(', ')}. Available task IDs: ${availableIds}`,
      )
    }

    commitsToRun = foundCommits
    console.log(`Running ${foundCommits.length} task(s): ${taskIds.join(', ')}`)
  } else {
    commitsToRun = allCommitsWithSource
  }

  const client =
    options.client ??
    (options.executionScope === 'key_free_environment'
      ? createIsolatedEvaluationClient().client
      : new OpenbuffClient({
          logger,
        }))

  // Load local agent definitions and type definition file for analyzers
  const agentsPath = path.join(__dirname, '../../agents')
  const loadedAgents = await loadLocalAgents({ agentsPath })
  const agentTypeDefinitionPath = path.join(
    agentsPath,
    'types',
    'agent-definition.ts',
  )
  const agentTypeDefinition = fs.existsSync(agentTypeDefinitionPath)
    ? fs.readFileSync(agentTypeDefinitionPath, 'utf-8')
    : ''

  const analyzerContext = {
    agentDefinitions: Object.values(loadedAgents),
    agentTypeDefinition,
    testedAgentIds: agents,
  }

  const startTime = Date.now()
  const results: Record<string, AgentEvalResults> = {}

  const sink = createRunArtifactSink(
    options.artifactsRoot ?? path.join(__dirname, 'logs'),
    options.now?.() ?? new Date(),
  )
  const logsDir = sink.root
  const runId = randomUUID()
  const hash = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const measurement = {
    workloadHash: hash(
      commitsToRun.map(({ commit, evalData }) => ({
        commit,
        repoUrl: evalData.repoUrl,
        initCommand: evalData.initCommand,
        finalCheckCommands: evalData.finalCheckCommands,
        envHash: hash(evalData.env ?? {}),
      })),
    ),
    measurementConfigHash: hash({
      repeats,
      seed,
      taskConcurrency,
      providerRoutes: options.providerRoutes ?? {},
      executionScope: options.executionScope ?? 'trusted_task',
    }),
    evaluatorVersion: `buffbench-v2/bun-${Bun.version}/${hash(['run-buffbench.ts', 'agent-runner.ts', 'runners/codebuff.ts', 'judge.ts', 'statistics.ts', 'evaluation-artifacts.ts', 'evaluation-environment.ts', 'evaluation-model-attempts.ts'].map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8')))}`,
  }

  for (const agentId of agents) {
    results[agentId] = {
      agentId,
      runs: [],
      averageScore: 0,
      averageScoreExcludingFailures: 0,
      averageCost: 0,
      averageDuration: 0,
    }
  }

  const commitLimit = pLimit(taskConcurrency)

  // P0-T6: repeat each task N times for variance estimation. The seed is
  // recorded/logged for reproducibility (and passed to bootstrap callers); it
  // does not alter agent execution.
  if (repeats > 1) {
    commitsToRun = commitsToRun.flatMap((c) =>
      Array.from({ length: repeats }, (_, repeat) => ({ ...c, repeat })),
    )
    console.log(`Repeats: ${repeats} (seed ${seed})`)
  }

  const commitPromises = commitsToRun.map((entry, index) => {
    const { commit, evalData } = entry
    // Merge binaries env with this eval's env
    const mergedEnv = { ...binsEnv, ...evalData.env }

    return commitLimit(() =>
      runTask({
        client,
        commit,
        agents,
        repoUrl: evalData.repoUrl,
        initCommand: evalData.initCommand,
        env: mergedEnv,
        logsDir,
        artifactSink: sink,
        providerRoutes: options.providerRoutes,
        lessonsDir: options.lessonsDir,
        attempt: {
          ...measurement,
          runId,
          experimentId: options.experimentId ?? measurement.workloadHash,
          repeat: entry.repeat ?? 0,
        },
        executionScope: options.executionScope,
        runAgentOnCommitImpl: options.runAgentOnCommitImpl,
        index,
        totalTasks: commitsToRun.length,
        analyzerContext,
        localAgentDefinitions: analyzerContext.agentDefinitions,
        extractLessons,
        printEvents: agents.length === 1 && taskConcurrency === 1,
        finalCheckCommands: evalData.finalCheckCommands,
        cacheRecallEval: evalData.cacheRecallEval,
        disableAnalysis,
        saveTraces,
      }),
    )
  })

  const commitResults = await Promise.allSettled(commitPromises)

  for (const result of commitResults) {
    if (result.status === 'fulfilled') {
      const { agentResults } = result.value

      for (const { agentId, evalRun } of agentResults) {
        results[agentId].runs.push(evalRun)
      }
    } else {
      console.error('Commit processing failed:', result.reason)
    }
  }

  for (const agentData of Object.values(results)) {
    const { validRuns, measuredRuns } = summarizeAgentRuns(agentData)

    // M5-T7-R2: averageScore is a measured-quality metric. Synthetic all-zero
    // runs (all_judges_failed) are excluded so a judge outage never reads as
    // a true zero.
    agentData.averageScore =
      measuredRuns.length > 0
        ? measuredRuns.reduce((sum, r) => sum + r.judging.overallScore, 0) /
          measuredRuns.length
        : 0

    // P0-T6: mean±SE + score-per-dollar over the measured runs.
    agentData.measuredRunCount = measuredRuns.length
    agentData.scoreStandardError = standardError(
      measuredRuns.map((r) => r.judging.overallScore),
    )

    // Average over valid (non-agent-error) runs. The old ">1.0 score" trim is
    // gone: genuine low measured scores are real data, not failures.
    agentData.averageScoreExcludingFailures =
      measuredRuns.length > 0
        ? measuredRuns.reduce((sum, r) => sum + r.judging.overallScore, 0) /
          measuredRuns.length
        : 0

    const idiomScoredRuns = validRuns.filter(
      (
        run,
      ): run is EvalRun & { judging: JudgingResult & { idiomScore: number } } =>
        typeof run.judging.idiomScore === 'number',
    )
    agentData.averageIdiomScore =
      idiomScoredRuns.length > 0
        ? idiomScoredRuns.reduce((sum, r) => sum + r.judging.idiomScore, 0) /
          idiomScoredRuns.length
        : undefined

    agentData.totalCost = sumFiniteCosts(agentData.runs.map((run) => run.cost))
    agentData.costComplete = agentData.runs.every(
      (run) => run.costEvidence?.status === 'reported',
    )
    agentData.attemptCount = agentData.runs.length
    agentData.averageCost =
      agentData.runs.length > 0
        ? agentData.totalCost / agentData.runs.length
        : 0

    agentData.averageDuration =
      agentData.runs.length > 0
        ? agentData.runs.reduce((sum, r) => sum + r.durationMs, 0) /
          agentData.runs.length
        : 0

    // An incomplete cost population cannot support an efficiency claim.
    agentData.scorePerDollar =
      agentData.costComplete && agentData.averageCost > 0
        ? agentData.averageScore / agentData.averageCost
        : undefined

    // N10: per-model edit-commit / tool error / LSP call rates and the
    // agent definition's static prompt tokens.
    const definition = loadedAgents[agentData.agentId] as
      | StaticPromptDefinition
      | undefined
    const staticPromptTokens = definition
      ? await computeStaticPromptTokens(definition)
          .then((tokens) => tokens.total)
          .catch(() => undefined)
      : undefined
    agentData.qualityMetrics = aggregateQualityMetrics(
      agentData.runs.map((run) => run.qualityMetrics),
      {
        model:
          definition?.model ??
          agentData.runs.find((run) => run.providerRoute)?.providerRoute,
        staticPromptTokens,
      },
    )
  }

  const metaRecorder = recordEvaluatorModelAttempts(
    client,
    createArtifactSink(path.join(sink.root, 'sdk-attempts')),
    [],
    {
      ...measurement,
      runId,
      experimentId: options.experimentId ?? measurement.workloadHash,
    },
  )
  const metaAnalysis = disableAnalysis
    ? undefined
    : await analyzeAllTasks({
        env: options.evaluatorEnv,
        inheritEnv: options.executionScope !== 'key_free_environment',
        client: metaRecorder.client,
        logsDir,
        agents,
        analyzerContext,
      }).catch((error) => {
        sink.writeJson('meta-analysis-error.json', {
          error: formatUnknownError(error),
        })
        return undefined
      })

  if (metaAnalysis) {
    // Print meta-analysis results
    console.log('\n=== Meta-Analysis Results ===')
    console.log('\nOverall Comparison:')
    console.log(metaAnalysis.overallComparison)

    if (metaAnalysis.agentInsights.length > 0) {
      console.log('\nAgent-Specific Insights:')
      for (const insight of metaAnalysis.agentInsights) {
        console.log(`\n[${insight.agentId}]`)
        if (insight.consistentStrengths.length > 0) {
          console.log('  Strengths:', insight.consistentStrengths.join(', '))
        }
        if (insight.consistentWeaknesses.length > 0) {
          console.log('  Weaknesses:', insight.consistentWeaknesses.join(', '))
        }
      }
    }

    if (metaAnalysis.keyFindings.length > 0) {
      console.log('\nKey Findings:')
      metaAnalysis.keyFindings.forEach((finding, i) => {
        console.log(`  ${i + 1}. ${finding}`)
      })
    }
  }

  // M5-T7: snapshot the artifact listing immediately before writing
  // FINAL_RESULTS.json. The previous snapshot ran before meta-analysis and
  // before FINAL_RESULTS.json itself existed, so metadata.files silently
  // omitted artifacts the run actually produced.
  const logFiles = [
    ...fs
      .readdirSync(logsDir, { recursive: true, encoding: 'utf8' })
      .filter((file) => fs.statSync(path.join(logsDir, file)).isFile()),
    'FINAL_RESULTS.json',
  ].sort()

  const modelAttempts = [
    ...commitResults.flatMap((result) =>
      result.status === 'fulfilled' ? result.value.modelAttempts : [],
    ),
    ...metaRecorder.attempts,
  ]
  const auxiliaryAttempts = modelAttempts.filter(
    (attempt) => attempt.role === 'auxiliary',
  )
  const spend = {
    scope: 'agent_attempts_plus_available_auxiliary_sdk_attempts',
    agentCostUsd: sumFiniteCosts(
      Object.values(results).map((agent) => agent.totalCost ?? 0),
    ),
    availableAuxiliaryCostUsd: sumFiniteCosts(
      auxiliaryAttempts.map((attempt) => attempt.costUsd ?? 0),
    ),
    availableUnsettledTaskCostUsd: sumFiniteCosts(
      modelAttempts
        .filter(
          (attempt) =>
            attempt.role === 'task_agent' && attempt.phase === 'running',
        )
        .map((attempt) => attempt.costUsd ?? 0),
    ),
    auxiliaryAttemptCount: auxiliaryAttempts.length,
    unknownAuxiliaryCostAttempts: auxiliaryAttempts.filter(
      (attempt) => attempt.costEvidence.status !== 'reported',
    ).length,
    incompleteAuxiliaryCostAttempts: auxiliaryAttempts.filter(
      (attempt) => !attempt.costComplete,
    ).length,
    wholeExperimentCostComplete:
      Object.values(results).every((agent) => agent.costComplete) &&
      auxiliaryAttempts.every(
        (attempt) => attempt.costEvidence.status === 'reported',
      ) &&
      modelAttempts.every(
        (attempt) => attempt.phase === 'settled' && attempt.costComplete,
      ) &&
      commitResults.every((result) => result.status === 'fulfilled'),
  }
  const finalResults = {
    metadata: {
      runId,
      ...measurement,
      experimentId: options.experimentId ?? measurement.workloadHash,
      executionScope: options.executionScope ?? 'trusted_task',
      timestamp: new Date().toISOString(),
      evalDataPaths,
      agentsTested: agents,
      commitsEvaluated: commitsToRun.length,
      rejectedTasks: commitResults.flatMap((result, index) =>
        result.status === 'rejected'
          ? [
              {
                index,
                error: formatUnknownError(result.reason),
                costEvidence: { status: 'unknown' },
              },
            ]
          : [],
      ),
      totalCommitsInEval: allCommitsWithSource.length,
      evalFiles: loadedEvalFiles.map((f) => ({
        path: f.path,
        repoUrl: f.data.repoUrl,
        taskCount: f.data.evalCommits.length,
      })),
      totalDuration: Date.now() - startTime,
      logsDirectory: logsDir,
      files: logFiles,
      repeats,
      seed,
      costScope: 'agent_attempts',
    },
    spend,
    modelAttempts,
    metaAnalysis,
    // M5-T7: agent results are namespaced under `agents` so an agent id of
    // 'metadata' or 'metaAnalysis' can no longer clobber the reserved keys
    // via top-level key collision in FINAL_RESULTS.json.
    agents: { ...results },
  }

  const finalResultsPath = path.join(logsDir, 'FINAL_RESULTS.json')
  sink.writeJson(path.basename(finalResultsPath), finalResults)

  // Cleanup binaries installation
  if (binsTempDir) {
    try {
      fs.rmSync(binsTempDir, { recursive: true, force: true })
      console.log(`✓ Cleaned up binaries installation at ${binsTempDir}.`)
    } catch (error) {
      console.warn(`Warning: Failed to cleanup binaries directory:`, error)
    }
  }

  console.log(`Traces saved to ${logsDir}`)
  console.log('\n=== Harness quality (per model) ===')
  console.log(
    formatQualityMetricsTable(
      Object.fromEntries(
        Object.entries(results).map(([id, data]) => [id, data.qualityMetrics]),
      ),
    ),
  )
  console.log('\n=== Summary ===')
  for (const [agentId, data] of Object.entries(results)) {
    const { validRuns, measuredRuns } = summarizeAgentRuns(data)
    const errorCount = data.runs.length - validRuns.length
    console.log(`\n${agentId}:`)
    console.log(`  Average Score: ${data.averageScore.toFixed(2)}/10`)
    console.log(
      `  Score: ${data.averageScore.toFixed(2)} ± ${(data.scoreStandardError ?? 0).toFixed(2)} SE (${data.measuredRunCount ?? 0} measured)`,
    )
    console.log(`  Score/Cost: ${(data.scorePerDollar ?? 0).toFixed(2)}`)
    console.log(
      `  Average Score (measured, excluding failed judges): ${data.averageScoreExcludingFailures.toFixed(2)}/10 (${measuredRuns.length}/${validRuns.length} runs)`,
    )
    if (typeof data.averageIdiomScore === 'number') {
      console.log(
        `  Average Idiom Score: ${data.averageIdiomScore.toFixed(2)}/10`,
      )
    }
    console.log(`  Average Cost: ${data.averageCost.toFixed(4)}`)
    console.log(
      `  Average Duration: ${(data.averageDuration / 1000).toFixed(1)}s`,
    )
    console.log(
      `  Valid runs: ${validRuns.length}/${data.runs.length} (excluding ${errorCount} agent error(s))`,
    )
  }

  // Print all overall scores for distribution analysis
  console.log('\n=== Score Distribution ===')
  for (const [agentId, data] of Object.entries(results)) {
    const { validRuns } = summarizeAgentRuns(data)
    const scores = validRuns.map((r) => r.judging.overallScore.toFixed(1))
    const idiomScores = validRuns
      .map((r) => r.judging.idiomScore)
      .filter((score): score is number => typeof score === 'number')
      .map((score) => score.toFixed(1))
    console.log(`\n${agentId}:`)
    console.log(`  Scores: ${scores.join(', ')}`)
    if (idiomScores.length > 0) {
      console.log(`  Idiom Scores: ${idiomScores.join(', ')}`)
    }
  }

  return finalResults
}
