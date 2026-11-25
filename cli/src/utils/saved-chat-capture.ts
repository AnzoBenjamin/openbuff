import fs from 'node:fs'
import path from 'node:path'
import { validatePersistedMessages } from './run-state-storage'
import { runPersistenceCodec } from './persistence-codec'
import type { ChatMessage } from '../types/chat'

export type SavedChatCapture =
  | { state: 'saved'; messages: ChatMessage[] }
  | { state: 'empty' }
  | { state: 'unavailable' }

const candidates = ['chat-state.json', 'chat-messages.json'] as const
function messagesFromCapture(
  value: unknown,
  envelope: boolean,
): ChatMessage[] | null {
  if (!envelope) return validatePersistedMessages(value)
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('runState' in value) ||
    !value.runState ||
    !('messages' in value)
  )
    return null
  return validatePersistedMessages(value.messages)
}
function classify(messages: ChatMessage[]): SavedChatCapture {
  return messages.length ? { state: 'saved', messages } : { state: 'empty' }
}

/** Display-only reads: never load SDK state, quarantine, or rewrite captures. */
export function readSavedChatCapture(chatDir: string): SavedChatCapture {
  let retained = false
  for (const name of candidates) {
    try {
      const value: unknown = JSON.parse(
        fs.readFileSync(path.join(chatDir, name), 'utf8'),
      )
      retained = true
      const messages = messagesFromCapture(value, name === 'chat-state.json')
      if (messages) return classify(messages)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') retained = true
    }
  }
  return retained ||
    ['run-state.json', 'turn-checkpoint.json'].some((name) =>
      fs.existsSync(path.join(chatDir, name)),
    )
    ? { state: 'unavailable' }
    : { state: 'empty' }
}

export async function readSavedChatCaptureAsync(
  chatDir: string,
  signal?: AbortSignal,
): Promise<SavedChatCapture> {
  let retained = false
  for (const name of candidates) {
    if (signal?.aborted) return { state: 'empty' }
    try {
      // Avoid reading absent sidecars and keep large JSON parsing off the TUI thread.
      await fs.promises.stat(path.join(chatDir, name))
      retained = true
      const raw = await fs.promises.readFile(path.join(chatDir, name), {
        encoding: 'utf8',
        signal,
      })
      let value: unknown
      try {
        value = await runPersistenceCodec('parse', raw, signal)
      } catch {
        if (signal?.aborted) return { state: 'empty' }
        value = JSON.parse(raw)
      }
      const messages = messagesFromCapture(value, name === 'chat-state.json')
      if (messages) return classify(messages)
    } catch (error) {
      if (signal?.aborted) return { state: 'empty' }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') retained = true
    }
  }
  for (const name of ['run-state.json', 'turn-checkpoint.json']) {
    try {
      await fs.promises.stat(path.join(chatDir, name))
      retained = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') retained = true
    }
  }
  return retained ? { state: 'unavailable' } : { state: 'empty' }
}
