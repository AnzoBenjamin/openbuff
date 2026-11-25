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
  test('history reports unreadable sessions separately from an empty result', async () => {
    writeChat('broken', 'old prompt')
    fs.writeFileSync(
      path.join(tempDataDir, 'chats', 'broken', 'chat-messages.json'),
      'invalid JSON',
    )
    const states: unknown[] = []
    const entries = await getAllChatsAsync(500, undefined, undefined, 25, (state) =>
        states.push(state),
      )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ chatId: 'broken', messageCountKnown: false, captureUnavailable: true })
    expect(states).toEqual([{ state: 'partial', omitted: 1 }])
  })

  test('log-only new chats and valid empty transcripts are omitted by both readers', async () => {
    const dir = path.join(tempDataDir, 'chats', 'new-chat')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'log.jsonl'), 'startup log')
    const empty = path.join(tempDataDir, 'chats', 'empty')
    fs.mkdirSync(empty, { recursive: true })
    fs.writeFileSync(path.join(empty, 'chat-messages.json'), '[]')
    const states: unknown[] = []
    expect(getAllChats()).toEqual([])
    expect(await getAllChatsAsync(500, undefined, undefined, 25, state => states.push(state))).toEqual([])
    expect(states).toEqual([{ state: 'loaded', omitted: 0 }])
    expect(fs.existsSync(path.join(dir, 'log.jsonl'))).toBe(true)
  })

  test('the authoritative envelope supplies history when its sidecar is absent or stale', async () => {
    writeChat('envelope', 'stale sidecar')
    const dir = path.join(tempDataDir, 'chats', 'envelope')
    const messages = JSON.parse(fs.readFileSync(path.join(dir, 'chat-messages.json'), 'utf8'))
    messages[0].content = 'authoritative prompt'
    fs.writeFileSync(path.join(dir, 'chat-state.json'), JSON.stringify({ version: 1, runState: {}, messages }))
    expect(getAllChats()[0]?.lastPrompt).toBe('authoritative prompt')
    expect((await getAllChatsAsync())[0]?.lastPrompt).toBe('authoritative prompt')
    fs.unlinkSync(path.join(dir, 'chat-messages.json'))
    expect((await getAllChatsAsync())[0]).toMatchObject({ lastPrompt: 'authoritative prompt', messageCount: 1 })
  })

  test.each(['corrupt', 'unsupported', 'run-only'])('%s saved state retains a recovery entry without any writes', async kind => {
    const dir = path.join(tempDataDir, 'chats', kind)
    fs.mkdirSync(dir, { recursive: true })
    const name = kind === 'run-only' ? 'run-state.json' : 'chat-state.json'
    const bytes = kind === 'corrupt' ? '{broken' : kind === 'unsupported' ? '{"version":999,"messages":[]}' : '{}'
    fs.writeFileSync(path.join(dir, name), bytes)
    expect(getAllChats()[0]).toMatchObject({ captureUnavailable: true, messageCountKnown: false })
    expect((await getAllChatsAsync())[0]).toMatchObject({ captureUnavailable: true, messageCountKnown: false })
    expect(fs.readdirSync(dir)).toEqual([name])
    expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe(bytes)
  })
})
