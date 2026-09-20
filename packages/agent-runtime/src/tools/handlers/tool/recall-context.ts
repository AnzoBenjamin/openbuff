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
  const { previousToolCallFinished, toolCall, agentState, logger } = params
  await previousToolCallFinished
  try {
    const query = toolCall.input.query
    const result = recallFromArchive(agentState.compactionArchive, query)
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
  } catch (error) {
    if (logger) {
      logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        'recall_context failed best-effort',
      )
    }
    return {
      output: jsonToolResult({ errorMessage: 'recall_context: failed to search the archive.' }),
    }
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
