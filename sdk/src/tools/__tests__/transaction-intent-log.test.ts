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
import {
  fileMutationResultV1Schema,
  getConfirmedAppliedActionsV1,
} from '@codebuff/common/tools/results/filesystem'
import {
  getContentHash,
  getExactContentHash,
} from '@codebuff/common/util/content-hash'
import { createHostReadPolicy } from '@codebuff/common/util/project-path-containment'
import { bindHostFileSystem } from '../../services/host-filesystem'
import {
  WORKSPACE_MUTATION_AUTHORITY,
  WorkspaceMutationBroker,
} from '../../services/workspace-mutation-broker'
import { changeFiles } from '../change-file'
import { createNodeFileSystem } from '../node-filesystem'

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

const brokerFileSystem = async () => {
  const broker = await WorkspaceMutationBroker.create({
    cwd: projectDir,
    stateDir,
  })
  return { broker, fs: createNodeFileSystem({ mutationBroker: broker }) }
}

function physicalIdentity(file: string) {
  const { dev, ino, ctimeNs, birthtimeNs, mode } = statSync(file, { bigint: true })
  return { dev, ino, ctimeNs, birthtimeNs, mode }
}

// Leave a real dispatched action committed in the broker, but no terminal
// intent marker or dispatch of the remaining stages. The kill fixture below
// separately exercises interruption of the full changeFiles coordinator.
async function dispatchFirstBrokerAction(
  log: ReturnType<typeof createTransactionIntentLog>,
  transactionId: string,
  entries: [TransactionIntentEntry, ...TransactionIntentEntry[]],
  after: string | null,
  { keepActive = false } = {},
) {
  const { broker, fs } = await brokerFileSystem()
  expect(
    await log.beginTransaction({
      transactionId,
      operationId: `op-${transactionId}`,
      callId: `call-${transactionId}`,
      entries,
      inFlight: true,
    }),
  ).toEqual({ ok: true })
  let committed = false
  try {
    const correlation = {
      transactionId,
      actionId: crypto.randomUUID(),
      from: 0,
      through: 0,
    }
    expect(await log.authorizeDispatch!(transactionId, 0, correlation)).toEqual({
      ok: true,
    })
    const [stage] = entries
    const evidence = { correlation, stages: [stage] }
    const target = join(projectDir, stage.path)
    const result =
      after === null
        ? await broker.conditionalDelete(
            target,
            stage.beforeHash!,
            undefined,
            evidence,
          )
        : await broker.conditionalCommit(
            target,
            after,
            stage.beforeHash,
            undefined,
            evidence,
          )
    expect(result.applied).toBe(true)
    expect(await broker.listReceipts()).toMatchObject([
      {
        receiptId: correlation.actionId,
        path: stage.path,
        correlation,
        state: 'committed',
      },
    ])
    committed = true
    return { broker, fs }
  } finally {
    if (!keepActive || !committed) log.releaseTransaction!(transactionId)
  }
}

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

describe('transaction intent log broker admission', () => {
  test.each(['unbrokered Node', 'virtual CAS'] as const)(
    '%s refuses a configured durable group before intent admission or workspace effects',
    async (adapter) => {
      const fs =
        adapter === 'unbrokered Node'
          ? createNodeFileSystem()
          : Object.assign(createMockFs({ directories: { [projectDir]: [] } }), {
              mutationAuthority: WORKSPACE_MUTATION_AUTHORITY,
            })
      const intentLog = createTransactionIntentLog({ stateDir })
      const parameters = ['a.txt', 'b.txt'].map((path) => ({
        type: 'file',
        path,
        content: `new ${path}`,
        expectedHash: null,
      }))
      const create = spyOn(fs, 'createFileExclusive')
      try {
        const refused = await changeFiles({
          cwd: projectDir,
          fs,
          intentLog,
          parameters,
        })
        expect(refused[0]?.type === 'json' ? refused[0].value : null).toMatchObject({
          outcome: 'not_applied',
          errors: [expect.objectContaining({ message: expect.stringMatching(/broker/i) })],
        })
        expect(create).not.toHaveBeenCalled()
        expect(existsSync(intentLog.filePath)).toBe(false)
        for (const { path } of parameters) {
          await expect(fs.readFile(join(projectDir, path))).rejects.toMatchObject({
            code: 'ENOENT',
          })
        }

        // Both adapters can actually create the files; only a configured
        // durable group requires host-verified broker authority.
        const volatile = await changeFiles({ cwd: projectDir, fs, parameters })
        expect(volatile[0]?.type === 'json' ? volatile[0].value : null).toMatchObject({
          outcome: 'applied',
        })
        expect(create).toHaveBeenCalledTimes(2)
        for (const { path, content } of parameters) {
          expect(await fs.readFile(join(projectDir, path), 'utf8')).toBe(content)
        }
      } finally {
        create.mockRestore()
      }
    },
  )
})

describe('transaction intent log crash simulation', () => {
  test.each([
    [0, 'none'], [1, 'none'], [2, 'none'], [3, 'none'], [4, 'none'],
    [0, 'foreign-update'], [2, 'foreign-delete'], [3, 'foreign-move'],
    [1, 'replaced-postimage'], [1, 'lookalike'], [4, 'recreated-move-source'],
  ] as const)(
    'recovers a killed coordinator after %i actual group commits (%s)',
    async (boundary, control) => {
      if (process.platform === 'win32') return
      const initial = {
        'first.txt': 'before\r\n',
        'delete.txt': 'retained 🌱\r\n',
        'move.txt': 'move bytes\n',
      }
      for (const [file, content] of Object.entries(initial))
        writeFileSync(join(projectDir, file), content)
      chmodSync(join(projectDir, 'first.txt'), 0o640)
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
      const [cwd, stateDir, rawBoundary, control] = process.argv.slice(2)
      const boundary = Number(rawBoundary)
      const beforeBroker = control.startsWith('foreign-')
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
        if (result.ok && boundary === 0 && !beforeBroker) await stop()
        return result
      }
      const authorize = log.authorizeDispatch
      log.authorizeDispatch = async (...args) => {
        const result = await authorize(...args)
        if (result.ok && beforeBroker && [0, 1, 2, 4][reached] === args[1] && reached === boundary) await stop()
        return result
      }
      let reached = 0
      for (const kind of ['conditionalCommit', 'createFileExclusive', 'conditionalDelete', 'conditionalMove']) {
        const operation = fs[kind].bind(fs)
        fs[kind] = async (...args) => {
          const result = await operation(...args)
          if (kind !== 'createFileExclusive' && !result.applied) throw new Error('Expected commit did not land: ' + kind)
          if (++reached === boundary && !beforeBroker) await stop()
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
          '--no-install',
          helper,
          projectDir,
          stateDir,
          String(boundary),
          control,
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
        const dispatchCount = boundary + (control.startsWith('foreign-') ? 1 : 0)
        expect(events().map((event) => event.kind)).toEqual([
          'tx_begin',
          ...Array<string>(dispatchCount).fill('tx_dispatch'),
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
        ).toEqual([0, 1, 2, 4].slice(0, dispatchCount))
        const live = await log.recoverInterruptedTransactions()
        expect(live.ok ? live.liveTransactionIds : []).toHaveLength(1)
        child.kill('SIGKILL')
        await child.exited
        expect(child.signalCode).toBe('SIGKILL')
        const broker = await WorkspaceMutationBroker.create({
          cwd: projectDir,
          stateDir,
        })
        const source = createNodeFileSystem({ mutationBroker: broker })
        const fs = bindHostFileSystem(
          control === 'lookalike' ? Object.create(source) : source,
          createHostReadPolicy(projectDir, [], (value) => value),
        )
        const first = join(projectDir, 'first.txt')
        if (control === 'foreign-update' || control === 'replaced-postimage') {
          expect(readFileSync(first, 'utf8')).toBe(
            boundary === 0 ? initial['first.txt'] : 'after\n',
          )
          const oldIdentity = statSync(first, { bigint: true }).ino
          const foreign = join(projectDir, 'foreign.txt')
          writeFileSync(foreign, 'after\n')
          chmodSync(foreign, 0o640)
          renameSync(foreign, first)
          expect(statSync(first, { bigint: true }).ino).not.toBe(oldIdentity)
        }
        if (control === 'foreign-delete') unlinkSync(join(projectDir, 'delete.txt'))
        if (control === 'foreign-move')
          renameSync(join(projectDir, 'move.txt'), join(projectDir, 'moved.txt'))
        if (control === 'recreated-move-source')
          writeFileSync(join(projectDir, 'move.txt'), initial['move.txt'])
        const forwardReceipts = await broker.listReceipts()
        expect(forwardReceipts).toHaveLength(boundary)
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
        if (control !== 'none') {
          const recreated = control === 'recreated-move-source'
          const priorOwned = recreated ? 3 : control.startsWith('foreign-') ? boundary : 0
          expect(outcome).toMatchObject({
            ok: false,
            status: 'recovery_required',
            revertedPaths: priorOwned,
            recoveredCommittedTransactions: 0,
          })
          expect(readFileSync(first, 'utf8')).toBe(priorOwned ? initial['first.txt'] : 'after\n')
          expect(existsSync(join(projectDir, 'created.txt'))).toBe(false)
          expect(existsSync(join(projectDir, 'delete.txt'))).toBe(control !== 'foreign-delete')
          expect(existsSync(join(projectDir, 'move.txt'))).toBe(control !== 'foreign-move')
          if (control === 'foreign-move' || recreated)
            expect(readFileSync(join(projectDir, 'moved.txt'), 'utf8')).toBe(initial['move.txt'])
          expect(events().some(({ kind }) => kind === 'tx_commit' || kind === 'tx_abort')).toBe(false)
          const retry = await runRecovery()
          expect(retry).toMatchObject({
            ok: false, status: 'recovery_required', revertedPaths: 0, recoveredCommittedTransactions: 0,
          })
          if (process.env.OPENBUFF_CAPTURE_B07_BOUNDARIES === '1') {
            console.log('B07_FOREIGN ' + JSON.stringify({
              boundary, control, signal: child.signalCode, outcome, retry,
              forwardReceiptIds: forwardReceipts.map(({ receiptId }) => receiptId),
              transitions: events().map(({ kind, through }) => ({ kind, through })),
            }))
          }
          return
        }
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
  test('an unbrokered matching update is left untouched until the exact preimage is restored', async () => {
    const target = join(projectDir, 'updated.ts')
    const neverCreated = join(projectDir, 'created-by-tx.ts')
    const log = createTransactionIntentLog({ stateDir })
    const { broker, fs } = await brokerFileSystem()
    writeFileSync(target, 'original\r\n')
    expect(
      (
        await begin(log, 'tx-crash', [
          diskIntent('updated.ts', 'original\r\n', 'applied\n'),
          diskIntent('created-by-tx.ts', null, 'future'),
        ])
      ).ok,
    ).toBe(true)
    writeFileSync(target, 'applied\n')
    const foreignIdentity = physicalIdentity(target)
    const recover = () =>
      recoverAndRevertInterruptedTransactions({
        intentLog: createTransactionIntentLog({ stateDir }),
        cwd: projectDir,
        fs,
      })
    expect(await recover()).toMatchObject({
      ok: false,
      status: 'recovery_required',
      transactionIds: ['tx-crash'],
      revertedPaths: 0,
      recoveredCommittedTransactions: 0,
    })
    expect(readFileSync(target, 'utf8')).toBe('applied\n')
    expect(physicalIdentity(target)).toEqual(foreignIdentity)
    expect(existsSync(neverCreated)).toBe(false)
    expect(await log.recoverInterruptedTransactions()).toMatchObject({
      ok: true,
      transactions: [{ transactionId: 'tx-crash' }],
    })

    // Operator repair returns the workspace to the exact preimage. Recovery
    // records that the intent is settled; it does not write either path.
    writeFileSync(target, 'original\r\n')
    const repairedIdentity = physicalIdentity(target)
    expect(await recover()).toMatchObject({
      ok: true,
      revertedTransactions: 1,
      revertedPaths: 0,
      recoveredCommittedTransactions: 0,
    })
    expect(readFileSync(target, 'utf8')).toBe('original\r\n')
    expect(physicalIdentity(target)).toEqual(repairedIdentity)
    expect(existsSync(neverCreated)).toBe(false)
    expect(await broker.listReceipts()).toEqual([])
    expect(await log.recoverInterruptedTransactions()).toMatchObject({
      ok: true,
      transactions: [],
    })
  })

  test('an unbrokered matching creation remains recovery-required without removing the file', async () => {
    const target = join(projectDir, 'created.ts')
    const log = createTransactionIntentLog({ stateDir })
    expect(
      (
        await begin(log, 'tx-cancel', [
          diskIntent('gone.ts', null, 'missing'),
          diskIntent('created.ts', null, 'created'),
        ])
      ).ok,
    ).toBe(true)
    writeFileSync(target, 'created')
    const identity = physicalIdentity(target)
    const { broker, fs } = await brokerFileSystem()
    const recover = () =>
      recoverAndRevertInterruptedTransactions({
        intentLog: log,
        cwd: projectDir,
        fs,
      })
    expect(await recover()).toMatchObject({
      ok: false,
      status: 'recovery_required',
      transactionIds: ['tx-cancel'],
      revertedPaths: 0,
      recoveredCommittedTransactions: 0,
    })
    expect(readFileSync(target, 'utf8')).toBe('created')
    expect(physicalIdentity(target)).toEqual(identity)
    expect(existsSync(join(projectDir, 'gone.ts'))).toBe(false)
    expect(await broker.listReceipts()).toEqual([])
  })

  test.skipIf(process.platform === 'win32')(
    'missing and replaced parents block recovery until the original parent and broker postimage return',
    async () => {
      const parent = join(projectDir, 'dir')
      const held = join(projectDir, 'original-parent')
      const outside = join(stateDir, 'outside')
      const target = join(parent, 'file.ts')
      const outsideTarget = join(outside, 'file.ts')
      mkdirSync(parent)
      mkdirSync(outside)
      writeFileSync(target, 'original')
      writeFileSync(outsideTarget, 'applied')
      const outsideIdentity = physicalIdentity(outsideTarget)
      const log = createTransactionIntentLog({ stateDir })
      const { broker, fs } = await dispatchFirstBrokerAction(
        log,
        'tx-parent',
        [
          diskIntent('dir/file.ts', 'original', 'applied'),
          diskIntent('pending.ts', null, 'pending'),
        ],
        'applied',
      )
      const originalPostimage = physicalIdentity(target)
      renameSync(parent, held)
      const recover = () =>
        recoverAndRevertInterruptedTransactions({
          intentLog: log,
          cwd: projectDir,
          fs,
        })
      const blocked = {
        ok: false,
        status: 'recovery_required',
        transactionIds: ['tx-parent'],
        revertedPaths: 0,
      }
      expect(await recover()).toMatchObject(blocked)
      expect(existsSync(parent)).toBe(false)
      symlinkSync(outside, parent, 'dir')
      expect(await recover()).toMatchObject(blocked)
      expect(readFileSync(outsideTarget, 'utf8')).toBe('applied')
      expect(physicalIdentity(outsideTarget)).toEqual(outsideIdentity)
      unlinkSync(parent)
      mkdirSync(parent)
      writeFileSync(target, 'applied')
      const replacement = physicalIdentity(target)
      expect(await recover()).toMatchObject({
        ...blocked,
        error: expect.stringContaining('replaced parent'),
      })
      expect(readFileSync(target, 'utf8')).toBe('applied')
      expect(physicalIdentity(target)).toEqual(replacement)
      expect(await broker.listReceipts()).toHaveLength(1)

      // Restore the original directory with its untouched broker postimage,
      // not a newly written file with equal bytes.
      rmSync(parent, { recursive: true })
      renameSync(held, parent)
      expect(physicalIdentity(target)).toEqual(originalPostimage)
      expect(await recover()).toMatchObject({
        ok: true,
        revertedTransactions: 1,
        revertedPaths: 1,
      })
      expect(readFileSync(target, 'utf8')).toBe('original')
      expect(readFileSync(outsideTarget, 'utf8')).toBe('applied')
      expect(physicalIdentity(outsideTarget)).toEqual(outsideIdentity)
      expect(existsSync(join(projectDir, 'pending.ts'))).toBe(false)
    },
  )

  test.each(['read', 'write', 'fsync'] as const)(
    'a recovery %s fault leaves the real broker postimage pending for retry',
    async (fault) => {
      const log = createTransactionIntentLog({ stateDir })
      const target = join(projectDir, 'target.txt')
      writeFileSync(target, 'before\r\n')
      const { broker, fs } = await dispatchFirstBrokerAction(
        log,
        'faults',
        [
          diskIntent('target.txt', 'before\r\n', 'after\n'),
          diskIntent('future.txt', null, 'future'),
        ],
        'after\n',
      )
      const postimage = physicalIdentity(target)
      const recover = () =>
        recoverAndRevertInterruptedTransactions({
          intentLog: createTransactionIntentLog({ stateDir }),
          cwd: projectDir,
          fs,
        })
      const failure = Object.assign(
        new Error(`injected recovery ${fault} fault`),
        { code: 'EIO' },
      )
      let injected = 0
      const probe = await open(join(stateDir, '.recovery-fault-probe'), 'w')
      const handleProto = Object.getPrototypeOf(probe) as FileHandle
      await probe.close()
      const { writeFile, sync } = handleProto
      const failOnWorkspaceStaging = async (handle: FileHandle) => {
        // Only fault the actual inverse staging file, never broker/intent
        // metadata, locks or directory fsyncs.
        const name = readdirSync(projectDir).find((entry) =>
          /^\.openbuff-mutation-.*\.tmp$/.test(entry),
        )
        if (!name) return
        const stage = statSync(join(projectDir, name), { bigint: true })
        const opened = await handle.stat({ bigint: true })
        if (opened.dev === stage.dev && opened.ino === stage.ino) {
          injected++
          throw failure
        }
      }
      const injection =
        fault === 'read'
          ? spyOn(fs, 'readFile').mockImplementationOnce(async (file) => {
              expect(String(file)).toBe(target)
              injected++
              throw failure
            })
          : fault === 'write'
            ? spyOn(handleProto, 'writeFile').mockImplementation(
                async function (
                  this: FileHandle,
                  ...args: Parameters<FileHandle['writeFile']>
                ) {
                  await failOnWorkspaceStaging(this)
                  await writeFile.apply(this, args)
                },
              )
            : spyOn(handleProto, 'sync').mockImplementation(async function (
                this: FileHandle,
              ) {
                await failOnWorkspaceStaging(this)
                await sync.call(this)
              })
      try {
        expect(await recover()).toMatchObject({
          ok: false,
          status: 'recovery_required',
          error: expect.stringContaining(
            fault === 'read' ? failure.message : 'failed (EIO)',
          ),
          transactionIds: ['faults'],
          revertedPaths: 0,
        })
      } finally {
        injection.mockRestore()
      }
      expect(injected).toBe(1)
      expect(readFileSync(target, 'utf8')).toBe('after\n')
      expect(physicalIdentity(target)).toEqual(postimage)
      expect(readdirSync(projectDir)).toEqual(['target.txt'])
      expect(await log.recoverInterruptedTransactions()).toMatchObject({
        ok: true,
        transactions: [{ transactionId: 'faults' }],
      })
      const receipts = await broker.listReceipts()
      expect(receipts.map(({ state, errorCode }) => [state, errorCode])).toEqual(
        fault === 'read'
          ? [['committed', undefined]]
          : [['committed', undefined], ['failed', 'EIO']],
      )

      expect(await recover()).toMatchObject({
        ok: true,
        revertedTransactions: 1,
        revertedPaths: 1,
      })
      expect(readFileSync(target, 'utf8')).toBe('before\r\n')
      expect(readdirSync(projectDir)).toEqual(['target.txt'])
      expect(await log.recoverInterruptedTransactions()).toMatchObject({
        ok: true,
        transactions: [],
      })
    },
  )

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
      fs: (await brokerFileSystem()).fs,
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
  test('a lost tx_commit append after real broker commits is reconciled without touching the files', async () => {
    const log = createTransactionIntentLog({
      stateDir,
      lockTimeoutMs: 50,
      commitRetryDelayMs: 5,
    })
    const { broker, fs } = await brokerFileSystem()
    const target = join(projectDir, 'updated.ts')
    const created = join(projectDir, 'created.ts')
    writeFileSync(target, 'original\r\n')
    const commitTransaction = log.commitTransaction
    let acknowledgement:
      | Awaited<ReturnType<typeof commitTransaction>>
      | undefined
    log.commitTransaction = async (id) => {
      // Compete for the real intent-log lock only after both broker actions
      // have landed. The live holder survives every bounded append retry.
      const token = readFileSync(
        `${log.filePath}.live-${process.pid}`,
        'utf8',
      ).trim()
      const lockPath = `${log.filePath}.lock`
      writeFileSync(lockPath, `${process.pid} ${token}\n`, { flag: 'wx' })
      try {
        return (acknowledgement = await commitTransaction(id))
      } finally {
        unlinkSync(lockPath)
      }
    }
    const result = await changeFiles({
      cwd: projectDir,
      fs,
      intentLog: log,
      capabilityIssuer: { projectId: projectDir, runId: 'lost-ack' },
      parameters: [
        {
          type: 'file',
          path: 'updated.ts',
          content: 'committed\n',
          expectedHash: getContentHash('original\r\n'),
        },
        {
          type: 'file',
          path: 'created.ts',
          content: 'created\n',
          expectedHash: null,
        },
      ],
    })
    expect(acknowledgement).toMatchObject({
      ok: false,
      error: expect.stringContaining('timed out'),
    })
    const pending = await log.recoverInterruptedTransactions()
    if (!pending.ok) throw new Error(pending.error)
    expect(pending.transactions).toHaveLength(1)
    const transaction = pending.transactions[0]!
    expect(transaction.recovery).toBeUndefined()
    const mutation = fileMutationResultV1Schema.parse(
      result[0]?.type === 'json' ? result[0].value : null,
    )
    expect(mutation).toMatchObject({
      outcome: 'unconfirmed',
      errors: [expect.objectContaining({ code: 'recovery_required' })],
      authorityReceipt: {
        status: 'acknowledgement_pending',
        transactionId: transaction.transactionId,
        actions: [
          { status: 'forward_verified' },
          { status: 'forward_verified' },
        ],
      },
      freshCapabilities: [],
    })
    expect(
      getConfirmedAppliedActionsV1(mutation).map(({ action, path, afterHash }) => ({
        action, path, afterHash,
      })),
    ).toEqual([
      { action: 'update', path: 'updated.ts', afterHash: getExactContentHash('committed\n') },
      { action: 'create', path: 'created.ts', afterHash: getExactContentHash('created\n') },
    ])
    for (const action of mutation.actions) {
      expect(action.outcome).toBe('applied')
      expect(action.forward).toEqual({
        outcome: 'applied',
        afterHashes: { [action.path]: action.afterHash },
      })
      expect(action.rollback).toBeUndefined()
      expect(action.editAnchor).toBeUndefined()
      expect(action.afterContent).toBeUndefined()
    }
    expect(readFileSync(target, 'utf8')).toBe('committed\n')
    expect(readFileSync(created, 'utf8')).toBe('created\n')
    const receipts = await broker.listReceipts()
    expect(transaction.actions).toHaveLength(2)
    expect(receipts).toMatchObject([
      {
        path: 'updated.ts',
        action: 'commit',
        state: 'committed',
        correlation: transaction.actions![0],
      },
      {
        path: 'created.ts',
        action: 'create',
        state: 'committed',
        correlation: transaction.actions![1],
      },
    ])
    const commitMarkers = () =>
      readFileSync(log.filePath, 'utf8')
        .split('\n')
        .filter((line) => line.includes('"kind":"tx_commit"'))
    expect(commitMarkers()).toEqual([])
    const postimages = [target, created].map(physicalIdentity)
    const reopened = await brokerFileSystem()
    const recover = () =>
      recoverAndRevertInterruptedTransactions({
        intentLog: createTransactionIntentLog({ stateDir }),
        cwd: projectDir,
        fs: reopened.fs,
      })
    expect(await recover()).toMatchObject({
      ok: true,
      revertedTransactions: 0,
      revertedPaths: 0,
      recoveredCommittedTransactions: 1,
    })
    expect(readFileSync(target, 'utf8')).toBe('committed\n')
    expect(readFileSync(created, 'utf8')).toBe('created\n')
    expect([target, created].map(physicalIdentity)).toEqual(postimages)
    expect(await reopened.broker.listReceipts()).toEqual(receipts)
    expect(await recover()).toMatchObject({
      ok: true,
      revertedTransactions: 0,
      revertedPaths: 0,
      recoveredCommittedTransactions: 0,
    })
    expect(commitMarkers().map((line) => JSON.parse(line))).toMatchObject([
      { transactionId: transaction.transactionId, recovered: true },
    ])
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

  test('matching every expected postimage cannot acknowledge a commit without broker receipts', async () => {
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
      ok: false,
      status: 'recovery_required',
      unresolvedPaths: ['a.ts', 'created.ts'],
      revertedPaths: 0,
    })
    expect(revertCalls).toEqual([])
    expect(await log.recoverInterruptedTransactions()).toMatchObject({
      ok: true,
      transactions: [{ transactionId: 'tx-recovered-commit' }],
    })
    expect(readFileSync(log.filePath, 'utf8')).not.toContain('"kind":"tx_commit"')
  })

  test('foreign divergence and rewritten postimage bytes both remain recovery-required', async () => {
    const log = createTransactionIntentLog({ stateDir })
    expect(
      (await begin(log, 'tx-foreign', [intent('a.ts', 'old\r\n', 'after')])).ok,
    ).toBe(true)
    const reverted: string[] = []
    const recover = (current: string) =>
      log.revertTransaction(
        'tx-foreign',
        async (entryPath) => reverted.push(entryPath),
        async () => current,
      )
    // Neither the expected postimage nor newline-normalized preimage is a
    // substitute for proof of ownership or the exact original bytes.
    for (const content of ['foreign', 'after', 'old\n']) {
      expect(await recover(content)).toMatchObject({
        ok: false,
        status: 'recovery_required',
        unresolvedPaths: ['a.ts'],
        revertedPaths: 0,
      })
      expect(await log.recoverInterruptedTransactions()).toMatchObject({
        ok: true,
        transactions: [{ transactionId: 'tx-foreign' }],
      })
    }
    expect(await recover('old\r\n')).toMatchObject({
      ok: true,
      status: 'reverted',
      revertedPaths: 0,
      ownedPaths: [],
    })
    expect(reverted).toEqual([])
  })

  test('an untouched path does not authorize restoration of an unbrokered matching peer', async () => {
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
      ok: false,
      status: 'recovery_required',
      unresolvedPaths: ['applied.ts'],
      revertedPaths: 0,
    })
    expect(reverted).toEqual([])
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

  test('same-process ownership defers recovery, then only the brokered path can be reverted', async () => {
    const log = createTransactionIntentLog({ stateDir })
    const fresh = createTransactionIntentLog({ stateDir })
    const a = join(projectDir, 'a')
    const b = join(projectDir, 'b')
    writeFileSync(a, 'before A')
    writeFileSync(b, 'before B')
    const { broker, fs } = await dispatchFirstBrokerAction(
      log,
      'active',
      [
        diskIntent('a', 'before A', 'after A'),
        diskIntent('b', 'before B', 'after B'),
      ],
      'after A',
      { keepActive: true },
    )
    const recover = () =>
      recoverAndRevertInterruptedTransactions({
        intentLog: fresh,
        cwd: projectDir,
        fs,
      })
    try {
      writeFileSync(b, 'after B') // No dispatch or broker receipt for b.
      expect(await fresh.recoverInterruptedTransactions()).toMatchObject({
        ok: true,
        transactions: [],
        liveTransactionIds: ['active'],
      })
      expect(await recover()).toMatchObject({
        ok: false,
        status: 'recovery_required',
        transactionIds: ['active'],
        revertedPaths: 0,
      })
      expect(readFileSync(a, 'utf8')).toBe('after A')
      expect(readFileSync(b, 'utf8')).toBe('after B')
    } finally {
      log.releaseTransaction!('active')
    }
    const foreign = physicalIdentity(b)
    expect(await recover()).toMatchObject({
      ok: false,
      status: 'recovery_required',
      transactionIds: ['active'],
      revertedPaths: 1,
    })
    expect(await fresh.recoverInterruptedTransactions()).toMatchObject({
      ok: true,
      transactions: [
        { transactionId: 'active', recovery: { unresolved: [1] } },
      ],
    })
    expect(readFileSync(a, 'utf8')).toBe('before A')
    expect(readFileSync(b, 'utf8')).toBe('after B')
    expect(physicalIdentity(b)).toEqual(foreign)
    expect(await recover()).toMatchObject({
      ok: false,
      status: 'recovery_required',
      transactionIds: ['active'],
      revertedPaths: 0,
    })
    const receipts = await broker.listReceipts()
    expect(receipts).toHaveLength(2) // Both forward and inverse on a.
    writeFileSync(b, 'before B')
    const repaired = physicalIdentity(b)
    expect(await recover()).toMatchObject({
      ok: true,
      revertedTransactions: 1,
      revertedPaths: 0,
    })
    expect(physicalIdentity(b)).toEqual(repaired)
    expect(await broker.listReceipts()).toEqual(receipts)
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
  test('a LIVE sibling owner defers recovery of its unfinished intent', async () => {
    const sibling = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { stdio: 'ignore' },
    )
    if (sibling.pid === undefined) {
      throw new Error('could not spawn a liveness probe process')
    }
    try {
      const log = createTransactionIntentLog({ stateDir, ownerPid: sibling.pid })
      const target = join(projectDir, 'a.ts')
      expect(
        (await begin(log, 'tx-sibling-live', [diskIntent('a.ts', 'before', 'after')])).ok,
      ).toBe(true)
      writeFileSync(target, 'after')
      const identity = physicalIdentity(target)
      const fs = createNodeFileSystem()
      const recovery = await recoverAndRevertInterruptedTransactions({
        intentLog: log,
        cwd: projectDir,
        fs,
      })
      expect(recovery).toMatchObject({
        ok: false,
        status: 'recovery_required',
        error: 'A live coordinator owns an unfinished transaction.',
        revertedTransactions: 0,
        revertedPaths: 0,
        transactionIds: ['tx-sibling-live'],
      })
      expect(readFileSync(target, 'utf8')).toBe('after')
      expect(physicalIdentity(target)).toEqual(identity)
      expect(await log.recoverInterruptedTransactions()).toMatchObject({
        ok: true,
        transactions: [],
        liveTransactionIds: ['tx-sibling-live'],
      })
    } finally {
      sibling.kill()
    }
  })

  test('a DEAD owner is no longer deferred but cannot authorize an unbrokered postimage', async () => {
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    if (exited.pid === undefined || exited.status !== 0) {
      throw new Error('could not spawn and reap a liveness probe process')
    }
    const log = createTransactionIntentLog({ stateDir, ownerPid: exited.pid })
    const target = join(projectDir, 'updated.ts')
    const untouched = join(projectDir, 'untouched.ts')
    expect(
      (
        await begin(log, 'tx-sibling-dead', [
          diskIntent('updated.ts', 'original\n', 'unbrokered after'),
          diskIntent('untouched.ts', 'same', 'future'),
        ])
      ).ok,
    ).toBe(true)
    writeFileSync(target, 'unbrokered after')
    writeFileSync(untouched, 'same')
    const identities = [target, untouched].map(physicalIdentity)
    expect(await log.recoverInterruptedTransactions()).toEqual({
      ok: true,
      transactions: [expect.objectContaining({ transactionId: 'tx-sibling-dead' })],
    })
    const recovery = await recoverAndRevertInterruptedTransactions({
      intentLog: log,
      cwd: projectDir,
      fs: createNodeFileSystem(),
    })
    expect(recovery).toMatchObject({
      ok: false,
      status: 'recovery_required',
      error: 'Foreign or unowned transaction state at updated.ts.',
      transactionIds: ['tx-sibling-dead'],
      revertedTransactions: 0,
      revertedPaths: 0,
      recoveredCommittedTransactions: 0,
    })
    expect(readFileSync(target, 'utf8')).toBe('unbrokered after')
    expect(readFileSync(untouched, 'utf8')).toBe('same')
    expect([target, untouched].map(physicalIdentity)).toEqual(identities)
  })

  test('a RECYCLED pid with a different instance token no longer defers recovery', async () => {
    const sibling = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { stdio: 'ignore' },
    )
    if (sibling.pid === undefined) {
      throw new Error('could not spawn a liveness probe process')
    }
    try {
      const log = createTransactionIntentLog({ stateDir, ownerPid: sibling.pid })
      const freshLog = createTransactionIntentLog({ stateDir })
      const target = join(projectDir, 'updated.ts')
      expect(
        (
          await begin(log, 'tx-recycled-pid', [
            diskIntent('updated.ts', 'original\n', 'unbrokered after'),
          ])
        ).ok,
      ).toBe(true)
      writeFileSync(target, 'unbrokered after')
      const identity = physicalIdentity(target)
      expect(await freshLog.recoverInterruptedTransactions()).toMatchObject({
        ok: true,
        transactions: [],
        liveTransactionIds: ['tx-recycled-pid'],
      })
      // The PID is still live, but the token now belongs to a new occupant.
      writeFileSync(
        `${log.filePath}.live-${sibling.pid}`,
        'token-of-the-new-occupant\n',
        'utf8',
      )
      process.kill(sibling.pid, 0)
      expect(await freshLog.recoverInterruptedTransactions()).toEqual({
        ok: true,
        transactions: [expect.objectContaining({ transactionId: 'tx-recycled-pid' })],
      })
      const recovery = await recoverAndRevertInterruptedTransactions({
        intentLog: freshLog,
        cwd: projectDir,
        fs: createNodeFileSystem(),
      })
      expect(recovery).toMatchObject({
        ok: false,
        status: 'recovery_required',
        error: 'Foreign or unowned transaction state at updated.ts.',
        transactionIds: ['tx-recycled-pid'],
        revertedPaths: 0,
        recoveredCommittedTransactions: 0,
      })
      expect(readFileSync(target, 'utf8')).toBe('unbrokered after')
      expect(physicalIdentity(target)).toEqual(identity)
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
      const log = createTransactionIntentLog({ stateDir, ownerPid: sibling.pid })
      expect(
        (
          await log.beginTransaction({
            transactionId: 'tx-missing-token',
            operationId: 'op-missing',
            callId: 'call-missing',
            entries: [diskIntent('a.ts', null, 'half-applied')],
            inFlight: true,
          })
        ).ok,
      ).toBe(true)
      log.releaseTransaction?.('tx-missing-token')
      unlinkSync(`${log.filePath}.live-${sibling.pid}`)
      const target = join(projectDir, 'a.ts')
      writeFileSync(target, 'half-applied')
      const identity = physicalIdentity(target)
      const freshLog = createTransactionIntentLog({ stateDir })
      expect(await freshLog.recoverInterruptedTransactions()).toMatchObject({
        ok: true,
        transactions: [],
        liveTransactionIds: ['tx-missing-token'],
      })
      const recovery = await recoverAndRevertInterruptedTransactions({
        intentLog: freshLog,
        cwd: projectDir,
        fs: createNodeFileSystem(),
      })
      expect(recovery).toMatchObject({
        ok: false,
        status: 'recovery_required',
        error: 'A live coordinator owns an unfinished transaction.',
        revertedPaths: 0,
        transactionIds: ['tx-missing-token'],
      })
      expect(readFileSync(target, 'utf8')).toBe('half-applied')
      expect(physicalIdentity(target)).toEqual(identity)
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
    'crash restoration recreates a broker-deleted file with its recorded mode',
    async () => {
      const target = join(projectDir, 'app.sh')
      writeFileSync(target, 'old\r\n')
      chmodSync(target, 0o751)
      const log = createTransactionIntentLog({ stateDir })
      const { broker, fs } = await dispatchFirstBrokerAction(
        log,
        'tx-mode',
        [
          { ...diskIntent('app.sh', 'old\r\n', null), beforeMode: 0o751 },
          diskIntent('future.txt', null, 'not yet created'),
        ],
        null,
      )
      expect(existsSync(target)).toBe(false)
      expect(await broker.listReceipts()).toMatchObject([
        { action: 'delete', beforeMode: 0o751, deleteTombstoneVerified: true },
      ])
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
      expect(readFileSync(target, 'utf8')).toBe('old\r\n')
      expect(statSync(target).mode & 0o777).toBe(0o751)
      expect(existsSync(join(projectDir, 'future.txt'))).toBe(false)
    },
  )

  test.skipIf(process.platform === 'win32')(
    'matching bytes with a foreign mode do not prove ownership even with a broker receipt',
    async () => {
      const log = createTransactionIntentLog({ stateDir })
      const target = join(projectDir, 'plain.txt')
      writeFileSync(target, 'before')
      chmodSync(target, 0o644)
      const { broker, fs } = await dispatchFirstBrokerAction(
        log,
        'tx-mode-conflict',
        [
          {
            ...diskIntent('plain.txt', 'before', 'after'),
            beforeMode: 0o644,
            afterMode: 0o644,
          },
          diskIntent('future.txt', null, 'future'),
        ],
        'after',
      )
      expect(statSync(target).mode & 0o777).toBe(0o644)
      chmodSync(target, 0o755)
      const foreign = physicalIdentity(target)
      expect(
        await recoverAndRevertInterruptedTransactions({
          intentLog: log,
          cwd: projectDir,
          fs,
        }),
      ).toMatchObject({
        ok: false,
        status: 'recovery_required',
        transactionIds: ['tx-mode-conflict'],
        revertedPaths: 0,
      })
      expect(readFileSync(target, 'utf8')).toBe('after')
      expect(physicalIdentity(target)).toEqual(foreign)
      expect(await broker.listReceipts()).toHaveLength(1)
    },
  )

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
