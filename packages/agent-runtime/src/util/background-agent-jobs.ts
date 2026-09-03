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
 * to 64KB), a 30-minute settled-job TTL, 100 retained adapter views, 32 running
 * background agents, 8 running background agents per root run. Every one of
 * those bounds is computed over the registry's 'agent'-kind population only (or,
 * for the view cap, over this adapter's own views), so shell `process` jobs
 * sharing the same registry never consume the background-AGENT budget and never
 * distort the view cap. This adapter shares the process-wide
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

import type { AgentState } from '@codebuff/common/types/session-state'
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
/**
 * Memory bound on the live adapter views this module retains. Evaluated over
 * `views` itself rather than over the shared registry population: the registry
 * also holds shell `process` jobs (and other owners' jobs), so counting them
 * would both trigger the cap when no view needs evicting and leave the cap
 * ineffective when the views genuinely grew.
 */
const MAX_BACKGROUND_AGENT_VIEWS = 100
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
  /** Agent type string (e.g. 'basher', 'file-picker'). */
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
 * Running jobs of THIS adapter's kind. Concurrency limits are background-AGENT
 * limits, so a shell `process` job (dev server, watcher, tail) sharing the
 * process-wide registry must never consume that budget — filtering by kind here
 * is what keeps a long-lived watcher from blocking every background agent spawn
 * for a run.
 */
function listRunningAgentJobs(owner?: {
  clientSessionId: string
  rootRunId: string
}): Job[] {
  return registry
    .listRunning(owner)
    .filter(
      (coreJob) => coreJob.kind === 'agent' && coreJob.state === 'running',
    )
}

/**
 * Drop settled jobs past the retention TTL (delegated to the core's sweep) and
 * cap the number of retained ADAPTER VIEWS by evicting the oldest settled ones.
 * The count cap is evaluated over `views` and the registry's 'agent'-kind
 * records only — never the whole shared registry population — so process jobs
 * and other owners' jobs can neither trigger nor defeat the view bound.
 *
 * The core has no single-job drop API, so count-cap eviction removes only the
 * adapter's view (its buffered chunks), while the core record is left for the
 * TTL sweep to reclaim. The core is the durable home of the lifecycle state
 * AND of the settled `result` (stamped there by
 * {@link attachJobCompletionHandlers}), so a job whose view was evicted still
 * reports its state and its result to check_background_agent, is still owned,
 * and is still an idempotent cancel target — never not_found.
 *
 * Only SETTLED views are evicted, and that is load-bearing rather than
 * incidental: the view owns this job's AbortController, so dropping the view
 * of a job whose core state is non-terminal would leave nothing able to cancel
 * it. The candidate list below is filtered to terminal core states for exactly
 * that reason.
 */
function sweepBackgroundAgentJobs(): void {
  // Only 'agent' records are backed by a view, so this is the exact population
  // the view cap bounds.
  const agentJobsById = new Map(
    registry
      .list()
      .filter((coreJob) => coreJob.kind === 'agent')
      .map((coreJob) => [coreJob.jobId, coreJob] as const),
  )
  for (const jobId of views.keys()) {
    if (!agentJobsById.has(jobId)) {
      views.delete(jobId)
    }
  }

  if (views.size <= MAX_BACKGROUND_AGENT_VIEWS) return
  // Eviction candidates are exactly the views whose core state is terminal: a
  // non-terminal job is still cancellable and its AbortController lives on the
  // view, so its view must stay reachable no matter how old it is.
  const settled = [...views.keys()]
    .flatMap((jobId) => {
      const coreJob = agentJobsById.get(jobId)
      return coreJob && isTerminalJobState(coreJob.state) ? [coreJob] : []
    })
    .sort(
      (a, b) =>
        (a.completedAt ?? a.startedAt ?? a.createdAt) -
        (b.completedAt ?? b.startedAt ?? b.createdAt),
    )
  let count = views.size
  for (const coreJob of settled) {
    if (count <= MAX_BACKGROUND_AGENT_VIEWS) break
    views.delete(coreJob.jobId)
    count -= 1
  }
}

/** Fall back to the placeholder owner when a caller has no run identity. */
function resolveBackgroundAgentJobOwner(
  owner?: BackgroundAgentJob['owner'],
): BackgroundAgentJob['owner'] {
  return (
    owner ?? {
      clientSessionId: 'unknown-session',
      rootRunId: 'unknown-root',
      parentRunId: 'unknown-parent-run',
      parentAgentId: 'unknown-parent-agent',
      userInputId: 'unknown-input',
    }
  )
}

/**
 * Create the core registry record + live adapter view for ONE background
 * agent job. Deliberately performs no capacity check: the caller owns the
 * claim, so a whole batch can be claimed atomically
 * ({@link allocateBackgroundAgentJobBatch}) instead of re-checking the shared
 * registry once per job.
 */
function createBackgroundAgentJobRecord(params: {
  agentType: string
  agentName: string
  owner: BackgroundAgentJob['owner']
}): BackgroundAgentJob {
  const { agentType, agentName, owner } = params
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
  const owner = resolveBackgroundAgentJobOwner(params.owner)
  assertBackgroundAgentCapacity({ additional: 1, owner })
  return createBackgroundAgentJobRecord({
    agentType: params.agentType,
    agentName: params.agentName,
    owner,
  })
}

/**
 * Allocate a whole batch of background agent jobs under ONE capacity check,
 * making the batch's claim on the shared registry atomic: a concurrent spawn
 * can no longer land between a batch preflight and a per-job allocation and
 * make a mid-batch allocation throw after earlier jobs of the same batch were
 * already launched. Either every id in the batch exists, or the capacity error
 * is thrown and no record/view was created at all.
 *
 * Same pre-allocate-then-attach contract as
 * {@link allocateBackgroundAgentJob}: every returned job still needs
 * {@link attachBackgroundAgentPromise} immediately after its coroutine is
 * launched.
 */
export function allocateBackgroundAgentJobBatch(params: {
  agents: Array<{ agentType: string; agentName: string }>
  owner?: BackgroundAgentJob['owner']
}): BackgroundAgentJob[] {
  const owner = resolveBackgroundAgentJobOwner(params.owner)
  assertBackgroundAgentCapacity({ additional: params.agents.length, owner })
  return params.agents.map(({ agentType, agentName }) =>
    createBackgroundAgentJobRecord({ agentType, agentName, owner }),
  )
}

/** Preflight a logical batch before the caller acquires leases or emits events. */
export function assertBackgroundAgentCapacity(params: {
  additional: number
  owner: BackgroundAgentJob['owner']
}): void {
  sweepBackgroundAgentJobs()
  if (params.additional <= 0) return
  const { owner } = params
  // Agent-kind only: shell `process` jobs share this registry but are bounded
  // separately, so they must not consume the background-agent budget.
  const running = listRunningAgentJobs()
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
 *
 * The resolved value is passed THROUGH the lifecycle event as well as stamped
 * on the view, so the core record owns the settled result and it outlives
 * count-cap eviction of that view. A job the caller already cancelled keeps
 * its cancellation receipt: the guard below returns before either stamp (and
 * the core would reject the transition anyway, since terminal states absorb).
 */
function attachJobCompletionHandlers(job: BackgroundAgentJob): void {
  job.promise.then(
    (result) => {
      if (job.status === 'cancelled') return
      job.result = result
      registry.emit(job.jobId, {
        type: 'lifecycle',
        state: 'completed',
        result,
      })
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

/**
 * Reconcile a parent's durable {@link AgentState.backgroundAgentJobs} intents
 * against the live registry: an intent still marked 'running' whose job no
 * longer exists is recorded as 'interrupted' with a terminal timestamp and
 * reason. Intents are never dropped — only reconciled — so the parent keeps an
 * auditable terminal record of detached work.
 *
 * Called at `loopAgentSteps` entry AND by the spawn preflight before it counts
 * the background concurrency budget off these intents, so a job that vanished
 * mid-turn stops consuming that budget instead of blocking later legitimate
 * background spawns until the next turn. Idempotent: a reconciled intent is no
 * longer 'running', so repeated calls within one turn are no-ops.
 */
export function reconcileInterruptedBackgroundAgentIntents(
  state: AgentState,
): void {
  for (const job of state.backgroundAgentJobs ?? []) {
    if (job.status === 'running' && !getBackgroundAgentJob(job.jobId)) {
      job.status = 'interrupted'
      job.completedAt = Date.now()
      job.error =
        'Background agent host process/session ended before a terminal receipt was recorded.'
    }
  }
}

export function listRunningBackgroundAgentJobs(owner?: {
  clientSessionId: string
  rootRunId: string
}): Array<
  Pick<BackgroundAgentJob, 'jobId' | 'agentType' | 'agentName' | 'startedAt'>
> {
  sweepBackgroundAgentJobs()
  const running = listRunningAgentJobs(owner)
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
  setConsumerCursor(job, consumerId, nextCursor)
  return { chunks: available, nextCursor, droppedChunks }
}

/**
 * Record `consumerId`'s confirmed position in this job's stream, keeping the
 * per-job cursor map bounded by {@link MAX_CONSUMER_CURSORS} (oldest insertion
 * evicted first, never the consumer being written). Single writer for the
 * cursor store so every path stays bounded the same way.
 */
function setConsumerCursor(
  job: BackgroundAgentJob,
  consumerId: string,
  nextCursor: number,
): void {
  job.consumerCursors.set(consumerId, nextCursor)
  if (job.consumerCursors.size > MAX_CONSUMER_CURSORS) {
    const oldest = job.consumerCursors.keys().next().value
    if (typeof oldest === 'string' && oldest !== consumerId) {
      job.consumerCursors.delete(oldest)
    }
  }
}

/**
 * This consumer's last confirmed position in the job's event stream, or
 * undefined when it has never polled (or the settled view was count-cap
 * evicted). check_background_agent uses it as the effective cursor for a poll
 * that omits `cursor`, so such a poll returns only the events that consumer
 * has not consumed instead of replaying the whole retained buffer.
 *
 * The stored number is whatever sequence space the consumer polls in — core
 * EVENT sequences for check_background_agent, chunk-local sequences for
 * {@link readBackgroundAgentChunks} — so one consumerId must stay on one API.
 */
export function getBackgroundAgentConsumerCursor(
  jobId: string,
  consumerId: string,
): number | undefined {
  return views.get(jobId)?.consumerCursors.get(consumerId)
}

/**
 * Advance this consumer's stored position to the cursor the CORE confirmed.
 * Monotonic and never past `confirmedCursor`: a follow-mode wait that timed out
 * without new events confirms the cursor it started from, so the consumer keeps
 * its place instead of skipping the events that arrive later. Bounded by
 * {@link MAX_CONSUMER_CURSORS} like every other cursor write.
 */
export function advanceBackgroundAgentConsumerCursor(
  jobId: string,
  consumerId: string,
  confirmedCursor: number,
): void {
  const job = views.get(jobId)
  if (!job || !Number.isFinite(confirmedCursor)) return
  setConsumerCursor(
    job,
    consumerId,
    Math.max(
      job.consumerCursors.get(consumerId) ?? 0,
      Math.floor(confirmedCursor),
    ),
  )
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

/**
 * The exact reason the adapter aborts a job cancelled through
 * check_background_agent. Exported so the spawn handler can recognize a
 * rejection driven by THIS job's own cancellation and record it as a
 * cancellation instead of relabelling it as a failure.
 */
export const BACKGROUND_AGENT_CANCEL_REASON =
  'Cancelled by check_background_agent.'

/**
 * Outcome of a cancel request. `cancelled: false` is the IDEMPOTENT no-op case:
 * the job is already settled (or its settled view was count-cap evicted), so
 * there is nothing left to abort and the caller's poll can still report the
 * job's state, events, and result. `errorMessage` is reserved for an id the
 * unified core no longer knows at all.
 */
export type CancelBackgroundAgentJobResult =
  | { cancelled: true; status: 'cancelled' }
  | { cancelled: false; status: BackgroundAgentJobStatus }
  | { errorMessage: string }

export function cancelBackgroundAgentJob(
  jobId: string,
): CancelBackgroundAgentJobResult {
  sweepBackgroundAgentJobs()
  const coreJob = registry.get(jobId)
  if (!coreJob) {
    return { errorMessage: `No background agent job found with id "${jobId}".` }
  }
  const job = views.get(jobId)
  if (!job) {
    // Only SETTLED views are ever evicted (the view owns the AbortController),
    // so an id the core still knows without a view is a settled job. Reporting
    // it as not_found would contradict the retention invariant, so it is
    // reported as the idempotent no-op it is.
    return { cancelled: false, status: jobStateToStatus(coreJob.state) }
  }
  if (job.status !== 'running') {
    return { cancelled: false, status: job.status }
  }
  const error = BACKGROUND_AGENT_CANCEL_REASON
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
 * True when this job's OWN cancellation is what settled it: the adapter view or
 * the core record already says 'cancelled', or this job's AbortController fired
 * with {@link BACKGROUND_AGENT_CANCEL_REASON}. The spawn handler uses it to
 * tell an explicit `check_background_agent({ cancel: true })` abort apart from
 * an ordinary rejection (a subagent timeout, a parent-signal abort, a real
 * error), so a cancelled job is not relabelled as a failure on the parent's
 * durable intent and receipt while the registry keeps 'cancelled'.
 *
 * A parent-signal abort is deliberately NOT cancellation here: the combined
 * signal the spawn handler builds never aborts this job's own controller, so
 * only the adapter's cancel path can satisfy the reason check.
 */
export function backgroundAgentJobWasCancelled(
  job: BackgroundAgentJob,
): boolean {
  if (job.status === 'cancelled') return true
  if (registry.get(job.jobId)?.state === 'cancelled') return true
  const reason: unknown = job.abortController.signal.aborted
    ? job.abortController.signal.reason
    : undefined
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : undefined
  return message === BACKGROUND_AGENT_CANCEL_REASON
}

/**
 * Terminally abandon a job that was allocated but whose coroutine was NEVER
 * launched. Mirrors {@link cancelBackgroundAgentJob}'s idiom — fold a terminal
 * lifecycle event into the core, then abort the adapter's controller — and
 * additionally drops the view, because a pre-launch job still holds the
 * allocation placeholder promise: no settle handler is wired until
 * {@link attachBackgroundAgentPromise}, and nothing reaps background agent
 * jobs, so without this the job stays 'running' forever and permanently
 * consumes the process-wide (32) and per-root (8) background budget.
 *
 * Terminal (`error`) rather than `cancelled`: the spawn failed before the agent
 * ran, and keeping `cancelled` to mean an explicit cancel is what lets
 * {@link backgroundAgentJobWasCancelled} stay accurate.
 *
 * ONLY legal for a job whose coroutine was never launched — abandoning a live
 * job would abort a running agent and drop the view that owns its
 * AbortController.
 */
export function abandonPreLaunchBackgroundAgentJob(
  job: BackgroundAgentJob,
  reason: string,
): void {
  const coreJob = registry.get(job.jobId)
  // Terminal states absorb in the core, so an already-settled job is a no-op.
  if (coreJob && !isTerminalJobState(coreJob.state)) {
    registry.emit(job.jobId, {
      type: 'lifecycle',
      state: 'error',
      error: reason,
    })
  }
  job.status = 'error'
  job.completedAt = Date.now()
  job.error = reason
  if (!job.abortController.signal.aborted) {
    job.abortController.abort(new Error(reason))
  }
  views.delete(job.jobId)
}

/**
 * Registry-backed ownership check for check_background_agent. Returns the
 * core's tri-state unchanged so the handler can distinguish not_found from
 * foreign. View presence is deliberately NOT consulted: the core owns both the
 * lifecycle state and the settled `result`, so a job whose view was count-cap
 * evicted is owned and still reports its result. Only a job the core no longer
 * knows about (never allocated, or reclaimed by the settled-job TTL sweep) is
 * not_found. The sweep runs first so this gate and the caller's subsequent
 * reads observe the same registry state.
 */
export function assertBackgroundAgentJobOwned(
  jobId: string,
  owner: { clientSessionId: string; rootRunId: string },
): AssertOwnedResult {
  sweepBackgroundAgentJobs()
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
 * terminal state, or the timeout fires, or the caller's abort signal fires —
 * driven purely off the registry's internal notifications (no sleep-polling).
 * The core clamps the supplied cursor, so a cursor past the job's latest
 * sequence cannot strand the waiter.
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
