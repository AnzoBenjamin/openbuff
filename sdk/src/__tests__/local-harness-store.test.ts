import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { afterEach, describe, expect, test } from 'bun:test'

import { LocalHarnessStore } from '../services/local-harness-store'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function makeRecord(revision = 0) {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1 as const,
    id: 'task-1',
    revision,
    repositoryId: 'repo-1',
    workspaceId: 'workspace-1',
    runId: 'run-1',
    snapshotId: 'snapshot-1',
    createdAt: now,
    updatedAt: now,
    phase: 'active',
  }
}

describe('LocalHarnessStore', () => {
  test('atomically persists and reads scoped records', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-harness-'))
    roots.push(root)
    const store = new LocalHarnessStore(root)
    store.put('tasks', makeRecord())

    expect(store.read('repo-1', 'tasks', 'task-1')).toMatchObject({
      id: 'task-1',
      revision: 0,
      phase: 'active',
    })
    expect(
      fs
        .readdirSync(path.join(root, 'repo-1', 'tasks'))
        .some((name) => name.includes('.tmp.')),
    ).toBe(false)
  })

  test('enforces compare-and-swap revisions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-harness-'))
    roots.push(root)
    const store = new LocalHarnessStore(root)
    store.put('tasks', makeRecord())
    expect(() => store.put('tasks', makeRecord(1), 4)).toThrow(
      'expected 4, current 0',
    )
    expect(store.put('tasks', makeRecord(1), 0).revision).toBe(1)
  })

  test('rejects traversal-shaped ids', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-harness-'))
    roots.push(root)
    const store = new LocalHarnessStore(root)
    expect(() => store.read('../repo', 'tasks', 'task-1')).toThrow(
      'Invalid harness repository id',
    )
  })

  test('rejects corrupt records instead of silently trusting them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-harness-'))
    roots.push(root)
    const filePath = path.join(root, 'repo-1', 'tasks', 'task-1.json')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({ id: 'task-1' }))
    const store = new LocalHarnessStore(root)
    expect(() => store.read('repo-1', 'tasks', 'task-1')).toThrow(
      'Invalid harness record',
    )
  })

  test('quarantines corrupt records while listing healthy records', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-harness-'))
    roots.push(root)
    const store = new LocalHarnessStore(root)
    store.put('tasks', makeRecord())
    const corruptPath = path.join(root, 'repo-1', 'tasks', 'task-bad.json')
    fs.writeFileSync(corruptPath, '{not json')

    const listed = store.listWithDiagnostics('repo-1', 'tasks')
    expect(listed.records.map((record) => record.id)).toEqual(['task-1'])
    expect(listed.diagnostics).toHaveLength(1)
    expect(listed.diagnostics[0]).toMatchObject({ filePath: corruptPath })
    expect(listed.diagnostics[0]?.quarantinedPath).toBeDefined()
    expect(fs.existsSync(corruptPath)).toBe(false)
    expect(fs.existsSync(listed.diagnostics[0]!.quarantinedPath!)).toBe(true)
  })

  test('serializes compare-and-swap across processes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-harness-'))
    roots.push(root)
    const store = new LocalHarnessStore(root)
    store.put('tasks', makeRecord())
    const gate = path.join(root, 'gate')
    const servicePath = path.resolve(
      import.meta.dir,
      '..',
      'services',
      'local-harness-store.ts',
    )

    const startChild = (name: string) => {
      const ready = path.join(root, `ready-${name}`)
      const code = `
        import fs from 'node:fs';
        import { LocalHarnessStore } from ${JSON.stringify(servicePath)};
        const store = new LocalHarnessStore(${JSON.stringify(root)});
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(wait, 0, 0, 5);
        const now = new Date().toISOString();
        try {
          store.put('tasks', ${JSON.stringify(makeRecord(1))}, 0);
          console.log('ok');
        } catch (error) {
          console.log(error instanceof Error ? error.message : String(error));
        }
      `
      const child = spawn(process.execPath, ['-e', code], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += String(chunk)))
      child.stderr.on('data', (chunk) => (stderr += String(chunk)))
      const completed = new Promise<string>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (exitCode) => {
          if (exitCode === 0) resolve(stdout.trim())
          else reject(new Error(stderr || `child exited ${exitCode}`))
        })
      })
      return { ready, completed }
    }

    const first = startChild('first')
    const second = startChild('second')
    const wait = new Int32Array(new SharedArrayBuffer(4))
    const deadline = Date.now() + 5_000
    while (
      (!fs.existsSync(first.ready) || !fs.existsSync(second.ready)) &&
      Date.now() < deadline
    ) {
      Atomics.wait(wait, 0, 0, 5)
    }
    expect(fs.existsSync(first.ready)).toBe(true)
    expect(fs.existsSync(second.ready)).toBe(true)
    fs.writeFileSync(gate, 'go')

    const outcomes = await Promise.all([first.completed, second.completed])
    expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(1)
    expect(
      outcomes.filter((outcome) => outcome.includes('revision conflict')),
    ).toHaveLength(1)
    expect(store.read('repo-1', 'tasks', 'task-1')?.revision).toBe(1)
  })

  test('lock reclaim verifies the recorded owner is dead, not just stale mtime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-harness-lock-'))
    roots.push(root)
    const store = new LocalHarnessStore(root)
    const internal = store as unknown as {
      isFilesystemLockOwnerDead: (ownerFilePath: string) => boolean
    }
    const ownerPath = path.join(root, 'kind.lock', 'owner.json')
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true })
    const writeOwner = (owner: Record<string, unknown>) => {
      fs.writeFileSync(ownerPath, JSON.stringify(owner))
    }

    // A lock whose recorded owner is this live process must not be
    // reclaimable on mtime alone: this is the slow-holder steal race.
    writeOwner({ pid: process.pid, acquiredAt: Date.now() })
    expect(internal.isFilesystemLockOwnerDead(ownerPath)).toBe(false)

    // A genuinely dead owner (an exited child process) is safe to reclaim.
    const dead = spawn(process.execPath, ['-e', ''])
    const deadPid = dead.pid!
    await new Promise<void>((resolve) => dead.on('close', () => resolve()))
    writeOwner({ pid: deadPid, acquiredAt: Date.now() })
    expect(internal.isFilesystemLockOwnerDead(ownerPath)).toBe(true)

    // A malformed owner record falls back to reclaimable so a corrupt lock
    // can still be recovered.
    fs.writeFileSync(ownerPath, 'not json')
    expect(internal.isFilesystemLockOwnerDead(ownerPath)).toBe(true)
  })

  test('release is ownership-verified: a stale holder does not delete a stolen lock', () => {
    const root = fs.mkdtempSync(path.join(
      os.tmpdir(),
      'openbuff-harness-lock2-',
    ))
    roots.push(root)
    const store = new LocalHarnessStore(root)
    const lockPath = path.join(root, 'repo-1', 'approvals.lock')

    store.withKindLock('repo-1', 'approvals', () => {
      // Simulate a lock steal inside the critical section: the owner record
      // now belongs to the new owner, not to this holder.
      fs.writeFileSync(
        path.join(lockPath, 'owner.json'),
        JSON.stringify({
          pid: process.pid,
          acquiredAt: Date.now(),
          token: 'foreign-owner-token',
        }),
      )
    })

    // The stale holder's release must leave the new owner's lock intact
    // instead of deleting it out from under them.
    expect(fs.existsSync(lockPath)).toBe(true)
    expect(
      JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')),
    ).toMatchObject({ token: 'foreign-owner-token' })
  })

  test('reclaim deletes the lock dir only when the displaced owner is still dead', async () => {
    const root = fs.mkdtempSync(path.join(
      os.tmpdir(),
      'openbuff-harness-lock3-',
    ))
    roots.push(root)
    const store = new LocalHarnessStore(root)
    const internal = store as unknown as {
      reclaimStaleFilesystemLock: (lockPath: string) => boolean
    }
    const lockPath = path.join(root, 'repo-1', 'approvals.lock')

    // A lock dir whose recorded owner is this live process must survive the
    // reclaim even when the caller already judged the lock stale: this is the
    // competing-waiter re-acquire race.
    fs.mkdirSync(lockPath, { recursive: true })
    fs.writeFileSync(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token: 'live' }),
    )
    expect(internal.reclaimStaleFilesystemLock(lockPath)).toBe(false)
    expect(fs.existsSync(lockPath)).toBe(true)
    expect(
      JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')),
    ).toMatchObject({ token: 'live' })
    // No displaced scratch copies of the live lock remain.
    expect(
      fs
        .readdirSync(path.dirname(lockPath))
        .filter((name) => name.includes('.reclaim.')),
    ).toEqual([])

    // A genuinely dead owner is reclaimable at delete time.
    const dead = spawn(process.execPath, ['-e', ''])
    const deadPid = dead.pid!
    await new Promise<void>((resolve) => dead.on('close', () => resolve()))
    fs.writeFileSync(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({ pid: deadPid, acquiredAt: Date.now(), token: 'dead' }),
    )
    expect(internal.reclaimStaleFilesystemLock(lockPath)).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
    expect(
      fs
        .readdirSync(path.dirname(lockPath))
        .filter((name) => name.includes('.reclaim.')),
    ).toEqual([])
  })

  test('reclaim removes the displaced scratch lock dir when the restore races a newer waiter', () => {
    const root = fs.mkdtempSync(path.join(
      os.tmpdir(),
      'openbuff-harness-lock4-',
    ))
    roots.push(root)
    const store = new LocalHarnessStore(root)
    const internal = store as unknown as {
      reclaimStaleFilesystemLock: (lockPath: string) => boolean
    }
    const lockPath = path.join(root, 'repo-1', 'approvals.lock')
    // A live owner holds the lock when this waiter's reclaim displaces it, so
    // the reclaim takes the restore path instead of deleting.
    fs.mkdirSync(lockPath, { recursive: true })
    fs.writeFileSync(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token: 'live' }),
    )

    // Simulate a newer waiter re-acquiring the lock path between the
    // displacement and the restore: the restore rename fails atomically and
    // the newer waiter's own lock dir is in place.
    const originalRename = fs.renameSync
    fs.renameSync = ((from: string, to: string) => {
      if (to === lockPath) {
        fs.mkdirSync(lockPath, { recursive: true })
        fs.writeFileSync(
          path.join(lockPath, 'owner.json'),
          JSON.stringify({
            pid: process.pid,
            acquiredAt: Date.now(),
            token: 'newer-waiter',
          }),
        )
        const error = new Error(
          'EEXIST: simulated newer waiter holds the lock path',
        ) as NodeJS.ErrnoException
        error.code = 'EEXIST'
        throw error
      }
      return originalRename(from, to)
    }) as typeof fs.renameSync
    let reclaimed: boolean
    try {
      reclaimed = internal.reclaimStaleFilesystemLock(lockPath)
    } finally {
      fs.renameSync = originalRename
    }
    expect(reclaimed).toBe(false)

    // The newer waiter's lock survived...
    expect(
      JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')),
    ).toMatchObject({ token: 'newer-waiter' })
    // ...and the losing waiter left no `.reclaim.*` scratch dirs behind.
    expect(
      fs
        .readdirSync(path.dirname(lockPath))
        .filter((name) => name.includes('.reclaim.')),
    ).toEqual([])
  })
})
