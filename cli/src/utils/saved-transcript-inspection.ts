import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getProjectDataDir } from '../project-files'
import { validatePersistedMessages } from './run-state-storage'
import { createJsonDocument, createTableDocument, createTextDocument, type OutputDocument } from './output-document'
import { sliceTextCells } from './text-boundaries'

const INSPECTION_BYTES = 8 * 1024 * 1024

/** Display-only recovery. Its rows are never returned as restorable messages. */
export function savedTranscriptInspection(
  id: string,
  value: unknown,
  source: string,
  version?: string,
): OutputDocument {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).messages)
      ? (value as { messages: unknown[] }).messages
      : null
  if (!rows) {
    const document = createJsonDocument(id, 'Saved session details', value)
    document.availability = 'limited'
    document.notice = 'Inspection only · cannot resume · saved transcript shape unavailable · original capture preserved'
    document.provenance = { source: 'saved-artifact', identity: source, version, freshness: 'unverified', exact: true }
    return document
  }
  const document = createTableDocument({
    id, title: 'Saved session details', rows,
    columns: [{ key: 'message', label: 'Captured message / availability' }],
    label: (value, index) => {
      const message = value && typeof value === 'object' ? value as Record<string, unknown> : undefined
      const valid = validatePersistedMessages([value]) !== null
      const fullIdentity = typeof message?.id === 'string' ? message.id : `message ${index + 1}`
      const identity = sliceTextCells(fullIdentity, 0, 40)
      const content = typeof message?.content === 'string'
        ? message.content
        : ''
      if (!valid) return `${index + 1} · unavailable message · ${identity} · ${content ? sliceTextCells(content.replace(/\s+/g, ' ').trim(), 0, 120) : 'Inspect retained raw fields'}`
      return `${index + 1} · ${String(message?.variant)} · ${identity} · ${sliceTextCells(content.replace(/\s+/g, ' ').trim(), 0, 120)}`
    },
  })
  document.availability = 'limited'
  document.notice = 'Inspection only · cannot resume or edit · message previews; inspect a row for retained fields'
  document.provenance = { source: 'saved-artifact', identity: source, version, freshness: 'unverified', exact: true }
  return document
}

/** Read a saved UI capture without loading SDK state, quarantining or rewriting it. */
export async function readSavedTranscriptInspection(
  chatId: string,
  metadata: string,
  signal?: AbortSignal,
): Promise<OutputDocument> {
  const id = `saved-inspection:${chatId}`
  if (!chatId || chatId === '.' || chatId === '..' || path.basename(chatId) !== chatId)
    throw new Error('Invalid saved session identifier')
  const source = path.join(getProjectDataDir(), 'chats', chatId, 'chat-messages.json')
  const chunks: Buffer[] = []
  let bytes = 0
  let limited = false
  const stream = fs.createReadStream(source, { signal, highWaterMark: 64 * 1024 })
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer
      const remaining = INSPECTION_BYTES - bytes
      if (buffer.length > remaining) {
        if (remaining) chunks.push(buffer.subarray(0, remaining))
        bytes = INSPECTION_BYTES
        limited = true
        break
      }
      chunks.push(buffer)
      bytes += buffer.length
    }
    const captured = Buffer.concat(chunks)
    const raw = captured.toString('utf8')
    if (!limited) {
      try {
        return savedTranscriptInspection(id, JSON.parse(raw), source, createHash('sha256').update(captured).digest('hex'))
      } catch {
        // An invalid JSON capture remains readable as text, never resumable data.
      }
    }
    return createTextDocument({
      id, title: 'Saved session details', text: `${metadata}\n\n${raw}`,
      availability: 'limited',
      notice: limited ? 'Inspection only · first 8 MiB captured; original file preserved' : 'Inspection only · invalid JSON; original file preserved',
      provenance: { source: 'saved-artifact', identity: source, freshness: 'unverified', exact: !limited },
    })
  } catch (error) {
    if (signal?.aborted) throw error
    return createTextDocument({
      id, title: 'Saved session details', text: metadata,
      availability: 'unavailable', notice: 'Saved transcript could not be read · metadata only · original file unchanged',
      provenance: { source: 'saved-artifact', identity: source, freshness: 'unverified', exact: false },
    })
  } finally {
    stream.destroy()
  }
}
