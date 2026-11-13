import {
  NESTED_INSTRUCTION_FILES_TAG,
  instructionFileMarker,
  selectNestedInstructionFilesForPaths,
  toProjectRelativePath,
} from '@codebuff/common/util/instruction-files'
import { userMessage } from '@codebuff/common/util/messages'

import { withSystemTags } from './messages'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ProjectFileContext } from '@codebuff/common/util/file'

export { NESTED_INSTRUCTION_FILES_TAG }

const PATH_KEY = /(?:^|_)(?:path|paths|file|files|file_path|filepath|dir|directory|cwd|target)$/i
const MAX_TOUCHED_PATHS = 512

function collectPathStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 3 || out.length >= MAX_TOUCHED_PATHS) return
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathStrings(item, out, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    // Arrays of `{ path }` objects (for example edit batches).
    const record = value as Record<string, unknown>
    for (const [key, nested] of Object.entries(record)) {
      if (PATH_KEY.test(key)) collectPathStrings(nested, out, depth + 1)
    }
  }
}

/**
 * Project-relative paths named by tool calls in the transcript (read, edit,
 * list and search arguments whose key looks like a path). Bounded.
 */
export function collectTouchedPaths(
  messages: readonly Message[],
  projectRoot: string,
): string[] {
  const raw: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type !== 'tool-call') continue
      for (const [key, value] of Object.entries(part.input ?? {})) {
        if (PATH_KEY.test(key)) collectPathStrings(value, raw)
      }
      if (raw.length >= MAX_TOUCHED_PATHS) break
    }
  }
  const touched = new Set<string>()
  for (const candidate of raw) {
    const relative = toProjectRelativePath(projectRoot, candidate.trim())
    if (relative) touched.add(relative)
  }
  return [...touched]
}

const INJECTED_PATH = /<instruction_file path="([^"]+)">/g

function alreadyInjectedPaths(messages: readonly Message[]): Set<string> {
  const injected = new Set<string>()
  for (const message of messages) {
    if (!message.tags?.includes(NESTED_INSTRUCTION_FILES_TAG)) continue
    const parts = Array.isArray(message.content) ? message.content : []
    for (const part of parts) {
      if (part.type !== 'text') continue
      for (const match of part.text.matchAll(INJECTED_PATH)) {
        injected.add(match[1])
      }
    }
  }
  return injected
}

/**
 * Builds one message carrying the nested instruction files (and their
 * imports) that govern paths the agent has touched and that were not injected
 * yet. Returns undefined when there is nothing new. The message persists in
 * history, so each file is injected once; after a compaction removes it the
 * file returns only when the agent touches that directory again.
 */
export function buildNestedInstructionFilesMessage(params: {
  fileContext: ProjectFileContext
  messages: readonly Message[]
}): Message | undefined {
  const { fileContext, messages } = params
  const records = fileContext.instructionFiles
  if (!records?.some((record) => record.scope === 'nested')) return undefined
  const touched = collectTouchedPaths(messages, fileContext.projectRoot)
  if (touched.length === 0) return undefined
  const injected = alreadyInjectedPaths(messages)
  const pending = selectNestedInstructionFilesForPaths(fileContext, touched)
    .filter((key) => !injected.has(key))
    .filter((key) => (fileContext.knowledgeFiles[key] ?? '').trim())
  if (pending.length === 0) return undefined
  const blocks = pending.map(
    (key) =>
      `${instructionFileMarker(key)}\n${fileContext.knowledgeFiles[key].trim()}\n</instruction_file>`,
  )
  return userMessage({
    content: withSystemTags(
      [
        'Project instructions for the directories you are working in. Follow them for files under those directories.',
        ...blocks,
      ].join('\n\n'),
    ),
    tags: [NESTED_INSTRUCTION_FILES_TAG],
    keepDuringTruncation: true,
  })
}
