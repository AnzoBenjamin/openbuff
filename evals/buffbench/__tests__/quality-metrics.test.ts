import { describe, expect, test } from 'bun:test'

import { createBase2 } from '../../../agents/base2/base2'
import {
  aggregateQualityMetrics,
  computeRunQualityMetrics,
  formatQualityMetricsTable,
} from '../quality-metrics'
import { computeStaticPromptTokens } from '../static-prompt-tokens'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

let nextId = 0
function call(toolName: string): PrintModeEvent {
  return {
    type: 'tool_call',
    toolCallId: `c${nextId++}`,
    toolName,
    input: {},
  } as PrintModeEvent
}
function result(
  toolName: string,
  value: unknown,
  outcome?: 'succeeded' | 'failed' | 'refused' | 'uncertain',
): PrintModeEvent {
  return {
    type: 'tool_result',
    toolCallId: `r${nextId++}`,
    toolName,
    output: [{ type: 'json', value }],
    ...(outcome && {
      actionOutcome: {
        actionId: 'a',
        attemptId: 'b',
        runId: 'c',
        toolName,
        basis: { inputHash: 'h' },
        outcome,
      },
    }),
  } as PrintModeEvent
}

const TRACE: PrintModeEvent[] = [
  call('read_files'),
  result('read_files', [{ path: 'a.ts', content: 'x' }]),
  call('go_to_definition'),
  result('go_to_definition', { locations: [] }),
  call('edit_transaction'),
  result('edit_transaction', { message: 'ok', files: [] }),
  call('str_replace'),
  result('str_replace', { errorMessage: 'no match' }),
  call('write_file'),
  result('write_file', { message: 'written' }, 'uncertain'),
  call('run_terminal_command'),
  result('run_terminal_command', { stdout: '' }, 'refused'),
  { type: 'text', text: 'done' } as PrintModeEvent,
]

describe('computeRunQualityMetrics (N10)', () => {
  test('counts tool errors, committed edits and LSP calls', () => {
    expect(computeRunQualityMetrics(TRACE)).toEqual({
      toolCallCount: 6,
      toolResultCount: 6,
      // str_replace errorMessage + refused terminal command
      toolErrorCount: 2,
      editResultCount: 3,
      // edit_transaction only: str_replace failed, write_file uncertain
      editCommittedCount: 1,
      lspCallCount: 1,
    })
  })

  test('empty trace has no rates', () => {
    const metrics = aggregateQualityMetrics([computeRunQualityMetrics([])])
    expect(metrics.editCommitRate).toBeUndefined()
    expect(metrics.toolErrorRate).toBeUndefined()
    expect(metrics.lspCallRate).toBeUndefined()
  })

  test('aggregates pooled rates per model and skips runs without metrics', () => {
    const run = computeRunQualityMetrics(TRACE)
    const metrics = aggregateQualityMetrics([run, undefined, run], {
      model: 'anthropic/claude-sonnet',
      staticPromptTokens: 1234,
    })
    expect(metrics.runCount).toBe(2)
    expect(metrics.editCommitRate).toBeCloseTo(1 / 3)
    expect(metrics.toolErrorRate).toBeCloseTo(2 / 6)
    expect(metrics.lspCallRate).toBeCloseTo(1 / 6)
    const table = formatQualityMetricsTable({ base2: metrics })
    expect(table).toContain(
      '| base2 | anthropic/claude-sonnet | 2 | 33.3% (2/6)',
    )
    expect(table).toContain('| 1234 |')
  })
})

describe('computeStaticPromptTokens (N10)', () => {
  test('counts base2 prompts and every tool definition offline', async () => {
    const base2 = createBase2('default')
    const tokens = await computeStaticPromptTokens(base2)
    expect(tokens.toolCount).toBe(base2.toolNames?.length ?? 0)
    expect(tokens.promptTokens).toBeGreaterThan(1000)
    expect(tokens.toolTokens).toBeGreaterThan(1000)
    expect(tokens.total).toBe(tokens.promptTokens + tokens.toolTokens)
  })

  test('a longer system prompt raises the count', async () => {
    const base = { systemPrompt: 'short prompt', toolNames: [] }
    const small = await computeStaticPromptTokens(base)
    const large = await computeStaticPromptTokens({
      ...base,
      systemPrompt: 'short prompt '.repeat(500),
    })
    expect(large.total).toBeGreaterThan(small.total * 50)
  })
})
