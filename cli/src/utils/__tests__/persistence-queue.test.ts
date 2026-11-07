import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  MAX_PENDING_PERSISTENCE_WRITES,
  atomicWriteJsonFile,
  awaitPersistenceWrite,
  cancelAndDrainPendingWriteFor,
  cancelPendingPersistenceWrite,
  drainPersistenceQueue,
  pendingPersistenceWriteCount,
  schedulePersistenceWrite,
} from '../persistence-queue'

let tempDir: string

describe('persistence-queue', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-persistence-queue-'),
    )
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('atomicWriteJsonFile', () => {
    test('writes content atomically with no temp leftovers', async () => {
      const target = path.join(tempDir, 'log-a.json')
      await atomicWriteJsonFile(target, '{"a":1}', { mode: 0o600 })

      expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}')
      expect(
        fs.readdirSync(tempDir).some((name) => name.includes('.tmp.')),
      ).toBe(false)
    })

    test('replaces an existing destination and keeps an explicit tmp name', async () => {
      const target = path.join(tempDir, 'log-b.json')
      const explicitTmp = `${target}.tmp.${process.pid}`
      await atomicWriteJsonFile(target, '{"v":1}', { tmpPath: explicitTmp })
      await atomicWriteJsonFile(target, '{"v":2}', { tmpPath: explicitTmp })

      expect(fs.readFileSync(target, 'utf8')).toBe('{"v":2}')
      expect(fs.existsSync(explicitTmp)).toBe(false)
    })
  })

  describe('coalescing', () => {
    test('a later same-target request replaces an earlier pending write', async () => {
      let supersededRuns = 0
      let survivingRuns = 0
      const supersededDone = awaitPersistenceWrite({
        targetKey: 'coalesced-target',
        label: 'coalesced-target.json',
        run: async () => {
          supersededRuns += 1
        },
      })
      const survivingDone = awaitPersistenceWrite({
        targetKey: 'coalesced-target',
        label: 'coalesced-target.json',
        run: async () => {
          survivingRuns += 1
        },
      })

      // Both requests were enqueued before the pump's deferred first tick,
      // so the second replaced the first instead of stacking behind it.
      expect(pendingPersistenceWriteCount()).toBe(1)

      const [supersededResult, survivingResult] = await Promise.all([
        supersededDone,
        survivingDone,
      ])
      expect(supersededRuns).toBe(0)
      expect(survivingRuns).toBe(1)
      expect(supersededResult).toBe(true)
      expect(survivingResult).toBe(true)
      expect(pendingPersistenceWriteCount()).toBe(0)
    })

    test('coalesced content round-trips to disk via awaitPersistenceWrite', async () => {
      const target = path.join(tempDir, 'coalesced.json')
      const firstDone = awaitPersistenceWrite({
        targetKey: target,
        label: target,
        run: () => atomicWriteJsonFile(target, '{"turn":1}'),
      })
      const secondDone = awaitPersistenceWrite({
        targetKey: target,
        label: target,
        run: () => atomicWriteJsonFile(target, '{"turn":2}'),
      })

      expect(await firstDone).toBe(true)
      expect(await secondDone).toBe(true)
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ turn: 2 })
    })
  })

  describe('drop-oldest bound', () => {
    test('evicts the oldest pending write when the queue is full', async () => {
      const done: Array<Promise<boolean>> = []
      for (let i = 0; i <= MAX_PENDING_PERSISTENCE_WRITES; i += 1) {
        done.push(
          awaitPersistenceWrite({
            targetKey: `drop-oldest-${i}`,
            label: `drop-oldest-${i}.json`,
            run: async () => {},
          }),
        )
      }

      const results = await Promise.all(done)
      // The very first request was evicted when the queue filled.
      expect(results[0]).toBe(false)
      expect(results.slice(1).every((result) => result)).toBe(true)
      expect(pendingPersistenceWriteCount()).toBe(0)
    })
  })

  describe('drain', () => {
    test('resolves after all queued writes complete', async () => {
      const targetA = path.join(tempDir, 'drain-a.json')
      const targetB = path.join(tempDir, 'drain-b.json')
      awaitPersistenceWrite({
        targetKey: 'drain-a',
        label: targetA,
        run: () => atomicWriteJsonFile(targetA, 'a'),
      })
      awaitPersistenceWrite({
        targetKey: 'drain-b',
        label: targetB,
        run: () => atomicWriteJsonFile(targetB, 'b'),
      })

      await drainPersistenceQueue()

      expect(fs.readFileSync(targetA, 'utf8')).toBe('a')
      expect(fs.readFileSync(targetB, 'utf8')).toBe('b')
      expect(pendingPersistenceWriteCount()).toBe(0)
    })

    test('the beforeExit hook flushes queued writes on normal unwind', async () => {
      const target = path.join(tempDir, 'exit-flush.json')
      let releaseGate!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      const done = awaitPersistenceWrite({
        targetKey: 'exit-flush',
        label: target,
        run: async () => {
          await gate
          await atomicWriteJsonFile(target, 'flushed-on-exit')
        },
      })

      // Exercise the exit hook's trigger directly: a pending write must
      // survive a normal event-loop unwind through the registered drain.
      ;(
        process as unknown as {
          emit: (event: string) => boolean
        }
      ).emit('beforeExit')
      expect(fs.existsSync(target)).toBe(false)

      releaseGate()
      await done
      expect(fs.readFileSync(target, 'utf8')).toBe('flushed-on-exit')
      expect(pendingPersistenceWriteCount()).toBe(0)
    })
  })

  describe('fail-soft error reporting', () => {
    test('a failed write resolves false and reports without throwing', async () => {
      const errorSpy = spyOn(console, 'error')
      const failed = awaitPersistenceWrite({
        targetKey: 'failing-target',
        label: 'failing.json',
        run: async () => {
          throw new Error('boom')
        },
      })

      expect(await failed).toBe(false)
      expect(
        errorSpy.mock.calls.some((call) =>
          String(call[0]).includes('persistence-queue write failed: boom'),
        ),
      ).toBe(true)
      errorSpy.mockRestore()

      await drainPersistenceQueue()
      expect(pendingPersistenceWriteCount()).toBe(0)
    })

    test('a custom onError replaces console.error and reports still never throw', async () => {
      const errors: Array<Error | string> = []
      const errorSpy = spyOn(console, 'error')
      const failed = awaitPersistenceWrite({
        targetKey: 'custom-error-target',
        label: 'custom-error.json',
        run: async () => {
          throw new Error('custom-boom')
        },
        onError: (error) => {
          errors.push(error instanceof Error ? error.message : String(error))
        },
      })

      expect(await failed).toBe(false)
      expect(errors).toEqual(['custom-boom'])
      expect(errorSpy).not.toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    test('schedulePersistenceWrite never rejects the caller', async () => {
      const errorSpy = spyOn(console, 'error')
      schedulePersistenceWrite({
        targetKey: 'schedule-fail',
        label: 'schedule-fail.json',
        run: async () => {
          throw new Error('schedule-boom')
        },
      })

      await drainPersistenceQueue()
      errorSpy.mockRestore()
      expect(pendingPersistenceWriteCount()).toBe(0)
    })
  })

  describe('cancelAndDrainPendingWriteFor', () => {
    test('serializes an in-flight write before returning', async () => {
      // Regression for the checkpoint-resurrection race: the pump deletes the
      // pendingWrites entry BEFORE awaiting run(), so a write that is already
      // IN FLIGHT is invisible to cancelPendingPersistenceWrite. The drain
      // variant must wait for that in-flight write to settle before the
      // caller's unlink would run.
      let ran = false
      let releaseWrite!: () => void
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
      const target = path.join(tempDir, 'serialize-target.json')
      const inflight = awaitPersistenceWrite({
        targetKey: 'serialize-target',
        label: target,
        run: async () => {
          // The pump dequeues BEFORE awaiting this run body, so once this
          // gated await is reached the write is officially in flight and no
          // longer reachable through pendingWrites.
          ran = true
          await writeGate
          await atomicWriteJsonFile(target, 'in-flight')
        },
      })

      // Let the pump's deferred first tick dequeue the write and reach its
      // gated body: the write is now in flight but still blocked.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(ran).toBe(true)

      const drained = cancelAndDrainPendingWriteFor('serialize-target')
      let drainSettled = false
      void drained.then(() => {
        drainSettled = true
      })

      // While the gate holds, the drain must NOT resolve in flight even
      // though the queue map is already empty (cancel returned false).
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(drainSettled).toBe(false)

      releaseWrite()
      await Promise.all([inflight, drained])
      expect(drainSettled).toBe(true)
      expect(fs.readFileSync(target, 'utf8')).toBe('in-flight')
      expect(pendingPersistenceWriteCount()).toBe(0)
    })

    test('resolves immediately when the queue is idle', async () => {
      expect(await cancelAndDrainPendingWriteFor('idle-target')).toBe(false)
    })
  })

  describe('cancelPendingPersistenceWrite', () => {
    test('drops a pending write without running it', async () => {
      let ran = false
      const doomed = awaitPersistenceWrite({
        targetKey: 'canceled-target',
        label: 'canceled.json',
        run: async () => {
          ran = true
        },
      })

      expect(cancelPendingPersistenceWrite('canceled-target')).toBe(true)
      expect(await doomed).toBe(false)
      expect(ran).toBe(false)
      expect(pendingPersistenceWriteCount()).toBe(0)
    })

    test('returns false when no write is pending', () => {
      expect(
        cancelPendingPersistenceWrite('never-scheduled-target'),
      ).toBe(false)
    })
  })
})
