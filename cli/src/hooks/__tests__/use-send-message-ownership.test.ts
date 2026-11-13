import { test, expect, spyOn, mock } from 'bun:test'
import React from 'react'
import { enableMapSet } from 'immer'
enableMapSet()

process.env.NEXT_PUBLIC_CB_ENVIRONMENT = 'test'
process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'https://app.codebuff.test'
process.env.NEXT_PUBLIC_SUPPORT_EMAIL = 'support@codebuff.test'
process.env.NEXT_PUBLIC_POSTHOG_API_KEY = 'phc_test_key'
process.env.NEXT_PUBLIC_POSTHOG_HOST_URL = 'https://posthog.codebuff.test'
const { useSendMessage } = await import('../use-send-message')
const { useChatStore } = await import('../../state/chat-store')
const registries = await import('../../services/deferred-registries')
const yielding = await import('../../utils/yield-to-event-loop')
const { setProjectRoot } = await import('../../project-files')
const clientModule = await import('../../utils/codebuff-client')
const providerModule = await import('../../utils/openbuff-provider')
const agentModule = await import('../../utils/local-agent-registry')
const configModule = await import('../../utils/create-run-config')
const journalModule = await import('../../utils/run-journal-path')
const internals = (React as any)
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

test('replacing the conversation during old failure yield keeps a newer submission busy', async () => {
  const original = internals.H
  const noop = () => {}
  internals.H = {
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (fn: unknown) => fn,
    useEffect: noop,
  }
  useChatStore.getState().reset()
  setProjectRoot('/tmp')
  let validations = 0
  let releaseValidation!: (value: { success: boolean; errors: [] }) => void
  const secondValidation = new Promise<{ success: boolean; errors: [] }>(
    (resolve) => {
      releaseValidation = resolve
    },
  )
  const chain = { current: false }
  let replacement: Promise<unknown> | undefined
  let replaced = false
  const options = {
    inputRef: { current: null },
    activeSubagentsRef: { current: new Set<string>() },
    isChainInProgressRef: chain,
    setStreamStatus: noop,
    setContextWindowUsage: noop,
    setCompactionNotice: noop,
    setCanProcessQueue: noop,
    abortControllerRef: { current: null },
    onBeforeMessageSend: async () => {
      if (++validations === 1) throw new Error('old validation fixture failure')
      return secondValidation
    },
    mainAgentTimer: {
      start: noop,
      stop: noop,
      pause: noop,
      resume: noop,
      elapsedSeconds: 0,
      startTime: null,
      isPaused: false,
    },
    scrollToLatest: noop,
    continueChat: false,
  }
  try {
    spyOn(registries, 'whenRegistriesReady').mockResolvedValue(undefined)
    const hook = useSendMessage(options as any)
    spyOn(yielding, 'yieldToEventLoop').mockImplementation(async () => {
      if (validations !== 1 || replaced) return
      replaced = true
      hook.clearMessages()
      useChatStore.getState().setMessages([])
      replacement = hook.sendMessage({
        content: 'new pending submission',
        agentMode: 'DEFAULT' as never,
      })
    })
    await hook.sendMessage({
      content: 'old failing submission',
      agentMode: 'DEFAULT' as never,
    })
    expect(chain.current).toBe(true)
  } finally {
    releaseValidation({ success: false, errors: [] })
    await replacement
    internals.H = original
    mock.restore()
    useChatStore.getState().reset()
  }
})

test('clearing a running SDK call holds execution occupancy until abort settles', async () => {
  const original = internals.H
  const noop = () => {}
  internals.H = {
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (fn: unknown) => fn,
    useEffect: noop,
  }
  useChatStore.getState().reset()
  setProjectRoot('/tmp')
  const chain = { current: false }
  let sdkStarted = false
  let releaseSdk!: (state: unknown) => void
  const sdkPending = new Promise((resolve) => {
    releaseSdk = resolve
  })
  let pending: Promise<unknown> | undefined
  let canQueue = true
  try {
    spyOn(registries, 'whenRegistriesReady').mockResolvedValue(undefined)
    spyOn(clientModule, 'getCodebuffClient').mockImplementation(
      async () =>
        ({
          run: () => {
            sdkStarted = true
            return sdkPending
          },
        }) as any,
    )
    spyOn(providerModule, 'getOpenbuffProviderReadiness').mockReturnValue({
      ok: true,
    })
    spyOn(agentModule, 'loadAgentDefinitions').mockReturnValue([])
    spyOn(configModule, 'createRunConfig').mockReturnValue({} as any)
    spyOn(journalModule, 'openRunJournalForRun').mockReturnValue(undefined)
    const hook = useSendMessage({
      inputRef: { current: null },
      activeSubagentsRef: { current: new Set() },
      isChainInProgressRef: chain,
      setStreamStatus: noop,
      setContextWindowUsage: noop,
      setCompactionNotice: noop,
      setCanProcessQueue: (value: boolean) => {
        canQueue = value
      },
      abortControllerRef: { current: null },
      onBeforeMessageSend: async () => ({ success: true, errors: [] }),
      mainAgentTimer: {
        start: noop,
        stop: noop,
        pause: noop,
        resume: noop,
        elapsedSeconds: 0,
        startTime: null,
        isPaused: false,
      },
      scrollToLatest: noop,
      continueChat: false,
    } as any)
    pending = hook.sendMessage({
      content: 'old running submission',
      agentMode: 'DEFAULT' as never,
    })
    for (let attempt = 0; attempt < 100 && !sdkStarted; attempt++)
      await Bun.sleep(1)
    expect(sdkStarted).toBe(true)
    hook.clearMessages()
    useChatStore.getState().setMessages([])
    expect(chain.current).toBe(true)
    expect(canQueue).toBe(false)
    releaseSdk({ output: { type: 'error', message: 'cancelled fixture' } })
    await pending
    expect(chain.current).toBe(false)
    expect(canQueue).toBe(true)
    expect(useChatStore.getState().messages).toEqual([])
  } finally {
    releaseSdk({ output: { type: 'error', message: 'cancelled fixture' } })
    await pending
    internals.H = original
    mock.restore()
    useChatStore.getState().reset()
  }
})
