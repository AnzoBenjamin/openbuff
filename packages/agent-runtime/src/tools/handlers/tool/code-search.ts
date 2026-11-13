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

type ToolName = 'code_search'

function buildDiscoveryQuestion(input: {
  pattern?: string
  cwd?: string
  paths?: string[]
}): string {
  let question = `code_search:${input.pattern ?? ''}`
  if (input.cwd) question += ` cwd:${input.cwd}`
  if (input.paths && input.paths.length > 0) {
    question += ` scope:${input.paths.join(',')}`
  }
  return question.slice(0, 4000)
}

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
    paths?: string[]
    flags?: string | string[]
  }
  const question = buildDiscoveryQuestion(input)
  const recordCoverage = (result: unknown) => {
    try {
      if (!agentState || typeof agentState !== 'object') return
      const verifiedPaths = getVerifiedMemoryPaths(agentState)
      agentState.discoveryCoverage = recordDiscoveryResult({
        existing: agentState.discoveryCoverage,
        agentType: 'code_search',
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
  // Memory is accounting-only here. code_search answers "every line matching
  // X"; memory excerpts are not matches, and narrowing the scope to the
  // uncovered paths would hide matches in the covered ones (read-search-01).
  try {
    if (agentState && typeof agentState === 'object') {
      const excerpts = getVerifiedMemoryExcerpts(agentState, {
        limit: 5,
        maxCharsPerExcerpt: 2_000,
      })
      const pathPrefixes: string[] = []
      if (Array.isArray(input.paths)) {
        for (const candidate of input.paths) {
          if (typeof candidate === 'string' && candidate.length > 0) {
            pathPrefixes.push(candidate)
          }
        }
      }
      if (typeof input.cwd === 'string' && input.cwd.length > 0) {
        pathPrefixes.push(input.cwd)
      }
      const cover = evaluateMemoryCover({
        excerpts,
        pathPrefixes: pathPrefixes.length > 0 ? pathPrefixes : undefined,
        query: typeof input.pattern === 'string' ? input.pattern : '',
        unresolvedGaps: agentState.discoveryCoverage?.unresolvedGaps,
        workspaceRevision: agentState.workspaceState?.revision,
        workspaceSnapshotId: agentState.workspaceState?.snapshotId,
        existingIndexSnapshotId: agentState.discoveryCoverage?.indexSnapshotId,
        exhaustive: true,
      })
      recordMemoryReuse(agentState, {
        tool: 'code_search',
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
}) satisfies CodebuffToolHandlerFunction<'code_search'>
