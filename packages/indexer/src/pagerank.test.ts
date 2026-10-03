import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_PAGERANK_DAMPING,
  MAX_PAGERANK_NODES,
  getPageRankAdjacency,
  personalizedPageRank,
  type PageRankEdge,
} from './pagerank'
import { queryIndex } from './query'
import { rankedRepoMap } from './repo-map'

import type { IndexedFile, IndexNode, MetadataIndex } from './types'

function adjacencyOf(
  edges: Record<string, Array<string | PageRankEdge>>,
): Map<string, PageRankEdge[]> {
  const adjacency = new Map<string, PageRankEdge[]>()
  for (const [from, targets] of Object.entries(edges)) {
    adjacency.set(
      from,
      targets.map((target) =>
        typeof target === 'string' ? { to: target } : target,
      ),
    )
  }
  return adjacency
}

function sumScores(scores: Map<string, number>): number {
  let sum = 0
  for (const score of scores.values()) sum += score
  return sum
}

function makeFile(
  path: string,
  concepts: string[],
  imports: string[] = [],
): IndexedFile {
  return {
    path,
    mtime: 1,
    size: 100,
    hash: path,
    ext: '.ts',
    symbols: [],
    imports,
    headings: [],
    concepts,
  }
}

function makeFileNode(path: string): IndexNode {
  return { id: `file:${path}`, type: 'file', label: path, path }
}

/**
 * Hub-and-satellite fixture: both satellites reference the hub, so the hub is
 * the best-connected file. The hub and the isolated file match the 'common'
 * query concept; the satellites do not match the query lexically.
 */
function makeHubIndex(): MetadataIndex {
  return {
    version: '2',
    projectRoot: '/repo',
    builtAt: 1,
    fileCount: 4,
    files: {
      'src/hub.ts': makeFile('src/hub.ts', ['common']),
      'src/satellite-a.ts': makeFile('src/satellite-a.ts', [], ['./hub']),
      'src/satellite-b.ts': makeFile('src/satellite-b.ts', [], ['./hub']),
      'src/isolated.ts': makeFile('src/isolated.ts', ['common']),
    },
    graph: {
      nodes: {
        'file:src/hub.ts': makeFileNode('src/hub.ts'),
        'file:src/satellite-a.ts': makeFileNode('src/satellite-a.ts'),
        'file:src/satellite-b.ts': makeFileNode('src/satellite-b.ts'),
        'file:src/isolated.ts': makeFileNode('src/isolated.ts'),
      },
      edges: [
        {
          from: 'file:src/satellite-a.ts',
          to: 'file:src/hub.ts',
          type: 'references',
          weight: 0.9,
          label: './hub',
        },
        {
          from: 'file:src/satellite-b.ts',
          to: 'file:src/hub.ts',
          type: 'references',
          weight: 0.9,
          label: './hub',
        },
      ],
    },
  }
}

describe('personalizedPageRank', () => {
  test('converges to the stationary distribution on a symmetric cycle', () => {
    const scores = personalizedPageRank({
      adjacency: adjacencyOf({ A: ['B'], B: ['C'], C: ['A'] }),
      epsilon: 1e-12,
      maxIterations: 100,
    })
    expect(sumScores(scores)).toBeCloseTo(1, 10)
    expect(scores.get('A')).toBeCloseTo(1 / 3, 10)
    expect(scores.get('B')).toBeCloseTo(1 / 3, 10)
    expect(scores.get('C')).toBeCloseTo(1 / 3, 10)
  })

  test('redistributes dangling-node rank through the personalization vector', () => {
    const scores = personalizedPageRank({
      adjacency: adjacencyOf({ A: ['B'], B: [], C: [] }),
      epsilon: 1e-12,
      maxIterations: 100,
    })
    // Only A has outgoing edges, yet the vector stays normalized because the
    // dangling nodes' rank flows back through the personalization vector.
    expect(sumScores(scores)).toBeCloseTo(1, 10)
    expect(scores.get('B')).toBeGreaterThan(scores.get('A') ?? 0)
    expect(scores.get('A')).toBeCloseTo(scores.get('C') ?? 0, 12)
    expect(scores.get('C')).toBeGreaterThan(0)
  })

  test('personalization seeds steer rank toward the seeded node', () => {
    const adjacency = adjacencyOf({ A: ['B'], B: ['A'] })
    const seeded = personalizedPageRank({
      adjacency,
      seeds: new Map([['A', 1]]),
      epsilon: 1e-12,
      maxIterations: 100,
    })
    const unseeded = personalizedPageRank({
      adjacency,
      epsilon: 1e-12,
      maxIterations: 100,
    })
    expect(seeded.get('A')).toBeGreaterThan(seeded.get('B') ?? 0)
    expect(seeded.get('A')).toBeGreaterThan(unseeded.get('A') ?? 0)
    expect(unseeded.get('A')).toBeCloseTo(unseeded.get('B') ?? 0, 12)
  })

  test('is deterministic and independent of seed insertion order', () => {
    const adjacency = adjacencyOf({
      A: ['B', 'C'],
      B: ['C'],
      C: ['A'],
      D: ['C'],
    })
    const first = personalizedPageRank({
      adjacency,
      seeds: new Map([
        ['A', 2],
        ['C', 1],
      ]),
    })
    const second = personalizedPageRank({
      adjacency,
      seeds: new Map([
        ['C', 1],
        ['A', 2],
      ]),
    })
    expect(Array.from(first.entries())).toEqual(Array.from(second.entries()))
  })

  test('falls back to a uniform vector when every seed is empty or invalid', () => {
    const scores = personalizedPageRank({
      adjacency: adjacencyOf({ A: ['B'], B: ['A'] }),
      seeds: new Map([
        ['A', 0],
        ['B', -3],
        ['missing', 5],
      ]),
      epsilon: 1e-12,
      maxIterations: 100,
    })
    expect(scores.get('A')).toBeCloseTo(0.5, 12)
    expect(scores.get('B')).toBeCloseTo(0.5, 12)
  })

  test('honors edge weights when distributing rank', () => {
    const scores = personalizedPageRank({
      adjacency: adjacencyOf({
        A: [
          { to: 'B', weight: 3 },
          { to: 'C', weight: 1 },
        ],
        B: [],
        C: [],
      }),
    })
    expect(scores.get('B')).toBeGreaterThan(scores.get('C') ?? 0)
  })

  test('respects the iteration cap (0 iterations returns the personalization vector)', () => {
    const scores = personalizedPageRank({
      adjacency: adjacencyOf({ A: ['B'], B: ['A'] }),
      seeds: new Map([
        ['A', 3],
        ['B', 1],
      ]),
      maxIterations: 0,
    })
    expect(scores.get('A')).toBeCloseTo(0.75, 12)
    expect(scores.get('B')).toBeCloseTo(0.25, 12)
  })

  test('returns an empty map for an empty graph', () => {
    expect(personalizedPageRank({ adjacency: new Map() }).size).toBe(0)
  })

  test('returns an empty map when the graph exceeds the node cap', () => {
    const adjacency = new Map<string, PageRankEdge[]>()
    for (let i = 0; i <= MAX_PAGERANK_NODES; i++) {
      adjacency.set(`node-${i}`, [])
    }
    expect(personalizedPageRank({ adjacency }).size).toBe(0)
  })

  test('drops edges that target unknown nodes', () => {
    const scores = personalizedPageRank({
      adjacency: adjacencyOf({ A: ['B', 'missing'], B: [] }),
    })
    expect(Array.from(scores.keys()).sort()).toEqual(['A', 'B'])
    expect(scores.get('B')).toBeGreaterThan(0)
  })

  test('uses the documented default damping factor', () => {
    expect(DEFAULT_PAGERANK_DAMPING).toBe(0.85)
  })
})

describe('getPageRankAdjacency', () => {
  test('builds a directed outgoing adjacency and caches it per index revision', () => {
    const index = makeHubIndex()
    const first = getPageRankAdjacency(index)
    expect(getPageRankAdjacency(index)).toBe(first)
    expect(getPageRankAdjacency(makeHubIndex())).not.toBe(first)

    // Directed: only the edge source has outgoing links; the hub is a pure
    // target, so it participates as a dangling node.
    expect(first.get('file:src/satellite-a.ts')).toEqual([
      { to: 'file:src/hub.ts', weight: 0.9 },
    ])
    expect(first.get('file:src/hub.ts')).toEqual([])
    expect(first.has('file:src/isolated.ts')).toBe(false)
  })
})

describe('queryIndex personalized-PageRank blend', () => {
  test('defaults to a no-op and matches an explicit zero weight', () => {
    const hubIndex = makeHubIndex()
    const defaultResults = queryIndex(hubIndex, 'common', { limit: 10 })
    const zeroResults = queryIndex(hubIndex, 'common', {
      limit: 10,
      pageRankWeight: 0,
    })
    expect(zeroResults).toEqual(defaultResults)
  })

  test('raises a well-connected file without changing unrelated scores', () => {
    const hubIndex = makeHubIndex()
    const defaultResults = queryIndex(hubIndex, 'common', { limit: 10 })
    const boostedResults = queryIndex(hubIndex, 'common', {
      limit: 10,
      pageRankWeight: 1,
    })

    const scoreOf = (
      results: typeof defaultResults,
      path: string,
    ): number => results.find((result) => result.path === path)?.score ?? 0
    const delta = (path: string): number =>
      scoreOf(boostedResults, path) - scoreOf(defaultResults, path)

    // The hub accumulates rank from both satellites; isolated.ts is not in
    // the graph adjacency, so its score is byte-identical.
    expect(delta('src/hub.ts')).toBeGreaterThan(delta('src/satellite-a.ts'))
    expect(delta('src/satellite-a.ts')).toBeGreaterThan(0)
    expect(delta('src/isolated.ts')).toBe(0)
    expect(boostedResults[0]?.path).toBe('src/hub.ts')

    // The hub had no graph-neighborhood boost, so the added 'graph' match is
    // attributable to the PageRank blend alone.
    const defaultHub = defaultResults.find(
      (result) => result.path === 'src/hub.ts',
    )
    const boostedHub = boostedResults.find(
      (result) => result.path === 'src/hub.ts',
    )
    expect(defaultHub?.matchedOn).not.toContain('graph')
    expect(boostedHub?.matchedOn).toContain('graph')
  })
})

describe('rankedRepoMap', () => {
  test('ranks the most connected file first for a seed set', () => {
    const ranked = rankedRepoMap(makeHubIndex(), [
      'src/satellite-a.ts',
      'src/satellite-b.ts',
    ])
    const paths = ranked.entries.map((entry) => entry.path)
    expect(paths[0]).toBe('src/hub.ts')
    expect(paths).toContain('src/satellite-a.ts')
    expect(paths).toContain('src/satellite-b.ts')
    // isolated.ts has no graph edges, so it is not part of the ranked map.
    expect(paths).not.toContain('src/isolated.ts')
  })

  test('falls back to a global importance ranking when the seed set is empty', () => {
    const ranked = rankedRepoMap(makeHubIndex(), [])
    expect(ranked.entries[0]?.path).toBe('src/hub.ts')
  })

  test('honors maxFiles', () => {
    const ranked = rankedRepoMap(
      makeHubIndex(),
      ['src/satellite-a.ts', 'src/satellite-b.ts'],
      { maxFiles: 1 },
    )
    expect(ranked.entries.length).toBe(1)
    expect(ranked.entries[0]?.path).toBe('src/hub.ts')
  })
})
