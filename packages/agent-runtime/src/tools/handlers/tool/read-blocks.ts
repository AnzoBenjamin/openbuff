import { MAX_READ_BLOCK_BYTES } from '@codebuff/common/tools/params/tool/read-blocks'
import {
  buildReadBlocksResultV1,
  type FilesystemError,
  type ReadBlocksItemV1,
} from '@codebuff/common/tools/results/filesystem'
import {
  encodeReadCapabilityToken,
  getContentHash,
  hasAuthoritativeReadCapabilityScope,
  normalizeLineEndings,
} from '@codebuff/common/util/content-hash'
import { jsonToolResult } from '@codebuff/common/util/messages'

import {
  formatUnsafeToolPathError,
  grantWholeFileReadAuthorization,
  normalizeToolPath,
} from './write-file'
import { classifyReadBlockAuthority } from './read-authority-ladder'
import { classifyOptionalReadError } from './read-files'
import {
  clearEditRereadRequirement,
  getEditRereadRequirement,
} from './edit-read-state'
import {
  findLiteralOccurrences,
  selectSymbolSlice,
} from '../../../structural-read'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type { FileProcessingState } from './write-file'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { RequestOptionalFileFn } from '@codebuff/common/types/contracts/client'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ProjectFileContext } from '@codebuff/common/util/file'

type ToolName = 'read_blocks'

const DEFAULT_WINDOW_SIZE = 400
const DEFAULT_CONTEXT_LINES = 40

/**
 * Read-side parity surface for edit_transaction: returns one or more COMPLETE,
 * capability-minting structural blocks (line windows, literal-anchored context
 * blocks, or occurrence-aware symbol slices) so large files yield usable edit
 * anchors without a guess-shrink-retry loop. Every complete block mints a
 * cap.v3 editAnchor scoped to { projectId, path, runId } exactly like
 * read_files; partial/failed blocks mint NO capability.
 */
export const handleReadBlocks = (async (
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: CodebuffToolCall<ToolName>
    requestOptionalFile: RequestOptionalFileFn
    logger: Logger

    fileContext: ProjectFileContext
    fileProcessingState: FileProcessingState
    runId: string
  },
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
  const windowInputs = toolCall.input.windows ?? []
  const aroundInputs = toolCall.input.around ?? []
  const symbolInputs = toolCall.input.symbols ?? []
  const allSelectors = [
    ...windowInputs.map((window, requestIndex) => ({
      selector: 'window' as const,
      requestIndex,
      path: window.path,
    })),
    ...aroundInputs.map((around, index) => ({
      selector: 'around' as const,
      requestIndex: windowInputs.length + index,
      path: around.path,
    })),
    ...symbolInputs.map((symbol, index) => ({
      selector: 'symbol' as const,
      requestIndex: windowInputs.length + aroundInputs.length + index,
      path: symbol.path,
    })),
  ]
  const invalidSelector = allSelectors.find(
    (selector) => !normalizeToolPath(selector.path),
  )
  if (invalidSelector) {
    const results: ReadBlocksItemV1[] = allSelectors.map((selector) => ({
      selector: selector.selector,
      requestIndex: selector.requestIndex,
      path: selector.path,
      status: 'error',
      error:
        selector === invalidSelector
          ? {
              code: 'outside_project',
              message: formatUnsafeToolPathError('read_blocks', selector.path),
              retryable: false,
            }
          : {
              code: 'invalid_request',
              message: `read_blocks batch was not executed because selector ${invalidSelector.requestIndex} has an unsafe path.`,
              retryable: true,
            },
    }))
    return {
      output: jsonToolResult(
        buildReadBlocksResultV1(results),
      ) as CodebuffToolOutput<ToolName>,
    }
  }

  await previousToolCallFinished

  // Memoize per-path file loads so several selectors on the same file issue a
  // single underlying read.
  const fileCache = new Map<
    string,
    Promise<{ content: string } | { error: FilesystemError }>
  >()
  const loadFile = (
    path: string,
  ): Promise<{ content: string } | { error: FilesystemError }> => {
    let cached = fileCache.get(path)
    if (!cached) {
      cached = (async () => {
        try {
          const raw = await requestOptionalFile({ ...params, filePath: path })
          if (raw === null) {
            return {
              error: {
                code: 'not_found',
                message: `File does not exist: ${path}`,
                retryable: true,
                recovery: 'discover_path',
              } satisfies FilesystemError,
            }
          }
          return { content: raw }
        } catch (error) {
          return { error: classifyOptionalReadError(error) }
        }
      })()
      fileCache.set(path, cached)
    }
    return cached
  }

  const mintBlockEditAnchor = (
    path: string,
    startLine: number,
    endLine: number,
    blockContent: string,
  ) => {
    const scope = { ...capabilityIssuer, path }
    if (!hasAuthoritativeReadCapabilityScope(scope)) return undefined
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
      }),
    }
  }

  const items: ReadBlocksItemV1[] = []
  const successfulReadPaths = new Set<string>()
  const wholeFileGrantPaths = new Set<string>()

  // Single coverage -> authority ladder call per successful block, mirroring
  // read_files: a block that covers exactly 1..totalLines of a complete,
  // capability-eligible read mints the same sticky whole-file authorization an
  // identical read_files whole-file read would. Sub-file blocks grant nothing.
  const applyBlockAuthority = (params: {
    path: string
    startLine: number
    endLine: number
    totalLines: number
    sourceContent: string
    capabilityEligible?: boolean
  }) => {
    const authority = classifyReadBlockAuthority({
      complete: true,
      startLine: params.startLine,
      endLine: params.endLine,
      totalLines: params.totalLines,
      sourceContent: params.sourceContent,
      ...(params.capabilityEligible === undefined
        ? {}
        : { capabilityEligible: params.capabilityEligible }),
    })
    if (authority !== 'whole_file') return
    wholeFileGrantPaths.add(params.path)
    delete fileProcessingState.confirmedPostEditAnchorsByPath?.[params.path]
    if (fileProcessingState.strictReadBeforeEdit) {
      grantWholeFileReadAuthorization(
        fileProcessingState,
        params.path,
        params.sourceContent,
      )
    }
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
      message: `read_blocks block is ${byteLength} bytes, over the ${MAX_READ_BLOCK_BYTES}-byte per-block budget. Request a smaller block (lower windowSize, or fewer contextLines) and read it in several passes.`,
      retryable: true,
      recovery: 'read_smaller_range',
    }
  }

  for (let index = 0; index < windowInputs.length; index++) {
    const request = windowInputs[index]!
    const requestIndex = index
    const path = normalizeToolPath(request.path)
    const loaded = await loadFile(path)
    if ('error' in loaded) {
      items.push({
        selector: 'window',
        requestIndex,
        path,
        status: 'error',
        error: loaded.error,
      })
      continue
    }
    const lines = normalizeLineEndings(loaded.content).split('\n')
    const totalLines = lines.length
    const windowSize = request.windowSize ?? DEFAULT_WINDOW_SIZE
    const windowCount = Math.max(1, Math.ceil(totalLines / windowSize))
    const window = request.window ?? 1
    if (window > windowCount) {
      items.push({
        selector: 'window',
        requestIndex,
        path,
        status: 'error',
        error: {
          code: 'invalid_request',
          message: `read_blocks window ${window} is out of range for ${path}: the file has ${totalLines} lines (${windowCount} window(s) of ${windowSize} lines). Omit window to get the manifest plus the first window.`,
          retryable: true,
          recovery: 'read_smaller_range',
        },
      })
      continue
    }
    const startLine = (window - 1) * windowSize + 1
    const endLine = Math.min(totalLines, window * windowSize)
    const blockContent = lines.slice(startLine - 1, endLine).join('\n')
    const tooLarge = overBudgetError(blockContent)
    if (tooLarge) {
      items.push({
        selector: 'window',
        requestIndex,
        path,
        status: 'error',
        error: tooLarge,
      })
      continue
    }
    const editAnchor = mintBlockEditAnchor(
      path,
      startLine,
      endLine,
      blockContent,
    )
    successfulReadPaths.add(path)
    items.push({
      selector: 'window',
      requestIndex,
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
      window,
      ...(editAnchor ? { editAnchor } : {}),
    })
    applyBlockAuthority({
      path,
      startLine,
      endLine,
      totalLines,
      sourceContent: blockContent,
    })
  }

  for (let index = 0; index < aroundInputs.length; index++) {
    const request = aroundInputs[index]!
    const requestIndex = windowInputs.length + index
    const path = normalizeToolPath(request.path)
    const loaded = await loadFile(path)
    if ('error' in loaded) {
      items.push({
        selector: 'around',
        requestIndex,
        path,
        status: 'error',
        error: loaded.error,
      })
      continue
    }
    const normalized = normalizeLineEndings(loaded.content)
    const lines = normalized.split('\n')
    const totalLines = lines.length
    const occurrence = request.occurrence ?? 1
    const contextLines = request.contextLines ?? DEFAULT_CONTEXT_LINES
    const occurrences = findLiteralOccurrences(normalized, request.match)
    const matched = occurrences[occurrence - 1]
    if (!matched) {
      items.push({
        selector: 'around',
        requestIndex,
        path,
        status: 'error',
        error: {
          code: 'no_match',
          message: `read_blocks found ${occurrences.length} exact occurrence(s) of the match in ${path}, so occurrence ${occurrence} does not exist. Re-check the literal text against a fresh read.`,
          retryable: true,
          recovery: 'read_again',
        },
      })
      continue
    }
    const startLine = Math.max(1, matched.startLine - contextLines)
    const endLine = Math.min(totalLines, matched.endLine + contextLines)
    const blockContent = lines.slice(startLine - 1, endLine).join('\n')
    const tooLarge = overBudgetError(blockContent)
    if (tooLarge) {
      items.push({
        selector: 'around',
        requestIndex,
        path,
        status: 'error',
        error: tooLarge,
      })
      continue
    }
    const editAnchor = mintBlockEditAnchor(
      path,
      startLine,
      endLine,
      blockContent,
    )
    successfulReadPaths.add(path)
    items.push({
      selector: 'around',
      requestIndex,
      path,
      status: 'ok',
      content: blockContent,
      sourceContent: blockContent,
      startLine,
      endLine,
      totalLines,
      complete: true,
      match: request.match,
      occurrence,
      totalOccurrences: occurrences.length,
      ...(editAnchor ? { editAnchor } : {}),
    })
    applyBlockAuthority({
      path,
      startLine,
      endLine,
      totalLines,
      sourceContent: blockContent,
    })
  }

  for (let index = 0; index < symbolInputs.length; index++) {
    const request = symbolInputs[index]!
    const requestIndex = windowInputs.length + aroundInputs.length + index
    const path = normalizeToolPath(request.path)
    const loaded = await loadFile(path)
    if ('error' in loaded) {
      items.push({
        selector: 'symbol',
        requestIndex,
        path,
        status: 'error',
        error: loaded.error,
      })
      continue
    }
    const occurrence = request.occurrence ?? 1
    const slice = await selectSymbolSlice({
      rawContent: loaded.content,
      filePath: path,
      name: request.name,
      occurrence,
      capabilityScope: { ...capabilityIssuer, path },
    })
    if (!slice) {
      items.push({
        selector: 'symbol',
        requestIndex,
        path,
        status: 'error',
        error: {
          code: 'no_match',
          message: `Symbol "${request.name}" (occurrence ${occurrence}) was not found in ${path}. Use read_outline to list the available symbols, then retry with an exact name.`,
          retryable: true,
          recovery: 'choose_symbol',
        },
      })
      continue
    }
    const totalLines = normalizeLineEndings(loaded.content).split('\n').length
    const tooLarge = overBudgetError(slice.content)
    if (tooLarge) {
      items.push({
        selector: 'symbol',
        requestIndex,
        path,
        status: 'error',
        error: tooLarge,
      })
      continue
    }
    // Mirror read_files: only parser-proven slices (which carry a minted
    // readCapability) expose an editAnchor; heuristic regex slices stay
    // read-only and require an anchored window/around read before editing.
    const editAnchor = slice.readCapability
      ? mintBlockEditAnchor(path, slice.startLine, slice.endLine, slice.content)
      : undefined
    successfulReadPaths.add(path)
    items.push({
      selector: 'symbol',
      requestIndex,
      path,
      status: 'ok',
      content: slice.content,
      sourceContent: slice.content,
      startLine: slice.startLine,
      endLine: slice.endLine,
      totalLines,
      complete: true,
      symbol: slice.symbol,
      ...(slice.kind ? { kind: slice.kind } : {}),
      occurrence,
      ...(editAnchor ? { editAnchor } : {}),
    })
    // A whole-file-spanning slice may grant, but only when the slice is
    // parser-proven; heuristic slices classify as 'none'.
    applyBlockAuthority({
      path,
      startLine: slice.startLine,
      endLine: slice.endLine,
      totalLines,
      sourceContent: slice.content,
      capabilityEligible: Boolean(slice.readCapability),
    })
  }

  // A block covering the whole file mints the same authority an identical
  // read_files whole-file read would, so it may clear context_compacted.
  // Sub-file blocks may clear failed_edit gates but must not drop
  // context_compacted (same rule as read_files range/symbol reads).
  for (const path of successfulReadPaths) {
    const rereadReq = getEditRereadRequirement(fileProcessingState, path)
    if (
      rereadReq?.reason === 'context_compacted' &&
      !wholeFileGrantPaths.has(path)
    ) {
      delete fileProcessingState.promisesByPath[path]
      continue
    }
    clearEditRereadRequirement(fileProcessingState, path)
    delete fileProcessingState.promisesByPath[path]
  }

  return {
    output: jsonToolResult(buildReadBlocksResultV1(items)),
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
