import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'

import { buildRunResumeReport, createRunJournal } from '../run-journal'
import type {
  BackgroundResumeDecision,
  ChildRunDisposition,
  RunResumeReport,
} from '../run-journal'
import { executeRunResumeReport } from '../run-replay-driver'
import type { RunReplayDriverSkip } from '../run-replay-driver'

/** Deterministic clock so journaled created_at is reproducible (matches run-journal.test). */
const fixedClock = { now: () => 1_000 }

const makeJournal = () =>
  createRunJournal({
    path: ':memory:',
    clock: fixedClock,
    createDatabase: (path) => new Database(path),
  })

const interrupted = (jobId: string, agentType: string) => ({
  jobId,
  agentType,
  status: 'interrupted' as const,
  startedAt: 1_000,
  completedAt: 2_000,
})

/** Hand-built report for fault-injection over the shapes buildRunResumeReport produces. */
const makeReport = (
  overrides: Partial<RunResumeReport> = {},
): RunResumeReport => ({
  runId: 'parent-p',
  self: { kind: 'clean' },
  children: { kind: 'live_continue' },
  background: [],
  ...overrides,
})

/** Collecting handlers so each test can assert the exact seam invocations. */
const makeHandlers = () => {
  const reDriveCalls: Array<{
    childRunId: string
    classification: ChildRunDisposition
  }> = []
  const respawnCalls: Array<{
    intent: BackgroundResumeDecision
    classification: { respawnOf: string }
  }> = []
  const skipped: RunReplayDriverSkip[] = []
  return {
    reDriveCalls,
    respawnCalls,
    skipped,
    handlers: {
      reDriveChild: async (
        childRunId: string,
        classification: ChildRunDisposition,
      ) => {
        reDriveCalls.push({ childRunId, classification })
      },
      respawnBackground: async (
        intent: BackgroundResumeDecision,
        classification: { respawnOf: string },
      ) => {
        respawnCalls.push({ intent, classification })
      },
      onSkipped: (info: RunReplayDriverSkip) => {
        skipped.push(info)
      },
    },
  }
}

/**
 * P2-T2 replay-driver slice: executeRunResumeReport — the driver that ACTS on
 * a RunResumeReport by re-driving children and respawning background intents
 * through caller-injected seams. Fixtures reuse the journal shapes the
 * run-journal tests build (same makeJournal/interrupted helpers).
 */
describe('executeRunResumeReport (P2-T2 replay-driver slice)', () => {
  it('a completed child is skipped, not re-driven', async () => {
    const journal = makeJournal()
    try {
      journal.append('parent-1', {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child-1',
        payload: { agentType: 'helper' },
      })
      journal.append('child-1', {
        eventType: 'step_boundary',
        stepNumber: 0,
        correlation: 'c1-done',
        payload: { status: 'completed' },
      })
      const report = buildRunResumeReport({ reader: journal, runId: 'parent-1' })
      const h = makeHandlers()
      const outcome = await executeRunResumeReport({
        report,
        handlers: h.handlers,
      })
      expect(outcome).toEqual({
        ok: true,
        childrenReplayed: 0,
        backgroundRespawned: 0,
        skipped: 1,
      })
      expect(h.reDriveCalls).toEqual([])
      expect(h.respawnCalls).toEqual([])
      expect(h.skipped).toEqual([
        {
          kind: 'child',
          childRunId: 'child-1',
          reason: 'replayed_completed',
        },
      ])
    } finally {
      journal.close()
    }
  })

  it('an in-flight-tool child is re-driven with its toolCallId', async () => {
    const journal = makeJournal()
    try {
      journal.append('parent-2', {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child-2',
        payload: { agentType: 'helper' },
      })
      journal.append('child-2', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'tc-2',
        payload: { toolName: 'write_file' },
      })
      const report = buildRunResumeReport({ reader: journal, runId: 'parent-2' })
      const h = makeHandlers()
      const outcome = await executeRunResumeReport({
        report,
        handlers: h.handlers,
      })
      expect(outcome).toEqual({
        ok: true,
        childrenReplayed: 1,
        backgroundRespawned: 0,
        skipped: 0,
      })
      expect(h.reDriveCalls).toEqual([
        {
          childRunId: 'child-2',
          classification: {
            kind: 'child_in_flight_tool',
            childRunId: 'child-2',
            toolCallId: 'tc-2',
          },
        },
      ])
    } finally {
      journal.close()
    }
  })

  it('an unknown child is skipped and reported', async () => {
    const journal = makeJournal()
    try {
      journal.append('parent-3', {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child-3',
        payload: { agentType: 'helper' },
      })
      // No events at all for child-3: recording intent without child progress.
      const report = buildRunResumeReport({ reader: journal, runId: 'parent-3' })
      const h = makeHandlers()
      const outcome = await executeRunResumeReport({
        report,
        handlers: h.handlers,
      })
      expect(outcome).toEqual({
        ok: true,
        childrenReplayed: 0,
        backgroundRespawned: 0,
        skipped: 1,
      })
      expect(h.reDriveCalls).toEqual([])
      expect(h.skipped).toEqual([
        { kind: 'child', childRunId: 'child-3', reason: 'child_unknown' },
      ])
    } finally {
      journal.close()
    }
  })

  it('a respawn decision drives respawnBackground with the respawnOf marker', async () => {
    const journal = makeJournal()
    try {
      const report = buildRunResumeReport({
        reader: journal,
        runId: 'parent-4',
        intents: [interrupted('bg-4', 'file-picker')],
      })
      const h = makeHandlers()
      const outcome = await executeRunResumeReport({
        report,
        handlers: h.handlers,
      })
      expect(outcome).toEqual({
        ok: true,
        childrenReplayed: 0,
        backgroundRespawned: 1,
        skipped: 0,
      })
      expect(h.respawnCalls).toEqual([
        {
          intent: { kind: 'respawn', jobId: 'bg-4', agentType: 'file-picker' },
          classification: { respawnOf: 'bg-4' },
        },
      ])
    } finally {
      journal.close()
    }
  })

  it('already_respawned is skipped: re-planning and re-driving respawns only once', async () => {
    const journal = makeJournal()
    try {
      // First resume: no respawn marker yet → respawn.
      const reportA = buildRunResumeReport({
        reader: journal,
        runId: 'parent-5',
        intents: [interrupted('bg-5', 'file-picker')],
      })
      const h = makeHandlers()
      const first = await executeRunResumeReport({
        report: reportA,
        handlers: h.handlers,
      })
      expect(first).toEqual({
        ok: true,
        childrenReplayed: 0,
        backgroundRespawned: 1,
        skipped: 0,
      })

      // The caller journals the respawnOf marker and the respawned child
      // reaches a terminal tail → the marker settles (the run-journal.test
      // settled-marker fixture shape).
      journal.append('parent-5', {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child-5',
        payload: { respawnOf: 'bg-5' },
      })
      journal.append('child-5', {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'c5-0',
        payload: { model: 'm' },
      })
      journal.append('child-5', {
        eventType: 'step_boundary',
        stepNumber: 1,
        correlation: 'c5-done',
        payload: { status: 'completed' },
      })

      // Second resume over the same journal: the intent re-plans to
      // already_respawned, and the marker's child now plans as an awaiting
      // (completed) child. Neither is re-driven.
      const reportB = buildRunResumeReport({
        reader: journal,
        runId: 'parent-5',
        intents: [interrupted('bg-5', 'file-picker')],
      })
      const second = await executeRunResumeReport({
        report: reportB,
        handlers: h.handlers,
      })
      expect(second).toEqual({
        ok: true,
        childrenReplayed: 0,
        backgroundRespawned: 0,
        skipped: 2,
      })
      expect(h.respawnCalls.length).toBe(1)
      expect(h.skipped).toEqual([
        { kind: 'child', childRunId: 'child-5', reason: 'replayed_completed' },
        { kind: 'background', jobId: 'bg-5', reason: 'already_respawned' },
      ])
    } finally {
      journal.close()
    }
  })

  it('needs_confirmation is skipped, never auto-run', async () => {
    const journal = makeJournal()
    try {
      const report = buildRunResumeReport({
        reader: journal,
        runId: 'parent-6',
        intents: [interrupted('bg-6', 'editor')],
      })
      const h = makeHandlers()
      const outcome = await executeRunResumeReport({
        report,
        handlers: h.handlers,
      })
      expect(outcome).toEqual({
        ok: true,
        childrenReplayed: 0,
        backgroundRespawned: 0,
        skipped: 1,
      })
      expect(h.respawnCalls).toEqual([])
      expect(h.skipped).toEqual([
        { kind: 'background', jobId: 'bg-6', reason: 'needs_confirmation' },
      ])
    } finally {
      journal.close()
    }
  })

  it('a throwing reDriveChild is recorded but the remaining items are still processed', async () => {
    const journal = makeJournal()
    try {
      journal.append('parent-7', {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child-a',
        payload: { agentType: 'helper' },
      })
      journal.append('parent-7', {
        eventType: 'spawn',
        stepNumber: 1,
        correlation: 'child-b',
        payload: { agentType: 'helper' },
      })
      journal.append('child-a', {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'tc-a',
        payload: { toolName: 'write_file' },
      })
      journal.append('child-b', {
        eventType: 'llm_request',
        stepNumber: 0,
        correlation: 'cl-b',
        payload: { model: 'm' },
      })
      const report = buildRunResumeReport({
        reader: journal,
        runId: 'parent-7',
        intents: [interrupted('bg-7', 'file-picker')],
      })
      const reDriven: string[] = []
      let respawned = 0
      const outcome = await executeRunResumeReport({
        report,
        handlers: {
          reDriveChild: async (childRunId) => {
            reDriven.push(childRunId)
            if (childRunId === 'child-a') throw new Error('boom')
          },
          respawnBackground: async () => {
            respawned += 1
          },
        },
      })
      // child-a threw but child-b (in-flight llm) and the background intent
      // were still attempted — the walk never aborts on a handler error.
      expect(reDriven).toEqual(['child-a', 'child-b'])
      expect(respawned).toBe(1)
      expect(outcome).toEqual({
        ok: false,
        error: 'boom',
        childrenReplayed: 1,
        backgroundRespawned: 1,
        skipped: 0,
      })
    } finally {
      journal.close()
    }
  })

  it('a clean report performs zero calls and reports ok', async () => {
    const journal = makeJournal()
    try {
      const report = buildRunResumeReport({ reader: journal, runId: 'fresh' })
      const h = makeHandlers()
      const outcome = await executeRunResumeReport({
        report,
        handlers: h.handlers,
      })
      expect(outcome).toEqual({
        ok: true,
        childrenReplayed: 0,
        backgroundRespawned: 0,
        skipped: 0,
      })
      expect(h.reDriveCalls).toEqual([])
      expect(h.respawnCalls).toEqual([])
      expect(h.skipped).toEqual([])
    } finally {
      journal.close()
    }
  })

  it('unwired handlers perform no work and never throw', async () => {
    const report = makeReport({
      children: {
        kind: 'needs_children',
        inFlight: [{ kind: 'child_in_flight_llm', childRunId: 'child-u' }],
        awaiting: [],
      },
      background: [{ kind: 'respawn', jobId: 'bg-u', agentType: 'file-picker' }],
    })
    const outcome = await executeRunResumeReport({ report })
    expect(outcome).toEqual({
      ok: true,
      childrenReplayed: 0,
      backgroundRespawned: 0,
      skipped: 0,
    })
  })
})
