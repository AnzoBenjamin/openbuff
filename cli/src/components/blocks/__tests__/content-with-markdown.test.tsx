import { beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { MarkdownPalette } from '../../../utils/markdown-renderer'

// The component under test is imported (below) only after these mocks
// register, so its native-markdown collaborators resolve to the doubles
// configured per test. The legacy remark renderer no longer exists after D47
// Stage 2, so only the two live collaborators are mocked.
const createMarkdownSyntaxStyleCalls: MarkdownPalette[] = []
let getSharedTreeSitterClientCalls = 0
let syntaxStyleSetupError: Error | null = null
let treeSitterClientSetupError: Error | null = null

mock.module('../../../utils/opentui-syntax-style', () => ({
  createMarkdownSyntaxStyle: (palette: MarkdownPalette) => {
    createMarkdownSyntaxStyleCalls.push(palette)
    if (syntaxStyleSetupError) {
      throw syntaxStyleSetupError
    }
    // String markers so the doubles' outputs are observable as native
    // element attributes in the static markup below.
    return '__stub-syntax-style__'
  },
}))

mock.module('../../../utils/tree-sitter-client', () => ({
  getSharedTreeSitterClient: () => {
    getSharedTreeSitterClientCalls += 1
    if (treeSitterClientSetupError) {
      throw treeSitterClientSetupError
    }
    return '__stub-tree-sitter-client__'
  },
}))

const { ContentWithMarkdown } = await import('../content-with-markdown')

const makePalette = (): MarkdownPalette => ({
  inlineCodeFg: '#a8a8ff',
  codeBackground: '#1e1e2e',
  codeHeaderFg: '#c0c0ff',
  headingFg: {
    1: '#ffffff',
    2: '#f0f0f0',
    3: '#e0e0e0',
    4: '#d0d0d0',
    5: '#c0c0c0',
    6: '#b0b0b0',
  },
  listBulletFg: '#89dceb',
  blockquoteBorderFg: '#5b5b7a',
  blockquoteTextFg: '#cdd6f4',
  dividerFg: '#45475a',
  codeTextFg: '#cdd6f4',
  codeMonochrome: false,
  linkFg: '#89b4fa',
})

const renderContent = (content: string, isStreaming = false): string =>
  renderToStaticMarkup(
    <ContentWithMarkdown
      content={content}
      isStreaming={isStreaming}
      codeBlockWidth={80}
      palette={makePalette()}
    />,
  )

describe('ContentWithMarkdown', () => {
  beforeEach(() => {
    createMarkdownSyntaxStyleCalls.length = 0
    getSharedTreeSitterClientCalls = 0
    syntaxStyleSetupError = null
    treeSitterClientSetupError = null
  })

  test('renders markdown content through the native <markdown> branch', () => {
    const markup = renderContent('# Hello *world*')

    // The native renderable is selected with our syntax style and shared
    // tree-sitter client wired in.
    expect(markup).toContain('<markdown')
    expect(markup).toContain('Hello *world*')
    expect(markup).toContain('__stub-syntax-style__')
    expect(markup).toContain('__stub-tree-sitter-client__')
    expect(createMarkdownSyntaxStyleCalls).toHaveLength(1)
    expect(getSharedTreeSitterClientCalls).toBe(1)
  })

  test('degrades to wrapped plain text when syntax style setup throws', () => {
    syntaxStyleSetupError = new Error('syntax style setup failed')

    const markup = renderContent('**bold** fallback')

    // Plain-text degradation: the raw content reaches the wrapped output and
    // no native markdown element is rendered.
    expect(markup).toContain('**bold** fallback')
    expect(markup).not.toContain('<markdown')
    expect(createMarkdownSyntaxStyleCalls).toHaveLength(1)
    expect(getSharedTreeSitterClientCalls).toBe(0)
  })

  test('degrades to wrapped plain text when tree-sitter client setup throws', () => {
    treeSitterClientSetupError = new Error('tree-sitter client setup failed')

    const markup = renderContent('`code` fallback')

    expect(markup).toContain('`code` fallback')
    expect(markup).not.toContain('<markdown')
    expect(createMarkdownSyntaxStyleCalls).toHaveLength(1)
    expect(getSharedTreeSitterClientCalls).toBe(1)
  })

  test('streaming markdown content degrades to wrapped plain text', () => {
    syntaxStyleSetupError = new Error('syntax style setup failed')

    const markup = renderContent('# streaming fallback', true)

    expect(markup).toContain('# streaming fallback')
    expect(markup).not.toContain('<markdown')
  })
})
