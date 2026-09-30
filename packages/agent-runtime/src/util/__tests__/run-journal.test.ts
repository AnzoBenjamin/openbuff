import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'

import { reconcileInterruptedBackgroundAgentIntents } from '../background-agent-jobs'
import {
  buildRunResumeReport,
  classifyChildRun,
  classifyRunResume,
  createRunJournal,
  executeReplayActions,
  isRunResumeReportClean,
  DEFAULT_RERUNNABLE_BACKGROUND_AGENT_TYPES,
  executeChildReplay,
  planBackgroundAgentResume,
  planChildResume,
  planReplayActions,
} from '../run-journal'
import type {
  BackgroundResumeDecision,
  ReplayAction,
  RunResumeReport,
} from '../run-journal'

import type { JournalReader } from '@codebuff/common/types/contracts/agent-runtime'
import type { Logger } from '@codebuff/common/types/contracts/logger'
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

  it('toolResultFor returns the newest attempt-completing tool_result payload, else undefined', () => {
    const journal = makeJournal()
    try {
      // Canonical shape: every attempt journals its tool_call boundary
      // BEFORE its tool_result.
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'call-x',
        payload: { toolName: 'toolX' },
      })
      journal.append('run-1', {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 'call-x',
        payload: { result: 'first' },
      })
      // A retry reuses the same correlation and completes again.
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 1,
        correlation: 'call-x',
        payload: { toolName: 'toolX' },
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

  it("toolResultFor resolves nothing for an in-flight retried tool call (an earlier attempt's result is stale)", () => {
    const journal = makeJournal()
    try {
      // Attempt 1 completed...
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'call-r',
        payload: { toolName: 'run_terminal_command' },
      })
      journal.append('run-1', {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 'call-r',
        payload: { result: 'attempt-1' },
      })
      // ...and a retry reusing the same correlation was killed mid-flight:
      // its tool_call is journaled but no tool_result follows it. The newest
      // matching tool_result is the EARLIER attempt's, which the replay
      // cross-check must not reuse — reusing it would skip re-execution of a
      // genuinely in-flight side-effecting tool call.
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 1,
        correlation: 'call-r',
        payload: { toolName: 'run_terminal_command' },
      })
      expect(journal.toolResultFor('run-1', 'call-r')).toBeUndefined()
      // classifyRunResume's seq-bounded guard and toolResultFor agree: the
      // tail is in-flight and the replay path re-executes it live.
      expect(classifyRunResume(journal, 'run-1')).toEqual({
        kind: 'in_flight_tool',
        toolCallId: 'call-r',
      })
    } finally {
      journal.close()
    }
  })

  it('toolResultFor fails closed when no tool_call with the correlation exists', () => {
    const journal = makeJournal()
    try {
      // A tool_result without its tool_call boundary cannot prove any
      // attempt of the call completed, so the replay path re-executes live
      // instead of reusing it.
      journal.append('run-1', {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 'orphan',
        payload: { result: 'orphan-result' },
      })
      expect(journal.toolResultFor('run-1', 'orphan')).toBeUndefined()
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

  it('classifies a tool_call tail with a null correlation as in_flight_tool, not clean', () => {
    const journal = makeJournal()
    try {
      // A null-correlation tool_call is the documented in-flight tail shape:
      // with no correlation no later tool_result can ever match, so the call
      // can never be proven complete. Classifying it clean would skip the
      // toolResultFor cross-check and could re-execute a side-effecting call.
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: null,
        payload: { toolName: 'write_file' },
      })
      const classification = classifyRunResume(journal, 'run-1')
      expect(classification.kind).toBe('in_flight_tool')
      if (classification.kind === 'in_flight_tool') {
        // toolResultFor('run-1', '') resolves nothing, so the replay path
        // re-executes under live control instead of silently skipping.
        expect(journal.toolResultFor('run-1', classification.toolCallId)).toBe(
          undefined,
        )
      }
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

  it("classifies a null-correlation llm_request tail as in_flight_llm, never clean", () => {
    const journal = makeJournal()
    try {
      // A null-correlation llm_request is in-flight by construction: the
      // null guard in the llm_request branch (same as the tool_call branch)
      // makes the response scan fail-closed — without it, `null === null`
      // would let ANY later null-correlation llm_response complete an
      // unrelated request and misclassify this in-flight one as clean.
      journal.append('run-1', {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: null,
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

  it('a child killed between its last tool_result and the next llm_request is NOT completed', () => {
    const parentRunId = 'parent-5'
    const childRunId = 'child-5'
    const journal = makeJournal()
    try {
      journal.append(parentRunId, {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: childRunId,
        payload: { agentType: 'helper' },
      })
      // The child journaled a full tool round-trip and was kill-9'd right
      // after the tool_result, before the next llm_request — the exact crash
      // window classifyRunResume's 'clean' verdict covers. That verdict is a
      // resume-SAFETY verdict, not a completion verdict: the child's final
      // output does not exist yet.
      journal.append(childRunId, {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'cl5',
        payload: { model: 'm' },
      })
      journal.append(childRunId, {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'c5-tool',
        payload: { toolName: 'toolC5' },
      })
      journal.append(childRunId, {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 'c5-tool',
        payload: { result: null },
      })

      expect(classifyChildRun(journal, childRunId)).toEqual({
        kind: 'child_incomplete_tail',
        childRunId,
      })
      // The child must be reconciled (in-flight), never folded into
      // `awaiting` as if its final output exists.
      expect(planChildResume(journal, parentRunId)).toEqual({
        kind: 'needs_children',
        inFlight: [{ kind: 'child_incomplete_tail', childRunId }],
        awaiting: [],
      })
      expect(executeChildReplay(journal, childRunId)).toEqual({
        kind: 'live_execution_required',
        childRunId,
      })

      // An llm_response tail is likewise a non-terminal, mid-run tail.
      journal.append(childRunId, {
        eventType: 'llm_response',
        stepNumber: 1,
        correlation: 'cl5',
        payload: { messageId: 'm5' },
      })
      expect(classifyChildRun(journal, childRunId)).toEqual({
        kind: 'child_incomplete_tail',
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
      // The respawn marker alone is intent-only evidence: it settles the
      // re-plan only once the respawned child's own run reaches a terminal
      // journal tail. 'child-respawn' has no events yet, so the interrupted
      // intent is re-planned instead of being classified already_respawned.
      expect(plan()).toEqual([
        { kind: 'respawn', jobId: 'bg-x', agentType: 'file-picker' },
      ])

      journal.append('child-respawn', {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'cr0',
        payload: { model: 'm' },
      })
      // A lone in-flight llm_request tail is NOT terminal: the respawned
      // child may have crashed right after journaling it, so the marker must
      // stay unsettled and the interrupted intent keeps re-planning (see the
      // dedicated lone-in-flight-event test below).
      expect(plan()).toEqual([
        { kind: 'respawn', jobId: 'bg-x', agentType: 'file-picker' },
      ])

      // Once the respawned child's own run reaches a TERMINAL journal tail,
      // the marker settles and re-planning becomes idempotent.
      journal.append('child-respawn', {
        eventType: 'step_boundary',
        stepNumber: 1,
        correlation: 'cr-done',
        payload: { status: 'completed' },
      })
      const respawnSeq = journal.lastEvent('parent-bg')!.seq
      expect(plan()).toEqual([
        { kind: 'already_respawned', jobId: 'bg-x', respawnSpawnSeq: respawnSeq },
      ])
    } finally {
      journal.close()
    }
  })

  it('a respawn marker whose child never journaled anything re-plans instead of dropping the job', () => {
    const journal = makeJournal()
    try {
      // The respawn was journaled but the respawned child never started (or
      // died before journaling anything): 'child-never-started' has no events
      // of its own, so the marker must not settle the intent.
      journal.append('parent-bg-lost', {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child-never-started',
        payload: { respawnOf: 'bg-lost' },
      })

      // A rerunnable interrupted intent is re-spawned again...
      expect(
        planBackgroundAgentResume({
          intents: [interrupted('bg-lost', 'file-picker')],
          reader: journal,
          parentRunId: 'parent-bg-lost',
        }),
      ).toEqual([
        { kind: 'respawn', jobId: 'bg-lost', agentType: 'file-picker' },
      ])

      // ...and a non-rerunnable one is not silently dropped either: it falls
      // back to the confirmation path instead of already_respawned.
      expect(
        planBackgroundAgentResume({
          intents: [interrupted('bg-lost-editor', 'editor')],
          reader: journal,
          parentRunId: 'parent-bg-lost',
        }),
      ).toEqual([
        {
          kind: 'needs_confirmation',
          jobId: 'bg-lost-editor',
          agentType: 'editor',
          reason: expect.any(String),
        },
      ])
    } finally {
      journal.close()
    }
  })

  it('a respawned child that journaled a lone in-flight event and crashed keeps re-planning on every resume', () => {
    const journal = makeJournal()
    try {
      // The respawned child journaled exactly one event — an in-flight
      // llm_request with no matching response — and then crashed. That tail
      // is NOT terminal (classifyChildRun → child_in_flight_llm), so the
      // marker must never settle: classifying the intent already_respawned
      // would silently drop the job on every subsequent resume
      // (resume-from-own-journal for background agents is deferred) — the
      // exact silent-loss outcome the planner's invariant forbids.
      journal.append('parent-bg-lone', {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child-lone',
        payload: { respawnOf: 'bg-lone' },
      })
      journal.append('child-lone', {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'cl-0',
        payload: { model: 'm' },
      })

      const plan = () =>
        planBackgroundAgentResume({
          intents: [interrupted('bg-lone', 'file-picker')],
          reader: journal,
          parentRunId: 'parent-bg-lone',
        })

      // Every repeated resume keeps re-planning the interrupted job instead
      // of returning already_respawned forever.
      expect(plan()).toEqual([
        { kind: 'respawn', jobId: 'bg-lone', agentType: 'file-picker' },
      ])
      expect(plan()).toEqual([
        { kind: 'respawn', jobId: 'bg-lone', agentType: 'file-picker' },
      ])

      // A non-rerunnable agent type goes to confirmation, not silent loss.
      expect(
        planBackgroundAgentResume({
          intents: [interrupted('bg-lone-editor', 'editor')],
          reader: journal,
          parentRunId: 'parent-bg-lone',
        }),
      ).toEqual([
        {
          kind: 'needs_confirmation',
          jobId: 'bg-lone-editor',
          agentType: 'editor',
          reason: expect.any(String),
        },
      ])

      // Once the respawned child's run reaches a terminal tail, the same
      // marker settles and re-planning becomes idempotent.
      journal.append('child-lone', {
        eventType: 'step_boundary',
        stepNumber: 1,
        correlation: 'cl-done',
        payload: { status: 'completed' },
      })
      const expected: BackgroundResumeDecision[] = [
        {
          kind: 'already_respawned',
          jobId: 'bg-lone',
          respawnSpawnSeq: journal.lastEvent('parent-bg-lone')!.seq,
        },
      ]
      expect(plan()).toEqual(expected)
      expect(plan()).toEqual(expected)
    } finally {
      journal.close()
    }
  })

  it('a respawned child killed after a tool_result keeps its marker unsettled (job is re-planned, not dropped)', () => {
    const journal = makeJournal()
    try {
      journal.append('parent-bg-tool-result', {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child-tool-result',
        payload: { respawnOf: 'bg-tool-result' },
      })
      journal.append('child-tool-result', {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'ctr-0',
        payload: { model: 'm' },
      })
      journal.append('child-tool-result', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'ctr-tool',
        payload: { toolName: 'tool' },
      })
      journal.append('child-tool-result', {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 'ctr-tool',
        payload: { result: null },
      })

      // The tool_result tail is a resume-SAFETY 'clean' verdict, not a
      // terminal one: settling the marker here would permanently drop the
      // background job with no output delivered.
      expect(
        planBackgroundAgentResume({
          intents: [interrupted('bg-tool-result', 'file-picker')],
          reader: journal,
          parentRunId: 'parent-bg-tool-result',
        }),
      ).toEqual([
        { kind: 'respawn', jobId: 'bg-tool-result', agentType: 'file-picker' },
      ])
    } finally {
      journal.close()
    }
  })

  it('a later settled respawn marker is not masked by an earlier unsettled one', () => {
    const journal = makeJournal()
    try {
      // First respawn attempt: journaled, but the respawned child died before
      // journaling anything, so this marker never settles.
      journal.append('parent-bg-masked', {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child-attempt-1',
        payload: { respawnOf: 'bg-masked' },
      })
      // A later resume re-spawned the job again and THAT child completed.
      journal.append('parent-bg-masked', {
        eventType: 'spawn',
        stepNumber: 1,
        correlation: 'child-attempt-2',
        payload: { respawnOf: 'bg-masked' },
      })
      journal.append('child-attempt-2', {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'ca2-0',
        payload: { model: 'm' },
      })
      // The terminal step_boundary tail is what makes this marker settle.
      journal.append('child-attempt-2', {
        eventType: 'step_boundary',
        stepNumber: 1,
        correlation: 'ca2-done',
        payload: { status: 'completed' },
      })

      const plan = () =>
        planBackgroundAgentResume({
          intents: [interrupted('bg-masked', 'file-picker')],
          reader: journal,
          parentRunId: 'parent-bg-masked',
        })

      // Resolving only the FIRST matching marker would keep re-classifying
      // the job as 'respawn' on every resume — an unbounded duplicate-respawn
      // loop — because the later settled marker is what proves the job was
      // already respawned.
      const expected: BackgroundResumeDecision[] = [
        {
          kind: 'already_respawned',
          jobId: 'bg-masked',
          respawnSpawnSeq: journal.lastEvent('parent-bg-masked')!.seq,
        },
      ]
      expect(plan()).toEqual(expected)
      // Idempotent across repeated resumes: the settled marker keeps
      // suppressing re-respawn on every re-plan.
      expect(plan()).toEqual(expected)
    } finally {
      journal.close()
    }
  })

  it('a settled respawn marker permanently suppresses re-respawn even when a later marker is unsettled', () => {
    const journal = makeJournal()
    try {
      // The first respawn's child completed (its marker settles via the
      // terminal step_boundary tail)...
      journal.append('parent-bg-settled', {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child-settled',
        payload: { respawnOf: 'bg-settled' },
      })
      journal.append('child-settled', {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'cs-0',
        payload: { model: 'm' },
      })
      journal.append('child-settled', {
        eventType: 'step_boundary',
        stepNumber: 1,
        correlation: 'cs-done',
        payload: { status: 'completed' },
      })
      // ...and a later resume journaled another respawn whose child never
      // started. The settled marker still suppresses re-respawn.
      journal.append('parent-bg-settled', {
        eventType: 'spawn',
        stepNumber: 1,
        correlation: 'child-unsettled',
        payload: { respawnOf: 'bg-settled' },
      })

      expect(
        planBackgroundAgentResume({
          intents: [interrupted('bg-settled', 'file-picker')],
          reader: journal,
          parentRunId: 'parent-bg-settled',
        }),
      ).toEqual([
        {
          kind: 'already_respawned',
          jobId: 'bg-settled',
          respawnSpawnSeq: 0,
        },
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

describe('buildRunResumeReport (loop-entry resume view)', () => {
  it('an empty journal with no intents is clean', () => {
    const journal = makeJournal()
    try {
      const report = buildRunResumeReport({ reader: journal, runId: 'fresh' })
      expect(report).toEqual({
        runId: 'fresh',
        self: { kind: 'clean' },
        children: { kind: 'live_continue' },
        background: [],
      })
      expect(isRunResumeReportClean(report)).toBe(true)
    } finally {
      journal.close()
    }
  })

  it('combines an in-flight tool, an in-flight child, and an interrupted background intent', () => {
    const journal = makeJournal()
    try {
      journal.append('parent-r', {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child-r',
        payload: { agentType: 'helper' },
      })
      journal.append('parent-r', {
        eventType: 'tool_call',
        stepNumber: 1,
        correlation: 'tc-r',
        payload: { toolName: 'write_file' },
      })
      journal.append('child-r', {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'cl-r',
        payload: { model: 'm' },
      })

      const report = buildRunResumeReport({
        reader: journal,
        runId: 'parent-r',
        intents: [
          {
            jobId: 'bg-r',
            agentType: 'file-picker',
            status: 'interrupted',
            startedAt: 1_000,
            completedAt: 2_000,
          },
        ],
      })
      expect(report.self).toEqual({ kind: 'in_flight_tool', toolCallId: 'tc-r' })
      expect(report.children).toEqual({
        kind: 'needs_children',
        inFlight: [{ kind: 'child_in_flight_llm', childRunId: 'child-r' }],
        awaiting: [],
      })
      expect(report.background).toEqual([
        { kind: 'respawn', jobId: 'bg-r', agentType: 'file-picker' },
      ])
      expect(isRunResumeReportClean(report)).toBe(false)
    } finally {
      journal.close()
    }
  })
})

/**
 * P2-T2 final REPLAY SLICE: planReplayActions / executeReplayActions — the
 * pure planning→execution seam that ACTS on a RunResumeReport.
 */
describe('planReplayActions (pure planner over RunResumeReport)', () => {
  const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Logger

  const makeReport = (
    overrides: Partial<RunResumeReport> = {},
  ): RunResumeReport => ({
    runId: 'parent-p',
    self: { kind: 'clean' },
    children: { kind: 'live_continue' },
    background: [],
    ...overrides,
  })

  it('plans awaiting children as replay_child/replayed_completed', () => {
    const plan = planReplayActions(
      makeReport({
        children: {
          kind: 'needs_children',
          inFlight: [],
          awaiting: [
            { childRunId: 'child-a', childLastSeq: 3 },
            { childRunId: 'child-b', childLastSeq: 1 },
          ],
        },
      }),
    )
    expect(plan.actions).toEqual([
      {
        kind: 'replay_child',
        childRunId: 'child-a',
        verdict: 'replayed_completed',
      },
      {
        kind: 'replay_child',
        childRunId: 'child-b',
        verdict: 'replayed_completed',
      },
    ])
    expect(plan.truncated).toBeUndefined()
  })

  it('plans in-flight children as live_execution_required and unknown children as child_unknown', () => {
    const plan = planReplayActions(
      makeReport({
        children: {
          kind: 'needs_children',
          inFlight: [
            {
              kind: 'child_in_flight_tool',
              childRunId: 'child-t',
              toolCallId: 'tc',
            },
            { kind: 'child_in_flight_llm', childRunId: 'child-l' },
            { kind: 'child_incomplete_tail', childRunId: 'child-i' },
            { kind: 'child_unknown', childRunId: 'child-u' },
          ],
          awaiting: [],
        },
      }),
    )
    expect(plan.actions).toEqual([
      {
        kind: 'replay_child',
        childRunId: 'child-t',
        verdict: 'live_execution_required',
      },
      {
        kind: 'replay_child',
        childRunId: 'child-l',
        verdict: 'live_execution_required',
      },
      {
        kind: 'replay_child',
        childRunId: 'child-i',
        verdict: 'live_execution_required',
      },
      {
        kind: 'replay_child',
        childRunId: 'child-u',
        verdict: 'child_unknown',
      },
    ])
  })

  it('passes background respawn and needs_confirmation decisions through verbatim', () => {
    const plan = planReplayActions(
      makeReport({
        background: [
          { kind: 'respawn', jobId: 'bg-1', agentType: 'file-picker' },
          {
            kind: 'needs_confirmation',
            jobId: 'bg-2',
            agentType: 'editor',
            reason: 'agent type is not known to be idempotent',
          },
          { kind: 'skip_terminal', jobId: 'bg-3', status: 'completed' },
          { kind: 'still_running', jobId: 'bg-4' },
          {
            kind: 'already_respawned',
            jobId: 'bg-5',
            respawnSpawnSeq: 7,
          },
        ],
      }),
    )
    expect(plan.actions).toEqual([
      {
        kind: 'respawn_background',
        jobId: 'bg-1',
        agentType: 'file-picker',
      },
      {
        kind: 'needs_confirmation',
        jobId: 'bg-2',
        agentType: 'editor',
        reason: 'agent type is not known to be idempotent',
      },
    ])
  })

  it('plans no actions for a clean report', () => {
    const plan = planReplayActions(makeReport())
    expect(plan.actions).toEqual([])
    expect(plan.truncated).toBeUndefined()
  })

  it('is deterministic: repeated planning yields identical plans', () => {
    const report = makeReport({
      children: {
        kind: 'needs_children',
        inFlight: [{ kind: 'child_unknown', childRunId: 'child-u' }],
        awaiting: [{ childRunId: 'child-a', childLastSeq: 0 }],
      },
      background: [
        { kind: 'respawn', jobId: 'bg-1', agentType: 'file-picker' },
      ],
    })
    expect(planReplayActions(report)).toEqual(planReplayActions(report))
  })

  it('truncates children beyond maxReplays deterministically, recording the first dropped childRunId', () => {
    const awaiting = Array.from({ length: 5 }, (_, i) => ({
      childRunId: `child-${i}`,
      childLastSeq: i,
    }))
    const plan = planReplayActions(
      makeReport({
        children: { kind: 'needs_children', inFlight: [], awaiting },
      }),
      { maxReplays: 2 },
    )
    expect(plan.actions).toHaveLength(2)
    expect(plan.actions).toEqual([
      {
        kind: 'replay_child',
        childRunId: 'child-0',
        verdict: 'replayed_completed',
      },
      {
        kind: 'replay_child',
        childRunId: 'child-1',
        verdict: 'replayed_completed',
      },
    ])
    expect(plan.truncated).toEqual({
      kind: 'children',
      firstDroppedChildRunId: 'child-2',
    })
  })

  it('the cap covers in-flight children too and never truncates background actions', () => {
    const plan = planReplayActions(
      makeReport({
        children: {
          kind: 'needs_children',
          inFlight: [
            { kind: 'child_unknown', childRunId: 'child-inflight' },
          ],
          awaiting: [
            { childRunId: 'child-0', childLastSeq: 0 },
            { childRunId: 'child-1', childLastSeq: 1 },
          ],
        },
        background: [
          { kind: 'respawn', jobId: 'bg-1', agentType: 'file-picker' },
        ],
      }),
      { maxReplays: 1 },
    )
    // Planner order: awaiting first, then inFlight — child-inflight is the
    // first dropped child; the background action is never truncated.
    expect(plan.actions).toEqual([
      {
        kind: 'replay_child',
        childRunId: 'child-0',
        verdict: 'replayed_completed',
      },
      {
        kind: 'respawn_background',
        jobId: 'bg-1',
        agentType: 'file-picker',
      },
    ])
    expect(plan.truncated).toEqual({
      kind: 'children',
      firstDroppedChildRunId: 'child-1',
    })
  })

  it('defaults maxReplays to 8', () => {
    const awaiting = Array.from({ length: 10 }, (_, i) => ({
      childRunId: `child-${i}`,
      childLastSeq: i,
    }))
    const plan = planReplayActions(
      makeReport({
        children: { kind: 'needs_children', inFlight: [], awaiting },
      }),
    )
    expect(plan.actions).toHaveLength(8)
    expect(plan.truncated).toEqual({
      kind: 'children',
      firstDroppedChildRunId: 'child-8',
    })
  })
})

describe('executeReplayActions (seam driver)', () => {
  const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Logger

  const childAction = (
    childRunId: string,
    verdict: 'replayed_completed' | 'live_execution_required' | 'child_unknown',
  ): ReplayAction => ({ kind: 'replay_child', childRunId, verdict })

  it('invokes seams in planner order and counts attempts and successes', async () => {
    const calls: string[] = []
    const result = await executeReplayActions(
      [
        childAction('child-a', 'replayed_completed'),
        { kind: 'respawn_background', jobId: 'bg-1', agentType: 'file-picker' },
        {
          kind: 'needs_confirmation',
          jobId: 'bg-2',
          agentType: 'editor',
          reason: 'why',
        },
      ],
      {
        logger: noopLogger,
        replayChild: async (childRunId, verdict) => {
          calls.push(`replay:${childRunId}:${verdict}`)
        },
        respawnBackground: async (jobId, agentType) => {
          calls.push(`respawn:${jobId}:${agentType}`)
        },
        requestConfirmation: async () => true,
      },
    )
    expect(calls).toEqual([
      'replay:child-a:replayed_completed',
      'respawn:bg-1:file-picker',
    ])
    expect(result).toEqual({ attempted: 3, succeeded: 3, failed: [] })
  })

  it('skips every action when no seams are wired (additive-optional)', async () => {
    const result = await executeReplayActions(
      [
        childAction('child-a', 'replayed_completed'),
        { kind: 'respawn_background', jobId: 'bg-1', agentType: 'file-picker' },
        {
          kind: 'needs_confirmation',
          jobId: 'bg-2',
          agentType: 'editor',
          reason: 'why',
        },
      ],
      { logger: noopLogger },
    )
    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: [] })
  })

  it('a declined confirmation (requestConfirmation → false) is a SKIP, never auto-run', async () => {
    let confirmations = 0
    const result = await executeReplayActions(
      [
        {
          kind: 'needs_confirmation',
          jobId: 'bg-2',
          agentType: 'editor',
          reason: 'why',
        },
      ],
      {
        logger: noopLogger,
        requestConfirmation: async () => {
          confirmations += 1
          return false
        },
      },
    )
    expect(confirmations).toBe(1)
    expect(result.attempted).toBe(1)
    expect(result.succeeded).toBe(0)
    expect(result.failed).toEqual([])
  })

  it('a confirmed needs_confirmation action counts as succeeded', async () => {
    const result = await executeReplayActions(
      [
        {
          kind: 'needs_confirmation',
          jobId: 'bg-ok',
          agentType: 'file-picker',
          reason: 'why',
        },
      ],
      {
        logger: noopLogger,
        requestConfirmation: async () => true,
      },
    )
    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: [] })
  })

  it('a failed seam is recorded in failed[] with a bounded message and does not abort later actions', async () => {
    const calls: string[] = []
    const result = await executeReplayActions(
      [
        childAction('child-boom', 'live_execution_required'),
        childAction('child-after', 'replayed_completed'),
      ],
      {
        logger: noopLogger,
        replayChild: async (childRunId) => {
          if (childRunId === 'child-boom') {
            throw new Error('boom')
          }
          calls.push(childRunId)
        },
      },
    )
    expect(calls).toEqual(['child-after'])
    expect(result.attempted).toBe(2)
    expect(result.succeeded).toBe(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].action).toEqual(
      childAction('child-boom', 'live_execution_required'),
    )
    expect(result.failed[0].error).toBe('boom')
  })

  it('bounds long seam error messages', async () => {
    const result = await executeReplayActions(
      [childAction('child-long', 'replayed_completed')],
      {
        logger: noopLogger,
        replayChild: async () => {
          throw new Error('x'.repeat(1000))
        },
      },
    )
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].error.length).toBeLessThanOrEqual(304)
    expect(result.failed[0].error.endsWith('...')).toBe(true)
  })
})

describe('replay driver integration (report → plan → execute)', () => {
  it('drives a fixture journal through buildRunResumeReport → planReplayActions → executeReplayActions', async () => {
    const parentRunId = 'parent-driver'
    const journal = makeJournal()
    try {
      // Fixture: an awaiting child (completed cleanly), an in-flight child
      // (killed mid-tool), and an interrupted rerunnable background intent.
      journal.append(parentRunId, {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child-done',
        payload: { agentType: 'helper' },
      })
      journal.append('child-done', {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'cd0',
        payload: { model: 'm' },
      })
      journal.append('child-done', {
        eventType: 'step_boundary',
        stepNumber: 0,
        correlation: 'cd-done',
        payload: { status: 'completed' },
      })
      journal.append(parentRunId, {
        eventType: 'spawn',
        stepNumber: 1,
        correlation: 'child-crashed',
        payload: { agentType: 'helper' },
      })
      journal.append('child-crashed', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'cc-tool',
        payload: { toolName: 'write_file' },
      })

      const report = buildRunResumeReport({
        reader: journal,
        runId: parentRunId,
        intents: [
          {
            jobId: 'bg-driver',
            agentType: 'file-picker',
            status: 'interrupted',
            startedAt: 1_000,
            completedAt: 2_000,
          },
        ],
      })
      expect(isRunResumeReportClean(report)).toBe(false)

      const plan = planReplayActions(report)
      expect(plan.actions).toEqual([
        {
          kind: 'replay_child',
          childRunId: 'child-done',
          verdict: 'replayed_completed',
        },
        {
          kind: 'replay_child',
          childRunId: 'child-crashed',
          verdict: 'live_execution_required',
        },
        {
          kind: 'respawn_background',
          jobId: 'bg-driver',
          agentType: 'file-picker',
        },
      ])

      const calls: string[] = []
      const result = await executeReplayActions(plan.actions, {
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        } as unknown as Logger,
        replayChild: async (childRunId, verdict) => {
          calls.push(`replay:${childRunId}:${verdict}`)
        },
        respawnBackground: async (jobId, agentType) => {
          calls.push(`respawn:${jobId}:${agentType}`)
        },
      })
      expect(calls).toEqual([
        'replay:child-done:replayed_completed',
        'replay:child-crashed:live_execution_required',
        'respawn:bg-driver:file-picker',
      ])
      expect(result).toEqual({ attempted: 3, succeeded: 3, failed: [] })

      // The driver's seams are logging-only by contract: the journal was NOT
      // mutated (no reconciliation markers or terminal boundaries appended).
      expect(journal.events(parentRunId)).toHaveLength(2)
    } finally {
      journal.close()
    }
  })

  it('a clean report plans and executes nothing (fresh runs stay byte-identical)', async () => {
    const journal = makeJournal()
    try {
      const report = buildRunResumeReport({ reader: journal, runId: 'fresh' })
      expect(isRunResumeReportClean(report)).toBe(true)
      const plan = planReplayActions(report)
      let seamCalls = 0
      const result = await executeReplayActions(plan.actions, {
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        } as unknown as Logger,
        replayChild: async () => {
          seamCalls += 1
        },
        respawnBackground: async () => {
          seamCalls += 1
        },
      })
      expect(plan.actions).toEqual([])
      expect(seamCalls).toBe(0)
      expect(result).toEqual({ attempted: 0, succeeded: 0, failed: [] })
    } finally {
      journal.close()
    }
  })
})
