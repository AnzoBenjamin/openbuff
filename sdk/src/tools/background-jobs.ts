import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { StringDecoder } from 'string_decoder'

import {
  SETTLED_JOB_TTL_MS,
  UNKNOWN_JOB_OWNER,
  jobRegistry,
  type JobOwner,
} from '@codebuff/common/util/job-registry'

/**
 * Thin ProcessJobAdapter over the shared `jobRegistry` core (M2). The
 * registry is the single source of truth for a shell job's lifecycle state,
 * ownership, and output/event stream; this adapter only owns the OS child
 * process, the on-disk log file, and the write-only recovery projection
 * (`openbuff-<jobId>.json` in the OS temp dir).
 *
 * Each job streams stdout+stderr to a temp log file; check_job reads the new
 * bytes since the last check (tracked by readOffset, the adapter's own
 * incremental-read cursor) so output is never duplicated or lost between
 * polls. Streamed bytes are also mirrored into the registry as `output`
 * events so registry consumers observe the same stream.
 */
export type BackgroundJobStatus =
  | 'running'
  | 'completed'
  | 'error'
  | 'lost'
  | 'stopped'

/**
 * Ownership identity for a background job. This is the core registry's
 * JobOwner: ownership checks go through `jobRegistry.assertOwned` rather
 * than the old pending-background-jobs mirror.
 */
export type BackgroundJobOwner = JobOwner

export function isProcessTreeAlive(child: Pick<ChildProcess, 'pid'>): boolean {
  if (!child.pid) return false
  try {
    process.kill(os.platform() === 'win32' ? child.pid : -child.pid, 0)
    return true
  } catch {
    return false
  }
}

export function terminateProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: 'SIGTERM' | 'SIGKILL',
): boolean {
  if (!child.pid) return false
  if (os.platform() !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch {
      // Fall back to the direct child when process-group signaling is not
      // available (for example, recovered legacy jobs).
    }
  }
  try {
    return child.kill(signal)
  } catch {
    return false
  }
}

export interface BackgroundJob {
  jobId: string
  command: string
  child: ChildProcess
  logFile: string
  metadataFile: string
  /**
   * Live mirror of the registry lifecycle state for this job. The registry
   * is authoritative; the adapter updates this field on every transition so
   * existing consumers (check_job/kill_job/read_logs) keep working.
   */
  status: BackgroundJobStatus
  exitCode: number | null
  startedAt: number
  /** Bytes of the log file already returned by check_job. */
  readOffset: number
  /** Preserves incomplete UTF-8 sequences across bounded incremental reads. */
  decoder?: StringDecoder
  /**
   * True only for jobs spawned by `startBackgroundJob`, which own a live
   * per-job drainer running on the 250ms `logQuotaTimer` interval. check_job
   * must NOT drain such a job (that would corrupt the shared
   * readOffset/decoder/lineCarry cursor); recovered and test-registered jobs
   * leave this undefined and keep draining via check_job's readNewJobOutput.
   */
  hasLiveDrainer?: boolean
  /**
   * Per-adapter registry consumer cursor for check_job. Tracks how far the
   * adapter has already returned events to a check_job caller — independent
   * of the live drainer's readOffset/decoder/lineCarry progress. Defaults to
   * 0 so the first check_job observes output the live interval already
   * mirrored into the registry; advanced to the returned nextCursor on each
   * successful check_job. Do NOT treat "already mirrored by the live drainer"
   * as "already consumed by check_job".
   */
  lastCheckCursor?: number
  /**
   * Retained partial trailing line (bytes drained after the last newline).
   * emitJobOutputLines carries it across drains so output enters the registry
   * as complete per-line events; a settled job's final drain flushes it.
   */
  lineCarry?: string
  /** Epoch ms when the job FIRST became terminal; set once in settleBackgroundJob. */
  settledAt?: number
  owner?: BackgroundJobOwner
  /** Wall-clock time of the last throttled metadata write, if any. */
  lastMetadataWriteAt?: number
  /**
   * Linux `/proc/<pid>/stat` field-22 starttime captured at spawn. Used to
   * verify a RECOVERED job's pid still belongs to the original process
   * before a group-kill (pid reuse guard); undefined on non-Linux hosts.
   */
  childProcessStartTime?: string
  /**
   * Project root used for the pre-start dirty snapshot (BACKGROUND start).
   * In-memory only — not written to recovery metadata. Recovered jobs omit it.
   */
  projectRoot?: string
  /**
   * Project-relative dirty paths captured immediately before spawn. Used by
   * check_job on first settlement observation to compute a one-shot dirty
   * delta. Soft-fail: undefined when git was unavailable at start.
   */
  dirtyBeforePaths?: string[]
  /**
   * One-shot settlement dirty delta. `undefined` means not yet resolved on a
   * settled observation; once set (possibly to `[]`) subsequent check_job
   * polls must not recompute or re-emit `touchedPaths`.
   */
  settlementTouchedPaths?: string[]
}

/**
 * Live adapter records keyed by the user-facing jobId (for jobs spawned by
 * this process, the registry-issued id used for the temp file names). This
 * Map only owns the OS process/log-file/recovery-projection handles —
 * lifecycle state and events live in the shared `jobRegistry`.
 */
const jobs = new Map<string, BackgroundJob>()
const metadataFilesCreatedByThisProcess = new Set<string>()

/**
 * Max age of orphaned background-job log/metadata files in /tmp before they
 * are eligible for cleanup on the next startBackgroundJob call. Set to 24h to
 * preserve recently-completed jobs for short-lived recovery while preventing
 * unbounded accumulation across CLI sessions.
 */
const ORPHANED_JOB_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_BACKGROUND_LOG_BYTES = 10 * 1024 * 1024
export const MAX_BACKGROUND_READ_BYTES = 100_000
/**
 * Max bytes emitJobOutputLines retains in `lineCarry` without seeing a newline
 * before it force-emits the carry as a single event. This bounds carry growth
 * on a newline-less flood so a chatty child cannot accumulate unbounded output
 * in memory while waiting for a line terminator that never arrives.
 */
export const MAX_LINE_BYTES = 64 * 1024
const BACKGROUND_LOG_MONITOR_INTERVAL_MS = 250
/**
 * Minimum interval between per-poll metadata writes in readNewJobOutput. The
 * readOffset is persisted for cross-session recovery, so we throttle the churn
 * of writing metadata on every read while still writing promptly on settle.
 */
const METADATA_WRITE_THROTTLE_MS = 1000
const JOB_ID_PATTERN = /^job-[A-Za-z0-9_-]+$/
/**
 * Permissions for newly-created background job temp files. 0o600 keeps the
 * log/metadata readable only by the owning user, since they may contain
 * sensitive command output.
 */
const JOB_FILE_MODE = 0o600
/**
 * `O_NOFOLLOW` causes open() to fail with ELOOP when the final path component
 * is a symlink. On Windows it is not defined; fall back to 0 (no-op) since
 * symlink semantics differ there and the temp dir is not world-writable.
 */
const O_NOFOLLOW_FLAG =
  typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
let orphanedJobFilesSwept = false

/**
 * Create a background-job log file for appending without following symlinks
 * or reusing an existing path. `O_EXCL` rejects both pre-created regular files
 * and symlinks, preventing temp-file clobbering despite the shared temp dir.
 */
function safeCreateJobLogFile(logFile: string): number {
  return fs.openSync(
    logFile,
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      O_NOFOLLOW_FLAG,
    JOB_FILE_MODE,
  )
}

/**
 * Provide a clear early error for pre-existing symlinks. The open() calls also
 * use O_NOFOLLOW so a symlink swapped in after this check is still rejected.
 */
function rejectIfSymlink(candidate: string): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(candidate)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing to start background job: temp file "${candidate}" is a symlink.`,
    )
  }
}

/**
 * Write background-job metadata without following symlinks. The first write
 * creates the file exclusively; later writes may truncate only a metadata path
 * created by this process.
 */
function safeWriteJobMetadata(
  metadataFile: string,
  metadata: BackgroundJobMetadata,
): void {
  const firstWrite = !metadataFilesCreatedByThisProcess.has(metadataFile)
  const flags = firstWrite
    ? fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      O_NOFOLLOW_FLAG
    : fs.constants.O_WRONLY | fs.constants.O_TRUNC | O_NOFOLLOW_FLAG

  const fd = fs.openSync(metadataFile, flags, JOB_FILE_MODE)
  try {
    fs.writeSync(fd, JSON.stringify(metadata, null, 2))
    metadataFilesCreatedByThisProcess.add(metadataFile)
  } finally {
    fs.closeSync(fd)
  }
}

export function safeOpenJobLogForRead(
  logFile: string,
): { fd: number; size: number } | { errorMessage: string } {
  try {
    const lstat = fs.lstatSync(logFile)
    if (!lstat.isFile()) {
      return { errorMessage: `Path is not a regular file: ${logFile}` }
    }

    const fd = fs.openSync(logFile, fs.constants.O_RDONLY | O_NOFOLLOW_FLAG)
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile()) {
        fs.closeSync(fd)
        return { errorMessage: `Path is not a regular file: ${logFile}` }
      }
      return { fd, size: stat.size }
    } catch (error) {
      fs.closeSync(fd)
      return {
        errorMessage: `Could not inspect log file: ${(error as Error).message}`,
      }
    }
  } catch (error) {
    return {
      errorMessage: `Could not open log file safely: ${(error as Error).message}`,
    }
  }
}

/**
 * Truncate a background-job log file to at most `maxBytes` by dropping the
 * HEAD (oldest bytes) and keeping the TAIL (newest bytes). The newest output
 * is the most diagnostically useful for a job terminated due to log quota —
 * errors, build failures, and recent status messages live there. No-op when
 * the file is already within quota. Opens the file safely (O_NOFOLLOW) and
 * rewrites the tail in place to avoid leaving a sparse/holey file behind
 * (truncating a live append-only fd below its write offset is undefined per
 * POSIX).
 */
function truncateLogToTail(logFile: string, maxBytes: number): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(logFile, fs.constants.O_RDWR | O_NOFOLLOW_FLAG)
    const size = fs.fstatSync(fd).size
    if (size <= maxBytes) return
    const keepStart = size - maxBytes
    const buf = Buffer.alloc(maxBytes)
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, keepStart)
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, buf.subarray(0, bytesRead), 0, bytesRead, 0)
  } catch {
    // best-effort truncation; the exit path owns final cleanup
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // already closed
      }
    }
  }
}

function safeReadJobMetadataFile(metadataFile: string): string | undefined {
  let fd: number | undefined
  try {
    const lstat = fs.lstatSync(metadataFile)
    if (!lstat.isFile()) return undefined

    fd = fs.openSync(metadataFile, fs.constants.O_RDONLY | O_NOFOLLOW_FLAG)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return undefined

    return fs.readFileSync(fd, 'utf8')
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // already closed
      }
    }
  }
}

/**
 * Best-effort cleanup of stale `openbuff-job-*.{log,json}` files left in the
 * OS temp dir by previous CLI sessions. Runs once per process, lazily on the
 * first background-job spawn, and never throws.
 */
function sweepOrphanedJobFiles(): void {
  if (orphanedJobFilesSwept) return
  orphanedJobFilesSwept = true
  sweepOrphanedJobFilesForTest()
}

function shouldPreserveJobMetadata(metadataFile: string): boolean {
  // FAIL CLOSED (SEC-4): any unreadable / symlink / parse-error / missing-pid
  // metadata must PRESERVE the file rather than delete it — a destructive
  // sweep must never act on metadata it could not fully verify.
  try {
    const rawMetadata = safeReadJobMetadataFile(metadataFile)
    if (rawMetadata === undefined) return true
    let metadata: Partial<BackgroundJobMetadata>
    try {
      metadata = JSON.parse(rawMetadata) as Partial<BackgroundJobMetadata>
    } catch {
      return true
    }
    if (metadata.status !== 'running') return false
    if (metadata.processId === null || metadata.processId === undefined) {
      // Be conservative when we cannot verify liveness.
      return true
    }
    return isProcessAlive(metadata.processId)
  } catch {
    return true
  }
}

/** Unlink only a real regular file (never a symlink); re-lstat immediately
 * before unlinking to fail closed against a TOCTOU swap. */
function removeFileIfPresent(filePath: string): void {
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) return
    fs.unlinkSync(filePath)
  } catch {
    // file vanished or permission denied — skip
  }
}

function sweepOrphanedJobFilesForTest(): void {
  try {
    const tmpDir = os.tmpdir()
    const entries = fs.readdirSync(tmpDir)
    const now = Date.now()
    for (const entry of entries) {
      if (!entry.startsWith('openbuff-job-')) continue
      if (!entry.endsWith('.log') && !entry.endsWith('.json')) continue
      const fullPath = path.join(tmpDir, entry)
      try {
        const stat = fs.lstatSync(fullPath)
        if (now - stat.mtimeMs <= ORPHANED_JOB_FILE_MAX_AGE_MS) continue

        const metadataFile = entry.endsWith('.json')
          ? fullPath
          : fullPath.replace(/\.log$/, '.json')
        if (
          fs.existsSync(metadataFile) &&
          shouldPreserveJobMetadata(metadataFile)
        ) {
          continue
        }

        removeFileIfPresent(fullPath)
        if (entry.endsWith('.json')) {
          removeFileIfPresent(fullPath.replace(/\.json$/, '.log'))
        }
      } catch {
        // file vanished or permission denied — skip
      }
    }
  } catch {
    // tmpdir unreadable — give up silently
  }
}

/**
 * Write-only recovery projection of a job. The adapter mirrors every state
 * transition into this file, but live state/ownership decisions never
 * consult it — the registry is the source of truth. The file is read back
 * only by recoverBackgroundJob on a live `get` miss (cross-session
 * recovery).
 */
type BackgroundJobMetadata = {
  jobId: string
  command: string
  processId: number | null
  logFile: string
  status: BackgroundJobStatus
  exitCode: number | null
  startedAt: number
  readOffset?: number
  /** Epoch ms when the job first became terminal; written on settle for recovery. */
  settledAt?: number
  owner?: BackgroundJobOwner
  childProcessStartTime?: string
}

function writeBackgroundJobMetadata(job: BackgroundJob): void {
  const metadata: BackgroundJobMetadata = {
    jobId: job.jobId,
    command: job.command,
    processId: job.child.pid ?? null,
    logFile: job.logFile,
    status: job.status,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    readOffset: job.readOffset,
    ...(job.settledAt !== undefined ? { settledAt: job.settledAt } : {}),
    owner: job.owner,
    childProcessStartTime: job.childProcessStartTime,
  }
  try {
    safeWriteJobMetadata(job.metadataFile, metadata)
  } catch {
    // best-effort recovery metadata
  }
}


/**
 * Fold a terminal lifecycle transition into the registry and mirror it onto
 * the adapter object + the write-only disk projection. All terminal paths
 * (exit, error, kill, log-quota) funnel through here; the registry ignores
 * lifecycle events after a terminal state, so exactly one transition wins
 * even when several paths race (e.g. quota kill followed by the exit event).
 */
function settleBackgroundJob(
  job: BackgroundJob,
  status: BackgroundJobStatus,
  exitCode: number | null,
  error?: string,
): void {
  job.status = status
  job.exitCode = exitCode
  // Stamp the FIRST terminal time once. settleBackgroundJob can be reached
  // from multiple terminal paths (child exit, child error, kill, log-quota);
  // keep the earliest stamp so the TTL window is correct and a late duplicate
  // settle can't extend an entry's lifetime. Running jobs keep settledAt
  // undefined so the prune ignores them.
  if (job.settledAt === undefined) {
    job.settledAt = Date.now()
  }
  jobRegistry.emit(job.jobId, {
    type: 'lifecycle',
    state: status,
    exitCode,
    ...(error !== undefined ? { error } : {}),
  })
  writeBackgroundJobMetadata(job)
}

/**
 * Internal helper: drop TTL-expired settled entries from the live `jobs` Map.
 * Only jobs whose terminal `settledAt` is older than SETTLED_JOB_TTL_MS are
 * removed; running jobs (settledAt undefined) and within-TTL settled jobs are
 * retained so their final output/exit code stay servable. Swept lazily (no
 * timer) from getBackgroundJob/startBackgroundJob. Exported only so a
 * deterministic regression test can inject `now`.
 */
export function pruneSettledJobs(now: number = Date.now()): void {
  for (const [jobId, record] of jobs) {
    if (
      record.settledAt !== undefined &&
      now - record.settledAt > SETTLED_JOB_TTL_MS
    ) {
      jobs.delete(jobId)
    }
  }
}

/** Mirror a chunk of streamed log bytes into the registry as an output event. */
function emitJobOutput(job: BackgroundJob, data: string): void {
  if (data.length === 0) return
  jobRegistry.emit(job.jobId, { type: 'output', data })
}

/**
 * Per-line inversion of emitJobOutput: append `text` to the job's `lineCarry`,
 * split on '\n', and emit each COMPLETE line (line + '\n') as its own registry
 * `output` event, retaining the trailing partial (no newline yet) in
 * `lineCarry` for the next drain. Output therefore enters the registry
 * line-by-line at drain time (timestamps stamped by jobRegistry.emit), not as
 * one blob. A newline-less flood is bounded by MAX_LINE_BYTES: once the carry
 * grows past the cap with no newline, it is force-emitted as one event and
 * reset so the carry can never grow without bound.
 */
function emitJobOutputLines(job: BackgroundJob, text: string): void {
  if (text.length === 0) return
  job.lineCarry = (job.lineCarry ?? '') + text
  let newlineIndex = job.lineCarry.indexOf('\n')
  while (newlineIndex !== -1) {
    emitJobOutput(job, job.lineCarry.slice(0, newlineIndex + 1))
    job.lineCarry = job.lineCarry.slice(newlineIndex + 1)
    newlineIndex = job.lineCarry.indexOf('\n')
  }
  if (job.lineCarry.length > MAX_LINE_BYTES) {
    emitJobOutput(job, job.lineCarry)
    job.lineCarry = ''
  }
}

/**
 * Flush any retained partial trailing line as a final `output` event. Called
 * on a settled job's final drain so a last line without a newline is not lost.
 * No-op when the carry is empty.
 */
export function flushJobLineCarry(job: BackgroundJob): void {
  if (job.lineCarry && job.lineCarry.length > 0) {
    emitJobOutput(job, job.lineCarry)
    job.lineCarry = ''
  }
}

/**
 * Return the current retained partial trailing line (bytes drained after the
 * last newline) WITHOUT emitting or clearing it. Lets a consumer's wait_for
 * match window see text that has been drained from the log but not yet
 * emitted as a per-line registry `output` event. Read-only; never mutates.
 */
export function peekJobLineCarry(job: BackgroundJob): string {
  return job.lineCarry ?? ''
}

function getBackgroundJobFilePath(
  jobId: string,
  extension: 'log' | 'json',
): string | undefined {
  if (!JOB_ID_PATTERN.test(jobId)) {
    return undefined
  }
  return path.join(os.tmpdir(), `openbuff-${jobId}.${extension}`)
}

function isUsableRecoveredLogFile(logFile: string): boolean {
  try {
    return fs.lstatSync(logFile).isFile()
  } catch {
    return false
  }
}

/**
 * Spawn a detached-from-the-step background process whose combined output is
 * appended to a temp log file. Returns immediately; the agent observes
 * progress via check_job.
 */
export function startBackgroundJob(params: {
  command: string
  shell: string
  shellArgs: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  owner?: BackgroundJob['owner']
  /** Project root for settlement dirty-delta attribution (in-memory only). */
  projectRoot?: string
  /** Pre-start dirty paths snapshot; omitted when git unavailable. */
  dirtyBeforePaths?: string[]
}): BackgroundJob {
  const { command, shell, shellArgs, cwd, env } = params
  const owner = params.owner ?? UNKNOWN_JOB_OWNER
  sweepOrphanedJobFiles()
  // Bound the Map at every spawn to the jobs settled within the TTL window,
  // so a long agent session does not accumulate dead process handles.
  pruneSettledJobs()
  // The registry issues the job id; the on-disk log/metadata file names are
  // derived from it so cross-session recovery can find them by id.
  const jobId = jobRegistry.create({
    kind: 'process',
    label: command,
    owner,
  }).jobId
  const logFile = getBackgroundJobFilePath(jobId, 'log')!
  const metadataFile = getBackgroundJobFilePath(jobId, 'json')!
  // Reject pre-existing symlinks at both paths before opening for write.
  // safeCreateJobLogFile/safeWriteJobMetadata also use O_EXCL + O_NOFOLLOW so
  // pre-created regular files and TOCTOU symlink swaps are rejected at open().
  let outFd: number | undefined
  let child: ChildProcess
  try {
    rejectIfSymlink(logFile)
    rejectIfSymlink(metadataFile)
    outFd = safeCreateJobLogFile(logFile)
    child = spawn(shell, [...shellArgs, command], {
      cwd,
      env,
      stdio: ['ignore', outFd, outFd],
      detached: os.platform() !== 'win32',
    })
  } catch (error) {
    // If safeCreateJobLogFile succeeded but spawn threw, the already-opened
    // log fd would otherwise leak. Close it best-effort before folding the
    // failed spawn into the registry.
    if (typeof outFd === 'number') {
      try {
        fs.closeSync(outFd)
      } catch {
        // already closed
      }
    }
    // The log file was created exclusively for this spawn (O_EXCL); on a failed
    // spawn nobody else can own it, so remove it best-effort rather than leaving
    // an empty temp file behind until the 24h+ orphan sweep.
    try {
      fs.unlinkSync(logFile)
    } catch {
      // best-effort; the orphan sweep will clean it up if removal fails
    }
    // Fold the failed spawn into the registry so the freshly-created id does
    // not linger as a queued job (queued only transitions via running).
    jobRegistry.start(jobId)
    jobRegistry.emit(jobId, {
      type: 'lifecycle',
      state: 'error',
      error: (error as Error).message,
    })
    throw error
  }

  const job: BackgroundJob = {
    jobId,
    command,
    child,
    logFile,
    metadataFile,
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    readOffset: 0,
    // Live jobs own their drainer on the logQuotaTimer interval below; this
    // flag tells check_job NOT to drain them (see check-job.ts).
    hasLiveDrainer: true,
    decoder: new StringDecoder('utf8'),
    owner,
    childProcessStartTime: child.pid
      ? readProcessStartTime(child.pid)
      : undefined,
    ...(params.projectRoot !== undefined
      ? { projectRoot: params.projectRoot }
      : {}),
    ...(params.dirtyBeforePaths !== undefined
      ? { dirtyBeforePaths: params.dirtyBeforePaths }
      : {}),
  }
  jobRegistry.start(jobId)

  let quotaExceeded = false
  const logQuotaTimer = setInterval(() => {
    try {
      // Job-owned drainer: drain newly-written log bytes into the registry as
      // per-line output events FIRST, independently of check_job. This MUST
      // run before the quota early-return below — otherwise a normal-sized job
      // (the common case, size <= MAX_BACKGROUND_LOG_BYTES) would never drain.
      // The gate in check-job.ts ensures a live job is drained only here, so
      // the shared readOffset/decoder/lineCarry cursor is never double-drained.
      readNewJobOutput(job)
      const size = fs.statSync(logFile).size
      if (size <= MAX_BACKGROUND_LOG_BYTES) return
      if (!quotaExceeded) {
        quotaExceeded = true
        // Quota termination is an error: emit the terminal lifecycle now so
        // the registry settles even if the child hangs on SIGTERM. The later
        // exit event is ignored by the registry (terminal states absorb).
        settleBackgroundJob(
          job,
          'error',
          job.exitCode,
          `background job exceeded the ${MAX_BACKGROUND_LOG_BYTES}-byte log quota`,
        )
        terminateProcessTree(child, 'SIGTERM')
      }
      // Keep trimming while the process is unwinding so a chatty child cannot
      // regrow a sparse/oversized log between SIGTERM and exit.
      //
      // Deliberate tradeoff: truncation keeps the TAIL (newest bytes) and drops
      // the oldest output. The job is being terminated for exceeding its log
      // quota, and the newest output is the most diagnostically useful — errors,
      // build failures, and recent status messages live in the tail; losing the
      // head is a known, accepted cost.
      truncateLogToTail(logFile, MAX_BACKGROUND_LOG_BYTES)
    } catch {
      // The process exit/error handlers own final cleanup.
    }
  }, BACKGROUND_LOG_MONITOR_INTERVAL_MS)
  logQuotaTimer.unref?.()

  const closeLog = () => {
    clearInterval(logQuotaTimer)
    try {
      fs.closeSync(outFd)
    } catch {
      // already closed
    }
  }
  writeBackgroundJobMetadata(job)
  child.on('exit', (code) => {
    // A prior killBackgroundJob call settles the job as 'stopped'
    // synchronously before this exit fires. SIGTERM produces a non-zero exit
    // code, so treat an already-'stopped' job as an intentional stop rather
    // than an error and preserve the documented 'stopped' contract. Quota
    // termination still wins (the job already settled as 'error').
    const intentionallyStopped = job.status === 'stopped'
    const status = quotaExceeded
      ? 'error'
      : intentionallyStopped
        ? 'stopped'
        : code === 0
          ? 'completed'
          : 'error'
    if (quotaExceeded) {
      // See the log-quota monitor above: truncation keeps the TAIL (newest
      // bytes) and drops the oldest output. Known, accepted tradeoff for a
      // job terminated for exceeding its log quota.
      try {
        truncateLogToTail(logFile, MAX_BACKGROUND_LOG_BYTES)
      } catch {
        // best-effort truncation; the exit path owns final cleanup
      }
    }
    // Final drain BEFORE settle + closeLog: capture any bytes written between
    // the last interval tick and exit, then flush the partial trailing line so
    // a last line without a newline is not lost. closeLog() clears the
    // interval, so this must precede it; JS single-threading guarantees the
    // interval callback cannot interleave with this handler.
    readNewJobOutput(job)
    flushJobLineCarry(job)
    // Terminal lifecycle is emitted exactly once per job: the registry folds
    // the first transition in and ignores this one when kill/quota already
    // settled the job, keeping the final state/exit code servable after exit.
    settleBackgroundJob(job, status, code)
    closeLog()
  })
  child.on('error', (error) => {
    // Final drain + carry flush before settle (same ordering as exit above).
    readNewJobOutput(job)
    flushJobLineCarry(job)
    settleBackgroundJob(job, 'error', job.exitCode, error.message)
    closeLog()
  })

  jobs.set(jobId, job)
  return job
}

/** True when an owner is the placeholder used for ownerless/test jobs. */
function isUnknownJobOwner(owner: BackgroundJobOwner | undefined): boolean {
  return (
    owner === undefined ||
    (owner.clientSessionId === UNKNOWN_JOB_OWNER.clientSessionId &&
      owner.rootRunId === UNKNOWN_JOB_OWNER.rootRunId)
  )
}

/**
 * Resolve the owner to stamp on re-attach. A trusted restampOwner UPGRADES
 * ownership only when the current owner is the placeholder/unknown owner;
 * an already-real owner is never overwritten (prevents cross-run ownership
 * laundering, SEC-2). Returns undefined when no upgrade applies so callers
 * fall back to the existing owner.
 *
 * Ownerless recovered jobs (UNKNOWN_JOB_OWNER / missing owner on disk) are
 * restamped by the FIRST check_job caller that supplies a trusted
 * restampOwner. That is intentional first-claimer semantics for orphan
 * recovery: any trusted session may claim an ownerless job, after which
 * assertOwned binds it to that owner. Cross-session first-claimer laundering
 * of ALREADY-OWNED jobs is prevented by the already-real-owner gate above;
 * only UNKNOWN_JOB_OWNER jobs are claimable. If product policy later requires
 * that solely the spawning session may claim ownerless jobs, gate the upgrade
 * here (e.g. match restampOwner to spawn metadata) rather than relaxing the
 * already-real-owner check.
 */
function resolveRestampedOwner(
  currentOwner: BackgroundJobOwner | undefined,
  restampOwner: BackgroundJobOwner | undefined,
): BackgroundJobOwner | undefined {
  if (!restampOwner || isUnknownJobOwner(restampOwner)) return undefined
  if (!isUnknownJobOwner(currentOwner)) return undefined
  return restampOwner
}

/**
 * Read-only adapter lookup by jobId (no recovery, no ownership changes).
 * list_jobs uses this to read `lastCheckCursor` / `lineCarry` from the
 * adapter without triggering recovery or ownership restamping.
 */
export function getBackgroundJobAdapter(jobId: string): BackgroundJob | undefined {
  pruneSettledJobs()
  return jobs.get(jobId)
}

export function getBackgroundJob(
  jobId: string,
  opts?: { restampOwner?: BackgroundJobOwner },
): BackgroundJob | undefined {
  // Lazily amortize the settled-job sweep on the hottest read path: a
  // settle→read within TTL stays registry-consistent (the shared registry
  // sweeps settled entries on its own TTL, so a cached adapter job must not
  // outlive the registry record that serves it).
  pruneSettledJobs()
  const existing = jobs.get(jobId)
  if (existing) {
    // Re-attach path: a job first recovered without a trusted owner is cached
    // in the registry under UNKNOWN_JOB_OWNER. When a later trusted caller
    // supplies restampOwner, UPGRADE the registry record from the placeholder
    // to the trusted owner exactly once — but NEVER overwrite an already-real
    // owner (that would allow cross-run ownership laundering, SEC-2). Without
    // this, the cached-job early return skips the re-stamp and the trusted
    // caller is locked out of its own job by assertOwned. Gate on the
    // REGISTRY record's current owner being unknown (SEC-2).
    const registryJob = jobRegistry.get(jobId)
    const upgraded = registryJob
      ? resolveRestampedOwner(registryJob.owner, opts?.restampOwner)
      : undefined
    if (upgraded) {
      jobRegistry.restampOwner(jobId, upgraded)
      existing.owner = upgraded
    }
    return existing
  }

  const recovered = recoverBackgroundJob(jobId)
  if (recovered) {
    // Post-TTL settled recoveries must not re-enter the live Map or create a
    // fresh registry row (that would reset completedAt and defeat pruning).
    // Leave orphan disk files for the existing 24h orphan sweep.
    if (
      recovered.status !== 'running' &&
      recovered.settledAt !== undefined &&
      Date.now() - recovered.settledAt > SETTLED_JOB_TTL_MS
    ) {
      return undefined
    }

    // Re-emit the recovered job into the registry, which is the live source
    // of truth for state/ownership. The disk-derived jobId is passed as the
    // explicit registry id so the registry record and adapter Map share one
    // key. Cross-session re-attach: a supplied restampOwner UPGRADES ownership
    // only when the disk metadata carries a placeholder / missing owner. A job
    // already stamped with a real owner keeps it, so a re-attaching run can
    // never launder ownership of another session's job (assertOwned then
    // refuses it as foreign) — this mirrors the cached-job branch above
    // (SEC-2). Same-process callers pass no opts, so the original owner is
    // preserved either way.
    const owner =
      resolveRestampedOwner(recovered.owner, opts?.restampOwner) ??
      recovered.owner ??
      UNKNOWN_JOB_OWNER
    recovered.owner = owner
    // Pass the disk-derived jobId as the explicit registry id so the
    // registry record and adapter Map share one key. On collision (another
    // job with the same id already registered), fall back to a fresh
    // registry-allocated id (preserving old behavior for that rare case).
    let registryJobId: string
    try {
      registryJobId = jobRegistry.create({
        kind: 'process',
        label: recovered.command,
        owner,
        jobId: recovered.jobId,
      }).jobId
    } catch {
      registryJobId = jobRegistry.create({
        kind: 'process',
        label: recovered.command,
        owner,
      }).jobId
    }
    recovered.jobId = registryJobId
    jobs.set(registryJobId, recovered)
    jobRegistry.start(registryJobId)
    if (recovered.status !== 'running') {
      // A settled recovered job is folded straight into its terminal state so
      // the re-attaching run can serve its final output/exit code from the
      // registry.
      jobRegistry.emit(registryJobId, {
        type: 'lifecycle',
        state: recovered.status,
        exitCode: recovered.exitCode,
      })
    }
  }
  return recovered
}

function recoverBackgroundJob(jobId: string): BackgroundJob | undefined {
  const metadataFile = getBackgroundJobFilePath(jobId, 'json')
  const fallbackLogFile = getBackgroundJobFilePath(jobId, 'log')
  if (!metadataFile || !fallbackLogFile) {
    return undefined
  }

  try {
    const rawMetadata = safeReadJobMetadataFile(metadataFile)
    if (rawMetadata === undefined) return undefined
    const metadata = JSON.parse(rawMetadata) as BackgroundJobMetadata
    if (
      metadata.jobId !== jobId ||
      metadata.logFile !== fallbackLogFile ||
      !isUsableRecoveredLogFile(fallbackLogFile)
    ) {
      return undefined
    }

    // Disk may still say 'running' while the process is gone; promote to
    // 'lost' at recovery time. That promotion is a *new* terminal discovery,
    // not an old settle — see settledAt below.
    const wasRunningOnDisk = metadata.status === 'running'
    const status =
      wasRunningOnDisk &&
      (metadata.processId === null || !isProcessAlive(metadata.processId))
        ? 'lost'
        : metadata.status
    const logSize = fs.statSync(fallbackLogFile).size
    const readOffset =
      typeof metadata.readOffset === 'number' &&
      Number.isFinite(metadata.readOffset)
        ? Math.min(Math.max(0, Math.floor(metadata.readOffset)), logSize)
        : 0
    const owner = isBackgroundJobOwner(metadata.owner)
      ? metadata.owner
      : undefined

    metadataFilesCreatedByThisProcess.add(metadataFile)

    // Terminal recoveries always carry a settledAt stamp so prune/get can
    // honor the TTL.
    // - Prefer the persisted field when present.
    // - If disk said running and we just promoted to lost, stamp NOW so a
    //   freshly-discovered dead process is not rejected as post-TTL (startedAt
    //   can be arbitrarily old and would defeat recovery of dead 'running'
    //   jobs).
    // - Already-terminal disk rows without settledAt fall back to startedAt
    //   as a conservative lower bound for older metadata.
    // - Still-running recoveries leave settledAt undefined so they stay
    //   cacheable.
    const settledAt =
      status === 'running'
        ? undefined
        : typeof metadata.settledAt === 'number' &&
            Number.isFinite(metadata.settledAt)
          ? metadata.settledAt
          : wasRunningOnDisk
            ? Date.now()
            : metadata.startedAt

    return {
      jobId,
      command: metadata.command,
      child: { pid: metadata.processId ?? undefined } as ChildProcess,
      logFile: fallbackLogFile,
      metadataFile,
      status,
      exitCode: metadata.exitCode,
      startedAt: metadata.startedAt,
      readOffset,
      decoder: new StringDecoder('utf8'),
      owner,
      settledAt,
      childProcessStartTime:
        typeof metadata.childProcessStartTime === 'string'
          ? metadata.childProcessStartTime
          : undefined,
    }
  } catch {
    return undefined
  }
}

function isBackgroundJobOwner(value: unknown): value is BackgroundJobOwner {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BackgroundJobOwner>
  return (
    typeof candidate.clientSessionId === 'string' &&
    typeof candidate.rootRunId === 'string' &&
    typeof candidate.parentRunId === 'string' &&
    typeof candidate.parentAgentId === 'string'
  )
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ESRCH'
    ) {
      return false
    }
    return true
  }
}

/**
 * 0-based index of /proc stat field 22 (`starttime`) within the post-comm
 * remainder (fields 3..22 follow the parenthesized comm field).
 */
const STARTTIME_FIELD_INDEX = 19

/**
 * Read the process start-time token (field 22, `starttime`) from Linux
 * `/proc/<pid>/stat`. Returns undefined on non-Linux hosts, when /proc is
 * absent, or when the pid cannot be inspected — i.e. whenever the pid's
 * identity is unverifiable.
 */
function readProcessStartTime(pid: number): string | undefined {
  if (os.platform() !== 'linux') return undefined
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The comm field (field 2) is parenthesized and may itself contain
    // spaces/parens, so parse from the LAST ')' rather than splitting the
    // whole line naively. Field 22 then sits at index 19 of the remainder
    // (fields 3..22 are state, ppid, ..., starttime).
    const closeParen = stat.lastIndexOf(')')
    if (closeParen < 0) return undefined
    const fields = stat
      .slice(closeParen + 1)
      .trim()
      .split(/\s+/)
    return fields[STARTTIME_FIELD_INDEX]
  } catch {
    return undefined
  }
}

function killProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

export function killBackgroundJob(
  jobId: string,
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
):
  | {
      jobId: string
      status: BackgroundJobStatus
      killed: boolean
      signal: 'SIGTERM' | 'SIGKILL'
      exitCode?: number | null
    }
  | { jobId: string; errorMessage: string } {
  const job = getBackgroundJob(jobId)
  if (!job) {
    return {
      jobId,
      errorMessage: `No background job found with id "${jobId}".`,
    }
  }

  if (job.status !== 'running') {
    return {
      jobId,
      status: job.status,
      killed: false,
      signal,
      exitCode: job.exitCode,
    }
  }

  const pid = job.child.pid
  if (!pid) {
    settleBackgroundJob(
      job,
      'error',
      job.exitCode,
      `Background job "${jobId}" has no process id to kill.`,
    )
    return {
      jobId,
      errorMessage: `Background job "${jobId}" has no process id to kill.`,
    }
  }

  let killed: boolean
  if (typeof job.child.kill === 'function') {
    killed = terminateProcessTree(job.child, signal)
  } else {
    // A recovered job has no live ChildProcess handle, so the only way to
    // stop it is a pid(-group) signal. Verify the pid still belongs to the
    // ORIGINAL spawned process by comparing its /proc start-time to the
    // value captured at spawn. If it differs — or cannot be verified
    // (non-Linux, no /proc, missing spawn-time record) — the pid may have
    // been recycled by an unrelated process, so FAIL CLOSED: mark the job
    // lost and REFUSE to group-kill. (SEC-3; SEC-5 HMAC metadata
    // authenticity is a follow-up.)
    const currentStartTime = readProcessStartTime(pid)
    if (
      job.childProcessStartTime === undefined ||
      currentStartTime === undefined ||
      currentStartTime !== job.childProcessStartTime
    ) {
      settleBackgroundJob(
        job,
        'lost',
        job.exitCode,
        'Could not verify the recovered process identity before killing.',
      )
      return {
        jobId,
        errorMessage: `Background job "${jobId}" could not be verified as the original process and was marked lost; refusing to kill a possibly-recycled pid.`,
      }
    }
    killed = killProcess(os.platform() === 'win32' ? pid : -pid, signal)
  }
  if (killed) {
    // An intentional kill is not a failure, so record it as 'stopped'. The
    // registry folds this terminal lifecycle in (and ignores the later exit
    // event), keeping the settled state servable for post-kill status reads.
    settleBackgroundJob(job, 'stopped', job.exitCode)
  }

  return {
    jobId,
    status: job.status,
    killed,
    signal,
    exitCode: job.exitCode,
  }
}

/**
 * Return the log bytes written since the last call for this job, advancing the
 * job's read offset. Returns '' when there is nothing new (or the log is not
 * yet readable). Never throws.
 */
export function readNewJobOutput(job: BackgroundJob): string {
  const opened = safeOpenJobLogForRead(job.logFile)
  if ('errorMessage' in opened) return ''
  const { fd, size } = opened
  try {
    if (size <= job.readOffset) {
      if (job.status !== 'running' && job.decoder) {
        const final = job.decoder.end()
        job.decoder = new StringDecoder('utf8')
        emitJobOutputLines(job, final)
        return final
      }
      return ''
    }
    const length = Math.min(size - job.readOffset, MAX_BACKGROUND_READ_BYTES)
    const buf = Buffer.alloc(length)
    const bytesRead = fs.readSync(fd, buf, 0, length, job.readOffset)
    job.readOffset += bytesRead
    if (bytesRead > 0) {
      // Persist the advanced readOffset for cross-session recovery, but throttle
      // the churn of writing on every poll. Bypass the throttle once the job has
      // settled so the final offset/status is durable.
      const now = Date.now()
      if (
        job.status !== 'running' ||
        now - (job.lastMetadataWriteAt ?? 0) >= METADATA_WRITE_THROTTLE_MS
      ) {
        writeBackgroundJobMetadata(job)
        job.lastMetadataWriteAt = now
      }
    }
    job.decoder ??= new StringDecoder('utf8')
    const text = job.decoder.write(buf.subarray(0, bytesRead))
    emitJobOutputLines(job, text)
    return text
  } catch {
    return ''
  } finally {
    fs.closeSync(fd)
  }
}

/** Test-only: register a job backed by an existing log file (no real process). */
export function __registerJobForTest(job: BackgroundJob): void {
  // Pass the adapter's jobId as the explicit registry id so the registry
  // record and adapter Map share one key. On collision (another job with
  // the same id already registered), fall back to a fresh registry-allocated
  // id (preserving old behavior for that rare case).
  let registryJobId: string
  try {
    registryJobId = jobRegistry.create({
      kind: 'process',
      label: job.command,
      owner: job.owner ?? UNKNOWN_JOB_OWNER,
      jobId: job.jobId,
    }).jobId
  } catch {
    registryJobId = jobRegistry.create({
      kind: 'process',
      label: job.command,
      owner: job.owner ?? UNKNOWN_JOB_OWNER,
    }).jobId
  }
  job.jobId = registryJobId
  jobs.set(registryJobId, job)
  jobRegistry.start(registryJobId)
  if (job.status !== 'running') {
    jobRegistry.emit(registryJobId, {
      type: 'lifecycle',
      state: job.status,
      exitCode: job.exitCode,
    })
  }
}

/**
 * Test-only: set/create a Map adapter keyed by jobId (production id shape).
 * Used only by tests so list_jobs can observe a same-id lastCheckCursor.
 */
export function __setLastCheckCursorForTest(
  jobId: string,
  lastCheckCursor: number,
  owner?: BackgroundJobOwner,
): void {
  const existing = jobs.get(jobId)
  if (existing) {
    existing.lastCheckCursor = lastCheckCursor
    return
  }
  // Minimal adapter stub only — do not call jobRegistry.create (caller owns the
  // registry row under the same jobId as production live spawns).
  jobs.set(jobId, {
    jobId,
    command: 'test',
    child: {} as ChildProcess,
    logFile: path.join(os.tmpdir(), `openbuff-${jobId}.log`),
    metadataFile: path.join(os.tmpdir(), `openbuff-${jobId}.json`),
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    readOffset: 0,
    lastCheckCursor,
    owner,
  })
}

/** Test-only: clear the registry between tests. */
export function __clearJobsForTest(): void {
  jobs.clear()
  metadataFilesCreatedByThisProcess.clear()
  orphanedJobFilesSwept = false
  jobRegistry.clear()
}

/** Test-only: run stale background-job temp-file cleanup deterministically. */
export function __sweepOrphanedJobFilesForTest(): void {
  sweepOrphanedJobFilesForTest()
}
