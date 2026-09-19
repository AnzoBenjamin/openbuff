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

type ToolName = 'query_index'

function buildDiscoveryQuestion(input: CodebuffToolCall<ToolName>['input']): string {
  const mode = input.mode ?? 'search'
  const query = input.query ?? ''
  let question = `query_index:${mode}:${query}`
  if (input.from) question += ` from:${input.from}`
  if (input.to) question += ` to:${input.to}`
  if (input.pathPrefixes && input.pathPrefixes.length > 0) {
    question += ` scope:${input.pathPrefixes.join(',')}`
  }
  return question.slice(0, 4000)
}

function buildSkipOutput(covering: VerifiedExcerpt[]): CodebuffToolOutput<ToolName> {
  const bounded = covering.slice(0, 5)
  const results = bounded.map((entry) => ({
    path: entry.path,
    score: 1,
    matchedOn: ['verified-memory'],
    ...(entry.excerpt ? { matchedSnippets: [entry.excerpt.slice(0, 500)] } : {}),
  }))
  return [
    {
      type: 'json',
      value: {
        results,
        kind: 'query_index_result',
        schemaVersion: 1,
        totalIndexed: results.length,
        indexAge: 0,
        message: `Served from verified memory; skipped index read (${results.length} paths fully covered).`,
      },
    },
  ] as unknown as CodebuffToolOutput<ToolName>
}

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
  const input = toolCall.input
  const question = buildDiscoveryQuestion(input)
  const recordCoverage = (result: unknown) => {
    try {
      const verifiedPaths = getVerifiedMemoryPaths(agentState)
      agentState.discoveryCoverage = recordDiscoveryResult({
        existing: agentState.discoveryCoverage,
        agentType: 'query_index',
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
    const excerpts = getVerifiedMemoryExcerpts(agentState, {
      limit: 5,
      maxCharsPerExcerpt: 500,
    })
    const queryText = [input.query ?? '', input.from ?? '', input.to ?? '']
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join(' ')
    const cover = evaluateMemoryCover({
      excerpts,
      pathPrefixes: Array.isArray(input.pathPrefixes)
        ? input.pathPrefixes
        : undefined,
      query: queryText,
      unresolvedGaps: agentState.discoveryCoverage?.unresolvedGaps,
      workspaceRevision: agentState.workspaceState?.revision,
      workspaceSnapshotId: agentState.workspaceState?.snapshotId,
      existingIndexSnapshotId: agentState.discoveryCoverage?.indexSnapshotId,
    })
    recordMemoryReuse(agentState, {
      tool: 'query_index',
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
    if (cover.decision === 'narrow' && cover.remainingGaps.length > 0) {
      const narrowedPrefixes = cover.remainingGaps.slice(0, 20)
      const narrowedCall = {
        ...toolCall,
        input: { ...input, pathPrefixes: narrowedPrefixes },
      } as unknown as ClientToolCall<ToolName>
      const output = await requestClientToolCall(narrowedCall)
      recordCoverage(output)
      return { output }
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
