import { expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  retryPendingAttachment,
  addPendingImageWithError,
} from '../pending-attachments'
import { fitAttachmentName } from '../attachment-names'
import { useChatStore } from '../../state/chat-store'
import stringWidth from 'string-width'
import type { PendingFileAttachment } from '../../types/store'

test('file retry reads a fresh snapshot, while errors retain the previous capture and source metadata', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'openbuff-attachment-retry-'),
  )
  const filename = path.join(root, 'source.ts')
  const original: PendingFileAttachment = {
    kind: 'file',
    id: 'source',
    path: filename,
    sourcePath: filename,
    sourceRoot: root,
    filename: 'source.ts',
    isDirectory: false,
    content: 'original captured text',
    status: 'error',
  }
  try {
    fs.writeFileSync(filename, 'fresh source text')
    const fresh = await retryPendingAttachment(original, '/different-project')
    expect(fresh).toMatchObject({
      id: 'source',
      content: 'fresh source text',
      status: 'ready',
      sourceRoot: root,
    })
    fs.unlinkSync(filename)
    const failed = await retryPendingAttachment(original, root)
    expect(failed).toMatchObject({
      content: original.content,
      status: 'error',
      sourcePath: filename,
      sourceRoot: root,
    })
    expect(failed.kind !== 'text' && failed.note).toContain(
      'previous capture retained',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('image source failure remains explicit and abort never replaces retained bytes', async () => {
  const original = {
    kind: 'image' as const,
    id: 'image',
    path: 'clipboard:unavailable',
    filename: 'image.png',
    status: 'error' as const,
    processedImage: { base64: 'retained-bytes', mediaType: 'image/png' },
  }
  const failed = await retryPendingAttachment(original, '/tmp')
  expect(failed).toMatchObject({
    status: 'error',
    processedImage: original.processedImage,
  })
  const controller = new AbortController()
  controller.abort()
  await expect(
    retryPendingAttachment(original, '/tmp', controller.signal),
  ).rejects.toThrow()
  useChatStore.getState().clearPendingAttachments()
  addPendingImageWithError(
    '/tmp/unsupported.format',
    'Unsupported image format',
  )
  expect(useChatStore.getState().pendingAttachments[0]).toMatchObject({
    status: 'error',
    note: 'Unsupported image format',
  })
  useChatStore.getState().clearPendingAttachments()
})

test('attachment names fit terminal cells without breaking emoji or combining clusters', () => {
  for (const name of [
    'plain.long-extension-name',
    '文件文件文件.ts',
    '👩🏽‍💻👩🏽‍💻👩🏽‍💻.png',
    'éééééé.md',
  ]) {
    for (const width of [1, 8, 16]) {
      const shown = fitAttachmentName(name, width)
      expect(stringWidth(shown)).toBeLessThanOrEqual(width)
      if (stringWidth(name) > width) expect(shown).toContain('…')
      expect(shown).not.toContain('\ufffd')
    }
  }
})
