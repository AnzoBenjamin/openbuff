import { describe, expect, test } from 'bun:test'
import { observeRetryWait } from '../services/retry-wait-status'

function scheduler() {
  let now = 0,
    id = 0
  const tasks = new Map<number, { at: number; run(): void }>()
  const options = {
    now: () => now,
    set(delay: number, run: () => void) {
      tasks.set(++id, { at: now + delay, run })
      return id
    },
    clear(timer: unknown) {
      tasks.delete(timer as number)
    },
  }
  return {
    options,
    tasks,
    advance(ms: number) {
      now += ms
      for (const [key, task] of [...tasks])
        if (task.at <= now) {
          tasks.delete(key)
          task.run()
        }
    },
  }
}
describe('owned streaming retry countdown observations', () => {
  test('reports actual elapsed 45-second wait without changing its sleep argument or adding attempts', async () => {
    const clock = scheduler(),
      remaining: number[] = []
    let finish!: () => void,
      calls = 0
    const waiting = observeRetryWait({
      delayMs: 45_000,
      sleep: async (ms) => {
        calls++
        expect(ms).toBe(45_000)
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      },
      onRemaining: (ms) => remaining.push(ms),
      scheduler: clock.options,
    })
    clock.advance(1_000)
    clock.advance(1_000)
    clock.advance(7_000)
    expect(remaining).toEqual([44_000, 43_000, 36_000])
    expect(calls).toBe(1)
    finish()
    await waiting
    expect(remaining.at(-1)).toBe(0)
    expect(clock.tasks.size).toBe(0)
    clock.advance(60_000)
    expect(remaining.at(-1)).toBe(0)
  })
  test('abort stops observation promptly even if an injected sleep has not settled', async () => {
    const clock = scheduler(),
      abort = new AbortController(),
      remaining: number[] = []
    let finish!: () => void
    const waiting = observeRetryWait({
      delayMs: 45_000,
      signal: abort.signal,
      sleep: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
      onRemaining: (ms) => remaining.push(ms),
      scheduler: clock.options,
    })
    clock.advance(1_000)
    abort.abort(new Error('stop retry'))
    expect(clock.tasks.size).toBe(0)
    clock.advance(60_000)
    expect(remaining).toEqual([44_000])
    finish()
    await waiting
    expect(remaining).toEqual([44_000])
  })
  test('a reentrant observer abort cannot rearm its countdown timer', async () => {
    const clock = scheduler(),
      abort = new AbortController()
    let finish!: () => void
    const pending = observeRetryWait({
      delayMs: 45_000,
      signal: abort.signal,
      sleep: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
      onRemaining() {
        abort.abort(new Error('observer caused cancellation'))
      },
      scheduler: clock.options,
    })
    clock.advance(1_000)
    expect(clock.tasks.size).toBe(0)
    finish()
    await pending
    expect(clock.tasks.size).toBe(0)
  })

  test('instant waits do not invent countdown ticks and observers cannot change retry behavior', async () => {
    const clock = scheduler(),
      observed: number[] = []
    await observeRetryWait({
      delayMs: 45_000,
      sleep: async () => {},
      onRemaining: (ms) => observed.push(ms),
      scheduler: clock.options,
    })
    expect(observed).toEqual([])
    expect(clock.tasks.size).toBe(0)
    let finish!: () => void
    const waiting = observeRetryWait({
      delayMs: 2_000,
      sleep: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
      onRemaining() {
        throw new Error('observer only')
      },
      scheduler: clock.options,
    })
    clock.advance(1_000)
    finish()
    await waiting
    expect(clock.tasks.size).toBe(0)
  })
})
