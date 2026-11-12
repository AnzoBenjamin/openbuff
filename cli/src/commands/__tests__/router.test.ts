import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'

import { useChatStore } from '../../state/chat-store'
import { findCommand } from '../command-registry'
import { routeUserPrompt } from '../router'

import type { RouterParams } from '../command-registry'
import type { SendMessageFn } from '../../types/contracts/send-message'
import type { ChatMessage } from '../../types/chat'
import type { InputValue } from '../../types/store'

// N08: `/compact [focus]` and `/context` instruction-file listing through the
// real router (DI harness, same shape as prompt-dispatch.test.ts).
function createHarness(inputValue: string, isStreaming = false) {
  const sent: Parameters<SendMessageFn>[0][] = []
  const queued: string[] = []
  let messages: ChatMessage[] = []
  let input: InputValue = {
    text: inputValue,
    cursorPosition: inputValue.length,
    lastEditDueToNav: false,
  }
  const params: RouterParams = {
    inputValue,
    agentMode: 'DEFAULT',
    isStreaming,
    isChainInProgressRef: { current: false },
    streamMessageIdRef: { current: null },
    abortControllerRef: { current: null },
    inputRef: { current: null },
    sendMessage: async (request) => {
      sent.push(request)
    },
    addToQueue: (content) => {
      queued.push(content)
    },
    setMessages: (value) => {
      messages = typeof value === 'function' ? value(messages) : value
    },
    setInputValue: (value) => {
      input = typeof value === 'function' ? value(input) : value
    },
    saveToHistory: () => {},
    setInputFocused: () => {},
    setCanProcessQueue: () => {},
    scrollToLatest: () => {},
    clearMessages: () => {},
    stopStreaming: () => {},
  }
  return {
    params,
    sent,
    queued,
    get messages() {
      return messages
    },
    get input() {
      return input
    },
  }
}

beforeEach(() => useChatStore.getState().reset())
afterEach(() => useChatStore.getState().reset())

describe('/compact', () => {
  test('is a registered command', () => {
    expect(findCommand('compact')?.name).toBe('compact')
  })

  test('/compact keep the API notes reaches the runtime with the focus', async () => {
    const harness = createHarness('/compact keep the API notes')
    await routeUserPrompt(harness.params)
    expect(harness.sent.map((request) => request.content)).toEqual([
      '/compact keep the API notes',
    ])
    expect(JSON.stringify(harness.messages)).not.toContain('Command not found')
    expect(harness.input.text).toBe('')
  })

  test('bare /compact reaches the runtime', async () => {
    const harness = createHarness('/compact')
    await routeUserPrompt(harness.params)
    expect(harness.sent.map((request) => request.content)).toEqual([
      '/compact',
    ])
  })

  test('is queued while a turn is streaming', async () => {
    const harness = createHarness('/compact keep the API notes', true)
    await routeUserPrompt(harness.params)
    expect(harness.sent).toEqual([])
    expect(harness.queued).toEqual(['/compact keep the API notes'])
  })
})

describe('/context', () => {
  test('lists the instruction files in effect', async () => {
    const fileContext = {
      ...getStubProjectFileContext(),
      knowledgeFiles: {
        '../AGENTS.md': 'root agents',
        '../CLAUDE.md': 'root claude',
        'AGENTS.md': 'see @docs/x.md',
        'docs/x.md': 'imported',
        'sub/AGENTS.md': 'nested',
      },
      instructionFiles: [
        { path: '../AGENTS.md', scope: 'ancestor' as const, chars: 11 },
        { path: '../CLAUDE.md', scope: 'ancestor' as const, chars: 11 },
        { path: 'AGENTS.md', scope: 'project' as const, chars: 14 },
        {
          path: 'docs/x.md',
          scope: 'import' as const,
          importedBy: 'AGENTS.md',
          chars: 8,
        },
        { path: 'sub/AGENTS.md', scope: 'nested' as const, chars: 6 },
      ],
      userKnowledgeFiles: { '~/.knowledge.md': 'user notes' },
    }
    const sessionState = getInitialSessionState(fileContext)
    sessionState.mainAgentState.contextBudgetLedger = {
      lines: [
        {
          category: 'knowledge',
          label: 'instruction:../AGENTS.md',
          tokens: 5,
          cacheable: true,
        },
      ],
      totalTokens: 5,
      byCategory: { knowledge: 5 },
      windowTokens: 200_000,
    }
    useChatStore.getState().setRunState({
      sessionState,
      output: { type: 'lastMessage', value: [] },
    })

    const harness = createHarness('/context')
    await routeUserPrompt(harness.params)
    const text = JSON.stringify(harness.messages)
    expect(harness.sent).toEqual([])
    expect(text).toContain('Instruction files')
    for (const filePath of [
      '../AGENTS.md',
      '../CLAUDE.md',
      'AGENTS.md',
      'docs/x.md',
      'sub/AGENTS.md',
      '~/.knowledge.md',
    ]) {
      expect(text).toContain(filePath)
    }
    expect(text).toContain('in prompt')
    expect(text).toContain('(from AGENTS.md)')
    expect(text).toContain('loads when sub/ is touched')
  })
})
