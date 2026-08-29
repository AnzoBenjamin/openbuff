import { describe, expect, it } from 'bun:test'

import { formatLedgerForCli } from '../context-budget'

import type { ContextBudgetLedger } from '../../types/session-state'

const buildLedger = (
  overrides: Partial<ContextBudgetLedger> = {},
): ContextBudgetLedger => ({
  lines: [],
  totalTokens: 0,
  byCategory: {},
  windowTokens: 200_000,
  ...overrides,
})

/**
 * Derives an expected row using the same padEnd/padStart widths the formatter
 * applies, so assertions never hardcode fragile runs of literal whitespace.
 * labelWidth is max(longest category label, 'category'.length); tokenWidth is
 * max(8, widest rendered token count), matching the formatter's derivation so
 * the window row pads to the same token column as the category/total rows.
 */
const row = (
  labelWidth: number,
  tokenWidth: number,
  label: string,
  tokens: number,
  pct: string,
) =>
  `${label.padEnd(labelWidth)}  ${String(tokens).padStart(tokenWidth)}  ${pct.padStart(5)}%`

const windowRow = (
  labelWidth: number,
  tokenWidth: number,
  windowTokens: number,
) =>
  `${'window'.padEnd(labelWidth)}  ${String(windowTokens).padStart(tokenWidth)}`

describe('formatLedgerForCli (common)', () => {
  it('emits a row per category, a total row, and the window row', () => {
    const output = formatLedgerForCli(
      buildLedger({
        totalTokens: 50_000,
        byCategory: { systemPrompt: 20_000, conversation: 30_000 },
        windowTokens: 200_000,
      }),
    )

    // labelWidth 12 from 'systemPrompt'/'conversation'.
    expect(output).toBe(
      [
        'Context Budget Breakdown',
        '------------------------',
        row(12, 8, 'systemPrompt', 20_000, '10.0'),
        row(12, 8, 'conversation', 30_000, '15.0'),
        row(12, 8, 'total', 50_000, '25.0'),
        windowRow(12, 8, 200_000),
      ].join('\n'),
    )
  })

  it('emits only total and window rows for an empty ledger', () => {
    const output = formatLedgerForCli(buildLedger())

    // No category rows for an empty byCategory; labelWidth falls back to
    // 'category'.length (8).
    expect(output).toBe(
      [
        'Context Budget Breakdown',
        '------------------------',
        row(8, 8, 'total', 0, '0.0'),
        windowRow(8, 8, 200_000),
      ].join('\n'),
    )
  })

  it('reports 0.0% for every category when windowTokens is 0', () => {
    const output = formatLedgerForCli(
      buildLedger({
        totalTokens: 20_000,
        byCategory: { systemPrompt: 20_000 },
        windowTokens: 0,
      }),
    )

    // windowTokens <= 0 short-circuits the division to '0.0'.
    expect(output).toBe(
      [
        'Context Budget Breakdown',
        '------------------------',
        row(12, 8, 'systemPrompt', 20_000, '0.0'),
        row(12, 8, 'total', 20_000, '0.0'),
        windowRow(12, 8, 0),
      ].join('\n'),
    )
  })

  it('widens the token column on every row when a number exceeds 8 digits', () => {
    const output = formatLedgerForCli(
      buildLedger({
        totalTokens: 123_456_789,
        byCategory: { systemPrompt: 100_000_000, conversation: 23_456_789 },
        windowTokens: 1_000_000_000,
      }),
    )

    // tokenWidth derives from the widest rendered number (the 10-digit
    // windowTokens), so category, total, and window rows all pad to it.
    const tokenWidth = String(1_000_000_000).length
    expect(output).toBe(
      [
        'Context Budget Breakdown',
        '------------------------',
        row(12, tokenWidth, 'systemPrompt', 100_000_000, '10.0'),
        row(12, tokenWidth, 'conversation', 23_456_789, '2.3'),
        row(12, tokenWidth, 'total', 123_456_789, '12.3'),
        windowRow(12, tokenWidth, 1_000_000_000),
      ].join('\n'),
    )

    // Alignment: the shared token column puts the percent column at one
    // offset on every category/total line.
    const percentLines = output.split('\n').filter((line) => line.endsWith('%'))
    expect(new Set(percentLines.map((line) => line.length)).size).toBe(1)
  })

  it('sanitizes malformed persisted numbers and category aggregates', () => {
    const output = formatLedgerForCli(
      buildLedger({
        totalTokens: Number.NaN,
        byCategory: {
          finite: 10,
          negative: -5,
          infinite: Number.POSITIVE_INFINITY,
          malformed: Number.NaN,
        },
        windowTokens: Number.POSITIVE_INFINITY,
      }),
    )

    expect(output).toBe(
      [
        'Context Budget Breakdown',
        '------------------------',
        row(9, 8, 'finite', 10, '0.0'),
        row(9, 8, 'negative', 0, '0.0'),
        row(9, 8, 'infinite', 0, '0.0'),
        row(9, 8, 'malformed', 0, '0.0'),
        row(9, 8, 'total', 0, '0.0'),
        windowRow(9, 8, 0),
      ].join('\n'),
    )
    expect(output).not.toContain('NaN')
    expect(output).not.toContain('Infinity')
  })

  it('appends a staleness note after the window row for post-compaction ledgers', () => {
    const output = formatLedgerForCli(
      buildLedger({
        totalTokens: 50_000,
        byCategory: { systemPrompt: 20_000, conversation: 30_000 },
        windowTokens: 200_000,
        compactedAtTurn: true,
      }),
    )

    // Identical rows to the non-annotated ledger above, plus the note.
    expect(output).toBe(
      [
        'Context Budget Breakdown',
        '------------------------',
        row(12, 8, 'systemPrompt', 20_000, '10.0'),
        row(12, 8, 'conversation', 30_000, '15.0'),
        row(12, 8, 'total', 50_000, '25.0'),
        windowRow(12, 8, 200_000),
        '(recorded before the last /compact; system-prompt blocks remain accurate)',
      ].join('\n'),
    )
  })

  it('renders a huge persisted byCategory without throwing', () => {
    const categoryCount = 5_000
    const byCategory = Object.fromEntries(
      Array.from({ length: categoryCount }, (_, index): [string, number] => [
        `cat${String(index).padStart(4, '0')}`,
        1,
      ]),
    )
    const totalTokens = categoryCount

    let output = ''
    expect(() => {
      output = formatLedgerForCli(buildLedger({ totalTokens, byCategory }))
    }).not.toThrow()

    // 2 header lines + one row per category + total and window rows.
    expect(output.split('\n')).toHaveLength(2 + categoryCount + 2)

    // labelWidth is the longest category key (floored at 'category'.length);
    // derive it the same way the formatter does instead of hardcoding a width.
    let labelWidth = 'category'.length
    for (const category of Object.keys(byCategory)) {
      if (category.length > labelWidth) labelWidth = category.length
    }
    expect(output).toContain(row(labelWidth, 8, 'total', totalTokens, '2.5'))
    expect(output).toContain(windowRow(labelWidth, 8, 200_000))
  })
})
