import { describe, expect, test } from 'bun:test'

import {
  MAX_SCIP_LABEL_CHARS,
  MAX_SCIP_SYMBOL_CHARS,
  mergeScipIntoIndex,
  parseScipJson,
  scipPreciseEdges,
  SCIP_MAX_MERGED_EDGES,
  SCIP_MAX_OCCURRENCES_PER_DOCUMENT,
  ScipIngestError,
} from './scip-ingest'

import type { ScipDocument, ScipIndex, ScipOccurrence } from './scip-ingest'
import type { IndexEdge, MetadataIndex } from './types'

const HELPER_SYMBOL = 'scip-typescript npm pkg 1.0.0 src/util.ts/helper().'
const EXTERNAL_SYMBOL = 'scip-typescript npm lib 2.0.0 src/index.ts/external().'

const scipFixture = {
  documents: [
    {
      relative_path: 'src/util.ts',
      language: 'typescript',
      occurrences: [
        { range: [1, 0, 1, 10], symbol: HELPER_SYMBOL, symbol_roles: 1 },
        // Same-file reference: file-internal, must not produce a self edge.
        { range: [5, 2, 8], symbol: HELPER_SYMBOL },
      ],
    },
    {
      relative_path: 'src/app.ts',
      occurrences: [
        { range: [3, 4, 3, 10], symbol: HELPER_SYMBOL },
        // Duplicate reference to the same symbol: deduped, not doubled.
        { range: [7, 4, 7, 10], symbol: HELPER_SYMBOL },
        // Local symbol: stays file-internal.
        { range: [9, 0, 9, 5], symbol: 'local 0' },
      ],
    },
  ],
  external_symbols: [{ symbol: EXTERNAL_SYMBOL }],
}

function makeIndex(overrides?: Partial<MetadataIndex>): MetadataIndex {
  return {
    version: '2',
    projectRoot: '/repo',
    builtAt: 123,
    fileCount: 2,
    files: {},
    graph: { nodes: {}, edges: [] },
    ...overrides,
  }
}

/** Build a validated SCIP index producing `edgeCount` unique precise edges. */
function scipWithUniqueEdges(edgeCount: number): ScipIndex {
  const documents: ScipDocument[] = []
  let produced = 0
  let pair = 0
  while (produced < edgeCount) {
    const size = Math.min(
      SCIP_MAX_OCCURRENCES_PER_DOCUMENT,
      edgeCount - produced,
    )
    const definer: ScipOccurrence[] = []
    const referrer: ScipOccurrence[] = []
    for (let i = 0; i < size; i++) {
      const symbol = `scip-typescript npm pkg 1.0.0 src/sym-${produced + i}#f().`
      definer.push({ symbol, symbolRoles: 1 })
      referrer.push({ symbol })
    }
    documents.push({ relativePath: `src/def-${pair}.ts`, occurrences: definer })
    documents.push({
      relativePath: `src/ref-${pair}.ts`,
      occurrences: referrer,
    })
    produced += size
    pair++
  }
  return { documents, externalSymbols: [] }
}

describe('parseScipJson', () => {
  test('validates the supported SCIP JSON shape', () => {
    const scip = parseScipJson(scipFixture)
    expect(scip.documents).toHaveLength(2)
    expect(scip.documents[0].relativePath).toBe('src/util.ts')
    expect(scip.documents[0].language).toBe('typescript')
    expect(scip.documents[0].occurrences[0].symbolRoles).toBe(1)
    expect(scip.documents[1].occurrences[0].symbolRoles).toBeUndefined()
    expect(scip.externalSymbols).toEqual([EXTERNAL_SYMBOL])
  })

  test('fails closed with a typed error on malformed input', () => {
    const malformed: unknown[] = [
      null,
      'scip',
      {},
      { documents: 'nope' },
      { documents: [{}] },
      { documents: [{ relative_path: 3, occurrences: [] }] },
      { documents: [{ relative_path: 'a.ts' }] },
      { documents: [{ relative_path: 'a.ts', occurrences: 'nope' }] },
      {
        documents: [{ relative_path: 'a.ts', occurrences: [{ symbol: 's' }] }],
      },
      {
        documents: [
          {
            relative_path: 'a.ts',
            occurrences: [{ range: [0, 0], symbol: 's' }],
          },
        ],
      },
      {
        documents: [
          {
            relative_path: 'a.ts',
            occurrences: [{ range: [0, 0, 1], symbol: 3 }],
          },
        ],
      },
      { documents: [], external_symbols: [{}] },
    ]
    for (const input of malformed) {
      expect(() => parseScipJson(input)).toThrow(ScipIngestError)
    }

    let caught: unknown
    try {
      parseScipJson(null)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ScipIngestError)
    expect((caught as ScipIngestError).code).toBe('malformed')
  })

  test('rejects documents exceeding the occurrence cap', () => {
    const occurrences = Array.from(
      { length: SCIP_MAX_OCCURRENCES_PER_DOCUMENT + 1 },
      (_, index) => ({ range: [index, 0, 1], symbol: 's' }),
    )
    let caught: unknown
    try {
      parseScipJson({ documents: [{ relative_path: 'big.ts', occurrences }] })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ScipIngestError)
    expect((caught as ScipIngestError).code).toBe('occurrence-limit')
  })

  test('keeps a 10k-char symbol exact while bounding its edge label', () => {
    const longSymbol = `scip-typescript npm pkg 1.0.0 src/long.ts/x().${'y'.repeat(10_000)}`
    const scip = parseScipJson({
      documents: [
        {
          relative_path: 'src/long.ts',
          occurrences: [
            { range: [0, 0, 0, 1], symbol: longSymbol, symbol_roles: 1 },
          ],
        },
        {
          relative_path: 'src/user.ts',
          occurrences: [
            { range: [1, 0, 1, 1], symbol: longSymbol },
            { range: [2, 0, 2, 1], symbol: longSymbol },
          ],
        },
      ],
    })
    expect(scip.documents[0].occurrences[0].symbol).toBe(longSymbol)
    const precise = scipPreciseEdges(scip)
    expect(precise).toHaveLength(1)
    expect(precise[0].label).toBe(longSymbol.slice(0, MAX_SCIP_LABEL_CHARS))
    expect(precise[0].identityDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('refuses a symbol over the identity bound instead of clipping it', () => {
    const maximal = 'x'.repeat(MAX_SCIP_SYMBOL_CHARS)
    const document = (symbol: string) => ({
      relative_path: 'src/a.ts',
      occurrences: [{ range: [0, 0, 1], symbol }],
    })
    expect(
      parseScipJson({ documents: [document(maximal)] }).documents[0]
        .occurrences[0].symbol,
    ).toBe(maximal)
    for (const parse of [
      () => parseScipJson({ documents: [document(`${maximal}x`)] }),
      () =>
        parseScipJson({
          documents: [],
          external_symbols: [{ symbol: `${maximal}x` }],
        }),
      () =>
        scipPreciseEdges({
          documents: [
            {
              relativePath: 'src/a.ts',
              occurrences: [{ symbol: `${maximal}x` }],
            },
          ],
          externalSymbols: [],
        }),
    ]) {
      expect(parse).toThrow(
        expect.objectContaining({
          name: 'ScipIngestError',
          code: 'symbol-limit',
        }),
      )
    }
  })
})

describe('mergeScipIntoIndex', () => {
  test('joins opaque descriptors to exact owners and keeps separate same-endpoint references', () => {
    const prefix = `scip-typescript npm pkg 1.0.0 ${'nested/'.repeat(24)}`
    const [a, b, c, unknown] = ['a().', 'b().', 'c().', 'missing().'].map(
      (suffix) => prefix + suffix,
    )
    const document = (
      relative_path: string,
      symbols: string[],
      symbol_roles = 0,
    ) => ({
      relative_path,
      occurrences: symbols.map((symbol, line) => ({
        range: [line, 0, 1],
        symbol,
        symbol_roles,
      })),
    })
    const documents = [
      document('src/a.ts', [a, a], 1),
      document('src/b.ts', [b, c], 1),
      document('src/user.ts', [a, unknown, b, c, b]),
    ]
    const edges = mergeScipIntoIndex(makeIndex(), parseScipJson({ documents }))
      .graph.edges
    expect(edges.map((edge) => [edge.from, edge.to, edge.label])).toEqual([
      [
        'file:src/user.ts',
        'file:src/a.ts',
        prefix.slice(0, MAX_SCIP_LABEL_CHARS),
      ],
      [
        'file:src/user.ts',
        'file:src/b.ts',
        prefix.slice(0, MAX_SCIP_LABEL_CHARS),
      ],
      [
        'file:src/user.ts',
        'file:src/b.ts',
        prefix.slice(0, MAX_SCIP_LABEL_CHARS),
      ],
    ])
    expect(new Set(edges.map((edge) => edge.identityDigest)).size).toBe(3)
    const reordered = [...documents].reverse().map((doc) => ({
      ...doc,
      occurrences: [...doc.occurrences].reverse(),
    }))
    expect(
      mergeScipIntoIndex(makeIndex(), parseScipJson({ documents: reordered }))
        .graph.edges,
    ).toEqual(edges)
  })

  test('does not normalize distinct or unusual JSON string identities', () => {
    const prefix = 'x'.repeat(MAX_SCIP_LABEL_CHARS)
    const symbols = ['\uD800', '\uD801', '\u00e9', 'e\u0301'].map(
      (tail) => prefix + tail,
    )
    const scip = parseScipJson({
      documents: ['src/definition.ts', 'src/user.ts'].map(
        (relative_path, i) => ({
          relative_path,
          occurrences: symbols.map((symbol, line) => ({
            range: [line, 0, 1],
            symbol,
            symbol_roles: i === 0 ? 1 : 0,
          })),
        }),
      ),
    })
    const edges = scipPreciseEdges(scip)
    expect(edges.map((edge) => edge.label)).toEqual(symbols.map(() => prefix))
    expect(new Set(edges.map((edge) => edge.identityDigest)).size).toBe(
      symbols.length,
    )
  })

  test('reports distinct exact definition owners instead of selecting one', () => {
    const documents = ['src/a.ts', 'src/b.ts', 'src/user.ts'].map(
      (relative_path, i) => ({
        relative_path,
        occurrences: [
          {
            range: [0, 0, 1],
            symbol: HELPER_SYMBOL,
            symbol_roles: i < 2 ? 1 : 0,
          },
        ],
      }),
    )
    const index = makeIndex()
    for (const order of [documents, [...documents].reverse()]) {
      expect(() =>
        mergeScipIntoIndex(index, parseScipJson({ documents: order })),
      ).toThrow(
        expect.objectContaining({
          name: 'ScipIngestError',
          code: 'ambiguous-definition',
        }),
      )
      expect(index.graph.edges).toEqual([])
    }
  })

  test('creates precise reference edges from definitions and references', () => {
    const index = makeIndex({
      graph: {
        nodes: {
          'file:src/app.ts': {
            id: 'file:src/app.ts',
            type: 'file',
            label: 'src/app.ts',
            path: 'src/app.ts',
          },
        },
        edges: [],
      },
    })
    const merged = mergeScipIntoIndex(index, parseScipJson(scipFixture))

    const precise = merged.graph.edges.filter(
      (edge) => edge.confidence === 'precise',
    )
    // Two identical references dedupe into a single precise edge.
    expect(precise).toHaveLength(1)
    expect(precise[0]).toMatchObject({
      from: 'file:src/app.ts',
      to: 'file:src/util.ts',
      type: 'references',
      label: HELPER_SYMBOL,
      confidence: 'precise',
    })
    // No self edge for the same-file reference; no edge for the local symbol.
    expect(merged.graph.edges.some((edge) => edge.from === edge.to)).toBe(false)
    expect(merged.graph.edges.some((edge) => edge.label === 'local 0')).toBe(
      false,
    )
    // Missing file nodes are materialized for edge endpoints.
    expect(merged.graph.nodes['file:src/util.ts']).toMatchObject({
      type: 'file',
      path: 'src/util.ts',
    })
    // The input snapshot is not mutated.
    expect(index.graph.edges).toHaveLength(0)
  })

  test('keeps heuristic edges untouched and ignores unknown symbols', () => {
    const heuristicEdge: IndexEdge = {
      from: 'file:src/app.ts',
      to: 'file:src/util.ts',
      type: 'references',
      weight: 0.9,
      label: './util',
    }
    const index = makeIndex({ graph: { nodes: {}, edges: [heuristicEdge] } })
    // Symbol defined only externally (no document defines it) → no edge.
    const scip = parseScipJson({
      documents: [
        {
          relative_path: 'src/app.ts',
          occurrences: [{ range: [1, 0, 6], symbol: EXTERNAL_SYMBOL }],
        },
      ],
      external_symbols: [{ symbol: EXTERNAL_SYMBOL }],
    })
    const merged = mergeScipIntoIndex(index, scip)
    expect(merged.graph.edges).toEqual([heuristicEdge])
    // Absent confidence means heuristic; consumers stay untouched.
    expect(merged.graph.edges[0].confidence).toBeUndefined()
  })

  test('a precise edge supersedes a heuristic duplicate of the same tuple', () => {
    const heuristicDuplicate: IndexEdge = {
      from: 'file:src/app.ts',
      to: 'file:src/util.ts',
      type: 'references',
      weight: 0.9,
      label: './util',
    }
    const unrelated: IndexEdge = {
      from: 'file:src/app.ts',
      to: 'file:src/other.ts',
      type: 'references',
      weight: 0.9,
      label: './other',
    }
    const index = makeIndex({
      graph: { nodes: {}, edges: [heuristicDuplicate, unrelated] },
    })
    const merged = mergeScipIntoIndex(index, parseScipJson(scipFixture))

    const tupleEdges = merged.graph.edges.filter(
      (edge) =>
        edge.from === 'file:src/app.ts' &&
        edge.to === 'file:src/util.ts' &&
        edge.type === 'references',
    )
    expect(tupleEdges).toHaveLength(1)
    expect(tupleEdges[0].confidence).toBe('precise')
    expect(merged.graph.edges).toContainEqual(unrelated)
  })

  test('local symbols stay file-internal', () => {
    const scip = parseScipJson({
      documents: [
        {
          relative_path: 'src/local.ts',
          occurrences: [
            { range: [0, 0, 0, 1], symbol: 'local 0', symbol_roles: 1 },
            { range: [2, 0, 2, 1], symbol: 'local 0' },
          ],
        },
      ],
    })
    const merged = mergeScipIntoIndex(makeIndex(), scip)
    expect(merged.graph.edges).toHaveLength(0)
    expect(merged.graph.nodes['file:src/local.ts']).toBeUndefined()
  })

  test('skips documents whose relative_path escapes the project', () => {
    const escaping = [
      '../evil.ts',
      '/abs/evil.ts',
      'src/../../evil.ts',
      'C:\\evil.ts',
      'src\\evil.ts',
    ]
    for (const relativePath of escaping) {
      const scip = parseScipJson({
        documents: [
          {
            relative_path: 'src/util.ts',
            occurrences: [
              { range: [0, 0, 0, 1], symbol: HELPER_SYMBOL, symbol_roles: 1 },
            ],
          },
          {
            relative_path: relativePath,
            occurrences: [{ range: [1, 0, 1, 1], symbol: HELPER_SYMBOL }],
          },
        ],
      })
      // The escaping document trips the guard: the merge fails closed and
      // the rejection is observable instead of silently absorbed (F2).
      expect(() => mergeScipIntoIndex(makeIndex(), scip)).toThrow(
        /escapes the project root/,
      )
    }
  })

  test('enforces the total merged edge cap', () => {
    const scip = scipWithUniqueEdges(SCIP_MAX_MERGED_EDGES + 1)
    let caught: unknown
    try {
      mergeScipIntoIndex(makeIndex(), scip)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ScipIngestError)
    expect((caught as ScipIngestError).code).toBe('edge-limit')
  })

  test('drops the stale persisted query accelerator', () => {
    const index = makeIndex({
      queryData: {
        postings: {},
        documentFrequencies: {},
        adjacency: { 'file:src/app.ts': [0] },
      },
    })
    const merged = mergeScipIntoIndex(index, parseScipJson(scipFixture))
    // queryData.adjacency indexes into graph.edges, so it must be rebuilt.
    expect(merged.queryData).toBeUndefined()
    expect(index.queryData).toBeDefined()
  })

  test('is deterministic regardless of document order', () => {
    const forward = mergeScipIntoIndex(makeIndex(), parseScipJson(scipFixture))
    const reversed = mergeScipIntoIndex(
      makeIndex(),
      parseScipJson({ documents: [...scipFixture.documents].reverse() }),
    )
    expect(reversed.graph.edges).toEqual(forward.graph.edges)
  })
})
