import * as fs from 'node:fs/promises'
import { existsSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { buildMetadataIndex, updateMetadataIndex } from './metadata-indexer'
import { IndexManager } from './index-manager'
import {
  createEmbeddedIndexStorage,
  DirectoryIndexStorage,
} from './embedded-storage'
import {
  closeIndexStorage,
  getIndexStorageIdentity,
  getOpenIndexStorageCount,
  MAX_OPEN_INDEX_STORES,
  loadIndexGeneration,
  loadIndexMutationJournal,
  openIndexStorage,
  recordIndexMutation,
  saveIndexGeneration,
  stableIndexEdgeKey,
} from './durable-index-store'
import {
  computeIndexSnapshotId,
  getIndexPublicationToken,
  loadIndex,
  saveIndex,
  saveLegacyIndex,
  withCacheLock,
  MAX_METADATA_INDEX_BYTES,
} from './index-store'
import { queryIndex } from './query'
import {
  MAX_SCIP_LABEL_CHARS,
  mergeScipEdgesIntoIndex,
  parseScipJson,
  scipPreciseEdges,
} from './scip-ingest'
import { openRepositoryServiceStorage } from './repository-service-client'
import {
  collectIndexGarbage,
  pinIndexGeneration,
  releaseIndexGenerationPin,
} from './index-retention'
import {
  compareIndexStorageKeys,
  indexStorageScope,
  queryAllIndexStorage,
  setIndexStorageFactory,
  type IndexStoragePort,
} from './storage-port'
import type { IndexEdge, MetadataIndex } from './types'

const roots: string[] = []
const managers: IndexManager[] = []
const nativeExecutable = path.resolve(
  import.meta.dir,
  '../../../rust/target/debug/openbuff-intelligence',
)

async function fixture(extraFiles = 0): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'openbuff-generation-'))
  roots.push(root)
  await fs.mkdir(path.join(root, 'src'))
  await fs.writeFile(
    path.join(root, 'src/a.ts'),
    "import { helper } from './b'\nexport function start() { return helper() }\n",
  )
  await fs.writeFile(
    path.join(root, 'src/b.ts'),
    'export function helper() { return 1 }\n',
  )
  await fs.writeFile(
    path.join(root, 'README.md'),
    '# Repository generation\nDiscovery context.\n',
  )
  for (let index = 0; index < extraFiles; index++) {
    await fs.writeFile(
      path.join(root, `src/extra${index}.ts`),
      `export function extra${index}() { return ${index} }\n`,
    )
  }
  return root
}

test.each([false, true])(
  'cold durable identity refusal is write-free (git=%s)',
  async (git) => {
    const root = await fixture()
    if (git) await fs.mkdir(path.join(root, '.git'))
    const directory = path.join(root, '.codebuff-index')
    await fs.mkdir(directory)
    const lock = path.join(directory, '.openbuff-index.lock')
    const lockContents = '2147483647:abandoned-test-owner\n0\n'
    await fs.writeFile(lock, lockContents)
    await expect(getIndexStorageIdentity(root)).rejects.toThrow(
      'requires recovery',
    )
    expect(await fs.readdir(directory)).toEqual(['.openbuff-index.lock'])
    expect(await fs.readFile(lock, 'utf8')).toBe(lockContents)
    if (git) expect(await fs.readdir(path.join(root, '.git'))).toEqual([])
  },
)

function manager(root: string): IndexManager {
  const instance = IndexManager.getInstance(root)
  managers.push(instance)
  return instance
}

function newManager(root: string): IndexManager {
  const registry = (
    IndexManager as unknown as { instances: Map<string, IndexManager> }
  ).instances
  for (const [key, value] of registry) {
    if ((value as unknown as { projectRoot: string }).projectRoot === root)
      registry.delete(key)
  }
  return manager(root)
}

function precise(index: MetadataIndex): MetadataIndex {
  return mergeScipEdgesIntoIndex(index, [
    {
      from: 'file:src/a.ts',
      to: 'file:src/b.ts',
      type: 'references',
      weight: 0.9,
      label: 'scip:test/helper',
      confidence: 'precise',
    },
  ]).index
}

afterEach(async () => {
  for (const instance of managers.splice(0))
    await instance.waitUntilReconciled(10_000)
  for (const root of roots.splice(0)) {
    await closeIndexStorage(root)
    await fs.rm(root, { recursive: true, force: true })
  }
  setIndexStorageFactory(undefined)
})

describe('normalized immutable index generations', () => {
  test('keeps the historical durable key for an edge without an opaque identity', () => {
    const legacy: IndexEdge = {
      from: 'file:src/a.ts',
      to: 'file:src/b.ts',
      type: 'references',
      weight: 0.9,
      label: 'scip:test/helper',
      confidence: 'precise',
      producer: { name: 'scip', version: 'scip-json:1', sourceHashes: {} },
    }
    expect(stableIndexEdgeKey(legacy)).toBe(
      'dd6da5e42e2eb4fb76b39eddb85966793ce0f3e7a1fe71c6cf37f33cc82feceb',
    )
  })

  test('roundtrips distinct same-label SCIP edges and consumes both in reference queries', async () => {
    const root = await fixture()
    // No heuristic import/call edges to b.ts, so only SCIP can affect this score.
    await fs.writeFile(path.join(root, 'src/a.ts'), 'export const start = 1\n')
    const base = await buildMetadataIndex(root)
    const prefix = `scip-typescript npm pkg 1.0.0 ${'nested/'.repeat(24)}`
    const symbols = [`${prefix}one().`, `${prefix}two().`]
    const document = (
      relative_path: string,
      names: string[],
      symbol_roles: number,
    ) => ({
      relative_path,
      occurrences: names.map((symbol, line) => ({
        range: [line, 0, 1],
        symbol,
        symbol_roles,
      })),
    })
    const input = scipPreciseEdges(
      parseScipJson({
        documents: [
          document('src/b.ts', symbols, 1),
          document('src/a.ts', [symbols[1]!, ...symbols], 0),
        ],
      }),
    )
    const { index: enriched, edgesMerged } = mergeScipEdgesIntoIndex(
      base,
      input,
    )
    expect(edgesMerged).toBe(2)
    expect(
      mergeScipEdgesIntoIndex(enriched, [...input].reverse()).edgesMerged,
    ).toBe(0)
    const preciseEdges = enriched.graph.edges.filter(
      (edge) => edge.confidence === 'precise',
    )
    const [first, second] = preciseEdges
    expect(first?.label).toBe(prefix.slice(0, MAX_SCIP_LABEL_CHARS))
    expect(second?.label).toBe(first?.label)
    expect(stableIndexEdgeKey(first!)).not.toBe(stableIndexEdgeKey(second!))
    expect(
      stableIndexEdgeKey({ ...first!, label: 'another display label' }),
    ).toBe(stableIndexEdgeKey(first!))
    expect(await saveIndexGeneration(base, root)).toBe(true)
    expect(await saveIndexGeneration(enriched, root)).toBe(true)
    await closeIndexStorage(root)

    const reopened = (await loadIndexGeneration(root))!
    expect(reopened.graph.edges).toEqual(enriched.graph.edges)
    for (const endpoint of ['file:src/a.ts', 'file:src/b.ts']) {
      const indexes = reopened.queryData?.adjacency[endpoint] ?? []
      expect(
        indexes
          .map((i) => reopened.graph.edges[i])
          .filter((edge) => edge?.confidence === 'precise'),
      ).toEqual(preciseEdges)
    }
    for (const index of [enriched, reopened]) {
      expect(
        queryIndex(index, '', { mode: 'references', from: 'src/b.ts' }),
      ).toEqual([expect.objectContaining({ path: 'src/a.ts', score: 1.8 })])
    }
  })

  test.each(['normalized', 'json'] as const)(
    'refuses lossy %s SCIP projections and restores structural fallback',
    async (format) => {
      const root = await fixture(1)
      const base = await buildMetadataIndex(root)
      const attached = precise(base)
      const edge = attached.graph.edges.find(
        (candidate) => candidate.confidence === 'precise',
      )!
      const stale: IndexEdge = {
        ...edge,
        producer: { ...edge.producer!, version: 'scip-json:1' },
      }
      const legacy = {
        ...attached,
        graph: {
          ...attached.graph,
          edges: [
            ...attached.graph.edges.filter((candidate) => candidate !== edge),
            stale,
            { ...stale, to: 'file:src/extra0.ts' },
          ],
        },
      }
      if (format === 'json') {
        expect(await saveLegacyIndex(legacy, root)).toBe(true)
      } else {
        expect(await saveIndexGeneration(legacy, root)).toBe(true)
        expect(
          (await loadIndexGeneration(root))?.graph.edges.some(
            (candidate) => candidate.confidence === 'precise',
          ),
        ).toBe(false)
        await closeIndexStorage(root)
      }

      let discovery: MetadataIndex | undefined
      const reopened = (await loadIndexGeneration(root, undefined, {
        onDiscovery: (index) => {
          discovery = index
        },
      }))!
      for (const index of [reopened, discovery!]) {
        expect(
          index.graph.edges.some(
            (candidate) => candidate.confidence === 'precise',
          ),
        ).toBe(false)
        const fallback = index.graph.edges.find(
          (candidate) =>
            candidate.type === 'references' &&
            candidate.from === stale.from &&
            candidate.to === stale.to,
        )
        expect(fallback).toMatchObject({ label: './b' })
        expect(
          queryIndex(index, '', { mode: 'references', from: 'src/extra0.ts' }),
        ).toEqual([])
        expect(
          queryIndex(index, '', { mode: 'references', from: 'src/b.ts' })[0]
            ?.path,
        ).toBe('src/a.ts')
      }
    },
  )

  test('dependency and posting names matching object properties survive restart and updates', async () => {
    const root = await fixture()
    await fs.writeFile(
      path.join(root, 'src/b.ts'),
      'export function toString() { return hasOwnProperty() }\n',
    )
    const initial = await buildMetadataIndex(root)
    expect(
      initial.graphDependencies?.definitions['toString' as string],
    ).toEqual(['src/b.ts'])
    expect(
      initial.graphDependencies?.callers['hasOwnProperty' as string],
    ).toEqual(['src/b.ts'])
    await saveIndexGeneration(initial, root)
    await closeIndexStorage(root)
    const restored = await loadIndexGeneration(root)
    expect(
      restored?.graphDependencies?.definitions['toString' as string],
    ).toEqual(['src/b.ts'])
    expect(
      restored?.graphDependencies?.callers['hasOwnProperty' as string],
    ).toEqual(['src/b.ts'])
    expect(restored?.queryData?.postings.constructor).toBeUndefined()
    await fs.writeFile(
      path.join(root, 'src/b.ts'),
      'export function toString() { return valueOf() }\n',
    )
    const updated = await updateMetadataIndex(
      restored!,
      root,
      {},
      { changedPaths: ['src/b.ts'], complete: true },
    )
    expect(updated.graphDependencies?.callers.hasOwnProperty).toBeUndefined()
    expect(updated.graphDependencies?.callers['valueOf' as string]).toEqual([
      'src/b.ts',
    ])
  })

  test('precise producer edges survive no-change refresh and a new manager', async () => {
    const root = await fixture()
    const initial = precise(await buildMetadataIndex(root))
    expect(await saveIndex(initial, root)).toBe(true)
    const updated = await updateMetadataIndex(
      initial,
      root,
      {},
      { verifyContent: true },
    )
    expect(
      updated.graph.edges.filter((edge) => edge.confidence === 'precise'),
    ).toHaveLength(1)
    expect(updated.updateStats).toMatchObject({
      parsedFiles: 0,
      graphFilesUpdated: 0,
    })
    await closeIndexStorage(root)
    const instance = newManager(root)
    expect(await instance.waitUntilReconciled(10_000)).toBe(true)
    expect(
      instance
        .getSnapshot()
        ?.graph.edges.filter((edge) => edge.confidence === 'precise'),
    ).toHaveLength(1)
    expect(instance.getSnapshot()?.updateStats).toMatchObject({
      parsedFiles: 0,
      graphFilesUpdated: 0,
    })
    expect(instance.getStatus().freshness).toBe('verified')
  })

  test('publishes cached unverified discovery before deferred reconciliation', async () => {
    const root = await fixture()
    const initial = await buildMetadataIndex(root)
    await saveIndexGeneration(initial, root)
    await closeIndexStorage(root)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setIndexStorageFactory(async (options) => {
      const underlying = await createEmbeddedIndexStorage(options)
      return {
        protocolVersion: 1,
        get: (request) => underlying.get(request),
        query: async (request) => {
          if (request.table === 'journal') await gate
          return underlying.query(request)
        },
        batch: (request) => underlying.batch(request),
        stats: (request) => underlying.stats(request),
        close: () => underlying.close(),
      } satisfies IndexStoragePort
    })
    const instance = newManager(root)
    try {
      expect(await instance.waitUntilReady(500)).toBe(true)
      const cached = instance.query('helper')
      expect(cached.ready).toBe(true)
      expect(cached.results.some((result) => result.path === 'src/b.ts')).toBe(
        true,
      )
      expect(cached.status).toMatchObject({
        freshness: 'unverified',
        refreshing: true,
        stale: true,
      })
      expect(cached.snapshot?.freshness).toBe('unverified')
      expect(await instance.waitUntilReconciled(20)).toBe(false)
    } finally {
      release()
    }
    expect(await instance.waitUntilReconciled(10_000)).toBe(true)
    expect(instance.getStatus().freshness).toBe('verified')
  })

  test('one-file content change parses and updates one source with bounded writes', async () => {
    const root = await fixture(60)
    const instance = manager(root)
    await instance.waitUntilReconciled(10_000)
    const before = instance.getSnapshot()!
    const { store } = await openIndexStorage(root)
    const writesBefore = (await store.stats()).writes
    await fs.writeFile(
      path.join(root, 'src/b.ts'),
      'export function helper() { return 2 }\n',
    )
    instance.markPathsChanged({
      changedPaths: ['src/b.ts'],
      complete: true,
      revision: 1,
    })
    await instance.waitUntilReconciled(10_000)
    const after = instance.getSnapshot()!
    expect(after.updateStats).toMatchObject({
      hashedFiles: 1,
      parsedFiles: 1,
      graphFilesUpdated: 1,
      changedFiles: ['src/b.ts'],
    })
    expect(after.parseData?.['src/a.ts']).toBe(before.parseData?.['src/a.ts'])
    expect(after.graphData?.['src/a.ts']).toBe(before.graphData?.['src/a.ts'])
    expect((await store.stats()).writes - writesBefore).toBeLessThan(30)
    expect(after.updateStats?.persistenceWrites).toBeLessThan(30)
    expect(after.queryData?.postings.helper).toEqual(
      before.queryData?.postings.helper,
    )
    expect(after.indexedJournalCursor).toBe(1)
  })

  test('unrelated source changes preserve precise layers; dependencies invalidate them', async () => {
    const root = await fixture()
    const initial = precise(await buildMetadataIndex(root))
    await saveIndexGeneration(initial, root)
    await fs.writeFile(
      path.join(root, 'README.md'),
      '# Updated repository generation\n',
    )
    const unrelated = await updateMetadataIndex(
      initial,
      root,
      {},
      { changedPaths: ['README.md'], complete: true },
    )
    expect(
      unrelated.graph.edges.filter((edge) => edge.confidence === 'precise'),
    ).toHaveLength(1)
    await saveIndexGeneration(unrelated, root)
    await fs.writeFile(
      path.join(root, 'src/b.ts'),
      'export function changedHelper() { return 2 }\n',
    )
    const changed = await updateMetadataIndex(
      unrelated,
      root,
      {},
      { changedPaths: ['src/b.ts'], complete: true },
    )
    expect(
      changed.graph.edges.some((edge) => edge.confidence === 'precise'),
    ).toBe(false)
    expect(
      changed.graph.edges.some(
        (edge) =>
          edge.from === 'file:src/a.ts' &&
          edge.to === 'file:src/b.ts' &&
          edge.type === 'references',
      ),
    ).toBe(true)
    expect(
      changed.graph.edges.some(
        (edge) => edge.type === 'calls' && edge.label === 'helper',
      ),
    ).toBe(false)
    expect(changed.updateStats?.graphFilesUpdated).toBe(2)
  })

  test('compiler configuration invalidates precise producer data', async () => {
    const root = await fixture()
    await fs.writeFile(
      path.join(root, 'tsconfig.json'),
      '{"compilerOptions":{"strict":false}}\n',
    )
    const initial = precise(await buildMetadataIndex(root))
    await fs.writeFile(
      path.join(root, 'tsconfig.json'),
      '{"compilerOptions":{"strict":true}}\n',
    )
    const changed = await updateMetadataIndex(
      initial,
      root,
      {},
      { changedPaths: ['tsconfig.json'], complete: true },
    )
    expect(
      changed.graph.edges.some((edge) => edge.confidence === 'precise'),
    ).toBe(false)
    expect(changed.sourceConfigFingerprint).not.toBe(
      initial.sourceConfigFingerprint,
    )
  })

  test('known dirty paths rehash when mtime and size are identical', async () => {
    const root = await fixture()
    const source = path.join(root, 'src/b.ts')
    utimesSync(source, 1_700_000_000, 1_700_000_000)
    const before = await buildMetadataIndex(root)
    const stat = statSync(source)
    writeFileSync(source, 'export function helper() { return 2 }\n')
    utimesSync(source, stat.atimeMs / 1000, stat.mtimeMs / 1000)
    expect(statSync(source).mtimeMs).toBe(before.files['src/b.ts']!.mtime)
    expect(statSync(source).size).toBe(before.files['src/b.ts']!.size)
    const after = await updateMetadataIndex(
      before,
      root,
      {},
      { changedPaths: ['src/b.ts'], complete: true },
    )
    expect(after.files['src/b.ts']!.hash).not.toBe(
      before.files['src/b.ts']!.hash,
    )
    expect(after.updateStats?.hashedFiles).toBe(1)
  })

  test('imports legacy JSON without changing it or stripping parse objects at the old cap', async () => {
    const root = await fixture()
    const initial = precise(await buildMetadataIndex(root))
    await saveLegacyIndex(initial, root)
    const legacyPath = path.join(root, '.codebuff-index/metadata.json')
    const legacyBefore = await fs.readFile(legacyPath, 'utf8')
    const imported = await loadIndexGeneration(root)
    expect(imported?.parseData).toEqual(initial.parseData)
    expect(
      imported?.graph.edges.some((edge) => edge.confidence === 'precise'),
    ).toBe(true)
    expect(imported?.freshness).toBe('unverified')
    expect(await fs.readFile(legacyPath, 'utf8')).toBe(legacyBefore)
    const aboveOldCap = {
      ...imported!,
      builtAt: imported!.builtAt + 1,
      parseData: {
        ...imported!.parseData,
        'src/b.ts': {
          ...imported!.parseData!['src/b.ts']!,
          identifiers: ['large' + 'x'.repeat(MAX_METADATA_INDEX_BYTES)],
        },
      },
    }
    expect(await saveIndexGeneration(aboveOldCap, root)).toBe(true)
    await closeIndexStorage(root)
    const reloaded = await loadIndexGeneration(root)
    expect(reloaded?.parseData?.['src/b.ts']?.identifiers[0]?.length).toBe(
      MAX_METADATA_INDEX_BYTES + 5,
    )
    expect(reloaded?.queryData).toBeDefined()
  }, 20_000)

  test('publication CAS protects graph-only concurrent writers', async () => {
    const root = await fixture()
    const base = await buildMetadataIndex(root)
    await saveIndexGeneration(base, root)
    const token = getIndexPublicationToken(base)!
    const first = precise(base)
    const second = {
      ...base,
      graph: {
        ...base.graph,
        edges: [
          ...base.graph.edges,
          {
            from: 'file:src/b.ts',
            to: 'file:src/a.ts',
            type: 'references' as const,
            weight: 0.5,
            label: 'other-writer',
          },
        ],
      },
    }
    const results = await Promise.all(
      [first, second].map((index) =>
        saveIndexGeneration(index, root, '.codebuff-index', {
          expectedPublicationToken: token,
        }),
      ),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = await loadIndex(root)
    expect(getIndexPublicationToken(winner!)).not.toBe(token)
    expect(computeIndexSnapshotId(winner!)).toBe(computeIndexSnapshotId(base))
    expect(
      winner?.graph.edges.some((edge) => edge.confidence === 'precise') ||
        winner?.graph.edges.some((edge) => edge.label === 'other-writer'),
    ).toBe(true)
  })

  test('durable publication refuses a preserved abandoned cache lock', async () => {
    const root = await fixture()
    const base = await buildMetadataIndex(root)
    expect(await saveIndexGeneration(base, root)).toBe(true)
    const token = getIndexPublicationToken(base)!
    const lockPath = path.join(root, '.codebuff-index/.openbuff-index.lock')
    const lock = '2147483647:abandoned-test-owner\n0\n'
    const verified: boolean[] = []
    await fs.writeFile(lockPath, lock)
    await expect(
      saveIndexGeneration(precise(base), root, '.codebuff-index', {
        expectedPublicationToken: token,
        onVerifiedWrite: (value) => verified.push(value),
      }),
    ).rejects.toThrow('requires recovery')
    expect(verified).toEqual([false])
    expect(await fs.readFile(lockPath, 'utf8')).toBe(lock)
    expect(getIndexPublicationToken((await loadIndex(root))!)).toBe(token)
  })

  test('durable publication waits for a live cache holder', async () => {
    const root = await fixture()
    const base = await buildMetadataIndex(root)
    expect(await saveIndexGeneration(base, root)).toBe(true)
    const token = getIndexPublicationToken(base)!
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const acquired = new Promise<void>((resolve) => {
      entered = resolve
    })
    const holder = withCacheLock(
      path.join(root, '.codebuff-index'),
      async () => {
        entered()
        await gate
      },
    )
    let publication: Promise<boolean> | undefined
    try {
      await acquired
      let settled = false
      publication = saveIndexGeneration(
        precise(base),
        root,
        '.codebuff-index',
        {
          expectedPublicationToken: token,
        },
      ).finally(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(settled).toBe(false)
      expect(getIndexPublicationToken((await loadIndex(root))!)).toBe(token)
      release()
      await holder
      expect(await publication).toBe(true)
      expect(getIndexPublicationToken((await loadIndex(root))!)).not.toBe(token)
    } finally {
      release()
      await holder
      await publication?.catch(() => {})
    }
  })

  test('journals concurrent mutations durably and does not replay before a checkpoint', async () => {
    const root = await fixture()
    const sequences = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        recordIndexMutation(root, {
          changedPaths: [`src/file${index}.ts`],
          complete: true,
        }),
      ),
    )
    expect(new Set(sequences).size).toBe(12)
    await closeIndexStorage(root)
    const restored = await loadIndexMutationJournal(root, 6)
    expect(restored.map((entry) => entry.sequence)).toEqual([
      7, 8, 9, 10, 11, 12,
    ])
    const initial = {
      ...(await buildMetadataIndex(root)),
      indexedJournalCursor: 12,
    }
    await saveIndexGeneration(initial, root)
    expect(
      await loadIndexMutationJournal(root, initial.indexedJournalCursor),
    ).toEqual([])
  })

  test('root aliases reuse identity; copied caches cannot serve a different project', async () => {
    const root = await fixture()
    await saveIndexGeneration(await buildMetadataIndex(root), root)
    const identity = await getIndexStorageIdentity(root)
    const parent = await fs.mkdtemp(path.join(tmpdir(), 'openbuff-alias-'))
    roots.push(parent)
    await fs.symlink(root, path.join(parent, 'alias'))
    expect(
      await getIndexStorageIdentity(path.join(parent, 'alias')),
    ).toMatchObject({
      repositoryId: identity.repositoryId,
      worktreeId: identity.worktreeId,
    })
    const other = await fixture()
    await fs.cp(
      path.join(root, '.codebuff-index'),
      path.join(other, '.codebuff-index'),
      { recursive: true },
    )
    expect((await getIndexStorageIdentity(other)).repositoryId).not.toBe(
      identity.repositoryId,
    )
    expect(await loadIndexGeneration(other)).toBeNull()
  })

  test('checkpoint collection retains pinned generations and another worktree content', async () => {
    const root = await fixture()
    await fs.mkdir(path.join(root, '.git/worktrees/other'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.git/worktrees/other/commondir'),
      '../..\n',
    )
    const other = await fixture()
    await fs.writeFile(
      path.join(other, '.git'),
      `gitdir: ${path.join(root, '.git/worktrees/other')}\n`,
    )
    let current = await buildMetadataIndex(root)
    await saveIndexGeneration(current, root)
    const pinned = current.generationId!
    expect(await pinIndexGeneration(root, pinned, 'actor-packet')).toBe(true)
    const otherIndex = await buildMetadataIndex(other)
    await saveIndexGeneration(otherIndex, other)
    expect(otherIndex.repositoryId).toBe(current.repositoryId)
    expect(otherIndex.worktreeId).not.toBe(current.worktreeId)
    for (let generation = 1; generation <= 67; generation++) {
      await fs.writeFile(
        path.join(root, 'src/b.ts'),
        `export function helper() { return ${generation + 1} }\n`,
      )
      current = await updateMetadataIndex(
        current,
        root,
        {},
        { changedPaths: ['src/b.ts'], complete: true },
      )
      expect(await saveIndexGeneration(current, root)).toBe(true)
    }
    const report = await collectIndexGarbage(root)
    expect(report?.pinnedGenerations).toBe(1)
    expect(report?.retainedGenerations).toBeLessThan(40)
    const { store, identity } = await openIndexStorage(root)
    const scope = indexStorageScope(identity)
    expect(
      await store.get({ scope, table: 'generations', key: pinned }),
    ).not.toBeNull()
    await closeIndexStorage(root)
    await closeIndexStorage(other)
    expect((await loadIndexGeneration(root))?.files['src/b.ts']?.hash).toBe(
      current.files['src/b.ts']!.hash,
    )
    expect((await loadIndexGeneration(other))?.parseData).toEqual(
      otherIndex.parseData,
    )
    await releaseIndexGenerationPin(root, 'actor-packet')
    const unpinned = await collectIndexGarbage(root)
    expect(unpinned?.pinnedGenerations).toBe(0)
    expect(unpinned?.removedObjects).toBeGreaterThanOrEqual(0)
  }, 20_000)
})

async function unicodeContract(store: IndexStoragePort): Promise<void> {
  const scope = { repositoryId: 'unicode', worktreeId: 'types' }
  const keys = [
    'plain',
    '\ue000',
    '\u{10000}',
    '\u{10ffff}',
    '\u{10ffff}tail',
    'prefix\0a',
    'prefix\0b',
  ]
  const sorted = [...keys].sort(compareIndexStorageKeys)
  await store.batch({
    puts: keys.map((key) => ({ scope, table: 'unicode', key, value: key })),
  })
  expect(
    (
      await queryAllIndexStorage(store, { scope, table: 'unicode', limit: 2 })
    ).map((record) => record.key),
  ).toEqual(sorted)
  expect(
    (
      await queryAllIndexStorage(store, {
        scope,
        table: 'unicode',
        prefix: '\u{10ffff}',
        limit: 1,
      })
    ).map((record) => record.key),
  ).toEqual(['\u{10ffff}', '\u{10ffff}tail'])
  expect(
    (
      await queryAllIndexStorage(store, {
        scope,
        table: 'unicode',
        prefix: 'prefix\0',
        limit: 1,
      })
    ).map((record) => record.key),
  ).toEqual(['prefix\0a', 'prefix\0b'])
  expect(
    (
      await queryAllIndexStorage(store, {
        scope,
        table: 'unicode',
        keys: [...keys, 'plain', '\ue000'],
        limit: 2,
      })
    ).map((record) => record.key),
  ).toEqual(sorted)
}

async function numberRoundtripContract(store: IndexStoragePort): Promise<void> {
  const key = {
    scope: { repositoryId: 'numbers', worktreeId: 'roundtrip' },
    table: 'numbers',
    key: 'values',
  }
  // Filesystem mtime fractions previously drifted by one ULP through Rust's
  // default JSON parser, invalidating immutable content-object digests.
  const values = Array.from(
    { length: 1_000 },
    (_, index) => 1_700_000_000_000 + index / 97,
  )
  values.push(
    1.2345678901234567,
    1.0000000000000002,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    Math.PI,
    0.12345678901234568,
  )
  await store.batch({ puts: [{ ...key, value: values }] })
  expect((await store.get<number[]>(key))?.value).toEqual(values)
}

test('embedded and portable ports use UTF-8 Unicode pagination and exact prefixes', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'openbuff-unicode-port-'))
  roots.push(root)
  const sqlite = await createEmbeddedIndexStorage({
    directory: path.join(root, 'sqlite'),
    identity: {
      repositoryId: 'unicode',
      worktreeId: 'types',
      projectRoot: root,
    },
  })
  const directory = await DirectoryIndexStorage.open(
    path.join(root, 'directory'),
  )
  try {
    await unicodeContract(sqlite)
    await unicodeContract(directory)
    await numberRoundtripContract(sqlite)
    await numberRoundtripContract(directory)
  } finally {
    await sqlite.close()
    await directory.close()
  }
})

test('portable directory store preserves atomic CAS and restart records under Node', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'openbuff-node-index-'))
  roots.push(root)
  const project = path.join(root, 'project')
  await fs.mkdir(project)
  await fs.writeFile(
    path.join(project, 'README.md'),
    '# Node discovery compatibility\n',
  )
  const entrypoint = path.join(root, 'entry.ts')
  await fs.writeFile(
    entrypoint,
    `
    import { IndexManager } from ${JSON.stringify(path.join(import.meta.dir, 'index-manager.ts'))};
    import { openIndexStorage,closeIndexStorage } from ${JSON.stringify(path.join(import.meta.dir, 'durable-index-store.ts'))};
    const root=process.argv[2]!;
    const manager=IndexManager.getInstance(root);
    await manager.waitUntilReconciled(10000);
    const reply=manager.query('Node');
    const {store}=await openIndexStorage(root);
    console.log(JSON.stringify({ready:reply.ready,paths:reply.results.map(r=>r.path),backend:(await store.stats()).backend}));
    await closeIndexStorage(root);
  `,
  )
  const built = await Bun.build({
    entrypoints: [entrypoint],
    outdir: path.join(root, 'build'),
    target: 'node',
    format: 'esm',
    naming: '[name].mjs',
  })
  expect(built.success).toBe(true)
  for (let index = 0; index < 2; index++) {
    const process = Bun.spawn(['node', built.outputs[0]!.path, project], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = await new Response(process.stdout).text()
    const stderr = await new Response(process.stderr).text()
    expect(await process.exited).toBe(0)
    expect(stderr).not.toContain('Cannot find module bun:sqlite')
    expect(JSON.parse(output.trim())).toMatchObject({
      ready: true,
      paths: ['README.md'],
      backend: 'node-directory',
    })
  }
}, 20_000)

test('directory port arbitrates concurrent writers and recovers immutable records', async () => {
  const root = await fs.mkdtemp(
    path.join(tmpdir(), 'openbuff-directory-store-'),
  )
  roots.push(root)
  const first = await DirectoryIndexStorage.open(root)
  const second = await DirectoryIndexStorage.open(root)
  const key = {
    scope: { repositoryId: 'repository', worktreeId: 'worktree' },
    table: 'files',
    key: 'a',
  }
  const initial = await first.batch({
    checks: [{ ...key, expectedVersion: null }],
    puts: [{ ...key, value: 'one' }],
  })
  const version = initial.versions[0]!.version
  const updates = await Promise.all(
    [first, second].map((store, index) =>
      store.batch({
        checks: [{ ...key, expectedVersion: version }],
        puts: [{ ...key, value: index }],
      }),
    ),
  )
  expect(updates.filter((result) => result.committed)).toHaveLength(1)
  await first.close()
  await second.close()
  const restored = await DirectoryIndexStorage.open(root)
  expect(await restored.get(key)).toMatchObject({
    value: updates[0]!.committed ? 0 : 1,
  })
  await restored.close()
})

test('directory checkpoints bound physical history and preserve another active reader', async () => {
  const root = await fs.mkdtemp(
    path.join(tmpdir(), 'openbuff-directory-checkpoint-'),
  )
  roots.push(root)
  const writer = await DirectoryIndexStorage.open(root)
  const reader = await DirectoryIndexStorage.open(root)
  const scope = { repositoryId: 'repository', worktreeId: 'worktree' }
  const key = { scope, table: 'state', key: 'head' }
  const stableKey = { scope, table: 'objects', key: 'stable' }
  const initial = await writer.batch({
    puts: [
      { ...key, value: 0 },
      { ...stableKey, value: 'unchanged' },
    ],
  })
  expect(await reader.get(key)).toMatchObject({ value: 0 })
  for (let value = 1; value <= 132; value++) {
    await writer.batch({ puts: [{ ...key, value }] })
    if (value === 127) expect(await reader.get(key)).toMatchObject({ value })
  }
  expect(await reader.get(key)).toMatchObject({ value: 132 })
  expect(await reader.get(stableKey)).toMatchObject({
    version: initial.versions[1]!.version,
    value: 'unchanged',
  })
  expect(
    (await fs.readdir(path.join(root, 'transactions'))).length,
  ).toBeLessThan(10)
  expect((await fs.readdir(path.join(root, 'objects'))).length).toBeLessThan(10)
  expect(await reader.stats()).toMatchObject({
    records: 2,
    transactions: 133,
    writes: 134,
  })
  await writer.close()
  await reader.close()
  const restored = await DirectoryIndexStorage.open(root)
  expect(await restored.get(key)).toMatchObject({ value: 132 })
  expect(await restored.get(stableKey)).toMatchObject({
    version: initial.versions[1]!.version,
  })
  expect(await restored.stats()).toMatchObject({
    records: 2,
    transactions: 133,
    writes: 134,
  })
  await restored.close()
})

test('bounded open-store handles reopen safely for a caller holding an evicted port', async () => {
  const firstRoot = await fixture()
  const held = await openIndexStorage(firstRoot)
  const key = {
    scope: indexStorageScope(held.identity),
    table: 'state',
    key: 'held',
  }
  const put = await held.store.batch({ puts: [{ ...key, value: 'retained' }] })
  for (let index = 0; index < MAX_OPEN_INDEX_STORES; index++)
    await openIndexStorage(await fixture())
  expect(getOpenIndexStorageCount()).toBeLessThanOrEqual(MAX_OPEN_INDEX_STORES)
  expect(await held.store.get(key)).toMatchObject({
    value: 'retained',
    version: put.versions[0]!.version,
  })
  const reopened = await openIndexStorage(firstRoot)
  expect(await reopened.store.get(key)).toMatchObject({
    value: 'retained',
    version: put.versions[0]!.version,
  })
  expect(getOpenIndexStorageCount()).toBeLessThanOrEqual(MAX_OPEN_INDEX_STORES)
})

test.skipIf(!existsSync(nativeExecutable) || process.platform === 'win32')(
  'Rust restores canonical generation objects and precise layers after service restart',
  async () => {
    const root = await fixture()
    const serviceDirectory = path.join(root, '.service')
    await fs.mkdir(serviceDirectory, { mode: 0o700 })
    let child = spawn(nativeExecutable, ['--serve', serviceDirectory], {
      stdio: 'ignore',
    })
    const factory = () =>
      openRepositoryServiceStorage({
        directory: serviceDirectory,
        executable: nativeExecutable,
      })
    setIndexStorageFactory(factory)
    try {
      const initial = precise(await buildMetadataIndex(root))
      expect(await saveIndexGeneration(initial, root)).toBe(true)
      await closeIndexStorage(root)
      child.kill()
      if (child.exitCode === null)
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve())
        })
      await fs.rm(path.join(serviceDirectory, 'service.sock'), { force: true })
      child = spawn(nativeExecutable, ['--serve', serviceDirectory], {
        stdio: 'ignore',
      })
      const restored = await loadIndexGeneration(root)
      expect(restored?.parseData).toEqual(initial.parseData)
      expect(
        restored?.graph.edges.filter((edge) => edge.confidence === 'precise'),
      ).toHaveLength(1)
      expect(restored?.queryData?.postings.helper).toBeDefined()
      const { store, identity } = await openIndexStorage(root)
      expect((await store.stats()).backend).toBe('rust-sqlite')
      expect(
        (
          await queryAllIndexStorage(store, {
            scope: indexStorageScope(identity),
            table: 'generations',
          })
        ).length,
      ).toBe(1)
      await unicodeContract(store)
      await numberRoundtripContract(store)
    } finally {
      await closeIndexStorage(root)
      child.kill()
    }
  },
  20_000,
)
