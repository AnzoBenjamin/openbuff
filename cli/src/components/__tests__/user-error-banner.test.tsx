import { expect, test } from 'bun:test'
import React from 'react'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useOutputReaderStore } from '../../state/output-reader-store'
import { UserErrorBanner } from '../user-error-banner'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

for (const [label, error, title] of [
  ['ordinary error', 'Something went wrong', 'Error'],
  [
    'context length',
    'Maximum context 200000 tokens; requested 201209 tokens.',
    'Error',
  ],
  ['network error', 'Network request failed: Connection refused', 'Error'],
  ['multiline error', 'First line of error\nSecond line of error', 'Error'],
  ['literal special characters', 'Error with <html> tags & "quotes"', 'Error'],
  ['long error', 'A'.repeat(500), 'Error'],
  ['custom title', 'Something went wrong', 'Network Error'],
]) {
  renderTest(`UserErrorBanner retains and exposes ${label}`, async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let setup!: Awaited<ReturnType<typeof testRender>>
    await React.act(async () => {
      setup = await testRender(
        <UserErrorBanner error={error} title={title} />,
        { width: 80, height: 24 },
      )
    })
    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain(title)
      expect(frame).toContain(error.slice(0, 30).split('\n')[0])
      const rows = frame.split('\n')
      const y = rows.findIndex((row) => row.includes('Inspect captured error'))
      expect(y).toBeGreaterThanOrEqual(0)
      await React.act(async () =>
        setup.mockMouse.click(rows[y].indexOf('Inspect') + 2, y),
      )
      expect(useOutputReaderStore.getState().request?.document?.text).toBe(
        error,
      )
    } finally {
      useOutputReaderStore.getState().close()
      await React.act(async () => setup.renderer.destroy())
    }
  })
}
for (const error of ['', '   ']) {
  renderTest(
    `UserErrorBanner omits empty content ${JSON.stringify(error)}`,
    async () => {
      const { testRender } = await import('@opentui/react/test-utils')
      let setup!: Awaited<ReturnType<typeof testRender>>
      await React.act(async () => {
        setup = await testRender(<UserErrorBanner error={error} />, {
          width: 60,
          height: 18,
        })
      })
      try {
        await setup.renderOnce()
        expect(setup.captureCharFrame().trim()).toBe('')
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    },
  )
}
