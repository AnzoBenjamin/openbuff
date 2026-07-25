/**
 * Process-wide registry of running background jobs.
 *
 * Background jobs are started by the SDK's run_terminal_command(process_type: BACKGROUND).
 * The SDK registers/unregisters jobs here as they start and finish, and the
 * agent-runtime's end_turn handler reads the registry to warn agents about any
 * jobs that are still running when they try to hand control back to the user.
 *
 * Both packages depend on @codebuff/common, so this module is a stable shared
 * surface that avoids a direct agent-runtime → sdk dependency.
 *
 * Settled jobs (status !== 'running') are now RETAINED rather than deleted so
 * check_job/read_logs/kill_job can still serve a job's final output/exit code
 * after it finishes. Retained entries carry a `completedAt` and are swept on a
 * TTL, mirroring the background-agent registry
 * (packages/agent-runtime/src/util/background-agent-jobs.ts).
 */

export type PendingBackgroundJobStatus =
  | 'running'
  | 'completed'
  | 'error'
  | 'lost'
  | 'stopped'

export interface PendingBackgroundJobEntry {
  jobId: string
  command: string
  status: PendingBackgroundJobStatus
  startedAt: number
  completedAt?: number
  owner?: {
    clientSessionId: string
    rootRunId: string
    parentRunId: string
    parentAgentId: string
  }
}

/**
 * How long a settled (non-running) job is retained in the registry before a
 * sweep drops it. 24h matches the SDK's orphaned-file window so the gate and
 * the on-disk log/metadata stay recoverable over the same horizon.
 */
export const SETTLED_PENDING_JOB_TTL_MS = 24 * 60 * 60 * 1000

const pendingJobs = new Map<string, PendingBackgroundJobEntry>()

/**
 * Drop settled entries whose completedAt is older than the TTL. Running jobs
 * and settled jobs without a completedAt are always retained. Mirrors
 * sweepBackgroundAgentJobs in the background-agent registry.
 */
export function sweepPendingBackgroundJobs(now = Date.now()): void {
  for (const [jobId, entry] of pendingJobs) {
    if (
      entry.status !== 'running' &&
      entry.completedAt !== undefined &&
      now - entry.completedAt > SETTLED_PENDING_JOB_TTL_MS
    ) {
      pendingJobs.delete(jobId)
    }
  }
}

export function upsertPendingBackgroundJob(
  entry: PendingBackgroundJobEntry,
): void {
  pendingJobs.set(entry.jobId, entry)
}

/**
 * Explicitly purge a job from the registry. Retained for tests and as an
 * explicit purge primitive; the SDK no longer calls this on the exit path so
 * settled jobs stay servable until the TTL sweep.
 */
export function removePendingBackgroundJob(jobId: string): void {
  pendingJobs.delete(jobId)
}

/**
 * Replace the owner of an existing entry (cross-session re-attach). Returns
 * true when an entry existed and was restamped, false otherwise.
 */
export function restampPendingBackgroundJobOwner(
  jobId: string,
  owner: PendingBackgroundJobEntry['owner'],
): boolean {
  const entry = pendingJobs.get(jobId)
  if (!entry) return false
  entry.owner = owner
  return true
}

export function getPendingBackgroundJob(
  jobId: string,
): PendingBackgroundJobEntry | undefined {
  sweepPendingBackgroundJobs()
  return pendingJobs.get(jobId)
}

export function pendingBackgroundJobOwnedBy(
  entry: PendingBackgroundJobEntry,
  owner: { clientSessionId: string; rootRunId: string },
): boolean {
  return (
    entry.owner?.clientSessionId === owner.clientSessionId &&
    entry.owner?.rootRunId === owner.rootRunId
  )
}

export function listRunningBackgroundJobs(owner?: {
  clientSessionId: string
  rootRunId: string
}): PendingBackgroundJobEntry[] {
  sweepPendingBackgroundJobs()
  const running: PendingBackgroundJobEntry[] = []
  for (const entry of pendingJobs.values()) {
    if (
      entry.status === 'running' &&
      (!owner || pendingBackgroundJobOwnedBy(entry, owner))
    ) {
      running.push(entry)
    }
  }
  return running
}

/**
 * Return ALL entries (running + settled-within-TTL) in insertion order,
 * filtered to the owner when provided. Backs the future list_jobs tool.
 */
export function listBackgroundJobs(owner?: {
  clientSessionId: string
  rootRunId: string
}): PendingBackgroundJobEntry[] {
  sweepPendingBackgroundJobs()
  const result: PendingBackgroundJobEntry[] = []
  for (const entry of pendingJobs.values()) {
    if (!owner || pendingBackgroundJobOwnedBy(entry, owner)) {
      result.push(entry)
    }
  }
  return result
}

/** Test-only: clear the registry between tests. */
export function __clearPendingBackgroundJobsForTest(): void {
  pendingJobs.clear()
}
