import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { FEEDBACK_CATEGORIES } from '@codebuff/common/constants/feedback'

import { getConfigDir } from './auth'

import type { FeedbackCategory } from '@codebuff/common/constants/feedback'
import type { FileHandle } from 'node:fs/promises'

export interface LocalFeedbackRecord {
  id: string
  createdAt: string
  category: FeedbackCategory
  text: string
  messageId?: string
}

export interface SaveLocalFeedbackInput {
  category: FeedbackCategory
  text: string
  messageId?: string
}

export interface LocalFeedbackStorageOptions {
  configDir?: string
  now?: Date
  id?: string
  cwd?: string
}

const FEEDBACK_FILE_NAME = 'feedback.jsonl'
const MAX_FEEDBACK_RECORD_BYTES = 20 * 1024
const MAX_FEEDBACK_STORE_BYTES = 10 * 1024 * 1024

function feedbackFilePath(configDir: string): string {
  return path.join(configDir, FEEDBACK_FILE_NAME)
}

function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return (
    typeof value === 'string' &&
    FEEDBACK_CATEGORIES.includes(value as FeedbackCategory)
  )
}

function isLocalFeedbackRecord(value: unknown): value is LocalFeedbackRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.createdAt === 'string' &&
    isFeedbackCategory(record.category) &&
    typeof record.text === 'string' &&
    (record.messageId === undefined || typeof record.messageId === 'string')
  )
}

async function appendPrivateFeedbackLine(
  filePath: string,
  line: string,
): Promise<void> {
  let existingBytes = 0
  try {
    const stat = await lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Local feedback file must be a regular file')
    }
    existingBytes = stat.size
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error
    }
  }

  const lineBytes = Buffer.byteLength(line)
  if (existingBytes + lineBytes > MAX_FEEDBACK_STORE_BYTES) {
    throw new Error('Local feedback store reached its 10 MiB size limit')
  }

  const flags =
    constants.O_WRONLY |
    constants.O_APPEND |
    constants.O_CREAT |
    (constants.O_NOFOLLOW ?? 0)
  const handle = await open(filePath, flags, 0o600)
  try {
    await handle.writeFile(line, 'utf8')
    await handle.chmod(0o600)
  } finally {
    await handle.close()
  }
}

export async function saveLocalFeedback(
  input: SaveLocalFeedbackInput,
  options: LocalFeedbackStorageOptions = {},
): Promise<{ record: LocalFeedbackRecord; filePath: string }> {
  const text = input.text.trim()
  if (!text) throw new Error('Feedback text cannot be empty')
  if (!isFeedbackCategory(input.category)) {
    throw new Error('Unknown local feedback category')
  }
  if (Buffer.byteLength(text) > MAX_FEEDBACK_RECORD_BYTES) {
    throw new Error('Feedback text exceeds the 20 KiB per-record limit')
  }

  const configDir = path.resolve(options.configDir ?? getConfigDir())
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  const filePath = feedbackFilePath(configDir)
  const record: LocalFeedbackRecord = {
    id: options.id ?? randomUUID(),
    createdAt: (options.now ?? new Date()).toISOString(),
    category: input.category,
    text,
    ...(input.messageId ? { messageId: input.messageId } : {}),
  }
  await appendPrivateFeedbackLine(filePath, `${JSON.stringify(record)}\n`)
  return { record, filePath }
}

export async function readLocalFeedback(
  configDir = getConfigDir(),
): Promise<LocalFeedbackRecord[]> {
  const filePath = feedbackFilePath(path.resolve(configDir))
  let handle: FileHandle
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    )
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return []
    }
    throw error
  }

  let content: string
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new Error('Local feedback file must be a regular file')
    }
    if (stat.size > MAX_FEEDBACK_STORE_BYTES) {
      throw new Error('Local feedback store exceeds its 10 MiB size limit')
    }
    content = await handle.readFile('utf8')
  } finally {
    await handle.close()
  }

  const records: LocalFeedbackRecord[] = []
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`Invalid local feedback record on line ${index + 1}`)
    }
    if (!isLocalFeedbackRecord(value)) {
      throw new Error(`Invalid local feedback record on line ${index + 1}`)
    }
    records.push(value)
  }
  return records
}

export async function exportLocalFeedback(
  destination: string,
  options: LocalFeedbackStorageOptions = {},
): Promise<string> {
  const configDir = path.resolve(options.configDir ?? getConfigDir())
  const sourcePath = feedbackFilePath(configDir)
  const records = await readLocalFeedback(configDir)
  if (records.length === 0)
    throw new Error('There are no local feedback records to export')

  const cwd = path.resolve(options.cwd ?? process.cwd())
  const outputPath = path.resolve(cwd, destination)
  if (outputPath === sourcePath) {
    throw new Error('Choose a different path from the local feedback store')
  }
  const content = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  await writeFile(outputPath, content, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  await chmod(outputPath, 0o600)
  return outputPath
}
