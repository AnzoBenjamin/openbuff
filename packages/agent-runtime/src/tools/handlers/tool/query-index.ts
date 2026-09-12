import { recordDiscoveryResult } from '../../../orchestration/discovery-coordinator'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type { AgentState } from '@codebuff/common/types/session-state'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

type ToolName = 'query_index'

export const handleQueryIndex = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  requestClientToolCall: (
    toolCall: ClientToolCall<ToolName>,
  ) => Promise<CodebuffToolOutput<ToolName>>
  agentState: AgentState
}): Promise<{
  output: CodebuffToolOutput<ToolName>
}> => {
  const { previousToolCallFinished, toolCall, requestClientToolCall, agentState } =
    params
  await previousToolCallFinished
  const output = await requestClientToolCall(toolCall)
  try {
    const input = toolCall.input
    const mode = input.mode ?? 'search'
    const query = input.query ?? ''
    let question = `query_index:${mode}:${query}`
    if (input.from) question += ` from:${input.from}`
    if (input.to) question += ` to:${input.to}`
    if (input.pathPrefixes && input.pathPrefixes.length > 0) {
      question += ` scope:${input.pathPrefixes.join(',')}`
    }
    question = question.slice(0, 4000)
    agentState.discoveryCoverage = recordDiscoveryResult({
      existing: agentState.discoveryCoverage,
      agentType: 'query_index',
      question,
      result: output,
      workspaceRevision: agentState.workspaceState?.revision,
      workspaceSnapshotId: agentState.workspaceState?.snapshotId,
    })
  } catch {
    // Coverage recording must never break the tool call.
  }
  return { output }
}) satisfies CodebuffToolHandlerFunction<ToolName>
