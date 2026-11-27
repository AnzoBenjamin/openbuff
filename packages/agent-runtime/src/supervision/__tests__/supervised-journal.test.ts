import { expect, test } from 'bun:test'

import {
  createSupervisedJournalWriter,
  readSupervisedJournalAppend,
} from '../supervised-journal'
import type { JournalEvent } from '@codebuff/common/types/contracts/agent-runtime'

const step: JournalEvent = {
  eventType: 'step_boundary',
  stepNumber: 2,
  payload: { terminal: true },
}

test('supervised journal snapshots enqueue-time bytes and acknowledges in order', async () => {
  const gate = Promise.withResolvers<void>()
  const events: JournalEvent[] = []
  const writer = createSupervisedJournalWriter(async ({ runId, event }) => {
    expect(runId).toBe('owned')
    if (!events.length) await gate.promise
    events.push(event)
  })
  const mutable = { data: 'before' }
  writer.append('owned', {
    eventType: 'tool_call',
    stepNumber: 1,
    payload: mutable,
  })
  mutable.data = 'after'
  const confirmation = writer.appendDurable!('owned', step)
  await Promise.resolve()
  expect(events).toEqual([])
  gate.resolve()
  await confirmation
  await writer.flush()
  expect(events.map((event) => event.payload)).toEqual([
    { data: 'before' },
    { terminal: true },
  ])
})

test('supervised journal rejection poisons later operations and refuses a clean flush', async () => {
  const calls: string[] = []
  const writer = createSupervisedJournalWriter(async ({ event }) => {
    calls.push(event.eventType)
    throw new Error('durable sink refused')
  })
  writer.append('owned', {
    eventType: 'tool_call',
    stepNumber: 1,
    payload: null,
  })
  await expect(writer.appendDurable!('owned', step)).rejects.toThrow(
    'durable sink refused',
  )
  await expect(writer.flush()).rejects.toThrow('durable sink refused')
  expect(calls).toEqual(['tool_call'])
})

test('supervised generic bridge rejects replay authority and invalid event inputs', () => {
  for (const event of [
    { ...step, eventType: 'read_plan_basis' },
    { ...step, eventType: 'programmatic_observation' },
    { ...step, stepNumber: Infinity },
    { ...step, payload: 'x'.repeat(2 * 1024 * 1024) },
    { ...step, foreignIdentity: 'root' },
  ])
    expect(() =>
      readSupervisedJournalAppend({ runId: 'owned', event }),
    ).toThrow()
})
