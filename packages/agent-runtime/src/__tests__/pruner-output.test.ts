import { describe, expect, it } from 'bun:test'
import { getInitialAgentState } from '@codebuff/common/types/session-state'

import { handleSetMessages } from '../tools/handlers/tool/set-messages'
import { buildRuntimeAgentReceipt } from '../tools/handlers/tool/spawn-agent-utils'
import { getAgentOutput } from '../util/agent-output'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { CodebuffToolCall } from '@codebuff/common/tools/list'

describe('context pruner transaction output', () => {
  it('returns a structured success even when the transcript contains no assistant message', async () => {
    const state = {
      ...getInitialAgentState(),
      agentType: 'openbuff/context-pruner@1.0.0',
    }
    const messages = [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'hello' }],
      },
    ]
    await handleSetMessages({
      agentState: state,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolName: 'set_messages',
        toolCallId: 'test',
        input: { messages },
      },
    })
    const output = getAgentOutput(state, {
      outputMode: 'structured_output',
    } as AgentTemplate)
    expect(output).toEqual({
      type: 'structuredOutput',
      value: { message: 'Context update applied.' },
    })
    expect(state.messageHistory).toEqual(messages)
    expect(
      buildRuntimeAgentReceipt({
        agentType: state.agentType,
        agentId: state.agentId,
        agentState: state,
        output,
      }).status,
    ).toBe('completed')
  })

  it('does not report success or replace history when the transaction is rejected', async () => {
    const state = { ...getInitialAgentState(), agentType: 'context-pruner' }
    const originalHistory = state.messageHistory
    const toolCall = {
      toolName: 'set_messages',
      toolCallId: 'test',
      input: { messages: [], taskMemory: {}, expectedTaskMemoryRevision: 3 },
    } as unknown as CodebuffToolCall<'set_messages'>
    await expect(
      handleSetMessages({
        agentState: state,
        previousToolCallFinished: Promise.resolve(),
        toolCall,
      }),
    ).rejects.toThrow('revision conflict')
    expect(state.messageHistory).toBe(originalHistory)
    expect(state.output).toBeUndefined()
  })
})
