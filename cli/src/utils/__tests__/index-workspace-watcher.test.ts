import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  __resetIndexWorkspaceWatchersForTests,
  classifyIndexWatchPath,
  ensureIndexWorkspaceWatcher,
  supportsRecursiveIndexWorkspaceWatcher,
} from '../index-workspace-watcher'
import {
  collectWatchableDirectories,
  startDirectoryIndexWatch,
} from '../index-dir-watch'

import type { IndexManager, IndexingConfig } from '@codebuff/indexer'
import type { DirectoryIndexWatchHandle } from '../index-dir-watch'

describe('index workspace watcher classification', () => {
  test('disables recursive watching for Bun on Linux to prevent descriptor exhaustion', () => {
    expect(
      supportsRecursiveIndexWorkspaceWatcher({
        platform: 'linux',
        bunVersion: '1.3.11',
      }),
    ).toBe(false)
    expect(supportsRecursiveIndexWorkspaceWatcher({ platform: 'linux' })).toBe(
      true,
    )
    expect(
      supportsRecursiveIndexWorkspaceWatcher({
        platform: 'darwin',
        bunVersion: '1.3.11',
      }),
    ).toBe(true)
  })

  test('classifies live files, deletions, ignored cache paths, and ambiguous directories', () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-index-watch-'),
    )
    fs.mkdirSync(path.join(projectRoot, 'src'))
    fs.writeFileSync(path.join(projectRoot, 'src', 'live.ts'), 'export {}\n')

    expect(
      classifyIndexWatchPath({ projectRoot, fileName: 'src/live.ts' }),
    ).toEqual({ kind: 'changed', path: 'src/live.ts' })
    expect(
      classifyIndexWatchPath({ projectRoot, fileName: 'src/deleted.ts' }),
    ).toEqual({ kind: 'deleted', path: 'src/deleted.ts' })
    expect(
      classifyIndexWatchPath({
        projectRoot,
        fileName: '.codebuff-index/index.json',
      }),
    ).toEqual({ kind: 'ignore' })
    expect(classifyIndexWatchPath({ projectRoot, fileName: 'src' })).toEqual({
      kind: 'ambiguous',
    })

    fs.rmSync(projectRoot, { recursive: true, force: true })
  })
})

describe('index directory watch pool', () => {
  // Mirrors the classification + auto-add/remove wiring inside
  // ensureIndexWorkspaceWatcher so the pool can be exercised directly.
  const startHarness = (projectRoot: string): {
    events: Array<{ kind: string; path?: string }>
    handle: DirectoryIndexWatchHandle
  } => {
    const events: Array<{ kind: string; path?: string }> = []
    const handle = startDirectoryIndexWatch({
      projectRoot,
      onRawEvent: (raw) => {
        const relativePath = path
          .relative(projectRoot, path.join(raw.dir, raw.fileName))
          .replace(/\\/g, '/')
          .replace(/^\.\//, '')
        const classified = classifyIndexWatchPath({
          projectRoot,
          fileName: relativePath,
        })
        if (classified.kind === 'ambiguous') {
          // A new directory appeared: watch it too, mirroring the wiring.
          const absolutePath = path.join(projectRoot, relativePath)
          try {
            if (
              fs.existsSync(absolutePath) &&
              fs.statSync(absolutePath).isDirectory()
            ) {
              handle.addDir(absolutePath)
            }
          } catch {
            // Raced with removal; classification already handled it.
          }
        } else if (classified.kind === 'deleted') {
          handle.removePrefix(path.join(projectRoot, classified.path))
        }
        events.push(classified)
      },
      onDegrade: () => events.push({ kind: 'degraded' }),
    })
    return { events, handle }
  }

  const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 5000,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return predicate()
  }

  // Workers start asynchronously, so a write landing before the watcher is up
  // would be missed; re-touch the target periodically until the event shows.
  const writeRetrying = (target: string, tick: number) => {
    try {
      fs.writeFileSync(target, `export {} // touch ${tick}\n`)
    } catch {
      // Best-effort touch; the polling loop keeps retrying.
    }
  }

  test('collects real directories, honoring ignores, caps, and symlinks', () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-dir-watch-scan-'),
    )
    try {
      fs.mkdirSync(path.join(projectRoot, 'src', 'nested', 'deep'), {
        recursive: true,
      })
      // Nested dirs named like top-level ignores must stay watched: the
      // recursive classifier ignores those names at the top level only.
      fs.mkdirSync(path.join(projectRoot, 'src', 'dist'), { recursive: true })
      fs.mkdirSync(path.join(projectRoot, 'src', 'build'), { recursive: true })
      fs.mkdirSync(path.join(projectRoot, 'src', 'node_modules'), {
        recursive: true,
      })
      fs.mkdirSync(path.join(projectRoot, 'node_modules', 'pkg'), {
        recursive: true,
      })
      fs.mkdirSync(path.join(projectRoot, '.git', 'objects'), {
        recursive: true,
      })
      fs.mkdirSync(path.join(projectRoot, '.codebuff-index', 'shards'), {
        recursive: true,
      })
      fs.symlinkSync(projectRoot, path.join(projectRoot, 'linked'), 'dir')

      const dirs = collectWatchableDirectories(projectRoot)
      expect(dirs[0]).toBe(projectRoot)
      expect(dirs).toContain(path.join(projectRoot, 'src'))
      expect(dirs).toContain(path.join(projectRoot, 'src', 'nested'))
      expect(dirs).toContain(path.join(projectRoot, 'src', 'nested', 'deep'))
      expect(dirs).toContain(path.join(projectRoot, 'src', 'dist'))
      expect(dirs).toContain(path.join(projectRoot, 'src', 'build'))
      expect(dirs).toContain(path.join(projectRoot, 'src', 'node_modules'))
      expect(dirs).not.toContain(path.join(projectRoot, 'node_modules'))
      expect(dirs).not.toContain(path.join(projectRoot, '.git'))
      expect(dirs).not.toContain(path.join(projectRoot, '.codebuff-index'))
      expect(dirs).not.toContain(path.join(projectRoot, 'linked'))

      expect(
        collectWatchableDirectories(projectRoot, { maxWatchers: 2 }),
      ).toEqual([projectRoot, path.join(projectRoot, 'src')])
      expect(collectWatchableDirectories(projectRoot, { maxDepth: 1 })).toEqual([
        projectRoot,
        path.join(projectRoot, 'src'),
      ])
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  // The repo runs on Linux, where real fs.watch events fire; skip elsewhere.
  test.skipIf(process.platform !== 'linux')(
    'forwards real change events from the worker pool',
    async () => {
      const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'openbuff-dir-watch-live-'),
      )
      fs.mkdirSync(path.join(projectRoot, 'src'))
      const { events, handle } = startHarness(projectRoot)
      try {
        const target = path.join(projectRoot, 'src', 'b.ts')
        writeRetrying(target, 0)
        let ticks = 0
        const sawChange = await waitFor(() => {
          if (++ticks % 10 === 0) writeRetrying(target, ticks)
          return events.some(
            (event) => event.kind === 'changed' && event.path === 'src/b.ts',
          )
        })
        expect(sawChange).toBe(true)
        expect(
          events.some((event) => event.kind === 'degraded'),
        ).toBe(false)
        expect(() => handle.close()).not.toThrow()
      } finally {
        handle.close()
        fs.rmSync(projectRoot, { recursive: true, force: true })
      }
    },
  )

  // The repo runs on Linux, where real fs.watch events fire; skip elsewhere.
  test.skipIf(process.platform !== 'linux')(
    'auto-watches new directories and reports files inside them',
    async () => {
      const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'openbuff-dir-watch-add-'),
      )
      fs.mkdirSync(path.join(projectRoot, 'src'))
      const { events, handle } = startHarness(projectRoot)
      try {
        fs.mkdirSync(path.join(projectRoot, 'src', 'newdir'))
        const target = path.join(projectRoot, 'src', 'newdir', 'c.ts')
        writeRetrying(target, 0)
        let ticks = 0
        const sawChange = await waitFor(() => {
          if (++ticks % 10 === 0) writeRetrying(target, ticks)
          return events.some(
            (event) =>
              event.kind === 'changed' && event.path === 'src/newdir/c.ts',
          )
        })
        expect(sawChange).toBe(true)
        expect(
          events.some((event) => event.kind === 'degraded'),
        ).toBe(false)
        expect(() => handle.close()).not.toThrow()
      } finally {
        handle.close()
        fs.rmSync(projectRoot, { recursive: true, force: true })
      }
    },
  )
})

describe('index workspace watcher root bound (P2-T9)', () => {
  const makeManager = () =>
    ({
      markStale: () => {},
      markPathsChanged: () => {},
    }) as unknown as IndexManager

  // Covers the eviction loop reached by BOTH branches: on Linux+Bun the
  // pool-backed branch returns early, so it must run its own eviction before
  // returning or a host watching many roots accumulates unbounded pools.
  test('evicts the oldest roots beyond MAX_WATCHED_ROOTS, including pool-backed roots', () => {
    const roots: string[] = []
    try {
      for (let i = 0; i < 6; i++) {
        const root = fs.mkdtempSync(
          path.join(os.tmpdir(), 'openbuff-root-cap-'),
        )
        roots.push(root)
        ensureIndexWorkspaceWatcher({
          projectRoot: root,
          config: {
            enabled: true,
            cacheDir: '.codebuff-index',
          } as unknown as IndexingConfig,
          manager: makeManager(),
        })
      }
      // Six roots were requested; the bound is 4, so exactly the two oldest
      // must have been evicted (their watchers/pools closed) before this.
      expect(__resetIndexWorkspaceWatchersForTests()).toBe(4)
    } finally {
      __resetIndexWorkspaceWatchersForTests()
      for (const root of roots) {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  })
})
