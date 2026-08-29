import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes } from '../../utils/theme-system'
import { ContextBox } from '../renderers/context-box'

import type { ContextContentBlock } from '../../types/chat'

initializeThemeStore()

const theme = chatThemes.dark

const makeBlock = (overrides: Partial<ContextContentBlock> = {}): ContextContentBlock => ({
  type: 'context',
  ledgerText: 'Context ledger header\nSecond header line\nToken usage: 123/456',
  gateBudgetsText: 'Gate repair budgets\nbudget: 10\nGate budgets: 5',
  ...overrides,
})

describe('ContextBox', () => {
  test('smoke renders title Context and key lines with theme tokens', () => {
    const markup = renderToStaticMarkup(<ContextBox block={makeBlock()} />)

    expect(markup).toContain('Context')
    expect(markup).toContain('Context ledger header')
    expect(markup).toContain('Gate repair budgets')
    expect(markup).toContain(theme.secondary)
  })

  test('renders ledger header with secondary and body with muted', () => {
    const markup = renderToStaticMarkup(<ContextBox block={makeBlock()} />)
    expect(markup).toContain(theme.secondary)
    expect(markup).toContain(theme.muted)
  })

  test('handles null ledgerText still renders gate', () => {
    const markup = renderToStaticMarkup(<ContextBox block={makeBlock({ ledgerText: null })} />)
    expect(markup).toContain('Context')
    expect(markup).toContain('Gate repair budgets')
    expect(markup).not.toContain('Token usage')
  })

  test('handles empty gateBudgetsText', () => {
    const markup = renderToStaticMarkup(<ContextBox block={makeBlock({ gateBudgetsText: '' })} />)
    expect(markup).toContain('Context')
    expect(markup).toContain('Context ledger header')
  })

  test('handles empty ledger lines boundary', () => {
    const markup = renderToStaticMarkup(
      <ContextBox block={makeBlock({ ledgerText: '\n\n', gateBudgetsText: '\n' })} />,
    )
    expect(markup).toContain('Context')
  })
})
