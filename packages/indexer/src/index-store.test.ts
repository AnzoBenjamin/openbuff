import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  buildChunkSidecarDocument,
  CHUNK_SIDECAR_VERSION,
  computeIndexSnapshotId,
  getIndexDir,
  loadChunkSidecar,
  loadIndex,
  loadSemanticVectors,
  sanitizeIndexCacheDir,
  saveChunkSidecar,
  saveIndex,
  saveSemanticVectors,
} from './index-store'

describe('index cache ownership', () => {
  test('accepts only a single hidden cache directory name', () => {
    expect(sanitizeIndexCacheDir('.custom-index')).toBe('.custom-index')
    expect(sanitizeIndexCacheDir('src')).toBe('.codebuff-index')
    expect(sanitizeIndexCacheDir('.cache/index')).toBe('.codebuff-index')
    expect(sanitizeIndexCacheDir('.git')).toBe('.codebuff-index')
  })

  test('refuses to claim a non-empty unowned directory', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-cache-owner-'),
    )
    const dir = getIndexDir(root, '.custom-index')
    await fs.promises.mkdir(dir)
    await fs.promises.writeFile(path.join(dir, 'user.txt'), 'mine')
    await expect(
      saveIndex(
        {
          version: '2',
          projectRoot: root,
          builtAt: Date.now(),
          fileCount: 0,
          files: {},
          graph: { nodes: {}, edges: [] },
        },
        root,
        '.custom-index',
      ),
    ).rejects.toThrow('non-owned')
  })

  test('persists semantic vectors by fingerprint and exact embedding hash', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-semantic-cache-'),
    )
    await saveSemanticVectors(root, 'model-a', [
      { path: 'src/a.ts', embeddingHash: 'embedding-a', vector: [1, 2] },
    ])

    expect(await loadSemanticVectors(root, 'model-a')).toEqual([
      { embeddingHash: 'embedding-a', vector: [1, 2] },
    ])
    expect(await loadSemanticVectors(root, 'model-b')).toEqual([])
  })

  test('rejects legacy content-hash vector schemas as unsafe cache misses', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-semantic-migration-'),
    )
    const dir = getIndexDir(root)
    await fs.promises.mkdir(dir)
    await fs.promises.writeFile(
      path.join(dir, 'semantic-vectors.json'),
      JSON.stringify({
        version: '1',
        projectRoot: root,
        fingerprint: 'legacy-model',
        vectors: [
          { path: 'old/name.ts', hash: 'same-content', vector: [0.5, 1] },
        ],
      }),
    )

    expect(await loadSemanticVectors(root, 'legacy-model')).toEqual([])
    await saveSemanticVectors(root, 'new-model', [
      { path: 'src/new.ts', embeddingHash: 'new-input', vector: [2, 3] },
    ])

    const migrated = JSON.parse(
      await fs.promises.readFile(
        path.join(dir, 'semantic-vectors.json'),
        'utf8',
      ),
    )
    expect(migrated.version).toBe('3')
    expect(migrated.fingerprints['legacy-model']).toBeUndefined()
    expect(migrated.fingerprints['new-model'].vectors).toEqual({
      'new-input': [2, 3],
    })
  })

  test('treats corrupt or foreign vector caches as safe misses', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-semantic-corrupt-'),
    )
    const dir = getIndexDir(root)
    await fs.promises.mkdir(dir)
    await fs.promises.writeFile(
      path.join(dir, 'semantic-vectors.json'),
      '{not json',
    )
    expect(await loadSemanticVectors(root, 'model')).toEqual([])

    await fs.promises.writeFile(
      path.join(dir, 'semantic-vectors.json'),
      JSON.stringify({
        version: '2',
        projectRoot: '/another/project',
        fingerprints: { model: { updatedAt: 1, vectors: { hash: [1] } } },
      }),
    )
    expect(await loadSemanticVectors(root, 'model')).toEqual([])
  })

  test('serializes concurrent metadata writes and preserves the newest snapshot', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-index-cas-'),
    )
    const base = {
      version: '2' as const,
      projectRoot: root,
      fileCount: 0,
      files: {},
      graph: { nodes: {}, edges: [] },
    }
    await Promise.all([
      saveIndex({ ...base, builtAt: 100 }, root),
      saveIndex({ ...base, builtAt: 200 }, root),
    ])
    expect((await loadIndex(root))?.builtAt).toBe(200)
  })

  test('supports compare-and-swap metadata persistence', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-index-explicit-cas-'),
    )
    const base = {
      version: '2' as const,
      projectRoot: root,
      fileCount: 0,
      files: {},
      graph: { nodes: {}, edges: [] },
    }
    expect(await saveIndex({ ...base, builtAt: 100 }, root)).toBe(true)
    expect(
      await saveIndex({ ...base, builtAt: 200 }, root, '.codebuff-index', {
        expectedBuiltAt: 50,
      }),
    ).toBe(false)
    expect((await loadIndex(root))?.builtAt).toBe(100)
    expect(
      await saveIndex({ ...base, builtAt: 200 }, root, '.codebuff-index', {
        expectedBuiltAt: 100,
      }),
    ).toBe(true)
    expect((await loadIndex(root))?.builtAt).toBe(200)
  })

  test('round-trips durable parse summaries and query accelerators', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-index-derived-data-'),
    )
    const file = {
      path: 'src/a.ts',
      mtime: 1,
      size: 1,
      hash: 'hash',
      ext: '.ts',
      symbols: ['alpha'],
      imports: [],
      headings: [],
      concepts: [],
    }
    await saveIndex(
      {
        version: '2',
        projectRoot: root,
        builtAt: 1,
        fileCount: 1,
        files: { 'src/a.ts': file },
        graph: { nodes: {}, edges: [] },
        parseData: {
          'src/a.ts': {
            identifiers: ['alpha'],
            calls: [],
            numLines: 1,
          },
        },
      },
      root,
    )

    const loaded = await loadIndex(root)
    expect(loaded?.parseData?.['src/a.ts']?.identifiers).toEqual(['alpha'])
    expect(loaded?.queryData?.postings.alpha).toEqual(['src/a.ts'])
  })

  test('reclaims a lock held by a dead process without waiting out the stale window', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-lock-dead-owner-'),
    )
    const dir = getIndexDir(root)
    await fs.promises.mkdir(dir, { recursive: true })
    // Find a PID that does not exist so isLockOwnerDead sees ESRCH. Start high
    // and walk down until process.kill(pid, 0) throws ESRCH.
    let deadPid = 0
    for (let candidate = 0x7fffffff; candidate > 1; candidate -= 111_113) {
      try {
        process.kill(candidate, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          deadPid = candidate
          break
        }
      }
    }
    expect(deadPid).toBeGreaterThan(1)
    // Mark the cache dir as owned so assertCacheOwnership does not reject the
    // now-non-empty directory (the lock file below makes it non-empty).
    await fs.promises.writeFile(
      path.join(dir, '.openbuff-index-owner'),
      'openbuff-index\n',
    )
    // Write a lock file with a fresh mtime (not stale by time) but owned by the
    // dead PID, so only the liveness check can reclaim it.
    const lockPath = path.join(dir, '.openbuff-index.lock')
    await fs.promises.writeFile(
      lockPath,
      `${deadPid}:00000000-0000-0000-0000-000000000000\n${Date.now()}\n`,
      'utf8',
    )

    const base = {
      version: '2' as const,
      projectRoot: root,
      fileCount: 0,
      files: {},
      graph: { nodes: {}, edges: [] },
    }
    const started = Date.now()
    expect(await saveIndex({ ...base, builtAt: 300 }, root)).toBe(true)
    // The reclaim must happen well inside the 10s lock-acquire timeout; a dead
    // owner should be detected immediately rather than after STALE_LOCK_MS.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect((await loadIndex(root))?.builtAt).toBe(300)
  })

  test('does not reclaim a lock owned by the current live process', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-lock-live-owner-'),
    )
    const dir = getIndexDir(root)
    await fs.promises.mkdir(dir, { recursive: true })
    // Mark the cache dir as owned so assertCacheOwnership does not reject the
    // now-non-empty directory (the lock file below makes it non-empty).
    await fs.promises.writeFile(
      path.join(dir, '.openbuff-index-owner'),
      'openbuff-index\n',
    )
    // A lock naming the current (live) PID must NOT be reclaimed by the
    // liveness check; saveIndex should block on it and time out rather than
    // steal an in-progress operation. Keep the mtime fresh so the stale-time
    // path also does not apply.
    const lockPath = path.join(dir, '.openbuff-index.lock')
    await fs.promises.writeFile(
      lockPath,
      `${process.pid}:00000000-0000-0000-0000-000000000000\n${Date.now()}\n`,
      'utf8',
    )
    const base = {
      version: '2' as const,
      projectRoot: root,
      fileCount: 0,
      files: {},
      graph: { nodes: {}, edges: [] },
    }
    await expect(saveIndex({ ...base, builtAt: 400 }, root)).rejects.toThrow(
      'Timed out waiting for index cache lock',
    )
  }, 15_000)

  test('merges concurrent semantic fingerprint writes under the cache lock', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-vector-lock-'),
    )
    await Promise.all([
      saveSemanticVectors(root, 'model-a', [
        { path: 'a.ts', embeddingHash: 'a', vector: [1] },
      ]),
      saveSemanticVectors(root, 'model-b', [
        { path: 'b.ts', embeddingHash: 'b', vector: [2] },
      ]),
    ])
    expect(await loadSemanticVectors(root, 'model-a')).toEqual([
      { embeddingHash: 'a', vector: [1] },
    ])
    expect(await loadSemanticVectors(root, 'model-b')).toEqual([
      { embeddingHash: 'b', vector: [2] },
    ])
  })

  test('verifies content-addressed snapshot via expectedSnapshotId', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-index-snapshot-'),
    )
    const file = {
      path: 'src/a.ts',
      mtime: 1,
      size: 1,
      hash: 'hash-a',
      ext: '.ts',
      symbols: ['alpha'],
      imports: [],
      headings: [],
      concepts: [],
    }
    const base = {
      version: '2' as const,
      projectRoot: root,
      fileCount: 1,
      files: { 'src/a.ts': file },
      graph: { nodes: {}, edges: [] },
    }
    expect(await saveIndex({ ...base, builtAt: 1 }, root)).toBe(true)

    // Omitted snapshot id returns the index.
    const loaded = await loadIndex(root)
    expect(loaded?.builtAt).toBe(1)
    expect(loaded?.files['src/a.ts']?.hash).toBe('hash-a')

    // Compute the expected content-addressed id via save/load round-trip
    // (same inputs as the persisted snapshot, no hardcoded hash).
    const expectedSnapshotId = createHash('sha256')
      .update(`2\0${root}\0unknown\0`)
      .update('src/a.ts')
      .update('\0')
      .update('hash-a')
      .digest('hex')

    const verified = await loadIndex(root, '.codebuff-index', {
      expectedSnapshotId,
    })
    expect(verified?.builtAt).toBe(1)
    expect(verified?.files['src/a.ts']?.hash).toBe('hash-a')

    // Mismatched snapshot id is a safe miss.
    expect(
      await loadIndex(root, '.codebuff-index', {
        expectedSnapshotId: '0'.repeat(64),
      }),
    ).toBeNull()

    // The same id no longer matches after content changes.
    expect(
      await saveIndex(
        {
          ...base,
          builtAt: 2,
          files: { 'src/a.ts': { ...file, hash: 'hash-b' } },
        },
        root,
      ),
    ).toBe(true)
    expect(await loadIndex(root)).not.toBeNull()
    expect(
      await loadIndex(root, '.codebuff-index', {
        expectedSnapshotId,
      }),
    ).toBeNull()
  })

  test('persists chunks.json sidecar atomically with metadata.json', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-index-sidecar-'),
    )
    // Old caches without a sidecar still load/rank: missing file is a safe miss.
    expect(await loadChunkSidecar(root)).toBeNull()
    const file = {
      path: 'src/a.ts',
      mtime: 1,
      size: 10,
      hash: 'hash-a',
      ext: '.ts',
      symbols: ['alpha'],
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
          hash: 'chunk-hash-a',
        },
      ],
    }
    const index = {
      version: '2' as const,
      projectRoot: root,
      builtAt: 1,
      fileCount: 1,
      files: { 'src/a.ts': file },
      graph: { nodes: {}, edges: [] },
    }
    expect(await saveIndex(index, root)).toBe(true)
    // Metadata still loads even though the sidecar is a new file.
    expect((await loadIndex(root))?.files['src/a.ts']?.hash).toBe('hash-a')
    const sidecar = await loadChunkSidecar(root)
    expect(sidecar?.version).toBe(CHUNK_SIDECAR_VERSION)
    expect(sidecar?.projectRoot).toBe(root)
    expect(sidecar?.snapshotId).toBe(computeIndexSnapshotId(index))
    expect(sidecar?.chunks['stable-a']).toEqual({
      file: 'src/a.ts',
      startLine: 1,
      endLine: 10,
      qualifiedName: 'A/run',
      kind: 'function',
      contentHash: 'chunk-hash-a',
    })
    // Deterministic derived document: same index rebuilds the same record.
    expect(buildChunkSidecarDocument(index).chunks).toEqual(sidecar?.chunks ?? {})
  })

  test('treats missing/invalid sidecars as safe misses and round-trips helpers', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-index-sidecar-invalid-'),
    )
    const dir = getIndexDir(root)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(path.join(dir, 'chunks.json'), '{not json')
    expect(await loadChunkSidecar(root)).toBeNull()
    await fs.promises.writeFile(
      path.join(dir, 'chunks.json'),
      JSON.stringify({
        version: 999,
        projectRoot: root,
        snapshotId: 'x',
        builtAt: 1,
        chunks: {},
      }),
    )
    expect(await loadChunkSidecar(root)).toBeNull()
    // saveChunkSidecar helper round-trips a validated document.
    const file = {
      path: 'src/a.ts',
      mtime: 1,
      size: 10,
      hash: 'hash-a',
      ext: '.ts',
      symbols: [],
      imports: [],
      headings: [],
      concepts: [],
      chunks: [
        {
          chunkId: 'chunk-a-0',
          stableChunkId: 'stable-helper',
          qualifiedName: 'A/run',
          kind: 'function',
          startLine: 2,
          endLine: 5,
          hash: 'chunk-hash-helper',
        },
      ],
    }
    const index = {
      version: '2' as const,
      projectRoot: root,
      builtAt: 7,
      fileCount: 1,
      files: { 'src/a.ts': file },
      graph: { nodes: {}, edges: [] },
    }
    await saveChunkSidecar(root, buildChunkSidecarDocument(index))
    expect((await loadChunkSidecar(root))?.chunks['stable-helper']?.contentHash).toBe(
      'chunk-hash-helper',
    )
  })
})
