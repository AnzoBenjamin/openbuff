import {
  buildReadFilesResultV1,
  type ReadFilesItemV1,
} from '@codebuff/common/tools/results/filesystem'
import {
  encodeReadCapabilityToken,
  getContentHash,
  normalizeLineEndings,
} from '@codebuff/common/util/content-hash'
import { jsonToolResult } from '@codebuff/common/util/messages'

import {
  formatUnsafeToolPathError,
  grantWholeFileReadAuthorization,
  normalizeToolPath,
} from './write-file'
import {
  clearEditRereadRequirement,
  getEditRereadRequirement,
} from './edit-read-state'
import { getFileReadingUpdates } from '../../../get-file-reading-updates'
import { extractSlices } from '../../../structural-read'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type { FileProcessingState } from './write-file'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { RequestOptionalFileFn } from '@codebuff/common/types/contracts/client'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ProjectFileContext } from '@codebuff/common/util/file'

type ToolName = 'read_files'

const CHANGED_SINCE_LAST_READ_MARKER =
  '[NOTE — changed since last read: you have already edited this file in the current turn. The content below reflects the CURRENT post-edit state; line numbers may have shifted from any earlier read of this path. Anchor your next edit on THIS read.]'

export const handleReadFiles = (async (
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: CodebuffToolCall<ToolName>
    requestOptionalFile: RequestOptionalFileFn
    logger: Logger

    fileContext: ProjectFileContext
    fileProcessingState: FileProcessingState
    runId: string
  } & ParamsExcluding<typeof getFileReadingUpdates, 'requestedFiles'>,
): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const {
    previousToolCallFinished,
    toolCall,
    requestOptionalFile,
    fileContext,
    fileProcessingState,
  } = params
  const capabilityIssuer = {
    projectId: fileContext.projectRoot,
    runId: params.runId ?? '',
  }
  const pathInputs = toolCall.input.paths ?? []
  const rangeInputs = toolCall.input.ranges ?? []
  const symbolInputs = toolCall.input.symbols ?? []
  const allSelectors = [
    ...pathInputs.map((path, requestIndex) => ({
      selector: 'file' as const,
      requestIndex,
      path,
    })),
    ...rangeInputs.map((range, index) => ({
      selector: 'range' as const,
      requestIndex: pathInputs.length + index,
      path: range.path,
    })),
    ...symbolInputs.map((symbol, index) => ({
      selector: 'symbols' as const,
      requestIndex: pathInputs.length + rangeInputs.length + index,
      path: symbol.path,
    })),
  ]
  const invalidSelector = allSelectors.find(
    (selector) => !normalizeToolPath(selector.path),
  )
  if (invalidSelector) {
    const results: ReadFilesItemV1[] = allSelectors.map((selector) => ({
      selector: selector.selector,
      requestIndex: selector.requestIndex,
      path: selector.path,
      status: 'error',
      error:
        selector === invalidSelector
          ? {
              code: 'outside_project',
              message: formatUnsafeToolPathError('read_files', selector.path),
              retryable: false,
            }
          : {
              code: 'invalid_request',
              message: `read_files batch was not executed because selector ${invalidSelector.requestIndex} has an unsafe path.`,
              retryable: true,
            },
    }))
    return {
      output: jsonToolResult(
        buildReadFilesResultV1(results),
      ) as CodebuffToolOutput<ToolName>,
    }
  }

  const paths = pathInputs.map(normalizeToolPath)
  const ranges = rangeInputs.map((range) => ({
    ...range,
    path: normalizeToolPath(range.path),
  }))
  const symbolRequests = symbolInputs.map((entry) => ({
    path: normalizeToolPath(entry.path),
    names: entry.names,
  }))

  await previousToolCallFinished

  const requestedPaths = new Set([
    ...paths,
    ...ranges.map((range) => range.path),
    ...symbolRequests.map((entry) => entry.path),
  ])
  const editedSinceLastRead = new Set<string>()
  for (const path of requestedPaths) {
    if ((fileProcessingState.promisesByPath[path]?.length ?? 0) > 0) {
      editedSinceLastRead.add(path)
    }
    const anchor = fileProcessingState.confirmedPostEditAnchorsByPath?.[path]
    const storedHash = fileProcessingState.readAuthorizationHashesByPath?.[path]
    const selectorCategory = paths.includes(path)
      ? 'whole_file'
      : ranges.some((range) => range.path === path)
        ? 'range'
        : 'symbols'
    const category =
      !anchor || !storedHash
        ? 'missing'
        : anchor.contentHash !== storedHash
          ? 'stale'
          : selectorCategory === 'whole_file'
            ? 'reuse_eligible'
            : 'different_region'
    if (editedSinceLastRead.has(path) || anchor) {
      params.logger.debug(
        { path, reason: 'immediate_post_edit_reread', category },
        'read_files requested a path with current confirmed post-edit authorization',
      )
    }
  }

  const fileReadResult = await getFileReadingUpdates({
    ...params,
    requestedFiles: paths,
    ranges,
    capabilityIssuer,
  })
  const fileResults = fileReadResult.results.map((result) => {
    if (result.status === 'error') return result
    const completeEditAnchor = (() => {
      if (
        result.selector === 'file' &&
        result.complete &&
        typeof result.content === 'string'
      ) {
        const contentHash = getContentHash(result.content)
        const startLine = 1
        const endLine = normalizeLineEndings(result.content).split('\n').length
        const readCapability = encodeReadCapabilityToken({
          startLine,
          endLine,
          hash: contentHash,
          scope: { ...capabilityIssuer, path: result.path },
        })
        return { startLine, endLine, contentHash, readCapability }
      }
      if (
        result.selector === 'range' &&
        result.complete &&
        result.editAnchor &&
        /^sha256:[a-f0-9]{64}$/.test(result.editAnchor.contentHash)
      ) {
        const readCapability = encodeReadCapabilityToken({
          startLine: result.startLine,
          endLine: result.endLine,
          hash: result.editAnchor.contentHash,
          scope: { ...capabilityIssuer, path: result.path },
        })
        return {
          startLine: result.startLine,
          endLine: result.endLine,
          contentHash: result.editAnchor.contentHash,
          readCapability,
        }
      }
      return undefined
    })()
    const refs =
      result.selector === 'file'
        ? fileContext.tokenCallers?.[result.path]
        : undefined
    const resultWithoutCapability = { ...result }
    if ('editAnchor' in resultWithoutCapability) {
      delete resultWithoutCapability.editAnchor
    }
    return {
      ...resultWithoutCapability,
      ...(completeEditAnchor ? { editAnchor: completeEditAnchor } : {}),
      ...(refs && Object.keys(refs).length > 0 ? { referencedBy: refs } : {}),
    }
  })

  const successfulReadPaths = new Set(
    fileResults
      .filter((result) => result.status !== 'error')
      .map((result) => result.path),
  )

  // Paths that receive a complete whole-file sticky grant (or the same complete
  // whole-file result that would mint one) may clear context_compacted.
  // Partial/range-subset/symbol success may still clear other reread reasons
  // (failed_edit gates) but must not drop context_compacted.
  const wholeFileGrantPaths = new Set<string>()

  for (const result of fileResults) {
    if (
      result.selector === 'file' &&
      result.status === 'ok' &&
      result.complete &&
      typeof result.content === 'string'
    ) {
      wholeFileGrantPaths.add(result.path)
      delete fileProcessingState.confirmedPostEditAnchorsByPath?.[result.path]
      if (fileProcessingState.strictReadBeforeEdit) {
        grantWholeFileReadAuthorization(
          fileProcessingState,
          result.path,
          result.content,
        )
      }
    }
    // Promote complete full-file range reads (1..totalLines) to sticky whole-file
    // auth — same as paths reads. Truncated/partial ranges never grant.
    if (
      result.selector === 'range' &&
      result.status === 'ok' &&
      result.complete === true &&
      typeof result.content === 'string'
    ) {
      const totalLines =
        'totalLines' in result && typeof result.totalLines === 'number'
          ? result.totalLines
          : undefined
      const isFullFileCoverage =
        result.startLine === 1 &&
        totalLines !== undefined &&
        result.endLine === totalLines
      if (isFullFileCoverage) {
        // Prefer undecorated sourceContent (hash-stable whole-file bytes).
        // Numbered display content alone is not used for granting.
        const wholeFileContent =
          'sourceContent' in result &&
          typeof result.sourceContent === 'string'
            ? result.sourceContent
            : null
        if (wholeFileContent !== null) {
          wholeFileGrantPaths.add(result.path)
          delete fileProcessingState.confirmedPostEditAnchorsByPath?.[result.path]
          if (fileProcessingState.strictReadBeforeEdit) {
            grantWholeFileReadAuthorization(
              fileProcessingState,
              result.path,
              wholeFileContent,
            )
          }
        }
      }
    }
  }

  for (const path of successfulReadPaths) {
    const rereadReq = getEditRereadRequirement(fileProcessingState, path)
    if (
      rereadReq?.reason === 'context_compacted' &&
      !wholeFileGrantPaths.has(path)
    ) {
      // Preserve context_compacted until a complete whole-file grant; still
      // drop stale per-path edit content so later anchors use current disk.
      delete fileProcessingState.promisesByPath[path]
      continue
    }
    clearEditRereadRequirement(fileProcessingState, path)
    delete fileProcessingState.promisesByPath[path]
  }

  const renderedFileResults = fileResults.map((result) => {
    const modelContent =
      result.status !== 'error' &&
      result.selector === 'range' &&
      typeof result.content === 'string'
        ? result.content.replace(/^\[RANGE_BLOCK [^\n]*\]\n/, '')
        : result.status !== 'error' && 'content' in result
          ? result.content
          : undefined
    if (
      result.status !== 'error' &&
      result.selector !== 'symbols' &&
      typeof modelContent === 'string' &&
      editedSinceLastRead.has(result.path)
    ) {
      return {
        ...result,
        content: `${CHANGED_SINCE_LAST_READ_MARKER}\n${modelContent}`,
      }
    }
    return modelContent === undefined
      ? result
      : { ...result, content: modelContent }
  })

  const symbolResults: ReadFilesItemV1[] = []
  for (let index = 0; index < symbolRequests.length; index++) {
    const request = symbolRequests[index]!
    const requestIndex = paths.length + ranges.length + index
    let rawContent: string | null
    try {
      rawContent = await requestOptionalFile({
        ...params,
        filePath: request.path,
      })
    } catch (error) {
      symbolResults.push({
        selector: 'symbols',
        requestIndex,
        path: request.path,
        status: 'error',
        error: classifyOptionalReadError(error),
      })
      continue
    }
    if (rawContent === null) {
      symbolResults.push({
        selector: 'symbols',
        requestIndex,
        path: request.path,
        status: 'error',
        error: {
          code: 'not_found',
          message: `File does not exist: ${request.path}`,
          retryable: true,
          recovery: 'discover_path',
        },
      })
      continue
    }

    const slices = (
      await extractSlices(rawContent, request.path, request.names, undefined, {
        ...capabilityIssuer,
        path: request.path,
      })
    ).map((slice) => {
      if (!slice.readCapability) return slice
      const contentHash = getContentHash(slice.content)
      const readCapability = encodeReadCapabilityToken({
        startLine: slice.startLine,
        endLine: slice.endLine,
        hash: contentHash,
        scope: { ...capabilityIssuer, path: request.path },
      })
      const sliceWithoutCapability = { ...slice }
      delete sliceWithoutCapability.readCapability
      return {
        ...sliceWithoutCapability,
        editAnchor: {
          startLine: slice.startLine,
          endLine: slice.endLine,
          contentHash,
          readCapability,
        },
      }
    })
    const foundSymbols = new Set(slices.map((slice) => slice.symbol))
    const missingSymbols = request.names.filter(
      (name) => !foundSymbols.has(name),
    )
    if (slices.length === 0) {
      symbolResults.push({
        selector: 'symbols',
        requestIndex,
        path: request.path,
        status: 'error',
        error: {
          code: 'no_match',
          message: `None of the requested symbols were found in ${request.path}: ${request.names.join(', ')}`,
          retryable: true,
          recovery: 'choose_symbol',
        },
      })
      continue
    }

    successfulReadPaths.add(request.path)
    // Symbol-only success may clear failed_edit gates but never mints whole-file
    // auth, so it must not drop context_compacted.
    const symbolRereadReq = getEditRereadRequirement(
      fileProcessingState,
      request.path,
    )
    if (symbolRereadReq?.reason !== 'context_compacted') {
      clearEditRereadRequirement(fileProcessingState, request.path)
    }
    delete fileProcessingState.promisesByPath[request.path]
    const slicesTooLarge =
      slices.reduce((total, slice) => total + slice.content.length, 0) > 100_000
    symbolResults.push({
      selector: 'symbols',
      requestIndex,
      path: request.path,
      status: missingSymbols.length > 0 || slicesTooLarge ? 'partial' : 'ok',
      requestedSymbols: request.names,
      missingSymbols,
      ...(slicesTooLarge
        ? { slicesOmittedForLength: true as const }
        : { slices }),
    })
  }

  return {
    output: jsonToolResult(
      buildReadFilesResultV1([...renderedFileResults, ...symbolResults]),
    ),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>

function classifyOptionalReadError(error: unknown): {
  code:
    | 'blocked'
    | 'binary'
    | 'unsupported_encoding'
    | 'too_large'
    | 'io_error'
    | 'cancelled'
  message: string
  retryable: boolean
  recovery?:
    | 'read_again'
    | 'read_smaller_range'
    | 'use_supported_encoding'
    | 'retry'
} {
  const message = error instanceof Error ? error.message : String(error)
  if (/\bblocked\b/i.test(message)) {
    return { code: 'blocked', message, retryable: false }
  }
  if (/\bbinary\b/i.test(message)) {
    return { code: 'binary', message, retryable: false }
  }
  if (/unsupported_encoding|not valid UTF-8/i.test(message)) {
    return {
      code: 'unsupported_encoding',
      message,
      retryable: false,
      recovery: 'use_supported_encoding',
    }
  }
  if (/too_large|complete editable snapshot/i.test(message)) {
    return {
      code: 'too_large',
      message,
      retryable: true,
      recovery: 'read_smaller_range',
    }
  }
  if (/abort|cancel/i.test(message)) {
    return { code: 'cancelled', message, retryable: true, recovery: 'retry' }
  }
  return { code: 'io_error', message, retryable: true, recovery: 'read_again' }
}
