import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ChatMessage } from '../../types/chat'
import type { RunState } from '@openbuff/sdk'

process.env.NEXT_PUBLIC_CB_ENVIRONMENT ??= 'test'
process.env.NEXT_PUBLIC_CODEBUFF_APP_URL ??= 'https://app.codebuff.test'
process.env.NEXT_PUBLIC_SUPPORT_EMAIL ??= 'support@codebuff.test'
process.env.NEXT_PUBLIC_POSTHOG_API_KEY ??= 'phc_test_key'
process.env.NEXT_PUBLIC_POSTHOG_HOST_URL ??= 'https://posthog.codebuff.test'

const projectFiles = await import('../../project-files')
const { useChatStore } = await import('../../state/chat-store')
const { prepareUserMessage } = await import('../../hooks/helpers/send-message')
const { saveChatState, getChatStatePath } = await import('../run-state-storage')
const { drainPersistenceQueue } = await import('../persistence-queue')

const facts = [
  'timeoutMs=1500',
  'forcePushMainRequiresExplicitRequest=true; do not force-push main without an explicit request',
  'blockerId=contract-consumer-v2; status=open',
  'sourceRevision=order-schema@2',
  'nextAction=verify-order-contract-before-task-acceptance',
  'represent amounts in integer minor units; avoid binary floating-point drift at the shared contract',
]

async function withOwnedSession(
  run: (fixture: {
    project: string
    config: string
    chatId: string
  }) => Promise<void>,
) {
  const owned = mkdtempSync(path.join(tmpdir(), 'openbuff-b13-transcript-'))
  const project = path.join(owned, 'project')
  const config = path.join(owned, 'config')
  mkdirSync(project)
  mkdirSync(config)
  const previousConfig = process.env.OPENBUFF_CONFIG_DIR
  let previousProject: string | undefined
  try {
    previousProject = projectFiles.getProjectRoot()
  } catch {}
  const previousChat = projectFiles.getCurrentChatId()
  const chatId = `b13-${crypto.randomUUID()}`
  try {
    process.env.OPENBUFF_CONFIG_DIR = config
    projectFiles.setProjectRoot(project)
    projectFiles.setCurrentChatId(chatId)
    useChatStore.getState().reset()
    await run({ project, config, chatId })
  } finally {
    await drainPersistenceQueue()
    useChatStore.getState().reset()
    if (previousConfig === undefined) delete process.env.OPENBUFF_CONFIG_DIR
    else process.env.OPENBUFF_CONFIG_DIR = previousConfig
    if (previousProject) projectFiles.setProjectRoot(previousProject)
    projectFiles.setCurrentChatId(previousChat)
    rmSync(owned, { recursive: true, force: true })
  }
}

async function loadInFreshProcess(fixture: {
  project: string
  config: string
  chatId: string
}) {
  const source = `
    globalThis.fetch = async () => { throw new Error('B13 fixture forbids provider/network entry') }
    const projectFiles = await import(${JSON.stringify(path.resolve(import.meta.dir, '../../project-files.ts'))})
    projectFiles.setProjectRoot(${JSON.stringify(fixture.project)})
    const { loadMostRecentChatStateAsync } = await import(${JSON.stringify(path.resolve(import.meta.dir, '../run-state-storage.ts'))})
    const loaded = await loadMostRecentChatStateAsync(${JSON.stringify(fixture.chatId)})
    if (!loaded) throw new Error('Saved B13 transcript did not restore')
    process.stdout.write('B13_TRANSCRIPT_RESULT:' + JSON.stringify({ pid: process.pid, home: process.env.HOME, ...loaded }) + '\\n')
  `
  const child = Bun.spawn(
    [process.execPath, '--no-env-file', '--no-install', '-e', source],
    {
      cwd: fixture.project,
      env: {
        ...process.env,
        OPENBUFF_CONFIG_DIR: fixture.config,
        OPENBUFF_TELEMETRY: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  const resultLine = stdout
    .split('\n')
    .find((line) => line.startsWith('B13_TRANSCRIPT_RESULT:'))
  expect(resultLine).toBeDefined()
  const loaded = JSON.parse(
    resultLine!.slice('B13_TRANSCRIPT_RESULT:'.length),
  ) as {
    pid: number
    home?: string
    messages: ChatMessage[]
    runState: RunState
    chatId: string
  }
  expect(loaded.pid).not.toBe(process.pid)
  expect(loaded.home).toBe(process.env.HOME)
  return loaded
}

test('500 actual prepareUserMessage sends save, drain and resume all IDs and bodies in a fresh process', async () => {
  await withOwnedSession(async (fixture) => {
    let messages: ChatMessage[] = []
    const sent: ChatMessage[] = []
    for (let index = 0; index < 500; index++) {
      const content = `MESSAGE-${String(index).padStart(3, '0')}\n${facts[index] ?? 'ordinary chronological message'}\n${'retained body '.repeat(45)}TAIL-${index}`
      const prepared = await prepareUserMessage({
        content,
        agentMode: 'DEFAULT',
        attachments: [],
        deps: {
          setMessages: (update) => {
            messages = typeof update === 'function' ? update(messages) : update
          },
          lastMessageMode: 'DEFAULT',
          setLastMessageMode: () => {},
          scrollToLatest: () => {},
          setHasReceivedPlanResponse: () => {},
        },
      })
      const message = messages.find(
        (item) => item.id === prepared.userMessageId,
      )!
      expect(message.content).toBe(content)
      sent.push(message)
    }
    expect(messages).toHaveLength(500)
    expect(messages.map((message) => message.id)).toEqual(
      sent.map((message) => message.id),
    )
    for (let index = 0; index < sent.length; index++)
      expect(messages[index]).toBe(sent[index])
    // This is CLI transcript fidelity, not a claim about SDK/model continuity.
    const runState: RunState = { output: { type: 'lastMessage', value: [] } }
    saveChatState(runState, messages)
    await drainPersistenceQueue()
    const savedPath = getChatStatePath()
    expect(savedPath.startsWith(fixture.config + path.sep)).toBe(true)
    expect(statSync(savedPath).size).toBeGreaterThan(64 * 1024)
    expect(statSync(savedPath).mode & 0o777).toBe(0o600)
    const loaded = await loadInFreshProcess(fixture)
    expect(loaded.messages).toEqual(sent)
    expect(loaded.chatId).toBe(fixture.chatId)
    expect(loaded.runState).toEqual(runState)
    for (let index = 0; index < facts.length; index++)
      expect(loaded.messages[index].content).toContain(facts[index])
    expect(
      JSON.parse(
        readFileSync(
          path.join(path.dirname(savedPath), 'chat-messages.json'),
          'utf8',
        ),
      ),
    ).toEqual(sent)
  })
}, 20_000)

test('non-cloneable state takes the synchronous save fallback without capping a 500-message transcript', async () => {
  await withOwnedSession(async (fixture) => {
    const messages: ChatMessage[] = Array.from({ length: 500 }, (_, index) => ({
      id: `fallback-${index}`,
      variant: index % 2 ? 'ai' : 'user',
      content: `fallback body ${index}`,
      timestamp: '2026-11-25T00:00:00Z',
    }))
    const runState = {
      output: { type: 'lastMessage' as const, value: [] },
      nonCloneable: () => {},
    }
    saveChatState(runState, messages)
    await drainPersistenceQueue()
    const loaded = await loadInFreshProcess(fixture)
    expect(loaded.messages).toEqual(messages)
    expect(loaded.runState.output).toEqual(runState.output)
  })
}, 20_000)
