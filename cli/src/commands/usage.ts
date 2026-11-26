import { usageSnapshot } from '../utils/usage-observations'
import { useChatStore } from '../state/chat-store'
import { getSystemMessage } from '../utils/message-history'

const tokens = (count: number, complete: boolean) =>
  `${count.toLocaleString('en-US')}${complete ? '' : ' known subtotal · incomplete'}`
const cents = (value: number) =>
  `$${(value / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`

/** Local retained telemetry only; this command never resolves provider credentials or calls a model. */
export function formatUsageReport(): string {
  const state = useChatStore.getState(),
    usage = usageSnapshot(state.chatSessionId)
  const ledger =
    state.runState?.sessionState?.mainAgentState.contextBudgetLedger
  const context = ledger
    ? `${ledger.totalTokens.toLocaleString('en-US')} / ${ledger.windowTokens.toLocaleString('en-US')} tokens${ledger.compactedAtTurn ? ' · prior prompt snapshot' : ' · last prompt-build snapshot'}`
    : 'not reported'
  if (!usage.observations)
    return [
      'Usage · local session observations',
      'No usage events observed in this process for this conversation yet.',
      'Restored history and provider billing are not reconstructed from legacy finish cost fields.',
      `Context: ${context}`,
    ].join('\n')
  const recent = usage.rows.slice(-20)
  return [
    'Usage · local session observations',
    `${usage.observations} observed request usage events (root and descendants).`,
    'Scope: this process and conversation only; failures without usage and earlier restored history may be absent.',
    ...(usage.aggregateOverflow
      ? [
          'Aggregate limit exceeded: displayed totals are retained known subtotals, not complete usage/cost totals.',
        ]
      : []),
    `Input: ${tokens(usage.inputTokens, usage.inputComplete && !usage.aggregateOverflow)}`,
    `Output: ${tokens(usage.outputTokens, usage.outputComplete && !usage.aggregateOverflow)}`,
    `Cache read: ${tokens(usage.cachedInputTokens, usage.cacheComplete && !usage.aggregateOverflow)}`,
    `Cache write: ${tokens(usage.cacheWriteInputTokens, usage.cacheWriteComplete && !usage.aggregateOverflow)}`,
    `Known cost subtotal: ${cents(usage.knownCostCents)}${usage.unknownCosts ? ` · ${usage.unknownCosts} request cost(s) unknown` : ''}`,
    ...(usage.subscriptionRequests
      ? [
          `Subscription requests: ${usage.subscriptionRequests} · not per-token billed by Openbuff.`,
        ]
      : []),
    `Context: ${context}`,
    `Recent ${recent.length}/${usage.observations} observations${usage.omittedRows ? `; ${usage.omittedRows} older detail rows dropped, cumulative totals retained` : ''}:`,
    ...recent.map(
      (row) =>
        `- ${row.model ?? 'model unavailable'} · run=${row.runId} · in=${row.inputTokens ?? '?'} out=${row.outputTokens ?? '?'} cache-read=${row.cachedInputTokens ?? '?'} cache-write=${row.cacheWriteInputTokens ?? '?'} · ${row.costStatus === 'subscription' ? 'subscription' : row.costCents !== undefined && (row.costStatus === 'observed' || row.costStatus === 'estimated') ? `${cents(row.costCents)} ${row.costStatus}` : `unknown: ${row.costReason ?? 'no complete price/cost observation'}`}`,
    ),
    'Catalog/configured-price totals are estimates, not exact provider bills or durable spending reservations.',
  ].join('\n')
}
export function handleUsageCommand() {
  const report = formatUsageReport()
  return {
    postUserMessage: (previous: import('../types/chat').ChatMessage[]) => [
      ...previous,
      getSystemMessage(report),
    ],
  }
}
