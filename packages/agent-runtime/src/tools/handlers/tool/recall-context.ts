import { jsonToolResult } from '@codebuff/common/util/messages'

import { recallFromArchive } from '../../../util/context-archive'
import { searchConsolidations } from '../../../util/context-consolidation'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { Logger } from '@codebuff/common/types/contracts/logger'

type ToolName = 'recall_context'

export const handleRecallContext = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  agentState: AgentState
  logger?: Logger
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const { previousToolCallFinished, toolCall, agentState } = params
  await previousToolCallFinished
  // recallFromArchive and searchConsolidations are pure, bounded scans over
  // in-memory arrays — no I/O, no throwing call surface — so the handler is
  // straight glue and needs no best-effort error envelope.
  const result = recallFromArchive(agentState.compactionArchive, toolCall.input.query)
  // Bounded summary hits from the canary-gated background consolidator
  // (OR-ranked). Omitted entirely when none exist, so the output contract is
  // additive: consumers that ignore the field keep verbatim-only behavior.
  const consolidations = searchConsolidations(
    agentState.contextConsolidations,
    toolCall.input.query,
  )
  return {
    output: jsonToolResult({
      ...result,
      ...(consolidations.length > 0 ? { consolidations } : {}),
      ...(result.matches.length === 0 && consolidations.length === 0
        ? {
            message:
              'No archived pre-compaction content matched. Archived transcripts exist only after a compaction pass rewrote history; verify facts against live files with read_files instead.',
          }
        : {}),
    }),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
