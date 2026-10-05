import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
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
  createBoundedWarnLatch,
  createWorkerSupervisor,
  startDirectoryIndexWatch,
} from '../index-dir-watch'
import { isDirAtOrUnderPrefix } from '../index-dir-watch-worker'

import type { IndexManager, IndexingConfig } from '@codebuff/indexer'
import type {
  DirectoryIndexWatchHandle,
  DirectoryWatchWorkerLike,
} from '../index-dir-watch'
import type {
  DirectoryWatchWorkerInbound,
  DirectoryWatchWorkerOutbound,
} from '../index-dir-watch-worker'

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

describe('index dir watch pool warnings + restart (P2-T9 audit fixes)', () => {
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

  const createFakeSpawner = () => {
    const fakes: Array<{
      emitter: EventEmitter
      posted: DirectoryWatchWorkerInbound[]
    }> = []
    const spawn = (): DirectoryWatchWorkerLike => {
      const entry = {
        emitter: new EventEmitter(),
        posted: [] as DirectoryWatchWorkerInbound[],
      }
      fakes.push(entry)
      return {
        on: (
          event: string,
          listener: (...args: unknown[]) => void,
        ) => entry.emitter.on(event, listener as never),
        postMessage: (message: DirectoryWatchWorkerInbound) => {
          entry.posted.push(message)
        },
        terminate: () => Promise.resolve(1),
        unref: () => {},
      }
    }
    return { fakes, spawn }
  }

  test('warn latch logs once per key and stays bounded', () => {
    const messages: string[] = []
    const latch = createBoundedWarnLatch(
      (_data, msg) => {
        messages.push(msg)
      },
      2,
    )
    for (let i = 0; i < 5; i++) latch('dir-a', {}, 'watch failed: dir-a')
    latch('dir-b', {}, 'watch failed: dir-b')
    // Beyond the bound: dropped silently, the age sweep still covers it.
    latch('dir-c', {}, 'watch failed: dir-c')
    expect(messages).toEqual(['watch failed: dir-a', 'watch failed: dir-b'])
  })

  test('remove-prefix helper matches both separator styles', () => {
    expect(isDirAtOrUnderPrefix('/repo/src', '/repo')).toBe(true)
    expect(isDirAtOrUnderPrefix('/repo', '/repo')).toBe(true)
    expect(isDirAtOrUnderPrefix('/repo/src/nested', '/repo/src')).toBe(true)
    expect(isDirAtOrUnderPrefix('\\repo\\src', '\\repo')).toBe(true)
    expect(isDirAtOrUnderPrefix('\\repo\\src', '/repo')).toBe(true)
    expect(isDirAtOrUnderPrefix('/repository', '/repo')).toBe(false)
    expect(isDirAtOrUnderPrefix('/repo/srcx', '/repo/src')).toBe(false)
    expect(isDirAtOrUnderPrefix('/repo/other', '/repo/src')).toBe(false)
  })

  test('fd-cap drops surface one warning per root, not per event', async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-dir-watch-cap-'),
    )
    try {
      fs.mkdirSync(path.join(projectRoot, 'a'))
      fs.mkdirSync(path.join(projectRoot, 'b'))
      fs.mkdirSync(path.join(projectRoot, 'c'))
      const capWarnings: Array<Record<string, unknown>> = []
      let degrades = 0
      const handle = startDirectoryIndexWatch({
        projectRoot,
        maxWatchers: 2,
        onRawEvent: () => {},
        onDegrade: () => {
          degrades++
        },
        onWarn: (data, msg) => {
          if (msg.includes('fd cap')) capWarnings.push(data)
        },
      })
      try {
        // The initial scan fills the cap (root + a); both subsequent adds
        // drop, but the worker latches the report and the parent logs once.
        handle.addDir(path.join(projectRoot, 'b'))
        handle.addDir(path.join(projectRoot, 'c'))
        const sawWarning = await waitFor(() => capWarnings.length > 0)
        expect(sawWarning).toBe(true)
        // Let any further worker messages land, then prove boundedness.
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(capWarnings).toHaveLength(1)
        expect(capWarnings[0]).toMatchObject({ activeWatchers: 2 })
        expect(degrades).toBe(0)
      } finally {
        handle.close()
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('worker crash restarts once, then degrades permanently', () => {
    const { fakes, spawn } = createFakeSpawner()
    const restartCallbacks: Array<() => void> = []
    const messages: DirectoryWatchWorkerOutbound[] = []
    const warnings: string[] = []
    let degrades = 0
    const supervisor = createWorkerSupervisor({
      projectRoot: '/repo',
      spawn,
      onMessage: (message) => {
        messages.push(message)
      },
      onDegrade: () => {
        degrades++
      },
      warn: (_data, msg) => {
        warnings.push(msg)
      },
      scheduleRestart: (callback) => {
        restartCallbacks.push(callback)
        return { cancel: () => {} }
      },
      onRestart: (post) => {
        post({ type: 'add', dir: '/repo/src' })
      },
    })
    expect(fakes).toHaveLength(1)

    // First crash: 'error' and 'exit' both fire; only one restart scheduled.
    fakes[0]!.emitter.emit('error', new Error('boom'))
    fakes[0]!.emitter.emit('exit', 1)
    expect(degrades).toBe(0)
    expect(restartCallbacks).toHaveLength(1)
    expect(warnings.some((msg) => msg.includes('retrying once'))).toBe(true)

    // Posts still flow while the restart is pending (dead-worker posts are
    // harmless best-effort).
    supervisor.post({ type: 'add', dir: '/repo/tmp' })
    expect(fakes[0]!.posted).toContainEqual({ type: 'add', dir: '/repo/tmp' })

    // The restart fires: a fresh worker is spawned and re-seeded.
    restartCallbacks[0]!()
    expect(fakes).toHaveLength(2)
    expect(fakes[1]!.posted).toContainEqual({ type: 'add', dir: '/repo/src' })

    // Live messages still reach the parent after the restart.
    fakes[1]!.emitter.emit('message', { type: 'cap-drop', count: 3 })
    expect(messages).toEqual([{ type: 'cap-drop', count: 3 }])

    // Second crash exhausts the single restart: permanent degrade, once.
    fakes[1]!.emitter.emit('exit', 1)
    expect(degrades).toBe(1)
    expect(warnings.some((msg) => msg.includes('degrading'))).toBe(true)

    // Degrade latches and messages/posts are gated afterwards.
    fakes[1]!.emitter.emit('error', new Error('again'))
    expect(degrades).toBe(1)
    fakes[1]!.emitter.emit('message', { type: 'cap-drop', count: 4 })
    expect(messages).toHaveLength(1)
    supervisor.post({ type: 'add', dir: '/repo/late' })
    expect(fakes[1]!.posted).not.toContainEqual({
      type: 'add',
      dir: '/repo/late',
    })
  })

  test('clean worker exit (code 0) neither restarts nor degrades', () => {
    const { fakes, spawn } = createFakeSpawner()
    const restartCallbacks: Array<() => void> = []
    let degrades = 0
    const supervisor = createWorkerSupervisor({
      projectRoot: '/repo',
      spawn,
      onMessage: () => {},
      onDegrade: () => {
        degrades++
      },
      warn: () => {},
      scheduleRestart: (callback) => {
        restartCallbacks.push(callback)
        return { cancel: () => {} }
      },
    })
    fakes[0]!.emitter.emit('exit', 0)
    expect(degrades).toBe(0)
    expect(restartCallbacks).toHaveLength(0)
    supervisor.close()
  })

  test('close cancels a pending restart and suppresses further failure handling', () => {
    const { fakes, spawn } = createFakeSpawner()
    const restartCallbacks: Array<() => void> = []
    let degrades = 0
    const supervisor = createWorkerSupervisor({
      projectRoot: '/repo',
      spawn,
      onMessage: () => {},
      onDegrade: () => {
        degrades++
      },
      warn: () => {},
      scheduleRestart: (callback) => {
        restartCallbacks.push(callback)
        return { cancel: () => {} }
      },
    })
    fakes[0]!.emitter.emit('error', new Error('boom'))
    expect(restartCallbacks).toHaveLength(1)
    supervisor.close()
    // The pending restart callback after close must not spawn a new worker.
    restartCallbacks[0]!()
    expect(fakes).toHaveLength(1)
    expect(degrades).toBe(0)
    // A late nonzero exit after close is ignored too.
    fakes[0]!.emitter.emit('exit', 1)
    expect(degrades).toBe(0)
    expect(restartCallbacks).toHaveLength(1)
  })
})

describe('ensureIndexWorkspaceWatcher end-to-end (real Linux+Bun pool wiring, P2-T9)', () => {
  // Unlike the pool describe above, these tests go through the REAL
  // ensureIndexWorkspaceWatcher wiring: relativePath join, classify args,
  // feedClassification, addDir/removePrefix, and the shared 75ms debounce
  // flushing into the manager. Only the IndexManager is a recording stub,
  // shaped to exactly what the function consumes.
  const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 3000,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return predicate()
  }

  // Workers start asynchronously, so a write landing before the watcher is
  // up would be missed; re-touch the target periodically until it shows.
  const writeRetrying = (target: string, tick: number) => {
    try {
      fs.writeFileSync(target, `export {} // touch ${tick}\n`)
    } catch {
      // Best-effort touch; the polling loop keeps retrying.
    }
  }

  const makeRecordingManager = () => {
    const pathChanges: Array<{
      changedPaths: string[]
      deletedPaths: string[]
      complete: boolean
    }> = []
    let staleCount = 0
    const manager = {
      markPathsChanged: (delta: {
        changedPaths: string[]
        deletedPaths: string[]
        complete: boolean
      }) => {
        pathChanges.push(delta)
      },
      markStale: () => {
        staleCount += 1
      },
    } as unknown as IndexManager
    return {
      manager,
      pathChanges,
      sawChangedPath: (relativePath: string) =>
        pathChanges.some((delta) => delta.changedPaths.includes(relativePath)),
      get staleCount() {
        return staleCount
      },
    }
  }

  const startRealWatcher = (projectRoot: string) => {
    const recorded = makeRecordingManager()
    ensureIndexWorkspaceWatcher({
      projectRoot,
      config: {
        enabled: true,
        cacheDir: '.codebuff-index',
      } as unknown as IndexingConfig,
      manager: recorded.manager,
    })
    return recorded
  }

  // Each test uses a unique temp root (the module caches per resolved root)
  // and resets the module-level watcher registry before and after.
  test.skipIf(process.platform !== 'linux')(
    'feeds markPathsChanged with the classified relative path for a write in a watched subdir',
    async () => {
      const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'openbuff-watcher-e2e-'),
      )
      fs.mkdirSync(path.join(projectRoot, 'src'))
      __resetIndexWorkspaceWatchersForTests()
      const recorded = startRealWatcher(projectRoot)
      try {
        const target = path.join(projectRoot, 'src', 'a.ts')
        writeRetrying(target, 0)
        let ticks = 0
        const sawChange = await waitFor(() => {
          if (++ticks % 10 === 0) writeRetrying(target, ticks)
          return recorded.sawChangedPath('src/a.ts')
        })
        expect(sawChange).toBe(true)

        // The literal production wiring reached the manager intact: the
        // debounced flush reports the joined relative path, complete.
        const delta = recorded.pathChanges.find((entry) =>
          entry.changedPaths.includes('src/a.ts'),
        )!
        expect(delta).toMatchObject({
          changedPaths: ['src/a.ts'],
          complete: true,
        })
        expect(delta.deletedPaths).toEqual([])
      } finally {
        __resetIndexWorkspaceWatchersForTests()
        fs.rmSync(projectRoot, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'auto-watches a new subdir created after startup and marks a file inside it changed',
    async () => {
      const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'openbuff-watcher-e2e-add-'),
      )
      fs.mkdirSync(path.join(projectRoot, 'src'))
      __resetIndexWorkspaceWatchersForTests()
      const recorded = startRealWatcher(projectRoot)
      try {
        // Created right after startup: either the ambiguous directory event
        // triggers handle.addDir, or the 250ms startup resweep discovers it.
        fs.mkdirSync(path.join(projectRoot, 'src', 'fresh'))
        const target = path.join(projectRoot, 'src', 'fresh', 'b.ts')
        writeRetrying(target, 0)
        let ticks = 0
        const sawChange = await waitFor(() => {
          if (++ticks % 10 === 0) writeRetrying(target, ticks)
          return recorded.sawChangedPath('src/fresh/b.ts')
        })
        expect(sawChange).toBe(true)
      } finally {
        __resetIndexWorkspaceWatchersForTests()
        fs.rmSync(projectRoot, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'stops feeding the manager after the watcher is disposed',
    async () => {
      const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'openbuff-watcher-e2e-close-'),
      )
      fs.mkdirSync(path.join(projectRoot, 'src'))
      __resetIndexWorkspaceWatchersForTests()
      const recorded = startRealWatcher(projectRoot)
      try {
        // Prove the wiring is live before disposing.
        const liveTarget = path.join(projectRoot, 'src', 'live.ts')
        writeRetrying(liveTarget, 0)
        let ticks = 0
        const sawLive = await waitFor(() => {
          if (++ticks % 10 === 0) writeRetrying(liveTarget, ticks)
          return recorded.sawChangedPath('src/live.ts')
        })
        expect(sawLive).toBe(true)

        // ensureIndexWorkspaceWatcher returns void; the module's close
        // handle is the test-only reset, which closes every watched root.
        const closedCount = __resetIndexWorkspaceWatchersForTests()
        expect(closedCount).toBeGreaterThanOrEqual(1)
        const callsAtClose = recorded.pathChanges.length
        const staleAtClose = recorded.staleCount

        // After close: no further events may flow to the manager.
        fs.writeFileSync(path.join(projectRoot, 'src', 'late.ts'), 'export {}\n')
        await new Promise((resolve) => setTimeout(resolve, 600))
        expect(recorded.pathChanges).toHaveLength(callsAtClose)
        expect(recorded.staleCount).toBe(staleAtClose)
      } finally {
        __resetIndexWorkspaceWatchersForTests()
        fs.rmSync(projectRoot, { recursive: true, force: true })
      }
    },
  )
})
