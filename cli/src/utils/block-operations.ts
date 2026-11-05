import { randomUUID } from 'node:crypto'
import { updateBlocksRecursively } from './message-block-helpers'
import {
  getPartialTagLength,
  THINK_OPEN_TAG,
  THINK_CLOSE_TAG,
} from './think-tag-parser'

import type {
  ContentBlock,
  ToolContentBlock,
  TextContentBlock,
} from '../types/chat'

const generateThinkingId = (): string => `thinking-${randomUUID()}`

type AgentTextUpdate =
  | {
      type: 'text'
      mode: 'append'
      content: string
      textType: 'text' | 'reasoning'
    }
  | { type: 'text'; mode: 'replace'; content: string }

const updateAgentText = (
  blocks: ContentBlock[],
  agentId: string,
  update: AgentTextUpdate,
) => {
  return updateBlocksRecursively(blocks, agentId, (block) => {
    if (block.type !== 'agent') {
      return block
    }

    const agentBlocks = block.blocks ? [...block.blocks] : []
    const text = update.content ?? ''

    if (update.mode === 'replace') {
      const updatedBlocks = [...agentBlocks]
      let replaced = false

      for (let i = updatedBlocks.length - 1; i >= 0; i--) {
        const entry = updatedBlocks[i]
        if (entry.type === 'text') {
          replaced = true
          if (entry.content === text && block.content === text) {
            return block
          }
          updatedBlocks[i] = { ...entry, content: text }
          break
        }
      }

      if (!replaced) {
        updatedBlocks.push({ type: 'text', content: text })
      }

      return {
        ...block,
        content: text,
        blocks: updatedBlocks,
      }
    }

    if (!text) {
      return block
    }

    // Handle native reasoning chunks for agent blocks
    if (update.textType === 'reasoning') {
      const updatedAgentBlocks = appendNativeReasoningToBlocks(
        agentBlocks,
        text,
      )
      const updatedContent = (block.content ?? '') + text
      return {
        ...block,
        content: updatedContent,
        blocks: updatedAgentBlocks,
      }
    }

    // For regular text: first close any open native reasoning block, then use think tag parsing
    const blocksWithClosedReasoning = closeNativeReasoningBlock(agentBlocks)
    const updatedAgentBlocks = appendTextWithThinkParsingToBlocks(
      blocksWithClosedReasoning,
      text,
    )
    const updatedContent = (block.content ?? '') + text
    return {
      ...block,
      content: updatedContent,
      blocks: updatedAgentBlocks,
    }
  })
}

/**
 * Check if a text block represents an open (unclosed) thinking block.
 */
const isOpenThinkingBlock = (block: ContentBlock | undefined): boolean => {
  if (!block || block.type !== 'text') {
    return false
  }
  return block.textType === 'reasoning' && block.thinkingOpen === true
}

/**
 * Creates a new reasoning (thinking) text block.
 */
const createReasoningBlock = (
  content: string,
  thinkingOpen: boolean,
  thinkingId: string,
): TextContentBlock => ({
  type: 'text',
  content,
  textType: 'reasoning',
  thinkingCollapseState: 'preview',
  thinkingOpen,
  thinkingId,
  thinkingStartedAt: Date.now(),
})

/**
 * Creates a new regular text block.
 */
const createTextBlock = (content: string): TextContentBlock => ({
  type: 'text',
  content,
  textType: 'text',
})

/**
 * Shared logic for appending text with think tag parsing.
 * Used by both root stream and agent blocks.
 */
const appendTextWithThinkParsingToBlocks = (
  blocks: ContentBlock[],
  text: string,
): ContentBlock[] => {
  if (!text) return blocks
  const nextBlocks = [...blocks]
  const previous = nextBlocks[nextBlocks.length - 1]
  let insideThinking = isOpenThinkingBlock(previous)
  let input = text

  // A partial delimiter stays in its source block until the next delta. That
  // keeps unfinished input inspectable and avoids a process-global buffer.
  // Remove only that suffix before replaying it with the new bytes.
  if (
    previous?.type === 'text' &&
    (insideThinking ||
      (previous.textType !== 'reasoning' && !previous.thinkingId))
  ) {
    const pending = getPartialTagLength(previous.content)
    if (pending > 0) {
      input = previous.content.slice(-pending) + input
      const content = previous.content.slice(0, -pending)
      if (!content && !insideThinking) nextBlocks.pop()
      else nextBlocks[nextBlocks.length - 1] = { ...previous, content }
    }
  }

  const append = (content: string) => {
    if (!content) return
    const last = nextBlocks[nextBlocks.length - 1]
    const canAppend =
      last?.type === 'text' &&
      (insideThinking
        ? isOpenThinkingBlock(last)
        : last.textType !== 'reasoning' && !last.thinkingId)
    if (canAppend && last?.type === 'text')
      nextBlocks[nextBlocks.length - 1] = {
        ...last,
        content: last.content + content,
      }
    else
      nextBlocks.push(
        insideThinking
          ? createReasoningBlock(content, true, generateThinkingId())
          : createTextBlock(content),
      )
  }

  let offset = 0
  while (offset < input.length) {
    const delimiter = insideThinking ? THINK_CLOSE_TAG : THINK_OPEN_TAG
    const found = input.indexOf(delimiter, offset)
    if (found === -1) {
      append(input.slice(offset))
      break
    }
    append(input.slice(offset, found))
    offset = found + delimiter.length
    if (insideThinking) {
      const last = nextBlocks[nextBlocks.length - 1]
      if (last?.type === 'text' && isOpenThinkingBlock(last))
        nextBlocks[nextBlocks.length - 1] = {
          ...last,
          thinkingOpen: false,
          thinkingEndedAt: Date.now(),
        }
      insideThinking = false
    } else {
      nextBlocks.push(createReasoningBlock('', true, generateThinkingId()))
      insideThinking = true
    }
  }
  return nextBlocks
}

/**
 * Appends native reasoning content to blocks array (for agent blocks).
 * Similar to how appendTextToRootStream handles reasoning for root.
 */
const appendNativeReasoningToBlocks = (
  blocks: ContentBlock[],
  text: string,
): ContentBlock[] => {
  if (!text) {
    return blocks
  }

  const nextBlocks = [...blocks]
  const lastBlock = nextBlocks[nextBlocks.length - 1]

  // If last block is already an open native reasoning block, append to it
  // Only append if it's a native reasoning block (thinkingOpen === undefined),
  // not a closed one or a <think> tag block
  if (isNativeReasoningBlock(lastBlock) && lastBlock.type === 'text') {
    const updatedBlock: ContentBlock = {
      ...lastBlock,
      content: lastBlock.content + text,
    }
    nextBlocks[nextBlocks.length - 1] = updatedBlock
    return nextBlocks
  }

  // Create a new native reasoning block
  const newBlock: ContentBlock = {
    type: 'text',
    content: text,
    textType: 'reasoning',
    thinkingCollapseState: 'preview',
    thinkingId: generateThinkingId(),
    thinkingStartedAt: Date.now(),
  }

  return [...nextBlocks, newBlock]
}

/**
 * Checks if a block is a native reasoning block (not from <think> tags).
 * Native reasoning blocks have textType === 'reasoning' but thinkingOpen === undefined.
 */
export const isNativeReasoningBlock = (
  block: ContentBlock | undefined,
): boolean => {
  if (!block || block.type !== 'text') {
    return false
  }
  return block.textType === 'reasoning' && block.thinkingOpen === undefined
}

/**
 * Closes native reasoning blocks within a specific agent's blocks.
 * Used when a tool call happens for a subagent.
 */
export const closeNativeReasoningInAgent = (
  blocks: ContentBlock[],
  agentId: string,
): ContentBlock[] => {
  return updateBlocksRecursively(blocks, agentId, (block) => {
    if (block.type !== 'agent') {
      return block
    }
    const closedBlocks = block.blocks
      ? closeNativeReasoningBlock(block.blocks)
      : undefined
    if (closedBlocks && closedBlocks !== block.blocks) {
      return { ...block, blocks: closedBlocks }
    }
    return block
  })
}

/**
 * Marks the last native reasoning block as complete by setting thinkingOpen: false.
 * This triggers the UI to collapse the thinking block.
 *
 * Note: We search backwards through all blocks because agent/tool blocks may have
 * been added after the reasoning block but before text output starts.
 */
export const closeNativeReasoningBlock = (
  blocks: ContentBlock[],
): ContentBlock[] => {
  // Find the last native reasoning block (not just the last block)
  let lastReasoningIndex = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isNativeReasoningBlock(blocks[i])) {
      lastReasoningIndex = i
      break
    }
  }

  if (lastReasoningIndex === -1) {
    return blocks
  }

  const reasoningBlock = blocks[lastReasoningIndex]
  if (reasoningBlock.type !== 'text') {
    return blocks
  }

  const nextBlocks = [...blocks]
  nextBlocks[lastReasoningIndex] = {
    ...reasoningBlock,
    thinkingOpen: false,
    thinkingEndedAt: Date.now(),
  }
  return nextBlocks
}

export const appendTextToRootStream = (
  blocks: ContentBlock[],
  delta: { type: 'text' | 'reasoning'; text: string },
) => {
  if (!delta.text) {
    return blocks
  }

  if (delta.type === 'reasoning')
    return appendNativeReasoningToBlocks(blocks, delta.text)

  // For text type: first close any open native reasoning block, then parse for <think> tags
  const blocksWithClosedReasoning = closeNativeReasoningBlock(blocks)
  return appendTextWithThinkParsingToBlocks(
    blocksWithClosedReasoning,
    delta.text,
  )
}

export const appendTextToAgentBlock = (
  blocks: ContentBlock[],
  agentId: string,
  text: string,
  textType: 'text' | 'reasoning' = 'text',
) =>
  updateAgentText(blocks, agentId, {
    type: 'text',
    mode: 'append',
    content: text,
    textType,
  })

export const replaceTextInAgentBlock = (
  blocks: ContentBlock[],
  agentId: string,
  text: string,
) =>
  updateAgentText(blocks, agentId, {
    type: 'text',
    mode: 'replace',
    content: text,
  })

export const appendToolToAgentBlock = (
  blocks: ContentBlock[],
  agentId: string,
  toolBlock: ToolContentBlock,
) =>
  updateBlocksRecursively(blocks, agentId, (block) => {
    if (block.type !== 'agent') {
      return block
    }
    // Close any open native reasoning blocks before adding the tool
    const agentBlocks = block.blocks
      ? closeNativeReasoningBlock([...block.blocks])
      : []
    return { ...block, blocks: [...agentBlocks, toolBlock] }
  })

export const markAgentComplete = (blocks: ContentBlock[], agentId: string) =>
  updateBlocksRecursively(blocks, agentId, (block) => {
    if (block.type !== 'agent') {
      return block
    }
    // Close any open native reasoning blocks when the agent completes
    const closedBlocks = block.blocks
      ? closeNativeReasoningBlock(block.blocks)
      : undefined
    return {
      ...block,
      status: 'complete' as const,
      ...(closedBlocks && { blocks: closedBlocks }),
    }
  })

export const markAgentFailed = (
  blocks: ContentBlock[],
  agentId: string,
  error?: string,
) =>
  updateBlocksRecursively(blocks, agentId, (block) => {
    if (block.type !== 'agent' || block.status === 'cancelled') return block
    const closedBlocks = block.blocks
      ? markRunningToolsAsFailed(closeNativeReasoningBlock(block.blocks))
      : []
    return {
      ...block,
      status: 'failed' as const,
      blocks: error
        ? [
            ...closedBlocks,
            {
              type: 'text' as const,
              textType: 'text' as const,
              content: error.split('\n').slice(0, 6).join('\n'),
            },
          ]
        : closedBlocks,
    }
  })

export const markAgentPartial = (
  blocks: ContentBlock[],
  agentId: string,
  error?: string,
) =>
  updateBlocksRecursively(blocks, agentId, (block) => {
    if (block.type !== 'agent' || block.status === 'cancelled') return block
    const closedBlocks = block.blocks
      ? closeNativeReasoningBlock(block.blocks)
      : []
    return {
      ...block,
      status: 'partial' as const,
      blocks: error
        ? [
            ...closedBlocks,
            {
              type: 'text' as const,
              textType: 'text' as const,
              content: error.split('\n').slice(0, 6).join('\n'),
            },
          ]
        : closedBlocks,
    }
  })

/** Mark every unresolved tool call failed without changing terminal calls. */
export const markRunningToolsAsFailed = (
  blocks: ContentBlock[],
): ContentBlock[] =>
  blocks.map((block) => {
    if (block.type === 'tool') {
      if (
        block.lifecycle === 'succeeded' ||
        block.lifecycle === 'failed' ||
        block.lifecycle === 'cancelled' ||
        block.outputRaw !== undefined
      ) {
        return block
      }
      return { ...block, queued: false, lifecycle: 'failed' as const }
    }
    if (block.type === 'agent' && block.blocks) {
      return { ...block, blocks: markRunningToolsAsFailed(block.blocks) }
    }
    return block
  })

/** Mark every unresolved tool call terminal without changing completed calls. */
export const markRunningToolsAsCancelled = (
  blocks: ContentBlock[],
): ContentBlock[] =>
  blocks.map((block) => {
    if (block.type === 'tool') {
      if (
        block.lifecycle === 'succeeded' ||
        block.lifecycle === 'failed' ||
        block.lifecycle === 'cancelled' ||
        block.outputRaw !== undefined
      ) {
        return block
      }
      return { ...block, queued: false, lifecycle: 'cancelled' as const }
    }
    if (block.type === 'agent' && block.blocks) {
      return { ...block, blocks: markRunningToolsAsCancelled(block.blocks) }
    }
    return block
  })

/**
 * Recursively marks all agent blocks with status 'running' as 'cancelled'.
 * Used when the user interrupts a response to indicate subagents were stopped.
 * Also closes any open native reasoning blocks so they don't appear "streaming".
 */
export const markRunningAgentsAsCancelled = (
  blocks: ContentBlock[],
): ContentBlock[] => {
  return blocks.map((block) => {
    if (block.type !== 'agent') {
      return block
    }

    // First recursively process nested agents, then close any reasoning blocks
    let updatedBlocks = block.blocks
      ? markRunningToolsAsCancelled(markRunningAgentsAsCancelled(block.blocks))
      : undefined

    // Close any open native reasoning blocks in this agent
    if (updatedBlocks) {
      updatedBlocks = closeNativeReasoningBlock(updatedBlocks)
    }

    if (block.status === 'running') {
      return {
        ...block,
        status: 'cancelled' as const,
        ...(updatedBlocks && { blocks: updatedBlocks }),
      }
    }

    if (updatedBlocks && updatedBlocks !== block.blocks) {
      return { ...block, blocks: updatedBlocks }
    }

    return block
  })
}
