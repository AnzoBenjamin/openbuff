import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test } from 'bun:test'
import React from 'react'

import { useChatStreaming } from '../use-chat-streaming'
import { useChatStore } from '../../state/chat-store'

import type { UseChatStreamingReturn } from '../use-chat-streaming'
import type { SendMessageFn } from '../../types/contracts/send-message'

const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
afterEach(() => useChatStore.getState().reset())

for (const enqueueDuringAbort of [false, true]) {
  renderTest(
    `interrupt pauses queued admission before synchronous abort cleanup (enqueueDuringAbort=${enqueueDuringAbort})`,
    async () => {
      const { testRender } = await import('@opentui/react/test-utils')
      const chain = { current: true }
      const active = { current: 0 }
      const sent: Parameters<SendMessageFn>[0][] = []
      const controller = new AbortController()
      let queue!: UseChatStreamingReturn
      let pauseObservedByAbort: boolean | undefined
      const sendRef = {
        current: async (message: Parameters<SendMessageFn>[0]) => {
          chain.current = true
          sent.push(message)
        },
      }
      function Host() {
        queue = useChatStreaming({
          agentMode: 'DEFAULT',
          inputValue: '',
          setInputValue: () => {},
          terminalWidth: 80,
          separatorWidth: 78,
          isChainInProgressRef: chain,
          activeAgentStreamsRef: active,
          sendMessageRef: sendRef,
        })
        return <text>{queue.queuePaused ? 'Queue paused' : 'Queue ready'}</text>
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
        const interruptFromPreviousRender = queue.interruptStreaming
        controller.signal.addEventListener(
          'abort',
          () => {
            pauseObservedByAbort = queue.isQueuePausedRef.current
            if (enqueueDuringAbort)
              queue.addToQueue('retain this prompt', [], 'PLAN')
            chain.current = false
            queue.stopStreaming()
            // Even a stale completion callback setting the state gate true cannot
            // clear the synchronously published user-pause ref.
            queue.setCanProcessQueue(true)
          },
          { once: true },
        )
        await React.act(async () => {
          if (!enqueueDuringAbort)
            queue.addToQueue('retain this prompt', [], 'PLAN')
          interruptFromPreviousRender(controller)
        })
        await setup!.renderOnce()
        expect(controller.signal.aborted).toBe(true)
        expect(pauseObservedByAbort).toBe(true)
        expect(queue.queuePaused).toBe(true)
        expect(sent).toEqual([])
        expect(queue.queuedMessages.map((message) => message.content)).toEqual([
          'retain this prompt',
        ])
        expect(setup!.captureCharFrame()).toContain('Queue paused')
        await React.act(async () => queue.resumeQueue())
        expect(sent).toEqual([
          { content: 'retain this prompt', agentMode: 'PLAN', attachments: [] },
        ])
        expect(queue.queuedMessages).toEqual([])

        // A fresh explicit submit in the same input batch must clear even an
        // empty queue pause without waiting for rendered state to catch up.
        chain.current = true
        const freshController = new AbortController()
        freshController.signal.addEventListener(
          'abort',
          () => {
            chain.current = false
          },
          { once: true },
        )
        const activateFromPreviousRender = queue.ensureQueueActiveBeforeSubmit
        let activated = false
        await React.act(async () => {
          queue.interruptStreaming(freshController)
          activated = activateFromPreviousRender()
        })
        expect(activated).toBe(true)
        expect(queue.isQueuePausedRef.current).toBe(false)
      } finally {
        await React.act(async () => setup?.renderer.destroy())
        client.clear()
      }
    },
  )
}
