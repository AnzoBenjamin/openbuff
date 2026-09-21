import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, mock, test } from 'bun:test'

import { IndexManager } from './index-manager'
import { saveIndex } from './index-store'
import type { MetadataIndex } from './types'

const roots: string[] = []

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-p8degraded-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

/**
 * P8.1 regression: a parserDegraded refresh must keep the prior builtAt,
 * must NOT stamp the pending delta revision, and must re-queue the delta
 * exactly once so the next refresh converges.
 *
 * This test lives in its own file on purpose: it uses bun's mock.module,
 * whose registrations persist for the process lifetime (mock.restore() and
 * re-registration cannot reliably undo them for already-imported
 * consumers). Keeping it isolated guarantees no other test file — p8-lite,
 * metadata-indexer, or any later file in the same run — inherits the
 * mocked updateMetadataIndex.
 */
describe('P8.1 parserDegraded delta retention in IndexManager', () => {
  const PERSISTED_INDEX: MetadataIndex = {
    version: '2',
    projectRoot: '/placeholder',
    builtAt: 1,
    fileCount: 1,
    files: {
      'src/a.ts': {
        path: 'src/a.ts',
        mtime: 1,
        size: 1,
        hash: 'hash-a',
        ext: '.ts',
        symbols: [],
        imports: [],
        headings: [],
        concepts: [],
      },
    },
    graph: { nodes: {}, edges: [] },
  }

  test('re-queues a dropped delta once when updateMetadataIndex degrades, then converges', async () => {
    let callCount = 0
    // Local numeric-aware copy so the mock keeps revision semantics for the
    // manager's mergeMutationDeltas.
    const toRevision = (value: string | number | undefined) =>
      typeof value === 'number' ? value : Number.parseInt(value ?? '', 10)
    mock.module('./metadata-indexer', () => ({
      updateMetadataIndex: (
        existing: MetadataIndex,
        _root: string,
        _config: unknown,
        delta?: { revision?: string | number },
      ): MetadataIndex => {
        callCount += 1
        if (callCount === 1) {
          // Simulate a degraded parse: result is the prior snapshot, builtAt
          // kept untouched, delta NOT incorporated (parserDegraded flag).
          return { ...existing, parserDegraded: true }
        }
        // Second refresh incorporates the delta normally (a real
        // createMetadataIndex result never carries parserDegraded).
        const { parserDegraded: _dropped, ...rest } = existing
        void _dropped
        return {
          ...rest,
          builtAt: existing.builtAt + 1,
          workspaceRevision: delta?.revision,
        }
      },
      compareRevisions: (a?: string | number, b?: string | number) => {
        const x = toRevision(a)
        const y = toRevision(b)
        if (x === undefined || y === undefined) return 0
        return x < y ? -1 : x > y ? 1 : 0
      },
    }))

    const root = makeProject()
    // Seed the on-disk index so _build takes the updateMetadataIndex path.
    await saveIndex({ ...PERSISTED_INDEX, projectRoot: root }, root)

    const mgr = IndexManager.getInstance(root, {})
    mgr.markPathsChanged({
      changedPaths: ['src/a.ts'],
      complete: true,
      revision: 9,
    })
    await mgr.waitUntilReady(10_000)

    const internal = mgr as unknown as {
      index: MetadataIndex
      pendingMutationDelta?: {
        changedPaths?: string[]
        revision?: string | number
      }
      degradedDeltaRequeued?: boolean
      lastBuildError?: { message: string }
      forceRefresh?: boolean
    }
    // First refresh degraded: prior snapshot preserved (builtAt still 1),
    // revision NOT stamped, and the delta re-queued once.
    expect(internal.index.builtAt).toBe(1)
    expect(internal.index.parserDegraded).toBe(true)
    expect(internal.index.workspaceRevision).toBeUndefined()
    expect(internal.degradedDeltaRequeued).toBe(true)
    expect(internal.pendingMutationDelta?.revision).toBe(9)
    expect(internal.lastBuildError).toBeUndefined()

    // Second refresh applies the re-queued delta and clears the bound state.
    await mgr.waitUntilReady(10_000)
    expect(callCount).toBe(2)
    expect(internal.index.parserDegraded).toBeUndefined()
    expect(internal.index.workspaceRevision).toBe(9)
    expect(internal.pendingMutationDelta).toBeUndefined()
    expect(internal.degradedDeltaRequeued).toBe(false)
    expect(internal.forceRefresh).toBe(false)
  })
})
