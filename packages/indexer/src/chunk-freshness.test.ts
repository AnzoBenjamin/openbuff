import { describe, expect, test } from 'bun:test'

import {
  buildChunkSidecar,
  evaluateChunkFreshness,
  resolveChunkEntry,
} from './chunk-freshness'
import type { ChunkSidecar, MetadataIndex } from './types'

function makeIndex(): MetadataIndex {
  return {
    version: '2',
    projectRoot: '/repo',
    builtAt: 1,
    fileCount: 2,
    files: {
      'src/b.ts': {
        path: 'src/b.ts',
        mtime: 1,
        size: 10,
        hash: 'file-b',
        ext: '.ts',
        symbols: [],
        imports: [],
        headings: [],
        concepts: [],
        chunks: [
          {
            chunkId: 'chunk-b-0',
            stableChunkId: 'stable-b',
            qualifiedName: 'B/render',
            kind: 'function',
            startLine: 3,
            endLine: 8,
            hash: 'hash-b',
          },
        ],
      },
      'src/a.ts': {
        path: 'src/a.ts',
        mtime: 1,
        size: 10,
        hash: 'file-a',
        ext: '.ts',
        symbols: [],
        imports: [],
        headings: [],
        concepts: [],
        chunks: [
          {
            chunkId: 'chunk-a-0',
            stableChunkId: 'stable-a',
            qualifiedName: 'A/run',
            kind: 'function',
            startLine: 1,
            endLine: 10,
            hash: 'hash-a',
          },
          {
            chunkId: 'chunk-a-1',
            qualifiedName: 'A/legacy',
            kind: 'function',
            startLine: 11,
            endLine: 20,
            hash: 'hash-legacy',
          },
        ],
      },
    },
    graph: { nodes: {}, edges: [] },
  }
}

function makeSidecar(index: MetadataIndex, snapshotId = 'snap-1'): ChunkSidecar {
  return {
    version: 1,
    snapshotId,
    builtAt: 1,
    projectRoot: '/repo',
    chunks: buildChunkSidecar(index),
  }
}

describe('buildChunkSidecar', () => {
  test('derives deterministic sorted records and skips chunks without stable ids', () => {
    const sidecar = buildChunkSidecar(makeIndex())
    expect(Object.keys(sidecar)).toEqual(['stable-a', 'stable-b'])
    expect(sidecar['stable-a']).toEqual({
      file: 'src/a.ts',
      startLine: 1,
      endLine: 10,
      qualifiedName: 'A/run',
      kind: 'function',
      contentHash: 'hash-a',
    })
    expect(sidecar['stable-b']?.file).toBe('src/b.ts')
  })

  test('is deterministic across input key order', () => {
    const a = buildChunkSidecar(makeIndex())
    const reversed = makeIndex()
    reversed.files = Object.fromEntries(
      Object.entries(reversed.files).reverse(),
    )
    expect(buildChunkSidecar(reversed)).toEqual(a)
  })

  test('never throws on invalid input', () => {
    expect(buildChunkSidecar(null as never)).toEqual({})
    expect(buildChunkSidecar({} as never)).toEqual({})
    expect(buildChunkSidecar({ files: null } as never)).toEqual({})
  })
})

describe('resolveChunkEntry', () => {
  test('resolves from both sidecar documents and plain records', () => {
    const index = makeIndex()
    const sidecar = makeSidecar(index)
    expect(resolveChunkEntry(sidecar, 'stable-a')?.contentHash).toBe('hash-a')
    expect(resolveChunkEntry(sidecar.chunks, 'stable-b')?.file).toBe('src/b.ts')
    expect(resolveChunkEntry(sidecar, 'missing')).toBeUndefined()
    expect(resolveChunkEntry(null, 'stable-a')).toBeUndefined()
    expect(resolveChunkEntry(sidecar, '')).toBeUndefined()
  })
})

describe('evaluateChunkFreshness matrix', () => {
  test('FRESH when stable id exists and hashes match', () => {
    const index = makeIndex()
    const sidecar = makeSidecar(index, 'snap-1')
    expect(
      evaluateChunkFreshness(
        { stableChunkId: 'stable-a', path: 'src/a.ts', contentHash: 'hash-a' },
        index,
        sidecar,
        'snap-1',
      ),
    ).toEqual({ state: 'FRESH', reason: 'hash-match' })
  })

  test('STALE when hash differs or qualifiedName moved', () => {
    const index = makeIndex()
    const sidecar = makeSidecar(index, 'snap-1')
    expect(
      evaluateChunkFreshness(
        { stableChunkId: 'stable-a', path: 'src/a.ts', contentHash: 'other' },
        index,
        sidecar,
        'snap-1',
      ).state,
    ).toBe('STALE')
    expect(
      evaluateChunkFreshness(
        {
          stableChunkId: 'stable-a',
          path: 'src/a.ts',
          contentHash: 'hash-a',
          qualifiedName: 'A/moved',
        },
        index,
        sidecar,
        'snap-1',
      ),
    ).toEqual({ state: 'STALE', reason: 'qualified-name-moved' })
  })

  test('ORPHAN when stable id is missing, unknown, or the file was deleted', () => {
    const index = makeIndex()
    const sidecar = makeSidecar(index, 'snap-1')
    expect(
      evaluateChunkFreshness({ path: 'src/a.ts' }, index, sidecar, 'snap-1')
        .state,
    ).toBe('ORPHAN')
    expect(
      evaluateChunkFreshness(
        { stableChunkId: 'nope', path: 'src/a.ts', contentHash: 'x' },
        index,
        sidecar,
        'snap-1',
      ).state,
    ).toBe('ORPHAN')
    const deleted = makeIndex()
    delete deleted.files['src/a.ts']
    expect(
      evaluateChunkFreshness(
        { stableChunkId: 'stable-a', path: 'src/a.ts', contentHash: 'hash-a' },
        deleted,
        sidecar,
        'snap-1',
      ),
    ).toEqual({ state: 'ORPHAN', reason: 'file-deleted' })
  })

  test('SNAPSHOT-OLD when snapshot differs but hashes match', () => {
    const index = makeIndex()
    const sidecar = makeSidecar(index, 'snap-1')
    expect(
      evaluateChunkFreshness(
        { stableChunkId: 'stable-a', path: 'src/a.ts', contentHash: 'hash-a' },
        index,
        sidecar,
        'snap-2',
      ),
    ).toEqual({ state: 'SNAPSHOT-OLD', reason: 'snapshot-id-mismatch' })
  })

  test('stableChunkId passthrough survives the sidecar round-trip', () => {
    const index = makeIndex()
    const record = buildChunkSidecar(index)
    // The stable id keying the record is the passthrough identity: a
    // query_index hit carrying stableChunkId resolves to the same entry.
    expect(resolveChunkEntry(record, 'stable-a')?.qualifiedName).toBe('A/run')
    expect(
      evaluateChunkFreshness(
        { stableChunkId: 'stable-a', path: 'src/a.ts', contentHash: 'hash-a' },
        index,
        record,
        undefined,
      ).state,
    ).toBe('FRESH')
  })

  test('fail-closed: never throws', () => {
    expect(
      evaluateChunkFreshness(null, null, null, null).state,
    ).toMatch(/ORPHAN|STALE/)
    expect(
      evaluateChunkFreshness(undefined, undefined, undefined, undefined).state,
    ).toMatch(/ORPHAN|STALE/)
  })
})
