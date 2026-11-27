import { expect, test } from 'bun:test'
import { classifyOutputOutcome, outcomeForTool } from '../output-outcome'
import { committedMutationFixture } from '@codebuff/common/testing/fixtures/file-mutation'
import { summarizeSpawnResult } from '../../components/tools/spawn-agents'
import { extractReceiptCore } from '../../components/tools/set-output'
import { outcomeTone } from '../../components/tools/human-result'

test.each([
  ['BLOCKING', 'bad', 'error'],
  ['NON_BLOCKING', 'warn', 'warning'],
  ['rejected', 'bad', 'error'],
  ['LOOKS_GOOD', 'good', 'success'],
  ['unknown status', 'neutral', 'muted'],
] as const)(
  'receipt, child and generic output agree on %s',
  (outcome, tone, color) => {
    expect(classifyOutputOutcome(outcome)).toBe(tone)
    expect(outcomeTone(outcome)).toBe(tone)
    expect(extractReceiptCore({ status: outcome }).outcomeKind).toBe(tone)
    expect(
      summarizeSpawnResult({ agentType: 'custom', value: { status: outcome } })
        .color,
    ).toBe(color)
  },
)

test('raw applied status without authority is unconfirmed across CLI outcome projection', () => {
  const mutation = committedMutationFixture([
    { path: 'a.ts', content: 'after' },
  ])
  const { authorityReceipt: _receipt, ...unbacked } = mutation
  expect(
    outcomeForTool({
      toolName: 'write_file',
      lifecycle: 'succeeded',
      outputRaw: [{ type: 'json', value: unbacked }],
    }),
  ).toMatchObject({ label: 'unconfirmed', tone: 'warn' })
  expect(
    outcomeForTool({
      toolName: 'write_file',
      lifecycle: 'succeeded',
      outputRaw: [{ type: 'json', value: mutation }],
    }),
  ).toMatchObject({ label: 'applied', tone: 'good' })
})
