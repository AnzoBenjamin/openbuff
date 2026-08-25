import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes } from '../../utils/theme-system'
import { IndexStatusBox } from '../renderers/index-status-box'

import type { IndexStatusContentBlock } from '../../types/chat'

initializeThemeStore()

const theme = chatThemes.dark

const makeBlock = (overrides: Partial<IndexStatusContentBlock> = {}): IndexStatusContentBlock => ({
  type: 'index-status',
  statusLine: 'Index status: ready.',
  messageLine: 'Index ready.',
  corpusLine: '42 indexed files.',
  ageLine: '1m',
  vectorLine: 'ready',
  hintLine: 'Use /index explain <query> to inspect ranking provenance.',
  coverageLine: undefined,
  diagnosticsLines: undefined,
  lines: [
    'Index status: ready.',
    'Index ready.',
    'Corpus: 42 indexed files.',
    'Age: 1m.',
    'Vector embeddings: ready.',
    'Use /index explain <query> to inspect ranking provenance.',
  ],
  ...overrides,
})

describe('IndexStatusBox', () => {
  test('smoke renders derived title and key lines with theme tokens', () => {
    const markup = renderToStaticMarkup(<IndexStatusBox block={makeBlock()} />)
    expect(markup).toContain('Index status: ready')
    expect(markup).toContain('Corpus:')
    expect(markup).toContain('42 indexed files.')
    expect(markup).toContain('Age:')
    expect(markup).toContain('1m')
    expect(markup).toContain('Vector:')
    expect(markup).toContain('ready')
    expect(markup).toContain(theme.secondary)
  })

  test('renders hintLine with muted and foreground tokens', () => {
    const markup = renderToStaticMarkup(<IndexStatusBox block={makeBlock()} />)
    expect(markup).toContain('Use /index explain')
    expect(markup).toContain(theme.muted)
    expect(markup).toContain(theme.foreground)
  })

  test('renders coverageLine with warning color', () => {
    const markup = renderToStaticMarkup(
      <IndexStatusBox block={makeBlock({ coverageLine: 'Coverage: partial at 100 files; skipped 5 under vendor.' })} />,
    )
    expect(markup).toContain('Coverage: partial')
    expect(markup).toContain(theme.warning)
  })

  test('renders diagnosticsLines with header and muted lines', () => {
    const markup = renderToStaticMarkup(
      <IndexStatusBox
        block={makeBlock({ diagnosticsLines: ['Diagnostics: 2 parser issues.', '- src/bad.ts (parse): syntax error'] })}
      />,
    )
    expect(markup).toContain('Diagnostics (2)')
    expect(markup).toContain('src/bad.ts')
    expect(markup).toContain(theme.secondary)
    expect(markup).toContain(theme.muted)
  })

  test('handles disabled statusLine and empty optional lines', () => {
    const markup = renderToStaticMarkup(
      <IndexStatusBox
        block={makeBlock({
          statusLine: 'Index status: disabled in openbuff.json.',
          messageLine: 'Use read_subtree, glob, or code_search for live discovery.',
          corpusLine: '',
          ageLine: '',
          vectorLine: '',
          hintLine: '',
          coverageLine: undefined,
          diagnosticsLines: undefined,
        })}
      />,
    )
    expect(markup).toContain('Index status: disabled in openbuff.json')
    expect(markup).toContain('Use read_subtree')
    expect(markup).not.toContain('Corpus:')
    expect(markup).not.toContain('Age:')
    expect(markup).not.toContain('Vector:')
  })

  test('deriveTitle handles empty statusLine fallback', () => {
    const markup = renderToStaticMarkup(<IndexStatusBox block={makeBlock({ statusLine: '' })} />)
    expect(markup).toContain('Index status')
  })

  test('omits hint/coverage/diagnostics when absent', () => {
    const markup = renderToStaticMarkup(
      <IndexStatusBox block={makeBlock({ hintLine: '', coverageLine: undefined, diagnosticsLines: [] })} />,
    )
    expect(markup).toContain('Index status: ready')
    expect(markup).not.toContain('Coverage: partial')
    expect(markup).not.toContain('Diagnostics (')
  })
})
