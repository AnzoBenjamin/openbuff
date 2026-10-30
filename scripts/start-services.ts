#!/usr/bin/env bun

/**
 * Start optional local development services in the background.
 *
 * Usage:
 *   bun start-services    # Start optional services in background
 *   bun start-cli         # Then start CLI in foreground
 *   bun stop-services     # Stop background services
 *
 * Services started:
 *   - sdk: SDK build (one-time)
 *
 * The Openbuff CLI does not require any background services for BYOK local
 * development; this script only exists to run the optional SDK build.
 *
 * This module is also the SINGLE SOURCE of the tracked-service identity used
 * by stop-services.ts and status-services.ts: TRACKED_SERVICE_ARGV, the
 * command-matching logic, and the PID-ownership check live only here, so a
 * change to the spawned argv can never desynchronize stop (which would
 * orphan the tracked build) or status (which would report PID-reuse
 * warnings) from what start actually spawns.
 */

import { execFileSync, spawn, type ChildProcess } from 'child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'fs'
import { join, resolve } from 'path'

const PROJECT_ROOT = resolve(import.meta.dir, '..')
const LOG_DIR = join(PROJECT_ROOT, 'debug', 'console')
export const PID_FILE = join(LOG_DIR, 'services.json')
const BUN_PATH = join(PROJECT_ROOT, '.bin', 'bun')

interface ServicePids {
  sdk?: number
  /**
   * The spawned build's start time at the moment services.json was written
   * (Linux /proc/<pid>/stat field 22, elsewhere `ps -o lstart=`), or null
   * when it could not be captured. The tracked build is short-lived, so its
   * PID is frequently recycled, and a recycled PID can run the identical
   * tracked argv — which command-line matching alone cannot distinguish from
   * the original build. The persisted start time changes on every recycle,
   * so every ownership check compares it against the live process's start
   * time and fails closed when it is missing or unverifiable.
   */
  sdkStartTime?: string | null
}

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Shared with status-services.ts, which reports the same success glyph. */
export function ok(name: string, message: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${name.padEnd(10)} ${message}`)
}

/** Shared with stop-services.ts and status-services.ts. */
export function loadPids(): ServicePids | null {
  if (!existsSync(PID_FILE)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf-8'))
  } catch {
    return null
  }
}

function savePids(pids: ServicePids): void {
  // Write to a unique temp file and rename atomically: a concurrent
  // stop-services/status-services reader must never observe a truncated PID
  // file between this write's truncate and flush.
  const tmpPath = `${PID_FILE}.${process.pid}.tmp`
  writeFileSync(tmpPath, JSON.stringify(pids, null, 2))
  renameSync(tmpPath, PID_FILE)
}

const START_LOCK_FILE = join(LOG_DIR, 'services.start.lock')
// Bound on the steal/retry loop below: contention between waiters resolves
// within one or two attempts, so this only prevents a pathological spin.
const START_LOCK_STEAL_ATTEMPTS = 10

/** Shared with stop-services.ts and status-services.ts. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the signal was denied, not that the process is gone: a
    // live process we lack permission to signal (e.g. the PID was recycled
    // by another user's process) must count as running, so status-services
    // does not report 'build completed' for a live foreign process and
    // awaitProcessExit's torn-identity fallback keeps polling instead of
    // reporting a premature 'exited'. Only a definitive ENOENT/ESRCH-class
    // failure means the process is dead.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    return false
  }
}

function createStartLock(): boolean {
  // The lock lives under LOG_DIR, which may not exist yet on a fresh
  // checkout (the ENOENT previously aborted `bun down` before it could
  // read the PID file).
  mkdirSync(LOG_DIR, { recursive: true })
  // Publish the holder record atomically: the PID is written to a private
  // temp file first and only then hard-linked into the lock path. linkSync
  // fails with EEXIST when the lock already exists — the same
  // exclusive-create semantics the previous openSync(path, 'wx') provided —
  // but unlike that create-then-write sequence the lock path can never exist
  // with an empty record. Otherwise a concurrent waiter that read the lock in
  // the create→write window would classify the fresh holder as dead/corrupt
  // and steal the lock immediately, so two `bun up` invocations could both
  // believe they hold it and both spawn an SDK build.
  const tmpPath = `${START_LOCK_FILE}.${process.pid}.tmp`
  writeFileSync(tmpPath, `${process.pid}\n`)
  try {
    linkSync(tmpPath, START_LOCK_FILE)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    // The published lock is its own directory entry, so unlinking the temp
    // name never removes it (and cleans up on the EEXIST path).
    try {
      unlinkSync(tmpPath)
    } catch {
      // Ignore
    }
  }
}

/**
 * Serialize concurrent `bun up` invocations with an exclusive-create lock file
 * holding the holder's PID. A lock is stolen only when its holder is provably
 * gone (dead PID, or a corrupt/empty record — which createStartLock's atomic
 * publish makes impossible to produce from the create path itself, so it can
 * only reflect external tampering). A live holder means
 * another start is mid-flight and the caller must not spawn a second SDK
 * build whose PID entry would overwrite — and orphan — the first's. There is
 * no mtime-based theft of a lock whose holder is alive: nothing refreshes the
 * lock's mtime while the holder's critical section runs, so an age threshold
 * cannot distinguish a long-lived live holder from a crashed one — stealing
 * from a live holder duplicates exactly the concurrent start the lock exists
 * to prevent. A crashed holder is reclaimed through its dead PID instead; the
 * one residual gap (a crashed holder whose PID was recycled by an unrelated
 * live process) is backed off from rather than stolen from.
 *
 * The steal itself is atomic: the stale lock is moved aside with a single
 * rename (there is no window in which the lock path is absent while the
 * validated stale lock still exists), the moved file is verified to be the
 * exact lock that was observed (same holder record, mtime, and inode), and
 * only then is the freed path claimed with an exclusive create. A
 * verification failure means the moved lock belonged to a holder that became
 * live after the observation, so it is restored instead of claimed —
 * restored, when the freed path is still free, with an EEXIST-failing link
 * rather than a rename that could clobber a lock another waiter
 * exclusive-created in the meantime. When that restore fails because the
 * freed path was already claimed, the moved lock is unlinked only once its
 * recorded holder is confirmed dead: destroying a live holder's record would
 * leave the displaced holder and the path's new owner both believing they
 * hold the start lock, so a live record is preserved (under the attempt's
 * unique stolen name) and this invocation backs off instead. This replaces
 * the
 * previous stat/read → unlink → create sequence, in which two concurrent
 * waiters that both observed the stale lock could interleave their unlink
 * and create steps and both end up holding the lock — each spawning an SDK
 * build.
 *
 * Exported for stop-services.ts, which serializes its PID-file lifecycle
 * (read → terminate → unlink) against concurrent starts with the same lock.
 */
export function acquireStartLock(): boolean {
  for (let attempt = 0; attempt < START_LOCK_STEAL_ATTEMPTS; attempt++) {
    if (createStartLock()) return true

    let observedRaw: string
    let observedMtimeMs: number
    let observedIno: number
    try {
      const stat = statSync(START_LOCK_FILE)
      const holderRaw = readFileSync(START_LOCK_FILE, 'utf-8').trim()
      const holder = holderRaw === '' ? null : Number.parseInt(holderRaw, 10)
      const holderAlive =
        holder !== null && Number.isFinite(holder) && isProcessRunning(holder)
      // Steal only a provably abandoned lock. Never steal from a live holder
      // regardless of the lock's age: nothing refreshes the mtime while the
      // holder's critical section runs, so an age threshold would rename a
      // long-lived live holder's lock aside mid-critical-section — two starts
      // would then both hold the lock and both spawn an SDK build. A crashed
      // holder is reclaimed through its dead PID instead.
      if (holderAlive) {
        return false
      }
      observedRaw = holderRaw
      observedMtimeMs = stat.mtimeMs
      observedIno = stat.ino
    } catch {
      // The lock vanished between the failed create and this read: retry the
      // exclusive create instead of stealing a path that no longer exists.
      continue
    }

    // The stolen file's name is unique per attempt so a live holder's record
    // preserved by an earlier attempt's failed restore can never be clobbered
    // by a later attempt's rename in this same loop.
    const stolenPath = `${START_LOCK_FILE}.${process.pid}.${attempt}.stolen`
    try {
      renameSync(START_LOCK_FILE, stolenPath)
    } catch {
      // The lock vanished before the rename (its holder released it, or
      // another waiter stole it): retry the exclusive create.
      continue
    }

    let stoleObservedLock = false
    try {
      const stolenStat = statSync(stolenPath)
      const stolenRaw = readFileSync(stolenPath, 'utf-8').trim()
      stoleObservedLock =
        stolenRaw === observedRaw &&
        stolenStat.mtimeMs === observedMtimeMs &&
        stolenStat.ino === observedIno
    } catch {
      stoleObservedLock = false
    }
    if (!stoleObservedLock) {
      // The moved lock was not the validated stale one: a live holder's lock
      // replaced it between the observation and the rename. Restore it so
      // its holder keeps ownership of the path — but never clobber a lock
      // another waiter exclusive-created at the freed path between the
      // steal-rename and this restore: renameSync would silently overwrite
      // it, leaving that waiter holding a lock file that records a different
      // PID (two concurrent starts could then both reach spawn/savePids).
      // linkSync fails with EEXIST when the destination exists, so the
      // restore is atomic against a concurrent claim; on failure the path's
      // current owner keeps it, and the moved lock is only discarded when its
      // recorded holder is provably dead (see below) so a live holder's
      // record is never destroyed here.
      try {
        linkSync(stolenPath, START_LOCK_FILE)
        try {
          unlinkSync(stolenPath)
        } catch {
          // Ignore
        }
      } catch {
        // The freed path was already claimed (EEXIST) or the restore failed.
        // The moved lock may hold a LIVE holder's record (it replaced the
        // validated stale lock between the observation and the rename), so it
        // must not be discarded unconditionally: destroying a live holder's
        // record would leave the displaced holder and the path's new owner
        // both believing they hold the start lock. Unlink the moved file only
        // when its recorded holder is provably dead; otherwise preserve the
        // record under this attempt's unique stolen name — nothing reads that
        // path, but the holder's record survives — and back off.
        try {
          const movedRaw = readFileSync(stolenPath, 'utf-8').trim()
          const movedHolder =
            movedRaw === '' ? null : Number.parseInt(movedRaw, 10)
          const movedHolderAlive =
            movedHolder !== null &&
            Number.isFinite(movedHolder) &&
            isProcessRunning(movedHolder)
          if (!movedHolderAlive) {
            unlinkSync(stolenPath)
          }
        } catch {
          // Ignore: the moved file is unreadable or already gone.
        }
      }
      continue
    }

    if (createStartLock()) {
      try {
        unlinkSync(stolenPath)
      } catch {
        // Ignore
      }
      return true
    }
    // Another waiter claimed the freed path between the rename and this
    // create; discard the verified-stale file we moved aside and retry.
    try {
      unlinkSync(stolenPath)
    } catch {
      // Ignore
    }
  }
  return false
}

/**
 * Release the lock only when it still holds this process's PID. The lock is
 * renamed to a private name FIRST and the moved file verified AFTER, so the
 * file removed is exactly the file verified: a read-then-unlink directly on
 * the shared path would race a concurrent waiter's steal-and-replace between
 * the read and the unlink and erase that waiter's live lock record (two
 * invocations would then both believe they hold the lock). If the moved
 * record is not ours, it is restored to the path; when the freed path was
 * already re-claimed, the moved record is discarded only when its holder is
 * provably dead — a live holder's record stays under the private name.
 * Shared with stop-services.ts.
 */
export function releaseStartLock(): void {
  const releasedPath = `${START_LOCK_FILE}.${process.pid}.released`
  try {
    renameSync(START_LOCK_FILE, releasedPath)
  } catch {
    // No lock at the path: already released or stolen. Nothing to do.
    return
  }
  try {
    if (readFileSync(releasedPath, 'utf-8').trim() === String(process.pid)) {
      try {
        unlinkSync(releasedPath)
      } catch {
        // Ignore
      }
      return
    }
    // The moved record belongs to another holder: the path was stolen and
    // replaced between our acquisition and this release. Restore it so that
    // holder keeps ownership of the lock.
    try {
      linkSync(releasedPath, START_LOCK_FILE)
      try {
        unlinkSync(releasedPath)
      } catch {
        // Ignore
      }
    } catch {
      // The freed path was already re-claimed (linkSync EEXIST): discard the
      // moved record only when its holder is provably dead; a live holder's
      // record is preserved under the private name.
      try {
        const holderRaw = readFileSync(releasedPath, 'utf-8').trim()
        const holder = holderRaw === '' ? null : Number.parseInt(holderRaw, 10)
        if (
          holder === null ||
          !Number.isFinite(holder) ||
          !isProcessRunning(holder)
        ) {
          unlinkSync(releasedPath)
        }
      } catch {
        // Ignore: the moved file is unreadable or already gone.
      }
    }
  } catch {
    // Ignore: best-effort release.
  }
}

const TERMINATE_TIMEOUT_MS = 3000
const TERMINATE_POLL_MS = 100

/**
 * Whether /proc is available (Linux). On other platforms the PID-reuse guard
 * below reads the command line via `ps` instead; when neither source is
 * available the command line cannot be verified and the PID is never
 * signalled.
 */
const PROC_AVAILABLE = existsSync('/proc')

/**
 * Whether negative-PID (process-group) signalling is supported on this
 * platform: it is POSIX-only. On Windows the tracked build is signalled by
 * its single PID as before.
 */
const GROUP_SIGNALS_SUPPORTED = process.platform !== 'win32'

/**
 * Read a process's argv (argv[0] is the executable as invoked). /proc (Linux)
 * is preferred: its NUL-separated cmdline preserves the exact argument
 * boundaries, so an executable or --cwd path containing a space cannot blur
 * argv[0] or the tracked-argument match — flattening those NULs into a
 * space-joined string would make the ownership checks below fail for this
 * script's OWN spawn whenever the checkout path contains a space (stop would
 * then unlink the ownership record without ever signalling the live build,
 * and start would spawn a duplicate, orphaning the original). Where /proc is
 * unavailable (macOS, some BSDs) `ps` provides only a space-joined command
 * line, so its output is split on whitespace — the best argument boundaries
 * available there. Returns undefined only when the argv cannot be determined
 * at all (no /proc and no working `ps`), and null when the process has no
 * readable argv (it vanished, or is a zombie).
 */
function readProcessArgv(
  pid: number,
): string[] | null | undefined {
  if (PROC_AVAILABLE) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
      const argv = cmdline.split('\0').filter((arg) => arg.length > 0)
      return argv.length > 0 ? argv : null
    } catch {
      return null
    }
  }
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim()
    const argv = command.split(' ').filter((arg) => arg.length > 0)
    return argv.length > 0 ? argv : null
  } catch {
    return undefined
  }
}

/**
 * The exact argv signature this script spawns for the tracked SDK build
 * (`bun run --cwd sdk build`). Matching this full argument sequence — rather
 * than the substrings 'sdk' or 'build', which any unrelated developer
 * process (another project's `bun run build`, `node build.js`) would also
 * contain — is what keeps a recycled PID holding a foreign command line from
 * ever being signalled. stop-services.ts and status-services.ts import the
 * ownership check built on it instead of duplicating it, so changing the
 * spawned argv here can never silently desynchronize stop (orphan
 * accumulation) or status (false PID-reuse warnings).
 */
const TRACKED_SERVICE_ARGV = ['run', '--cwd', 'sdk', 'build']

/**
 * Whether a process's argv matches the tracked SDK build's: the tracked
 * arguments must appear as a contiguous run in the argv. Matching argv
 * ELEMENTS — never a flattened, space-joined command line — is what keeps a
 * checkout path containing a space from breaking the match for the script's
 * own spawn.
 */
function argvMatchesTrackedService(argv: string[]): boolean {
  for (
    let start = 0;
    start + TRACKED_SERVICE_ARGV.length <= argv.length;
    start++
  ) {
    let matched = true
    for (let offset = 0; offset < TRACKED_SERVICE_ARGV.length; offset++) {
      if (argv[start + offset] !== TRACKED_SERVICE_ARGV[offset]) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}

/** The executable check plus tracked argv match, shared by the PID-level
 * and identity-level ownership checks. */
function argvIsTrackedService(argv: string[]): boolean {
  const executable = (argv[0] ?? '').split('/').pop() ?? ''
  if (executable !== 'bun' && executable !== 'node') return false
  return argvMatchesTrackedService(argv)
}

/**
 * Whether a live start time matches the start time persisted in services.json
 * when the tracked build was spawned. The tracked build is short-lived and
 * its PID is frequently recycled, and a recycled PID can run the identical
 * tracked argv — which command-line matching alone cannot distinguish from
 * the original build — so the persisted start time (which changes on every
 * recycle) is the only discriminator at an ownership check's first identity
 * read. Fail closed: a record without a persisted start time (services.json
 * written by an older revision, or a spawn whose start time could not be
 * captured) and a live process whose start time cannot be read are both
 * treated as not ours and never signalled.
 */
function startTimeMatchesRecord(
  liveStartTime: string | null | undefined,
  recordedStartTime: string | null | undefined,
): boolean {
  if (recordedStartTime === undefined || recordedStartTime === null) {
    return false
  }
  if (liveStartTime === undefined || liveStartTime === null) {
    return false
  }
  return liveStartTime === recordedStartTime
}

/**
 * Guard against PID reuse: services.json stores a PID plus the start time
 * captured when the tracked build was spawned, and the tracked SDK build is
 * short-lived, so its PID is frequently recycled by an unrelated process.
 * Only treat a live PID as ours when its argv is confirmed to be our
 * Bun/Node SDK build (`bun run --cwd sdk build`) AND its start time matches
 * the persisted one; an unidentified, unverifiable, or foreign argv,
 * a missing persisted start time, or a mismatching start time is never
 * signalled. When the command line or start time cannot be determined at all
 * (no /proc and no working `ps`) the check fails closed: a recycled PID
 * belonging to an unrelated process — even one running the identical tracked
 * argv — can never receive SIGTERM or SIGKILL from these scripts. Shared
 * verbatim with stop-services.ts and status-services.ts.
 */
export function isTrackedServiceProcess(
  pid: number,
  recordedStartTime?: string | null,
): boolean {
  const argv = readProcessArgv(pid)
  if (argv === undefined) return false
  if (argv === null) return false
  if (!argvIsTrackedService(argv)) return false
  return startTimeMatchesRecord(readProcessStartTime(pid), recordedStartTime)
}

/**
 * A running process's distinguishable identity: its full argv plus its start
 * time. The start time (Linux /proc/<pid>/stat field 22, elsewhere
 * `ps -o lstart=`) changes when the PID is recycled, so two processes that
 * reuse the same PID never share an identity even with identical argv. The
 * argv is kept as an array — never flattened to a space-joined string — so
 * an executable path containing a space (a checkout directory with a space)
 * cannot make the script's own spawn look foreign to the identity checks.
 * `null` means the process exists but exposes no readable identity;
 * `undefined` means identity could not be determined at all (process gone
 * mid-read, or no readable source) — callers must fail closed and never
 * signal an unverifiable PID.
 */
interface ProcessIdentity {
  argv: string[]
  startTime: string | null
}

function readProcessStartTime(pid: number): string | null | undefined {
  if (PROC_AVAILABLE) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      // Field 2 (comm) may contain spaces and parentheses, so parse the
      // fixed-position fields after the closing parenthesis of comm.
      const afterComm = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(' ')
      // afterComm[0] is state (field 3); starttime is field 22, i.e. index 19.
      const startTime = afterComm[19]
      return startTime === undefined ? null : startTime
    } catch {
      return null
    }
  }
  try {
    const lstart = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim()
    return lstart.length > 0 ? lstart : null
  } catch {
    return undefined
  }
}

function readProcessIdentity(
  pid: number,
): ProcessIdentity | null | undefined {
  const argv = readProcessArgv(pid)
  if (argv === undefined) return undefined
  if (argv === null) return null
  const startTime = readProcessStartTime(pid)
  if (startTime === undefined) return undefined
  return { argv, startTime }
}

function sameProcessIdentity(
  a: ProcessIdentity,
  b: ProcessIdentity,
): boolean {
  return (
    a.argv.length === b.argv.length &&
    a.argv.every((arg, index) => arg === b.argv[index]) &&
    a.startTime !== null &&
    a.startTime === b.startTime
  )
}

type SignalOutcome = 'signalled' | 'exited' | 'foreign' | 'denied'

/**
 * Re-verify the target's identity and deliver `signal` in one synchronous
 * sequence: there is no await between the identity read and the kill syscall,
 * so a PID recycled before the read never matches the captured identity, and
 * an identity that cannot be re-read at all fails closed. This closes the
 * check-then-act window the previous per-kill ownership re-checks left open,
 * where a PID recycled between the check and the kill syscall would receive
 * a signal meant for the tracked SDK build.
 *
 * An EPERM-denied signal is reported as 'denied' instead of 'exited': a
 * denied signal means the target is (or may still be) live and the signal
 * was not delivered, so reporting 'exited' would let the caller treat a
 * surviving tracked build as stopped and orphan it (see the catch below).
 */
function signalVerifiedProcess(
  pid: number,
  identity: ProcessIdentity,
  signal: 'SIGTERM' | 'SIGKILL',
): SignalOutcome {
  const current = readProcessIdentity(pid)
  if (current === null) {
    // A null identity means the process EXISTS but exposes no readable
    // command line — the classic shape of a zombie: a detached group leader
    // SIGKILLed externally stays unreaped until its parent reaps it, and its
    // build children/grandchildren can still be live in the same process
    // group. Reporting 'exited' here would skip the process-group signal
    // entirely, let the caller drop the PID record, and orphan the surviving
    // build while stop reports success. The group still exists while ANY
    // member lives, and the leader's PID is not reusable while the zombie
    // occupies it, so the negative-pid signal reaches exactly the tracked
    // spawn's group or nothing; the caller's awaitProcessExit poll remains
    // the confirmation path.
    if (GROUP_SIGNALS_SUPPORTED) {
      try {
        process.kill(-pid, signal)
        return 'signalled'
      } catch (error) {
        const zombieCode = (error as NodeJS.ErrnoException).code
        if (zombieCode === 'EPERM') return 'denied'
        // ESRCH-class: no member of the group can receive a signal any more.
        return 'exited'
      }
    }
    // No group signals on this platform: an unreadable-but-live identity
    // cannot be verified, so fail closed rather than claiming success.
    return 'denied'
  }
  if (current === undefined) return 'foreign'
  if (!sameProcessIdentity(current, identity)) return 'foreign'
  // The tracked build is spawned detached, which makes it a process-group
  // leader: signalling the NEGATIVE pid reaches the `bun run --cwd sdk build`
  // wrapper AND every build child/grandchild it spawned, so a stop can never
  // leave an orphaned grandchild running while start/stop/status report the
  // service as stopped. Windows has no negative-pid group signal.
  const target = GROUP_SIGNALS_SUPPORTED ? -pid : pid
  try {
    process.kill(target, signal)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      GROUP_SIGNALS_SUPPORTED &&
      code !== 'EPERM' &&
      code !== 'ESRCH' &&
      code !== 'ENOENT'
    ) {
      // Group signalling itself failed on this kernel/configuration (the
      // failure is not the target's absence): fall back to the single-PID
      // signal so the tracked leader is still terminated.
      try {
        process.kill(pid, signal)
      } catch (fallbackError) {
        const fallbackCode = (fallbackError as NodeJS.ErrnoException).code
        if (fallbackCode === 'EPERM') return 'denied'
        // ESRCH/ENOENT-class: the leader vanished between the identity read
        // and the kill syscall. For a detached spawn the leader is its own
        // group leader, so a vanished leader means the group is gone — but
        // never report 'exited' from a failed signal alone; the caller's
        // awaitProcessExit poll confirms the exit before anything is unlinked.
        return 'exited'
      }
      return 'signalled'
    }
    // EPERM means the signal was denied against a live process, not that the
    // process is gone: classifying it as 'exited' would report a successful
    // stop for a still-running tracked build, which stop-services would then
    // unlink from services.json and start-services would replace with a new
    // spawn — orphaning the survivor. Fail closed instead: the caller keeps
    // the ownership record and reports the survivor. Any other kill failure
    // (ESRCH-class: the process vanished between the identity read and the
    // kill syscall) means the tracked process — and, for a group signal, its
    // whole process group — is gone.
    if (code === 'EPERM') return 'denied'
    return 'exited'
  }
  return 'signalled'
}

/**
 * Bounded poll for the signalled process to exit, re-checking its identity
 * each poll so a PID recycled during the wait is detected before any
 * escalation signal is considered.
 */
async function awaitProcessExit(
  pid: number,
  identity: ProcessIdentity,
): Promise<'exited' | 'recycled' | 'running'> {
  const deadline = Date.now() + TERMINATE_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(TERMINATE_POLL_MS)
    const current = readProcessIdentity(pid)
    if (current === null) {
      // The process still exists but exposes no readable identity — the
      // zombie-leader shape. It has not exited: the PID is occupied and the
      // group's remaining members may still be live, so keep polling until
      // the identity disappears entirely (the bounded deadline then reports
      // 'running' and the caller fails closed instead of dropping the record
      // over a live group).
      continue
    }
    if (current === undefined) {
      // Torn snapshot between the command-line and start-time reads — the
      // process may have exited mid-read. Fall back to plain liveness; an
      // unreadable-but-live identity is retried until the deadline and is
      // never escalated against.
      if (!isProcessRunning(pid)) return 'exited'
      continue
    }
    if (!sameProcessIdentity(current, identity)) return 'recycled'
  }
  return 'running'
}

/**
 * Outcome of terminateProcess. The two gone-shaped outcomes are deliberately
 * distinct so callers can never conflate a stale record with a survivor:
 *
 * - 'terminated': the tracked target is confirmed gone — the termination flow
 *   observed its exit — so the ownership record is stale and safe to drop.
 * - 'recycled': the tracked target is confirmed gone, but its PID no longer
 *   identifies it (the PID was reused by a foreign process during a wait
 *   window, or the identity stopped matching the record before signalling).
 *   The record now points at a PID that is not the tracked build, so it is
 *   stale and safe to drop — keeping it would make a later stop report a
 *   'survivor' that no longer exists.
 * - 'survived': a live PID still occupies the record — the tracked build
 *   genuinely survived SIGKILL, a signal was denied against it, or its
 *   identity could not be verified — so the caller must fail closed and keep
 *   the record to keep the survivor owned.
 */
export type TerminateOutcome = 'terminated' | 'recycled' | 'survived'

/**
 * Terminate a tracked service process: capture the target's identity (full
 * tracked argv + start time), deliver SIGTERM only through the
 * synchronous verified-signal path, poll for exit on a bounded interval
 * instead of assuming a fixed sleep sufficed, and escalate to SIGKILL only
 * through the same verified-signal path. A PID recycled at any point never
 * matches the captured identity and is never signalled; an unreadable
 * identity fails closed. Returns 'terminated' only when the process is
 * confirmed gone, 'recycled' when the tracked process is confirmed gone but
 * its PID has been reused by a foreign process (or the identity stopped
 * matching the record), and 'survived' when a live process may still occupy
 * the record. Shared with stop-services.ts so both scripts escalate and
 * verify ownership identically.
 *
 * The captured identity is additionally checked against the start time
 * persisted in services.json when the build was spawned: a PID recycled
 * before this call — even one now running the identical tracked argv, which
 * command-line matching alone cannot distinguish from the original build —
 * never matches the persisted start time and is never signalled, and a
 * record without a persisted start time fails closed.
 */
export async function terminateProcess(
  pid: number,
  recordedStartTime?: string | null,
): Promise<TerminateOutcome> {
  const identity = readProcessIdentity(pid)
  if (identity === null || identity === undefined) return 'survived'
  if (identity.startTime === null) return 'survived'
  if (!argvIsTrackedService(identity.argv)) {
    // PID reuse: this PID no longer belongs to our service. The tracked
    // process is gone (its PID was taken over), so the record is stale —
    // not a survivor.
    return 'recycled'
  }
  // Initial-capture PID reuse with an identical tracked command line: only
  // the start time persisted at spawn distinguishes the original build from
  // a recycled PID running the same argv, and a record without a persisted
  // start time fails closed here too. A start-time mismatch means the
  // original build exited and this PID was recycled, so the record is stale.
  if (!startTimeMatchesRecord(identity.startTime, recordedStartTime)) {
    return 'recycled'
  }

  const term = signalVerifiedProcess(pid, identity, 'SIGTERM')
  if (term === 'exited') return 'terminated'
  if (term === 'foreign') return 'recycled'
  if (term === 'denied') {
    // A denied SIGTERM is not a stop: SIGKILL against the same live process
    // would be denied for the same permission reason, so fail closed now —
    // the caller keeps the ownership record instead of orphaning the
    // surviving build.
    return 'survived'
  }

  const grace = await awaitProcessExit(pid, identity)
  if (grace === 'exited') return 'terminated'
  if (grace === 'recycled') {
    // PID reuse during the SIGTERM wait: the tracked process is gone (its
    // PID was taken over by a foreign process), so the record is stale —
    // not a survivor. Conflating this with a survived SIGKILL would keep
    // services.json pointing at a foreign PID and tell the operator the
    // build 'survived termination' for a process that is already gone.
    return 'recycled'
  }

  // Still running after the SIGTERM window: escalate to SIGKILL through the
  // same verified-signal path — a PID recycled since the SIGTERM was
  // delivered never matches the captured identity and is never signalled.
  const kill = signalVerifiedProcess(pid, identity, 'SIGKILL')
  if (kill === 'exited') return 'terminated'
  // 'denied' is reachable here only if the SIGTERM was signalled but the
  // SIGKILL was denied (e.g. permissions changed mid-terminate): the process
  // may still be live, so fail closed like a denied SIGTERM above.
  if (kill === 'foreign') return 'recycled'
  if (kill === 'denied') return 'survived'

  return (await awaitProcessExit(pid, identity)) === 'exited'
    ? 'terminated'
    : 'survived'
}

/**
 * Terminate any previously tracked SDK build. Returns false when a live,
 * tracked build survived termination: the caller must then keep services.json
 * (so the survivor stays owned) and must not spawn a replacement whose PID
 * entry would orphan it. A recycled PID — the tracked build confirmed gone
 * with its PID reused by a foreign process — returns true: the record is
 * stale, not a survivor, and is dropped like any other gone outcome.
 */
async function killExistingServices(): Promise<boolean> {
  const existing = loadPids()
  if (!existing) return true

  let terminated = true
  if (
    existing.sdk &&
    isProcessRunning(existing.sdk) &&
    isTrackedServiceProcess(existing.sdk, existing.sdkStartTime)
  ) {
    const outcome = await terminateProcess(existing.sdk, existing.sdkStartTime)
    // 'terminated' and 'recycled' both mean the tracked build is confirmed
    // gone and the record is stale, so the PID-file lifecycle proceeds. Only
    // 'survived' (a live process still occupying the record) keeps
    // services.json and blocks the replacement spawn: treating a recycled
    // PID as a survivor would strand a record that points at a foreign PID
    // and refuse every later start.
    terminated = outcome !== 'survived'
  }

  if (terminated) {
    try {
      unlinkSync(PID_FILE)
    } catch {
      // Ignore
    }
  }
  return terminated
}

function spawnBackgroundProcess(
  command: string,
  args: string[],
  logFileName: string,
): ChildProcess {
  const logFile = openSync(join(LOG_DIR, logFileName), 'w')

  // Closes the parent's copy of the log descriptor. The child receives its
  // own duplicate of the fd through its stdio wiring, so closing the
  // parent's copy never truncates or interferes with the child's output —
  // it only releases the descriptor this process would otherwise keep open
  // for its entire lifetime. Guarded because closeSync on an already-closed
  // fd throws EBADF: whichever close point runs second (or should not run
  // again at all) must be a no-op, not a crash — mirroring the defensive
  // try/catch every other fs cleanup path in this file wraps itself in.
  const closeLogFd = (): void => {
    try {
      closeSync(logFile)
    } catch {
      // Ignore: already closed (EBADF) or otherwise already gone.
    }
  }

  let child: ChildProcess
  try {
    child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', logFile, logFile],
      env: process.env,
    })
  } catch (spawnError) {
    // spawn() itself can throw synchronously (e.g. an invalid argument
    // shape) — a path in which no child was created, so no fd was ever
    // inherited and neither listener below will ever run. Closing before
    // rethrowing is what keeps the start script from exiting with the log
    // descriptor still open.
    closeLogFd()
    throw spawnError
  }

  // The parent's copy of the log fd must be closed once the child has taken
  // it, on BOTH outcomes:
  //
  // - 'spawn' is the safe close point on success: it fires only after the
  //   child process was created with the fd inherited, so closing any
  //   earlier could race the kernel's duplication of the fd into the child
  //   and drop the build's stdout/stderr mid-stream.
  // - 'error' covers the spawn-failure path (a missing or unexecutable
  //   .bin/bun, spawn-time ENOENT), where 'spawn' never fires and the fd
  //   would otherwise leak with nothing ever inheriting it.
  //
  // On any given spawn exactly one of the two outcomes occurs, but each is
  // registered as a once-listener and closeLogFd tolerates an already-closed
  // fd, so the overlap is harmless by construction.
  child.once('spawn', closeLogFd)
  child.once('error', closeLogFd)

  // A spawn failure (a missing or unexecutable .bin/bun, spawn-time ENOENT)
  // is delivered as an 'error' event on the child, not as a throw from
  // spawn(): without a listener the unhandled 'error' event throws and
  // crashes the start script AFTER the PID was already persisted to
  // services.json and after the caller reported the service as started.
  // Swallowing the event keeps the script's exit flow intact: the dead PID
  // stays tracked, and stop/status (and the next start's terminate phase)
  // already treat a dead tracked PID as gone.
  child.on('error', () => {
    // Intentionally ignored: the failure surfaces through the tracked PID's
    // absence on the next stop/status/start, not through this script's exit.
  })

  child.unref()
  return child
}

function startBackgroundServices(): ServicePids {
  const pids: ServicePids = {}

  // The spawned argv is exactly the tracked signature above: one source of
  // truth for what is spawned and what stop/status recognize as ours.
  const sdk = spawnBackgroundProcess(BUN_PATH, TRACKED_SERVICE_ARGV, 'sdk.log')
  if (sdk.pid) {
    pids.sdk = sdk.pid
    // Persist the child's start time beside its PID: the tracked build is
    // short-lived, so its PID is likely to be recycled, and a recycled PID
    // running the identical tracked argv is indistinguishable from this
    // build by command line alone. The start time changes on every recycle,
    // so every later ownership check (stop, status, and a later start's
    // terminate phase) can tell them apart; a failed capture persists null,
    // which makes every later check fail closed instead of signalling an
    // unverified PID.
    pids.sdkStartTime = readProcessStartTime(sdk.pid) ?? null
  }
  ok('sdk', '(building)')

  return pids
}

async function main(): Promise<void> {
  ensureLogDir()

  console.log('Starting optional local services in background...')

  // Serialize concurrent starts under an exclusive lock: two concurrent `bun
  // up` invocations must not both pass the loadPids/terminate phase and each
  // spawn an SDK build — the second savePids() would overwrite the first's
  // PID entry, leaving the first spawned build untracked and unreapable by
  // stop-services.
  if (!acquireStartLock()) {
    console.log(
      '  Another "bun up" is already starting services; skipping this invocation.',
    )
    console.log('')
    console.log('Now run: bun start-cli')
    return
  }
  try {
    const cleared = await killExistingServices()
    if (!cleared) {
      console.error(
        '  The previous SDK build survived termination; its PID stays tracked in services.json. Not starting a replacement — run `bun down` and retry.',
      )
      return
    }

    const pids = startBackgroundServices()
    // The spawn→save window must stay as short as possible, and a savePids
    // failure must not leave a spawned, untracked build behind: an orphan
    // with no services.json entry can never be reaped by PID (the hazard
    // main()'s own locking rationale exists to prevent), so on save failure
    // the just-spawned build is terminated before the error surfaces.
    try {
      savePids(pids)
    } catch (saveError) {
      if (pids.sdk && isTrackedServiceProcess(pids.sdk, pids.sdkStartTime)) {
        try {
          await terminateProcess(pids.sdk, pids.sdkStartTime)
        } catch {
          // Ignore: best-effort reaping; the error below is the root cause.
        }
      }
      throw saveError
    }
  } finally {
    releaseStartLock()
  }

  console.log('')
  console.log(`  View logs:  tail -f ${join(LOG_DIR, 'sdk.log')}`)
  console.log(`  Stop with:  bun down`)
  console.log('')
  console.log('Now run: bun start-cli')
}

// Only run when executed directly: stop-services.ts and status-services.ts
// import the shared tracked-service identity from this module and must not
// trigger a service start by importing it.
if (import.meta.main) {
  main().catch((error) => {
    console.error('Error starting services:', error)
    process.exit(1)
  })
}
