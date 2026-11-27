import { expect, test } from 'bun:test'
import React, { useState } from 'react'
import type { BoxRenderable, TextRenderable } from '@opentui/core'
import { MessageWithAgents } from '../message-with-agents'
import { setProjectRoot } from '../../project-files'
import { useChatStore } from '../../state/chat-store'
import { useMessageBlockStore } from '../../state/message-block-store'
import { initializeThemeStore, useThemeStore } from '../../hooks/use-theme'
import { useConfiguredModelName } from '../../hooks/use-configured-model-name'
import { getUserMessage } from '../../utils/message-history'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'
import type { ChatMessage } from '../../types/chat'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

async function mount(node: React.ReactNode) {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(node, { width: 80, height: 24 })
  })
  return setup
}

async function frameWith(
  setup: Awaited<ReturnType<typeof mount>>,
  text: string,
) {
  for (let attempt = 0; attempt < 40; attempt++) {
    await React.act(async () => {
      await Bun.sleep(25)
      await setup.renderOnce()
    })
    if (setup.captureCharFrame().includes(text)) return
  }
  throw new Error(`Missing ${text}: ${setup.captureCharFrame()}`)
}

renderTest(
  'inline expansion and validation survive row unmount, stay identity-bound and prune on removal',
  async () => {
    setProjectRoot(process.cwd())
    useMessageBlockStore.getState().reset()
    useMessageBlockStore
      .getState()
      .setContext({
        theme: chatThemes.dark,
        markdownPalette: createMarkdownPalette(chatThemes.dark),
      })
    const message = {
      ...getUserMessage('# Heading\none\ntwo\nFOURTH_LINE'),
      validationErrors: [{ id: 'fixture', message: 'retained validation' }],
    }
    let setVisible!: (visible: boolean) => void
    function Host() {
      const [visible, update] = useState(true)
      setVisible = update
      return visible ? (
        <MessageWithAgents
          message={message}
          depth={0}
          isLastMessage={false}
          availableWidth={80}
        />
      ) : (
        <text>Row outside viewport</text>
      )
    }
    const setup = await mount(<Host />)
    const click = async (text: string) => {
      await frameWith(setup, text)
      const rows = setup.captureCharFrame().split('\n')
      const row = rows.findIndex((line) => line.includes(text))
      await React.act(async () =>
        setup.mockMouse.click(rows[row].indexOf(text) + 1, row),
      )
    }
    try {
      await click('Show more')
      await frameWith(setup, 'FOURTH_LINE')
      await click('[!]')
      await frameWith(setup, 'retained validation')
      await React.act(async () => setVisible(false))
      await frameWith(setup, 'Row outside viewport')
      await React.act(async () => setVisible(true))
      await frameWith(setup, 'retained validation')
      expect(setup.captureCharFrame()).toContain('FOURTH_LINE')
      const store = useMessageBlockStore.getState()
      store.setView('other-message', 'prompt', true)
      store.pruneViews([message.id])
      expect(
        useMessageBlockStore.getState().views['other-message'],
      ).toBeUndefined()
      expect(useMessageBlockStore.getState().views[message.id]).toEqual({
        prompt: true,
        validation: true,
      })
      store.pruneViews([])
      expect(useMessageBlockStore.getState().views).toEqual({})
      store.setView('another-session', 'prompt', true)
      store.reset()
      expect(useMessageBlockStore.getState().views).toEqual({})
    } finally {
      await React.act(async () => setup.renderer.destroy())
      useMessageBlockStore.getState().reset()
    }
  },
)

renderTest(
  'closing a configuration generation refreshes the model at the same mode using local resolution only',
  async () => {
    let configured = 'fixture/old-model'
    let reads = 0
    let setGeneration!: (value: string) => void
    const resolve = () => {
      reads++
      return configured
    }
    function Host() {
      const [generation, update] = useState('closed')
      setGeneration = update
      const model = useConfiguredModelName('DEFAULT', generation, resolve)
      return <text>Configured model: {model}</text>
    }
    const setup = await mount(<Host />)
    try {
      await frameWith(setup, 'fixture/old-model')
      await React.act(async () => setGeneration('open'))
      configured = 'fixture/new-model'
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('fixture/old-model')
      await React.act(async () => setGeneration('closed'))
      await frameWith(setup, 'fixture/new-model')
      expect(reads).toBe(3)
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

function luminance(channels: readonly number[]) {
  const values = channels.slice(0, 3).map((value) => {
    const channel = value / 255
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  })
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
}

renderTest(
  'restored legacy agent headers render readable controlled colors in both themes and focus states',
  async () => {
    const measurements: unknown[] = []
    for (const name of ['dark', 'light'] as const) {
      useThemeStore.getState().setThemeName(name)
      useMessageBlockStore
        .getState()
        .setContext({
          theme: chatThemes[name],
          markdownPalette: createMarkdownPalette(chatThemes[name]),
        })
      for (const collapsed of [false, true])
        for (const focused of [false, true]) {
          const message: ChatMessage = {
            id: 'legacy-agent',
            variant: 'agent',
            content: 'Captured result',
            timestamp: '',
            metadata: { isCollapsed: collapsed },
            agent: {
              agentName: 'Legacy reviewer',
              agentType: 'fixture',
              responseCount: 1,
            },
          }
          useChatStore.getState().setFocusedAgentId(focused ? message.id : null)
          const setup = await mount(
            <MessageWithAgents
              message={message}
              depth={0}
              isLastMessage={false}
              availableWidth={80}
            />,
          )
          try {
            await frameWith(setup, 'Legacy reviewer')
            const title = setup.renderer.root.findDescendantById(
              `agent-title-${message.id}`,
            ) as TextRenderable
            const control = setup.renderer.root.findDescendantById(
              `agent-title-control-${message.id}`,
            ) as BoxRenderable
            const foreground = title.fg.toInts(),
              background = control.backgroundColor.toInts()
            const [low, high] = [
              luminance(foreground),
              luminance(background),
            ].sort((a, b) => a - b)
            const contrast = (high + 0.05) / (low + 0.05)
            expect(foreground[3]).toBe(255)
            expect(background[3]).toBe(255)
            expect(contrast).toBeGreaterThanOrEqual(4.5)
            measurements.push({
              theme: name,
              collapsed,
              focused,
              foreground,
              background,
              contrast,
            })
          } finally {
            await React.act(async () => setup.renderer.destroy())
          }
        }
    }
    console.log(
      JSON.stringify({
        fixture: 'legacy-header-rendered-colors',
        measurements,
        scope:
          'Native renderer controlled colors; no terminal-default/screen-reader claim.',
      }),
    )
    useMessageBlockStore.getState().reset()
    useChatStore.getState().reset()
    useThemeStore.getState().setThemeName('dark')
  },
)
