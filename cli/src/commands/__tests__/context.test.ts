import { afterEach, describe, expect, it } from 'bun:test'

import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { formatGateRepairBudgetsForCli } from '@codebuff/common/util/gate-repair-budgets'

import { useChatStore } from '../../state/chat-store'
import { getSystemMessage } from '../../utils/message-history'
import { handleContextCommand } from '../context'

import type { ChatMessage } from '../../types/chat'
import type { ContextBudgetLedger } from '@codebuff/common/types/session-state'

const buildLedger = (): ContextBudgetLedger => ({
  lines: [
    {
      category: 'fileTree',
      label: 'project-file-tree',
      tokens: 10_000,
      cacheable: true,
    },
    {
      category: 'systemInfo',
      label: 'system-info',
      tokens: 5_000,
      cacheable: true,
    },
  ],
  totalTokens: 15_000,
  byCategory: {
    fileTree: 10_000,
    systemInfo: 5_000,
  },
  windowTokens: 200_000,
})

const defaultGateBudgets = () =>
  formatGateRepairBudgetsForCli({
    maxRepairRounds: null,
    maxReviewerRepairRounds: null,
    maxSpecialistRepairRounds: null,
  })

describe('handleContextCommand', () => {
  const envKey = 'OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS'
  let previousEnv: string | undefined

  afterEach(() => {
    useChatStore.getState().setRunState(null)
    if (previousEnv === undefined) {
      delete process.env[envKey]
    } else {
      process.env[envKey] = previousEnv
    }
    previousEnv = undefined
  })

  it('renders the ledger breakdown when a context budget ledger is set', () => {
    const sessionState = getInitialSessionState(getStubProjectFileContext())
    sessionState.mainAgentState.contextBudgetLedger = buildLedger()
    useChatStore.getState().setRunState({
      sessionState,
      output: { type: 'lastMessage', value: [] },
    })

    const { postUserMessage } = handleContextCommand()
    const prior: ChatMessage[] = [getSystemMessage('prior')]
    const messages = postUserMessage(prior)
    const last = messages[messages.length - 1]

    expect(messages).toHaveLength(prior.length + 1)
    // Pin the byte-stable format by deriving expected lines with the same
    // padEnd/padStart widths the formatter uses (labelWidth 10, tokens width 8,
    // percents width 5). The window row is padded to the same token column as
    // the category rows (alignment fix). Exact lines guard against spurious
    // substring passes. Gate repair budgets always append after a blank line.
    const row = (label: string, tokens: number, pct: string) =>
      `${label.padEnd(10)}  ${String(tokens).padStart(8)}  ${pct.padStart(5)}%`
    expect(last.content).toBe(
      [
        'Context Budget Breakdown',
        '------------------------',
        row('fileTree', 10_000, '5.0'),
        row('systemInfo', 5_000, '2.5'),
        row('total', 15_000, '7.5'),
        `${'window'.padEnd(10)}  ${String(200_000).padStart(8)}`,
        '',
        defaultGateBudgets(),
      ].join('\n'),
    )
  })

  it('always shows gate repair budgets when no context budget data exists yet', () => {
    useChatStore.getState().setRunState(null)

    const { postUserMessage } = handleContextCommand()
    const messages = postUserMessage([])
    const last = messages[messages.length - 1]

    expect(messages).toHaveLength(1)
    expect(last.content).toBe(defaultGateBudgets())
    expect(last.content).toContain('Gate repair budgets')
    expect(last.content).toContain('validation (hooks)')
  })

  it('shows an env-overridden gate repair budget and restores env', () => {
    previousEnv = process.env[envKey]
    process.env[envKey] = '11'
    useChatStore.getState().setRunState(null)

    try {
      const { postUserMessage } = handleContextCommand()
      const content = postUserMessage([])[0].content
      expect(content).toContain('Gate repair budgets')
      expect(content).toContain('reviewer (code-review)')
      expect(content).toContain('11')
      expect(content).toBe(
        formatGateRepairBudgetsForCli({
          maxRepairRounds: null,
          maxReviewerRepairRounds: 11,
          maxSpecialistRepairRounds: null,
        }),
      )
    } finally {
      if (previousEnv === undefined) {
        delete process.env[envKey]
      } else {
        process.env[envKey] = previousEnv
      }
      previousEnv = undefined
    }
  })

  it('renders finite non-negative values for a malformed persisted ledger', () => {
    const sessionState = getInitialSessionState(getStubProjectFileContext())
    sessionState.mainAgentState.contextBudgetLedger = {
      lines: [],
      totalTokens: -1,
      byCategory: {
        malformed: Number.NaN,
        infinite: Number.POSITIVE_INFINITY,
      },
      windowTokens: Number.NEGATIVE_INFINITY,
    }
    useChatStore.getState().setRunState({
      sessionState,
      output: { type: 'lastMessage', value: [] },
    })

    const { postUserMessage } = handleContextCommand()
    const messages = postUserMessage([])
    const content = messages[messages.length - 1].content

    expect(content).not.toContain('NaN')
    expect(content).not.toContain('Infinity')
    expect(content).toContain('malformed')
    expect(content).toContain('       0')
    expect(content).toContain('Gate repair budgets')
  })
})
