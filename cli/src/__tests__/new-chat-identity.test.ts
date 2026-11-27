import { expect, test } from 'bun:test'
import { getCurrentChatId, setCurrentChatId, startNewChat } from '../project-files'

test('rapid New Chat actions always have distinct persistence identities and accept legacy restored IDs', () => {
  const original = getCurrentChatId()
  try {
    setCurrentChatId('legacy-session')
    expect(getCurrentChatId()).toBe('legacy-session')
    const ids = Array.from({ length: 100 }, () => startNewChat())
    expect(new Set(ids).size).toBe(100)
    expect(ids.every((id) => id !== 'legacy-session')).toBe(true)
    expect(getCurrentChatId()).toBe(ids.at(-1)!)
  } finally { setCurrentChatId(original) }
})
