import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  RunJournal,
  RunResumeReport,
} from '../run-journal'

import type {
  JournalEvent,
  JournalReader,
} from '@codebuff/common/types/contracts/agent-runtime'
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

/** Unique on-disk path so a closed file-based journal can be re-opened. */
const tmpDbPath = () =>
  join(
    tmpdir(),
    `run-journal-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  )

/** makeJournal with slice-4 option overrides (retention/batching) + path. */
const makeJournalWith = (
  overrides: Partial<Parameters<typeof createRunJournal>[0]> = {},
  path = ':memory:',
) =>
  createRunJournal({
    path,
    clock: fixedClock,
    createDatabase: (p) => new Database(p),
    ...overrides,
  })

const stepEvent = (
  stepNumber: number,
  payload: unknown = { status: 'ok' },
): JournalEvent => ({
  eventType: 'step_boundary',
  stepNumber,
  correlation: `s${stepNumber}`,
  payload,
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

  it('an implementor without the optional slice-4 members still satisfies RunJournal', () => {
    // Slice 4 added flush/close/pruneRuns; they stay OPTIONAL on the exported
    // RunJournal interface (mirroring JournalWriter in the contracts file) so
    // a pre-slice-4 implementor of the exported interface is never broken by
    // an added required member. createRunJournal returns the required-member
    // superset (CreatedRunJournal) for its own callers.
    const minimal: RunJournal = {
      append: () => undefined,
      lastEvent: () => undefined,
      events: () => [],
      toolResultFor: () => undefined,
      toolResultForInput: () => undefined,
    }
    expect(minimal.append).toBeDefined()
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

  it('runIds enumerates the distinct runIds newest-first (P2-T7 dash extension)', () => {
    let now = 1_000
    const journal = makeJournalWith({ clock: { now: () => now } })
    try {
      journal.append('run-old', stepEvent(0))
      now = 2_000
      journal.append('run-mid', stepEvent(0))
      now = 3_000
      journal.append('run-new', stepEvent(0))
      // A later append to an OLD run must not promote it: the order keys on
      // each run's FIRST event (MIN(created_at)), not on the most recent
      // append.
      now = 2_500
      journal.append('run-old', stepEvent(1))
      expect(journal.runIds()).toEqual(['run-new', 'run-mid', 'run-old'])
    } finally {
      journal.close()
    }
  })

  it('runIds on an empty journal returns an empty array', () => {
    const journal = makeJournal()
    try {
      expect(journal.runIds()).toEqual([])
    } finally {
      journal.close()
    }
  })

  // P2-T7 background-children close race: a detached background subagent
  // launched during a turn outlives the turn's promise chain, which closes
  // the journal. The post-close append (the child's llm_request/llm_response
  // under its own runId) must be a fail-open no-op on the closed connection
  // — never a throw that would fail the background job itself.
  it('append after close is a fail-open no-op, never a throw on the closed connection', () => {
    const journal = makeJournal()
    journal.append('run-1', stepEvent(0))
    journal.close()
    expect(() =>
      journal.append('run-2', {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'late-background-child',
        payload: { model: 'm', messages: [] },
      }),
    ).not.toThrow()
    // A second post-close append (e.g. the paired llm_response) is equally
    // inert.
    expect(() =>
      journal.append('run-2', {
        eventType: 'llm_response',
        stepNumber: 0,
        correlation: 'late-background-child',
        payload: { messageId: null, fullResponse: '' },
      }),
    ).not.toThrow()
  })

  it('flush and close after close are no-ops (close is idempotent)', async () => {
    const journal = makeJournalWith({
      batching: { maxBatchEvents: 8, maxBatchDelayMs: 0 },
    })
    journal.append('run-1', stepEvent(0))
    await journal.close()
    // The post-close flush must resolve (draining nothing) and a second
    // close must resolve without touching the closed database.
    await expect(journal.flush()).resolves.toBeUndefined()
    await expect(journal.close()).resolves.toBeUndefined()
  })

  // P2-T2-DESIGN §5 (replay requires reproducible ids): the deterministic
  // short-circuit keys on the journaled tool_call PAYLOAD (toolName + input),
  // NOT the freshly-minted toolCallId, so it reproduces across a restart.
  it('toolResultForInput matches a journaled call by toolName+input regardless of its correlation', () => {
    const journal = makeJournal()
    try {
      // The pre-crash toolCallId ('random-uuid-1') is NOT reproduced on resume:
      // the lookup must still find the journaled result via toolName+input.
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'random-uuid-1',
        payload: { toolName: 'write_file', input: { path: 'a.ts' } },
      })
      journal.append('run-1', {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 'random-uuid-1',
        payload: { toolName: 'write_file', result: [{ type: 'json', value: 1 }] },
      })
      expect(
        journal.toolResultForInput('run-1', 'write_file', { path: 'a.ts' }, 0),
      ).toEqual({
        toolName: 'write_file',
        result: [{ type: 'json', value: 1 }],
      })
      // A different input or toolName does not match.
      expect(
        journal.toolResultForInput('run-1', 'write_file', { path: 'b.ts' }, 0),
      ).toBeUndefined()
      expect(
        journal.toolResultForInput('run-1', 'read_files', { path: 'a.ts' }, 0),
      ).toBeUndefined()
    } finally {
      journal.close()
    }
  })

  it('toolResultForInput matches input structurally (key order does not matter)', () => {
    const journal = makeJournal()
    try {
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'c-order',
        payload: { toolName: 'read_files', input: { a: 1, b: 2 } },
      })
      journal.append('run-1', {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 'c-order',
        payload: { result: 'ok' },
      })
      // The same input with keys enumerated in a different order must match:
      // on resume the input is re-derived, not the key order.
      expect(
        journal.toolResultForInput('run-1', 'read_files', { b: 2, a: 1 }, 0),
      ).toEqual({ result: 'ok' })
    } finally {
      journal.close()
    }
  })

  it('toolResultForInput consumes duplicate identical calls in seq order (occurrence)', () => {
    const journal = makeJournal()
    try {
      // The SAME tool called TWICE with an identical input in one run: each
      // journaled tool_call has a distinct correlation and result. Consuming
      // occurrences 0 then 1 resolves them deterministically in seq order.
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'dup-1',
        payload: { toolName: 'run_terminal_command', input: { command: 'ls' } },
      })
      journal.append('run-1', {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 'dup-1',
        payload: { result: 'first' },
      })
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 1,
        correlation: 'dup-2',
        payload: { toolName: 'run_terminal_command', input: { command: 'ls' } },
      })
      journal.append('run-1', {
        eventType: 'tool_result',
        stepNumber: 1,
        correlation: 'dup-2',
        payload: { result: 'second' },
      })
      const input = { command: 'ls' }
      expect(
        journal.toolResultForInput('run-1', 'run_terminal_command', input, 0),
      ).toEqual({ result: 'first' })
      expect(
        journal.toolResultForInput('run-1', 'run_terminal_command', input, 1),
      ).toEqual({ result: 'second' })
      // A third occurrence has no journaled match.
      expect(
        journal.toolResultForInput('run-1', 'run_terminal_command', input, 2),
      ).toBeUndefined()

      // A FRESH occurrence counter (a resumed process whose in-memory replay
      // consumption state was lost to kill-9) reads the same journaled results
      // in the same seq order — the cross-restart determinism §5 requires.
      const resumeCounter = new Map<string, number>()
      const nextOccurrence = () => {
        const key = `run_terminal_command\u0000${JSON.stringify(input)}`
        const n = resumeCounter.get(key) ?? 0
        resumeCounter.set(key, n + 1)
        return n
      }
      const resumedResults = [
        journal.toolResultForInput(
          'run-1',
          'run_terminal_command',
          input,
          nextOccurrence(),
        ),
        journal.toolResultForInput(
          'run-1',
          'run_terminal_command',
          input,
          nextOccurrence(),
        ),
      ]
      expect(resumedResults).toEqual([{ result: 'first' }, { result: 'second' }])
    } finally {
      journal.close()
    }
  })

  it('toolResultForInput resolves undefined for a matched in-flight call (no later tool_result)', () => {
    const journal = makeJournal()
    try {
      // Matched tool_call but NO later tool_result: the call is in-flight, so
      // the caller must re-execute live rather than skip a side-effecting call.
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'inflight-1',
        payload: { toolName: 'write_file', input: { path: 'x.ts' } },
      })
      expect(
        journal.toolResultForInput('run-1', 'write_file', { path: 'x.ts' }, 0),
      ).toBeUndefined()
    } finally {
      journal.close()
    }
  })

  it('toolResultForInput fails closed for a matched call with a null correlation', () => {
    const journal = makeJournal()
    try {
      journal.append('run-1', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: null,
        payload: { toolName: 'write_file', input: { path: 'y.ts' } },
      })
      expect(
        journal.toolResultForInput('run-1', 'write_file', { path: 'y.ts' }, 0),
      ).toBeUndefined()
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
          // The pre-crash correlation is a random id (realIdGen.uuid()), which
          // is NEVER reproduced on resume — the deterministic short-circuit
          // must match on toolName+input instead (P2-T2-DESIGN §5).
          id: 'uuid-pre-crash-A',
          toolName: 'toolA',
          input: { op: 'write', path: 'a.ts' },
          execute: () => {
            sideEffectCount++
            return { result: 'A-done' }
          },
        },
        {
          id: 'uuid-pre-crash-B',
          toolName: 'toolB',
          input: { op: 'write', path: 'b.ts' },
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
        correlation: scripted[0].id,
        payload: { toolName: scripted[0].toolName, input: scripted[0].input },
      })
      const aResult = scripted[0].execute()
      journal.append(runId, {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: scripted[0].id,
        payload: aResult,
      })
      expect(sideEffectCount).toBe(1)

      // Tool B's call is journaled but the process is kill-9'd before its
      // tool_result is written — the crash window.
      journal.append(runId, {
        eventType: 'tool_call',
        stepNumber: 1,
        correlation: scripted[1].id,
        payload: { toolName: scripted[1].toolName, input: scripted[1].input },
      })

      // Classification sees B as in-flight.
      expect(classifyRunResume(journal, runId)).toEqual({
        kind: 'in_flight_tool',
        toolCallId: scripted[1].id,
      })

      // --- Phase 2: resume via an inline replay driver ---
      // Mirrors the fixed executeSingleToolCall §4c short-circuit: mint a
      // FRESH id per call (the pre-crash correlation is never reproduced), then
      // short-circuit on the journaled toolName+input, consuming occurrences in
      // order so duplicate identical inputs resolve deterministically.
      const replayDriver = (
        reader: JournalReader,
        id: string,
        script: typeof scripted,
      ) => {
        const consumedByKey = new Map<string, number>()
        for (const call of script) {
          const freshId = `uuid-resumed-${call.toolName}` // new random id on resume
          const key = `${call.toolName}\u0000${JSON.stringify(call.input)}`
          const occurrence = consumedByKey.get(key) ?? 0
          consumedByKey.set(key, occurrence + 1)
          const recorded = reader.toolResultForInput(
            id,
            call.toolName,
            call.input,
            occurrence,
          )
          if (recorded !== undefined) {
            // Idempotency short-circuit: reuse the recorded result, do NOT
            // re-run the live executor.
            continue
          }
          // Canonical attempt shape: journal the fresh tool_call boundary
          // BEFORE executing (this append is the crash window if the resumed
          // process is itself kill-9'd mid-tool), then the tool_result under
          // the same fresh correlation.
          journal.append(id, {
            eventType: 'tool_call',
            stepNumber: 1,
            correlation: freshId,
            payload: { toolName: call.toolName, input: call.input },
          })
          const live = call.execute()
          journal.append(id, {
            eventType: 'tool_result',
            stepNumber: 1,
            correlation: freshId,
            payload: live,
          })
        }
      }

      replayDriver(journal, runId, scripted)

      // A was NOT re-executed (would push count to 3); B executed live once.
      // Final count is 2: A(pre-crash) + B(resume).
      expect(sideEffectCount).toBe(2)

      // The run reaches completion with both tool_results now journaled,
      // resolvable by the deterministic toolName+input key.
      expect(
        journal.toolResultForInput(runId, 'toolA', { op: 'write', path: 'a.ts' }, 0),
      ).toEqual({ result: 'A-done' })
      expect(
        journal.toolResultForInput(runId, 'toolB', { op: 'write', path: 'b.ts' }, 0),
      ).toEqual({ result: 'B-done' })
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

describe('P2-T2 slice 4: retention/rotation', () => {
  it('maxEvents: deletes the oldest rows beyond the cap and keeps the newest', () => {
    const journal = makeJournalWith({ retention: { maxEvents: 5 } })
    try {
      for (let i = 0; i < 15; i++) {
        journal.append('run-ret', stepEvent(i))
      }
      const events = journal.events('run-ret')
      expect(events.length).toBeLessThanOrEqual(5)
      expect(events.map((e) => e.seq)).toEqual([10, 11, 12, 13, 14])
    } finally {
      journal.close()
    }
  })

  it('maxEvents: classifyRunResume still classifies the retained tail (ordering by seq, not row count)', () => {
    const journal = makeJournalWith({ retention: { maxEvents: 4 } })
    try {
      for (let i = 0; i < 10; i++) journal.append('run-gap', stepEvent(i))
      journal.append('run-gap', {
        eventType: 'tool_call',
        stepNumber: 10,
        correlation: 'tool-1',
        payload: { toolName: 'write_file' },
      })
      // Only the newest maxEvents rows survive; the in-flight tool_call tail
      // is still classified correctly because readers order by seq.
      expect(journal.events('run-gap')).toHaveLength(4)
      expect(classifyRunResume(journal, 'run-gap')).toEqual({
        kind: 'in_flight_tool',
        toolCallId: 'tool-1',
      })
    } finally {
      journal.close()
    }
  })

  it('maxBytes: deletes the oldest rows until payload bytes fit the cap, never dropping the newest', () => {
    // stepEvent's default payload serializes to 15 bytes.
    const journal = makeJournalWith({ retention: { maxBytes: 100 } })
    try {
      for (let i = 0; i < 20; i++) journal.append('run-bytes', stepEvent(i))
      const events = journal.events('run-bytes')
      const totalBytes = events.reduce(
        (sum, e) => sum + JSON.stringify(e.payload).length,
        0,
      )
      expect(totalBytes).toBeLessThanOrEqual(100)
      expect(events.length).toBeGreaterThan(0)
      expect(events[events.length - 1].seq).toBe(19)
      expect(events[0].seq).toBeGreaterThan(0)
    } finally {
      journal.close()
    }
  })

  it('maxBytes: the newest row is retained even when it alone exceeds the cap', () => {
    const journal = makeJournalWith({ retention: { maxBytes: 5 } })
    try {
      journal.append('run-big', stepEvent(0))
      expect(journal.events('run-big')).toHaveLength(1)
    } finally {
      journal.close()
    }
  })

  it('maxBytes counts UTF-8 bytes, not characters (multibyte payloads)', () => {
    // Each payload serializes to ~39 CHARACTERS but ~69 UTF-8 BYTES, so a
    // character-based LENGTH(payload) count would under-count by nearly
    // half and retain a tail whose true byte size exceeds the cap.
    const journal = makeJournalWith({ retention: { maxBytes: 100 } })
    try {
      const payload = { note: 'é'.repeat(30) }
      for (let i = 0; i < 4; i++) {
        journal.append('run-utf8', stepEvent(i, payload))
      }
      const events = journal.events('run-utf8')
      const totalBytes = events.reduce(
        (sum, e) =>
          sum + Buffer.byteLength(JSON.stringify(e.payload), 'utf8'),
        0,
      )
      expect(totalBytes).toBeLessThanOrEqual(100)
      expect(events.length).toBeGreaterThan(0)
      // The newest row is never dropped.
      expect(events[events.length - 1].seq).toBe(3)
    } finally {
      journal.close()
    }
  })

  it('pruneRuns deletes rows for other runIds and drops their buffered events', async () => {
    const journal = makeJournalWith({
      batching: { maxBatchEvents: 32, maxBatchDelayMs: 60_000 },
    })
    try {
      for (let i = 0; i < 3; i++) journal.append('keep-a', stepEvent(i))
      for (let i = 0; i < 3; i++) journal.append('drop-b', stepEvent(i))
      await journal.flush()
      journal.append('drop-b', stepEvent(3)) // buffered only
      journal.pruneRuns(['keep-a'])
      expect(journal.events('keep-a')).toHaveLength(3)
      expect(journal.events('drop-b')).toHaveLength(0)
      await journal.flush()
      expect(journal.events('drop-b')).toHaveLength(0)
    } finally {
      journal.close()
    }
  })
})

describe('P2-T2 slice 4: hot-path batching', () => {
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))

  it('without batching, appends are durable immediately (flush-per-append default)', async () => {
    const journal = makeJournalWith()
    try {
      journal.append('run-sync', stepEvent(0))
      journal.append('run-sync', stepEvent(1))
      expect(journal.events('run-sync').map((e) => e.seq)).toEqual([0, 1])
      await journal.flush()
      expect(journal.events('run-sync')).toHaveLength(2)
    } finally {
      await journal.close()
    }
  })

  it('buffers appends and drains when maxBatchEvents is reached', () => {
    const journal = makeJournalWith({ batching: { maxBatchEvents: 4 } })
    try {
      for (let i = 0; i < 3; i++) journal.append('run-batch', stepEvent(i))
      expect(journal.events('run-batch')).toHaveLength(0)
      journal.append('run-batch', stepEvent(3))
      expect(journal.events('run-batch').map((e) => e.seq)).toEqual([
        0, 1, 2, 3,
      ])
    } finally {
      journal.close()
    }
  })

  it('flush() drains buffered events before the delay timer elapses', async () => {
    const journal = makeJournalWith({
      batching: { maxBatchEvents: 32, maxBatchDelayMs: 60_000 },
    })
    try {
      for (let i = 0; i < 5; i++) journal.append('run-flush', stepEvent(i))
      expect(journal.events('run-flush')).toHaveLength(0)
      await journal.flush()
      expect(journal.events('run-flush').map((e) => e.seq)).toEqual([
        0, 1, 2, 3, 4,
      ])
    } finally {
      journal.close()
    }
  })

  it('flushes buffered events after maxBatchDelayMs elapses', async () => {
    const journal = makeJournalWith({
      batching: { maxBatchEvents: 32, maxBatchDelayMs: 10 },
    })
    try {
      for (let i = 0; i < 5; i++) journal.append('run-delay', stepEvent(i))
      expect(journal.events('run-delay')).toHaveLength(0)
      await sleep(50)
      expect(journal.events('run-delay')).toHaveLength(5)
    } finally {
      journal.close()
    }
  })

  it('close() flushes buffered events so a reopened journal sees them', async () => {
    const path = tmpDbPath()
    const journal = makeJournalWith(
      { batching: { maxBatchEvents: 32, maxBatchDelayMs: 60_000 } },
      path,
    )
    for (let i = 0; i < 3; i++) journal.append('run-close', stepEvent(i))
    await journal.close()
    const reopened = makeJournalWith({}, path)
    try {
      expect(reopened.events('run-close').map((e) => e.seq)).toEqual([0, 1, 2])
    } finally {
      await reopened.close()
    }
  })

  it('kill-9 classification still sees a flushed tool_call tail on a batched journal', async () => {
    const journal = makeJournalWith({ batching: { maxBatchEvents: 32 } })
    try {
      journal.append('run-kill', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'k-tool',
        payload: { toolName: 'write_file' },
      })
      // Not durable until flushed.
      expect(journal.events('run-kill')).toHaveLength(0)
      await journal.flush()
      expect(classifyRunResume(journal, 'run-kill')).toEqual({
        kind: 'in_flight_tool',
        toolCallId: 'k-tool',
      })
    } finally {
      journal.close()
    }
  })
})

describe('P2-T2 slice-4 hardening: retention O(1), forceFlush, close-on-throw, bounded reads', () => {
  /**
   * Journal over a COUNTING createDatabase seam: tallies PREPARES of the
   * over-cap byte walk's phase-1 seq-page statement (the statement the
   * O(rows-walked) two-phase walk uses on over-cap appends — the O(n)
   * greedy per-append scan byte retention used to run on EVERY append)
   * and can fail every BEGIN IMMEDIATE with a NON-busy error to exercise
   * the close() drain-throw path.
   */
  const makeCountingJournal = (
    overrides: Partial<Parameters<typeof createRunJournal>[0]> = {},
  ) => {
    let walkPrepares = 0
    let failBegins = false
    const journal = createRunJournal({
      path: ':memory:',
      clock: fixedClock,
      createDatabase: (p) => {
        const db = new Database(p)
        return {
          run: (sql: string, ...params: unknown[]) => {
            if (failBegins && sql === 'BEGIN IMMEDIATE;') {
              throw new Error('injected non-busy failure')
            }
            return (
              db as unknown as {
                run: (sql: string, ...params: unknown[]) => unknown
              }
            ).run(sql, ...params)
          },
          query: (sql: string) => {
            // The two-phase over-cap walk's phase-1 seq page — the only
            // statement that pages the run's index on the byte path (the
            // old combined (seq, LENGTH) page statement no longer exists).
            if (
              sql.startsWith(
                'SELECT seq FROM run_events WHERE run_id = ? AND seq > ?',
              )
            ) {
              walkPrepares += 1
            }
            return (
              db as unknown as {
                query: (sql: string) => {
                  all: (...params: unknown[]) => unknown[]
                  get: (...params: unknown[]) => unknown
                }
              }
            ).query(sql)
          },
          close: () => {
            ;(db as unknown as { close: () => void }).close()
          },
        }
      },
      ...overrides,
    })
    return {
      journal,
      scanned: () => walkPrepares,
      setFailBegins: (value: boolean) => {
        failBegins = value
      },
    }
  }

  it('maxBytes retention no longer full-scans the run on every append while under the cap', () => {
    const { journal, scanned } = makeCountingJournal({
      retention: { maxBytes: 100_000 },
    })
    try {
      for (let i = 0; i < 50; i++) journal.append('run-fast', stepEvent(i))
      // 50 appends with a far-away byte cap: the over-cap walk is never
      // even PREPARED (the side-table-seeded cached total stays under the
      // cap and each append only O(1)-increments it).
      expect(scanned()).toBe(0)
      // Behavior equivalence: nothing was dropped.
      expect(journal.events('run-fast').map((e) => e.seq)).toEqual(
        Array.from({ length: 50 }, (_, i) => i),
      )
    } finally {
      journal.close()
    }
  })

  it('byte-cap cache seeding is lazy per runId: open no longer scans every journaled run', async () => {
    // The deleted eager open-time seed ran ONE GROUP-BY-over-all-runs
    // SUM(LENGTH(CAST(payload AS BLOB))) when a byte-capped journal opened —
    // O(all runs ever journaled) on the synchronous open path. After the fix
    // open is O(1): no run's byte total is read at open, and each runId's
    // total is seeded lazily on first use (the per-run recompute query in
    // enforceRetention, plus the O(1) per-append increment in insertEvent).
    const path = tmpDbPath()
    // Seed an on-disk db with events on 'other-run' under a far-away byte
    // cap so nothing is deleted; reopening this db must not scan these rows.
    const seeder = makeJournalWith(
      { retention: { maxEvents: 20_000, maxBytes: 512 * 1024 * 1024 } },
      path,
    )
    try {
      for (let i = 0; i < 30; i++) seeder.append('other-run', stepEvent(i))
    } finally {
      await seeder.close()
    }

    // Counting wrapper mirroring makeCountingJournal above, tallying two
    // distinct query prefixes: the deleted eager open-time seed ('SELECT
    // run_id, COALESCE(SUM' — GROUP BY over ALL runs) and the per-run lazy
    // recompute ('SELECT COALESCE(SUM' — one runId).
    let seedScans = 0
    let perRunRecomputes = 0
    const journal = createRunJournal({
      path,
      clock: fixedClock,
      retention: { maxEvents: 20_000, maxBytes: 4096 },
      createDatabase: (p) => {
        const db = new Database(p)
        return {
          run: (sql: string, ...params: unknown[]) => {
            return (
              db as unknown as {
                run: (sql: string, ...params: unknown[]) => unknown
              }
            ).run(sql, ...params)
          },
          query: (sql: string) => {
            if (sql.startsWith('SELECT run_id, COALESCE(SUM')) {
              seedScans += 1
            }
            if (sql.startsWith('SELECT COALESCE(SUM')) {
              perRunRecomputes += 1
            }
            return (
              db as unknown as {
                query: (sql: string) => {
                  all: (...params: unknown[]) => unknown[]
                  get: (...params: unknown[]) => unknown
                }
              }
            ).query(sql)
          },
          close: () => {
            ;(db as unknown as { close: () => void }).close()
          },
        }
      },
    })
    try {
      // Open-time invariant: the eager seed scan must never run at open...
      expect(seedScans).toBe(0)
      // ...and nothing is read lazily at open either (open is O(1)).
      expect(perRunRecomputes).toBe(0)

      // ~1024-byte payloads ({"blob":"…"} serializes to exactly 1024 bytes):
      // 10 events exceed the 4096-byte cap, so retention must enforce the
      // cap for 'late-run' — seeding its byte total lazily on first use.
      const bigPayload = { blob: 'x'.repeat(1013) }
      for (let i = 0; i < 10; i++) {
        journal.append('late-run', stepEvent(i, bigPayload))
      }

      // The per-run lazy seeding/recompute fired for 'late-run', while the
      // eager open-time seed never ran at all.
      expect(seedScans).toBe(0)
      expect(perRunRecomputes).toBeGreaterThan(0)

      // Retention behavior is unchanged: the newest seq survives and the
      // retained payload bytes fit the cap.
      const lateEvents = journal.events('late-run')
      expect(lateEvents[lateEvents.length - 1].seq).toBe(9)
      const totalBytes = lateEvents.reduce(
        (sum, e) => sum + JSON.stringify(e.payload).length,
        0,
      )
      expect(totalBytes).toBeLessThanOrEqual(4096)

      // The other run's rows are untouched by lazy seeding.
      expect(journal.events('other-run')).toHaveLength(30)
    } finally {
      await journal.close()
    }
  })

  it('reopen enforces the byte cap over historical bytes via the persisted run_byte_totals side table', async () => {
    // Regression for the lazy-seed ordering defect: insertEvent used to seed
    // an absent per-run byte total with ONLY the new event's bytes and ran
    // BEFORE enforceRetention, so any runId that already had rows in the db
    // (kill-9 crash-resume, a persistent runId re-opened per send) never had
    // its historical bytes counted — the cap never fired. The persisted
    // run_byte_totals side table (maintained inside the same transaction as
    // each append) makes the historical total durable: journal B's FIRST
    // append to the reopened runId must enforce the cap over historical +
    // new bytes.
    const path = tmpDbPath()
    // Journal A: 10 ~1024-byte-payload events on 'persist-run' under a
    // far-away byte cap so nothing is deleted; its side row lands at the
    // exact historical total (10 × 1024 = 10240).
    const seeder = makeJournalWith(
      { retention: { maxEvents: 20_000, maxBytes: 512 * 1024 * 1024 } },
      path,
    )
    try {
      const bigPayload = { blob: 'x'.repeat(1013) }
      for (let i = 0; i < 10; i++) {
        seeder.append('persist-run', stepEvent(i, bigPayload))
      }
    } finally {
      await seeder.close()
    }

    // Journal B over the same path, with a counting wrapper mirroring
    // makeCountingJournal above: tallies the persisted side-table reads
    // ('SELECT total_bytes' — a prefix no other journal SQL uses, so the
    // counted SUM prefixes keep their exact meanings) to prove the cap
    // decision now consumes the persisted historical total.
    let sideReads = 0
    const journal = createRunJournal({
      path,
      clock: fixedClock,
      retention: { maxEvents: 20_000, maxBytes: 4096 },
      createDatabase: (p) => {
        const db = new Database(p)
        return {
          run: (sql: string, ...params: unknown[]) => {
            return (
              db as unknown as {
                run: (sql: string, ...params: unknown[]) => unknown
              }
            ).run(sql, ...params)
          },
          query: (sql: string) => {
            if (sql.startsWith('SELECT total_bytes')) {
              sideReads += 1
            }
            return (
              db as unknown as {
                query: (sql: string) => {
                  all: (...params: unknown[]) => unknown[]
                  get: (...params: unknown[]) => unknown
                }
              }
            ).query(sql)
          },
          close: () => {
            ;(db as unknown as { close: () => void }).close()
          },
        }
      },
    })
    try {
      // ONE append to the reopened runId: a fresh ~1024-byte payload.
      journal.append('persist-run', stepEvent(10, { blob: 'x'.repeat(1013) }))

      // Seq continues from the historical rows (gap-free MAX(seq) + 1).
      const events = journal.events('persist-run')
      expect(events[events.length - 1].seq).toBe(10)
      // Historical + new bytes exceeded the 4096 cap, so the oldest rows
      // were deleted. Under the broken ordering the total would have been
      // seeded as just the new event's 1024 bytes — under the cap — and
      // nothing would have been deleted (11 rows, ~11KB retained).
      expect(events.length).toBeLessThan(11)
      // The retained tail fits the cap.
      const totalBytes = events.reduce(
        (sum, e) => sum + JSON.stringify(e.payload).length,
        0,
      )
      expect(totalBytes).toBeLessThanOrEqual(4096)
      // The cap decision was served from the persisted side table.
      expect(sideReads).toBeGreaterThanOrEqual(1)
    } finally {
      await journal.close()
    }
  })

  it('a stale inflated run_byte_totals row self-heals on the first scan-only enforcement pass', async () => {
    // Regression for the stale-side-row defect: a crash between a retention
    // DELETE and the side-row re-persist leaves an inflated run_byte_totals
    // row, and getRunPayloadBytes trusts any present side row. Without a
    // scan-only self-heal, a stale-over-cap / exact-under-cap state re-ran
    // the full ordered greedy scan on EVERY append with no cut and no
    // correction — a per-send O(n) payload scan. The self-heal in the
    // byte-cap scan branch re-persists the exact total even when the pass
    // cuts nothing, restoring the O(1) fast path.
    const path = tmpDbPath()
    const bigPayload = { blob: 'x'.repeat(1013) }
    // Journal A: 4 ~1024-byte-payload events on 'stale-run' under a
    // far-away byte cap so nothing is deleted; its side row lands at the
    // exact historical total (4 × 1024).
    const seeder = makeJournalWith(
      { retention: { maxEvents: 20_000, maxBytes: 512 * 1024 * 1024 } },
      path,
    )
    try {
      for (let i = 0; i < 4; i++) {
        seeder.append('stale-run', stepEvent(i, bigPayload))
      }
    } finally {
      await seeder.close()
    }

    // Simulate the crash window: inflate the persisted side row directly on
    // the db file, exactly as a crash between a retention DELETE and the
    // side-row re-persist would leave it.
    const raw = new Database(path)
    raw.run(
      "UPDATE run_byte_totals SET total_bytes = 999999 WHERE run_id = 'stale-run'",
    )
    raw.close()

    // Journal B over the same file with a counting wrapper mirroring
    // makeCountingJournal above: tallies the per-run greedy byte scan. The
    // 8192 cap sits ABOVE the exact total (4 + 3 events × 1024 = 7168) but
    // BELOW the inflated 999999 side row, so the first append's scan must
    // cut nothing yet self-heal the side row.
    let scans = 0
    const journal = createRunJournal({
      path,
      clock: fixedClock,
      retention: { maxEvents: 20_000, maxBytes: 8192 },
      createDatabase: (p) => {
        const db = new Database(p)
        return {
          run: (sql: string, ...params: unknown[]) => {
            return (
              db as unknown as {
                run: (sql: string, ...params: unknown[]) => unknown
              }
            ).run(sql, ...params)
          },
          query: (sql: string) => {
            // The two-phase walk's phase-1 page statement (seq only; the
            // eager excessBoundary statement lacks the 'AND seq > ?' tail,
            // so this prefix uniquely identifies the walk's lazy prepare).
            if (
              sql.startsWith(
                'SELECT seq FROM run_events WHERE run_id = ? AND seq > ?',
              )
            ) {
              scans += 1
            }
            return (
              db as unknown as {
                query: (sql: string) => {
                  all: (...params: unknown[]) => unknown[]
                  get: (...params: unknown[]) => unknown
                }
              }
            ).query(sql)
          },
          close: () => {
            ;(db as unknown as { close: () => void }).close()
          },
        }
      },
    })
    try {
      for (let i = 0; i < 3; i++) {
        journal.append('stale-run', stepEvent(4 + i, bigPayload))
      }

      // Only the FIRST append ran the scan: the scan-only pass self-healed
      // the inflated side row (no cut — the exact total is under the cap),
      // so the later appends take the O(1) fast path instead of re-scanning
      // per append.
      expect(scans).toBe(1)
      // No rows were deleted by any pass.
      const events = journal.events('stale-run')
      expect(events).toHaveLength(7)
      expect(events[events.length - 1].seq).toBe(6)
      await journal.close()

      // The side row now holds the EXACT total — the sum over the retained
      // events — not the inflated 999999.
      const exactTotal = events.reduce(
        (sum, e) => sum + JSON.stringify(e.payload).length,
        0,
      )
      const verify = new Database(path)
      const row = verify
        .query('SELECT total_bytes FROM run_byte_totals WHERE run_id = ?')
        .get('stale-run') as { total_bytes: number } | undefined
      verify.close()
      expect(row?.total_bytes).toBe(exactTotal)
    } finally {
      await journal.close()
    }
  })

  it('maxBytes retention still enforces the cap once the cached total exceeds it', () => {
    // stepEvent's default payload serializes to 15 bytes, so the run goes
    // over the 60-byte cap at the fifth append.
    const { journal, scanned } = makeCountingJournal({
      retention: { maxBytes: 60 },
    })
    try {
      for (let i = 0; i < 20; i++) journal.append('run-cap', stepEvent(i))
      const events = journal.events('run-cap')
      const totalBytes = events.reduce(
        (sum, e) => sum + JSON.stringify(e.payload).length,
        0,
      )
      expect(totalBytes).toBeLessThanOrEqual(60)
      expect(events.length).toBeGreaterThan(0)
      expect(events[events.length - 1].seq).toBe(19)
      // The over-cap walk's phase-1 seq-page statement was PREPARED
      // exactly ONCE (lazily, on the first over-cap append) and reused for
      // every subsequent over-cap append — a per-append query-object
      // regression would tally one per over-cap append instead.
      expect(scanned()).toBe(1)
    } finally {
      journal.close()
    }
  })

  it('forceFlush drains buffered events so the tool_call marker is durable pre-execution', async () => {
    const journal = makeJournalWith({
      batching: { maxBatchEvents: 32, maxBatchDelayMs: 60_000 },
    })
    try {
      expect(typeof journal.forceFlush).toBe('function')
      journal.append('run-ff', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'ff-tool',
        payload: { toolName: 'write_file' },
      })
      // Not durable until forced.
      expect(journal.events('run-ff')).toHaveLength(0)
      await journal.forceFlush()
      expect(journal.events('run-ff').map((e) => e.seq)).toEqual([0])
      expect(classifyRunResume(journal, 'run-ff')).toEqual({
        kind: 'in_flight_tool',
        toolCallId: 'ff-tool',
      })
    } finally {
      journal.close()
    }
  })

  it('forceFlush is a no-op without batching and after close', async () => {
    const journal = makeJournalWith()
    try {
      journal.append('run-ff2', stepEvent(0))
      await journal.forceFlush()
      expect(journal.events('run-ff2')).toHaveLength(1)
      await journal.close()
      // Post-close forceFlush resolves without touching the closed connection.
      await journal.forceFlush()
    } finally {
      journal.close()
    }
  })

  it('close() closes the db and clears the timer even when the final drain throws', async () => {
    const path = tmpDbPath()
    const { journal, setFailBegins } = makeCountingJournal({
      path,
      batching: { maxBatchEvents: 32, maxBatchDelayMs: 60_000 },
    })
    for (let i = 0; i < 3; i++) journal.append('run-throw', stepEvent(i))
    setFailBegins(true)
    // The drain throws (the non-busy failure propagates out of insertEvent),
    // but close() must still release the sqlite handle and clear the pending
    // delay timer instead of leaking both.
    await expect(journal.close()).rejects.toThrow('injected non-busy failure')
    setFailBegins(false)
    // The handle was released: the file can be re-opened immediately.
    const reopened = makeJournalWith({}, path)
    try {
      // The failed drain committed nothing.
      expect(reopened.events('run-throw')).toHaveLength(0)
    } finally {
      await reopened.close()
    }
  })

  it('recentEvents returns the newest N events newest-first', () => {
    const journal = makeJournal()
    try {
      for (let i = 0; i < 10; i++) journal.append('run-tail', stepEvent(i))
      expect(journal.recentEvents('run-tail', 3).map((e) => e.seq)).toEqual([
        9, 8, 7,
      ])
      expect(journal.recentEvents('run-tail', 0)).toEqual([])
    } finally {
      journal.close()
    }
  })

  it('eventsOfType returns only the requested eventType in seq ASC order', () => {
    const journal = makeJournal()
    try {
      journal.append('run-eot', stepEvent(0))
      journal.append('run-eot', {
        eventType: 'spawn',
        stepNumber: 1,
        correlation: 'child-a',
        payload: {},
      })
      journal.append('run-eot', stepEvent(1))
      journal.append('run-eot', {
        eventType: 'spawn',
        stepNumber: 2,
        correlation: 'child-b',
        payload: {},
      })
      expect(
        journal.eventsOfType('run-eot', 'spawn').map((e) => e.correlation),
      ).toEqual(['child-a', 'child-b'])
      expect(journal.eventsOfType('run-eot', 'llm_request')).toEqual([])
    } finally {
      journal.close()
    }
  })

  it('classifyRunResume stays correct on a run longer than the bounded tail window', () => {
    const journal = makeJournalWith({ retention: { maxEvents: 200 } })
    try {
      for (let i = 0; i < 100; i++) journal.append('run-long', stepEvent(i))
      journal.append('run-long', {
        eventType: 'llm_request',
        stepNumber: 100,
        correlation: 'llm-1',
        payload: { model: 'x' },
      })
      // 101 events: the bounded window cannot hold them all, yet the tail
      // classification is unchanged (the tail IS the newest event).
      expect(classifyRunResume(journal, 'run-long')).toEqual({
        kind: 'in_flight_llm',
      })
      journal.append('run-long', {
        eventType: 'llm_response',
        stepNumber: 100,
        correlation: 'llm-1',
        payload: { ok: true },
      })
      expect(classifyRunResume(journal, 'run-long')).toEqual({ kind: 'clean' })
    } finally {
      journal.close()
    }
  })

  it('planChildResume reconciles a child whose step_boundary follows far after its spawn', () => {
    const journal = makeJournal()
    try {
      journal.append('run-parent', {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child-x',
        payload: {},
      })
      for (let i = 0; i < 80; i++) journal.append('run-parent', stepEvent(i))
      journal.append('run-parent', {
        eventType: 'step_boundary',
        stepNumber: 81,
        correlation: 'child-x',
        payload: {},
      })
      // The targeted path compares seq order across separately-fetched spawn
      // and step_boundary lists, so a boundary far after its spawn still
      // reconciles the child (live_continue, not needs_children/unknown).
      expect(planChildResume(journal, 'run-parent')).toEqual({
        kind: 'live_continue',
      })
    } finally {
      journal.close()
    }
  })

  it('toolResultForInput resolves via the targeted toolName-filtered query', () => {
    const journal = makeJournal()
    try {
      journal.append('run-tri', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'c1',
        payload: { toolName: 'write_file', input: { path: 'a.ts' } },
      })
      journal.append('run-tri', {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 'c1',
        payload: { result: [{ type: 'text', text: 'ok' }] },
      })
      expect(
        journal.toolResultForInput('run-tri', 'write_file', { path: 'a.ts' }, 0),
      ).toEqual({ result: [{ type: 'text', text: 'ok' }] })
      // A different toolName with the same input shape resolves nothing.
      expect(
        journal
          .toolResultForInput('run-tri', 'read_files', { path: 'a.ts' }, 0),
      ).toBeUndefined()
    } finally {
      journal.close()
    }
  })
})

describe('P2 perf: per-send open gate + prepared per-append statements', () => {
  /** The over-cap retention DELETE both cap branches issue, as a SQL prefix. */
  const RETENTION_DELETE_SQL =
    'DELETE FROM run_events WHERE run_id = ? AND seq <= ?'

  /**
   * Journal over a COUNTING createDatabase seam that records (a) every
   * connection-level run() SQL string, (b) every query() call (each one is a
   * statement PREPARE — the per-append allocation the perf finding names),
   * and (c) executions of the prepared hot-path statements, so the tests can
   * prove the per-send open gate skips the persistent schema/DDL re-run on an
   * already-initialized db and that insertEvent reuses one prepared statement
   * per connection instead of allocating a fresh query object per append.
   */
  const makeCountingDbJournal = (
    overrides: Partial<Parameters<typeof createRunJournal>[0]> = {},
    path = ':memory:',
  ) => {
    const runSqls: string[] = []
    const prepares: string[] = []
    const gets: Record<string, number> = {}
    const alls: Record<string, number> = {}
    const stmtRuns: Record<string, number> = {}
    const tagOf = (sql: string): string => {
      if (sql.startsWith('SELECT MAX(seq)')) return 'maxSeq'
      if (sql.startsWith('SELECT total_bytes')) return 'sideRowSelect'
      if (sql.startsWith('UPDATE run_byte_totals')) return 'sideRowUpdate'
      if (sql.startsWith('INSERT OR REPLACE INTO run_byte_totals')) {
        return 'sideRowInsert'
      }
      if (sql.startsWith('SELECT event_count')) return 'eventCountSelect'
      if (sql.startsWith('UPDATE run_event_counts')) return 'eventCountUpdate'
      if (sql.startsWith('INSERT OR REPLACE INTO run_event_counts')) {
        return 'eventCountInsert'
      }
      if (sql.startsWith('SELECT COUNT(*)')) return 'countEvents'
      if (sql.startsWith('INSERT INTO run_events')) return 'insertRunEvent'
      if (
        sql.startsWith(
          'SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq ASC',
        )
      ) {
        return 'excessBoundary'
      }
      if (
        sql.startsWith(
          'SELECT seq FROM run_events WHERE run_id = ? AND seq > ?',
        )
      ) {
        return 'byteWalkSeqPage'
      }
      if (
        sql.startsWith(
          'SELECT LENGTH(CAST(payload AS BLOB)) AS len FROM run_events WHERE run_id = ? AND seq = ?',
        )
      ) {
        return 'byteRowLen'
      }
      if (sql.startsWith(RETENTION_DELETE_SQL)) {
        return 'deletePrefix'
      }
      return 'other'
    }
    const journal = createRunJournal({
      path,
      clock: fixedClock,
      retention: { maxEvents: 20_000, maxBytes: 512 * 1024 * 1024 },
      createDatabase: (p) => {
        const db = new Database(p)
        return {
          run: (sql: string, ...params: unknown[]) => {
            runSqls.push(sql)
            return (
              db as unknown as {
                run: (sql: string, ...params: unknown[]) => unknown
              }
            ).run(sql, ...params)
          },
          query: (sql: string) => {
            prepares.push(sql)
            const tag = tagOf(sql)
            const stmt = (
              db as unknown as {
                query: (sql: string) => {
                  all: (...params: unknown[]) => unknown[]
                  get: (...params: unknown[]) => unknown
                  run?: (...params: unknown[]) => unknown
                }
              }
            ).query(sql)
            return {
              get: (...params: unknown[]) => {
                gets[tag] = (gets[tag] ?? 0) + 1
                return stmt.get(...params)
              },
              all: (...params: unknown[]) => {
                alls[tag] = (alls[tag] ?? 0) + 1
                return stmt.all(...params)
              },
              run: (...params: unknown[]) => {
                stmtRuns[tag] = (stmtRuns[tag] ?? 0) + 1
                // Real bun:sqlite statements expose run(); proxy it so the
                // prepared-UPDATE path executes through the statement, which
                // is the exact reuse createRunJournal must exercise.
                if (stmt.run) return stmt.run(...params)
                return (
                  db as unknown as {
                    run: (sql: string, ...params: unknown[]) => unknown
                  }
                ).run(sql, ...params)
              },
            }
          },
          close: () => {
            ;(db as unknown as { close: () => void }).close()
          },
        }
      },
      ...overrides,
    })
    return {
      journal,
      runSqls: () => runSqls,
      prepares: () => prepares,
      prepareCount: (prefix: string) =>
        prepares.filter((sql) => sql.startsWith(prefix)).length,
      gets: () => gets,
      alls: () => alls,
      stmtRuns: () => stmtRuns,
    }
  }

  it('a reopen of an already-initialized file journal skips SCHEMA_SQL and journal_mode=WAL (per-send open gate)', () => {
    const path = tmpDbPath()
    // First open: the fresh db must apply the persistent state (SCHEMA_SQL
    // DDL + journal_mode=WAL) and stamp the marker.
    const first = makeCountingDbJournal({}, path)
    try {
      first.journal.append('gate-run', stepEvent(0))
      expect(first.runSqls().some((sql) => sql === 'PRAGMA journal_mode=WAL;'))
        .toBe(true)
      expect(first.runSqls().some((sql) => sql.includes('CREATE TABLE'))).toBe(
        true,
      )
      expect(
        first.runSqls().some((sql) => sql.startsWith('PRAGMA user_version =')),
      ).toBe(true)
    } finally {
      first.journal.close()
    }

    // Second open over the SAME file: the cheap marker read must gate BOTH
    // the WAL pragma and the whole 5-statement SCHEMA_SQL off.
    const second = makeCountingDbJournal({}, path)
    try {
      expect(second.runSqls().some((sql) => sql === 'PRAGMA journal_mode=WAL;'))
        .toBe(false)
      expect(second.runSqls().some((sql) => sql.includes('CREATE '))).toBe(
        false,
      )
      expect(
        second.runSqls().some((sql) => sql.startsWith('PRAGMA user_version =')),
      ).toBe(false)
      // The gate itself still ran (one cheap marker read per open).
      expect(second.runSqls().some((sql) => sql === 'PRAGMA busy_timeout = 5000;'))
        .toBe(true)
      expect(second.runSqls().some((sql) => sql.startsWith('PRAGMA synchronous')))
        .toBe(true)
      // And the reopened journal stays fully functional: appends and reads
      // still work over the skipped schema.
      second.journal.append('gate-run', stepEvent(1))
      expect(second.journal.events('gate-run').map((e) => e.seq)).toEqual([0, 1])
    } finally {
      second.journal.close()
    }
  })

  it('an on-disk journal with a user_version marker below the schema version is re-initialized on reopen', () => {
    const path = tmpDbPath()
    // Seed the marker WITHOUT any schema (the crash-window shape: the marker
    // stamped while the schema round-trip failed) — or equivalently any legacy
    // state where user_version < SCHEMA_USER_VERSION.
    const raw = new Database(path)
    raw.run('PRAGMA user_version = 0;')
    raw.close()

    const reopened = makeCountingDbJournal({}, path)
    try {
      // Marker 0 < 1: the gate must NOT trust it and must re-run the schema.
      expect(reopened.runSqls().some((sql) => sql.includes('CREATE '))).toBe(
        true,
      )
      expect(
        reopened.runSqls().some((sql) => sql.startsWith('PRAGMA user_version =')),
      ).toBe(true)
      // The journal is functional afterwards.
      reopened.journal.append('gate-legacy', stepEvent(0))
      expect(reopened.journal.events('gate-legacy')).toHaveLength(1)
    } finally {
      reopened.journal.close()
    }
  })

  it('insertEvent prepares the hot per-append statements once per connection and reuses them', () => {
    const { journal, prepareCount, gets, stmtRuns } = makeCountingDbJournal({
      retention: { maxEvents: 20_000, maxBytes: 512 * 1024 * 1024 },
    })
    try {
      // 5 appends to the same runId under a far-away byte cap: every append
      // runs the MAX(seq) SELECT and the side-row SELECT, plus ONE side-row
      // UPDATE (the byte-cache maintenance).
      for (let i = 0; i < 5; i++) journal.append('prepared-run', stepEvent(i))
      // Each hot statement was PREPARED (query() called) exactly ONCE for the
      // whole connection — the perf finding's "allocates fresh query objects
      // per append" is gone.
      expect(prepareCount('SELECT MAX(seq)')).toBe(1)
      expect(prepareCount('SELECT total_bytes')).toBe(1)
      expect(prepareCount('UPDATE run_byte_totals')).toBe(1)
      // The prepared statements were actually EXECUTED per append (the reuse
      // is not dead code). The FIRST append seeds the side row via the
      // once-prepared INSERT OR REPLACE (no UPDATE yet); appends 2-5 take
      // the O(1) UPDATE branch through the prepared statement.
      expect(gets()['maxSeq'] ?? 0).toBe(5)
      expect(gets()['sideRowSelect'] ?? 0).toBe(5)
      expect(stmtRuns()['sideRowUpdate'] ?? 0).toBe(4)
      // The byte side-row UPSERT is prepared ONCE per connection too, and the
      // append-1 seed executed through it — the per-call db.run re-prepare
      // the finding named is gone.
      expect(prepareCount('INSERT OR REPLACE INTO run_byte_totals')).toBe(1)
      expect(stmtRuns()['sideRowInsert'] ?? 0).toBe(1)
      // Behavior is unchanged: gap-free seq under the reused prepared MAX.
      expect(journal.events('prepared-run').map((e) => e.seq)).toEqual([
        0, 1, 2, 3, 4,
      ])
      // The side-table cache still works: no greedy byte scan ran.
      expect(
        prepareCount('SELECT seq, LENGTH(CAST(payload AS BLOB)) AS len'),
      ).toBe(0)
      // The retention DELETE is prepared LAZILY: an append path that never
      // crosses a cap never prepares it either.
      expect(prepareCount(RETENTION_DELETE_SQL)).toBe(0)
    } finally {
      journal.close()
    }
  })

  it('the reused side-row UPDATE executes through the prepared statement, not a per-append re-prepare', () => {
    const { journal, prepareCount, stmtRuns } = makeCountingDbJournal({
      retention: { maxEvents: 20_000, maxBytes: 512 * 1024 * 1024 },
    })
    try {
      for (let i = 0; i < 3; i++) journal.append('update-run', stepEvent(i))
      // Every UPDATE execution went through the prepared statement's run()
      // (stmtRuns counts it), and only ONE UPDATE PREPARE happened for the
      // whole connection. The FIRST append seeds the side row via
      // INSERT OR REPLACE instead (no UPDATE), so 2 of the 3 appends UPDATE.
      expect(stmtRuns()['sideRowUpdate'] ?? 0).toBe(2)
      expect(prepareCount('UPDATE run_byte_totals')).toBe(1)
      // The total still matches exactly.
      const totalBytes = journal
        .events('update-run')
        .reduce((sum, e) => sum + JSON.stringify(e.payload).length, 0)
      expect(totalBytes).toBe(3 * JSON.stringify(stepEvent(0).payload).length)
    } finally {
      journal.close()
    }
  })

  it('the per-append fast path reuses the same prepared statements as the side-table cache read', () => {
    const { journal, prepareCount, gets, stmtRuns } = makeCountingDbJournal({
      retention: { maxEvents: 20_000, maxBytes: 512 * 1024 * 1024 },
    })
    try {
      journal.append('shared-run', stepEvent(0))
      // The per-append side-row SELECT was prepared once and consumed by
      // BOTH the insertEvent fast path and the seed decision.
      expect(prepareCount('SELECT total_bytes')).toBe(1)
      expect(gets()['sideRowSelect'] ?? 0).toBe(1)
      // The FIRST append found no side row and seeded it via the
      // once-prepared INSERT OR REPLACE — no prepared UPDATE ran yet.
      expect(stmtRuns()['sideRowUpdate'] ?? 0).toBe(0)
      expect(stmtRuns()['sideRowInsert'] ?? 0).toBe(1)
      // A second append keeps reusing the same statement objects: the side
      // row now exists, so the O(1) prepared UPDATE branch runs.
      journal.append('shared-run', stepEvent(1))
      expect(prepareCount('SELECT total_bytes')).toBe(1)
      expect(gets()['sideRowSelect'] ?? 0).toBe(2)
      expect(stmtRuns()['sideRowUpdate'] ?? 0).toBe(1)
      expect(journal.events('shared-run').map((e) => e.seq)).toEqual([0, 1])
    } finally {
      journal.close()
    }
  })

  it('a prepared-statement-less database double still appends correctly (fallback path)', () => {
    // A hand-rolled double whose query() returns only { get, all } (no run)
    // must keep working: createRunJournal's fallback routes the side-row
    // UPDATE through the connection-level run instead of the statement.
    const runSqls: string[] = []
    const journal = createRunJournal({
      path: ':memory:',
      clock: fixedClock,
      retention: { maxEvents: 20_000, maxBytes: 512 * 1024 * 1024 },
      createDatabase: (p) => {
        const db = new Database(p)
        return {
          run: (sql: string, ...params: unknown[]) => {
            runSqls.push(sql)
            return (
              db as unknown as {
                run: (sql: string, ...params: unknown[]) => unknown
              }
            ).run(sql, ...params)
          },
          query: (sql: string) => {
            const stmt = (
              db as unknown as {
                query: (sql: string) => {
                  all: (...params: unknown[]) => unknown[]
                  get: (...params: unknown[]) => unknown
                  run?: (...params: unknown[]) => unknown
                }
              }
            ).query(sql)
            return { get: stmt.get.bind(stmt), all: stmt.all.bind(stmt) }
          },
          close: () => {
            ;(db as unknown as { close: () => void }).close()
          },
        }
      },
    })
    try {
      for (let i = 0; i < 3; i++) journal.append('fallback-run', stepEvent(i))
      // The side-row UPDATE was routed through db.run (fallback), which the
      // real bun:sqlite Database executes fine. The FIRST append seeded the
      // side row via INSERT OR REPLACE (also the connection-level fallback:
      // this double's statements expose no run()), so 2 of the 3 appends
      // issued the UPDATE.
      expect(
        runSqls.filter((sql) => sql.startsWith('UPDATE run_byte_totals')),
      ).toHaveLength(2)
      expect(
        runSqls.filter((sql) =>
          sql.startsWith('INSERT OR REPLACE INTO run_byte_totals'),
        ),
      ).toHaveLength(1)
      expect(journal.events('fallback-run').map((e) => e.seq)).toEqual([0, 1, 2])
    } finally {
      journal.close()
    }
  })

  it('a prepared-statement-less database double still deletes over-cap rows through the connection-level fallback', () => {
    // The over-cap retention DELETE executes through the prepared statement's
    // run() when the statement exposes one; a hand-rolled double whose
    // query() returns only { get, all } must keep deleting correctly by
    // falling back to the connection-level run — the same compatibility
    // contract the side-row UPDATE/INSERT fallback above follows.
    const runSqls: string[] = []
    const journal = createRunJournal({
      path: ':memory:',
      clock: fixedClock,
      retention: { maxEvents: 2 },
      createDatabase: (p) => {
        const db = new Database(p)
        return {
          run: (sql: string, ...params: unknown[]) => {
            runSqls.push(sql)
            return (
              db as unknown as {
                run: (sql: string, ...params: unknown[]) => unknown
              }
            ).run(sql, ...params)
          },
          query: (sql: string) => {
            const stmt = (
              db as unknown as {
                query: (sql: string) => {
                  all: (...params: unknown[]) => unknown[]
                  get: (...params: unknown[]) => unknown
                  run?: (...params: unknown[]) => unknown
                }
              }
            ).query(sql)
            return { get: stmt.get.bind(stmt), all: stmt.all.bind(stmt) }
          },
          close: () => {
            ;(db as unknown as { close: () => void }).close()
          },
        }
      },
    })
    try {
      for (let i = 0; i < 3; i++) {
        journal.append('fallback-delete-run', stepEvent(i))
      }
      // The third append went over the cap of 2, so exactly one deleting
      // pass ran — and because this double's statements expose no run(), the
      // DELETE took the connection-level fallback instead of the prepared
      // statement's run().
      expect(
        runSqls.filter((sql) => sql.startsWith(RETENTION_DELETE_SQL)),
      ).toHaveLength(1)
      // ...and it still deleted exactly the over-cap excess (the OLDEST row),
      // keeping the newest two events.
      expect(journal.events('fallback-delete-run').map((e) => e.seq)).toEqual([
        1, 2,
      ])
    } finally {
      journal.close()
    }
  })

  it('a batched drain reuses the prepared statements across all buffered events', () => {
    const { journal, prepareCount, gets } = makeCountingDbJournal({
      batching: { maxBatchEvents: 4, maxBatchDelayMs: 60_000 },
      retention: { maxEvents: 20_000, maxBytes: 512 * 1024 * 1024 },
    })
    try {
      for (let i = 0; i < 4; i++) journal.append('batch-run', stepEvent(i))
      // The drain ran inside one connection with ONE prepared MAX per runId.
      expect(prepareCount('SELECT MAX(seq)')).toBe(1)
      expect((gets()['maxSeq'] ?? 0)).toBe(4)
      expect(journal.events('batch-run').map((e) => e.seq)).toEqual([0, 1, 2, 3])
    } finally {
      journal.close()
    }
  })

  it('maxEvents retention uses a persisted count side table: under-cap appends skip the boundary walk and over-cap appends delete exactly the excess', () => {
    // NO maxBytes key: the byte dimension must stay completely untouched.
    const { journal, prepareCount, gets, stmtRuns, runSqls } =
      makeCountingDbJournal({
        retention: { maxEvents: 5 },
      })
    try {
      for (let i = 0; i < 10; i++) journal.append('count-run', stepEvent(i))
      // Exactly the five over-cap appends (6-10) ran the boundary query;
      // appends 1-5 took the O(1) count fast path and never walked it (the
      // old DESC/OFFSET walk ran on EVERY enforcement pass).
      expect(gets()['excessBoundary'] ?? 0).toBe(5)
      const events = journal.events('count-run')
      expect(events).toHaveLength(5)
      expect(events[events.length - 1].seq).toBe(9)
      // Each event-count statement was PREPARED exactly once for the whole
      // connection — the per-call re-prepare the perf finding named is gone.
      expect(prepareCount('SELECT event_count')).toBe(1)
      expect(
        prepareCount(
          'SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq ASC',
        ),
      ).toBe(1)
      // The byte dimension was untouched: without a byte cap its statements
      // are never even prepared.
      expect(prepareCount('SELECT total_bytes')).toBe(0)
      // Appends 2-10 O(1)-incremented the side row through the prepared
      // UPDATE; the first append seeded it via the prepared INSERT OR
      // REPLACE (the seed-branch COUNT already includes the just-inserted
      // event inside the open transaction).
      expect(stmtRuns()['eventCountUpdate'] ?? 0).toBe(9)
      // The seed (1) plus each of the five over-cap appends' post-delete
      // re-persist, which now runs through the SAME prepared INSERT OR
      // REPLACE — the old raw db.run was invisible to this tally.
      expect(stmtRuns()['eventCountInsert'] ?? 0).toBe(6)
      // The decisive WORK bound: COUNT(*) ran exactly once per runId (the
      // append-1 seed) plus once per OVER-CAP append (the documented,
      // deliberate pre-delete authoritative count) — NEVER a second
      // post-delete COUNT. 1 seed + 5 over-cap = 6.
      expect(gets()['countEvents'] ?? 0).toBe(6)
      // The over-cap retention DELETE was PREPARED exactly ONCE for the whole
      // connection and each of the five deleting appends executed through it
      // — the per-call connection-level db.run re-parse the finding named is
      // gone, and ZERO connection-level DELETE SQL ran on the steady-state
      // over-cap path.
      expect(prepareCount(RETENTION_DELETE_SQL)).toBe(1)
      expect(stmtRuns()['deletePrefix'] ?? 0).toBe(5)
      expect(
        runSqls().filter((sql) => sql.startsWith(RETENTION_DELETE_SQL)),
      ).toHaveLength(0)
    } finally {
      journal.close()
    }
  })

  it('a stale inflated run_event_counts row self-heals and the authoritative count drives the delete', async () => {
    // Regression for the crash-window durability class: a crash between a
    // retention DELETE and the side-row re-persist can leave an inflated
    // run_event_counts row. The stale count is only the fast-path check —
    // the authoritative COUNT(*) drives the delete decision (so the inflated
    // row can never over-delete) — and the over-cap pass re-persists the
    // exact count, healing the row.
    const path = tmpDbPath()
    // Journal A: 6 events on 'count-run' under a far-away event cap so
    // nothing is deleted; its side row lands at the exact count (6).
    const seeder = makeJournalWith({ retention: { maxEvents: 20_000 } }, path)
    try {
      for (let i = 0; i < 6; i++) seeder.append('count-run', stepEvent(i))
    } finally {
      await seeder.close()
    }

    // Simulate the crash window: inflate the persisted side row directly on
    // the db file, exactly as a crash between a retention DELETE and the
    // side-row re-persist would leave it.
    const raw = new Database(path)
    raw.run(
      "UPDATE run_event_counts SET event_count = 999 WHERE run_id = 'count-run'",
    )
    raw.close()

    // Journal B over the same file: 7 rows exist (seqs 0-5 plus the new 6)
    // when its single append's enforcement runs. The inflated side count
    // (now 1000 after the O(1) increment) is over the cap of 5, but the
    // authoritative COUNT(*) (7) drives the delete of exactly the 2 excess
    // oldest rows — never 995 rows.
    const journalB = makeCountingDbJournal(
      { retention: { maxEvents: 5 } },
      path,
    )
    try {
      journalB.journal.append('count-run', stepEvent(6))
      const events = journalB.journal.events('count-run')
      expect(events).toHaveLength(5)
      expect(events[events.length - 1].seq).toBe(6)
      expect(journalB.gets()['excessBoundary'] ?? 0).toBe(1)
      // The once-per-staleness-event heal (writes the exact pre-delete
      // count) and the post-delete re-persist (writes the exact post-delete
      // count) BOTH ran through the ONCE-prepared run_event_counts upsert —
      // zero connection-level count-upsert SQL on the heal path.
      expect(journalB.stmtRuns()['eventCountInsert'] ?? 0).toBe(2)
      expect(
        journalB
          .runSqls()
          .filter((sql) =>
            sql.startsWith('INSERT OR REPLACE INTO run_event_counts'),
          ),
      ).toHaveLength(0)
    } finally {
      await journalB.journal.close()
    }

    // The side row now holds the EXACT post-delete count (5), not the
    // inflated value.
    const verify = new Database(path)
    const row = verify
      .query('SELECT event_count FROM run_event_counts WHERE run_id = ?')
      .get('count-run') as { event_count: number } | undefined
    verify.close()
    expect(row?.event_count).toBe(5)
  })

  it('byte over-cap steady state is O(deleted rows): the paged walk stops at the boundary and re-persists the exact total in O(1)', async () => {
    const path = tmpDbPath()
    // Journal A: 6 ~1024-byte events on 'over-run' under a far-away byte
    // cap so nothing is deleted; its side row lands at the exact 6 × 1024.
    const seeder = makeJournalWith(
      { retention: { maxEvents: 20_000, maxBytes: 512 * 1024 * 1024 } },
      path,
    )
    try {
      const bigPayload = { blob: 'x'.repeat(1013) }
      for (let i = 0; i < 6; i++) {
        seeder.append('over-run', stepEvent(i, bigPayload))
      }
    } finally {
      await seeder.close()
    }

    // Journal B over the same file with an 8192-byte cap: appends 1-2 land
    // under the cap (7 × 1024 = 7168, then exactly 8192); appends 3-4 each
    // re-cross it, so each runs the paged walk once.
    const { journal, prepareCount, alls, gets, stmtRuns, runSqls } =
      makeCountingDbJournal(
        { retention: { maxEvents: 20_000, maxBytes: 8192 } },
        path,
      )
    try {
      const bigPayload = { blob: 'x'.repeat(1013) }
      for (let i = 0; i < 4; i++) {
        journal.append('over-run', stepEvent(6 + i, bigPayload))
      }
      // Exactly the two over-cap appends walked — one bounded seq page
      // each (the whole run fits in a single 512-row page): the walk
      // consumes the rows being DELETED, never the retained window.
      expect(alls()['byteWalkSeqPage'] ?? 0).toBe(2)
      // The decisive WORK bound: one per-row LENGTH read per row the
      // walk CONSUMED. Each of the two over-cap appends deleted exactly
      // one row, so 2 reads total — the byte work is O(deleted rows),
      // never a full page of payload LENGTH evaluations.
      expect(gets()['byteRowLen'] ?? 0).toBe(2)
      // The walk statements were prepared exactly ONCE each (lazily, on
      // the first over-cap pass) for the whole connection.
      expect(
        prepareCount('SELECT seq FROM run_events WHERE run_id = ? AND seq > ?'),
      ).toBe(1)
      expect(
        prepareCount(
          'SELECT LENGTH(CAST(payload AS BLOB)) AS len FROM run_events WHERE run_id = ? AND seq = ?',
        ),
      ).toBe(1)
      const events = journal.events('over-run')
      expect(events[events.length - 1].seq).toBe(9)
      const totalBytes = events.reduce(
        (sum, e) => sum + JSON.stringify(e.payload).length,
        0,
      )
      expect(totalBytes).toBeLessThanOrEqual(8192)
      // Steady state: three more over-cap appends, one bounded walk each —
      // the per-append cost stays O(deleted rows) (~1 row), not O(retained).
      for (let i = 4; i < 7; i++) {
        journal.append('over-run', stepEvent(6 + i, bigPayload))
      }
      expect(alls()['byteWalkSeqPage'] ?? 0).toBe(5)
      // Steady-state byte work: three more over-cap appends each consumed
      // exactly one row => 3 more per-row LENGTH reads (2 + 3 = 5 total).
      expect(gets()['byteRowLen'] ?? 0).toBe(5)
      // The steady-state over-cap re-persist executed through the ONCE-
      // prepared byte UPSERT on every deleting append (5 deleting appends =>
      // 5 executions, 1 prepare) — the per-call db.run re-prepare the finding
      // named is gone, and the connection-level fallback never fired (the
      // real statement exposes run(), so no db.run byte-upsert appears).
      expect(prepareCount('INSERT OR REPLACE INTO run_byte_totals')).toBe(1)
      expect(stmtRuns()['sideRowInsert'] ?? 0).toBe(5)
      expect(
        runSqls().filter((sql) =>
          sql.startsWith('INSERT OR REPLACE INTO run_byte_totals'),
        ),
      ).toHaveLength(0)
      // The byte branch's over-cap DELETE ran through the SAME once-prepared
      // statement the count branch uses: one DELETE prepare for the whole
      // connection, one execution per deleting append (5), and ZERO
      // connection-level DELETE SQL on the steady-state over-cap path.
      expect(prepareCount(RETENTION_DELETE_SQL)).toBe(1)
      expect(stmtRuns()['deletePrefix'] ?? 0).toBe(5)
      expect(
        runSqls().filter((sql) => sql.startsWith(RETENTION_DELETE_SQL)),
      ).toHaveLength(0)
      // The count dimension ran NO COUNT(*) for any of the five byte-branch
      // deletes: the post-delete count re-persist is ARITHMETIC (base
      // count minus the byte walk's consumed rows), never a second
      // O(retained) COUNT. The side row was seeded by journal A, so this
      // connection never even ran the seed COUNT.
      expect(gets()['countEvents'] ?? 0).toBe(0)
      const finalEvents = journal.events('over-run')
      expect(finalEvents[finalEvents.length - 1].seq).toBe(12)
    } finally {
      await journal.close()
    }

    // The side row holds the EXACT remaining total — the O(1) re-persist
    // (walked deleted bytes subtracted from the surviving total, no SUM
    // recompute) — verified against the live db.
    const raw = new Database(path)
    try {
      const row = raw
        .query('SELECT total_bytes FROM run_byte_totals WHERE run_id = ?')
        .get('over-run') as { total_bytes: number } | undefined
      expect(row?.total_bytes).toBe(8192)
      const live = raw
        .query('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?')
        .get('over-run') as { n: number }
      expect(live.n).toBe(8)
      // The count side row stayed EXACT through every byte-branch delete —
      // the arithmetic re-persist (no post-delete COUNT) verified against
      // the live row count.
      const countRow = raw
        .query('SELECT event_count FROM run_event_counts WHERE run_id = ?')
        .get('over-run') as { event_count: number } | undefined
      expect(countRow?.event_count).toBe(live.n)
    } finally {
      raw.close()
    }
  })

  it('the hot run_events INSERT executes through the once-prepared statement', () => {
    const { journal, prepareCount, stmtRuns } = makeCountingDbJournal({
      retention: { maxEvents: 5 },
    })
    try {
      for (let i = 0; i < 3; i++) journal.append('insert-run', stepEvent(i))
      // The main INSERT was PREPARED (query() called) exactly ONCE for the
      // whole connection — the highest-frequency statement is no longer
      // re-prepared per append.
      expect(prepareCount('INSERT INTO run_events')).toBe(1)
      // Every append EXECUTED through the prepared statement's run().
      expect(stmtRuns()['insertRunEvent'] ?? 0).toBe(3)
      expect(journal.events('insert-run').map((e) => e.seq)).toEqual([0, 1, 2])
    } finally {
      journal.close()
    }
  })
})
