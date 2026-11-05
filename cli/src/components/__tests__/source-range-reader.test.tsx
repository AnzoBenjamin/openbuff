import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import { OutputReaderScreen } from '../output-reader-screen'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { collectOutputEntries } from '../../utils/output-catalog'

initializeThemeStore()
afterEach(() => useOutputReaderStore.setState({ views: {}, request: null }))
const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test

for (const width of [60, 80]) {
  nativeTest(`captured source range401–403 at${width} columns uses source gutters and source-number goto`, async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const document = collectOutputEntries([{
      id: `range-${width}`, variant: 'ai', content: '', timestamp: '', blocks: [{
        type: 'tool', toolCallId: `read-${width}`, toolName: 'read_files', input: {},
        outputRaw: [{ type: 'json', value: {
          kind: 'read_files_result', version: 1, status: 'partial', results: [{
            path: '/unavailable/current.ts', selector: 'range', startLine: 401, endLine: 403,
            status: 'partial', sourceContent: 'first captured row\nsecond retained row\nlast captured row',
          }],
        } }],
      }],
    }]).find(entry => entry.id.includes(':read:'))!.read()
    const setup = await testRender(<OutputReaderScreen messages={[]} initialDocument={document} onClose={() => {}} />, { width, height: 18 })
    try {
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Source line 401')
      expect(setup.captureCharFrame()).toMatch(/401›\s+first captured row/)
      expect(setup.captureCharFrame()).toMatch(/403\s+last captured row/)
      await React.act(async () => setup.mockInput.pressKey('g'))
      await React.act(async () => { await setup.mockInput.typeText('402'); setup.mockInput.pressEnter() })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Source line 402')
      expect(setup.captureCharFrame()).toMatch(/402›\s+second retained row/)
      expect(useOutputReaderStore.getState().views[document.id].location.line).toBe(1)
      await React.act(async () => setup.mockInput.pressKey('/'))
      await React.act(async () => { await setup.mockInput.typeText('last captured'); setup.mockInput.pressEnter() })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Source line 403')
      expect(setup.captureCharFrame()).toContain('Match · line 403')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  })
}
