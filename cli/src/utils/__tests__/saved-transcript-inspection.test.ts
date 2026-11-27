import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as projectFiles from '../../project-files'
import { savedTranscriptInspection, readSavedTranscriptInspection } from '../saved-transcript-inspection'
import { validatePersistedMessages } from '../run-state-storage'

const messages = [
  { id: 'healthy-1', variant: 'user', content: 'retained first prompt', timestamp: '', blocks: [] },
  { id: 'bad-2', variant: 'ai', content: { retainedDiagnostic: 'corrupt content field' }, timestamp: '', blocks: 'invalid' },
  { id: 'healthy-3', variant: 'system', content: 'retained final message', timestamp: '', blocks: [] },
]
afterEach(() => mock.restore())

test('inspection isolates a malformed UI item while restore validation stays refused and raw fields survive', () => {
  const document = savedTranscriptInspection('recovery', messages, '/captured/messages.json')
  expect(document.rowCount).toBe(3)
  expect(document.text).toContain('retained first prompt')
  expect(document.text).toContain('unavailable message')
  expect(document.text).toContain('retained final message')
  expect(document.detail?.(1)?.text).toContain('corrupt content field')
  expect(document.notice).toContain('cannot resume or edit')
  expect(validatePersistedMessages(messages)).toBeNull()
  expect(messages[1].content).toEqual({ retainedDiagnostic: 'corrupt content field' })
})

test('reading an inspection never quarantines or rewrites a capture and refuses path traversal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'saved-inspection-'))
  spyOn(projectFiles, 'getProjectDataDir').mockReturnValue(root)
  const directory = path.join(root, 'chats', 'saved')
  const capture = path.join(directory, 'chat-messages.json')
  const raw = JSON.stringify(messages)
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(capture, raw)
    const document = await readSavedTranscriptInspection('saved', 'metadata')
    expect(document.rowCount).toBe(3)
    expect(document.provenance?.identity).toBe(capture)
    expect(await readFile(capture, 'utf8')).toBe(raw)
    await expect(readSavedTranscriptInspection('../other', '')).rejects.toThrow('Invalid saved session')
    await writeFile(capture, '{ invalid JSON')
    const malformed = await readSavedTranscriptInspection('saved', 'metadata retained')
    expect(malformed.text).toContain('{ invalid JSON')
    expect(malformed.notice).toContain('invalid JSON')
    expect(await readFile(capture, 'utf8')).toBe('{ invalid JSON')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('inspection reads an envelope-only save without loading continuation state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'saved-envelope-inspection-'))
  spyOn(projectFiles, 'getProjectDataDir').mockReturnValue(root)
  const directory = path.join(root, 'chats', 'saved')
  const source = path.join(directory, 'chat-state.json')
  const raw = JSON.stringify({ version: 1, runState: { retainedState: true }, messages })
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(source, raw)
    const document = await readSavedTranscriptInspection('saved', 'metadata')
    expect(document.rowCount).toBe(3)
    expect(document.provenance?.identity).toBe(source)
    expect(document.notice).toContain('cannot resume or edit')
    expect(await readFile(source, 'utf8')).toBe(raw)
  } finally { await rm(root, { recursive: true, force: true }) }
})
