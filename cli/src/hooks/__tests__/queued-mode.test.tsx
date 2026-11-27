import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import React from 'react'

import { useChatStore } from '../../state/chat-store'
import * as images from '../../utils/image-processor'
import { useChatStreaming } from '../use-chat-streaming'
import { useMessageQueue, type QueuedMessage } from '../use-message-queue'
import { completedRun, completionOf, mountRealSend, valid } from './fixtures/mount-send-queue'

import type { UseChatStreamingReturn } from '../use-chat-streaming'
import type { PromptAdmissionResult, SendMessageFn } from '../../types/contracts/send-message'
import type { PendingFileAttachment } from '../../types/store'
import type { Client } from './fixtures/mount-send-queue'
import type { testRender } from '@opentui/react/test-utils'
import type { RunState } from '@openbuff/sdk'

// OpenTUI's test-utils import React.act, which production React omits. The
// real renderer integration runs explicitly under development React.
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

afterEach(() => {
  mock.restore()
  useChatStore.getState().reset()
})

renderTest(
  'a queued prompt runs in its enqueue-time mode after the toggle changes',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    useChatStore.getState().reset()
    const chain = { current: true }
    const activeStreams = { current: 0 }
    const sent: Parameters<SendMessageFn>[0][] = []
    const sendRef = {
      current: async (request: Parameters<SendMessageFn>[0]) => {
        chain.current = true
        sent.push(request)
        return {
          status: 'accepted',
          disposition: 'started',
          completion: Promise.resolve(),
        } as const
      },
    }
    let queue!: UseChatStreamingReturn
    const attachment = {
      kind: 'text' as const,
      id: 'evidence',
      content: 'source',
      preview: 'source',
      charCount: 6,
    }

    function Host() {
      const agentMode = useChatStore((state) => state.agentMode)
      queue = useChatStreaming({
        agentMode,
        inputValue: '',
        setInputValue: () => {},
        terminalWidth: 80,
        separatorWidth: 78,
        isChainInProgressRef: chain,
        activeAgentStreamsRef: activeStreams,
        sendMessageRef: sendRef,
      })
      return <text>{queue.queuePreviewTitle ?? 'Ready'}</text>
    }

    const client = new QueryClient()
    let setup: Awaited<ReturnType<typeof testRender>> | undefined
    try {
      await React.act(async () => {
        setup = await testRender(
          <QueryClientProvider client={client}>
            <Host />
          </QueryClientProvider>,
          { width: 80, height: 8 },
        )
      })
      await React.act(async () => {
        queue.addToQueue('Review first', [attachment], 'PLAN')
        queue.addToQueue('Run later', [], 'EXECUTE_PLAN')
        queue.setCanProcessQueue(false)
      })
      await React.act(async () => {
        useChatStore.getState().setAgentMode('EXECUTE_PLAN')
      })
      await setup!.renderOnce()
      expect(setup!.captureCharFrame()).toContain(
        'Next · Plan · 1 attachment: Review first',
      )
      expect(sent).toEqual([])
      const firstId = queue.queuedMessages[0]!.id!
      const secondId = queue.queuedMessages[1]!.id!
      await React.act(async () => {
        queue.updateQueuedMessage(firstId, { content: 'Review edited' })
        queue.moveQueuedMessage(secondId, -1)
      })
      expect(queue.queuedMessages.map((message) => message.content)).toEqual([
        'Run later',
        'Review edited',
      ])
      await React.act(async () => queue.removeQueuedMessage(secondId))
      expect(queue.queuedMessages).toHaveLength(1)
      await React.act(async () => queue.undoQueueRemoval())
      expect(queue.queuedMessages[0]!.id).toBe(secondId)
      await React.act(async () => queue.moveQueuedMessage(firstId, -1))
      expect(queue.queuedMessages[0]!.attachments).toEqual([attachment])
      expect(queue.queuedMessages[0]!.agentMode).toBe('PLAN')

      await React.act(async () => {
        chain.current = false
        queue.resumeQueue()
      })
      expect(sent).toEqual([
        {
          content: 'Review edited',
          agentMode: 'PLAN',
          attachments: [attachment],
        },
      ])
      expect(queue.queuedMessages.map((message) => message.content)).toEqual([
        'Run later',
      ])
    } finally {
      await React.act(async () => {
        setup?.renderer.destroy()
      })
      client.clear()
      useChatStore.getState().reset()
    }
  },
)

renderTest('accepting an in-flight payload does not dequeue a newer edit of the same item', async () => {
  const { testRender } = await import('@opentui/react/test-utils')
  const first = Promise.withResolvers<PromptAdmissionResult>()
  const accepted = {
    status: 'accepted', disposition: 'started', completion: Promise.resolve(),
  } as const
  const send = mock((message: QueuedMessage) =>
    message.content === 'Original prompt' ? first.promise : Promise.resolve(accepted),
  )
  const chain = { current: false }
  const active = { current: 0 }
  const original = { kind: 'text' as const, id: 'source', content: 'old', preview: 'old', charCount: 3 }
  const edited = { ...original, content: 'new', preview: 'new' }
  let queue!: ReturnType<typeof useMessageQueue>
  function Host() {
    queue = useMessageQueue(send, chain, active)
    return <text>{queue.queuedMessages[0]?.content ?? 'Queue empty'}</text>
  }

  let setup: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    await React.act(async () => {
      setup = await testRender(<Host />, { width: 80, height: 8 })
    })
    await React.act(async () => queue.addToQueue('Original prompt', [original], 'PLAN'))
    expect(send).toHaveBeenCalledTimes(1)
    const id = queue.queuedMessages[0]!.id!
    await React.act(async () => {
      // Opening the queue manager pauses admission before it edits an item.
      queue.pauseQueue()
      expect(queue.updateQueuedMessage(id, { content: 'Edited prompt', agentMode: 'DEFAULT' })).toBe(true)
      expect(queue.updateQueuedAttachment(id, original.id, edited)).toBe(true)
    })
    expect(send.mock.calls[0]?.[0]).toEqual({
      id, content: 'Original prompt', attachments: [original], agentMode: 'PLAN',
    })

    await React.act(async () => { first.resolve(accepted) })
    const next: QueuedMessage = { id, content: 'Edited prompt', attachments: [edited], agentMode: 'DEFAULT' }
    expect(send).toHaveBeenCalledTimes(1)
    expect(queue.queuedMessages).toEqual([next])
    await setup!.renderOnce()
    expect(setup!.captureCharFrame()).toContain('Edited prompt')

    await React.act(async () => queue.resumeQueue())
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]?.[0]).toEqual(next)
    expect(queue.queuedMessages).toEqual([])
  } finally {
    await React.act(async () => {
      first.resolve(accepted)
      setup?.renderer.destroy()
    })
  }
})

renderTest('a queued-only acknowledgement cannot dequeue a pending execution', async () => {
  const { testRender } = await import('@opentui/react/test-utils')
  const acknowledgement = Promise.withResolvers<PromptAdmissionResult>()
  const send = mock(() => acknowledgement.promise)
  const chain = { current: false }
  const active = { current: 0 }
  let queue!: ReturnType<typeof useMessageQueue>
  function Host() {
    queue = useMessageQueue(send, chain, active)
    return <text>{queue.queueError ?? 'Queue ready'}</text>
  }
  let setup: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    await React.act(async () => {
      setup = await testRender(<Host />, { width: 80, height: 8 })
    })
    await React.act(async () => queue.addToQueue('Not yet started', [], 'PLAN'))
    const original = queue.queuedMessages[0]
    expect(queue.isProcessingQueueRef.current).toBe(true)
    await React.act(async () => { acknowledgement.resolve({ status: 'accepted', disposition: 'queued' }) })
    expect(send).toHaveBeenCalledTimes(1)
    expect(queue.isProcessingQueueRef.current).toBe(false)
    expect(queue.queuedMessages[0]).toBe(original)
    expect(queue.queuePaused).toBe(true)
    expect(queue.queueError).toContain('did not start')
  } finally {
    acknowledgement.resolve({ status: 'not-started', reason: 'test cleanup' })
    await React.act(async () => setup?.renderer.destroy())
  }
})

renderTest('real queue sees same-batch backlog and does not dispatch a tail before the accepted head settles', async () => {
  const terminal = Promise.withResolvers<RunState>()
  const headStarted = Promise.withResolvers<void>()
  const tailStarted = Promise.withResolvers<void>()
  const run = mock((request: Parameters<Client['run']>[0]) => {
    if (request.prompt?.startsWith('Older work')) {
      headStarted.resolve()
      return terminal.promise
    }
    tailStarted.resolve()
    return Promise.resolve(completedRun)
  })
  const state = await mountRealSend(run)
  const captured = { kind: 'text' as const, id: 'head', content: 'older evidence', preview: 'older evidence', charCount: 14 }
  const draftAttachment = { ...captured, id: 'tail', content: 'new evidence' }
  const newDraft = { text: 'Keep typing here', cursorPosition: 6, lastEditDueToNav: true }
  try {
    await React.act(async () => {
      const store = useChatStore.getState()
      store.setInputValue({ text: 'Later work', cursorPosition: 2, lastEditDueToNav: true })
      store.addPendingAttachment(draftAttachment)
      state.streaming.addToQueue('Older work', [captured], 'PLAN')
      expect(await state.route('Later work')).toEqual({ status: 'accepted', disposition: 'queued' })
      expect(run).not.toHaveBeenCalled()
      store.setInputValue(newDraft)
    })
    await React.act(async () => { await headStarted.promise })
    expect(run).toHaveBeenCalledTimes(1)
    expect(state.chain.current).toBe(true)
    expect(state.streaming.isProcessingQueueRef.current).toBe(false)
    expect(state.streaming.queuedMessages.map(({ content }) => content)).toEqual(['Later work'])
    expect(state.streaming.queuedMessages[0]?.attachments[0]).toBe(draftAttachment)
    expect(run.mock.calls[0]?.[0]?.prompt).toBe('Older work\n\n[Pasted Text]\nolder evidence')
    await React.act(async () => terminal.resolve(completedRun))
    await React.act(async () => { await tailStarted.promise })
    expect(run.mock.calls.map(([request]) => request.prompt)).toEqual([
      'Older work\n\n[Pasted Text]\nolder evidence',
      'Later work\n\n[Pasted Text]\nnew evidence',
    ])
    expect(run.mock.calls[1]?.[0]?.previousRun).toBe(completedRun)
    expect(state.streaming.queuedMessages).toEqual([])
    expect(useChatStore.getState()).toMatchObject({
      inputValue: newDraft.text, cursorPosition: 6, lastEditDueToNav: true,
      pendingAttachments: [],
    })
  } finally {
    terminal.resolve(completedRun)
    await state.destroy()
  }
})

renderTest('a refused queue head is retained and never retried by a new live submission', async () => {
  const entered = Promise.withResolvers<void>()
  const factory = Promise.withResolvers<Client>()
  const run = mock((_request: Parameters<Client['run']>[0]) => Promise.resolve(completedRun))
  const state = await mountRealSend(run)
  state.getClient.mockImplementationOnce(() => {
    entered.resolve()
    return factory.promise
  })
  const attachment = { kind: 'text' as const, id: 'retained', content: 'first context', preview: 'first context', charCount: 13 }
  const draft = { text: 'Fresh work', cursorPosition: 3, lastEditDueToNav: true }
  try {
    await React.act(async () => state.streaming.addToQueue('Refused head', [attachment], 'PLAN'))
    await React.act(async () => { await entered.promise })
    const head = state.streaming.queuedMessages[0]!
    expect(head.attachments[0]).toBe(attachment)
    expect(state.streaming.isProcessingQueueRef.current).toBe(true)
    expect(state.chain.current).toBe(true)
    await React.act(async () => {
      factory.reject(new Error('Offline factory failure'))
      await factory.promise.catch(() => {})
    })
    expect(state.chain.current).toBe(false)
    expect(state.streaming.isProcessingQueueRef.current).toBe(false)
    expect(state.streaming.queueError).toBe('Offline factory failure')
    expect(state.streaming.queuedMessages[0]).toBe(head)
    expect(run).not.toHaveBeenCalled()
    useChatStore.getState().setInputValue(draft)
    await React.act(async () => {
      const admission = await state.route(draft.text)
      expect(admission).toMatchObject({ status: 'accepted', disposition: 'started' })
      await completionOf(admission)
    })
    expect(state.streaming.queuePaused).toBe(true)
    expect(state.streaming.queuedMessages[0]).toBe(head)
    expect(run.mock.calls.map(([request]) => request.prompt)).toEqual(['Fresh work'])
    await React.act(async () => state.streaming.resumeQueue())
    for (let i = 0; i < 100 && (run.mock.calls.length < 2 || state.chain.current); i++)
      await React.act(async () => { await Bun.sleep(1) })
    expect(state.streaming.queueError).toBeNull()
    expect(run.mock.calls.map(([request]) => request.prompt)).toEqual(['Fresh work', 'Refused head\n\n[Pasted Text]\nfirst context'])
    expect(state.streaming.queuedMessages).toEqual([])
  } finally {
    factory.resolve({ run } as unknown as Client)
    await state.destroy()
  }
})

renderTest('a second direct send cannot replace pending validation; refusal restores the original cursor and context', async () => {
  const entered = Promise.withResolvers<void>()
  const validation = Promise.withResolvers<typeof valid>()
  const validate = mock(() => {
    entered.resolve()
    return validation.promise
  })
  const run = mock(async () => completedRun)
  const state = await mountRealSend(run, validate)
  const draft = { text: 'Retain this draft', cursorPosition: 7, lastEditDueToNav: true }
  const attachment = { kind: 'text' as const, id: 'retry', content: 'exact context', preview: 'exact context', charCount: 13 }
  const store = useChatStore.getState()
  store.setInputValue(draft)
  store.addPendingAttachment(attachment)
  let first: ReturnType<typeof state.route> | undefined
  let concurrent: ReturnType<typeof state.send> | undefined
  try {
    await React.act(async () => {
      first = state.route(draft.text)
      await entered.promise
      concurrent = state.send({ content: 'Bypass attempt', agentMode: 'DEFAULT' })
      expect(state.chain.current).toBe(true)
    })
    await React.act(async () => {
      validation.resolve({ success: false, errors: [] })
      expect(await concurrent).toEqual({ status: 'not-started', reason: 'turn-in-progress' })
      expect(await first).toMatchObject({ status: 'rejected', retryable: true })
    })
    expect(validate).toHaveBeenCalledTimes(1)
    expect(state.getClient).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(state.chain.current).toBe(false)
    expect(useChatStore.getState()).toMatchObject({
      inputValue: draft.text, cursorPosition: 7, lastEditDueToNav: true,
      pendingAttachments: [attachment],
    })
    expect(useChatStore.getState().pendingAttachments[0]).toBe(attachment)
  } finally {
    validation.resolve(valid)
    await completionOf(await first)
    await completionOf(await concurrent)
    await state.destroy()
  }
})

renderTest('a refused routed submission parks its own context without changing a newer draft', async () => {
  const entered = Promise.withResolvers<void>()
  const validation = Promise.withResolvers<typeof valid>()
  const validate = mock(async () => valid).mockImplementationOnce(() => {
    entered.resolve()
    return validation.promise
  })
  const parkedRunStarted = Promise.withResolvers<void>()
  const run = mock(async ({ prompt }: Parameters<Client['run']>[0]) => {
    if (prompt?.startsWith('Draft A')) parkedRunStarted.resolve()
    return completedRun
  })
  const state = await mountRealSend(run, validate)
  const store = useChatStore.getState()
  const draftA = { text: 'Draft A', cursorPosition: 2, lastEditDueToNav: false }
  const draftB = { text: 'Draft B', cursorPosition: 3, lastEditDueToNav: true }
  const contextA = { kind: 'text' as const, id: 'a', content: 'context A', preview: 'context A', charCount: 9 }
  const contextB = { ...contextA, id: 'b', content: 'context B', preview: 'context B' }
  const acceptedA = mock(() => {})
  let pending: ReturnType<typeof state.route> | undefined
  try {
    await React.act(async () => {
      store.setAgentMode('PLAN')
      store.setInputValue(draftA)
      store.addPendingAttachment(contextA)
      pending = state.route(draftA.text, { onPromptAccepted: acceptedA })
      await entered.promise
      store.setInputValue(draftB)
      store.setAgentMode('DEFAULT')
      store.addPendingAttachment(contextB)
      validation.resolve({ success: false, errors: [] })
      expect(await pending).toMatchObject({ status: 'rejected', retryable: true })
    })
    expect(acceptedA).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(useChatStore.getState()).toMatchObject({
      inputValue: draftB.text, cursorPosition: 3, lastEditDueToNav: true,
      pendingAttachments: [contextB],
    })
    expect(state.streaming.queuePaused).toBe(true)
    const parked = state.streaming.queuedMessages[0]
    expect(parked).toMatchObject({ content: draftA.text, agentMode: 'PLAN', attachments: [contextA] })
    expect(parked?.attachments[0]).toBe(contextA)

    await React.act(async () => { await completionOf(await state.route(draftB.text)) })
    expect(run.mock.calls.map(([request]) => request.prompt)).toEqual(['Draft B\n\n[Pasted Text]\ncontext B'])
    expect(state.streaming.queuedMessages).toEqual([parked])
    expect(state.streaming.queuePaused).toBe(true)

    await React.act(async () => state.streaming.resumeQueue())
    await React.act(async () => { await parkedRunStarted.promise })
    expect(run.mock.calls.map(([request]) => request.prompt)).toEqual([
      'Draft B\n\n[Pasted Text]\ncontext B', 'Draft A\n\n[Pasted Text]\ncontext A',
    ])
    expect(state.streaming.queuedMessages).toEqual([])
  } finally {
    validation.resolve(valid)
    await completionOf(await pending)
    await state.destroy()
  }
})

for (const removal of ['drain', 'cancel', 'remove and undo'] as const) {
  renderTest(`explicit queue ${removal} revokes admission during real message preparation`, async () => {
    const entered = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const processImages = images.processImagesForMessage
    spyOn(images, 'processImagesForMessage').mockImplementationOnce(async (request) => {
      entered.resolve()
      await ready.promise
      return processImages(request)
    })
    const run = mock(async (_request: Parameters<Client['run']>[0]) => completedRun)
    const state = await mountRealSend(run)
    const attachment = { kind: 'text' as const, id: 'pending', content: 'captured', preview: 'captured', charCount: 8 }
    const shell = { id: 'shell', command: 'echo context', stdout: 'shell context', stderr: '', exitCode: 0, isRunning: false }
    useChatStore.getState().addPendingBashMessage(shell)
    const idle = Promise.withResolvers<void>()
    const unsubscribe = useChatStore.subscribe((current, previous) => {
      if (previous.isChainInProgress && !current.isChainInProgress) idle.resolve()
    })
    try {
      await React.act(async () => state.streaming.addToQueue('Pending head', [attachment], 'PLAN'))
      await React.act(async () => { await entered.promise })
      expect(state.streaming.isProcessingQueueRef.current).toBe(true)
      expect(state.chain.current).toBe(true)
      const head = state.streaming.queuedMessages[0]!
      await React.act(async () => {
        if (removal === 'drain') {
          expect(state.streaming.clearQueue(1)).toEqual([head])
        } else if (removal === 'cancel') {
          expect(state.streaming.cancelQueuedMessages([head.id!])).toEqual([head])
        } else {
          expect(state.streaming.updateQueuedMessage(head.id!, { content: 'Newer edit' })).toBe(true)
          expect(state.streaming.removeQueuedMessage(head.id!)?.content).toBe('Newer edit')
          expect(state.streaming.undoQueueRemoval()).toBe(1)
        }
        ready.resolve()
        await idle.promise
      })
      expect(run).not.toHaveBeenCalled()
      expect(useChatStore.getState().messages).toEqual([])
      expect(useChatStore.getState().pendingBashMessages).toEqual([shell])
      expect(state.streaming.queueError).toBeNull()
      expect(state.streaming.isProcessingQueueRef.current).toBe(false)
      if (removal === 'remove and undo') {
        expect(state.streaming.queuePaused).toBe(true)
        expect(state.streaming.queuedMessages).toEqual([{ ...head, content: 'Newer edit' }])
      } else {
        expect(state.streaming.queuedMessages).toEqual([])
      }
    } finally {
      ready.resolve()
      unsubscribe()
      await state.destroy()
    }
  })
}

renderTest('direct preparation never consumes later composer attachments or loses completed shell context on refusal', async () => {
  const entering = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<Awaited<ReturnType<typeof images.processImagesForMessage>>>()
  const run = mock((_request: Parameters<Client['run']>[0]) => Promise.resolve(completedRun))
  const state = await mountRealSend(run)
  const prepare = spyOn(images, 'processImagesForMessage').mockImplementationOnce(() => {
    entering.resolve()
    return ready.promise
  })
  const captured: PendingFileAttachment = {
    kind: 'file', id: 'same-file', path: 'fixture.txt', filename: 'fixture.txt',
    status: 'ready', isDirectory: false, content: 'original data',
  }
  const replacement = { ...captured, content: 'newer data' }
  const completed = { id: 'done', command: 'fixture done', stdout: 'kept output', stderr: '', exitCode: 0, isRunning: false }
  const running = { ...completed, id: 'busy', stdout: '', isRunning: true }
  const newDraft = { text: 'Unrelated composer draft', cursorPosition: 3, lastEditDueToNav: true }
  const store = useChatStore.getState()
  store.addPendingAttachment(captured)
  store.addPendingBashMessage(completed)
  store.addPendingBashMessage(running)
  let pending: ReturnType<typeof state.send> | undefined
  try {
    await React.act(async () => {
      pending = state.send({ content: 'Refuse superseded capture', agentMode: 'DEFAULT' })
      await entering.promise
      expect(useChatStore.getState().pendingBashMessages).toEqual([completed, running])
      store.removePendingAttachment(captured.path)
      store.addPendingAttachment(replacement)
      store.setInputValue(newDraft)
      ready.resolve({ attachments: [], messageContent: undefined })
      expect(await pending).toMatchObject({ status: 'not-started' })
    })
    expect(run).not.toHaveBeenCalled()
    expect(prepare.mock.calls[0]?.[0].content).toContain('original data')
    expect(useChatStore.getState()).toMatchObject({
      inputValue: newDraft.text, cursorPosition: 3, lastEditDueToNav: true,
      pendingAttachments: [replacement], pendingBashMessages: [completed, running],
    })
    await React.act(async () => {
      const admission = await state.route(newDraft.text)
      expect(admission).toMatchObject({ status: 'accepted', disposition: 'started' })
      await completionOf(admission)
    })
    expect(run.mock.calls[0]?.[0]?.prompt).toContain('kept output')
    expect(run.mock.calls[0]?.[0]?.prompt).toContain('newer data')
    expect(run.mock.calls[0]?.[0]?.prompt).not.toContain('original data')
    expect(useChatStore.getState().pendingAttachments).toEqual([])
    expect(useChatStore.getState().pendingBashMessages).toEqual([running])
    await React.act(async () => { await completionOf(await state.route('Another turn')) })
    expect(run.mock.calls[1]?.[0]?.prompt).toBe('Another turn')
    expect(useChatStore.getState().pendingBashMessages).toEqual([running])
  } finally {
    ready.resolve({ attachments: [], messageContent: undefined })
    await completionOf(await pending)
    await state.destroy()
  }
})
