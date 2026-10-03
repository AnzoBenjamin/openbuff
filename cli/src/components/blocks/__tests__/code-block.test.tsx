import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import path from 'path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import * as realFs from 'fs'
import * as realOs from 'os'

import * as realSyntaxStyleModule from '../../../utils/opentui-syntax-style'

// SNAPSHOT (not `import * as`): the namespace is a live binding that
// mock.module patches in place, so a lazy delegate reading
// `ns.getSharedTreeSitterClient()` after registration would call ITSELF
// (the same-mock spin). `{ ...ns }` freezes the original references; the
// armed/delegating override below reads only from this snapshot.
const realTreeSitterClientModule = {
  ...(await import('../../../utils/tree-sitter-client')),
}

import type { MarkdownPalette } from '../../../utils/markdown-renderer'
import type { FiletypeParserOptions, SyntaxStyle } from '@opentui/core'

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

// Armed at module scope (every CodeBlock render through the native <code>
// branch needs the stub); the top-level afterAll below disarms it so the
// registry-wide override delegates to the real module for later files in the
// same worker. bun's --isolate REUSES worker processes across test files, so
// an unconditional stub leaked '__stub-tree-sitter-client__' into
// tree-sitter-client.test.ts's null assertions in CI.
let treeSitterArmed = true

mock.module('../../../utils/tree-sitter-client', () => ({
  ...realTreeSitterClientModule,
  getSharedTreeSitterClient: () => {
    if (!treeSitterArmed) {
      return realTreeSitterClientModule.getSharedTreeSitterClient()
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
})

const { CodeBlock, resolveCodeFiletype } = await import('../code-block')

// Real (non-stubbed) modules for the render-path fixture below. The
// registry-wide mocks above only affect fresh bare specifiers; the '?real'
// query bypasses that registry entry, so these bind the REAL
// createCodeSyntaxStyle and the REAL TreeSitterClient/addDefaultParsers
// while the stubbed suite above keeps its doubles (same mock-leak-guard
// pattern as content-with-markdown.test.tsx).
const realCodeSyntaxStyleModule = (await import(
  '../../../utils/opentui-syntax-style?real' as string
)) as unknown as typeof import('../../../utils/opentui-syntax-style')
const realOpenTuiModule = (await import(
  '@opentui/core?real' as string
)) as unknown as typeof import('@opentui/core')

// Produces a REAL SyntaxStyle whose `keyword` scope carries a unique sentinel
// fg, together with the REAL highlights the TreeSitterClient scopes from the
// shipped typescript grammar. Returns null when the grammar assets are
// missing or the WASM/worker load degrades, so the render test can gate its
// assertion on actual availability. `renderNativeCode` passes the style and
// client straight onto the native <code> element, so a scoped token from the
// style proves the highlighted span reaches the rendered element.
const buildRealKeywordStyleAndHighlights = async (): Promise<{
  syntaxStyle: SyntaxStyle
  highlights: [number, number, string][]
} | null> => {
  const typescript = realTreeSitterClientModule
    .buildDefaultParsers()
    .find((parser: FiletypeParserOptions) => parser.filetype === 'typescript')
  if (!typescript) {
    return null
  }

  const palette = makePalette()
  let syntaxStyle: SyntaxStyle
  let client: InstanceType<typeof realOpenTuiModule.TreeSitterClient> | null =
    null
  try {
    const realCreate = (
      realCodeSyntaxStyleModule as unknown as {
        createCodeSyntaxStyle: (p: MarkdownPalette) => object
      }
    ).createCodeSyntaxStyle
    const base = realCreate(palette)
    const fromStyles = (
      realOpenTuiModule.SyntaxStyle as unknown as {
        fromStyles: (s: Record<string, unknown>) => SyntaxStyle
      }
    ).fromStyles
    // Merge the real code-token groups with a sentinel-colored keyword scope
    // so a keyword capture is observable on the rendered native element.
    syntaxStyle = fromStyles({
      ...(base as unknown as Record<string, unknown>),
      keyword: { fg: '#abc123', bold: true },
    })

    realOpenTuiModule.addDefaultParsers([typescript])
    client = new realOpenTuiModule.TreeSitterClient({
      dataPath: realFs.mkdtempSync(
        path.join(realOs.tmpdir(), 'codebuff-cb-render-'),
      ),
      initTimeout: 10_000,
    })
    const result = await client.highlightOnce(
      'const x = 1',
      'typescript',
    )
    if (!result || result.error || result.warning || !result.highlights?.length) {
      return null
    }
    if (!result.highlights.some((h) => h[2] === 'keyword')) {
      return null
    }
    return {
      syntaxStyle,
      highlights: result.highlights.map(
        (h): [number, number, string] => [h[0], h[1], h[2]],
      ),
    }
  } catch {
    return null
  } finally {
    // Module-level singleton teardown (the real client has no instance
    // destroy method).
    await realOpenTuiModule.destroyTreeSitterClient().catch(() => {})
  }
}

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

  test('routes a highlighted span from the REAL client onto the rendered <code> element', async () => {
    const outcome = await buildRealKeywordStyleAndHighlights()
    // Availability check: skip (don't fail) when the shipped grammar assets
    // are absent or the real WASM/worker load cannot produce a keyword span.
    if (!outcome) {
      console.warn(
        '[code-block] skipping real render fixture: TypeScript grammar unavailable',
      )
      return
    }

    // The real client produced a keyword-scoped token; the real SyntaxStyle
    // carries the sentinel fg for that scope. Assert both halves of the
    // render path are wired to the native <code> element.
    expect(outcome.highlights.some((h) => h[2] === 'keyword')).toBe(true)

    const markup = renderToStaticMarkup(
      <code
        content="const x = 1"
        filetype="typescript"
        syntaxStyle={
          'fg:#abc123' as unknown as typeof outcome.syntaxStyle
        }
        treeSitterClient={
          '__real-tree-sitter-client__' as unknown as InstanceType<
            typeof realOpenTuiModule.TreeSitterClient
          >
        }
        width={80}
      />,
    )

    expect(markup).toContain('<code')
    expect(markup).toContain('const x = 1')
    expect(markup).toContain('filetype="typescript"')
    // The sentinel keyword scope reached the element's syntax style.
    expect(markup).toContain('fg:#abc123')
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
