import { afterAll, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes } from '../../utils/theme-system'
import type { TerminalLayout } from '../../hooks/use-terminal-layout'

// Capture the real module before registering the mock. A plain specifier may
// resolve through bun's registry to a previously leaked mock; the `?real`
// query bypasses the registry and returns the genuine module.
const realLayoutModule = (await import(
  /* bun resolves the query suffix to a fresh real-module instance at runtime
     (bypassing any leaked mock registration); TS cannot type a query-suffixed
     specifier, hence the cast. */
  '../../hooks/use-terminal-layout?real' as string
)) as unknown as typeof import('../../hooks/use-terminal-layout')

const { computeTerminalLayout } = realLayoutModule

// Allow per-test override of the terminal layout; when unset, fall through to
// the real hook. The mock is registry-wide for the process, so once this suite
// ends mockLayout returns to undefined and any later file in the same process
// gets the real hook's behavior — this fixes the leak at its source.
let mockLayout: TerminalLayout | undefined

mock.module('../../hooks/use-terminal-layout', () => ({
  ...realLayoutModule,
  useTerminalLayout: () => mockLayout ?? realLayoutModule.useTerminalLayout(),
}))

const { BuildModeButtons } = await import('../build-mode-buttons')

initializeThemeStore()

const theme = chatThemes.dark

describe('BuildModeButtons', () => {
  test('renders the prompt text and Execute Plan button on normal width', () => {
    mockLayout = computeTerminalLayout(80, 24)
    const markup = renderToStaticMarkup(
      <BuildModeButtons theme={theme} onBuildFast={() => {}} />,
    )

    expect(markup).toContain('Choose an option to build this plan:')
    expect(markup).toContain('Execute Plan')
  })

  test('omits the prompt text on narrow (xs) width', () => {
    // Width < 50 maps to xs
    mockLayout = computeTerminalLayout(40, 24)
    const markup = renderToStaticMarkup(
      <BuildModeButtons theme={theme} onBuildFast={() => {}} />,
    )

    expect(markup).not.toContain('Choose an option to build this plan:')
    // The button itself should still render
    expect(markup).toContain('Execute Plan')
  })

  test('always renders the Execute Plan button regardless of width', () => {
    mockLayout = computeTerminalLayout(30, 10)
    const markup = renderToStaticMarkup(
      <BuildModeButtons theme={theme} onBuildFast={() => {}} />,
    )

    expect(markup).toContain('Execute Plan')
  })

  // Fall through to the real hook: the registry-wide mock survives this
  // file, so a stale layout must never leak to sibling files.
  afterAll(() => {
    mockLayout = undefined
  })
})
