import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/fixtures/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { jobRegistry } from '@codebuff/common/util/job-registry'
import { assistantMessage } from '@codebuff/common/util/messages'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'

import { mockFileContext } from './test-utils'
import * as runAgentStep from '../run-agent-step'
import {
  DEFAULT_CHECK_BACKGROUND_AGENT_FOLLOW_TIMEOUT_MS,
  MAX_CHECK_BACKGROUND_AGENT_FOLLOW_TIMEOUT_MS,
  handleCheckBackgroundAgent,
  resolveCheckBackgroundAgentWaitBounds,
} from '../tools/handlers/tool/check-background-agent'
import { handleSpawnAgents } from '../tools/handlers/tool/spawn-agents'
import {
  abandonPreLaunchBackgroundAgentJob,
  allocateBackgroundAgentJob,
  allocateBackgroundAgentJobBatch,
  assertBackgroundAgentCapacity,
  assertBackgroundAgentJobOwned,
  attachBackgroundAgentPromise,
  registerBackgroundAgentJob,
  appendBackgroundAgentChunk,
  getBackgroundAgentJob,
  getBackgroundAgentJobCore,
  listRunningBackgroundAgentJobs,
  readNewBackgroundAgentChunks,
  readBackgroundAgentChunks,
  backgroundAgentJobOwnedBy,
  backgroundAgentJobWasCancelled,
  reconcileInterruptedBackgroundAgentIntents,
  takeDroppedBackgroundAgentChunkCount,
  cancelBackgroundAgentJob,
  __clearBackgroundAgentJobsForTest,
} from '../util/background-agent-jobs'

import type {
  BackgroundAgentJob,
  BackgroundAgentJobOwner,
} from '../util/background-agent-jobs'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'

const INTERRUPTED_INTENT_MESSAGE =
  'Background agent host process/session ended before a terminal receipt was recorded.'

/**
 * Attach an already-resolved coroutine and flush the two microtask ticks the
 * settle chain needs (the `.then` handler, then the registry sync).
 */
async function settleBackgroundAgentJob(
  job: BackgroundAgentJob,
  result: unknown,
): Promise<void> {
  attachBackgroundAgentPromise(job, Promise.resolve(result))
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Push the adapter past its 100-VIEW retention cap with SETTLED background
 * agents so the count-cap sweep runs and evicts the oldest settled adapter
 * views. Each filler is settled before the next is allocated, so the
 * running-job quotas (32 total, 8 per root) are never in play.
 */
async function fillPastBackgroundAgentJobCountCap(
  owner: BackgroundAgentJobOwner,
): Promise<void> {
  for (let index = 0; index < 105; index++) {
    const filler = allocateBackgroundAgentJob({
      agentType: 'researcher',
      agentName: `Filler ${index}`,
      owner,
    })
    await settleBackgroundAgentJob(filler, { output: `filler-${index}` })
  }
}

/** Seed a settled shell `process` job directly on the shared registry. */
function seedSettledProcessJob(
  owner: BackgroundAgentJobOwner,
  label: string,
): void {
  const job = jobRegistry.create({ kind: 'process', label, owner })
  jobRegistry.start(job.jobId)
  jobRegistry.emit(job.jobId, { type: 'lifecycle', state: 'completed' })
}

/** Seed a running shell `process` job directly on the shared registry. */
function seedRunningProcessJob(
  owner: BackgroundAgentJobOwner,
  label: string,
): void {
  const job = jobRegistry.create({ kind: 'process', label, owner })
  jobRegistry.start(job.jobId)
}

/** Read the single json part of a tool handler output. */
function readJsonToolValue(output: unknown): Record<string, unknown> {
  const part = Array.isArray(output) ? output[0] : output
  return (part as { value: Record<string, unknown> }).value
}

describe('background-agent-jobs registry', () => {
  beforeEach(() => {
    __clearBackgroundAgentJobsForTest()
  })

  test('allocateBackgroundAgentJob creates a running job with a unique id', () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    expect(job.jobId).toMatch(/^bg-agent-/)
    expect(job.status).toBe('running')
    expect(job.agentType).toBe('basher')
    expect(job.agentName).toBe('Basher')
    expect(job.chunks).toEqual([])
    expect(job.readOffset).toBe(0)
  })

  test('allocateBackgroundAgentJob produces distinct ids across calls', () => {
    const a = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    const b = allocateBackgroundAgentJob({
      agentType: 'file-picker',
      agentName: 'File Picker',
    })
    expect(a.jobId).not.toBe(b.jobId)
  })

  test('preflights a background batch atomically against the per-root limit', () => {
    const owner = {
      clientSessionId: 'session',
      rootRunId: 'root',
      parentRunId: 'parent',
      parentAgentId: 'agent',
      userInputId: 'input',
    }
    for (let index = 0; index < 7; index++) {
      allocateBackgroundAgentJob({
        agentType: 'researcher',
        agentName: `Researcher ${index}`,
        owner,
      })
    }

    expect(() =>
      assertBackgroundAgentCapacity({ additional: 2, owner }),
    ).toThrow('concurrency limit reached for this run (8)')
    expect(() =>
      assertBackgroundAgentCapacity({ additional: 1, owner }),
    ).not.toThrow()
  })

  test('allocateBackgroundAgentJobBatch claims capacity atomically and launches nothing when over the limit', () => {
    const owner = {
      clientSessionId: 'session-batch-overflow',
      rootRunId: 'root-batch-overflow',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      userInputId: 'input-batch-overflow',
    }
    for (let index = 0; index < 7; index++) {
      allocateBackgroundAgentJob({
        agentType: 'researcher',
        agentName: `Researcher ${index}`,
        owner,
      })
    }
    const runningBefore = listRunningBackgroundAgentJobs(owner).length
    expect(runningBefore).toBe(7)

    // ONE capacity claim covers the whole batch: 7 + 2 > 8, so the batch is
    // rejected before any record exists — no partial launch.
    expect(() =>
      allocateBackgroundAgentJobBatch({
        agents: [
          { agentType: 'researcher', agentName: 'Researcher 7' },
          { agentType: 'researcher', agentName: 'Researcher 8' },
        ],
        owner,
      }),
    ).toThrow('concurrency limit reached for this run (8)')

    expect(listRunningBackgroundAgentJobs(owner).length).toBe(runningBefore)
  })

  test('allocateBackgroundAgentJobBatch pre-allocates one distinct id per requested agent', () => {
    const owner = {
      clientSessionId: 'session-batch',
      rootRunId: 'root-batch',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      userInputId: 'input-batch',
    }
    const agents = [
      { agentType: 'basher', agentName: 'Basher' },
      { agentType: 'file-picker', agentName: 'File Picker' },
      { agentType: 'reviewer', agentName: 'Reviewer' },
    ]

    const jobs = allocateBackgroundAgentJobBatch({ agents, owner })

    expect(jobs.length).toBe(3)
    const ids = jobs.map((job) => job.jobId)
    expect(new Set(ids).size).toBe(3)
    for (const job of jobs) {
      expect(job.jobId).toMatch(/^bg-agent-/)
      expect(job.status).toBe('running')
      // Every id resolves and can buffer chunks before any promise attaches.
      expect(getBackgroundAgentJob(job.jobId)).toBe(job)
      expect(job.chunks).toEqual([])
      expect(job.readOffset).toBe(0)
    }
    expect(
      jobs.map((job) => ({
        agentType: job.agentType,
        agentName: job.agentName,
      })),
    ).toEqual(agents)
    expect(listRunningBackgroundAgentJobs(owner).length).toBe(3)
  })

  test('getBackgroundAgentJob returns the job for a known id', () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    expect(getBackgroundAgentJob(job.jobId)).toBe(job)
  })

  test('getBackgroundAgentJob returns undefined for unknown id', () => {
    expect(getBackgroundAgentJob('bg-agent-does-not-exist')).toBeUndefined()
  })

  test('attachBackgroundAgentPromise transitions to completed on resolve', async () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    attachBackgroundAgentPromise(job, Promise.resolve({ output: 'done' }))
    // Microtasks run on await.
    await Promise.resolve()
    await Promise.resolve()
    expect(job.status).toBe('completed')
    expect(job.result).toEqual({ output: 'done' })
  })

  test('attachBackgroundAgentPromise transitions to error on reject', async () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    attachBackgroundAgentPromise(job, Promise.reject(new Error('boom')))
    await Promise.resolve()
    await Promise.resolve()
    expect(job.status).toBe('error')
    expect(job.error).toBe('boom')
  })

  test('attachBackgroundAgentPromise normalizes non-Error rejections', async () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    attachBackgroundAgentPromise(job, Promise.reject('string reason'))
    await Promise.resolve()
    await Promise.resolve()
    expect(job.status).toBe('error')
    expect(job.error).toBe('string reason')
  })

  test('registerBackgroundAgentJob combines allocation + attachment', async () => {
    const job = registerBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      promise: Promise.resolve(42),
    })
    expect(job.status).toBe('running')
    await Promise.resolve()
    await Promise.resolve()
    expect(job.status).toBe('completed')
    expect(job.result).toBe(42)
  })

  test('appendBackgroundAgentChunk buffers chunks in arrival order', () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    appendBackgroundAgentChunk(job.jobId, {
      type: 'text',
      payload: 'first',
      timestamp: 1000,
    })
    appendBackgroundAgentChunk(job.jobId, {
      type: 'text',
      payload: 'second',
      timestamp: 1001,
    })
    expect(job.chunks.length).toBe(2)
    expect(job.chunks[0]!.payload).toBe('first')
    expect(job.chunks[1]!.payload).toBe('second')
  })

  test('appendBackgroundAgentChunk is a no-op for unknown jobId', () => {
    expect(() =>
      appendBackgroundAgentChunk('bg-agent-unknown', {
        type: 'text',
        payload: 'x',
        timestamp: 1,
      }),
    ).not.toThrow()
  })

  test('readNewBackgroundAgentChunks returns only unconsumed chunks and advances offset', () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    for (let i = 0; i < 5; i++) {
      appendBackgroundAgentChunk(job.jobId, {
        type: 'text',
        payload: `chunk-${i}`,
        timestamp: i,
      })
    }
    const first = readNewBackgroundAgentChunks(job)
    expect(first.length).toBe(5)
    expect(first.map((c) => c.payload)).toEqual([
      'chunk-0',
      'chunk-1',
      'chunk-2',
      'chunk-3',
      'chunk-4',
    ])
    expect(job.readOffset).toBe(5)

    // A second read immediately after returns nothing new.
    const second = readNewBackgroundAgentChunks(job)
    expect(second).toEqual([])

    // After appending more, a third read returns only the new chunks.
    appendBackgroundAgentChunk(job.jobId, {
      type: 'text',
      payload: 'chunk-5',
      timestamp: 5,
    })
    const third = readNewBackgroundAgentChunks(job)
    expect(third.length).toBe(1)
    expect(third[0]!.payload).toBe('chunk-5')
  })

  test('appendBackgroundAgentChunk evicts oldest entries past the ring buffer bound', () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    // MAX_BUFFERED_CHUNKS is 200; push well past it.
    for (let i = 0; i < 210; i++) {
      appendBackgroundAgentChunk(job.jobId, {
        type: 'text',
        payload: i,
        timestamp: i,
      })
    }
    // Buffer should be bounded to ~200 (eviction keeps it from growing).
    expect(job.chunks.length).toBeLessThanOrEqual(200)
    // The oldest chunks should have been evicted; readOffset is adjusted to
    // stay valid so a poll returns only the surviving unconsumed chunks.
    expect(job.readOffset).toBeGreaterThanOrEqual(0)
    const polled = readNewBackgroundAgentChunks(job)
    expect(polled.length).toBe(job.chunks.length)
    expect(takeDroppedBackgroundAgentChunkCount(job)).toBe(10)
    expect(takeDroppedBackgroundAgentChunkCount(job)).toBe(0)
  })

  test('bounds chunks by UTF-8 bytes rather than JavaScript character count', () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    appendBackgroundAgentChunk(job.jobId, {
      type: 'text',
      payload: '🙂'.repeat(20_000),
      timestamp: 1,
    })

    expect(job.chunks[0]?.payload).toMatchObject({
      truncated: true,
      originalBytes: 80_002,
    })
    expect(
      Buffer.byteLength(JSON.stringify(job.chunks[0]?.payload), 'utf8'),
    ).toBeLessThanOrEqual(64 * 1024)
  })

  test('caps consumer cursor count and clamps oversized cursors', () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    appendBackgroundAgentChunk(job.jobId, {
      type: 'text',
      payload: 'first',
      timestamp: 1,
    })

    for (let index = 0; index < 40; index++) {
      readBackgroundAgentChunks({
        job,
        consumerId: `consumer-${index}`,
        cursor: index === 39 ? Number.MAX_SAFE_INTEGER : undefined,
      })
    }
    expect(job.consumerCursors.size).toBeLessThanOrEqual(32)

    appendBackgroundAgentChunk(job.jobId, {
      type: 'text',
      payload: 'second',
      timestamp: 2,
    })
    const next = readBackgroundAgentChunks({
      job,
      consumerId: 'consumer-39',
    })
    expect(next.chunks.map((chunk) => chunk.payload)).toEqual(['second'])
    expect(next.nextCursor).toBe(2)
  })

  test('tracks ownership and enforces the per-root running quota', () => {
    const owner = {
      clientSessionId: 'session-1',
      rootRunId: 'root-1',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      userInputId: 'input-1',
    }
    const jobs = Array.from({ length: 8 }, (_, index) =>
      allocateBackgroundAgentJob({
        agentType: 'basher',
        agentName: `Basher ${index}`,
        owner,
      }),
    )

    expect(backgroundAgentJobOwnedBy(jobs[0], owner)).toBe(true)
    expect(
      backgroundAgentJobOwnedBy(jobs[0], {
        clientSessionId: owner.clientSessionId,
        rootRunId: 'another-root',
      }),
    ).toBe(false)
    expect(() =>
      allocateBackgroundAgentJob({
        agentType: 'basher',
        agentName: 'One too many',
        owner,
      }),
    ).toThrow('concurrency limit reached for this run (8)')
  })

  test('assertBackgroundAgentJobOwned returns the core tri-state for a settled job', async () => {
    const owner = {
      clientSessionId: 'session-settled',
      rootRunId: 'root-settled',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      userInputId: 'input-settled',
    }
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      owner,
    })
    await settleBackgroundAgentJob(job, { output: 'settled' })
    expect(job.status).toBe('completed')

    expect(assertBackgroundAgentJobOwned(job.jobId, owner).ok).toBe(true)
    expect(getBackgroundAgentJob(job.jobId)?.result).toEqual({
      output: 'settled',
    })
    expect(
      assertBackgroundAgentJobOwned(job.jobId, {
        clientSessionId: owner.clientSessionId,
        rootRunId: 'another-root',
      }),
    ).toMatchObject({ ok: false, reason: 'foreign' })

    // Only an id the core itself no longer knows about is not_found.
    expect(
      assertBackgroundAgentJobOwned('bg-agent-job-never-allocated', owner),
    ).toMatchObject({ ok: false, reason: 'not_found' })
  })

  test('a count-cap-evicted settled job stays owned and still reports its core state and result', async () => {
    const owner = {
      clientSessionId: 'session-evicted',
      rootRunId: 'root-evicted',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      userInputId: 'input-evicted',
    }
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      owner,
    })
    await settleBackgroundAgentJob(job, { output: 'survives-eviction' })

    await fillPastBackgroundAgentJobCountCap(owner)

    // The oldest settled adapter view was evicted by the count cap...
    expect(getBackgroundAgentJob(job.jobId)).toBeUndefined()
    // ...but the core record is the durable home of both the lifecycle state
    // and the settled result, so a parent polling after eviction is still
    // authorized and still sees the child's result.
    expect(assertBackgroundAgentJobOwned(job.jobId, owner).ok).toBe(true)
    const coreJob = getBackgroundAgentJobCore(job.jobId)
    expect(coreJob?.state).toBe('completed')
    expect(coreJob?.result).toEqual({ output: 'survives-eviction' })
  })

  test('the count-cap sweep never evicts a non-terminal job, so it stays cancellable', async () => {
    const owner = {
      clientSessionId: 'session-cancellable',
      rootRunId: 'root-cancellable',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      userInputId: 'input-cancellable',
    }
    const running = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      owner,
    })
    // A coroutine that never settles keeps the core state non-terminal.
    attachBackgroundAgentPromise(running, new Promise(() => {}))

    await fillPastBackgroundAgentJobCountCap(owner)

    // The view owns this job's AbortController, so the sweep must keep it...
    expect(getBackgroundAgentJob(running.jobId)).toBe(running)
    expect(running.status).toBe('running')
    // ...and cancellation can still reach the coroutine.
    expect(cancelBackgroundAgentJob(running.jobId)).toEqual({
      cancelled: true,
      status: 'cancelled',
    })
    expect(running.abortController.signal.aborted).toBe(true)
  })

  test('cancelBackgroundAgentJob aborts a running coroutine and preserves cancelled status', async () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    let rejectPromise!: (reason: unknown) => void
    attachBackgroundAgentPromise(
      job,
      new Promise((_resolve, reject) => {
        rejectPromise = reject
      }),
    )
    const result = cancelBackgroundAgentJob(job.jobId)
    expect(result).toEqual({ cancelled: true, status: 'cancelled' })
    expect(job.abortController.signal.aborted).toBe(true)
    rejectPromise(new Error('aborted'))
    await Promise.resolve()
    expect(job.status).toBe('cancelled')
  })

  test('a pre-allocated jobId is available before the promise attaches', () => {
    // Validates the temporal-dead-zone fix: the chunk handler can reference
    // job.jobId synchronously before attachBackgroundAgentPromise is called.
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    const capturedId = job.jobId
    // Simulate a synchronous onResponseChunk firing before the promise exists.
    appendBackgroundAgentChunk(capturedId, {
      type: 'text',
      payload: 'early',
      timestamp: 0,
    })
    // Now attach the coroutine.
    attachBackgroundAgentPromise(job, Promise.resolve('ok'))
    expect(job.chunks.length).toBe(1)
    expect(job.chunks[0]!.payload).toBe('early')
  })

  test('reconcileInterruptedBackgroundAgentIntents only reconciles running intents whose job is gone', () => {
    const { mainAgentState } = getInitialSessionState(mockFileContext)
    const live = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    mainAgentState.backgroundAgentJobs = [
      {
        jobId: live.jobId,
        agentType: 'basher',
        status: 'running',
        startedAt: live.startedAt,
      },
      {
        jobId: 'bg-agent-job-gone',
        agentType: 'researcher',
        status: 'running',
        startedAt: 1,
      },
      {
        jobId: 'bg-agent-job-already-settled',
        agentType: 'researcher',
        status: 'completed',
        startedAt: 2,
        completedAt: 3,
      },
    ]

    reconcileInterruptedBackgroundAgentIntents(mainAgentState)
    // Idempotent: a second pass within the same turn changes nothing.
    reconcileInterruptedBackgroundAgentIntents(mainAgentState)

    const intents = mainAgentState.backgroundAgentJobs!
    // Intents are reconciled, never dropped.
    expect(intents).toHaveLength(3)
    expect(intents[0]!.status).toBe('running')
    expect(intents[1]).toMatchObject({
      status: 'interrupted',
      error: INTERRUPTED_INTENT_MESSAGE,
    })
    expect(typeof intents[1]!.completedAt).toBe('number')
    expect(intents[2]).toMatchObject({ status: 'completed', completedAt: 3 })
  })

  test('shell process jobs do not consume the background-agent concurrency budget', () => {
    const owner = {
      clientSessionId: 'session-kinds',
      rootRunId: 'root-kinds',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      userInputId: 'input-kinds',
    }
    // Dev servers / watchers / tails share the process-wide registry. They are
    // bounded separately, so they must not fill the background-AGENT quotas
    // (8 per root, 32 total) and block every background agent spawn for a run.
    for (let index = 0; index < 40; index++) {
      seedRunningProcessJob(owner, `dev-server-${index}`)
    }

    expect(() =>
      assertBackgroundAgentCapacity({ additional: 1, owner }),
    ).not.toThrow()
    expect(listRunningBackgroundAgentJobs(owner)).toEqual([])

    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      owner,
    })
    expect(listRunningBackgroundAgentJobs(owner).map((j) => j.jobId)).toEqual([
      job.jobId,
    ])
  })

  test('the view count cap is evaluated over adapter views, not the whole registry', async () => {
    const owner = {
      clientSessionId: 'session-view-cap',
      rootRunId: 'root-view-cap',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      userInputId: 'input-view-cap',
    }
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      owner,
    })
    await settleBackgroundAgentJob(job, { output: 'kept' })

    // Far more process jobs than the 100-view bound: counting them would evict
    // this settled agent view even though the adapter retains only one.
    for (let index = 0; index < 120; index++) {
      seedSettledProcessJob(owner, `tail-${index}`)
    }

    expect(getBackgroundAgentJob(job.jobId)).toBe(job)
    expect(getBackgroundAgentJob(job.jobId)?.result).toEqual({ output: 'kept' })
  })

  test('cancelBackgroundAgentJob is an idempotent no-op for an already-settled job', async () => {
    const owner = {
      clientSessionId: 'session-idempotent-cancel',
      rootRunId: 'root-idempotent-cancel',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      userInputId: 'input-idempotent-cancel',
    }
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      owner,
    })
    await settleBackgroundAgentJob(job, { output: 'settled' })

    // Not an error: the caller's poll must still be able to report the settled
    // state/events/result instead of an error-only payload.
    expect(cancelBackgroundAgentJob(job.jobId)).toEqual({
      cancelled: false,
      status: 'completed',
    })

    await fillPastBackgroundAgentJobCountCap(owner)
    expect(getBackgroundAgentJob(job.jobId)).toBeUndefined()
    // Only SETTLED views are ever evicted, so a view-less known id is settled
    // work — reporting not_found here would contradict that invariant.
    expect(cancelBackgroundAgentJob(job.jobId)).toEqual({
      cancelled: false,
      status: 'completed',
    })
    expect(cancelBackgroundAgentJob('bg-agent-job-never-allocated')).toEqual({
      errorMessage:
        'No background agent job found with id "bg-agent-job-never-allocated".',
    })
  })

  test('abandonPreLaunchBackgroundAgentJob releases a stranded pre-launch job', () => {
    const owner = {
      clientSessionId: 'session-abandon',
      rootRunId: 'root-abandon',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      userInputId: 'input-abandon',
    }
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      owner,
    })
    const reason = 'spawn failed before launch'
    abandonPreLaunchBackgroundAgentJob(job, reason)

    expect(getBackgroundAgentJob(job.jobId)).toBeUndefined()
    expect(getBackgroundAgentJobCore(job.jobId)?.state).toBe('error')
    expect(getBackgroundAgentJobCore(job.jobId)?.error).toBe(reason)
    expect(listRunningBackgroundAgentJobs(owner)).toEqual([])
    expect(() =>
      assertBackgroundAgentCapacity({ additional: 1, owner }),
    ).not.toThrow()
  })

  test('backgroundAgentJobWasCancelled distinguishes explicit cancel from running', () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    attachBackgroundAgentPromise(job, new Promise(() => {}))
    expect(backgroundAgentJobWasCancelled(job)).toBe(false)

    expect(cancelBackgroundAgentJob(job.jobId)).toEqual({
      cancelled: true,
      status: 'cancelled',
    })
    expect(backgroundAgentJobWasCancelled(job)).toBe(true)

    const fresh = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
    })
    attachBackgroundAgentPromise(fresh, new Promise(() => {}))
    expect(backgroundAgentJobWasCancelled(fresh)).toBe(false)
  })
})

describe('check_background_agent join semantics', () => {
  const POLL_OWNER: BackgroundAgentJobOwner = {
    clientSessionId: 'session-poll',
    // handleCheckBackgroundAgent derives rootRunId from the agent state, whose
    // initial shape has no ancestors/runId, so it resolves to the agent id.
    rootRunId: 'main-agent',
    parentRunId: 'main-agent',
    parentAgentId: 'main-agent',
    userInputId: 'input-poll',
  }

  function startCheckBackgroundAgent(
    input: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const { mainAgentState } = getInitialSessionState(mockFileContext)
    return handleCheckBackgroundAgent({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'check_background_agent',
        toolCallId: 'poll-background-agent',
        input,
      },
      agentState: mainAgentState,
      clientSessionId: POLL_OWNER.clientSessionId,
      signal: options.signal ?? new AbortController().signal,
    } as unknown as Parameters<typeof handleCheckBackgroundAgent>[0]).then(
      ({ output }) => readJsonToolValue(output),
    )
  }

  beforeEach(() => {
    __clearBackgroundAgentJobsForTest()
  })

  afterEach(() => {
    mock.restore()
  })

  test('follow mode always resolves a finite deadline, capped at the documented maximum', () => {
    // `wait_for` with no timeout used to await the registry with NO deadline,
    // which could block the agent turn for the whole run.
    expect(
      resolveCheckBackgroundAgentWaitBounds({ waitFor: 'milestone' }),
    ).toEqual({
      follow: true,
      timeoutMs: DEFAULT_CHECK_BACKGROUND_AGENT_FOLLOW_TIMEOUT_MS,
    })
    // Poll mode (documented `timeout_seconds: 0`) still returns immediately.
    expect(
      resolveCheckBackgroundAgentWaitBounds({ timeoutSeconds: 0 }),
    ).toEqual({
      follow: false,
      timeoutMs: DEFAULT_CHECK_BACKGROUND_AGENT_FOLLOW_TIMEOUT_MS,
    })
    expect(
      resolveCheckBackgroundAgentWaitBounds({ timeoutSeconds: 5 }),
    ).toEqual({ follow: true, timeoutMs: 5_000 })
    // A non-finite or negative value is treated as omitted rather than as
    // "no deadline".
    for (const timeoutSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(
        resolveCheckBackgroundAgentWaitBounds({
          waitFor: 'milestone',
          timeoutSeconds,
        }),
      ).toEqual({
        follow: true,
        timeoutMs: DEFAULT_CHECK_BACKGROUND_AGENT_FOLLOW_TIMEOUT_MS,
      })
    }
    expect(
      resolveCheckBackgroundAgentWaitBounds({ timeoutSeconds: 100_000 }),
    ).toEqual({
      follow: true,
      timeoutMs: MAX_CHECK_BACKGROUND_AGENT_FOLLOW_TIMEOUT_MS,
    })
  })

  test('a follow-mode wait without an explicit timeout still returns a bounded result', async () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      owner: POLL_OWNER,
    })
    let settleCoroutine!: (value: unknown) => void
    attachBackgroundAgentPromise(
      job,
      new Promise((resolve) => {
        settleCoroutine = resolve
      }),
    )

    // No timeout_seconds: the handler must still hand the registry a deadline,
    // so this join resolves as soon as the job settles rather than hanging.
    const pending = startCheckBackgroundAgent({
      jobId: job.jobId,
      wait_for: 'never-appears',
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    settleCoroutine({ output: 'done' })

    expect(await pending).toMatchObject({
      jobId: job.jobId,
      state: 'completed',
      matched: false,
    })
  })

  test('an aborted turn settles a follow-mode wait instead of holding the turn open', async () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      owner: POLL_OWNER,
    })
    attachBackgroundAgentPromise(job, new Promise(() => {}))
    const controller = new AbortController()

    const pending = startCheckBackgroundAgent(
      { jobId: job.jobId, wait_for: 'never-appears', timeout_seconds: 600 },
      { signal: controller.signal },
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()

    expect(await pending).toMatchObject({
      jobId: job.jobId,
      state: 'running',
      timedOut: true,
    })
  })

  test('a cursor past the latest sequence does not strand a follow-mode wait', async () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      owner: POLL_OWNER,
    })
    let settleCoroutine!: (value: unknown) => void
    attachBackgroundAgentPromise(
      job,
      new Promise((resolve) => {
        settleCoroutine = resolve
      }),
    )

    // Unclamped, this cursor makes the terminal transition fail the
    // `sequence > cursor` test, so the wait could only end by timing out.
    const pending = startCheckBackgroundAgent({
      jobId: job.jobId,
      wait_for: 'never-appears',
      timeout_seconds: 5,
      cursor: 10_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    settleCoroutine({ output: 'done' })

    const value = await pending
    // Events are lifecycle(queued)=1, lifecycle(running)=2, completed=3, so the
    // clamped wait reports the terminal sequence instead of the bogus cursor.
    expect(value).toMatchObject({
      jobId: job.jobId,
      state: 'completed',
      nextCursor: 3,
    })
    expect(value.timedOut).toBeUndefined()
  })

  test('a repeated cancel poll on a settled job still returns its state, events, and result', async () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      owner: POLL_OWNER,
    })
    appendBackgroundAgentChunk(job.jobId, {
      type: 'text',
      payload: 'progress',
      timestamp: 1,
    })
    await settleBackgroundAgentJob(job, { output: 'settled' })

    const value = await startCheckBackgroundAgent({
      jobId: job.jobId,
      cancel: true,
    })

    expect(value).not.toHaveProperty('errorMessage')
    expect(value).toMatchObject({
      jobId: job.jobId,
      state: 'completed',
      result: { output: 'settled' },
    })
    expect(Array.isArray(value.events)).toBe(true)
    // A no-op cancel must not relabel an already-completed job as cancelled.
    expect(value.cancelled).toBeUndefined()
  })

  test('a cancel poll on a count-cap-evicted settled job reports the settled job instead of not_found', async () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      owner: POLL_OWNER,
    })
    await settleBackgroundAgentJob(job, { output: 'survives-eviction' })
    await fillPastBackgroundAgentJobCountCap(POLL_OWNER)
    expect(getBackgroundAgentJob(job.jobId)).toBeUndefined()

    const value = await startCheckBackgroundAgent({
      jobId: job.jobId,
      cancel: true,
    })

    expect(value).not.toHaveProperty('errorMessage')
    expect(value).toMatchObject({
      jobId: job.jobId,
      state: 'completed',
      result: { output: 'survives-eviction' },
    })
  })

  test('reports not_found only for an id the core never knew', async () => {
    expect(
      await startCheckBackgroundAgent({
        jobId: 'bg-agent-job-never-allocated',
      }),
    ).toEqual({
      jobId: 'bg-agent-job-never-allocated',
      errorMessage:
        'No background agent job found with id "bg-agent-job-never-allocated".',
    })
  })

  test('cursorless polls return only chunks since the last poll', async () => {
    const job = allocateBackgroundAgentJob({
      agentType: 'basher',
      agentName: 'Basher',
      owner: POLL_OWNER,
    })
    attachBackgroundAgentPromise(job, new Promise(() => {}))
    appendBackgroundAgentChunk(job.jobId, {
      type: 'text',
      payload: 'chunk-A',
      timestamp: 1,
    })

    const first = await startCheckBackgroundAgent({ jobId: job.jobId })
    expect(JSON.stringify(first.events)).toContain('chunk-A')
    expect(first.truncated).toBe(false)
    const firstCursor = first.nextCursor as number

    appendBackgroundAgentChunk(job.jobId, {
      type: 'text',
      payload: 'chunk-B',
      timestamp: 2,
    })

    const second = await startCheckBackgroundAgent({ jobId: job.jobId })
    expect(JSON.stringify(second.events)).toContain('chunk-B')
    expect(JSON.stringify(second.events)).not.toContain('chunk-A')
    expect(second.nextCursor as number).toBeGreaterThan(firstCursor)
    expect(second.truncated).toBe(false)
  })
})

describe('spawn_agents background intent reconciliation', () => {
  let baseParams: ParamsExcluding<
    typeof handleSpawnAgents,
    'agentState' | 'agentTemplate' | 'localAgentTemplates' | 'toolCall'
  >

  const createMockAgent = (
    id: string,
    spawnableAgents: string[] = [],
  ): AgentTemplate => ({
    id,
    displayName: `Mock ${id}`,
    outputMode: 'last_message' as const,
    inputSchema: {
      prompt: {
        safeParse: () => ({ success: true }),
      } as unknown as AgentTemplate['inputSchema']['prompt'],
    },
    spawnerPrompt: '',
    model: '',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: [],
    spawnableAgents,
    systemPrompt: '',
    instructionsPrompt: '',
    stepPrompt: '',
  })

  beforeEach(() => {
    __clearBackgroundAgentJobsForTest()
    baseParams = {
      ...TEST_AGENT_RUNTIME_IMPL,
      ancestorRunIds: [],
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      previousToolCallFinished: Promise.resolve(),
      repoId: undefined,
      repoUrl: undefined,
      sendSubagentChunk: mock(() => {}),
      signal: new AbortController().signal,
      system: 'Test system prompt',
      userId: TEST_USER_ID,
      userInputId: 'test-input',
      writeToClient: () => {},
    }
    spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(
      async (options) => ({
        agentState: {
          ...options.agentState,
          messageHistory: [assistantMessage('Mock agent response')],
        },
        output: {
          type: 'lastMessage',
          value: [assistantMessage('Mock agent response')],
        },
      }),
    )
  })

  afterEach(() => {
    mock.restore()
  })

  test('a background spawn succeeds when the parent still lists running intents whose jobs are gone', async () => {
    const parentAgent = createMockAgent('parent', ['thinker'])
    const childAgent = createMockAgent('thinker')
    const { mainAgentState } = getInitialSessionState(mockFileContext)
    // The whole per-root background budget is consumed by intents whose jobs no
    // longer exist (settled + count-cap evicted, or from a previous session).
    mainAgentState.backgroundAgentJobs = Array.from(
      { length: 8 },
      (_, index) => ({
        jobId: `bg-agent-job-gone-${index}`,
        agentType: 'researcher',
        status: 'running' as const,
        startedAt: index,
      }),
    )

    const { output } = await handleSpawnAgents({
      ...baseParams,
      agentState: mainAgentState,
      agentTemplate: parentAgent,
      localAgentTemplates: { thinker: childAgent },
      toolCall: {
        toolName: 'spawn_agents',
        toolCallId: 'spawn-background-after-eviction',
        input: {
          agents: [
            { agent_type: 'thinker', prompt: 'background', background: true },
          ],
        },
      },
    })

    const intents = mainAgentState.backgroundAgentJobs ?? []
    // The stale intents were reconciled (not dropped), freeing the budget, and
    // the newly launched job was appended.
    expect(intents).toHaveLength(9)
    expect(intents.slice(0, 8).map((intent) => intent.status)).toEqual(
      Array.from({ length: 8 }, () => 'interrupted'),
    )
    expect(intents[0]!.error).toBe(INTERRUPTED_INTENT_MESSAGE)
    expect(typeof intents[0]!.completedAt).toBe('number')

    const newJobId = intents[8]!.jobId
    expect(newJobId).toMatch(/^bg-agent-/)
    expect(output[0]?.type).toBe('json')
    expect(JSON.stringify(output)).toContain('"background":true')
    expect(JSON.stringify(output)).toContain(newJobId)
  })

  test('a rejected background batch terminates the spawn_started events it already emitted', async () => {
    const parentAgent = createMockAgent('parent', ['thinker'])
    const childAgent = createMockAgent('thinker')
    const { mainAgentState } = getInitialSessionState(mockFileContext)
    // Saturate the per-root background-agent quota with REAL running jobs so
    // the batch allocation throws AFTER spawn_started was already emitted.
    const owner = {
      clientSessionId: 'test-session',
      rootRunId: mainAgentState.agentId,
      parentRunId: mainAgentState.agentId,
      parentAgentId: mainAgentState.agentId,
      userInputId: 'test-input',
    }
    for (let index = 0; index < 8; index++) {
      allocateBackgroundAgentJob({
        agentType: 'researcher',
        agentName: `Researcher ${index}`,
        owner,
      })
    }

    await expect(
      handleSpawnAgents({
        ...baseParams,
        agentState: mainAgentState,
        agentTemplate: parentAgent,
        localAgentTemplates: { thinker: childAgent },
        toolCall: {
          toolName: 'spawn_agents',
          toolCallId: 'spawn-background-over-quota',
          input: {
            agents: [
              { agent_type: 'thinker', prompt: 'background', background: true },
            ],
          },
        },
      }),
    ).rejects.toThrow('concurrency limit reached for this run (8)')

    const events = mainAgentState.orchestrationLedger?.events ?? []
    const startedSpawnIds = events.flatMap((event) =>
      event.type === 'spawn_started' ? [event.spawnId] : [],
    )
    const interruptedSpawnIds = events.flatMap((event) =>
      event.type === 'interrupted' && event.subjectType === 'spawn'
        ? [event.subjectId]
        : [],
    )

    expect(startedSpawnIds).toHaveLength(1)
    // The rollback must settle the emitted spawn, or the ledger keeps reporting
    // a spawn that never launched as in-flight for the rest of the turn.
    expect(interruptedSpawnIds).toEqual(startedSpawnIds)
    expect(
      mainAgentState.workspacePathLeases?.filter(
        (lease) => lease.status === 'active',
      ) ?? [],
    ).toHaveLength(0)
  })
})
