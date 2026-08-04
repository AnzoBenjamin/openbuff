
import { countTokensJson } from './token-counter'

import type {
  BudgetCategory,
  BudgetLine,
  ContextBudgetLedger,
} from '@codebuff/common/types/session-state'

// formatLedgerForCli lives in @codebuff/common so the CLI's /context command
// and this package share one implementation over the plain-JSON ledger type;
// re-exported here so existing `../context-budget` imports keep working.
export { formatLedgerForCli } from '@codebuff/common/util/context-budget'

// The ledger types are canonical in @codebuff/common
// (common/src/types/session-state.ts) because common must not import from
// agent-runtime. Re-exported here so this module's consumers
// (../context-budget import sites) keep working and the shapes stay aligned
// by construction rather than by a keep-in-sync comment.
export type { BudgetCategory, BudgetLine, ContextBudgetLedger }

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
  return Number.isFinite(tokens) ? Math.max(0, tokens) : 0
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
 * Clamps negative token counts to 0, then REASSIGNS `ledger.lines`,
 * `totalTokens`, and `byCategory` from the immutable {@link recordBlock}
 * result (leaving other fields like `windowTokens` and `compactedAtTurn`
 * untouched) and returns the same object. Because `lines` is replaced rather
 * than appended to, a caller holding a `lines` reference captured before this
 * call keeps the OLD array — always read `ledger.lines` after the call, not
 * a cached reference.
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
    const tokens = clampTokens(line.tokens)
    totalTokens += tokens
    byCategory[line.category] = (byCategory[line.category] ?? 0) + tokens
  }
  return {
    ...ledger,
    totalTokens,
    byCategory,
  }
}

/**
 * Returns a NEW ledger annotated as recorded before the last /compact.
 * The ledger is system-prompt telemetry: compaction only shrinks
 * messageHistory (which the ledger never records), so the breakdown still
 * describes the byte-identical cached system prompt. Annotating (rather
 * than discarding) lets /context surface a staleness note over accurate
 * data. Idempotent: annotating an already-annotated ledger returns an
 * equivalent object.
 */
export function annotateLedgerAfterCompaction(
  ledger: ContextBudgetLedger,
): ContextBudgetLedger {
  return {
    ...ledger,
    compactedAtTurn: true,
  }
}
