import { beforeEach, describe, expect, spyOn, test } from 'bun:test'

import {
  clearSymbolEnrichmentCacheForTest,
  enrichFileSymbols,
  SYMBOL_ENRICHMENT_CACHE_MAX_ENTRIES,
  symbolEnrichmentCacheSizeForTest,
} from '../services/symbol-enrichment'
import {
  LspServerError,
  LspServerUnavailableError,
} from '../services/lsp-multiplexer'

import type {
  LspDocumentSymbol,
  LspHover,
  LspPosition,
} from '../services/lsp-multiplexer'
import type {
  LspInlayHint,
  SymbolEnrichmentMultiplexer,
} from '../services/symbol-enrichment'

const FILE = '/proj/src/index.ts'
const TEXT = 'export const foo = 1\n'

function range(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
) {
  return {
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
  }
}

type FakeHandlers = {
  documentSymbol?: (
    params: { filePath: string },
  ) => Promise<LspDocumentSymbol[] | null> | LspDocumentSymbol[] | null
  hover?: (
    params: { filePath: string; position: LspPosition },
  ) => Promise<LspHover | null> | LspHover | null
  inlayHint?: (
    params: { filePath: string },
  ) => Promise<LspInlayHint[] | null> | LspInlayHint[] | null
}

/** A hermetic multiplexer-like fake with per-method spies over canned handlers. */
function makeFakeMultiplexer(handlers: FakeHandlers) {
  const target: SymbolEnrichmentMultiplexer = {
    documentSymbol: (params) =>
      Promise.resolve(
        handlers.documentSymbol ? handlers.documentSymbol(params) : null,
      ),
    hover: (params) =>
      Promise.resolve(handlers.hover ? handlers.hover(params) : null),
    ...(handlers.inlayHint
      ? {
          inlayHint: (params: { filePath: string }) =>
            Promise.resolve(handlers.inlayHint!(params)),
        }
      : {}),
  }
  return {
    multiplexer: target,
    documentSymbolSpy: spyOn(target, 'documentSymbol'),
    hoverSpy: spyOn(target, 'hover'),
    ...(handlers.inlayHint
      ? { inlayHintSpy: spyOn(target, 'inlayHint') }
      : {}),
  }
}

describe('enrichFileSymbols', () => {
  beforeEach(() => {
    clearSymbolEnrichmentCacheForTest()
  })

  test('merges hover type signature + documentation onto symbols', async () => {
    const { multiplexer, documentSymbolSpy } = makeFakeMultiplexer({
      documentSymbol: () => [
        {
          name: 'foo',
          kind: 13,
          range: range(0, 0, 0, 20),
          selectionRange: range(0, 14, 0, 17),
        },
      ],
      hover: () => ({
        contents: [
          { language: 'typescript', value: 'const foo: 1' },
          { kind: 'markdown', value: 'The foo constant.' },
        ],
      }),
    })

    const result = await enrichFileSymbols({
      filePath: FILE,
      fileText: TEXT,
      multiplexer,
    })

    expect(result.unavailable).toBeUndefined()
    expect(result.symbols).toHaveLength(1)
    expect(documentSymbolSpy).toHaveBeenCalledTimes(1)
    const [foo] = result.symbols
    expect(foo.name).toBe('foo')
    expect(foo.kind).toBe(13)
    expect(foo.detail).toBe('const foo: 1')
    expect(foo.documentation).toBe('const foo: 1\n\nThe foo constant.')
  })

  test('attaches inlayHint inferred types when supported', async () => {
    const { multiplexer, inlayHintSpy } = makeFakeMultiplexer({
      documentSymbol: () => [
        {
          name: 'total',
          kind: 13,
          range: range(2, 0, 2, 24),
          selectionRange: range(2, 6, 2, 11),
        },
      ],
      hover: () => null,
      inlayHint: () => [
        { position: { line: 2, character: 11 }, label: ': number', kind: 1 },
      ],
    })

    const result = await enrichFileSymbols({
      filePath: FILE,
      fileText: 'let total = 0\n'.repeat(4),
      multiplexer,
    })

    expect(inlayHintSpy).toHaveBeenCalledTimes(1)
    expect(result.symbols[0].inferredType).toBe('number')
    // No hover result -> detail/documentation stay undefined, symbol kept.
    expect(result.symbols[0].detail).toBeUndefined()
    expect(result.symbols[0].documentation).toBeUndefined()
  })

  test('skips inlayHint quietly when the seam (capability) is absent', async () => {
    const { multiplexer } = makeFakeMultiplexer({
      documentSymbol: () => [
        {
          name: 'foo',
          kind: 13,
          range: range(0, 0, 0, 20),
          selectionRange: range(0, 14, 0, 17),
        },
      ],
      hover: () => null,
    })

    const result = await enrichFileSymbols({
      filePath: FILE,
      fileText: TEXT,
      multiplexer,
    })

    expect(result.symbols).toHaveLength(1)
    expect(result.symbols[0].inferredType).toBeUndefined()
  })

  test('cache hit avoids a second documentSymbol call', async () => {
    const { multiplexer, documentSymbolSpy, hoverSpy } = makeFakeMultiplexer({
      documentSymbol: () => [
        {
          name: 'foo',
          kind: 13,
          range: range(0, 0, 0, 20),
          selectionRange: range(0, 14, 0, 17),
        },
      ],
      hover: () => ({ contents: 'docs' }),
    })

    await enrichFileSymbols({ filePath: FILE, fileText: TEXT, multiplexer })
    const second = await enrichFileSymbols({
      filePath: FILE,
      fileText: TEXT,
      multiplexer,
    })

    expect(documentSymbolSpy).toHaveBeenCalledTimes(1)
    expect(hoverSpy).toHaveBeenCalledTimes(1)
    expect(second.symbols).toHaveLength(1)
    expect(second.symbols[0].documentation).toBe('docs')
  })

  test('changed content re-queries (cache keyed by content hash, not path)', async () => {
    const { multiplexer, documentSymbolSpy } = makeFakeMultiplexer({
      documentSymbol: () => [
        {
          name: 'foo',
          kind: 13,
          range: range(0, 0, 0, 20),
          selectionRange: range(0, 14, 0, 17),
        },
      ],
      hover: () => null,
    })

    await enrichFileSymbols({ filePath: FILE, fileText: TEXT, multiplexer })
    await enrichFileSymbols({
      filePath: FILE,
      fileText: `${TEXT}// changed\n`,
      multiplexer,
    })

    expect(documentSymbolSpy).toHaveBeenCalledTimes(2)
  })

  test('same content at different paths produces separate cache entries', async () => {
    // Hover enrichment is path-dependent (imports resolve per location), so
    // the cache key is path + content: byte-identical files at different
    // paths must not share an entry.
    const { multiplexer, documentSymbolSpy } = makeFakeMultiplexer({
      documentSymbol: () => [
        {
          name: 'foo',
          kind: 13,
          range: range(0, 0, 0, 20),
          selectionRange: range(0, 14, 0, 17),
        },
      ],
      hover: (params) => ({ contents: `docs for ${params.filePath}` }),
    })

    const first = await enrichFileSymbols({
      filePath: '/proj/src/a.ts',
      fileText: TEXT,
      multiplexer,
    })
    const second = await enrichFileSymbols({
      filePath: '/proj/src/b.ts',
      fileText: TEXT,
      multiplexer,
    })

    expect(documentSymbolSpy).toHaveBeenCalledTimes(2)
    expect(symbolEnrichmentCacheSizeForTest()).toBe(2)
    expect(first.symbols[0].documentation).toBe('docs for /proj/src/a.ts')
    expect(second.symbols[0].documentation).toBe('docs for /proj/src/b.ts')

    // Re-enriching either path is still a cache hit against its own entry.
    const again = await enrichFileSymbols({
      filePath: '/proj/src/a.ts',
      fileText: TEXT,
      multiplexer,
    })
    expect(documentSymbolSpy).toHaveBeenCalledTimes(2)
    expect(again.symbols[0].documentation).toBe('docs for /proj/src/a.ts')
  })

  test('same path with changed content still invalidates (path does not mask content)', async () => {
    const { multiplexer, documentSymbolSpy } = makeFakeMultiplexer({
      documentSymbol: () => [],
      hover: () => null,
    })

    await enrichFileSymbols({ filePath: FILE, fileText: TEXT, multiplexer })
    await enrichFileSymbols({
      filePath: FILE,
      fileText: `${TEXT}// changed\n`,
      multiplexer,
    })

    expect(documentSymbolSpy).toHaveBeenCalledTimes(2)
  })

  test('keeps the symbol when hover yields no result', async () => {
    const { multiplexer } = makeFakeMultiplexer({
      documentSymbol: () => [
        {
          name: 'bar',
          kind: 12,
          range: range(1, 0, 3, 1),
          selectionRange: range(1, 9, 1, 12),
        },
      ],
      hover: () => null,
    })

    const result = await enrichFileSymbols({
      filePath: FILE,
      fileText: TEXT,
      multiplexer,
    })

    expect(result.symbols).toHaveLength(1)
    expect(result.symbols[0].name).toBe('bar')
    expect(result.symbols[0].detail).toBeUndefined()
    expect(result.symbols[0].documentation).toBeUndefined()
  })

  test('keeps the symbol when the hover request fails (crashed server)', async () => {
    const { multiplexer } = makeFakeMultiplexer({
      documentSymbol: () => [
        {
          name: 'bar',
          kind: 12,
          range: range(1, 0, 3, 1),
          selectionRange: range(1, 9, 1, 12),
        },
      ],
      hover: () => {
        throw new LspServerError('died', { reason: 'crashed' })
      },
    })

    const result = await enrichFileSymbols({
      filePath: FILE,
      fileText: TEXT,
      multiplexer,
    })

    expect(result.symbols).toHaveLength(1)
    expect(result.symbols[0].name).toBe('bar')
    expect(result.symbols[0].documentation).toBeUndefined()
  })

  test('preserves existing symbol detail and enriches children', async () => {
    const { multiplexer } = makeFakeMultiplexer({
      documentSymbol: () => [
        {
          name: 'Widget',
          kind: 5,
          range: range(0, 0, 9, 1),
          selectionRange: range(0, 6, 0, 12),
          detail: 'class Widget',
          children: [
            {
              name: 'render',
              kind: 6,
              range: range(2, 2, 5, 3),
              selectionRange: range(2, 2, 2, 8),
            },
          ],
        },
      ],
      hover: () => ({
        contents: { kind: 'plaintext', value: 'Widget docs' },
      }),
    })

    const result = await enrichFileSymbols({
      filePath: FILE,
      fileText: TEXT,
      multiplexer,
    })

    const [widget] = result.symbols
    // Pre-existing detail is not overwritten by the hover signature.
    expect(widget.detail).toBe('class Widget')
    expect(widget.documentation).toBe('Widget docs')
    expect(widget.children).toHaveLength(1)
    expect(widget.children![0].name).toBe('render')
  })

  test('unavailable server returns the honest result without throwing', async () => {
    const { multiplexer, documentSymbolSpy } = makeFakeMultiplexer({
      documentSymbol: () => {
        throw new LspServerUnavailableError('no server', {
          reason: 'no-server-spec',
        })
      },
    })

    const result = await enrichFileSymbols({
      filePath: FILE,
      fileText: TEXT,
      multiplexer,
    })

    expect(documentSymbolSpy).toHaveBeenCalledTimes(1)
    expect(result.symbols).toEqual([])
    expect(result.unavailable).toEqual({ reason: 'no-server-spec' })
  })

  test('crashed server (LspServerError) returns the honest result without throwing', async () => {
    const { multiplexer } = makeFakeMultiplexer({
      documentSymbol: () => {
        throw new LspServerError('timeout', { reason: 'timeout' })
      },
    })

    const result = await enrichFileSymbols({
      filePath: FILE,
      fileText: TEXT,
      multiplexer,
    })

    expect(result.symbols).toEqual([])
    expect(result.unavailable).toEqual({ reason: 'timeout' })
  })

  test('cache is bounded by SYMBOL_ENRICHMENT_CACHE_MAX_ENTRIES', async () => {
    const { multiplexer } = makeFakeMultiplexer({
      documentSymbol: () => [],
      hover: () => null,
    })

    const overflow = 5
    for (let i = 0; i < SYMBOL_ENRICHMENT_CACHE_MAX_ENTRIES + overflow; i++) {
      await enrichFileSymbols({
        filePath: FILE,
        fileText: `// entry ${i}\n`,
        multiplexer,
      })
    }

    expect(symbolEnrichmentCacheSizeForTest()).toBe(
      SYMBOL_ENRICHMENT_CACHE_MAX_ENTRIES,
    )
  })

  test('fans hover requests out with bounded concurrency instead of serial round-trips', async () => {
    const symbolCount = 12
    let inFlight = 0
    let maxInFlight = 0
    const { multiplexer, hoverSpy } = makeFakeMultiplexer({
      documentSymbol: () =>
        Array.from({ length: symbolCount }, (_, i) => ({
          name: `sym${i}`,
          kind: 12,
          range: range(i, 0, i, 5),
          selectionRange: range(i, 0, i, 5),
        })),
      hover: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight--
        return { contents: 'docs' }
      },
    })

    const result = await enrichFileSymbols({
      filePath: FILE,
      fileText: TEXT,
      multiplexer,
    })

    // Every symbol is still enriched (index-aligned), and the hover requests
    // actually overlapped instead of running as 12 serial LSP round-trips.
    expect(result.symbols).toHaveLength(symbolCount)
    expect(result.symbols.every((s) => s.documentation === 'docs')).toBe(true)
    expect(hoverSpy).toHaveBeenCalledTimes(symbolCount)
    expect(maxInFlight).toBeGreaterThan(1)
  })
})
