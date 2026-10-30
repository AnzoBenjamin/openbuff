import {
  appendTextToAgentBlock,
  appendTextToRootStream,
} from './block-operations'

import type { StreamChunkEvent } from './sdk-event-handlers'
import type { ContentBlock } from '../types/chat'

export type ChunkDestination =
  | { type: 'root'; textType: 'text' | 'reasoning' }
  | { type: 'agent'; agentId: string; textType: 'text' | 'reasoning' }

export const destinationFromTextEvent = (event: {
  agentId?: string
}): ChunkDestination => {
  if (event.agentId) {
    return { type: 'agent', agentId: event.agentId, textType: 'text' }
  }
  return { type: 'root', textType: 'text' }
}

export const destinationFromChunkEvent = (
  event: StreamChunkEvent,
): ChunkDestination | null => {
  if (typeof event === 'string') {
    return { type: 'root', textType: 'text' }
  }

  if (event.type === 'subagent_chunk') {
    return { type: 'agent', agentId: event.agentId, textType: 'text' }
  }

  if (event.type === 'reasoning_chunk') {
    // Mirror `destinationFromTextEvent`: an event carrying an `agentId` belongs
    // to that agent's block, and only an event with NO agentId is root-owned.
    // A DIRECT child of the orchestrator has an empty `ancestorRunIds` chain
    // (it has no ancestor runs) but a non-empty `agentId`, so keying on
    // ancestry alone rendered its thinking at the root while its text rendered
    // in its own block. Keying on `agentId` matches the text convention and
    // keeps a root reasoning delta (no agentId) at the root.
    if (event.agentId) {
      return { type: 'agent', agentId: event.agentId, textType: 'reasoning' }
    }
    return { type: 'root', textType: 'reasoning' }
  }

  return null
}

export const processTextChunk = (
  blocks: ContentBlock[],
  destination: ChunkDestination,
  text: string,
): ContentBlock[] => {
  if (!text) {
    return blocks
  }

  if (destination.type === 'agent') {
    return appendTextToAgentBlock(
      blocks,
      destination.agentId,
      text,
      destination.textType,
    )
  }

  return appendTextToRootStream(blocks, {
    type: destination.textType,
    text,
  })
}
