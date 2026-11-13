/**
 * Attached BACKGROUND job lifetime (N06, exec-jobs-09).
 *
 * An attached job (`detach: false`) belongs to this SDK/CLI process. When the
 * process ends, its process group is terminated on every exit path:
 *
 * - natural end: the job's handles are unref'd so it cannot keep the event
 *   loop alive; `beforeExit` runs the cooperative B20 scope stop;
 * - `process.exit()`: the synchronous `exit` hook sends SIGTERM to each group,
 *   waits a bounded grace period, then SIGKILLs survivors;
 * - SIGINT / SIGTERM / SIGHUP: the cooperative stop runs. When no other
 *   listener owns the signal, this module exits the process afterwards
 *   (128 + signal number), so an SDK host honours Ctrl+C while jobs run. When
 *   the host has its own handler (the CLI), the host decides when to exit and
 *   the `exit` hook backs the cleanup up.
 *
 * Transferred (`detach: true`) jobs are never registered here; they keep the
 * receiver lifetime they were transferred to.
 *
 * Hooks are installed only while at least one attached job is live, so a host
 * with no attached jobs keeps its default signal behaviour.
 */
import os from 'node:os'

import type { ChildProcess } from 'node:child_process'

export type AttachedJobHandle = Readonly<{
  jobId: string
  child: ChildProcess
  /** Cooperative B20 scope stop (SIGTERM, grace, SIGKILL) with its receipt. */
  stop(): Promise<unknown>
}>

/** Narrow process surface; tests may inject a fake. */
export type AttachedJobProcess = Pick<NodeJS.Process, 'on' | 'off' | 'listenerCount' | 'exit'>

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number]
const SIGNAL_NUMBERS: Record<ShutdownSignal, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }

/** Upper bound on the cooperative stop before a signal-driven exit. */
export const ATTACHED_JOB_SHUTDOWN_TIMEOUT_MS = 3_000
/** Grace between SIGTERM and SIGKILL inside the synchronous `exit` hook. */
export const ATTACHED_JOB_EXIT_GRACE_MS = 300

const attached = new Map<string, AttachedJobHandle>()
let installedOn: AttachedJobProcess | undefined
let shuttingDown: Promise<void> | undefined
let signalExitPending = false
const listeners = new Map<string, (...args: unknown[]) => void>()

function isLive(handle: AttachedJobHandle): boolean {
  const { child } = handle
  if (child.pid === undefined) return false
  return (child.exitCode == null && child.signalCode == null) || groupAlive(child.pid)
}

function groupAlive(pid: number): boolean {
  if (os.platform() === 'win32') return false
  try { process.kill(-pid, 0); return true } catch { return false }
}

function signalGroup(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (!child.pid) return
  if (os.platform() !== 'win32') {
    try { process.kill(-child.pid, signal); return } catch { /* not a group leader or already gone */ }
  }
  if (child.exitCode != null || child.signalCode != null) return
  try { child.kill(signal) } catch { /* already gone */ }
}

function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* best effort */ }
}

/** Cooperative stop of every live attached job; resolves when all scopes report. */
export function stopAttachedJobs(): Promise<void> {
  const live = [...attached.values()].filter(isLive)
  return Promise.allSettled(live.map(handle => handle.stop())).then(() => undefined)
}

/**
 * Synchronous last resort for the `exit` event, where no async work can run:
 * SIGTERM each live group, wait up to `graceMs`, SIGKILL whatever remains.
 */
export function terminateAttachedJobsSync(graceMs = ATTACHED_JOB_EXIT_GRACE_MS): void {
  const live = [...attached.values()].filter(isLive)
  if (live.length === 0) return
  for (const handle of live) signalGroup(handle.child, 'SIGTERM')
  const deadline = Date.now() + graceMs
  let survivors = live
  while (survivors.length > 0 && Date.now() < deadline) {
    sleepSync(10)
    survivors = survivors.filter(handle => handle.child.pid !== undefined && groupAlive(handle.child.pid))
  }
  for (const handle of survivors) signalGroup(handle.child, 'SIGKILL')
}

function boundedStop(): Promise<void> {
  shuttingDown ??= (async () => {
    // A ref'd timer keeps the loop alive while scope timers (unref'd) run.
    const keepAlive = setInterval(() => {}, 1_000)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        stopAttachedJobs(),
        new Promise<void>(resolve => { timer = setTimeout(resolve, ATTACHED_JOB_SHUTDOWN_TIMEOUT_MS) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      clearInterval(keepAlive)
      shuttingDown = undefined
    }
  })()
  return shuttingDown
}

function install(proc: AttachedJobProcess): void {
  if (installedOn) return
  installedOn = proc
  const onExit = () => terminateAttachedJobsSync()
  const onBeforeExit = () => {
    if (shuttingDown || ![...attached.values()].some(isLive)) return
    void boundedStop()
  }
  listeners.set('exit', onExit)
  listeners.set('beforeExit', onBeforeExit)
  for (const signal of SHUTDOWN_SIGNALS) {
    const onSignal = () => {
      // Another listener (for example the CLI renderer cleanup) owns exit.
      const hostHandles = proc.listenerCount(signal) > 1
      const stopping = boundedStop()
      if (hostHandles || signalExitPending) return
      signalExitPending = true
      void stopping.finally(() => {
        terminateAttachedJobsSync(0)
        proc.exit(128 + SIGNAL_NUMBERS[signal])
      })
    }
    listeners.set(signal, onSignal)
  }
  for (const [event, listener] of listeners) proc.on(event as 'exit', listener)
}

function uninstallIfIdle(): void {
  if (!installedOn || attached.size > 0 || shuttingDown || signalExitPending) return
  for (const [event, listener] of listeners) installedOn.off(event as 'exit', listener)
  listeners.clear()
  installedOn = undefined
}

/**
 * Register an attached job. Its child and stdio handles are unref'd so the job
 * never keeps the host alive on its own; this module ends it with the host.
 */
export function registerAttachedJob(handle: AttachedJobHandle, proc: AttachedJobProcess = process): void {
  attached.set(handle.jobId, handle)
  const { child } = handle
  try { child.unref() } catch { /* fake child */ }
  for (const stream of child.stdio ?? []) {
    try { (stream as { unref?: () => void } | null)?.unref?.() } catch { /* not a socket */ }
  }
  child.once('close', () => {
    attached.delete(handle.jobId)
    uninstallIfIdle()
  })
  install(proc)
}

export function attachedJobIds(): readonly string[] {
  return [...attached.keys()]
}

export function __resetAttachedJobsForTest(): void {
  attached.clear()
  shuttingDown = undefined
  signalExitPending = false
  uninstallIfIdle()
}
