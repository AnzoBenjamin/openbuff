import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  __clearJobRegistryForTest,
  AGENT_JOB_EVENT_BUFFER_LIMIT,
  AGENT_JOB_SETTLED_TTL_MS,
  JobRegistry,
  jobRegistry,
  reduceJobState,
  TERMINAL_STATES,
} from '../job-registry'

import type {
  Job,
  JobEvent,
  JobEventPayload,
  JobOwner,
  JobState,
} from '../job-registry'

const OWNER_A: JobOwner = {
  clientSessionId: 'session-a',
  rootRunId: 'run-a',
  parentRunId: 'parent-run-a',
  parentAgentId: 'agent-a',
}
const OWNER_B: JobOwner = {
  clientSessionId: 'session-b',
  rootRunId: 'run-b',
  parentRunId: 'parent-run-b',
  parentAgentId: 'agent-b',
}

type LifecyclePayload = Extract<JobEventPayload, { type: 'lifecycle' }>

// Payload constructors: single place to adapt if the real payload shapes
// differ slightly from the contract sketched in the module docs.
const out = (data: string): JobEventPayload => ({ type: 'output', data })
const agentChunk = (text: string): JobEventPayload => ({
  type: 'agent_chunk',
  chunkType: 'text',
  data: text,
})
const lifecycle = (state: JobState): LifecyclePayload => ({
  type: 'lifecycle',
  state,
})

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

function outputData(events: JobEvent[]): string[] {
  return events.flatMap((event) =>
    event.payload.type === 'output' ? [event.payload.data] : [],
  )
}

function lifecycleStates(events: JobEvent[]): JobState[] {
  return events.flatMap((event) =>
    event.payload.type === 'lifecycle' ? [event.payload.state] : [],
  )
}

function expectContiguousSequences(events: JobEvent[]): void {
  for (let i = 1; i < events.length; i++) {
    expect(events[i].sequence).toBe(events[i - 1].sequence + 1)
  }
}

async function collect(stream: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const events: JobEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

function createRunningJob(owner: JobOwner = OWNER_A, label = 'job') {
  const job = jobRegistry.create({ kind: 'process', label, owner })
  jobRegistry.start(job.jobId)
  return job
}

describe('jobRegistry', () => {
  beforeEach(() => {
    __clearJobRegistryForTest()
  })

  afterEach(() => {
    __clearJobRegistryForTest()
  })

  describe('TERMINAL_STATES', () => {
    it('contains exactly the settled states', () => {
      expect([...TERMINAL_STATES].sort()).toEqual([
        'cancelled',
        'completed',
        'error',
        'lost',
        'stopped',
      ])
    })
  })

  describe('reduceJobState', () => {
    const legalTransitions: Array<[JobState, JobState]> = [
      ['queued', 'running'],
      ['running', 'stopping'],
      ['running', 'completed'],
      ['running', 'error'],
      ['running', 'stopped'],
      ['running', 'lost'],
      ['running', 'cancelled'],
      ['stopping', 'completed'],
      ['stopping', 'error'],
      ['stopping', 'stopped'],
      ['stopping', 'lost'],
      ['stopping', 'cancelled'],
    ]

    for (const [from, to] of legalTransitions) {
      it(`allows ${from} -> ${to}`, () => {
        expect(reduceJobState(from, lifecycle(to))).toBe(to)
      })
    }

    const terminalStates: JobState[] = [
      'completed',
      'error',
      'stopped',
      'lost',
      'cancelled',
    ]

    for (const terminal of terminalStates) {
      it(`rejects every transition out of terminal state ${terminal}`, () => {
        const targets: JobState[] = [
          'queued',
          'running',
          'stopping',
          'completed',
          'error',
          'stopped',
          'lost',
          'cancelled',
        ]
        for (const target of targets) {
          expect(reduceJobState(terminal, lifecycle(target))).toBeNull()
        }
      })
    }

    it('is pure: stable across calls and does not mutate the lifecycle payload', () => {
      const event = lifecycle('completed')

      expect(reduceJobState('running', event)).toBe('completed')
      expect(reduceJobState('running', event)).toBe('completed')
      expect(event).toEqual({ type: 'lifecycle', state: 'completed' })
    })

    it('does not touch registry state', () => {
      const job = jobRegistry.create({
        kind: 'process',
        label: 'pure',
        owner: OWNER_A,
      })

      reduceJobState('running', lifecycle('completed'))

      expect(jobRegistry.get(job.jobId)?.state).toBe('queued')
    })
  })

  describe('create/get/list', () => {
    it('creates a queued job with the given kind, label, and owner', () => {
      const job = jobRegistry.create({
        kind: 'agent',
        label: 'my-agent',
        owner: OWNER_A,
      })

      expect(typeof job.jobId).toBe('string')
      expect(job.jobId.length).toBeGreaterThan(0)
      expect(job.kind).toBe('agent')
      expect(job.label).toBe('my-agent')
      expect(job.owner).toEqual(OWNER_A)
      expect(job.state).toBe('queued')
    })

    it('assigns unique ids across jobs', () => {
      const a = jobRegistry.create({
        kind: 'process',
        label: 'a',
        owner: OWNER_A,
      })
      const b = jobRegistry.create({
        kind: 'process',
        label: 'b',
        owner: OWNER_A,
      })

      expect(a.jobId).not.toBe(b.jobId)
    })

    it('get returns the job and undefined for unknown ids', () => {
      const job = jobRegistry.create({
        kind: 'process',
        label: 'x',
        owner: OWNER_A,
      })

      expect(jobRegistry.get(job.jobId)?.jobId).toBe(job.jobId)
      expect(jobRegistry.get('does-not-exist')).toBeUndefined()
    })

    it('list returns all jobs, or only those of the given owner', () => {
      const a1 = jobRegistry.create({
        kind: 'process',
        label: 'a1',
        owner: OWNER_A,
      })
      const a2 = jobRegistry.create({
        kind: 'process',
        label: 'a2',
        owner: OWNER_A,
      })
      const b1 = jobRegistry.create({
        kind: 'agent',
        label: 'b1',
        owner: OWNER_B,
      })

      expect(
        jobRegistry
          .list()
          .map((job) => job.jobId)
          .sort(),
      ).toEqual([a1.jobId, a2.jobId, b1.jobId].sort())
      expect(
        jobRegistry
          .list(OWNER_A)
          .map((job) => job.jobId)
          .sort(),
      ).toEqual([a1.jobId, a2.jobId].sort())
      expect(jobRegistry.list(OWNER_B).map((job) => job.jobId)).toEqual([
        b1.jobId,
      ])
    })

    it('listRunning returns only running jobs, optionally per owner', () => {
      const running = jobRegistry.create({
        kind: 'process',
        label: 'r',
        owner: OWNER_A,
      })
      jobRegistry.start(running.jobId)
      const queued = jobRegistry.create({
        kind: 'process',
        label: 'q',
        owner: OWNER_A,
      })
      const done = jobRegistry.create({
        kind: 'process',
        label: 'd',
        owner: OWNER_B,
      })
      jobRegistry.start(done.jobId)
      jobRegistry.emit(done.jobId, lifecycle('completed'))

      expect(jobRegistry.listRunning().map((job) => job.jobId)).toEqual([
        running.jobId,
        queued.jobId,
      ])
      expect(jobRegistry.listRunning(OWNER_A).map((job) => job.jobId)).toEqual([
        running.jobId,
        queued.jobId,
      ])
      expect(jobRegistry.listRunning(OWNER_B)).toEqual([])
    })
  })

  describe('state machine', () => {
    it('start moves a queued job to running and records a lifecycle event', () => {
      const job = jobRegistry.create({
        kind: 'process',
        label: 'boot',
        owner: OWNER_A,
      })

      jobRegistry.start(job.jobId)

      expect(jobRegistry.get(job.jobId)?.state).toBe('running')
      expect(
        lifecycleStates(jobRegistry.snapshot(job.jobId, 0)!.events),
      ).toContain('running')
    })

    it('walks queued -> running -> stopping -> completed', () => {
      const job = createRunningJob()

      jobRegistry.emit(job.jobId, lifecycle('stopping'))
      expect(jobRegistry.get(job.jobId)?.state).toBe('stopping')

      jobRegistry.emit(job.jobId, lifecycle('completed'))
      expect(jobRegistry.get(job.jobId)?.state).toBe('completed')

      const states = lifecycleStates(jobRegistry.snapshot(job.jobId, 0)!.events)
      expect(states.slice(-3)).toEqual(['running', 'stopping', 'completed'])
    })

    it('supports running -> error directly', () => {
      const job = createRunningJob()

      jobRegistry.emit(job.jobId, lifecycle('error'))

      expect(jobRegistry.get(job.jobId)?.state).toBe('error')
    })

    it('ignores lifecycle events after a terminal state', () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, lifecycle('completed'))

      jobRegistry.emit(job.jobId, lifecycle('running'))
      jobRegistry.emit(job.jobId, lifecycle('stopping'))
      jobRegistry.emit(job.jobId, lifecycle('error'))

      expect(jobRegistry.get(job.jobId)?.state).toBe('completed')
    })
  })

  describe('event sequencing', () => {
    it('assigns contiguous, monotonically increasing sequence numbers per job', () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, out('one'))
      jobRegistry.emit(job.jobId, out('two'))
      jobRegistry.emit(job.jobId, out('three'))

      const events = jobRegistry.snapshot(job.jobId, 0)!.events

      expect(events.length).toBeGreaterThanOrEqual(3)
      expectContiguousSequences(events)
      for (const event of events) {
        expect(event.jobId).toBe(job.jobId)
        expect(typeof event.timestamp).toBe('number')
      }
    })

    it('numbers sequences independently per job', () => {
      const a = createRunningJob(OWNER_A, 'a')
      const b = createRunningJob(OWNER_A, 'b')

      jobRegistry.emit(a.jobId, out('a1'))
      jobRegistry.emit(a.jobId, out('a2'))
      jobRegistry.emit(b.jobId, out('b1'))

      const aEvents = jobRegistry.snapshot(a.jobId, 0)!.events
      const bEvents = jobRegistry.snapshot(b.jobId, 0)!.events

      expect(aEvents[0].sequence).toBe(bEvents[0].sequence)
      expectContiguousSequences(aEvents)
      expectContiguousSequences(bEvents)
    })
  })

  describe('ring buffer', () => {
    // Emits in batches until the buffer reports evictions, so the test does
    // not depend on the exact ring buffer bound.
    function emitUntilDropped(jobId: string): number {
      let emitted = 0
      for (let batch = 0; batch < 400; batch++) {
        for (let i = 0; i < 250; i++) {
          jobRegistry.emit(jobId, out(`line-${emitted}`))
          emitted += 1
        }
        if (jobRegistry.snapshot(jobId, 0)!.dropped > 0) {
          return emitted
        }
      }
      throw new Error('ring buffer never evicted (emitted 100000 events)')
    }

    it('evicts the oldest events past the bound and accounts for them in dropped', () => {
      const job = createRunningJob()
      const baseline = jobRegistry.snapshot(job.jobId, 0)!.events.length
      const emitted = emitUntilDropped(job.jobId)

      const snap = jobRegistry.snapshot(job.jobId, 0)!

      expect(snap.dropped).toBeGreaterThan(0)
      // The gap is fully accounted for: retained + dropped == total events.
      expect(snap.events.length + snap.dropped).toBe(baseline + emitted)
      // ... and the retained window has no holes.
      expectContiguousSequences(snap.events)
      expect(snap.events[snap.events.length - 1].payload).toEqual(
        out(`line-${emitted - 1}`),
      )
    })

    it('tolerates a cursor that has already been evicted', () => {
      const job = createRunningJob()
      emitUntilDropped(job.jobId)

      const fromStart = jobRegistry.snapshot(job.jobId, 0)!
      const fromStale = jobRegistry.snapshot(job.jobId, 1)!

      expect(fromStale.events.length).toBe(fromStart.events.length)
      expect(fromStale.events[0].sequence).toBe(fromStart.events[0].sequence)
    })

    it('continues assigning increasing sequence numbers after eviction', () => {
      const job = createRunningJob()
      emitUntilDropped(job.jobId)
      const before = jobRegistry.snapshot(job.jobId, 0)!
      const last = before.events[before.events.length - 1].sequence

      jobRegistry.emit(job.jobId, out('tail'))

      const after = jobRegistry.snapshot(job.jobId, last)!
      expect(after.events.length).toBe(1)
      expect(after.events[0].sequence).toBe(last + 1)
      expect(outputData(after.events)).toEqual(['tail'])
    })

    it('does not report truncated for a healthy buffer with nothing dropped', () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, out('one'))
      jobRegistry.emit(job.jobId, out('two'))
      jobRegistry.emit(job.jobId, out('three'))

      const snap = jobRegistry.snapshot(job.jobId, 0)!
      // A fresh consumer at cursor 0 with the first retained sequence at 1 has
      // no gap: truncated must be false even though events sit at/below the
      // cursor, and nothing was ever evicted.
      expect(snap.dropped).toBe(0)
      expect(snap.truncated).toBe(false)
    })

    it('reports truncated when events after the cursor were evicted', () => {
      const job = createRunningJob()
      emitUntilDropped(job.jobId)

      const snap = jobRegistry.snapshot(job.jobId, 0)!
      // Eviction left the lowest retained sequence far past cursor 0, so the
      // consumer at cursor 0 has a real gap.
      expect(snap.dropped).toBeGreaterThan(0)
      expect(snap.truncated).toBe(true)
    })

    it('does not report truncated once the cursor is caught up past the gap', () => {
      const job = createRunningJob()
      emitUntilDropped(job.jobId)

      const snap = jobRegistry.snapshot(job.jobId, 0)!
      // Snapshotting from a cursor at/after the highest evicted sequence (one
      // before the lowest retained sequence) has no gap: the consumer already
      // consumed everything up to the retained window.
      const firstRetained = snap.events[0].sequence
      const caughtUp = jobRegistry.snapshot(job.jobId, firstRetained - 1)!
      expect(caughtUp.truncated).toBe(false)
    })
  })

  describe('output byte bound', () => {
    it('evicts oldest output events once buffered bytes exceed the limit', () => {
      // A high event-count cap isolates the byte bound: only the 100-byte
      // output limit can trigger eviction here, proving accumulated output is
      // bounded by bytes so a chatty process job cannot grow without limit.
      const registry = new JobRegistry({
        outputByteLimit: 100,
        eventBufferLimit: 10_000,
      })
      const job = registry.create({
        kind: 'process',
        label: 'chatty',
        owner: OWNER_A,
      })
      registry.start(job.jobId)
      for (let i = 0; i < 50; i++) {
        registry.emit(job.jobId, { type: 'output', data: 'x'.repeat(20) })
      }

      const snap = registry.snapshot(job.jobId, 0)!
      const bufferedBytes = snap.events.reduce(
        (total, event) =>
          total +
          (event.payload.type === 'output' ? event.payload.data.length : 0),
        0,
      )
      expect(bufferedBytes).toBeLessThanOrEqual(100)
      expect(snap.dropped).toBeGreaterThan(0)
      expectContiguousSequences(snap.events)
    })

    it('byte-bounds accumulated agent_chunk output so a chatty agent cannot OOM', () => {
      // The event-count cap is set far above the number emitted, so only the
      // byte bound can evict — guarding the OOM vector where agent chunks are
      // count-bounded but individually large.
      const registry = new JobRegistry({
        outputByteLimit: 200,
        eventBufferLimit: 10_000,
      })
      const job = registry.create({
        kind: 'agent',
        label: 'chatty-agent',
        owner: OWNER_A,
      })
      registry.start(job.jobId)
      for (let i = 0; i < 100; i++) {
        registry.emit(job.jobId, {
          type: 'agent_chunk',
          chunkType: 'text',
          data: 'y'.repeat(50),
        })
      }

      const snap = registry.snapshot(job.jobId, 0)!
      expect(snap.dropped).toBeGreaterThan(0)
      expect(snap.events.length).toBeLessThan(100)
    })
  })

  describe('kindBounds', () => {
    it('applies agent eventBufferLimit overrides over the global cap', () => {
      // High global so only the agent kind bound can fire eviction.
      const registry = new JobRegistry({
        eventBufferLimit: 10_000,
        kindBounds: {
          agent: { eventBufferLimit: 5 },
        },
      })
      const job = registry.create({
        kind: 'agent',
        label: 'bounded-agent',
        owner: OWNER_A,
      })
      registry.start(job.jobId)
      for (let i = 0; i < 20; i++) {
        registry.emit(job.jobId, {
          type: 'agent_chunk',
          chunkType: 'text',
          data: `c${i}`,
        })
      }

      const snap = registry.snapshot(job.jobId, 0)!
      // lifecycle(queued/running) also count toward the ring.
      expect(snap.dropped).toBeGreaterThan(0)
      expect(snap.events.length).toBeLessThanOrEqual(5)
    })

    it('does not apply agent eventBufferLimit to process jobs', () => {
      const registry = new JobRegistry({
        eventBufferLimit: 10_000,
        kindBounds: {
          agent: { eventBufferLimit: 5 },
        },
      })
      const job = registry.create({
        kind: 'process',
        label: 'unbounded-process',
        owner: OWNER_A,
      })
      registry.start(job.jobId)
      for (let i = 0; i < 20; i++) {
        registry.emit(job.jobId, out(`line-${i}`))
      }

      const snap = registry.snapshot(job.jobId, 0)!
      // Process keeps the high global limit; agent-only kindBounds must not drop.
      expect(snap.dropped).toBe(0)
      expect(snap.events.length).toBeGreaterThan(5)
    })

    it('applies agent settledTtlMs overrides over the global TTL', () => {
      const registry = new JobRegistry({
        settledTtlMs: 24 * 60 * 60 * 1000, // long global
        kindBounds: {
          agent: { settledTtlMs: 100 }, // short agent TTL
        },
      })
      const agent = registry.create({
        kind: 'agent',
        label: 'a',
        owner: OWNER_A,
      })
      registry.start(agent.jobId)
      registry.emit(agent.jobId, lifecycle('completed'))
      const process = registry.create({
        kind: 'process',
        label: 'p',
        owner: OWNER_A,
      })
      registry.start(process.jobId)
      registry.emit(process.jobId, lifecycle('completed'))

      // Past agent TTL, still within process (global) TTL.
      registry.sweep(Date.now() + 200)
      expect(registry.get(agent.jobId)).toBeUndefined()
      expect(registry.get(process.jobId)?.state).toBe('completed')
    })

    it('uses the singleton default agent eventBufferLimit', () => {
      // jobRegistry is constructed with agent kindBounds mirroring
      // AGENT_JOB_EVENT_BUFFER_LIMIT / AGENT_JOB_SETTLED_TTL_MS.
      const job = jobRegistry.create({
        kind: 'agent',
        label: 'singleton-agent-bound',
        owner: OWNER_A,
      })
      jobRegistry.start(job.jobId)
      // lifecycle(queued/running) count toward the ring; overflow past the
      // agent default must drop once the kind bound is hit.
      for (let i = 0; i < AGENT_JOB_EVENT_BUFFER_LIMIT + 50; i++) {
        jobRegistry.emit(job.jobId, agentChunk(`chunk-${i}`))
      }

      const snap = jobRegistry.snapshot(job.jobId, 0)!
      expect(snap.dropped).toBeGreaterThan(0)
      expect(snap.events.length).toBeLessThanOrEqual(
        AGENT_JOB_EVENT_BUFFER_LIMIT,
      )
      // Keep the settled-TTL constant referenced so a silent export/rename
      // break is caught alongside the event-buffer default.
      expect(AGENT_JOB_SETTLED_TTL_MS).toBe(30 * 60 * 1000)
    })
  })

  describe('snapshot cursors', () => {
    it('returns every event from the beginning with cursor 0', () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, out('first'))
      jobRegistry.emit(job.jobId, out('second'))

      const events = jobRegistry.snapshot(job.jobId, 0)!.events

      expect(outputData(events)).toEqual(['first', 'second'])
    })

    it('returns only events after the given cursor', () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, out('first'))
      const buffered = jobRegistry.snapshot(job.jobId, 0)!.events
      const cursor = buffered[buffered.length - 1].sequence

      jobRegistry.emit(job.jobId, out('second'))
      jobRegistry.emit(job.jobId, out('third'))

      const events = jobRegistry.snapshot(job.jobId, cursor)!.events
      expect(outputData(events)).toEqual(['second', 'third'])
    })

    it('has no job-global read offset: consumers at different cursors coexist', () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, out('one'))
      jobRegistry.emit(job.jobId, out('two'))

      // Consumer 1 catches up to the latest event.
      const consumer1 = jobRegistry.snapshot(job.jobId, 0)!
      const cursor1 = consumer1.events[consumer1.events.length - 1].sequence

      // Consumer 2 is still at the beginning and must see the full history.
      const consumer2 = jobRegistry.snapshot(job.jobId, 0)!
      expect(outputData(consumer2.events)).toEqual(['one', 'two'])

      jobRegistry.emit(job.jobId, out('three'))

      // Each consumer continues from its own cursor, independently.
      expect(
        outputData(jobRegistry.snapshot(job.jobId, cursor1)!.events),
      ).toEqual(['three'])
      expect(outputData(jobRegistry.snapshot(job.jobId, 0)!.events)).toEqual([
        'one',
        'two',
        'three',
      ])
    })
  })

  describe('wait', () => {
    it('resolves with matched=true when a new event satisfies the predicate', async () => {
      const job = createRunningJob()

      const pending = jobRegistry.wait(job.jobId, {
        predicate: (event) =>
          event.payload.type === 'output' && event.payload.data === 'needle',
        timeoutMs: 1_000,
      })
      await sleep(5)

      jobRegistry.emit(job.jobId, out('hay'))
      jobRegistry.emit(job.jobId, out('needle'))

      const result = (await pending)!
      expect(result.matched).toBeDefined()
      expect(result.timedOut).toBeFalsy()
    })

    it('resolves with matched=false when the job reaches a terminal state', async () => {
      const job = createRunningJob()

      const pending = jobRegistry.wait(job.jobId, {
        predicate: (event) =>
          event.payload.type === 'output' && event.payload.data === 'never',
        timeoutMs: 1_000,
      })
      await sleep(5)

      jobRegistry.emit(job.jobId, out('noise'))
      jobRegistry.emit(job.jobId, lifecycle('completed'))

      const result = (await pending)!
      expect(result.matched).toBeUndefined()
      expect(result.timedOut).toBeFalsy()
    })

    it('resolves with matched=false when the job is already terminal', async () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, lifecycle('completed'))

      const result = (await jobRegistry.wait(job.jobId, {
        predicate: (event) =>
          event.payload.type === 'output' && event.payload.data === 'never',
        timeoutMs: 1_000,
      }))!

      expect(result.matched).toBeUndefined()
      expect(result.timedOut).toBeFalsy()
    })

    it('resolves with timedOut=true when nothing matches within timeoutMs', async () => {
      const job = createRunningJob()

      const startedAt = Date.now()
      const result = (await jobRegistry.wait(job.jobId, {
        predicate: () => false,
        timeoutMs: 20,
      }))!
      const elapsed = Date.now() - startedAt

      expect(result.timedOut).toBe(true)
      expect(result.matched).toBeUndefined()
      expect(elapsed).toBeGreaterThanOrEqual(10)
    })

    it('does not busy-loop while waiting', async () => {
      const job = createRunningJob()

      let calls = 0
      const result = (await jobRegistry.wait(job.jobId, {
        predicate: () => {
          calls += 1
          return false
        },
        timeoutMs: 25,
      }))!

      expect(result.timedOut).toBe(true)
      // An event-driven wait evaluates the predicate once per new event
      // (zero here). Even a poller ticking every millisecond stays far below
      // this bound, while a hot loop runs thousands of iterations in 25ms.
      expect(calls).toBeLessThanOrEqual(100)
    })

    it('cleans up its listener after resolving', async () => {
      const job = createRunningJob()

      let calls = 0
      const pending = jobRegistry.wait(job.jobId, {
        predicate: () => {
          calls += 1
          return false
        },
        timeoutMs: 1_000,
      })
      await sleep(5)
      jobRegistry.emit(job.jobId, lifecycle('completed'))
      await pending

      const callsAtResolve = calls
      jobRegistry.emit(job.jobId, out('after-terminal'))
      jobRegistry.emit(job.jobId, out('after-terminal-2'))
      await sleep(10)

      expect(calls).toBe(callsAtResolve)
    })

    it('ignores buffered events at or before the given cursor', async () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, out('needle'))
      const buffered = jobRegistry.snapshot(job.jobId, 0)!.events
      const cursor = buffered[buffered.length - 1].sequence

      const result = (await jobRegistry.wait(job.jobId, {
        predicate: (event) =>
          event.payload.type === 'output' && event.payload.data === 'needle',
        timeoutMs: 20,
        cursor,
      }))!

      expect(result.timedOut).toBe(true)
      expect(result.matched).toBeUndefined()
    })
  })

  describe('stream', () => {
    it('replays buffered events in order for a finished job and then ends', async () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, out('a'))
      jobRegistry.emit(job.jobId, out('b'))
      jobRegistry.emit(job.jobId, lifecycle('completed'))

      const events = await collect(jobRegistry.stream(job.jobId, 0))

      expect(outputData(events)).toEqual(['a', 'b'])
      expectContiguousSequences(events)
      expect(lifecycleStates(events)).toContain('completed')
    })

    it('yields live events as they arrive and ends once drained after terminal', async () => {
      const job = createRunningJob()

      const consumed = collect(jobRegistry.stream(job.jobId, 0))
      await sleep(5)

      jobRegistry.emit(job.jobId, out('live-1'))
      await sleep(1)
      jobRegistry.emit(job.jobId, out('live-2'))
      jobRegistry.emit(job.jobId, lifecycle('completed'))

      const events = await consumed
      expect(outputData(events)).toEqual(['live-1', 'live-2'])
      expectContiguousSequences(events)
    })

    it('starts after the given cursor', async () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, out('skipped'))
      const buffered = jobRegistry.snapshot(job.jobId, 0)!.events
      const cursor = buffered[buffered.length - 1].sequence
      jobRegistry.emit(job.jobId, out('kept'))
      jobRegistry.emit(job.jobId, lifecycle('completed'))

      const events = await collect(jobRegistry.stream(job.jobId, cursor))

      expect(outputData(events)).toEqual(['kept'])
    })

    it('drains output emitted after the terminal event before ending', async () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, out('before'))
      jobRegistry.emit(job.jobId, lifecycle('completed'))
      jobRegistry.emit(job.jobId, out('after'))

      const events = await collect(jobRegistry.stream(job.jobId, 0))

      expect(outputData(events)).toEqual(['before', 'after'])
    })
  })

  describe('assertOwned', () => {
    it("returns 'ok' for the owning session and root run", () => {
      const job = jobRegistry.create({
        kind: 'process',
        label: 'owned',
        owner: OWNER_A,
      })

      expect(jobRegistry.assertOwned(job.jobId, OWNER_A).ok).toBe(true)
      expect(
        jobRegistry.assertOwned(job.jobId, {
          clientSessionId: 'session-a',
          rootRunId: 'run-a',
        }).ok,
      ).toBe(true)
    })

    it("returns 'foreign' when the session differs", () => {
      const job = jobRegistry.create({
        kind: 'process',
        label: 'owned',
        owner: OWNER_A,
      })

      expect(
        jobRegistry.assertOwned(job.jobId, {
          clientSessionId: 'session-b',
          rootRunId: 'run-a',
        }),
      ).toEqual({ ok: false, reason: 'foreign' })
    })

    it("returns 'foreign' when the root run differs", () => {
      const job = jobRegistry.create({
        kind: 'process',
        label: 'owned',
        owner: OWNER_A,
      })

      expect(
        jobRegistry.assertOwned(job.jobId, {
          clientSessionId: 'session-a',
          rootRunId: 'run-b',
        }),
      ).toEqual({ ok: false, reason: 'foreign' })
    })

    it("returns 'not_found' for unknown job ids", () => {
      expect(jobRegistry.assertOwned('missing-job', OWNER_A)).toEqual({
        ok: false,
        reason: 'not_found',
      })
    })
  })

  describe('restampOwner', () => {
    it('replaces a job owner in place', () => {
      const job = createRunningJob(OWNER_A)

      jobRegistry.restampOwner(job.jobId, OWNER_B)

      expect(jobRegistry.assertOwned(job.jobId, OWNER_B).ok).toBe(true)
      expect(jobRegistry.assertOwned(job.jobId, OWNER_A)).toEqual({
        ok: false,
        reason: 'foreign',
      })
    })

    it('is a no-op for an unknown job id', () => {
      expect(() =>
        jobRegistry.restampOwner('job-does-not-exist', OWNER_A),
      ).not.toThrow()
    })
  })

  describe('cancel', () => {
    it('transitions a running job to cancelled and records a lifecycle event', () => {
      const job = createRunningJob()

      jobRegistry.cancel(job.jobId)

      expect(jobRegistry.get(job.jobId)?.state).toBe('cancelled')
      expect(
        lifecycleStates(jobRegistry.snapshot(job.jobId, 0)!.events),
      ).toContain('cancelled')
      expect(jobRegistry.listRunning().map((job) => job.jobId)).not.toContain(
        job.jobId,
      )
    })

    it('leaves a queued job queued (no running work to abort)', () => {
      const job = jobRegistry.create({
        kind: 'process',
        label: 'queued',
        owner: OWNER_A,
      })

      jobRegistry.cancel(job.jobId)

      expect(jobRegistry.get(job.jobId)?.state).toBe('queued')
    })

    it('is a no-op for a job that already reached a terminal state', () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, lifecycle('completed'))

      jobRegistry.cancel(job.jobId)

      expect(jobRegistry.get(job.jobId)?.state).toBe('completed')
    })
  })

  describe('sweep', () => {
    const FAR_FUTURE = Date.now() + 30 * 24 * 60 * 60 * 1000

    it('drops settled jobs past the TTL', () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, lifecycle('completed'))

      jobRegistry.sweep(FAR_FUTURE)

      expect(jobRegistry.get(job.jobId)).toBeUndefined()
      expect(jobRegistry.list().map((job) => job.jobId)).not.toContain(
        job.jobId,
      )
    })

    it('drops cancelled jobs past the TTL', () => {
      const job = createRunningJob()
      jobRegistry.cancel(job.jobId)

      jobRegistry.sweep(FAR_FUTURE)

      expect(jobRegistry.get(job.jobId)).toBeUndefined()
    })

    it('never drops running jobs', () => {
      const job = createRunningJob()

      jobRegistry.sweep(FAR_FUTURE)

      expect(jobRegistry.get(job.jobId)?.state).toBe('running')
    })

    it('never drops queued jobs', () => {
      const job = jobRegistry.create({
        kind: 'process',
        label: 'queued',
        owner: OWNER_A,
      })

      jobRegistry.sweep(FAR_FUTURE)

      expect(jobRegistry.get(job.jobId)?.state).toBe('queued')
    })

    it('keeps recently settled jobs when swept at the current time', () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, lifecycle('completed'))

      jobRegistry.sweep()

      expect(jobRegistry.get(job.jobId)?.state).toBe('completed')
    })
  })

  describe('events after terminal state', () => {
    it('still buffers output events after completion', () => {
      const job = createRunningJob()
      jobRegistry.emit(job.jobId, lifecycle('completed'))

      jobRegistry.emit(job.jobId, out('late-output'))

      expect(outputData(jobRegistry.snapshot(job.jobId, 0)!.events)).toContain(
        'late-output',
      )
    })

    it('still buffers agent_chunk events after completion', () => {
      const job = jobRegistry.create({
        kind: 'agent',
        label: 'agent',
        owner: OWNER_A,
      })
      jobRegistry.start(job.jobId)
      jobRegistry.emit(job.jobId, agentChunk('early'))
      jobRegistry.emit(job.jobId, lifecycle('completed'))
      jobRegistry.emit(job.jobId, agentChunk('late'))

      const chunks = jobRegistry
        .snapshot(job.jobId, 0)!
        .events.filter((event) => event.payload.type === 'agent_chunk')
      expect(chunks.length).toBe(2)
    })
  })
})

describe('subscribeAll', () => {
  it('receives lifecycle and output events for any job', () => {
    const registry = new JobRegistry()
    const received: Array<{ jobId: string; payload: JobEventPayload }> = []
    registry.subscribeAll((job, event) => {
      received.push({ jobId: job.jobId, payload: event.payload })
    })

    const job = registry.create({
      kind: 'process',
      label: 'watched',
      owner: OWNER_A,
    })
    registry.start(job.jobId)
    registry.emit(job.jobId, out('hello'))
    registry.emit(job.jobId, lifecycle('completed'))

    // create(queued) + start(running) + output + completed
    expect(received.map((r) => r.payload.type)).toEqual([
      'lifecycle',
      'lifecycle',
      'output',
      'lifecycle',
    ])
    expect(received.every((r) => r.jobId === job.jobId)).toBe(true)
    expect(
      received
        .filter((r) => r.payload.type === 'lifecycle')
        .map((r) => (r.payload as LifecyclePayload).state),
    ).toEqual(['queued', 'running', 'completed'])
  })

  it('delivers a defensive copy of the job (not the live record)', () => {
    const registry = new JobRegistry()
    const jobs: Job[] = []
    registry.subscribeAll((job) => jobs.push(job))

    const created = registry.create({
      kind: 'process',
      label: 'copy',
      owner: OWNER_A,
    })
    registry.start(created.jobId)

    // The queued snapshot must not have been mutated to running afterwards.
    expect(jobs[0].state).toBe('queued')
    expect(jobs[1].state).toBe('running')
  })

  it('stops delivery after the disposer runs, idempotently', () => {
    const registry = new JobRegistry()
    const received: JobEvent[] = []
    const dispose = registry.subscribeAll((_job, event) => {
      received.push(event)
    })

    const job = registry.create({
      kind: 'process',
      label: 'disposed',
      owner: OWNER_A,
    })
    const countAfterCreate = received.length
    expect(countAfterCreate).toBeGreaterThan(0)

    dispose()
    dispose() // idempotent: a second call is a no-op

    registry.start(job.jobId)
    registry.emit(job.jobId, out('after-dispose'))

    expect(received.length).toBe(countAfterCreate)
  })

  it('isolates a throwing listener so emit and other listeners are unaffected', () => {
    const registry = new JobRegistry()
    const good: JobEvent[] = []
    registry.subscribeAll(() => {
      throw new Error('bad listener')
    })
    registry.subscribeAll((_job, event) => {
      good.push(event)
    })

    const job = registry.create({
      kind: 'process',
      label: 'isolate',
      owner: OWNER_A,
    })
    // emit does not throw despite the bad listener...
    expect(() => registry.emit(job.jobId, out('still-works'))).not.toThrow()
    // ...and the good listener still received every event.
    expect(good.length).toBeGreaterThanOrEqual(2)
    expect(outputData(good)).toContain('still-works')
  })

  it('clear() removes all global subscribers', () => {
    const registry = new JobRegistry()
    const received: JobEvent[] = []
    registry.subscribeAll((_job, event) => received.push(event))

    registry.clear()

    const job = registry.create({
      kind: 'process',
      label: 'cleared',
      owner: OWNER_A,
    })
    registry.emit(job.jobId, out('after-clear'))

    expect(received.length).toBe(0)
  })
})

describe('JobRegistry', () => {
  it('keeps jobs isolated between instances', () => {
    const first = new JobRegistry()
    const second = new JobRegistry()

    const job = first.create({
      kind: 'process',
      label: 'isolated',
      owner: OWNER_A,
    })

    expect(first.get(job.jobId)?.jobId).toBe(job.jobId)
    expect(second.get(job.jobId)).toBeUndefined()
    expect(second.list()).toEqual([])
  })
})
