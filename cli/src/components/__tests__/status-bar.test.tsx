import { describe, expect, test } from 'bun:test'
import React from 'react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { SCROLL_GLYPH } from '../scroll-to-bottom-button'
import { StatusBar } from '../status-bar'

import type { StatusIndicatorState } from '../../utils/status-indicator-state'

initializeThemeStore()

/**
 * `@opentui/react/test-utils` imports `act` from react, which the production
 * build does not export, so it cannot even be imported under NODE_ENV=production
 * — which is how this package's `bun run test` script invokes bun test. Same
 * convention as text-nesting.test.tsx.
 */
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

const renderFrame = async (node: React.ReactNode): Promise<string> => {
  const { testRender } = await import('@opentui/react/test-utils')
  const setup = await testRender(
    <box style={{ flexDirection: 'column', width: 100 }}>{node}</box>,
    { width: 100, height: 40 },
  )
  await setup.renderOnce()
  const frame: string = setup.captureCharFrame()
  setup.renderer.destroy()
  return frame
}

/**
 * Asserts the renderer survived commit (see text-nesting.test.tsx: an OpenTUI
 * nesting throw replaces the frame with the root error boundary's fallback) and
 * that every expected substring made it into the frame.
 */
const expectRendered = (frame: string, expectedContent: string[]) => {
  expect(frame).not.toContain('TextNodeRenderable')
  for (const content of expectedContent) expect(frame).toContain(content)
}

/** The status bar is a single row, so ordering is compared within one line. */
const rowContaining = (frame: string, needle: string): string => {
  const row = frame.split('\n').find((line) => line.includes(needle))
  expect(row).toBeDefined()
  return row ?? ''
}

const STREAMING: StatusIndicatorState = {
  kind: 'streaming',
  phaseLabel: 'working...',
}

/**
 * The context chip's percent survives every width the harness might report:
 * 'ctx 48%', '<bar> 48%' and the bare '48%' overflow fallback all contain it,
 * and it is the highest-priority chip, so it is the one chip label that is safe
 * to assert without controlling the rendered width.
 */
const CONTEXT_PERCENT = '48%'

/**
 * `timerStartTime` is null on purpose: a live elapsed timer would add a chip
 * whose label changes with wall-clock time, and the timer itself is covered by
 * utils/__tests__/status-bar-chips.test.ts.
 */
const baseProps = {
  timerStartTime: null,
  scrollToLatest: () => {},
  statusIndicatorState: STREAMING,
  contextWindowUsage: { used: 48_000, max: 100_000 },
  modelName: 'anthropic/claude-sonnet',
  diffStats: { modified: 2, added: 1, deleted: 0 },
}

describe('StatusBar through the real OpenTUI reconciler', () => {
  renderTest(
    'renders the status label, the chip cluster and the scroll control together',
    async () => {
      const frame = await renderFrame(
        <StatusBar {...baseProps} isAtBottom={false} />,
      )

      expectRendered(frame, ['working...', CONTEXT_PERCENT, SCROLL_GLYPH])
    },
  )

  renderTest(
    'renders the stop hint to the right of the chips while a run is active',
    async () => {
      const frame = await renderFrame(
        <StatusBar {...baseProps} isAtBottom={false} onStop={() => {}} />,
      )

      expectRendered(frame, [CONTEXT_PERCENT, SCROLL_GLYPH, '■ Esc'])

      // Both controls live in the right-hand region, so they share the chips'
      // row; compare offsets inside that one row rather than across the
      // newline-joined frame.
      const row = rowContaining(frame, '■ Esc')
      expect(row).toContain(CONTEXT_PERCENT)
      expect(row.indexOf(CONTEXT_PERCENT)).toBeLessThan(row.indexOf('■ Esc'))
      expect(row.indexOf(SCROLL_GLYPH)).toBeLessThan(row.indexOf('■ Esc'))
    },
  )

  renderTest(
    'hides the scroll control at the bottom, keeping the chips',
    async () => {
      const frame = await renderFrame(<StatusBar {...baseProps} isAtBottom />)

      expectRendered(frame, ['working...', CONTEXT_PERCENT])
      expect(frame).not.toContain(SCROLL_GLYPH)
    },
  )
})
