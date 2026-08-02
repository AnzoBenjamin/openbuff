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
  buildAroundBlock,
  buildSymbolBlock,
  buildWindowBlock,
  type ReadBlockBuilderContext,
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

  const builderContext: ReadBlockBuilderContext = {
    loadFile,
    mintBlockEditAnchor,
    applyBlockAuthority,
    overBudgetError,
    capabilityIssuer,
    successfulReadPaths,
  }

  for (let index = 0; index < windowInputs.length; index++) {
    items.push(await buildWindowBlock(builderContext, windowInputs[index]!, index))
  }

  for (let index = 0; index < aroundInputs.length; index++) {
    items.push(
      await buildAroundBlock(
        builderContext,
        aroundInputs[index]!,
        windowInputs.length + index,
      ),
    )
  }

  for (let index = 0; index < symbolInputs.length; index++) {
    items.push(
      await buildSymbolBlock(
        builderContext,
        symbolInputs[index]!,
        windowInputs.length + aroundInputs.length + index,
      ),
    )
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
