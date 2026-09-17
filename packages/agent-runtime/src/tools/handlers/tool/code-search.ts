import {
  getVerifiedMemoryPaths,
  recordDiscoveryResult,
} from '../../../orchestration/discovery-coordinator'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type { AgentState } from '@codebuff/common/types/session-state'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

export const handleCodeSearch = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<'code_search'>
  requestClientToolCall: (
    toolCall: ClientToolCall<'code_search'>,
  ) => Promise<CodebuffToolOutput<'code_search'>>
  agentState?: AgentState
}): Promise<{
  output: CodebuffToolOutput<'code_search'>
}> => {
  const { previousToolCallFinished, toolCall, requestClientToolCall, agentState } =
    params

  await previousToolCallFinished
  const output = await requestClientToolCall(toolCall)
  try {
    if (!agentState || typeof agentState !== 'object') return { output }
    const input = toolCall.input as {
      pattern?: string
      cwd?: string
      paths?: string[]
      flags?: string | string[]
    }
    let question = `code_search:${input.pattern ?? ''}`
    if (input.cwd) question += ` cwd:${input.cwd}`
    if (input.paths && input.paths.length > 0) {
      question += ` scope:${input.paths.join(',')}`
    }
    question = question.slice(0, 4000)
    const verifiedPaths = getVerifiedMemoryPaths(agentState)
    agentState.discoveryCoverage = recordDiscoveryResult({
      existing: agentState.discoveryCoverage,
      agentType: 'code_search',
      question,
      result: output,
      workspaceRevision: agentState.workspaceState?.revision,
      workspaceSnapshotId: agentState.workspaceState?.snapshotId,
      verifiedPaths,
    })
  } catch {
    // Coverage recording must never break the tool call.
  }
  return { output }
}) satisfies CodebuffToolHandlerFunction<'code_search'>
