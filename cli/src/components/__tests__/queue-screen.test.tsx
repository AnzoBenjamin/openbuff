import { expect, test } from 'bun:test'
import React from 'react'

import { QueueScreen } from '../queue-screen'
import { useMessageQueue } from '../../hooks/use-message-queue'
import { initializeThemeStore } from '../../hooks/use-theme'
import type { QueuedMessage } from '../../hooks/use-message-queue'
import type { PendingAttachment } from '../../types/store'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
const attachment: PendingAttachment = {
  kind: 'text',
  id: 'evidence',
  content: 'retained source',
  preview: 'retained source',
  charCount: 15,
}

async function mountQueue(
  send: (message: QueuedMessage) => Promise<void> = async () => {},
) {
  const { testRender } = await import('@opentui/react/test-utils')
  const chain = { current: true }
  const streams = { current: 0 }
  let queue!: ReturnType<typeof useMessageQueue>
  let closed = false
  function Host() {
    queue = useMessageQueue(send, chain, streams)
    return (
      <QueueScreen
        {...queue}
        onClose={() => {
          closed = true
        }}
        onRestore={() => false}
      />
    )
  }
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(<Host />, { width: 60, height: 18 })
  })
  await React.act(async () => queue.pauseQueue())
  return {
    setup,
    chain,
    get queue() {
      return queue
    },
    get closed() {
      return closed
    },
    async key(name: string) {
      await React.act(async () => {
        if (name === 'escape') setup.mockInput.pressEscape()
        else setup.mockInput.pressKey(name)
        if (name === 'escape') await Bun.sleep(120)
      })
      await setup.renderOnce()
    },
    frame: () => setup.captureCharFrame(),
    destroy: () => React.act(async () => setup.renderer.destroy()),
  }
}

renderTest(
  'mode and prompt edits preserve item identity and attachments at 60×18',
  async () => {
    const host = await mountQueue()
    try {
      await React.act(async () => {
        host.queue.addToQueue('Review first', [attachment], 'PLAN')
        host.queue.addToQueue('Implement later', [], 'EXECUTE_PLAN')
      })
      const firstId = host.queue.queuedMessages[0]!.id
      await host.key('m')
      expect(host.frame()).toContain('Mode for this queued prompt')
      await React.act(async () => host.setup.mockInput.pressArrow('down'))
      await host.key('escape')
      expect(host.queue.queuedMessages[0]!.agentMode).toBe('PLAN')
      expect(host.closed).toBe(false)
      await host.key('m')
      await React.act(async () => {
        host.setup.mockInput.pressArrow('down')
        host.setup.mockInput.pressEnter()
      })
      expect(host.queue.queuedMessages[0]).toEqual({
        id: firstId,
        content: 'Review first',
        attachments: [attachment],
        agentMode: 'EXECUTE_PLAN',
      })
      await host.key('e')
      // Text and Enter arrive in the same terminal batch.
      await React.act(async () => {
        await host.setup.mockInput.pasteBracketedText(' 👩🏽‍💻')
        host.setup.mockInput.pressEnter()
      })
      expect(host.queue.queuedMessages[0]!.content).toBe('Review first 👩🏽‍💻')
      expect(host.queue.queuedMessages[0]!.attachments).toEqual([attachment])
      expect(host.queue.queuedMessages[1]!.content).toBe('Implement later')
      expect(host.queue.queuePaused).toBe(true)
    } finally {
      await host.destroy()
    }
  },
)

renderTest(
  'clear confirmation retains newly queued work and Undo restores the batch paused once',
  async () => {
    const sent: QueuedMessage[] = []
    const host = await mountQueue(async (message) => {
      sent.push(message)
    })
    try {
      await React.act(async () => {
        host.queue.addToQueue('First', [attachment], 'PLAN')
        host.queue.addToQueue('Second', [], 'EXECUTE_PLAN')
      })
      const original = [...host.queue.queuedMessages]
      await host.key('c')
      expect(host.frame()).toContain('Clear 2 queued prompts?')
      expect(host.frame()).toContain('Y clears · I inspect all · Esc cancels')
      await host.key('i')
      expect(host.frame()).toContain('Prompts to clear')
      await host.key('escape')
      expect(host.frame()).toContain('Clear 2 queued prompts?')
      await host.key('escape')
      expect(host.closed).toBe(false)
      expect(host.queue.queuedMessages).toEqual(original)
      await host.key('c')
      await React.act(async () =>
        host.queue.addToQueue('Added after preview', [], 'DEFAULT'),
      )
      const added = host.queue.queuedMessages[2]!
      await host.key('y')
      expect(host.queue.queuedMessages).toEqual([added])
      expect(host.queue.queueRemovalCount).toBe(2)
      await React.act(async () => {
        host.chain.current = false
        host.queue.undoQueueRemoval()
        host.queue.undoQueueRemoval()
      })
      expect(host.queue.queuedMessages).toEqual([...original, added])
      expect(host.queue.queueRemovalCount).toBe(0)
      expect(host.queue.queuePaused).toBe(true)
      expect(sent).toEqual([])
    } finally {
      await host.destroy()
    }
  },
)

renderTest(
  'an edit or mode save cannot target a different prompt after its item disappears',
  async () => {
    const host = await mountQueue()
    try {
      await React.act(async () => {
        host.queue.addToQueue('Original', [], 'PLAN')
        host.queue.addToQueue('Unrelated', [attachment], 'DEFAULT')
      })
      const firstId = host.queue.queuedMessages[0]!.id!
      await host.key('e')
      await React.act(async () => host.queue.removeQueuedMessage(firstId))
      await React.act(async () => {
        await host.setup.mockInput.typeText(' retained edit')
        host.setup.mockInput.pressEnter()
      })
      await host.setup.renderOnce()
      expect(host.frame()).toContain('edit retained here')
      expect(host.frame()).toContain('Original retained edit')
      expect(host.queue.queuedMessages[0]!.content).toBe('Unrelated')
      await host.key('escape')
      await host.key('m')
      const secondId = host.queue.queuedMessages[0]!.id!
      await React.act(async () => host.queue.removeQueuedMessage(secondId))
      await React.act(async () =>
        host.queue.addToQueue('Replacement', [], 'EXECUTE_PLAN'),
      )
      await React.act(async () => host.setup.mockInput.pressEnter())
      expect(host.queue.queuedMessages[0]!.agentMode).toBe('EXECUTE_PLAN')
      expect(host.queue.queuedMessages[0]!.content).toBe('Replacement')
    } finally {
      await host.destroy()
    }
  },
)

renderTest(
  'the selected FIFO tail stays visible through height-only resize',
  async () => {
    const host = await mountQueue()
    try {
      await React.act(async () => {
        for (let index = 1; index <= 40; index++)
          host.queue.addToQueue(`Prompt ${index}`, [], 'PLAN')
      })
      await React.act(async () => {
        for (let index = 1; index < 40; index++)
          host.setup.mockInput.pressArrow('down')
      })
      await host.setup.renderOnce()
      expect(host.frame()).toContain('› Plan · 0 attachments · Prompt 40')
      await React.act(async () => host.setup.resize(60, 14))
      await host.setup.renderOnce()
      expect(host.frame()).toContain('› Plan · 0 attachments · Prompt 40')
      expect(host.frame()).toContain('C clear queue')
      expect(host.frame()).toContain('Esc Back')
    } finally {
      await host.destroy()
    }
  },
)

renderTest(
  'recovery and exit drains retain FIFO mode and attachments without replaying drained work',
  async () => {
    const host = await mountQueue()
    try {
      await React.act(async () => {
        host.queue.addToQueue('First', [attachment], 'PLAN')
        host.queue.addToQueue('Second', [], 'EXECUTE_PLAN')
      })
      const original = [...host.queue.queuedMessages]
      await React.act(async () => host.queue.cancelQueuedMessages())
      expect(host.queue.queueRemovalCount).toBe(2)
      await host.key('u')
      expect(host.queue.queuedMessages).toEqual(original)
      let drained: QueuedMessage[] = []
      await React.act(async () => {
        drained = host.queue.clearQueue(1)
      })
      expect(drained).toEqual([original[0]!])
      expect(host.queue.queuedMessages).toEqual([original[1]!])
      await host.key('u')
      expect(host.queue.queuedMessages).toEqual([original[1]!])
    } finally {
      await host.destroy()
    }
  },
)

renderTest(
  'a failed send keeps its prompt and reason visible alongside edit feedback',
  async () => {
    const host = await mountQueue(async () => {
      throw new Error('Provider unavailable')
    })
    try {
      await React.act(async () =>
        host.queue.addToQueue('Retain failed work', [attachment], 'PLAN'),
      )
      const originalId = host.queue.queuedMessages[0]!.id
      await React.act(async () => {
        host.chain.current = false
        host.queue.resumeQueue()
        await Bun.sleep(10)
      })
      expect(host.queue.queuePaused).toBe(true)
      expect(host.queue.queueError).toBe('Provider unavailable')
      expect(host.queue.queuedMessages[0]!.id).toBe(originalId)
      await host.key('e')
      await React.act(async () => host.setup.mockInput.pressEnter())
      await host.setup.renderOnce()
      expect(host.frame()).toContain('Send failed · Provider unavailable')
      expect(host.frame()).toContain('Queued prompt saved')
      expect(host.queue.queuedMessages[0]!.attachments).toEqual([attachment])
    } finally {
      await host.destroy()
    }
  },
)
