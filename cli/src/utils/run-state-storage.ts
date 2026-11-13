import * as fs from 'fs'
import { readdir, unlink } from 'fs/promises'
import path from 'path'

import {
  getCurrentChatDir,
  getMostRecentChatDir,
  getProjectDataDir,
  getProjectRoot,
} from '../project-files'
import { getMemoryAuthoritySelection } from './env'
import {
  atomicWriteJsonFile,
  cancelAndDrainPendingWriteFor,
  schedulePersistenceWrite,
} from './persistence-queue'
import { logger } from './logger'
import { sanitizeForChatPersistence } from './payload-sanitizer'
import { runPersistenceCodec } from './persistence-codec'

import type { ChatMessage, ContentBlock } from '../types/chat'
import type { RunState } from '@openbuff/sdk'
import type {
  AgentState,
  SessionState,
} from '@codebuff/common/types/session-state'
import { flushContextArchiveSnapshots } from '../services/memory-v2/context-archive-sync'

const RUN_STATE_FILENAME = 'run-state.json'
const CHAT_MESSAGES_FILENAME = 'chat-messages.json'
const CHAT_STATE_FILENAME = 'chat-state.json'
const CHECKPOINT_FILENAME = 'turn-checkpoint.json'

/**
 * A checkpoint temp file younger than this is never swept even when its
 * owning pid cannot be verified: the window comfortably exceeds any
 * write-then-rename interval, so a live sibling session's pre-rename temp
 * file is never deleted.
 */
const STALE_TEMP_FILE_SWEEP_MIN_AGE_MS = 5 * 60_000

/**
 * True when `pid` refers to a live process. `kill(pid, 0)` signals nothing;
 * EPERM means the process exists but is owned by another user, which must
 * still be treated as alive — never sweep a tmp file we cannot prove is
 * orphaned (reliability finding checkpoint-sweep-cross-pid-race).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

type SavedChatState = {
  runState: RunState
  messages: ChatMessage[]
  chatId?: string
}

type PersistedChatState = {
  version: 1
  runState: RunState
  messages: ChatMessage[]
}

// P6.5: Minimal shape guard for legacy session files. Deliberately loose — we
// only need the fields the restore path reads — so older-but-valid sessions
// keep loading unchanged; anything that fails is treated as a corrupt session
// and the caller starts fresh instead of rendering broken messages.
export const validatePersistedMessages = (
  messages: unknown,
): ChatMessage[] | null => {
  if (!Array.isArray(messages)) return null
  const validBlocks = (blocks: unknown, depth = 0): boolean => {
    if (!Array.isArray(blocks) || depth > 64) return false
    return blocks.every((block) => {
      if (
        !block ||
        typeof block !== 'object' ||
        Array.isArray(block) ||
        typeof block.type !== 'string'
      )
        return false
      if (block.blocks !== undefined && !validBlocks(block.blocks, depth + 1))
        return false
      if (block.content !== undefined && typeof block.content !== 'string')
        return false
      if (block.output !== undefined && typeof block.output !== 'string')
        return false
      if (block.type === 'text') return typeof block.content === 'string'
      if (block.type === 'tool')
        return (
          typeof block.toolName === 'string' &&
          typeof block.toolCallId === 'string'
        )
      if (block.type === 'agent')
        return (
          typeof block.agentId === 'string' &&
          typeof block.agentName === 'string' &&
          typeof block.agentType === 'string' &&
          typeof block.content === 'string'
        )
      if (block.type === 'image')
        return (
          typeof block.image === 'string' && typeof block.mediaType === 'string'
        )
      const strings = (value: unknown) =>
        Array.isArray(value) && value.every((item) => typeof item === 'string')
      const object = (value: unknown): value is Record<string, unknown> =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
      const optionalStrings = (value: unknown) =>
        value === undefined || strings(value)
      if (block.type === 'doctor')
        return (
          typeof block.projectRoot === 'string' &&
          typeof block.providerStatus === 'string' &&
          Array.isArray(block.diagnostics) &&
          block.diagnostics.every(
            (item: unknown) => object(item) && typeof item.message === 'string',
          ) &&
          (block.capabilities === undefined ||
            (Array.isArray(block.capabilities) &&
              block.capabilities.every(
                (item: unknown) =>
                  object(item) &&
                  typeof item.label === 'string' &&
                  typeof item.value === 'string' &&
                  optionalStrings(item.rows),
              )))
        )
      if (block.type === 'update') return strings(block.lines)
      if (block.type === 'index-status')
        return (
          strings(block.lines) &&
          optionalStrings(block.diagnosticsLines) &&
          [
            'statusLine',
            'messageLine',
            'corpusLine',
            'ageLine',
            'vectorLine',
            'hintLine',
          ].every((key) => typeof block[key] === 'string')
        )
      if (block.type === 'plan-status' || block.type === 'plan-status-list')
        return typeof block.reportText === 'string'
      if (block.type === 'plan') return typeof block.content === 'string'
      if (block.type === 'context')
        return (
          (block.ledgerText === null || typeof block.ledgerText === 'string') &&
          typeof block.gateBudgetsText === 'string' &&
          (block.instructionFilesText === undefined ||
            typeof block.instructionFilesText === 'string')
        )
      if (block.type === 'info')
        return (
          typeof block.version === 'string' &&
          typeof block.workspace === 'string'
        )
      if (block.type === 'agent-list')
        return (
          Array.isArray(block.agents) &&
          block.agents.every(
            (item: unknown) =>
              object(item) &&
              typeof item.id === 'string' &&
              typeof item.displayName === 'string',
          )
        )
      if (block.type === 'completion-summary')
        return (
          object(block.summary) &&
          (block.summary.reviewHistory === undefined ||
            (Array.isArray(block.summary.reviewHistory) &&
              block.summary.reviewHistory.every(
                (item: unknown) =>
                  object(item) && typeof item.verdict === 'string',
              )))
        )
      if (block.type === 'compaction')
        return (
          block.categoryDeltas === undefined ||
          (Array.isArray(block.categoryDeltas) &&
            block.categoryDeltas.every(
              (item: unknown) =>
                object(item) && typeof item.category === 'string',
            ))
        )
      if (block.type === 'gate-state')
        return (
          typeof block.gate === 'string' &&
          ['pending', 'passed', 'failed', 'skipped'].includes(
            block.gateStatus,
          ) &&
          optionalStrings(block.advisories) &&
          optionalStrings(block.reviewers) &&
          (block.origin === undefined || typeof block.origin === 'string')
        )
      if (block.type === 'ask-user')
        return (
          typeof block.toolCallId === 'string' &&
          Array.isArray(block.questions) &&
          block.questions.every(
            (item: unknown) =>
              object(item) &&
              typeof item.question === 'string' &&
              Array.isArray(item.options) &&
              item.options.every(
                (option: unknown) =>
                  object(option) && typeof option.label === 'string',
              ),
          )
        )
      if (block.type === 'memory') {
        if (!optionalStrings(block.v2Lines)) return false
        if (block.state === 'status')
          return (
            object(block.counts) &&
            object(block.evidence) &&
            typeof block.goalPreview === 'string' &&
            strings(block.stalePaths)
          )
        if (block.state === 'report' || block.state === 'reuse')
          return (
            strings(block.lines) &&
            (block.insertCommands === undefined ||
              (Array.isArray(block.insertCommands) &&
                block.insertCommands.every(
                  (item: unknown) =>
                    object(item) &&
                    typeof item.label === 'string' &&
                    typeof item.command === 'string',
                )))
          )
        return (
          [
            'empty',
            'pruned',
            'nothing-to-prune',
            'no-record',
            'failed',
            'error',
          ].includes(block.state) &&
          (block.message === undefined || typeof block.message === 'string')
        )
      }
      // Executable React content cannot be reconstructed from a saved JSON file.
      if (block.type === 'html') return false
      return true
    })
  }
  for (const message of messages) {
    if (
      message === null ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      typeof message.id !== 'string' ||
      typeof message.variant !== 'string' ||
      !['ai', 'user', 'agent', 'error'].includes(message.variant) ||
      typeof message.timestamp !== 'string' ||
      typeof message.content !== 'string' ||
      (message.blocks !== undefined && !validBlocks(message.blocks))
    ) {
      return null
    }
  }
  // Old sessions used process-local thinking-N counters. Give each retained
  // group its own identity, preserving contiguous fragments of the same group.
  const scopeThinking = (blocks: import('../types/chat').ContentBlock[]) => {
    let previous: import('../types/chat').TextContentBlock | undefined
    let scopedId: string | undefined
    for (const block of blocks) {
      if (block.type === 'agent' && block.blocks) scopeThinking(block.blocks)
      if (block.type !== 'text' || !block.thinkingId) {
        previous = undefined
        continue
      }
      const originalId = block.thinkingId
      if (
        !previous ||
        previous.thinkingId !== originalId ||
        previous.thinkingOpen !== block.thinkingOpen ||
        previous.thinkingCollapseState !== block.thinkingCollapseState ||
        previous.thinkingStartedAt !== block.thinkingStartedAt ||
        previous.thinkingEndedAt !== block.thinkingEndedAt
      )
        scopedId = `restored-thinking-${crypto.randomUUID()}`
      previous = { ...block, thinkingId: originalId }
      block.thinkingId = scopedId
    }
  }
  for (const message of messages as ChatMessage[])
    if (message.blocks) scopeThinking(message.blocks)
  return messages as ChatMessage[]
}

function quarantineCorruptStateFile(filePath: string): string | null {
  const quarantinePath = `${filePath}.corrupt.${Date.now()}.${process.pid}`
  try {
    fs.renameSync(filePath, quarantinePath)
    return quarantinePath
  } catch (error) {
    logger.warn(
      {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to quarantine corrupt chat state envelope',
    )
    return null
  }
}

/**
 * The envelope schema version this CLI reads and writes. Bump when the
 * persisted chat-state shape changes in a way older CLIs cannot read.
 */
const CHAT_STATE_ENVELOPE_VERSION = 1 as const

/**
 * Whether `parsed` is an envelope whose version this CLI does not understand
 * (e.g. written by a newer release). A parseable newer envelope must never be
 * quarantined on read or overwritten on write: a downgraded CLI leaves it in
 * place so it is found again after re-upgrade.
 */
function hasUnrecognizedEnvelopeVersion(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false
  }
  const version = (parsed as { version?: unknown }).version
  return version !== undefined && version !== CHAT_STATE_ENVELOPE_VERSION
}

/**
 * Parse the envelope version out of the chat-state.json on disk without
 * assuming which CLI release wrote it. Returns undefined when the file is
 * absent, unreadable, or not a JSON object carrying a numeric `version` —
 * those are the legacy/corrupt cases handled elsewhere.
 */
function readEnvelopeVersion(filePath: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }
  const version = (parsed as { version?: unknown }).version
  return typeof version === 'number' ? version : undefined
}

export function loadChatStateFromCompatibilityFiles(
  chatDir: string,
): SavedChatState | null {
  const runStatePath = path.join(chatDir, RUN_STATE_FILENAME)
  const messagesPath = path.join(chatDir, CHAT_MESSAGES_FILENAME)
  if (!fs.existsSync(runStatePath) || !fs.existsSync(messagesPath)) {
    logger.debug(
      { runStatePath, messagesPath },
      'Missing state files in chat directory',
    )
    return null
  }

  const runState = sanitizeForChatPersistence(
    JSON.parse(fs.readFileSync(runStatePath, 'utf8')) as RunState,
  )
  let messages: ChatMessage[]
  try {
    messages = sanitizeForChatPersistence(
      JSON.parse(fs.readFileSync(messagesPath, 'utf8')) as ChatMessage[],
    )
  } catch (error) {
    logger.warn(
      {
        messagesPath,
        error: error instanceof Error ? error.message : String(error),
      },
      'Legacy chat messages file is unreadable; starting a fresh session',
    )
    return null
  }
  if (
    !runState ||
    validatePersistedMessages(messages) === null ||
    !Array.isArray(messages)
  ) {
    logger.warn(
      { runStatePath, messagesPath },
      'Legacy chat state files are malformed; starting a fresh session',
    )
    return null
  }

  const chatId = path.basename(chatDir)
  logger.info(
    { runStatePath, messagesPath, messageCount: messages.length, chatId },
    'Loaded chat state from compatibility files',
  )
  return { runState, messages, chatId }
}

export function loadChatStateFromDirectory(
  chatDir: string,
): SavedChatState | null {
  const chatStatePath = path.join(chatDir, CHAT_STATE_FILENAME)
  if (fs.existsSync(chatStatePath)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(chatStatePath, 'utf8'))
    } catch (error) {
      // Unreadable bytes cannot be interpreted by any CLI version, so
      // quarantine them rather than letting corrupt data shadow the
      // compatibility recovery below.
      const quarantinePath = quarantineCorruptStateFile(chatStatePath)
      logger.warn(
        {
          chatStatePath,
          quarantinePath,
          error: error instanceof Error ? error.message : String(error),
        },
        'Chat state envelope is unreadable; quarantining and attempting compatibility recovery',
      )
      return loadChatStateFromCompatibilityFiles(chatDir)
    }
    if (hasUnrecognizedEnvelopeVersion(parsed)) {
      // A parseable envelope whose only defect is an unrecognized (e.g.
      // newer) envelope version was written by a different CLI release.
      // Never quarantine it: a downgraded CLI must leave a newer session's
      // state file in place so it is found again after re-upgrade. Fall
      // through to compatibility recovery instead.
      logger.warn(
        { chatStatePath, version: (parsed as { version?: unknown }).version },
        'Chat state envelope has an unrecognized version; leaving file in place and attempting compatibility recovery',
      )
      return loadChatStateFromCompatibilityFiles(chatDir)
    }
    // Read-path sanitization is for redaction/unserializable safety ONLY — it
    // must never size-cap, or a storage budget would truncate the transcript
    // that becomes the next run's live model context.
    const persisted = sanitizeForChatPersistence(parsed as PersistedChatState)
    if (
      !persisted ||
      typeof persisted !== 'object' ||
      Array.isArray(persisted) ||
      persisted.version !== 1 ||
      !persisted.runState ||
      !Array.isArray(persisted.messages) ||
      // P6.5: an invalid messages payload means the session cannot be
      // rendered safely; fall through to the compatibility recovery rather
      // than crashing.
      validatePersistedMessages(persisted.messages) === null
    ) {
      // Version-1 data with a corrupt shape is unreadable for every CLI
      // version, so quarantine it before attempting compatibility recovery.
      const quarantinePath = quarantineCorruptStateFile(chatStatePath)
      logger.warn(
        {
          chatStatePath,
          quarantinePath,
        },
        'Chat state envelope is corrupt; attempting compatibility recovery',
      )
      return loadChatStateFromCompatibilityFiles(chatDir)
    }
    return {
      runState: persisted.runState,
      messages: persisted.messages,
      chatId: path.basename(chatDir),
    }
  }
  return loadChatStateFromCompatibilityFiles(chatDir)
}

const CODEC_WORKER_MIN_CHARS = 64 * 1024

async function parsePersistedAsync<T>(
  text: string,
  signal?: AbortSignal,
): Promise<T> {
  if (text.length >= CODEC_WORKER_MIN_CHARS) {
    try {
      return await runPersistenceCodec<T>('parse', text, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      // Worker startup can fail on an unsupported host. Preserve the existing
      // parsing and corruption-recovery behavior as a fail-open fallback.
    }
  }
  return sanitizeForChatPersistence(JSON.parse(text)) as T
}

/** Async counterpart used by the TUI restore path; the sync API remains for
 * callers that need it. Large JSON payloads are parsed on a worker. */
export async function loadChatStateFromDirectoryAsync(
  chatDir: string,
  signal?: AbortSignal,
): Promise<SavedChatState | null> {
  const options = { encoding: 'utf8' as const, signal }
  const compatibility = async (): Promise<SavedChatState | null> => {
    try {
      const [runText, messagesText] = await Promise.all([
        fs.promises.readFile(path.join(chatDir, RUN_STATE_FILENAME), options),
        fs.promises.readFile(
          path.join(chatDir, CHAT_MESSAGES_FILENAME),
          options,
        ),
      ])
      if (signal?.aborted) return null
      const [runState, messages] = await Promise.all([
        parsePersistedAsync<RunState>(runText, signal),
        parsePersistedAsync<unknown>(messagesText, signal),
      ])
      if (signal?.aborted) return null
      if (!runState || validatePersistedMessages(messages) === null) return null
      return {
        runState,
        messages: messages as ChatMessage[],
        chatId: path.basename(chatDir),
      }
    } catch {
      return null
    }
  }
  const filePath = path.join(chatDir, CHAT_STATE_FILENAME)
  let raw: string
  try {
    raw = await fs.promises.readFile(filePath, options)
  } catch (error) {
    if (signal?.aborted) return null
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      quarantineCorruptStateFile(filePath)
    }
    return compatibility()
  }
  if (signal?.aborted) return null
  let parsed: unknown
  try {
    parsed = await parsePersistedAsync<unknown>(raw, signal)
  } catch {
    if (signal?.aborted) return null
    quarantineCorruptStateFile(filePath)
    return compatibility()
  }
  if (hasUnrecognizedEnvelopeVersion(parsed)) return compatibility()
  const persisted = parsed as PersistedChatState
  if (
    !persisted ||
    typeof persisted !== 'object' ||
    Array.isArray(persisted) ||
    persisted.version !== 1 ||
    !persisted.runState ||
    validatePersistedMessages(persisted.messages) === null
  ) {
    quarantineCorruptStateFile(filePath)
    return compatibility()
  }
  return {
    runState: persisted.runState,
    messages: persisted.messages,
    chatId: path.basename(chatDir),
  }
}

export async function loadMostRecentChatStateAsync(
  chatId?: string,
  signal?: AbortSignal,
): Promise<SavedChatState | null> {
  try {
    let chatDir: string | null = null
    if (chatId && chatId.trim().length > 0) {
      if (!isValidChatId(chatId)) return null
      const candidate = path.join(getProjectDataDir(), 'chats', chatId.trim())
      if (!(await fs.promises.stat(candidate)).isDirectory()) return null
      chatDir = candidate
    } else {
      const chatsDir = path.join(getProjectDataDir(), 'chats')
      const names = await fs.promises.readdir(chatsDir)
      const candidates: Array<{ fullPath: string; mtime: number } | null> = []
      for (
        let start = 0;
        start < names.length && !signal?.aborted;
        start += 32
      ) {
        candidates.push(
          ...(await Promise.all(
            names.slice(start, start + 32).map(async (name) => {
              const fullPath = path.join(chatsDir, name)
              try {
                const stat = await fs.promises.stat(fullPath)
                return stat.isDirectory()
                  ? { fullPath, mtime: stat.mtimeMs }
                  : null
              } catch {
                return null
              }
            }),
          )),
        )
      }
      const dirs = candidates.filter(
        (item): item is { fullPath: string; mtime: number } => item !== null,
      )
      dirs.sort((a, b) => b.mtime - a.mtime)
      chatDir = dirs[0]?.fullPath ?? null
    }
    if (!chatDir || signal?.aborted) return null
    return await loadChatStateFromDirectoryAsync(chatDir, signal)
  } catch {
    return null
  }
}

/**
 * Queue one atomic chat-state output file: temp file + rename, coalesced per
 * file path on the persistence queue so a rapid save burst writes each file
 * at most once. Serialization has already happened by the time the caller
 * invokes this; only the disk IO is asynchronous. Write failures are logged
 * (fail-soft, matching saveChatState's error contract) and never thrown.
 */
function scheduleChatStateWrite(filePath: string, serialized: string): void {
  schedulePersistenceWrite({
    targetKey: filePath,
    label: filePath,
    run: () => atomicWriteJsonFile(filePath, serialized, { mode: 0o600 }),
    onError: (error) => {
      logger.error(
        {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to save chat state',
      )
    },
  })
}

export function isValidChatId(chatId: string): boolean {
  const trimmed = chatId.trim()
  return (
    trimmed.length > 0 &&
    trimmed !== '.' &&
    trimmed !== '..' &&
    path.basename(trimmed) === trimmed &&
    !path.isAbsolute(trimmed)
  )
}

/**
 * Recursively extract all agent IDs and tool call IDs from content blocks
 */
function extractToggleIds(blocks: ContentBlock[] | undefined): string[] {
  if (!blocks) return []

  const ids: string[] = []

  for (const block of blocks) {
    if (block.type === 'agent') {
      ids.push(block.agentId)
      // Recursively extract from nested blocks
      ids.push(...extractToggleIds(block.blocks))
    } else if (block.type === 'tool') {
      ids.push(block.toolCallId)
    }
  }

  return ids
}

/**
 * Get all toggle IDs (agent IDs and tool call IDs) from chat messages
 */
export function getAllToggleIdsFromMessages(messages: ChatMessage[]): string[] {
  const ids: string[] = []

  for (const message of messages) {
    ids.push(...extractToggleIds(message.blocks))
  }

  return ids
}

/**
 * Get the path to the run state file for the current chat
 */
export function getRunStatePath(): string {
  const chatDir = getCurrentChatDir()
  return path.join(chatDir, RUN_STATE_FILENAME)
}

/**
 * Get the path to the chat messages file for the current chat
 */
export function getChatMessagesPath(): string {
  const chatDir = getCurrentChatDir()
  return path.join(chatDir, CHAT_MESSAGES_FILENAME)
}

export function getChatStatePath(): string {
  return path.join(getCurrentChatDir(), CHAT_STATE_FILENAME)
}

/**
 * P2-3: Get the path to the mid-turn checkpoint file for the current chat.
 * The checkpoint stores a serialized mainAgentState snapshot taken every
 * ~30s during the main agent loop, so a crashed/killed session can resume
 * mid-turn from the last checkpoint rather than losing all in-flight work.
 */
export function getCheckpointPath(): string {
  const chatDir = getCurrentChatDir()
  return path.join(chatDir, CHECKPOINT_FILENAME)
}

/**
 * Save both the RunState and ChatMessage[] to disk
 */
export function saveChatState(
  runState: RunState,
  messages: ChatMessage[],
): void {
  const chatDir = getCurrentChatDir()
  const chatStatePath = path.join(chatDir, CHAT_STATE_FILENAME)
  const runStatePath = path.join(chatDir, RUN_STATE_FILENAME)
  const messagesPath = path.join(chatDir, CHAT_MESSAGES_FILENAME)
  const archiveOwner = runState.sessionState?.mainAgentState?.compactionArchive
    ?.length
    ? { root: getProjectRoot(), authority: getMemoryAuthoritySelection() }
    : undefined
  // Capture at call time before the queued worker runs. The clone also gives
  // the fallback the same immutable snapshot if the worker cannot start.
  let snapshot: { runState: RunState; messages: ChatMessage[] }
  try {
    snapshot = structuredClone({
      runState,
      messages: messages.map((message) => {
        if (message.metadata?.runState === undefined) return message
        const { runState: _historicalRunState, ...metadata } = message.metadata
        return { ...message, metadata }
      }),
    })
  } catch {
    // Preserve support for unusual non-cloneable live state.
    saveChatStateSynchronously(runState, messages)
    return
  }
  schedulePersistenceWrite({
    targetKey: chatStatePath,
    label: chatStatePath,
    onError: (error) =>
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to save chat state',
      ),
    run: async () => {
      let serialized: {
        runState: string
        messages: string
        archive: RunState | null
      }
      try {
        serialized = await runPersistenceCodec('serialize', snapshot)
      } catch {
        const cleanRunState = sanitizeForChatPersistence(snapshot.runState)
        serialized = {
          runState: JSON.stringify(cleanRunState),
          messages: JSON.stringify(
            sanitizeForChatPersistence(snapshot.messages),
          ),
          archive: cleanRunState,
        }
      }
      let diskVersion: number | undefined
      try {
        const raw = await fs.promises.readFile(chatStatePath, 'utf8')
        const parsed = await parsePersistedAsync<unknown>(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const version = (parsed as { version?: unknown }).version
          if (typeof version === 'number') diskVersion = version
        }
      } catch {
        // Missing or corrupt files follow the existing overwrite behavior.
      }
      if (
        diskVersion === undefined ||
        diskVersion === CHAT_STATE_ENVELOPE_VERSION
      ) {
        try {
          await atomicWriteJsonFile(
            chatStatePath,
            `{"version":1,"runState":${serialized.runState},"messages":${serialized.messages}}`,
            { mode: 0o600 },
          )
        } catch (error) {
          logger.error(
            {
              filePath: chatStatePath,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to save chat state',
          )
        }
      } else {
        logger.warn(
          { chatStatePath, diskVersion },
          'Chat state envelope has an unrecognized version; leaving file in place and updating only the legacy compatibility files',
        )
      }
      // The legacy sidecar outputs are scheduled as their OWN per-target
      // queue entries (scheduleChatStateWrite) and never written inline from
      // this chatStatePath-keyed run(): a queued sidecar write must stay
      // visible to cancelAndDrainPendingWriteFor(runStatePath) /
      // (messagesPath), which cannot see files written inline under a
      // different target key (reliability finding
      // cleared-state-resurrection-async-save). These synchronous enqueues
      // join the pump's current loop, so the sidecars still land right after
      // the envelope, in the same relative order as before.
      scheduleChatStateWrite(runStatePath, serialized.runState)
      scheduleChatStateWrite(messagesPath, serialized.messages)
      if (serialized.archive) {
        void flushContextArchiveSnapshots(
          serialized.archive,
          archiveOwner,
        ).catch((error) => {
          logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'Context archive flush failed (non-fatal)',
          )
        })
      }
    },
  })
}

function saveChatStateSynchronously(
  runState: RunState,
  messages: ChatMessage[],
): void {
  try {
    const persistedRunState = sanitizeForChatPersistence(runState)
    // Older messages may carry a full historical RunState in metadata. The
    // authoritative continuation state is the envelope's runState; message
    // metadata is for rendering and undo already excludes this field. Do not
    // repeatedly persist transcript-sized snapshots from old sessions.
    const persistedMessages = sanitizeForChatPersistence(
      messages.map((message) => {
        if (message.metadata?.runState === undefined) return message
        const { runState: _historicalRunState, ...metadata } = message.metadata
        return { ...message, metadata }
      }),
    )
    // Serialize (sanitize + compact JSON) happens synchronously so the
    // persisted bytes always match THIS call's arguments and the caller still
    // sees an up-to-date in-memory snapshot; only the disk IO (queued via
    // scheduleChatStateWrite) is asynchronous. Compact JSON keeps the three
    // envelopes lean; file names, layout, and the version contract below are
    // unchanged.
    //
    // The envelope is the authoritative resume state, so a crash cannot pair
    // one turn's run state with another turn's messages. Legacy files remain
    // as atomic compatibility/read-model outputs for history views.
    //
    // Mixed-version tolerance on the write path mirrors the read path: if the
    // envelope on disk was written by a different CLI release (any other
    // version), it must not be overwritten — a downgraded CLI continuing a
    // session would otherwise destroy the newer release's only authoritative
    // resume state. The legacy sidecars still advance so compatibility
    // recovery and history views keep working for this process. The version
    // check reads the CURRENT on-disk envelope synchronously, before any of
    // this call's writes are queued.
    const chatStatePath = getChatStatePath()
    const diskVersion = readEnvelopeVersion(chatStatePath)
    // The envelope and compatibility files carry exactly the same sanitized
    // trees. Serialize each once and reuse the bytes for all three files.
    const serializedRunState = JSON.stringify(persistedRunState)
    const serializedMessages = JSON.stringify(persistedMessages)
    if (
      diskVersion !== undefined &&
      diskVersion !== CHAT_STATE_ENVELOPE_VERSION
    ) {
      logger.warn(
        {
          chatStatePath,
          diskVersion,
          writeVersion: CHAT_STATE_ENVELOPE_VERSION,
        },
        'Chat state envelope has an unrecognized version; leaving it in place and updating only the legacy compatibility files',
      )
    } else {
      scheduleChatStateWrite(
        chatStatePath,
        `{"version":1,"runState":${serializedRunState},"messages":${serializedMessages}}`,
      )
    }
    scheduleChatStateWrite(getRunStatePath(), serializedRunState)
    scheduleChatStateWrite(getChatMessagesPath(), serializedMessages)

    // Cross-session context-archive persistence: fire-and-forget flush of the
    // run's compaction archive into the memory-v2 store (the recall_context
    // source) after the chat state itself is safely on disk. The SANITIZED
    // run state is flushed, not the raw one: the durable store must never
    // persist tool bodies less redacted than the run-state.json produced by
    // the same sanitizeForChatPersistence pass. Deliberately NOT
    // awaited — saveChatState keeps sanitize + serialize synchronous and only
    // the queued disk writes above and this archive flush are asynchronous —
    // and safe to fire here without an import cycle: context-archive-sync →
    // provider → utils/env + project-files, none of which import back into
    // run-state-storage. The helper is no-throw; the .catch is a
    // double-guard so an unexpected
    // rejection can only ever log.
    void flushContextArchiveSnapshots(persistedRunState).catch((error) => {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Context archive flush failed (non-fatal)',
      )
    })
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to save chat state',
    )
  }
}

/**
 * Load both RunState and ChatMessage[] from a specific chat directory or the most recent one.
 * When chatId is provided, it is used to locate the chat directory; otherwise the most
 * recently modified chat directory is used.
 * Returns null if no previous chat exists or files can't be parsed.
 */
export function loadMostRecentChatState(
  chatId?: string,
): SavedChatState | null {
  try {
    let chatDir: string | null = null

    if (chatId && chatId.trim().length > 0) {
      if (!isValidChatId(chatId)) {
        logger.warn({ chatId }, 'Rejected invalid chat id')
        return null
      }
      const baseDir = path.join(getProjectDataDir(), 'chats')
      const candidateDir = path.join(baseDir, chatId.trim())
      if (
        fs.existsSync(candidateDir) &&
        fs.statSync(candidateDir).isDirectory()
      ) {
        chatDir = candidateDir
      } else {
        logger.debug(
          { candidateDir, chatId },
          'Requested chatId directory not found',
        )
        return null
      }
    }

    if (!chatDir) {
      chatDir = getMostRecentChatDir()
    }

    if (!chatDir) {
      logger.debug('No previous chat directory found')
      return null
    }

    return loadChatStateFromDirectory(chatDir)
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to load chat state',
    )
    return null
  }
}

/**
 * P2-3: Wrapper for a mid-turn checkpoint. Contains the serialized
 * mainAgentState snapshot plus the `checkpointTurnId` (the userInputId/promptId
 * of the interrupted turn) so the CLI can self-validate on resume that the
 * checkpoint belongs to the turn it's about to resume — a stale checkpoint from
 * a *previous* turn is discarded rather than corrupting the new turn.
 */
export type TurnCheckpoint = {
  /** The promptId/userInputId of the turn this checkpoint was written for.
   * On resume, the CLI compares this against the turn it's about to resume;
   * mismatch = discard the checkpoint and start fresh. */
  checkpointTurnId: string
  /** Unix ms of the last checkpoint write, for staleness diagnostics. */
  checkpointTime: number
  /** The main agent's state snapshot at the last step boundary. */
  mainAgentState: SessionState['mainAgentState']
}

/**
 * P2-3: Save a mid-turn checkpoint atomically (temp file + rename). Called by
 * the SDK's onCheckpoint callback (throttled to 30s inside loopAgentSteps).
 * Serialize (sanitize + compact JSON) happens synchronously so the serialized
 * bytes always match THIS call's snapshot; only the disk IO is queued on the
 * persistence queue (coalesced per checkpoint path). Failures are swallowed
 * and logged — checkpoint persistence must never kill the run (loopAgentSteps
 * also catches, but we double-guard here since this runs on the CLI's
 * filesystem).
 */
export function saveCheckpoint(
  checkpointTurnId: string,
  mainAgentState: AgentState,
): void {
  try {
    const checkpointPath = getCheckpointPath()
    const checkpoint: TurnCheckpoint = {
      checkpointTurnId,
      checkpointTime: Date.now(),
      mainAgentState: sanitizeForChatPersistence(mainAgentState),
    }
    const serialized = JSON.stringify(checkpoint)
    // Atomic write: temp file in the same directory, then rename. Same-dir
    // rename is atomic on POSIX and prevents a partial-write checkpoint from
    // corrupting the resume path on a crash mid-write. The run() below
    // executes on the serial persistence queue, so the sweep can never race
    // this target's own in-flight rename.
    const dir = path.dirname(checkpointPath)
    const tempPath = `${checkpointPath}.tmp.${process.pid}`
    schedulePersistenceWrite({
      targetKey: checkpointPath,
      label: checkpointPath,
      run: async () => {
        // Sweep stale temp files from prior crashed writes. Bounded to the
        // checkpoint's own directory and the `.tmp.<pid>` prefix so we never
        // touch unrelated files. A concurrent sibling session's pre-rename
        // tmp file must NOT be swept: only remove a candidate when its
        // owning pid is provably dead (a previous process that died between
        // write and rename); entries with an unparsable pid suffix fall
        // back to an mtime staleness window longer than any reasonable
        // write (reliability finding checkpoint-sweep-cross-pid-race).
        const sweepPrefix = `${CHECKPOINT_FILENAME}.tmp.`
        try {
          for (const entry of await readdir(dir)) {
            if (
              !entry.startsWith(sweepPrefix) ||
              entry === path.basename(tempPath)
            ) {
              continue
            }
            const candidatePath = path.join(dir, entry)
            const pidSuffix = entry.slice(sweepPrefix.length)
            let stale = false
            if (/^\d+$/.test(pidSuffix)) {
              stale = !isPidAlive(Number.parseInt(pidSuffix, 10))
            } else {
              try {
                stale =
                  Date.now() - fs.statSync(candidatePath).mtimeMs >
                  STALE_TEMP_FILE_SWEEP_MIN_AGE_MS
              } catch {
                // Vanished between readdir and stat: already gone.
                continue
              }
            }
            if (!stale) continue
            try {
              await unlink(candidatePath)
            } catch {
              // Best-effort: a concurrent rename or lock on this entry must
              // not block the checkpoint write below.
            }
          }
        } catch {
          // Best-effort cleanup; a missing dir or race here must not block the
          // checkpoint write below.
        }
        await atomicWriteJsonFile(checkpointPath, serialized, {
          tmpPath: tempPath,
        })
      },
      onError: (error) => {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Failed to save mid-turn checkpoint (non-fatal)',
        )
      },
    })
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to save mid-turn checkpoint (non-fatal)',
    )
  }
}

/**
 * P2-3: Load the mid-turn checkpoint for validation. Returns null if no
 * checkpoint exists or it can't be parsed. The caller validates that
 * `checkpointTurnId` matches the turn it's about to resume before using the
 * snapshot; a mismatch means the checkpoint is stale (from a previous turn)
 * and must be discarded.
 */
export function loadCheckpoint(): TurnCheckpoint | null {
  try {
    const checkpointPath = getCheckpointPath()
    if (!fs.existsSync(checkpointPath)) {
      return null
    }
    const content = fs.readFileSync(checkpointPath, 'utf8')
    const checkpoint = sanitizeForChatPersistence(
      JSON.parse(content) as TurnCheckpoint,
    )
    if (
      !checkpoint ||
      typeof checkpoint.checkpointTurnId !== 'string' ||
      typeof checkpoint.checkpointTime !== 'number' ||
      !checkpoint.mainAgentState
    ) {
      logger.warn(
        { checkpointPath },
        'Mid-turn checkpoint is malformed, discarding',
      )
      return null
    }
    return checkpoint
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to load mid-turn checkpoint (non-fatal)',
    )
    return null
  }
}

/**
 * P2-3: Clear the mid-turn checkpoint. Called after a turn completes
 * successfully (so a stale checkpoint can't interfere with the next turn) and
 * when a checkpoint is rejected as stale on resume.
 *
 * Async serialization is required here, not a plain cancel: the persistence
 * pump deletes a write's map entry BEFORE awaiting run(), so an in-flight
 * rename is invisible to cancelPendingPersistenceWrite and could land after
 * the unlink below, resurrecting a checkpoint from a completed turn. On the
 * next restore, loadCheckpoint would accept that file (its turnId still
 * matches a restored message) and a resumed send could fork from a stale
 * mid-turn snapshot instead of the final saved state.
 */
export async function clearCheckpoint(): Promise<void> {
  try {
    const checkpointPath = getCheckpointPath()
    // Cancel the queued write, then drain so any write already handed to the
    // pump settles before the unlink below. The pump serializes writes, so
    // after this await no dequeued-but-unwritten rename can follow it.
    await cancelAndDrainPendingWriteFor(checkpointPath)
    if (fs.existsSync(checkpointPath)) {
      fs.unlinkSync(checkpointPath)
      logger.debug({ checkpointPath }, 'Cleared mid-turn checkpoint')
    }
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to clear mid-turn checkpoint (non-fatal)',
    )
  }
}

/**
 * Clear the saved state files. Clear-then-unlink on each target is awaited
 * (see clearCheckpoint) so an in-flight write cannot land after a target's
 * unlink and resurrect the cleared state.
 */
export async function clearChatState(): Promise<void> {
  try {
    const runStatePath = getRunStatePath()
    const messagesPath = getChatMessagesPath()
    const chatStatePath = getChatStatePath()

    // Cancel queued writes and drain the pump first so a pending save cannot
    // resurrect any of these files after the unlinks below.
    await cancelAndDrainPendingWriteFor(runStatePath)
    await cancelAndDrainPendingWriteFor(messagesPath)
    await cancelAndDrainPendingWriteFor(chatStatePath)

    if (fs.existsSync(runStatePath)) {
      fs.unlinkSync(runStatePath)
    }
    if (fs.existsSync(messagesPath)) {
      fs.unlinkSync(messagesPath)
    }
    if (fs.existsSync(chatStatePath)) {
      fs.unlinkSync(chatStatePath)
    }

    logger.debug(
      { runStatePath, messagesPath, chatStatePath },
      'Cleared chat state files',
    )
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to clear chat state',
    )
  }
}
