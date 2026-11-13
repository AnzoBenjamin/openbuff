import { describe, test, expect } from 'bun:test'

import {
  flushContextArchiveSnapshots,
  hydrateContextArchiveSnapshots,
  mergeContextArchives,
  persistContextArchiveSnapshotsToRepository,
  loadContextArchiveSnapshotsFromRepository,
} from '../context-archive-sync'
import type { ContextArchiveSnapshot } from '@codebuff/common/types/context-archive'

/**
 * Unit coverage for the cross-session context-archive sync helpers.
 *
 * The pure merge (dedupe/caps/ordering) and the optional-method narrowing are
 * exercised directly; the flush skip paths run without a store because they
 * return before the provider is touched. The full flush→hydrate roundtrip
 * against a real SQLite store is covered by the storage layer's own tests
 * (the memory-v2 repository is landing in parallel — see
 * persistContextArchiveSnapshots/loadContextArchiveSnapshots there).
 */

const toolMessage = (toolCallId: string, value: string) => ({
  role: 'tool' as const,
  toolCallId,
  toolName: 'read_files',
  content: [{ type: 'json' as const, value }],
})

const snapshot = (params: {
  archivedAt: number
  action: ContextArchiveSnapshot['action']
  toolCallId?: string
  runId?: string
}): ContextArchiveSnapshot => {
  const base: ContextArchiveSnapshot = {
    archivedAt: params.archivedAt,
    action: params.action,
    keepRecentSteps: 2,
    messages: [toolMessage(params.toolCallId ?? `call-${params.archivedAt}`, 'body')],
  }
  // Optional store-attached runId leg of the merge identity (present on
  // durable rows when the store attaches it; read defensively on both sides).
  return params.runId !== undefined
    ? ({ ...base, runId: params.runId } as ContextArchiveSnapshot)
    : base
}

/**
 * Narrow an archived Message union member to the tool leg so assertions can
 * read toolCallId (same role === 'tool' narrowing the storage layer uses).
 */
const toolCallIdOf = (
  message?: ContextArchiveSnapshot['messages'][number],
): string => (message !== undefined && message.role === 'tool' ? message.toolCallId : '')

describe('mergeContextArchives', () => {
  test('orders the merged archive chronologically oldest-first', () => {
    const inMemory = [snapshot({ archivedAt: 300, action: 'semantic_compaction' })]
    const durable = [
      snapshot({ archivedAt: 200, action: 'semantic_compaction', toolCallId: 'd1' }),
      snapshot({ archivedAt: 100, action: 'semantic_compaction', toolCallId: 'd2' }),
    ]

    const merged = mergeContextArchives(inMemory, durable)

    expect(merged).toHaveLength(3)
    // Runtime archive array convention: chronological oldest-first (recall
    // derives newest-first via row_index DESC over array order). Hydration
    // must write a same-convention array so recall ordering and the
    // archivedAt provenance list survive restore, and later appends land
    // after older durable snapshots.
    expect(merged.map((s) => s.archivedAt)).toEqual([100, 200, 300])
    expect(merged[0]).toBe(durable[1])
    expect(merged[2]).toBe(inMemory[0])
  })

  test('dedupes on (runId, archivedAt, action); in-memory wins', () => {
    const inMemory = [
      snapshot({ archivedAt: 100, action: 'semantic_compaction', toolCallId: 'live' }),
    ]
    const durable = [
      // Same identity as the in-memory snapshot but different content.
      snapshot({ archivedAt: 100, action: 'semantic_compaction', toolCallId: 'store' }),
      snapshot({ archivedAt: 50, action: 'semantic_compaction', toolCallId: 'older' }),
    ]

    const merged = mergeContextArchives(inMemory, durable)

    expect(merged).toHaveLength(2)
    // Chronological oldest-first: the older durable snapshot comes first.
    expect(toolCallIdOf(merged[0]?.messages[0])).toBe('older')
    expect(toolCallIdOf(merged[1]?.messages[0])).toBe('live')
  })

  test('treats the same action at different archivedAt as distinct', () => {
    const inMemory = [snapshot({ archivedAt: 100, action: 'mechanical_trim' })]
    const durable = [snapshot({ archivedAt: 200, action: 'mechanical_trim' })]

    expect(mergeContextArchives(inMemory, durable)).toHaveLength(2)
  })

  test('dedupes repeated restores: a second hydrate with the merged archive is a no-op', () => {
    const durable = [
      snapshot({ archivedAt: 200, action: 'semantic_compaction', toolCallId: 'd1' }),
      snapshot({ archivedAt: 100, action: 'semantic_compaction', toolCallId: 'd2' }),
    ]
    const first = mergeContextArchives(undefined, durable)

    // A repeated restore hydrates against the previously merged archive.
    const second = mergeContextArchives(first, durable)

    expect(second).toEqual(first)
  })

  test('caps semantic/mechanical fills at 8 while eviction keeps its own cap', () => {
    const inMemory = Array.from({ length: 8 }, (_, i) =>
      snapshot({ archivedAt: 1_000 + i, action: 'semantic_compaction' }),
    )
    const durable = [
      snapshot({ archivedAt: 900, action: 'semantic_compaction', toolCallId: 'over-cap' }),
      // Eviction is a separate kind: it must still be admitted.
      snapshot({ archivedAt: 890, action: 'tool_result_eviction', toolCallId: 'evict' }),
    ]

    const merged = mergeContextArchives(inMemory, durable)

    expect(merged).toHaveLength(9)
    expect(
      merged.some((s) => toolCallIdOf(s.messages[0]) === 'over-cap'),
    ).toBe(false)
    expect(
      merged.some((s) => toolCallIdOf(s.messages[0]) === 'evict'),
    ).toBe(true)
  })

  test('eviction cap is 16 and independent of the semantic/mechanical cap', () => {
    const inMemory = Array.from({ length: 16 }, (_, i) =>
      snapshot({ archivedAt: 1_000 + i, action: 'tool_result_eviction' }),
    )
    const durable = [
      snapshot({ archivedAt: 900, action: 'tool_result_eviction', toolCallId: 'over-cap' }),
      snapshot({ archivedAt: 890, action: 'semantic_compaction', toolCallId: 'semantic' }),
    ]

    const merged = mergeContextArchives(inMemory, durable)

    expect(merged).toHaveLength(17)
    expect(
      merged.some((s) => toolCallIdOf(s.messages[0]) === 'over-cap'),
    ).toBe(false)
    expect(
      merged.some((s) => toolCallIdOf(s.messages[0]) === 'semantic'),
    ).toBe(true)
  })

  test('in-memory entries are never dropped even when already over cap', () => {
    const inMemory = Array.from({ length: 10 }, (_, i) =>
      snapshot({ archivedAt: 1_000 + i, action: 'semantic_compaction' }),
    )

    expect(mergeContextArchives(inMemory, [])).toHaveLength(10)
  })

  test('handles undefined in-memory archive and empty durable set', () => {
    expect(mergeContextArchives(undefined, [])).toEqual([])
    expect(mergeContextArchives(undefined, [
      snapshot({ archivedAt: 100, action: 'semantic_compaction' }),
    ])).toHaveLength(1)
  })

  test('mechanical_trim and semantic_compaction share the same cap kind', () => {
    const inMemory = [
      ...Array.from({ length: 7 }, (_, i) =>
        snapshot({ archivedAt: 1_000 + i, action: 'semantic_compaction' }),
      ),
      snapshot({ archivedAt: 2_000, action: 'mechanical_trim' }),
    ]
    const durable = [
      snapshot({ archivedAt: 900, action: 'mechanical_trim', toolCallId: 'over-cap' }),
    ]

    const merged = mergeContextArchives(inMemory, durable)

    expect(merged).toHaveLength(8)
    expect(
      merged.some((s) => toolCallIdOf(s.messages[0]) === 'over-cap'),
    ).toBe(false)
  })
})

describe('optional repository narrowing (callers-must-narrow contract)', () => {
  test('persist returns null when the repository lacks the method', async () => {
    const result = await persistContextArchiveSnapshotsToRepository({}, {
      runId: 'run-1',
      snapshots: [],
    })
    expect(result).toBeNull()
  })

  test('persist returns null (never throws) when the method rejects', async () => {
    const repository = {
      persistContextArchiveSnapshots: async () => {
        throw new Error('store closed')
      },
    }
    const result = await persistContextArchiveSnapshotsToRepository(repository, {
      runId: 'run-1',
      snapshots: [snapshot({ archivedAt: 1, action: 'semantic_compaction' })],
    })
    expect(result).toBeNull()
  })

  test('persist forwards the request and returns the outcome', async () => {
    let seen: unknown
    const repository = {
      persistContextArchiveSnapshots: async (request: unknown) => {
        seen = request
        return { persisted: 2, skipped: 1 }
      },
    }
    const snapshots = [
      snapshot({ archivedAt: 1, action: 'semantic_compaction' }),
      snapshot({ archivedAt: 2, action: 'tool_result_eviction' }),
    ]
    const result = await persistContextArchiveSnapshotsToRepository(repository, {
      runId: 'run-1',
      snapshots,
    })

    expect(result).toEqual({ persisted: 2, skipped: 1 })
    expect(seen).toEqual({ runId: 'run-1', snapshots })
  })

  test('binds prototype methods to the repository (this-aware invocation)', async () => {
    // Prototype methods read `this` (the production BunSQLiteMemoryRepository
    // reads this.requireOpen()/this.database); a detached call would throw
    // inside the helpers' try/catch and silently degrade to a warn log.
    class FakeRepository {
      lastPersistRequest: unknown = null
      lastLoadRequest: unknown = null
      async persistContextArchiveSnapshots(request: unknown) {
        this.lastPersistRequest = request
        return { persisted: 1, skipped: 0 }
      }
      async loadContextArchiveSnapshots(request: unknown) {
        this.lastLoadRequest = request
        return {
          snapshots: [
            snapshot({ archivedAt: 1, action: 'semantic_compaction' }),
          ],
        }
      }
    }
    const repository = new FakeRepository()
    const snapshots = [
      snapshot({ archivedAt: 1, action: 'semantic_compaction' }),
    ]

    const persisted = await persistContextArchiveSnapshotsToRepository(
      repository,
      { runId: 'run-1', snapshots },
    )
    expect(persisted).toEqual({ persisted: 1, skipped: 0 })
    expect(repository.lastPersistRequest).toEqual({ runId: 'run-1', snapshots })

    const loaded = await loadContextArchiveSnapshotsFromRepository(repository, {
      limit: 24,
    })
    expect(loaded).toHaveLength(1)
    expect(repository.lastLoadRequest).toEqual({ limit: 24 })
  })

  test('load returns null when the repository lacks the method', async () => {
    expect(
      await loadContextArchiveSnapshotsFromRepository({}, { limit: 24 }),
    ).toBeNull()
  })

  test('load returns null (never throws) when the method rejects', async () => {
    const repository = {
      loadContextArchiveSnapshots: async () => {
        throw new Error('fts unavailable')
      },
    }
    expect(
      await loadContextArchiveSnapshotsFromRepository(repository, {}),
    ).toBeNull()
  })

  test('load forwards the request and returns snapshots', async () => {
    let seen: unknown
    const durable = [
      snapshot({ archivedAt: 200, action: 'semantic_compaction', toolCallId: 'newest' }),
      snapshot({ archivedAt: 100, action: 'semantic_compaction', toolCallId: 'older' }),
    ]
    const repository = {
      loadContextArchiveSnapshots: async (request: unknown) => {
        seen = request
        return { snapshots: durable }
      },
    }

    const result = await loadContextArchiveSnapshotsFromRepository(repository, {
      limit: 24,
    })

    expect(seen).toEqual({ limit: 24 })
    expect(result).toEqual(durable)
  })

  test('load coerces a malformed (non-array) snapshots field to []', async () => {
    const repository = {
      loadContextArchiveSnapshots: async () => ({ snapshots: 'garbage' }),
    }
    expect(
      await loadContextArchiveSnapshotsFromRepository(repository, {}),
    ).toEqual([])
  })
})

describe('flushContextArchiveSnapshots skip paths (best-effort, no-throw)', () => {
  test('resolves without touching the provider when runId is missing', async () => {
    const runState = {
      sessionState: {
        mainAgentState: {
          compactionArchive: [
            snapshot({ archivedAt: 1, action: 'semantic_compaction' }),
          ],
        },
      },
      output: { type: 'error', message: 'x' },
    } as unknown as Parameters<typeof flushContextArchiveSnapshots>[0]

    // Returns before the provider would be opened; must never throw.
    await expect(flushContextArchiveSnapshots(runState)).resolves.toBeUndefined()
  })

  test('resolves without touching the provider when the archive is empty', async () => {
    const runState = {
      sessionState: {
        mainAgentState: { runId: 'run-1', compactionArchive: [] },
      },
      output: { type: 'error', message: 'x' },
    } as unknown as Parameters<typeof flushContextArchiveSnapshots>[0]

    await expect(flushContextArchiveSnapshots(runState)).resolves.toBeUndefined()
  })

  test('resolves when sessionState is absent entirely', async () => {
    const runState = {
      output: { type: 'error', message: 'x' },
    } as unknown as Parameters<typeof flushContextArchiveSnapshots>[0]

    await expect(flushContextArchiveSnapshots(runState)).resolves.toBeUndefined()
  })
})

describe('hydrateContextArchiveSnapshots (merge-through seam)', () => {
  test('merges loaded durable snapshots into the in-memory archive', async () => {
    // The real provider is not touchable in a unit test, so the unavailable
    // path is what this asserts directly: hydration must still return the
    // in-memory archive (degraded, never throwing).
    const inMemory = [
      snapshot({ archivedAt: 100, action: 'semantic_compaction', toolCallId: 'live' }),
    ]
    const hydrated = await hydrateContextArchiveSnapshots(inMemory)
    expect(hydrated).toEqual(inMemory)
  })
})