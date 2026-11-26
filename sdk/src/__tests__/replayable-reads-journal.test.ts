import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createRunJournal } from '@codebuff/agent-runtime/util/run-journal'

import { OpenbuffClient } from '../client'
import { openReplayableReadJournal } from '../services/replayable-reads'

describe.skipIf(process.platform !== 'linux')(
  'replayable read journal storage',
  () => {
    let root: string
    let file: string

    beforeEach(() => {
      root = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), 'openbuff-read-journal-'),
      )
      file = path.join(root, 'journal.sqlite')
    })

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true })
    })

    test('creates and reopens an owner-only database and SQLite sidecars', async () => {
      const journal = openReplayableReadJournal(file)
      try {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600)
        for (const name of fs.readdirSync(root)) {
          expect(fs.statSync(path.join(root, name)).mode & 0o077).toBe(0)
        }
      } finally {
        await journal.close()
      }
      await openReplayableReadJournal(file).close()
    })

    test('refuses a publicly traversable parent or replaceable ancestor without creating a database', () => {
      fs.chmodSync(root, 0o755)
      expect(() => openReplayableReadJournal(file)).toThrow(/private directory/)
      expect(fs.existsSync(file)).toBe(false)

      fs.chmodSync(root, 0o777)
      const parent = path.join(root, 'private')
      fs.mkdirSync(parent, { mode: 0o700 })
      const nested = path.join(parent, 'new.sqlite')
      expect(() => openReplayableReadJournal(nested)).toThrow(
        /trusted ancestors/,
      )
      expect(fs.existsSync(nested)).toBe(false)
    })

    test('refuses symlinked parents, symlink/hardlink files, and public sidecars', () => {
      const target = path.join(root, 'target')
      fs.writeFileSync(target, 'preserve me', { mode: 0o600 })
      fs.symlinkSync(target, file)
      expect(() => openReplayableReadJournal(file)).toThrow(
        /regular, owner-only files/,
      )
      fs.unlinkSync(file)
      fs.linkSync(target, file)
      expect(() => openReplayableReadJournal(file)).toThrow(
        /regular, owner-only files/,
      )
      fs.unlinkSync(file)
      expect(fs.readFileSync(target, 'utf8')).toBe('preserve me')

      const real = path.join(root, 'private')
      const alias = path.join(root, 'alias')
      fs.mkdirSync(real, { mode: 0o700 })
      fs.symlinkSync(real, alias)
      expect(() =>
        openReplayableReadJournal(path.join(alias, 'new.sqlite')),
      ).toThrow(/private directory/)
      expect(fs.readdirSync(real)).toEqual([])

      fs.writeFileSync(file, '', { mode: 0o600 })
      const sidecar = file + '-wal'
      fs.writeFileSync(sidecar, 'preserve WAL', { mode: 0o600 })
      fs.chmodSync(sidecar, 0o644)
      expect(() => openReplayableReadJournal(file)).toThrow(
        /regular, owner-only files/,
      )
      expect(fs.readFileSync(sidecar, 'utf8')).toBe('preserve WAL')
    })

    test('does not admit a journal opened through the generic journal API', async () => {
      fs.writeFileSync(path.join(root, 'input.txt'), 'fixture data')
      // The generic runtime journal, unlike the SDK opener, has not validated
      // ownership, permissions, or the journal path's ancestors.
      const journal = createRunJournal({ path: file })
      try {
        const result = await new OpenbuffClient({
          cwd: root,
        }).runReplayableReads({
          batches: [['input.txt']],
          journal: journal as ReturnType<typeof openReplayableReadJournal>,
        })
        expect(result.runOutcome?.cause?.code).toBe('replay_unavailable')
        expect(result.runOutcome?.cause?.message).toMatch(
          /openReplayableReadJournal/,
        )
        expect(journal.runIds()).toEqual([])
      } finally {
        await journal.close()
      }
    })
  },
)
