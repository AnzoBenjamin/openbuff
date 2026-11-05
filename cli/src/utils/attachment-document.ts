import { createTextDocument } from './output-document'
import {
  getFileAttachmentContextMetadata,
  getPendingAttachmentId,
} from './pending-attachments'
import type { PendingAttachment } from '../types/store'

export function createAttachmentDocument(attachment: PendingAttachment) {
  const id = getPendingAttachmentId(attachment)
  if (attachment.kind === 'text')
    return createTextDocument({
      id: `attachment:${id}`,
      title: 'Pasted text attachment',
      text: attachment.content,
    })
  const header = [
    `Attachment: ${attachment.filename}`,
    `Source: ${attachment.path}`,
    `Read source: ${attachment.sourcePath ?? attachment.path}`,
    `Source project: ${attachment.sourceRoot ?? 'not recorded'}`,
    `State: ${attachment.status}`,
    ...(attachment.note ? [`Note: ${attachment.note}`] : []),
  ]
  if (attachment.kind === 'file') {
    const metadata = getFileAttachmentContextMetadata(attachment)
    header.push(`Capture: ${metadata.completeness} · ${metadata.provenance}`)
    if (metadata.totalBytes !== undefined)
      header.push(
        `Bytes captured: ${metadata.bytesRead ?? 0}/${metadata.totalBytes}`,
      )
    if (metadata.totalEntries !== undefined)
      header.push(
        `Directory entries captured: ${metadata.entriesIncluded ?? 0}/${metadata.totalEntries}`,
      )
    return createTextDocument({
      id: `attachment:${id}`,
      title: attachment.filename,
      text: `${header.join('\n')}\n\n${attachment.content || 'No text content captured.'}`,
    })
  }
  header.push(
    `Image payload: ${attachment.processedImage ? (attachment.processedImage.base64 ? 'retained encoded data' : 'empty capture') : 'not captured'}`,
    `Dimensions: ${attachment.width ?? '?'} × ${attachment.height ?? '?'}`,
  )
  return createTextDocument({
    id: `attachment:${id}`,
    title: attachment.filename,
    text: header.join('\n'),
  })
}
