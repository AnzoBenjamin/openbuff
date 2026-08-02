
import { countTokensJson } from './token-counter'

/**
 * Fixed-baseline, injection, and conversation buckets tracked by the
 * per-turn context-budget ledger (M1-T1).
 *
 * The conversation/tool-results buckets exist for later M1-T3 wiring into the
 * trim path; this module just defines them.
 */
export type BudgetCategory =
  | 'systemPrompt'
  | 'fileTree'
  | 'knowledge'
  | 'systemInfo'
  | 'gitChanges'
  | 'proactiveRetrieval'
  | 'gitObservation'
  | 'patterns'
  | 'languageProfile'
  | 'tools'
  | 'conversation'
  | 'other'

export interface BudgetLine {
  category: BudgetCategory
  label: string
  tokens: number
  cacheable: boolean
}

export interface ContextBudgetLedger {
  lines: BudgetLine[]
  totalTokens: number
  byCategory: Record<string, number>
  windowTokens: number
}

export function createBudgetLedger(params: {
  windowTokens: number
}): ContextBudgetLedger {
  return {
    lines: [],
    totalTokens: 0,
    byCategory: {},
    windowTokens: params.windowTokens,
  }
}

function clampTokens(tokens: number): number {
  return Math.max(0, tokens)
}

export function recordBlock(
  ledger: ContextBudgetLedger,
  line: BudgetLine,
): ContextBudgetLedger {
  const tokens = clampTokens(line.tokens)
  const recordedLine: BudgetLine = { ...line, tokens }
  return {
    ...ledger,
    lines: [...ledger.lines, recordedLine],
    totalTokens: ledger.totalTokens + tokens,
    byCategory: {
      ...ledger.byCategory,
      [line.category]: (ledger.byCategory[line.category] ?? 0) + tokens,
    },
  }
}

export interface MeasureParams {
  category: BudgetCategory
  label: string
  content: string | object
  cacheable?: boolean
}

function buildLine(params: MeasureParams, tokens: number): BudgetLine {
  return {
    category: params.category,
    label: params.label,
    tokens,
    cacheable: params.cacheable ?? true,
  }
}

export function measureBlock(
  ledger: ContextBudgetLedger,
  params: MeasureParams,
): { ledger: ContextBudgetLedger; tokens: number } {
  const tokens = countTokensJson(params.content)
  const nextLedger = recordBlock(ledger, buildLine(params, tokens))
  return { ledger: nextLedger, tokens }
}

/**
 * Mutable, in-place variant of {@link recordBlock} used by production wiring.
 *
 * The per-turn ledger is created once by the orchestrator and shared across
 * every injected-block builder. Those builders return prompt strings, so they
 * cannot thread a new immutable ledger back to the caller. Instead, they push
 * their recorded line into the SAME ledger object the caller already holds.
 * `recordBlock` remains the pure/immutable variant for pure use.
 *
 * Clamps negative token counts to 0, pushes the line onto `ledger.lines`,
 * accumulates `totalTokens` and `byCategory`, and returns the same object.
 */
export function applyRecord(
  ledger: ContextBudgetLedger,
  line: BudgetLine,
): ContextBudgetLedger {
  const recorded = recordBlock(ledger, line)
  ledger.lines = recorded.lines
  ledger.totalTokens = recorded.totalTokens
  ledger.byCategory = recorded.byCategory
  return ledger
}

/**
 * Mutable, in-place variant of {@link measureBlock}. Measures `content` with
 * `countTokensJson` and records the resulting line via {@link applyRecord},
 * mutating and returning the same ledger the caller passed in.
 */
export function applyMeasure(
  ledger: ContextBudgetLedger,
  params: MeasureParams,
): { ledger: ContextBudgetLedger; tokens: number } {
  const tokens = countTokensJson(params.content)
  const nextLedger = applyRecord(ledger, buildLine(params, tokens))
  return { ledger: nextLedger, tokens }
}

export function finalizeLedger(
  ledger: ContextBudgetLedger,
): ContextBudgetLedger {
  const byCategory: Record<string, number> = {}
  let totalTokens = 0
  for (const line of ledger.lines) {
    totalTokens += line.tokens
    byCategory[line.category] = (byCategory[line.category] ?? 0) + line.tokens
  }
  return {
    ...ledger,
    totalTokens,
    byCategory,
  }
}

export function formatLedgerForCli(ledger: ContextBudgetLedger): string {
  const lines: string[] = []
  lines.push('Context Budget Breakdown')
  lines.push('------------------------')

  const categories = Object.keys(ledger.byCategory)
  const labelWidth = Math.max(
    ...categories.map((category) => category.length),
    'category'.length,
  )

  for (const category of categories) {
    const tokens = ledger.byCategory[category]
    const percent =
      ledger.windowTokens > 0
        ? ((tokens / ledger.windowTokens) * 100).toFixed(1)
        : '0.0'
    lines.push(
      `${category.padEnd(labelWidth)}  ${String(tokens).padStart(8)}  ${percent.padStart(5)}%`,
    )
  }

  const totalPercent =
    ledger.windowTokens > 0
      ? ((ledger.totalTokens / ledger.windowTokens) * 100).toFixed(1)
      : '0.0'
  lines.push(
    `${'total'.padEnd(labelWidth)}  ${String(ledger.totalTokens).padStart(8)}  ${totalPercent.padStart(5)}%`,
  )
  lines.push(
    `${'window'.padEnd(labelWidth)}  ${String(ledger.windowTokens)}`,
  )

  return lines.join('\n')
}
