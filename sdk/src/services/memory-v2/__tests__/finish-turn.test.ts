import { describe, expect, test } from 'bun:test'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { finishMemoryV2Turn } from '../finish-turn'

const output = { type: 'lastMessage' as const, value: [] }
describe('independent terminal memory finalization wait', () => {
  test('an already aborted productive-run signal selects cancellation without abandoning persistence', async () => {
    const signal = AbortSignal.abort(new Error('cancelled work'))
    let entered!: () => void, release!: () => void
    const arrived = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let settled = false
    const pending = finishMemoryV2Turn({
      agentState: getInitialAgentState(),
      output,
      signal,
      coordinator: {
        async finishTurn(input) {
          expect(input.signal).toBe(signal)
          entered()
          await gate
        },
      },
    }).then(() => {
      settled = true
    })
    await arrived
    expect(settled).toBe(false)
    release()
    await pending
    expect(settled).toBe(true)
  })
  test('uncooperative optional maintenance remains bounded and late rejection is observed', async () => {
    let reject!: (error: Error) => void
    const pending = new Promise<void>((_, fail) => {
      reject = fail
    })
    const warnings: string[] = []
    await finishMemoryV2Turn({
      agentState: getInitialAgentState(),
      output,
      waitMs: 10,
      coordinator: { finishTurn: () => pending },
      logger: {
        warn(_fields, message) {
          warnings.push(message ?? '')
        },
      },
    })
    expect(warnings.join(' ')).toContain('wait expired')
    reject(new Error('late maintenance error'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(warnings.join(' ')).toContain('finalization failed')
  })
  test('sync observer and logger failures never change the run effect', async () => {
    await expect(
      finishMemoryV2Turn({
        agentState: getInitialAgentState(),
        output,
        coordinator: {
          finishTurn() {
            throw new Error('metadata failure')
          },
        },
        logger: {
          warn() {
            throw new Error('logger failure')
          },
        },
      }),
    ).resolves.toBeUndefined()
  })
})
