import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, test } from 'bun:test'
import React from 'react'

import { useChatStreaming } from '../use-chat-streaming'
import { useChatStore } from '../../state/chat-store'

import type { UseChatStreamingReturn } from '../use-chat-streaming'
import type { SendMessageFn } from '../../types/contracts/send-message'
import type { testRender } from '@opentui/react/test-utils'

// OpenTUI's test-utils import React.act, which production React omits. The
// real renderer integration runs explicitly under development React.
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

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
