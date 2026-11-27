import { expect, test } from 'bun:test'
import React from 'react'
import { FollowupLine } from '../suggest-followups'
import { initializeThemeStore } from '../../../hooks/use-theme'
import { useOutputReaderStore } from '../../../state/output-reader-store'
import { useChatStore } from '../../../state/chat-store'
import { OutputReaderScreen } from '../../output-reader-screen'
import type { FollowupSubmissionOutcome } from '../../../utils/followup-request'
initializeThemeStore()
const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test
for (const width of [60, 100])
  nativeTest(
    `active followup at ${width} columns exposes full prompt and sends it exactly once after acceptance`,
    async () => {
      const { testRender } = await import('@opentui/react/test-utils')
      const prompt =
        '  preserved leading space\n' +
        '👩🏽‍💻 retained prompt '.repeat(100) +
        '\nFOLLOWUP_TAIL\n  '
      const requests: string[] = []
      let resolve!: (value: FollowupSubmissionOutcome) => void
      const send = async (text: string) => {
        requests.push(text)
        return new Promise<FollowupSubmissionOutcome>((done) => {
          resolve = done
        })
      }
      useOutputReaderStore.setState({ request: null, views: {} })
      useChatStore
        .getState()
        .setInputValue({
          text: 'keep draft 👩🏽‍💻',
          cursorPosition: 5,
          lastEditDueToNav: false,
        })
      function Fixture() {
        const request = useOutputReaderStore((state) => state.request)
        return request?.document ? (
          <OutputReaderScreen
            messages={[]}
            initialDocument={request.document}
            onClose={() => useOutputReaderStore.getState().close()}
          />
        ) : (
          <FollowupLine
            toolCallId={`native-followup-${width}`}
            index={0}
            followup={{ label: 'Continue fixture', prompt }}
            isClicked={false}
            isHovered={false}
            onHover={() => {}}
            onSendFollowup={send}
            labelColumnWidth={12}
            availableWidth={width}
          />
        )
      }
      const setup = await testRender(<Fixture />, { width, height: 24 })
      const click = async (text: string) => {
        await setup.renderOnce()
        const lines = setup.captureCharFrame().split('\n')
        const row = lines.findIndex((line) => line.includes(text))
        expect(row).toBeGreaterThanOrEqual(0)
        await React.act(async () =>
          setup.mockMouse.click(lines[row].indexOf(text) + 1, row),
        )
        await setup.renderOnce()
      }
      try {
        await click('Inspect full prompt')
        expect(useOutputReaderStore.getState().request?.document?.text).toBe(
          prompt,
        )
        await React.act(async () => setup.mockInput.pressKey('/'))
        await React.act(async () => {
          await setup.mockInput.typeText('FOLLOWUP_TAIL')
          setup.mockInput.pressEnter()
        })
        await setup.renderOnce()
        expect(setup.captureCharFrame()).toContain('FOLLOWUP_TAIL')
        await React.act(async () => {
          setup.mockInput.pressEscape()
          await Bun.sleep(70)
        })
        await click('Continue fixture')
        await click('Continue fixture')
        expect(requests).toEqual([prompt])
        expect(setup.captureCharFrame()).not.toContain('✓')
        await React.act(async () =>
          resolve({ accepted: false, error: 'Captured routing failure' }),
        )
        await setup.renderOnce()
        expect(setup.captureCharFrame()).toContain('Captured routing failure')
        expect(setup.captureCharFrame()).not.toContain('✓')
        await click('Try again')
        expect(requests).toEqual([prompt, prompt])
        await React.act(async () => resolve({ accepted: true }))
        await setup.renderOnce()
        expect(setup.captureCharFrame()).toContain('✓')
        await click('Continue fixture')
        expect(requests).toHaveLength(2)
        expect(useChatStore.getState().inputValue).toBe('keep draft 👩🏽‍💻')
        expect(useChatStore.getState().cursorPosition).toBe(5)
      } finally {
        await React.act(async () => setup.renderer.destroy())
        useOutputReaderStore.getState().close()
        useChatStore.getState().reset()
      }
    },
  )
