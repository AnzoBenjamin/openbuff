import { afterAll, expect, test } from 'bun:test'
import React, { useRef, useState } from 'react'
import type {
  BoxRenderable,
  MarkdownRenderable,
  Renderable,
  ScrollBoxRenderable,
} from '@opentui/core'

import { ContentWithMarkdown } from '../blocks/content-with-markdown'
import { ChatHistoryScreen } from '../chat-history-screen'
import { MessageListWindow } from '../message-list-window'
import { useChatMessages } from '../../hooks/use-chat-messages'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useMessageBlockStore } from '../../state/message-block-store'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'
import {
  getSharedTreeSitterClient,
  resetTreeSitterClientStateForTests,
} from '../../utils/tree-sitter-client'
import type { ChatMessage } from '../../types/chat'
import type { getAllChatsAsync } from '../../utils/chat-history'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
const palette = createMarkdownPalette(chatThemes.dark)
const visit = (node: Renderable): Renderable[] => [
  node,
  ...node.getChildren().flatMap(visit),
]

afterAll(async () => {
  await getSharedTreeSitterClient()?.destroy()
  resetTreeSitterClientStateForTests()
})

renderTest(
  'completed eager markdown stays visible while its native parser finalizes',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let setup!: Awaited<ReturnType<typeof testRender>>
    await React.act(async () => {
      setup = await testRender(
        <ContentWithMarkdown
          content={'# Restored heading\n\n**BODY_ONLY_ONCE**'}
          isStreaming={false}
          eagerProse
          codeBlockWidth={80}
          palette={palette}
        />,
        { width: 80, height: 20 },
      )
    })
    try {
      await React.act(async () => setup.renderOnce())
      const initialMarkdown = visit(setup.renderer.root).find(
        (node) => node.constructor.name === 'MarkdownRenderable',
      ) as MarkdownRenderable
      expect(setup.captureCharFrame().match(/BODY_ONLY_ONCE/g)).toHaveLength(1)
      for (let pass = 0; pass < 40; pass++) {
        await React.act(async () => {
          await Bun.sleep(10)
          await setup.renderOnce()
        })
        expect(setup.captureCharFrame().match(/BODY_ONLY_ONCE/g)).toHaveLength(
          1,
        )
        if (!initialMarkdown.streaming) break
      }
      const markdown = visit(setup.renderer.root).find(
        (node) => node.constructor.name === 'MarkdownRenderable',
      ) as MarkdownRenderable
      expect(markdown).toBe(initialMarkdown)
      expect(markdown.streaming).toBe(false)
      expect(setup.captureCharFrame().match(/BODY_ONLY_ONCE/g)).toHaveLength(1)
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'live markdown finalizes on completion without replacing or duplicating its body',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let finish!: () => void
    function Host() {
      const [live, setLive] = useState(true)
      finish = () => setLive(false)
      return (
        <ContentWithMarkdown
          content={'# Receiving\n\n**STREAM_BODY_ONCE**'}
          isStreaming={live}
          eagerProse
          codeBlockWidth={80}
          palette={palette}
        />
      )
    }
    let setup!: Awaited<ReturnType<typeof testRender>>
    await React.act(async () => {
      setup = await testRender(<Host />, { width: 80, height: 20 })
    })
    try {
      await React.act(async () => setup.renderOnce())
      const markdown = visit(setup.renderer.root).find(
        (node) => node.constructor.name === 'MarkdownRenderable',
      ) as MarkdownRenderable
      expect(markdown.streaming).toBe(true)
      await React.act(async () => finish())
      for (let pass = 0; pass < 20; pass++) {
        await React.act(async () => {
          await Bun.sleep(10)
          await setup.renderOnce()
        })
        const frame = setup.captureCharFrame()
        expect(frame.match(/STREAM_BODY_ONCE/g)).toHaveLength(1)
      }
      expect(visit(setup.renderer.root)).toContain(markdown)
      expect(markdown.streaming).toBe(false)
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

for (const outcome of ['loaded', 'unavailable'] as const) {
  renderTest(
    `saved session loading and ${outcome} state each display one status`,
    async () => {
      const { testRender } = await import('@opentui/react/test-utils')
      let settle!: () => void
      const load: typeof getAllChatsAsync = (
        _max,
        _signal,
        _initial,
        _count,
        state,
      ) =>
        new Promise((resolve) => {
          settle = () => {
            state?.({ state: outcome })
            resolve(
              outcome === 'loaded'
                ? [
                    {
                      chatId: 'saved-once',
                      lastPrompt: 'SAVED_PROMPT_ONCE',
                      messageCount: 2,
                      timestamp: new Date(),
                    },
                  ]
                : [],
            )
          }
        })
      let setup!: Awaited<ReturnType<typeof testRender>>
      await React.act(async () => {
        setup = await testRender(
          <ChatHistoryScreen
            onSelectChat={() => {}}
            onCancel={() => {}}
            onNewChat={() => {}}
            dependencies={{ load, delete: () => false }}
          />,
          { width: 100, height: 24 },
        )
      })
      try {
        await React.act(async () => setup.renderOnce())
        const loading = setup.captureCharFrame()
        console.log(
          JSON.stringify({
            fixture: `saved-history-${outcome}`,
            phase: 'loading',
            frame: loading,
          }),
        )
        await React.act(async () => {
          settle()
          await Promise.resolve()
        })
        let settled = ''
        for (let pass = 0; pass < 40; pass++) {
          await React.act(async () => {
            await Bun.sleep(10)
            await setup.renderOnce()
          })
          settled = setup.captureCharFrame()
          if (!settled.includes('Loading saved sessions')) break
        }
        console.log(
          JSON.stringify({
            fixture: `saved-history-${outcome}`,
            phase: 'settled',
            frame: settled,
          }),
        )
        expect(settled).not.toContain('Loading saved sessions')
        if (outcome === 'unavailable')
          expect(settled.match(/Saved sessions unavailable/g)).toHaveLength(1)
        else expect(settled.match(/SAVED_PROMPT_ONCE/g)).toHaveLength(1)
        expect(loading.match(/Loading saved sessions/g)).toHaveLength(1)
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    },
  )
}

renderTest(
  'restored history and successive reveals mount each retained message once',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    useMessageBlockStore.getState().reset()
    useMessageBlockStore
      .getState()
      .setContext({ theme: chatThemes.dark, markdownPalette: palette })
    const restored: ChatMessage[] = Array.from({ length: 45 }, (_, index) => ({
      id: `history-${index}`,
      variant: 'ai',
      content: '',
      timestamp: '',
      isComplete: true,
      blocks: [
        {
          type: 'text',
          content: `# History ${index}\n\n**BODY_${String(index).padStart(2, '0')}**\n\n- First retained line\n- Last retained line`,
        },
      ],
    }))
    let restore!: () => void
    let reveal!: () => void
    let scroll!: (position: number) => void
    function Host() {
      const [messages, setMessages] = useState<ChatMessage[]>([])
      const box = useRef<ScrollBoxRenderable | null>(null)
      const header = useRef<BoxRenderable | null>(null)
      const chat = useChatMessages({ messages, setMessages })
      restore = () => setMessages(restored)
      reveal = chat.handleLoadPreviousMessages
      scroll = (position) => {
        if (box.current) box.current.scrollTop = position
      }
      return (
        <scrollbox
          ref={box}
          scrollY
          height={24}
          contentOptions={{ flexDirection: 'column' }}
        >
          <box ref={header} style={{ height: 1, flexShrink: 0 }}>
            <text>Retained history</text>
          </box>
          <MessageListWindow
            messages={chat.visibleTopLevelMessages}
            scrollRef={box}
            availableWidth={80}
            hasLoadPrevious={chat.hiddenMessageCount > 0}
            headerRef={header}
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
    const checkFrames = async () => {
      for (let pass = 0; pass < 20; pass++) {
        await React.act(async () => {
          await Bun.sleep(10)
          await setup.renderOnce()
        })
        const ids = visit(setup.renderer.root)
          .filter((node) => node.id.startsWith('transcript-message-'))
          .map((node) => node.id)
        expect(new Set(ids).size).toBe(ids.length)
        const bodies = setup.captureCharFrame().match(/BODY_\d{2}/g) ?? []
        expect(new Set(bodies).size).toBe(bodies.length)
      }
      expect(setup.captureCharFrame()).toMatch(/BODY_\d{2}/)
    }
    try {
      await React.act(async () => restore())
      await checkFrames()
      for (let pass = 0; pass < 2; pass++) {
        await React.act(async () => {
          reveal()
          scroll(0)
        })
        await checkFrames()
      }
      await React.act(async () => scroll(100_000))
      await checkFrames()
      await React.act(async () => setup.resize(60, 24))
      await checkFrames()
    } finally {
      await React.act(async () => setup.renderer.destroy())
      useMessageBlockStore.getState().reset()
    }
  },
  15_000,
)
