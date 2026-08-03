import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { formatLedgerForCli as formatLedgerForCliFromCommon } from '@codebuff/common/util/context-budget'

import {
  annotateLedgerAfterCompaction,
  applyMeasure,
  applyRecord,
  createBudgetLedger,
  finalizeLedger,
  formatLedgerForCli,
  measureBlock,
  recordBlock,
} from '../context-budget'
import * as tokenCounter from '../token-counter'

import type {
  BudgetCategory as CommonBudgetCategory,
  BudgetLine as CommonBudgetLine,
  ContextBudgetLedger as CommonContextBudgetLedger,
} from '@codebuff/common/types/session-state'
import type {
  BudgetCategory,
  BudgetLine,
  ContextBudgetLedger,
} from '../context-budget'

describe('context-budget', () => {
  afterEach(() => {
    mock.restore()
  })

  describe('createBudgetLedger', () => {
    it('returns an empty ledger with the given window', () => {
      const ledger = createBudgetLedger({ windowTokens: 200_000 })

      expect(ledger).toEqual({
        lines: [],
        totalTokens: 0,
        byCategory: {},
        windowTokens: 200_000,
      })
    })
  })

  describe('type deduplication with @codebuff/common', () => {
    it('re-exports formatLedgerForCli as the same function from common', () => {
      // The agent-runtime module re-exports the shared common implementation
      // rather than defining its own copy.
      expect(formatLedgerForCli).toBe(formatLedgerForCliFromCommon)
    })

    it('re-exports ledger types assignable to the canonical common types', () => {
      // Compile-time-only guard. TypeScript is structural, so these
      // assignments do NOT prove the declarations are the same symbol; they
      // only fail typecheck if the shapes become incompatible. The real
      // single-source proof is the formatLedgerForCli identity assertion
      // above plus the absence of local declarations in ../context-budget.
      const ledger: ContextBudgetLedger = {
        lines: [
          {
            category: 'systemPrompt',
            label: 'base prompt',
            tokens: 1_000,
            cacheable: true,
          },
        ],
        totalTokens: 1_000,
        byCategory: { systemPrompt: 1_000 },
        windowTokens: 200_000,
      }

      const asCommon: CommonContextBudgetLedger = ledger
      const backToLocal: ContextBudgetLedger = asCommon
      const line: BudgetLine = backToLocal.lines[0]
      const asCommonLine: CommonBudgetLine = line
      const category: BudgetCategory = asCommonLine.category
      const asCommonCategory: CommonBudgetCategory = category

      expect(asCommonCategory).toBe('systemPrompt')
    })

    it('accepts every BudgetCategory union member through recordBlock', () => {
      // Behavior proof that the re-exported BudgetCategory union stays wide
      // enough for all producers: record a line per member and confirm the
      // category is preserved verbatim in the ledger.
      const categories: BudgetCategory[] = [
        'systemPrompt',
        'fileTree',
        'knowledge',
        'systemInfo',
        'gitChanges',
        'proactiveRetrieval',
        'gitObservation',
        'patterns',
        'languageProfile',
        'tools',
        'conversation',
        'other',
      ]

      let ledger = createBudgetLedger({ windowTokens: 200_000 })
      for (const category of categories) {
        ledger = recordBlock(ledger, {
          category,
          label: `${category} block`,
          tokens: 1,
          cacheable: true,
        })
      }

      expect(ledger.lines.map((line) => line.category)).toEqual(categories)
      expect(Object.keys(ledger.byCategory).sort()).toEqual(
        [...categories].sort(),
      )
    })
  })

  describe('recordBlock', () => {
    it('appends the line and accumulates totals and byCategory', () => {
      const ledger = createBudgetLedger({ windowTokens: 200_000 })

      const after1 = recordBlock(ledger, {
        category: 'systemPrompt',
        label: 'base prompt',
        tokens: 1_000,
        cacheable: true,
      })
      const after2 = recordBlock(after1, {
        category: 'systemPrompt',
        label: 'agent prompt',
        tokens: 500,
        cacheable: true,
      })
      const after3 = recordBlock(after2, {
        category: 'tools',
        label: 'tool schemas',
        tokens: 250,
        cacheable: false,
      })

      expect(after3.lines).toHaveLength(3)
      expect(after3.lines[2]).toEqual({
        category: 'tools',
        label: 'tool schemas',
        tokens: 250,
        cacheable: false,
      })
      expect(after3.totalTokens).toBe(1_750)
      expect(after3.byCategory).toEqual({
        systemPrompt: 1_500,
        tools: 250,
      })
    })

    it('returns a new ledger object and does not mutate the input', () => {
      const ledger = createBudgetLedger({ windowTokens: 200_000 })
      const originalLines = ledger.lines
      const originalByCategory = ledger.byCategory

      const next = recordBlock(ledger, {
        category: 'knowledge',
        label: 'knowledge files',
        tokens: 100,
        cacheable: true,
      })

      expect(next).not.toBe(ledger)
      expect(next.lines).not.toBe(originalLines)
      expect(next.byCategory).not.toBe(originalByCategory)

      // Input is unchanged
      expect(ledger.lines).toHaveLength(0)
      expect(ledger.totalTokens).toBe(0)
      expect(ledger.byCategory).toEqual({})
    })

    it('clamps negative token counts to 0', () => {
      const ledger = createBudgetLedger({ windowTokens: 200_000 })

      const next = recordBlock(ledger, {
        category: 'other',
        label: 'negative block',
        tokens: -50,
        cacheable: true,
      })

      expect(next.lines[0].tokens).toBe(0)
      expect(next.totalTokens).toBe(0)
      expect(next.byCategory.other).toBe(0)
    })
  })

  describe('measureBlock', () => {
    it('counts tokens via countTokensJson and records the block', () => {
      spyOn(tokenCounter, 'countTokensJson').mockImplementation(
        (text) => JSON.stringify(text).length,
      )

      const ledger = createBudgetLedger({ windowTokens: 200_000 })
      const content = 'hello world'
      const expectedTokens = JSON.stringify(content).length

      const { ledger: next, tokens } = measureBlock(ledger, {
        category: 'fileTree',
        label: 'file tree',
        content,
      })

      expect(tokens).toBe(expectedTokens)
      expect(next.lines).toHaveLength(1)
      expect(next.lines[0]).toEqual({
        category: 'fileTree',
        label: 'file tree',
        tokens: expectedTokens,
        cacheable: true,
      })
      expect(next.totalTokens).toBe(expectedTokens)
      expect(next.byCategory.fileTree).toBe(expectedTokens)
    })

    it('defaults cacheable to true and honors explicit cacheable: false', () => {
      spyOn(tokenCounter, 'countTokensJson').mockImplementation(
        (text) => JSON.stringify(text).length,
      )

      const ledger = createBudgetLedger({ windowTokens: 200_000 })

      const { ledger: withDefault } = measureBlock(ledger, {
        category: 'conversation',
        label: 'messages',
        content: { role: 'user', content: 'hi' },
      })
      expect(withDefault.lines[0].cacheable).toBe(true)

      const { ledger: explicitFalse } = measureBlock(ledger, {
        category: 'conversation',
        label: 'messages',
        content: 'hi',
        cacheable: false,
      })
      expect(explicitFalse.lines[0].cacheable).toBe(false)
    })
  })

  describe('applyRecord', () => {
    it('mutates and returns the same ledger object', () => {
      const ledger = createBudgetLedger({ windowTokens: 200_000 })

      const returned = applyRecord(ledger, {
        category: 'fileTree',
        label: 'project-file-tree',
        tokens: 1_000,
        cacheable: true,
      })

      expect(returned).toBe(ledger)
      expect(ledger.lines).toHaveLength(1)
      expect(ledger.lines[0]).toEqual({
        category: 'fileTree',
        label: 'project-file-tree',
        tokens: 1_000,
        cacheable: true,
      })
      expect(ledger.totalTokens).toBe(1_000)
      expect(ledger.byCategory).toEqual({ fileTree: 1_000 })
    })

    it('accumulates multiple lines in place', () => {
      const ledger = createBudgetLedger({ windowTokens: 200_000 })

      applyRecord(ledger, {
        category: 'systemInfo',
        label: 'system-info',
        tokens: 500,
        cacheable: true,
      })
      applyRecord(ledger, {
        category: 'systemInfo',
        label: 'system-info-again',
        tokens: 250,
        cacheable: true,
      })
      applyRecord(ledger, {
        category: 'gitChanges',
        label: 'git-changes',
        tokens: 100,
        cacheable: false,
      })

      expect(ledger.lines).toHaveLength(3)
      expect(ledger.totalTokens).toBe(850)
      expect(ledger.byCategory).toEqual({
        systemInfo: 750,
        gitChanges: 100,
      })
    })

    it('clamps negative token counts to 0', () => {
      const ledger = createBudgetLedger({ windowTokens: 200_000 })

      applyRecord(ledger, {
        category: 'other',
        label: 'negative block',
        tokens: -50,
        cacheable: true,
      })

      expect(ledger.lines[0].tokens).toBe(0)
      expect(ledger.totalTokens).toBe(0)
      expect(ledger.byCategory.other).toBe(0)
    })
  })

  describe('applyMeasure', () => {
    it('counts tokens and mutates the same ledger in place', () => {
      spyOn(tokenCounter, 'countTokensJson').mockImplementation(
        (text) => JSON.stringify(text).length,
      )

      const ledger = createBudgetLedger({ windowTokens: 200_000 })
      const content = 'hello world'
      const expectedTokens = JSON.stringify(content).length

      const { ledger: returned, tokens } = applyMeasure(ledger, {
        category: 'fileTree',
        label: 'project-file-tree',
        content,
      })

      expect(returned).toBe(ledger)
      expect(tokens).toBe(expectedTokens)
      expect(ledger.lines).toHaveLength(1)
      expect(ledger.lines[0]).toEqual({
        category: 'fileTree',
        label: 'project-file-tree',
        tokens: expectedTokens,
        cacheable: true,
      })
      expect(ledger.totalTokens).toBe(expectedTokens)
      expect(ledger.byCategory.fileTree).toBe(expectedTokens)
    })

    it('accumulates across calls and honors cacheable: false', () => {
      spyOn(tokenCounter, 'countTokensJson').mockImplementation(
        (text) => JSON.stringify(text).length,
      )

      const ledger = createBudgetLedger({ windowTokens: 200_000 })

      applyMeasure(ledger, {
        category: 'systemInfo',
        label: 'system-info',
        content: 'abc',
      })
      applyMeasure(ledger, {
        category: 'gitChanges',
        label: 'git-changes',
        content: 'defgh',
        cacheable: false,
      })

      const expectedSystemInfo = JSON.stringify('abc').length
      const expectedGitChanges = JSON.stringify('defgh').length

      expect(ledger.lines).toHaveLength(2)
      expect(ledger.lines[0].cacheable).toBe(true)
      expect(ledger.lines[1].cacheable).toBe(false)
      expect(ledger.totalTokens).toBe(expectedSystemInfo + expectedGitChanges)
      expect(ledger.byCategory).toEqual({
        systemInfo: expectedSystemInfo,
        gitChanges: expectedGitChanges,
      })
    })
  })

  describe('finalizeLedger', () => {
    it('recomputes totalTokens and byCategory from lines', () => {
      let ledger = createBudgetLedger({ windowTokens: 200_000 })
      ledger = recordBlock(ledger, {
        category: 'systemPrompt',
        label: 'base prompt',
        tokens: 1_000,
        cacheable: true,
      })
      ledger = recordBlock(ledger, {
        category: 'tools',
        label: 'tool schemas',
        tokens: 250,
        cacheable: false,
      })

      // Corrupt the aggregates to prove finalizeLedger recomputes them
      const corrupted = {
        ...ledger,
        totalTokens: 999_999,
        byCategory: { wrong: 1 },
      }

      const finalized = finalizeLedger(corrupted)
      expect(finalized.totalTokens).toBe(1_250)
      expect(finalized.byCategory).toEqual({
        systemPrompt: 1_000,
        tools: 250,
      })
      expect(finalized.windowTokens).toBe(200_000)
    })

    it('normalizes non-finite and negative persisted line tokens', () => {
      const corrupted: ContextBudgetLedger = {
        lines: [
          {
            category: 'systemPrompt',
            label: 'invalid',
            tokens: Number.NaN,
            cacheable: true,
          },
          {
            category: 'tools',
            label: 'negative',
            tokens: -10,
            cacheable: true,
          },
          {
            category: 'conversation',
            label: 'infinite',
            tokens: Number.POSITIVE_INFINITY,
            cacheable: true,
          },
        ],
        totalTokens: Number.POSITIVE_INFINITY,
        byCategory: {
          systemPrompt: Number.NaN,
          tools: -10,
        },
        windowTokens: 200_000,
      }

      const normalized = finalizeLedger(corrupted)

      expect(normalized.totalTokens).toBe(0)
      expect(normalized.byCategory).toEqual({
        systemPrompt: 0,
        tools: 0,
        conversation: 0,
      })
    })

    it('is idempotent', () => {
      let ledger = createBudgetLedger({ windowTokens: 200_000 })
      ledger = recordBlock(ledger, {
        category: 'knowledge',
        label: 'knowledge',
        tokens: 100,
        cacheable: true,
      })

      const once = finalizeLedger(ledger)
      const twice = finalizeLedger(once)

      expect(twice).toEqual(once)
    })
  })

  describe('annotateLedgerAfterCompaction', () => {
    it('returns a new object with compactedAtTurn true and preserves the recorded fields', () => {
      let ledger = createBudgetLedger({ windowTokens: 200_000 })
      ledger = recordBlock(ledger, {
        category: 'systemPrompt',
        label: 'base prompt',
        tokens: 1_000,
        cacheable: true,
      })
      ledger = recordBlock(ledger, {
        category: 'tools',
        label: 'tool schemas',
        tokens: 250,
        cacheable: false,
      })

      const annotated = annotateLedgerAfterCompaction(ledger)

      expect(annotated).not.toBe(ledger)
      expect(annotated.compactedAtTurn).toBe(true)
      expect(annotated.lines).toBe(ledger.lines)
      expect(annotated.totalTokens).toBe(ledger.totalTokens)
      expect(annotated.byCategory).toBe(ledger.byCategory)
      expect(annotated.windowTokens).toBe(ledger.windowTokens)
    })

    it('does not mutate the input', () => {
      const ledger = createBudgetLedger({ windowTokens: 200_000 })

      annotateLedgerAfterCompaction(ledger)

      expect(ledger.compactedAtTurn).toBeUndefined()
    })

    it('is idempotent', () => {
      let ledger = createBudgetLedger({ windowTokens: 200_000 })
      ledger = recordBlock(ledger, {
        category: 'knowledge',
        label: 'knowledge',
        tokens: 100,
        cacheable: true,
      })

      const once = annotateLedgerAfterCompaction(ledger)
      const twice = annotateLedgerAfterCompaction(once)

      expect(twice).toEqual(once)
      expect(twice.compactedAtTurn).toBe(true)
    })
  })

  describe('formatLedgerForCli', () => {
    it('emits a row per category, a total row, and the window percent', () => {
      let ledger = createBudgetLedger({ windowTokens: 200_000 })
      ledger = recordBlock(ledger, {
        category: 'systemPrompt',
        label: 'base prompt',
        tokens: 20_000,
        cacheable: true,
      })
      ledger = recordBlock(ledger, {
        category: 'conversation',
        label: 'messages',
        tokens: 30_000,
        cacheable: false,
      })

      const output = formatLedgerForCli(ledger)

      expect(output).toContain('systemPrompt')
      expect(output).toContain('conversation')
      expect(output).toContain('20000')
      expect(output).toContain('30000')
      expect(output).toContain('total')
      expect(output).toContain('50000')
      expect(output).toContain('window')
      expect(output).toContain('200000')
      // 20000 / 200000 = 10.0%
      expect(output).toContain('10.0%')
      // 30000 / 200000 = 15.0%
      expect(output).toContain('15.0%')
      // 50000 / 200000 = 25.0%
      expect(output).toContain('25.0%')
    })

    it('is deterministic for a given ledger', () => {
      let ledger = createBudgetLedger({ windowTokens: 100_000 })
      ledger = recordBlock(ledger, {
        category: 'tools',
        label: 'tool schemas',
        tokens: 5_000,
        cacheable: true,
      })

      expect(formatLedgerForCli(ledger)).toBe(formatLedgerForCli(ledger))
    })

    // Direct formatter coverage (multi-category, empty ledger, zero window)
    // lives in common/src/util/__tests__/context-budget.test.ts, which owns
    // the implementation. Only the re-export identity is asserted here so a
    // format change requires updating one file, not two.
  })
})
