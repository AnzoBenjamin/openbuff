import { existsSync, promises as fs, statSync } from 'node:fs'
import path from 'node:path'

import { resolveProjectPath } from '@codebuff/common/util/project-path-containment'
import { isMandatorySensitiveReadPath } from '@codebuff/common/util/sensitive-paths'

import { processImageFile, resolveFilePath, isImageFile } from './image-handler'
import { useChatStore } from '../state/chat-store'
import type { ImageUploadResult } from './image-handler'
import type { FileAttachment } from '../types/chat'
import type {
  PendingAttachment,
  PendingFileAttachment,
  PendingImageAttachment,
} from '../types/store'

/**
 * Exit image input mode if currently active.
 * Called after successfully adding an image via paste or path.
 */
function exitImageModeIfActive(): void {
  if (useChatStore.getState().inputMode === 'image') {
    useChatStore.getState().setInputMode('default')
  }
}

/**
 * Process an image file and add it to the pending images state.
 * This handles compression/resizing and caches the result so we don't
 * need to reprocess at send time.
 *
 * @param replacePlaceholder - If provided, replaces an existing placeholder entry instead of adding new
 */
export async function addPendingImageFromFile(
  imagePath: string,
  cwd: string,
  replacePlaceholder?: string,
): Promise<{ success: boolean; error?: string }> {
  const filename = path.basename(imagePath)
  const id = crypto.randomUUID()

  if (replacePlaceholder) {
    // Replace existing placeholder with actual image info (still processing)
    useChatStore.setState((state) => ({
      pendingAttachments: state.pendingAttachments.map((att) =>
        att.kind === 'image' && att.path === replacePlaceholder
          ? {
              ...att,
              id,
              path: imagePath,
              filename,
              sourcePath: imagePath,
              sourceRoot: cwd,
            }
          : att,
      ),
    }))
  } else {
    const nextImage: PendingImageAttachment = {
      kind: 'image',
      id,
      path: imagePath,
      sourcePath: imagePath,
      sourceRoot: cwd,
      filename,
      status: 'processing',
    }
    useChatStore.setState((state) => ({
      pendingAttachments: state.pendingAttachments.some(
        (attachment) =>
          attachment.kind === 'image' && attachment.path === imagePath,
      )
        ? state.pendingAttachments.map((attachment) =>
            attachment.kind === 'image' && attachment.path === imagePath
              ? { ...attachment, ...nextImage }
              : attachment,
          )
        : [...state.pendingAttachments, nextImage],
    }))
  }

  // Process the image in background
  const result = await processImageFile(imagePath, cwd).catch(
    (error): ImageUploadResult => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  if (
    !useChatStore
      .getState()
      .pendingAttachments.some(
        (attachment) => attachment.kind === 'image' && attachment.id === id,
      )
  ) {
    return {
      success: false,
      error: 'Image attachment was removed or replaced while processing',
    }
  }

  // Update the pending image with processed data
  useChatStore.setState((state) => ({
    pendingAttachments: state.pendingAttachments.map((att) => {
      if (att.kind !== 'image' || att.id !== id) return att

      if (result.success && result.imagePart) {
        return {
          ...att,
          status: 'ready' as const,
          size: result.imagePart.size,
          width: result.imagePart.width,
          height: result.imagePart.height,
          note: result.wasCompressed ? 'compressed' : undefined,
          processedImage: {
            base64: result.imagePart.image,
            mediaType: result.imagePart.mediaType,
          },
        }
      }

      return {
        ...att,
        status: 'error' as const,
        note: result.error || 'failed',
      }
    }),
  }))

  // Exit image mode after successfully processing an image
  if (result.success) {
    exitImageModeIfActive()
  }
  return result.success
    ? { success: true }
    : { success: false, error: result.error ?? 'Failed to process image' }
}

/**
 * Process an image from base64 data and add it to the pending images state.
 */
export async function addPendingImageFromBase64(
  base64Data: string,
  mediaType: string,
  filename: string,
  tempPath?: string,
): Promise<void> {
  // For base64 images (like clipboard), we already have the data
  // Check size and add directly
  const size = Math.round((base64Data.length * 3) / 4) // Approximate decoded size

  useChatStore.getState().addPendingImage({
    id: crypto.randomUUID(),
    path: tempPath || `clipboard:${filename}`,
    filename,
    status: 'ready',
    size,
    processedImage: {
      base64: base64Data,
      mediaType,
    },
  })
}

// Counter for generating unique placeholder IDs
let clipboardPlaceholderCounter = 0

/**
 * Add a placeholder for a clipboard image immediately and return its path.
 * Use with addPendingImageFromFile's replacePlaceholder parameter.
 */
export function addClipboardPlaceholder(): string {
  const placeholderPath = `clipboard:pending-${++clipboardPlaceholderCounter}`
  useChatStore.getState().addPendingImage({
    id: crypto.randomUUID(),
    path: placeholderPath,
    filename: 'clipboard image',
    status: 'processing',
  })
  return placeholderPath
}

/**
 * Add a pending image with an error note (e.g., unsupported format, not found).
 * Used when we want to show the image in the banner with an error state.
 * Errors remain visible until the user removes or retries the attachment.
 */
export function addPendingImageWithError(
  imagePath: string,
  note: string,
): void {
  const filename = path.basename(imagePath)
  useChatStore.getState().addPendingImage({
    id: crypto.randomUUID(),
    path: imagePath,
    sourcePath: imagePath,
    filename,
    status: 'error',
    note,
  })
}

/**
 * Clear the auto-remove timer for an error image.
 * Call this when manually removing an image to prevent memory leaks.
 */
export function clearErrorImageTimer(_imagePath: string): void {
  // Kept for existing callers; errors now remain until explicit removal.
}

/**
 * Validate and add an image from a file path.
 * Returns { success: true } if the image was added for processing,
 * or { success: false, error } if the file doesn't exist or isn't supported.
 */
export async function validateAndAddImage(
  imagePath: string,
  cwd: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const resolvedPath = resolveFilePath(imagePath, cwd)

  // Check if file exists
  if (!existsSync(resolvedPath)) {
    const error = 'file not found'
    addPendingImageWithError(resolvedPath, `❌ ${error}`)
    return { success: false, error }
  }

  // Check if it's a supported format
  if (!isImageFile(resolvedPath)) {
    const ext = path.extname(imagePath).toLowerCase()
    const error = ext ? `unsupported format ${ext}` : 'unsupported format'
    addPendingImageWithError(resolvedPath, `❌ ${error}`)
    return { success: false, error }
  }

  // Process and add the image (addPendingImageFromFile handles exiting image mode on success)
  const processed = await addPendingImageFromFile(resolvedPath, cwd)
  return processed.success
    ? { success: true }
    : { success: false, error: processed.error ?? 'Failed to process image' }
}

// ---------------------------------------------------------------------------
// File / folder attachments
// ---------------------------------------------------------------------------

const MAX_FILE_READ_SIZE = 1024 * 1024 // 1 MB – don't read files larger than this
const MAX_CONTENT_CHARS = 100 * 1024 // 100 KB of text content
const MAX_DIR_ENTRIES = 100

export type FileAttachmentCompleteness =
  | 'full'
  | 'truncated'
  | 'metadata-only'
  | 'shallow-directory'

export type FileAttachmentProvenance = 'attachment' | '@file selection'

type FileAttachmentContextMetadata = {
  completeness?: FileAttachmentCompleteness
  provenance?: FileAttachmentProvenance
  bytesRead?: number
  totalBytes?: number
  entriesIncluded?: number
  totalEntries?: number
}

export function getFileAttachmentContextMetadata(
  attachment: PendingFileAttachment | FileAttachment,
): Required<
  Pick<FileAttachmentContextMetadata, 'completeness' | 'provenance'>
> &
  Omit<FileAttachmentContextMetadata, 'completeness' | 'provenance'> {
  const metadata = attachment as typeof attachment &
    FileAttachmentContextMetadata
  const note = attachment.note?.toLowerCase() ?? ''
  const inferredCompleteness: FileAttachmentCompleteness = note.includes(
    'metadata only',
  )
    ? 'metadata-only'
    : note.includes('truncated')
      ? 'truncated'
      : note.includes('shallow')
        ? 'shallow-directory'
        : attachment.isDirectory
          ? 'shallow-directory'
          : 'full'
  return {
    completeness: metadata.completeness ?? inferredCompleteness,
    provenance:
      metadata.provenance ??
      (note.startsWith('@file') ? '@file selection' : 'attachment'),
    bytesRead: metadata.bytesRead,
    totalBytes: metadata.totalBytes,
    entriesIncluded: metadata.entriesIncluded,
    totalEntries: metadata.totalEntries,
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1)} MB`
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sampleSize = Math.min(buffer.length, 8192)
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

export async function loadFileAttachmentContent(
  filePath: string,
  isDirectory: boolean,
  provenance: FileAttachmentProvenance = 'attachment',
): Promise<
  Pick<PendingFileAttachment, 'content' | 'status' | 'note'> &
    FileAttachmentContextMetadata
> {
  let content: string
  let note: string
  let contextMetadata: FileAttachmentContextMetadata

  if (isDirectory) {
    const entries = await fs.readdir(filePath, { withFileTypes: true })
    const count = entries.length
    const included = Math.min(count, MAX_DIR_ENTRIES)
    note = `shallow · ${included}/${count} item${count !== 1 ? 's' : ''}`
    contextMetadata = {
      completeness: 'shallow-directory',
      provenance,
      entriesIncluded: included,
      totalEntries: count,
    }

    if (count === 0) {
      content = '(empty directory)'
    } else {
      // Sort: directories first, then files, alphabetically within each group
      const sorted = [...entries].sort((a, b) => {
        const aIsDir = a.isDirectory()
        const bIsDir = b.isDirectory()
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      const listing = sorted
        .slice(0, MAX_DIR_ENTRIES)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join('\n')
      content = listing
      if (count > MAX_DIR_ENTRIES) {
        content += `\n… and ${count - MAX_DIR_ENTRIES} more`
      }
    }
  } else {
    const stats = await fs.stat(filePath)

    if (stats.size === 0) {
      content = '(empty file)'
      note = 'full · 0 B'
      contextMetadata = {
        completeness: 'full',
        provenance,
        bytesRead: 0,
        totalBytes: 0,
      }
    } else if (stats.size > MAX_FILE_READ_SIZE) {
      content = `(file too large to preview: ${formatFileSize(stats.size)})`
      note = `metadata only · ${formatFileSize(stats.size)}`
      contextMetadata = {
        completeness: 'metadata-only',
        provenance,
        bytesRead: 0,
        totalBytes: stats.size,
      }
    } else {
      const buffer = await fs.readFile(filePath)
      if (isBinaryBuffer(buffer)) {
        content = '(binary file)'
        note = `metadata only · ${formatFileSize(stats.size)} · binary`
        contextMetadata = {
          completeness: 'metadata-only',
          provenance,
          bytesRead: 0,
          totalBytes: stats.size,
        }
      } else {
        const text = buffer.toString('utf-8')
        if (text.length > MAX_CONTENT_CHARS) {
          content = text.slice(0, MAX_CONTENT_CHARS) + '\n… (truncated)'
          note = `truncated · first ${formatFileSize(MAX_CONTENT_CHARS)} of ${formatFileSize(stats.size)}`
          contextMetadata = {
            completeness: 'truncated',
            provenance,
            bytesRead: Buffer.byteLength(text.slice(0, MAX_CONTENT_CHARS)),
            totalBytes: stats.size,
          }
        } else {
          content = text
          note = `full · ${formatFileSize(stats.size)}`
          contextMetadata = {
            completeness: 'full',
            provenance,
            bytesRead: stats.size,
            totalBytes: stats.size,
          }
        }
      }
    }
  }

  return {
    ...contextMetadata,
    content,
    status: 'ready',
    note: provenance === '@file selection' ? `@file · ${note}` : note,
  }
}

/**
 * Add a file or folder as a pending attachment.
 * Reads the content in the background and updates the store.
 */
export function addPendingFileFromPath(
  filePath: string,
  isDirectory: boolean,
  options: {
    displayPath?: string
    provenance?: FileAttachmentProvenance
    sourceRoot?: string
  } = {},
): void {
  const displayPath = options.displayPath ?? filePath
  const provenance = options.provenance ?? 'attachment'
  const alreadyPending = useChatStore
    .getState()
    .pendingAttachments.some(
      (attachment) =>
        attachment.kind === 'file' && attachment.path === displayPath,
    )
  if (alreadyPending) return

  if (
    isMandatorySensitiveReadPath(displayPath) ||
    isMandatorySensitiveReadPath(filePath)
  ) {
    const blockedAttachment: Omit<PendingFileAttachment, 'kind'> &
      FileAttachmentContextMetadata = {
      id: crypto.randomUUID(),
      path: displayPath,
      filename: path.basename(displayPath) || displayPath,
      isDirectory,
      content: '',
      status: 'error',
      note: 'Blocked by mandatory sensitive-file policy',
      completeness: isDirectory ? 'shallow-directory' : 'metadata-only',
      provenance,
    }
    useChatStore.getState().addPendingFileAttachment(blockedAttachment)
    return
  }

  const id = crypto.randomUUID()
  const filename = path.basename(displayPath) || displayPath
  const initialAttachment: Omit<PendingFileAttachment, 'kind'> &
    FileAttachmentContextMetadata = {
    id,
    path: displayPath,
    sourcePath: filePath,
    sourceRoot: options.sourceRoot,
    filename,
    isDirectory,
    content: '',
    status: 'processing',
    completeness: isDirectory ? 'shallow-directory' : 'full',
    provenance,
  }

  useChatStore.getState().addPendingFileAttachment(initialAttachment)

  // Use promise-based filesystem APIs so large directories and files do not
  // block the OpenTUI renderer thread.
  setTimeout(async () => {
    try {
      const loaded = await loadFileAttachmentContent(
        filePath,
        isDirectory,
        provenance,
      )
      useChatStore.setState((state) => ({
        pendingAttachments: state.pendingAttachments.map((att) => {
          if (att.kind !== 'file' || att.id !== id) return att
          return {
            ...att,
            ...loaded,
          }
        }),
      }))
    } catch (error) {
      useChatStore.setState((state) => ({
        pendingAttachments: state.pendingAttachments.map((att) => {
          if (att.kind !== 'file' || att.id !== id) return att
          return {
            ...att,
            status: 'error' as const,
            note: `Failed to read: ${error instanceof Error ? error.message : String(error)}`,
          }
        }),
      }))
    }
  }, 0)
}

/** Resolve a file-menu selection inside the project and attach its current
 * contents with explicit provenance. This turns `@file` selection into a
 * guaranteed context operation instead of relying on the model to notice text. */
export function addPendingFileMention(
  projectRelativePath: string,
  isDirectory: boolean,
  projectRoot: string,
): void {
  const resolved = resolveProjectPath(projectRoot, projectRelativePath)
  if (!resolved) {
    const id = crypto.randomUUID()
    const failedAttachment: Omit<PendingFileAttachment, 'kind'> &
      FileAttachmentContextMetadata = {
      id,
      path: projectRelativePath,
      filename: path.basename(projectRelativePath) || projectRelativePath,
      isDirectory,
      content: '',
      status: 'error',
      note: 'Failed to resolve inside project',
      completeness: isDirectory ? 'shallow-directory' : 'metadata-only',
      provenance: '@file selection',
    }
    useChatStore.getState().addPendingFileAttachment(failedAttachment)
    return
  }

  addPendingFileFromPath(resolved.realFullPath, isDirectory, {
    displayPath: resolved.relativePath,
    provenance: '@file selection',
    sourceRoot: projectRoot,
  })
}

/**
 * Check if any pending images are still processing.
 */
export function hasProcessingImages(): boolean {
  return useChatStore
    .getState()
    .pendingAttachments.some(
      (att) => att.kind === 'image' && att.status === 'processing',
    )
}

/**
 * Check if any pending file attachments are still processing.
 */
export function hasProcessingFiles(): boolean {
  return useChatStore
    .getState()
    .pendingAttachments.some(
      (att) => att.kind === 'file' && att.status === 'processing',
    )
}

/**
 * Capture and clear all pending attachments so they can be passed to the queue
 * without duplicating state handling logic in multiple callers.
 */
export function capturePendingAttachments(): PendingAttachment[] {
  const pendingAttachments = [...useChatStore.getState().pendingAttachments]
  if (pendingAttachments.length > 0) {
    useChatStore.getState().clearPendingAttachments()
  }
  return pendingAttachments
}

/** Stable IDs are additive; old image captures retain their path identity. */
export function getPendingAttachmentId(attachment: PendingAttachment): string {
  return attachment.kind === 'image'
    ? (attachment.id ?? attachment.path)
    : attachment.id
}

/** Retry reads a fresh source snapshot; failures preserve previously captured content. */
export async function retryPendingAttachment(
  attachment: PendingAttachment,
  cwd: string,
  signal?: AbortSignal,
  dependencies = { image: processImageFile, file: loadFileAttachmentContent },
): Promise<PendingAttachment> {
  if (attachment.kind === 'text') return attachment
  signal?.throwIfAborted()
  const sourcePath = attachment.sourcePath ?? attachment.path
  const sourceRoot = attachment.sourceRoot ?? cwd
  try {
    if (sourcePath.startsWith('clipboard:'))
      throw new Error(
        'Clipboard source is no longer available. Remove this item and attach the image again.',
      )
    const resolved = resolveFilePath(sourcePath, sourceRoot)
    if (
      isMandatorySensitiveReadPath(sourcePath) ||
      isMandatorySensitiveReadPath(resolved)
    )
      throw new Error('Blocked by mandatory sensitive-file policy')
    if (attachment.kind === 'file') {
      const metadata = getFileAttachmentContextMetadata(attachment)
      if (metadata.provenance === '@file selection') {
        const selected = resolveProjectPath(sourceRoot, sourcePath)
        if (!selected)
          throw new Error('Failed to resolve inside the original project')
      }
      const loaded = await dependencies.file(
        resolved,
        attachment.isDirectory,
        metadata.provenance,
      )
      signal?.throwIfAborted()
      return { ...attachment, ...loaded, sourcePath: resolved, sourceRoot }
    }
    const result = await dependencies.image(resolved, sourceRoot)
    signal?.throwIfAborted()
    if (!result.success || !result.imagePart)
      throw new Error(result.error ?? 'Failed to process image')
    return {
      ...attachment,
      status: 'ready',
      note: result.wasCompressed ? 'compressed' : undefined,
      sourcePath: resolved,
      sourceRoot,
      size: result.imagePart.size,
      width: result.imagePart.width,
      height: result.imagePart.height,
      processedImage: {
        base64: result.imagePart.image,
        mediaType: result.imagePart.mediaType,
      },
    }
  } catch (error) {
    signal?.throwIfAborted()
    return {
      ...attachment,
      status: 'error',
      note: `Retry failed: ${error instanceof Error ? error.message : String(error)} · previous capture retained`,
    }
  }
}
