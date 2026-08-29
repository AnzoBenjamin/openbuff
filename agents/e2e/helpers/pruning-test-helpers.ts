import { expect } from 'bun:test'

import type { Message, ToolMessage } from '@openbuff/sdk'
import type { ToolCallPart } from '@codebuff/common/types/messages/content-part'

export {
  WORD_FILLER,
  makeLargeContent,
  isTextPart,
} from '../../../sdk/e2e/utils/e2e-mocks'

export function isToolCallPart(part: unknown): part is ToolCallPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    'type' in part &&
    part.type === 'tool-call' &&
    'toolCallId' in part &&
    typeof (part as ToolCallPart).toolCallId === 'string'
  )
}

export function isToolMessageWithId(
  msg: Message,
): msg is ToolMessage & { toolCallId: string } {
  return (
    msg.role === 'tool' &&
    'toolCallId' in msg &&
    typeof msg.toolCallId === 'string'
  )
}

export function verifyToolCallPairIntegrity(messages: Message[]): void {
  const toolCallIds = new Set<string>()
  const toolResultIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (isToolCallPart(part)) {
          toolCallIds.add(part.toolCallId)
        }
      }
    }
    if (isToolMessageWithId(msg)) {
      toolResultIds.add(msg.toolCallId)
    }
  }
  for (const resultId of toolResultIds) {
    expect(toolCallIds.has(resultId)).toBe(true)
  }
  for (const callId of toolCallIds) {
    expect(toolResultIds.has(callId)).toBe(true)
  }
}
