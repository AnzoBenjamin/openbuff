import { beforeEach, describe, expect, test } from 'bun:test'

import {
  MAX_PAST_MESSAGE_SNAPSHOTS,
  useChatStore,
} from '../chat-store'

import type { ChatMessage } from '../../types/chat'

const makeMessage = (
  id: string,
  runState?: unknown,
): ChatMessage => ({
  id,
  variant: 'ai',
  content: `message-${id}`,
  timestamp: '',
  metadata: runState === undefined ? undefined : { runState },
})

const setMessages = (messages: ChatMessage[]): void => {
  useChatStore.getState().setMessages(messages)
}

describe('chat-store pastMessageSnapshots', () => {
  beforeEach(() => {
    useChatStore.getState().reset()
  })

  test(`pushMessageSnapshot drops the oldest past MAX_PAST_MESSAGE_SNAPSHOtS (${MAX_PAST_MESSAGE_SNAPSHOTS}) entries`, () => {
    const overshoot = 3
    for (let i = 0; i < MAX_PAST_MESSAGE_SNAPSHOTS + overshoot; i += 1) {
      setMessages([makeMessage(`msg-${i}`)])
      useChatStore.getState().pushMessageSnapshot()
    }

    const past = useChatStore.getState().pastMessageSnapshots

    expect(past).toHaveLength(MAX_PAST_MESSAGE_SNAPSHOTS)
    // The OLDEST snapshots (msg-0 .. msg-2) were dropped, not the newest:
    // the first retained entry is the overshoot-th one, and the last is
    // the newest snapshot.
    expect(past[0]?.[0]?.id).toBe(`msg-${overshoot}`)
    expect(
      past[past.length - 1]?.[0]?.id,
    ).toBe(`msg-${MAX_PAST_MESSAGE_SNAPSHOTS + overshoot - 1}`)
  })

  test('undo still restores the newest snapshot under the cap', () => {
    for (let i = 0; i < MAX_PAST_MESSAGE_SNAPSHOTS + 3; i += 1) {
      setMessages([makeMessage(`msg-${i}`)])
      useChatStore.getState().pushMessageSnapshot()
    }

    useChatStore.getState().undoMessages()

    const state = useChatStore.getState()
    // undoMessages pops the newest snapshot (slice(0, -1)) and restores it.
    expect(state.messages[0]?.id).toBe(
      `msg-${MAX_PAST_MESSAGE_SNAPSHOTS + 2}`,
    )
    expect(state.pastMessageSnapshots).toHaveLength(
      MAX_PAST_MESSAGE_SNAPSHOTS - 1,
    )
    // The popped snapshot moved onto the redo stack.
    expect(state.futureMessageSnapshots).toHaveLength(1)
    expect(state.futureMessageSnapshots[0]?.[0]?.id).toBe(
      `msg-${MAX_PAST_MESSAGE_SNAPSHOTS + 3 - 1}`,
    )
  })

  test('undo then redo round-trips through the capped stacks', () => {
    for (let i = 0; i < 5; i += 1) {
      setMessages([makeMessage(`msg-${i}`)])
      useChatStore.getState().pushMessageSnapshot()
    }
    setMessages([makeMessage('msg-final')])

    useChatStore.getState().undoMessages()
    expect(
      useChatStore.getState().messages.map((m) => m.id),
    ).toEqual(['msg-4'])

    useChatStore.getState().redoMessages()
    const state = useChatStore.getState()
    expect(state.messages.map((m) => m.id)).toEqual(['msg-final'])
    expect(state.pastMessageSnapshots).toHaveLength(5)
    expect(state.futureMessageSnapshots).toHaveLength(0)
  })

  test('snapshots strip metadata.runState instead of deep-cloning RunState bodies', () => {
    const transcriptBody = {
      sessionState: { mainAgentState: { messages: [{ text: 'x'.repeat(8192) }] } },
    }
    setMessages([
      makeMessage('msg-with-runstate', transcriptBody),
      makeMessage('msg-plain'),
    ])
    useChatStore.getState().pushMessageSnapshot()

    const snapshots = useChatStore.getState().pastMessageSnapshots
    expect(snapshots).toHaveLength(1)
    // The RunState body was replaced with nothing in the snapshot; the LIVE
    // message still carries it (the strip only affects stored snapshots).
    expect(snapshots[0]?.[0]?.metadata?.runState).toBeUndefined()
    expect(
      useChatStore.getState().messages[0]?.metadata?.runState,
    ).toEqual(transcriptBody)
    // Non-runState snapshot metadata is preserved.
    expect(snapshots[0]?.[0]?.content).toBe('message-msg-with-runstate')
    expect(useChatStore.getState().messages[0]?.content).toBe(
      'message-msg-with-runstate',
    )
  })

  test('undo restores a snapshot stripped of runState (render path unaffected)', () => {
    setMessages([makeMessage('msg-with-runstate', { big: 'body' })])
    useChatStore.getState().pushMessageSnapshot()
    setMessages([makeMessage('msg-after')])

    useChatStore.getState().undoMessages()

    const state = useChatStore.getState()
    expect(state.messages[0]?.id).toBe('msg-with-runstate')
    expect(state.messages[0]?.metadata?.runState).toBeUndefined()
  })
})
