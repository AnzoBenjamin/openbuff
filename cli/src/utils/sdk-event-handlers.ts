import { match } from 'ts-pattern'

import {
  appendTextToRootStream,
  appendToolToAgentBlock,
  closeNativeReasoningBlock,
  closeNativeReasoningInAgent,
  markAgentComplete,
  markAgentFailed,
} from './block-operations'
import {
  getCanonicalMutationResult,
  hasMultipartError,
  isTerminalToolBlock,
} from './tool-result-normalizer'
import { shouldHideAgent } from './constants'
import {
  createAgentBlock,
  extractPlanFromBuffer,
  extractSpawnAgentResultContent,
  findAgentTypeById,
  getBackgroundShellJobIdFromToolOutput,
  insertPlanBlock,
  markPendingCompactionInterrupted,
  nestBlockUnderParent,
  transformAskUserBlocks,
  updateBlocksRecursively,
  updateToolBlockWithOutput,
} from './message-block-helpers'
import {
  extractDiff,
  extractFilePath,
  getImplementorDisplayName,
  isEditToolBlock,
  isImplementorAgent,
} from './implementor-helpers'
import {
  findMatchingSpawnAgent,
  resolveSpawnAgentToReal,
} from './spawn-agent-matcher'
import {
  destinationFromChunkEvent,
  processTextChunk,
} from './stream-chunk-processor'
import { computeCompletionSummary } from './completion-summary'
import { CLI_LIVE_SESSION_ID } from '../types/chat'

import type { AgentMode } from './constants'
import type { MessageUpdater } from './message-updater'
import type { StatusBarContextUsage } from './status-bar-chips'
import type { StreamController } from '../hooks/stream-state'
import type { StreamStatus } from '../hooks/use-message-queue'
import type {
  AgentContentBlock,
  CompactionCategoryDelta,
  CompactionContentBlock,
  CompactionNotice,
  ContentBlock,
  TextContentBlock,
  ToolContentBlock,
} from '../types/chat'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  PrintModeContextWindow,
  PrintModeContextCompaction,
  PrintModeContextCompactionStatus,
  PrintModeContextRequestTrim,
  PrintModeEvent as SDKEvent,
  PrintModeJobUpdate,
  PrintModeFinish,
  PrintModePhase,
  PrintModeSubagentFinish,
  PrintModeSubagentStart,
  PrintModeToolCall,
  PrintModeToolResult,
  PrintModeToolStart,
} from '@codebuff/common/types/print-mode'
import type { ToolName } from '@openbuff/sdk'
import type { MutableRefObject } from 'react'

export type SetStreamingAgentsFn = (
  updater: (prev: Set<string>) => Set<string>,
) => void

export type SetStreamStatusFn = (status: StreamStatus) => void

/**
 * Forwards the `context_window` event's usage to the status bar. The payload is
 * the canonical {@link StatusBarContextUsage} the chip selector consumes, so a
 * later additive field cannot go silently missing from one hop.
 *
 * `compactionTriggerTokens` — the runtime's model-aware semantic-compaction
 * trigger budget — is forwarded only when the event supplies it: persisted or
 * replayed events emitted before the field existed omit it, and the chip then
 * renders exactly as it did before. It is forwarded verbatim and therefore NOT
 * bounded by `max` — see `printModeContextWindowSchema`; the status-bar chip
 * suppresses a trigger that reaches `max`.
 */
export type SetContextWindowUsageFn = (
  usage: StatusBarContextUsage | null,
) => void

// Re-exported from its canonical declaration in ../types/chat so existing
// importers of this module keep working while there is only one shape.
export type { CompactionNotice }

// Same reason, for the canonical context-usage shape declared in
// ./status-bar-chips: consumers of this module's setter get the shape from the
// same place rather than restating it.
export type { StatusBarContextUsage }

/**
 * Accumulating setter for the status-bar compaction chip: receives an updater so
 * repeated compactions within one turn can keep counting from the previous
 * notice, and null to clear it when a new turn starts.
 */
export type SetCompactionNoticeFn = (
  update: (previous: CompactionNotice | null) => CompactionNotice | null,
) => void

export type StreamChunkEvent =
  | string
  | {
      type: 'subagent_chunk'
      agentId: string
      agentType: string
      chunk: string
    }
  | {
      type: 'reasoning_chunk'
      agentId: string
      ancestorRunIds: string[]
      chunk: string
    }

export type StreamingState = {
  streamRefs: StreamController
  setStreamingAgents: SetStreamingAgentsFn
  setStreamStatus: SetStreamStatusFn
  setContextWindowUsage: SetContextWindowUsageFn
  setCompactionNotice: SetCompactionNoticeFn
}

export type MessageState = {
  aiMessageId: string
  updater: MessageUpdater
  hasReceivedContentRef: MutableRefObject<boolean>
}

export type SubagentState = {
  addActiveSubagent: (id: string, agentType?: string) => void
  removeActiveSubagent: (id: string) => void
}

export type ModeState = {
  agentMode: AgentMode
  setHasReceivedPlanResponse: (value: boolean) => void
}

export type EventHandlerState = {
  streaming: StreamingState
  message: MessageState
  subagents: SubagentState
  mode: ModeState
  logger: Logger
  setIsRetrying: (retrying: boolean) => void
  onTotalCost?: (cost: number) => void
}

type TextDelta = { type: 'text' | 'reasoning'; text: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const hiddenToolNames = new Set<ToolName | 'spawn_agent_inline'>([
  'spawn_agent_inline',
  'end_turn',
  'spawn_agents',
])

const isHiddenToolName = (
  toolName: string,
): toolName is ToolName | 'spawn_agent_inline' =>
  hiddenToolNames.has(toolName as ToolName | 'spawn_agent_inline')

const ensureStreaming = (state: EventHandlerState) => {
  if (!state.message.hasReceivedContentRef.current) {
    state.message.hasReceivedContentRef.current = true
    state.streaming.setStreamStatus('streaming')
    state.setIsRetrying(false)
  }
}

const appendRootChunk = (state: EventHandlerState, delta: TextDelta) => {
  if (!delta.text) {
    return
  }

  state.message.updater.updateAiMessageBlocks((blocks) =>
    appendTextToRootStream(blocks, delta),
  )

  if (
    state.mode.agentMode === 'PLAN' &&
    delta.type === 'text' &&
    !state.streaming.streamRefs.state.planExtracted
  ) {
    const currentBuffer = `${state.streaming.streamRefs.state.rootStreamBuffer}${delta.text}`
    const rawPlan = extractPlanFromBuffer(currentBuffer)
    if (rawPlan !== null) {
      state.streaming.streamRefs.setters.setPlanExtracted(true)
      state.mode.setHasReceivedPlanResponse(true)
      state.message.updater.updateAiMessageBlocks((blocks) =>
        insertPlanBlock(blocks, rawPlan),
      )
    }
  }
}

const updateStreamingAgents = (
  state: EventHandlerState,
  op: { add?: string; remove?: string },
) => {
  state.streaming.setStreamingAgents((prev) => {
    const next = new Set(prev)
    if (op.remove) {
      next.delete(op.remove)
    }
    if (op.add) {
      next.add(op.add)
    }
    return next
  })
}

const handleSubagentStart = (
  state: EventHandlerState,
  event: PrintModeSubagentStart,
) => {
  if (shouldHideAgent(event.agentType)) {
    return
  }

  state.subagents.addActiveSubagent(event.agentId, event.agentType)

  const spawnAgentMatch = findMatchingSpawnAgent(
    state.streaming.streamRefs.state.spawnAgentsMap,
    event.agentType || '',
    event.spawnToolCallId,
    event.spawnIndex,
  )

  if (spawnAgentMatch) {
    state.message.updater.updateAiMessageBlocks((blocks) =>
      resolveSpawnAgentToReal({
        blocks,
        match: spawnAgentMatch,
        realAgentId: event.agentId,
        realAgentType: event.agentType,
        parentAgentId: event.parentAgentId,
        params: event.params,
        prompt: event.prompt,
      }),
    )

    updateStreamingAgents(state, {
      remove: spawnAgentMatch.tempId,
      add: event.agentId,
    })
    state.streaming.streamRefs.setters.removeSpawnAgentInfo(
      spawnAgentMatch.tempId,
    )
    return
  }

  state.logger.info(
    {
      agentId: event.agentId,
      agentType: event.agentType,
      parentAgentId: event.parentAgentId || 'ROOT',
    },
    'Creating new agent block (no spawn_agents match)',
  )

  state.message.updater.updateAiMessageBlocks((blocks) => {
    // Look up the parent agent's type if there's a parent agent ID
    const parentAgentType = event.parentAgentId
      ? findAgentTypeById(blocks, event.parentAgentId)
      : undefined

    const newAgentBlock = createAgentBlock({
      agentId: event.agentId,
      agentType: event.agentType || '',
      prompt: event.prompt,
      params: event.params,
      parentAgentType,
    })

    if (event.parentAgentId) {
      const { blocks: nestedBlocks, parentFound } = nestBlockUnderParent(
        blocks,
        event.parentAgentId,
        newAgentBlock,
      )
      if (parentFound) {
        return nestedBlocks
      }
    }
    return [...blocks, newAgentBlock]
  })

  updateStreamingAgents(state, { add: event.agentId })
}

const handleSubagentFinish = (
  state: EventHandlerState,
  event: PrintModeSubagentFinish,
) => {
  if (shouldHideAgent(event.agentType)) {
    return
  }

  state.streaming.streamRefs.setters.removeAgentAccumulator(event.agentId)
  state.subagents.removeActiveSubagent(event.agentId)

  const unresolvedToolIds = new Set<string>()
  state.message.updater.updateAiMessageBlocks((blocks) => {
    if (event.error) {
      collectUnresolvedToolIdsForAgent(blocks, event.agentId, unresolvedToolIds)
      return markAgentFailed(blocks, event.agentId, event.error)
    }
    return markAgentComplete(blocks, event.agentId)
  })

  updateStreamingAgents(state, { remove: event.agentId })
  for (const toolCallId of unresolvedToolIds) {
    updateStreamingAgents(state, { remove: toolCallId })
  }
}

const collectUnresolvedToolIds = (
  blocks: ContentBlock[],
  out: Set<string>,
): void => {
  for (const block of blocks) {
    if (block.type === 'tool') {
      if (!isTerminalToolBlock(block) && block.outputRaw === undefined) {
        out.add(block.toolCallId)
      }
    } else if (block.type === 'agent' && block.blocks) {
      collectUnresolvedToolIds(block.blocks, out)
    }
  }
}

const collectUnresolvedToolIdsForAgent = (
  blocks: ContentBlock[],
  agentId: string,
  out: Set<string>,
): void => {
  for (const block of blocks) {
    if (block.type !== 'agent') continue
    if (block.agentId === agentId) {
      collectUnresolvedToolIds(block.blocks ?? [], out)
      return
    }
    if (block.blocks) {
      collectUnresolvedToolIdsForAgent(block.blocks, agentId, out)
    }
  }
}

const handleSpawnAgentsToolCall = (
  state: EventHandlerState,
  event: PrintModeToolCall,
) => {
  const agents: unknown[] = Array.isArray(
    (event.input as { agents?: unknown })?.agents,
  )
    ? (event.input as { agents: unknown[] }).agents
    : []

  agents.forEach((agent: unknown, index: number) => {
    const tempAgentId = `${event.toolCallId}-${index}`
    const agentType =
      isRecord(agent) && typeof agent.agent_type === 'string'
        ? agent.agent_type
        : 'unknown'
    state.streaming.streamRefs.setters.setSpawnAgentInfo(tempAgentId, {
      index,
      agentType,
    })
  })

  state.message.updater.updateAiMessageBlocks((blocks) => {
    // Look up the parent agent's type if there's a parent agent ID
    const parentAgentType = event.agentId
      ? findAgentTypeById(blocks, event.agentId)
      : undefined

    const newAgentBlocks: ContentBlock[] = agents
      .map((agent: unknown, originalIndex: number) => ({
        agent,
        originalIndex,
      }))
      .filter(({ agent }) => {
        const agentType =
          isRecord(agent) && typeof agent.agent_type === 'string'
            ? agent.agent_type
            : ''
        return !shouldHideAgent(agentType)
      })
      .map(({ agent, originalIndex }) => {
        const record = isRecord(agent) ? agent : {}
        const agentType =
          typeof record.agent_type === 'string' ? record.agent_type : ''
        const prompt =
          typeof record.prompt === 'string' ? record.prompt : undefined
        const params = isRecord(record.params)
          ? (record.params as Record<string, unknown>)
          : undefined
        return createAgentBlock({
          agentId: `${event.toolCallId}-${originalIndex}`,
          agentType,
          prompt,
          params,
          spawnToolCallId: event.toolCallId,
          spawnIndex: originalIndex,
          parentAgentType,
        })
      })

    return [...blocks, ...newAgentBlocks]
  })

  agents.forEach((_: unknown, index: number) => {
    updateStreamingAgents(state, { add: `${event.toolCallId}-${index}` })
  })
}

const handleRegularToolCall = (
  state: EventHandlerState,
  event: PrintModeToolCall,
) => {
  const newToolBlock: ToolContentBlock = {
    type: 'tool',
    toolCallId: event.toolCallId,
    toolName: event.toolName as ToolName,
    input: event.input,
    agentId: event.agentId,
    ...(event.includeToolCall !== undefined && {
      includeToolCall: event.includeToolCall,
    }),
    // Carry the `queued` signal so the UI can distinguish a write that is
    // waiting on a prior same-path write (queued) from one that is actively
    // running but has no result yet (pending). Omitted when not queued.
    ...(event.queued !== undefined && { queued: event.queued }),
    // Correlate a run_terminal_command BACKGROUND card with its detached job so
    // live `job_update` events (M5) can update its lifecycle/output in place.
    ...(event.backgroundJobId !== undefined && {
      backgroundJobId: event.backgroundJobId,
    }),
    lifecycle: event.queued === true ? 'queued' : 'running',
  }

  if (event.parentAgentId && event.agentId) {
    state.message.updater.updateAiMessageBlocks((blocks) =>
      appendToolToAgentBlock(blocks, event.agentId as string, newToolBlock),
    )
    return
  }

  state.message.updater.updateAiMessageBlocks((blocks) => [
    ...blocks,
    newToolBlock,
  ])
}

const handleToolCall = (state: EventHandlerState, event: PrintModeToolCall) => {
  // Close any open native reasoning blocks when a tool call happens
  // (agent may go directly from thinking to tool calls without emitting text)
  // This must happen BEFORE any early returns (spawn_agents, hidden tools)
  if (event.parentAgentId && event.agentId) {
    // For agent tool calls, close reasoning in that specific agent
    state.message.updater.updateAiMessageBlocks((blocks) =>
      closeNativeReasoningInAgent(blocks, event.agentId as string),
    )
  } else if (!event.parentAgentId) {
    // For root tool calls, close reasoning at root level
    state.message.updater.updateAiMessageBlocks(closeNativeReasoningBlock)
  }

  if (event.toolName === 'spawn_agents' && event.input?.agents) {
    handleSpawnAgentsToolCall(state, event)
    return
  }

  if (isHiddenToolName(event.toolName)) {
    return
  }

  handleRegularToolCall(state, event)
  updateStreamingAgents(state, { add: event.toolCallId })
}

/**
 * Flips a queued tool block back to not-queued (pending) once its per-path
 * write barrier has resolved. The runtime emits a `tool_start` event via a
 * non-blocking `.then` on the barrier promise once the prior same-path write
 * settles, so this always precedes the matching `tool_result`. Uses the same
 * recursive block-lookup style as `updateToolBlockWithOutput` so nested agent
 * tool blocks (when `parentAgentId` is set) are handled.
 */
const handleToolStart = (
  state: EventHandlerState,
  event: PrintModeToolStart,
) => {
  const flipQueued = (blocks: ContentBlock[]): ContentBlock[] =>
    blocks.map((block) => {
      if (block.type === 'tool' && block.toolCallId === event.toolCallId) {
        if (isTerminalToolBlock(block)) return block
        return { ...block, queued: false, lifecycle: 'running' as const }
      } else if (block.type === 'agent' && block.blocks) {
        const updatedBlocks = flipQueued(block.blocks)
        // Avoid creating a new agent block ref when nothing changed (shallow reference check to avoid node:util and O(N^2)).
        if (
          updatedBlocks.length === block.blocks.length &&
          updatedBlocks.every(
            (updated, index) => updated === block.blocks![index],
          )
        ) {
          return block
        }
        return { ...block, blocks: updatedBlocks }
      }
      return block
    })

  state.message.updater.updateAiMessageBlocks((blocks) => flipQueued(blocks))
}

/**
 * Extracts the exact runtime child agent id from a spawn_agents report when
 * available. Older reports only had spawn index metadata; current reports carry
 * this id so out-of-order subagent_start blocks can still receive final output.
 */
const getSpawnResultAgentId = (result: unknown): string | undefined =>
  isRecord(result) &&
  typeof result.agentId === 'string' &&
  result.agentId.trim()
    ? result.agentId
    : undefined

const getSpawnResultForBlock = (
  block: AgentContentBlock,
  toolCallId: string,
  results: unknown[],
): unknown | undefined => {
  if (block.spawnToolCallId === toolCallId && block.spawnIndex !== undefined) {
    return results[block.spawnIndex]
  }

  return results.find(
    (result) => getSpawnResultAgentId(result) === block.agentId,
  )
}

/** Narrow spawn_agents result.agentReceipt without using any. */
const readSpawnAgentReceipt = (
  result: unknown,
): { status?: string; errorMessage?: string } => {
  if (!result || typeof result !== 'object') return {}
  const receipt = (result as { agentReceipt?: unknown }).agentReceipt
  if (!receipt || typeof receipt !== 'object') return {}
  const status =
    typeof (receipt as { status?: unknown }).status === 'string'
      ? (receipt as { status: string }).status
      : undefined
  const errors = (receipt as { errors?: unknown }).errors
  let errorMessage: string | undefined
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0]
    if (
      first &&
      typeof first === 'object' &&
      typeof (first as { message?: unknown }).message === 'string'
    ) {
      errorMessage = (first as { message: string }).message
    }
  }
  return { status, errorMessage }
}

const mapReceiptStatusToAgentStatus = (
  receiptStatus: string | undefined,
  hasError: boolean,
  backgroundJobId: string | undefined,
): AgentContentBlock['status'] => {
  // Prefer value-level errors over receipt status.
  if (hasError) return 'failed'
  if (backgroundJobId) return 'running'

  switch (receiptStatus) {
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'partial':
    case 'blocked':
      return 'partial'
    case 'completed':
    case undefined:
      return 'complete'
    default:
      // Unknown receipt statuses fall through to complete (existing path).
      return 'complete'
  }
}

const applySpawnAgentResultToBlock = (
  block: AgentContentBlock,
  result: unknown,
): ContentBlock => {
  const receipt = readSpawnAgentReceipt(result)
  const record = isRecord(result) ? result : null
  const hasValue = record?.value != null
  const hasReceipt =
    record?.agentReceipt != null && typeof record.agentReceipt === 'object'

  // Receipt-only results still need status applied (e.g. partial with empty value).
  if (!hasValue && !hasReceipt) {
    return block
  }

  const valueRecord = record && isRecord(record.value) ? record.value : null
  const backgroundJobId =
    hasValue &&
    valueRecord?.background === true &&
    typeof valueRecord.jobId === 'string'
      ? (valueRecord.jobId as string)
      : undefined

  const existingBlocks = block.blocks ?? []
  const { content, hasError } = hasValue
    ? extractSpawnAgentResultContent(record.value)
    : { content: '', hasError: false }
  // Check if the agent already streamed text content (e.g., basher).
  // Agents like thinker return all output at the end via lastMessage,
  // so we should add final content even if they have tool blocks.
  const hasStreamedTextContent = existingBlocks.some(
    (b) => b.type === 'text' && b.textType === 'text',
  )
  let finalBlocks =
    content && !hasStreamedTextContent
      ? [...existingBlocks, { type: 'text', content } as ContentBlock]
      : existingBlocks

  const nextStatus = mapReceiptStatusToAgentStatus(
    receipt.status,
    hasError,
    backgroundJobId,
  )

  // Append a brief receipt error when partial if that message is not already present.
  if (nextStatus === 'partial' && receipt.errorMessage) {
    const truncated = receipt.errorMessage.split('\n').slice(0, 6).join('\n')
    const firstLine = truncated.split('\n')[0] ?? truncated
    const alreadyHasErrorText = finalBlocks.some(
      (b) =>
        b.type === 'text' &&
        b.textType === 'text' &&
        b.content.includes(firstLine),
    )
    if (!alreadyHasErrorText) {
      finalBlocks = [
        ...finalBlocks,
        {
          type: 'text' as const,
          textType: 'text' as const,
          content: truncated,
        },
      ]
    }
  }

  // Apply when we have content/error, a receipt status to honor, or a background job.
  // This also allows downgrading complete → partial when receipt arrives after
  // subagent_finish marked the block complete.
  if (hasError || finalBlocks.length > 0 || hasReceipt || backgroundJobId) {
    return {
      ...block,
      blocks: finalBlocks,
      ...(backgroundJobId ? { backgroundJobId } : {}),
      status: nextStatus,
    }
  }

  return block
}

/**
 * Recursively finds and updates agent blocks that match a spawn_agents result.
 */
const updateSpawnAgentBlocks = (
  blocks: ContentBlock[],
  toolCallId: string,
  results: unknown[],
): ContentBlock[] => {
  return blocks.map((block) => {
    if (block.type !== 'agent') {
      return block
    }

    const result = getSpawnResultForBlock(block, toolCallId, results)
    if (result) {
      return applySpawnAgentResultToBlock(block, result)
    }

    // Recursively process nested agent blocks
    if (block.blocks?.length) {
      const updatedNestedBlocks = updateSpawnAgentBlocks(
        block.blocks,
        toolCallId,
        results,
      )
      if (updatedNestedBlocks !== block.blocks) {
        return { ...block, blocks: updatedNestedBlocks }
      }
    }

    return block
  })
}

const handleSpawnAgentsResult = (
  state: EventHandlerState,
  toolCallId: string,
  results: unknown[],
) => {
  // Replace placeholder spawn agent blocks with their final text/status output.
  state.message.updater.updateAiMessageBlocks((blocks) =>
    updateSpawnAgentBlocks(blocks, toolCallId, results),
  )

  results.forEach((result: unknown, index: number) => {
    if (
      isRecord(result) &&
      isRecord(result.value) &&
      result.value.background === true
    )
      return
    const agentId = `${toolCallId}-${index}`
    updateStreamingAgents(state, { remove: agentId })
  })
}

const updateBackgroundAgentCard = (
  blocks: ContentBlock[],
  value: Record<string, unknown>,
): ContentBlock[] => {
  const jobId = typeof value.jobId === 'string' ? value.jobId : undefined
  if (!jobId) return blocks
  return blocks.map((block) => {
    if (block.type !== 'agent') return block
    if (block.backgroundJobId === jobId) {
      const status = String(value.status ?? 'running')
      const resultSummary = extractSpawnAgentResultContent(value.result)
      const chunks = Array.isArray(value.newChunks) ? value.newChunks : []
      const chunkText = chunks
        .map((chunk) => {
          if (!chunk || typeof chunk !== 'object') return ''
          const payload = (chunk as Record<string, unknown>).payload
          if (typeof payload === 'string') return payload
          if (
            payload &&
            typeof payload === 'object' &&
            typeof (payload as Record<string, unknown>).text === 'string'
          ) {
            return String((payload as Record<string, unknown>).text)
          }
          return ''
        })
        .filter(Boolean)
        .join('')
      const appended = [chunkText, resultSummary.content]
        .filter(Boolean)
        .join('\n')
      const existingBlocks = block.blocks ?? []
      const resultReceipt =
        value.result &&
        typeof value.result === 'object' &&
        (value.result as { agentReceipt?: unknown }).agentReceipt &&
        typeof (value.result as { agentReceipt?: unknown }).agentReceipt ===
          'object'
          ? (value.result as { agentReceipt: { status?: unknown } })
              .agentReceipt
          : undefined
      const receiptStatus =
        resultReceipt && typeof resultReceipt.status === 'string'
          ? resultReceipt.status
          : undefined
      // Defensive: value.status or nested agentReceipt can surface partial.
      const mappedStatus: AgentContentBlock['status'] =
        status === 'partial' ||
        receiptStatus === 'partial' ||
        receiptStatus === 'blocked'
          ? 'partial'
          : status === 'completed'
            ? 'complete'
            : status === 'error'
              ? 'failed'
              : status === 'cancelled'
                ? 'cancelled'
                : 'running'
      return {
        ...block,
        blocks: appended
          ? [
              ...existingBlocks,
              { type: 'text', content: appended } as ContentBlock,
            ]
          : existingBlocks,
        status: mappedStatus,
      }
    }
    return block.blocks
      ? { ...block, blocks: updateBackgroundAgentCard(block.blocks, value) }
      : block
  })
}

const appendResultOnlyToolBlockToAgent = (
  blocks: ContentBlock[],
  event: PrintModeToolResult,
): ContentBlock[] => {
  if (!event.agentId) return blocks

  return updateBlocksRecursively(blocks, event.agentId, (block) => {
    if (block.type !== 'agent') return block
    const existingBlocks = block.blocks ?? []
    if (
      existingBlocks.some(
        (child) =>
          child.type === 'tool' && child.toolCallId === event.toolCallId,
      )
    ) {
      return block
    }

    const hasError = hasMultipartError(event.output)
    const backgroundJobId =
      !hasError && event.toolName === 'run_terminal_command'
        ? getBackgroundShellJobIdFromToolOutput(event.output)
        : undefined
    // BACKGROUND shell start is fire-and-forget: keep the card running until
    // live job_update settles it. A successful BACKGROUND start is not terminal.
    const lifecycle: ToolContentBlock['lifecycle'] = hasError
      ? 'failed'
      : backgroundJobId
        ? 'running'
        : 'succeeded'

    const resultOnlyToolBlock: ToolContentBlock = {
      type: 'tool',
      toolCallId: event.toolCallId,
      toolName: event.toolName as ToolName,
      input: {},
      agentId: event.agentId,
      lifecycle,
      ...(backgroundJobId !== undefined ? { backgroundJobId } : {}),
    }

    return {
      ...block,
      blocks: updateToolBlockWithOutput(
        [...existingBlocks, resultOnlyToolBlock],
        {
          toolCallId: event.toolCallId,
          toolOutput: event.output,
        },
      ),
    }
  })
}

const handleToolResult = (
  state: EventHandlerState,
  event: PrintModeToolResult,
) => {
  const askUserResult =
    event.output?.[0]?.type === 'json'
      ? (event.output[0] as { type: 'json'; value: unknown }).value
      : undefined
  state.message.updater.updateAiMessageBlocks((blocks) =>
    transformAskUserBlocks(blocks, {
      toolCallId: event.toolCallId,
      resultValue: askUserResult,
    }),
  )

  const firstOutput = event.output?.[0]
  const firstOutputValue =
    firstOutput?.type === 'json' ? firstOutput.value : undefined
  const isSpawnAgentsResult =
    Array.isArray(firstOutputValue) &&
    firstOutputValue.some(
      (v: unknown) =>
        isRecord(v) &&
        (typeof v.agentName === 'string' || typeof v.agentType === 'string'),
    )

  if (isSpawnAgentsResult && Array.isArray(firstOutputValue)) {
    handleSpawnAgentsResult(state, event.toolCallId, firstOutputValue)
    return
  }

  if (
    event.toolName === 'check_background_agent' &&
    firstOutputValue &&
    typeof firstOutputValue === 'object' &&
    !Array.isArray(firstOutputValue)
  ) {
    state.message.updater.updateAiMessageBlocks((blocks) =>
      updateBackgroundAgentCard(
        blocks,
        firstOutputValue as Record<string, unknown>,
      ),
    )
  }

  state.message.updater.updateAiMessageBlocks((blocks) => {
    const updatedBlocks = updateToolBlockWithOutput(blocks, {
      toolCallId: event.toolCallId,
      toolOutput: event.output,
    })
    const backgroundShellJobId =
      event.toolName === 'run_terminal_command'
        ? getBackgroundShellJobIdFromToolOutput(event.output)
        : undefined
    const withLifecycle = updatedBlocks.map(
      function markResult(block): ContentBlock {
        if (block.type === 'tool' && block.toolCallId === event.toolCallId) {
          if (block.lifecycle === 'cancelled') {
            const mutation = getCanonicalMutationResult(event.output)
            if (!mutation) return block
            return {
              ...block,
              interrupted: true,
              lifecycle:
                mutation.outcome === 'applied' ||
                mutation.outcome === 'rolled_back'
                  ? 'succeeded'
                  : 'failed',
            }
          }
          if (hasMultipartError(event.output)) {
            return { ...block, lifecycle: 'failed' }
          }
          // Successful BACKGROUND shell start: keep lifecycle running and ensure
          // backgroundJobId is set so job_update can settle the card later.
          // Do NOT mark succeeded merely because the tool call returned.
          const jobId = block.backgroundJobId ?? backgroundShellJobId
          if (jobId) {
            return {
              ...block,
              backgroundJobId: jobId,
              lifecycle: 'running',
            }
          }
          return {
            ...block,
            lifecycle: 'succeeded',
          }
        }
        if (block.type === 'agent' && block.blocks) {
          return { ...block, blocks: block.blocks.map(markResult) }
        }
        return block
      },
    )
    return appendResultOnlyToolBlockToAgent(withLifecycle, event)
  })

  updateStreamingAgents(state, { remove: event.toolCallId })
}

/** Max accumulated live output kept on a background tool card (tail-bounded). */
const JOB_OUTPUT_CHAR_CAP = 50_000

/** Tail-slice without cutting surrogate pairs (e.g. emoji). */
const safeTailSlice = (str: string, cap: number): string => {
  if (str.length <= cap) return str
  let start = str.length - cap
  // If start lands on a low surrogate, advance to avoid splitting a pair.
  if (start > 0 && start < str.length) {
    const cu = str.charCodeAt(start)
    if (cu >= 0xdc00 && cu <= 0xdfff) {
      const prev = str.charCodeAt(start - 1)
      if (prev >= 0xd800 && prev <= 0xdbff) start += 1
    }
  }
  return str.slice(start)
}

const trimTextBlocksToCap = (
  blocks: ContentBlock[],
  cap = JOB_OUTPUT_CHAR_CAP,
): ContentBlock[] => {
  const totalTextLen = blocks
    .filter((b) => b.type === 'text')
    .reduce((sum, b) => sum + ((b as TextContentBlock).content?.length ?? 0), 0)
  if (totalTextLen <= cap) return blocks
  let remaining = cap
  const trimmed: ContentBlock[] = []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.type !== 'text') {
      trimmed.unshift(b)
      continue
    }
    const content = (b as TextContentBlock).content ?? ''
    if (content.length <= remaining) {
      trimmed.unshift(b)
      remaining -= content.length
    } else {
      trimmed.unshift({
        ...b,
        content: safeTailSlice(content, remaining),
      } as ContentBlock)
      remaining = 0
      for (let j = i - 1; j >= 0; j--) {
        if (blocks[j].type !== 'text') trimmed.unshift(blocks[j])
      }
      break
    }
  }
  return trimmed
}

/**
 * Maps a job-registry lifecycle state to the tool block's lifecycle vocabulary
 * (`'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'`).
 *
 * Forward-compat: the `printModeJobUpdateSchema` JSDoc says consumers should
 * treat unknown variants as no-ops. `handleJobUpdate` runs in the streaming
 * UI render path, so the `default` branch fails safe by mapping any unknown
 * state to `'running'` (the least-surprising non-terminal state) and logging
 * a warning, instead of throwing and aborting the whole event handler.
 */
const jobStateToToolLifecycle = (
  state: PrintModeJobUpdate['state'],
  logger: Logger,
): ToolContentBlock['lifecycle'] => {
  switch (state) {
    case 'queued':
      return 'queued'
    case 'running':
    case 'stopping':
      return 'running'
    case 'completed':
      return 'succeeded'
    case 'error':
    case 'lost':
      return 'failed'
    case 'stopped':
    case 'cancelled':
      return 'cancelled'
    // Exhaustiveness guard: if `state` is a declared enum value this branch is
    // unreachable and `never` keeps the switch exhaustive at compile time. If a
    // newer runtime ever emits an unlisted state, this branch fails safe
    // (log + `'running'`) rather than throwing on the render path.
    default: {
      const exhaustive: never = state
      logger.warn(
        { jobState: String(exhaustive) },
        'Unknown job state for tool lifecycle; mapping to running (fail-safe)',
      )
      return 'running'
    }
  }
}

/**
 * Maps a job-registry lifecycle state to the agent block's status vocabulary
 * (`'running' | 'complete' | 'failed' | 'cancelled'`).
 *
 * Forward-compat: see {@link jobStateToToolLifecycle}. The `default` branch
 * fails safe by mapping unknown states to `'running'` and logging a warning,
 * instead of throwing on the streaming render path.
 */
const jobStateToAgentStatus = (
  state: PrintModeJobUpdate['state'],
  logger: Logger,
): AgentContentBlock['status'] => {
  switch (state) {
    case 'queued':
    case 'running':
    case 'stopping':
      return 'running'
    case 'completed':
      return 'complete'
    case 'error':
    case 'lost':
      return 'failed'
    case 'stopped':
    case 'cancelled':
      return 'cancelled'
    // Exhaustiveness guard: see {@link jobStateToToolLifecycle}.
    default: {
      const exhaustive: never = state
      logger.warn(
        { jobState: String(exhaustive) },
        'Unknown job state for agent status; mapping to running (fail-safe)',
      )
      return 'running'
    }
  }
}

const handleJobUpdate = (
  state: EventHandlerState,
  event: Extract<SDKEvent, { type: 'job_update' }>,
) => {
  // A failed background job carries a human-readable `error` (mirrors
  // markAgentFailed). Surface it on the correlated card; lifecycle error/lost
  // transitions fire once, so appending is idempotent-friendly.
  const errorText =
    typeof event.error === 'string' && event.error.length > 0
      ? event.error
      : undefined
  const updateBlock = (block: ContentBlock): ContentBlock => {
    if (block.type === 'tool' && block.backgroundJobId === event.jobId) {
      const nextLifecycle = jobStateToToolLifecycle(event.state, state.logger)
      // A non-terminal transition (running/queued, e.g. a restart that
      // recovers from an earlier error/lost) resets the append flag so a
      // genuinely new error reported after recovery is still surfaced —
      // otherwise the first error append would permanently suppress all
      // later errors for the same job. Terminal error/lost appends keep the
      // flag set so a repeated identical error is not duplicated.
      const isRecovery =
        nextLifecycle === 'queued' || nextLifecycle === 'running'
      const base = block.output ?? ''
      const withDelta =
        event.outputDelta !== undefined ? base + event.outputDelta : base
      // Track whether the error text has already been appended via an explicit
      // flag on the block, rather than string-suffix matching. This avoids the
      // edge case where legitimate streamed output happens to end with the same
      // error string, which would suppress a genuinely new error append.
      const errorAlreadyAppended =
        errorText !== undefined && block.jobErrorAppended === true
      const combined =
        errorText !== undefined && !errorAlreadyAppended
          ? `${withDelta}\n${errorText}`
          : withDelta
      const nextOutput =
        event.outputDelta !== undefined || errorText !== undefined
          ? safeTailSlice(combined, JOB_OUTPUT_CHAR_CAP)
          : block.output
      // Prefer flag true when this update appends error text, even if the
      // lifecycle is running/queued. Never clear the flag while event.error is
      // still present: a running/queued+error ternary fallthrough would reset
      // on each already-appended update and re-append on the next one.
      // Mirrors the agent branch, which keeps jobErrorAppended while errorText
      // is set and only resets on recovery transitions without error text.
      return {
        ...block,
        lifecycle: nextLifecycle,
        ...(nextOutput !== undefined ? { output: nextOutput } : {}),
        ...(errorText !== undefined
          ? errorAlreadyAppended
            ? {}
            : { jobErrorAppended: true }
          : isRecovery
            ? { jobErrorAppended: false }
            : {}),
      }
    }
    if (block.type === 'agent') {
      if (block.backgroundJobId === event.jobId) {
        const status = jobStateToAgentStatus(event.state, state.logger)
        const hasDelta = event.outputDelta !== undefined
        let nextBlocks = block.blocks ?? []
        if (hasDelta) {
          const deltaText = event.outputDelta as string
          const last = nextBlocks[nextBlocks.length - 1]
          if (last && last.type === 'text' && last.textType === 'text') {
            const combined = (last.content ?? '') + deltaText
            const cappedCombined =
              combined.length > JOB_OUTPUT_CHAR_CAP
                ? safeTailSlice(combined, JOB_OUTPUT_CHAR_CAP)
                : combined
            nextBlocks = [
              ...nextBlocks.slice(0, -1),
              { ...last, content: cappedCombined } as ContentBlock,
            ]
          } else {
            const cappedDelta =
              deltaText.length > JOB_OUTPUT_CHAR_CAP
                ? safeTailSlice(deltaText, JOB_OUTPUT_CHAR_CAP)
                : deltaText
            nextBlocks = [
              ...nextBlocks,
              {
                type: 'text',
                textType: 'text',
                content: cappedDelta,
              } as ContentBlock,
            ]
          }
          nextBlocks = trimTextBlocksToCap(nextBlocks)
        }
        if (errorText !== undefined) {
          const truncatedError = errorText.split('\n').slice(0, 6).join('\n')
          // Mirror the tool-block flag-based dedup: track whether the error has
          // already been appended via an explicit flag rather than comparing the
          // last text block's content, so a genuinely new identical error is not
          // suppressed when the prior block coincidentally matches.
          const alreadyAppended = block.jobErrorAppended === true
          if (!alreadyAppended) {
            nextBlocks = [
              ...nextBlocks,
              {
                type: 'text',
                textType: 'text',
                content: truncatedError,
              } as ContentBlock,
            ]
            nextBlocks = trimTextBlocksToCap(nextBlocks)
            return {
              ...block,
              status,
              blocks: nextBlocks,
              jobErrorAppended: true,
            }
          }
          return {
            ...block,
            status,
            blocks: hasDelta ? nextBlocks : block.blocks,
          }
        }
        return {
          ...block,
          status,
          blocks: hasDelta ? nextBlocks : block.blocks,
          // Mirror the tool-block recovery reset: a non-terminal transition
          // (recovery back to running) clears the append flag so a genuinely
          // new error reported after recovery is still surfaced. The terminal
          // error/lost branch above keeps the flag set once it appends.
          ...(status === 'running' ? { jobErrorAppended: false } : {}),
        }
      }
      if (block.blocks) {
        return { ...block, blocks: block.blocks.map(updateBlock) }
      }
    }
    return block
  }

  state.message.updater.updateAiMessageBlocks((blocks) =>
    blocks.map(updateBlock),
  )
}

const handlePhase = (state: EventHandlerState, event: PrintModePhase) => {
  // Phase events provide structured progress info for the status bar.
  // The detail field carries a human-readable description (e.g. "reading 5 files").
  // These are stored on the stream refs so the status bar can read them.
  state.streaming.streamRefs.setters.setPhase({
    phase: event.phase,
    detail: event.detail,
  })
}

const handleContextWindow = (
  state: EventHandlerState,
  event: PrintModeContextWindow,
) => {
  // Context-window events carry the current token usage and max so the
  // CLI status bar can display how full the context window is, plus the
  // model-aware compaction budget so the chip can also show where compaction
  // will fire. `compactionTargetTokens` is deliberately NOT forwarded: the
  // post-compaction target is not user-actionable at a glance, and it stays
  // available on the event for other consumers.
  state.streaming.setContextWindowUsage({
    used: event.used,
    max: event.max,
    ...(event.compactionTriggerTokens !== undefined && {
      compactionTriggerTokens: event.compactionTriggerTokens,
    }),
  })
}

/**
 * Tokens recorded for one category of a compaction snapshot, or 0 when the
 * payload omits that category map entry. A cross-version or replayed
 * `context_compaction` event may carry a removed category with no matching
 * entry in `before`/`after.categories`; degrading to 0 keeps the block
 * renderable instead of throwing a TypeError inside the SDK event handler.
 */
const compactionCategoryTokens = (
  categories:
    | Partial<Record<CompactionCategoryDelta['category'], { tokens?: unknown }>>
    | undefined,
  category: CompactionCategoryDelta['category'],
): number => {
  const tokens = categories?.[category]?.tokens
  return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0
}

/**
 * True when a compaction event belongs to the ROOT agent run rather than a
 * subagent or inline one. `ancestorRunIds` is empty exactly for the root run
 * (the same convention as `reasoning_delta`), so a non-empty lineage describes
 * another agent's context and must not drive root-level state. The
 * `context_compaction` result carries the correlation optionally for
 * persisted/replayed events emitted before it existed; an absent field keeps
 * the previous root-attributed behavior.
 */
const isRootCompactionEvent = (event: { ancestorRunIds?: string[] }): boolean =>
  (event.ancestorRunIds?.length ?? 0) === 0

/**
 * Index of the newest still-running compaction block produced by `runId`, or
 * -1. Only the newest one is consumed by an arriving result: two results can
 * land in one runtime iteration (semantic then mechanical) and the second must
 * append rather than overwrite the first. Matched on the producing run so a
 * result from one agent loop cannot settle another loop's live card; a legacy
 * uncorrelated result (`undefined`) still pairs with an equally uncorrelated
 * block.
 */
const findLastPendingCompactionIndex = (
  blocks: ContentBlock[],
  runId: string | undefined,
): number => {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (
      block.type === 'compaction' &&
      block.status === 'pending' &&
      block.runId === runId
    ) {
      return index
    }
  }
  return -1
}

/**
 * Rewrites the still-running compaction blocks produced by `runId` to the
 * terminal `status: 'declined'` state, returning the ORIGINAL array reference
 * when there was nothing to rewrite so React skips a re-render. Used by the
 * `settled` path only: such a pass RAN and reclaimed nothing, so the transcript
 * keeps an honest trace of it instead of deleting the card. That is distinct
 * from {@link markPendingCompactionInterrupted}, which reports a pass whose run
 * ended (abort/teardown) before it could report anything at all.
 *
 * Consecutive over-trigger iterations can each announce and decline a pass, so
 * a rewritten card that is immediately preceded by an identical declined card
 * of the same run collapses into it rather than accumulating a column of
 * duplicates. Only the immediately preceding block is considered, so an
 * unrelated block or another run's card between them keeps both.
 *
 * Only that run's blocks are rewritten, so one agent loop's `settled` cannot
 * touch another loop's live card. `runId` is required on
 * `printModeContextCompactionStatusSchema`, so unlike
 * {@link findLastPendingCompactionIndex} — reached from the `context_compaction`
 * result path, where the correlation fields are optional — there is no
 * uncorrelated case to pair here. Root-level only: compaction blocks are never
 * nested under an agent block.
 */
const declinePendingCompactionBlocks = (
  blocks: ContentBlock[],
  runId: string,
): ContentBlock[] => {
  let changed = false
  const next: ContentBlock[] = []
  for (const block of blocks) {
    if (
      !(
        block.type === 'compaction' &&
        block.status === 'pending' &&
        block.runId === runId
      )
    ) {
      next.push(block)
      continue
    }
    changed = true
    // The live stamp is meaningless once the pass is terminal.
    const { liveSessionId: _liveSessionId, ...rest } = block
    const declined: CompactionContentBlock = { ...rest, status: 'declined' }
    const previous = next[next.length - 1]
    if (
      previous &&
      previous.type === 'compaction' &&
      previous.status === 'declined' &&
      previous.runId === runId
    ) {
      next[next.length - 1] = declined
      continue
    }
    next.push(declined)
  }
  return changed ? next : blocks
}

/**
 * Live-pass bookkeeping for {@link CompactionNotice}, keyed by the emitting
 * `runId` so nested or concurrent agent loops cannot cross-settle each other.
 */
const addPendingRunId = (
  pendingRunIds: string[] | undefined,
  runId: string,
): string[] =>
  pendingRunIds?.includes(runId)
    ? pendingRunIds
    : [...(pendingRunIds ?? []), runId]

/** Tolerates a `settled` for a run that was never recorded (a post-reset event). */
const removePendingRunId = (
  pendingRunIds: string[] | undefined,
  runId: string,
): string[] => (pendingRunIds ?? []).filter((id) => id !== runId)

/**
 * True for the compatibility case {@link CompactionNotice.pendingRunIds}
 * documents: a notice produced before per-run tracking existed carries
 * `pending: true` with no `pendingRunIds` at all. Its live pass belongs to an
 * unknown run, so it cannot be matched per run — but dropping it would silently
 * lose a live flag the type promises to tolerate, so it is carried forward until
 * a settling event for it arrives.
 */
const hasUncorrelatedPending = (
  previous: CompactionNotice | null | undefined,
): boolean => previous?.pending === true && previous.pendingRunIds === undefined

/**
 * `pending` is kept as the DERIVED value of `pendingRunIds` so the status-bar
 * chip needs no logic change. Both are omitted once nothing is live, so a
 * settled notice has the exact shape it had before per-run tracking existed and
 * cannot outlive the turn as a stale `pending: true`.
 *
 * `legacyPending` covers the tolerated uncorrelated case (see
 * {@link hasUncorrelatedPending}): a live flag with no run set stays a bare
 * `pending: true`, since inventing a run id for it would let an unrelated
 * `settled` clear it.
 */
const pendingNoticeFields = (
  pendingRunIds: string[],
  legacyPending = false,
): { pending?: true; pendingRunIds?: string[] } =>
  pendingRunIds.length > 0
    ? { pending: true, pendingRunIds }
    : legacyPending
      ? { pending: true }
      : {}

/**
 * Live compaction state. The pruner agent runs inline and is hidden from the
 * CLI, so `started` marks the status-bar chip live and — for the ROOT run only
 * — appends a pending compaction card that the terminal `context_compaction`
 * result settles in place. A non-root run gets no card: its pass is short-lived
 * and a live nested card would only flicker, but its live state is still
 * reported on the chip. `settled` is the runtime's guarantee that a pass which
 * decided not to compact cannot leave that pending state on screen; the card is
 * rewritten as a declined pass rather than deleted, so the transcript keeps an
 * honest trace of a pass that reclaimed nothing.
 *
 * Every agent loop emits this event, so live state is paired by run:
 * `pendingRunIds` records each run with an unsettled `started`, and a `settled`
 * only clears its own `runId`. Without that a subagent's compaction would
 * cross-settle the root run's live pass.
 *
 * Neither cleanup path is reachable when the user aborts mid-compaction: the
 * SDK drops every post-abort event, and the blocks of the turn are persisted to
 * chat-messages.json afterwards. The pending block is therefore stamped with
 * {@link CLI_LIVE_SESSION_ID} so a replayed copy renders as an interrupted
 * pass rather than a permanent "Compacting context…" card, and the status chip
 * stops reporting a live pass once the run is no longer active.
 */
const handleContextCompactionStatus = (
  state: EventHandlerState,
  event: PrintModeContextCompactionStatus,
) => {
  const rootScoped = isRootCompactionEvent(event)

  if (event.state === 'started') {
    if (rootScoped) {
      const pendingBlock: CompactionContentBlock = {
        type: 'compaction',
        status: 'pending',
        // Stamped so a persisted/replayed copy of this transient block (the user
        // aborted the turn before `settled` or `context_compaction` arrived)
        // renders as an interrupted pass instead of a permanently live card.
        liveSessionId: CLI_LIVE_SESSION_ID,
        // Correlated so only this run's own `settled`/result can consume the card.
        runId: event.runId,
        action: 'semantic_compaction',
        beforeTokens: event.contextTokens ?? 0,
        afterTokens: 0,
        beforeMessages: 0,
        afterMessages: 0,
        reductionPercent: 0,
        retainedKnowledgeMemory: false,
        recovery: '',
        categoryDeltas: [],
        ...(event.resolvedContextWindowTokens !== undefined && {
          resolvedContextWindowTokens: event.resolvedContextWindowTokens,
        }),
        ...(event.triggerBudgetTokens !== undefined && {
          triggerBudgetTokens: event.triggerBudgetTokens,
        }),
        ...(event.targetBudgetTokens !== undefined && {
          targetBudgetTokens: event.targetBudgetTokens,
        }),
      }
      state.message.updater.updateAiMessageBlocks((blocks) => [
        ...blocks,
        pendingBlock,
      ])
    }
    state.streaming.setCompactionNotice((previous) => ({
      count: previous?.count ?? 0,
      // The live chip label does not read `action`, and a pass that has only
      // started has not decided its own action yet, so the accumulated action
      // of the last COMPLETED pass is carried forward. Overwriting it would
      // mislead the settled chip after an abort mid-compaction: a turn whose
      // only completed pass was a mechanical trim would read '⇲ compacted ×N'.
      action: previous?.action ?? 'semantic_compaction',
      degraded: previous?.degraded ?? false,
      ...pendingNoticeFields(
        addPendingRunId(previous?.pendingRunIds, event.runId),
      ),
    }))
    return
  }

  state.message.updater.updateAiMessageBlocks((blocks) =>
    declinePendingCompactionBlocks(blocks, event.runId),
  )
  state.streaming.setCompactionNotice((previous) => {
    if (!previous) return null
    const pendingRunIds = removePendingRunId(
      previous.pendingRunIds,
      event.runId,
    )
    // A pass that was announced and settled without a result RAN and reclaimed
    // nothing; its honest trace is the terminal `declined` card rewritten
    // above, not the notice. `selectStatusBarChips` renders nothing for a
    // notice that is neither pending nor `count > 0`, so once no pass is live
    // and none has completed the notice is cleared rather than retained as
    // state no consumer can observe (which also keeps a '⇲ compacted ×0' chip
    // unreachable). An uncorrelated legacy `pending: true` is settled here
    // rather than carried: a `settled` is the only event that can ever clear a
    // live flag whose run is unknown, so keeping it would strand the chip.
    if (previous.count === 0 && pendingRunIds.length === 0) return null
    return {
      count: previous.count,
      action: previous.action,
      degraded: previous.degraded,
      ...pendingNoticeFields(pendingRunIds),
    }
  })
}

/**
 * Request-time emergency trim (`context_request_trim`): the SDK dropped
 * messages at dispatch time because the request still exceeded the
 * provider-safe budget after every runtime brake ran. A DIFFERENT brake from
 * the runtime's own `mechanical_trim` result, so the block is marked
 * `trimSource: 'request'` and never consumes a pending card — it is an
 * additional pass, not the settlement of an announced one — and it always
 * degrades the notice, because reaching it means the earlier brakes failed.
 */
const handleContextRequestTrim = (
  state: EventHandlerState,
  event: PrintModeContextRequestTrim,
) => {
  // Same clamp as handleContextCompaction: a trim that somehow grew the request
  // (or reported a zero baseline) renders 0% rather than an out-of-range value.
  const reductionPercent =
    event.beforeTokens > 0
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round(
              ((event.beforeTokens - event.afterTokens) / event.beforeTokens) *
                100,
            ),
          ),
        )
      : 0

  const trimBlock: CompactionContentBlock = {
    type: 'compaction',
    status: 'complete',
    action: 'mechanical_trim',
    trimSource: 'request',
    ...(event.runId !== undefined && { runId: event.runId }),
    ...(isRootCompactionEvent(event) ? {} : { subagent: true }),
    beforeTokens: event.beforeTokens,
    afterTokens: event.afterTokens,
    beforeMessages: event.beforeMessages,
    afterMessages: event.afterMessages,
    reductionPercent,
    retainedKnowledgeMemory: false,
    recovery:
      'The runtime compaction brakes were exceeded: reduce pinned state (fewer keepDuringTruncation blocks, or /compact) or start a fresh turn.',
    categoryDeltas: [],
    reason:
      'Request-time emergency brake: messages still exceeded the provider-safe request budget at dispatch time.',
    triggerBudgetTokens: event.messageBudgetTokens,
    targetBudgetTokens: event.messageBudgetTokens,
    ...(event.resolvedContextWindowTokens !== undefined && {
      resolvedContextWindowTokens: event.resolvedContextWindowTokens,
    }),
  }

  // Always appended: this trim settles no announced pass, so a live root card
  // stays live until its own result or `settled` arrives.
  state.message.updater.updateAiMessageBlocks((blocks) => [
    ...blocks,
    trimBlock,
  ])

  state.streaming.setCompactionNotice((previous) => ({
    count: (previous?.count ?? 0) + 1,
    action: 'mechanical_trim',
    // A request-time trim means the runtime brakes failed, so the turn is
    // degraded regardless of how the earlier passes reported.
    degraded: true,
    // This trim settles no announced pass, so every live pass is carried
    // forward — including a legacy notice's uncorrelated `pending: true`,
    // which would otherwise silently lose its live flag here.
    ...pendingNoticeFields(
      previous?.pendingRunIds ?? [],
      hasUncorrelatedPending(previous),
    ),
  }))
}

const handleContextCompaction = (
  state: EventHandlerState,
  event: PrintModeContextCompaction,
) => {
  // Whole-percent reduction, clamped so a compaction that somehow grew the
  // context (or reported a zero baseline) renders 0% instead of a negative or
  // out-of-range percent.
  const reductionPercent =
    event.before.tokens > 0
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round(
              ((event.before.tokens - event.after.tokens) /
                event.before.tokens) *
                100,
            ),
          ),
        )
      : 0

  // `removedCategories` is required by the current event contract, but a
  // cross-version or replayed `context_compaction` payload emitted before the
  // field existed can omit it. Degrading to an empty delta list keeps the card
  // renderable instead of throwing a TypeError inside the SDK event handler.
  const removedCategories = Array.isArray(event.removedCategories)
    ? event.removedCategories
    : []

  const categoryDeltas: CompactionCategoryDelta[] = removedCategories.map(
    (category) => ({
      category,
      beforeTokens: compactionCategoryTokens(event.before.categories, category),
      afterTokens: compactionCategoryTokens(event.after.categories, category),
    }),
  )

  const degraded =
    event.fitsBudget === false ||
    (event.consecutiveNoProgressCompactions ?? 0) >= 2

  const resultBlock: CompactionContentBlock = {
    type: 'compaction',
    status: 'complete',
    action: event.action,
    ...(event.runId !== undefined && { runId: event.runId }),
    // A nested run's pass is labelled as such: it reports another agent's
    // context, not the root turn's.
    ...(isRootCompactionEvent(event) ? {} : { subagent: true }),
    beforeTokens: event.before.tokens,
    afterTokens: event.after.tokens,
    beforeMessages: event.before.messages,
    afterMessages: event.after.messages,
    reductionPercent,
    retainedKnowledgeMemory: event.retainedKnowledgeMemory,
    recovery: event.recovery,
    categoryDeltas,
    ...(event.reason !== undefined && { reason: event.reason }),
    ...(event.resolvedContextWindowTokens !== undefined && {
      resolvedContextWindowTokens: event.resolvedContextWindowTokens,
    }),
    ...(event.triggerBudgetTokens !== undefined && {
      triggerBudgetTokens: event.triggerBudgetTokens,
    }),
    ...(event.targetBudgetTokens !== undefined && {
      targetBudgetTokens: event.targetBudgetTokens,
    }),
    ...(event.compactionCount !== undefined && {
      compactionCount: event.compactionCount,
    }),
    ...(event.consecutiveNoProgressCompactions !== undefined && {
      consecutiveNoProgressCompactions: event.consecutiveNoProgressCompactions,
    }),
    ...(event.fitsBudget !== undefined && { fitsBudget: event.fitsBudget }),
    ...(event.shortfallTokens !== undefined && {
      shortfallTokens: event.shortfallTokens,
    }),
    ...(event.escalated !== undefined && { escalated: event.escalated }),
  }

  // The live pending card settles into the result in place; with no pending
  // card for this run (e.g. a mechanical trim with no preceding start, or a
  // subagent result while the root card is live) the result appends, which is
  // the pre-existing behavior.
  state.message.updater.updateAiMessageBlocks((blocks) => {
    const pendingIndex = findLastPendingCompactionIndex(blocks, event.runId)
    if (pendingIndex === -1) return [...blocks, resultBlock]
    const next = [...blocks]
    next[pendingIndex] = resultBlock
    return next
  })

  // The notice accumulates across compactions within a turn. `compactionCount`
  // counts the EMITTING run's own passes, so only the root run's count may
  // replace the turn total; a subagent/inline result contributes one pass
  // instead of overwriting it, and never settles the root run's live pass.
  const rootScoped = isRootCompactionEvent(event)
  state.streaming.setCompactionNotice((previous) => {
    // A root result consumes this run's announced pass; a nested result leaves
    // every live pass (including the root's) exactly as it was. A legacy
    // uncorrelated root result carries no runId, so it clears the live set the
    // way it did before per-run tracking existed.
    const pendingRunIds = !rootScoped
      ? (previous?.pendingRunIds ?? [])
      : event.runId === undefined
        ? []
        : removePendingRunId(previous?.pendingRunIds, event.runId)
    // A nested result changes no live state, so an uncorrelated legacy
    // `pending: true` is carried forward; a root result consumes the announced
    // pass that flag stands for and therefore clears it.
    const legacyPending = !rootScoped && hasUncorrelatedPending(previous)
    return {
      count: rootScoped
        ? (event.compactionCount ?? (previous?.count ?? 0) + 1)
        : (previous?.count ?? 0) + 1,
      action: event.action,
      degraded,
      ...pendingNoticeFields(pendingRunIds, legacyPending),
    }
  })
}

const handleFinish = (state: EventHandlerState, event: PrintModeFinish) => {
  if (typeof event.totalCost === 'number' && state.onTotalCost) {
    state.onTotalCost(event.totalCost)
  }

  const settledIds = new Set<string>()
  state.message.updater.updateAiMessageBlocks((blocks) => {
    // Defensive turn-boundary cleanup: an abnormal end between `started` and
    // `settled` must not leave a live compacting card on screen. The pass is
    // rewritten to its terminal interrupted state rather than deleted, so the
    // transcript keeps an honest record of a compaction that never reported a
    // result. Kept separate from the recursive agent/tool settling below, which
    // walks nested blocks. A user abort never reaches this handler: the abort
    // listener in hooks/helpers/send-message.ts applies the same rewrite.
    const rootBlocks = markPendingCompactionInterrupted(blocks)
    const settledBlocks = settleOrphanedForegroundAgents(rootBlocks, settledIds)
    const summary = computeCompletionSummary(settledBlocks)
    if (!summary) return settledBlocks

    return [
      ...settledBlocks,
      {
        type: 'completion-summary' as const,
        summary,
      },
    ]
  })
  for (const id of settledIds) {
    updateStreamingAgents(state, { remove: id })
  }
}

const settleOrphanedForegroundAgents = (
  blocks: ContentBlock[],
  settledIds: Set<string>,
): ContentBlock[] =>
  blocks.map((block) => {
    if (block.type === 'tool') {
      if (isTerminalToolBlock(block) || block.outputRaw !== undefined) {
        return block
      }
      settledIds.add(block.toolCallId)
      return { ...block, queued: false, lifecycle: 'failed' as const }
    }
    if (block.type !== 'agent') return block
    // Detached background agents remain live after the root turn finishes and
    // are reconciled only by check_background_agent.
    if (block.backgroundJobId && block.status === 'running') return block
    const nestedBlocks = block.blocks
      ? settleOrphanedForegroundAgents(block.blocks, settledIds)
      : block.blocks
    if (block.status === 'running' && !block.backgroundJobId) {
      settledIds.add(block.agentId)
      return { ...block, blocks: nestedBlocks, status: 'failed' as const }
    }
    return nestedBlocks === block.blocks
      ? block
      : { ...block, blocks: nestedBlocks }
  })

const handleRuntimeError = (
  state: EventHandlerState,
  event: Extract<SDKEvent, { type: 'error' }>,
) => {
  // Auto-recoverable model errors (e.g. a malformed tool call the model is
  // already correcting, or a runtime-enforced tool-ordering rejection) are
  // agent-facing control-flow diagnostics, not user-facing errors: skip the
  // visible error banner entirely, and log at debug rather than error so the
  // log level matches their non-failure nature.
  if (event.autoRecovering === true) {
    state.logger.debug({ event }, 'SDK auto-recovering runtime notice')
    return
  }
  state.logger.error({ event }, 'SDK runtime error event')
  const concise = event.userMessage?.trim()
  if (concise) {
    state.message.updater.setError(concise)
    return
  }
  const message = event.message
    .split('\n')
    .filter((line, index) => index === 0 || !/^\s*at\s/.test(line))
    .join('\n')
    .trim()
  state.message.updater.setError(
    message || 'The agent runtime reported an error.',
  )
}

const handleProviderStatus = (
  state: EventHandlerState,
  event: Extract<SDKEvent, { type: 'provider_status' }>,
) => {
  state.setIsRetrying(event.status !== 'recovered')
  const content =
    event.status === 'retrying'
      ? `Provider request failed; retrying${event.attempt ? ` (attempt ${event.attempt}/${event.maxAttempts})` : ''}${event.delayMs ? ` in ${(event.delayMs / 1000).toFixed(1)}s` : ''}.`
      : event.status === 'failover'
        ? `Provider failover: ${event.model ?? 'primary model'} → ${event.nextModel ?? 'backup model'}.`
        : `Provider connection recovered${event.model ? ` on ${event.model}` : ''}.`
  state.message.updater.updateAiMessageBlocks((blocks) => [
    ...blocks,
    { type: 'text' as const, textType: 'text' as const, content },
  ])
}

export const createStreamChunkHandler =
  (state: EventHandlerState) => (event: StreamChunkEvent) => {
    const destination = destinationFromChunkEvent(event)
    let text: string | undefined
    if (typeof event === 'string') {
      text = event
    } else {
      text = event.chunk
    }

    if (!destination) {
      state.logger.warn({ event }, 'Unhandled stream chunk event')
      return
    }

    if (!text) {
      return
    }

    ensureStreaming(state)

    if (destination.type === 'root') {
      if (destination.textType === 'text') {
        state.streaming.streamRefs.setters.appendRootStreamBuffer(text)
      }
      state.streaming.streamRefs.setters.setRootStreamSeen(true)
      appendRootChunk(state, { type: destination.textType, text })
      return
    }

    state.message.updater.updateAiMessageBlocks((blocks) =>
      processTextChunk(blocks, destination, text),
    )
  }

export const createEventHandler =
  (state: EventHandlerState) => (event: SDKEvent) => {
    return match(event)
      .with({ type: 'subagent_start' }, (e) => handleSubagentStart(state, e))
      .with({ type: 'subagent_finish' }, (e) => handleSubagentFinish(state, e))
      .with({ type: 'tool_call' }, (e) => handleToolCall(state, e))
      .with({ type: 'tool_start' }, (e) => handleToolStart(state, e))
      .with({ type: 'tool_result' }, (e) => handleToolResult(state, e))
      .with({ type: 'finish' }, (e) => handleFinish(state, e))
      .with({ type: 'error' }, (e) => handleRuntimeError(state, e))
      .with({ type: 'provider_status' }, (e) => handleProviderStatus(state, e))
      .with({ type: 'phase' }, (e) => handlePhase(state, e))
      .with({ type: 'context_window' }, (e) => handleContextWindow(state, e))
      .with({ type: 'context_compaction' }, (e) =>
        handleContextCompaction(state, e),
      )
      .with({ type: 'context_compaction_status' }, (e) =>
        handleContextCompactionStatus(state, e),
      )
      .with({ type: 'context_request_trim' }, (e) =>
        handleContextRequestTrim(state, e),
      )
      .with({ type: 'job_update' }, (e) => handleJobUpdate(state, e))
      .otherwise(() => undefined)
  }
