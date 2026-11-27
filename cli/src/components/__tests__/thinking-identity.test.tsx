import { expect, test } from 'bun:test'
import React from 'react'
import { ThinkingBlock } from '../blocks/thinking-block'
import { initializeThemeStore } from '../../hooks/use-theme'
import { processBlocks } from '../../utils/block-processor'
import type { ContentBlock } from '../../types/chat'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

renderTest(
  'CB04 distinct completed/live thoughts render truthful durations and toggle only their displayed identity',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let latest: ContentBlock[] = [
      {
        type: 'text',
        textType: 'reasoning',
        content: 'Completed reasoning evidence',
        thinkingId: 'completed',
        thinkingOpen: false,
        thinkingStartedAt: 1000,
        thinkingEndedAt: 3000,
        thinkingCollapseState: 'preview',
      },
      {
        type: 'text',
        textType: 'reasoning',
        content: 'Live reasoning evidence',
        thinkingId: 'live',
        thinkingOpen: true,
        thinkingStartedAt: 5000,
        thinkingCollapseState: 'preview',
      },
    ]
    const toggles: string[] = []
    function Host() {
      const [blocks, setBlocks] = React.useState(latest)
      latest = blocks
      return (
        <box flexDirection="column">
          {processBlocks(blocks, {
            onReasoningGroup: (group, index) => (
              <ThinkingBlock
                key={index}
                blocks={group}
                availableWidth={60}
                isNested={false}
                isMessageComplete={false}
                onToggleCollapsed={(id) => {
                  toggles.push(id)
                  setBlocks((current) =>
                    current.map((block) =>
                      block.type === 'text' && block.thinkingId === id
                        ? {
                            ...block,
                            thinkingCollapseState:
                              block.thinkingCollapseState === 'hidden'
                                ? 'preview'
                                : 'hidden',
                          }
                        : block,
                    ),
                  )
                }}
              />
            ),
            onToolGroup: () => null,
            onImplementorGroup: () => null,
            onAgentGroup: () => null,
            onSingleBlock: () => null,
          })}
        </box>
      )
    }
    const setup = await testRender(<Host />, { width: 60, height: 15 })
    await React.act(async () => setup.renderOnce())
    const click = async (label: string) => {
      const rows = setup.captureCharFrame().split('\n')
      const y = rows.findIndex((row) => row.includes(label))
      expect(y).toBeGreaterThanOrEqual(0)
      await React.act(async () =>
        setup.mockMouse.click(rows[y]!.indexOf(label) + 2, y),
      )
      await React.act(async () => setup.renderOnce())
    }
    try {
      expect(setup.captureCharFrame()).toContain('Thought · 2s')
      expect(setup.captureCharFrame()).toContain('Thinking')
      expect(setup.captureCharFrame()).toContain('Completed reasoning evidence')
      expect(setup.captureCharFrame()).toContain('Live reasoning evidence')
      await click('Thought')
      expect(toggles).toEqual(['completed'])
      expect(setup.captureCharFrame()).not.toContain(
        'Completed reasoning evidence',
      )
      expect(setup.captureCharFrame()).toContain('Live reasoning evidence')
      expect(latest[1]).toMatchObject({
        thinkingId: 'live',
        thinkingOpen: true,
        thinkingCollapseState: 'preview',
      })
      await click('Thinking')
      expect(toggles).toEqual(['completed', 'live'])
      expect(setup.captureCharFrame()).not.toContain('Live reasoning evidence')
      expect(setup.captureCharFrame()).toContain('Thought · 2s')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
