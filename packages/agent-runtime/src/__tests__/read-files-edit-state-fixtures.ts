import { buildReadFilesResultV1 } from '@codebuff/common/tools/results/filesystem'
import {
  getExactContentHash,
  hasAuthoritativeReadCapabilityScope,
} from '@codebuff/common/util/content-hash'
import {
  captureTextDocument,
  getRawLineSpan,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'
import type { RawReadBasisV1 } from '@codebuff/common/util/raw-read-basis'

import { encodeReadCapabilityToken } from '../process-str-replace'
import { mockFileContext } from './test-utils'

import type { FileProcessingState } from '../tools/handlers/tool/write-file'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { RequestFilesFn } from '@codebuff/common/types/contracts/client'

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
  scope: { projectId: string; runId: string } = defaultTestAuthorityScope,
) {
  return buildReadFilesResultV1(
    filePaths.map((path, requestIndex) => {
      const content = getContent(path)
      const document =
        content === null ? undefined : captureTextDocument(content)
      const rawBasis = document
        ? getRawReadBasis(document, 1, document.maxCapabilityLine, 'whole')
        : undefined
      const canIssue = hasAuthoritativeReadCapabilityScope({ ...scope, path })
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
            content: document!.observation,
            ...(canIssue ? { rawSourceContent: document!.rawText } : {}),
            complete: true,
            metadataComplete: true,
            template: false,
            ...(canIssue
              ? {
                  editAnchor: {
                    startLine: 1,
                    endLine: document!.maxCapabilityLine,
                    contentHash: document!.observationHash,
                    readCapability: encodeReadCapabilityToken({
                      startLine: 1,
                      endLine: document!.maxCapabilityLine,
                      hash: document!.observationHash,
                      scope: { ...scope, path },
                      rawBasis,
                    }),
                    rawBasis,
                  },
                }
              : {}),
          }
    }),
  )
}

export function buildRangeReadItemV1(params: {
  path: string
  rawContent: string
  startLine: number
  endLine: number
  requestIndex?: number
  scope?: { projectId: string; runId: string }
  content?: string
}) {
  const { path, startLine, endLine } = params
  const document = captureTextDocument(params.rawContent)
  const span = getRawLineSpan(document, startLine, endLine)
  const sourceContent = document.observation.slice(
    span.startObservationOffset,
    span.endObservationOffset,
  )
  const rangeDocument = captureTextDocument(sourceContent, {
    includesBom: false,
  })
  const rawBasis = getRawReadBasis(document, startLine, endLine, 'lines')
  const scope = { ...(params.scope ?? defaultTestAuthorityScope), path }
  return {
    selector: 'range' as const,
    requestIndex: params.requestIndex ?? 0,
    path,
    status: 'ok' as const,
    content:
      params.content ??
      sourceContent
        .split('\n')
        .map((line, index) => `${startLine + index}\t${line}`)
        .join('\n'),
    sourceContent,
    startLine,
    endLine,
    totalLines: document.visibleLineCount,
    complete: true,
    metadataComplete: true,
    ...(hasAuthoritativeReadCapabilityScope(scope)
      ? {
          editAnchor: {
            startLine,
            endLine,
            contentHash: rangeDocument.observationHash,
            readCapability: encodeReadCapabilityToken({
              startLine,
              endLine,
              hash: rangeDocument.observationHash,
              scope,
              rawBasis,
            }),
            rawBasis,
          },
        }
      : {}),
  }
}

export function buildReadFilesResponseV1(
  input: Parameters<RequestFilesFn>[0],
  getContent: (path: string) => string | null,
) {
  const files = buildWholeFileReadResultV1(
    input.filePaths,
    getContent,
    input.capabilityIssuer,
  )
  return buildReadFilesResultV1([
    ...files.results,
    ...(input.ranges ?? []).map((range, index) => {
      const rawContent = getContent(range.path)
      const requestIndex = input.filePaths.length + index
      if (rawContent === null)
        return {
          selector: 'range' as const,
          requestIndex,
          path: range.path,
          status: 'error' as const,
          error: {
            code: 'not_found' as const,
            message: '[FILE_DOES_NOT_EXIST]',
            retryable: true,
            recovery: 'discover_path' as const,
          },
        }
      const document = captureTextDocument(rawContent)
      return buildRangeReadItemV1({
        path: range.path,
        rawContent,
        startLine: range.startLine ?? 1,
        endLine:
          range.endLine === undefined
            ? Math.max(1, document.visibleLineCount)
            : Math.min(range.endLine, document.maxCapabilityLine),
        requestIndex,
        scope: input.capabilityIssuer,
      })
    }),
  ])
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
          rawBasis: RawReadBasisV1
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
      const document =
        finalContent === undefined
          ? undefined
          : captureTextDocument(finalContent)
      const endLine = document?.maxCapabilityLine
      const rawBasis = document
        ? getRawReadBasis(document, 1, endLine!, 'whole')
        : undefined
      const editAnchor =
        finalContent === undefined
          ? undefined
          : {
              startLine: 1,
              endLine: endLine!,
              contentHash: document!.observationHash,
              readCapability: encodeReadCapabilityToken({
                startLine: 1,
                endLine: endLine!,
                hash: document!.observationHash,
                scope: {
                  projectId: scope.projectId,
                  path: finalPath,
                  runId: scope.runId,
                },
                rawBasis,
              }),
              rawBasis: rawBasis!,
            }
      return {
        actionId: `${operationId}:${index}`,
        index,
        action,
        path: change.path,
        ...(change.destinationPath
          ? { destinationPath: change.destinationPath }
          : {}),
        beforeHash:
          change.expectedRawHash !== undefined
            ? change.expectedRawHash
            : (change.expectedHash ?? null),
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
