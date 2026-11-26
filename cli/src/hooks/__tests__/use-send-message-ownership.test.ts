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
const storage = await import('../../utils/run-state-storage')
const archiveSync =
  await import('../../services/memory-v2/context-archive-sync')
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

test('client factory rejection is visible and releases only its own occupancy for retry', async () => {
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
  let canQueue = true
  try {
    spyOn(registries, 'whenRegistriesReady').mockResolvedValue(undefined)
    const clientSpy = spyOn(
      clientModule,
      'getCodebuffClient',
    ).mockRejectedValue(new Error('fixture client factory failed'))
    spyOn(agentModule, 'loadAgentDefinitions').mockReturnValue([])
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

    const result = await hook.sendMessage({
      content: 'retryable factory prompt',
      agentMode: 'DEFAULT' as never,
    })

    expect(result).toMatchObject({ status: 'rejected', retryable: true })
    expect(chain.current).toBe(false)
    expect(canQueue).toBe(true)
    expect(
      useChatStore
        .getState()
        .messages.some((message: any) =>
          String(message.content).includes('Unable to initialize'),
        ),
    ).toBe(true)

    clientSpy.mockResolvedValue({} as any)
    spyOn(providerModule, 'getOpenbuffProviderReadiness').mockImplementation(
      () => {
        throw new Error('fixture readiness resolver failed')
      },
    )
    const readinessResult = await hook.sendMessage({
      content: 'retryable readiness prompt',
      agentMode: 'DEFAULT' as never,
    })
    expect(readinessResult).toMatchObject({
      status: 'rejected',
      reason: 'fixture readiness resolver failed',
    })
    expect(chain.current).toBe(false)
    expect(canQueue).toBe(true)
    expect(
      useChatStore
        .getState()
        .messages.some((message: any) =>
          String(message.content).includes(
            'Unable to resolve provider readiness',
          ),
        ),
    ).toBe(true)
  } finally {
    internals.H = original
    mock.restore()
    useChatStore.getState().reset()
  }
})

test.each(['legacy', 'structured', 'unclassified'] as const)(
  'B15 a %s checkpoint refusal keeps the saved state and can still start a distinct turn',
  async (format) => {
    const original = internals.H
    const effects: Array<() => void | (() => void)> = []
    const cleanups: Array<() => void> = []
    const noop = () => {}
    internals.H = {
      useRef: (value: unknown) => ({ current: value }),
      useCallback: (fn: unknown) => fn,
      useEffect: (effect: () => void | (() => void)) => effects.push(effect),
    }
    useChatStore.getState().reset()
    setProjectRoot('/tmp')
    const prompt = 'repeat the interrupted fixture'
    const saved = {
      output: { type: 'lastMessage', value: [] },
      sessionState: {
        mainAgentState: { runId: 'last-saved-run', messageHistory: [] },
      },
    }
    const messageHistory =
      format === 'legacy'
        ? [{ role: 'user', content: prompt }]
        : [
            {
              role: 'user',
              ...(format === 'structured' ? { tags: ['USER_PROMPT'] } : {}),
              content: [
                {
                  type: 'text',
                  text: `<user_message>${prompt}</user_message>`,
                },
              ],
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'unrelated later helper context' },
              ],
            },
          ]
    const run = mock(
      async (params: {
        resumeInterruptedTurn?: boolean
        previousRun?: typeof saved
      }) => ({
        ...params.previousRun,
        output: {
          type: 'error' as const,
          message: params.resumeInterruptedTurn
            ? 'Cannot resume: no verified replay prefix is available.'
            : 'fixture new turn',
        },
        runOutcome: {
          termination: 'failed' as const,
          cause: {
            code: params.resumeInterruptedTurn
              ? 'replay_unavailable'
              : 'fixture',
            message: 'fixture',
          },
        },
      }),
    )
    try {
      spyOn(storage, 'loadMostRecentChatStateAsync').mockResolvedValue({
        runState: saved,
        messages: [{ id: 'old-user-message', role: 'user', content: prompt }],
      } as any)
      spyOn(storage, 'loadCheckpoint').mockReturnValue({
        checkpointTurnId: 'old-user-message',
        checkpointTime: 1,
        mainAgentState: { runId: 'interrupted-run', messageHistory },
      } as any)
      const clear = spyOn(storage, 'clearCheckpoint').mockResolvedValue(
        undefined,
      )
      const save = spyOn(storage, 'saveChatState').mockImplementation(noop)
      spyOn(archiveSync, 'hydrateContextArchiveSnapshots').mockImplementation(
        async (archive) => archive ?? [],
      )
      spyOn(registries, 'whenRegistriesReady').mockResolvedValue(undefined)
      spyOn(clientModule, 'getCodebuffClient').mockImplementation(
        async () => ({ run }) as any,
      )
      spyOn(providerModule, 'getOpenbuffProviderReadiness').mockReturnValue({
        ok: true,
      })
      spyOn(agentModule, 'loadAgentDefinitions').mockReturnValue([])
      spyOn(configModule, 'createRunConfig').mockImplementation(
        (params) =>
          ({
            resumeInterruptedTurn: params.resumeInterruptedTurn,
            previousRun: params.previousRunState,
          }) as any,
      )
      spyOn(journalModule, 'openRunJournalForRun').mockReturnValue(undefined)
      const hook = useSendMessage({
        inputRef: { current: null },
        activeSubagentsRef: { current: new Set() },
        isChainInProgressRef: { current: false },
        abortControllerRef: { current: null },
        setStreamStatus: noop,
        setContextWindowUsage: noop,
        setCompactionNotice: noop,
        setCanProcessQueue: noop,
        scrollToLatest: noop,
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
        continueChat: true,
      } as any)
      for (const effect of effects) {
        const cleanup = effect()
        if (cleanup) cleanups.push(cleanup)
      }
      const send = async (content: string) => {
        const outcome = await hook.sendMessage({
          content,
          agentMode: 'DEFAULT',
        })
        expect(outcome).toMatchObject({
          status: 'accepted',
          disposition: 'started',
        })
        if (outcome.status === 'accepted' && outcome.disposition === 'started')
          await outcome.completion
      }
      await send(prompt)
      expect(run).toHaveBeenCalledTimes(1)
      expect(run.mock.calls[0]?.[0]).toMatchObject({
        resumeInterruptedTurn: true,
        previousRun: {
          sessionState: { mainAgentState: { runId: 'interrupted-run' } },
        },
      })
      expect(clear).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(
        useChatStore.getState().runState?.sessionState?.mainAgentState.runId,
      ).toBe('last-saved-run')
      if (format === 'unclassified') {
        // Ambiguous old payloads cannot implicitly create a different turn;
        // an explicit conversation reset can still start a fresh run.
        await send('ambiguous saved prompt')
        expect(run.mock.calls[1]?.[0]?.resumeInterruptedTurn).toBe(true)
        expect(clear).not.toHaveBeenCalled()
        hook.clearMessages()
        await send(prompt)
        expect(run.mock.calls[2]?.[0]?.resumeInterruptedTurn).toBe(false)
      } else {
        await send('start different explicit work')
        expect(run).toHaveBeenCalledTimes(2)
        expect(run.mock.calls[1]?.[0]).toMatchObject({
          resumeInterruptedTurn: false,
          previousRun: {
            sessionState: { mainAgentState: { runId: 'last-saved-run' } },
          },
        })
      }
      expect(clear).toHaveBeenCalled()
    } finally {
      for (const cleanup of cleanups) cleanup()
      internals.H = original
      mock.restore()
      useChatStore.getState().reset()
    }
  },
)

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
  let pending:
    | ReturnType<ReturnType<typeof useSendMessage>['sendMessage']>
    | undefined
  let completion: Promise<void> | undefined
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
      onAccepted: () => {
        throw new Error('fixture acceptance callback failed')
      },
    })
    for (let attempt = 0; attempt < 100 && !sdkStarted; attempt++)
      await Bun.sleep(1)
    expect(sdkStarted).toBe(true)
    const admission = await pending
    expect(admission).toMatchObject({
      status: 'accepted',
      disposition: 'started',
    })
    if (admission.status === 'accepted' && admission.disposition === 'started')
      completion = admission.completion
    expect(completion).toBeDefined()
    hook.clearMessages()
    useChatStore.getState().setMessages([])
    expect(chain.current).toBe(true)
    expect(canQueue).toBe(false)
    releaseSdk({ output: { type: 'error', message: 'cancelled fixture' } })
    await completion
    expect(chain.current).toBe(false)
    expect(canQueue).toBe(true)
    expect(useChatStore.getState().messages).toEqual([])
  } finally {
    releaseSdk({ output: { type: 'error', message: 'cancelled fixture' } })
    await pending
    await completion
    mock.restore()
    useChatStore.getState().reset()
  }
})
