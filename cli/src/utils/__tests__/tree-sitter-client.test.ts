import { beforeEach, describe, expect, mock, test } from 'bun:test'
import path from 'path'

import * as realFs from 'fs'
import * as realOpenTuiCore from '@opentui/core'

import type { FiletypeParserOptions } from '@opentui/core'

// Doubles for the @opentui/core tree-sitter surface used by
// ../tree-sitter-client. The stub client never spawns a worker; it either
// records construction or throws on demand.
const addDefaultParsersCalls: FiletypeParserOptions[][] = []
let constructedClientCount = 0
let clientConstructorError: Error | null = null

mock.module('@opentui/core', () => ({
  ...realOpenTuiCore,
  TreeSitterClient: class StubTreeSitterClient {
    constructor(_options: unknown) {
      if (clientConstructorError) {
        throw clientConstructorError
      }
      constructedClientCount += 1
    }
  },
  addDefaultParsers: (parsers: FiletypeParserOptions[]) => {
    addDefaultParsersCalls.push(parsers)
  },
}))

// Hide one descriptor's wasm/highlights assets (markdown_inline) behind a
// filtered existsSync double so the asset-existence filter has a skip to
// exercise; every other path stays on the real filesystem.
const realExistsSync = realFs.existsSync
const fsMock = () => ({
  ...realFs,
  existsSync: (candidate: Parameters<typeof realExistsSync>[0]): boolean =>
    typeof candidate === 'string' && candidate.includes('markdown_inline')
      ? false
      : realExistsSync(candidate),
})
mock.module('fs', fsMock)
mock.module('node:fs', fsMock)

// Imported after the mocks register so the module under test binds to them.
const { buildDefaultParsers, getSharedTreeSitterClient } = await import(
  '../tree-sitter-client'
)

describe('getSharedTreeSitterClient', () => {
  beforeEach(() => {
    addDefaultParsersCalls.length = 0
    constructedClientCount = 0
    clientConstructorError = null
  })

  test('skips parsers whose wasm/highlights assets are missing', () => {
    // Registration runs before client construction inside the first call, so
    // the captured addDefaultParsers payload exercises buildDefaultParsers
    // even though the stub constructor then fails (see the next test).
    clientConstructorError = new Error('simulated TreeSitterClient failure')

    expect(getSharedTreeSitterClient()).toBeNull()

    expect(addDefaultParsersCalls).toHaveLength(1)
    const registered = addDefaultParsersCalls[0] ?? []
    // markdown_inline is filtered out because its assets are hidden by the
    // fs double above.
    expect(registered.map((parser) => parser.filetype)).toEqual([
      'javascript',
      'typescript',
      'markdown',
    ])

    const javascript = registered.find(
      (parser) => parser.filetype === 'javascript',
    )
    expect(javascript?.aliases).toEqual(['javascriptreact'])
    expect(path.isAbsolute(javascript?.wasm ?? '')).toBe(true)

    const typescript = registered.find(
      (parser) => parser.filetype === 'typescript',
    )
    expect(typescript?.aliases).toEqual(['typescriptreact'])

    const markdown = registered.find(
      (parser) => parser.filetype === 'markdown',
    )
    expect(markdown?.injectionMapping).toEqual({
      nodeTypes: {
        inline: 'markdown_inline',
        pipe_table_cell: 'markdown_inline',
      },
      infoStringMap: {
        javascript: 'javascript',
        js: 'javascript',
        jsx: 'javascriptreact',
        javascriptreact: 'javascriptreact',
        typescript: 'typescript',
        ts: 'typescript',
        tsx: 'typescriptreact',
        typescriptreact: 'typescriptreact',
        markdown: 'markdown',
        md: 'markdown',
      },
    })
    const markdownHighlights = markdown?.queries?.highlights ?? []
    expect(markdownHighlights.every((query) => path.isAbsolute(query))).toBe(
      true,
    )
    expect(markdownHighlights.every((query) => realExistsSync(query))).toBe(
      true,
    )
    expect(path.isAbsolute(markdown?.wasm ?? '')).toBe(true)
  })

  test('caches a client-creation failure and keeps returning null', () => {
    // The previous test's call already failed client creation; the cached
    // failure must short-circuit without re-registering parsers or
    // attempting a second construction.
    expect(getSharedTreeSitterClient()).toBeNull()
    expect(addDefaultParsersCalls).toHaveLength(0)
    expect(constructedClientCount).toBe(0)
  })
})

describe('buildDefaultParsers', () => {
  test('skips filetypes whose shipped assets are missing and keeps the rest', () => {
    const parsers = buildDefaultParsers()

    // markdown_inline's wasm/highlights assets are hidden by the fs double
    // above, so its descriptor must be skipped rather than guessed at.
    expect(parsers.map((parser) => parser.filetype)).toEqual([
      'javascript',
      'typescript',
      'markdown',
    ])
    expect(parsers.some((parser) => parser.filetype === 'markdown_inline')).toBe(
      false,
    )
  })

  test('registers shipped filetypes with absolute existing wasm/highlight paths', () => {
    const parsers = buildDefaultParsers()
    expect(parsers.length).toBeGreaterThan(0)

    for (const parser of parsers) {
      expect(path.isAbsolute(parser.wasm)).toBe(true)
      const highlights = parser.queries.highlights
      expect(highlights.length).toBeGreaterThan(0)
      expect(highlights.every((query) => path.isAbsolute(query))).toBe(true)
      // Every registered highlight query must actually exist on disk.
      expect(highlights.every((query) => realExistsSync(query))).toBe(true)
    }
  })
})
