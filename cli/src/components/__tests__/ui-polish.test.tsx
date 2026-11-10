import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import { mkdirSync, writeFileSync } from 'node:fs'
import stringWidth from 'string-width'
import { OutputReaderScreen } from '../output-reader-screen'
import { AgentBranchItem } from '../blocks/agent-branch-item'
import { MultipleChoiceForm } from '../ask-user'
import { AgentModeToggle } from '../agent-mode-toggle'
import { createJsonDocument } from '../../utils/output-document'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { useOutputReaderStore } from '../../state/output-reader-store'

initializeThemeStore()
const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test
const frames = '/tmp/openbuff-ui-polish-frames'
mkdirSync(frames, { recursive: true })
afterEach(() => {
  useChatStore.getState().reset()
  useOutputReaderStore.getState().close()
})
async function mount(
  node: React.ReactNode,
  width = 80,
  height = 24,
  settleMs = 80,
) {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(node, { width, height })
  })
  await React.act(async () => {
    await setup.flush()
    if (settleMs) await Bun.sleep(settleMs)
  })
  await setup.renderOnce()
  return setup
}
function capture(setup: Awaited<ReturnType<typeof mount>>, name: string) {
  const frame = setup.captureCharFrame()
  writeFileSync(`${frames}/${name}.txt`, frame)
  writeFileSync(
    `${frames}/${name}.json`,
    JSON.stringify(
      setup.captureSpans().lines.map((line) =>
        line.spans.map((span) => ({
          text: span.text,
          width: stringWidth(span.text),
          fg: span.fg.toInts(),
          bg: span.bg.toInts(),
        })),
      ),
    ),
  )
  return frame
}

nativeTest(
  'readable field view keeps exact search, raw paths, scalar details and scoped command help',
  async () => {
    const document = createJsonDocument('readable-fixture', 'Build result', {
      status: 'completed',
      agentResult: {
        summary: 'Tests passed\nFiles updated\nValidation complete',
        passedTests: 42,
      },
    })
    const setup = await mount(
      <OutputReaderScreen
        messages={[]}
        initialDocument={document}
        onClose={() => {}}
      />,
    )
    try {
      const frame = capture(setup, 'reader-80x24')
      expect(frame).toContain('agent result')
      expect(frame).toContain('passed tests: 42')
      expect(frame).not.toContain('$["agentResult"]')
      expect(frame).toContain('Enter opens full text')
      await React.act(async () => setup.mockInput.pressKey('v'))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('$["agentResult"]')
      await React.act(async () => setup.mockInput.pressKey('v'))
      await React.act(async () => setup.mockInput.pressKey('/'))
      await React.act(async () => {
        await setup.mockInput.typeText('Files updated')
        setup.mockInput.pressEnter()
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Match · line 4')
      await React.act(async () => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Validation complete')
      await React.act(async () => {
        setup.mockInput.pressEscape()
        await Bun.sleep(80)
      })
      await React.act(async () => setup.mockInput.pressKey('v'))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(
        '$[\"agentResult\"][\"summary\"]',
      )
      await React.act(async () => setup.mockInput.pressKey('v'))
      await React.act(async () => setup.mockInput.pressKey('?'))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Reader keyboard commands')
      await React.act(async () => {
        setup.mockInput.pressEscape()
        await Bun.sleep(80)
      })
      await React.act(async () => setup.resize(60, 18))
      await setup.renderOnce()
      const narrow = capture(setup, 'reader-60x18')
      expect(narrow).toContain('Back (Esc)')
      expect(narrow).toContain('? Keys')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'agent task instructions use native Markdown with readable hierarchy',
  async () => {
    const setup = await mount(
      <AgentBranchItem
        name="Researcher"
        isCollapsed={false}
        isStreaming={false}
        preview=""
        prompt={
          '## Investigate the CLI\n\nCheck **memory usage** and `resize` listeners.\n\n- Read the latest logs\n- Verify cleanup'
        }
        availableWidth={80}
      />,
      80,
      24,
      0,
    )
    try {
      const frame = capture(setup, 'agent-80x24')
      expect(frame).toContain('Task')
      expect(frame).toContain('Investigate the CLI')
      expect(frame).not.toContain('## Investigate')
      expect(frame).not.toContain('**memory usage**')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'decision panel fits content, windows many choices and keeps footer visible',
  async () => {
    for (const [width, height] of [
      [100, 32],
      [60, 18],
    ]) {
      const setup = await mount(
        <box width={width} height={height} flexDirection="column">
          <box flexGrow={1}>
            <text>Conversation remains visible</text>
          </box>
          <box
            width={Math.min(88, width)}
            border
            flexGrow={0}
            flexShrink={0}
            paddingLeft={1}
            paddingRight={1}
          >
            <MultipleChoiceForm
              questions={[
                {
                  question: 'Allow terminal command?\nbun test --filter memory',
                  options: Array.from({ length: 25 }, (_, index) => ({
                    label: `Choice ${index + 1}`,
                    description:
                      'An informative description that should stay on its own rows without overlapping neighboring choices.',
                  })),
                },
              ]}
              onSubmit={() => {}}
              onSkip={() => {}}
              onStop={() => {}}
            />
          </box>
        </box>,
        width,
        height,
      )
      try {
        const frame = capture(setup, `choices-${width}x${height}`)
        expect(frame).toContain('Conversation remains visible')
        expect(frame).toContain('bun test --filter memory')
        expect(frame).toContain('Submit')
        expect(frame).toContain('Choice 1')
        const firstBorder = frame
          .split('\n')
          .findIndex((row) => row.includes('┌'))
        expect(firstBorder).toBeGreaterThanOrEqual(4)
        await React.act(async () => {
          for (let index = 0; index < 24; index++)
            setup.mockInput.pressArrow('down')
        })
        await setup.renderOnce()
        const last = capture(setup, `choices-last-${width}x${height}`)
        expect(last).toContain('Choice 25')
        expect(last).toContain('Submit')
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    }
  },
)

nativeTest(
  'mode menu paints a complete boundary above composer border',
  async () => {
    useChatStore.getState().setInputFocused(true)
    const setup = await mount(
      <box width={80} height={24} flexDirection="column">
        <box flexGrow={1}>
          <text>Conversation</text>
        </box>
        <box
          width={80}
          border
          overflow="visible"
          zIndex={25}
          flexDirection="row"
        >
          <box flexGrow={1}>
            <text>Message draft</text>
          </box>
          <AgentModeToggle mode="PLAN" onToggle={() => {}} />
        </box>
      </box>,
    )
    try {
      let rows = setup.captureCharFrame().split('\n')
      const y = rows.findIndex((row) => row.includes('Plan ▾'))
      await React.act(async () =>
        setup.mockMouse.click(rows[y].indexOf('Plan ▾') + 2, y),
      )
      await setup.renderOnce()
      const frame = capture(setup, 'mode-80x24')
      expect(frame).toContain('Execute plan')
      rows = frame.split('\n')
      const header = rows.findIndex((row) => row.includes('Mode'))
      expect(header).toBeGreaterThan(0)
      expect(rows[header - 1]).toContain('─')
      expect(rows[header + 5]).toContain('─')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
