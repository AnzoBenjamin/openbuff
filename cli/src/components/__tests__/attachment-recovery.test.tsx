import { expect, test } from 'bun:test'
import React from 'react'
import { QueueScreen } from '../queue-screen'
import { AttachmentRecoveryScreen } from '../attachment-recovery-screen'
import { PendingAttachmentsBanner } from '../pending-attachments-banner'
import { ImageCard } from '../image-card'
import { useMessageQueue } from '../../hooks/use-message-queue'
import { useChatStore } from '../../state/chat-store'
import { initializeThemeStore } from '../../hooks/use-theme'
import type {
  PendingAttachment,
  PendingFileAttachment,
} from '../../types/store'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

renderTest(
  'removing the only attachment pauses empty queued work until restoration',
  async () => {
    let queue!: ReturnType<typeof useMessageQueue>
    let sent = 0
    const chain = { current: true }
    const Host = () => {
      queue = useMessageQueue(
        async () => {
          sent++
        },
        chain,
        { current: 0 },
      )
      return <text>Queue</text>
    }
    const setup = await mount(<Host />)
    try {
      await React.act(async () => {
        queue.pauseQueue()
        queue.addToQueue('', [original], 'PLAN')
      })
      const id = queue.queuedMessages[0].id!
      await React.act(async () => queue.removeQueuedAttachment(id, original.id))
      chain.current = false
      await React.act(async () => queue.resumeQueue())
      expect(sent).toBe(0)
      expect(queue.queuePaused).toBe(true)
      expect(queue.queueAttachmentNotice).toContain('no prompt or attachment')
      await React.act(async () => {
        queue.undoQueuedAttachmentRemoval()
        queue.resumeQueue()
      })
      expect(sent).toBe(1)
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
const original: PendingFileAttachment = {
  kind: 'file',
  id: 'attachment-one',
  path: '/fixture/source.ts',
  sourcePath: '/fixture/source.ts',
  sourceRoot: '/fixture',
  filename: 'source.ts',
  isDirectory: false,
  content: 'Retained original capture',
  status: 'error',
  note: 'Earlier read failed',
}
async function mount(node: React.ReactNode) {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(node, {
      width: 60,
      height: 18,
      exitOnCtrlC: false,
    })
  })
  return setup
}

renderTest(
  'queue attachment retry cannot overwrite a removed then restored original or a cleared then restored prompt',
  async () => {
    let queue!: ReturnType<typeof useMessageQueue>
    const resolves: Array<(value: PendingAttachment) => void> = []
    function Host() {
      queue = useMessageQueue(async () => {}, { current: true }, { current: 0 })
      return (
        <QueueScreen
          {...queue}
          onClose={() => {}}
          onRestore={() => false}
          retryAttachment={async () =>
            new Promise<PendingAttachment>((resolve) => resolves.push(resolve))
          }
        />
      )
    }
    const setup = await mount(<Host />)
    const key = async (value: string) => {
      await React.act(async () => setup.mockInput.pressKey(value))
      await setup.renderOnce()
    }
    try {
      await React.act(async () => {
        queue.pauseQueue()
        queue.addToQueue('Keep prompt context', [original], 'PLAN')
      })
      const id = queue.queuedMessages[0].id!
      await key('a')
      await key('r')
      expect(queue.queuedMessages[0].attachments[0]).toMatchObject({
        status: 'processing',
        content: original.content,
      })
      await React.act(async () => {
        queue.removeQueuedAttachment(id, original.id)
        queue.undoQueuedAttachmentRemoval()
      })
      expect(queue.queuedMessages[0].attachments[0]).toEqual(original)
      await React.act(async () =>
        resolves.shift()?.({
          ...original,
          status: 'ready',
          content: 'STALE replacement',
        }),
      )
      expect(queue.queuedMessages[0].attachments[0]).toEqual(original)
      await key('r')
      await React.act(async () => {
        queue.cancelQueuedMessages([id])
        queue.undoQueueRemoval()
      })
      await React.act(async () =>
        resolves.shift()?.({
          ...original,
          status: 'ready',
          content: 'STALE after Clear/Undo',
        }),
      )
      expect(queue.queuedMessages[0]).toMatchObject({
        id,
        content: 'Keep prompt context',
        agentMode: 'PLAN',
        attachments: [original],
      })
      expect(queue.queuePaused).toBe(true)
      await key('i')
      expect(setup.captureCharFrame()).toContain(original.content)
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'composer attachment removal/Undo and external Clear/restore cancel late reads without changing draft',
  async () => {
    const resolves: Array<(value: PendingAttachment) => void> = []
    useChatStore.setState({
      pendingAttachments: [original],
      inputValue: 'Keep 👩🏽‍💻 draft',
    })
    const setup = await mount(
      <AttachmentRecoveryScreen
        onClose={() => {}}
        loadAttachment={async () =>
          new Promise<PendingAttachment>((resolve) => resolves.push(resolve))
        }
      />,
    )
    const key = async (value: string) => {
      await React.act(async () => setup.mockInput.pressKey(value))
      await setup.renderOnce()
    }
    try {
      await key('r')
      await key('x')
      await key('u')
      await React.act(async () =>
        resolves.shift()?.({
          ...original,
          status: 'ready',
          content: 'STALE replacement',
        }),
      )
      expect(useChatStore.getState().pendingAttachments).toEqual([original])
      await key('r')
      const processing = useChatStore.getState().pendingAttachments[0]
      await React.act(async () =>
        useChatStore.getState().clearPendingAttachments(),
      )
      await React.act(async () =>
        useChatStore.setState({ pendingAttachments: [processing] }),
      )
      await React.act(async () =>
        resolves.shift()?.({
          ...original,
          status: 'ready',
          content: 'STALE after Clear/restore',
        }),
      )
      expect(useChatStore.getState().pendingAttachments).toEqual([original])
      expect(useChatStore.getState().inputValue).toBe('Keep 👩🏽‍💻 draft')
      await key('i')
      expect(setup.captureCharFrame()).toContain(original.content)
    } finally {
      await React.act(async () => setup.renderer.destroy())
      useChatStore.getState().clearPendingAttachments()
    }
  },
)

renderTest(
  'twenty mixed attachments keep a bounded composer banner and a navigable final attachment',
  async () => {
    const attachments = Array.from({ length: 20 }, (_, index) => ({
      ...original,
      id: `attachment-${index}`,
      path: `/fixture/${index}.ts`,
      filename: `文件 👩🏽‍💻 ${index}.ts`,
    }))
    useChatStore.setState({ pendingAttachments: attachments })
    const setup = await mount(<AttachmentRecoveryScreen onClose={() => {}} />)
    try {
      for (let index = 0; index < 19; index++)
        await React.act(async () => setup.mockInput.pressArrow('down'))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('20/20')
      expect(setup.captureCharFrame()).toContain('19.ts')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
    const banner = await mount(
      <box>
        <PendingAttachmentsBanner onManageAttachments={() => {}} />
        <text>Visible composer draft</text>
      </box>,
    )
    try {
      await banner.renderOnce()
      expect(banner.captureCharFrame()).toContain('20 attachments')
      expect(banner.captureCharFrame()).toContain('Visible composer draft')
    } finally {
      await React.act(async () => banner.renderer.destroy())
      useChatStore.getState().clearPendingAttachments()
    }
  },
)

renderTest(
  'empty and corrupt image captures show explicit preview failure with retained-source access',
  async () => {
    for (const [base64, expected] of [
      ['', 'Empty capture'],
      ['invalid-image-data', 'Preview failed'],
    ]) {
      const setup = await mount(
        <ImageCard
          image={{
            path: 'clipboard:fixture',
            filename: 'corrupt.png',
            status: 'ready',
            processedImage: { base64, mediaType: 'image/png' },
          }}
        />,
      )
      try {
        await React.act(async () => Bun.sleep(80))
        await setup.renderOnce()
        expect(setup.captureCharFrame()).toContain(expected)
        expect(setup.captureCharFrame()).toContain('Inspect')
        expect(setup.captureCharFrame()).not.toContain('invalid-image-data')
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    }
  },
)
