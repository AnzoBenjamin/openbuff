import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
  ProcessJobClientToolCall,
} from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'

type ToolName = 'check_job'

/**
 * Shell check_job stays a client tool (it runs in the SDK process, which owns
 * the OS child + log file). The handler stamps a TRUSTED owner (derived from
 * agentState — never from model input) onto the forwarded call so the SDK can
 * assert registry ownership. The result is the unified event-slice shape
 * ({ events, nextCursor, state, truncated, dropped, exitCode?, matched?,
 * timedOut? }); wait_for remains a predicate over the output event stream.
 */
export const handleCheckJob = (async ({
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
    toolName: 'check_job',
    toolCallId: toolCall.toolCallId,
    input: {
      jobId: toolCall.input.jobId,
      wait_for: toolCall.input.wait_for,
      timeout_seconds: toolCall.input.timeout_seconds,
      kill_on_timeout: toolCall.input.kill_on_timeout,
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
