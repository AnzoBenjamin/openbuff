import { describe, expect, test } from 'bun:test'

import { handleRunTerminalCommand } from '../run-terminal-command'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { ClientToolCall } from '@codebuff/common/tools/list'

type ToolName = 'run_terminal_command'

const baseAgentTemplate = {
  id: 'base/base@1.0.0' as AgentTemplate['id'],
  displayName: 'Base',
  mcpServers: {},
  toolNames: [],
  spawnableAgents: [],
  systemPrompt: '',
  instructionsPrompt: '',
  stepPrompt: '',
  inputSchema: {},
  includeMessageHistory: true,
  inheritParentSystemPrompt: true,
  outputMode: 'last_message' as const,
}

const makeToolCall = (extraInput: Record<string, unknown> = {}) => ({
  toolName: 'run_terminal_command' as const,
  toolCallId: 'tool-1',
  input: {
    command: 'git status',
    ...extraInput,
  },
})

const runHandler = async ({
  agentTemplate,
  toolCall,
}: {
  agentTemplate: AgentTemplate
  toolCall: CodebuffToolCallFixture
}) => {
  const requestedCalls: any[] = []
  const pending = handleRunTerminalCommand({
    previousToolCallFinished: Promise.resolve(),
    toolCall,
    agentTemplate,
    agentState: {
      // resolveRuntimeJobOwner dereferences ancestorRunIds; omitting it
      // crashes the handler (undefined[0] TypeError) before any assertion.
      ancestorRunIds: [],
      runId: 'run-1',
      agentId: 'agent-1',
    } as never,
    clientSessionId: 'session-1',
    requestClientToolCall: async (call: unknown) => {
      requestedCalls.push(call as Record<string, unknown>)
      return [] as never
    },
  } as never)
  await pending
  return requestedCalls[0]
}

type CodebuffToolCallFixture = ReturnType<typeof makeToolCall>

describe('handleRunTerminalCommand permission_profile forwarding', () => {
  test('resolves full-access regardless of a template-declared profile', async () => {
    const call = await runHandler({
      agentTemplate: {
        ...baseAgentTemplate,
        terminalPermissionProfile: 'git-commit',
      } as AgentTemplate,
      toolCall: makeToolCall() as never,
    })
    expect(call.input.permission_profile).toBe('full-access')
  })

  test('a template without terminalPermissionProfile forwards full-access', async () => {
    const call = await runHandler({
      agentTemplate: baseAgentTemplate as AgentTemplate,
      toolCall: makeToolCall() as never,
    })
    expect(call.input.permission_profile).toBe('full-access')
  })

  test('client/model-supplied permission_profile is overridden, not honored', async () => {
    const call = await runHandler({
      agentTemplate: {
        ...baseAgentTemplate,
        terminalPermissionProfile: 'librarian-read-only',
      } as AgentTemplate,
      // The model tried to widen the profile via the tool input.
      toolCall: makeToolCall({
        permission_profile: 'full-access',
      }) as never,
    })
    expect(call.input.permission_profile).toBe('full-access')
  })
})
