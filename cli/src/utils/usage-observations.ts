import {
  printModeUsageSchema,
  type PrintModeUsage,
} from '@codebuff/common/types/print-mode'

export type UsageSnapshot = {
  observations: number
  inputTokens: number
  outputTokens: number
  cacheWriteInputTokens: number
  cacheWriteComplete: boolean
  cachedInputTokens: number
  inputComplete: boolean
  outputComplete: boolean
  cacheComplete: boolean
  knownCostCents: number
  unknownCosts: number
  subscriptionRequests: number
  omittedRows: number
  aggregateOverflow: boolean
  rows: Array<PrintModeUsage & { turnMessageId: string }>
}
const sessions = new Map<string, UsageSnapshot>()
const empty = (): UsageSnapshot => ({
  observations: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteInputTokens: 0,
  cacheWriteComplete: true,
  cachedInputTokens: 0,
  inputComplete: true,
  outputComplete: true,
  cacheComplete: true,
  knownCostCents: 0,
  unknownCosts: 0,
  subscriptionRequests: 0,
  omittedRows: 0,
  aggregateOverflow: false,
  rows: [],
})

/** Process-local observed events only; no persisted/live billing inference or count-based dedup. */
export function recordUsageObservation(
  sessionId: string,
  turnMessageId: string,
  candidate: unknown,
): void {
  const parsed = printModeUsageSchema.safeParse(candidate)
  if (!parsed.success || !sessionId || !turnMessageId) return
  const source = parsed.data
  // Capture an explicit bounded DTO; no credentials, prompt bodies, or arbitrary peer fields enter this store.
  const event: PrintModeUsage = {
    type: 'usage',
    runId: source.runId.slice(0, 256),
    agentId: source.agentId?.slice(0, 256),
    model: source.model?.slice(0, 256),
    inputTokens: source.inputTokens,
    outputTokens: source.outputTokens,
    cacheWriteInputTokens: source.cacheWriteInputTokens,
    cachedInputTokens: source.cachedInputTokens,
    totalTokens: source.totalTokens,
    complete: source.complete,
    costCents: source.costCents,
    costStatus: source.costStatus,
    costReason: source.costReason?.slice(0, 512),
  }
  const snapshot = sessions.get(sessionId) ?? empty()
  snapshot.observations++
  const add = (current: number, value: number, integer: boolean) => {
    const sum = current + value
    if (!Number.isFinite(sum) || (integer && !Number.isSafeInteger(sum))) {
      snapshot.aggregateOverflow = true
      return current
    }
    return sum
  }
  snapshot.inputTokens = add(snapshot.inputTokens, event.inputTokens ?? 0, true)
  snapshot.outputTokens = add(
    snapshot.outputTokens,
    event.outputTokens ?? 0,
    true,
  )
  snapshot.cachedInputTokens = add(
    snapshot.cachedInputTokens,
    event.cachedInputTokens ?? 0,
    true,
  )
  snapshot.cacheWriteInputTokens = add(
    snapshot.cacheWriteInputTokens,
    event.cacheWriteInputTokens ?? 0,
    true,
  )
  snapshot.cacheWriteComplete &&= event.cacheWriteInputTokens !== undefined
  snapshot.inputComplete &&= event.inputTokens !== undefined

  snapshot.outputComplete &&= event.outputTokens !== undefined
  snapshot.cacheComplete &&= event.cachedInputTokens !== undefined
  if (event.costStatus === 'subscription') snapshot.subscriptionRequests++
  else if (
    (event.costStatus === 'observed' || event.costStatus === 'estimated') &&
    event.costCents !== undefined
  )
    snapshot.knownCostCents = add(
      snapshot.knownCostCents,
      event.costCents,
      false,
    )
  else snapshot.unknownCosts++
  snapshot.rows.push({ ...event, turnMessageId: turnMessageId.slice(0, 256) })
  if (snapshot.rows.length > 100) {
    snapshot.omittedRows += snapshot.rows.length - 100
    snapshot.rows = snapshot.rows.slice(-100)
  }
  sessions.delete(sessionId)
  sessions.set(sessionId, snapshot)
  while (sessions.size > 8) sessions.delete(sessions.keys().next().value!)
}
export function usageSnapshot(sessionId: string): UsageSnapshot {
  const snapshot = sessions.get(sessionId) ?? empty()
  return { ...snapshot, rows: snapshot.rows.map((row) => ({ ...row })) }
}
export function clearUsageObservations(): void {
  sessions.clear()
}
