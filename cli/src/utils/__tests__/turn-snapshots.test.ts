import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  bisectTurnsPure,
  cancelTurnBisection,
  createTurnSnapshot,
  isTurnBisectionRunning,
  listTurnSnapshots,
  MAX_RETAINED_SNAPSHOTS,
  prunePlanPure,
  pruneTurnSnapshots,
  restoreToTurn,
  runTurnBisection,
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

    test('is skipped while a turn bisection is running (snapshot chain guard)', async () => {
      for (let i = 1; i <= 3; i++) {
        writeFileSync(path.join(repoRoot, 'tracked.txt'), `v${i}\n`)
        await createTurnSnapshot({ projectRoot: repoRoot, label: `v${i}` })
      }

      let releaseProbe: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        releaseProbe = resolve
      })

      // A real in-flight bisection holds the guard while its baseline probe
      // blocks on the gate.
      const bisection = runTurnBisection(
        { projectRoot: repoRoot },
        {
          runTestSuite: async () => {
            await gate
            return false
          },
        },
      )
      expect(isTurnBisectionRunning()).toBe(true)

      const outcome = await createTurnSnapshot({
        projectRoot: repoRoot,
        label: 'mid-bisect',
      })
      expect(outcome.status).toBe('skipped')
      if (outcome.status !== 'skipped') return
      expect(outcome.reason).toMatch(/bisection/)

      releaseProbe()
      const bisectionOutcome = await bisection
      expect(bisectionOutcome.status).toBe('inconclusive')
      expect(isTurnBisectionRunning()).toBe(false)

      // The declined snapshot never touched the private ref: only the three
      // pre-bisect snapshots exist.
      expect(
        (await listTurnSnapshots({ projectRoot: repoRoot })).length,
      ).toBe(3)
    })

    test('accepts a custom label such as shell', async () => {
      await createTurnSnapshot({ projectRoot: repoRoot, label: 'shell' })

      const listed = await listTurnSnapshots({ projectRoot: repoRoot })
      expect(listed[0]?.label).toBe('shell')
    })
  })

  describe('prunePlanPure (SEC retention bound)', () => {
    test('keeps the newest maxRetained and prunes older entries', () => {
      const shas = Array.from({ length: 6 }, (_, i) => `s${i}`)
      expect(prunePlanPure(shas, 4)).toEqual({
        keep: ['s0', 's1', 's2', 's3'],
        prune: ['s4', 's5'],
      })
    })

    test('keeps everything when the chain is within the bound', () => {
      const shas = ['a', 'b']
      expect(prunePlanPure(shas, 50)).toEqual({
        keep: ['a', 'b'],
        prune: [],
      })
      expect(prunePlanPure(['a'], 1)).toEqual({ keep: ['a'], prune: [] })
    })

    test('defaults maxRetained to MAX_RETAINED_SNAPSHOTS', () => {
      expect(MAX_RETAINED_SNAPSHOTS).toBe(50)
      const shas = Array.from({ length: 52 }, (_, i) => `s${i}`)
      const plan = prunePlanPure(shas)
      expect(plan.keep).toHaveLength(50)
      expect(plan.prune).toHaveLength(2)
    })

    test('handles an empty chain', () => {
      expect(prunePlanPure([], 50)).toEqual({ keep: [], prune: [] })
    })
  })

  describe('pruneTurnSnapshots', () => {
    test('keeps at most MAX_RETAINED snapshots reachable from the private ref', async () => {
      // Build a chain longer than the retention bound.
      for (let i = 1; i <= 53; i++) {
        writeFileSync(path.join(repoRoot, 'tracked.txt'), `v${i}\n`)
        const outcome = await createTurnSnapshot({
          projectRoot: repoRoot,
          label: `v${i}`,
        })
        expect(outcome.status).toBe('created')
      }

      // createTurnSnapshot prunes automatically after each update-ref.
      const listed = await listTurnSnapshots({ projectRoot: repoRoot })
      expect(listed.length).toBe(MAX_RETAINED_SNAPSHOTS)
      // The newest snapshot is still the ref tip.
      expect(listed[0]?.label).toBe('v53')
    }, 120_000)

    test('explicit pruneTurnSnapshots call detaches the oldest snapshot via git plumbing', async () => {
      for (let i = 1; i <= 4; i++) {
        writeFileSync(path.join(repoRoot, 'tracked.txt'), `v${i}\n`)
        await createTurnSnapshot({ projectRoot: repoRoot, label: `v${i}` })
      }

      // A small custom bound prunes everything older than the last 2.
      await pruneTurnSnapshots({ projectRoot: repoRoot, maxRetained: 2 })

      const listed = await listTurnSnapshots({ projectRoot: repoRoot })
      expect(listed.map((entry) => entry.label)).toEqual(['v4', 'v3'])
      // A replace ref was created for the graft (git plumbing evidence).
      const replaceRefs = await git(repoRoot, 'for-each-ref', 'refs/replace/')
      expect(replaceRefs.trim().length).toBeGreaterThan(0)
    })

    test('is a no-op below the bound and outside a git repo', async () => {
      await createTurnSnapshot({ projectRoot: repoRoot, label: 't1' })
      await expect(
        pruneTurnSnapshots({ projectRoot: repoRoot }),
      ).resolves.toBeUndefined()
      expect((await listTurnSnapshots({ projectRoot: repoRoot })).length).toBe(1)

      // Outside a git repo: total, never throws.
      await expect(
        pruneTurnSnapshots({ projectRoot: plainDir }),
      ).resolves.toBeUndefined()
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

  describe('turn bisection', () => {
    describe('bisectTurnsPure', () => {
      test('finds the first failing index with bounded, non-repeating probes', async () => {
        const probed: number[] = []
        const result = await bisectTurnsPure(4, async (index) => {
          probed.push(index)
          return index >= 2
        })
        expect(result).toEqual({
          firstFailingIndex: 2,
          probesRun: 3,
          baselineFailed: false,
        })
        // The oldest snapshot is always probed first (baseline check).
        expect(probed[0]).toBe(0)
        // Each index is probed at most once.
        expect(new Set(probed).size).toBe(probed.length)
      })

      test('reports a failing oldest snapshot as an inconclusive baseline', async () => {
        const result = await bisectTurnsPure(4, async () => true)
        expect(result).toEqual({
          firstFailingIndex: null,
          probesRun: 1,
          baselineFailed: true,
        })
      })

      test('reports no failure when every snapshot passes', async () => {
        const result = await bisectTurnsPure(4, async () => false)
        expect(result.firstFailingIndex).toBeNull()
        expect(result.baselineFailed).toBe(false)
        expect(result.probesRun).toBeLessThanOrEqual(4)
      })
    })

    describe('runTurnBisection', () => {
      test('finds the first failing turn and restores the newest tree', async () => {
        const shas: string[] = []
        for (let i = 1; i <= 4; i++) {
          writeFileSync(path.join(repoRoot, 'tracked.txt'), `v${i}\n`)
          const outcome = await createTurnSnapshot({
            projectRoot: repoRoot,
            label: `v${i}`,
          })
          expect(outcome.status).toBe('created')
          if (outcome.status === 'created') {
            shas.push(outcome.sha)
          }
        }

        const outcome = await runTurnBisection(
          { projectRoot: repoRoot },
          {
            runTestSuite: async (entry) =>
              entry.label === 'v3' || entry.label === 'v4',
          },
        )

        expect(outcome.status).toBe('found')
        if (outcome.status !== 'found') return
        expect(outcome.failingLabel).toBe('v3')
        expect(outcome.failingSha).toBe(shas[2])
        expect(outcome.bestSha).toBe(shas[1])
        expect(outcome.probesRun).toBeLessThanOrEqual(4)

        // The tracked tree is back at the newest (pre-bisect) state.
        expect(
          readFileSync(path.join(repoRoot, 'tracked.txt'), 'utf8'),
        ).toBe('v4\n')
      })

      test('keepBestState leaves the tracked tree at the last passing snapshot', async () => {
        for (let i = 1; i <= 4; i++) {
          writeFileSync(path.join(repoRoot, 'tracked.txt'), `v${i}\n`)
          await createTurnSnapshot({ projectRoot: repoRoot, label: `v${i}` })
        }

        const outcome = await runTurnBisection(
          { projectRoot: repoRoot, keepBestState: true },
          {
            runTestSuite: async (entry) =>
              entry.label === 'v3' || entry.label === 'v4',
          },
        )

        expect(outcome.status).toBe('found')
        expect(
          readFileSync(path.join(repoRoot, 'tracked.txt'), 'utf8'),
        ).toBe('v2\n')
      })

      test('is inconclusive when the suite passes at every snapshot', async () => {
        for (let i = 1; i <= 4; i++) {
          writeFileSync(path.join(repoRoot, 'tracked.txt'), `v${i}\n`)
          await createTurnSnapshot({ projectRoot: repoRoot, label: `v${i}` })
        }

        const outcome = await runTurnBisection(
          { projectRoot: repoRoot },
          { runTestSuite: async () => false },
        )

        expect(outcome.status).toBe('inconclusive')
        if (outcome.status !== 'inconclusive') return
        expect(outcome.reason).toBe('no-failure-reproduced')
        // The newest (pre-bisect) state is restored.
        expect(
          readFileSync(path.join(repoRoot, 'tracked.txt'), 'utf8'),
        ).toBe('v4\n')
      })

      test('needs at least three snapshots to bisect', async () => {
        await createTurnSnapshot({ projectRoot: repoRoot, label: 't1' })
        writeFileSync(path.join(repoRoot, 'tracked.txt'), 'v2\n')
        await createTurnSnapshot({ projectRoot: repoRoot, label: 't2' })

        const outcome = await runTurnBisection(
          { projectRoot: repoRoot },
          { runTestSuite: async () => true },
        )
        expect(outcome).toEqual({ status: 'too-few-snapshots', count: 2 })
      })

      test('reports no-snapshots on a fresh repo', async () => {
        const outcome = await runTurnBisection({ projectRoot: repoRoot })
        expect(outcome).toEqual({ status: 'no-snapshots' })
      })

      test('can be cancelled mid-run and still restores the newest tree', async () => {
        for (let i = 1; i <= 4; i++) {
          writeFileSync(path.join(repoRoot, 'tracked.txt'), `v${i}\n`)
          await createTurnSnapshot({ projectRoot: repoRoot, label: `v${i}` })
        }

        const outcome = await runTurnBisection(
          { projectRoot: repoRoot },
          {
            runTestSuite: async () => {
              cancelTurnBisection()
              return false
            },
          },
        )
        expect(outcome.status).toBe('cancelled')
        expect(
          readFileSync(path.join(repoRoot, 'tracked.txt'), 'utf8'),
        ).toBe('v4\n')

        // The cancel flag resets: a fresh run is not immediately cancelled.
        const rerun = await runTurnBisection(
          { projectRoot: repoRoot },
          { runTestSuite: async () => false },
        )
        expect(rerun.status).not.toBe('cancelled')
      })

      test('rejects a second concurrent bisection and clears the in-flight flag', async () => {
        for (let i = 1; i <= 4; i++) {
          writeFileSync(path.join(repoRoot, 'tracked.txt'), `v${i}\n`)
          await createTurnSnapshot({ projectRoot: repoRoot, label: `v${i}` })
        }

        let releaseProbe: () => void = () => {}
        const gate = new Promise<void>((resolve) => {
          releaseProbe = resolve
        })

        // The first run claims the in-flight guard synchronously before its
        // probe blocks on the gate.
        const first = runTurnBisection(
          { projectRoot: repoRoot },
          {
            runTestSuite: async () => {
              await gate
              return false
            },
          },
        )
        expect(isTurnBisectionRunning()).toBe(true)

        // The second run is rejected instead of interleaving checkouts.
        const second = await runTurnBisection({ projectRoot: repoRoot })
        expect(second.status).toBe('error')
        if (second.status !== 'error') return
        expect(second.message).toMatch(/already in flight/)
        expect(isTurnBisectionRunning()).toBe(true)

        releaseProbe()
        const firstOutcome = await first
        expect(firstOutcome.status).toBe('inconclusive')

        // The guard is released when the run ends.
        expect(isTurnBisectionRunning()).toBe(false)
        expect(
          readFileSync(path.join(repoRoot, 'tracked.txt'), 'utf8'),
        ).toBe('v4\n')
      })

      test('reports a mistyped test command as an error, not a failing baseline', async () => {
        for (let i = 1; i <= 4; i++) {
          writeFileSync(path.join(repoRoot, 'tracked.txt'), `v${i}\n`)
          await createTurnSnapshot({ projectRoot: repoRoot, label: `v${i}` })
        }

        // The default runTestSuite spawns a command that cannot start
        // (ENOENT): this is a command-level error, never "suite fails at the
        // OLDEST snapshot".
        const outcome = await runTurnBisection({
          projectRoot: repoRoot,
          command: 'definitely-not-a-real-command-12345',
        })

        expect(outcome.status).toBe('error')
        if (outcome.status !== 'error') return
        expect(outcome.message).toMatch(/could not be run/)

        // The newest snapshot's tree is still restored before the error is
        // reported.
        expect(
          readFileSync(path.join(repoRoot, 'tracked.txt'), 'utf8'),
        ).toBe('v4\n')
      })

      test('an empty test command is a command-level error', async () => {
        for (let i = 1; i <= 3; i++) {
          writeFileSync(path.join(repoRoot, 'tracked.txt'), `v${i}\n`)
          await createTurnSnapshot({ projectRoot: repoRoot, label: `v${i}` })
        }

        const outcome = await runTurnBisection({
          projectRoot: repoRoot,
          command: '   ',
        })
        expect(outcome.status).toBe('error')
        if (outcome.status !== 'error') return
        expect(outcome.message).toMatch(/empty/)
      })
    })
  })
})
