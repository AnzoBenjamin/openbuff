import { beforeEach, expect, test } from 'bun:test'
import type { RunState } from '@openbuff/sdk'
import type { ChatMessage } from '../../types/chat'
import {
  forkConversationBeforeMessage,
  stampRunPromptBoundary,
} from '../conversation-fork'
import { useChatStore } from '../../state/chat-store'

const visible = (id: string, variant: ChatMessage['variant']): ChatMessage => ({
  id,
  variant,
  content: id,
  timestamp: '',
})
const state = (history: unknown[]): RunState =>
  ({
    sessionState: {
      mainAgentState: {
        messageHistory: history,
        output: { status: 'success' },
        subagents: ['stale'],
        agentContext: { stale: true },
        backgroundAgentJobs: ['stale'],
      },
    },
  }) as unknown as RunState
const prompt = (content: string) => ({
  role: 'user',
  content,
  tags: ['USER_PROMPT'],
})

beforeEach(() => useChatStore.getState().reset())

test('fork removes the edited turn and later SDK and visible history without changing source', () => {
  const first = stampRunPromptBoundary(
    state([{ role: 'system', content: 'system' }, prompt('one')]),
    'u1',
  )
  const source = stampRunPromptBoundary(
    state([
      ...first.sessionState!.mainAgentState.messageHistory,
      { role: 'assistant', content: 'first answer' },
      prompt('two'),
      { role: 'assistant', content: 'second answer' },
    ]),
    'u2',
  )
  const messages = [
    visible('u1', 'user'),
    visible('a1', 'ai'),
    visible('u2', 'user'),
    visible('a2', 'ai'),
  ]
  const fork = forkConversationBeforeMessage(source, messages, 'u2')
  expect(fork.status).toBe('ready')
  if (fork.status !== 'ready') throw new Error(fork.reason)
  expect(fork.messages.map((message) => message.id)).toEqual(['u1', 'a1'])
  expect(fork.runState.sessionState.mainAgentState.messageHistory).toHaveLength(
    3,
  )
  expect(fork.runState.sessionState.mainAgentState.output).toBeUndefined()
  expect(fork.runState.sessionState.mainAgentState.backgroundAgentJobs).toEqual(
    [],
  )
  expect(source.sessionState!.mainAgentState.messageHistory).toHaveLength(5)
  expect(source.sessionState!.mainAgentState.output).toEqual({
    status: 'success',
  })
  expect(messages).toHaveLength(4)
})

test('legacy or missing prompt boundary refuses to invent a continuation', () => {
  const source = state([prompt('one')])
  expect(
    forkConversationBeforeMessage(source, [visible('u1', 'user')], 'u1').status,
  ).toBe('unavailable')
  expect(forkConversationBeforeMessage(null, [], 'u1').status).toBe(
    'unavailable',
  )
})

test('fork removes future branch memory and control state while retaining actual workspace evidence', () => {
  const source = stampRunPromptBoundary(state([prompt('edited')]), 'u1')
  const main = source.sessionState!.mainAgentState
  Object.assign(main, {
    taskMemory: { goal: 'future-only decision' },
    base2ActiveWork: { tasks: ['future-only task'] },
    compactionArchive: [{ messages: ['future-only archive'] }],
    contextConsolidations: ['future-only summary'],
    memoryV2Context: { text: 'future-only recall' },
    memoryV2: { activeTask: 'future-only task' },
    orchestrationLedger: { events: ['future-only event'] },
    workflowStates: { future: {} },
    workspaceState: { revision: 42 },
  })
  const fork = forkConversationBeforeMessage(
    source,
    [visible('u1', 'user')],
    'u1',
  )
  if (fork.status !== 'ready') throw new Error(fork.reason)
  const branched = fork.runState.sessionState.mainAgentState
  for (const field of [
    'taskMemory',
    'base2ActiveWork',
    'memoryV2Context',
    'memoryV2',
    'orchestrationLedger',
    'workflowStates',
  ] as const)
    expect(branched[field]).toBeUndefined()
  expect(branched.compactionArchive).toEqual([])
  expect(branched.contextConsolidations).toEqual([])
  expect(branched.contextArchiveHydration).toBe('in-memory-only')
  expect(branched.workspaceState).toBe(main.workspaceState)
  expect(main.taskMemory).toBeDefined()
  expect(main.compactionArchive).toHaveLength(1)
})

test('tagging the latest user prompt preserves earlier tags and does not mutate the SDK state', () => {
  const source = state([
    prompt('one'),
    { role: 'assistant', content: 'answer' },
    prompt('two'),
  ])
  const stamped = stampRunPromptBoundary(source, 'latest')
  expect(stamped.sessionState!.mainAgentState.messageHistory[2].tags).toEqual([
    'USER_PROMPT',
    'OPENBUFF_UI_PROMPT:latest',
  ])
  expect(source.sessionState!.mainAgentState.messageHistory[2].tags).toEqual([
    'USER_PROMPT',
  ])
  expect(
    stampRunPromptBoundary(stamped, 'latest').sessionState!.mainAgentState
      .messageHistory[2].tags,
  ).toHaveLength(2)
})

test('undo and redo restore the continuation that matches each visible transcript', () => {
  const original = stampRunPromptBoundary(state([prompt('one')]), 'u1')
  const edited = stampRunPromptBoundary(state([prompt('replacement')]), 'u2')
  const store = useChatStore.getState()
  store.setMessages([visible('u1', 'user')])
  store.setRunState(original)
  store.pushMessageSnapshot()
  store.setMessages([visible('u2', 'user')])
  store.setRunState(edited)
  store.undoMessages()
  expect(useChatStore.getState().messages[0].id).toBe('u1')
  expect(useChatStore.getState().runState).toEqual(original)
  store.redoMessages()
  expect(useChatStore.getState().messages[0].id).toBe('u2')
  expect(useChatStore.getState().runState).toEqual(edited)
})
