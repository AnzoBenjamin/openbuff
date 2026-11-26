import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getExactContentHash } from '@codebuff/common/util/content-hash'
import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import { describe, expect, it } from 'bun:test'

import { handleEditTransaction } from '../tools/handlers/tool/edit-transaction'
import { handleReadFiles } from '../tools/handlers/tool/read-files'
import { getContentHash } from '../process-str-replace'
import {
  buildWholeFileReadResultV1,
  confirmedMutationOutput,
} from './read-files-edit-state-fixtures'
import { mockFileContext } from './test-utils'

import type { FileProcessingState } from '../tools/handlers/tool/write-file'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const defaultTestAuthorityScope = {
  projectId: mockFileContext.projectRoot,
  runId: 'edit-transaction-multi-file-recovery-run',
}

const defaultTestHandlerAuthority = {
  fileContext: mockFileContext,
  runId: defaultTestAuthorityScope.runId,
}

function createFileProcessingState(): FileProcessingState {
  return {
    promisesByPath: {},
    allPromises: [],
    fileChangeErrors: [],
    fileChanges: [],
    firstFileProcessed: false,
    failedEditRequiresReadByPath: {},
    consecutiveStrReplaceFailuresByPath: {},
  }
}

async function readWholeFiles(
  paths: string[],
  diskContentByPath: Record<string, string>,
  fileProcessingState: FileProcessingState,
  toolCallId: string,
) {
  return handleReadFiles({
    ...defaultTestHandlerAuthority,
    previousToolCallFinished: Promise.resolve(),
    toolCall: { toolCallId, toolName: 'read_files', input: { paths } },
    fileProcessingState,
    requestFiles: async ({ filePaths, capabilityIssuer }) =>
      buildWholeFileReadResultV1(
        filePaths,
        (path) => diskContentByPath[path] ?? null,
        capabilityIssuer,
      ),
    logger,
  } as Parameters<typeof handleReadFiles>[0])
}

describe('edit_transaction multi-file no-match recovery loop', () => {
  it('retains SDK recovery-required for a replaced postimage and retries after independent preimage repair', async () => {
    const { handleToolCall } = await import('../../../../sdk/src/run')
    const { createNodeFileSystem } =
      await import('../../../../sdk/src/tools/node-filesystem')
    const { changeFiles } =
      await import('../../../../sdk/src/tools/change-file')
    const { WorkspaceMutationBroker } =
      await import('../../../../sdk/src/services/workspace-mutation-broker')
    const { createTransactionIntentLogForWorkspace } =
      await import('../../../../sdk/src/tools/transaction-intent-log')
    const root = mkdtempSync(path.join(tmpdir(), 'openbuff-runtime-tx-'))
    const cwd = path.join(realpathSync(root), 'project')
    const stateDir = path.join(root, 'state')
    mkdirSync(cwd)
    const target = path.join(cwd, 'target.txt')
    const later = path.join(cwd, 'later.txt')
    writeFileSync(target, 'original\r\n')
    writeFileSync(later, 'unchanged\n')
    const identity = (file: string) => {
      const { dev, ino, ctimeNs, birthtimeNs, mode } = statSync(file, {
        bigint: true,
      })
      return { dev, ino, ctimeNs, birthtimeNs, mode }
    }
    try {
      const broker = await WorkspaceMutationBroker.create({ cwd, stateDir })
      const fs = createNodeFileSystem({ mutationBroker: broker })
      const intentLog = createTransactionIntentLogForWorkspace({
        cwd,
        stateDir,
      })
      const commit = fs.conditionalCommit!
      fs.conditionalCommit = async (file, bytes, options) => {
        if (String(file) === later) {
          // Replace the real broker postimage with a different physical file.
          const foreign = path.join(cwd, 'foreign.txt')
          writeFileSync(foreign, 'foreign\n', {
            mode: statSync(target).mode & 0o777,
          })
          renameSync(foreign, target)
          throw new Error('fixture: second commit failed')
        }
        return commit(file, bytes, options)
      }
      const failed = await changeFiles({
        cwd,
        fs,
        intentLog,
        parameters: [
          {
            type: 'file',
            path: 'target.txt',
            content: 'owned\n',
            expectedHash: getContentHash('original\r\n'),
          },
          {
            type: 'file',
            path: 'later.txt',
            content: 'after\n',
            expectedHash: getContentHash('unchanged\n'),
          },
        ],
      })
      fs.conditionalCommit = commit
      expect(failed[0]?.type === 'json' ? failed[0].value : null).toMatchObject(
        { outcome: 'rollback_incomplete' },
      )
      const pending = await intentLog.recoverInterruptedTransactions()
      if (!pending.ok) throw new Error(pending.error)
      expect(pending.transactions).toHaveLength(1)
      const transactionId = pending.transactions[0]!.transactionId
      const receipts = await broker.listReceipts()
      expect(receipts).toMatchObject([
        {
          action: 'commit',
          path: 'target.txt',
          state: 'committed',
          correlation: { transactionId, from: 0, through: 0 },
          resultIdentity: { ino: expect.any(String) },
        },
      ])
      expect(String(identity(target).ino)).not.toBe(
        receipts[0]!.resultIdentity!.ino,
      )
      const runId = 'transaction-runtime-retry'
      const fileProcessingState = createFileProcessingState()
      const dispatch = (id: string) =>
        handleEditTransaction({
          fileContext: { ...mockFileContext, projectRoot: cwd },
          runId,
          previousToolCallFinished: Promise.resolve(),
          toolCall: {
            toolCallId: id,
            toolName: 'edit_transaction',
            input: {
              edits: [
                { type: 'create', path: 'created-a.txt', content: 'created A' },
                { type: 'create', path: 'created-b.txt', content: 'created B' },
              ],
            },
          },
          fileProcessingState,
          logger,
          requestOptionalFile: async ({ filePath }) =>
            fs.readFile(path.join(cwd, filePath), 'utf8').catch((error) => {
              if (error?.code === 'ENOENT') return null
              throw error
            }),
          requestClientToolCall: async ({ input, toolCallId }) => {
            const response = await handleToolCall({
              action: {
                type: 'tool-call-request',
                requestId: toolCallId,
                userInputId: 'fixture',
                toolName: 'edit_transaction',
                input,
              },
              overrides: {},
              customToolDefinitions: {},
              cwd,
              fs,
              intentLog,
              logger,
              capabilityIssuer: { projectId: cwd, runId },
              trustedJobOwner: {
                clientSessionId: 'fixture',
                rootRunId: runId,
                parentRunId: runId,
                parentAgentId: 'fixture',
              },
              approvalReceiptIds: [],
              approvalMode: 'balanced',
              getWorkspaceState: () => undefined,
              setWorkspaceState: () => {},
            })
            return response.output as CodebuffToolOutput<'edit_transaction'>
          },
        })
      const expectBlockedWithoutWrites = async (id: string, content: string) => {
        const before = identity(target)
        const blocked = (await dispatch(id)).output[0]
        expect(blocked?.type === 'json' ? blocked.value : null).toMatchObject({
          errorCode: 'recovery_required',
          errorMessage: expect.stringContaining(
            'No edits from this call were applied',
          ),
          recovery: {
            kind: 'transaction_intent',
            transactionIds: [transactionId],
          },
        })
        expect(readFileSync(target, 'utf8')).toBe(content)
        expect(identity(target)).toEqual(before)
        expect(readFileSync(later, 'utf8')).toBe('unchanged\n')
        for (const file of ['created-a.txt', 'created-b.txt']) {
          await expect(
            fs.readFile(path.join(cwd, file), 'utf8'),
          ).rejects.toMatchObject({ code: 'ENOENT' })
        }
        expect(await broker.listReceipts()).toEqual(receipts)
      }
      await expectBlockedWithoutWrites('blocked', 'foreign\n')

      // Equal bytes cannot recover the original receipt's physical identity.
      writeFileSync(target, 'owned\n')
      await expectBlockedWithoutWrites('blocked-matching-bytes', 'owned\n')

      // The operator can restore the exact preimage instead. Recovery only
      // settles the intent; the retry may then write its two new files.
      writeFileSync(target, 'original\r\n')
      const repaired = identity(target)
      const retried = (await dispatch('retry')).output[0]
      expect(retried?.type === 'json' ? retried.value : null).toMatchObject({
        kind: 'file_mutation_result',
        outcome: 'applied',
      })
      expect(readFileSync(target, 'utf8')).toBe('original\r\n')
      expect(identity(target)).toEqual(repaired)
      expect(readFileSync(later, 'utf8')).toBe('unchanged\n')
      expect(readFileSync(path.join(cwd, 'created-a.txt'), 'utf8')).toBe(
        'created A',
      )
      expect(readFileSync(path.join(cwd, 'created-b.txt'), 'utf8')).toBe(
        'created B',
      )
      expect(
        (await broker.listReceipts()).map(({ action, path }) => [action, path]),
      ).toEqual([
        ['commit', 'target.txt'],
        ['create', 'created-a.txt'],
        ['create', 'created-b.txt'],
      ])
      expect(await intentLog.recoverInterruptedTransactions()).toMatchObject({
        ok: true,
        transactions: [],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('aborts with recovery.paths for the failing target only, then applies after re-reading it', async () => {
    const pathA = 'src/recovery-a.ts'
    const pathB = 'src/recovery-b.ts'
    const contentA = 'export const value = 1\n'
    const contentB = 'export const peer = 1\n'
    const nextA = 'export const value = 2\n'
    const nextB = 'export const peer = 2\n'
    const runId = defaultTestAuthorityScope.runId
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true

    const diskContentByPath: Record<string, string> = {
      [pathA]: contentA,
      [pathB]: contentB,
    }

    // Establish both normalized and raw authority through authenticated reads.
    await readWholeFiles(
      [pathA, pathB],
      diskContentByPath,
      fileProcessingState,
      'initial-whole-file-reads',
    )

    let clientCalls = 0
    const abortResult = await handleEditTransaction({
      ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'multi-file-no-match-abort',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'str_replace',
              path: pathA,
              replacements: [
                {
                  oldString: 'export const value = 1',
                  newString: 'export const value = 2',
                  allowMultiple: false,
                },
              ],
            },
            {
              type: 'str_replace',
              path: pathB,
              replacements: [
                {
                  oldString: 'export const peer = 999',
                  newString: 'export const peer = 2',
                  allowMultiple: false,
                },
              ],
            },
          ],
        },
      },
      fileProcessingState,
      fileContext: mockFileContext,
      runId,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        diskContentByPath[filePath] ?? null,
      requestClientToolCall: async () => {
        clientCalls += 1
        throw new Error('must not apply multi-file match abort')
      },
    } as any)

    expect(clientCalls).toBe(0)
    // Only pathB's oldString failed to match. No bytes were written, so pathA
    // is byte-identical to the snapshot and keeps its read state.
    expect(fileProcessingState.failedEditRequiresReadByPath[pathB]).toBe(true)
    expect(
      fileProcessingState.editRereadRequirementsByPath?.[pathB],
    ).toMatchObject({
      reason: 'preflight_failed',
      sourceTool: 'edit_transaction',
    })
    expect(fileProcessingState.failedEditRequiresReadByPath[pathA]).toBeFalsy()
    expect(fileProcessingState.readAuthorizationsByPath?.[pathA]).toBe(true)
    expect(fileProcessingState.readAuthorizationHashesByPath?.[pathA]).toBe(
      getContentHash(contentA),
    )

    const abortOutput = abortResult.output[0]
    expect(abortOutput.type).toBe('json')
    if (abortOutput.type === 'json') {
      const value = abortOutput.value as {
        errorMessage?: string
        requiresFreshRead?: boolean
        errorCode?: string
        recovery?: {
          action?: string
          requiresFreshRead?: boolean
          paths?: string[]
          tool?: string
          input?: { paths?: string[] }
        }
      }
      expect(value.requiresFreshRead).toBe(true)
      expect(value.errorCode).toBe('no_match')
      expect(value.recovery?.action).toBe('rebuild_whole_transaction')
      expect(value.recovery?.requiresFreshRead).toBe(true)
      expect(value.recovery?.tool).toBe('read_files')
      expect(value.recovery?.paths).toEqual([pathB])
      expect(value.recovery?.input?.paths).toEqual([pathB])
      expect(String(value.errorMessage)).toContain(pathB)
      expect(String(value.errorMessage)).toContain(
        'every other transaction target retains valid read state',
      )
    }

    // Simulate the narrowed recovery: re-read ONLY recovery.paths (pathB).
    // pathA is never re-read here, so the retry below can only succeed if its
    // retained authorization survived the abort.
    await readWholeFiles(
      [pathB],
      diskContentByPath,
      fileProcessingState,
      'multi-file-recovery-reread',
    )

    for (const path of [pathA, pathB]) {
      expect(
        fileProcessingState.failedEditRequiresReadByPath[path],
      ).toBeUndefined()
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash(diskContentByPath[path]),
      )
      expect(fileProcessingState.rawReadAuthorizationHashesByPath?.[path]).toBe(
        getExactContentHash(diskContentByPath[path]),
      )
    }

    const recoveredResult = await handleEditTransaction({
      ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'multi-file-no-match-recovered',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'str_replace',
              path: pathA,
              replacements: [
                {
                  oldString: 'export const value = 1',
                  newString: 'export const value = 2',
                  allowMultiple: false,
                },
              ],
            },
            {
              type: 'str_replace',
              path: pathB,
              replacements: [
                {
                  oldString: 'export const peer = 1',
                  newString: 'export const peer = 2',
                  allowMultiple: false,
                },
              ],
            },
          ],
        },
      },
      fileProcessingState,
      fileContext: mockFileContext,
      runId,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        diskContentByPath[filePath] ?? null,
      requestClientToolCall: async (toolCall: any) => {
        clientCalls += 1
        return confirmedMutationOutput(
          toolCall,
          {
            [pathA]: nextA,
            [pathB]: nextB,
          },
          { projectId: mockFileContext.projectRoot, runId },
        )
      },
    } as any)

    expect(clientCalls).toBe(1)
    const recoveredOutput = recoveredResult.output[0]
    expect(recoveredOutput.type).toBe('json')
    if (recoveredOutput.type === 'json') {
      expect(recoveredOutput.value).not.toHaveProperty('errorMessage')
    }
  })

  it('lets a follow-up write_file on a non-failing target apply without an intervening re-read', async () => {
    // The narrowed contract end-to-end: a multi-file transaction aborts on one
    // path, and a whole-file overwrite of a DIFFERENT (non-failing) target then
    // succeeds with no re-read of that path at all. write_file never
    // auto-rereads, so it can only apply if the retained whole-file
    // authorization for pathA survived the abort and still hash-matches disk.
    const pathA = 'src/retained-a.ts'
    const pathB = 'src/retained-b.ts'
    const contentA = 'export const value = 1\n'
    const contentB = 'export const peer = 1\n'
    const overwrittenA = 'export const value = 42\n'
    const runId = defaultTestAuthorityScope.runId
    const fileProcessingState = createFileProcessingState()
    fileProcessingState.strictReadBeforeEdit = true

    const diskContentByPath: Record<string, string> = {
      [pathA]: contentA,
      [pathB]: contentB,
    }

    // Establish both normalized and raw authority through authenticated reads.
    await readWholeFiles(
      [pathA, pathB],
      diskContentByPath,
      fileProcessingState,
      'initial-whole-file-reads',
    )

    let clientCalls = 0
    const abortResult = await handleEditTransaction({
      ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'retained-auth-abort',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'str_replace',
              path: pathA,
              replacements: [
                {
                  oldString: 'export const value = 1',
                  newString: 'export const value = 2',
                  allowMultiple: false,
                },
              ],
            },
            {
              type: 'str_replace',
              path: pathB,
              replacements: [
                {
                  oldString: 'export const peer = 999',
                  newString: 'export const peer = 2',
                  allowMultiple: false,
                },
              ],
            },
          ],
        },
      },
      fileProcessingState,
      fileContext: mockFileContext,
      runId,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        diskContentByPath[filePath] ?? null,
      requestClientToolCall: async () => {
        clientCalls += 1
        throw new Error('must not apply multi-file match abort')
      },
    } as any)

    expect(clientCalls).toBe(0)
    const abortOutput = abortResult.output[0]
    expect(abortOutput.type).toBe('json')
    if (abortOutput.type === 'json') {
      const value = abortOutput.value as { recovery?: { paths?: string[] } }
      expect(value.recovery?.paths).toEqual([pathB])
    }

    // No read_files call between the abort and this whole-file overwrite.
    const followUpResult = await handleEditTransaction({
      ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'retained-auth-follow-up',
        toolName: 'edit_transaction',
        input: {
          edits: [
            {
              type: 'write_file',
              path: pathA,
              content: overwrittenA,
            },
          ],
        },
      },
      fileProcessingState,
      fileContext: mockFileContext,
      runId,
      logger,
      requestOptionalFile: async ({ filePath }: { filePath: string }) =>
        diskContentByPath[filePath] ?? null,
      requestClientToolCall: async (toolCall: any) => {
        clientCalls += 1
        return confirmedMutationOutput(
          toolCall,
          { [pathA]: overwrittenA },
          { projectId: mockFileContext.projectRoot, runId },
        )
      },
    } as any)

    expect(clientCalls).toBe(1)
    const followUpOutput = followUpResult.output[0]
    expect(followUpOutput.type).toBe('json')
    if (followUpOutput.type === 'json') {
      expect(followUpOutput.value).not.toHaveProperty('errorMessage')
    }
    // pathB still needs its fresh read; the abort's narrowing did not clear it.
    expect(fileProcessingState.failedEditRequiresReadByPath[pathB]).toBe(true)
  })
})
