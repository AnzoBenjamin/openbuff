import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import * as projectFiles from '../../project-files'

let tempDataDir = ''

// spyOn (restored after each test) instead of mock.module: a module mock
// leaks into every other test file in the same bun process.

import {
  deleteChatSession,
  getAllChats,
  getAllChatsAsync,
} from '../chat-history'

function writeChat(chatId: string, prompt: string) {
  const chatDir = path.join(tempDataDir, 'chats', chatId)
  fs.mkdirSync(chatDir, { recursive: true })
  fs.writeFileSync(
    path.join(chatDir, 'chat-messages.json'),
    JSON.stringify([
      {
        id: `${chatId}-message`,
        variant: 'user',
        content: prompt,
        timestamp: new Date().toISOString(),
        blocks: [],
      },
    ]),
  )
}

describe('chat-history', () => {
  beforeEach(() => {
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuff-history-'))
    spyOn(projectFiles, 'getProjectDataDir').mockReturnValue(tempDataDir)
  })

  afterEach(() => {
    mock.restore()
    fs.rmSync(tempDataDir, { recursive: true, force: true })
  })

  test('deleteChatSession removes a saved chat directory', () => {
    writeChat('chat-a', 'hello from chat a')
    writeChat('chat-b', 'hello from chat b')

    expect(deleteChatSession('chat-a')).toBe(true)

    expect(fs.existsSync(path.join(tempDataDir, 'chats', 'chat-a'))).toBe(false)
    expect(fs.existsSync(path.join(tempDataDir, 'chats', 'chat-b'))).toBe(true)
    expect(getAllChats().map((chat) => chat.chatId)).toEqual(['chat-b'])
  })

  test('deleteChatSession rejects invalid chat ids', () => {
    const outsideDir = path.join(tempDataDir, 'outside')
    fs.mkdirSync(outsideDir, { recursive: true })

    expect(deleteChatSession('../outside')).toBe(false)
    expect(deleteChatSession('..')).toBe(false)

    expect(fs.existsSync(outsideDir)).toBe(true)
  })

  test('deleteChatSession returns false when the chat does not exist', () => {
    expect(deleteChatSession('missing-chat')).toBe(false)
  })

  test('a cancelled history load stops before reading chat directories', async () => {
    writeChat('chat-a', 'hello')
    const controller = new AbortController()
    controller.abort()
    const stat = spyOn(fs.promises, 'stat')

    expect(await getAllChatsAsync(500, controller.signal)).toEqual([])
    expect(stat).not.toHaveBeenCalled()
  })

  test('progressive loading reads each chat once and returns both batches', async () => {
    writeChat('chat-a', 'prompt a')
    writeChat('chat-b', 'prompt b')
    writeChat('chat-c', 'prompt c')
    const readFile = spyOn(fs.promises, 'readFile')
    const initial: string[][] = []
    const entries = await getAllChatsAsync(
      3,
      undefined,
      (chats) => {
        initial.push(chats.map((chat) => chat.chatId))
      },
      1,
    )
    expect(initial).toHaveLength(1)
    expect(initial[0]).toEqual([entries[0].chatId])
    expect(entries).toHaveLength(3)
    expect(readFile).toHaveBeenCalledTimes(3)
  })
})
