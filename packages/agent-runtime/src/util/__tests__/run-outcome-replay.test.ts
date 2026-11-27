import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'

import {
  buildRunResumeReport,
  classifyChildRun,
  createRunJournal,
  executeChildReplay,
  executeReplayActions,
  planReplayActions,
} from '../run-journal'
import { executeRunResumeReport } from '../run-replay-driver'

test('an intermediate generator boundary requires live execution', async () => {
  const journal = createRunJournal({
    path: ':memory:',
    createDatabase: (file) => new Database(file),
  })
  try {
    journal.append('child', {
      eventType: 'step_boundary',
      stepNumber: 1,
      correlation: 'step',
      payload: { terminal: false, status: 'completed' },
    })
    await journal.forceFlush()
    expect(classifyChildRun(journal, 'child').kind).toBe(
      'child_incomplete_tail',
    )
    expect(executeChildReplay(journal, 'child').kind).toBe(
      'live_execution_required',
    )
  } finally {
    await journal.close()
  }
})

test('terminal replay preserves failed and rejected verdicts without redispatch', async () => {
  for (const termination of [
    'failed',
    'cancelled',
    'budget_exhausted',
    'step_exhausted',
    'completed',
  ] as const) {
    const journal = createRunJournal({
      path: ':memory:',
      createDatabase: (file) => new Database(file),
    })
    const runOutcome = { termination }
    const taskAcceptance = { status: 'rejected' as const, oracle: 'fixture' }
    try {
      journal.append('parent', {
        eventType: 'spawn',
        stepNumber: 0,
        correlation: 'child',
        payload: { agentType: 'fixture' },
      })
      journal.append('child', {
        eventType: 'step_boundary',
        stepNumber: 1,
        correlation: 'terminal',
        payload: {
          terminal: true,
          status: termination === 'completed' ? 'completed' : 'failed',
          runOutcome,
          taskAcceptance,
        },
      })
      await journal.forceFlush()
      expect(executeChildReplay(journal, 'child')).toMatchObject({
        kind: 'replayed_completed',
        runOutcome,
        taskAcceptance,
      })
      const report = buildRunResumeReport({ reader: journal, runId: 'parent' })
      const skipped: unknown[] = []
      const driven = await executeRunResumeReport({
        report,
        handlers: {
          reDriveChild: async () => {
            throw new Error('terminal child redispatched')
          },
          onSkipped: (info) => {
            skipped.push(info)
          },
        },
      })
      expect(driven.ok).toBe(true)
      expect(skipped).toEqual([
        {
          kind: 'child',
          childRunId: 'child',
          reason: 'replayed_completed',
          runOutcome,
          taskAcceptance,
        },
      ])
      const plan = planReplayActions(report)
      expect(plan.actions[0]).toMatchObject({
        kind: 'replay_child',
        runOutcome,
        taskAcceptance,
      })
      const replayed: unknown[] = []
      await executeReplayActions(plan.actions, {
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
        replayChild: async (id, verdict, outcomes) => {
          replayed.push({ id, verdict, ...outcomes })
        },
      })
      expect(replayed).toEqual([
        {
          id: 'child',
          verdict: 'replayed_completed',
          runOutcome,
          taskAcceptance,
        },
      ])
    } finally {
      await journal.close()
    }
  }
})
