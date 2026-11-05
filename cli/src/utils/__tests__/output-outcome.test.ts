import { expect, test } from 'bun:test'
import { classifyOutputOutcome } from '../output-outcome'
import { summarizeSpawnResult } from '../../components/tools/spawn-agents'
import { extractReceiptCore } from '../../components/tools/set-output'
import { outcomeTone } from '../../components/tools/human-result'

test.each([['BLOCKING', 'bad', 'error'], ['NON_BLOCKING', 'warn', 'warning'], ['rejected', 'bad', 'error'], ['LOOKS_GOOD', 'good', 'success'], ['unknown status', 'neutral', 'muted']] as const)('receipt, child and generic output agree on %s', (outcome, tone, color) => {
  expect(classifyOutputOutcome(outcome)).toBe(tone)
  expect(outcomeTone(outcome)).toBe(tone)
  expect(extractReceiptCore({ status: outcome }).outcomeKind).toBe(tone)
  expect(summarizeSpawnResult({ agentType: 'custom', value: { status: outcome } }).color).toBe(color)
})
