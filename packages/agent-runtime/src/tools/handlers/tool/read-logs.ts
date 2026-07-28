import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
  ProcessJobClientToolCall,
} from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'

type ToolName = 'read_logs'

/**
 * read_logs keeps both path-based and jobId-based log reads as a client tool
 * (the SDK process owns the log file). The handler stamps a TRUSTED owner
 * (derived from agentState — never from model input) onto the forwarded call
 * so the SDK can gate the jobId log read on registry ownership.
 */
export const handleReadLogs = (async ({
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
  const clientToolCall: ProcessJobClientToolCall<ToolName> = {
    toolName: 'read_logs',
    toolCallId: toolCall.toolCallId,
    input: {
      path: toolCall.input.path,
      jobId: toolCall.input.jobId,
      lines: toolCall.input.lines,
      max_chars: toolCall.input.max_chars,
      // Trusted owner injected from agent/session state (never model input).
      owner: {
        clientSessionId,
        rootRunId:
          agentState.ancestorRunIds[0] ?? agentState.runId ?? agentState.agentId,
        parentRunId: agentState.runId ?? agentState.agentId,
        parentAgentId: agentState.agentId,
      },
    },
  }
  await previousToolCallFinished
  return {
    output: await requestClientToolCall(
      clientToolCall as unknown as ClientToolCall<ToolName>,
    ),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
