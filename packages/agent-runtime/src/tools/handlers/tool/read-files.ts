import {
  buildReadFilesResultV1,
  type FilesystemError,
  type ReadFilesItemV1,
} from '@codebuff/common/tools/results/filesystem'
import { MAX_READ_BLOCK_BYTES } from '@codebuff/common/tools/params/tool/read-files'
import {
  encodeReadCapabilityToken,
  decodeReadCapabilityToken,
  getContentHash,
  hasAuthoritativeReadCapabilityScope,
  normalizeLineEndings,
} from '@codebuff/common/util/content-hash'
import { jsonToolResult } from '@codebuff/common/util/messages'
import { AbortError } from '@codebuff/common/util/error'

import {
  formatUnsafeToolPathError,
  grantWholeFileReadAuthorization,
  normalizeToolPath,
} from './write-file'
import { classifyReadBlockAuthority } from './read-authority-ladder'
import {
  clearEditRereadRequirement,
  getEditRereadRequirement,
} from './edit-read-state'
import { getFileReadingUpdates } from '../../../get-file-reading-updates'
import {
  authenticateReadFilesItem,
  captureAuthenticatedWholeRead,
} from '../../../util/authenticated-read-source'
import {
  captureTextDocument,
  getRawLineSpan,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'
import type { CapturedTextDocument } from '@codebuff/common/util/byte-text'
import type { RawReadBasisV1 } from '@codebuff/common/util/raw-read-basis'
import {
  buildAroundBlock,
  buildSymbolBlock,
  buildWindowBlock,
  extractSlices,
  type ReadBlockBuilderContext,
} from '../../../structural-read'

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
    // Matches the other handlers (rewrite_symbol / replace_range / str_replace
    // / edit_transaction): a missing fileContext or projectRoot degrades to an
    // empty project id, which hasAuthoritativeReadCapabilityScope rejects, so
    // no read capability is minted instead of the handler throwing a raw
    // TypeError.
    projectId: fileContext?.projectRoot ?? '',
    runId: params.runId ?? '',
  }
  const assertReadActive = () => {
    if (params.signal?.aborted) throw new AbortError('read_files was cancelled')
  }
  const pathInputs = toolCall.input.paths ?? []
  const rangeInputs = toolCall.input.ranges ?? []
  const windowInputs = toolCall.input.windows ?? []
  const aroundInputs = toolCall.input.around ?? []
  const symbolBlockInputs = toolCall.input.symbol ?? []
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
    ...windowInputs.map((window, index) => ({
      selector: 'window' as const,
      requestIndex: pathInputs.length + rangeInputs.length + index,
      path: window.path,
    })),
    ...aroundInputs.map((around, index) => ({
      selector: 'around' as const,
      requestIndex:
        pathInputs.length + rangeInputs.length + windowInputs.length + index,
      path: around.path,
    })),
    ...symbolBlockInputs.map((symbol, index) => ({
      selector: 'symbol' as const,
      requestIndex:
        pathInputs.length +
        rangeInputs.length +
        windowInputs.length +
        aroundInputs.length +
        index,
      path: symbol.path,
    })),
    ...symbolInputs.map((symbol, index) => ({
      selector: 'symbols' as const,
      requestIndex:
        pathInputs.length +
        rangeInputs.length +
        windowInputs.length +
        aroundInputs.length +
        symbolBlockInputs.length +
        index,
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
  const windowRequests = windowInputs.map((entry) => ({
    ...entry,
    path: normalizeToolPath(entry.path),
  }))
  const aroundRequests = aroundInputs.map((entry) => ({
    ...entry,
    path: normalizeToolPath(entry.path),
  }))
  const symbolBlockRequests = symbolBlockInputs.map((entry) => ({
    ...entry,
    path: normalizeToolPath(entry.path),
  }))
  const symbolRequests = symbolInputs.map((entry) => ({
    path: normalizeToolPath(entry.path),
    names: entry.names,
  }))

  await previousToolCallFinished
  assertReadActive()

  const requestedPaths = new Set([
    ...paths,
    ...ranges.map((range) => range.path),
    ...windowRequests.map((entry) => entry.path),
    ...aroundRequests.map((entry) => entry.path),
    ...symbolBlockRequests.map((entry) => entry.path),
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
  assertReadActive()
  const fileResults = fileReadResult.results.map((result) => {
    if (result.status === 'error') return result
    const completeEditAnchor = authenticateReadFilesItem(
      result,
      capabilityIssuer,
    )
    const refs =
      result.selector === 'file'
        ? fileContext?.tokenCallers?.[result.path]
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
      // A truncated file/range exposes no edit anchor and cannot establish
      // that the agent saw the content needed to recover from a failed edit.
      .filter(
        (result) =>
          result.status === 'ok' &&
          'complete' in result &&
          result.complete === true &&
          'editAnchor' in result &&
          Boolean(result.editAnchor),
      )
      .map((result) => result.path),
  )

  // Paths whose observed coverage classifies as 'whole_file' on the shared
  // read-authority ladder may clear context_compacted. Anything the ladder
  // calls 'scoped'/'none' (partial reads, range subsets, symbol slices) may
  // still clear other reread reasons (failed_edit gates) but must not drop
  // context_compacted.
  const wholeFileGrantPaths = new Set<string>()

  for (const result of fileResults) {
    const verified = captureAuthenticatedWholeRead(result, capabilityIssuer)
    if (!verified) continue
    if (
      !grantWholeFileReadAuthorization(
        fileProcessingState,
        result.path,
        verified.document.rawText,
        verified.anchor.rawBasis,
      )
    )
      continue
    wholeFileGrantPaths.add(result.path)
    delete fileProcessingState.confirmedPostEditAnchorsByPath?.[result.path]
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
    clearEditRereadRequirement(fileProcessingState, path, {
      clearContextCompacted: true,
    })
    delete fileProcessingState.promisesByPath[path]
  }

  const renderedFileResults = fileResults.map((result) => {
    const modelResult = { ...result }
    if ('rawSourceContent' in modelResult) delete modelResult.rawSourceContent
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
        ...modelResult,
        content: `${CHANGED_SINCE_LAST_READ_MARKER}\n${modelContent}`,
      }
    }
    return modelContent === undefined
      ? modelResult
      : { ...modelResult, content: modelContent }
  })

  // -------------------------------------------------------------------------
  // windows / around selectors: share one memoized loader, one anchor minter,
  // one authority ladder, and one byte-budget guard with read_blocks via the
  // shared block builders.
  // -------------------------------------------------------------------------
  const blockFileCache = new Map<
    string,
    Promise<
      | { content: string; sourceReadCapability?: string }
      | { error: FilesystemError }
    >
  >()
  const blockDocumentsByPath = new Map<string, CapturedTextDocument>()
  const loadBlockFile = (
    path: string,
  ): Promise<
    | { content: string; sourceReadCapability?: string }
    | { error: FilesystemError }
  > => {
    let cached = blockFileCache.get(path)
    if (!cached) {
      cached = (async () => {
        try {
          const read = await getFileReadingUpdates({
            requestFiles: params.requestFiles,
            requestedFiles: [path],
            capabilityIssuer,
            signal: params.signal,
          })
          assertReadActive()
          const item = read.results[0]
          if (item?.status === 'error') return { error: item.error }
          if (
            !item ||
            item.selector !== 'file' ||
            !item.complete ||
            typeof item.content !== 'string'
          ) {
            return {
              error: {
                code: 'too_large',
                message: `A complete bounded source is unavailable for structural reads of ${path}. Request a smaller line range.`,
                retryable: true,
                recovery: 'read_smaller_range',
              } satisfies FilesystemError,
            }
          }
          const verified = captureAuthenticatedWholeRead(item, capabilityIssuer)
          if (!verified) return { content: item.content }
          blockDocumentsByPath.set(path, verified.document)
          return {
            content: verified.document.rawText,
            sourceReadCapability: verified.anchor.readCapability,
          }
        } catch (error) {
          if (error instanceof AbortError) throw error
          return { error: classifyOptionalReadError(error) }
        }
      })()
      blockFileCache.set(path, cached)
    }
    return cached
  }

  const mintBlockEditAnchor = (
    path: string,
    startLine: number,
    endLine: number,
    blockContent: string,
  ) => {
    assertReadActive()
    const scope = { ...capabilityIssuer, path }
    if (!hasAuthoritativeReadCapabilityScope(scope)) return undefined
    const document = blockDocumentsByPath.get(path)
    if (!document) return undefined
    const span = getRawLineSpan(document, startLine, endLine)
    if (
      document.observation.slice(
        span.startObservationOffset,
        span.endObservationOffset,
      ) !== blockContent
    )
      return undefined
    const rawBasis = getRawReadBasis(document, startLine, endLine, 'lines')
    const contentHash = getContentHash(blockContent)
    return {
      startLine,
      endLine,
      contentHash,
      readCapability: encodeReadCapabilityToken({
        startLine,
        endLine,
        hash: contentHash,
        scope,
        rawBasis,
      }),
      rawBasis,
    }
  }

  const applyBlockAuthority = (blockParams: {
    path: string
    startLine: number
    endLine: number
    totalLines: number
    sourceContent: string
    capabilityEligible?: boolean
    rawBasis?: RawReadBasisV1
  }) => {
    const authority = classifyReadBlockAuthority({
      complete: true,
      startLine: blockParams.startLine,
      endLine: blockParams.endLine,
      totalLines: blockParams.totalLines,
      sourceContent: blockParams.sourceContent,
      ...(blockParams.capabilityEligible === undefined
        ? {}
        : { capabilityEligible: blockParams.capabilityEligible }),
      rawBasis: blockParams.rawBasis,
    })
    if (authority !== 'whole_file') return
    const document = blockDocumentsByPath.get(blockParams.path)
    if (
      !document ||
      !grantWholeFileReadAuthorization(
        fileProcessingState,
        blockParams.path,
        document.rawText,
        blockParams.rawBasis,
      )
    )
      return
    wholeFileGrantPaths.add(blockParams.path)
    delete fileProcessingState.confirmedPostEditAnchorsByPath?.[
      blockParams.path
    ]
  }

  // A block that exceeds the byte budget mints no editAnchor and never counts
  // as a successful read, so it cannot clear failed_edit gates.
  const overBudgetError = (
    blockContent: string,
  ): FilesystemError | undefined => {
    const byteLength = new TextEncoder().encode(blockContent).byteLength
    if (byteLength <= MAX_READ_BLOCK_BYTES) return undefined
    return {
      code: 'too_large',
      message: `read_files block is ${byteLength} bytes, over the ${MAX_READ_BLOCK_BYTES}-byte per-block budget. Request a smaller block (lower windowSize, or fewer contextLines) and read it in several passes.`,
      retryable: true,
      recovery: 'read_smaller_range',
    }
  }

  const blockBuilderContext: ReadBlockBuilderContext = {
    loadFile: loadBlockFile,
    mintBlockEditAnchor,
    applyBlockAuthority,
    overBudgetError,
    capabilityIssuer,
    successfulReadPaths,
  }

  const blockItems: ReadFilesItemV1[] = []
  for (let index = 0; index < windowRequests.length; index++) {
    blockItems.push(
      await buildWindowBlock(
        blockBuilderContext,
        windowRequests[index]!,
        paths.length + ranges.length + index,
      ),
    )
  }
  for (let index = 0; index < aroundRequests.length; index++) {
    blockItems.push(
      await buildAroundBlock(
        blockBuilderContext,
        aroundRequests[index]!,
        paths.length + ranges.length + windowRequests.length + index,
      ),
    )
  }
  for (let index = 0; index < symbolBlockRequests.length; index++) {
    blockItems.push(
      await buildSymbolBlock(
        blockBuilderContext,
        symbolBlockRequests[index]!,
        paths.length +
          ranges.length +
          windowRequests.length +
          aroundRequests.length +
          index,
      ),
    )
  }

  // Line and structural blocks retain scoped authority, including full-looking
  // blocks. They may clear failed_edit gates while preserving context_compacted.
  const blockReadPaths = new Set<string>()
  for (const item of blockItems) {
    if (item.status !== 'error' && 'editAnchor' in item && item.editAnchor)
      blockReadPaths.add(item.path)
  }
  for (const path of blockReadPaths) {
    const rereadReq = getEditRereadRequirement(fileProcessingState, path)
    if (
      rereadReq?.reason === 'context_compacted' &&
      !wholeFileGrantPaths.has(path)
    ) {
      delete fileProcessingState.promisesByPath[path]
      continue
    }
    clearEditRereadRequirement(fileProcessingState, path, {
      clearContextCompacted: true,
    })
    delete fileProcessingState.promisesByPath[path]
  }

  const symbolResults: ReadFilesItemV1[] = []
  for (let index = 0; index < symbolRequests.length; index++) {
    const request = symbolRequests[index]!
    const requestIndex =
      paths.length +
      ranges.length +
      windowRequests.length +
      aroundRequests.length +
      symbolBlockRequests.length +
      index
    const loaded = await loadBlockFile(request.path)
    if ('error' in loaded) {
      symbolResults.push({
        selector: 'symbols',
        requestIndex,
        path: request.path,
        status: 'error',
        error: loaded.error,
      })
      continue
    }

    const symbolScope = { ...capabilityIssuer, path: request.path }
    const slices = (
      await extractSlices(
        loaded.content,
        request.path,
        request.names,
        undefined,
        // A non-authoritative scope mints no slice capability instead of
        // letting encodeReadCapabilityToken throw.
        hasAuthoritativeReadCapabilityScope(symbolScope)
          ? symbolScope
          : undefined,
        loaded.sourceReadCapability,
      )
    ).map((slice) => {
      const sliceWithoutCapability = { ...slice }
      delete sliceWithoutCapability.readCapability
      if (!slice.readCapability) return sliceWithoutCapability
      const contentHash = getContentHash(slice.content)
      const capability = decodeReadCapabilityToken(slice.readCapability)
      if (typeof capability === 'string' || capability.tokenVersion !== 'v4')
        return sliceWithoutCapability
      return {
        ...sliceWithoutCapability,
        editAnchor: {
          startLine: slice.startLine,
          endLine: slice.endLine,
          contentHash,
          readCapability: slice.readCapability,
          rawBasis: capability.rawBasis,
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

    // Keep each complete slice and its capability up to the response budget;
    // never discard already useful slices because a later one is too large.
    let returnedBytes = 0
    const returnedSlices: typeof slices = []
    const omittedSymbols: string[] = []
    for (const slice of slices) {
      const bytes = Buffer.byteLength(slice.content, 'utf8')
      if (
        bytes > MAX_READ_BLOCK_BYTES ||
        returnedBytes + bytes > MAX_READ_BLOCK_BYTES
      ) {
        omittedSymbols.push(slice.symbol)
      } else {
        returnedSlices.push(slice)
        returnedBytes += bytes
      }
    }
    if (
      returnedSlices.some((slice) => 'editAnchor' in slice && slice.editAnchor)
    ) {
      successfulReadPaths.add(request.path)
      const symbolRereadReq = getEditRereadRequirement(
        fileProcessingState,
        request.path,
      )
      if (symbolRereadReq?.reason !== 'context_compacted') {
        clearEditRereadRequirement(fileProcessingState, request.path, {
          clearContextCompacted: true,
        })
      }
      delete fileProcessingState.promisesByPath[request.path]
    }
    symbolResults.push({
      selector: 'symbols',
      requestIndex,
      path: request.path,
      status:
        missingSymbols.length > 0 || omittedSymbols.length > 0
          ? 'partial'
          : 'ok',
      requestedSymbols: request.names,
      missingSymbols,
      slices: returnedSlices,
      ...(omittedSymbols.length > 0 && {
        omittedSymbols,
        recovery: `Some symbol slices exceeded the ${MAX_READ_BLOCK_BYTES}-byte response budget. Request omitted symbols separately, or use smaller ranges/windows for a single oversized symbol.`,
      }),
    })
  }

  const allResults: ReadFilesItemV1[] = [
    ...renderedFileResults,
    ...blockItems,
    ...symbolResults,
  ]

  // M2-T4: when a whole-file paths read was rejected or truncated for size,
  // also emit the window manifest for that path plus its first window so the
  // agent can page immediately. The failure information stays in the same
  // result (status 'partial' + truncation) and no whole-file capability is
  // minted for it. Each synthesized manifest item is inserted immediately
  // after the truncated file item it belongs to, then every requestIndex is
  // renumbered contiguously so the summary invariant still holds.
  const truncatedFilePaths = new Set<string>()
  for (const result of allResults) {
    if (
      result.selector === 'file' &&
      result.status === 'partial' &&
      !result.complete &&
      // Only synthesize a manifest when this path has no other selector item
      // (the agent already has another way to page it).
      !allResults.some((item) => item !== result && item.path === result.path)
    ) {
      truncatedFilePaths.add(result.path)
    }
  }
  if (truncatedFilePaths.size > 0) {
    const DEFAULT_MANIFEST_WINDOW_SIZE = 400
    const manifestByPath = new Map<string, ReadFilesItemV1>()
    for (const path of truncatedFilePaths) {
      const loaded = await loadBlockFile(path)
      if ('error' in loaded) continue
      const lines = captureTextDocument(loaded.content).observation.split('\n')
      const totalLines = lines.length
      const windowSize = DEFAULT_MANIFEST_WINDOW_SIZE
      const windowCount = Math.max(1, Math.ceil(totalLines / windowSize))
      const startLine = 1
      const endLine = Math.min(totalLines, windowSize)
      const blockContent = lines.slice(0, endLine).join('\n')
      if (overBudgetError(blockContent)) continue
      // Never mint an anchor that covers the whole file from a truncated
      // read: only a strict sub-file first window earns a scoped capability,
      // so the partial paths read cannot be laundered into whole-file auth.
      const editAnchor =
        endLine < totalLines
          ? mintBlockEditAnchor(path, startLine, endLine, blockContent)
          : undefined
      manifestByPath.set(path, {
        selector: 'window',
        requestIndex: -1, // reassigned below
        path,
        status: 'ok',
        content: blockContent,
        sourceContent: blockContent,
        startLine,
        endLine,
        totalLines,
        complete: true,
        windowSize,
        windowCount,
        window: 1,
        ...(editAnchor ? { editAnchor } : {}),
      })
    }
    if (manifestByPath.size > 0) {
      const withManifests: ReadFilesItemV1[] = []
      for (const item of allResults) {
        withManifests.push(item)
        if (
          item.selector === 'file' &&
          item.status === 'partial' &&
          manifestByPath.has(item.path)
        ) {
          withManifests.push(manifestByPath.get(item.path)!)
        }
      }
      withManifests.forEach((item, index) => {
        item.requestIndex = index
      })
      allResults.length = 0
      allResults.push(...withManifests)
    }
  }

  return {
    output: jsonToolResult(buildReadFilesResultV1(allResults)),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>

export function classifyOptionalReadError(error: unknown): {
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
