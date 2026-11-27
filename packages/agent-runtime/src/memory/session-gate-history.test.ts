import { describe, expect, test } from 'bun:test'

import {
  correlateCompliedAfterBlock,
  createSessionGateHistory,
  recordSessionGateOutcome,
  SESSION_GATE_HISTORY_MAX_ENTRIES,
} from './session-gate-history'

import type { SessionGateHistoryEntry } from './session-gate-history'

/**
 * Build one history entry. Only the fields under test vary: correlation keys
 * on the trigger signature, and the playbook id is constant because it never
 * participates in matching.
 */
const entry = (
  outcome: SessionGateHistoryEntry['outcome'],
  atMs: number,
  triggerSignature = 'sig-1',
): SessionGateHistoryEntry => ({
  playbookId: 'pb-1',
  triggerSignature,
  outcome,
  atMs,
})

describe('session gate history', () => {
  test('caps at the most-recent entries and mutates in place (identity stable)', () => {
    const history = createSessionGateHistory()
    const entriesRef = history.entries
    for (let i = 0; i < SESSION_GATE_HISTORY_MAX_ENTRIES + 50; i += 1) {
      recordSessionGateOutcome(history, entry('blocked', i))
    }
    expect(history.entries).toHaveLength(SESSION_GATE_HISTORY_MAX_ENTRIES)
    // Splice, not reassignment: the entries array keeps its identity, so
    // agent state can hold the same history object across steps.
    expect(history.entries).toBe(entriesRef)
    expect(history.entries[0]?.atMs).toBe(50)
    expect(history.entries.at(-1)?.atMs).toBe(
      SESSION_GATE_HISTORY_MAX_ENTRIES + 49,
    )
  })

  test('correlates an allowed outcome back to a prior block exactly once', () => {
    const history = createSessionGateHistory()
    recordSessionGateOutcome(history, entry('blocked', 1_000))
    expect(
      correlateCompliedAfterBlock(history, { triggerSignature: 'sig-1' }),
    ).toBe(true)
    expect(history.entries[0]?.compensated).toBe(true)
    // The same block can never earn a second comply report.
    expect(
      correlateCompliedAfterBlock(history, { triggerSignature: 'sig-1' }),
    ).toBe(false)
  })

  test('never correlates without a prior block for the signature', () => {
    const history = createSessionGateHistory()
    recordSessionGateOutcome(history, entry('allowed', 1_000))
    expect(
      correlateCompliedAfterBlock(history, { triggerSignature: 'sig-1' }),
    ).toBe(false)
    // A block for a different signature never satisfies this one.
    recordSessionGateOutcome(history, entry('blocked', 2_000, 'sig-other'))
    expect(
      correlateCompliedAfterBlock(history, { triggerSignature: 'sig-1' }),
    ).toBe(false)
  })

  test('warned entries never correlate — compliedAfterBlock is after-block only', () => {
    // Design-doc invariant: a heeded warn must NEVER produce
    // compliedAfterBlock; that counter means specifically after-block
    // compliance, and polluting it destroys the effectiveness signal.
    const history = createSessionGateHistory()
    recordSessionGateOutcome(history, entry('warned', 1_000))
    recordSessionGateOutcome(history, entry('allowed', 2_000))
    expect(
      correlateCompliedAfterBlock(history, { triggerSignature: 'sig-1' }),
    ).toBe(false)
    expect(history.entries[0]?.compensated).toBeUndefined()
  })

  test('the most recent uncompensated block wins when several exist', () => {
    const history = createSessionGateHistory()
    recordSessionGateOutcome(history, entry('blocked', 1_000))
    recordSessionGateOutcome(history, entry('blocked', 2_000))
    expect(
      correlateCompliedAfterBlock(history, { triggerSignature: 'sig-1' }),
    ).toBe(true)
    // The most recent block is the one compensated, not the older one.
    expect(history.entries[0]?.compensated).toBeUndefined()
    expect(history.entries[1]?.compensated).toBe(true)
    // Exactly once per prior block: the older block still earns its own
    // report on a later satisfied call.
    expect(
      correlateCompliedAfterBlock(history, { triggerSignature: 'sig-1' }),
    ).toBe(true)
    expect(history.entries[0]?.compensated).toBe(true)
  })

  test('the compensation marker mutates only the matched entry', () => {
    const history = createSessionGateHistory()
    recordSessionGateOutcome(history, entry('warned', 1_000))
    recordSessionGateOutcome(history, entry('blocked', 2_000, 'sig-1'))
    recordSessionGateOutcome(history, entry('blocked', 3_000, 'sig-2'))
    expect(
      correlateCompliedAfterBlock(history, { triggerSignature: 'sig-1' }),
    ).toBe(true)
    expect(history.entries[0]?.compensated).toBeUndefined()
    expect(history.entries[1]?.compensated).toBe(true)
    expect(history.entries[2]?.compensated).toBeUndefined()
    // The untouched block for the other signature still correlates on its
    // own, exactly once.
    expect(
      correlateCompliedAfterBlock(history, { triggerSignature: 'sig-2' }),
    ).toBe(true)
    expect(history.entries[2]?.compensated).toBe(true)
  })
})
