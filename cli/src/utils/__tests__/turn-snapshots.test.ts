import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  createTurnSnapshot,
  listTurnSnapshots,
  restoreToTurn,
  undoLastTurn,
  TURN_SNAPSHOT_REF,
} from '../turn-snapshots'

const execFileAsync = promisify(execFile)

/**
 * Hermeticity: every test runs git ONLY inside a per-test temp repo, and the
 * module under test receives an explicit `projectRoot`, so the openbuff
 * repo's own git state (index, HEAD, refs) is never touched.
 */
const isolatedEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: isolatedEnv,
  })
  return stdout
}

async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, 'rev-parse', 'HEAD')).trim()
}

async function stagedFiles(cwd: string): Promise<string[]> {
  return (await git(cwd, 'diff', '--cached', '--name-only'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

async function initTempRepo(): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'openbuff-turn-snapshots-test-'))
  await git(root, 'init')
  await git(root, 'config', 'user.email', 'test@example.com')
  await git(root, 'config', 'user.name', 'Test')
  writeFileSync(path.join(root, 'tracked.txt'), 'v1\n')
  await git(root, 'add', 'tracked.txt')
  await git(root, 'commit', '-m', 'initial')
  return root
}

describe('turn-snapshots', () => {
  let repoRoot: string
  let plainDir: string

  const rootsToClean: string[] = []

  beforeEach(async () => {
    repoRoot = await initTempRepo()
    rootsToClean.push(repoRoot)
    plainDir = mkdtempSync(path.join(tmpdir(), 'openbuff-turn-snapshots-plain-'))
    rootsToClean.push(plainDir)
  })

  afterEach(() => {
    while (rootsToClean.length > 0) {
      const dir = rootsToClean.pop()
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  describe('createTurnSnapshot', () => {
    test('creates a snapshot on the private ref and returns the sha', async () => {
      const before = await headSha(repoRoot)

      const outcome = await createTurnSnapshot({
        projectRoot: repoRoot,
        label: 'turn-1',
      })

      expect(outcome.status).toBe('created')
      if (outcome.status !== 'created') return
      expect(outcome.label).toBe('turn-1')
      expect(outcome.sha).toMatch(/^[0-9a-f]{40}$/)

      // HEAD never moves; the private ref points at the snapshot.
      expect(await headSha(repoRoot)).toBe(before)
      expect((await git(repoRoot, 'rev-parse', TURN_SNAPSHOT_REF)).trim()).toBe(
        outcome.sha,
      )
    })

    test('chains snapshots: parent of snapshot 2 is snapshot 1', async () => {
      const first = await createTurnSnapshot({ projectRoot: repoRoot, label: 't1' })
      writeFileSync(path.join(repoRoot, 'tracked.txt'), 'v2\n')
      const second = await createTurnSnapshot({ projectRoot: repoRoot, label: 't2' })

      expect(first.status).toBe('created')
      expect(second.status).toBe('created')
      if (first.status !== 'created' || second.status !== 'created') return
      expect(first.sha).not.toBe(second.sha)
      expect((await git(repoRoot, 'rev-parse', `${second.sha}^`)).trim()).toBe(
        first.sha,
      )
    })

    test('is skipped when the tracked tree is unchanged since the last snapshot', async () => {
      expect(
        (await createTurnSnapshot({ projectRoot: repoRoot, label: 't1' })).status,
      ).toBe('created')
      const outcome = await createTurnSnapshot({ projectRoot: repoRoot, label: 't2' })
      expect(outcome.status).toBe('skipped')
    })

    test('never captures untracked files (tracked-tree gate)', async () => {
      writeFileSync(path.join(repoRoot, 'untracked.txt'), 'scratch\n')

      const outcome = await createTurnSnapshot({ projectRoot: repoRoot, label: 't1' })
      expect(outcome.status).toBe('created')

      const listed = await listTurnSnapshots({ projectRoot: repoRoot })
      // The snapshot tree only contains tracked.txt: recover it and confirm
      // no untracked entry exists in the tree.
      const tree = (
        await git(repoRoot, 'ls-tree', '--name-only', listed[0]!.sha)
      )
        .split('\n')
        .filter((line) => line.length > 0)
      expect(tree).toEqual(['tracked.txt'])
    })

    test('is unavailable outside a git repo', async () => {
      const outcome = await createTurnSnapshot({
        projectRoot: plainDir,
        label: 'nope',
      })
      expect(outcome.status).toBe('unavailable')
    })
  })

  describe('listTurnSnapshots', () => {
    test('walks the parent chain newest-first', async () => {
      await createTurnSnapshot({ projectRoot: repoRoot, label: 'first' })
      writeFileSync(path.join(repoRoot, 'tracked.txt'), 'v2\n')
      await createTurnSnapshot({ projectRoot: repoRoot, label: 'second' })

      const listed = await listTurnSnapshots({ projectRoot: repoRoot })
      expect(listed.map((entry) => entry.label)).toEqual(['second', 'first'])
      for (const entry of listed) {
        expect(entry.sha).toMatch(/^[0-9a-f]{40}$/)
        expect(entry.timestamp).toBeGreaterThan(0)
      }
    })

    test('returns [] outside a git repo', async () => {
      expect(await listTurnSnapshots({ projectRoot: plainDir })).toEqual([])
    })
  })

  describe('undoLastTurn', () => {
    test('restores a deleted tracked file and leaves index/HEAD/untracked alone', async () => {
      await createTurnSnapshot({ projectRoot: repoRoot, label: 't1' })
      writeFileSync(path.join(repoRoot, 'tracked.txt'), 'v2\n')
      await createTurnSnapshot({ projectRoot: repoRoot, label: 't2' })

      // Simulate the last turn's uncommitted changes: delete a tracked file,
      // stage an unrelated file, and drop an untracked file that must
      // survive the undo.
      rmSync(path.join(repoRoot, 'tracked.txt'))
      writeFileSync(path.join(repoRoot, 'extra.txt'), 'extra\n')
      await git(repoRoot, 'add', 'extra.txt')
      writeFileSync(path.join(repoRoot, 'untracked.txt'), 'scratch\n')
      const headBefore = await headSha(repoRoot)

      const outcome = await undoLastTurn({ projectRoot: repoRoot })

      expect(outcome.status).toBe('undone')
      if (outcome.status !== 'undone') return
      expect(outcome.toSha).toMatch(/^[0-9a-f]{40}$/)

      // Deleted tracked file is back with its snapshot content.
      expect(existsSync(path.join(repoRoot, 'tracked.txt'))).toBe(true)

      // The real index is untouched: extra.txt stays staged.
      expect(await stagedFiles(repoRoot)).toEqual(['extra.txt'])

      // HEAD never moves.
      expect(await headSha(repoRoot)).toBe(headBefore)

      // Untracked files are never removed.
      expect(existsSync(path.join(repoRoot, 'untracked.txt'))).toBe(true)

      // The private ref is kept: newer snapshots are not deleted.
      expect(
        (await listTurnSnapshots({ projectRoot: repoRoot })).length,
      ).toBe(2)
    })

    test('is nothing-to-undo with no snapshots', async () => {
      const outcome = await undoLastTurn({ projectRoot: repoRoot })
      expect(outcome.status).toBe('nothing-to-undo')
    })

    test('is unavailable outside a git repo', async () => {
      const outcome = await undoLastTurn({ projectRoot: plainDir })
      expect(outcome.status).toBe('unavailable')
    })
  })

  describe('restoreToTurn', () => {
    test('restores the working tree to an earlier snapshot', async () => {
      await createTurnSnapshot({ projectRoot: repoRoot, label: 't1' })
      const firstSha = (
        await git(repoRoot, 'rev-parse', TURN_SNAPSHOT_REF)
      ).trim()

      writeFileSync(path.join(repoRoot, 'tracked.txt'), 'v2\n')
      const second = await createTurnSnapshot({ projectRoot: repoRoot, label: 't2' })
      expect(second.status).toBe('created')

      const outcome = await restoreToTurn(firstSha, { projectRoot: repoRoot })
      expect(outcome.status).toBe('restored')
      if (outcome.status !== 'restored') return
      expect(outcome.sha).toBe(firstSha)

      expect(
        readFileSync(path.join(repoRoot, 'tracked.txt'), 'utf8'),
      ).toBe('v1\n')

      // HEAD and the private ref are untouched by the restore.
      expect((await git(repoRoot, 'rev-parse', TURN_SNAPSHOT_REF)).trim()).toBe(
        second.status === 'created' ? second.sha : '',
      )
    })

    test('is not-found for an unknown sha', async () => {
      await createTurnSnapshot({ projectRoot: repoRoot, label: 't1' })
      const outcome = await restoreToTurn('0'.repeat(40), {
        projectRoot: repoRoot,
      })
      expect(outcome.status).toBe('not-found')
    })

    test('is unavailable outside a git repo', async () => {
      const outcome = await restoreToTurn('0'.repeat(40), {
        projectRoot: plainDir,
      })
      expect(outcome.status).toBe('unavailable')
    })
  })
})
