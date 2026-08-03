import type { ContextBudgetLedger } from '../types/session-state'

/**
 * Formats the per-turn context-budget ledger for terminal display.
 * Lives in common (operating on the plain-JSON {@link ContextBudgetLedger}
 * stored on AgentState) so both the agent-runtime package and the CLI's
 * /context command share one implementation. Output is byte-stable; the
 * /context command and its tests depend on the exact format.
 */
function sanitizeLedgerNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0
}

export function formatLedgerForCli(ledger: ContextBudgetLedger): string {
  const lines: string[] = []
  lines.push('Context Budget Breakdown')
  lines.push('------------------------')

  const byCategory =
    ledger.byCategory !== null &&
    typeof ledger.byCategory === 'object' &&
    !Array.isArray(ledger.byCategory)
      ? ledger.byCategory
      : {}
  const totalTokens = sanitizeLedgerNumber(ledger.totalTokens)
  const windowTokens = sanitizeLedgerNumber(ledger.windowTokens)
  const categories = Object.keys(byCategory)
  // Loops rather than Math.max(...spread): a malformed persisted ledger with
  // a huge byCategory could exceed the engine's argument-count limit and
  // throw RangeError. Computes the identical widths for every input.
  // tokenWidth floors at 8 (the historical fixed width) so ledgers whose
  // numbers all fit in 8 digits keep their previous column widths; a wider
  // number widens every row, window row included, keeping the token column
  // aligned. Widths derive from the sanitized numbers, not raw values.
  let labelWidth = 'category'.length
  let tokenWidth = Math.max(
    8,
    String(totalTokens).length,
    String(windowTokens).length,
  )
  for (const category of categories) {
    if (category.length > labelWidth) labelWidth = category.length
    const tokenText = String(sanitizeLedgerNumber(byCategory[category]))
    if (tokenText.length > tokenWidth) tokenWidth = tokenText.length
  }

  for (const category of categories) {
    const tokens = sanitizeLedgerNumber(byCategory[category])
    const percent =
      windowTokens > 0
        ? ((tokens / windowTokens) * 100).toFixed(1)
        : '0.0'
    lines.push(
      `${category.padEnd(labelWidth)}  ${String(tokens).padStart(tokenWidth)}  ${percent.padStart(5)}%`,
    )
  }

  const totalPercent =
    windowTokens > 0
      ? ((totalTokens / windowTokens) * 100).toFixed(1)
      : '0.0'
  lines.push(
    `${'total'.padEnd(labelWidth)}  ${String(totalTokens).padStart(tokenWidth)}  ${totalPercent.padStart(5)}%`,
  )
  lines.push(
    `${'window'.padEnd(labelWidth)}  ${String(windowTokens).padStart(tokenWidth)}`,
  )

  // Post-compaction ledgers still describe the last prompt-build turn
  // accurately (compaction only shrinks messageHistory, which the ledger
  // never records) — append a staleness note rather than dropping the data.
  if (ledger.compactedAtTurn === true) {
    lines.push(
      '(recorded before the last /compact; system-prompt blocks remain accurate)',
    )
  }

  return lines.join('\n')
}
