import { describe, expect, test } from 'bun:test'

import { mapWithConcurrency } from '../tools/concurrency'

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
