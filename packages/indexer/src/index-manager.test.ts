import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterAll, describe, expect, test } from 'bun:test'

import { IndexManager } from './index-manager'
import { MAX_INDEX_AGE_MS } from './index-store'
import type { EmbedFn } from './semantic'
import type { MetadataIndex } from './types'

const roots: string[] = []

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'openbuff-indexer-markstale-'))
  roots.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'auth.ts'),
    'export function loginUser() {}\n',
  )
  return root
}

function writePackageJson(root: string, scripts: Record<string, string>): void {
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ scripts }, null, 2)}\n`,
  )
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

describe('IndexManager.markStale', () => {
  test('exposes markStale without throwing and is idempotent', () => {
    // Disabled config keeps this hermetic (no filesystem walk/build).
    const mgr = IndexManager.getInstance(
      '/tmp/openbuff-indexer-test-markstale',
      {
        enabled: false,
      },
    )
    expect(typeof mgr.markStale).toBe('function')
    mgr.markStale()
    mgr.markStale()
    // A disabled manager never builds, so query stays not-ready.
    const result = mgr.query('anything')
    expect(result.ready).toBe(false)
    expect(result.results).toEqual([])
  })

  test('waitUntilReady resolves quickly for a disabled manager even after markStale', async () => {
    const mgr = IndexManager.getInstance(
      '/tmp/openbuff-indexer-test-markstale-2',
      {
        enabled: false,
      },
    )
    mgr.markStale()
    await mgr.waitUntilReady(50)
    expect(mgr.query('x').ready).toBe(false)
  })

  test('query serves a labeled last-known-good snapshot after markStale', async () => {
    const root = makeProject()
    const mgr = IndexManager.getInstance(root, {})
    await mgr.waitUntilReady(10_000)

    const ready = mgr.query('loginUser')
    expect(ready.ready).toBe(true)
    expect(ready.results.some((result) => result.path === 'src/auth.ts')).toBe(
      true,
    )

    mgr.markStale()
    const stale = mgr.query('loginUser')
    expect(stale.ready).toBe(true)
    expect(stale.results.some((result) => result.path === 'src/auth.ts')).toBe(
      true,
    )
    expect(stale.status.stale).toBe(true)
    expect(stale.totalIndexed).toBe(ready.totalIndexed)

    await mgr.waitUntilReady(10_000)
    expect(mgr.query('loginUser').ready).toBe(true)
  })

  test('query keeps serving a labeled stale snapshot while refresh is pending', async () => {
    const root = makeProject()
    const refreshGate = deferred()
    let embedCalls = 0
    let refreshEmbeddingStarted: (() => void) | undefined
    const refreshEmbedding = new Promise<void>((resolve) => {
      refreshEmbeddingStarted = resolve
    })
    const embed: EmbedFn = async (texts) => {
      embedCalls += 1
      if (embedCalls === 2) {
        refreshEmbeddingStarted?.()
        await refreshGate.promise
      }
      return texts.map(() => [1])
    }
    const mgr = IndexManager.getInstance(
      root,
      { semantic: { enabled: true } },
      embed,
    )
    await mgr.waitUntilReady(10_000)

    const ready = mgr.query('loginUser')
    expect(ready.ready).toBe(true)

    writeFileSync(
      join(root, 'src', 'auth.ts'),
      'export function loginUser() {}\nexport const changed = true\n',
    )
    mgr.markStale()
    const firstStale = mgr.query('loginUser')
    expect(firstStale.ready).toBe(true)
    expect(firstStale.status.stale).toBe(true)

    await refreshEmbedding
    const secondStale = mgr.query('loginUser')
    expect(secondStale.ready).toBe(true)
    expect(secondStale.status.stale).toBe(true)

    refreshGate.resolve()
    await mgr.waitUntilReady(10_000)
    expect(mgr.query('loginUser').ready).toBe(true)
  })

  test('command-mode queries refresh package script changes after markStale', async () => {
    const root = makeProject()
    writePackageJson(root, { typecheck: 'tsc --noEmit' })
    const mgr = IndexManager.getInstance(root, {})
    await mgr.waitUntilReady(10_000)

    const initial = mgr.query('typecheck lint', { mode: 'commands', limit: 3 })
    expect(initial.ready).toBe(true)
    expect(initial.results[0]?.path).toBe('package.json')
    expect(initial.results[0]?.matchedSnippets).toContain(
      'package script: typecheck=tsc --noEmit',
    )

    writePackageJson(root, { lint: 'eslint src --max-warnings=0' })
    const future = new Date(Date.now() + 5_000)
    utimesSync(join(root, 'package.json'), future, future)
    mgr.markStale()

    const stale = mgr.query('typecheck lint', { mode: 'commands', limit: 3 })
    expect(stale.ready).toBe(true)
    expect(stale.status.stale).toBe(true)
    expect(stale.results[0]?.matchedSnippets).toContain(
      'package script: typecheck=tsc --noEmit',
    )

    await mgr.waitUntilReady(10_000)
    const refreshed = mgr.query('typecheck lint', {
      mode: 'commands',
      limit: 3,
    })
    expect(refreshed.ready).toBe(true)
    expect(refreshed.results[0]?.path).toBe('package.json')
    expect(refreshed.results[0]?.matchedSnippets).toContain(
      'package script: lint=eslint src --max-warnings=0',
    )
    expect(refreshed.results[0]?.matchedSnippets).not.toContain(
      'package script: typecheck=tsc --noEmit',
    )
  })

  test('age-stale snapshots automatically schedule a background refresh', async () => {
    const root = makeProject()
    const mgr = IndexManager.getInstance(root, {})
    await mgr.waitUntilReady(10_000)
    writeFileSync(
      join(root, 'src', 'auth.ts'),
      'export function refreshedLogin() {}\n',
    )

    const internal = mgr as unknown as {
      index: MetadataIndex
      lastBuildAttempt: number
    }
    internal.index.builtAt = Date.now() - MAX_INDEX_AGE_MS - 1
    internal.lastBuildAttempt = 0

    const stale = mgr.query('loginUser')
    expect(stale.ready).toBe(true)
    expect(stale.status.stale).toBe(true)
    expect(stale.status.refreshing).toBe(true)

    await mgr.waitUntilReady(10_000)
    const refreshed = mgr.query('refreshedLogin')
    expect(
      refreshed.results.some((result) => result.path === 'src/auth.ts'),
    ).toBe(true)
  })

  test('accepts precise path deltas for incremental refreshes', async () => {
    const root = makeProject()
    const mgr = IndexManager.getInstance(root, {})
    await mgr.waitUntilReady(10_000)
    const before = mgr.query('loginUser')
    writeFileSync(
      join(root, 'src', 'auth.ts'),
      'export function deltaLogin() {}\n',
    )

    mgr.markPathsChanged({
      changedPaths: ['src/auth.ts'],
      complete: true,
      revision: 7,
    })
    expect(mgr.query('loginUser').status.stale).toBe(true)
    await mgr.waitUntilReady(10_000)
    const refreshed = mgr.query('deltaLogin')
    const result = refreshed.results.find(
      (candidate) => candidate.path === 'src/auth.ts',
    )
    expect(result?.indexedHash).toHaveLength(64)
    expect(refreshed.snapshot).toMatchObject({
      schemaVersion: 1,
      indexVersion: '2',
      workspaceRevision: 7,
    })
    expect(refreshed.snapshot?.snapshotId).toHaveLength(64)
    expect(refreshed.snapshot?.snapshotId).not.toBe(before.snapshot?.snapshotId)
  })

  test('exposes structured build failures instead of reporting an empty index', async () => {
    const root = makeProject()
    mkdirSync(join(root, '.custom-index'))
    writeFileSync(join(root, '.custom-index', 'owned-by-user.txt'), 'user data')
    const mgr = IndexManager.getInstance(root, { cacheDir: '.custom-index' })

    await mgr.waitUntilReady(10_000)
    const status = mgr.getStatus()
    expect(status.state).toBe('failed')
    expect(status.lastBuildError).toMatchObject({
      stage: 'persist',
      retryable: false,
    })
    expect(status.lastBuildError?.cachePath).toContain('.custom-index')
  })
})

describe('IndexManager.indexMutationEpoch', () => {
  test('starts at 0 and the getter returns a number', () => {
    // Disabled config keeps this hermetic (no filesystem walk/build), and a
    // unique instance key guarantees a fresh epoch.
    const mgr = IndexManager.getInstance('/tmp/openbuff-indexer-test-epoch-1', {
      enabled: false,
    })
    expect(typeof mgr.indexMutationEpoch).toBe('number')
    expect(mgr.indexMutationEpoch).toBe(0)
  })

  test('increments on every markStale call', () => {
    const mgr = IndexManager.getInstance('/tmp/openbuff-indexer-test-epoch-2', {
      enabled: false,
    })
    mgr.markStale()
    expect(mgr.indexMutationEpoch).toBe(1)
    mgr.markStale()
    expect(mgr.indexMutationEpoch).toBe(2)
  })

  test('increments on markPathsChanged and markStale alike', () => {
    const mgr = IndexManager.getInstance('/tmp/openbuff-indexer-test-epoch-3', {
      enabled: false,
    })
    mgr.markPathsChanged({
      changedPaths: ['src/auth.ts'],
      complete: true,
      revision: 1,
    })
    expect(mgr.indexMutationEpoch).toBe(1)
    mgr.markStale()
    expect(mgr.indexMutationEpoch).toBe(2)
    mgr.markPathsChanged({
      changedPaths: ['src/other.ts'],
      complete: true,
      revision: 2,
    })
    expect(mgr.indexMutationEpoch).toBe(3)
  })

  test('a detached instance advances its own epoch while forwarding to the singleton', () => {
    const key = '/tmp/openbuff-indexer-test-detached-epoch'
    const holder = IndexManager.getInstance(key, { enabled: false })

    // Overflow the bounded registry (MAX_INSTANCE_ROOTS = 8) so the holder is
    // evicted, then re-register the same key: the replacement becomes the
    // singleton and the holder is detached but still held by this test.
    for (let i = 0; i < 8; i++) {
      IndexManager.getInstance(
        `/tmp/openbuff-indexer-test-detached-epoch-${i}`,
        { enabled: false },
      )
    }
    const replacement = IndexManager.getInstance(key, { enabled: false })
    expect(replacement).not.toBe(holder)

    holder.markStale()
    // The detached holder's own epoch must advance (per-instance epoch
    // contract), not only the singleton's.
    expect(holder.indexMutationEpoch).toBe(1)
    // ...and the registered singleton still receives the mutation signal.
    expect(replacement.indexMutationEpoch).toBe(1)

    holder.markPathsChanged({
      changedPaths: ['src/auth.ts'],
      complete: true,
      revision: 1,
    })
    expect(holder.indexMutationEpoch).toBe(2)
    expect(replacement.indexMutationEpoch).toBe(2)
  })

  test('a detached holder never regresses its epoch after the singleton restarts', () => {
    const key = '/tmp/openbuff-indexer-test-detached-epoch-regress'
    const holder = IndexManager.getInstance(key, { enabled: false })
    // While the holder is the registered singleton, advance its own epoch.
    holder.markStale()
    holder.markStale()
    expect(holder.indexMutationEpoch).toBe(2)

    // Overflow the bounded registry so the holder is evicted, then
    // re-register the same key: the replacement singleton restarts at
    // epoch 0 while the detached holder keeps its accumulated epoch.
    for (let i = 0; i < 8; i++) {
      IndexManager.getInstance(
        `/tmp/openbuff-indexer-test-detached-epoch-regress-${i}`,
        { enabled: false },
      )
    }
    const replacement = IndexManager.getInstance(key, { enabled: false })
    expect(replacement).not.toBe(holder)
    expect(replacement.indexMutationEpoch).toBe(0)

    holder.markStale()
    // The forward still signals the restarted singleton...
    expect(replacement.indexMutationEpoch).toBe(1)
    // ...but the holder's monotonic epoch must never move backwards.
    expect(holder.indexMutationEpoch).toBe(3)

    holder.markPathsChanged({
      changedPaths: ['src/auth.ts'],
      complete: true,
      revision: 1,
    })
    expect(replacement.indexMutationEpoch).toBe(2)
    expect(holder.indexMutationEpoch).toBe(4)
  })
})

describe('IndexManager.detached holder forwarding', () => {
  test('a detached holder forwards readiness and queries to the registered singleton instead of building its own index', async () => {
    const root = makeProject()
    const holder = IndexManager.getInstance(root, {})

    // Overflow the bounded registry (MAX_INSTANCE_ROOTS = 8) so the holder is
    // evicted, then re-register the same key: the replacement becomes the
    // singleton and the holder is detached but still held by this test.
    for (let i = 0; i < 8; i++) {
      IndexManager.getInstance(
        `/tmp/openbuff-indexer-test-detached-build-loop-${i}`,
        { enabled: false },
      )
    }
    const replacement = IndexManager.getInstance(root, {})
    expect(replacement).not.toBe(holder)

    await replacement.waitUntilReady(10_000)

    writeFileSync(
      join(root, 'src', 'extra.ts'),
      'export function extraLogin() {}\n',
    )
    // The detached holder's mutation signal reaches the singleton...
    holder.markStale()
    // ...and readiness is forwarded, so the holder never runs its own _build
    // loop against the same cache directory (reliability finding
    // detached-index-manager-still-runs-own-build-loop).
    await holder.waitUntilReady(10_000)

    const internal = holder as unknown as {
      index: MetadataIndex | null
    }
    // No detached build loop: the holder's own index was never populated.
    expect(internal.index).toBeNull()

    // Queries are served from the registered singleton's fresh index.
    const result = holder.query('extraLogin')
    expect(result.ready).toBe(true)
    expect(
      result.results.some((candidate) => candidate.path === 'src/extra.ts'),
    ).toBe(true)
  })

  test('a detached holder merges its accumulated pending delta into the forwarded markPathsChanged signal', () => {
    const key = '/tmp/openbuff-indexer-test-detached-delta-merge'
    const holder = IndexManager.getInstance(key, { enabled: false })
    // Accumulate a delta while the holder is still the registered singleton.
    holder.markPathsChanged({
      changedPaths: ['src/auth.ts'],
      complete: true,
      revision: 1,
    })

    // Overflow the bounded registry so the holder is evicted, then
    // re-register the same key (reliability finding
    // detached-indexmanager-pending-delta-dropped-on-forward).
    for (let i = 0; i < 8; i++) {
      IndexManager.getInstance(
        `/tmp/openbuff-indexer-test-detached-delta-merge-${i}`,
        { enabled: false },
      )
    }
    const replacement = IndexManager.getInstance(key, { enabled: false })
    expect(replacement).not.toBe(holder)

    // The holder is now detached: this signal must carry BOTH the delta
    // accumulated before eviction and the new one to the singleton.
    holder.markPathsChanged({
      changedPaths: ['src/extra.ts'],
      complete: true,
      revision: 2,
    })

    const internal = replacement as unknown as {
      pendingMutationDelta: { changedPaths: string[] } | undefined
    }
    expect(internal.pendingMutationDelta?.changedPaths).toEqual(
      expect.arrayContaining(['src/auth.ts', 'src/extra.ts']),
    )
  })

  test('a detached holder forwards its pending delta to the singleton via ensureBuilt', () => {
    const key = '/tmp/openbuff-indexer-test-detached-delta-ensurebuilt'
    const holder = IndexManager.getInstance(key, { enabled: false })
    holder.markPathsChanged({
      changedPaths: ['src/auth.ts'],
      complete: true,
      revision: 1,
    })

    for (let i = 0; i < 8; i++) {
      IndexManager.getInstance(
        `/tmp/openbuff-indexer-test-detached-delta-ensurebuilt-${i}`,
        { enabled: false },
      )
    }
    const replacement = IndexManager.getInstance(key, { enabled: false })
    expect(replacement).not.toBe(holder)

    holder.ensureBuilt()

    // The singleton received the holder's queued delta (the disabled config
    // stops the singleton's own build before it consumes the delta, so the
    // forwarded signal stays observable here).
    const singletonInternal = replacement as unknown as {
      pendingMutationDelta: { changedPaths: string[] } | undefined
    }
    expect(singletonInternal.pendingMutationDelta?.changedPaths).toContain(
      'src/auth.ts',
    )
    // ...and the holder no longer holds it.
    const holderInternal = holder as unknown as {
      pendingMutationDelta: unknown
    }
    expect(holderInternal.pendingMutationDelta).toBeUndefined()
  })
})
