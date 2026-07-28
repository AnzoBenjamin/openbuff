/**
 * Thin adapter that runs background agent turns on the unified job-registry
 * core (`@codebuff/common/util/job-registry`).
 *
 * A "background agent turn" is a {@link loopAgentSteps} invocation launched
 * detached from the main run via `spawn_agents({ background: true })`. The
 * parent's `handleSpawnAgents` returns immediately with a `jobId`; the agent
 * step loop runs as an un-awaited same-process coroutine whose progress the
 * parent (or another agent) can poll via `check_background_agent`.
 *
 * The unified core is the single source of truth for each job's lifecycle
 * state machine, its bounded sequenced event log (the chunk stream), and
 * ownership enforcement. This module is only an adapter on top of it:
 *
 * - It keeps a legacy live {@link BackgroundAgentJob} view per job — the
 *   object spawn_agents / check_background_agent hold across polls, with the
 *   historical fields (`chunks`, `readOffset`, `droppedChunks`, ...).
 * - It owns the coroutine AbortController (the core deliberately has no
 *   execution machinery) and enforces the background-agent capacity limits.
 * - It maps each streamed chunk onto a core `agent_chunk` event and folds
 *   coroutine settle/cancel into core `lifecycle` events.
 *
 * Preserved bounds: 200 buffered events per job (each chunk payload truncated
 * to 64KB), a 30-minute settled-job TTL, 100 total jobs, 32 running jobs, 8
 * running jobs per root run. This adapter shares the process-wide
 * `jobRegistry` singleton — the single source of truth every consumer
 * reads — and the core enforces the agent bounds (the 200-event ring buffer
 * and 30-minute settled TTL) per-kind for 'agent' jobs; the state machine,
 * sequenced event log, cursor math, and ownership checks are all the core's.
 * There is no disk recovery: background agents are process-scoped and never
 * outlive the CLI process.
 */

import {
  isTerminalJobState,
  jobRegistry,
} from '@codebuff/common/util/job-registry'

import type {
  AssertOwnedResult,
  Job,
  JobOwner,
  JobSnapshot,
  JobState,
  WaitJobOptions,
  WaitJobResult,
} from '@codebuff/common/util/job-registry'

/**
 * Bounded ring buffer for streaming agent output. Older chunks are evicted
 * once the buffer exceeds this many entries to bound memory on long agents.
 */
const MAX_BUFFERED_CHUNKS = 200
const MAX_BUFFERED_CHUNK_BYTES = 64 * 1024
const MAX_CONSUMER_CURSORS = 32
const MAX_BACKGROUND_AGENT_JOBS = 100
const MAX_RUNNING_BACKGROUND_AGENT_JOBS = 32
const MAX_RUNNING_BACKGROUND_AGENT_JOBS_PER_ROOT = 8

/**
 * A background agent job has exactly ONE id everywhere: the `bg-agent-`-
 * prefixed id handed to spawn_agents/check_background_agent callers, which
 * is also the id the registry record is created with. Consumers reading the
 * shared registry directly (end_turn, list_jobs) therefore surface the same
 * id the adapter hands out — there is no core-vs-adapter id remapping.
 */
const BACKGROUND_AGENT_JOB_ID_PREFIX = 'bg-agent-'

let backgroundAgentJobCounter = 0

/**
 * Allocate a unique background agent job id of the form
 * `bg-agent-job-<counter>-<hex>` (mirroring the core's id shape, with the
 * adapter prefix). The id is passed to the registry as the job's explicit
 * id, so the registry record and the adapter view share one key.
 */
function allocateBackgroundAgentJobId(): string {
  backgroundAgentJobCounter += 1
  const random = Math.random().toString(16).slice(2, 10)
  return `${BACKGROUND_AGENT_JOB_ID_PREFIX}job-${backgroundAgentJobCounter.toString(36)}-${random}`
}

/**
 * The shared process-wide job-registry singleton backing this adapter. The
 * core enforces the historical background-agent bounds (200-event ring
 * buffer, 30-minute settled TTL) per-kind for 'agent' jobs, so this adapter
 * shares the singleton rather than constructing a private registry — agent
 * jobs are visible to every consumer that reads the singleton. All
 * lifecycle/state/chunk-stream truth lives here.
 */
const registry = jobRegistry

/**
 * A single streamed chunk from a background agent turn. Mirrors the
 * `PrintModeEvent` shape but is kept minimal to avoid coupling the registry
 * to the full event union. The `text` field carries assistant text; `type`
 * preserves the original event type for the polling caller to interpret.
 */
export interface BackgroundAgentChunk {
  /** Monotonic job-local sequence number assigned by the registry. */
  sequence: number
  /** Original event type (e.g. 'text', 'tool_call', 'tool_result'). */
  type: string
  /** Serialized chunk payload (opaque to the registry). */
  payload: unknown
  /** Wall-clock timestamp when the chunk was appended. */
  timestamp: number
}

export type BackgroundAgentJobStatus =
  | 'running'
  | 'completed'
  | 'error'
  | 'cancelled'

/**
 * Ownership of a background agent job. Extends the core {@link JobOwner}
 * (which the registry checks as clientSessionId + rootRunId) with the
 * user-input correlation id the spawn handler threads through.
 */
export interface BackgroundAgentJobOwner extends JobOwner {
  userInputId: string
}

export interface BackgroundAgentJob {
  jobId: string
  /** Agent type string (e.g. 'basher', 'code-searcher'). */
  agentType: string
  /** Agent template display name. */
  agentName: string
  owner: BackgroundAgentJobOwner
  status: BackgroundAgentJobStatus
  startedAt: number
  completedAt?: number
  /** Resolved value when status === 'completed'; undefined otherwise. */
  result?: unknown
  /** Rejection reason when status === 'error'; undefined otherwise. */
  error?: string
  /** Ring buffer of streamed chunks, oldest-first, bounded. */
  chunks: BackgroundAgentChunk[]
  /**
   * Number of chunks already consumed by a `check_background_agent` poll.
   * Polls return only the chunks appended since the last poll.
   */
  readOffset: number
  /** Per-consumer sequence cursors for backward-compatible cursor omission. */
  consumerCursors: Map<string, number>
  nextSequence: number
  /** Unseen chunks evicted since the previous poll. */
  droppedChunks: number
  /** Controller owned by this job and used for explicit cancellation. */
  abortController: AbortController
  /** The detached coroutine promise. Stored for lifecycle bookkeeping only. */
  promise: Promise<unknown>
}

/**
 * Live adapter views keyed by the single background agent job id (the same
 * id as the job's registry record). The unified core remains the source of
 * truth; the view exists so long-held references (spawn_agents' settle
 * callbacks, check_background_agent's follow loop) observe status
 * transitions on the same object they were handed at allocation time.
 */
const views = new Map<string, BackgroundAgentJob>()

/** Fold a core lifecycle state into the adapter's coarser status union. */
function jobStateToStatus(state: JobState): BackgroundAgentJobStatus {
  switch (state) {
    case 'completed':
      return 'completed'
    case 'error':
      return 'error'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'running'
  }
}

/** Push the core record's lifecycle fields into the live view. */
function syncViewFromCore(job: BackgroundAgentJob, coreJob: Job): void {
  job.status = jobStateToStatus(coreJob.state)
  job.startedAt = coreJob.startedAt ?? job.startedAt
  job.completedAt = coreJob.completedAt
  if (coreJob.error !== undefined) {
    job.error = coreJob.error
  }
}

/**
 * Project the job's `agent_chunk` events out of the unified core into the
 * legacy chunk shape, assigning absolute chunk-local sequence numbers. The
 * core buffer and the live view always hold the same chunks (appends funnel
 * through {@link appendBackgroundAgentChunk}, which maintains both), so the
 * view's `nextSequence` counter pins the absolute numbering. Falls back to
 * the live view when the core record has already been swept.
 */
function currentChunks(job: BackgroundAgentJob): BackgroundAgentChunk[] {
  const snapshot = registry.snapshot(job.jobId, 0)
  if (!snapshot) return job.chunks
  const chunkEvents: Array<Omit<BackgroundAgentChunk, 'sequence'>> = []
  for (const event of snapshot.events) {
    const payload = event.payload
    if (payload.type !== 'agent_chunk') continue
    chunkEvents.push({
      type: payload.chunkType,
      payload: payload.data,
      timestamp: event.timestamp,
    })
  }
  const firstSequence = job.nextSequence - chunkEvents.length
  return chunkEvents.map((chunk, index) => ({
    ...chunk,
    sequence: firstSequence + index,
  }))
}

/**
 * Drop settled jobs past the retention TTL (delegated to the core's sweep)
 * and cap the total registry size by evicting the oldest settled jobs. The
 * core has no single-job drop API, so count-cap eviction removes the
 * adapter's view — making the job invisible to every adapter API — while the
 * core record is left for the TTL sweep to reclaim.
 */
function sweepBackgroundAgentJobs(): void {
  const coreJobs = registry.list()
  const liveCoreIds = new Set(coreJobs.map((coreJob) => coreJob.jobId))
  for (const jobId of views.keys()) {
    if (!liveCoreIds.has(jobId)) {
      views.delete(jobId)
    }
  }

  if (coreJobs.length <= MAX_BACKGROUND_AGENT_JOBS) return
  const settled = coreJobs
    .filter((coreJob) => isTerminalJobState(coreJob.state))
    .sort(
      (a, b) =>
        (a.completedAt ?? a.startedAt ?? a.createdAt) -
        (b.completedAt ?? b.startedAt ?? b.createdAt),
    )
  let count = coreJobs.length
  for (const coreJob of settled) {
    if (count <= MAX_BACKGROUND_AGENT_JOBS) break
    views.delete(coreJob.jobId)
    count -= 1
  }
}

/**
 * Allocate a job id and a pending job record WITHOUT a coroutine promise yet.
 * This split is required because {@link executeSubagent} synchronously fires
 * `onResponseChunk(startEvent)` when invoked — the chunk handler needs a
 * `jobId` to buffer into BEFORE the detached promise exists. The caller must
 * invoke {@link attachBackgroundAgentPromise} immediately after launching the
 * coroutine to wire the settle handlers that transition the status.
 */
export function allocateBackgroundAgentJob(params: {
  agentType: string
  agentName: string
  owner?: BackgroundAgentJob['owner']
}): BackgroundAgentJob {
  const owner = params.owner ?? {
    clientSessionId: 'unknown-session',
    rootRunId: 'unknown-root',
    parentRunId: 'unknown-parent-run',
    parentAgentId: 'unknown-parent-agent',
    userInputId: 'unknown-input',
  }
  assertBackgroundAgentCapacity({ additional: 1, owner })
  const { agentType, agentName } = params
  // The unified core owns lifecycle/state: create in 'queued' with the
  // adapter's single `bg-agent-` id as the explicit job id, then immediately
  // transition to 'running' so the job is pollable the moment
  // executeSubagent's synchronous start chunk lands.
  const coreJob = registry.create({
    kind: 'agent',
    label: agentType,
    owner,
    jobId: allocateBackgroundAgentJobId(),
  })
  const startedCoreJob = registry.start(coreJob.jobId)
  const job: BackgroundAgentJob = {
    jobId: coreJob.jobId,
    agentType,
    agentName,
    owner,
    status: 'running',
    startedAt: startedCoreJob.startedAt ?? Date.now(),
    chunks: [],
    readOffset: 0,
    consumerCursors: new Map(),
    nextSequence: 1,
    droppedChunks: 0,
    abortController: new AbortController(),
    // Placeholder promise replaced by {@link attachBackgroundAgentPromise}.
    promise: Promise.resolve(),
  }
  views.set(job.jobId, job)
  return job
}

/** Preflight a logical batch before the caller acquires leases or emits events. */
export function assertBackgroundAgentCapacity(params: {
  additional: number
  owner: BackgroundAgentJob['owner']
}): void {
  sweepBackgroundAgentJobs()
  if (params.additional <= 0) return
  const { owner } = params
  const running = registry
    .listRunning()
    .filter((coreJob) => coreJob.state === 'running')
  if (running.length + params.additional > MAX_RUNNING_BACKGROUND_AGENT_JOBS) {
    throw new Error(
      `Background agent concurrency limit reached (${MAX_RUNNING_BACKGROUND_AGENT_JOBS}). Join or cancel an existing job before spawning another.`,
    )
  }
  const runningForRoot = running.filter(
    (coreJob) =>
      coreJob.owner.clientSessionId === owner.clientSessionId &&
      coreJob.owner.rootRunId === owner.rootRunId,
  )
  if (
    runningForRoot.length + params.additional >
    MAX_RUNNING_BACKGROUND_AGENT_JOBS_PER_ROOT
  ) {
    throw new Error(
      `Background agent concurrency limit reached for this run (${MAX_RUNNING_BACKGROUND_AGENT_JOBS_PER_ROOT}). Join or cancel an existing job before spawning another.`,
    )
  }
}

/**
 * Attach a detached coroutine promise to a job allocated by
 * {@link allocateBackgroundAgentJob} and wire the settle handlers that
 * transition the status to 'completed' or 'error'. MUST be called immediately
 * after launching the coroutine; the job is not usable for status polling
 * until this is wired.
 */
export function attachBackgroundAgentPromise(
  job: BackgroundAgentJob,
  promise: Promise<unknown>,
): void {
  job.promise = promise
  attachJobCompletionHandlers(job)
}

/**
 * Register a new background agent job with an already-created coroutine
 * promise. Convenience wrapper for callers that do NOT need to buffer chunks
 * before the promise exists (i.e. when the coroutine defers its first
 * `onResponseChunk` to a later tick). Callers that need to pre-allocate the
 * jobId (because the coroutine fires synchronously, as `executeSubagent` does)
 * should use {@link allocateBackgroundAgentJob} + {@link attachBackgroundAgentPromise}.
 *
 * Not currently called by the production spawn_agents handler (which pre-
 * allocates), but kept as a tested public convenience API for future callers
 * with deferred-first-chunk coroutines — see the
 * `registerBackgroundAgentJob combines allocation + attachment` unit test.
 */
export function registerBackgroundAgentJob(params: {
  agentType: string
  agentName: string
  promise: Promise<unknown>
  owner?: BackgroundAgentJob['owner']
}): BackgroundAgentJob {
  const { agentType, agentName, promise, owner } = params
  const job = allocateBackgroundAgentJob({ agentType, agentName, owner })
  attachBackgroundAgentPromise(job, promise)
  return job
}

/**
 * Attach settle handlers that fold the coroutine's resolution into the
 * unified core as lifecycle(completed) / lifecycle(error) events, then sync
 * the live view. Detached from registration so the caller doesn't need to
 * remember to wire `.then`/`.catch` at every registration site.
 */
function attachJobCompletionHandlers(job: BackgroundAgentJob): void {
  job.promise.then(
    (result) => {
      if (job.status === 'cancelled') return
      job.result = result
      registry.emit(job.jobId, { type: 'lifecycle', state: 'completed' })
      const coreJob = registry.get(job.jobId)
      if (coreJob) syncViewFromCore(job, coreJob)
    },
    (error) => {
      if (job.status === 'cancelled') return
      const message = error instanceof Error ? error.message : String(error)
      registry.emit(job.jobId, {
        type: 'lifecycle',
        state: 'error',
        error: message,
      })
      const coreJob = registry.get(job.jobId)
      if (coreJob) syncViewFromCore(job, coreJob)
    },
  )
}

/**
 * Append a streamed chunk to a job's ring buffer: emitted as an `agent_chunk`
 * event into the unified core (the source of truth) and mirrored onto the
 * live view. Evicts the oldest entry when the buffer exceeds
 * {@link MAX_BUFFERED_CHUNKS} to bound memory.
 */
export function appendBackgroundAgentChunk(
  jobId: string,
  chunk: Omit<BackgroundAgentChunk, 'sequence'> & { sequence?: number },
): void {
  const job = views.get(jobId)
  if (!job) return
  let payload = chunk.payload
  try {
    const serialized = JSON.stringify(payload)
    const serializedBytes = Buffer.from(serialized, 'utf8')
    if (serializedBytes.byteLength > MAX_BUFFERED_CHUNK_BYTES) {
      payload = {
        truncated: true,
        originalBytes: serializedBytes.byteLength,
        preview: `${serializedBytes.subarray(0, 48_000).toString('utf8')}...[truncated background chunk]...${serializedBytes.subarray(-8_000).toString('utf8')}`,
      }
    }
  } catch {
    payload = { truncated: true, preview: 'Unserializable background chunk.' }
  }
  registry.emit(jobId, {
    type: 'agent_chunk',
    chunkType: chunk.type,
    data: payload,
  })
  job.chunks.push({
    ...chunk,
    payload,
    sequence: chunk.sequence ?? job.nextSequence++,
  })
  if (job.chunks.length > MAX_BUFFERED_CHUNKS) {
    job.chunks.shift()
    // Keep readOffset sane if we evict chunks the poller hasn't seen yet.
    if (job.readOffset > 0) {
      job.readOffset -= 1
    } else {
      job.droppedChunks += 1
    }
  }
}

/**
 * Look up a background agent job by id. Returns undefined for unknown ids.
 */
export function getBackgroundAgentJob(
  jobId: string,
): BackgroundAgentJob | undefined {
  sweepBackgroundAgentJobs()
  const coreJob = registry.get(jobId)
  if (!coreJob) return undefined
  const job = views.get(jobId)
  if (!job) return undefined
  syncViewFromCore(job, coreJob)
  return job
}

export function listRunningBackgroundAgentJobs(owner?: {
  clientSessionId: string
  rootRunId: string
}): Array<
  Pick<BackgroundAgentJob, 'jobId' | 'agentType' | 'agentName' | 'startedAt'>
> {
  sweepBackgroundAgentJobs()
  const running = registry
    .listRunning(owner)
    .filter((coreJob) => coreJob.state === 'running')
  const result: Array<
    Pick<BackgroundAgentJob, 'jobId' | 'agentType' | 'agentName' | 'startedAt'>
  > = []
  for (const coreJob of running) {
    const job = views.get(coreJob.jobId)
    if (!job) continue
    result.push({
      jobId: job.jobId,
      agentType: job.agentType,
      agentName: job.agentName,
      startedAt: job.startedAt,
    })
  }
  return result
}

/**
 * Return the chunks appended since the last poll for this job, advancing the
 * job's read offset. Returns an empty array when there is nothing new. Never
 * throws.
 *
 * Because the ring buffer may evict old chunks on long agents, a poll after
 * eviction returns only the surviving unconsumed chunks (the offset is
 * adjusted in {@link appendBackgroundAgentChunk} to stay valid).
 */
export function readNewBackgroundAgentChunks(
  job: BackgroundAgentJob,
): BackgroundAgentChunk[] {
  const available = job.chunks.slice(job.readOffset)
  job.readOffset = job.chunks.length
  return available
}

export function readBackgroundAgentChunks(params: {
  job: BackgroundAgentJob
  consumerId: string
  cursor?: number
}): {
  chunks: BackgroundAgentChunk[]
  nextCursor: number
  droppedChunks: number
} {
  const { job, consumerId } = params
  const requestedCursor =
    params.cursor ?? job.consumerCursors.get(consumerId) ?? 0
  const chunks = currentChunks(job)
  const latestSequence = chunks.at(-1)?.sequence ?? job.nextSequence - 1
  const cursor = Math.max(
    0,
    Math.min(
      Number.isFinite(requestedCursor) ? Math.floor(requestedCursor) : 0,
      latestSequence,
    ),
  )
  const firstSequence = chunks[0]?.sequence ?? latestSequence + 1
  const droppedChunks = Math.max(0, firstSequence - cursor - 1)
  const available = chunks.filter((chunk) => chunk.sequence > cursor)
  const nextCursor = available.at(-1)?.sequence ?? cursor
  job.consumerCursors.set(consumerId, nextCursor)
  if (job.consumerCursors.size > MAX_CONSUMER_CURSORS) {
    const oldest = job.consumerCursors.keys().next().value
    if (typeof oldest === 'string' && oldest !== consumerId) {
      job.consumerCursors.delete(oldest)
    }
  }
  return { chunks: available, nextCursor, droppedChunks }
}

export function backgroundAgentJobOwnedBy(
  job: BackgroundAgentJob,
  owner: { clientSessionId: string; rootRunId: string },
): boolean {
  return registry.assertOwned(job.jobId, owner).ok
}

/** Return and reset the count of unseen chunks evicted since the last poll. */
export function takeDroppedBackgroundAgentChunkCount(
  job: BackgroundAgentJob,
): number {
  const count = job.droppedChunks
  job.droppedChunks = 0
  return count
}

export function cancelBackgroundAgentJob(
  jobId: string,
): { cancelled: true; status: 'cancelled' } | { errorMessage: string } {
  const job = views.get(jobId)
  if (!job) {
    return { errorMessage: `No background agent job found with id "${jobId}".` }
  }
  if (job.status !== 'running') {
    return {
      errorMessage: `Background agent job "${jobId}" is already ${job.status}.`,
    }
  }
  const error = 'Cancelled by check_background_agent.'
  // The core folds lifecycle(cancelled) into its state machine (legal from
  // 'running', absorbing once terminal); the adapter performs the real abort.
  registry.cancel(jobId)
  job.status = 'cancelled'
  job.completedAt = Date.now()
  job.error = error
  job.abortController.abort(new Error(error))
  return { cancelled: true, status: 'cancelled' }
}

/**
 * Registry-backed ownership check for check_background_agent. Returns the
 * core's tri-state so the handler can distinguish not_found from foreign.
 */
export function assertBackgroundAgentJobOwned(
  jobId: string,
  owner: { clientSessionId: string; rootRunId: string },
): AssertOwnedResult {
  return registry.assertOwned(jobId, owner)
}

/**
 * Return the job's events with sequence > cursor from the unified core (the
 * source of truth for the chunk stream). `truncated` flags that events at or
 * below the cursor were evicted from the bounded buffer.
 */
export function snapshotBackgroundAgentJob(
  jobId: string,
  cursor = 0,
): JobSnapshot | undefined {
  return registry.snapshot(jobId, cursor)
}

/**
 * Join/wait primitive over the unified core: resolve when a NEW agent_chunk
 * event (sequence > cursor) satisfies the predicate, or the job reaches a
 * terminal state, or the timeout fires — driven purely off the registry's
 * internal notifications (no sleep-polling).
 */
export function waitForBackgroundAgentJob(
  jobId: string,
  options: WaitJobOptions = {},
): Promise<WaitJobResult | undefined> {
  return registry.wait(jobId, options)
}

/** Registry-side Job view for a background agent job (result/error/exitCode). */
export function getBackgroundAgentJobCore(jobId: string): Job | undefined {
  return registry.get(jobId)
}

/** Test-only: clear the registry between tests. */
export function __clearBackgroundAgentJobsForTest(): void {
  registry.clear()
  views.clear()
}
