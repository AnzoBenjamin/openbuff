import { describe, expect, test } from 'bun:test'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

import {
  computeThinkerHarvestSignals,
  evaluateThinkerHarvest,
  extractMessageFromSetOutputInput,
} from '../thinker-harvest-signals'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function subagentStart(
  overrides: Partial<{
    agentId: string
    agentType: string
    onlyChild: boolean
    parentAgentId: string
  }> = {},
): PrintModeEvent {
  return {
    type: 'subagent_start',
    agentId: overrides.agentId ?? 'thinker-1',
    agentType: overrides.agentType ?? 'thinker',
    displayName: overrides.agentType ?? 'thinker',
    onlyChild: overrides.onlyChild ?? true,
    parentAgentId: overrides.parentAgentId,
  } as PrintModeEvent
}

function setOutputCall(params: {
  agentId: string
  toolCallId?: string
  input: Record<string, unknown>
  includeToolCall?: boolean
}): PrintModeEvent {
  return {
    type: 'tool_call',
    toolCallId: params.toolCallId ?? `so-${Math.random().toString(36).slice(2, 8)}`,
    toolName: 'set_output',
    input: params.input,
    agentId: params.agentId,
    includeToolCall: params.includeToolCall,
  } as PrintModeEvent
}

function textEvent(text: string, agentId?: string): PrintModeEvent {
  return { type: 'text', text, agentId } as PrintModeEvent
}

// ---------------------------------------------------------------------------
// extractMessageFromSetOutputInput
// ---------------------------------------------------------------------------

describe('extractMessageFromSetOutputInput', () => {
  test('recovers top-level message', () => {
    expect(
      extractMessageFromSetOutputInput({ message: 'final answer' }),
    ).toBe('final answer')
  })

  test('recovers nested data.message (LsHOhL5cwBo shape)', () => {
    expect(
      extractMessageFromSetOutputInput({
        data: { message: 'nested harvest answer' },
      }),
    ).toBe('nested harvest answer')
  })

  test('prefers top-level message when both are present', () => {
    expect(
      extractMessageFromSetOutputInput({
        message: 'top',
        data: { message: 'nested' },
      }),
    ).toBe('top')
  })

  test('returns undefined for empty, whitespace, or missing message', () => {
    expect(extractMessageFromSetOutputInput({ message: '' })).toBeUndefined()
    expect(extractMessageFromSetOutputInput({ message: '   ' })).toBeUndefined()
    expect(
      extractMessageFromSetOutputInput({ data: { message: '' } }),
    ).toBeUndefined()
    expect(extractMessageFromSetOutputInput({})).toBeUndefined()
    expect(extractMessageFromSetOutputInput(null)).toBeUndefined()
    expect(extractMessageFromSetOutputInput('x')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// computeThinkerHarvestSignals + evaluateThinkerHarvest
// ---------------------------------------------------------------------------

describe('thinker harvest signals', () => {
  test('LsHOhL5cwBo-style: non-empty data.message then empty harvest set_output fails', () => {
    const thinkerId = 'LsHOhL5cwBo'
    const events: PrintModeEvent[] = [
      subagentStart({ agentId: thinkerId, agentType: 'thinker' }),
      setOutputCall({
        agentId: thinkerId,
        toolCallId: 'so-nonempty',
        input: {
          data: {
            message:
              'The root cause is harvest clobbering the prior set_output.',
          },
        },
      }),
      setOutputCall({
        agentId: thinkerId,
        toolCallId: 'so-empty-harvest',
        input: { message: '' },
        includeToolCall: false,
      }),
    ]

    const signals = computeThinkerHarvestSignals({ events })
    expect(signals.thinkerAgentIds).toEqual([thinkerId])
    expect(signals.anyEmptyHarvestClobber).toBe(true)
    expect(signals.agents[0]).toMatchObject({
      agentId: thinkerId,
      emptyHarvestClobber: true,
      preservedNonEmpty: false,
      plainTextOnly: false,
      nonEmptySetOutputCount: 1,
      emptySetOutputCount: 1,
    })

    const evaluation = evaluateThinkerHarvest({ signals })
    expect(evaluation.verdict).toBe('fail')
    expect(evaluation.reasons.some((r) => r.includes(thinkerId))).toBe(true)
  })

  test('non-empty top-level message then empty harvest also clobbers', () => {
    const thinkerId = 'thinker-top'
    const events: PrintModeEvent[] = [
      subagentStart({ agentId: thinkerId }),
      setOutputCall({
        agentId: thinkerId,
        input: { message: 'good answer' },
      }),
      setOutputCall({
        agentId: thinkerId,
        input: { message: '' },
        includeToolCall: false,
      }),
    ]

    const signals = computeThinkerHarvestSignals({ events })
    expect(signals.agents[0].emptyHarvestClobber).toBe(true)
    expect(evaluateThinkerHarvest({ signals }).verdict).toBe('fail')
  })

  test('set_output-only good answer with no empty follow-up passes / preservedNonEmpty', () => {
    const thinkerId = 'thinker-good'
    const events: PrintModeEvent[] = [
      subagentStart({ agentId: thinkerId }),
      setOutputCall({
        agentId: thinkerId,
        input: { message: 'complete analysis of the bug' },
      }),
    ]

    const signals = computeThinkerHarvestSignals({ events })
    expect(signals.agents[0]).toMatchObject({
      emptyHarvestClobber: false,
      preservedNonEmpty: true,
      plainTextOnly: false,
      finalNonEmptyMessage: 'complete analysis of the bug',
    })
    expect(signals.anyPreservedNonEmpty).toBe(true)

    const evaluation = evaluateThinkerHarvest({ signals })
    expect(evaluation.verdict).toBe('pass')
    expect(evaluation.reasons[0]).toContain('preserved non-empty')
  })

  test('plain text only (no set_output) skips — harvest clobber not applicable', () => {
    const thinkerId = 'thinker-plain'
    const events: PrintModeEvent[] = [
      subagentStart({ agentId: thinkerId }),
      textEvent('Just reasoning in plain text.', thinkerId),
    ]

    const signals = computeThinkerHarvestSignals({ events })
    expect(signals.agents[0]).toMatchObject({
      plainTextOnly: true,
      emptyHarvestClobber: false,
      preservedNonEmpty: false,
      setOutputCount: 0,
    })
    expect(signals.allPlainTextOnly).toBe(true)

    // Prefer skip when no set_output at all for thinker(s).
    const evaluation = evaluateThinkerHarvest({ signals })
    expect(evaluation.verdict).toBe('skip')
    expect(evaluation.reasons[0]).toContain('plain text only')
  })

  test('no thinker in trace → skip', () => {
    const events: PrintModeEvent[] = [
      subagentStart({ agentId: 'fp-1', agentType: 'file-picker' }),
      setOutputCall({
        agentId: 'fp-1',
        input: { message: 'not a thinker' },
      }),
      textEvent('top-level text'),
    ]

    const signals = computeThinkerHarvestSignals({ events })
    expect(signals.thinkerAgentIds).toEqual([])
    expect(signals.agents).toEqual([])

    const evaluation = evaluateThinkerHarvest({ signals })
    expect(evaluation.verdict).toBe('skip')
    expect(evaluation.reasons[0]).toContain('No thinker')
  })

  test('empty set_output without a prior non-empty is not emptyHarvestClobber but fails', () => {
    const thinkerId = 'thinker-empty-only'
    const events: PrintModeEvent[] = [
      subagentStart({ agentId: thinkerId }),
      setOutputCall({
        agentId: thinkerId,
        input: { message: '' },
        includeToolCall: false,
      }),
    ]

    const signals = computeThinkerHarvestSignals({ events })
    expect(signals.agents[0].emptyHarvestClobber).toBe(false)
    expect(signals.agents[0].preservedNonEmpty).toBe(false)
    expect(evaluateThinkerHarvest({ signals }).verdict).toBe('fail')
  })

  test('evaluates multiple thinkers independently then aggregates', () => {
    const goodId = 'thinker-good'
    const badId = 'thinker-bad'
    const events: PrintModeEvent[] = [
      subagentStart({ agentId: goodId }),
      subagentStart({ agentId: badId }),
      setOutputCall({
        agentId: goodId,
        input: { message: 'solid answer' },
      }),
      setOutputCall({
        agentId: badId,
        input: { data: { message: 'will be clobbered' } },
      }),
      setOutputCall({
        agentId: badId,
        input: { message: '' },
        includeToolCall: false,
      }),
    ]

    const signals = computeThinkerHarvestSignals({ events })
    expect(signals.thinkerAgentIds).toEqual([goodId, badId])
    expect(signals.agents.find((a) => a.agentId === goodId)?.preservedNonEmpty).toBe(
      true,
    )
    expect(
      signals.agents.find((a) => a.agentId === badId)?.emptyHarvestClobber,
    ).toBe(true)
    expect(signals.anyEmptyHarvestClobber).toBe(true)

    // Any clobber fails the aggregate verdict.
    expect(evaluateThinkerHarvest({ signals }).verdict).toBe('fail')
  })

  test('ignores set_output from non-thinker agentIds', () => {
    const thinkerId = 'thinker-1'
    const events: PrintModeEvent[] = [
      subagentStart({ agentId: thinkerId }),
      setOutputCall({
        agentId: 'other-agent',
        input: { message: 'ignored' },
      }),
      setOutputCall({
        agentId: thinkerId,
        input: { message: 'kept' },
      }),
    ]

    const signals = computeThinkerHarvestSignals({ events })
    expect(signals.agents[0].setOutputCount).toBe(1)
    expect(signals.agents[0].preservedNonEmpty).toBe(true)
    expect(evaluateThinkerHarvest({ signals }).verdict).toBe('pass')
  })
})
