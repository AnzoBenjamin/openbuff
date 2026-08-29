import { describe, expect, test } from 'bun:test'

import { createWarnLatch } from '../warn-latch'

/**
 * The primitive's own tests. `createWarnLatch` is shared by two unrelated
 * consumers (the gate-telemetry sink's warn wrapper and run-programmatic-step's
 * blank-projectRoot warning), so its cases live here rather than in either
 * consumer's test file.
 */
describe('createWarnLatch', () => {
  test('reports each key once and re-arms every key on clear', () => {
    // The single definition of the once-per-failure-mode policy.
    const latch = createWarnLatch()

    expect(latch.shouldWarn('EACCES')).toBe(true)
    expect(latch.shouldWarn('EACCES')).toBe(false)
    // A distinct key is a distinct failure mode, so it is still reported.
    expect(latch.shouldWarn('ENOSPC')).toBe(true)
    expect(latch.shouldWarn('ENOSPC')).toBe(false)

    latch.clear()
    expect(latch.shouldWarn('EACCES')).toBe(true)
    expect(latch.shouldWarn('ENOSPC')).toBe(true)
  })

  test('latches are independent of one another', () => {
    // Each owner picks its own lifetime: one recorder's latch must not silence
    // another's, which is what keeps the per-run guarantee per-run.
    const first = createWarnLatch()
    const second = createWarnLatch()

    expect(first.shouldWarn('same-key')).toBe(true)
    expect(second.shouldWarn('same-key')).toBe(true)
  })

  test('caps the distinct keys it tracks when `maxKeys` is given', () => {
    // A caller-controlled key dimension states its bound here rather than
    // reimplementing a key count beside the latch.
    const latch = createWarnLatch({ maxKeys: 2 })

    expect(latch.shouldWarn('a')).toBe(true)
    expect(latch.shouldWarn('b')).toBe(true)
    // Past the cap a fresh key is not reported...
    expect(latch.shouldWarn('c')).toBe(false)
    // ...and is not remembered either, so the key set stays at the cap.
    expect(latch.shouldWarn('d')).toBe(false)
    // Keys already reported stay latched, as they would be uncapped.
    expect(latch.shouldWarn('a')).toBe(false)

    // `clear` re-arms the budget along with the keys.
    latch.clear()
    expect(latch.shouldWarn('c')).toBe(true)
  })
})
