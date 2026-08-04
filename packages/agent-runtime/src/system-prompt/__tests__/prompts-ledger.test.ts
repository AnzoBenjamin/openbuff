import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { getStubProjectFileContext } from '@codebuff/common/util/file'

import {
  getGitChangesPrompt,
  getProjectFileTreePrompt,
  getSystemInfoPrompt,
} from '../prompts'
import { createBudgetLedger } from '../../util/context-budget'
import * as tokenCounter from '../../util/token-counter'

import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('system-prompt builders ledger recording', () => {
  afterEach(() => {
    mock.restore()
  })

  it('getProjectFileTreePrompt records a fileTree line with positive tokens', () => {
    spyOn(tokenCounter, 'countTokensJson').mockImplementation(
      (text) => JSON.stringify(text).length,
    )

    const fileContext = getStubProjectFileContext()
    const ledger = createBudgetLedger({ windowTokens: 500_000 })

    const prompt = getProjectFileTreePrompt({
      fileContext,
      fileTreeTokenBudget: 10_000,
      mode: 'agent',
      logger,
      ledger,
    })

    expect(prompt.length).toBeGreaterThan(0)
    expect(ledger.lines).toHaveLength(1)
    expect(ledger.lines[0].category).toBe('fileTree')
    expect(ledger.lines[0].label).toBe('project-file-tree')
    expect(ledger.lines[0].tokens).toBeGreaterThan(0)
    expect(ledger.totalTokens).toBe(ledger.lines[0].tokens)
    expect(ledger.byCategory.fileTree).toBe(ledger.lines[0].tokens)
  })

  it('getSystemInfoPrompt records a systemInfo line with positive tokens', () => {
    spyOn(tokenCounter, 'countTokensJson').mockImplementation(
      (text) => JSON.stringify(text).length,
    )

    const fileContext = getStubProjectFileContext()
    const ledger = createBudgetLedger({ windowTokens: 500_000 })

    const prompt = getSystemInfoPrompt(fileContext, ledger)

    expect(prompt.length).toBeGreaterThan(0)
    expect(ledger.lines).toHaveLength(1)
    expect(ledger.lines[0].category).toBe('systemInfo')
    expect(ledger.lines[0].label).toBe('system-info')
    expect(ledger.lines[0].tokens).toBeGreaterThan(0)
    expect(ledger.byCategory.systemInfo).toBe(ledger.lines[0].tokens)
  })

  it('getGitChangesPrompt records a gitChanges line when gitChanges exist', () => {
    spyOn(tokenCounter, 'countTokensJson').mockImplementation(
      (text) => JSON.stringify(text).length,
    )

    const fileContext = {
      ...getStubProjectFileContext(),
      gitChanges: {
        status: ' M file.ts',
        diff: 'diff --git a/file.ts b/file.ts',
        diffCached: '',
        lastCommitMessages: 'initial commit',
      },
    }
    const ledger = createBudgetLedger({ windowTokens: 500_000 })

    const prompt = getGitChangesPrompt(fileContext, ledger)

    expect(prompt.length).toBeGreaterThan(0)
    expect(ledger.lines).toHaveLength(1)
    expect(ledger.lines[0].category).toBe('gitChanges')
    expect(ledger.lines[0].label).toBe('git-changes')
    expect(ledger.lines[0].tokens).toBeGreaterThan(0)
    expect(ledger.byCategory.gitChanges).toBe(ledger.lines[0].tokens)
  })

  it('getGitChangesPrompt records nothing when gitChanges is empty', () => {
    spyOn(tokenCounter, 'countTokensJson').mockImplementation(
      (text) => JSON.stringify(text).length,
    )

    // The stub's gitChanges fields are all empty strings, which the builder
    // treats as "no git changes" (records nothing, returns '').
    const fileContext = getStubProjectFileContext()
    const ledger = createBudgetLedger({ windowTokens: 500_000 })

    const prompt = getGitChangesPrompt(fileContext, ledger)

    expect(prompt).toBe('')
    expect(ledger.lines).toHaveLength(0)
    expect(ledger.totalTokens).toBe(0)
    expect(ledger.byCategory).toEqual({})
  })

  it('builders record nothing when no ledger is passed (backward compatible)', () => {
    spyOn(tokenCounter, 'countTokensJson').mockImplementation(
      (text) => JSON.stringify(text).length,
    )

    const fileContext = getStubProjectFileContext()

    // These should behave identically to before: return strings, no ledger.
    const treePrompt = getProjectFileTreePrompt({
      fileContext,
      fileTreeTokenBudget: 10_000,
      mode: 'agent',
      logger,
    })
    const systemInfoPrompt = getSystemInfoPrompt(fileContext)
    const gitChangesPrompt = getGitChangesPrompt(fileContext)

    expect(typeof treePrompt).toBe('string')
    expect(typeof systemInfoPrompt).toBe('string')
    expect(gitChangesPrompt).toBe('')
  })

  it('a shared ledger accumulates all three blocks', () => {
    spyOn(tokenCounter, 'countTokensJson').mockImplementation(
      (text) => JSON.stringify(text).length,
    )

    const fileContext = {
      ...getStubProjectFileContext(),
      gitChanges: {
        status: ' M file.ts',
        diff: 'diff --git a/file.ts b/file.ts',
        diffCached: '',
        lastCommitMessages: 'initial commit',
      },
    }
    const ledger = createBudgetLedger({ windowTokens: 500_000 })

    getGitChangesPrompt(fileContext, ledger)
    getProjectFileTreePrompt({
      fileContext,
      fileTreeTokenBudget: 10_000,
      mode: 'search',
      logger,
      ledger,
    })
    getSystemInfoPrompt(fileContext, ledger)

    expect(ledger.lines).toHaveLength(3)
    expect(ledger.lines.map((line) => line.category)).toEqual([
      'gitChanges',
      'fileTree',
      'systemInfo',
    ])
    const expectedTotal = ledger.lines.reduce((sum, line) => sum + line.tokens, 0)
    expect(ledger.totalTokens).toBe(expectedTotal)
    expect(ledger.byCategory.gitChanges).toBeGreaterThan(0)
    expect(ledger.byCategory.fileTree).toBeGreaterThan(0)
    expect(ledger.byCategory.systemInfo).toBeGreaterThan(0)
  })
})
