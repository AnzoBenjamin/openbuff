import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  symlinkSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { open, utimes, type FileHandle } from 'node:fs/promises'

import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'
import { getExactContentHash } from '@codebuff/common/util/content-hash'
import { createNodeFileSystem } from '../node-filesystem'
import { WorkspaceMutationBroker } from '../../services/workspace-mutation-broker'

import {
  TRANSACTION_INTENT_LOG_MAX_ENTRIES_PER_TRANSACTION,
  TRANSACTION_INTENT_LOG_MAX_TRANSACTIONS,
  createTransactionIntentLog,
  createTransactionIntentLogForWorkspace,
  recoverAndRevertInterruptedTransactions,
  revertPathToPreImage,
  transactionIntentLogFileName,
  type TransactionIntentEntry,
} from '../transaction-intent-log'
import { spawn, spawnSync } from 'node:child_process'

let stateDir = ''
let projectDir = ''

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'openbuff-tx-intent-'))
  projectDir = join(stateDir, 'project')
  mkdirSync(projectDir, { recursive: true })
  projectDir = realpathSync(projectDir)
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

function intent(
  path: string,
  before: string | null,
  after: string | null,
): TransactionIntentEntry {
  return {
    path,
    beforeHash: before === null ? null : getExactContentHash(before),
    ...(before === null ? {} : { beforeBytes: before }),
    afterHash: after === null ? null : getExactContentHash(after),
  }
}

function diskIntent(
  path: string,
  before: string | null,
  after: string | null,
): TransactionIntentEntry {
  const canonicalPath = dirname(join(projectDir, path))
  const { dev, ino } = statSync(canonicalPath, { bigint: true })
  return {
    ...intent(path, before, after),
    parent: { canonicalPath, dev: String(dev), ino: String(ino) },
  }
}

const brokerFileSystem = async () =>
  createNodeFileSystem({
    mutationBroker: await WorkspaceMutationBroker.create({
      cwd: projectDir,
      stateDir,
    }),
  })

const mockIntent = (
  path: string,
  before: string | null,
  after: string | null,
): TransactionIntentEntry => ({
  ...intent(path, before, after),
  parent: { canonicalPath: projectDir, dev: '0', ino: '0' },
})

const mockProjectFs = (files: Record<string, string>) =>
  createMockFs({ files, directories: { [projectDir]: [] } })

const begin = (
  log: ReturnType<typeof createTransactionIntentLog>,
  transactionId: string,
  entries: TransactionIntentEntry[] = [{ path: 'a.ts', beforeHash: null }],
) =>
  log.beginTransaction({
    transactionId,
    operationId: `op-${transactionId}`,
    callId: `call-${transactionId}`,
    entries,
  })

describe('transaction intent log round-trips', () => {
  test('begin/commit marks a transaction resolved', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect((await begin(log, 'tx-1')).ok).toBe(true)

    // Before the commit marker the transaction is half-applied.
    const before = await log.recoverInterruptedTransactions()
    expect(before.ok).toBe(true)
    expect(before.ok ? before.transactions : []).toHaveLength(1)

    expect((await log.commitTransaction('tx-1')).ok).toBe(true)
    const after = await log.recoverInterruptedTransactions()
    expect(after.ok).toBe(true)
    expect(after.ok ? after.transactions : []).toEqual([])
  })

  test('begin/abort marks a transaction resolved', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect((await begin(log, 'tx-2')).ok).toBe(true)
    expect((await log.abortTransaction('tx-2', 'user asked')).ok).toBe(true)

    const recovery = await log.recoverInterruptedTransactions()
    expect(recovery.ok).toBe(true)
    expect(recovery.ok ? recovery.transactions : []).toEqual([])
  })

  test('recover reports a half-applied transaction with its entries', async () => {
    const log = createTransactionIntentLog({ stateDir })
    const entries: TransactionIntentEntry[] = [
      { path: 'src/a.ts', beforeHash: 'sha256:aaa', beforeBytes: 'old a' },
      { path: 'src/new.ts', beforeHash: null },
    ]
    expect(
      (
        await log.beginTransaction({
          transactionId: 'tx-3',
          operationId: 'op-3',
          callId: 'call-3',
          entries,
        })
      ).ok,
    ).toBe(true)

    const recovery = await log.recoverInterruptedTransactions()
    expect(recovery.ok).toBe(true)
    expect(recovery.ok ? recovery.transactions : []).toEqual([
      {
        transactionId: 'tx-3',
        operationId: 'op-3',
        entries,
        startedAt: expect.any(String),
      },
    ])
  })
})

describe('transaction intent log crash simulation', () => {
  test.each([0, 1, 2, 3, 4])(
    'recovers a killed coordinator after %i actual group commits',
    async (boundary) => {
      if (process.platform === 'win32') return
      const initial = {
        'first.txt': 'before\r\n',
        'delete.txt': 'retained 🌱\r\n',
        'move.txt': 'move bytes\n',
      }
      for (const [file, content] of Object.entries(initial))
        writeFileSync(join(projectDir, file), content)
      chmodSync(join(projectDir, 'delete.txt'), 0o751)
      const src = resolve(import.meta.dir, '..', '..')
      const intentModule = join(src, 'tools', 'transaction-intent-log.ts')
      const helper = join(stateDir, 'transaction-worker.ts')
      writeFileSync(
        helper,
        `
      import { changeFiles } from ${JSON.stringify(join(src, 'tools', 'change-file.ts'))}
      import { createNodeFileSystem } from ${JSON.stringify(join(src, 'tools', 'node-filesystem.ts'))}
      import { WorkspaceMutationBroker } from ${JSON.stringify(join(src, 'services', 'workspace-mutation-broker.ts'))}
      import { createTransactionIntentLogForWorkspace } from ${JSON.stringify(intentModule)}
      import { getContentHash } from ${JSON.stringify(resolve(src, '../../common/src/util/content-hash.ts'))}
      const [cwd, stateDir, rawBoundary] = process.argv.slice(2)
      const boundary = Number(rawBoundary)
      const stop = async () => {
        const keepAlive = setInterval(() => {}, 1000)
        try {
          process.stdout.write('READY\\n')
          await new Promise(() => {})
        } finally { clearInterval(keepAlive) }
      }
      const fs = createNodeFileSystem({ mutationBroker: await WorkspaceMutationBroker.create({ cwd, stateDir }) })
      const log = createTransactionIntentLogForWorkspace({ cwd, stateDir })
      const begin = log.beginTransaction
      log.beginTransaction = async (params) => {
        const result = await begin(params)
        if (result.ok && boundary === 0) await stop()
        return result
      }
      let reached = 0
      for (const kind of ['conditionalCommit', 'createFileExclusive', 'conditionalDelete', 'conditionalMove']) {
        const operation = fs[kind].bind(fs)
        fs[kind] = async (...args) => {
          const result = await operation(...args)
          if (kind !== 'createFileExclusive' && !result.applied) throw new Error('Expected commit did not land: ' + kind)
          if (++reached === boundary) await stop()
          return result
        }
      }
      const result = await changeFiles({ cwd, fs, intentLog: log, parameters: [
        { type: 'file', path: 'first.txt', content: 'after\\n', expectedHash: getContentHash('before\\r\\n') },
        { type: 'file', path: 'created.txt', content: 'created\\n', expectedHash: null },
        { type: 'delete', path: 'delete.txt', expectedHash: getContentHash('retained 🌱\\r\\n') },
        { type: 'move', path: 'move.txt', destinationPath: 'moved.txt', expectedHash: getContentHash('move bytes\\n'), destinationExpectedHash: null },
      ] })
      throw new Error('Coordinator should stop at the selected commit boundary: ' + JSON.stringify(result))
    `,
      )
      const child = Bun.spawn(
        [
          process.execPath,
          '--no-env-file',
          helper,
          projectDir,
          stateDir,
          String(boundary),
        ],
        {
          env: { PATH: '/usr/bin:/bin' },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const marker = await Promise.race([
          (async () => {
            let received = ''
            const reader = child.stdout.getReader()
            try {
              for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                received += Buffer.from(value).toString('utf8')
                if (received.includes('READY\n')) return received
              }
            } finally {
              reader.releaseLock()
            }
            throw new Error(
              `Helper exited before its commit boundary: ${await new Response(child.stderr).text()}`,
            )
          })(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Commit boundary timed out')),
              4_000,
            )
          }),
        ])
        expect(marker).toContain('READY\n')
        const log = createTransactionIntentLogForWorkspace({
          cwd: projectDir,
          stateDir,
        })
        const events = () =>
          readFileSync(log.filePath, 'utf8')
            .trim()
            .split('\n')
            .map(
              (line) =>
                JSON.parse(line) as {
                  kind: string
                  through?: number
                  entries?: unknown[]
                  recovered?: boolean
                },
            )
        expect(events().map((event) => event.kind)).toEqual([
          'tx_begin',
          ...Array<string>(boundary).fill('tx_dispatch'),
        ])
        expect(events()[0]?.entries).toEqual([
          expect.objectContaining({
            path: 'first.txt',
            beforeHash: getExactContentHash(initial['first.txt']),
            afterHash: getExactContentHash('after\n'),
            parent: expect.any(Object),
          }),
          expect.objectContaining({
            path: 'created.txt',
            beforeHash: null,
            afterHash: getExactContentHash('created\n'),
          }),
          expect.objectContaining({
            path: 'delete.txt',
            beforeHash: getExactContentHash(initial['delete.txt']),
            afterHash: null,
          }),
          expect.objectContaining({
            path: 'moved.txt',
            beforeHash: null,
            afterHash: getExactContentHash(initial['move.txt']),
          }),
          expect.objectContaining({
            path: 'move.txt',
            beforeHash: getExactContentHash(initial['move.txt']),
            afterHash: null,
          }),
        ])
        expect(
          events()
            .slice(1)
            .map((event) => event.through),
        ).toEqual([0, 1, 2, 4].slice(0, boundary))
        const live = await log.recoverInterruptedTransactions()
        expect(live.ok ? live.liveTransactionIds : []).toHaveLength(1)
        child.kill('SIGKILL')
        await child.exited
        expect(child.signalCode).toBe('SIGKILL')
        const broker = await WorkspaceMutationBroker.create({
          cwd: projectDir,
          stateDir,
        })
        const fs = createNodeFileSystem({ mutationBroker: broker })
        const runRecovery = () =>
          recoverAndRevertInterruptedTransactions({
            intentLog: createTransactionIntentLogForWorkspace({
              cwd: projectDir,
              stateDir,
            }),
            cwd: projectDir,
            fs,
          })
        const outcome = await runRecovery()
        if (boundary < 4) {
          expect(outcome).toMatchObject({
            ok: true,
            revertedPaths: boundary,
            recoveredCommittedTransactions: 0,
          })
          for (const [file, content] of Object.entries(initial))
            expect(readFileSync(join(projectDir, file), 'utf8')).toBe(content)
          expect(statSync(join(projectDir, 'delete.txt')).mode & 0o777).toBe(
            0o751,
          )
          expect(existsSync(join(projectDir, 'created.txt'))).toBe(false)
          expect(existsSync(join(projectDir, 'moved.txt'))).toBe(false)
          expect(events().at(-1)?.kind).toBe('tx_abort')
        } else {
          expect(outcome).toMatchObject({
            ok: true,
            revertedPaths: 0,
            recoveredCommittedTransactions: 1,
          })
          expect(readFileSync(join(projectDir, 'first.txt'), 'utf8')).toBe(
            'after\n',
          )
          expect(readFileSync(join(projectDir, 'created.txt'), 'utf8')).toBe(
            'created\n',
          )
          expect(readFileSync(join(projectDir, 'moved.txt'), 'utf8')).toBe(
            initial['move.txt'],
          )
          expect(existsSync(join(projectDir, 'delete.txt'))).toBe(false)
          expect(existsSync(join(projectDir, 'move.txt'))).toBe(false)
          expect(events().at(-1)).toMatchObject({
            kind: 'tx_commit',
            recovered: true,
          })
        }
        expect(await runRecovery()).toMatchObject({
          ok: true,
          revertedPaths: 0,
          recoveredCommittedTransactions: 0,
        })
        if (process.env.OPENBUFF_CAPTURE_B07_BOUNDARIES === '1') {
          console.log(
            'B07_BOUNDARY ' +
              JSON.stringify({
                boundary,
                outcome,
                signal: child.signalCode,
                transitions: events().map(({ kind, through, recovered }) => ({
                  kind,
                  through,
                  recovered,
                })),
                intent: (events()[0]!.entries as TransactionIntentEntry[]).map(
                  ({ path, beforeHash, afterHash, parent }) => ({
                    path,
                    beforeHash,
                    afterHash,
                    parent,
                  }),
                ),
                receipts: (await broker.listReceipts()).map(
                  ({
                    action,
                    path,
                    destinationPath,
                    beforeHash,
                    afterHash,
                    sourceIdentity,
                    stagingIdentity,
                    state,
                  }) => ({
                    action,
                    path,
                    destinationPath,
                    beforeHash,
                    afterHash,
                    sourceIdentity,
                    stagingIdentity,
                    state,
                  }),
                ),
              }),
          )
        }
      } finally {
        if (timeout) clearTimeout(timeout)
        if (child.signalCode === null && child.exitCode === null)
          child.kill('SIGKILL')
        await child.exited
      }
    },
    10_000,
  )
  test('a partial commit restores exact bytes and leaves the never-created path alone', async () => {
    const target = join(projectDir, 'updated.ts')
    const log = createTransactionIntentLog({ stateDir })
    const fs = await brokerFileSystem()
    expect(
      (
        await begin(log, 'tx-crash', [
          diskIntent('updated.ts', 'original\r\n', 'applied\n'),
          diskIntent('created-by-tx.ts', null, 'future'),
        ])
      ).ok,
    ).toBe(true)
    writeFileSync(target, 'applied\n')

    const newLog = createTransactionIntentLog({ stateDir })
    expect(
      await recoverAndRevertInterruptedTransactions({
        intentLog: newLog,
        cwd: projectDir,
        fs,
      }),
    ).toMatchObject({
      ok: true,
      revertedTransactions: 1,
      revertedPaths: 1,
    })
    expect(readFileSync(target, 'utf8')).toBe('original\r\n')
    expect(existsSync(join(projectDir, 'created-by-tx.ts'))).toBe(false)
    expect(
      await recoverAndRevertInterruptedTransactions({
        intentLog: newLog,
        cwd: projectDir,
        fs,
      }),
    ).toMatchObject({
      ok: true,
      revertedTransactions: 0,
    })
  })

  test('recovery removes only the exact postimage of a creation', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect(
      (
        await begin(log, 'tx-cancel', [
          diskIntent('gone.ts', null, 'missing'),
          diskIntent('created.ts', null, 'created'),
        ])
      ).ok,
    ).toBe(true)
    writeFileSync(join(projectDir, 'created.ts'), 'created')
    const fs = await brokerFileSystem()
    expect(
      await recoverAndRevertInterruptedTransactions({
        intentLog: log,
        cwd: projectDir,
        fs,
      }),
    ).toMatchObject({
      ok: true,
      revertedTransactions: 1,
      revertedPaths: 1,
    })
    expect(existsSync(join(projectDir, 'created.ts'))).toBe(false)
    expect(existsSync(join(projectDir, 'gone.ts'))).toBe(false)
  })

  test.skipIf(process.platform === 'win32')(
    'replaced or missing parents block recovery; retry uses the original parent',
    async () => {
      const parent = join(projectDir, 'dir')
      const held = join(projectDir, 'original-parent')
      const outside = join(stateDir, 'outside')
      mkdirSync(parent)
      mkdirSync(outside)
      writeFileSync(join(outside, 'file.ts'), 'applied')
      const fs = await brokerFileSystem()
      const log = createTransactionIntentLog({ stateDir })
      expect(
        (
          await begin(log, 'tx-parent', [
            diskIntent('dir/file.ts', 'original', 'applied'),
            diskIntent('pending.ts', null, 'pending'),
          ])
        ).ok,
      ).toBe(true)
      writeFileSync(join(parent, 'file.ts'), 'applied')
      renameSync(parent, held)
      const recover = () =>
        recoverAndRevertInterruptedTransactions({
          intentLog: log,
          cwd: projectDir,
          fs,
        })
      expect(await recover()).toMatchObject({
        ok: false,
        status: 'recovery_required',
      })
      expect(existsSync(parent)).toBe(false)
      symlinkSync(outside, parent, 'dir')
      expect(await recover()).toMatchObject({
        ok: false,
        status: 'recovery_required',
      })
      expect(readFileSync(join(outside, 'file.ts'), 'utf8')).toBe('applied')
      unlinkSync(parent)
      mkdirSync(parent)
      writeFileSync(join(parent, 'file.ts'), 'applied')
      expect(await recover()).toMatchObject({
        ok: false,
        status: 'recovery_required',
      })
      expect(readFileSync(join(parent, 'file.ts'), 'utf8')).toBe('applied')
      rmSync(parent, { recursive: true })
      renameSync(held, parent)
      expect(await recover()).toMatchObject({
        ok: true,
        revertedTransactions: 1,
        revertedPaths: 1,
      })
      expect(readFileSync(join(parent, 'file.ts'), 'utf8')).toBe('original')
      expect(readFileSync(join(outside, 'file.ts'), 'utf8')).toBe('applied')
    },
  )

  test('read and conditional-write faults leave the intent pending for a fresh retry', async () => {
    const log = createTransactionIntentLog({ stateDir })
    const target = join(projectDir, 'target.txt')
    expect(
      (
        await begin(log, 'faults', [
          diskIntent('target.txt', 'before', 'after'),
          diskIntent('future.txt', null, 'future'),
        ])
      ).ok,
    ).toBe(true)
    writeFileSync(target, 'after')
    const fs = await brokerFileSystem()
    const readFile = fs.readFile
    const conditionalCommit = fs.conditionalCommit
    fs.readFile = (async () => {
      throw new Error('read failed')
    }) as typeof fs.readFile
    const recover = () =>
      recoverAndRevertInterruptedTransactions({
        intentLog: createTransactionIntentLog({ stateDir }),
        cwd: projectDir,
        fs,
      })
    expect(await recover()).toMatchObject({
      ok: false,
      error: 'read failed',
      transactionIds: ['faults'],
    })
    expect(readFileSync(target, 'utf8')).toBe('after')
    fs.readFile = readFile
    fs.conditionalCommit = async () => {
      throw new Error('write failed')
    }
    expect(await recover()).toMatchObject({
      ok: false,
      error: 'write failed',
      transactionIds: ['faults'],
    })
    expect(readFileSync(target, 'utf8')).toBe('after')
    fs.conditionalCommit = conditionalCommit
    expect(await recover()).toMatchObject({ ok: true, revertedPaths: 1 })
    expect(readFileSync(target, 'utf8')).toBe('before')
  })

  test('revertPathToPreImage deletes only when the file still exists', async () => {
    const fs = createMockFs({ files: { [join(projectDir, 'live.ts')]: 'x' } })
    await revertPathToPreImage({
      cwd: projectDir,
      fs,
      entryPath: 'live.ts',
      beforeBytes: null,
    })
    expect(existsSync(join(projectDir, 'live.ts'))).toBe(false)

    // Already absent: a no-op, not an error.
    await revertPathToPreImage({
      cwd: projectDir,
      fs,
      entryPath: 'live.ts',
      beforeBytes: null,
    })
  })

  test('revertPathToPreImage refuses entry paths that escape the workspace', async () => {
    const written: string[] = []
    const removed: string[] = []
    const fs = createMockFs({
      writeFileImpl: async (filePath) => {
        written.push(filePath)
      },
      unlinkImpl: async (filePath) => {
        removed.push(filePath)
      },
    })

    // Relative traversal out of the workspace...
    await expect(
      revertPathToPreImage({
        cwd: projectDir,
        fs,
        entryPath: '../outside-victim.ts',
        beforeBytes: 'tampered',
      }),
    ).rejects.toThrow('not contained in the workspace')
    // ...and an absolute path outside it. Both are refused BEFORE any
    // filesystem mutation happens.
    await expect(
      revertPathToPreImage({
        cwd: projectDir,
        fs,
        entryPath: join(stateDir, 'outside-victim.ts'),
        beforeBytes: 'tampered',
      }),
    ).rejects.toThrow('not contained in the workspace')
    expect(written).toEqual([])
    expect(removed).toEqual([])
  })

  test('a tampered log entry that escapes the workspace fails closed without touching files outside it', async () => {
    const victimPath = join(stateDir, 'outside-victim.ts')
    writeFileSync(victimPath, 'original outside bytes', 'utf8')
    const log = createTransactionIntentLog({ stateDir })
    // A well-formed but tampered tx_begin whose entry path traverses out of
    // the workspace the log guards.
    writeFileSync(
      log.filePath,
      `${JSON.stringify({
        kind: 'tx_begin',
        transactionId: 'tx-escape',
        operationId: 'op-escape',
        callId: 'call-escape',
        startedAt: new Date().toISOString(),
        entries: [
          {
            ...diskIntent('inside.ts', 'before', 'original outside bytes'),
            path: '../outside-victim.ts',
          },
        ],
      })}\n`,
      'utf8',
    )

    const recovery = await recoverAndRevertInterruptedTransactions({
      intentLog: log,
      cwd: projectDir,
      fs: await brokerFileSystem(),
    })
    expect(recovery).toMatchObject({ ok: false, status: 'recovery_required' })
    expect(readFileSync(victimPath, 'utf8')).toBe('original outside bytes')
    const after = await log.recoverInterruptedTransactions()
    expect(
      after.ok ? after.transactions.map((value) => value.transactionId) : [],
    ).toEqual(['tx-escape'])
  })
})

describe('transaction intent log lossless recovery (lost tx_commit)', () => {
  test('a tx_commit append that fails after the bytes were committed does NOT revert the committed content', async () => {
    const log = createTransactionIntentLog({
      stateDir,
      lockTimeoutMs: 50,
      commitRetryDelayMs: 5,
    })
    expect(
      (
        await log.beginTransaction({
          transactionId: 'tx-lost-commit',
          operationId: 'op-lost',
          callId: 'call-lost',
          entries: [
            diskIntent(
              'updated.ts',
              'original\n',
              'committed by the crashed run',
            ),
          ],
        })
      ).ok,
    ).toBe(true)
    // The files were committed; then the tx_commit append hits a transient
    // lock failure: a LIVE holder (this process, with its own published
    // instance token) holds the lock past every bounded retry.
    const token = readFileSync(
      `${log.filePath}.live-${process.pid}`,
      'utf8',
    ).trim()
    writeFileSync(`${log.filePath}.lock`, `${process.pid} ${token}\n`, 'utf8')
    const committed = await log.commitTransaction('tx-lost-commit')
    expect(committed.ok).toBe(false)
    if (!committed.ok) {
      expect(committed.error).toContain('timed out')
    }
    // Release the simulated holder so recovery can append its terminal marker.
    unlinkSync(`${log.filePath}.lock`)

    // Only exact after-state can resolve a lost commit acknowledgement.
    writeFileSync(
      join(projectDir, 'updated.ts'),
      'committed by the crashed run',
    )
    const fs = await brokerFileSystem()
    const recovery = await recoverAndRevertInterruptedTransactions({
      intentLog: log,
      cwd: projectDir,
      fs,
    })
    expect(recovery).toMatchObject({
      ok: true,
      revertedTransactions: 0,
      recoveredCommittedTransactions: 1,
    })
    expect(await fs.readFile(join(projectDir, 'updated.ts'), 'utf-8')).toBe(
      'committed by the crashed run',
    )
    expect(readFileSync(log.filePath, 'utf8')).toContain('"recovered":true')
    const second = await recoverAndRevertInterruptedTransactions({
      intentLog: log,
      cwd: projectDir,
      fs,
    })
    expect(second).toMatchObject({
      ok: true,
      revertedTransactions: 0,
      recoveredCommittedTransactions: 0,
    })
  })

  test('a transient lock failure retries the tx_commit append and lands exactly one commit marker', async () => {
    const log = createTransactionIntentLog({
      stateDir,
      lockTimeoutMs: 200,
      commitRetryDelayMs: 10,
    })
    expect((await begin(log, 'tx-retry-commit')).ok).toBe(true)
    // A transient live holder occupies the lock when the commit marker append
    // starts and releases it a moment later: one of the bounded retries must
    // land the tx_commit line instead of surfacing the lossy failure.
    const token = readFileSync(
      `${log.filePath}.live-${process.pid}`,
      'utf8',
    ).trim()
    writeFileSync(`${log.filePath}.lock`, `${process.pid} ${token}\n`, 'utf8')
    const releaseHolder = setTimeout(() => {
      try {
        unlinkSync(`${log.filePath}.lock`)
      } catch {
        // Already released.
      }
    }, 60)
    const committed = await log.commitTransaction('tx-retry-commit')
    clearTimeout(releaseHolder)
    expect(committed.ok).toBe(true)
    // Exactly one tx_commit line: the retried append did not duplicate it.
    const raw = readFileSync(log.filePath, 'utf8')
    expect(
      raw.split('\n').filter((line) => line.includes('"kind":"tx_commit"')),
    ).toHaveLength(1)
    const recovery = await log.recoverInterruptedTransactions()
    expect(recovery.ok ? recovery.transactions : []).toEqual([])
  })

  test('modern expected-after proof resolves a fully applied transaction as recovered_committed without reverting', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect(
      (
        await begin(log, 'tx-recovered-commit', [
          intent('a.ts', 'old a', 'new a'),
          intent('created.ts', null, 'created'),
        ])
      ).ok,
    ).toBe(true)
    const revertCalls: string[] = []
    const outcome = await log.revertTransaction(
      'tx-recovered-commit',
      async (entryPath) => {
        revertCalls.push(entryPath)
      },
      async (entryPath) => (entryPath === 'a.ts' ? 'new a' : 'created'),
    )
    expect(outcome).toMatchObject({
      ok: true,
      status: 'recovered_committed',
      revertedPaths: 0,
    })
    expect(revertCalls).toEqual([])
    const recovery = await log.recoverInterruptedTransactions()
    expect(recovery.ok ? recovery.transactions : []).toEqual([])
  })

  test('foreign divergence remains untouched and recovery-required until exact after-state is restored', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect(
      (await begin(log, 'tx-foreign', [intent('a.ts', 'old', 'owned')])).ok,
    ).toBe(true)
    const reverted: string[] = []
    const first = await log.revertTransaction(
      'tx-foreign',
      async (entryPath) => reverted.push(entryPath),
      async () => 'foreign',
    )
    expect(first).toMatchObject({
      ok: false,
      status: 'recovery_required',
      unresolvedPaths: ['a.ts'],
    })
    expect(reverted).toEqual([])
    const pending = await log.recoverInterruptedTransactions()
    expect(
      pending.ok
        ? pending.transactions.map((entry) => entry.transactionId)
        : [],
    ).toContain('tx-foreign')

    const second = await log.revertTransaction(
      'tx-foreign',
      async (entryPath) => reverted.push(entryPath),
      async () => 'owned',
    )
    expect(second).toMatchObject({ ok: true, status: 'reverted' })
    expect(reverted).toEqual(['a.ts'])
  })

  test('modern half-applied recovery reverts only exact transaction-owned after-state', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect(
      (
        await begin(log, 'tx-half-applied', [
          intent('applied.ts', 'old a', 'new a'),
          intent('untouched.ts', 'same', 'new b'),
        ])
      ).ok,
    ).toBe(true)
    const reverted: Array<[string, string | null]> = []
    const outcome = await log.revertTransaction(
      'tx-half-applied',
      async (entryPath, beforeBytes) => {
        reverted.push([entryPath, beforeBytes])
      },
      async (entryPath) => (entryPath === 'applied.ts' ? 'new a' : 'same'),
    )
    expect(outcome).toMatchObject({
      ok: true,
      status: 'reverted',
      revertedPaths: 1,
      ownedPaths: ['applied.ts'],
    })
    expect(reverted).toEqual([['applied.ts', 'old a']])
  })

  test('legacy entries without expected after-state preserve explicit uncertainty and never mutate', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect(
      (
        await begin(log, 'tx-legacy-uncertain', [
          { path: 'legacy.ts', beforeHash: 'sha256:old', beforeBytes: 'old' },
        ])
      ).ok,
    ).toBe(true)
    const reverted: string[] = []
    const outcome = await log.revertTransaction(
      'tx-legacy-uncertain',
      async (entryPath) => reverted.push(entryPath),
      async () => 'different',
    )
    expect(outcome).toMatchObject({
      ok: false,
      status: 'recovery_required',
      unresolvedPaths: ['legacy.ts'],
      uncertainty: 'legacy_missing_after_state',
    })
    expect(reverted).toEqual([])
    const first = await log.recoverInterruptedTransactions()
    const second = await log.recoverInterruptedTransactions()
    expect(first.ok ? first.transactions : []).toHaveLength(1)
    expect(second.ok ? second.transactions : []).toHaveLength(1)
  })
})

describe('transaction intent log durability', () => {
  test('an interleaved commit and later trim cannot evict another unfinished intent', async () => {
    const log = createTransactionIntentLog({ stateDir, maxTransactions: 2 })
    expect((await begin(log, 'first')).ok).toBe(true)
    expect((await begin(log, 'still-active')).ok).toBe(true)
    expect((await log.commitTransaction('first')).ok).toBe(true)
    expect((await begin(log, 'third')).ok).toBe(true)
    const report = await log.recoverInterruptedTransactions()
    expect(
      report.ok ? report.transactions.map((value) => value.transactionId) : [],
    ).toEqual(['still-active', 'third'])
  })

  test('same-process ownership blocks recovery, and an exact but undispatched postimage stays foreign', async () => {
    const log = createTransactionIntentLog({ stateDir })
    const entries = [
      mockIntent('a', 'before A', 'after A'),
      mockIntent('b', 'before B', 'after B'),
    ]
    expect(
      (
        await log.beginTransaction({
          transactionId: 'active',
          operationId: 'op',
          callId: 'call',
          entries,
          inFlight: true,
        })
      ).ok,
    ).toBe(true)
    expect((await log.authorizeDispatch?.('active', 0))?.ok).toBe(true)
    const fresh = createTransactionIntentLog({ stateDir })
    const content = { a: 'after A', b: 'after B' }
    const revert = async (file: string, before: string | null) => {
      content[file as keyof typeof content] = before!
    }
    const read = async (file: string) => content[file as keyof typeof content]
    try {
      expect(
        await fresh.revertTransaction('active', revert, read),
      ).toMatchObject({
        ok: false,
        status: 'recovery_required',
        revertedPaths: 0,
      })
      expect(content).toEqual({ a: 'after A', b: 'after B' })
    } finally {
      log.releaseTransaction?.('active')
    }
    expect(await fresh.revertTransaction('active', revert, read)).toMatchObject(
      {
        ok: false,
        status: 'recovery_required',
        unresolvedPaths: ['b'],
        revertedPaths: 1,
      },
    )
    expect(content).toEqual({ a: 'before A', b: 'after B' })
    expect(await fresh.revertTransaction('active', revert, read)).toMatchObject(
      { ok: false, unresolvedPaths: ['b'], revertedPaths: 0 },
    )
    content.b = 'before B'
    expect(await fresh.revertTransaction('active', revert, read)).toMatchObject(
      { ok: true, status: 'reverted', revertedPaths: 0 },
    )
  })
  test('the 101st transaction drops the oldest finished one', async () => {
    const log = createTransactionIntentLog({ stateDir })
    for (
      let index = 0;
      index < TRANSACTION_INTENT_LOG_MAX_TRANSACTIONS;
      index++
    ) {
      expect((await begin(log, `tx-${index}`)).ok).toBe(true)
      expect((await log.commitTransaction(`tx-${index}`)).ok).toBe(true)
    }
    // Terminal events count against their own transaction, not as new groups.
    let recovery = await log.recoverInterruptedTransactions()
    expect(recovery.ok ? recovery.transactions : []).toEqual([])
    let raw = readFileSync(log.filePath, 'utf8')
    expect(
      raw.split('\n').filter((line) => line.includes('"kind":"tx_begin"')),
    ).toHaveLength(TRANSACTION_INTENT_LOG_MAX_TRANSACTIONS)
    expect(raw).toContain('"tx-0"')
    expect(raw).toContain('"tx-1"')

    // One new transaction evicts exactly the oldest resolved group.
    expect((await begin(log, 'tx-100')).ok).toBe(true)
    recovery = await log.recoverInterruptedTransactions()
    expect(
      recovery.ok ? recovery.transactions.map((tx) => tx.transactionId) : [],
    ).toEqual(['tx-100'])
    raw = readFileSync(log.filePath, 'utf8')
    expect(raw).not.toContain('"tx-0"')
    expect(raw).toContain('"tx-1"')
    expect(raw).toContain('"tx-100"')
    expect(
      raw.split('\n').filter((line) => line.includes('"kind":"tx_begin"')),
    ).toHaveLength(TRANSACTION_INTENT_LOG_MAX_TRANSACTIONS)
  })

  test('the byte cap drops the oldest finished transactions, never unresolved ones', async () => {
    const log = createTransactionIntentLog({
      stateDir,
      maxTransactions: 100,
      maxBytes: 900,
    })
    // Six finished (droppable) transactions, then two half-applied ones.
    for (let index = 0; index < 6; index++) {
      expect((await begin(log, `tx-byte-${index}`)).ok).toBe(true)
      expect((await log.commitTransaction(`tx-byte-${index}`)).ok).toBe(true)
    }
    expect((await begin(log, 'tx-byte-6')).ok).toBe(true)
    expect((await begin(log, 'tx-byte-7')).ok).toBe(true)

    const recovery = await log.recoverInterruptedTransactions()
    expect(
      recovery.ok ? recovery.transactions.map((tx) => tx.transactionId) : [],
    ).toEqual(['tx-byte-6', 'tx-byte-7'])
    // Finished transactions were dropped oldest-first to fit the cap, but
    // the two unresolved ones survive even though they are now the oldest.
    const raw = readFileSync(log.filePath, 'utf8')
    expect(raw).not.toContain('"tx-byte-0"')
    expect(raw).toContain('"tx-byte-6"')
    expect(raw).toContain('"tx-byte-7"')
    // The file itself stays under the cap.
    expect(raw.length).toBeLessThan(900)
  })

  test('trim keeps an unfinished transaction’s entries even when it is the oldest', async () => {
    const log = createTransactionIntentLog({ stateDir, maxTransactions: 3 })
    // The oldest transaction is never resolved: it models a live sibling
    // mid-commit whose terminal marker has not landed yet.
    expect((await begin(log, 'tx-unfinished-oldest')).ok).toBe(true)
    expect((await begin(log, 'tx-fin-a')).ok).toBe(true)
    expect((await log.commitTransaction('tx-fin-a')).ok).toBe(true)
    expect((await begin(log, 'tx-fin-b')).ok).toBe(true)
    expect((await log.commitTransaction('tx-fin-b')).ok).toBe(true)

    // A fourth transaction overflows the count cap; the only droppable group
    // is a finished one, so the OLDEST (unfinished) transaction survives.
    expect((await begin(log, 'tx-newest')).ok).toBe(true)

    const recovery = await log.recoverInterruptedTransactions()
    expect(
      recovery.ok ? recovery.transactions.map((tx) => tx.transactionId) : [],
    ).toEqual(['tx-unfinished-oldest', 'tx-newest'])
    const raw = readFileSync(log.filePath, 'utf8')
    expect(raw).toContain('"tx-unfinished-oldest"')
    expect(raw).toContain('"tx-fin-b"')
    expect(raw).not.toContain('"tx-fin-a"')
  })

  test('an append that cannot fit without evicting an unresolved transaction is rejected', async () => {
    const log = createTransactionIntentLog({ stateDir, maxTransactions: 2 })
    expect((await begin(log, 'tx-half-1')).ok).toBe(true)
    expect((await begin(log, 'tx-half-2')).ok).toBe(true)
    // Both transactions are unresolved, so the third cannot fit without
    // evicting one: a structured failure, and the log is left unchanged.
    const outcome = await begin(log, 'tx-half-3')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('cap')
    }
    const recovery = await log.recoverInterruptedTransactions()
    expect(
      recovery.ok ? recovery.transactions.map((tx) => tx.transactionId) : [],
    ).toEqual(['tx-half-1', 'tx-half-2'])
  })

  test('a single transaction larger than maxBytes is rejected, not silently dropped', async () => {
    const log = createTransactionIntentLog({
      stateDir,
      maxTransactions: 100,
      maxBytes: 512,
    })
    expect((await begin(log, 'tx-keep')).ok).toBe(true)

    const outcome = await log.beginTransaction({
      transactionId: 'tx-huge',
      operationId: 'op-huge',
      callId: 'call-huge',
      entries: [
        {
          path: 'big.ts',
          beforeHash: 'sha256:x',
          beforeBytes: 'x'.repeat(1024),
        },
      ],
    })
    // Oversize must be a structured failure, never ok:true with the
    // just-appended event silently shifted out: the commit path must learn
    // that no durable pre-image was persisted.
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('byte')
    }

    // Nothing was written for the oversized event, and the older recoverable
    // transaction was not destroyed to make room.
    const recovery = await log.recoverInterruptedTransactions()
    expect(
      recovery.ok ? recovery.transactions.map((tx) => tx.transactionId) : [],
    ).toEqual(['tx-keep'])
  })

  test('a corrupted line is tolerated and skipped on read', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect((await begin(log, 'tx-good')).ok).toBe(true)
    const filePath = log.filePath
    writeFileSync(
      filePath,
      `${readFileSync(filePath, 'utf8')}this is not json\n`,
      'utf8',
    )

    const recovery = await log.recoverInterruptedTransactions()
    expect(recovery.ok).toBe(true)
    expect(
      recovery.ok ? recovery.transactions.map((tx) => tx.transactionId) : [],
    ).toEqual(['tx-good'])

    // Appends still work after a corrupted line was skipped.
    expect((await log.commitTransaction('tx-good')).ok).toBe(true)
    const after = await log.recoverInterruptedTransactions()
    expect(after.ok ? after.transactions : []).toEqual([])
  })

  test('revertTransaction on an unknown or resolved transaction is a no-op', async () => {
    const log = createTransactionIntentLog({ stateDir })
    const outcome = await log.revertTransaction('tx-unknown', async () => {
      throw new Error('must never be called')
    })
    expect(outcome).toMatchObject({ ok: true, status: 'already_resolved' })
  })

  test('revertTransaction keeps failed restoration recovery-required for a later retry', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect(
      (
        await log.beginTransaction({
          transactionId: 'tx-fail',
          operationId: 'op-fail',
          callId: 'call-fail',
          entries: [
            intent('a.ts', null, 'created'),
            intent('b.ts', null, 'not yet created'),
          ],
        })
      ).ok,
    ).toBe(true)

    const outcome = await log.revertTransaction(
      'tx-fail',
      async () => {
        throw new Error('disk exploded')
      },
      async (file) => (file === 'a.ts' ? 'created' : null),
    )
    expect(outcome).toMatchObject({
      ok: false,
      status: 'recovery_required',
      error: 'disk exploded',
      revertedPaths: 0,
      unresolvedPaths: ['a.ts'],
    })
    const recovery = await log.recoverInterruptedTransactions()
    expect(
      recovery.ok
        ? recovery.transactions.map((entry) => entry.transactionId)
        : [],
    ).toContain('tx-fail')
  })

  test('per-transaction entry cap is enforced with a structured outcome', async () => {
    const log = createTransactionIntentLog({ stateDir })
    const tooMany: TransactionIntentEntry[] = Array.from(
      { length: TRANSACTION_INTENT_LOG_MAX_ENTRIES_PER_TRANSACTION + 1 },
      (_, index) => ({ path: `f${index}.ts`, beforeHash: null }),
    )
    const outcome = await begin(log, 'tx-big', tooMany)
    expect(outcome).toMatchObject({ ok: false })
  })

  test('a failed beginTransaction does not corrupt the existing log', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect((await begin(log, 'tx-keep')).ok).toBe(true)
    const outcome = await log.beginTransaction({
      transactionId: '',
      operationId: 'op',
      callId: 'call',
      entries: [],
    })
    expect(outcome).toMatchObject({ ok: false })

    const recovery = await log.recoverInterruptedTransactions()
    expect(
      recovery.ok ? recovery.transactions.map((tx) => tx.transactionId) : [],
    ).toEqual(['tx-keep'])
  })

  test('a plain append fsyncs the log file itself and never creates a tmp rewrite', async () => {
    // FileHandle is a type-only binding in this tsconfig, so derive the
    // shared prototype from a real opened handle instead of the constructor
    // (every fs/promises handle shares it, so the spy intercepts the module).
    const probe = await open(join(stateDir, '.fsync-probe'), 'w')
    const handleProto = Object.getPrototypeOf(probe) as FileHandle
    await probe.close()
    const originalSync = handleProto.sync
    // Per fsync: whether some `.tmp` rewrite artifact existed at that moment
    // (true would mean a whole-file read-rewrite happened).
    const syncSawTmpFile: boolean[] = []
    const observedLockModes: number[] = []
    let observedLogPath = ''
    const syncSpy = spyOn(handleProto, 'sync').mockImplementation(
      async function (this: FileHandle) {
        const tmpName = readdirSync(stateDir).find((name) =>
          name.endsWith('.tmp'),
        )
        syncSawTmpFile.push(
          tmpName !== undefined && existsSync(join(stateDir, tmpName)),
        )
        // The append runs while the holder's lock file exists: record its
        // mode to prove the lock artifact is written owner-only too.
        if (observedLogPath !== '') {
          const lockPath = `${observedLogPath}.lock`
          if (existsSync(lockPath)) {
            observedLockModes.push(statSync(lockPath).mode & 0o777)
          }
        }
        await originalSync.call(this)
      },
    )
    try {
      const log = createTransactionIntentLog({ stateDir })
      observedLogPath = log.filePath
      expect((await begin(log, 'tx-append-fsync')).ok).toBe(true)
      expect((await log.commitTransaction('tx-append-fsync')).ok).toBe(true)

      // The append path fsyncs the log file itself...
      expect(syncSawTmpFile.length).toBeGreaterThanOrEqual(2)
      // ...and never touches a tmp rewrite artifact: the whole-file
      // read-rewrite is reserved for the bounded trim.
      expect(syncSawTmpFile.every((sawTmp) => sawTmp === false)).toBe(true)
      // The lock that was held while the appends ran is owner-only.
      expect(observedLockModes.length).toBeGreaterThanOrEqual(1)
      expect(observedLockModes.every((mode) => mode === 0o600)).toBe(true)
    } finally {
      syncSpy.mockRestore()
    }
  })

  test('the bounded trim still fsyncs the tmp file before the rename and the directory after', async () => {
    const probe = await open(join(stateDir, '.fsync-probe'), 'w')
    const handleProto = Object.getPrototypeOf(probe) as FileHandle
    await probe.close()
    const originalSync = handleProto.sync
    // Per fsync: whether the tmp file still existed at the moment the fsync
    // fired (true = before the rename, false = after it).
    const syncSawTmpFile: boolean[] = []
    const observedTmpModes: number[] = []
    const syncSpy = spyOn(handleProto, 'sync').mockImplementation(
      async function (this: FileHandle) {
        const tmpName = readdirSync(stateDir).find((name) =>
          name.endsWith('.tmp'),
        )
        if (tmpName !== undefined && existsSync(join(stateDir, tmpName))) {
          syncSawTmpFile.push(true)
          observedTmpModes.push(statSync(join(stateDir, tmpName)).mode & 0o777)
        } else {
          syncSawTmpFile.push(false)
        }
        await originalSync.call(this)
      },
    )
    try {
      const log = createTransactionIntentLog({ stateDir, maxBytes: 512 })
      // Seed a FINISHED transaction whose lines exceed the byte cap, so the
      // next append must trim — exercising the read-rewrite path.
      writeFileSync(
        log.filePath,
        `${JSON.stringify({
          kind: 'tx_begin',
          transactionId: 'tx-seed',
          operationId: 'op-seed',
          callId: 'call-seed',
          startedAt: new Date().toISOString(),
          ownerPid: process.pid,
          ownerToken: 'seed-token',
          entries: [
            {
              path: 'seed.ts',
              beforeHash: 'sha256:seed',
              beforeBytes: 'x'.repeat(400),
            },
          ],
        })}\n${JSON.stringify({
          kind: 'tx_commit',
          transactionId: 'tx-seed',
          committedAt: new Date().toISOString(),
        })}\n`,
        'utf8',
      )

      expect((await begin(log, 'tx-trim-fsync')).ok).toBe(true)

      // The tmp file's data blocks are flushed BEFORE the rename: without
      // that, a power loss after the rename can leave the log zero-length or
      // truncated and destroy the durable pre-image.
      expect(syncSawTmpFile.length).toBeGreaterThanOrEqual(1)
      expect(syncSawTmpFile[0]).toBe(true)
      // The tmp artifact is owner-only: it becomes the log on rename.
      expect(observedTmpModes.every((mode) => mode === 0o600)).toBe(true)
      // The directory entry holding the rename is flushed AFTER the rename,
      // so the rename itself survives a power cycle. Platforms that reject
      // directory fsync (e.g. Windows) degrade to file-level durability and
      // only issue the first fsync.
      if (syncSawTmpFile.length > 1) {
        expect(syncSawTmpFile[1]).toBe(false)
      }
    } finally {
      syncSpy.mockRestore()
    }
  })
})

describe('transaction intent log append-only growth', () => {
  test('appends grow the file monotonically without rewriting existing bytes', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect((await begin(log, 'tx-grow-1')).ok).toBe(true)
    let previousSize = statSync(log.filePath).size
    let previousContent = readFileSync(log.filePath, 'utf8')
    const assertAppendOnly = () => {
      const size = statSync(log.filePath).size
      const raw = readFileSync(log.filePath, 'utf8')
      // Strictly growing: each append added bytes and removed none.
      expect(size).toBeGreaterThan(previousSize)
      // The previous bytes survive verbatim as an exact prefix: nothing was
      // rewritten in place.
      expect(raw.startsWith(previousContent)).toBe(true)
      previousSize = size
      previousContent = raw
    }

    expect((await log.commitTransaction('tx-grow-1')).ok).toBe(true)
    assertAppendOnly()
    expect((await begin(log, 'tx-grow-2')).ok).toBe(true)
    assertAppendOnly()
    expect(
      (await log.abortTransaction('tx-grow-2', 'changed my mind')).ok,
    ).toBe(true)
    assertAppendOnly()
    expect((await begin(log, 'tx-grow-3')).ok).toBe(true)
    assertAppendOnly()

    // No tmp rewrite artifact was ever created on the append path: the
    // whole-file read-rewrite is reserved for the bounded trim.
    expect(
      readdirSync(stateDir).filter((name) => name.endsWith('.tmp')),
    ).toEqual([])
  })
})

describe('transaction intent log placement', () => {
  test('the log file name is workspace-scoped and lives in the state dir', () => {
    expect(transactionIntentLogFileName('/repo')).toBe(
      transactionIntentLogFileName('/repo'),
    )
    // Distinct projects get distinct files so one workspace never reverts
    // another's half-applied transactions.
    expect(transactionIntentLogFileName('/repo/a')).not.toBe(
      transactionIntentLogFileName('/repo/b'),
    )
    const log = createTransactionIntentLogForWorkspace({
      stateDir,
      cwd: '/repo',
    })
    expect(dirname(log.filePath)).toBe(stateDir)
  })
})

describe('transaction intent log concurrent appenders', () => {
  test('two concurrent begin appends both survive (no lost tx_begin)', async () => {
    // Two log instances sharing one state dir model two openbuff processes
    // (or two parallel changeFiles transactions) appending concurrently.
    const logA = createTransactionIntentLog({ stateDir })
    const logB = createTransactionIntentLog({ stateDir })
    const [a, b] = await Promise.all([begin(logA, 'tx-a'), begin(logB, 'tx-b')])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)

    // Both tx_begin lines are present in the file, in some order.
    const raw = readFileSync(logA.filePath, 'utf8')
    expect(
      raw.split('\n').filter((line) => line.includes('"kind":"tx_begin"')),
    ).toHaveLength(2)

    // Both half-applied transactions are recoverable: neither begin was
    // silently dropped by a concurrent rewrite.
    const recovery = await logA.recoverInterruptedTransactions()
    expect(
      recovery.ok
        ? recovery.transactions.map((tx) => tx.transactionId).sort()
        : [],
    ).toEqual(['tx-a', 'tx-b'])

    // The lock was released, so a later append is not wedged.
    expect(existsSync(`${logA.filePath}.lock`)).toBe(false)
  })

  test('concurrent begin and commit events all land (no lost tx_commit)', async () => {
    const logA = createTransactionIntentLog({ stateDir })
    const logB = createTransactionIntentLog({ stateDir })
    expect((await begin(logA, 'tx-a')).ok).toBe(true)
    expect((await begin(logB, 'tx-b')).ok).toBe(true)

    const [commitA, beginC] = await Promise.all([
      logA.commitTransaction('tx-a'),
      begin(logB, 'tx-c'),
    ])
    expect(commitA.ok).toBe(true)
    expect(beginC.ok).toBe(true)

    const raw = readFileSync(logA.filePath, 'utf8')
    expect(
      raw.split('\n').filter((line) => line.includes('"kind":"tx_commit"')),
    ).toHaveLength(1)
    // tx-a is committed (not recoverable); the two half-applied begins were
    // neither dropped nor misclassified as committed.
    const recovery = await logA.recoverInterruptedTransactions()
    expect(
      recovery.ok
        ? recovery.transactions.map((tx) => tx.transactionId).sort()
        : [],
    ).toEqual(['tx-b', 'tx-c'])
  })

  test('a stale lock left by a crashed process is broken', async () => {
    const log = createTransactionIntentLog({ stateDir })
    const lockPath = `${log.filePath}.lock`
    writeFileSync(lockPath, '', 'utf8')
    const stale = new Date(Date.now() - 40_000)
    await utimes(lockPath, stale, stale)

    // The stale lock must not wedge the log forever.
    expect((await begin(log, 'tx-after-stale')).ok).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })

  test('a waiter never breaks a LIVE holder\u2019s lock (it fails with a timeout instead)', async () => {
    const log = createTransactionIntentLog({ stateDir, lockTimeoutMs: 100 })
    const lockPath = `${log.filePath}.lock`
    // A holder that is alive RIGHT NOW (this test process) holds the lock,
    // with its holder identity recorded exactly as the real holder writes it.
    writeFileSync(lockPath, `${process.pid}\n`, 'utf8')

    const outcome = await begin(log, 'tx-waiter')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('timed out')
    }
    // The LIVE holder's lock was NOT broken by the waiter.
    expect(existsSync(lockPath)).toBe(true)
  })

  test('a lock whose recorded holder is dead is broken without waiting for staleness', async () => {
    // A process that has already exited gives a provably dead pid.
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    if (exited.pid === undefined) {
      throw new Error('could not spawn a liveness probe process')
    }
    const log = createTransactionIntentLog({ stateDir, lockTimeoutMs: 300 })
    const lockPath = `${log.filePath}.lock`
    writeFileSync(lockPath, `${exited.pid}\n`, 'utf8')

    expect((await begin(log, 'tx-after-dead-holder')).ok).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })
})

describe('transaction intent log recovery liveness guard', () => {
  test('a half-applied transaction owned by a LIVE sibling process is not reverted', async () => {
    // A second openbuff process sharing this state dir mid multi-file commit:
    // its tx_commit has not been appended yet, so the transaction looks
    // half-applied, but its owner is a live process OTHER than this one.
    // (This test process cannot stand in for the sibling: a transaction whose
    // ownerPid is process.pid is this process's OWN half-applied work, which
    // its own recovery pass still reverts.)
    const sibling = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { stdio: 'ignore' },
    )
    if (sibling.pid === undefined) {
      throw new Error('could not spawn a liveness probe process')
    }
    try {
      const log = createTransactionIntentLog({
        stateDir,
        ownerPid: sibling.pid,
      })
      expect((await begin(log, 'tx-sibling-live')).ok).toBe(true)

      const fs = createMockFs({
        files: {
          [join(projectDir, 'a.ts')]: 'committed by the live sibling',
        },
      })
      const recovery = await recoverAndRevertInterruptedTransactions({
        intentLog: log,
        cwd: projectDir,
        fs,
      })
      // Liveness guard: nothing is reverted while the foreign owner is alive.
      expect(recovery).toMatchObject({
        ok: false,
        status: 'recovery_required',
        revertedTransactions: 0,
        transactionIds: ['tx-sibling-live'],
      })
      expect(await fs.readFile(join(projectDir, 'a.ts'), 'utf-8')).toBe(
        'committed by the live sibling',
      )
      // The live-owned transaction stays pending (skipped, not aborted), so a
      // later recovery pass can still act on it once the owner dies.
      const pending = await log.recoverInterruptedTransactions()
      expect(pending.ok ? pending.transactions : []).toEqual([])
    } finally {
      sibling.kill()
    }
  })

  test('a half-applied transaction owned by a DEAD process is reverted', async () => {
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    if (exited.pid === undefined) {
      throw new Error('could not spawn a liveness probe process')
    }
    const log = createTransactionIntentLog({ stateDir, ownerPid: exited.pid })
    expect(
      (
        await log.beginTransaction({
          transactionId: 'tx-sibling-dead',
          operationId: 'op-dead',
          callId: 'call-dead',
          entries: [
            mockIntent(
              'updated.ts',
              'original\n',
              'committed by the dead sibling',
            ),
            mockIntent('untouched.ts', 'same', 'future'),
          ],
        })
      ).ok,
    ).toBe(true)

    const fs = mockProjectFs({
      [join(projectDir, 'updated.ts')]: 'committed by the dead sibling',
      [join(projectDir, 'untouched.ts')]: 'same',
    })
    const recovery = await recoverAndRevertInterruptedTransactions({
      intentLog: log,
      cwd: projectDir,
      fs,
    })
    // The owner is gone, so the half-applied transaction is reverted from its
    // durable pre-image exactly like a crashed process: only the diverged
    // path is restored, the matching one is left untouched.
    expect(recovery).toMatchObject({
      ok: true,
      revertedTransactions: 1,
      revertedPaths: 1,
      recoveredCommittedTransactions: 0,
    })
    expect(await fs.readFile(join(projectDir, 'updated.ts'), 'utf-8')).toBe(
      'original\n',
    )
    expect(await fs.readFile(join(projectDir, 'untouched.ts'), 'utf-8')).toBe(
      'same',
    )
  })

  test('a RECYCLED pid with a different instance token no longer defers the revert', async () => {
    // The dead writer's tx_begin recorded a pid that a DIFFERENT process now
    // occupies: the token file next to the log carries the new occupant's
    // instance token, which cannot match the dead writer's recorded token —
    // with a bare pid liveness check this half-applied transaction would be
    // deferred forever (pid reuse swallowing startup recovery).
    const sibling = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { stdio: 'ignore' },
    )
    if (sibling.pid === undefined) {
      throw new Error('could not spawn a liveness probe process')
    }
    try {
      const log = createTransactionIntentLog({
        stateDir,
        ownerPid: sibling.pid,
      })
      expect(
        (
          await log.beginTransaction({
            transactionId: 'tx-recycled-pid',
            operationId: 'op-recycled',
            callId: 'call-recycled',
            entries: [
              mockIntent(
                'updated.ts',
                'original\n',
                'committed by the dead writer',
              ),
              mockIntent('untouched.ts', 'same', 'future'),
            ],
          })
        ).ok,
      ).toBe(true)
      // The recycled pid's NEW occupant published its own token over the
      // dead writer's recorded one.
      writeFileSync(
        `${log.filePath}.live-${sibling.pid}`,
        'token-of-the-new-occupant\n',
        'utf8',
      )

      const freshLog = createTransactionIntentLog({ stateDir })
      const fs = mockProjectFs({
        [join(projectDir, 'updated.ts')]: 'committed by the dead writer',
        [join(projectDir, 'untouched.ts')]: 'same',
      })
      const recovery = await recoverAndRevertInterruptedTransactions({
        intentLog: freshLog,
        cwd: projectDir,
        fs,
      })
      // The pid is alive but it is NOT the original writer: revert instead
      // of deferring forever.
      expect(recovery).toMatchObject({
        ok: true,
        revertedTransactions: 1,
        revertedPaths: 1,
        recoveredCommittedTransactions: 0,
      })
      expect(await fs.readFile(join(projectDir, 'updated.ts'), 'utf-8')).toBe(
        'original\n',
      )
    } finally {
      sibling.kill()
    }
  })

  test('a live coordinator with a missing token must not authorize recovery', async () => {
    const sibling = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { stdio: 'ignore' },
    )
    if (sibling.pid === undefined) {
      throw new Error('could not spawn a liveness probe process')
    }
    try {
      const log = createTransactionIntentLog({
        stateDir,
        ownerPid: sibling.pid,
      })
      expect(
        (
          await log.beginTransaction({
            transactionId: 'tx-missing-token',
            operationId: 'op-missing',
            callId: 'call-missing',
            entries: [
              mockIntent('a.ts', null, 'half-applied'),
              mockIntent('kept.ts', 'kept content', 'future'),
            ],
            inFlight: true,
          })
        ).ok,
      ).toBe(true)
      log.releaseTransaction?.('tx-missing-token')
      unlinkSync(`${log.filePath}.live-${sibling.pid}`)

      const fs = mockProjectFs({
        [join(projectDir, 'a.ts')]: 'half-applied',
        [join(projectDir, 'kept.ts')]: 'kept content',
      })
      const freshLog = createTransactionIntentLog({ stateDir })
      const recovery = await recoverAndRevertInterruptedTransactions({
        intentLog: freshLog,
        cwd: projectDir,
        fs,
      })
      expect(recovery).toMatchObject({
        ok: false,
        status: 'recovery_required',
        revertedPaths: 0,
        transactionIds: ['tx-missing-token'],
      })
      expect(await fs.readFile(join(projectDir, 'a.ts'), 'utf8')).toBe(
        'half-applied',
      )
      expect(await fs.readFile(join(projectDir, 'kept.ts'), 'utf8')).toBe(
        'kept content',
      )
    } finally {
      sibling.kill()
    }
  })

  test('an unowned legacy begin stays uncertain, even with an old ambiguous commit marker', async () => {
    const log = createTransactionIntentLog({ stateDir })
    writeFileSync(
      log.filePath,
      `${JSON.stringify({
        kind: 'tx_begin',
        transactionId: 'tx-legacy',
        operationId: 'op-legacy',
        callId: 'call-legacy',
        startedAt: new Date().toISOString(),
        // Half-applied shape: the applied legacy.ts diverges from its
        // pre-image while the second staged path still matches its own.
        entries: [
          {
            path: 'legacy.ts',
            beforeHash: 'sha256:legacy',
            beforeBytes: 'before\n',
          },
          {
            path: 'untouched.ts',
            beforeHash: 'sha256:same',
            beforeBytes: 'same',
          },
        ],
      })}\n${JSON.stringify({ kind: 'tx_ambiguous_commit', transactionId: 'tx-legacy', ambiguousAt: new Date().toISOString(), divergedPaths: ['legacy.ts'] })}\n`,
      'utf8',
    )

    const fs = createMockFs({
      files: {
        [join(projectDir, 'legacy.ts')]: 'after',
        [join(projectDir, 'untouched.ts')]: 'same',
      },
    })
    const recovery = await recoverAndRevertInterruptedTransactions({
      intentLog: log,
      cwd: projectDir,
      fs,
    })
    expect(recovery).toMatchObject({
      ok: false,
      status: 'recovery_required',
      revertedPaths: 0,
      transactionIds: ['tx-legacy'],
    })
    expect(await fs.readFile(join(projectDir, 'legacy.ts'), 'utf8')).toBe(
      'after',
    )
  })

  test('tx_begin records the owning process id for the recovery liveness guard', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect((await begin(log, 'tx-owned')).ok).toBe(true)
    const raw = readFileSync(log.filePath, 'utf8')
    expect(raw).toContain(`"ownerPid":${process.pid}`)
  })
})

describe('transaction intent log pre-image file mode', () => {
  test.skipIf(process.platform === 'win32')(
    'crash restoration recreates a deleted file with its recorded mode',
    async () => {
      const fs = await brokerFileSystem()
      const log = createTransactionIntentLog({ stateDir })
      expect(
        (
          await begin(log, 'tx-mode', [
            { ...diskIntent('app.sh', 'old\r\n', null), beforeMode: 0o751 },
            diskIntent('future.txt', null, 'not yet created'),
          ])
        ).ok,
      ).toBe(true)
      const report = await recoverAndRevertInterruptedTransactions({
        intentLog: log,
        cwd: projectDir,
        fs,
      })
      expect(report).toMatchObject({
        ok: true,
        revertedTransactions: 1,
        revertedPaths: 1,
      })
      const target = join(projectDir, 'app.sh')
      expect(readFileSync(target, 'utf8')).toBe('old\r\n')
      expect(statSync(target).mode & 0o777).toBe(0o751)
      expect(existsSync(join(projectDir, 'future.txt'))).toBe(false)
    },
  )

  test('a postimage with a foreign mode does not prove ownership', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect(
      (
        await begin(log, 'tx-mode-conflict', [
          {
            ...intent('plain.txt', 'before', 'after'),
            beforeMode: 0o644,
            afterMode: 0o644,
          },
        ])
      ).ok,
    ).toBe(true)
    const reversed: string[] = []
    expect(
      await log.revertTransaction(
        'tx-mode-conflict',
        async (file) => reversed.push(file),
        async () => ({
          hash: getExactContentHash('after'),
          mode: 0o755,
        }),
      ),
    ).toMatchObject({
      ok: false,
      status: 'recovery_required',
      unresolvedPaths: ['plain.txt'],
    })
    expect(reversed).toEqual([])
  })

  test('the log and its identity artifacts are written owner-only (0o600)', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect((await begin(log, 'tx-mode-600')).ok).toBe(true)
    // The log persists plaintext pre-images in the shared state dir: it must
    // not be readable by group/other.
    expect(statSync(log.filePath).mode & 0o777).toBe(0o600)
    // The liveness-token file is a pre-image-adjacent artifact: owner-only.
    expect(statSync(`${log.filePath}.live-${process.pid}`).mode & 0o777).toBe(
      0o600,
    )
  })
})

describe('transaction intent log lock identity (pid-recycle guard)', () => {
  test('a LIVE holder with a matching token is never broken (timeout instead)', async () => {
    const token = 'token-of-the-live-holder'
    const log = createTransactionIntentLog({
      stateDir,
      ownerToken: token,
      lockTimeoutMs: 100,
    })
    const lockPath = `${log.filePath}.lock`
    // A live holder holds the lock with its identity recorded exactly as the
    // real holder writes it (`<pid> <token>`), and its token file is published.
    writeFileSync(`${log.filePath}.live-${process.pid}`, `${token}\n`, 'utf8')
    writeFileSync(lockPath, `${process.pid} ${token}\n`, 'utf8')

    const outcome = await begin(log, 'tx-waiter-live-holder')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('timed out')
    }
    // The LIVE holder's lock was NOT broken by the waiter.
    expect(existsSync(lockPath)).toBe(true)
  })

  test('a lock whose recorded pid was RECYCLED (token mismatch) is broken instead of wedging', async () => {
    // The dead holder crashed holding the lock; its pid was recycled to a
    // live sibling process that published its OWN instance token. The bare
    // pid liveness check would treat the recycled pid as a live holder and
    // wedge EVERY later append forever; the token mismatch breaks the lock.
    const sibling = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { stdio: 'ignore' },
    )
    if (sibling.pid === undefined) {
      throw new Error('could not spawn a liveness probe process')
    }
    try {
      const log = createTransactionIntentLog({
        stateDir,
        ownerToken: 'token-of-the-waiter',
        lockTimeoutMs: 300,
      })
      const lockPath = `${log.filePath}.lock`
      // The new occupant's token file carries a DIFFERENT token than the
      // dead writer recorded in the lock.
      writeFileSync(
        `${log.filePath}.live-${sibling.pid}`,
        'token-of-the-new-occupant\n',
        'utf8',
      )
      writeFileSync(
        lockPath,
        `${sibling.pid} token-of-the-dead-writer\n`,
        'utf8',
      )

      expect((await begin(log, 'tx-after-recycled-holder')).ok).toBe(true)
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      sibling.kill()
    }
  })

  test('a token-bearing lock whose token file is missing is broken (fail-open, not wedged)', async () => {
    // A holder that recorded its identity but never published (or whose
    // token file was removed) cannot be distinguished from a dead one that a
    // recycled pid now occupies: fail open toward breaking the lock rather
    // than wedging every later append.
    const sibling = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { stdio: 'ignore' },
    )
    if (sibling.pid === undefined) {
      throw new Error('could not spawn a liveness probe process')
    }
    try {
      const log = createTransactionIntentLog({
        stateDir,
        ownerToken: 'token-of-the-waiter',
        lockTimeoutMs: 300,
      })
      const lockPath = `${log.filePath}.lock`
      writeFileSync(
        lockPath,
        `${sibling.pid} token-with-no-token-file\n`,
        'utf8',
      )

      expect((await begin(log, 'tx-after-tokenless-lock')).ok).toBe(true)
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      sibling.kill()
    }
  })

  test('a legacy pid-only lock from a live holder keeps the conservative never-break behavior', async () => {
    // A lock written by an older build (pid only, no token) whose pid is
    // alive: it cannot be distinguished from a recycled pid, so it must NOT
    // be broken on age alone (the old behavior) — the waiter times out.
    const log = createTransactionIntentLog({
      stateDir,
      lockTimeoutMs: 100,
    })
    const lockPath = `${log.filePath}.lock`
    writeFileSync(lockPath, `${process.pid}\n`, 'utf8')

    const outcome = await begin(log, 'tx-waiter-legacy-lock')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('timed out')
    }
    expect(existsSync(lockPath)).toBe(true)
  })

  test('a breaker does NOT unlink a lock a FRESH holder acquired in between', async () => {
    // A dead holder crashed holding the lock; the waiter decides to break
    // it. During the seam-widened window between the break decision and the
    // unlink, a fresh live holder acquires the lock and records its own
    // identity: pid AND instance token no longer match what the breaker
    // observed, so the fresh lock must survive (unlinking it would allow
    // dual writers).
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    if (exited.pid === undefined) {
      throw new Error('could not spawn a liveness probe process')
    }
    const log = createTransactionIntentLog({
      stateDir,
      ownerPid: exited.pid,
      ownerToken: 'token-of-the-waiter',
      lockTimeoutMs: 1_500,
      lockBreakConfirmDelayMs: 400,
    })
    const lockPath = `${log.filePath}.lock`
    writeFileSync(lockPath, `${exited.pid} token-of-the-dead-holder\n`, 'utf8')

    const outcomePromise = begin(log, 'tx-race-waiter')
    // While the breaker sits inside its decision→confirmation window, the
    // fresh holder takes the lock and publishes its token file.
    await new Promise((resolve) => setTimeout(resolve, 100))
    writeFileSync(
      lockPath,
      `${process.pid} token-of-the-fresh-holder\n`,
      'utf8',
    )
    writeFileSync(
      `${log.filePath}.live-${process.pid}`,
      'token-of-the-fresh-holder\n',
      'utf8',
    )

    const outcome = await outcomePromise
    // The fresh holder's lock was NOT unlinked by the stale breaker.
    expect(existsSync(lockPath)).toBe(true)
    expect(readFileSync(lockPath, 'utf8')).toBe(
      `${process.pid} token-of-the-fresh-holder\n`,
    )
    // The waiter gave up with the structured timeout instead of racing the
    // fresh holder.
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('timed out')
    }
  })
})
