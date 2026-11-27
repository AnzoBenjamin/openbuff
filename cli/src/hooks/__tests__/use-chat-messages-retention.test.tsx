import { afterAll, expect, test } from 'bun:test'
import React, { useRef, useState } from 'react'
import type {
  BoxRenderable,
  Renderable,
  ScrollBoxRenderable,
} from '@opentui/core'
import type { ChatMessage } from '../../types/chat'
import { useChatMessages } from '../use-chat-messages'
import { MessageListWindow } from '../../components/message-list-window'
import { LoadPreviousButton } from '../../components/load-previous-button'
import { initializeThemeStore } from '../use-theme'
import { useMessageBlockStore } from '../../state/message-block-store'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'
import {
  getSharedTreeSitterClient,
  resetTreeSitterClientStateForTests,
} from '../../utils/tree-sitter-client'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
const visit = (node: Renderable): Renderable[] => [
  node,
  ...node.getChildren().flatMap(visit),
]
afterAll(async () => {
  await getSharedTreeSitterClient()?.destroy()
  resetTreeSitterClientStateForTests()
})

renderTest(
  '500 retained messages start with a 15-message hot page, load older pages and reveal the earliest through the viewport',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    useMessageBlockStore.getState().reset()
    useMessageBlockStore.getState().setContext({
      theme: chatThemes.dark,
      markdownPalette: createMarkdownPalette(chatThemes.dark),
    })
    const retained: ChatMessage[] = Array.from({ length: 500 }, (_, index) => ({
      id: `retained-${index}`,
      variant: 'user',
      content: `RETAINED_BODY_${String(index).padStart(3, '0')}`,
      timestamp: '',
      isComplete: true,
    }))
    let chat!: ReturnType<typeof useChatMessages>
    let reveal!: (id: string) => void
    let scroll!: (top: number) => void
    function Host() {
      const [messages, setMessages] = useState(retained)
      const box = useRef<ScrollBoxRenderable | null>(null)
      const header = useRef<BoxRenderable | null>(null)
      const [target, setTarget] = useState<{
        messageId: string
        token: number
      } | null>(null)
      chat = useChatMessages({ messages, setMessages })
      scroll = (top) => {
        if (box.current) box.current.scrollTop = top
      }
      reveal = (id) => {
        const messageId = chat.revealMessage(id)
        if (messageId)
          setTarget((previous) => ({
            messageId,
            token: (previous?.token ?? 0) + 1,
          }))
      }
      return (
        <scrollbox
          ref={box}
          scrollY
          height={24}
          contentOptions={{ flexDirection: 'column' }}
        >
          <box ref={header} style={{ flexShrink: 0 }}>
            {chat.hiddenMessageCount > 0 && (
              <LoadPreviousButton
                hiddenCount={chat.hiddenMessageCount}
                onLoadMore={chat.handleLoadPreviousMessages}
              />
            )}
          </box>
          <MessageListWindow
            messages={chat.visibleTopLevelMessages}
            scrollRef={box}
            availableWidth={80}
            hasLoadPrevious={chat.hiddenMessageCount > 0}
            headerRef={header}
            scrollTarget={target}
            adjustScrollTop={(delta) => {
              if (box.current) box.current.scrollTop += delta
            }}
            isAtBottomNow={() => false}
            scrollToLatest={() => {}}
          />
        </scrollbox>
      )
    }
    let setup!: Awaited<ReturnType<typeof testRender>>
    await React.act(async () => {
      setup = await testRender(<Host />, { width: 80, height: 24 })
    })
    const settle = async () => {
      for (let pass = 0; pass < 12; pass++)
        await React.act(async () => {
          await Bun.sleep(10)
          await setup.renderOnce()
        })
    }
    const mountedIds = () =>
      visit(setup.renderer.root)
        .filter((node) => node.id.startsWith('transcript-message-'))
        .map((node) => node.id)
    try {
      await settle()
      expect(chat.topLevelMessages).toHaveLength(500)
      expect(chat.visibleTopLevelMessages).toHaveLength(15)
      expect(chat.hiddenMessageCount).toBe(485)
      expect(chat.visibleTopLevelMessages[0].id).toBe('retained-485')
      expect(mountedIds().length).toBeLessThanOrEqual(15)
      for (let page = 0; page < 2; page++) {
        await React.act(async () => scroll(0))
        await settle()
        const lines = setup.captureCharFrame().split('\n')
        const row = lines.findIndex((line) =>
          line.includes('Load previous messages'),
        )
        expect(row).toBeGreaterThanOrEqual(0)
        await React.act(async () =>
          setup.mockMouse.click(lines[row].indexOf('Load previous') + 1, row),
        )
        await settle()
        expect(chat.visibleTopLevelMessages).toHaveLength(30 + page * 15)
      }
      expect(chat.hiddenMessageCount).toBe(455)
      await React.act(async () => reveal('retained-0'))
      await settle()
      expect(chat.hiddenMessageCount).toBe(0)
      expect(chat.topLevelMessages).toEqual(retained)
      expect(setup.captureCharFrame()).toContain('RETAINED_BODY_000')
      // Revealing a durable page must not mount the whole transcript.
      expect(mountedIds().length).toBeLessThan(30)
      expect(new Set(mountedIds()).size).toBe(mountedIds().length)
    } finally {
      await React.act(async () => setup.renderer.destroy())
      useMessageBlockStore.getState().reset()
    }
  },
  15_000,
)
