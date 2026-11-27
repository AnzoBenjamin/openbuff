import type { TextContentBlock } from '../types/chat'
export const THINKING_PREVIEW_CHARACTER_LIMIT = 8192
export const THINKING_PREVIEW_PART_LIMIT = 4096

/** Read a bounded retained tail; hidden mode never calls this helper. */
export function thinkingPreviewTail(
  blocks: readonly Pick<TextContentBlock, 'content'>[],
): { text: string; limited: boolean; characters: number; parts: number } {
  const pieces: string[] = []
  let remaining = THINKING_PREVIEW_CHARACTER_LIMIT
  let parts = 0
  let limited = false
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (!remaining || parts >= THINKING_PREVIEW_PART_LIMIT) {
      limited = true
      break
    }
    const text = blocks[index].content
    parts++
    const start = Math.max(0, text.length - remaining)
    let piece = text.slice(start)
    if (start > 0) {
      limited = true
      if (/^[\uDC00-\uDFFF]/.test(piece)) piece = piece.slice(1)
    }
    pieces.push(piece)
    remaining -= piece.length
  }
  const text = pieces.reverse().join('')
  return { text, limited, characters: text.length, parts }
}
export function retainedThinkingText(
  blocks: readonly Pick<TextContentBlock, 'content'>[],
): string {
  return blocks.length === 1
    ? blocks[0].content
    : blocks.map((block) => block.content).join('')
}
