import { expect, test } from 'bun:test'
import React from 'react'
import { initializeThemeStore } from '../../../hooks/use-theme'
import { documentForTool } from '../../../utils/output-catalog'
import { OutputReaderScreen } from '../../output-reader-screen'
initializeThemeStore()
const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test
nativeTest(
  'retained receipt finding thirteen is readable through native local find at 60 columns',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const document = documentForTool({
      type: 'tool',
      toolName: 'set_output',
      toolCallId: 'native-receipt',
      input: {
        findings: Array.from({ length: 13 }, (_, index) => ({
          title: `FINDING_${index + 1}`,
          detail: 'retained detail',
        })),
      } as never,
      lifecycle: 'succeeded',
      outputRaw: [{ type: 'json', value: { success: true } }],
    })
    const setup = await testRender(
      <OutputReaderScreen
        messages={[]}
        initialDocument={document}
        onClose={() => {}}
      />,
      { width: 60, height: 18 },
    )
    try {
      await React.act(async () => setup.mockInput.pressKey('/'))
      await React.act(async () => {
        await setup.mockInput.typeText('FINDING_13')
        setup.mockInput.pressEnter()
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('FINDING_13')
      expect(setup.captureCharFrame()).toContain('Back (Esc)')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
