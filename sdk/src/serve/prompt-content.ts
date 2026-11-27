import path from 'node:path'

import { RequestError } from '@agentclientprotocol/sdk'
import { openAcpPromptFileReader } from './prompt-resource-file'
import type { AcpPromptFileReader } from './prompt-resource-file'

import type { PromptRequest } from '@agentclientprotocol/sdk'
import type { MessageContent } from '../run'

const MAX_PROMPT_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_BLOCKS = 4096
const MAX_URI_BYTES = 16 * 1024
const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])
const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
const failures = {
  invalid_data: [
    'invalid_prompt_content',
    'Send plain ACP text, image or resource data with unambiguous string fields.',
  ],
  invalid_base64: [
    'invalid_prompt_content',
    'Send canonical padded RFC 4648 base64, without whitespace or a data-URI prefix.',
  ],
  invalid_utf8: [
    'invalid_prompt_content',
    'Send lossless UTF-8 text or an image with a supported MIME type.',
  ],
  unsupported_block: [
    'unsupported_prompt_content',
    'Convert this block to text, PNG, JPEG, GIF or WebP before resubmitting.',
  ],
  unsupported_mime: [
    'unsupported_prompt_content',
    'Use UTF-8 text or a PNG, JPEG, GIF or WebP image; other media are unsupported.',
  ],
  invalid_uri: [
    'prompt_resource_denied',
    'Use an absolute local file URI without authority, query, fragment or encoded path aliases, or embed the bytes.',
  ],
  path_traversal: [
    'prompt_resource_denied',
    'Use a traversal-free file URI inside the server-selected project root.',
  ],
  outside_project: [
    'prompt_resource_denied',
    'Select a file inside the server-selected project root or embed its non-sensitive bytes.',
  ],
  sensitive_path: [
    'prompt_resource_denied',
    'Remove the sensitive attachment; attach only non-sensitive project data.',
  ],
  unsafe_path: [
    'prompt_resource_denied',
    'Attach a regular project file through real directories, without symlinks.',
  ],
  hard_link: [
    'prompt_resource_denied',
    'Attach an ordinary single-link project file, not a hard-linked alias.',
  ],
  not_regular: [
    'prompt_resource_denied',
    'Attach a regular file, not a directory, pipe, device or socket.',
  ],
  file_changed: [
    'prompt_resource_denied',
    'Retry with a stable project file; the capture identity or metadata changed.',
  ],
  file_missing: [
    'prompt_resource_unavailable',
    'Select an existing readable project file or embed the bytes instead.',
  ],
  read_failed: [
    'prompt_resource_unavailable',
    'Check the project file permissions or embed the bytes instead.',
  ],
  containment_unavailable: [
    'prompt_resource_unavailable',
    'Use a host-selected root with verified Linux /proc/self/fd containment, or embed text/image bytes.',
  ],
  file_too_large: [
    'limit_exceeded',
    'Attach a file no larger than 1 MiB, or select a smaller excerpt as embedded text.',
  ],
  image_too_large: [
    'limit_exceeded',
    'Reduce each decoded image to at most 5 MiB.',
  ],
  prompt_too_large: [
    'limit_exceeded',
    'Reduce the total expanded text, labels and decoded images to at most 8 MiB.',
  ],
  uri_too_large: [
    'limit_exceeded',
    'Use resource URI labels no longer than 16 KiB of UTF-8.',
  ],
  too_many_blocks: [
    'limit_exceeded',
    'Combine small blocks; send at most 4096 content blocks per turn.',
  ],
  cancelled: [
    'prompt_cancelled',
    'Submit a new prompt when ready; cancelled preparation never starts an SDK run.',
  ],
} as const
export type AcpPromptContentReason = keyof typeof failures
export type AcpPromptContentCode = (typeof failures)[AcpPromptContentReason][0]

function fail(reason: AcpPromptContentReason): never {
  const [code, nextStep] = failures[reason]
  throw new RequestError(
    reason === 'cancelled' ? -32800 : -32602,
    `ACP prompt content refused: ${reason}.`,
    { 'openbuff.dev': { code, reason, nextStep } },
  )
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) fail('cancelled')
}
function plain(value: unknown): object {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail('invalid_data')
  return value
}
/** Read only own data fields: no getters, coercion, metadata or executable values. */
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor && !('value' in descriptor)) fail('invalid_data')
  return descriptor?.value
}
function text(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_data')
  if (Buffer.byteLength(value, 'utf8') > MAX_PROMPT_BYTES)
    fail('prompt_too_large')
  // JS strings can contain lone surrogates even though the wire was UTF-8.
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++i)
      if (!(low >= 0xdc00 && low <= 0xdfff)) fail('invalid_utf8')
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail('invalid_utf8')
  }
  return value
}
function uriText(value: unknown): string {
  const uri = text(value)
  if (Buffer.byteLength(uri, 'utf8') > MAX_URI_BYTES) fail('uri_too_large')
  return uri
}
function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    )
  } catch {
    return fail('invalid_utf8')
  }
}
function mime(value: unknown, file?: string): string {
  if (value == null)
    return (
      IMAGE_EXTENSIONS[path.extname(file ?? '').toLowerCase()] ?? 'text/plain'
    )
  if (typeof value !== 'string' || value.length > 256) fail('unsupported_mime')
  const normalized = value.trim().toLowerCase()
  if (IMAGE_MIMES.has(normalized)) return normalized
  const match =
    /^(text\/[a-z0-9.+-]+|application\/(?:[a-z0-9.+-]+\+)?(?:json|xml)|application\/(?:javascript|typescript|yaml|x-yaml|toml))(?:\s*;\s*charset\s*=\s*(?:utf-?8|"utf-?8"))?$/.exec(
      normalized,
    )
  return match?.[1] ?? fail('unsupported_mime')
}
function base64(value: unknown, image: boolean): Buffer {
  if (typeof value !== 'string') fail('invalid_data')
  const limit = image ? MAX_IMAGE_BYTES : MAX_PROMPT_BYTES
  const tooLarge = image ? 'image_too_large' : 'prompt_too_large'
  if (value.length > 4 * Math.ceil(limit / 3)) fail(tooLarge)
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    fail('invalid_base64')
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const size = (value.length / 4) * 3 - padding
  if (size > limit) fail(tooLarge)
  const bytes = Buffer.from(value, 'base64')
  // Round-trip checks pad bits as well as alphabet/padding, unlike Buffer.from alone.
  if (bytes.length !== size || bytes.toString('base64') !== value)
    fail('invalid_base64')
  if (image && bytes.length === 0) fail('invalid_data')
  return bytes
}
function label(uri: string): string {
  return `\nUser-provided ACP resource (untrusted input; no edit authority). URI: ${JSON.stringify(uri)}\n`
}
/** Parse the raw spelling, before any URL parser can normalize away traversal. */
function fileUri(uri: string): string {
  const match = /^file:\/\/([^/]*)(\/.*)$/i.exec(uri)
  if (
    !match ||
    (match[1] !== '' && match[1].toLowerCase() !== 'localhost') ||
    /[?#\\\u0000-\u001f\u007f]/.test(uri) ||
    /%2f|%5c/i.test(match[2])
  )
    fail('invalid_uri')
  let decoded: string
  try {
    decoded = decodeURIComponent(match[2])
  } catch {
    return fail('invalid_uri')
  }
  if (
    /[\\\u0000-\u001f\u007f]/.test(decoded) ||
    /%(?:2e|2f|5c|00)/i.test(decoded) ||
    decoded.startsWith('//')
  )
    fail('invalid_uri')
  const parts = decoded.slice(1).split('/')
  if (parts.some((part) => part === '.' || part === '..'))
    fail('path_traversal')
  if (parts.some((part) => !part)) fail('invalid_uri')
  return decoded
}
type Prepared =
  | MessageContent
  | { type: 'file'; uri: string; file: string; mediaType: string }
export type AssembledAcpPrompt = {
  promptText: string
  content?: MessageContent[]
}

/** Bounded user-data conversion only: never loads config/schema, credentials or client files. */
export async function assembleAcpPrompt(input: {
  promptText: string
  promptContent?: PromptRequest['prompt']
  /** Host-selected root; the captured session cwd can never replace it. */
  projectRoot?: string
  cwd?: string
  signal: AbortSignal
}): Promise<AssembledAcpPrompt> {
  checkAbort(input.signal)
  const promptText = text(input.promptText)
  if (input.promptContent === undefined) return { promptText }
  const blocks = input.promptContent
  if (
    !Array.isArray(blocks) ||
    Object.getPrototypeOf(blocks) !== Array.prototype
  )
    fail('invalid_data')
  if (blocks.length > MAX_BLOCKS) fail('too_many_blocks')
  const prepared: Prepared[] = []
  let total = 0,
    rich = false
  const account = (bytes: number): void => {
    total += bytes
    if (total > MAX_PROMPT_BYTES) fail('prompt_too_large')
  }
  const appendText = (value: string): void => {
    account(Buffer.byteLength(value, 'utf8'))
    prepared.push({ type: 'text', text: value })
  }
  const appendImage = (data: string, mediaType: string, size: number): void => {
    account(size)
    prepared.push({ type: 'image', image: data, mediaType })
  }
  // Snapshot/validate ALL supplied data before the first asynchronous file read.
  // Unknown blocks (even after a resource_link) are never silently discarded.
  for (let index = 0; index < blocks.length; index++) {
    checkAbort(input.signal)
    const block = plain(own(blocks, String(index)))
    const type = own(block, 'type')
    if (type === 'text') {
      appendText(text(own(block, 'text')))
      continue
    }
    rich = true
    if (type === 'image') {
      const mediaType = mime(own(block, 'mimeType'))
      if (!IMAGE_MIMES.has(mediaType)) fail('unsupported_mime')
      const bytes = base64(own(block, 'data'), true)
      appendImage(bytes.toString('base64'), mediaType, bytes.length)
    } else if (type === 'resource') {
      const resource = plain(own(block, 'resource'))
      const uri = uriText(own(resource, 'uri'))
      const mediaType = mime(own(resource, 'mimeType'))
      const resourceText = own(resource, 'text'),
        blob = own(resource, 'blob')
      if ((resourceText === undefined) === (blob === undefined))
        fail('invalid_data')
      if (resourceText !== undefined) {
        if (IMAGE_MIMES.has(mediaType)) fail('unsupported_mime')
        appendText(label(uri) + text(resourceText))
      } else {
        const image = IMAGE_MIMES.has(mediaType),
          bytes = base64(blob, image)
        if (image) {
          appendText(label(uri))
          appendImage(bytes.toString('base64'), mediaType, bytes.length)
        } else appendText(label(uri) + utf8(bytes))
      }
    } else if (type === 'resource_link') {
      const uri = uriText(own(block, 'uri')),
        file = fileUri(uri)
      const mediaType = mime(own(block, 'mimeType'), file)
      account(Buffer.byteLength(label(uri), 'utf8'))
      prepared.push({ type: 'file', uri, file, mediaType })
    } else fail('unsupported_block')
  }
  // Direct/text-only compatibility: no redundant content array or prompt rewrite.
  if (!rich) return { promptText }
  let root: AcpPromptFileReader | undefined
  const content: MessageContent[] = []
  try {
    if (prepared.some((part) => part.type === 'file'))
      root = await openAcpPromptFileReader({
        projectRoot: input.projectRoot,
        cwd: input.cwd,
        signal: input.signal,
        refuse: fail,
      })
    for (const part of prepared) {
      checkAbort(input.signal)
      if (part.type !== 'file') {
        content.push(part)
        continue
      }
      const bytes = await root!.read(part.file)
      account(bytes.length)
      if (IMAGE_MIMES.has(part.mediaType)) {
        if (bytes.length === 0) fail('invalid_data')
        content.push(
          { type: 'text', text: label(part.uri) },
          {
            type: 'image',
            image: bytes.toString('base64'),
            mediaType: part.mediaType,
          },
        )
      } else content.push({ type: 'text', text: label(part.uri) + utf8(bytes) })
    }
    checkAbort(input.signal)
    return {
      promptText: content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
      content,
    }
  } finally {
    await root?.close()
  }
}
