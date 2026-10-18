import { describe, expect, test } from 'bun:test'
import { handleRecordDecision } from '../record-decision'
import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'

function buildAgentState(): AgentState {
  return { ancestorRunIds: ['root-run'], runId: 'parent-run', agentId: 'parent-agent' } as AgentState
}

function buildToolCall(input: Record<string, unknown>): CodebuffToolCall<'record_decision'> {
  return { toolName: 'record_decision', toolCallId: 'tool-call-1', input } as unknown as CodebuffToolCall<'record_decision'>
}

describe('handleRecordDecision', () => {
  test('records decision and evidence on happy path', async () => {
    const agentState = buildAgentState()
    const { output } = await handleRecordDecision({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall({ text: 'Chose Postgres for sessions because they must survive restarts', kind: 'decision', evidenceSelectors: ['docs/architecture.md'] }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    const value = (output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { message: string; kind: string; evidenceCount: number }
    expect(value.kind).toBe('decision')
    expect(value.evidenceCount).toBe(1)
    expect(agentState.taskMemory?.decisions.length).toBe(1)
    expect(agentState.taskMemory?.evidence.length).toBe(1)
  })
  test('skips a verbatim duplicate decision idempotently', async () => {
    const agentState = buildAgentState()
    const first = await handleRecordDecision({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall({ text: 'Chose Postgres because sessions must survive restarts', kind: 'decision', evidenceSelectors: ['docs/architecture.md'] }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    const firstValue = ((first.output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { errorMessage?: string })
    expect(firstValue.errorMessage).toBeUndefined()

    const second = await handleRecordDecision({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall({ text: 'Chose Postgres because sessions must survive restarts', kind: 'decision', evidenceSelectors: ['docs/other.md'] }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    const secondValue = ((second.output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { message?: string; evidenceCount?: number; errorMessage?: string })
    expect(secondValue.errorMessage).toBeUndefined()
    expect(secondValue.message).toContain('duplicate')
    expect(secondValue.evidenceCount).toBe(0)
    expect(agentState.taskMemory?.decisions.length).toBe(1)
    expect(agentState.taskMemory?.evidence.length).toBe(1)
  })
  test('does not dedupe a cross-kind restatement (fact vs decision)', async () => {
    const agentState = buildAgentState()
    const asDecision = await handleRecordDecision({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall({ text: 'Config uses port 8080 because the proxy expects it', kind: 'decision', evidenceSelectors: ['docs/a.md'] }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    expect(((asDecision.output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { errorMessage?: string }).errorMessage).toBeUndefined()

    const asFact = await handleRecordDecision({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall({ text: 'Config uses port 8080 because the proxy expects it', kind: 'fact', evidenceSelectors: ['docs/a.md'] }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    const factValue = ((asFact.output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { message?: string; evidenceCount?: number; errorMessage?: string })
    expect(factValue.errorMessage).toBeUndefined()
    // Different kind = different record: the fact is stored, not skipped.
    expect(factValue.message).not.toContain('duplicate')
    expect(agentState.taskMemory?.decisions.length).toBe(2)
    expect(agentState.taskMemory?.evidence.length).toBe(2)
  })
  test('rejects empty text without throwing', async () => {
    const agentState = buildAgentState()
    const { output } = await handleRecordDecision({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall({ text: '   ', kind: 'decision', evidenceSelectors: ['docs/a.md'] }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    const value = (output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { errorMessage?: string }
    expect(typeof value.errorMessage).toBe('string')
    expect(agentState.taskMemory?.decisions ?? []).toHaveLength(0)
  })
  test('rejects empty evidence without throwing', async () => {
    const agentState = buildAgentState()
    const { output } = await handleRecordDecision({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall({ text: 'Some decision', kind: 'fact', evidenceSelectors: [] }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    const value = (output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { errorMessage?: string }
    expect(typeof value.errorMessage).toBe('string')
  })
  test('rejects private evidence paths without throwing', async () => {
    const agentState = buildAgentState()
    const { output } = await handleRecordDecision({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall({ text: 'Some decision', kind: 'decision', evidenceSelectors: ['.openbuff/state.json'] }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    const value = (output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { errorMessage?: string }
    expect(typeof value.errorMessage).toBe('string')
  })
  test('rejects a decision without a rationale', async () => {
    const agentState = buildAgentState()
    const { output } = await handleRecordDecision({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall({ text: 'Updated the config file today', kind: 'decision', evidenceSelectors: ['docs/a.md'] }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    const value = (output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { errorMessage?: string }
    expect(typeof value.errorMessage).toBe('string')
    expect(agentState.taskMemory?.decisions ?? []).toHaveLength(0)
  })
  test('accepts a decision with a rationale', async () => {
    const agentState = buildAgentState()
    const { output } = await handleRecordDecision({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall({ text: 'Chose Postgres because sessions must survive restarts', kind: 'decision', evidenceSelectors: ['docs/architecture.md'] }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    const value = (output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { message?: string; kind?: string; errorMessage?: string }
    expect(value.errorMessage).toBeUndefined()
    expect(value.kind).toBe('decision')
    expect(agentState.taskMemory?.decisions.length).toBe(1)
  })
  test('does not gate a fact with short non-rationale text', async () => {
    const agentState = buildAgentState()
    const { output } = await handleRecordDecision({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall({ text: 'Config file exists', kind: 'fact', evidenceSelectors: ['docs/a.md'] }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    const value = (output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { kind?: string; errorMessage?: string }
    expect(value.errorMessage).toBeUndefined()
    expect(value.kind).toBe('fact')
    expect(agentState.taskMemory?.decisions.length).toBe(1)
  })
  test('echoes trimmed deduped supersedes ids in the success output', async () => {
    const agentState = buildAgentState()
    const { output } = await handleRecordDecision({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall({
        text: 'Chose Postgres for sessions because they must survive restarts',
        kind: 'decision',
        evidenceSelectors: ['docs/architecture.md'],
        supersedes: ['  observation:dup-2  ', 'observation:dup-1', 'observation:dup-2'],
      }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    const value = (output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { supersedes?: unknown; errorMessage?: string }
    expect(value.errorMessage).toBeUndefined()
    expect(value.supersedes).toEqual(['observation:dup-2', 'observation:dup-1'])
    expect(agentState.taskMemory?.decisions.length).toBe(1)
    // The normalized supersedes ids must be PERSISTED on the evidence record
    // (not only echoed) so normalizeEvidence can mark the targets stale.
    const evidence = agentState.taskMemory?.evidence ?? []
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.supersedes).toEqual(['observation:dup-2', 'observation:dup-1'])
  })
  test('omits supersedes from the output when not provided', async () => {
    const agentState = buildAgentState()
    const { output } = await handleRecordDecision({
      previousToolCallFinished: Promise.resolve(),
      toolCall: buildToolCall({ text: 'Chose Postgres for sessions because they must survive restarts', kind: 'decision', evidenceSelectors: ['docs/architecture.md'] }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    const value = (output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { supersedes?: unknown }
    expect(value.supersedes).toBeUndefined()
  })
  test('rejects invalid supersedes payloads without recording', async () => {
    const invalidPayloads: unknown[] = [
      [],
      ['   '],
      ['x'.repeat(129)],
      ['observation:a', 7],
      Array.from({ length: 17 }, (_, index) => 'observation:' + String(index)),
    ]
    for (const supersedes of invalidPayloads) {
      const agentState = buildAgentState()
      const { output } = await handleRecordDecision({
        previousToolCallFinished: Promise.resolve(),
        toolCall: buildToolCall({
          text: 'Chose Postgres for sessions because they must survive restarts',
          kind: 'decision',
          evidenceSelectors: ['docs/architecture.md'],
          supersedes,
        }),
        agentState,
      } as Parameters<typeof handleRecordDecision>[0])
      const value = (output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { errorMessage?: string }
      expect(value.errorMessage).toBe(
        'record_decision: supersedes must contain 1..16 observation id strings of at most 128 characters.',
      )
      expect(agentState.taskMemory?.decisions ?? []).toHaveLength(0)
    }
  })
})
