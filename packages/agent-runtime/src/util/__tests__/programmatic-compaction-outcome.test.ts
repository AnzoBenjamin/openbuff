import { describe, expect, test } from 'bun:test'

import { inlineCompactionOutcome } from '../programmatic-compaction-outcome'

import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { JSONObject } from '@codebuff/common/types/json'

const output = (receipt: JSONObject): ToolResultOutput[] => [
  { type: 'json', value: { agentReceipt: receipt } },
]

describe('inline compaction outcome classification', () => {
  test('uses the host receipt rather than a child result claiming success', () => {
    expect(
      inlineCompactionOutcome([
        {
          type: 'json',
          value: {
            result: { status: 'completed' },
            agentReceipt: {
              status: 'failed',
              output: { message: 'pruner failed' },
            },
          },
        },
      ]),
    ).toEqual({ outcome: 'failed', reason: 'pruner failed' })
  })

  test('missing, malformed and unrelated output cannot claim completion', () => {
    for (const result of [
      undefined,
      [],
      [{ type: 'json', value: { result: { status: 'completed' } } }],
    ] as Array<ToolResultOutput[] | undefined>)
      expect(inlineCompactionOutcome(result)).toMatchObject({
        outcome: 'failed',
        reason: expect.stringContaining('unconfirmed'),
      })
  })

  test('preserves an explicit skipped outcome and bounds its reason', () => {
    const message = 'Semantic compaction skipped: ' + 'x'.repeat(1_000)
    expect(
      inlineCompactionOutcome(
        output({ status: 'cancelled', output: { message } }),
      ),
    ).toEqual({ outcome: 'skipped', reason: message.slice(0, 400) })
  })

  test('prefers a host termination cause and bounds failure text', () => {
    const message = 'failure '.repeat(200)
    expect(
      inlineCompactionOutcome(
        output({
          status: 'failed',
          runOutcome: { termination: 'failed', cause: { message } },
          output: { message: 'less specific' },
        }),
      ),
    ).toEqual({ outcome: 'failed', reason: message.slice(0, 400) })
  })

  test('only a completed host receipt grants completion', () => {
    expect(
      inlineCompactionOutcome(output({ status: 'completed', output: {} })),
    ).toEqual({ outcome: 'completed' })
    expect(inlineCompactionOutcome(output({ status: 'unknown' }))).toEqual({
      outcome: 'failed',
      reason: 'Inline context pruner ended with unknown status.',
    })
  })
})
