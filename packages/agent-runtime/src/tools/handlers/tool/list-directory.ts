import {
  evaluateMemoryCover,
  getVerifiedMemoryExcerpts,
  getVerifiedMemoryPaths,
  recordDiscoveryResult,
} from '../../../orchestration/discovery-coordinator'

import type { VerifiedExcerpt } from '../../../orchestration/discovery-coordinator'
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

function buildSkipOutput(
  covering: VerifiedExcerpt[],
  requestedPath: string,
): CodebuffToolOutput<ToolName> {
  const bounded = covering.slice(0, 5)
  const files = bounded.map((entry) => entry.path).slice(0, 5)
  return [
    {
      type: 'json',
      value: {
        files,
        directories: [],
        path: requestedPath,
      },
    },
  ] as unknown as CodebuffToolOutput<ToolName>
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
  const { previousToolCallFinished, toolCall, requestClientToolCall, agentState } =
    params

  await previousToolCallFinished
  const input = toolCall.input as {
    path?: string
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
  // Memory-first check (best-effort, never breaks the call).
  try {
    if (agentState && typeof agentState === 'object') {
      const excerpts = getVerifiedMemoryExcerpts(agentState, {
        limit: 5,
        maxCharsPerExcerpt: 500,
      })
      const pathPrefixes: string[] = []
      if (typeof input.path === 'string' && input.path.length > 0) {
        pathPrefixes.push(input.path)
      }
      const cover = evaluateMemoryCover({
        excerpts,
        pathPrefixes: pathPrefixes.length > 0 ? pathPrefixes : undefined,
        query: typeof input.path === 'string' ? input.path : '',
        unresolvedGaps: agentState.discoveryCoverage?.unresolvedGaps,
        workspaceRevision: agentState.workspaceState?.revision,
        workspaceSnapshotId: agentState.workspaceState?.snapshotId,
        existingIndexSnapshotId: agentState.discoveryCoverage?.indexSnapshotId,
      })
      if (cover.decision === 'skip' && cover.coveringExcerpts.length > 0) {
        const requestedPath =
          typeof input.path === 'string' && input.path.length > 0
            ? input.path
            : '.'
        const output = buildSkipOutput(cover.coveringExcerpts, requestedPath)
        recordCoverage(output)
        return { output }
      }
      // Narrow falls through to the full call: listing cannot be narrowed safely.
    }
  } catch {
    // Fall through to the full call on any memory-check failure.
  }
  const output = await requestClientToolCall(
    toolCall as unknown as ClientToolCall<ToolName>,
  )
  recordCoverage(output)
  return { output }
}) satisfies CodebuffToolHandlerFunction<ToolName>
