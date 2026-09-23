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
    const expectedTotal = ledger.lines.reduce(
      (sum, line) => sum + line.tokens,
      0,
    )
    expect(ledger.totalTokens).toBe(expectedTotal)
    expect(ledger.byCategory.gitChanges).toBeGreaterThan(0)
    expect(ledger.byCategory.fileTree).toBeGreaterThan(0)
    expect(ledger.byCategory.systemInfo).toBeGreaterThan(0)
  })
})

/**
 * Coverage for `redactedShellConfigBlock` (M1-T5 secret redaction), exercised
 * through its only public entry point, `getSystemInfoPrompt`.
 */
describe('getSystemInfoPrompt shell config redaction', () => {
  const baseSystemInfo = {
    platform: 'linux',
    shell: '/bin/bash',
    nodeVersion: 'v22',
    arch: 'x64',
    homedir: '/home/test',
    cpus: 4,
    chromeAvailable: false,
  }

  it('drops secret-bearing lines and keeps innocuous lines', () => {
    const fileContext = {
      ...getStubProjectFileContext(),
      shellConfigFiles: {
        '~/.bashrc': [
          'export EDITOR=vim',
          'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx',
          'alias ll="ls -la"',
        ].join('\n'),
      },
      systemInfo: baseSystemInfo,
    }

    const prompt = getSystemInfoPrompt(fileContext)

    expect(prompt).toContain('<user_shell_config_files>')
    // Innocuous lines survive untouched.
    expect(prompt).toContain('export EDITOR=vim')
    expect(prompt).toContain('alias ll="ls -la"')
    // The secret-bearing line is dropped entirely (line-granularity policy).
    expect(prompt).not.toContain('sk-proj-abcdefghijklmnopqrstuvwx')
    expect(prompt).not.toContain('OPENAI_API_KEY=')
  })

  it('drops token-shaped secret lines even without a sensitive keyword', () => {
    const skToken = 'sk-' + 'a'.repeat(24)
    const fileContext = {
      ...getStubProjectFileContext(),
      shellConfigFiles: {
        '~/.zshrc': `curl -H "Authorization: ${skToken}" api.example.com`,
      },
      systemInfo: baseSystemInfo,
    }

    const prompt = getSystemInfoPrompt(fileContext)

    expect(prompt).not.toContain(skToken)
  })

  it('marks a fully redacted file with the explicit redaction marker', () => {
    const fileContext = {
      ...getStubProjectFileContext(),
      shellConfigFiles: {
        '~/.bashrc': 'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG',
      },
      systemInfo: baseSystemInfo,
    }

    const prompt = getSystemInfoPrompt(fileContext)

    expect(prompt).toContain('[REDACTED for safety')
    expect(prompt).toContain('1 lines omitted')
    expect(prompt).not.toContain('wJalrXUtnFEMI')
    expect(prompt).not.toContain('AWS_SECRET_ACCESS_KEY=')
  })

  it('drops comment and blank lines from shell config files', () => {
    const fileContext = {
      ...getStubProjectFileContext(),
      shellConfigFiles: {
        '~/.profile': [
          '# my api key config',
          '',
          'export PATH=$PATH:/usr/local/bin',
        ].join('\n'),
      },
      systemInfo: baseSystemInfo,
    }

    const prompt = getSystemInfoPrompt(fileContext)

    // Comments and blanks are dropped; only real config survives.
    expect(prompt).not.toContain('# my api key config')
    expect(prompt).toContain('export PATH=$PATH:/usr/local/bin')
  })
})
