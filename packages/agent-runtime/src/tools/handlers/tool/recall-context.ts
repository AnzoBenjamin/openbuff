import { DEFAULT_CONTEXT_ARCHIVE_TTL_MS } from '@codebuff/common/util/context-archive-body'
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
import type { AgentRuntimeDeps } from '@codebuff/common/types/contracts/agent-runtime'
import type { ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'

type ToolName = 'recall_context'

export const handleRecallContext = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  agentState: AgentState
  logger?: Logger
  readContextArchiveBodyPage?: AgentRuntimeDeps['readContextArchiveBodyPage']
  searchContextArchive?: AgentRuntimeDeps['searchContextArchive']
  executionIdentity?: ToolExecutionIdentity
  userInputId?: string
  clock?: AgentRuntimeDeps['clock']
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const { previousToolCallFinished, toolCall, agentState } = params
  await previousToolCallFinished
  const input = toolCall.input
  const now = params.clock?.now() ?? Date.now()
  const retainedArchive = agentState.compactionArchive?.filter(
    (snapshot) =>
      (snapshot.expiresAt === undefined || snapshot.expiresAt > now) &&
      (snapshot.pinned ||
        Math.min(
          snapshot.archivedAt,
          ...(snapshot.provenance?.map(
            (entry) => entry.capturedAt ?? snapshot.archivedAt,
          ) ?? []),
        ) +
          DEFAULT_CONTEXT_ARCHIVE_TTL_MS >
          now),
  )
  let result: ArchiveRecallIndexedResult = input.toolCallId
    ? {
        ...recallFromArchiveByToolCallId(retainedArchive, input.toolCallId, {
          bodies: agentState.contextArchiveBodies,
          sourceRunId: input.sourceRunId,
          expectedSha256: input.expectedSha256,
          offsetBytes: input.offsetBytes,
          maxBytes: input.maxBytes,
          now,
        }),
        indexState: 'indexed',
      }
    : await recallFromArchiveIndexed(retainedArchive, input.query ?? '')
  if (
    input.toolCallId &&
    params.readContextArchiveBodyPage &&
    agentState.contextArchiveHydration !== 'in-memory-only'
  ) {
    const identity = params.executionIdentity
    if (identity && params.userInputId) {
      try {
        const page = await params.readContextArchiveBodyPage({
          toolCallId: input.toolCallId,
          sourceRunId: input.sourceRunId,
          expectedSha256: input.expectedSha256,
          offsetBytes: input.offsetBytes,
          maxBytes: input.maxBytes,
          actor: {
            runId: identity.runId,
            rootRunId: identity.rootRunId,
            agentId: identity.agentId,
          },
          userInputId: params.userInputId,
        })
        if (page.status === 'ok') {
          const body = {
            bodyId: page.bodyId,
            sha256: page.sha256,
            utf8Bytes: page.utf8Bytes,
          }
          result = {
            status: 'ok',
            indexState: 'indexed',
            archivedAt: result.archivedAt,
            snapshotsSearched: result.snapshotsSearched,
            matches: [
              {
                step: page.step,
                toolName: page.toolName,
                toolCallId: page.toolCallId,
                runId: page.runId,
                snippet: page.text,
                body,
                page: {
                  startByte: page.startByte,
                  endByte: page.endByte,
                  nextOffset: page.nextOffset,
                },
                provenance: {
                  kind:
                    page.startByte === 0 && page.endByte === page.utf8Bytes
                      ? 'original'
                      : 'excerpt',
                  sourceRunId: page.runId,
                  toolCallId: page.toolCallId,
                  step: page.step,
                  body,
                  retainedRange: {
                    startByte: page.startByte,
                    endByte: page.endByte,
                  },
                },
              },
            ],
          }
        } else if (
          !['missing', 'unavailable'].includes(page.status) ||
          !result.matches.some(
            (match) => match.provenance?.sourceRunId === identity.runId,
          )
        ) {
          result = {
            ...result,
            matches: [],
            status: page.status,
            reason: page.reason,
          }
        } else if (page.status === 'unavailable') {
          // A newly captured same-run original remains local evidence; it is not durable-storage success.
          result = { ...result, status: 'degraded', reason: page.reason }
        }
      } catch {
        result = {
          ...result,
          matches: [],
          status: 'unavailable',
          reason:
            'Host archive lookup failed; no original was inferred from a pointer.',
        }
      }
    } else
      result = {
        ...result,
        matches: [],
        status: 'unavailable',
        reason:
          'Archive lookup lacks registered runtime actor/task attribution.',
      }
  }
  if (
    !input.toolCallId &&
    input.query &&
    params.searchContextArchive &&
    agentState.contextArchiveHydration !== 'in-memory-only'
  ) {
    const identity = params.executionIdentity
    if (identity && params.userInputId) {
      try {
        const durable = await params.searchContextArchive({
          query: input.query,
          limit: 6,
          actor: {
            runId: identity.runId,
            rootRunId: identity.rootRunId,
            agentId: identity.agentId,
          },
          userInputId: params.userInputId,
        })
        const merged = [
          ...durable.matches.map((match) => ({
            step: match.step,
            toolName: match.toolName,
            toolCallId: match.toolCallId,
            snippet: match.snippet,
            runId: match.runId,
            body: match.body,
            provenance: {
              kind: 'excerpt' as const,
              sourceRunId: match.runId,
              toolCallId: match.toolCallId,
              step: match.step,
              body: match.body,
            },
          })),
          ...result.matches,
        ]
        const seen = new Set<string>()
        result = {
          ...result,
          matches: merged
            .filter((match) => {
              const key = JSON.stringify([
                match.runId ?? '',
                match.toolCallId,
                match.step,
              ])
              if (seen.has(key)) return false
              seen.add(key)
              return true
            })
            .slice(0, 6),
          snapshotsSearched:
            result.snapshotsSearched + durable.snapshotsSearched,
          archivedAt: [
            ...new Set([
              ...result.archivedAt,
              ...durable.matches.map((match) => match.archivedAt),
            ]),
          ].sort((a, b) => b - a),
          ...(durable.status === 'unavailable' || durable.status === 'degraded'
            ? {
                status: 'degraded' as const,
                reason:
                  durable.reasons?.join('; ') ??
                  'Durable archive search is degraded.',
              }
            : {}),
        }
      } catch {
        result = {
          ...result,
          status: 'degraded',
          reason:
            'Durable archive search failed; only local excerpts were searched.',
        }
      }
    }
  }
  let consolidations: ConsolidationHit[] = []
  try {
    consolidations = searchConsolidations(
      agentState.contextConsolidations,
      input.query ?? '',
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
      ...(consolidations.length ? { consolidations } : {}),
      ...(result.matches.length === 0 && consolidations.length === 0
        ? {
            message: result.reason ?? recallEmptyResultMessage(result),
          }
        : {}),
    }),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
