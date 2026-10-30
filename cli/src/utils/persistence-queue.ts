import { rename, unlink, writeFile } from 'fs/promises'

/**
 * Upper bound on concurrently pending writes, enforced with drop-oldest: when
 * the queue is full, the oldest pending write is evicted (its awaiters resolve
 * to `false` and its error reporter is invoked) before a new request is
 * admitted. The bound keeps a pathological save burst from accumulating
 * unbounded buffer memory.
 */
export const MAX_PENDING_PERSISTENCE_WRITES = 32

export type PersistenceWriteRequest = {
  /**
   * Logical target key (usually the destination file path). Pending writes
   * for the same key coalesce: a later request replaces the earlier pending
   * one, whose awaiters then resolve with the surviving write's outcome.
   */
  targetKey: string
  /** Human-readable label (usually the destination path) for diagnostics. */
  label: string
  /**
   * Performs the actual IO for this write. It must be atomic (temp file +
   * rename) so it either fully lands or leaves the previous file untouched;
   * use atomicWriteJsonFile for the common file-replacement case.
   */
  run: () => Promise<void>
  /**
   * Fail-soft error reporter. Defaults to console.error; when supplied it
   * fully REPLACES the default report — one failure is never reported
   * through both channels. Reporters that throw are contained; the queue
   * never propagates write failures as rejections.
   */
  onError?: (error: unknown) => void
}

type PendingEntry = {
  request: PersistenceWriteRequest
  /** Settled once the surviving write for this key completes. */
  awaiters: Array<(completed: boolean) => void>
}

const pendingWrites = new Map<string, PendingEntry>()

let pumping = false
let settlePumpIdle: () => void = () => {}
let pumpIdlePromise: Promise<void> = Promise.resolve()

// Default fail-soft channel. The bracket-free 'persistence-queue write
// failed:' prefix is pinned by the fail-soft tests' substring assertions.
const defaultReportError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`persistence-queue write failed: ${message}`)
}

const reportError = (
  request: PersistenceWriteRequest,
  error: unknown,
): void => {
  const report = request.onError ?? defaultReportError
  try {
    report(error)
  } catch (reporterError) {
    // A throwing reporter must not break the pump; surface it through the
    // default channel instead.
    defaultReportError(reporterError)
  }
}

function enqueue(request: PersistenceWriteRequest): Promise<boolean> {
  const previous = pendingWrites.get(request.targetKey)
  const carriedAwaiters = previous?.awaiters ?? []
  if (previous) {
    pendingWrites.delete(request.targetKey)
  }

  let settleThis!: (completed: boolean) => void
  const promise = new Promise<boolean>((resolve) => {
    settleThis = resolve
  })

  // Drop-oldest bound: evict entries from the front (oldest insertion) until
  // there is room. A re-enqueued key frees no slot, so this may evict entries
  // belonging to distinct targets — documented so callers know which write
  // was dropped when capacity runs out.
  while (pendingWrites.size >= MAX_PENDING_PERSISTENCE_WRITES) {
    const oldest = pendingWrites.entries().next()
    if (oldest.done) break
    const [key, dropped] = oldest.value
    pendingWrites.delete(key)
    reportError(
      dropped.request,
      new Error('persistence queue overflow: dropped the oldest pending write'),
    )
    for (const settle of dropped.awaiters) {
      settle(false)
    }
  }

  pendingWrites.set(request.targetKey, {
    request,
    awaiters: [...carriedAwaiters, settleThis],
  })
  kick()
  return promise
}

function kick(): void {
  if (pumping) return
  pumping = true
  pumpIdlePromise = new Promise<void>((resolve) => {
    settlePumpIdle = resolve
  })
  // Defer the first pump tick to the end of the current synchronous stack so
  // a burst of same-key writes scheduled synchronously coalesces into one.
  queueMicrotask(() => {
    void (pump().finally(() => {
      pumping = false
      settlePumpIdle()
    }))
  })
}

async function pump(): Promise<void> {
  // The pump is total: every run failure is contained, so this loop can only
  // exit through the empty-map return.
  for (;;) {
    const next = pendingWrites.entries().next()
    if (next.done) return
    const [key, entry] = next.value
    pendingWrites.delete(key)
    let completed = true
    try {
      await entry.request.run()
    } catch (error) {
      completed = false
      reportError(entry.request, error)
    }
    for (const settle of entry.awaiters) {
      settle(completed)
    }
  }
}

/**
 * Fire-and-forget enqueue: returns immediately. Errors are reported through
 * the request's onError hook (console.error by default) and never thrown.
 */
export function schedulePersistenceWrite(request: PersistenceWriteRequest): void {
  enqueue(request)
}

/**
 * Consistency escape hatch: same coalescing as schedulePersistenceWrite, but
 * the returned promise resolves (never rejects) to true once this request's
 * surviving write has landed on disk, false when it failed, was dropped, or
 * was canceled.
 */
export function awaitPersistenceWrite(
  request: PersistenceWriteRequest,
): Promise<boolean> {
  return enqueue(request)
}

/** Cancel a pending (not yet started) write for a key. Used when a state
 * clear must not resurrect something a queued write would still write. */
export function cancelPendingPersistenceWrite(targetKey: string): boolean {
  const entry = pendingWrites.get(targetKey)
  if (!entry) return false
  pendingWrites.delete(targetKey)
  for (const settle of entry.awaiters) {
    settle(false)
  }
  return true
}

/** Number of writes waiting to be started (excludes in-flight ones). */
export function pendingPersistenceWriteCount(): number {
  return pendingWrites.size
}

/**
 * Serialize a state clear with queued persistence writes for one target:
 * cancel the still-pending write for `targetKey`, then wait for the pump so
 * any write already handed to it (invisible to cancelPendingPersistenceWrite,
 * which can only see entries still in the map) is fully settled before the
 * caller unlinks/replaces the target. Without this, a dequeued-but-unwritten
 * rename can land AFTER the caller's unlink and resurrect the cleared state
 * (checkpoint-resurrection race).
 *
 * MUST be awaited whenever the caller's follow-up unlink must not race an
 * in-flight write; plain cancelPendingPersistenceWrite stays fire-and-forget
 * for paths that tolerate the window.
 *
 * NEVER rejects: the pump contains every run failure, so awaiting the queue
 * can only resolve. Returns whether a cancelable pending write was present.
 */
export async function cancelAndDrainPendingWriteFor(
  targetKey: string,
): Promise<boolean> {
  const canceled = cancelPendingPersistenceWrite(targetKey)
  await drainPersistenceQueue()
  return canceled
}

/**
 * Resolve once nothing is pending and the pump is idle. Used by the
 * process-exit hook below and by tests/callers that need to observe the
 * flushed bytes on disk.
 */
export async function drainPersistenceQueue(): Promise<void> {
  for (;;) {
    await pumpIdlePromise
    if (pendingWrites.size === 0) return
    // Writes scheduled while/after the previous pump drained start a fresh
    // one; loop until the queue is quiet.
  }
}

/**
 * Atomic file replacement: write to a sibling temp file, then rename over the
 * destination. Same-directory rename is atomic on POSIX; the EEXIST/EPERM
 * fallback below carries over the Windows behavior of the previous
 * synchronous writer (remove the target, retry the rename). Callers own the
 * temp-file naming contract when they pass tmpPath explicitly (e.g. the
 * mid-turn checkpoint's pid-suffixed, sweepable temp name).
 */
export async function atomicWriteJsonFile(
  filePath: string,
  content: string,
  opts?: { mode?: number; tmpPath?: string },
): Promise<void> {
  const tempPath =
    opts?.tmpPath ?? `${filePath}.tmp.${process.pid}.${Date.now()}`
  await writeFile(
    tempPath,
    content,
    opts?.mode !== undefined ? { mode: opts.mode } : undefined,
  )
  try {
    await rename(tempPath, filePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') {
      throw error
    }
    await unlink(filePath)
    await rename(tempPath, filePath)
  }
}

// Once-only guard for the exit hook below: at most ONE drain pass may ever
// run, so a pass parked on in-flight work cannot re-arm 'beforeExit' in a
// loop and hang a green exit.
let exitDrainPassUsed = false

/**
 * Single flush-on-exit hook for this queue: on a normal event-loop unwind
 * ('beforeExit'), drain everything still queued so the last chat-state or
 * checkpoint save is not lost. Abrupt process.exit() cannot flush
 * asynchronously; per-request awaiters see `false` in that case, matching the
 * pre-queue fire-and-forget risk.
 *
 * Bounded exit drain (green-exit hang): an unconditional async drain parks
 * on a promise on every emission, and the parked continuation counts as
 * pending microtask work — Node runs it, finds the loop empty again, and
 * re-emits 'beforeExit' forever. The idle fast-path returns synchronously
 * (schedules nothing) when the queue is empty and no write is in flight;
 * otherwise exactly one pass runs, and the pending fs work keeps the loop
 * alive by itself so queued writes land before the next (fast-path)
 * emission lets the process exit for real.
 */
process.on('beforeExit', () => {
  // Idle fast-path: must schedule nothing — not even a microtask — or
  // beforeExit re-arms and the exit hangs.
  if (pendingWrites.size === 0 && !pumping) return
  if (exitDrainPassUsed) return
  exitDrainPassUsed = true
  void drainPersistenceQueue()
})
