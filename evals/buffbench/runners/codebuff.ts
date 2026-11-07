import { execFileSync } from 'child_process'
import { randomUUID } from 'node:crypto'
import {
  artifactId,
  type EvaluationArtifactSink,
} from '../evaluation-artifacts'
import type { RunOutcome } from '@codebuff/common/types/run-outcome'

import type { Runner, RunnerResult, AgentStep, RunnerOptions } from './runner'
import type { OpenbuffClient } from '@openbuff/sdk'

const DEBUG_ERROR = true

export class CodebuffRunner implements Runner {
  private cwd: string
  private env?: Record<string, string>
  private client: OpenbuffClient
  private agentId: string
  private localAgentDefinitions: any[]
  private printEvents: boolean
  private commitId: string
  private parentSha: string
  private artifactSink?: EvaluationArtifactSink
  private inheritEnv: boolean

  constructor(options: {
    cwd: string
    env?: Record<string, string>
    client: OpenbuffClient
    agentId: string
    localAgentDefinitions: any[]
    printEvents: boolean
    commitId: string
    parentSha: string
    artifactSink?: EvaluationArtifactSink
    inheritEnv?: boolean
  }) {
    this.cwd = options.cwd
    this.env = options.env
    this.client = options.client
    this.agentId = options.agentId
    this.localAgentDefinitions = options.localAgentDefinitions
    this.printEvents = options.printEvents
    this.commitId = options.commitId
    this.parentSha = options.parentSha
    this.artifactSink = options.artifactSink
    this.inheritEnv = options.inheritEnv ?? true
  }

  async run(
    prompt: string,
    options: RunnerOptions = {},
  ): Promise<RunnerResult> {
    const steps: AgentStep[] = []
    let totalCostUsd = 0

    /**
     * Streaming-aggregated cost in USD, accumulated from `finish` events emitted
     * during the run. This is a defensive SECOND source of cost, complementing
     * the post-run `result.sessionState.mainAgentState.creditsUsed`.
     *
     * Why two sources: for routed providers (e.g. iamhc/glm-5.2) the post-run
     * `creditsUsed` field is NOT populated — every step's `onCostCalculated`
     * callback either never fires or fires with 0, so `creditsUsed` stays 0 and
     * the cost-to-value signal is lost. The `finish` PrintModeEvent carries a
     * `totalCost` field that the SDK reports alongside `creditsUsed`; by also
     * accumulating it here we capture cost even when the post-run field is
     * absent. We prefer `creditsUsed` when present (it is the authoritative
     * per-turn accounting) and fall back to the streaming aggregate otherwise.
     *
     * Assumption: every cost-bearing event reports cost in the same unit as
     * `creditsUsed` (i.e. US cents), so we divide by 100 to get USD, matching the
     * existing `creditsUsed / 100` conversion below. If events only carried raw
     * token counts we'd need a per-model price lookup, but the `finish` event's
     * `totalCost` is already credit-denominated (cents), so the simple division
     * is correct.
     */
    let streamedCostUsd = 0
    let streamedCostReported = false
    let runError: string | undefined
    let result: Awaited<ReturnType<OpenbuffClient['run']>> | undefined
    const saveError = (value: unknown) => {
      if (DEBUG_ERROR && this.artifactSink)
        this.artifactSink.writeJson(
          `${artifactId(this.commitId)}-${artifactId(this.agentId)}-error-${randomUUID()}.json`,
          value,
        )
    }

    const maxAgentSteps = 40
    try {
      result = await this.client.run({
        agent: this.agentId,
        prompt,
        agentDefinitions: this.localAgentDefinitions,
        cwd: this.cwd,
        env: this.env,
        inheritEnv: this.inheritEnv,
        maxAgentSteps,
        signal: options.signal,
        handleEvent: (event) => {
          if (
            (event.type === 'tool_call' || event.type === 'tool_result') &&
            event.toolName === 'set_messages'
          ) {
            return
          }
          // Accumulate cost from streaming `finish` events. The `finish` event's
          // `totalCost` is reported in cents (same as `creditsUsed`), so divide by
          // 100 to USD and sum across every finish in the run (subagent + main).
          if (
            event.type === 'finish' &&
            typeof event.totalCost === 'number' &&
            Number.isFinite(event.totalCost) &&
            event.totalCost >= 0
          ) {
            streamedCostReported = true
            streamedCostUsd += event.totalCost / 100
            streamedCostReported = Number.isFinite(streamedCostUsd)
          }
          if (event.type === 'error') {
            console.error(
              `[${this.commitId}:${this.agentId}] Error event:`,
              event.message,
            )
            if (!event.message.startsWith('Invalid JSON'))
              saveError({ error: event.message, trace: steps })
          } else if (this.printEvents) {
            console.log(
              `[${this.commitId}:${this.agentId}]`,
              JSON.stringify(event, null, 2),
            )
          }
          steps.push(event)
        },
      })
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error)
      saveError({ error: runError, trace: steps })
    }
    if (result?.output.type === 'error') {
      runError = result.output.message
      saveError({ ...result.output, trace: steps })
    }
    let runOutcome: RunOutcome = result?.runOutcome ??
      result?.sessionState?.mainAgentState?.runOutcome ?? {
        termination: options.signal?.aborted
          ? 'cancelled'
          : runError !== undefined
            ? 'failed'
            : 'completed',
      }
    if (runError !== undefined && runOutcome.termination === 'completed')
      runOutcome = { ...runOutcome, termination: 'failed' }
    if (runOutcome.termination !== 'completed') {
      runError ??= runOutcome.cause?.message ?? `Run ${runOutcome.termination}`
    }

    const mainAgentState = result?.sessionState?.mainAgentState
    // Prefer the authoritative post-run `creditsUsed` (credited per-turn,
    // summed across steps). When it's 0/absent — the routed-provider case —
    // fall back to `directCreditsUsed` (a sibling session-state cost field that
    // mirrors `creditsUsed`'s accumulation), and finally to the
    // streaming-aggregated cost. All three are credit-denominated (cents), so
    // each is divided by 100 to USD. cachedInputTokens / inputTokens still read
    // from mainAgentState exactly as before (those were NOT reported missing).
    const creditsUsed =
      Number.isFinite(mainAgentState?.creditsUsed) &&
      (mainAgentState?.creditsUsed ?? -1) >= 0
        ? mainAgentState!.creditsUsed
        : 0
    const directCreditsUsed =
      Number.isFinite(mainAgentState?.directCreditsUsed) &&
      (mainAgentState?.directCreditsUsed ?? -1) >= 0
        ? mainAgentState!.directCreditsUsed
        : 0
    if (creditsUsed > 0) {
      totalCostUsd = creditsUsed / 100
    } else if (directCreditsUsed > 0) {
      totalCostUsd = directCreditsUsed / 100
    } else {
      totalCostUsd = Number.isFinite(streamedCostUsd) ? streamedCostUsd : 0
    }

    const cachedInputTokens = mainAgentState?.cacheInputTokens
    const inputTokens = mainAgentState?.cacheTotalInputTokens
    const finalMessageHistoryText = mainAgentState?.messageHistory
      ? JSON.stringify(mainAgentState.messageHistory)
      : undefined

    // If the agent actually did work (produced step events) but we still have
    // no cost, flag it. For routed providers where none of `creditsUsed`,
    // `directCreditsUsed`, nor any streamed `finish.totalCost` was populated,
    // the cost truly cannot be aggregated from the available signals — this
    // keeps the meta-analysis from misinterpreting cost:0 as a "free run".
    if (totalCostUsd === 0 && steps.length > 0) {
      console.warn(
        `[${this.commitId}:${this.agentId}] Cost could not be aggregated for this provider route (creditsUsed=${creditsUsed}, directCreditsUsed=${directCreditsUsed}, streamedCostUsd=${streamedCostUsd}); reporting cost:0 as a known limitation.`,
      )
    }

    // Get git diff after Codebuff has made changes
    let diff = ''
    try {
      execFileSync('git', ['add', '--', '.'], {
        cwd: this.cwd,
        env: this.env,
        stdio: 'ignore',
      })
      diff = execFileSync('git', ['diff', this.parentSha, '--'], {
        cwd: this.cwd,
        env: this.env,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      })
    } catch {
      // Ignore git errors
    }

    return {
      steps,
      totalCostUsd,
      diff,
      error: runError,
      runOutcome,
      costEvidence: {
        status:
          creditsUsed > 0 || directCreditsUsed > 0 || streamedCostReported
            ? 'reported'
            : 'unknown',
        source:
          creditsUsed > 0
            ? 'creditsUsed'
            : directCreditsUsed > 0
              ? 'directCreditsUsed'
              : streamedCostReported
                ? 'finish.totalCost'
                : undefined,
      },
      cachedInputTokens,
      inputTokens,
      finalMessageHistoryText,
    }
  }
}
