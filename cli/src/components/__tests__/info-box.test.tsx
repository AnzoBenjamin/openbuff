import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes } from '../../utils/theme-system'
import { InfoBox } from '../renderers/info-box'

import type { InfoContentBlock } from '../../types/chat'

initializeThemeStore()

const theme = chatThemes.dark

const makeBlock = (overrides: Partial<InfoContentBlock> = {}): InfoContentBlock => ({
  type: 'info',
  version: '1.2.3',
  workspace: '/tmp/workspace',
  ...overrides,
})

describe('InfoBox', () => {
  test('smoke renders title CLI Diagnostic Info and key lines with theme tokens', () => {
    const markup = renderToStaticMarkup(<InfoBox block={makeBlock()} />)

    expect(markup).toContain('CLI Diagnostic Info')
    expect(markup).toContain('Version:')
    expect(markup).toContain('1.2.3')
    expect(markup).toContain('Workspace:')
    expect(markup).toContain('/tmp/workspace')
    expect(markup).toContain('Auth:')
    expect(markup).toContain('Local/BYOK Mode')
    expect(markup).toContain(theme.secondary)
    expect(markup).toContain(theme.foreground)
  })

  test('renders version and workspace empty values still shows labels', () => {
    const markup = renderToStaticMarkup(<InfoBox block={makeBlock({ version: '', workspace: '' })} />)
    expect(markup).toContain('CLI Diagnostic Info')
    expect(markup).toContain('Version:')
    expect(markup).toContain('Workspace:')
  })

  test('uses secondary for labels and foreground for values', () => {
    const markup = renderToStaticMarkup(<InfoBox block={makeBlock()} />)
    expect(markup).toContain(theme.secondary)
    expect(markup).toContain(theme.foreground)
  })
})
