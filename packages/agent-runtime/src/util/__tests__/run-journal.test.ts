import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'

import { classifyRunResume, createRunJournal } from '../run-journal'

import type { JournalReader } from '@codebuff/common/types/contracts/agent-runtime'

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
