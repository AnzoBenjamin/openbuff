import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

import type { Dirent } from 'node:fs'
import type {
  DirectoryWatchWorkerInbound,
  DirectoryWatchWorkerOutbound,
} from './index-dir-watch-worker'

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
  /** Watch one more directory; silently dropped when the fd cap is full. */
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
 * Start a worker-thread pool of non-recursive per-directory watchers for
 * platforms without recursive watching support (Linux + Bun). The worker owns
 * every fs.watch handle so platform watcher bugs cannot crash the main
 * thread, and unref/terminate semantics guarantee the watchers never hold the
 * process open.
 */
export function startDirectoryIndexWatch(params: {
  projectRoot: string
  cacheDir?: string
  onRawEvent: (raw: DirectoryWatchRawEvent) => void
  onDegrade: () => void
  maxWatchers?: number
  maxDepth?: number
}): DirectoryIndexWatchHandle {
  const dirs = collectWatchableDirectories(params.projectRoot, {
    maxWatchers: params.maxWatchers,
    maxDepth: params.maxDepth,
    cacheDir: params.cacheDir,
  })
  const maxWatchers = params.maxWatchers ?? MAX_DIR_WATCHERS
  // The actual fs.watch handles live in a worker thread: Bun's Linux watcher
  // can SIGILL-trap, so never call fs.watch on the main thread here.
  const worker = new Worker(
    new URL('./index-dir-watch-worker.ts', import.meta.url),
    { workerData: { dirs, maxWatchers } },
  )
  // Never hold the CLI process open at exit (mirrors persistent: false).
  worker.unref()

  let closed = false
  let degraded = false
  const degradeOnce = () => {
    if (degraded) return
    degraded = true
    params.onDegrade()
  }

  worker.on('message', (message: DirectoryWatchWorkerOutbound) => {
    if (closed || degraded) return
    if (message.type === 'event') {
      params.onRawEvent({ dir: message.dir, fileName: message.fileName })
      return
    }
    // 'watch-error' / 'watch-failed': the failed directory is simply
    // unwatched from now on, with no retry spam; the age-based sweep covers
    // its subtree.
  })
  worker.on('error', () => {
    // A worker crash must never crash the main process: degrade to sweeps.
    degradeOnce()
  })
  worker.on('exit', (code) => {
    if (closed) return
    if (code !== 0) degradeOnce()
  })

  const postRaw = (message: DirectoryWatchWorkerInbound) => {
    try {
      worker.postMessage(message)
    } catch {
      // The worker already exited; terminate/cleanup below remains safe.
    }
  }
  const post = (message: DirectoryWatchWorkerInbound) => {
    if (closed || degraded) return
    postRaw(message)
  }

  // Startup re-sweep: re-run the bounded directory scan once after the
  // worker's bootstrap window and post 'add' for anything the initial scan
  // could not have known about (or that the parent-dir watcher missed while
  // its handles were still coming up). Dirs beyond the fd cap remain
  // unwatched by design; the age-based integrity sweep covers them.
  const postedDirs = new Set(dirs)
  const resweep = () => {
    if (closed || degraded) return
    try {
      for (const dir of collectWatchableDirectories(params.projectRoot, {
        maxWatchers: params.maxWatchers,
        maxDepth: params.maxDepth,
        cacheDir: params.cacheDir,
      })) {
        if (postedDirs.has(dir)) continue
        postedDirs.add(dir)
        postRaw({ type: 'add', dir })
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
      postRaw({ type: 'close' })
      void worker.terminate()
    },
    addDir: (dir) => {
      postedDirs.add(dir)
      post({ type: 'add', dir })
    },
    removePrefix: (prefix) => post({ type: 'remove-prefix', prefix }),
  }
}
