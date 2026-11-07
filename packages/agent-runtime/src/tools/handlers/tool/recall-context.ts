import { jsonToolResult } from '@codebuff/common/util/messages'

import {
  recallEmptyResultMessage,
  recallFromArchiveIndexed,
  type ArchiveRecallIndexedResult,
} from '../../../util/archive-recall-index'
import { recallFromArchiveByToolCallId } from '../../../util/context-archive'
import {
  searchConsolidations,
  type ConsolidationHit,
} from '../../../util/context-consolidation'

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
  // EXACT-ID PATH (toolCallId present): the eviction tombstone names
  // `toolCallId=<id>` and that id usually appears in NO archived body, so a
  // text query for it can miss — the by-ID scanner matches the entry identity
  // instead and needs no FTS. When BOTH params are present the ID wins: the
  // caller asked for one exact archived call, not a text search.
  // TEXT PATH (query only): recallFromArchiveIndexed builds a per-call
  // in-memory FTS5 index over the bounded archive and fails open to the
  // substring scanner — no I/O beyond the in-memory db and no throwing call
  // surface — so the handler stays straight glue and needs no best-effort
  // error envelope.
  // The by-ID result is tagged indexState: 'indexed' (the D27 healthy-empty
  // state — no index was involved, so there is nothing to fall back from),
  // which keeps the empty-result guidance below identical across paths.
  const result: ArchiveRecallIndexedResult = toolCall.input.toolCallId
    ? {
        ...recallFromArchiveByToolCallId(
          agentState.compactionArchive,
          toolCall.input.toolCallId,
        ),
        indexState: 'indexed',
      }
    : await recallFromArchiveIndexed(
        agentState.compactionArchive,
        toolCall.input.query ?? '',
      )
  // Bounded summary hits from the canary-gated background consolidator
  // (OR-ranked). Omitted entirely when none exist, so the output contract is
  // additive: consumers that ignore the field keep verbatim-only behavior.
  // Best-effort: the handler's no-throw guarantee covers the whole recall
  // surface, so a consolidator-search failure degrades to an empty summary
  // list (verbatim archive results unaffected) and is logged, not thrown.
  let consolidations: ConsolidationHit[] = []
  try {
    // `query ?? ''` keeps this search structurally identical on the by-ID
    // path: a toolCallId-only call has no terms, and an empty term list is
    // the search's own no-op (never a throw).
    consolidations = searchConsolidations(
      agentState.contextConsolidations,
      toolCall.input.query ?? '',
    )
  } catch (error) {
    params.logger?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'recall_context: consolidation search failed; degrading to verbatim-only results.',
    )
  }
  return {
    output: jsonToolResult({
      ...result,
      ...(consolidations.length > 0 ? { consolidations } : {}),
      ...(result.matches.length === 0 && consolidations.length === 0
        ? {
            // D27: when the FTS5 index failed open, note it so the caller can
            // tell a failed index apart from a healthy empty one.
            message: recallEmptyResultMessage(result),
          }
        : {}),
    }),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
