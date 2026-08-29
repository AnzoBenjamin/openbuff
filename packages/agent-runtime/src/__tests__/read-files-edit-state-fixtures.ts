import { buildReadFilesResultV1 } from '@codebuff/common/tools/results/filesystem'
import { getExactContentHash } from '@codebuff/common/util/content-hash'

import {
  encodeReadCapabilityToken,
  getContentHash,
} from '../process-str-replace'
import { mockFileContext } from './test-utils'

import type { FileProcessingState } from '../tools/handlers/tool/write-file'
import type { Logger } from '@codebuff/common/types/contracts/logger'

export { mockFileContext }

export const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export const defaultTestAuthorityScope = {
  projectId: mockFileContext.projectRoot,
  runId: 'read-files-edit-state-test-run',
}

export const defaultTestHandlerAuthority = {
  fileContext: mockFileContext,
  runId: defaultTestAuthorityScope.runId,
}

export function createFileProcessingState(): FileProcessingState {
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

export function buildWholeFileReadResultV1(
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

export function confirmedMutationOutput(
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
        'destinationPath' in action ? action.destinationPath : action.path,
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
