import { resolveRuntimeJobOwner } from '../../../util/runtime-job-owner'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
  ProcessJobClientToolCall,
} from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'

type ToolName = 'list_jobs'

/**
 * list_jobs is a client tool so the SDK run loop can inject the same trusted
 * root owner used for BACKGROUND spawn / check_job / kill_job. The handler
 * stamps owner from agent/session state (never model input); the SDK ignores
 * any model-supplied owner and lists process + agent jobs for that owner.
 */
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
  const clientToolCall: ProcessJobClientToolCall<ToolName> = {
    toolName: 'list_jobs',
    toolCallId: toolCall.toolCallId,
    input: {
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
