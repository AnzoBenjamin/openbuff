import { describe, expect, test } from 'bun:test'
import { printModeEventSchema } from '../print-mode'

describe('per-request usage events', () => {
  test('explicit zero counts are representable and missing usage stays unknown', () => {
    expect(
      printModeEventSchema.parse({
        type: 'usage',
        runId: 'run',
        inputTokens: 0,
        outputTokens: 0,
        complete: true,
      }),
    ).toMatchObject({ inputTokens: 0, outputTokens: 0 })
    const unknown = printModeEventSchema.parse({
      type: 'usage',
      runId: 'run',
      complete: false,
    })
    expect(unknown).not.toHaveProperty('inputTokens')
    expect(unknown).not.toHaveProperty('outputTokens')
  })
  for (const value of [-1, 0.2, Infinity, NaN])
    test('invalid counts cannot cross the public usage schema', () => {
      expect(
        printModeEventSchema.safeParse({
          type: 'usage',
          runId: 'run',
          inputTokens: value,
          complete: false,
        }).success,
      ).toBe(false)
    })
})
