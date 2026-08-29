/**
 * Unified in-process registry for all background jobs (shell `process` jobs
 * and `agent` coroutines).
 *
 * This module is the single source of truth for a job's lifecycle state, its
 * bounded sequenced event ring buffer, per-consumer cursors, join/wait
 * primitives, and an in-process async-iterator stream. Adapters (e.g. the
 * SDK's background shell runner, the agent-runtime's background agent runner)
 * never set job state directly — they only `emit()` events, and lifecycle
 * payloads are folded into state here via a strictly enforced state machine.
 *
 * Both packages depend on @codebuff/common, so keeping the core registry here
 * gives every adapter and consumer a stable shared surface with no direct
 * sdk ↔ agent-runtime dependency.
 *
 * Pure TypeScript: no Node builtins are imported, so this module is safe to
 * run in any JS runtime.
 */

/** The kind of execution unit backing a background job. */
export type JobKind = 'process' | 'agent'

/**
 * Lifecycle states of a background job.
 *
 * Legal transitions (enforced by {@link reduceJobState}):
 *   queued -> running
 *   running -> stopping
 *   running -> completed | error | stopped | lost | cancelled
 *   stopping -> completed | error | stopped | lost | cancelled
 *
 * Terminal states are absorbing: no state can be exited once reached.
 */
export type JobState =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'error'
  | 'stopped'
  | 'lost'
  | 'cancelled'

/** States from which no further transition is possible. */
export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'completed',
  'error',
  'stopped',
  'lost',
  'cancelled',
])

/** Whether a state is terminal (absorbing). */
export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_STATES.has(state)
}

/**
 * Identify which client/session/run a job belongs to. Ownership is checked
 * inside the registry (see {@link JobRegistry.assertOwned}) so adapters can
 * never touch another session's jobs.
 */
export interface JobOwner {
  clientSessionId: string
  rootRunId: string
  parentRunId: string
  parentAgentId: string
}

/**
 * Placeholder owner stamped on ownerless / test jobs (e.g. direct CLI
 * invocations or registry test fixtures). It must NEVER be attributed to a
 * real run: owner-scoped consumers (such as the SDK run loop's live
 * job-event forwarding) explicitly refuse to forward jobs stamped with this
 * owner because they are unattributable. The SDK imports this single source
 * directly for stamping ownerless spawns (no private copy).
 */
export const UNKNOWN_JOB_OWNER: JobOwner = {
  clientSessionId: 'unknown-session',
  rootRunId: 'unknown-root',
  parentRunId: 'unknown-parent',
  parentAgentId: 'unknown-agent',
}

/** Payloads carried by {@link JobEvent}s. */
export type JobEventPayload =
  | { type: 'output'; data: string }
  | { type: 'agent_chunk'; chunkType: string; data: unknown }
  | {
      type: 'lifecycle'
      state: JobState
      exitCode?: number | null
      error?: string
    }
  | { type: 'status'; message?: string }

/**
 * Global fan-out listener registered via {@link JobRegistry.subscribeAll}.
 * Receives every recorded event across all jobs (a defensive copy of the job
 * plus the same event object waiters/stream subscribers receive), so a host
 * (e.g. the SDK run loop) can push owner-scoped live job activity to a UI
 * without polling.
 */
export type AllJobsListener = (job: Job, event: JobEvent) => void

/** A single sequenced event in a job's ring buffer. */
export interface JobEvent {
  /** Monotonically increasing per job, starting at 1. */
  sequence: number
  jobId: string
  timestamp: number
  payload: JobEventPayload
}

/** A background job record. */
export interface Job {
  jobId: string
  kind: JobKind
  state: JobState
  owner: JobOwner
  /** Human-readable label (command line, agent prompt, ...). */
  label: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  exitCode?: number | null
  error?: string
  result?: unknown
}

/** Options for {@link JobRegistry.create}. */
export interface CreateJobOptions {
  kind: JobKind
  label: string
  owner: JobOwner
  /**
   * Explicit id for the job. When omitted the registry allocates one (the
   * `job-<counter>-<hex>` shape); when provided it must be unique among
   * currently-registered jobs (create throws on collision).
   */
  jobId?: string
}

/** Result of {@link JobRegistry.assertOwned}. */
export type AssertOwnedResult =
  | { ok: true; job: Job }
  | { ok: false; reason: 'not_found' | 'foreign' }

/** Result of {@link JobRegistry.snapshot}. */
export interface JobSnapshot {
  events: JobEvent[]
  /** Highest sequence returned, or the passed cursor when none were. */
  nextCursor: number
  state: JobState
  /** True when events at or below the cursor were evicted from the buffer. */
  truncated: boolean
  /** Cumulative number of events evicted from the job's buffer. */
  dropped: number
}

/** Options for {@link JobRegistry.wait}. */
export interface WaitJobOptions {
  /** Resolve early when a NEW event (sequence > cursor) matches. */
  predicate?: (event: JobEvent) => boolean
  /** Resolve with timedOut=true after this many milliseconds. */
  timeoutMs?: number
  /** Only events with sequence > cursor count as new. Defaults to 0. */
  cursor?: number
}

/** Result of {@link JobRegistry.wait}. */
export interface WaitJobResult {
  events: JobEvent[]
  nextCursor: number
  state: JobState
  /** The event that satisfied the predicate, if any. */
  matched?: JobEvent
  timedOut: boolean
  dropped: number
}

/** How long a settled (terminal) job is retained before {@link JobRegistry.sweep} drops it. Defaults to 24h. */
export const SETTLED_JOB_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Default maximum number of events kept per job. Past this bound the oldest
 * events are evicted (and counted in `dropped`).
 */
export const DEFAULT_JOB_EVENT_BUFFER_LIMIT = 500

/**
 * Default maximum total bytes of accumulated output kept per job — shell/agent
 * `output` text plus `agent_chunk` data (approximated via string / JSON
 * length). Whichever of the count/byte bounds is hit first triggers eviction
 * of the oldest events, so a chatty job of either kind stays byte-bounded and
 * cannot OOM the runtime.
 */
export const DEFAULT_JOB_OUTPUT_BYTE_LIMIT = 256 * 1024

/**
 * Agent-kind event ring bound: agent_chunk traffic is voluminous, so agent
 * jobs keep a shorter event window than process jobs.
 */
export const AGENT_JOB_EVENT_BUFFER_LIMIT = 200

/** Agent-kind settled retention window: 30 minutes. */
export const AGENT_JOB_SETTLED_TTL_MS = 30 * 60 * 1000

/**
 * Per-kind overrides for the registry bounds. Any field left unset falls
 * back to the registry-wide default.
 */
export interface JobKindBounds {
  /** Max events retained for jobs of this kind. */
  eventBufferLimit?: number
  /** Max retained bytes of output text for jobs of this kind. */
  outputByteLimit?: number
  /** Retention window for settled jobs of this kind. */
  settledTtlMs?: number
}

/** Per-registry bounds knobs. */
export interface JobRegistryOptions {
  /** Max events retained per job. Defaults to {@link DEFAULT_JOB_EVENT_BUFFER_LIMIT}. */
  eventBufferLimit?: number
  /** Max retained bytes of output text per job. Defaults to {@link DEFAULT_JOB_OUTPUT_BYTE_LIMIT}. */
  outputByteLimit?: number
  /** Retention window for settled jobs. Defaults to {@link SETTLED_JOB_TTL_MS}. */
  settledTtlMs?: number
  /**
   * Per-kind overrides: `kindBounds[kind]` layers over the top-level
   * defaults above, so kinds not listed (and fields not set on a listed
   * kind) keep the registry-wide defaults.
   */
  kindBounds?: Partial<Record<JobKind, JobKindBounds>>
}

/**
 * Pure lifecycle reducer: fold a lifecycle event into a job's state. Returns
 * the next state when the transition is legal, `null` when it is not (the
 * registry ignores such events so a job's state can never leave a terminal
 * state or skip stages).
 *
 * Legal:
 *   queued -> running
 *   running -> stopping
 *   running -> any terminal state
 *   stopping -> any terminal state
 */
export function reduceJobState(
  current: JobState,
  lifecycle: { state: JobState },
): JobState | null {
  if (current === lifecycle.state) return null
  switch (current) {
    case 'queued':
      return lifecycle.state === 'running' ? 'running' : null
    case 'running':
      if (lifecycle.state === 'stopping') return 'stopping'
      return isTerminalJobState(lifecycle.state) ? lifecycle.state : null
    case 'stopping':
      return isTerminalJobState(lifecycle.state) ? lifecycle.state : null
    default:
      // Terminal states are absorbing.
      return null
  }
}

/**
 * Approximate the retained-byte cost of an event payload for the per-job
 * output byte bound. Both shell/agent `output` text and `agent_chunk` data
 * accumulate in memory, so both are counted (chunk objects via a cheap JSON
 * size estimate); otherwise a chatty agent's structured chunks could grow the
 * buffer without limit even under the event-count cap and OOM the runtime.
 * Lifecycle/status payloads are negligible and are not counted.
 *
 * Using the SAME measurement on append and eviction keeps `bufferedBytes`
 * symmetric (a circular / unserializable chunk measures as 0 both times).
 */
function payloadByteSize(payload: JobEventPayload): number {
  if (payload.type === 'output') return payload.data.length
  if (payload.type === 'agent_chunk') {
    if (typeof payload.data === 'string') return payload.data.length
    try {
      return JSON.stringify(payload.data)?.length ?? 0
    } catch {
      return 0
    }
  }
  return 0
}

let jobCounter = 0

/**
 * Allocate a unique, URL/path-safe job id of the form `job-<counter>-<hex>`.
 * An explicit `jobId` is honored as-is; the counter still advances so
 * registry-allocated ids can never collide with explicit ids.
 */
function allocateJobId(explicitJobId?: string): string {
  jobCounter += 1
  if (explicitJobId !== undefined) return explicitJobId
  const random = Math.random().toString(16).slice(2, 10)
  return `job-${jobCounter.toString(36)}-${random}`
}

/** Fully-resolved bounds for one job: its kind's overrides over the registry defaults. */
interface ResolvedJobBounds {
  eventBufferLimit: number
  outputByteLimit: number
  settledTtlMs: number
}

/** Internal per-job record: public job data plus its event machinery. */
interface JobRecord {
  job: Job
  events: JobEvent[]
  nextSequence: number
  /** Cumulative number of events evicted from the buffer. */
  dropped: number
  /**
   * Approximate bytes of accumulated output currently buffered: shell/agent
   * `output` text plus `agent_chunk` data, so a chatty job of either kind is
   * byte-bounded (not just event-count bounded) and cannot OOM the runtime.
   */
  bufferedBytes: number
  /** Effective bounds for this job, resolved from its kind at create time. */
  bounds: ResolvedJobBounds
}

interface PendingWaiter {
  cursor: number
  predicate?: (event: JobEvent) => boolean
  timeoutMs?: number
  timer?: ReturnType<typeof setTimeout>
  /**
   * Accepts `undefined` because {@link JobRegistry.clear} resolves pending
   * waiters with it — the same "job no longer exists" value {@link
   * JobRegistry.wait} returns for an unknown job id.
   */
  resolve: (result: WaitJobResult | undefined) => void
}

interface PendingStream {
  cursor: number
  push: (event: JobEvent) => void
  finish: () => void
}

/**
 * In-process source of truth for background jobs: a strictly-enforced
 * lifecycle state machine, a bounded sequenced event ring buffer per job,
 * per-consumer cursors, a join/wait primitive, and an in-process
 * async-iterator stream.
 */
export class JobRegistry {
  private records = new Map<string, JobRecord>()
  private waiters = new Map<string, Set<PendingWaiter>>()
  private streamSubscribers = new Map<string, Set<PendingStream>>()
  private allSubscribers = new Set<AllJobsListener>()
  private readonly eventBufferLimit: number
  private readonly outputByteLimit: number
  private readonly settledTtlMs: number
  private readonly kindBounds: Partial<Record<JobKind, JobKindBounds>>

  constructor(options: JobRegistryOptions = {}) {
    this.eventBufferLimit =
      options.eventBufferLimit ?? DEFAULT_JOB_EVENT_BUFFER_LIMIT
    this.outputByteLimit =
      options.outputByteLimit ?? DEFAULT_JOB_OUTPUT_BYTE_LIMIT
    this.settledTtlMs = options.settledTtlMs ?? SETTLED_JOB_TTL_MS
    this.kindBounds = options.kindBounds ?? {}
  }

  /**
   * Allocate a new job in the `queued` state and emit its lifecycle(queued)
   * event (the first event in the job's buffer).
   */
  create({ kind, label, owner, jobId }: CreateJobOptions): Job {
    const allocatedJobId = allocateJobId(jobId)
    if (this.records.has(allocatedJobId)) {
      throw new Error(
        `job-registry: job id '${allocatedJobId}' is already registered`,
      )
    }
    const job: Job = {
      jobId: allocatedJobId,
      kind,
      state: 'queued',
      owner,
      label,
      createdAt: Date.now(),
    }
    this.records.set(job.jobId, {
      job,
      events: [],
      nextSequence: 1,
      dropped: 0,
      bufferedBytes: 0,
      bounds: this.resolveBounds(kind),
    })
    this.appendEvent(job.jobId, { type: 'lifecycle', state: 'queued' })
    return { ...job }
  }

  /**
   * Transition a job from `queued` to `running`, stamping startedAt and
   * emitting lifecycle(running). Throws when the job is unknown or the
   * transition is not legal.
   */
  start(jobId: string): Job {
    const record = this.getRecordOrThrow(jobId)
    const transitioned = this.appendEvent(jobId, {
      type: 'lifecycle',
      state: 'running',
    })
    if (!transitioned) {
      throw new Error(
        `job-registry: cannot start job ${jobId} from state '${record.job.state}'`,
      )
    }
    return { ...record.job }
  }

  /**
   * Append an event to the job's ring buffer with the next per-job sequence
   * number, evicting the oldest events when the count/byte bounds are
   * exceeded.
   *
   * Lifecycle payloads are folded into job state via the state machine;
   * invalid transitions (including any transition out of a terminal state)
   * are ignored — the event is not recorded and state is left untouched.
   * Output/agent_chunk/status payloads are always buffered, even after the
   * job is terminal, so late output is never lost. Returns the recorded
   * event, or `undefined` for a rejected lifecycle transition.
   */
  emit(jobId: string, payload: JobEventPayload): JobEvent | undefined {
    const record = this.records.get(jobId)
    if (!record) return undefined
    return this.appendEvent(jobId, payload)
  }

  /** Look up a job by id (settled jobs are swept first). */
  get(jobId: string): Job | undefined {
    this.sweep()
    const record = this.records.get(jobId)
    return record ? { ...record.job } : undefined
  }

  /**
   * List running jobs plus settled jobs still within the retention TTL,
   * filtered to the owner (clientSessionId + rootRunId) when provided.
   */
  list(owner?: { clientSessionId: string; rootRunId: string }): Job[] {
    this.sweep()
    const jobs: Job[] = []
    for (const record of this.records.values()) {
      if (!owner || this.ownedBy(record.job, owner)) {
        jobs.push({ ...record.job })
      }
    }
    return jobs
  }

  /** List only non-terminal jobs, filtered to the owner when provided. */
  listRunning(owner?: { clientSessionId: string; rootRunId: string }): Job[] {
    this.sweep()
    const jobs: Job[] = []
    for (const record of this.records.values()) {
      if (
        !isTerminalJobState(record.job.state) &&
        (!owner || this.ownedBy(record.job, owner))
      ) {
        jobs.push({ ...record.job })
      }
    }
    return jobs
  }

  /**
   * Check that a job exists and belongs to the given owner. Ownership is
   * enforced inside the registry so callers can never accidentally operate on
   * another session's job.
   */
  assertOwned(
    jobId: string,
    owner: { clientSessionId: string; rootRunId: string },
  ): AssertOwnedResult {
    this.sweep()
    const record = this.records.get(jobId)
    if (!record) return { ok: false, reason: 'not_found' }
    if (!this.ownedBy(record.job, owner))
      return { ok: false, reason: 'foreign' }
    return { ok: true, job: { ...record.job } }
  }

  /**
   * Replace a job's owner. Used by the cross-session re-attach path to upgrade
   * a job first recovered under a placeholder owner to the current run's
   * trusted owner. Callers are responsible for only upgrading FROM a
   * placeholder owner (never overwriting an already-trusted owner). No-op for
   * an unknown job id.
   */
  restampOwner(jobId: string, owner: JobOwner): void {
    const record = this.records.get(jobId)
    if (!record) return
    record.job.owner = owner
  }

  /**
   * Return every buffered event with sequence > cursor. `nextCursor` is the
   * highest sequence returned (or the passed cursor when none); `truncated`
   * reports that events at or below the cursor were evicted, and `dropped`
   * is the cumulative eviction count so consumers can detect gaps.
   */
  snapshot(jobId: string, cursor = 0): JobSnapshot | undefined {
    const record = this.records.get(jobId)
    if (!record) return undefined
    const events = record.events.filter((event) => event.sequence > cursor)
    const last = events[events.length - 1]
    return {
      events,
      nextCursor: last ? last.sequence : cursor,
      state: record.job.state,
      truncated: this.truncatedAtCursor(record, cursor),
      dropped: record.dropped,
    }
  }

  /**
   * Resolve when the predicate matches a NEW event (sequence > cursor), or
   * the job reaches a terminal state, or the timeout fires — whichever comes
   * first. Driven purely off the registry's internal notifications: no
   * sleep-polling, and listeners/timers are cleaned up on settle. Resolves
   * `undefined` for an unknown job id.
   */
  wait(
    jobId: string,
    options: WaitJobOptions = {},
  ): Promise<WaitJobResult | undefined> {
    const record = this.records.get(jobId)
    if (!record) return Promise.resolve(undefined)

    const cursor = options.cursor ?? 0
    const immediate = this.evaluateWait(record, cursor, options.predicate)
    if (immediate) return Promise.resolve(immediate)

    return new Promise<WaitJobResult | undefined>((resolve) => {
      const waiter: PendingWaiter = {
        cursor,
        predicate: options.predicate,
        timeoutMs: options.timeoutMs,
        resolve,
      }
      if (options.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.settleWaiter(jobId, waiter)
        }, options.timeoutMs)
      }
      this.addWaiter(jobId, waiter)
    })
  }

  /**
   * Push events to an in-process consumer as they arrive, starting after
   * `cursor`. The iterable terminates once the job is in a terminal state and
   * its buffer has been drained. A late subscriber first receives any still
   * buffered backlog (backpressure-free: events are queued if the consumer
   * falls behind).
   */
  stream(jobId: string, cursor = 0): AsyncIterable<JobEvent> {
    const registry = this
    return {
      [Symbol.asyncIterator](): AsyncIterator<JobEvent> {
        const queue: JobEvent[] = []
        let pull:
          | { resolve: (result: IteratorResult<JobEvent>) => void }
          | undefined
        let done = false

        const deliver = (event: JobEvent): void => {
          if (done) return
          if (pull) {
            const pending = pull
            pull = undefined
            pending.resolve({ value: event, done: false })
          } else {
            queue.push(event)
          }
        }
        const finish = (): void => {
          if (done) return
          done = true
          if (pull) {
            const pending = pull
            pull = undefined
            pending.resolve({ value: undefined, done: true })
          }
        }

        const subscriber: PendingStream = { cursor, push: deliver, finish }
        const record = registry.records.get(jobId)
        if (record) {
          // Replay any still-buffered backlog so a late subscriber never
          // silently skips events that were not yet evicted.
          for (const event of record.events) {
            if (event.sequence > subscriber.cursor) {
              subscriber.cursor = event.sequence
              deliver(event)
            }
          }
          if (isTerminalJobState(record.job.state)) {
            finish()
          } else {
            registry.addStreamSubscriber(jobId, subscriber)
          }
        } else {
          // Unknown (or already swept) job: nothing to stream.
          finish()
        }

        return {
          next(): Promise<IteratorResult<JobEvent>> {
            const queued = queue.shift()
            if (queued !== undefined) {
              return Promise.resolve({ value: queued, done: false })
            }
            if (done) {
              return Promise.resolve({ value: undefined, done: true })
            }
            return new Promise<IteratorResult<JobEvent>>((resolve) => {
              pull = { resolve }
            })
          },
          async return(): Promise<IteratorResult<JobEvent>> {
            registry.removeStreamSubscriber(jobId, subscriber)
            finish()
            return { value: undefined, done: true }
          },
        }
      },
    }
  }

  /**
   * Record a cancellation request by emitting lifecycle(cancelled). The
   * owning adapter performs the real kill/abort separately; this only folds
   * the terminal transition into the registry (legal from `running` or
   * `stopping`).
   */
  cancel(jobId: string): void {
    this.appendEvent(jobId, { type: 'lifecycle', state: 'cancelled' })
  }

  /**
   * Drop settled jobs whose completedAt is older than their kind's
   * retention TTL. Running jobs and settled jobs without a completedAt are
   * always retained.
   */
  sweep(now = Date.now()): void {
    for (const [jobId, record] of this.records) {
      if (
        isTerminalJobState(record.job.state) &&
        record.job.completedAt !== undefined &&
        now - record.job.completedAt > record.bounds.settledTtlMs
      ) {
        this.records.delete(jobId)
      }
    }
  }

  /** Remove every job, waiter, and stream subscriber. Test-only hook. */
  clear(): void {
    // Snapshot the waiters and detach the map before resolving: a pending
    // wait() whose promise is dropped here would hang its caller forever.
    // `undefined` is the "job no longer exists" resolution — the same value
    // wait() gives an unknown job id — and after clear() the job is gone.
    const pendingWaiters = [...this.waiters.values()].flatMap((waiters) => [
      ...waiters,
    ])
    this.waiters.clear()
    for (const waiter of pendingWaiters) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(undefined)
    }
    for (const subscribers of this.streamSubscribers.values()) {
      for (const subscriber of subscribers) {
        subscriber.finish()
      }
    }
    this.streamSubscribers.clear()
    this.allSubscribers.clear()
    this.records.clear()
  }

  /**
   * Register a global fan-out listener invoked with every recorded event
   * across all jobs. Returns an idempotent disposer that detaches the
   * listener (calling it more than once is a no-op). Listener throws are
   * isolated so one bad listener can never break emit or other subscribers.
   */
  subscribeAll(listener: AllJobsListener): () => void {
    this.allSubscribers.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.allSubscribers.delete(listener)
    }
  }

  private notifyAllSubscribers(job: Job, event: JobEvent): void {
    for (const listener of [...this.allSubscribers]) {
      try {
        listener({ ...job }, event)
      } catch {
        /* isolate: one bad listener must not break emit */
      }
    }
  }

  private getRecordOrThrow(jobId: string): JobRecord {
    const record = this.records.get(jobId)
    if (!record) {
      throw new Error(`job-registry: unknown job '${jobId}'`)
    }
    return record
  }

  private ownedBy(
    job: Job,
    owner: { clientSessionId: string; rootRunId: string },
  ): boolean {
    return (
      job.owner.clientSessionId === owner.clientSessionId &&
      job.owner.rootRunId === owner.rootRunId
    )
  }

  /**
   * Core append path shared by create/start/emit/cancel. Folds lifecycle
   * payloads through the state machine, stamps the job record, buffers the
   * event, enforces ring-buffer bounds, and notifies waiters/subscribers.
   * Returns `false` when a lifecycle transition was rejected.
   */
  private appendEvent(
    jobId: string,
    payload: JobEventPayload,
  ): JobEvent | undefined {
    const record = this.records.get(jobId)
    if (!record) return undefined

    const timestamp = Date.now()
    let transitionedTo: JobState | undefined
    if (payload.type === 'lifecycle') {
      // `queued` is the create-time stamp; reduceJobState only governs
      // transitions out of an already-allocated state.
      if (payload.state === 'queued' && record.nextSequence === 1) {
        transitionedTo = 'queued'
      } else {
        const next = reduceJobState(record.job.state, payload)
        if (next === null) return undefined
        transitionedTo = next
      }

      if (transitionedTo === 'running') {
        record.job.startedAt = timestamp
      }
      if (isTerminalJobState(transitionedTo)) {
        record.job.completedAt = timestamp
        if (payload.exitCode !== undefined) {
          record.job.exitCode = payload.exitCode
        }
        if (payload.error !== undefined) {
          record.job.error = payload.error
        }
      }
      record.job.state = transitionedTo
    }

    const event: JobEvent = {
      sequence: record.nextSequence,
      jobId,
      timestamp,
      payload,
    }
    record.nextSequence += 1
    record.events.push(event)
    record.bufferedBytes += payloadByteSize(payload)
    this.evictOverflow(record)

    this.notifyWaiters(jobId, record, event)
    this.notifyStreamSubscribers(jobId, record, event)
    this.notifyAllSubscribers(record.job, event)
    return event
  }

  /**
   * Resolve the effective bounds for a job kind: the kind's `kindBounds`
   * overrides layered over the registry-wide defaults.
   */
  private resolveBounds(kind: JobKind): ResolvedJobBounds {
    const overrides = this.kindBounds[kind]
    return {
      eventBufferLimit: overrides?.eventBufferLimit ?? this.eventBufferLimit,
      outputByteLimit: overrides?.outputByteLimit ?? this.outputByteLimit,
      settledTtlMs: overrides?.settledTtlMs ?? this.settledTtlMs,
    }
  }

  /** Evict oldest events until both the count and byte bounds are satisfied. */
  private evictOverflow(record: JobRecord): void {
    while (
      record.events.length > record.bounds.eventBufferLimit ||
      record.bufferedBytes > record.bounds.outputByteLimit
    ) {
      const evicted = record.events.shift()
      if (!evicted) break
      record.bufferedBytes -= payloadByteSize(evicted.payload)
      record.dropped += 1
    }
    if (record.bufferedBytes < 0) record.bufferedBytes = 0
  }

  /**
   * Whether events the consumer has not yet seen were evicted before it could
   * read them (a real gap in its stream). A gap exists when the lowest
   * retained sequence is more than one past the cursor: the consumer wants
   * `cursor + 1` next, so a first retained sequence greater than that means
   * the events in between were dropped. A healthy buffer that merely still
   * holds already-consumed events (first.sequence <= cursor) is NOT a gap.
   */
  private truncatedAtCursor(record: JobRecord, cursor: number): boolean {
    const first = record.events[0]
    return first !== undefined && first.sequence > cursor + 1
  }

  /**
   * Evaluate a wait against the job's CURRENT buffer: predicate over new
   * events first, then terminal state. Returns the result when the wait can
   * settle immediately, or `undefined` when it must remain pending.
   */
  private evaluateWait(
    record: JobRecord,
    cursor: number,
    predicate: ((event: JobEvent) => boolean) | undefined,
    timedOut = false,
  ): WaitJobResult | undefined {
    const events = record.events.filter((event) => event.sequence > cursor)
    if (predicate) {
      const matched = events.find(predicate)
      if (matched) {
        return {
          events,
          nextCursor: matched.sequence,
          state: record.job.state,
          matched,
          timedOut,
          dropped: record.dropped,
        }
      }
    }
    if (isTerminalJobState(record.job.state) || timedOut) {
      const last = events[events.length - 1]
      return {
        events,
        nextCursor: last ? last.sequence : cursor,
        state: record.job.state,
        timedOut,
        dropped: record.dropped,
      }
    }
    return undefined
  }

  private addWaiter(jobId: string, waiter: PendingWaiter): void {
    let waiters = this.waiters.get(jobId)
    if (!waiters) {
      waiters = new Set()
      this.waiters.set(jobId, waiters)
    }
    waiters.add(waiter)
  }

  /** Resolve a waiter's promise and detach it (clearing its timer). */
  private settleWaiter(
    jobId: string,
    waiter: PendingWaiter,
    timedOut = false,
  ): void {
    const waiters = this.waiters.get(jobId)
    if (!waiters || !waiters.has(waiter)) return
    waiters.delete(waiter)
    if (waiters.size === 0) this.waiters.delete(jobId)
    if (waiter.timer) clearTimeout(waiter.timer)

    const record = this.records.get(jobId)
    if (!record) {
      waiter.resolve({
        events: [],
        nextCursor: waiter.cursor,
        state: 'lost',
        timedOut,
        dropped: 0,
      })
      return
    }
    const result = this.evaluateWait(
      record,
      waiter.cursor,
      waiter.predicate,
      timedOut,
    )
    if (result) {
      waiter.resolve(result)
      return
    }
    // The record is live and non-terminal (only reachable from the timeout
    // path): report the current snapshot with timedOut=true.
    waiter.resolve(
      this.evaluateWait(record, waiter.cursor, waiter.predicate, true) ?? {
        events: [],
        nextCursor: waiter.cursor,
        state: record.job.state,
        timedOut: true,
        dropped: record.dropped,
      },
    )
  }

  /** Wake pending waiters on each new event; also settle them all on terminal. */
  private notifyWaiters(
    jobId: string,
    record: JobRecord,
    event: JobEvent,
  ): void {
    const waiters = this.waiters.get(jobId)
    if (!waiters || waiters.size === 0) return
    const terminal = isTerminalJobState(record.job.state)
    for (const waiter of [...waiters]) {
      if (
        event.sequence > waiter.cursor &&
        (terminal || (waiter.predicate?.(event) ?? false))
      ) {
        this.settleWaiter(jobId, waiter)
      }
    }
  }

  private addStreamSubscriber(jobId: string, subscriber: PendingStream): void {
    let subscribers = this.streamSubscribers.get(jobId)
    if (!subscribers) {
      subscribers = new Set()
      this.streamSubscribers.set(jobId, subscribers)
    }
    subscribers.add(subscriber)
  }

  private removeStreamSubscriber(
    jobId: string,
    subscriber: PendingStream,
  ): void {
    const subscribers = this.streamSubscribers.get(jobId)
    if (!subscribers) return
    subscribers.delete(subscriber)
    if (subscribers.size === 0) this.streamSubscribers.delete(jobId)
  }

  /** Push each new event to subscribers; finish them all on terminal. */
  private notifyStreamSubscribers(
    jobId: string,
    record: JobRecord,
    event: JobEvent,
  ): void {
    const subscribers = this.streamSubscribers.get(jobId)
    if (!subscribers || subscribers.size === 0) return
    for (const subscriber of [...subscribers]) {
      if (event.sequence > subscriber.cursor) {
        subscriber.cursor = event.sequence
        subscriber.push(event)
      }
    }
    if (isTerminalJobState(record.job.state)) {
      this.streamSubscribers.delete(jobId)
      for (const subscriber of subscribers) {
        subscriber.finish()
      }
    }
  }
}

/**
 * Process-wide shared registry. Both adapters and consumers use this.
 *
 * Agent jobs run with tighter per-kind bounds (a shorter event window and
 * settled retention TTL, since agent_chunk traffic is voluminous) while
 * process jobs keep the core defaults, so one registry remains the single
 * source of truth for every kind of job.
 */
export const jobRegistry: JobRegistry = new JobRegistry({
  kindBounds: {
    agent: {
      eventBufferLimit: AGENT_JOB_EVENT_BUFFER_LIMIT,
      settledTtlMs: AGENT_JOB_SETTLED_TTL_MS,
    },
  },
})

/** Test-only: reset the shared singleton between tests. */
export function __clearJobRegistryForTest(): void {
  jobRegistry.clear()
}
