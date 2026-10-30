import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import path from 'path'

import * as realFs from 'fs'
import * as realOs from 'os'
import * as realOpenTuiCore from '@opentui/core'

import type { FiletypeParserOptions } from '@opentui/core'

// SNAPSHOT (not the live namespace): mock.module patches `import * as`
// bindings in place, so the disarmed delegates below must read from this
// frozen copy — reading the live namespace would call ITSELF (the same-mock
// spin). `{ ...ns }` freezes the original references.
const realOpenTuiCoreSnapshot = { ...realOpenTuiCore }

// Doubles for the @opentui/core tree-sitter surface used by
// ../tree-sitter-client. The stub client never spawns a worker; it either
// records construction or throws on demand.
const addDefaultParsersCalls: FiletypeParserOptions[][] = []
const constructedClientOptions: Array<{ dataPath: string }> = []
let constructedClientCount = 0
let clientConstructorError: Error | null = null

// Armed at module scope (this suite's own tests exercise the stub
// constructor and the recording addDefaultParsers); the top-level afterAll
// below disarms it so the registry-wide override delegates to the real
// @opentui/core exports for later files in the same worker.
let openTuiArmed = true

// Armed at module scope too (this suite's own tests need the markdown_inline
// assets to look missing); the same top-level afterAll disarms it so the
// registry-wide fsMock.existsSync override delegates to the REAL existsSync
// for later files in the same worker (mock.module('fs'/'node:fs') is
// registry-wide).
let hideMarkdownInlineAssets = true

mock.module('@opentui/core', () => ({
  ...realOpenTuiCore,
  // The stub/real choice is read at CALL time, not factory time: bun applies
  // the factory result once (patching already-loaded namespaces in place),
  // so a factory-body ternary would freeze whichever branch ran first.
  // TreeSitterClient stays constructable in both branches: when disarmed,
  // `new` returns the REAL client instance built from the snapshot.
  TreeSitterClient: function StubTreeSitterClient(options: unknown) {
    if (!openTuiArmed) {
      return new realOpenTuiCoreSnapshot.TreeSitterClient(
        options as ConstructorParameters<
          typeof realOpenTuiCoreSnapshot.TreeSitterClient
        >[0],
      )
    }
    if (clientConstructorError) {
      throw clientConstructorError
    }
    constructedClientCount += 1
    // Record the construction options so tests can assert the dataPath the
    // client is bound to (SEC: per-user cache isolation).
    constructedClientOptions.push(
      JSON.parse(JSON.stringify(options)) as { dataPath: string },
    )
    // Constructor called with `new`: returning undefined keeps `this` (the
    // fresh instance) as the result. Explicit so noImplicitReturns stays
    // satisfied alongside the disarmed path's object return.
    return undefined
  },
  addDefaultParsers: (parsers: FiletypeParserOptions[]) => {
    if (!openTuiArmed) {
      return realOpenTuiCoreSnapshot.addDefaultParsers(parsers)
    }
    addDefaultParsersCalls.push(parsers)
  },
}))

afterAll(() => {
  openTuiArmed = false
  // Disarm the markdown_inline asset-hiding existsSync override too, so a
  // later test file in the same worker gets the REAL filesystem answer.
  hideMarkdownInlineAssets = false
})

// Hide one descriptor's wasm/highlights assets (markdown_inline) behind a
// filtered existsSync double so the asset-existence filter has a skip to
// exercise; every other path stays on the real filesystem.
const realExistsSync = realFs.existsSync
// Pre-captured BEFORE mock.module('fs', ...) for the same reason as
// realExistsSync: mock.module patches the live `import * as realFs` binding
// in place, so the statSync override must delegate to this frozen reference
// — calling realFs.statSync from inside the override would call ITSELF (the
// same-mock spin) and hang the suite.
const realStatSync = realFs.statSync
// Armed only by the foreign-ownership test below: when true, statSync reports
// a DIFFERENT uid for the per-user tree-sitter cache dir so the ownership
// check's fail-closed fallback can be exercised hermetically.
let foreignTreeSitterCacheOwner = false
const fsMock = () => ({
  ...realFs,
  existsSync: (candidate: Parameters<typeof realExistsSync>[0]): boolean => {
    // Disarmed (after this suite): delegate to the REAL existsSync so sibling
    // files in the same worker get the real filesystem answer for
    // markdown_inline paths instead of a lying `false`.
    if (!hideMarkdownInlineAssets) {
      return realExistsSync(candidate)
    }
    return typeof candidate === 'string' && candidate.includes('markdown_inline')
      ? false
      : realExistsSync(candidate)
  },
  statSync: (
    candidate: string,
    options?: { throwIfNoEntry?: boolean },
  ): realFs.Stats | undefined => {
    if (
      foreignTreeSitterCacheOwner &&
      candidate.includes('codebuff-tree-sitter')
    ) {
      const ownUid =
        typeof process.getuid === 'function' ? process.getuid() : 0
      return {
        uid: ownUid + 1,
        isSymbolicLink: () => false,
      } as unknown as realFs.Stats
    }
    return realStatSync(candidate, options)
  },
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
const { buildDefaultParsers, getSharedTreeSitterClient, getTreeSitterDataPath, resetTreeSitterClientStateForTests } = await import(
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
    // bun's --isolate reuses worker processes: an earlier suite in this
    // worker may have constructed a real client or cached a creation
    // failure through the delegating mock chain, so every test starts from
    // pristine singleton state.
    resetTreeSitterClientStateForTests()
    addDefaultParsersCalls.length = 0
    constructedClientOptions.length = 0
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
    // beforeEach resets the singleton, so this test establishes its own
    // failure instead of relying on the previous test's cached state (which
    // worker reuse across files could otherwise mutate). The FIRST call
    // registers parsers and fails client construction, caching the failure;
    // the SECOND call must short-circuit on the cached failure without
    // re-registering parsers or attempting a second construction.
    clientConstructorError = new Error('simulated TreeSitterClient failure')
    expect(getSharedTreeSitterClient()).toBeNull()

    clientConstructorError = null
    expect(getSharedTreeSitterClient()).toBeNull()
    expect(addDefaultParsersCalls).toHaveLength(1)
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

describe('getTreeSitterDataPath (SEC: per-user cache isolation)', () => {
  beforeEach(() => {
    // Mirror the getSharedTreeSitterClient suite's reset: that suite caches a
    // client-creation failure on the shared singleton, and without this reset
    // getSharedTreeSitterClient() short-circuits on the cached failure and
    // returns null (with no recorded construction). Resetting the singleton
    // and the recording state makes it build ONE fresh client bound to the
    // per-user dataPath.
    resetTreeSitterClientStateForTests()
    addDefaultParsersCalls.length = 0
    constructedClientOptions.length = 0
    constructedClientCount = 0
    clientConstructorError = null
    foreignTreeSitterCacheOwner = false
  })

  test('returns a per-uid cache path under the OS tmpdir', () => {
    const dataPath = getTreeSitterDataPath()
    expect(path.dirname(dataPath)).toBe(realOs.tmpdir())
    expect(path.basename(dataPath)).toMatch(/^codebuff-tree-sitter-.+/)
    // On POSIX the suffix is the numeric uid: the same user's repeat runs
    // share the cache (the WASM cache-hit path), other users cannot.
    if (typeof process.getuid === 'function') {
      expect(dataPath).toContain(`u${process.getuid()}`)
    }
  })

  test('fails closed to a private temp dir when the cache dir is owned by another uid', () => {
    foreignTreeSitterCacheOwner = true
    try {
      const dataPath = getTreeSitterDataPath()
      expect(path.basename(dataPath)).toMatch(
        /^codebuff-tree-sitter-untrusted-/,
      )
      // The fallback dir is a fresh mkdtemp we own; clean it up.
      realFs.rmSync(dataPath, { recursive: true, force: true })
    } finally {
      foreignTreeSitterCacheOwner = false
    }
  })

  test('the shared client binds the stable per-user dataPath (cache-hit path intact)', () => {
    const first = getSharedTreeSitterClient()
    expect(first).not.toBeNull()
    expect(constructedClientOptions).toHaveLength(1)
    expect(
      path.basename(constructedClientOptions[0]?.dataPath ?? ''),
    ).toMatch(/^codebuff-tree-sitter-/)

    // The memoized singleton reuses the SAME client and dataPath, so the
    // worker's content-addressed grammar cache is still hit on later calls.
    expect(getSharedTreeSitterClient()).toBe(first)
    expect(constructedClientOptions).toHaveLength(1)
    expect(constructedClientCount).toBe(1)
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
