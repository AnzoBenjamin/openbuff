import { describe, expect, test } from 'bun:test'

import {
  buildIndexStatusContentBlock,
  handleIndexCommand,
  handleIndexCommandBlocks,
} from '../index-command'

const createDeps = (overrides: Record<string, unknown> = {}) => {
  const manager = {
    markStale: () => {},
    ensureBuilt: () => {},
    waitUntilReady: async () => {},
    query: () => ({
      results: [],
      ready: true,
      totalIndexed: 42,
      indexAge: 65_000,
      status: {
        state: 'ready' as const,
        ready: true,
        stale: false,
        refreshing: false,
        semantic: 'unavailable' as const,
        totalIndexed: 42,
        indexAge: 65_000,
        diagnostics: [],
        message: 'Index ready.',
      },
    }),
    queryBlended: async () => ({
      results: [
        {
          path: 'src/auth.ts',
          score: 12.345,
          matchedOn: ['symbol'],
          explanation: 'Defines authenticate.',
        },
      ],
      ready: true,
      totalIndexed: 42,
      indexAge: 65_000,
      status: {
        state: 'ready' as const,
        ready: true,
        stale: false,
        refreshing: false,
        semantic: 'unavailable' as const,
        totalIndexed: 42,
        indexAge: 65_000,
        diagnostics: [],
        message: 'Index ready.',
      },
    }),
    isSemanticReady: () => false,
    ...overrides,
  }
  return {
    manager,
    deps: {
      getManager: () => ({
        enabled: true,
        semanticEnabled: true,
        manager,
      }),
    },
  }
}

describe('/index command', () => {
  test('reports readiness, age, corpus size, and semantic fallback', async () => {
    const { deps } = createDeps()

    const result = await handleIndexCommand('status', deps)

    expect(result).toContain('Index status: ready')
    expect(result).toContain('42 indexed files')
    expect(result).toContain('Age: 1m')
    expect(result).toContain('metadata-only fallback')
  })

  test('renders stale, degraded, coverage, and parser diagnostics faithfully', async () => {
    const { deps } = createDeps({
      query: () => ({
        results: [],
        ready: true,
        totalIndexed: 100,
        indexAge: 2_000,
        status: {
          state: 'degraded' as const,
          ready: true,
          stale: true,
          refreshing: true,
          semantic: 'failed' as const,
          totalIndexed: 100,
          indexAge: 2_000,
          diagnostics: [
            { filePath: 'src/bad.ts', stage: 'parse', message: 'syntax error' },
          ],
          coverage: {
            truncated: true,
            maxFiles: 100,
            skippedFiles: 12,
            skippedPrefixes: ['vendor'],
          },
          message: 'Index ready with parser diagnostics.',
        },
      }),
    })

    const result = await handleIndexCommand('status', deps)

    expect(result).toContain('degraded · refreshing')
    expect(result).toContain('Coverage: partial')
    expect(result).toContain('src/bad.ts (parse): syntax error')
    expect(result).toContain('failed (metadata-only fallback)')
  })

  test('requests a safe refresh and waits for status', async () => {
    let marked = false
    let ensured = false
    let waited = false
    const { deps } = createDeps({
      markStale: () => {
        marked = true
      },
      ensureBuilt: () => {
        ensured = true
      },
      waitUntilReady: async () => {
        waited = true
      },
    })

    const result = await handleIndexCommand('rebuild', deps)

    expect({ marked, ensured, waited }).toEqual({
      marked: true,
      ensured: true,
      waited: true,
    })
    expect(result).toContain('Index refresh requested')
  })

  test('explains ranked results with provenance', async () => {
    const { deps } = createDeps()

    const result = await handleIndexCommand('explain authentication', deps)

    expect(result).toContain('src/auth.ts')
    expect(result).toContain('matched symbol')
    expect(result).toContain('Defines authenticate.')
  })

  test('reports disabled indexing without creating a manager', async () => {
    const result = await handleIndexCommand('status', {
      getManager: () => ({
        enabled: false,
        semanticEnabled: false,
        manager: null,
      }),
    })

    expect(result).toContain('disabled in openbuff.json')
    expect(result).toContain('read_subtree, glob, or code_search')
  })
})

describe('buildIndexStatusContentBlock prefix parsing', () => {
  const baseResult = () => ({
    results: [] as Array<{ path: string; score: number }>,
    ready: true,
    totalIndexed: 99,
    indexAge: 61_000,
    status: {
      state: 'ready' as const,
      ready: true,
      stale: false,
      refreshing: false,
      semantic: 'ready' as const,
      totalIndexed: 99,
      indexAge: 61_000,
      diagnostics: [] as Array<{ filePath: string; stage: string; message: string }>,
      message: 'Index ready.',
    },
  })

  test('strips Corpus:/Age:/Vector: prefixes correctly', () => {
    const result = baseResult()
    const block = buildIndexStatusContentBlock(result, true, true)

    expect(block.statusLine).toContain('Index status: ready')
    expect(block.corpusLine).toBe('99 indexed files.')
    expect(block.corpusLine).not.toContain('Corpus:')
    expect(block.ageLine).toBe('1m')
    expect(block.ageLine).not.toContain('Age:')
    expect(block.vectorLine).toBe('ready')
    expect(block.vectorLine).not.toContain('Vector embeddings:')
    expect(block.hintLine).toContain('Use /index explain')
    expect(block.lines.length).toBeGreaterThan(3)
  })

  test('parses coverage and diagnostics when present', () => {
    const result = {
      ...baseResult(),
      status: {
        ...baseResult().status,
        state: 'degraded' as const,
        refreshing: true,
        coverage: {
          truncated: true,
          maxFiles: 100,
          skippedFiles: 5,
          skippedPrefixes: ['vendor'],
        },
        diagnostics: [
          { filePath: 'src/bad.ts', stage: 'parse', message: 'oops' },
          { filePath: 'src/bad2.ts', stage: 'index', message: 'fail' },
        ],
      },
    }
    const block = buildIndexStatusContentBlock(result, false, true)

    expect(block.coverageLine).toContain('Coverage: partial')
    expect(block.diagnosticsLines).toBeDefined()
    expect(block.diagnosticsLines?.[0]).toContain('Diagnostics:')
    expect(block.diagnosticsLines?.join('\n')).toContain('src/bad.ts')
  })

  test('handles empty age and vector disabled', () => {
    const result = {
      ...baseResult(),
      indexAge: 0,
      status: { ...baseResult().status, indexAge: 0 },
    }
    const block = buildIndexStatusContentBlock(result, false, false)

    expect(block.ageLine).toBe('not available')
    expect(block.vectorLine).toBe('disabled')
  })

  test('handles not-ready hint and zero corpus edge', () => {
    const result = {
      results: [],
      ready: false,
      totalIndexed: 0,
      indexAge: 0,
      status: {
        state: 'building' as const,
        ready: false,
        stale: false,
        refreshing: true,
        semantic: 'building' as const,
        totalIndexed: 0,
        indexAge: 0,
        diagnostics: [],
        message: 'Building index...',
      },
    }
    const block = buildIndexStatusContentBlock(result, false, true)

    expect(block.corpusLine).toBe('0 indexed files.')
    expect(block.hintLine).toContain('Retry shortly')
  })

  test('corpus singular vs plural boundary', () => {
    const one = {
      ...baseResult(),
      status: { ...baseResult().status, totalIndexed: 1 },
    }
    const block = buildIndexStatusContentBlock(one, true, true)
    expect(block.corpusLine).toBe('1 indexed file.')
  })
})

describe('handleIndexCommandBlocks disabled vs status/rebuild', () => {
  test('returns disabled block without corpus/age/vector', async () => {
    const block = (await handleIndexCommandBlocks('status', {
      getManager: () => ({
        enabled: false,
        semanticEnabled: false,
        manager: null,
      }),
    })) as import('../../types/chat').IndexStatusContentBlock

    expect(block.type).toBe('index-status')
    expect(block.statusLine).toContain('disabled in openbuff.json')
    expect(block.corpusLine).toBe('')
    expect(block.ageLine).toBe('')
    expect(block.vectorLine).toBe('')
    expect(block.lines[0]).toContain('disabled')
  })

  test('status parses same as buildIndexStatusContentBlock', async () => {
    const { deps, manager } = createDeps()
    const expected = buildIndexStatusContentBlock(manager.query(), manager.isSemanticReady(), true)
    const block = (await handleIndexCommandBlocks('status', deps)) as import('../../types/chat').IndexStatusContentBlock

    expect(block.statusLine).toBe(expected.statusLine)
    expect(block.corpusLine).toBe(expected.corpusLine)
    expect(block.ageLine).toBe(expected.ageLine)
    expect(block.vectorLine).toBe(expected.vectorLine)
  })

  test('rebuild prefixes message and lines', async () => {
    const { deps } = createDeps()
    const block = (await handleIndexCommandBlocks('rebuild', deps)) as import('../../types/chat').IndexStatusContentBlock

    expect(block.messageLine).toContain('Index refresh requested')
    expect(block.messageLine).toContain('\n')
    expect(block.lines[0]).toContain('Index refresh requested')
    expect(block.lines[1]).toContain('Index status:')
    expect(block.corpusLine).not.toContain('Corpus:')
    expect(block.corpusLine).toContain('indexed files')
  })

  test('disabled rebuild path also returns disabled block', async () => {
    const block = (await handleIndexCommandBlocks('rebuild', {
      getManager: () => ({
        enabled: false,
        semanticEnabled: false,
        manager: null,
      }),
    })) as import('../../types/chat').IndexStatusContentBlock
    expect(block.statusLine).toContain('disabled')
  })
})
