import { afterEach, expect, test } from 'bun:test'
import { useChatStore } from '../../state/chat-store'
import {
  clearUsageObservations,
  recordUsageObservation,
  usageSnapshot,
} from '../../utils/usage-observations'
import { createEventHandler } from '../../utils/sdk-event-handlers'
import { formatUsageReport } from '../usage'
import { findCommand } from '../command-registry'
import {
  SLASH_COMMANDS,
  formatCommandDirectory,
} from '../../data/slash-commands'
import type { EventHandlerState } from '../../utils/sdk-event-handlers'
import type { RouterParams } from '../command-registry'
import type { ChatMessage } from '../../types/chat'

afterEach(() => {
  clearUsageObservations()
  useChatStore.getState().reset()
})
test('actual SDK event handler captures usage without adding prose and isolates a replacement conversation', () => {
  useChatStore.getState().reset()
  const old = useChatStore.getState().chatSessionId
  const handle = createEventHandler({
    message: { aiMessageId: 'turn' },
  } as EventHandlerState)
  handle({
    type: 'usage',
    runId: 'root',
    model: 'p/m',
    inputTokens: 100,
    outputTokens: 5,
    complete: true,
    costStatus: 'estimated',
    costCents: 0.0018,
  })
  expect(usageSnapshot(old).observations).toBe(1)
  expect(useChatStore.getState().messages).toEqual([])
  useChatStore.getState().reset()
  handle({
    type: 'usage',
    runId: 'late-old',
    complete: false,
    costStatus: 'unknown',
  })
  expect(
    usageSnapshot(useChatStore.getState().chatSessionId).observations,
  ).toBe(0)
  expect(usageSnapshot(old).observations).toBe(2)
})
test('local /usage report exposes tokens, incomplete fields, root/child models and unknown reasons', () => {
  useChatStore.getState().reset()
  const session = useChatStore.getState().chatSessionId
  recordUsageObservation(session, 'turn', {
    type: 'usage',
    runId: 'root',
    model: 'provider/model',
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 4,
    complete: true,
    costStatus: 'estimated',
    costCents: 0.0018,
  })
  recordUsageObservation(session, 'turn', {
    type: 'usage',
    runId: 'child',
    model: 'provider/child',
    inputTokens: 5,
    complete: false,
    costStatus: 'unknown',
    costReason: 'Provider usage incomplete',
  })
  const report = formatUsageReport()
  expect(report).toContain('Input: 15')
  expect(report).toContain('Output: 2 known subtotal · incomplete')
  expect(report).toContain('Cache read: 4 known subtotal · incomplete')
  expect(report).toContain('$0.000018')
  expect(report).toContain('1 request cost(s) unknown')
  expect(report).toContain('Provider usage incomplete')
  expect(report).toContain('provider/child')
  expect(report).toContain('Context: not reported')
  expect(report).toContain('Cache write: not reported')
})
test('/usage is discoverable and its actual registry handler never sends a provider prompt', async () => {
  let messages: ChatMessage[] = [],
    saved = '',
    cleared = false,
    providerCalls = 0
  const command = findCommand('usage')
  expect(command).toBeDefined()
  expect(SLASH_COMMANDS.some((command) => command.id === 'usage')).toBe(true)
  expect(formatCommandDirectory()).toContain('/usage')
  await command!.handler(
    {
      inputValue: '/usage',
      setMessages: (
        update: ((previous: ChatMessage[]) => ChatMessage[]) | ChatMessage[],
      ) => {
        messages = typeof update === 'function' ? update(messages) : update
      },
      saveToHistory: (value: string) => {
        saved = value
      },
      setInputValue: () => {
        cleared = true
      },
      sendMessage: async () => {
        providerCalls++
      },
      inputRef: { current: null },
    } as unknown as RouterParams,
    '',
  )
  expect(providerCalls).toBe(0)
  expect(saved).toBe('/usage')
  expect(cleared).toBe(true)
  expect(messages).toHaveLength(1)
  expect(messages[0].variant).toBe('ai')
  expect(messages[0].isComplete).toBe(true)
  expect(messages[0].content).toContain('No usage events observed')
  expect(messages[0].content).not.toContain('$0.00')
})
