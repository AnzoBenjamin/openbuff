import { beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import * as realSyntaxStyleModule from '../../../utils/opentui-syntax-style'
import * as realTreeSitterClientModule from '../../../utils/tree-sitter-client'

import type { MarkdownPalette } from '../../../utils/markdown-renderer'

// The component under test is imported (below) only after these mocks
// register, so its native-<code> collaborators resolve to the doubles
// configured per test (same mock.module-before-dynamic-import pattern as
// content-with-markdown.test.tsx). The real modules are spread into each
// factory so sibling exports (createMarkdownSyntaxStyle,
// buildDefaultParsers) stay intact for other test files in the same bun
// process, mirroring the spread pattern in
// utils/__tests__/tree-sitter-client.test.ts.
const createCodeSyntaxStyleCalls: MarkdownPalette[] = []
let getSharedTreeSitterClientCalls = 0
let syntaxStyleSetupError: Error | null = null
let treeSitterClientSetupError: Error | null = null

mock.module('../../../utils/opentui-syntax-style', () => ({
  ...realSyntaxStyleModule,
  createCodeSyntaxStyle: (palette: MarkdownPalette) => {
    createCodeSyntaxStyleCalls.push(palette)
    if (syntaxStyleSetupError) {
      throw syntaxStyleSetupError
    }
    // String markers so the doubles' outputs are observable as native
    // element attributes in the static markup below.
    return '__stub-syntax-style__'
  },
}))

mock.module('../../../utils/tree-sitter-client', () => ({
  ...realTreeSitterClientModule,
  getSharedTreeSitterClient: () => {
    getSharedTreeSitterClientCalls += 1
    if (treeSitterClientSetupError) {
      throw treeSitterClientSetupError
    }
    return '__stub-tree-sitter-client__'
  },
}))

const { CodeBlock, resolveCodeFiletype } = await import('../code-block')

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

const renderCode = (content: string, filetype?: string): string =>
  renderToStaticMarkup(
    <CodeBlock
      content={content}
      filetype={filetype}
      palette={makePalette()}
      availableWidth={80}
    />,
  )

describe('CodeBlock', () => {
  beforeEach(() => {
    createCodeSyntaxStyleCalls.length = 0
    getSharedTreeSitterClientCalls = 0
    syntaxStyleSetupError = null
    treeSitterClientSetupError = null
  })

  test('renders code through the native <code> branch with a ts filetype', () => {
    const markup = renderCode('const x = 1', 'ts')

    // The native renderable is selected with our syntax style and shared
    // tree-sitter client wired in; the "ts" fence tag resolves to the
    // registered "typescript" filetype.
    expect(markup).toContain('<code')
    expect(markup).toContain('const x = 1')
    expect(markup).toContain('filetype="typescript"')
    expect(markup).toContain('__stub-syntax-style__')
    expect(markup).toContain('__stub-tree-sitter-client__')
    // The code background/code text palette fields ride on the renderable's
    // fg/bg (TextBufferOptions), not on syntax style entries.
    expect(markup).toContain('bg="#1e1e2e"')
    expect(markup).toContain('fg="#cdd6f4"')
    expect(createCodeSyntaxStyleCalls).toHaveLength(1)
    expect(getSharedTreeSitterClientCalls).toBe(1)
  })

  test('degrades to plain text when syntax style setup throws', () => {
    syntaxStyleSetupError = new Error('syntax style setup failed')

    const markup = renderCode('const x = 1', 'ts')

    // Plain-text degradation: the raw content reaches the output and no
    // native code element is rendered.
    expect(markup).toContain('const x = 1')
    expect(markup).not.toContain('<code')
    expect(createCodeSyntaxStyleCalls).toHaveLength(1)
    expect(getSharedTreeSitterClientCalls).toBe(0)
  })

  test('degrades to plain text when tree-sitter client setup throws', () => {
    treeSitterClientSetupError = new Error('tree-sitter client setup failed')

    const markup = renderCode('const x = 1', 'ts')

    expect(markup).toContain('const x = 1')
    expect(markup).not.toContain('<code')
    expect(createCodeSyntaxStyleCalls).toHaveLength(1)
    expect(getSharedTreeSitterClientCalls).toBe(1)
  })

  test('omits filetype entirely for unrecognized languages', () => {
    const markup = renderCode('print("hi")', 'ruby')

    expect(markup).toContain('<code')
    expect(markup).not.toContain('filetype=')
  })
})

describe('resolveCodeFiletype', () => {
  test('maps fence tags and extensions onto registered filetypes', () => {
    expect(resolveCodeFiletype('ts')).toBe('typescript')
    expect(resolveCodeFiletype('typescript')).toBe('typescript')
    expect(resolveCodeFiletype('tsx')).toBe('typescriptreact')
    expect(resolveCodeFiletype('js')).toBe('javascript')
    expect(resolveCodeFiletype('jsx')).toBe('javascriptreact')
    expect(resolveCodeFiletype('.md')).toBe('markdown')
  })

  test('returns undefined for unknown, blank, or missing languages', () => {
    expect(resolveCodeFiletype('ruby')).toBeUndefined()
    expect(resolveCodeFiletype('')).toBeUndefined()
    expect(resolveCodeFiletype()).toBeUndefined()
  })
})
