import { createTableDocument, type OutputDocument } from './output-document'
import type { ChatMessage } from '../types/chat'

/** Inspect captured descendants without rehydrating, executing or rereading them. */
export function legacyAgentDescendantDocument(
  children: readonly ChatMessage[],
  tree: ReadonlyMap<string, readonly ChatMessage[]> | null,
): OutputDocument {
  const pending = [{ messages: children, index: 0 }]
  const rows: ChatMessage[] = []
  const seen = new Set<string>()
  let examined = 0
  while (pending.length && examined++ < 10_000) {
    const frame = pending[pending.length - 1]
    if (frame.index >= frame.messages.length) {
      pending.pop()
      continue
    }
    const message = frame.messages[frame.index++]
    if (seen.has(message.id)) continue
    seen.add(message.id)
    rows.push(message)
    const nested = tree?.get(message.id) ?? []
    if (nested.length) pending.push({ messages: nested, index: 0 })
  }
  const document = createTableDocument({
    id: `legacy-descendants:${children[0]?.parentId ?? children[0]?.id ?? 'empty'}`,
    title: 'Captured nested agents',
    rows,
    columns: [{ key: 'agent', label: 'Agent / captured message' }],
    label: (value) => {
      const message = value as ChatMessage
      return `${message.agent?.agentName ?? 'Captured message'} · ${message.id}${message.userError ? ' · error captured' : ''}`
    },
  })
  document.notice = `Showing ${rows.length} captured descendant messages · no new inference or current-file reads`
  if (pending.length) {
    document.availability = 'limited'
    document.notice += ' · traversal limit reached'
  }
  return document
}

export function legacyAgentStateLabel(
  message: ChatMessage,
  running: boolean,
): string {
  if (running) return 'Running'
  if (typeof message.userError === 'string' && message.userError.trim()) return 'Error captured'
  const captured = message.agent as unknown as { status?: unknown } | undefined
  switch (captured?.status) {
    case 'complete':
      return 'Completed'
    case 'partial':
      return 'Partial'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    default:
      return 'State not captured'
  }
}
