import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  exportLocalFeedback,
  readLocalFeedback,
  saveLocalFeedback,
} from '../feedback-storage'

let configDir = ''
afterEach(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
  configDir = ''
})

function createConfigDir(): string {
  configDir = mkdtempSync(path.join(tmpdir(), 'openbuff-feedback-test-'))
  return configDir
}

test('stores minimal feedback privately and exports without overwriting', async () => {
  const configDir = createConfigDir()
  const saved = await saveLocalFeedback(
    {
      category: 'app_bug',
      text: '  The prompt card did not render.  ',
      messageId: 'message-1',
    },
    {
      configDir,
      now: new Date('2026-11-24T12:00:00.000Z'),
      id: 'feedback-1',
    },
  )

  expect(saved.record).toEqual({
    id: 'feedback-1',
    createdAt: '2026-11-24T12:00:00.000Z',
    category: 'app_bug',
    text: 'The prompt card did not render.',
    messageId: 'message-1',
  })
  expect(statSync(saved.filePath).mode & 0o777).toBe(0o600)
  expect(await readLocalFeedback(configDir)).toEqual([saved.record])

  const exportedPath = await exportLocalFeedback('feedback-export.jsonl', {
    configDir,
    cwd: configDir,
  })
  expect(await readFile(exportedPath, 'utf8')).toBe(
    `${JSON.stringify(saved.record)}\n`,
  )
  expect(statSync(exportedPath).mode & 0o777).toBe(0o600)
  await expect(
    exportLocalFeedback('feedback-export.jsonl', { configDir, cwd: configDir }),
  ).rejects.toThrow()
})

test('rejects empty or oversized feedback and malformed local records', async () => {
  const configDir = createConfigDir()
  await expect(
    saveLocalFeedback({ category: 'other', text: '  ' }, { configDir }),
  ).rejects.toThrow('cannot be empty')
  await expect(
    saveLocalFeedback(
      { category: 'other', text: 'x'.repeat(20 * 1024 + 1) },
      { configDir },
    ),
  ).rejects.toThrow('20 KiB')

  await writeFile(path.join(configDir, 'feedback.jsonl'), '{invalid json}\n')
  await expect(readLocalFeedback(configDir)).rejects.toThrow(
    'Invalid local feedback record on line 1',
  )
})

test('refuses to read a symlink in the local feedback store', async () => {
  if (process.platform === 'win32') return
  const configDir = createConfigDir()
  const sourcePath = path.join(configDir, 'source.txt')
  const feedbackPath = path.join(configDir, 'feedback.jsonl')
  await writeFile(sourcePath, '{"private":"not feedback"}\n')
  symlinkSync(sourcePath, feedbackPath)

  await expect(readLocalFeedback(configDir)).rejects.toThrow()
})
