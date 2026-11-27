import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import React, { useRef } from 'react'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.NEXT_PUBLIC_CB_ENVIRONMENT ??= 'test'
process.env.NEXT_PUBLIC_CODEBUFF_APP_URL ??= 'https://app.codebuff.test'
process.env.NEXT_PUBLIC_SUPPORT_EMAIL ??= 'support@codebuff.test'
process.env.NEXT_PUBLIC_POSTHOG_API_KEY ??= 'phc_test_key'
process.env.NEXT_PUBLIC_POSTHOG_HOST_URL ??= 'https://posthog.codebuff.test'

const { useSendMessage } = await import('../use-send-message')
const { useChatStore } = await import('../../state/chat-store')
const storage = await import('../../utils/run-state-storage')
const project = await import('../../project-files')
const { drainPersistenceQueue } = await import('../../utils/persistence-queue')
const { SessionRestoreScreen } =
  await import('../../components/session-restore-screen')
const { initializeThemeStore } = await import('../use-theme')
const { resetProjectMemoryV2Provider } =
  await import('../../services/memory-v2/provider')
const clients = await import('../../utils/codebuff-client')
const registries = await import('../../services/deferred-registries')
initializeThemeStore()

let owned: string,
  previousConfig: string | undefined,
  previousRoot: string | undefined,
  previousChat: string
let setup:
  | Awaited<ReturnType<typeof import('@opentui/react/test-utils').testRender>>
  | undefined
let hook: ReturnType<typeof useSendMessage> | undefined
let validations: number, clientEntries: number, pauses: number
const selected = 'selected-b13-session'

beforeEach(() => {
  owned = mkdtempSync(path.join(tmpdir(), 'openbuff-b13-restore-'))
  mkdirSync(path.join(owned, 'project'))
  mkdirSync(path.join(owned, 'config'))
  previousConfig = process.env.OPENBUFF_CONFIG_DIR
  try {
    previousRoot = project.getProjectRoot()
  } catch {
    previousRoot = undefined
  }
  previousChat = project.getCurrentChatId()
  process.env.OPENBUFF_CONFIG_DIR = path.join(owned, 'config')
  project.setProjectRoot(path.join(owned, 'project'))
  project.setCurrentChatId(selected)
  useChatStore.getState().reset()
  useChatStore.setState({
    inputValue: 'draft must survive',
    pendingAttachments: [
      {
        kind: 'text',
        id: 'attachment',
        content: 'retained context',
        preview: 'retained context',
        charCount: 16,
      },
    ] as never,
  })
  validations = 0
  clientEntries = 0
  pauses = 0
  hook = undefined
  spyOn(registries, 'whenRegistriesReady').mockResolvedValue(undefined)
  spyOn(clients, 'getCodebuffClient').mockImplementation(async () => {
    clientEntries++
    throw new Error('Restore fixture forbids SDK/provider entry')
  })
})

afterEach(async () => {
  if (setup) {
    await React.act(async () => setup!.renderer.destroy())
    setup = undefined
  }
  await drainPersistenceQueue()
  await resetProjectMemoryV2Provider()
  mock.restore()
  useChatStore.getState().reset()
  if (previousConfig === undefined) delete process.env.OPENBUFF_CONFIG_DIR
  else process.env.OPENBUFF_CONFIG_DIR = previousConfig
  if (previousRoot) project.setProjectRoot(previousRoot)
  project.setCurrentChatId(previousChat)
  rmSync(owned, { recursive: true, force: true })
})

function Harness() {
  const chain = useRef(false),
    paused = useRef(false),
    processing = useRef(false)
  const active = useRef(new Set<string>()),
    abort = useRef<AbortController | null>(null)
  hook = useSendMessage({
    inputRef: useRef(null),
    activeSubagentsRef: active,
    isChainInProgressRef: chain,
    setStreamStatus: () => {},
    setContextWindowUsage: () => {},
    setCompactionNotice: () => {},
    setCanProcessQueue: () => {},
    abortControllerRef: abort,
    onBeforeMessageSend: async () => {
      validations++
      return { success: true, errors: [] }
    },
    mainAgentTimer: {
      start: () => {},
      stop: () => {},
      pause: () => {},
      resume: () => {},
      elapsedSeconds: 0,
      startTime: null,
      isPaused: false,
    } as never,
    scrollToLatest: () => {},
    isQueuePausedRef: paused,
    isProcessingQueueRef: processing,
    pauseQueue: () => {
      pauses++
      paused.current = true
    },
    continueChat: true,
    continueChatId: selected,
  })
  const state = useChatStore((value) => value.sessionRestore)
  return state ? (
    <SessionRestoreScreen
      state={state}
      onRetry={hook.retryRestore}
      onCancel={hook.cancelRestore}
    />
  ) : (
    <text>Conversation ready</text>
  )
}

async function mount() {
  const { testRender } = await import('@opentui/react/test-utils')
  await React.act(async () => {
    setup = await testRender(<Harness />, { width: 100, height: 20 })
  })
}
async function settle(predicate: () => boolean) {
  for (let attempt = 0; attempt < 150 && !predicate(); attempt++)
    await React.act(async () => {
      await Bun.sleep(5)
    })
  expect(predicate()).toBe(true)
  await setup!.renderOnce()
}

const savedMessages = [
  {
    id: 'original-message',
    variant: 'user' as const,
    content: 'original retained conversation',
    timestamp: '2026-11-25T00:00:00Z',
  },
]
const savedState = { output: { type: 'lastMessage' as const, value: [] } }

const renderIt = process.env.NODE_ENV === 'production' ? it.skip : it

describe('B13 mounted selected-session recovery', () => {
  for (const kind of ['missing', 'corrupt'] as const) {
    renderIt(
      `${kind} selection blocks send before draft/attachment drain and retry restores the actual saved file`,
      async () => {
        if (kind === 'corrupt') {
          const dir = path.dirname(storage.getChatStatePath())
          for (const file of [
            'chat-state.json',
            'run-state.json',
            'chat-messages.json',
          ])
            writeFileSync(path.join(dir, file), '{invalid')
        }
        await mount()
        await settle(
          () => useChatStore.getState().sessionRestore?.status === 'error',
        )
        const frame = setup!.captureCharFrame()
        expect(frame).toContain('Could not restore the selected session')
        expect(frame).toContain('Retry')
        expect(frame).toContain('Cancel')
        await React.act(async () => {
          await hook!.sendMessage({
            content: 'draft must survive',
            agentMode: 'DEFAULT' as never,
          })
        })
        expect(validations).toBe(0)
        expect(clientEntries).toBe(0)
        expect(useChatStore.getState().messages).toEqual([])
        expect(useChatStore.getState().inputValue).toBe('draft must survive')
        expect(useChatStore.getState().pendingAttachments).toHaveLength(1)
        storage.saveChatState(savedState, savedMessages)
        await drainPersistenceQueue()
        await React.act(async () => setup!.mockInput.pressKey('r'))
        await settle(
          () =>
            useChatStore.getState().sessionRestore === null &&
            useChatStore.getState().runState !== null,
        )
        expect(useChatStore.getState().messages).toEqual(savedMessages)
        expect(useChatStore.getState().runState).toEqual(savedState)
        expect(useChatStore.getState().inputValue).toBe('draft must survive')
        expect(clientEntries).toBe(0)
        expect(project.getCurrentChatId()).toBe(selected)
        expect(setup!.captureCharFrame()).toContain('Conversation ready')
      },
      10_000,
    )
  }

  renderIt(
    'cancel aborts an in-flight restore, preserves draft/queue and ignores the late old result',
    async () => {
      let release!: (value: {
        runState: typeof savedState
        messages: typeof savedMessages
        chatId: string
      }) => void
      let signal: AbortSignal | undefined
      spyOn(storage, 'loadMostRecentChatStateAsync').mockImplementation(
        (_id, capturedSignal) => {
          signal = capturedSignal
          return new Promise((resolve) => {
            release = resolve
          })
        },
      )
      await mount()
      await settle(
        () => useChatStore.getState().sessionRestore?.status === 'loading',
      )
      expect(setup!.captureCharFrame()).toContain('Restoring saved session')
      await React.act(async () => setup!.mockInput.pressEscape())
      await settle(
        () =>
          signal?.aborted === true &&
          useChatStore.getState().sessionRestore === null,
      )
      expect(signal?.aborted).toBe(true)
      expect(useChatStore.getState().sessionRestore).toBeNull()
      expect(project.getCurrentChatId()).not.toBe(selected)
      expect(useChatStore.getState().inputValue).toBe('draft must survive')
      expect(useChatStore.getState().pendingAttachments).toHaveLength(1)
      expect(pauses).toBe(1)
      await React.act(async () => {
        release({
          runState: savedState,
          messages: savedMessages,
          chatId: selected,
        })
        await Bun.sleep(5)
      })
      expect(useChatStore.getState().messages).toEqual([])
      expect(useChatStore.getState().runState).toBeNull()
      expect(project.getCurrentChatId()).not.toBe(selected)
      expect(clientEntries).toBe(0)
    },
    10_000,
  )
})
