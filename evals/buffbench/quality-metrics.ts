/**
 * N10 per-run harness quality metrics, computed from the agent trace.
 *
 * - edit-commit rate: edit tool results that committed / edit tool results.
 * - tool error rate: tool results that errored / tool results.
 * - LSP call rate: LSP tool calls / tool calls.
 *
 * Results include subagent events (editor and other spawned agents do the
 * edits). Pure: no I/O.
 */
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'apply_patch',
  'edit_transaction',
  'replace_range',
  'rewrite_symbol',
  'str_replace',
  'write_file',
])

export const LSP_TOOL_NAMES: ReadonlySet<string> = new Set([
  'code_action',
  'extract_symbol',
  'find_references',
  'go_to_definition',
  'hover_type',
  'rename_symbol',
  'workspace_symbol',
])

export interface RunQualityMetrics {
  toolCallCount: number
  toolResultCount: number
  toolErrorCount: number
  editResultCount: number
  editCommittedCount: number
  lspCallCount: number
}

export interface QualityRates {
  /** Committed edit results / edit results. Undefined when no edits ran. */
  editCommitRate?: number
  /** Errored tool results / tool results. Undefined when no tools ran. */
  toolErrorRate?: number
  /** LSP tool calls / tool calls. Undefined when no tools ran. */
  lspCallRate?: number
}

export interface AgentQualityMetrics extends RunQualityMetrics, QualityRates {
  runCount: number
  /** Model id from the agent definition, when known. */
  model?: string
  /**
   * Fixed prompt cost of the agent definition: system, instructions and step
   * prompts plus the tool definitions it sends, in estimated tokens.
   */
  staticPromptTokens?: number
}

type ToolResultEvent = Extract<PrintModeEvent, { type: 'tool_result' }>

function hasErrorField(value: unknown, depth = 0): boolean {
  if (depth > 3 || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.some((item) => hasErrorField(item, depth + 1))
  }
  const record = value as Record<string, unknown>
  if (typeof record.errorMessage === 'string' && record.errorMessage)
    return true
  if (typeof record.error === 'string' && record.error) return true
  return false
}

/** True when the tool result reports a failure. */
export function isToolResultError(event: ToolResultEvent): boolean {
  const outcome = event.actionOutcome?.outcome
  if (outcome === 'failed' || outcome === 'refused' || outcome === 'cancelled')
    return true
  if (outcome === 'succeeded') return false
  return event.output.some(
    (part) => part.type === 'json' && hasErrorField(part.value),
  )
}

/** True when an edit tool result committed its change. */
export function isEditCommitted(event: ToolResultEvent): boolean {
  if (isToolResultError(event)) return false
  const outcome = event.actionOutcome?.outcome
  // `uncertain` means the runtime could not confirm the write.
  return outcome === undefined || outcome === 'succeeded'
}

export function computeRunQualityMetrics(
  trace: readonly PrintModeEvent[],
): RunQualityMetrics {
  const metrics: RunQualityMetrics = {
    toolCallCount: 0,
    toolResultCount: 0,
    toolErrorCount: 0,
    editResultCount: 0,
    editCommittedCount: 0,
    lspCallCount: 0,
  }
  for (const event of trace) {
    if (event.type === 'tool_call') {
      metrics.toolCallCount += 1
      if (LSP_TOOL_NAMES.has(event.toolName)) metrics.lspCallCount += 1
      continue
    }
    if (event.type !== 'tool_result') continue
    metrics.toolResultCount += 1
    if (isToolResultError(event)) metrics.toolErrorCount += 1
    if (EDIT_TOOL_NAMES.has(event.toolName)) {
      metrics.editResultCount += 1
      if (isEditCommitted(event)) metrics.editCommittedCount += 1
    }
  }
  return metrics
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator > 0 ? numerator / denominator : undefined
}

export function qualityRates(metrics: RunQualityMetrics): QualityRates {
  return {
    editCommitRate: ratio(metrics.editCommittedCount, metrics.editResultCount),
    toolErrorRate: ratio(metrics.toolErrorCount, metrics.toolResultCount),
    lspCallRate: ratio(metrics.lspCallCount, metrics.toolCallCount),
  }
}

/**
 * Pool per-run counts for one agent (one model) and derive the rates from
 * the pooled counts, so long runs weigh more than short ones.
 */
export function aggregateQualityMetrics(
  runs: ReadonlyArray<RunQualityMetrics | undefined>,
  extra: { model?: string; staticPromptTokens?: number } = {},
): AgentQualityMetrics {
  const pooled: RunQualityMetrics = {
    toolCallCount: 0,
    toolResultCount: 0,
    toolErrorCount: 0,
    editResultCount: 0,
    editCommittedCount: 0,
    lspCallCount: 0,
  }
  let runCount = 0
  for (const run of runs) {
    if (!run) continue
    runCount += 1
    for (const key of Object.keys(pooled) as (keyof RunQualityMetrics)[]) {
      pooled[key] += run[key]
    }
  }
  return {
    runCount,
    ...pooled,
    ...qualityRates(pooled),
    ...(extra.model !== undefined && { model: extra.model }),
    ...(extra.staticPromptTokens !== undefined && {
      staticPromptTokens: extra.staticPromptTokens,
    }),
  }
}

function pct(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

/** Markdown table: one row per agent/model. */
export function formatQualityMetricsTable(
  byAgent: Record<string, AgentQualityMetrics | undefined>,
): string {
  const lines = [
    '| Agent | Model | Runs | Edit-commit rate | Tool error rate | LSP call rate | Static prompt tokens |',
    '|-------|-------|------|------------------|-----------------|---------------|----------------------|',
  ]
  for (const [agentId, metrics] of Object.entries(byAgent)) {
    if (!metrics) continue
    lines.push(
      `| ${agentId} | ${metrics.model ?? 'n/a'} | ${metrics.runCount} | ${pct(metrics.editCommitRate)} (${metrics.editCommittedCount}/${metrics.editResultCount}) | ${pct(metrics.toolErrorRate)} (${metrics.toolErrorCount}/${metrics.toolResultCount}) | ${pct(metrics.lspCallRate)} (${metrics.lspCallCount}/${metrics.toolCallCount}) | ${metrics.staticPromptTokens ?? 'n/a'} |`,
    )
  }
  return lines.join('\n')
}
