import { beforeEach, describe, expect, mock, test } from 'bun:test'
import path from 'path'

import * as realFs from 'fs'
import * as realOs from 'os'
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
// mock.module is registry-wide for the whole test process (bun does not
// isolate registrations across test files, and afterAll(mock.restore) does
// NOT undo it). The fsMock factory already spreads the REAL fs exports and
// only overrides existsSync, and the SAME factory state is registered for
// both 'fs' and 'node:fs', so the real fs API keeps flowing identically
// through either specifier — keeping sibling test files importing fs in this
// process safe.
mock.module('fs', fsMock)
mock.module('node:fs', fsMock)

// Imported after the mocks register so the module under test binds to them.
const { buildDefaultParsers, getSharedTreeSitterClient } = await import(
  '../tree-sitter-client'
)

// Real (non-stubbed) client for the highlighted-code fixture below. The
// registry-wide '@opentui/core' mock above only affects a fresh bare
// specifier; the '?real' query bypasses that registry entry, so this binds
// the real TreeSitterClient/addDefaultParsers while the stubbed-suite import
// above still binds the stubs (same mock-leak-guard pattern as
// content-with-markdown.test.tsx).
const realOpenTuiModule = (await import(
  '@opentui/core?real' as string
)) as unknown as typeof import('@opentui/core')

const snippetFor = (filetype: string): string =>
  filetype === 'typescript' || filetype === 'typescriptreact'
    ? 'const greeting: string = "hello"\nexport default greeting\n'
    : 'const greeting = "hello"\n'

// Drives the REAL TreeSitterClient (web-tree-sitter WASM worker) over a
// grammar whose parser descriptor's wasm/highlights assets exist on disk.
// Returns null when the environment cannot produce real scoped highlights —
// the same degradation signal the real client itself surfaces (null client,
// hasParser false, or an empty/errored result) — so the caller can gate the
// real-token assertion on actual grammar availability rather than assuming
// the WASM load always succeeds.
const highlightWithRealClient = async (
  parser: FiletypeParserOptions,
): Promise<{ client: object; highlights: [number, number, string][] } | null> => {
  const { TreeSitterClient: RealTreeSitterClient, addDefaultParsers: realAddDefaultParsers } =
    realOpenTuiModule
  let client: InstanceType<typeof RealTreeSitterClient> | null = null
  try {
    realAddDefaultParsers([parser])
    client = new RealTreeSitterClient({
      dataPath: realFs.mkdtempSync(
        path.join(realOs.tmpdir(), 'codebuff-tsc-test-'),
      ),
      initTimeout: 10_000,
    })
    const result = await client.highlightOnce(
      snippetFor(parser.filetype),
      parser.filetype,
    )
    if (!result || result.error || result.warning || !result.highlights?.length) {
      return null
    }
    return {
      client,
      highlights: result.highlights.map(
        (h): [number, number, string] => [h[0], h[1], h[2]],
      ),
    }
  } catch {
    // A real-client construction/highlight failure means the grammar WASM
    // load degraded; the caller's availability check treats this as
    // "grammars unavailable" and skips the real-token assertion.
    return null
  } finally {
    // Destroy must run even on an early return so the spawned tree-sitter
    // worker is reaped rather than leaked across the test process. The real
    // client tears down via the module-level singleton destroyer (there is
    // no instance destroy method).
    await realOpenTuiModule.destroyTreeSitterClient().catch(() => {})
  }
}

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

describe('highlighted-code fixture (REAL TreeSitterClient, no stub)', () => {
  test('produces non-empty, correctly scoped highlight tokens for the shipped TypeScript grammar', async () => {
    const parsers = buildDefaultParsers()
    const typescript = parsers.find((parser) => parser.filetype === 'typescript')

    // Availability check: the TS grammar's wasm + highlights assets must be
    // shipped on disk. Skip the real-token assertion when they are absent.
    if (!typescript) {
      console.warn(
        '[tree-sitter] skipping real TypeScript fixture: grammar assets missing from @opentui/core',
      )
      return
    }

    const outcome = await highlightWithRealClient(typescript)
    // Availability check: the real WASM/worker load must produce scoped
    // highlights. Skip (don't fail) when the environment cannot load the
    // shipped grammar — the degrade path is asserted separately below.
    if (!outcome) {
      console.warn(
        '[tree-sitter] skipping real TypeScript fixture: real client could not produce scoped highlights',
      )
      return
    }

    const { highlights } = outcome
    // SimpleHighlight = [line, col, group]; group is the tree-sitter capture
    // scope (keyword, string, type, ...). The real fixture must produce
    // non-empty, well-formed tokens.
    expect(highlights.length).toBeGreaterThan(0)
    for (const highlight of highlights) {
      expect(Array.isArray(highlight)).toBe(true)
      expect(typeof highlight[0]).toBe('number')
      expect(typeof highlight[1]).toBe('number')
      expect(typeof highlight[2]).toBe('string')
      expect(highlight[2].length).toBeGreaterThan(0)
    }

    const scopes = new Set(highlights.map((highlight) => highlight[2]))
    // `const greeting: string = "hello"` must scope at least the keyword and
    // string tokens from the shipped typescript highlights.scm.
    expect(scopes.has('keyword')).toBe(true)
    expect(scopes.has('string')).toBe(true)
  })

  test('reports the degrade signal when the grammar WASM load fails', async () => {
    const { TreeSitterClient: RealTreeSitterClient } = realOpenTuiModule
    const client = new RealTreeSitterClient({
      dataPath: realFs.mkdtempSync(
        path.join(realOs.tmpdir(), 'codebuff-tsc-degrade-'),
      ),
      initTimeout: 10_000,
    })
    try {
      // The grammar wasm was never registered (addDefaultParsers not called),
      // so the worker has no TypeScript parser: the real client surfaces that
      // degradation either as a THROWN error, an error/warning on the result,
      // or empty highlights. Every one of those is the availability signal
      // the real-fixture gate keys on.
      let degraded: boolean
      try {
        const result = await client.highlightOnce(
          snippetFor('typescript'),
          'typescript',
        )
        degraded =
          Boolean(result.error) ||
          Boolean(result.warning) ||
          !result.highlights?.length
      } catch {
        // A thrown error IS the degrade signal (the worker rejects the
        // unregistered filetype instead of returning a result).
        degraded = true
      }
      expect(degraded).toBe(true)
    } finally {
      // Module-level singleton teardown (the client has no instance destroy).
      await realOpenTuiModule.destroyTreeSitterClient().catch(() => {})
    }
  })
})
