import { beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import * as realMarkdownRenderer from '../../../utils/markdown-renderer'

import type { MarkdownPalette } from '../../../utils/markdown-renderer'

// The component under test is imported (below) only after these mocks
// register, so its native-markdown collaborators and the legacy renderer
// resolve to the doubles configured per test.
const createMarkdownSyntaxStyleCalls: MarkdownPalette[] = []
let getSharedTreeSitterClientCalls = 0
const renderMarkdownCalls: string[] = []
const renderStreamingMarkdownCalls: string[] = []
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

mock.module('../../../utils/markdown-renderer', () => ({
  ...realMarkdownRenderer,
  renderMarkdown: (content: string) => {
    renderMarkdownCalls.push(content)
    return `legacy-static:${content}`
  },
  renderStreamingMarkdown: (content: string) => {
    renderStreamingMarkdownCalls.push(content)
    return `legacy-streaming:${content}`
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
    renderMarkdownCalls.length = 0
    renderStreamingMarkdownCalls.length = 0
    syntaxStyleSetupError = null
    treeSitterClientSetupError = null
  })

  test('renders markdown content through the native <markdown> branch', () => {
    const markup = renderContent('# Hello *world*')

    // The native renderable is selected with our syntax style and shared
    // tree-sitter client wired in, and the legacy renderer is not used.
    expect(markup).toContain('<markdown')
    expect(markup).toContain('Hello *world*')
    expect(markup).toContain('__stub-syntax-style__')
    expect(markup).toContain('__stub-tree-sitter-client__')
    expect(createMarkdownSyntaxStyleCalls).toHaveLength(1)
    expect(getSharedTreeSitterClientCalls).toBe(1)
    expect(renderMarkdownCalls).toHaveLength(0)
    expect(renderStreamingMarkdownCalls).toHaveLength(0)
  })

  test('falls back to the legacy renderer when syntax style setup throws', () => {
    syntaxStyleSetupError = new Error('syntax style setup failed')

    const markup = renderContent('**bold** fallback')

    expect(markup).toContain('legacy-static:**bold** fallback')
    expect(renderMarkdownCalls).toEqual(['**bold** fallback'])
    expect(createMarkdownSyntaxStyleCalls).toHaveLength(1)
    expect(getSharedTreeSitterClientCalls).toBe(0)
    expect(renderStreamingMarkdownCalls).toHaveLength(0)
  })

  test('falls back to the legacy renderer when tree-sitter client setup throws', () => {
    treeSitterClientSetupError = new Error('tree-sitter client setup failed')

    const markup = renderContent('`code` fallback')

    expect(markup).toContain('legacy-static:`code` fallback')
    expect(renderMarkdownCalls).toEqual(['`code` fallback'])
    expect(createMarkdownSyntaxStyleCalls).toHaveLength(1)
    expect(getSharedTreeSitterClientCalls).toBe(1)
    expect(renderStreamingMarkdownCalls).toHaveLength(0)
  })

  test('streaming content falls back to the legacy streaming renderer', () => {
    syntaxStyleSetupError = new Error('syntax style setup failed')

    const markup = renderContent('# streaming fallback', true)

    expect(markup).toContain('legacy-streaming:# streaming fallback')
    expect(renderStreamingMarkdownCalls).toEqual(['# streaming fallback'])
    expect(renderMarkdownCalls).toHaveLength(0)
  })
})
