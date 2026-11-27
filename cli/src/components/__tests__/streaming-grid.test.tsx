import { expect, test } from 'bun:test'
import React, { useEffect, useRef, useState } from 'react'
import type { BoxRenderable, ScrollBoxRenderable } from '@opentui/core'

import { GridLayout } from '../grid-layout'
import { useViewportWindow } from '../../hooks/use-viewport-window'
import type { ChatMessage } from '../../types/chat'

const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
const act = React.act

renderTest(
  'adding streaming agents retains mounted cards and the reading position',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const mounts = new Map<string, number>()
    let updateItems!: React.Dispatch<React.SetStateAction<string[]>>
    let scrollbox: ScrollBoxRenderable | null = null
    const Card = ({ id }: { id: string }) => {
      useEffect(() => {
        mounts.set(id, (mounts.get(id) ?? 0) + 1)
      }, [id])
      return (
        <box height={20} flexShrink={0}>
          <text>{`Agent ${id}`}</text>
        </box>
      )
    }
    const renderItem = (id: string) => <Card id={id} />
    const getItemKey = (id: string) => id
    const Harness = () => {
      const [items, setItems] = useState(['a', 'b', 'c'])
      updateItems = setItems
      return (
        <scrollbox
          ref={(node) => {
            scrollbox = node
          }}
          height={10}
        >
          <GridLayout
            items={items}
            availableWidth={180}
            stableColumns
            getItemKey={getItemKey}
            renderItem={renderItem}
          />
        </scrollbox>
      )
    }
    let setup!: Awaited<ReturnType<typeof testRender>>
    await act(async () => {
      setup = await testRender(<Harness />, { width: 180, height: 10 })
    })
    try {
      await act(async () => {
        await setup.renderOnce()
      })
      expect(scrollbox).not.toBeNull()
      scrollbox!.scrollTop = 5
      for (const id of ['d', 'e', 'f', 'g']) {
        await act(async () => {
          updateItems((items) => [...items, id])
        })
        await act(async () => {
          await setup.renderOnce()
        })
        expect(scrollbox!.verticalScrollBar.scrollPosition).toBe(5)
        for (const mountCount of mounts.values()) expect(mountCount).toBe(1)
      }
    } finally {
      await act(async () => {
        setup.renderer.destroy()
      })
    }
  },
)

renderTest(
  'a history with tall agent turns keeps offscreen rendering bounded',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const messages: ChatMessage[] = Array.from({ length: 15 }, (_, i) => ({
      id: `turn-${i}`,
      variant: 'ai',
      timestamp: '00:00',
      content: 'body',
    }))
    let window!: ReturnType<typeof useViewportWindow>
    const Harness = () => {
      const scrollRef = useRef<ScrollBoxRenderable | null>(null)
      window = useViewportWindow({
        messages,
        scrollRef,
        availableWidth: 80,
        headerHeight: 0,
        hasLoadPrevious: false,
        scrollTopOverride: 7_050,
        viewportHeightOverride: 24,
      })
      useEffect(() => {
        for (const message of messages) {
          window.registerMeasurement(message.id, {
            height: 1_000,
          } as BoxRenderable)
        }
      }, [])
      return <text>window</text>
    }
    let setup!: Awaited<ReturnType<typeof testRender>>
    await act(async () => {
      setup = await testRender(<Harness />, { width: 80, height: 24 })
    })
    try {
      await act(async () => {
        await setup.renderOnce()
      })
      expect(window.startIndex).toBe(7)
      expect(window.endIndex).toBe(7)
      expect(window.topSpacerHeight).toBe(7_000)
    } finally {
      await act(async () => {
        setup.renderer.destroy()
      })
    }
  },
)
