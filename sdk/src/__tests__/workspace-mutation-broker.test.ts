import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  WorkspaceMutationBroker,
  WorkspaceMutationBrokerRecoveryError,
} from '../services/workspace-mutation-broker'
import { changeFiles } from '../tools/change-file'
import { hashFileContent } from '../tools/filesystem-authority'
import { createNodeFileSystem } from '../tools/node-filesystem'

import type { WorkspaceMutationReceipt } from '../services/workspace-mutation-broker'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function makeWorkspace(name: string): Promise<{
  workspace: string
  stateDir: string
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `openbuff-${name}-`))
  roots.push(root)
  const workspace = path.join(root, 'workspace')
  const stateDir = path.join(root, 'state')
  await mkdir(workspace, { recursive: true })
  return { workspace, stateDir }
}

async function fileIdentity(file: string) {
  const { dev, ino } = await lstat(file, { bigint: true })
  return { dev: String(dev), ino: String(ino) }
}

async function parentIdentity(directory: string) {
  return {
    canonicalPath: await realpath(directory),
    ...(await fileIdentity(directory)),
  }
}

function brokerReceipt(file: string): Promise<WorkspaceMutationReceipt> {
  return readFile(file, 'utf8').then((contents) => JSON.parse(contents))
}

async function pendingReceipt(broker: WorkspaceMutationBroker) {
  const directory = path.join(broker.brokerDir, 'pending')
  const names = await readdir(directory)
  expect(names).toHaveLength(1)
  const file = path.join(directory, names[0]!)
  return { file, receipt: await brokerReceipt(file) }
}

function stagedName(receiptId: string, role: 'tmp' | 'delete') {
  return `.openbuff-mutation-${receiptId}.${role}`
}

async function writePendingReceipt(
  broker: WorkspaceMutationBroker,
  receipt: WorkspaceMutationReceipt,
) {
  const file = path.join(
    broker.brokerDir,
    'pending',
    `${String(receipt.brokerRevision).padStart(16, '0')}-${receipt.receiptId}.json`,
  )
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`)
  return file
}

// Inject an I/O fault at the real workspace durability boundary, after the
// operation has published a staging/target entry and before receipt finalization.
function refuseNextWorkspaceSync(
  broker: WorkspaceMutationBroker,
  directory: string,
) {
  const internals = broker as unknown as {
    fsyncDirectory(directory: string, ...options: unknown[]): Promise<void>
  }
  const original = internals.fsyncDirectory.bind(broker)
  internals.fsyncDirectory = async (candidate, ...options) => {
    if (candidate === directory) {
      internals.fsyncDirectory = original
      throw Object.assign(new Error('fixture workspace fsync failure'), {
        code: 'EIO',
      })
    }
    return original(candidate, ...options)
  }
}

describe('WorkspaceMutationBroker', () => {
  test('commits exact bytes, rejects stale hashes, and journals receipts', async () => {
    const { workspace, stateDir } = await makeWorkspace('broker-commit')
    const file = path.join(workspace, 'file.txt')
    const before = Buffer.from('one\r\ntwo\r\n')
    const after = Buffer.from('one\r\ntwo\r\nthree\r\n')
    await writeFile(file, before)
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })

    const committed = await broker.conditionalCommit(
      file,
      after,
      hashFileContent(before),
    )
    expect(committed).toMatchObject({
      applied: true,
      receipt: { authorityKind: 'cooperative_cas', brokerRevision: 1 },
    })
    expect(await readFile(file)).toEqual(after)

    const stale = await broker.conditionalCommit(
      file,
      Buffer.from('wrong\n'),
      hashFileContent(before),
    )
    expect(stale).toMatchObject({
      applied: false,
      actualHash: hashFileContent(after),
      receipt: { authorityKind: 'cooperative_cas', brokerRevision: 2 },
    })
    expect(await readFile(file)).toEqual(after)
    expect(await broker.listReceipts()).toMatchObject([
      {
        state: 'committed',
        parent: await parentIdentity(workspace),
        stagingIdentity: await fileIdentity(file),
      },
      { state: 'rejected', parent: await parentIdentity(workspace) },
    ])
  })

  // 1002 sequential fs-heavy commits: ~2.2s locally, but CI-disk contention
  // pushed this past bun's 5s per-test default (observed 5.06s on PR #93 CI).
  // Explicit 30s budget judges the retention semantics, not runner disk speed.
  test('prunes oldest finalized receipts beyond the retention cap (hr-09 P4.3)', async () => {
    const { workspace, stateDir } = await makeWorkspace('broker-retention')
    const file = path.join(workspace, 'counter.txt')
    await writeFile(file, Buffer.from('0\n'))
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })

    // Drive commits past the retention cap (1000): each conditionalCommit
    // finalizes exactly one receipt, and each finalize prunes the oldest
    // beyond the cap. 1002 receipts => the directory settles at 1000, and
    // the SURVIVORS are the newest (sorted by zero-padded revision).
    let content = Buffer.from('0\n')
    for (let i = 1; i <= 1002; i++) {
      const next = Buffer.from(`${i}\n`)
      const result = await broker.conditionalCommit(
        file,
        next,
        hashFileContent(content),
      )
      expect(result.applied).toBe(true)
      content = next
    }

    // The broker derives repository/workspace ids from the workspace path
    // (broker.repositoryId exposes it); reuse the live broker's own layout.
    const receiptsDir = path.join(
      stateDir,
      broker.repositoryId,
      'mutation-brokers',
      broker.repositoryId,
      'receipts',
    )
    const names = (await fs.promises.readdir(receiptsDir)).sort()
    expect(names.length).toBe(1000)
    // The newest listing window is intact: the last listing-limit receipts
    // are all present, and the two OLDEST (revisions 1 and 2) were pruned.
    expect(names[0]).not.toContain('-0000000000000001-')
    expect(names[1]).not.toContain('-0000000000000002-')
    const listed = await broker.listReceipts()
    expect(listed.length).toBe(500)
    expect(listed[listed.length - 1]).toMatchObject({
      brokerRevision: 1002,
      state: 'committed',
    })
  }, 30_000)

  test('serializes compare-and-swap across Openbuff processes', async () => {
    const { workspace, stateDir } = await makeWorkspace('broker-process-race')
    const file = path.join(workspace, 'file.txt')
    const before = Buffer.from('before\n')
    await writeFile(file, before)
    const gate = path.join(path.dirname(workspace), 'gate')
    const activePath = path.join(path.dirname(workspace), 'active')
    const eventsPath = path.join(path.dirname(workspace), 'events.jsonl')
    const servicePath = path.resolve(
      import.meta.dir,
      '..',
      'services',
      'workspace-mutation-broker.ts',
    )

    const startChild = (name: string, content: string) => {
      const ready = path.join(path.dirname(workspace), `ready-${name}`)
      const code = `
        import fs from 'node:fs';
        import { WorkspaceMutationBroker } from ${JSON.stringify(servicePath)};
        const broker = await WorkspaceMutationBroker.create({
          cwd: ${JSON.stringify(workspace)},
          stateDir: ${JSON.stringify(stateDir)},
        });
        const originalLock = broker.withWorkspaceLock.bind(broker);
        broker.withWorkspaceLock = (operation) => originalLock(async () => {
          fs.writeFileSync(${JSON.stringify(activePath)}, String(process.pid), {flag:'wx'});
          const owner = JSON.parse(fs.readFileSync(broker.brokerDir+'.lock/owner.json','utf8'));
          fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({event:'enter', pid:process.pid, token:owner.token})+'\\n');
          try { await new Promise(resolve=>setTimeout(resolve,25)); return await operation(); }
          finally {
            fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({event:'exit',pid:process.pid,token:owner.token})+'\\n');
            fs.unlinkSync(${JSON.stringify(activePath)});
          }
        });
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(wait, 0, 0, 5);
        const result = await broker.conditionalCommit(
          ${JSON.stringify(file)},
          ${JSON.stringify(content)},
          ${JSON.stringify(hashFileContent(before))},
        );
        console.log(JSON.stringify(result));
      `
      const child = spawn(
        process.execPath,
        ['--no-env-file', '--no-install', '-e', code],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += String(chunk)))
      child.stderr.on('data', (chunk) => (stderr += String(chunk)))
      const completed = new Promise<{ applied: boolean }>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (exitCode) => {
          if (exitCode === 0) resolve(JSON.parse(stdout.trim()))
          else reject(new Error(stderr || `child exited ${exitCode}`))
        })
      })
      return { ready, completed }
    }

    const first = startChild('first', 'first\n')
    const second = startChild('second', 'second\n')
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

    const results = await Promise.all([first.completed, second.completed])
    expect(results.filter((result) => result.applied)).toHaveLength(1)
    const events = (await readFile(eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events.map((event) => event.event)).toEqual([
      'enter',
      'exit',
      'enter',
      'exit',
    ])
    expect(new Set(events.map((event) => event.token)).size).toBe(2)
    console.log(JSON.stringify({ b04: 'broker-real-process', events, results }))
    expect(['first\n', 'second\n']).toContain(await readFile(file, 'utf8'))
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    expect(
      (await broker.listReceipts()).map((receipt) => receipt.state).sort(),
    ).toEqual(['committed', 'rejected'])
  })

  test('an actual exited holder leaves inspectable recovery-required ownership', async () => {
    const { workspace, stateDir } = await makeWorkspace(
      'broker-crashed-process',
    )
    const target = path.join(workspace, 'file.txt')
    await writeFile(target, 'before')
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '--no-install',
        '-e',
        `
      import { WorkspaceMutationBroker } from ${JSON.stringify(path.resolve(import.meta.dir, '../services/workspace-mutation-broker.ts'))};
      const broker=await WorkspaceMutationBroker.create(${JSON.stringify({ cwd: workspace, stateDir })});
      await broker.withWorkspaceLock(async()=>{process.exit(0)});
    `,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(await child.exited).toBe(0)
    const ownerPath = `${broker.brokerDir}.lock/owner.json`
    const owner = await readFile(ownerPath, 'utf8')
    expect(JSON.parse(owner).pid).toBe(child.pid)
    const state = await readFile(path.join(broker.brokerDir, 'state.json'))
    await expect(
      broker.conditionalCommit(target, 'after', hashFileContent('before')),
    ).rejects.toBeInstanceOf(WorkspaceMutationBrokerRecoveryError)
    expect(await readFile(ownerPath, 'utf8')).toBe(owner)
    expect(await readFile(path.join(broker.brokerDir, 'state.json'))).toEqual(
      state,
    )
    expect(await readFile(target, 'utf8')).toBe('before')
    expect(await broker.listReceipts()).toEqual([])
    console.log(
      JSON.stringify({
        b04: 'broker-crash-refusal',
        owner: JSON.parse(owner),
        beforeHash: hashFileContent('before'),
        afterHash: hashFileContent(await readFile(target)),
      }),
    )
  })

  test('supports exclusive create, conditional delete, and no-clobber move', async () => {
    const { workspace, stateDir } = await makeWorkspace('broker-operations')
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    const created = path.join(workspace, 'created.txt')

    expect(await broker.createExclusive(created, 'created\n')).toMatchObject({
      applied: true,
    })
    expect(await broker.createExclusive(created, 'clobber\n')).toMatchObject({
      applied: false,
      actualHash: hashFileContent('created\n'),
    })

    const source = path.join(workspace, 'source.txt')
    const destination = path.join(workspace, 'destination.txt')
    await writeFile(source, 'move me\n')
    expect(
      await broker.conditionalMove(
        source,
        destination,
        hashFileContent('move me\n'),
      ),
    ).toMatchObject({ applied: true })
    expect(fs.existsSync(source)).toBe(false)
    expect(await readFile(destination, 'utf8')).toBe('move me\n')

    await writeFile(source, 'new source\n')
    const collision = await broker.conditionalMove(
      source,
      destination,
      hashFileContent('new source\n'),
    )
    expect(collision).toMatchObject({
      applied: false,
      actualDestinationHash: hashFileContent('move me\n'),
    })
    expect(await readFile(source, 'utf8')).toBe('new source\n')
    expect(await readFile(destination, 'utf8')).toBe('move me\n')

    expect(
      await broker.conditionalDelete(created, hashFileContent('created\n')),
    ).toMatchObject({ applied: true })
    expect(fs.existsSync(created)).toBe(false)
  })

  test('uses exact-byte hashes when rolling back a brokered CRLF transaction', async () => {
    const { workspace, stateDir } = await makeWorkspace('broker-crlf-rollback')
    const first = path.join(workspace, 'first.txt')
    const second = path.join(workspace, 'second.txt')
    await writeFile(first, 'first before\r\n')
    await writeFile(second, 'second before\r\n')
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    const fileSystem = createNodeFileSystem({ mutationBroker: broker })
    const conditionalCommit = fileSystem.conditionalCommit!.bind(fileSystem)
    let commitCount = 0
    fileSystem.conditionalCommit = async (...args) => {
      commitCount += 1
      if (commitCount === 2) {
        // Model a confirmed refusal so the fixture can require a full rollback.
        return {
          applied: false,
          actualHash: hashFileContent(await readFile(second)),
        }
      }
      return conditionalCommit(...args)
    }

    const result = await changeFiles({
      parameters: [
        { type: 'file', path: 'first.txt', content: 'first after\r\n' },
        { type: 'file', path: 'second.txt', content: 'second after\r\n' },
      ],
      cwd: workspace,
      fs: fileSystem,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      outcome: 'rolled_back',
    })
    expect(await readFile(first, 'utf8')).toBe('first before\r\n')
    expect(await readFile(second, 'utf8')).toBe('second before\r\n')
  })

  test.each([
    ['dead', 2_147_483_647],
    ['live', process.pid],
    ['unknown', -1],
  ])('preserves stale %s ownership and refuses writes', async (kind, pid) => {
    const { workspace, stateDir } = await makeWorkspace('broker-stale-lock')
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
      lockTimeoutMs: 30,
      lockPollMs: 2,
    })
    const target = path.join(workspace, 'file.txt')
    await writeFile(target, 'before')
    const stateBefore = await readFile(
      path.join(broker.brokerDir, 'state.json'),
    )
    const lockPath = `${broker.brokerDir}.lock`
    await mkdir(lockPath)
    const owner = JSON.stringify({
      schemaVersion: 1,
      token: `${kind}-generation`,
      pid,
      acquiredAt: new Date(0).toISOString(),
    })
    await writeFile(path.join(lockPath, 'owner.json'), owner)
    await fs.promises.utimes(lockPath, new Date(0), new Date(0))
    await expect(
      broker.conditionalCommit(target, 'after', hashFileContent('before')),
    ).rejects.toThrow(
      kind === 'live' ? 'Timed out acquiring' : 'requires recovery',
    )
    expect(await readFile(target, 'utf8')).toBe('before')
    expect(await readFile(path.join(lockPath, 'owner.json'), 'utf8')).toBe(
      owner,
    )
    expect(await readFile(path.join(broker.brokerDir, 'state.json'))).toEqual(
      stateBefore,
    )
    expect(await broker.listReceipts()).toEqual([])
  })

  test('competing stale observations cannot remove replacement ownership', async () => {
    const { workspace, stateDir } = await makeWorkspace(
      'broker-reclaim-barrier',
    )
    // Create the two brokers sequentially. Concurrent creations contend for
    // the same workspace lock with a 30ms lockTimeoutMs: under full-suite
    // runner load the winning create can hold the lock through initialize()
    // (durable owner write + fsync + recovery scan) for longer than that, and
    // the loser then fails closed with a recovery-required error before this
    // test's stale-observation fixture is even installed (observed as a CI
    // flake at the create() call, not in the behavior under test). The race
    // this test exercises is the competing conditionalCommit barrier below,
    // which is deterministic once both brokers exist.
    const brokers: WorkspaceMutationBroker[] = []
    for (const i of [0, 1]) {
      brokers.push(
        await WorkspaceMutationBroker.create({
          cwd: workspace,
          stateDir,
          lockTimeoutMs: 30,
          lockPollMs: 2,
        }),
      )
    }
    const target = path.join(workspace, 'file.txt')
    await writeFile(target, 'before')
    const lockPath = `${brokers[0]!.brokerDir}.lock`
    const ownerPath = path.join(lockPath, 'owner.json')
    await mkdir(lockPath)
    const dead = JSON.stringify({
      schemaVersion: 1,
      token: 'dead-generation',
      pid: 2_147_483_647,
      acquiredAt: new Date(0).toISOString(),
    })
    const replacement = JSON.stringify({
      schemaVersion: 1,
      token: 'replacement-generation',
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    })
    await writeFile(ownerPath, dead)
    await fs.promises.utimes(lockPath, new Date(0), new Date(0))
    const originalRead = fs.promises.readFile
    const originalRm = fs.promises.rm
    let observed = 0
    let removals = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    fs.promises.readFile = (async (
      ...args: Parameters<typeof originalRead>
    ) => {
      const result = await originalRead(...args)
      if (String(args[0]) === ownerPath && observed < 2) {
        observed++
        if (observed === 2) {
          await writeFile(ownerPath, replacement)
          release()
        }
        await barrier
      }
      return result
    }) as typeof originalRead
    fs.promises.rm = (async (...args: Parameters<typeof originalRm>) => {
      if (String(args[0]) === lockPath) removals++
      return originalRm(...args)
    }) as typeof originalRm
    let outcomes: PromiseSettledResult<unknown>[]
    try {
      outcomes = await Promise.allSettled(
        brokers.map((broker, i) =>
          broker.conditionalCommit(
            target,
            `after-${i}`,
            hashFileContent('before'),
          ),
        ),
      )
    } finally {
      fs.promises.readFile = originalRead
      fs.promises.rm = originalRm
    }
    expect(observed).toBe(2)
    expect(removals).toBe(0)
    expect(
      outcomes!.every(
        (outcome) =>
          outcome.status === 'rejected' &&
          outcome.reason instanceof WorkspaceMutationBrokerRecoveryError,
      ),
    ).toBe(true)
    expect(await readFile(ownerPath, 'utf8')).toBe(replacement)
    expect(await readFile(target, 'utf8')).toBe('before')
    expect(await brokers[0]!.listReceipts()).toEqual([])
  })

  test('reconciles a committed create and removes its attested staging link', async () => {
    const { workspace, stateDir } = await makeWorkspace('broker-recovery')
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    const receiptId = '00000000-0000-4000-8000-000000000001'
    const target = path.join(workspace, 'file.txt')
    const stagingPath = stagedName(receiptId, 'tmp')
    const staging = path.join(workspace, stagingPath)
    const after = 'after\n'
    await writeFile(staging, after)
    await fs.promises.link(staging, target)
    const now = new Date().toISOString()
    await writePendingReceipt(broker, {
      schemaVersion: 1,
      receiptId,
      brokerRevision: 7,
      authorityKind: 'cooperative_cas',
      repositoryId: broker.repositoryId,
      workspaceId: broker.workspaceId,
      action: 'create',
      path: 'file.txt',
      parent: await parentIdentity(workspace),
      expectedHash: null,
      beforeHash: null,
      afterHash: hashFileContent(after),
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
      stagingPath,
      stagingIdentity: await fileIdentity(staging),
    })

    const unlinks: string[] = []
    const unlink = fs.promises.unlink
    fs.promises.unlink = async (file) => {
      if (path.basename(String(file)) === stagingPath)
        unlinks.push(String(file))
      return unlink(file)
    }
    let recovered: WorkspaceMutationBroker
    try {
      recovered = await WorkspaceMutationBroker.create({
        cwd: workspace,
        stateDir,
      })
    } finally {
      fs.promises.unlink = unlink
    }
    expect(unlinks).toHaveLength(1)
    if (process.platform === 'linux') {
      expect(unlinks[0]).toMatch(/^\/proc\/self\/fd\/\d+\//)
    }
    expect(fs.existsSync(staging)).toBe(false)
    expect(await readFile(target, 'utf8')).toBe(after)
    expect(await recovered.listReceipts()).toMatchObject([
      { receiptId, state: 'recovered_committed' },
    ])
  })

  test.each(['directory', 'symlink'] as const)(
    'refuses a replacement %s parent before opening deletion tombstone bytes and retries',
    async (replacement) => {
      const { workspace, stateDir } = await makeWorkspace(
        'broker-replaced-parent',
      )
      const broker = await WorkspaceMutationBroker.create({
        cwd: workspace,
        stateDir,
      })
      const parent = path.join(broker.workspaceRoot, 'src')
      const target = path.join(parent, 'file.txt')
      const original = path.join(path.dirname(workspace), 'original-src')
      const preimage = 'original bytes\n'
      await mkdir(parent)
      await writeFile(target, preimage)
      const proof = await parentIdentity(parent)
      const sourceIdentity = await fileIdentity(target)
      refuseNextWorkspaceSync(broker, proof.canonicalPath)
      await expect(
        broker.conditionalDelete(target, hashFileContent(preimage)),
      ).rejects.toBeInstanceOf(WorkspaceMutationBrokerRecoveryError)
      const { file, receipt } = await pendingReceipt(broker)
      const tombstone = path.basename(receipt.stagingPath!)
      const owned = path.join(original, tombstone)
      await rename(parent, original)
      if (replacement === 'directory') {
        await mkdir(parent)
        await writeFile(path.join(parent, tombstone), preimage)
        expect(await parentIdentity(parent)).not.toEqual(proof)
      } else {
        await fs.promises.symlink(original, parent, 'junction')
      }

      const open = fs.promises.open
      const openedTargets: string[] = []
      fs.promises.open = (async (candidate, ...options) => {
        if (
          [tombstone, 'file.txt'].includes(path.basename(String(candidate)))
        ) {
          openedTargets.push(String(candidate))
        }
        return open(candidate, ...options)
      }) as typeof open
      try {
        await expect(
          WorkspaceMutationBroker.create({ cwd: workspace, stateDir }),
        ).rejects.toBeInstanceOf(WorkspaceMutationBrokerRecoveryError)
      } finally {
        fs.promises.open = open
      }
      expect(openedTargets).toEqual([])
      expect(await brokerReceipt(file)).toMatchObject({
        state: 'recovery_required',
        errorCode: 'RECOVERY_PARENT_CHANGED',
        parent: proof,
        sourceIdentity,
      })
      expect(await readFile(owned, 'utf8')).toBe(preimage)
      expect(await readFile(path.join(parent, tombstone), 'utf8')).toBe(
        preimage,
      )
      expect(await broker.listReceipts()).toEqual([])

      // Keep any foreign replacement as evidence while putting the actual
      // original directory back; the receipt can now finish only its own work.
      const retired = path.join(path.dirname(workspace), 'retired-src')
      await rename(parent, retired)
      await rename(original, parent)
      const retried = await WorkspaceMutationBroker.create({
        cwd: workspace,
        stateDir,
      })
      expect(await readdir(parent)).toEqual([])
      if (replacement === 'directory') {
        expect(await readFile(path.join(retired, tombstone), 'utf8')).toBe(
          preimage,
        )
      }
      expect(await retried.listReceipts()).toMatchObject([
        { receiptId: receipt.receiptId, state: 'recovered_committed' },
      ])
    },
  )

  test('refuses a same-byte foreign tombstone until the owned entry is restored', async () => {
    const { workspace, stateDir } = await makeWorkspace(
      'broker-foreign-staging',
    )
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    const target = path.join(broker.workspaceRoot, 'file.txt')
    const preimage = 'before\n'
    await writeFile(target, preimage)
    refuseNextWorkspaceSync(broker, broker.workspaceRoot)
    await expect(
      broker.conditionalDelete(target, hashFileContent(preimage)),
    ).rejects.toBeInstanceOf(WorkspaceMutationBrokerRecoveryError)
    const { file, receipt } = await pendingReceipt(broker)
    const staging = path.join(broker.workspaceRoot, receipt.stagingPath!)
    const held = path.join(path.dirname(workspace), 'held-tombstone')
    await rename(staging, held)
    await writeFile(staging, preimage)
    expect(await fileIdentity(staging)).not.toEqual(await fileIdentity(held))

    await expect(
      WorkspaceMutationBroker.create({ cwd: workspace, stateDir }),
    ).rejects.toBeInstanceOf(WorkspaceMutationBrokerRecoveryError)
    expect(await brokerReceipt(file)).toMatchObject({
      state: 'recovery_required',
      errorCode: 'RECOVERY_FOREIGN_STAGING',
    })
    expect(await readFile(staging, 'utf8')).toBe(preimage)
    expect(await readFile(held, 'utf8')).toBe(preimage)
    expect(await broker.listReceipts()).toEqual([])

    await rename(
      staging,
      path.join(path.dirname(workspace), 'foreign-tombstone'),
    )
    await rename(held, staging)
    const retried = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    expect(fs.existsSync(staging)).toBe(false)
    expect(await retried.listReceipts()).toMatchObject([
      { receiptId: receipt.receiptId, state: 'recovered_committed' },
    ])
  })

  test('refuses to finish a link/unlink move when just its destination parent was replaced', async () => {
    const { workspace, stateDir } = await makeWorkspace('broker-move-parent')
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    const parent = path.join(broker.workspaceRoot, 'dest')
    const source = path.join(broker.workspaceRoot, 'source.txt')
    const destination = path.join(parent, 'file.txt')
    const original = path.join(path.dirname(workspace), 'original-dest')
    const contents = 'move bytes\n'
    await mkdir(parent)
    await writeFile(source, contents)
    const proof = await parentIdentity(parent)
    refuseNextWorkspaceSync(broker, proof.canonicalPath)
    await expect(
      broker.conditionalMove(source, destination, hashFileContent(contents)),
    ).rejects.toBeInstanceOf(WorkspaceMutationBrokerRecoveryError)
    const { file, receipt } = await pendingReceipt(broker)
    await rename(parent, original)
    await mkdir(parent)
    await fs.promises.link(source, destination)
    expect(await fileIdentity(destination)).toEqual(await fileIdentity(source))

    await expect(
      WorkspaceMutationBroker.create({ cwd: workspace, stateDir }),
    ).rejects.toBeInstanceOf(WorkspaceMutationBrokerRecoveryError)
    expect(await brokerReceipt(file)).toMatchObject({
      state: 'recovery_required',
      errorCode: 'RECOVERY_PARENT_CHANGED',
      parent: await parentIdentity(broker.workspaceRoot),
      destinationParent: proof,
    })
    expect(await readFile(source, 'utf8')).toBe(contents)
    expect(await readFile(destination, 'utf8')).toBe(contents)

    const retired = path.join(path.dirname(workspace), 'retired-dest')
    await rename(parent, retired)
    await rename(original, parent)
    const retried = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    expect(fs.existsSync(source)).toBe(false)
    expect(await readFile(destination, 'utf8')).toBe(contents)
    expect(await readFile(path.join(retired, 'file.txt'), 'utf8')).toBe(
      contents,
    )
    expect(await retried.listReceipts()).toMatchObject([
      { receiptId: receipt.receiptId, state: 'recovered_committed' },
    ])
  })

  test('legacy receipts with matching staging bytes and no parent proof stay unresolved', async () => {
    const { workspace, stateDir } = await makeWorkspace('broker-legacy-proof')
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    const receiptId = '00000000-0000-4000-8000-000000000003'
    const stagingPath = stagedName(receiptId, 'delete')
    const staging = path.join(workspace, stagingPath)
    const expectedHash = hashFileContent('before\n')
    await writeFile(staging, 'before\n')
    const now = new Date().toISOString()
    const pending = await writePendingReceipt(broker, {
      schemaVersion: 1,
      receiptId,
      brokerRevision: 5,
      authorityKind: 'cooperative_cas',
      repositoryId: broker.repositoryId,
      workspaceId: broker.workspaceId,
      action: 'delete',
      path: 'file.txt',
      expectedHash,
      beforeHash: expectedHash,
      afterHash: null,
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
      stagingPath,
    })
    await expect(
      WorkspaceMutationBroker.create({ cwd: workspace, stateDir }),
    ).rejects.toBeInstanceOf(WorkspaceMutationBrokerRecoveryError)
    expect(await brokerReceipt(pending)).toMatchObject({
      state: 'recovery_required',
      errorCode: 'RECOVERY_MISSING_PARENT_PROOF',
    })
    expect(await readFile(staging, 'utf8')).toBe('before\n')
    expect(await broker.listReceipts()).toEqual([])
  })

  test('rechecks the group recovery parent under lock; does not hash or mutate a replacement', async () => {
    const { workspace, stateDir } = await makeWorkspace('broker-group-guard')
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    const parent = path.join(broker.workspaceRoot, 'src')
    await mkdir(parent)
    const target = path.join(parent, 'file.txt')
    const original = path.join(broker.workspaceRoot, 'original')
    const contents = 'postimage\n'
    const expectedHash = hashFileContent(contents)
    await writeFile(target, contents)
    const proof = await parentIdentity(parent)
    const internals = broker as unknown as {
      withWorkspaceLock<T>(operation: () => Promise<T>): Promise<T>
    }
    const originalLock = internals.withWorkspaceLock.bind(broker)
    internals.withWorkspaceLock = (operation) =>
      originalLock(async () => {
        internals.withWorkspaceLock = originalLock
        await rename(parent, original)
        await mkdir(parent)
        await writeFile(target, contents)
        return operation()
      })
    await expect(
      broker.conditionalCommit(target, 'preimage\n', expectedHash, {
        parent: proof,
      }),
    ).rejects.toBeInstanceOf(WorkspaceMutationBrokerRecoveryError)
    await expect(
      broker.conditionalDelete(target, expectedHash, { parent: proof }),
    ).rejects.toBeInstanceOf(WorkspaceMutationBrokerRecoveryError)
    expect(await readFile(target, 'utf8')).toBe(contents)
    expect(await readFile(path.join(original, 'file.txt'), 'utf8')).toBe(
      contents,
    )
    expect(await broker.listReceipts()).toEqual([])
    await rename(parent, path.join(broker.workspaceRoot, 'replacement'))
    await rename(original, parent)
    expect(
      await broker.conditionalDelete(target, expectedHash, { parent: proof }),
    ).toMatchObject({ applied: true })
    expect(fs.existsSync(target)).toBe(false)
  })

  test('guarded recovery refuses a final symlink even if the referent has the expected hash', async () => {
    const { workspace, stateDir } = await makeWorkspace(
      'broker-group-final-symlink',
    )
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    const target = path.join(broker.workspaceRoot, 'file.txt')
    const outside = path.join(path.dirname(workspace), 'other.txt')
    await writeFile(outside, 'postimage\n')
    await fs.promises.symlink(outside, target, 'file')
    const guard = { parent: await parentIdentity(broker.workspaceRoot) }
    const hash = hashFileContent('postimage\n')
    await expect(
      broker.conditionalCommit(target, 'preimage\n', hash, guard),
    ).rejects.toBeInstanceOf(WorkspaceMutationBrokerRecoveryError)
    await expect(
      broker.conditionalDelete(target, hash, guard),
    ).rejects.toBeInstanceOf(WorkspaceMutationBrokerRecoveryError)
    expect((await lstat(target)).isSymbolicLink()).toBe(true)
    expect(await readFile(outside, 'utf8')).toBe('postimage\n')
    expect(await broker.listReceipts()).toEqual([])
  })

  test.skipIf(process.platform === 'win32')(
    'publishes guarded replacement bytes and preimage mode together',
    async () => {
      const { workspace, stateDir } = await makeWorkspace('broker-group-mode')
      const broker = await WorkspaceMutationBroker.create({
        cwd: workspace,
        stateDir,
      })
      const target = path.join(broker.workspaceRoot, 'file.txt')
      await writeFile(target, 'postimage\n', { mode: 0o600 })
      const proof = await parentIdentity(broker.workspaceRoot)
      const mode = fs.constants.S_IFREG | 0o751
      const internals = broker as unknown as {
        fsyncDirectory(directory: string, ...options: unknown[]): Promise<void>
      }
      const sync = internals.fsyncDirectory.bind(broker)
      let publishedMode: number | undefined
      internals.fsyncDirectory = async (directory, ...options) => {
        if (directory === proof.canonicalPath && publishedMode === undefined) {
          publishedMode = (await stat(target)).mode & 0o7777
        }
        return sync(directory, ...options)
      }
      await expect(
        broker.conditionalCommit(
          target,
          'preimage\n',
          hashFileContent('postimage\n'),
          { parent: proof, mode },
        ),
      ).resolves.toMatchObject({ applied: true })
      expect(publishedMode).toBe(0o751)
      expect((await stat(target)).mode & 0o7777).toBe(0o751)
      expect(await readFile(target, 'utf8')).toBe('preimage\n')
    },
  )

  test.skipIf(process.platform === 'win32')(
    'guarded rollback refuses matching bytes with a different mode',
    async () => {
      const { workspace, stateDir } = await makeWorkspace(
        'broker-group-mode-conflict',
      )
      const broker = await WorkspaceMutationBroker.create({
        cwd: workspace,
        stateDir,
      })
      const target = path.join(broker.workspaceRoot, 'file.txt')
      await writeFile(target, 'postimage', { mode: 0o600 })
      const hash = hashFileContent('postimage')
      const guard = {
        parent: await parentIdentity(broker.workspaceRoot),
        expectedMode: 0o644,
      }
      await expect(
        broker.conditionalCommit(target, 'original', hash, guard),
      ).rejects.toMatchObject({ code: 'RECOVERY_MODE_CHANGED' })
      await expect(
        broker.conditionalDelete(target, hash, guard),
      ).rejects.toMatchObject({ code: 'RECOVERY_MODE_CHANGED' })
      expect(await readFile(target, 'utf8')).toBe('postimage')
      expect(await broker.listReceipts()).toEqual([])
    },
  )

  test('isolates workspace state and fails closed for invalid state roots', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'openbuff-broker-isolation-'),
    )
    roots.push(root)
    const firstRoot = path.join(root, 'first')
    const secondRoot = path.join(root, 'second')
    const stateDir = path.join(root, 'state')
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])
    const [first, second] = await Promise.all([
      WorkspaceMutationBroker.create({ cwd: firstRoot, stateDir }),
      WorkspaceMutationBroker.create({ cwd: secondRoot, stateDir }),
    ])
    expect(first.brokerDir).not.toBe(second.brokerDir)
    await expect(
      first.createExclusive(path.join(secondRoot, 'escape.txt'), 'nope'),
    ).rejects.toThrow('outside the broker root')
    await expect(
      WorkspaceMutationBroker.create({
        cwd: firstRoot,
        stateDir: path.join(firstRoot, '.openbuff-state'),
      }),
    ).rejects.toThrow('state must be stored outside the workspace')

    const invalidStateRoot = path.join(root, 'state-file')
    await writeFile(invalidStateRoot, 'not a directory')
    await expect(
      WorkspaceMutationBroker.create({
        cwd: firstRoot,
        stateDir: invalidStateRoot,
      }),
    ).rejects.toThrow()
    expect(await stat(invalidStateRoot).then((value) => value.isFile())).toBe(
      true,
    )
  })

  test('fails closed when an incomplete receipt has an ambiguous workspace state', async () => {
    const { workspace, stateDir } = await makeWorkspace('broker-ambiguous')
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    const target = path.join(workspace, 'file.txt')
    await writeFile(target, 'before\n')
    const sourceIdentity = await fileIdentity(target)
    await writeFile(target, 'external\n')
    const receiptId = '00000000-0000-4000-8000-000000000002'
    const now = new Date().toISOString()
    const pending = await writePendingReceipt(broker, {
      schemaVersion: 1,
      receiptId,
      brokerRevision: 4,
      authorityKind: 'cooperative_cas',
      repositoryId: broker.repositoryId,
      workspaceId: broker.workspaceId,
      action: 'commit',
      path: 'file.txt',
      parent: await parentIdentity(workspace),
      sourceIdentity,
      expectedHash: hashFileContent('before\n'),
      beforeHash: hashFileContent('before\n'),
      afterHash: hashFileContent('after\n'),
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
      stagingPath: stagedName(receiptId, 'tmp'),
    })

    await expect(
      WorkspaceMutationBroker.create({ cwd: workspace, stateDir }),
    ).rejects.toBeInstanceOf(WorkspaceMutationBrokerRecoveryError)
    expect(await brokerReceipt(pending)).toMatchObject({
      state: 'recovery_required',
      errorCode: 'AMBIGUOUS_COMMIT_STATE',
    })
    expect(await readFile(target, 'utf8')).toBe('external\n')
  })
})
