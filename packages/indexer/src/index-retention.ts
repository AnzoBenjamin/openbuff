import { randomUUID } from 'node:crypto'

import {
  openIndexStorage,
  readGenerationReferences,
  INDEX_FACT_TABLES,
  type IndexGenerationManifest,
} from './durable-index-store'
import {
  indexStorageScope,
  queryAllIndexStorage,
  type IndexStorageKey,
  type IndexStoragePort,
  type IndexStorageRecord,
  type IndexStorageScope,
} from './storage-port'

interface RetentionLease {
  phase: 'idle' | 'collecting'
  ownerPid?: number
  token?: string
}

/** Publication must compare this version so collection cannot race a new head. */
export async function acquireIndexPublicationLease(
  store: IndexStoragePort,
  scope: IndexStorageScope,
): Promise<IndexStorageRecord<RetentionLease> | null> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const lease = await store.get<RetentionLease>({
      scope,
      table: 'state',
      key: 'retention-lease',
    })
    if (!lease || lease.value.phase === 'idle') return lease
    let dead = false
    if (Number.isInteger(lease.value.ownerPid) && lease.value.ownerPid! > 0) {
      try {
        process.kill(lease.value.ownerPid!, 0)
      } catch (error) {
        dead = (error as NodeJS.ErrnoException).code === 'ESRCH'
      }
    }
    if (dead) {
      // Only a proven dead process releases an interrupted collection. Age
      // alone cannot take over a paused/live owner.
      await store.batch({
        checks: [
          {
            scope,
            table: 'state',
            key: 'retention-lease',
            expectedVersion: lease.version,
          },
        ],
        puts: [
          {
            scope,
            table: 'state',
            key: 'retention-lease',
            value: { phase: 'idle' },
          },
        ],
      })
      continue
    }
    if (Date.now() >= deadline)
      throw new Error('Index retention owner requires recovery')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export interface IndexRetentionReport {
  collectedAt: number
  worktrees: number
  pinnedGenerations: number
  retainedGenerations: number
  retainedObjects: number
  removedGenerations: number
  removedReferences: number
  removedObjects: number
}

/** Pin a complete generation before another actor/context keeps its references. */
export async function pinIndexGeneration(
  projectRoot: string,
  generationId: string,
  ownerId: string,
  cacheDir = '.codebuff-index',
): Promise<boolean> {
  const { store, identity } = await openIndexStorage(projectRoot, cacheDir)
  const scope = indexStorageScope(identity)
  const objectScope = {
    repositoryId: scope.repositoryId,
    worktreeId: '@objects',
  }
  for (let attempt = 0; attempt < 64; attempt++) {
    const lease = await acquireIndexPublicationLease(store, objectScope)
    const manifest = await store.get<IndexGenerationManifest>({
      scope,
      table: 'generations',
      key: generationId,
    })
    if (!manifest) return false
    const references = await readGenerationReferences(
      store,
      scope,
      manifest.value,
    )
    const keys = Array.from(
      new Set(
        Array.from(references.values()).flatMap((table) =>
          Array.from(table.values()),
        ),
      ),
    )
    for (let offset = 0; offset < keys.length; offset += 256) {
      const expected = keys.slice(offset, offset + 256)
      const objects = await queryAllIndexStorage(store, {
        scope: objectScope,
        table: 'objects',
        keys: expected,
      })
      if (objects.length !== expected.length) return false
    }
    const result = await store.batch({
      checks: [
        {
          scope: objectScope,
          table: 'state',
          key: 'retention-lease',
          expectedVersion: lease?.version ?? null,
        },
      ],
      puts: [
        {
          scope,
          table: 'pins',
          key: ownerId,
          value: { generationId, createdAt: Date.now() },
        },
      ],
    })
    if (result.committed) return true
  }
  return false
}

export async function releaseIndexGenerationPin(
  projectRoot: string,
  ownerId: string,
  cacheDir = '.codebuff-index',
): Promise<void> {
  const { store, identity } = await openIndexStorage(projectRoot, cacheDir)
  const key = {
    scope: indexStorageScope(identity),
    table: 'pins',
    key: ownerId,
  }
  const pin = await store.get(key)
  if (pin)
    await store.batch({
      checks: [{ ...key, expectedVersion: pin.version }],
      deletes: [key],
    })
}

/**
 * Keep every worktree head, its last recovery generation, and explicit pins.
 * Immutable content shared by another worktree is traced before collection.
 */
export async function collectIndexGarbage(
  projectRoot: string,
  cacheDir = '.codebuff-index',
): Promise<IndexRetentionReport | null> {
  const { store, identity } = await openIndexStorage(projectRoot, cacheDir)
  const scope = indexStorageScope(identity)
  const objectScope = {
    repositoryId: scope.repositoryId,
    worktreeId: '@objects',
  }
  const observed = await acquireIndexPublicationLease(store, objectScope)
  const token = randomUUID()
  const claimed = await store.batch({
    checks: [
      {
        scope: objectScope,
        table: 'state',
        key: 'retention-lease',
        expectedVersion: observed?.version ?? null,
      },
    ],
    puts: [
      {
        scope: objectScope,
        table: 'state',
        key: 'retention-lease',
        value: { phase: 'collecting', token, ownerPid: process.pid },
      },
    ],
  })
  if (!claimed.committed) return null
  const leaseVersion = claimed.versions[0]!.version
  try {
    const registry = await queryAllIndexStorage<{ worktreeId: string }>(store, {
      scope: objectScope,
      table: 'worktrees',
    })
    const worktrees = new Set([
      scope.worktreeId,
      ...registry.map((row) => row.value.worktreeId),
    ])
    const retainedObjects = new Set<string>()
    const retained = new Map<string, Set<string>>()
    let pinnedGenerations = 0
    for (const worktreeId of worktrees) {
      const worktreeScope = { repositoryId: scope.repositoryId, worktreeId }
      const head = await store.get<{
        generationId: string
        parentGenerationId?: string
      }>({ scope: worktreeScope, table: 'state', key: 'head' })
      if (!head) continue
      const pins = await queryAllIndexStorage<{ generationId: string }>(store, {
        scope: worktreeScope,
        table: 'pins',
      })
      pinnedGenerations += pins.length
      const targets = new Set([
        head.value.generationId,
        ...pins.map((pin) => pin.value.generationId),
      ])
      if (head.value.parentGenerationId)
        targets.add(head.value.parentGenerationId)
      const required = new Set<string>()
      retained.set(worktreeId, required)
      for (const generationId of targets) {
        const manifest = await store.get<IndexGenerationManifest>({
          scope: worktreeScope,
          table: 'generations',
          key: generationId,
        })
        if (!manifest)
          throw new Error(
            'Missing retained index generation; collection refused',
          )
        const references = await readGenerationReferences(
          store,
          worktreeScope,
          manifest.value,
        )
        for (const table of references.values())
          for (const objectKey of table.values()) retainedObjects.add(objectKey)
        let ancestor: IndexGenerationManifest | undefined = manifest.value
        const visited = new Set<string>()
        while (ancestor) {
          if (visited.has(ancestor.generationId))
            throw new Error('Cyclic retained generation')
          visited.add(ancestor.generationId)
          required.add(ancestor.generationId)
          if (ancestor.checkpoint) break
          if (!ancestor.parentGenerationId)
            throw new Error('Missing retained generation checkpoint')
          ancestor = (
            await store.get<IndexGenerationManifest>({
              scope: worktreeScope,
              table: 'generations',
              key: ancestor.parentGenerationId,
            })
          )?.value
          if (!ancestor) throw new Error('Missing retained generation ancestor')
        }
      }
    }
    const report: IndexRetentionReport = {
      collectedAt: Date.now(),
      worktrees: worktrees.size,
      pinnedGenerations,
      retainedGenerations: Array.from(retained.values()).reduce(
        (sum, generations) => sum + generations.size,
        0,
      ),
      retainedObjects: retainedObjects.size,
      removedGenerations: 0,
      removedReferences: 0,
      removedObjects: 0,
    }
    const deletes: IndexStorageKey[] = []
    for (const [worktreeId, required] of retained) {
      const worktreeScope = { repositoryId: scope.repositoryId, worktreeId }
      for (const table of INDEX_FACT_TABLES) {
        const rows = await queryAllIndexStorage(store, {
          scope: worktreeScope,
          table,
        })
        for (const row of rows) {
          if (required.has(row.key.split('/')[0]!)) continue
          deletes.push({ scope: worktreeScope, table, key: row.key })
          report.removedReferences += 1
        }
      }
      for (const row of await queryAllIndexStorage(store, {
        scope: worktreeScope,
        table: 'generations',
      })) {
        if (required.has(row.key)) continue
        deletes.push({
          scope: worktreeScope,
          table: 'generations',
          key: row.key,
        })
        report.removedGenerations += 1
      }
    }
    for (const row of await queryAllIndexStorage(store, {
      scope: objectScope,
      table: 'objects',
    })) {
      if (retainedObjects.has(row.key)) continue
      deletes.push({ scope: objectScope, table: 'objects', key: row.key })
      report.removedObjects += 1
    }
    for (let offset = 0; offset < deletes.length; offset += 256) {
      const deleted = await store.batch({
        deletes: deletes.slice(offset, offset + 256),
      })
      if (!deleted.committed)
        throw new Error('Index retention delete batch refused')
    }
    await store.batch({
      puts: [{ scope, table: 'state', key: 'retention', value: report }],
    })
    return report
  } finally {
    await store.batch({
      checks: [
        {
          scope: objectScope,
          table: 'state',
          key: 'retention-lease',
          expectedVersion: leaseVersion,
        },
      ],
      puts: [
        {
          scope: objectScope,
          table: 'state',
          key: 'retention-lease',
          value: { phase: 'idle' },
        },
      ],
    })
  }
}
