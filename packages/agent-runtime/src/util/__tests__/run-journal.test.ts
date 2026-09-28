import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'

import { reconcileInterruptedBackgroundAgentIntents } from '../background-agent-jobs'
import {
  classifyChildRun,
  classifyRunResume,
  createRunJournal,
  DEFAULT_RERUNNABLE_BACKGROUND_AGENT_TYPES,
  executeChildReplay,
  planBackgroundAgentResume,
  planChildResume,
} from '../run-journal'

import type { JournalReader } from '@codebuff/common/types/contracts/agent-runtime'
import type { AgentState } from '@codebuff/common/types/session-state'

/** Deterministic clock so created_at is reproducible in tests. */
const fixedClock = { now: () => 1_000 }

const makeJournal = () =>
  createRunJournal({
    path: ':memory:',
    clock: fixedClock,
    createDatabase: (path) => new Database(path),
  })

describe('createRunJournal (JournalWriter/JournalReader)', () => {
  it('mints monotonic gap-free seq per runId', () => {
    const journal = makeJournal()
    try {
      journal.append('run-1', {
        eventType: 'step_boundary',
        stepNumber: 0,
        correlation: 's0',
        payload: { status: 'completed' },
      })
      journal.append('run-1', {
        eventType: 'step_boundary',
        stepNumber: 1,
        correlation: 's1',
        payload: { status: 'completed' },
      })
      journal.append('run-1', {
        eventType: 'step_boundary',
        stepNumber: 2,
        correlation: 's2',
        payload: { status: 'completed' },
      })
      expect(journal.events('run-1').map((e) => e.seq)).toEqual([0, 1, 2])
    } finally {
      journal.close()
    }
  })

  it('lastEvent returns the highest-seq row', () => {
    const journal = makeJournal()
    try {
      journal.append('run-1', {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'a',
        payload: { model: 'm' },
      })
      journal.append('run-1', {
        eventType: 'llm_response',
        stepNumber: 0,
        correlation: 'a',
        payload: { messageId: 'msg-1' },
      })
      const last = journal.lastEvent('run-1')
      expect(last?.eventType).toBe('llm_response')
      expect(last?.seq).toBe(1)
      expect(last?.payload).toEqual({ messageId: 'msg-1' })
    } finally {
      journal.close()
    }
  })

  it('events returns all rows in seq order with parsed payloads', () => {
    const journal = makeJournal()
    try {
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 't1',
        payload: { toolName: 'read_files', input: { a: 1 } },
      })
      journal.append('run-1', {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 't1',
        payload: { toolName: 'read_files', result: [{ type: 'json', value: 42 }] },
      })
      const events = journal.events('run-1')
      expect(events).toHaveLength(2)
      expect(events[0].eventType).toBe('tool_call')
      expect(events[0].payload).toEqual({
        toolName: 'read_files',
        input: { a: 1 },
      })
      expect(events[1].payload).toEqual({
        toolName: 'read_files',
        result: [{ type: 'json', value: 42 }],
      })
    } finally {
      journal.close()
    }
  })

  it('toolResultFor returns the newest matching tool_result payload, else undefined', () => {
    const journal = makeJournal()
    try {
      journal.append('run-1', {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 'call-x',
        payload: { result: 'first' },
      })
      journal.append('run-1', {
        eventType: 'tool_result',
        stepNumber: 1,
        correlation: 'call-x',
        payload: { result: 'second' },
      })
      expect(journal.toolResultFor('run-1', 'call-x')).toEqual({
        result: 'second',
      })
      expect(journal.toolResultFor('run-1', 'missing')).toBeUndefined()
    } finally {
      journal.close()
    }
  })

  it('isolates events by runId', () => {
    const journal = makeJournal()
    try {
      journal.append('run-a', {
        eventType: 'step_boundary',
        stepNumber: 0,
        correlation: 'sa',
        payload: {},
      })
      journal.append('run-b', {
        eventType: 'step_boundary',
        stepNumber: 0,
        correlation: 'sb',
        payload: {},
      })
      journal.append('run-b', {
        eventType: 'step_boundary',
        stepNumber: 1,
        correlation: 'sb2',
        payload: {},
      })
      // Each runId gets its own seq series starting at 0.
      expect(journal.events('run-a').map((e) => e.seq)).toEqual([0])
      expect(journal.events('run-b').map((e) => e.seq)).toEqual([0, 1])
    } finally {
      journal.close()
    }
  })
})

describe('classifyRunResume', () => {
  it('classifies a step_boundary tail as clean', () => {
    const journal = makeJournal()
    try {
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'c1',
        payload: {},
      })
      journal.append('run-1', {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 'c1',
        payload: { result: null },
      })
      journal.append('run-1', {
        eventType: 'step_boundary',
        stepNumber: 0,
        correlation: 's0',
        payload: { status: 'completed' },
      })
      expect(classifyRunResume(journal, 'run-1')).toEqual({ kind: 'clean' })
    } finally {
      journal.close()
    }
  })

  it('classifies a tool_call with no matching tool_result as in_flight_tool', () => {
    const journal = makeJournal()
    try {
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'B',
        payload: { toolName: 'run_terminal_command' },
      })
      expect(classifyRunResume(journal, 'run-1')).toEqual({
        kind: 'in_flight_tool',
        toolCallId: 'B',
      })
    } finally {
      journal.close()
    }
  })

  it('classifies an llm_request with no llm_response as in_flight_llm', () => {
    const journal = makeJournal()
    try {
      journal.append('run-1', {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'step-1',
        payload: { model: 'm', messageCount: 3 },
      })
      expect(classifyRunResume(journal, 'run-1')).toEqual({
        kind: 'in_flight_llm',
      })
    } finally {
      journal.close()
    }
  })

  it('classifies an empty run as clean', () => {
    const journal = makeJournal()
    try {
      expect(classifyRunResume(journal, 'nonexistent')).toEqual({
        kind: 'clean',
      })
    } finally {
      journal.close()
    }
  })
})

describe('kill-9 mid-tool-call resume (P2-T2-DESIGN §6)', () => {
  it('replays a completed side-effecting tool without re-executing it and finishes the crashed one exactly once', () => {
    const runId = 'run-kill9'
    const journal = makeJournal()
    try {
      // --- Phase 1: pre-crash ---
      // Live side-effecting executors. Each increments this counter when it
      // actually runs; the replay driver must NOT run A again.
      let sideEffectCount = 0
      const scripted = [
        {
          id: 'A',
          execute: () => {
            sideEffectCount++
            return { result: 'A-done' }
          },
        },
        {
          id: 'B',
          execute: () => {
            sideEffectCount++
            return { result: 'B-done' }
          },
        },
      ]

      // Tool A runs to completion pre-crash: tool_call then tool_result.
      journal.append(runId, {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'A',
        payload: { toolName: 'toolA' },
      })
      const aResult = scripted[0].execute()
      journal.append(runId, {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 'A',
        payload: aResult,
      })
      expect(sideEffectCount).toBe(1)

      // Tool B's call is journaled but the process is kill-9'd before its
      // tool_result is written — the crash window.
      journal.append(runId, {
        eventType: 'tool_call',
        stepNumber: 1,
        correlation: 'B',
        payload: { toolName: 'toolB' },
      })

      // Classification sees B as in-flight.
      expect(classifyRunResume(journal, runId)).toEqual({
        kind: 'in_flight_tool',
        toolCallId: 'B',
      })

      // --- Phase 2: resume via an inline replay driver ---
      const replayDriver = (
        reader: JournalReader,
        id: string,
        script: typeof scripted,
      ) => {
        for (const call of script) {
          const recorded = reader.toolResultFor(id, call.id)
          if (recorded !== undefined) {
            // Idempotency short-circuit: reuse the recorded result, do NOT
            // re-run the live executor.
            continue
          }
          const live = call.execute()
          journal.append(id, {
            eventType: 'tool_result',
            stepNumber: 1,
            correlation: call.id,
            payload: live,
          })
        }
      }

      replayDriver(journal, runId, scripted)

      // A was NOT re-executed (would push count to 3); B executed live once.
      // Final count is 2: A(pre-crash) + B(resume).
      expect(sideEffectCount).toBe(2)

      // The run reaches completion with both tool_results now journaled.
      expect(journal.toolResultFor(runId, 'A')).toEqual({ result: 'A-done' })
      expect(journal.toolResultFor(runId, 'B')).toEqual({ result: 'B-done' })
      expect(classifyRunResume(journal, runId)).toEqual({ kind: 'clean' })
    } finally {
      journal.close()
    }
  })
})

describe('nested child spawn resume (P2-T2-DESIGN §4d)', () => {
  it('parent with an in-flight child spawn resumes from the child’s own journal', () => {
    const parentRunId = 'parent-1'
    const childRunId = 'child-1'
    const journal = makeJournal()
    try {
      // Parent: a completed step, then a spawn of child-1 that never got its
      // terminal step_boundary journaled in the parent.
      journal.append(parentRunId, {
        eventType: 'step_boundary',
        stepNumber: 0,
        correlation: 's0',
        payload: { status: 'completed' },
      })
      journal.append(parentRunId, {
        eventType: 'spawn',
        stepNumber: 1,
        correlation: childRunId,
        payload: { agentType: 'helper' },
      })

      // Child runs its own nested loop, journaled under ITS runId, and
      // finishes with a clean terminal tail.
      journal.append(childRunId, {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'cl0',
        payload: { model: 'm' },
      })
      journal.append(childRunId, {
        eventType: 'tool_call',
        stepNumber: 1,
        correlation: 'c1-tool',
        payload: { toolName: 'toolC1' },
      })
      journal.append(childRunId, {
        eventType: 'tool_result',
        stepNumber: 1,
        correlation: 'c1-tool',
        payload: { result: null },
      })
      journal.append(childRunId, {
        eventType: 'step_boundary',
        stepNumber: 1,
        correlation: 'cs1',
        payload: { status: 'completed' },
      })
      const childLastSeq = journal.lastEvent(childRunId)!.seq
      expect(childLastSeq).toBe(3)

      expect(classifyChildRun(journal, childRunId)).toEqual({
        kind: 'child_completed',
        lastEventSeq: childLastSeq,
      })
      expect(planChildResume(journal, parentRunId)).toEqual({
        kind: 'needs_children',
        inFlight: [],
        awaiting: [{ childRunId, childLastSeq }],
      })
      expect(executeChildReplay(journal, childRunId)).toEqual({
        kind: 'replayed_completed',
        childRunId,
        lastSeq: childLastSeq,
      })
    } finally {
      journal.close()
    }
  })

  it('parent with a crashed in-flight child requires live execution', () => {
    const parentRunId = 'parent-2'
    const childRunId = 'child-2'
    const journal = makeJournal()
    try {
      journal.append(parentRunId, {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: childRunId,
        payload: { agentType: 'helper' },
      })
      // Child was kill-9'd mid-tool: tool_call journaled, no tool_result.
      journal.append(childRunId, {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'cl0',
        payload: { model: 'm' },
      })
      journal.append(childRunId, {
        eventType: 'tool_call',
        stepNumber: 1,
        correlation: 'c2-tool',
        payload: { toolName: 'toolC2' },
      })

      expect(classifyChildRun(journal, childRunId)).toEqual({
        kind: 'child_in_flight_tool',
        childRunId,
        toolCallId: 'c2-tool',
      })
      const plan = planChildResume(journal, parentRunId)
      expect(plan).toEqual({
        kind: 'needs_children',
        inFlight: [
          {
            kind: 'child_in_flight_tool',
            childRunId,
            toolCallId: 'c2-tool',
          },
        ],
        awaiting: [],
      })
      expect(executeChildReplay(journal, childRunId)).toEqual({
        kind: 'live_execution_required',
        childRunId,
      })
    } finally {
      journal.close()
    }
  })

  it('crashed child with no journaled output classifies unknown', () => {
    const parentRunId = 'parent-3'
    const childRunId = 'child-3'
    const journal = makeJournal()
    try {
      journal.append(parentRunId, {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: childRunId,
        payload: { agentType: 'helper' },
      })
      // childRunId NEVER journaled anything: recording intent without progress.

      expect(classifyChildRun(journal, childRunId)).toEqual({
        kind: 'child_unknown',
        childRunId,
      })
      expect(planChildResume(journal, parentRunId)).toEqual({
        kind: 'needs_children',
        inFlight: [{ kind: 'child_unknown', childRunId }],
        awaiting: [],
      })
      expect(executeChildReplay(journal, childRunId)).toEqual({
        kind: 'child_unknown',
        childRunId,
      })
    } finally {
      journal.close()
    }
  })

  it('a reconciled child is skipped (spawn followed by matching step_boundary)', () => {
    const parentRunId = 'parent-4'
    const childRunId = 'child-4'
    const journal = makeJournal()
    try {
      journal.append(parentRunId, {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: childRunId,
        payload: { agentType: 'helper' },
      })
      journal.append(parentRunId, {
        eventType: 'step_boundary',
        stepNumber: 1,
        correlation: childRunId,
        payload: { status: 'completed' },
      })
      expect(planChildResume(journal, parentRunId)).toEqual({
        kind: 'live_continue',
      })
    } finally {
      journal.close()
    }
  })

  it('empty parent journal is live_continue', () => {
    const journal = makeJournal()
    try {
      expect(planChildResume(journal, 'parent-empty')).toEqual({
        kind: 'live_continue',
      })
    } finally {
      journal.close()
    }
  })

  it('re-plan is idempotent: appending the terminal step_boundary flips to live_continue', () => {
    const parentRunId = 'parent-1-replan'
    const childRunId = 'child-1-replan'
    const journal = makeJournal()
    try {
      journal.append(parentRunId, {
        eventType: 'step_boundary',
        stepNumber: 0,
        correlation: 's0',
        payload: { status: 'completed' },
      })
      journal.append(parentRunId, {
        eventType: 'spawn',
        stepNumber: 1,
        correlation: childRunId,
        payload: { agentType: 'helper' },
      })
      // Child completes with a clean tail.
      journal.append(childRunId, {
        eventType: 'step_boundary',
        stepNumber: 0,
        correlation: 'cs0',
        payload: { status: 'completed' },
      })
      const childLastSeq = journal.lastEvent(childRunId)!.seq
      expect(planChildResume(journal, parentRunId)).toEqual({
        kind: 'needs_children',
        inFlight: [],
        awaiting: [{ childRunId, childLastSeq }],
      })

      // Parent later records the child's terminal boundary → reconciled.
      journal.append(parentRunId, {
        eventType: 'step_boundary',
        stepNumber: 2,
        correlation: childRunId,
        payload: { status: 'completed' },
      })
      expect(planChildResume(journal, parentRunId)).toEqual({
        kind: 'live_continue',
      })
    } finally {
      journal.close()
    }
  })
})

describe('background agent resume policy (P2-T2-DESIGN §4d slice 3)', () => {
  type Intent = NonNullable<AgentState['backgroundAgentJobs']>[number]
  const interrupted = (jobId: string, agentType: string): Intent => ({
    jobId,
    agentType,
    status: 'interrupted',
    startedAt: 1_000,
    completedAt: 2_000,
  })

  it('interrupted background job is reconciled then re-spawned from its intent', () => {
    const state = {
      backgroundAgentJobs: [
        {
          jobId: 'bg-gone-1',
          agentType: 'file-picker',
          status: 'running',
          startedAt: 1_000,
        },
        {
          jobId: 'bg-gone-2',
          agentType: 'editor',
          status: 'running',
          startedAt: 1_000,
        },
        {
          jobId: 'bg-done',
          agentType: 'thinker',
          status: 'completed',
          startedAt: 1_000,
          completedAt: 2_000,
        },
      ],
    } as unknown as AgentState

    // The jobIds are not in the live registry: the host process "died".
    reconcileInterruptedBackgroundAgentIntents(state, 5_000)
    const [gone1, gone2, done] = state.backgroundAgentJobs!
    expect(gone1.status).toBe('interrupted')
    expect(gone1.completedAt).toBe(5_000)
    expect(gone2.status).toBe('interrupted')
    expect(gone2.completedAt).toBe(5_000)
    expect(done.status).toBe('completed')
    expect(done.completedAt).toBe(2_000)

    expect(
      planBackgroundAgentResume({ intents: state.backgroundAgentJobs! }),
    ).toEqual([
      { kind: 'respawn', jobId: 'bg-gone-1', agentType: 'file-picker' },
      {
        kind: 'needs_confirmation',
        jobId: 'bg-gone-2',
        agentType: 'editor',
        reason: expect.any(String),
      },
      { kind: 'skip_terminal', jobId: 'bg-done', status: 'completed' },
    ])
  })

  it('still-running intent is reported, not re-spawned', () => {
    expect(
      planBackgroundAgentResume({
        intents: [
          {
            jobId: 'bg-live',
            agentType: 'file-picker',
            status: 'running',
            startedAt: 1_000,
          },
        ],
      }),
    ).toEqual([{ kind: 'still_running', jobId: 'bg-live' }])
  })

  it('re-plan is idempotent once the re-spawn is journaled', () => {
    const journal = makeJournal()
    try {
      const intents = [interrupted('bg-x', 'file-picker')]
      const plan = () =>
        planBackgroundAgentResume({
          intents,
          reader: journal,
          parentRunId: 'parent-bg',
        })
      expect(plan()).toEqual([
        { kind: 'respawn', jobId: 'bg-x', agentType: 'file-picker' },
      ])

      // Non-matching spawn markers must not count.
      journal.append('parent-bg', {
        eventType: 'spawn',
        stepNumber: 1,
        correlation: 'child-a',
        payload: 'bg-x',
      })
      journal.append('parent-bg', {
        eventType: 'spawn',
        stepNumber: 2,
        correlation: 'child-b',
        payload: { respawnOf: 'other' },
      })
      expect(plan()).toEqual([
        { kind: 'respawn', jobId: 'bg-x', agentType: 'file-picker' },
      ])

      journal.append('parent-bg', {
        eventType: 'spawn',
        stepNumber: 3,
        correlation: 'child-respawn',
        payload: { respawnOf: 'bg-x' },
      })
      const respawnSeq = journal.lastEvent('parent-bg')!.seq
      expect(plan()).toEqual([
        { kind: 'already_respawned', jobId: 'bg-x', respawnSpawnSeq: respawnSeq },
      ])
    } finally {
      journal.close()
    }
  })

  it('custom isRerunnable overrides the default allowlist', () => {
    expect(
      planBackgroundAgentResume({
        intents: [interrupted('bg-e', 'editor')],
        isRerunnable: () => true,
      }),
    ).toEqual([{ kind: 'respawn', jobId: 'bg-e', agentType: 'editor' }])
    expect(
      planBackgroundAgentResume({
        intents: [interrupted('bg-f', 'file-picker')],
        isRerunnable: () => false,
      }),
    ).toEqual([
      {
        kind: 'needs_confirmation',
        jobId: 'bg-f',
        agentType: 'file-picker',
        reason: expect.any(String),
      },
    ])
  })

  it('default allowlist excludes side-effecting agents', () => {
    expect(DEFAULT_RERUNNABLE_BACKGROUND_AGENT_TYPES.has('editor')).toBe(false)
    expect(DEFAULT_RERUNNABLE_BACKGROUND_AGENT_TYPES.has('basher')).toBe(false)
  })
})
