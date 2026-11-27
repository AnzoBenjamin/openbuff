import {
  evaluateMemoryCover,
  getVerifiedMemoryExcerpts,
  getVerifiedMemoryPaths,
  recordDiscoveryResult,
  recordMemoryReuse,
} from '../../../orchestration/discovery-coordinator'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type { AgentState } from '@codebuff/common/types/session-state'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

type ToolName = 'list_directory'

function buildDiscoveryQuestion(input: { path?: string }): string {
  const question = `list_directory:${input.path ?? ''}`
  return question.slice(0, 4000)
}

export const handleListDirectory = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  requestClientToolCall: (
    toolCall: ClientToolCall<ToolName>,
  ) => Promise<CodebuffToolOutput<ToolName>>
  agentState?: AgentState
}): Promise<{
  output: CodebuffToolOutput<ToolName>
}> => {
  const {
    previousToolCallFinished,
    toolCall,
    requestClientToolCall,
    agentState,
  } = params

  await previousToolCallFinished
  const input = toolCall.input as {
    path?: string
    offset?: number
    limit?: number
  }
  const question = buildDiscoveryQuestion(input)
  const recordCoverage = (result: unknown) => {
    try {
      if (!agentState || typeof agentState !== 'object') return
      const verifiedPaths = getVerifiedMemoryPaths(agentState)
      agentState.discoveryCoverage = recordDiscoveryResult({
        existing: agentState.discoveryCoverage,
        agentType: 'list_directory',
        question,
        result,
        workspaceRevision: agentState.workspaceState?.revision,
        workspaceSnapshotId: agentState.workspaceState?.snapshotId,
        verifiedPaths,
      })
    } catch {
      // Coverage recording must never break the tool call.
    }
  }
  // Memory is accounting-only here. A directory listing must come from the
  // filesystem: memory excerpts are nested file paths, not direct children,
  // and never prove the listing is complete (read-search-01).
  try {
    if (agentState && typeof agentState === 'object') {
      const excerpts = getVerifiedMemoryExcerpts(agentState, {
        limit: 5,
        maxCharsPerExcerpt: 2_000,
      })
      const cover = evaluateMemoryCover({
        excerpts,
        pathPrefixes:
          typeof input.path === 'string' && input.path.length > 0
            ? [input.path]
            : undefined,
        query: typeof input.path === 'string' ? input.path : '',
        unresolvedGaps: agentState.discoveryCoverage?.unresolvedGaps,
        workspaceRevision: agentState.workspaceState?.revision,
        workspaceSnapshotId: agentState.workspaceState?.snapshotId,
        existingIndexSnapshotId: agentState.discoveryCoverage?.indexSnapshotId,
        exhaustive: true,
      })
      recordMemoryReuse(agentState, {
        tool: 'list_directory',
        decision: 'full',
        reason: cover.reason,
        served: 0,
        gaps: cover.remainingGaps.length,
      })
    }
  } catch {
    // Accounting failure never affects the call.
  }
  const output = await requestClientToolCall(
    toolCall as unknown as ClientToolCall<ToolName>,
  )
  recordCoverage(output)
  return { output }
}) satisfies CodebuffToolHandlerFunction<ToolName>
