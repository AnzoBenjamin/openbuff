import { createRequire } from 'node:module'

import { describe, expect, mock, test } from 'bun:test'
import React from 'react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { SCROLL_GLYPH } from '../scroll-to-bottom-button'
import { StatusBar } from '../status-bar'

import type { StatusIndicatorState } from '../../utils/status-indicator-state'

/**
 * Defensive re-registration: sibling test files (build-mode-buttons.test.tsx)
 * mock.module('../../hooks/use-terminal-layout') registry-wide, and bun cannot
 * unregister it — the leaked 80-wide mockLayout breaks this file's 152-wide
 * real-reconciler renders in full-suite runs. Overwrite the registration with
 * the REAL module's exports so whatever leaked is restored before rendering.
 */
const requireReal = createRequire(import.meta.url)
const requiredLayoutModule = requireReal('../../hooks/use-terminal-layout') as
  typeof import('../../hooks/use-terminal-layout')

/**
 * require() may itself resolve to the leaked mock (bun's mock registry covers
 * require too), so fall back to a cache-busting import that bypasses it. The
 * sentinel is WIDTH_MD_BREAKPOINT — a real export the mock factory does NOT
 * provide (the mock also exports computeTerminalLayout, so that would be a
 * false positive; verified by probe: require returns the 2-key mock, the
 * ?restore query import returns the full 7-key real module).
 */
const realUseTerminalLayout: typeof import('../../hooks/use-terminal-layout') =
  'WIDTH_MD_BREAKPOINT' in requiredLayoutModule
    ? requiredLayoutModule
    : ((await import(
        '../../hooks/use-terminal-layout?restore' as string
      )) as typeof import('../../hooks/use-terminal-layout'))

mock.module('../../hooks/use-terminal-layout', () => ({
  ...realUseTerminalLayout,
}))

initializeThemeStore()

/**
 * `@opentui/react/test-utils` imports `act` from react, which the production
 * build does not export, so it cannot even be imported under NODE_ENV=production
 * — which is how this package's `bun run test` script invokes bun test. Same
 * convention as text-nesting.test.tsx.
 */
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

/**
 * Dev/prod act mismatch: `bun test` resolves the dev React build (which warns
 * on any update "not wrapped in act(...)") while `@opentui/react/test-utils`
 * resolves production React, whose `act` is a throwing stub — so testRender's
 * internal act-wrapping silently no-ops and reconciler updates escape capture
 * under load. Only an explicit outer act can be trusted; this shim is safe
 * under both builds, using React's real act when available (dev) and a
 * microtask-flushing passthrough otherwise (production or a missing export).
 */
const actPassthrough = async (callback: () => Promise<void>): Promise<void> => {
  await callback()
  await Promise.resolve()
}

const act: (callback: () => Promise<void>) => Promise<void> =
  process.env.NODE_ENV === 'production'
    ? actPassthrough
    : ((React as any).act ?? actPassthrough)

// React's dev build only honors act() when this flag is set before the first
// render, so set it once at module scope.
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const renderFrame = async (node: React.ReactNode): Promise<string> => {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    setup = await testRender(
      <box style={{ flexDirection: 'column', width: 152 }}>{node}</box>,
      { width: 152, height: 40 },
    )
  })
  await act(async () => {
    await setup.renderOnce()
    await Promise.resolve()
  })
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
  sessionCostCents: 25,
  modelName: 'anthropic/claude-sonnet',
  diffStats: { modified: 2, added: 1, deleted: 0 },
}

/**
 * sessionCostCents large enough that formatCostLabel renders '$0.25' (not
 * '<$0.0001'), pinning the low-priority cost chip the selector now renders
 * beside the context chip in this scenario.
 */
const COST_LABEL = '$0.25'

describe('StatusBar through the real OpenTUI reconciler', () => {
  renderTest(
    'renders the status label, the chip cluster and the scroll control together',
    async () => {
      const frame = await renderFrame(
        <StatusBar {...baseProps} isAtBottom={false} />,
      )

      expectRendered(frame, [
        'working...',
        CONTEXT_PERCENT,
        COST_LABEL,
        SCROLL_GLYPH,
      ])
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

      expectRendered(frame, ['working...', CONTEXT_PERCENT, COST_LABEL])
      expect(frame).not.toContain(SCROLL_GLYPH)
    },
  )

  renderTest(
    'renders the capability-tier chip from the honest default capability map',
    async () => {
      // No model/cost/git props, so the low-priority static chip fits beside
      // the context chip within the width budget.
      const frame = await renderFrame(
        <StatusBar
          timerStartTime={null}
          scrollToLatest={() => {}}
          statusIndicatorState={STREAMING}
          contextWindowUsage={{ used: 48_000, max: 100_000 }}
          isAtBottom
        />,
      )

      expectRendered(frame, [CONTEXT_PERCENT, 'sandbox:lexical'])
    },
  )
})
