import { describe, expect, it } from 'bun:test'

import {
  JobRegistry,
  UNKNOWN_JOB_OWNER,
} from '@codebuff/common/util/job-registry'

import { createJobUpdateForwarder } from '../job-update-forwarder'

import type { JobOwner } from '@codebuff/common/util/job-registry'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

/**
 * These tests exercise the run-loop subscription/forwarding closure against a
 * real JobRegistry with a stub handleEvent and the same guard flags run.ts
 * threads (`callbacksEnabled`, `runSignal.aborted`), rather than wiring a full
 * run. The closure under test is the imported production
 * `createJobUpdateForwarder` (see `sdk/src/job-update-forwarder.ts`), not a
 * re-implementation, so the owner-scoping + payload-mapping contract is pinned
 * against the same code run.ts uses.
 */

type RunOwner = { clientSessionId: string; rootRunId: string }

/**
 * Adapter that mirrors the previous local `attachJobForwarding` call sites:
 * subscribes the imported production forwarder to the registry with the same
 * owner scope and mutable guard flags the tests toggle.
 */
function attachJobForwarding(params: {
  registry: JobRegistry
  runOwner: RunOwner
  handleEvent: (event: PrintModeEvent) => void | Promise<void>
  guards: { callbacksEnabled: boolean; aborted: boolean }
}): () => void {
  const { registry, runOwner, handleEvent, guards } = params
  return registry.subscribeAll(
    createJobUpdateForwarder({
      owner: runOwner,
      handleEvent,
      shouldForward: () => guards.callbacksEnabled && !guards.aborted,
    }),
  )
}

const OWNER: JobOwner = {
  clientSessionId: 'run-session',
  rootRunId: 'run-root',
  parentRunId: 'run-root',
  parentAgentId: 'main-agent',
}
const FOREIGN: JobOwner = {
  clientSessionId: 'other-session',
  rootRunId: 'other-root',
  parentRunId: 'other-root',
  parentAgentId: 'other-agent',
}

describe('run job_update forwarding', () => {
  it('forwards lifecycle + output job_update events for the run-owned session', async () => {
    const registry = new JobRegistry()
    const events: Extract<PrintModeEvent, { type: 'job_update' }>[] = []
    const guards = { callbacksEnabled: true, aborted: false }
    const dispose = attachJobForwarding({
      registry,
      runOwner: { clientSessionId: OWNER.clientSessionId, rootRunId: OWNER.rootRunId },
      handleEvent: (event) => {
        if (event.type === 'job_update') events.push(event)
      },
      guards,
    })

    const job = registry.create({ kind: 'process', label: 'echo hi', owner: OWNER })
    registry.start(job.jobId)
    registry.emit(job.jobId, { type: 'output', data: 'hello' })
    registry.emit(job.jobId, { type: 'lifecycle', state: 'completed', exitCode: 0 })
    await Promise.resolve()

    expect(events.map((e) => e.state)).toEqual([
      'queued',
      'running',
      'running',
      'completed',
    ])
    const output = events.find((e) => e.outputDelta !== undefined)
    expect(output?.outputDelta).toBe('hello')
    expect(events.every((e) => e.jobId === job.jobId)).toBe(true)
    expect(events.at(-1)?.exitCode).toBe(0)
    dispose()
  })

  it('does NOT forward jobs owned by a different clientSessionId', async () => {
    const registry = new JobRegistry()
    const events: PrintModeEvent[] = []
    attachJobForwarding({
      registry,
      runOwner: { clientSessionId: OWNER.clientSessionId, rootRunId: OWNER.rootRunId },
      handleEvent: (event) => {
        events.push(event)
      },
      guards: { callbacksEnabled: true, aborted: false },
    })

    const job = registry.create({ kind: 'process', label: 'foreign', owner: FOREIGN })
    registry.start(job.jobId)
    registry.emit(job.jobId, { type: 'output', data: 'leak?' })
    await Promise.resolve()

    expect(events).toEqual([])
  })

  it('does NOT forward UNKNOWN_JOB_OWNER jobs (unattributable)', async () => {
    const registry = new JobRegistry()
    const events: PrintModeEvent[] = []
    attachJobForwarding({
      registry,
      runOwner: { clientSessionId: OWNER.clientSessionId, rootRunId: OWNER.rootRunId },
      handleEvent: (event) => {
        events.push(event)
      },
      guards: { callbacksEnabled: true, aborted: false },
    })

    const job = registry.create({
      kind: 'process',
      label: 'unknown',
      owner: UNKNOWN_JOB_OWNER,
    })
    registry.start(job.jobId)
    registry.emit(job.jobId, { type: 'output', data: 'unattributable' })
    await Promise.resolve()

    expect(events).toEqual([])
  })

  it('forwards nothing after the subscription is disposed on run teardown', async () => {
    const registry = new JobRegistry()
    const events: PrintModeEvent[] = []
    const dispose = attachJobForwarding({
      registry,
      runOwner: { clientSessionId: OWNER.clientSessionId, rootRunId: OWNER.rootRunId },
      handleEvent: (event) => {
        events.push(event)
      },
      guards: { callbacksEnabled: true, aborted: false },
    })

    const job = registry.create({ kind: 'process', label: 'teardown', owner: OWNER })
    dispose()
    registry.start(job.jobId)
    registry.emit(job.jobId, { type: 'output', data: 'after-teardown' })
    await Promise.resolve()

    // Only the create(queued) event fired before disposal.
    expect(events.map((e) => (e.type === 'job_update' ? e.state : e.type))).toEqual([
      'queued',
    ])
  })

  it('ignores agent_chunk/status payloads (M5 forwards state + process output only)', async () => {
    const registry = new JobRegistry()
    const events: Extract<PrintModeEvent, { type: 'job_update' }>[] = []
    attachJobForwarding({
      registry,
      runOwner: { clientSessionId: OWNER.clientSessionId, rootRunId: OWNER.rootRunId },
      handleEvent: (event) => {
        if (event.type === 'job_update') events.push(event)
      },
      guards: { callbacksEnabled: true, aborted: false },
    })

    const job = registry.create({ kind: 'agent', label: 'agent', owner: OWNER })
    registry.start(job.jobId)
    registry.emit(job.jobId, { type: 'agent_chunk', chunkType: 'text', data: 'chunk' })
    registry.emit(job.jobId, { type: 'status', message: 'thinking' })
    await Promise.resolve()

    // Only the queued + running lifecycle updates; no chunk/status forwarded.
    expect(events.map((e) => e.state)).toEqual(['queued', 'running'])
  })

  it('respects the callbacksEnabled/aborted guards', async () => {
    const registry = new JobRegistry()
    const events: PrintModeEvent[] = []
    const guards = { callbacksEnabled: false, aborted: false }
    attachJobForwarding({
      registry,
      runOwner: { clientSessionId: OWNER.clientSessionId, rootRunId: OWNER.rootRunId },
      handleEvent: (event) => {
        events.push(event)
      },
      guards,
    })

    const job = registry.create({ kind: 'process', label: 'guarded', owner: OWNER })
    registry.start(job.jobId)
    await Promise.resolve()
    expect(events).toEqual([])

    guards.callbacksEnabled = true
    guards.aborted = true
    registry.emit(job.jobId, { type: 'output', data: 'still-guarded' })
    await Promise.resolve()
    expect(events).toEqual([])
  })
})
