import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

import type { Dirent } from 'node:fs'
import type {
  DirectoryWatchWorkerInbound,
  DirectoryWatchWorkerOutbound,
} from './index-dir-watch-worker'
import { logger } from './logger'

// Mirrors IGNORED_TOP_LEVEL in index-workspace-watcher.ts. Re-declared locally
// instead of imported to avoid a circular module dependency: the watcher
// imports this pool for the Linux+Bun wiring. The scan applies these names at
// the TOP LEVEL only, matching the recursive watcher's classifier (nested
// directories with the same names stay watched).
const IGNORED_TOP_LEVEL = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  'coverage',
])

/**
 * Cap on concurrently open fs.watch descriptors inside the worker. Every
 * watched directory costs one fd; subtrees beyond this cap (or beyond
 * `maxDepth`) are simply unwatched and rely on the index manager's age-based
 * integrity sweep.
 */
export const MAX_DIR_WATCHERS = 128

const DEFAULT_MAX_DEPTH = 8
const DEFAULT_CACHE_DIR = '.codebuff-index'

/**
 * The worker needs ~10-20ms to bootstrap its fs.watch handles, so a directory
 * created inside that window never emits an event and would stay unwatched
 * until the next age-based integrity sweep. One bounded re-sweep after the
 * bootstrap window closes the race.
 */
const STARTUP_RESWEEP_DELAY_MS = 250

export type DirectoryWatchRawEvent = { dir: string; fileName: string }

export type DirectoryIndexWatchHandle = {
  /** Stop the worker and release every descriptor it holds. */
  close: () => void
  /** Watch one more directory; dropped with a bounded warning at the fd cap. */
  addDir: (dir: string) => void
  /** Close the watcher at `prefix` and every watcher underneath it. */
  removePrefix: (prefix: string) => void
}

/**
 * Bounded BFS from projectRoot collecting directories eligible for a
 * non-recursive watcher: real directories only (no symlinks), skipping the
 * index cache dir at any depth and the top-level ignore names ONLY at the
 * top level (mirroring the recursive watcher's classifier, so nested
 * directories named like a top-level ignore — e.g. src/dist — stay watched).
 * projectRoot itself is always first.
 */
export function collectWatchableDirectories(
  projectRoot: string,
  options: {
    maxWatchers?: number
    maxDepth?: number
    cacheDir?: string
  } = {},
): string[] {
  const maxWatchers = options.maxWatchers ?? MAX_DIR_WATCHERS
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const cacheDir = (options.cacheDir ?? DEFAULT_CACHE_DIR)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '')
  if (maxWatchers < 1) return []
  const root = path.resolve(projectRoot)
  const dirs = [root]
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let cursor = 0
  while (cursor < queue.length && dirs.length < maxWatchers) {
    const { dir, depth } = queue[cursor++]!
    if (depth >= maxDepth) continue
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // Unreadable directory: skip it; the age-based sweep still covers it.
      continue
    }
    for (const entry of entries) {
      if (dirs.length >= maxWatchers) break
      if (!entry.isDirectory()) continue
      // Mirror the recursive watcher's classifier: IGNORED_TOP_LEVEL names
      // are ignored ONLY at the top level. A nested directory named like a
      // top-level ignore (e.g. src/dist, packages/build) is watched so its
      // index-change events are not missed until the age-based sweep.
      if (depth === 0 && IGNORED_TOP_LEVEL.has(entry.name)) continue
      const child = path.join(dir, entry.name)
      try {
        // Never watch through symlinks: they can escape the project or loop.
        if (lstatSync(child).isSymbolicLink()) continue
      } catch {
        continue
      }
      const childRelative = path.relative(root, child).replace(/\\/g, '/')
      if (
        childRelative === cacheDir ||
        childRelative.startsWith(`${cacheDir}/`)
      ) {
        continue
      }
      dirs.push(child)
      queue.push({ dir: child, depth: depth + 1 })
    }
  }
  return dirs
}

/**
 * Bounded warning sink for the watch pool. Defaults to the shared CLI
 * logger; tests inject a recorder. Context travels in the data payload
 * (root, dir, counts) rather than interpolated into the message string.
 */
export type IndexWatchWarn = (
  data: Record<string, unknown>,
  msg: string,
) => void

/**
 * Structural subset of node:worker_threads.Worker that the pool needs. Kept
 * narrow so the failure/restart policy is unit-testable with fake workers.
 */
export type DirectoryWatchWorkerLike = {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  postMessage(message: DirectoryWatchWorkerInbound): void
  terminate(): Promise<number>
  unref(): void
}

const DEFAULT_MAX_WARN_KEYS = 32

/**
 * Warn at most once per distinct key (and at most `maxKeys` keys total) so
 * per-event failures — one of hundreds of directories failing watch() —
 * cannot spam the log. Keys beyond the bound stay silent; the age-based
 * integrity sweep still covers them.
 */
export function createBoundedWarnLatch(
  warn: IndexWatchWarn,
  maxKeys: number = DEFAULT_MAX_WARN_KEYS,
): (key: string, data: Record<string, unknown>, msg: string) => void {
  const seen = new Set<string>()
  return (key, data, msg) => {
    if (seen.has(key) || seen.size >= maxKeys) return
    seen.add(key)
    warn(data, msg)
  }
}

/** Restart policy: one bounded retry after a short delay, then degrade. */
const MAX_WORKER_RESTARTS = 1
const WORKER_RESTART_DELAY_MS = 2_000

export type WorkerRestartScheduler = (
  callback: () => void,
  delayMs: number,
) => { cancel: () => void }

const defaultRestartScheduler: WorkerRestartScheduler = (
  callback,
  delayMs,
) => {
  const timer = setTimeout(callback, delayMs)
  // A pending restart must never hold the CLI process open.
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export type WorkerSupervisorParams = {
  projectRoot: string
  spawn: () => DirectoryWatchWorkerLike
  onMessage: (message: DirectoryWatchWorkerOutbound) => void
  onDegrade: () => void
  warn: IndexWatchWarn
  /** Restart attempts before degrading permanently. Default: one. */
  maxRestarts?: number
  restartDelayMs?: number
  scheduleRestart?: WorkerRestartScheduler
  /** Called after a fresh worker spawns so the parent can re-seed state. */
  onRestart?: (post: (message: DirectoryWatchWorkerInbound) => void) => void
}

export type WorkerSupervisor = {
  /** Post unless closed or degraded (silent no-op when gated). */
  post: (message: DirectoryWatchWorkerInbound) => void
  /** Post even while a restart is pending (best-effort, never throws). */
  postRaw: (message: DirectoryWatchWorkerInbound) => void
  close: () => void
  isDegraded: () => boolean
}

/**
 * Owns the pool worker's lifecycle: message dispatch, one bounded restart
 * after a crash, and a permanent degrade (onDegrade → markStale) once the
 * restarts are exhausted. A crashed worker must never crash the main
 * process, and unref/terminate semantics never hold the process open.
 */
export function createWorkerSupervisor(
  params: WorkerSupervisorParams,
): WorkerSupervisor {
  const maxRestarts = params.maxRestarts ?? MAX_WORKER_RESTARTS
  const restartDelayMs = params.restartDelayMs ?? WORKER_RESTART_DELAY_MS
  const scheduleRestart = params.scheduleRestart ?? defaultRestartScheduler

  const spawnWorker = () => {
    const worker = params.spawn()
    // Never hold the CLI process open at exit (mirrors persistent: false).
    worker.unref()
    return worker
  }

  let worker = spawnWorker()
  let closed = false
  let degraded = false
  let restarts = 0
  let failureHandled = false
  let restartHandle: { cancel: () => void } | undefined

  const degrade = () => {
    if (degraded) return
    degraded = true
    params.warn(
      { projectRoot: params.projectRoot, restartAttempts: restarts },
      '[index-watch] worker crashed; degrading to the age-based integrity sweep',
    )
    params.onDegrade()
  }

  const handleFailure = () => {
    if (closed || degraded || failureHandled) return
    failureHandled = true
    if (restarts >= maxRestarts) {
      degrade()
      return
    }
    restarts += 1
    params.warn(
      { projectRoot: params.projectRoot, attempt: restarts },
      '[index-watch] worker crashed; retrying once',
    )
    restartHandle = scheduleRestart(() => {
      restartHandle = undefined
      if (closed || degraded) return
      worker = spawnWorker()
      failureHandled = false
      attach(worker)
      params.onRestart?.((message) => postRaw(message))
    }, restartDelayMs)
  }

  const attach = (target: DirectoryWatchWorkerLike) => {
    target.on('message', (raw: unknown) => {
      if (closed || degraded) return
      const message = raw as DirectoryWatchWorkerOutbound
      if (!message || typeof message !== 'object') return
      params.onMessage(message)
    })
    target.on('error', () => handleFailure())
    target.on('exit', (code: unknown) => {
      if (typeof code === 'number' && code !== 0) handleFailure()
    })
  }
  attach(worker)

  const postRaw = (message: DirectoryWatchWorkerInbound) => {
    try {
      worker.postMessage(message)
    } catch {
      // The worker already exited; the restart/degrade path handles it.
    }
  }

  return {
    post: (message) => {
      if (closed || degraded) return
      postRaw(message)
    },
    postRaw,
    close: () => {
      if (closed) return
      closed = true
      restartHandle?.cancel()
      postRaw({ type: 'close' })
      void worker.terminate()
    },
    isDegraded: () => degraded,
  }
}

/**
 * Start a worker-thread pool of non-recursive per-directory watchers for
 * platforms without recursive watching support (Linux + Bun). The worker owns
 * every fs.watch handle so platform watcher bugs cannot crash the main
 * thread, and unref/terminate semantics guarantee the watchers never hold the
 * process open. A crash triggers one bounded restart attempt; once that is
 * exhausted the pool degrades permanently to the age-based integrity sweep,
 * with cap drops, failed directory watches, and the degrade itself surfaced
 * through bounded, deduplicated warnings.
 */
export function startDirectoryIndexWatch(params: {
  projectRoot: string
  cacheDir?: string
  onRawEvent: (raw: DirectoryWatchRawEvent) => void
  onDegrade: () => void
  maxWatchers?: number
  maxDepth?: number
  /** Injectable warning sink; defaults to the shared CLI logger. */
  onWarn?: IndexWatchWarn
}): DirectoryIndexWatchHandle {
  const dirs = collectWatchableDirectories(params.projectRoot, {
    maxWatchers: params.maxWatchers,
    maxDepth: params.maxDepth,
    cacheDir: params.cacheDir,
  })
  const maxWatchers = params.maxWatchers ?? MAX_DIR_WATCHERS
  const projectRoot = path.resolve(params.projectRoot)
  const warn: IndexWatchWarn =
    params.onWarn ?? ((data, msg) => logger.warn(data, msg))
  // Bounded, deduplicated warnings: one per root for fd-cap drops, one per
  // failed directory — never per event.
  const warnOnce = createBoundedWarnLatch(warn)
  const postedDirs = new Set(dirs)

  const supervisor = createWorkerSupervisor({
    projectRoot,
    spawn: () =>
      new Worker(
        new URL('./index-dir-watch-worker.ts', import.meta.url),
        // The actual fs.watch handles live in a worker thread: Bun's Linux
        // watcher can SIGILL-trap, so never call fs.watch on the main thread
        // here.
        { workerData: { dirs, maxWatchers } },
      ),
    onMessage: (message) => {
      if (message.type === 'event') {
        params.onRawEvent({ dir: message.dir, fileName: message.fileName })
        return
      }
      if (message.type === 'cap-drop') {
        warnOnce(
          'cap-drop',
          { projectRoot, activeWatchers: message.count },
          '[index-watch] directory watcher fd cap reached; extra subtrees rely on the age-based integrity sweep',
        )
        return
      }
      // 'watch-error' / 'watch-failed': the failed directory stays unwatched
      // with no retry spam; the age-based sweep covers its subtree.
      warnOnce(
        `dir:${message.dir}`,
        { projectRoot, dir: message.dir },
        '[index-watch] directory watch failed; its subtree relies on the age-based integrity sweep',
      )
    },
    onDegrade: params.onDegrade,
    warn,
    onRestart: (post) => {
      // Re-seed the fresh worker with every directory known so far; the
      // worker skips dirs it already watches.
      for (const dir of postedDirs) post({ type: 'add', dir })
    },
  })

  let closed = false

  // Startup re-sweep: re-run the bounded directory scan once after the
  // worker's bootstrap window and post 'add' for anything the initial scan
  // could not have known about (or that the parent-dir watcher missed while
  // its handles were still coming up). Dirs beyond the fd cap remain
  // unwatched by design (surfaced by a single bounded warning); the
  // age-based integrity sweep covers them.
  const resweep = () => {
    if (closed || supervisor.isDegraded()) return
    try {
      for (const dir of collectWatchableDirectories(params.projectRoot, {
        maxWatchers: params.maxWatchers,
        maxDepth: params.maxDepth,
        cacheDir: params.cacheDir,
      })) {
        if (postedDirs.has(dir)) continue
        postedDirs.add(dir)
        supervisor.postRaw({ type: 'add', dir })
      }
    } catch {
      // Best-effort discovery; the age-based sweep still covers misses.
    }
  }
  const resweepTimer = setTimeout(resweep, STARTUP_RESWEEP_DELAY_MS)
  resweepTimer.unref?.()

  return {
    close: () => {
      if (closed) return
      closed = true
      clearTimeout(resweepTimer)
      supervisor.close()
    },
    addDir: (dir) => {
      postedDirs.add(dir)
      supervisor.post({ type: 'add', dir })
    },
    removePrefix: (prefix) => supervisor.post({ type: 'remove-prefix', prefix }),
  }
}
