import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'

type ToolName = 'list_jobs'
export const handleListJobs = (async ({
  previousToolCallFinished,
  toolCall,
  requestClientToolCall,
  agentState,
  clientSessionId,
}: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  requestClientToolCall: (
    toolCall: ClientToolCall<ToolName>,
  ) => Promise<CodebuffToolOutput<ToolName>>
  agentState: AgentState
  clientSessionId: string
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const rootRunId =
    agentState.ancestorRunIds[0] ?? agentState.runId ?? agentState.agentId
  const clientToolCall: ClientToolCall<ToolName> = {
    toolName: 'list_jobs',
    toolCallId: toolCall.toolCallId,
    input: {
      owner: {
        clientSessionId,
        rootRunId,
        parentRunId: agentState.runId ?? agentState.agentId,
        parentAgentId: agentState.agentId,
      },
    },
  }
  await previousToolCallFinished
  return { output: await requestClientToolCall(clientToolCall) }
}) satisfies CodebuffToolHandlerFunction<ToolName>
