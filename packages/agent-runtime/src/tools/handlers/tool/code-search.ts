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

function buildSkipOutput(
  covering: VerifiedExcerpt[],
): CodebuffToolOutput<ToolName> {
  const bounded = covering.slice(0, 5)
  const lines = bounded.map((entry) =>
    entry.excerpt
      ? `${entry.path}: ${entry.excerpt.slice(0, 500)}`
      : entry.path,
  )
  const stdout =
    lines.join('\n').slice(0, 2500) || bounded.map((entry) => entry.path).join('\n')
  return [
    {
      type: 'json',
      value: {
        stdout,
        message: `Served from verified memory; skipped code search (${bounded.length} paths fully covered).`,
      },
    },
  ] as unknown as CodebuffToolOutput<ToolName>
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
  const { previousToolCallFinished, toolCall, requestClientToolCall, agentState } =
    params

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
  // Memory-first check (best-effort, never breaks the call).
  try {
    if (agentState && typeof agentState === 'object') {
      const excerpts = getVerifiedMemoryExcerpts(agentState, {
        limit: 5,
        maxCharsPerExcerpt: 500,
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
      })
      if (cover.decision === 'skip' && cover.coveringExcerpts.length > 0) {
        const output = buildSkipOutput(cover.coveringExcerpts)
        recordCoverage(output)
        return { output }
      }
      if (cover.decision === 'narrow' && cover.remainingGaps.length > 0) {
        const narrowedPaths = cover.remainingGaps.slice(0, 20)
        const narrowedCall = {
          ...toolCall,
          input: { ...input, paths: narrowedPaths },
        } as unknown as ClientToolCall<ToolName>
        const output = await requestClientToolCall(narrowedCall)
        recordCoverage(output)
        return { output }
      }
    }
  } catch {
    // Fall through to the full call on any memory-check failure.
  }
  const output = await requestClientToolCall(
    toolCall as unknown as ClientToolCall<ToolName>,
  )
  recordCoverage(output)
  return { output }
}) satisfies CodebuffToolHandlerFunction<'code_search'>
