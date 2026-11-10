import { expect, test } from 'bun:test'
import React from 'react'
import type { BoxRenderable, ScrollBoxRenderable } from '@opentui/core'

import { useConversationControls } from '../use-conversation-controls'

const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

renderTest(
  'F6 and Tab traverse visible conversation controls through the content facade',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const scrollRef = React.createRef<ScrollBoxRenderable>()
    const firstRef = React.createRef<BoxRenderable>()
    const secondRef = React.createRef<BoxRenderable>()
    let entered = 0
    let left = 0
    function Host() {
      useConversationControls({
        scrollRef,
        enabled: () => true,
        onEnter: () => entered++,
        onLeave: () => left++,
        onCommands: () => {
          throw new Error('Controls should be available')
        },
        composerHasFocus: () => true,
      })
      return (
        <scrollbox ref={scrollRef} height={6} width={30}>
          <box ref={firstRef} focusable height={1}>
            <text>Inspect output</text>
          </box>
          <box ref={secondRef} focusable height={1}>
            <text>Copy result</text>
          </box>
        </scrollbox>
      )
    }
    let setup!: Awaited<ReturnType<typeof testRender>>
    try {
      await React.act(async () => {
        setup = await testRender(<Host />, { width: 40, height: 8 })
      })
      await setup.renderOnce()
      await React.act(async () => setup.mockInput.pressKey('F6'))
      expect(firstRef.current?.focused).toBe(true)
      expect(entered).toBe(1)
      await React.act(async () => setup.mockInput.pressTab())
      expect(secondRef.current?.focused).toBe(true)
      await React.act(async () => setup.mockInput.pressTab({ shift: true }))
      expect(firstRef.current?.focused).toBe(true)
      await React.act(async () => {
        setup.mockInput.pressEscape()
        await Bun.sleep(100)
      })
      expect(left).toBe(1)
      expect(scrollRef.current?.content.getChildren()).toHaveLength(2)
    } finally {
      if (setup) {
        await React.act(async () => setup.renderer.destroy())
        await setup.renderer.closed
      }
    }
  },
)
