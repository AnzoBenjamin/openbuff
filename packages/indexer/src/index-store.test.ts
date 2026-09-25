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
  MAX_CARRIED_SEMANTIC_VECTORS,
  reclaimStaleLock,
  releaseOwnedLock,
  sanitizeIndexCacheDir,
  saveChunkSidecar,
  saveIndex,
  saveSemanticVectors,
  setWriteGitExclude,
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

  test('still unions concurrent same-fingerprint writes within the retention bound', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-vector-union-'),
    )
    await saveSemanticVectors(root, 'model-a', [
      { path: 'a.ts', embeddingHash: 'a', vector: [1] },
    ])
    await saveSemanticVectors(root, 'model-a', [
      { path: 'b.ts', embeddingHash: 'b', vector: [2] },
    ])

    const loaded = await loadSemanticVectors(root, 'model-a')
    expect(loaded).toHaveLength(2)
    expect(loaded.map((entry) => entry.embeddingHash).sort()).toEqual([
      'a',
      'b',
    ])
  })

  test('bounds the per-fingerprint union merge so superseded vectors are pruned', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-vector-bound-'),
    )
    // Simulate a long edit history: more distinct embedding hashes than the
    // carried-over retention bound.
    const history = []
    for (let i = 0; i < MAX_CARRIED_SEMANTIC_VECTORS + 50; i++) {
      history.push({
        path: `src/gen-${i}.ts`,
        embeddingHash: `hash-${i}`,
        vector: [i],
      })
    }
    await saveSemanticVectors(root, 'model-a', history)

    // A later save with a much smaller current index must prune the stale
    // carried-over hashes instead of retaining the full edit history
    // (reliability finding semantic-vector-union-merge-unbounded-growth).
    await saveSemanticVectors(root, 'model-a', [
      { path: 'src/current.ts', embeddingHash: 'hash-current', vector: [0] },
    ])

    const loaded = await loadSemanticVectors(root, 'model-a')
    expect(loaded.length).toBe(MAX_CARRIED_SEMANTIC_VECTORS + 1)
    // The oldest generation was pruned...
    expect(loaded.some((entry) => entry.embeddingHash === 'hash-0')).toBe(false)
    // ...the current index's vector survives...
    expect(loaded.some((entry) => entry.embeddingHash === 'hash-current')).toBe(
      true,
    )
    // ...and the most recent carried-over hashes are retained.
    expect(
      loaded.some(
        (entry) =>
          entry.embeddingHash === `hash-${MAX_CARRIED_SEMANTIC_VECTORS + 49}`,
      ),
    ).toBe(true)
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
    expect(buildChunkSidecarDocument(index).chunks).toEqual(
      sidecar?.chunks ?? {},
    )
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
    expect(await saveChunkSidecar(root, buildChunkSidecarDocument(index))).toBe(
      true,
    )
    expect(
      (await loadChunkSidecar(root))?.chunks['stable-helper']?.contentHash,
    ).toBe('chunk-hash-helper')
    // A validator-rejected sidecar returns false instead of silently dropping
    // the write, and prior valid content is left intact for the caller to
    // fall back to chunkId/inline chunks.
    const rejected = buildChunkSidecarDocument(index)
    const leakedEntry = { ...rejected.chunks['stable-helper']!, kind: '' }
    expect(
      await saveChunkSidecar(root, {
        ...rejected,
        chunks: { ...rejected.chunks, 'stable-bad': leakedEntry },
      }),
    ).toBe(false)
    expect((await loadChunkSidecar(root))?.chunks['stable-bad']).toBeUndefined()
  })

  test('generation CAS drops a stale vector write for the same fingerprint', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-vector-cas-'),
    )
    await saveSemanticVectors(root, 'model-a', [
      { path: 'a.ts', embeddingHash: 'a1', vector: [1] },
    ])
    const dir = getIndexDir(root)
    const readGeneration = async (): Promise<number | undefined> => {
      const parsed = JSON.parse(
        await fs.promises.readFile(
          path.join(dir, 'semantic-vectors.json'),
          'utf8',
        ),
      ) as {
        fingerprints?: Record<string, { updatedAt?: number }>
      }
      return parsed.fingerprints?.['model-a']?.updatedAt
    }
    const generation = await readGeneration()
    expect(typeof generation).toBe('number')

    // A parallel writer advances the generation first...
    await saveSemanticVectors(root, 'model-a', [
      { path: 'b.ts', embeddingHash: 'b1', vector: [2] },
    ])
    // ...then the stale writer (pinned to the pre-advance generation) must
    // lose: its vector is dropped and the newer one is preserved.
    await saveSemanticVectors(
      root,
      'model-a',
      [{ path: 'c.ts', embeddingHash: 'c1', vector: [3] }],
      '.codebuff-index',
      { expectedUpdatedAt: generation },
    )
    // The stale writer's c1 vector was CAS-dropped; the winning b1 write
    // union-merged with the pre-existing a1 vector (no-lost-updates), so the
    // store holds both surviving hashes.
    expect(
      (await loadSemanticVectors(root, 'model-a')).map((v) => v.embeddingHash),
    ).toEqual(['a1', 'b1'])
  })

  test('concurrent same-fingerprint vector writers merge without lost updates', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-vector-merge-'),
    )
    await Promise.all([
      saveSemanticVectors(root, 'model-a', [
        { path: 'a.ts', embeddingHash: 'h1', vector: [1] },
      ]),
      saveSemanticVectors(root, 'model-a', [
        { path: 'b.ts', embeddingHash: 'h2', vector: [2] },
      ]),
    ])
    // Union-merge under the lock means neither writer can erase the other's
    // freshly computed vectors.
    expect(
      (await loadSemanticVectors(root, 'model-a'))
        .map((v) => v.embeddingHash)
        .sort(),
    ).toEqual(['h1', 'h2'])
  })

  test('serializes large index artifacts compactly and small ones pretty', async () => {
    // Regression for the M4-S6 pretty-print finding: big data files must not
    // pay the ~2x byte/CPU cost of JSON.stringify(value, null, 2).
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-index-compact-'),
    )
    const bigFile = {
      path: 'src/big.ts',
      mtime: 1,
      size: 1,
      hash: 'hash-big',
      ext: '.ts',
      symbols: Array.from({ length: 400 }, (_, i) => `symbol${i}`),
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
        files: { 'src/big.ts': bigFile },
        graph: { nodes: {}, edges: [] },
      },
      root,
    )
    const rawIndex = await fs.promises.readFile(
      path.join(getIndexDir(root), 'metadata.json'),
      'utf8',
    )
    // Compact serialization: no pretty-printed indentation remains.
    expect(rawIndex.includes('\n  "')).toBe(false)
    // Still valid, still round-trips.
    expect((await loadIndex(root))?.files['src/big.ts']?.hash).toBe('hash-big')

    // A small document keeps the human-readable pretty format.
    await saveChunkSidecar(root, {
      version: CHUNK_SIDECAR_VERSION,
      snapshotId: 's',
      builtAt: 1,
      projectRoot: root,
      chunks: {},
    })
    const rawSidecar = await fs.promises.readFile(
      path.join(getIndexDir(root), 'chunks.json'),
      'utf8',
    )
    expect(rawSidecar.includes('\n  "')).toBe(true)
  })

  test('does not write .git/info/exclude by default and honors the per-root opt-in', async () => {
    // Regression for the M4-S6 git-exclude finding: the unadvertised git
    // metadata side effect must be opt-in, not opt-out, and the toggle must
    // be scopeable per project root.
    // Reset the module-global toggle first: bun runs every test file in one
    // process, and a sibling suite enabling the toggle would otherwise break
    // this default-off assertion (same cross-file test-bleed class fixed
    // across the sdk/cli/agents suites).
    setWriteGitExclude(false)
    const rootA = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-gitexclude-a-'),
    )
    const rootB = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-gitexclude-b-'),
    )
    for (const root of [rootA, rootB]) {
      await fs.promises.mkdir(path.join(root, '.git', 'info'), {
        recursive: true,
      })
    }
    const excludePathA = path.join(rootA, '.git', 'info', 'exclude')
    const excludePathB = path.join(rootB, '.git', 'info', 'exclude')
    await fs.promises.writeFile(excludePathA, 'original-a\n')
    await fs.promises.writeFile(excludePathB, 'original-b\n')

    // Default (no opt-in): no write at all, not even a read.
    await saveIndex(
      {
        version: '2',
        projectRoot: rootA,
        builtAt: 1,
        fileCount: 0,
        files: {},
        graph: { nodes: {}, edges: [] },
      },
      rootA,
    )
    expect(await fs.promises.readFile(excludePathA, 'utf8')).toBe(
      'original-a\n',
    )

    // Per-root opt-in writes only that root.
    setWriteGitExclude(true, rootB)
    try {
      await saveIndex(
        {
          version: '2',
          projectRoot: rootB,
          builtAt: 1,
          fileCount: 0,
          files: {},
          graph: { nodes: {}, edges: [] },
        },
        rootB,
      )
      const contentB = await fs.promises.readFile(excludePathB, 'utf8')
      expect(contentB).toContain('original-b\n')
      expect(contentB).toContain('/.codebuff-index/')
    } finally {
      setWriteGitExclude(false, rootB)
    }
    // rootA stayed untouched throughout.
    expect(await fs.promises.readFile(excludePathA, 'utf8')).toBe(
      'original-a\n',
    )
  })
})

describe('reclaimStaleLock', () => {
  const makeLockPath = async (prefix: string): Promise<string> =>
    path.join(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix)),
      '.openbuff-index.lock',
    )

  test('deletes a lock whose content still matches the stale snapshot', async () => {
    const lockPath = await makeLockPath('openbuff-reclaim-match-')
    const staleContent = '424242:00000000-0000-0000-0000-000000000000\n1\n'
    await fs.promises.writeFile(lockPath, staleContent, 'utf8')
    expect(await reclaimStaleLock(lockPath, staleContent)).toBe(true)
    await expect(fs.promises.readFile(lockPath, 'utf8')).rejects.toThrow(
      'ENOENT',
    )
  })

  test('leaves a re-acquired lock intact when its content no longer matches', async () => {
    const lockPath = await makeLockPath('openbuff-reclaim-fresh-')
    const staleContent = '424242:00000000-0000-0000-0000-000000000000\n1\n'
    // A competing waiter reclaimed the stale lock and re-acquired it with a
    // fresh owner token before this waiter's reclaim ran.
    const freshContent = `${process.pid}:11111111-1111-1111-1111-111111111111\n${Date.now()}\n`
    await fs.promises.writeFile(lockPath, staleContent, 'utf8')
    await fs.promises.writeFile(lockPath, freshContent, 'utf8')

    expect(await reclaimStaleLock(lockPath, staleContent)).toBe(false)
    // The fresh holder's lock file must survive the losing waiter's reclaim.
    expect(await fs.promises.readFile(lockPath, 'utf8')).toBe(freshContent)
  })

  test('reports success for an already-reclaimed (missing) lock', async () => {
    const lockPath = await makeLockPath('openbuff-reclaim-gone-')
    expect(await reclaimStaleLock(lockPath, 'gone\n')).toBe(true)
  })

  test('leaves no reclaim scratch files behind after a matched reclaim', async () => {
    const lockPath = await makeLockPath('openbuff-reclaim-clean-')
    const staleContent = '424242:00000000-0000-0000-0000-000000000000\n1\n'
    await fs.promises.writeFile(lockPath, staleContent, 'utf8')
    expect(await reclaimStaleLock(lockPath, staleContent)).toBe(true)
    expect(
      fs
        .readdirSync(path.dirname(lockPath))
        .filter((name) => name.includes('.reclaim.')),
    ).toEqual([])
  })

  test('restores a displaced fresh lock byte-for-byte when the namespace frees up', async () => {
    const lockPath = await makeLockPath('openbuff-reclaim-restore-')
    const staleContent = '424242:00000000-0000-0000-0000-000000000000\n1\n'
    const freshContent = `${process.pid}:22222222-2222-2222-2222-222222222222\n${Date.now()}\n`
    await fs.promises.writeFile(lockPath, freshContent, 'utf8')

    expect(await reclaimStaleLock(lockPath, staleContent)).toBe(false)
    // The displaced live lock was moved back atomically: no scratch copies of
    // a live holder's lock remain in the directory.
    expect(await fs.promises.readFile(lockPath, 'utf8')).toBe(freshContent)
    expect(
      fs
        .readdirSync(path.dirname(lockPath))
        .filter((name) => name.includes('.reclaim.')),
    ).toEqual([])
  })

  test('removes the displaced scratch lock when the restore races a newer waiter', async () => {
    const lockPath = await makeLockPath('openbuff-reclaim-leak-')
    const staleContent = '424242:00000000-0000-0000-0000-000000000000\n1\n'
    const freshContent = `${process.pid}:33333333-3333-3333-3333-333333333333\n${Date.now()}\n`
    // The competing waiter re-acquired with a fresh owner token before this
    // waiter's reclaim ran, so the displaced copy can never match.
    await fs.promises.writeFile(lockPath, freshContent, 'utf8')

    // Simulate the newer waiter still holding the lock path at restore time:
    // link fails atomically with EEXIST, so the displaced copy cannot go back
    // and the losing waiter must clean up its own scratch.
    const originalLink = fs.promises.link
    fs.promises.link = (async (
      existingPath: string,
      newPath: string,
    ): Promise<void> => {
      if (newPath === lockPath) {
        await fs.promises.writeFile(lockPath, freshContent, 'utf8')
        const error = new Error(
          'EEXIST: simulated newer waiter holds the lock path',
        ) as NodeJS.ErrnoException
        error.code = 'EEXIST'
        throw error
      }
      return originalLink(existingPath, newPath)
    }) as typeof fs.promises.link
    try {
      expect(await reclaimStaleLock(lockPath, staleContent)).toBe(false)
    } finally {
      fs.promises.link = originalLink
    }

    // The newer waiter's lock survived...
    expect(await fs.promises.readFile(lockPath, 'utf8')).toBe(freshContent)
    // ...and the losing waiter left no `.reclaim.*` scratch behind.
    expect(
      fs
        .readdirSync(path.dirname(lockPath))
        .filter((name) => name.includes('.reclaim.')),
    ).toEqual([])
  })
})

describe('releaseOwnedLock', () => {
  const makeLockPath = async (prefix: string): Promise<string> =>
    path.join(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix)),
      '.openbuff-index.lock',
    )

  test('deletes the lock when the displaced bytes still hold our token', async () => {
    const lockPath = await makeLockPath('openbuff-release-match-')
    const ownerToken = '424242:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    await fs.promises.writeFile(lockPath, `${ownerToken}\n1\n`, 'utf8')

    await releaseOwnedLock(lockPath, ownerToken)

    await expect(fs.promises.readFile(lockPath, 'utf8')).rejects.toThrow(
      'ENOENT',
    )
    expect(
      fs
        .readdirSync(path.dirname(lockPath))
        .filter((name) => name.includes('.release.')),
    ).toEqual([])
  })

  test("restores a competing waiter's re-acquired lock instead of deleting it", async () => {
    // The finding's race: our mtime aged out (silent heartbeat utimes
    // failure), a waiter reclaimed the lock and re-acquired it with a fresh
    // token, and only then did our release run. The release must not delete
    // the waiter's live lock.
    const lockPath = await makeLockPath('openbuff-release-race-')
    const staleToken = '424242:00000000-0000-0000-0000-000000000000'
    const freshContent = `${process.pid}:44444444-4444-4444-4444-444444444444\n${Date.now()}\n`
    await fs.promises.writeFile(lockPath, freshContent, 'utf8')

    await releaseOwnedLock(lockPath, staleToken)

    expect(await fs.promises.readFile(lockPath, 'utf8')).toBe(freshContent)
    expect(
      fs
        .readdirSync(path.dirname(lockPath))
        .filter((name) => name.includes('.release.')),
    ).toEqual([])
  })

  test('treats an already-reclaimed (missing) lock as released', async () => {
    const lockPath = await makeLockPath('openbuff-release-gone-')
    await expect(
      releaseOwnedLock(lockPath, '424242:00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined()
  })
})
