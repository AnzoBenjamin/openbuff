import { describe, expect, test } from 'bun:test'

import { createQueuedPromptDrainer } from '../exit-queue-drain'

import type { QueuedMessage } from '../../use-message-queue'

/**
 * Behavior pins (reliability findings
 * exit-drain-partial-failure-drops-queue /
 * exit-drain-stops-on-first-persist-failure /
 * exit-drain-drops-queued-attachments) extracted from the previous inline
 * drain body in chat.tsx — see exit-queue-drain.ts for where this runs.
 */

let snapshotCalls = 0

describe('createQueuedPromptDrainer (exit-path queue drain)', () => {
  test('drains every queued prompt one at a time in FIFO order', () => {
    snapshotCalls = 0
    const remaining: QueuedMessage[] = [
      { content: 'first prompt', attachments: [] },
      { content: 'second prompt', attachments: [] },
      { content: 'third prompt', attachments: [] },
    ]
    const saved: string[] = []

    const drainer = createQueuedPromptDrainer({
      pushMessageSnapshot: () => {
        snapshotCalls++
      },
      clearQueue: (count) => remaining.splice(0, Math.max(0, count)),
      saveToHistory: (prompt) => {
        saved.push(prompt)
      },
    })
    drainer()

    expect(snapshotCalls).toBe(1)
    expect(remaining).toEqual([])
    expect(saved.join('\n')).toContain('first prompt')
    expect(saved.join('\n')).toContain('second prompt')
    expect(saved.join('\n')).toContain('third prompt')
  })

  test('a failing persist only skips its own entry and the drain continues', () => {
    snapshotCalls = 0
    const remaining: QueuedMessage[] = [
      { content: 'keep-me-1', attachments: [] },
      { content: 'boom', attachments: [] },
      { content: 'keep-me-2', attachments: [] },
    ]
    const saved: string[] = []

    const drainer = createQueuedPromptDrainer({
      pushMessageSnapshot: () => {
        snapshotCalls++
      },
      clearQueue: (count) => remaining.splice(0, Math.max(0, count)),
      saveToHistory: (prompt) => {
        if (prompt.includes('boom')) throw new Error('persist failed')
        saved.push(prompt)
      },
    })

    expect(() => drainer()).not.toThrow()
    expect(snapshotCalls).toBe(1)
    expect(saved.join('\n')).toContain('keep-me-1')
    expect(saved.join('\n')).not.toContain('boom')
    expect(saved.join('\n')).toContain('keep-me-2')
    expect(remaining).toEqual([])
  })

  test('an empty queue still snapshots the conversation and is a no-op', () => {
    snapshotCalls = 0
    let drainCalls = 0

    const drainer = createQueuedPromptDrainer({
      pushMessageSnapshot: () => {
        snapshotCalls++
      },
      clearQueue: () => {
        drainCalls++
        return []
      },
      saveToHistory: () => {},
    })

    expect(() => drainer()).not.toThrow()
    expect(snapshotCalls).toBe(1)
    expect(drainCalls).toBe(1)
  })
})
