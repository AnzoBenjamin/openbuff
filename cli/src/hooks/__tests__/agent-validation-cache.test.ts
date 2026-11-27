import { describe, expect, it } from 'bun:test'

import {
  createValidationCache,
  type ValidationCheckResult,
} from '../use-agent-validation'

// Plain bun:test over the EXPORTED PURE helper (no React rendering —
// rendering hooks is unreliable under React 19 + Bun, mirroring the
// export-pure-helpers-for-tests pattern of use-input-history.ts).
describe('createValidationCache (epoch-keyed validation cache)', () => {
  it('get before any set returns null', () => {
    const cache = createValidationCache()
    expect(cache.get(0)).toBeNull()
    expect(cache.get(7)).toBeNull()
  })

  it('set(epoch, result) then get(same epoch) returns that exact result', () => {
    const cache = createValidationCache()
    const result = { success: false, errors: [{ id: 'a', message: 'bad' }] }
    cache.set(3, result)
    // Identity, not deep equality: the hook returns the EXACT cached object.
    expect(cache.get(3)).toBe(result)
  })

  it('get(different epoch) returns null', () => {
    const cache = createValidationCache()
    const result = { success: true, errors: [] }
    cache.set(3, result)
    expect(cache.get(4)).toBeNull()
    expect(cache.get(2)).toBeNull()
  })

  it('a later set under a new epoch overwrites, and the old epoch misses', () => {
    const cache = createValidationCache()
    const stale = { success: false, errors: [{ id: 'a', message: 'bad' }] }
    cache.set(1, stale)
    const fresh = { success: true, errors: [] }
    cache.set(2, fresh)
    expect(cache.get(2)).toBe(fresh)
    // The registry reload invalidated the previous epoch's entry.
    expect(cache.get(1)).toBeNull()
  })

  it('a verdict cached against a mid-reload epoch is not served after the reload lands', () => {
    const cache = createValidationCache()
    const stale = { success: false, errors: [{ id: 'a', message: 'bad' }] }
    // A send mid-reload (after the load-start bump, before the reload's
    // content lands) validates the OLD registry content and caches that
    // verdict under the load-start epoch.
    const startEpoch = 7
    cache.set(startEpoch, stale)
    expect(cache.get(startEpoch)).toBe(stale)
    // The landing bump advances the epoch again; the hook re-reads it after
    // the bump, so the stale verdict is unreachable under the new epoch.
    expect(cache.get(startEpoch + 1)).toBeNull()
  })

  // IN-FLIGHT DEDUP (validation-cache-no-inflight-dedup): concurrent
  // same-epoch misses must JOIN one in-flight pass instead of each
  // re-running it — the "one epoch lookup per send" costing holds under
  // concurrent sends.
  it('getOrJoin dedups concurrent same-epoch misses onto ONE in-flight pass', async () => {
    const cache = createValidationCache()
    let passes = 0
    let release!: (result: ValidationCheckResult) => void
    const gate = new Promise<ValidationCheckResult>((resolve) => {
      release = resolve
    })
    const run = (): Promise<ValidationCheckResult> => {
      passes++
      return gate
    }
    // Two overlapping sends in the SAME registry epoch: both miss the
    // completed-result slot, but the second must JOIN the first's
    // in-flight pass rather than start its own.
    const first = cache.getOrJoin(4, run)
    const second = cache.getOrJoin(4, run)
    expect(passes).toBe(1)
    const result: ValidationCheckResult = { success: true, errors: [] }
    release(result)
    expect(await first).toBe(result)
    expect(await second).toBe(result)
    // The in-flight slot cleared on settle: a later same-epoch call starts
    // a FRESH pass (a settled pass is never joined).
    let laterPasses = 0
    const third = cache.getOrJoin(4, () => {
      laterPasses++
      return Promise.resolve(result)
    })
    expect(laterPasses).toBe(1)
    expect(await third).toBe(result)
  })

  it('getOrJoin isolates DIFFERENT epochs: a new-epoch pass does not join the old epoch\'s in-flight pass', async () => {
    const cache = createValidationCache()
    let oldPasses = 0
    let newPasses = 0
    const runOld = (): Promise<ValidationCheckResult> => {
      oldPasses++
      return Promise.resolve({ success: true, errors: [] })
    }
    const runNew = (): Promise<ValidationCheckResult> => {
      newPasses++
      return Promise.resolve({ success: false, errors: [] })
    }
    const old = cache.getOrJoin(1, runOld)
    // A send AFTER the load-start bump lands in a new epoch: it must run its
    // OWN pass, never join the old epoch's in-flight one (a pre-reload pass
    // result must never be served to a post-reload send).
    const fresh = cache.getOrJoin(2, runNew)
    expect(oldPasses).toBe(1)
    expect(newPasses).toBe(1)
    expect((await old).success).toBe(true)
    expect((await fresh).success).toBe(false)
  })

  it('a rejected in-flight pass is NOT joined after it settles, and its rejection propagates to joiners', async () => {
    const cache = createValidationCache()
    let passes = 0
    const run = (): Promise<ValidationCheckResult> => {
      passes++
      return Promise.reject(new Error('transient validation failure'))
    }
    const first = cache.getOrJoin(9, run)
    const second = cache.getOrJoin(9, run)
    // The single in-flight pass rejects; both callers observe the rejection.
    await expect(first).rejects.toThrow('transient validation failure')
    await expect(second).rejects.toThrow('transient validation failure')
    expect(passes).toBe(1)
    // The slot cleared on the rejected settle: the next call retries with a
    // FRESH pass (never cached, never joined onto the rejected one).
    const third = cache.getOrJoin(9, () =>
      Promise.resolve({ success: true, errors: [] }),
    )
    expect((await third).success).toBe(true)
  })
})
