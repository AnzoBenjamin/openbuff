import {
  evaluateMemoryCover,
  getVerifiedMemoryExcerpts,
  getVerifiedMemoryPaths,
  recordDiscoveryResult,
  recordMemoryReuse,
} from '../../../orchestration/discovery-coordinator'

import type { VerifiedExcerpt } from '../../../orchestration/discovery-coordinator'
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

function buildSkipOutput(
  covering: VerifiedExcerpt[],
): CodebuffToolOutput<ToolName> {
  const bounded = covering.slice(0, 5)
  const files = bounded.map((entry) => entry.path).slice(0, 5)
  const message =
    `Served from verified memory; skipped glob (${files.length} paths fully covered).`.slice(
      0,
      2500,
    )
  return [
    {
      type: 'json',
      value: {
        files,
        count: files.length,
        message,
      },
    },
  ] as unknown as CodebuffToolOutput<ToolName>
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
  const { previousToolCallFinished, toolCall, requestClientToolCall, agentState } =
    params

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
  // Memory-first check (best-effort, never breaks the call).
  try {
    if (agentState && typeof agentState === 'object') {
      const excerpts = getVerifiedMemoryExcerpts(agentState, {
        limit: 5,
        maxCharsPerExcerpt: 500,
      })
      const pathPrefixes: string[] = []
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
      })
      recordMemoryReuse(agentState, {
        tool: 'glob',
        decision: cover.decision,
        served:
          cover.decision === 'skip' || cover.decision === 'narrow'
            ? cover.coveringExcerpts.length
            : 0,
        gaps: cover.remainingGaps.length,
      })
      if (cover.decision === 'skip' && cover.coveringExcerpts.length > 0) {
        const output = buildSkipOutput(cover.coveringExcerpts)
        recordCoverage(output)
        return { output }
      }
      // Narrow falls through to the full call: remainingGaps are file-like
      // paths, but glob's cwd must be a directory, so rooting glob at a gap
      // path would yield empty/incorrect results.
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
