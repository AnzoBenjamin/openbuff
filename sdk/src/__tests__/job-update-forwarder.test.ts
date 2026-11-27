import { describe, expect, it } from 'bun:test'

import { createJobUpdateForwarder } from '../job-update-forwarder'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { Job, JobEvent } from '@codebuff/common/util/job-registry'

const owner = {
  clientSessionId: 'session-1',
  rootRunId: 'run-1',
  parentRunId: 'parent-run',
  parentAgentId: 'agent-1',
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    jobId: 'job-1',
    kind: 'agent',
    state: 'running',
    label: 'Background work',
    owner,
    ...overrides,
  } as Job
}

function makeEvent(sequence: number, payload: unknown): JobEvent {
  return { sequence, payload } as JobEvent
}

describe('createJobUpdateForwarder', () => {
  it('forwards owned lifecycle and summarized output while bounding deltas', () => {
    const events: PrintModeEvent[] = []
    const forward = createJobUpdateForwarder({
      owner,
      handleEvent: (event) => {
        events.push(event)
      },
      shouldForward: () => true,
    })
    const longOutput = `prefix:${'x'.repeat(2_500)}:tail`

    forward(makeJob(), makeEvent(1, { type: 'lifecycle' }))
    forward(makeJob(), makeEvent(2, { type: 'output', data: longOutput }))
    forward(
      makeJob(),
      makeEvent(3, {
        type: 'agent_chunk',
        chunkType: 'tool_call',
        data: { toolName: 'read_files', args: { secret: 'not forwarded' } },
      }),
    )
    forward(
      makeJob({ state: 'completed', exitCode: 0 }),
      makeEvent(4, { type: 'lifecycle' }),
    )

    expect(events).toHaveLength(4)
    expect(events[0]).toMatchObject({
      type: 'job_update',
      sequence: 1,
      state: 'running',
    })
    expect(events[0]).not.toHaveProperty('outputDelta')
    expect(events[1]).toMatchObject({
      sequence: 2,
      outputDelta: longOutput.slice(-2_000),
    })
    expect(events[2]).toMatchObject({
      sequence: 3,
      outputDelta: '[tool_call:read_files]',
    })
    expect(JSON.stringify(events[2])).not.toContain('not forwarded')
    expect(events[3]).toMatchObject({
      sequence: 4,
      state: 'completed',
      exitCode: 0,
    })
  })

  it('ignores foreign job owners and stops forwarding when disabled', () => {
    const events: PrintModeEvent[] = []
    let enabled = true
    const forward = createJobUpdateForwarder({
      owner,
      handleEvent: (event) => {
        events.push(event)
      },
      shouldForward: () => enabled,
    })
    const lifecycle = makeEvent(1, { type: 'lifecycle' })

    forward(makeJob({ owner: { ...owner, rootRunId: 'other-run' } }), lifecycle)
    forward(
      makeJob({ owner: { ...owner, clientSessionId: 'other-session' } }),
      lifecycle,
    )
    enabled = false
    forward(makeJob(), lifecycle)

    expect(events).toEqual([])
  })
})
