import { describe, expect, test } from 'bun:test'

import { filterOutDeletedChats } from '../chat-history-screen'

type ChatSummary = { chatId: string; messageCount: number }

const chat = (chatId: string, messageCount = 1): ChatSummary => ({
  chatId,
  messageCount,
})

describe('filterOutDeletedChats', () => {
  test('filters out chats deleted while the background load was in flight', () => {
    const loaded = [chat('a'), chat('deleted-while-loading'), chat('c')]
    const deleted = new Set(['deleted-while-loading'])

    // Regression guard for the reliability finding: the terminal
    // getAllChatsAsync result must not resurrect a chat that was deleted
    // between load start and load settle.
    expect(filterOutDeletedChats(loaded, deleted)).toEqual([
      chat('a'),
      chat('c'),
    ])
  })

  test('passes the loaded list through untouched when nothing was deleted', () => {
    const loaded = [chat('a'), chat('b')]

    expect(filterOutDeletedChats(loaded, new Set())).toBe(loaded)
  })

  test('filters every deleted id, including all entries when all are deleted', () => {
    const loaded = [chat('a'), chat('b'), chat('c')]

    expect(
      filterOutDeletedChats(loaded, new Set(['a', 'c'])),
    ).toEqual([chat('b')])
    expect(
      filterOutDeletedChats(loaded, new Set(['a', 'b', 'c'])),
    ).toEqual([])
  })

  test('ignores deleted ids that are not part of the loaded snapshot', () => {
    const loaded = [chat('a'), chat('b')]

    expect(filterOutDeletedChats(loaded, new Set(['missing']))).toEqual(loaded)
  })
})
