import { expect, test } from 'bun:test'
import React from 'react'
import type { Renderable } from '@opentui/core'
import {
  UserBlockTextWithInlineCopy,
  UserContentWithCopyButton,
} from '../blocks/user-content-copy'
import { MessageWithAgents } from '../message-with-agents'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useMessageBlockStore } from '../../state/message-block-store'
import { getUserMessage } from '../../utils/message-history'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
const palette = createMarkdownPalette(chatThemes.dark)

async function mount(node: React.ReactNode) {
  const { testRender } = await import('@opentui/react/test-utils')
  const setup = await testRender(node, { width: 80, height: 24 })
  await React.act(async () => {
    await Bun.sleep(20)
    await setup.renderOnce()
  })
  return setup
}

async function waitForFrame(
  setup: Awaited<ReturnType<typeof mount>>,
  text: string,
  visible = true,
) {
  for (let attempt = 0; attempt < 40; attempt++) {
    await React.act(async () => {
      await Bun.sleep(25)
      await setup.renderOnce()
    })
    if (setup.captureCharFrame().includes(text) === visible) return
  }
  throw new Error(
    `Frame did not settle for ${text}: ${setup.captureCharFrame()}`,
  )
}

function controls(node: Renderable): Renderable[] {
  const result: Renderable[] = []
  if (node.focusable) result.push(node)
  for (const child of node.getChildren())
    result.push(...controls(child as Renderable))
  return result
}

renderTest(
  'complete Markdown, hyphen and underscore prompts keep keyboard copy and disclosure with original bytes',
  async () => {
    for (const first of ['# Heading', 'plain-hyphen', 'plain_underscore']) {
      const content = `  ${first}\none\ntwo\nFOURTH_LINE  `
      let copied = ''
      const setup = await mount(
        <UserContentWithCopyButton
          content={content}
          messageId={first}
          isLoading={false}
          isUser={true}
          textColor="#ffffff"
          codeBlockWidth={78}
          palette={palette}
          showCopyButton={true}
          copy={async (text) => {
            copied = text
          }}
        />,
      )
      try {
        expect(setup.captureCharFrame()).toContain('Copy prompt')
        expect(setup.captureCharFrame()).toContain('Show more')
        expect(setup.captureCharFrame()).not.toContain('FOURTH_LINE')
        const [copy, toggle] = controls(setup.renderer.root)
        expect(copy).toBeDefined()
        expect(toggle).toBeDefined()
        await React.act(async () => {
          copy.focus()
          setup.mockInput.pressEnter()
        })
        expect(copied).toBe(content)
        await React.act(async () => {
          toggle.focus()
          setup.mockInput.pressEnter()
          await Bun.sleep(20)
        })
        await waitForFrame(setup, 'FOURTH_LINE')
        expect(setup.captureCharFrame()).toContain('FOURTH_LINE')
        expect(setup.captureCharFrame()).toContain('Show less')
        await React.act(async () => setup.mockInput.pressEnter())
        await waitForFrame(setup, 'FOURTH_LINE', false)
        expect(setup.captureCharFrame()).not.toContain('FOURTH_LINE')
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    }
  },
)

renderTest(
  'structured user Markdown blocks expose disclosure and copy the complete original prompt',
  async () => {
    const content = '# Heading\none\ntwo\nFOURTH_LINE'
    const original = `  ${content}\n\nretained other block  `
    let copied = ''
    const setup = await mount(
      <UserBlockTextWithInlineCopy
        content={content}
        contentToCopy={original}
        isStreaming={false}
        textColor="#ffffff"
        codeBlockWidth={78}
        palette={palette}
        marginTop={0}
        marginBottom={0}
        copy={async (text) => {
          copied = text
        }}
      />,
    )
    try {
      expect(setup.captureCharFrame()).toContain('Copy prompt')
      expect(setup.captureCharFrame()).toContain('Show more')
      const [copy, toggle] = controls(setup.renderer.root)
      await React.act(async () => {
        copy.focus()
        setup.mockInput.pressEnter()
      })
      expect(copied).toBe(original)
      await React.act(async () => {
        toggle.focus()
        setup.mockInput.pressEnter()
        await Bun.sleep(20)
      })
      await waitForFrame(setup, 'FOURTH_LINE')
      expect(setup.captureCharFrame()).toContain('FOURTH_LINE')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'fresh and restored user message wrappers normalize missing completion for text and block prompts',
  async () => {
    useMessageBlockStore
      .getState()
      .setContext({ theme: chatThemes.dark, markdownPalette: palette })
    try {
      for (const blockForm of [false, true]) {
        const content = '# Heading\none\ntwo\nFOURTH_LINE'
        const fresh = getUserMessage(
          blockForm ? [{ type: 'text', content }] : content,
        )
        for (const message of [fresh, JSON.parse(JSON.stringify(fresh))]) {
          const setup = await mount(
            <MessageWithAgents
              message={message}
              depth={0}
              isLastMessage={false}
              availableWidth={80}
            />,
          )
          try {
            expect(setup.captureCharFrame()).toContain('Copy prompt')
            expect(setup.captureCharFrame()).toContain('Show more')
            expect(setup.captureCharFrame()).not.toContain('FOURTH_LINE')
          } finally {
            await React.act(async () => setup.renderer.destroy())
          }
        }
      }
    } finally {
      useMessageBlockStore.getState().reset()
    }
  },
)

renderTest(
  'explicitly pending user text and incomplete assistant text remain fully visible',
  async () => {
    const content = '# Heading\none\ntwo\nFOURTH_LINE'
    for (const state of [
      { isUser: true, isLoading: false, isComplete: false },
      { isUser: true, isLoading: true },
      { isUser: false, isLoading: false },
    ]) {
      const setup = await mount(
        <UserContentWithCopyButton
          content={content}
          messageId="pending"
          {...state}
          textColor="#ffffff"
          codeBlockWidth={78}
          palette={palette}
          showCopyButton={false}
        />,
      )
      try {
        await waitForFrame(setup, 'FOURTH_LINE')
        expect(setup.captureCharFrame()).toContain('FOURTH_LINE')
        expect(setup.captureCharFrame()).not.toContain('Show more')
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    }
  },
)
