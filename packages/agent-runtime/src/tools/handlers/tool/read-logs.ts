import { authorizeBackgroundJob } from './authorize-background-job'

import type { BackgroundJobOwnerTuple } from './authorize-background-job'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'

type ToolName = 'read_logs'
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
  let owner: BackgroundJobOwnerTuple | undefined
  // Only gate/recover when a jobId is present. Path-only reads keep current
  // behavior.
  if (toolCall.input.jobId) {
    const authorization = authorizeBackgroundJob({
      jobId: toolCall.input.jobId,
      agentState,
      clientSessionId,
    })
    if (authorization.status === 'foreign') {
      return {
        output: [
          {
            type: 'json',
            value: {
              path: toolCall.input.path ?? '',
              jobId: toolCall.input.jobId,
              errorMessage: `Background shell job "${toolCall.input.jobId}" is unavailable to this run.`,
            },
          },
        ],
      }
    }
    owner = authorization.owner
  }
  const clientToolCall: ClientToolCall<ToolName> = {
    toolName: 'read_logs',
    toolCallId: toolCall.toolCallId,
    input: {
      path: toolCall.input.path,
      jobId: toolCall.input.jobId,
      owner,
      lines: toolCall.input.lines,
      max_chars: toolCall.input.max_chars,
    },
  }
  await previousToolCallFinished
  return { output: await requestClientToolCall(clientToolCall) }
}) satisfies CodebuffToolHandlerFunction<ToolName>
