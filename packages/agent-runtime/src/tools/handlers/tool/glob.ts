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

type ToolName = 'glob'

function buildDiscoveryQuestion(input: {
  pattern?: string
  cwd?: string
}): string {
  let question = `glob:${input.pattern ?? ''}`
  if (input.cwd) question += ` cwd:${input.cwd}`
  return question.slice(0, 4000)
}

export const handleGlob = (async (params: {
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
    pattern?: string
    cwd?: string
  }
  const question = buildDiscoveryQuestion(input)
  const recordCoverage = (result: unknown) => {
    try {
      if (!agentState || typeof agentState !== 'object') return
      const verifiedPaths = getVerifiedMemoryPaths(agentState)
      agentState.discoveryCoverage = recordDiscoveryResult({
        existing: agentState.discoveryCoverage,
        agentType: 'glob',
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
  // Memory is accounting-only here. glob answers "every file matching X",
  // which a few memory excerpts can never prove, so memory never replaces the
  // real call (read-search-01). Best-effort, never breaks the call.
  try {
    if (agentState && typeof agentState === 'object') {
      const excerpts = getVerifiedMemoryExcerpts(agentState, {
        limit: 5,
        maxCharsPerExcerpt: 2_000,
      })
      const cover = evaluateMemoryCover({
        excerpts,
        pathPrefixes:
          typeof input.cwd === 'string' && input.cwd.length > 0
            ? [input.cwd]
            : undefined,
        query: typeof input.pattern === 'string' ? input.pattern : '',
        unresolvedGaps: agentState.discoveryCoverage?.unresolvedGaps,
        workspaceRevision: agentState.workspaceState?.revision,
        workspaceSnapshotId: agentState.workspaceState?.snapshotId,
        existingIndexSnapshotId: agentState.discoveryCoverage?.indexSnapshotId,
        exhaustive: true,
      })
      recordMemoryReuse(agentState, {
        tool: 'glob',
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
