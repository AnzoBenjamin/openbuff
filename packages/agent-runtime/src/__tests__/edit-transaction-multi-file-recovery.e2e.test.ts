import { buildReadFilesResultV1 } from '@codebuff/common/tools/results/filesystem'
import { getExactContentHash } from '@codebuff/common/util/content-hash'
import { describe, expect, it } from 'bun:test'

import { handleEditTransaction } from '../tools/handlers/tool/edit-transaction'
import { handleReadFiles } from '../tools/handlers/tool/read-files'
import {
  encodeReadCapabilityToken,
  getContentHash,
} from '../process-str-replace'
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

function buildWholeFileReadResultV1(
  filePaths: string[],
  getContent: (path: string) => string | null,
) {
  return buildReadFilesResultV1(
    filePaths.map((path, requestIndex) => {
      const content = getContent(path)
      return content === null
        ? {
            selector: 'file' as const,
            requestIndex,
            path,
            status: 'error' as const,
            error: {
              code: 'not_found' as const,
              message: '[FILE_DOES_NOT_EXIST]',
              retryable: true,
              recovery: 'discover_path' as const,
            },
          }
        : {
            selector: 'file' as const,
            requestIndex,
            path,
            status: 'ok' as const,
            content,
            complete: true,
            template: false,
          }
    }),
  )
}

function confirmedMutationOutput(
  toolCall: any,
  expectedContentByPath: Record<string, string>,
  scope: { projectId: string; runId: string } = defaultTestAuthorityScope,
) {
  const changes = Array.isArray(toolCall.input)
    ? toolCall.input
    : [toolCall.input]
  const operationId = toolCall.toolCallId
  const receiptId = `${operationId}-receipt`
  type SyntheticAction = {
    actionId: string
    index: number
    action: 'create' | 'update' | 'delete' | 'move'
    path: string
    destinationPath?: string
    beforeHash: string | null
  } & (
    | { afterHash: null }
    | {
        afterHash: string
        afterContent: string
        editAnchor: {
          startLine: number
          endLine: number
          contentHash: string
          readCapability: string
        }
      }
  )
  const actions: SyntheticAction[] = changes.map(
    (change: any, index: number) => {
      const action =
        change.type === 'delete' || change.type === 'move'
          ? change.type
          : change.expectedHash === null
            ? 'create'
            : 'update'
      const finalPath = change.destinationPath ?? change.path
      const finalContent =
        action === 'delete' ? undefined : expectedContentByPath[finalPath]
      if (action !== 'delete' && finalContent === undefined) {
        throw new Error(`Missing expected post-edit content for ${finalPath}`)
      }
      const endLine = finalContent?.replace(/\r\n?/g, '\n').split('\n').length
      const editAnchor =
        finalContent === undefined
          ? undefined
          : {
              startLine: 1,
              endLine: endLine!,
              contentHash: getContentHash(finalContent),
              readCapability: encodeReadCapabilityToken({
                startLine: 1,
                endLine: endLine!,
                hash: getContentHash(finalContent),
                scope: {
                  projectId: scope.projectId,
                  path: finalPath,
                  runId: scope.runId,
                },
              }),
            }
      return {
        actionId: `${operationId}:${index}`,
        index,
        action,
        path: change.path,
        ...(change.destinationPath
          ? { destinationPath: change.destinationPath }
          : {}),
        beforeHash: change.expectedHash ?? null,
        afterHash:
          action === 'delete' ? null : getExactContentHash(finalContent!),
        ...(finalContent === undefined
          ? {}
          : { afterContent: finalContent, editAnchor }),
      } as SyntheticAction
    },
  )
  const receipt = {
    kind: 'commit_receipt' as const,
    version: 1 as const,
    receiptId,
    operationId,
    callId: operationId,
    authorityTier: 'portable_path' as const,
    status: 'committed' as const,
    actions: actions.map((action) => ({
      actionId: action.actionId,
      index: action.index,
      action: action.action,
      path: action.path,
      ...('destinationPath' in action
        ? { destinationPath: action.destinationPath }
        : {}),
      status: 'committed' as const,
      beforeHash: action.beforeHash,
      afterHash: action.afterHash,
    })),
    finalHashes: Object.fromEntries(
      actions.map((action) => [
        'destinationPath' in action ? action.destinationPath! : action.path,
        action.afterHash,
      ]),
    ),
  }
  const canonicalProject = mockFileContext.projectRoot
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
  const freshCapabilities = actions.flatMap((action) => {
    if (action.afterHash === null || !('editAnchor' in action)) return []
    const finalPath = action.destinationPath ?? action.path
    return [
      {
        kind: 'whole_file' as const,
        version: 1 as const,
        token: action.editAnchor.readCapability,
        snapshot: {
          kind: 'file_snapshot' as const,
          version: 1 as const,
          canonicalPath: `${canonicalProject}/${finalPath
            .replaceAll('\\', '/')
            .replace(/^\.\//, '')}`,
          contentHash: action.afterHash,
          sizeBytes: Buffer.byteLength(action.afterContent),
          encoding: 'utf8' as const,
          readGeneration: Date.now(),
        },
      },
    ]
  })
  return [
    {
      type: 'json' as const,
      value: {
        kind: 'file_mutation_result',
        version: 1,
        operationId,
        outcome: 'applied',
        actions: actions.map((action) => ({
          ...action,
          outcome: 'applied' as const,
        })),
        authorityTier: 'portable_path',
        receiptId,
        authorityReceipt: receipt,
        errors: [],
        freshCapabilities,
      },
    },
  ]
}

describe('edit_transaction multi-file no-match recovery loop', () => {
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
    fileProcessingState.readAuthorizationsByPath = {
      [pathA]: true,
      [pathB]: true,
    }
    fileProcessingState.readAuthorizationHashesByPath = {
      [pathA]: getContentHash(contentA),
      [pathB]: getContentHash(contentB),
    }

    const diskContentByPath: Record<string, string> = {
      [pathA]: contentA,
      [pathB]: contentB,
    }

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
    await handleReadFiles({
      ...defaultTestHandlerAuthority,
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'multi-file-recovery-reread',
        toolName: 'read_files',
        input: { paths: [pathB] },
      },
      fileContext: mockFileContext,
      fileProcessingState,
      requestFiles: async ({ filePaths }: { filePaths: string[] }) =>
        buildWholeFileReadResultV1(
          filePaths,
          (filePath) => diskContentByPath[filePath] ?? null,
        ),
      logger,
    } as any)

    for (const path of [pathA, pathB]) {
      expect(
        fileProcessingState.failedEditRequiresReadByPath[path],
      ).toBeUndefined()
      expect(fileProcessingState.readAuthorizationsByPath?.[path]).toBe(true)
      expect(fileProcessingState.readAuthorizationHashesByPath?.[path]).toBe(
        getContentHash(diskContentByPath[path]),
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
    fileProcessingState.readAuthorizationsByPath = {
      [pathA]: true,
      [pathB]: true,
    }
    fileProcessingState.readAuthorizationHashesByPath = {
      [pathA]: getContentHash(contentA),
      [pathB]: getContentHash(contentB),
    }

    const diskContentByPath: Record<string, string> = {
      [pathA]: contentA,
      [pathB]: contentB,
    }

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
