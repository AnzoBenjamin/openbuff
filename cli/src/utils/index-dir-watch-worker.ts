import { watch } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'

// Worker-thread entry for the non-recursive per-directory index watch pool.
// The actual fs.watch handles live here so a misbehaving platform watcher
// (Bun's Linux watcher can SIGILL-trap) can never take down the CLI process.
// Descriptor budget is capped: directories beyond `maxWatchers` are simply
// left unwatched and covered by the index manager's age-based integrity
// sweep.

export type DirectoryWatchWorkerInbound =
  | { type: 'add'; dir: string }
  | { type: 'remove-prefix'; prefix: string }
  | { type: 'close' }

export type DirectoryWatchWorkerOutbound =
  | { type: 'event'; dir: string; fileName: string }
  | { type: 'watch-error'; dir: string }
  | { type: 'watch-failed'; dir: string }
  | { type: 'cap-drop'; count: number }

const watchDirs: string[] = Array.isArray(workerData?.dirs)
  ? workerData.dirs
  : []
const maxWatchers =
  typeof workerData?.maxWatchers === 'number' && workerData.maxWatchers > 0
    ? workerData.maxWatchers
    : 128

const watchers = new Map<string, ReturnType<typeof watch>>()

const post = (message: DirectoryWatchWorkerOutbound) => {
  parentPort?.postMessage(message)
}

// Cap-drop reporting is latched: the parent logs once per root, so the
// worker only needs to report the first drop (with the live watcher count).
let capDropReported = false

const addDir = (dir: string) => {
  if (watchers.has(dir)) return
  // Real fd cap: drop watches beyond maxWatchers and report the first drop
  // so the parent can surface a bounded warning. Deeper unwatched subtrees
  // are covered by the age-based index sweep.
  if (watchers.size >= maxWatchers) {
    if (!capDropReported) {
      capDropReported = true
      post({ type: 'cap-drop', count: watchers.size })
    }
    return
  }
  try {
    const dirWatcher = watch(
      dir,
      // Keep options minimal for maximum platform compatibility and
      // persistent: false so watchers never hold the worker open.
      { persistent: false },
      (_eventType, fileName) => {
        post({ type: 'event', dir, fileName: String(fileName ?? '') })
      },
    )
    dirWatcher.on('error', () => {
      // The watched directory may have been removed; report it once and keep
      // the worker alive instead of throwing.
      post({ type: 'watch-error', dir })
    })
    watchers.set(dir, dirWatcher)
  } catch {
    // Some filesystems/platforms reject watch() outright; report and move on
    // rather than crashing the worker.
    post({ type: 'watch-failed', dir })
  }
}

for (const dir of watchDirs) addDir(dir)

/**
 * Separator-agnostic check that `dir` is `prefix` itself or lives under it.
 * Watcher keys and prefixes come from path.join on whatever platform built
 * them, so both sides are normalized to forward slashes before the segment
 * comparison (latent Windows bug if the pool ever runs there).
 */
export function isDirAtOrUnderPrefix(dir: string, prefix: string): boolean {
  const normalizedDir = dir.replace(/\\/g, '/')
  const normalizedPrefix = prefix.replace(/\\/g, '/')
  return (
    normalizedDir === normalizedPrefix ||
    normalizedDir.startsWith(`${normalizedPrefix}/`)
  )
}

parentPort?.on('message', (message: DirectoryWatchWorkerInbound) => {
  if (message.type === 'add') {
    addDir(message.dir)
    return
  }
  if (message.type === 'remove-prefix') {
    for (const [dir, dirWatcher] of watchers) {
      if (isDirAtOrUnderPrefix(dir, message.prefix)) {
        watchers.delete(dir)
        dirWatcher.close()
      }
    }
    return
  }
  if (message.type === 'close') {
    for (const dirWatcher of watchers.values()) dirWatcher.close()
    watchers.clear()
    process.exit(0)
  }
})
