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
      toolCall: buildToolCall({ text: 'Use Postgres for sessions', kind: 'decision', evidenceSelectors: ['docs/architecture.md'] }),
      agentState,
    } as Parameters<typeof handleRecordDecision>[0])
    const value = (output as Array<{ type: string; value: Record<string, unknown> }>)[0].value as { message: string; kind: string; evidenceCount: number }
    expect(value.kind).toBe('decision')
    expect(value.evidenceCount).toBe(1)
    expect(agentState.taskMemory?.decisions.length).toBe(1)
    expect(agentState.taskMemory?.evidence.length).toBe(1)
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
})
