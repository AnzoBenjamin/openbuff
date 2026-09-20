import { jsonToolResult } from '@codebuff/common/util/messages'

import { recallFromArchive } from '../../../util/context-archive'

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
  // recallFromArchive is a pure, bounded scan over an in-memory array — no
  // I/O, no throwing call surface — so the handler is straight glue and
  // needs no best-effort error envelope.
  const result = recallFromArchive(agentState.compactionArchive, toolCall.input.query)
  return {
    output: jsonToolResult({
      ...result,
      ...(result.matches.length === 0
        ? {
            message:
              'No archived pre-compaction content matched. Archived transcripts exist only after a compaction pass rewrote history; verify facts against live files with read_files instead.',
          }
        : {}),
    }),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
