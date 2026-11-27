import { randomUUID } from 'node:crypto'
import type { OpenbuffClient } from '@openbuff/sdk'
import type { EvaluationArtifactSink } from './evaluation-artifacts'
import type { EvalAttemptEvidence } from './types'

export interface EvaluatorModelAttempt extends EvalAttemptEvidence {
  attemptId: string
  agentId: string
  role: 'task_agent' | 'auxiliary'
  requestedModel?: string
  phase: 'running' | 'settled'
  startedAt: string
  durationMs: number
  output?: unknown
  error?: string
  events: unknown[]
  costUsd: number | null
  /** False when only a paid prefix survived a throw, cancellation or truncation. */
  costComplete: boolean
  costEvidence: { status: 'reported' | 'unknown'; source?: string }
}

/** Records every resolved, failed and paid SDK call without storing input env. */
export function recordEvaluatorModelAttempts(
  client: OpenbuffClient,
  sink: EvaluationArtifactSink,
  taskAgents: readonly string[],
  context: EvalAttemptEvidence = {},
  providerRoutes: Record<string, string> = {},
) {
  const attempts: EvaluatorModelAttempt[] = []
  const run: OpenbuffClient['run'] = async (input) => {
    const started = Date.now()
    const events: unknown[] = []
    let streamedCost = 0
    let streamedReported = false
    let result: Awaited<ReturnType<OpenbuffClient['run']>> | undefined
    let error: { value: unknown } | undefined
    const attempt: EvaluatorModelAttempt = {
      ...context,
      attemptId: randomUUID(),
      agentId: typeof input.agent === 'string' ? input.agent : 'unreported',
      providerRoute:
        typeof input.agent === 'string'
          ? (providerRoutes[input.agent] ?? 'unreported')
          : 'unreported',
      requestedModel:
        typeof input.agent === 'string'
          ? input.agentDefinitions?.find(
              (definition) => definition.id === input.agent,
            )?.model
          : undefined,
      role:
        typeof input.agent === 'string' && taskAgents.includes(input.agent)
          ? 'task_agent'
          : 'auxiliary',
      phase: 'running',
      startedAt: new Date(started).toISOString(),
      durationMs: 0,
      events,
      costUsd: null,
      costComplete: false,
      costEvidence: { status: 'unknown' },
    }
    attempts.push(attempt)
    sink.writeJson(`${attempt.attemptId}-started.json`, attempt)
    try {
      result = await client.run({
        ...input,
        handleEvent: (event) => {
          events.push(event)
          if (
            event.type === 'finish' &&
            typeof event.totalCost === 'number' &&
            Number.isFinite(event.totalCost) &&
            event.totalCost >= 0
          ) {
            streamedCost += event.totalCost / 100
            streamedReported = Number.isFinite(streamedCost)
            attempt.costUsd = streamedReported ? streamedCost : null
            attempt.costEvidence = streamedReported
              ? { status: 'reported', source: 'finish.totalCost' }
              : { status: 'unknown' }
          }
          sink.writeJson(`${attempt.attemptId}-event-${events.length}.json`, {
            attemptId: attempt.attemptId,
            event,
            costUsd: attempt.costUsd,
            costEvidence: attempt.costEvidence,
          })
          input.handleEvent?.(event)
        },
      })
      return result
    } catch (caught) {
      error = { value: caught }
      throw caught
    } finally {
      const state = result?.sessionState?.mainAgentState
      const reported = [
        { value: state?.creditsUsed, source: 'creditsUsed' },
        { value: state?.directCreditsUsed, source: 'directCreditsUsed' },
      ].find(
        (entry) =>
          typeof entry.value === 'number' &&
          Number.isFinite(entry.value) &&
          entry.value > 0,
      )
      const settled: EvaluatorModelAttempt = {
        ...context,
        requestedModel: attempt.requestedModel,
        attemptId: attempt.attemptId,
        agentId: typeof input.agent === 'string' ? input.agent : 'unreported',
        providerRoute:
          typeof input.agent === 'string'
            ? (providerRoutes[input.agent] ?? 'unreported')
            : 'unreported',
        role:
          typeof input.agent === 'string' && taskAgents.includes(input.agent)
            ? 'task_agent'
            : 'auxiliary',
        phase: 'settled',
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        output: result?.output,
        runOutcome: result?.runOutcome,
        error: error
          ? error.value instanceof Error
            ? error.value.message
            : String(error.value)
          : result?.output.type === 'error'
            ? result.output.message
            : undefined,
        events,
        costUsd: reported
          ? reported.value! / 100
          : streamedReported
            ? streamedCost
            : null,
        costComplete: Boolean(result && (reported || streamedReported)),
        costEvidence: reported
          ? { status: 'reported', source: reported.source }
          : streamedReported
            ? { status: 'reported', source: 'finish.totalCost' }
            : { status: 'unknown' },
      }
      Object.assign(attempt, settled)
      sink.writeJson(`${attempt.attemptId}-settled.json`, attempt)
    }
  }
  return {
    client: new Proxy(client, {
      get(target, property) {
        return property === 'run' ? run : Reflect.get(target, property, target)
      },
    }),
    attempts,
  }
}
