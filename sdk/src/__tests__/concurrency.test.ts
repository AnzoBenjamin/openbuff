import { describe, expect, test } from 'bun:test'

import {
  FILESYSTEM_FANOUT_CONCURRENCY,
  FILESYSTEM_RESERVED_INTERACTIVE_SLOTS,
  __getFilesystemMaxPhaseSlotsForTest,
  __getFilesystemMaxSlotsInUseForTest,
  __getFilesystemPhaseMaxSlotsForTest,
  __getFilesystemSlotsInUseForTest,
  __resetFilesystemMaxSlotsInUseForTest,
  __resetFilesystemPhaseStatsForTest,
  mapWithConcurrency,
  withFilesystemSlot,
} from '../tools/concurrency'

describe('mapWithConcurrency', () => {
  test('rethrows the first rejection only after every started call settles', async () => {
    const settled: number[] = []
    const result = mapWithConcurrency(
      [0, 1, 2, 3],
      2,
      async (value) => {
        await new Promise((resolve) => setTimeout(resolve, value === 0 ? 20 : 5))
        settled.push(value)
        if (value === 0) throw new Error('boom')
        return value
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The first failure does not cancel already-started work.
    expect(result).rejects.toThrow('boom')
    await result
      .catch(() => undefined)
      .then(() => undefined)
    expect(settled).toContain(1)
  })

  test('returns index-aligned results in input order', async () => {
    const results = await mapWithConcurrency(
      [10, 20, 30],
      2,
      async (value, index) => {
        // Delay the first item so completion order differs from input order.
        await new Promise((resolve) => setTimeout(resolve, index === 0 ? 20 : 1))
        return value + index
      },
    )
    // Results stay index-aligned with the inputs even though completion
    // order differs from input order.
    expect(results).toEqual([10, 21, 32])
  })

  test('never starts an item at or past the first failure', async () => {
    const started: number[] = []
    await mapWithConcurrency([0, 1, 2, 3, 4], 1, async (value) => {
      started.push(value)
      if (value === 1) throw new Error('stop')
      return value
    }).catch((error) => error)

    expect(started).toEqual([0, 1])
  })

  test('returns an index-aligned empty result for empty input', async () => {
    const results = await mapWithConcurrency([], 2, async (value) => value)
    expect(results).toEqual([])
  })

  test('throws RangeError for concurrency below 1 or non-integer', () => {
    expect(mapWithConcurrency([1], 0, async (v) => v)).rejects.toThrow(
      RangeError,
    )
    expect(mapWithConcurrency([1], -3, async (v) => v)).rejects.toThrow(
      RangeError,
    )
    expect(mapWithConcurrency([1], 1.5, async (v) => v)).rejects.toThrow(
      RangeError,
    )
    expect(mapWithConcurrency([1], Number.NaN, async (v) => v)).rejects.toThrow(
      RangeError,
    )
  })
})

describe('withFilesystemSlot', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

  test('bounds the AGGREGATE fan-out across overlapping call sites', async () => {
    // The regression this pins: `mapWithConcurrency` bounds one call site, so
    // two phases that each cap at 8 run together at 16 on the shared libuv pool.
    // Three concurrent width-8 batches are exactly the shape the aux gate
    // produces (discovery walk + manifest pre-reads + collector probes), and the
    // per-call-site widths all look correct in it.
    __resetFilesystemMaxSlotsInUseForTest()
    let live = 0
    let observedMax = 0
    const oneProbe = async () => {
      await withFilesystemSlot(async () => {
        live += 1
        observedMax = Math.max(observedMax, live)
        await settle()
        live -= 1
      })
    }

    await Promise.all([
      mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 8, oneProbe),
      mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 8, oneProbe),
      mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 8, oneProbe),
    ])

    // 24 gated probes, and never more than one call-site width of them at once.
    expect(observedMax).toBeLessThanOrEqual(FILESYSTEM_FANOUT_CONCURRENCY)
    expect(__getFilesystemMaxSlotsInUseForTest()).toBeLessThanOrEqual(
      FILESYSTEM_FANOUT_CONCURRENCY,
    )
    // ...and the gate did not degenerate into a serial loop.
    expect(observedMax).toBeGreaterThan(1)
  })

  test('does not leak a slot when a probe rejects', async () => {
    __resetFilesystemMaxSlotsInUseForTest()
    const failures = await mapWithConcurrency([0, 1, 2, 3], 2, async () => {
      try {
        await withFilesystemSlot(async () => {
          throw new Error('probe failed')
        })
      } catch {
        return 'failed'
      }
    })

    expect(failures).toEqual(['failed', 'failed', 'failed', 'failed'])
    // Every rejected probe returned its slot, so the process capacity is whole
    // again: a leaked slot would show up as a permanently shrunk bound and would
    // eventually deadlock the next phase.
    expect(__getFilesystemSlotsInUseForTest()).toBe(0)
  })

  test('an aborted waiter leaves the queue instead of draining syscalls', async () => {
    // A cancelled run must not keep issuing filesystem work. An already-aborted
    // signal never acquires; a waiter aborted WHILE queued splices itself out so
    // it is never handed a slot; and a caller aborted between grant and run
    // releases the slot without issuing the probe.
    const holder = new AbortController()
    const holderSignal = holder.signal
    const held = Array.from({ length: FILESYSTEM_FANOUT_CONCURRENCY }, () =>
      withFilesystemSlot(() => settle(), holderSignal),
    )

    const queuedAbort = new AbortController()
    let ranWhileQueued = false
    const queued = withFilesystemSlot(async () => {
      ranWhileQueued = true
    }, queuedAbort.signal)
    const queuedRejection = queued.catch((error: unknown) => error)

    queuedAbort.abort(new Error('cancelled while queued'))
    const queuedError = await queuedRejection
    expect(queuedError).toBeInstanceOf(Error)
    expect((queuedError as Error).message).toBe('cancelled while queued')
    expect(ranWhileQueued).toBe(false)

    // The aborted waiter must not have consumed a slot: after the holders
    // release, the count returns to zero rather than being handed to it.
    await Promise.all(held)
    expect(__getFilesystemSlotsInUseForTest()).toBe(0)

    // An already-aborted signal never queues and never runs the probe.
    const preAborted = new AbortController()
    preAborted.abort(new Error('already cancelled'))
    let ranAfterAbort = false
    const preAbortedError = await withFilesystemSlot(async () => {
      ranAfterAbort = true
    }, preAborted.signal).catch((error: unknown) => error)
    expect((preAbortedError as Error).message).toBe('already cancelled')
    expect(ranAfterAbort).toBe(false)
    expect(__getFilesystemSlotsInUseForTest()).toBe(0)
  })

  test('a waiter cancelled after release shifted it never takes the freed slot', async () => {
    // The regression this pins: `releaseFilesystemSlot` decremented the counter
    // and shifted the head waiter off the queue, but the waiter's own `grant`
    // could still refuse to take the slot (phase limit reached) and re-queue
    // itself. An abort landing in that window set the caller's promise to
    // rejected while the grant survived, so a later grant took a slot whose
    // `withFilesystemSlot` finally had already been skipped — a permanent leak.
    const phase = 'lateAbort'
    const narrowLimit = 1
    __resetFilesystemPhaseStatsForTest()

    // One gated holder at the phase width keeps the counter decremented by the
    // release while the phase itself is still at its limit...
    let releaseHolder = (): void => {}
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve
    })
    const holder = withFilesystemSlot(
      () => holderGate,
      undefined,
      phase,
      narrowLimit,
    )
    await settle()
    expect(__getFilesystemSlotsInUseForTest()).toBe(1)

    // ...and a second gated call in the same phase is what has to queue. It is
    // queued on the PHASE limit while the process still has free slots, so it
    // stays in `filesystemSlotWaiters` until something wakes it.
    const queuedAbort = new AbortController()
    let ranWhileQueued = false
    const queued = withFilesystemSlot(
      async () => {
        ranWhileQueued = true
      },
      queuedAbort.signal,
      phase,
      narrowLimit,
    )
    const queuedRejection = queued.catch((error: unknown) => error)
    await settle()

    // The abort lands while the waiter is genuinely still queued: it must
    // reject with the caller's own reason and never run the probe.
    queuedAbort.abort(new Error('cancelled while queued'))
    const queuedError = await queuedRejection
    expect((queuedError as Error).message).toBe('cancelled while queued')
    expect(ranWhileQueued).toBe(false)

    // Now release the holder. `releaseFilesystemSlot` hands the freed slot to
    // the next waiter — but the only waiter was cancelled, so it must forward
    // the still-free slot (or drop it) rather than take one nobody will ever
    // release. A leaked grant shows up here as a permanently shrunk budget.
    releaseHolder()
    await holder
    await settle()

    expect(ranWhileQueued).toBe(false)
    expect(__getFilesystemSlotsInUseForTest()).toBe(0)
  })

  test('aborting one queued waiter does not disturb the ones behind it', async () => {
    const held = Array.from({ length: FILESYSTEM_FANOUT_CONCURRENCY }, () =>
      withFilesystemSlot(() => settle()),
    )

    const order: number[] = []
    const cancelled = new AbortController()
    const first = withFilesystemSlot(async () => {
      order.push(0)
    }, cancelled.signal).catch(() => undefined)
    const survivors = [1, 2].map((id) =>
      withFilesystemSlot(async () => {
        order.push(id)
      }),
    )

    cancelled.abort(new Error('cancel the head waiter'))
    await Promise.all([...held, first, ...survivors])

    // The spliced-out waiter ran nothing, the queue stayed FIFO for the rest,
    // and every slot was released.
    expect(order).toEqual([1, 2])
    expect(__getFilesystemSlotsInUseForTest()).toBe(0)
  })

  test('drains a saturated queue in the order the waiters arrived', async () => {
    const order: number[] = []
    // Fill every slot first so the queued probes are genuinely waiting.
    const held = Array.from({ length: FILESYSTEM_FANOUT_CONCURRENCY }, () =>
      withFilesystemSlot(() => settle()),
    )
    const queued = [0, 1, 2].map((id) =>
      withFilesystemSlot(async () => {
        order.push(id)
      }),
    )

    await Promise.all([...held, ...queued])
    expect(order).toEqual([0, 1, 2])
    expect(__getFilesystemSlotsInUseForTest()).toBe(0)
  })

  test('no single phase can occupy the whole process-wide budget', async () => {
    // The finding this pins: the process cap bounded the AGGREGATE, but a phase
    // entering at its own tuned width (8) could still hold every slot, so an
    // overlapping interactive phase — or the render loop's own fs work — queued
    // behind a whole batch. Each phase now hands the gate its own width, which
    // the gate reduces by the reserved interactive headroom.
    __resetFilesystemPhaseStatsForTest()
    let live = 0
    let observedMax = 0
    const probeFor = (phase: string) => async () => {
      await withFilesystemSlot(
        async () => {
          live += 1
          observedMax = Math.max(observedMax, live)
          await settle()
          live -= 1
        },
        undefined,
        phase,
        FILESYSTEM_FANOUT_CONCURRENCY,
      )
    }

    // Two wide phases running together, the shape inspect_environment produces
    // (discovery walk + manifest pre-read + collector probes).
    await Promise.all([
      mapWithConcurrency(
        [0, 1, 2, 3, 4, 5, 6, 7],
        FILESYSTEM_FANOUT_CONCURRENCY,
        probeFor('walk'),
      ),
      mapWithConcurrency(
        [0, 1, 2, 3, 4, 5, 6, 7],
        FILESYSTEM_FANOUT_CONCURRENCY,
        probeFor('manifestPreRead'),
      ),
    ])

    // Still the process bound...
    expect(observedMax).toBeLessThanOrEqual(FILESYSTEM_FANOUT_CONCURRENCY)
    // ...and neither phase took the whole budget: one slot stayed reserved.
    const perPhase = __getFilesystemPhaseMaxSlotsForTest()
    expect(perPhase.walk).toBeLessThanOrEqual(
      FILESYSTEM_FANOUT_CONCURRENCY - FILESYSTEM_RESERVED_INTERACTIVE_SLOTS,
    )
    expect(perPhase.manifestPreRead).toBeLessThanOrEqual(
      FILESYSTEM_FANOUT_CONCURRENCY - FILESYSTEM_RESERVED_INTERACTIVE_SLOTS,
    )
    expect(__getFilesystemMaxPhaseSlotsForTest()).toBeLessThanOrEqual(
      FILESYSTEM_FANOUT_CONCURRENCY - FILESYSTEM_RESERVED_INTERACTIVE_SLOTS,
    )
    // Neither phase degenerated to serial, and both actually ran.
    expect(perPhase.walk).toBeGreaterThan(1)
    expect(perPhase.manifestPreRead).toBeGreaterThan(1)
    expect(__getFilesystemSlotsInUseForTest()).toBe(0)
  })

  test('a phase-named probe still respects the shared process cap', async () => {
    // The per-phase limit is an UPPER bound on one phase, never a bypass of the
    // process-wide one: three narrow phases together may still not exceed it.
    __resetFilesystemPhaseStatsForTest()
    let live = 0
    let observedMax = 0
    const probeFor = (phase: string) => async () => {
      await withFilesystemSlot(
        async () => {
          live += 1
          observedMax = Math.max(observedMax, live)
          await settle()
          live -= 1
        },
        undefined,
        phase,
        4,
      )
    }

    await Promise.all(
      ['a', 'b', 'c'].map((phase) =>
        mapWithConcurrency([0, 1, 2, 3], 4, probeFor(phase)),
      ),
    )

    expect(observedMax).toBeLessThanOrEqual(FILESYSTEM_FANOUT_CONCURRENCY)
    expect(observedMax).toBeGreaterThan(1)
    for (const held of Object.values(__getFilesystemPhaseMaxSlotsForTest())) {
      expect(held).toBeLessThanOrEqual(4)
    }
    expect(__getFilesystemSlotsInUseForTest()).toBe(0)
  })

  test('an unnamed call site keeps the previous ungated-by-phase behaviour', async () => {
    // Backwards compatibility: every existing caller passes only (probe, signal),
    // and must keep exactly the process-wide bound it had before phases existed.
    __resetFilesystemPhaseStatsForTest()
    let live = 0
    let observedMax = 0
    await Promise.all(
      Array.from({ length: FILESYSTEM_FANOUT_CONCURRENCY * 2 }, () =>
        withFilesystemSlot(async () => {
          live += 1
          observedMax = Math.max(observedMax, live)
          await settle()
          live -= 1
        }),
      ),
    )

    expect(observedMax).toBe(FILESYSTEM_FANOUT_CONCURRENCY)
    // No phase was named, so no phase attribution was recorded.
    expect(__getFilesystemPhaseMaxSlotsForTest()).toEqual({})
    expect(__getFilesystemSlotsInUseForTest()).toBe(0)
  })
})
