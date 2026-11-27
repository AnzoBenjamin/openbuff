import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSQLiteIntegrity } from '../sqlite-integrity-check'

test('checks a database read-only while allowing the main event loop to run', async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), 'openbuff-integrity-')),
    'test.sqlite',
  )
  const database = new Database(path, { create: true })
  database.exec('CREATE TABLE fixture (value TEXT)')
  database.close()
  let timerRan = false
  const timer = setTimeout(() => {
    timerRan = true
  }, 0)
  try {
    expect(await checkSQLiteIntegrity(path)).toBe(true)
    expect(timerRan).toBe(true)
  } finally {
    clearTimeout(timer)
  }
})

test('worker failures and deadlines refuse the check and release the worker', async () => {
  await expect(
    checkSQLiteIntegrity('/nonexistent/openbuff-integrity.sqlite'),
  ).rejects.toThrow()
  await expect(
    checkSQLiteIntegrity('/nonexistent/openbuff-integrity.sqlite', 0),
  ).rejects.toThrow()
})
