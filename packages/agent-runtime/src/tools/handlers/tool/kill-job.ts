import { resolveRuntimeJobOwner } from '../../../util/runtime-job-owner'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
  ProcessJobClientToolCall,
} from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'

type ToolName = 'kill_job'

/**
 * Shell kill_job stays a client tool: the SDK adapter owns the real kill
 * (process-group SIGTERM with SIGKILL escalation). The handler stamps a
 * TRUSTED owner (derived from agentState — never from model input) onto the
 * forwarded call so the SDK can gate the mutating kill on registry ownership.
 */
export const handleKillJob = (async ({
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
    toolName: 'kill_job',
    toolCallId: toolCall.toolCallId,
    input: {
      jobId: toolCall.input.jobId,
      signal: toolCall.input.signal,
      // Trusted owner injected from agent/session state (never model input).
      owner: resolveRuntimeJobOwner({ clientSessionId, agentState }),
    },
  }
  await previousToolCallFinished
  return {
    output: await requestClientToolCall(
      clientToolCall as unknown as ClientToolCall<ToolName>,
    ),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
