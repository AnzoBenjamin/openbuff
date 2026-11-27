import stringWidth from 'string-width'

import type { AgentMode } from './constants'

const previewSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
})

let timestampFormatter: Intl.DateTimeFormat | null = null
export function initTimestampFormatter() {
  if (timestampFormatter) return
  try {
    timestampFormatter = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    timestampFormatter = null
  }
}

export function formatTimestamp(date = new Date()): string {
  if (timestampFormatter) {
    return timestampFormatter.format(date)
  }
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatQueuedPreview(
  messages: Array<{
    content: string
    agentMode?: AgentMode
    attachments?: unknown[]
  }>,
  maxChars: number = 60,
): string {
  if (messages.length === 0) return ''

  const next = messages[0]
  const mode =
    next.agentMode === 'EXECUTE_PLAN'
      ? 'Execute'
      : next.agentMode === 'PLAN'
        ? 'Plan'
        : 'Default'
  const attachmentCount = next.attachments?.length ?? 0
  const attachments = attachmentCount
    ? ` · ${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`
    : ''
  const following = messages.length > 1 ? ` (+${messages.length - 1})` : ''
  const content = next.content.replace(/\s+/g, ' ').trim()
  const preview = `Next · ${mode}${attachments}${content ? `: ${content}` : ''}`
  const width = Math.max(0, Math.floor(maxChars))
  if (stringWidth(preview + following) <= width) return preview + following
  if (width === 0) return ''
  const suffix = stringWidth(following) < width ? following : ''
  const bodyWidth = width - stringWidth(suffix)
  let clipped = ''
  let usedWidth = 0
  for (const { segment } of previewSegmenter.segment(preview)) {
    const segmentWidth = stringWidth(segment)
    if (usedWidth + segmentWidth > bodyWidth - 1) break
    clipped += segment
    usedWidth += segmentWidth
  }
  return clipped + '…' + suffix
}
