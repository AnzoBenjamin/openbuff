import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { MarkdownPalette } from '../../../utils/markdown-renderer'

// The component under test is imported (below) only after these mocks
// register, so its native-markdown collaborators resolve to the doubles
// configured per test. The legacy remark renderer no longer exists after D47
// Stage 2, so only the two live collaborators are mocked.
// bun's mock.module is registry-wide for the whole test process (afterAll
// mock.restore does not undo it), so capture the REAL modules first and
// spread their exports so nothing is dropped for later files. The `?real`
// query bypasses the registry so a previously leaked mock cannot shadow
// the real module.
const realSyntaxStyleModule = (await import(
  '../../../utils/opentui-syntax-style?real' as string
)) as unknown as typeof import('../../../utils/opentui-syntax-style')

const realTreeSitterModule = (await import(
  '../../../utils/tree-sitter-client?real' as string
)) as unknown as typeof import('../../../utils/tree-sitter-client')

const createMarkdownSyntaxStyleCalls: MarkdownPalette[] = []
let getSharedTreeSitterClientCalls = 0
let syntaxStyleSetupError: Error | null = null
let treeSitterClientSetupError: Error | null = null

// Armed at module scope (every native-markdown render needs the stub); the
// top-level afterAll below disarms it so the registry-wide override
// delegates to the real module for later files in the same worker.
// realSyntaxStyleModule is a `?real` query import — a separate module object
// this registry-wide mock cannot patch — so the delegation cannot re-enter
// the override.
let syntaxStyleArmed = true

mock.module('../../../utils/opentui-syntax-style', () => ({
  // Real exports first (registry-wide leak guard); the counting stub below
  // must keep winning while armed.
  ...realSyntaxStyleModule,
  createMarkdownSyntaxStyle: (palette: MarkdownPalette) => {
    if (!syntaxStyleArmed) {
      return realSyntaxStyleModule.createMarkdownSyntaxStyle(palette)
    }
    createMarkdownSyntaxStyleCalls.push(palette)
    if (syntaxStyleSetupError) {
      throw syntaxStyleSetupError
    }
    // String markers so the doubles' outputs are observable as native
    // element attributes in the static markup below.
    return '__stub-syntax-style__'
  },
}))

// Armed at module scope (every native-markdown render needs the stub); the
// top-level afterAll below disarms it so the registry-wide override
// delegates to the real module for later files in the same worker. bun's
// --isolate REUSES worker processes across test files, so an unconditional
// stub leaked '__stub-tree-sitter-client__' into tree-sitter-client.test.ts's
// null assertions in CI.
let treeSitterArmed = true

mock.module('../../../utils/tree-sitter-client', () => ({
  // Real exports first (registry-wide leak guard); the counting stub below
  // must keep winning while armed.
  ...realTreeSitterModule,
  getSharedTreeSitterClient: () => {
    if (!treeSitterArmed) {
      return realTreeSitterModule.getSharedTreeSitterClient()
    }
    getSharedTreeSitterClientCalls += 1
    if (treeSitterClientSetupError) {
      throw treeSitterClientSetupError
    }
    return '__stub-tree-sitter-client__'
  },
}))

afterAll(() => {
  treeSitterArmed = false
  syntaxStyleArmed = false
})

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
