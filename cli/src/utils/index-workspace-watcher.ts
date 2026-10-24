import { existsSync, statSync, watch } from 'node:fs'
import path from 'node:path'

import type { IndexManager, IndexingConfig } from '@codebuff/indexer'

import { startDirectoryIndexWatch } from './index-dir-watch'

type WatcherEntry = {
  close: () => void
  manager: IndexManager
}

const watchers = new Map<string, WatcherEntry>()
const MAX_WATCHED_ROOTS = 4
export const IGNORED_TOP_LEVEL = new Set([
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

export function supportsRecursiveIndexWorkspaceWatcher(params: {
  platform: NodeJS.Platform
  bunVersion?: string
}): boolean {
  // Bun's recursive Linux watcher currently retains file descriptors for the
  // full subtree before our callback can filter ignored paths. Large pnpm
  // workspaces can therefore hit EMFILE and make Bun's HTTP client trap with
  // SIGILL. Explicit SDK mutation deltas and the index manager's age-based
  // integrity sweeps remain active when this optimization is disabled.
  return !(params.platform === 'linux' && params.bunVersion)
}

export function classifyIndexWatchPath(params: {
  projectRoot: string
  fileName: string
  cacheDir?: string
}):
  | { kind: 'ignore' }
  | { kind: 'changed'; path: string }
  | { kind: 'deleted'; path: string }
  | { kind: 'ambiguous' } {
  const relativePath = params.fileName.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!relativePath || relativePath === '.') return { kind: 'ambiguous' }
  const topLevel = relativePath.split('/')[0]!
  const cacheDir = (params.cacheDir ?? '.codebuff-index')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '')
  if (
    IGNORED_TOP_LEVEL.has(topLevel) ||
    relativePath === cacheDir ||
    relativePath.startsWith(`${cacheDir}/`)
  ) {
    return { kind: 'ignore' }
  }
  const absolutePath = path.join(params.projectRoot, relativePath)
  if (!existsSync(absolutePath)) {
    return path.extname(relativePath)
      ? { kind: 'deleted', path: relativePath }
      : { kind: 'ambiguous' }
  }
  try {
    return statSync(absolutePath).isFile()
      ? { kind: 'changed', path: relativePath }
      : { kind: 'ambiguous' }
  } catch {
    return { kind: 'ambiguous' }
  }
}

/**
 * Close the oldest watched roots while more than MAX_WATCHED_ROOTS remain.
 * Called on EVERY successful watcher start — recursive AND Linux+Bun
 * pool-backed — so a host watching many roots stays bounded instead of
 * accumulating watcher pools (each holding up to the worker fd cap in
 * fs.watch descriptors).
 */
function evictOldestWatchedRoots(): void {
  while (watchers.size > MAX_WATCHED_ROOTS) {
    const oldestRoot = watchers.keys().next().value
    if (!oldestRoot) break
    watchers.get(oldestRoot)?.close()
    watchers.delete(oldestRoot)
  }
}

export function ensureIndexWorkspaceWatcher(params: {
  projectRoot: string
  config: IndexingConfig
  manager: IndexManager
}): void {
  if (params.config.enabled === false) return
  const supportsRecursive = supportsRecursiveIndexWorkspaceWatcher({
    platform: process.platform,
    bunVersion: process.versions.bun,
  })
  const projectRoot = path.resolve(params.projectRoot)
  const existing = watchers.get(projectRoot)
  if (existing?.manager === params.manager) return
  existing?.close()

  // Shared debounce/flush state machine: buffered path deltas flush to the
  // manager after 75ms, while any ambiguity degrades to a conservative
  // markStale(). Both the recursive watcher and the Linux+Bun per-directory
  // worker pool feed this machine.
  const changedPaths = new Set<string>()
  const deletedPaths = new Set<string>()
  let ambiguous = false
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    flushTimer = undefined
    if (ambiguous) {
      params.manager.markStale()
    } else if (changedPaths.size > 0 || deletedPaths.size > 0) {
      params.manager.markPathsChanged({
        changedPaths: [...changedPaths].sort(),
        deletedPaths: [...deletedPaths].sort(),
        complete: true,
      })
    }
    changedPaths.clear()
    deletedPaths.clear()
    ambiguous = false
  }
  const scheduleFlush = () => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(flush, 75)
    flushTimer.unref?.()
  }
  const feedClassification = (
    classified: ReturnType<typeof classifyIndexWatchPath>,
  ) => {
    if (classified.kind === 'ignore') return
    if (classified.kind === 'ambiguous') {
      ambiguous = true
    } else if (classified.kind === 'changed') {
      changedPaths.add(classified.path)
      deletedPaths.delete(classified.path)
    } else {
      deletedPaths.add(classified.path)
      changedPaths.delete(classified.path)
    }
    scheduleFlush()
  }

  if (!supportsRecursive) {
    // Linux + Bun: recursive watching stays disabled (Bun's Linux watcher can
    // exhaust file descriptors and SIGILL-trap), so run a worker-isolated pool
    // of non-recursive per-directory watchers instead. The worker owns every
    // fs.watch handle; directories beyond its fd cap are simply unwatched and
    // covered by the age-based integrity sweep.
    try {
      const handle = startDirectoryIndexWatch({
        projectRoot,
        cacheDir: params.config.cacheDir,
        onRawEvent: (raw) => {
          const relativePath = path
            .relative(projectRoot, path.join(raw.dir, raw.fileName))
            .replace(/\\/g, '/')
            .replace(/^\.\//, '')
          const absolutePath = path.join(projectRoot, relativePath)
          const classified = classifyIndexWatchPath({
            projectRoot,
            fileName: relativePath,
            cacheDir: params.config.cacheDir,
          })
          feedClassification(classified)
          if (classified.kind === 'ambiguous') {
            // A new directory appeared (classify reports existing directories
            // as ambiguous): watch it too. The pool drops the add when its fd
            // cap is full; that subtree then relies on the age sweep.
            try {
              if (
                existsSync(absolutePath) &&
                statSync(absolutePath).isDirectory()
              ) {
                handle.addDir(absolutePath)
              }
            } catch {
              // Raced with removal; classification already handled it.
            }
          } else if (classified.kind === 'deleted') {
            // The subtree rooted at the deleted path no longer needs watchers.
            handle.removePrefix(absolutePath)
          }
        },
        onDegrade: () => {
          // Worker crash that survived the pool's single restart attempt:
          // degrade to the markStale() path instead of crashing the process.
          ambiguous = true
          scheduleFlush()
        },
      })
      watchers.set(projectRoot, {
        manager: params.manager,
        close: () => {
          if (flushTimer) clearTimeout(flushTimer)
          handle.close()
        },
      })
    } catch {
      // Worker spawn failures fail open: age-based integrity sweeps and
      // explicit SDK mutation deltas remain active.
    }
    // Pool-backed roots must be evicted too: without this the Linux+Bun
    // branch accumulated one worker pool (up to its fd cap) per watched
    // root, unbounded.
    evictOldestWatchedRoots()
    return
  }

  try {
    const watcher = watch(
      projectRoot,
      { recursive: true, persistent: false },
      (_eventType, fileName) => {
        feedClassification(
          classifyIndexWatchPath({
            projectRoot,
            fileName: String(fileName ?? ''),
            cacheDir: params.config.cacheDir,
          }),
        )
      },
    )
    watcher.on('error', () => {
      ambiguous = true
      scheduleFlush()
    })
    watchers.set(projectRoot, {
      manager: params.manager,
      close: () => {
        if (flushTimer) clearTimeout(flushTimer)
        watcher.close()
      },
    })
  } catch {
    // Some filesystems do not support recursive watching. Age-based integrity
    // sweeps and explicit SDK mutation deltas remain active in that case.
  }

  evictOldestWatchedRoots()
}

/** Test-only: close every watched root and report how many were closed. */
export function __resetIndexWorkspaceWatchersForTests(): number {
  const closed = watchers.size
  for (const entry of watchers.values()) entry.close()
  watchers.clear()
  return closed
}
