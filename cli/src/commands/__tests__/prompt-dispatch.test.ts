import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'

import { useChatStore } from '../../state/chat-store'
import * as turnSnapshots from '../../utils/turn-snapshots'
import { routeUserPrompt } from '../router'

import type { RouterParams } from '../command-registry'
import type { SendMessageFn } from '../../types/contracts/send-message'
import type { ChatMessage } from '../../types/chat'
import type { InputValue, PendingAttachment } from '../../types/store'
import type { AgentMode } from '../../utils/constants'

function createHarness(inputValue: string) {
  const sent: Parameters<SendMessageFn>[0][] = []
  const queued: Array<{
    content: string
    attachments: PendingAttachment[]
    agentMode: AgentMode | undefined
  }> = []
  let messages: ChatMessage[] = []
  let input: InputValue = {
    text: inputValue,
    cursorPosition: inputValue.length,
    lastEditDueToNav: false,
  }
  const params: RouterParams = {
    inputValue,
    agentMode: 'DEFAULT',
    isStreaming: false,
    isChainInProgressRef: { current: false },
    streamMessageIdRef: { current: null },
    abortControllerRef: { current: null },
    inputRef: { current: null },
    sendMessage: async (request) => {
      sent.push(request)
      return {
        status: 'accepted',
        disposition: 'started',
        completion: Promise.resolve(),
      }
    },
    addToQueue: (content, attachments = [], agentMode) => {
      queued.push({ content, attachments, agentMode })
    },
    setMessages: (value) => {
      messages = typeof value === 'function' ? value(messages) : value
    },
    setInputValue: (value) => {
      input = typeof value === 'function' ? value(input) : value
    },
    saveToHistory: () => {},
    setInputFocused: () => {},
    setCanProcessQueue: () => {},
    scrollToLatest: () => {},
    clearMessages: () => {},
    stopStreaming: () => {},
  }
  return {
    params,
    sent,
    queued,
    get messages() {
      return messages
    },
    get input() {
      return input
    },
  }
}

beforeEach(() => useChatStore.getState().reset())
afterEach(() => {
  mock.restore()
  useChatStore.getState().reset()
})

test('legacy OAuth callback routing never retains authorization input in transcript or prompt history', async () => {
  const secret = 'https://localhost:1455/auth/callback?code=fixture-secret-code'
  const harness = createHarness(secret)
  const history: string[] = []
  harness.params.saveToHistory = (value) => history.push(value)
  useChatStore.getState().setInputMode('connect:chatgpt')
  await routeUserPrompt(harness.params)
  expect(JSON.stringify(harness.messages)).not.toContain('fixture-secret-code')
  expect(JSON.stringify(harness.messages)).toContain(
    'ChatGPT connection failed',
  )
  expect(history).toEqual([])
  expect(harness.input.text).toBe('')
  expect(useChatStore.getState().inputMode).toBe('default')
})

describe('prompt-producing command dispatch', () => {
  test('acceptance distinguishes queue insertion, readiness rejection and exact ordinary action bytes', async () => {
    const exact = '  inspect\n  retained evidence  \n'
    const harness = createHarness(exact)
    harness.params.preserveInputValue = true
    harness.params.preservePromptWhitespace = true
    let accepted = 0
    harness.params.onPromptAccepted = () => accepted++
    await routeUserPrompt(harness.params)
    expect(harness.sent[0]?.content).toBe(exact)
    expect(accepted).toBe(0)
    harness.sent[0]?.onAccepted?.()
    expect(accepted).toBe(1)
    harness.params.isStreaming = true
    await routeUserPrompt(harness.params)
    expect(harness.queued[0]?.content).toBe(exact)
    expect(accepted).toBe(2)
    harness.params.addToQueue = () => {
      throw new Error('queue unavailable')
    }
    expect(await routeUserPrompt(harness.params)).toMatchObject({
      status: 'rejected',
      reason: 'queue unavailable',
    })
    expect(accepted).toBe(2)
    harness.params.inputValue = '/unknown-captured-command'
    await routeUserPrompt(harness.params)
    expect(accepted).toBe(2)
  })

  test('queued acceptance remains authoritative when compatibility callback throws', async () => {
    const harness = createHarness('queue once')
    harness.params.isStreaming = true
    harness.params.onPromptAccepted = () => {
      throw new Error('fixture callback failed')
    }

    expect(await routeUserPrompt(harness.params)).toEqual({
      status: 'accepted',
      disposition: 'queued',
    })
    expect(harness.queued).toHaveLength(1)
    expect(harness.queued[0]?.content).toBe('queue once')
  })

  for (const busy of ['stream', 'message', 'chain'] as const) {
    test.each([
      '/mode:plan inspect changes',
      '/review inspect changes',
      '/interview inspect changes',
    ])(`%s queues while ${busy} is active`, async (command) => {
      const harness = createHarness(command)
      if (busy === 'stream') harness.params.isStreaming = true
      if (busy === 'message')
        harness.params.streamMessageIdRef.current = 'active-message'
      if (busy === 'chain') harness.params.isChainInProgressRef.current = true

      await routeUserPrompt(harness.params)

      expect(harness.sent).toEqual([])
      expect(harness.queued).toHaveLength(1)
      expect(harness.queued[0]?.content).toContain('inspect changes')
      expect(harness.queued[0]?.agentMode).toBe(
        command.startsWith('/mode:') ? 'PLAN' : 'DEFAULT',
      )
    })
  }

  test.each(['review', 'interview'] as const)(
    'input mode %s obeys the busy gate',
    async (inputMode) => {
      useChatStore.getState().setInputMode(inputMode)
      const harness = createHarness('inspect changes')
      harness.params.isChainInProgressRef.current = true

      await routeUserPrompt(harness.params)

      expect(harness.sent).toEqual([])
      expect(harness.queued).toHaveLength(1)
      expect(harness.queued[0]?.agentMode).toBe('DEFAULT')
      expect(useChatStore.getState().inputMode).toBe('default')
    },
  )

  test('unknown slash commands report immediately while busy', async () => {
    const harness = createHarness('/hep')
    harness.params.isStreaming = true

    await routeUserPrompt(harness.params)

    expect(harness.sent).toEqual([])
    expect(harness.queued).toEqual([])
    expect(
      harness.messages.some((message) =>
        message.content.includes('Command not found'),
      ),
    ).toBe(true)
  })

  test('processing or failed context returns not-started without clearing ordinary or mode-command input', async () => {
    const processing: PendingAttachment = {
      kind: 'file',
      id: 'processing-context',
      path: 'notes.txt',
      filename: 'notes.txt',
      isDirectory: false,
      content: '',
      status: 'processing',
    }
    useChatStore.getState().addPendingAttachment(processing)
    const ordinary = createHarness('keep this draft')

    const ordinaryResult = await routeUserPrompt(ordinary.params)

    expect(ordinaryResult).toMatchObject({ status: 'not-started' })
    expect(ordinary.sent).toEqual([])
    expect(ordinary.input.text).toBe('keep this draft')
    expect(useChatStore.getState().pendingAttachments).toEqual([processing])

    useChatStore.getState().removePendingAttachment('notes.txt')
    const failed: PendingAttachment = {
      ...processing,
      id: 'failed-context',
      status: 'error',
      note: 'fixture read failed',
    }
    useChatStore.getState().addPendingAttachment(failed)
    const command = createHarness('/mode:plan inspect changes')

    const commandResult = await routeUserPrompt(command.params)

    expect(commandResult).toMatchObject({ status: 'not-started' })
    expect(command.sent).toEqual([])
    expect(command.queued).toEqual([])
    expect(command.input.text).toBe('/mode:plan inspect changes')
    expect(useChatStore.getState().pendingAttachments).toEqual([failed])
  })

  test('prompt-producing command is not started during bisection while local stop stays reachable', async () => {
    spyOn(turnSnapshots, 'isTurnBisectionRunning').mockReturnValue(true)
    const command = createHarness('/mode:plan inspect changes')

    const result = await routeUserPrompt(command.params)

    expect(result).toMatchObject({ status: 'not-started' })
    expect(command.sent).toEqual([])
    expect(command.queued).toEqual([])
    expect(command.input.text).toBe('/mode:plan inspect changes')

    const stop = createHarness('/bisect-turn stop')
    const cancel = spyOn(turnSnapshots, 'cancelTurnBisection')
    await routeUserPrompt(stop.params)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  test('accepted, rejected and not-started outcomes are separate from run completion', async () => {
    const accepted = createHarness('accepted prompt')
    accepted.params.sendMessage = async (request) => {
      accepted.sent.push(request)
      request.onAccepted?.()
      return {
        status: 'accepted',
        disposition: 'started',
        completion: Promise.resolve(),
      } as const
    }
    expect(await routeUserPrompt(accepted.params)).toMatchObject({
      status: 'accepted',
      disposition: 'started',
    })

    const rejected = createHarness('rejected prompt')
    rejected.params.sendMessage = async (request) => {
      rejected.sent.push(request)
      return {
        status: 'rejected',
        reason: 'fixture validation failure',
        retryable: true,
      } as const
    }
    expect(await routeUserPrompt(rejected.params)).toMatchObject({
      status: 'rejected',
      retryable: true,
    })

    useChatStore.getState().addPendingAttachment({
      kind: 'image',
      id: 'pending-image',
      path: 'pending.png',
      filename: 'pending.png',
      status: 'processing',
    })
    const notStarted = createHarness('not started prompt')
    expect(await routeUserPrompt(notStarted.params)).toMatchObject({
      status: 'not-started',
    })
  })

  test('ready context is restored after rejection and consumed exactly once by retry', async () => {
    const ready: PendingAttachment = {
      kind: 'file',
      id: 'ready-context',
      path: 'evidence.txt',
      filename: 'evidence.txt',
      isDirectory: false,
      content: 'captured evidence',
      status: 'ready',
      note: 'metadata-only fixture',
    }
    useChatStore.getState().addPendingAttachment(ready)
    const harness = createHarness('retry this draft')
    harness.params.sendMessage = async (request) => {
      harness.sent.push(request)
      return {
        status: 'rejected',
        reason: 'fixture readiness failure',
        retryable: true,
      }
    }

    expect(await routeUserPrompt(harness.params)).toMatchObject({
      status: 'rejected',
    })
    expect(harness.input.text).toBe('retry this draft')
    expect(useChatStore.getState().pendingAttachments).toEqual([ready])
    expect(harness.sent[0]?.attachments).toEqual([ready])

    harness.params.sendMessage = async (request) => {
      harness.sent.push(request)
      request.onAccepted?.()
      return {
        status: 'accepted',
        disposition: 'started',
        completion: Promise.resolve(),
      }
    }
    expect(await routeUserPrompt(harness.params)).toMatchObject({
      status: 'accepted',
      disposition: 'started',
    })
    expect(harness.sent[1]?.attachments).toEqual([ready])
    expect(useChatStore.getState().pendingAttachments).toEqual([])
  })

  test('queued commands capture draft attachments and the requested mode', async () => {
    const attachment: PendingAttachment = {
      kind: 'text',
      id: 'draft-context',
      content: 'retained evidence',
      preview: 'retained evidence',
      charCount: 17,
    }
    useChatStore.getState().addPendingAttachment(attachment)
    const harness = createHarness('/mode:plan inspect changes')
    harness.params.isStreaming = true

    await routeUserPrompt(harness.params)
    useChatStore.getState().setAgentMode('EXECUTE_PLAN')

    expect(harness.queued[0]?.agentMode).toBe('PLAN')
    expect(harness.queued[0]?.attachments).toEqual([attachment])
    expect(useChatStore.getState().pendingAttachments).toEqual([])
  })

  test('Execute Plan keeps the draft and its attachments while awaiting the send', async () => {
    const attachment: PendingAttachment = {
      kind: 'text',
      id: 'draft',
      content: 'draft evidence',
      preview: 'draft evidence',
      charCount: 14,
    }
    useChatStore.getState().addPendingAttachment(attachment)
    useChatStore.getState().setInputMode('review')
    const harness = createHarness('Build it!')
    harness.params.preserveInputValue = true
    harness.params.agentMode = 'EXECUTE_PLAN'
    harness.params.setInputValue({
      text: 'Unsent follow-up',
      cursorPosition: 5,
      lastEditDueToNav: false,
    })
    let complete!: () => void
    harness.params.sendMessage = async (request) => {
      harness.sent.push(request)
      await new Promise<void>((resolve) => {
        complete = resolve
      })
      return {
        status: 'accepted',
        disposition: 'started',
        completion: Promise.resolve(),
      }
    }

    const pending = routeUserPrompt(harness.params)
    expect(harness.sent).toEqual([
      { content: 'Build it!', agentMode: 'EXECUTE_PLAN', attachments: [] },
    ])
    expect(harness.input.text).toBe('Unsent follow-up')
    expect(useChatStore.getState().pendingAttachments).toEqual([attachment])
    harness.params.setInputValue({
      text: 'New typing',
      cursorPosition: 10,
      lastEditDueToNav: false,
    })
    complete()
    await pending

    expect(harness.input.text).toBe('New typing')
    expect(useChatStore.getState().pendingAttachments).toEqual([attachment])
  })

  test('an action queued while busy leaves draft attachments for the draft', async () => {
    const attachment: PendingAttachment = {
      kind: 'text',
      id: 'draft',
      content: 'draft evidence',
      preview: 'draft evidence',
      charCount: 14,
    }
    useChatStore.getState().addPendingAttachment(attachment)
    const harness = createHarness('Build it!')
    harness.params.preserveInputValue = true
    harness.params.isStreaming = true
    harness.params.agentMode = 'EXECUTE_PLAN'

    await routeUserPrompt(harness.params)

    expect(harness.queued).toEqual([
      { content: 'Build it!', attachments: [], agentMode: 'EXECUTE_PLAN' },
    ])
    expect(harness.input.text).toBe('Build it!')
    expect(useChatStore.getState().pendingAttachments).toEqual([attachment])
  })
})
