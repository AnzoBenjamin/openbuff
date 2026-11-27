import type { ChatMessage, ContentBlock } from '../types/chat'

/** Lifecycle milestones, independent of token/chunk frequency. */
export function conversationUpdateKeys(messages: readonly ChatMessage[]): Set<string> {
  const keys = new Set<string>()
  const visited = new Set<ContentBlock>()
  const blocks: ContentBlock[] = []
  for (const message of messages) {
    keys.add(`message:${message.id}`)
    if (message.isComplete) keys.add(`complete:${message.id}`)
    if (message.blocks) blocks.push(...message.blocks)
  }
  while (blocks.length && visited.size < 5000) {
    const block = blocks.pop()!
    if (visited.has(block)) continue
    visited.add(block)
    if (block.type === 'tool')
      keys.add(`tool:${block.toolCallId}:${block.lifecycle ?? (block.outputRaw !== undefined || block.output !== undefined ? 'captured' : 'running')}`)
    else if (block.type === 'agent') {
      keys.add(`agent:${block.agentId}:${block.status}`)
      if (block.blocks) blocks.push(...block.blocks)
    }
  }
  return keys
}
