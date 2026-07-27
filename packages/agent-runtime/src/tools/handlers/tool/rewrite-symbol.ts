import { markEditRequiresFreshRead } from './edit-read-state'
import { handleStrReplace } from './str-replace'
import { formatUnsafeToolPathError, normalizeToolPath } from './write-file'
import {
  extractSlices,
  extendRangeToPrecedingComment,
  getFileStructure,
  mintSliceCapability,
  validateRewriteSymbolReadCapability,
} from '../../../structural-read'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type { FileProcessingState } from './write-file'
import type { RequestOptionalFileFn } from '@codebuff/common/types/contracts/client'
import type { ProjectFileContext } from '@codebuff/common/util/file'

function errorResult(file: string, message: string) {
  return {
    output: [{ type: 'json' as const, value: { file, errorMessage: message } }],
  }
}

/**
 * Structural edit: replace a whole symbol's definition by name. Resolves the
 * symbol's exact AST range, then applies the change through the existing
 * str_replace machinery (atomic, capability-anchored, client-applied) using the
 * symbol's current text as a precise oldString — so the model never has to copy
 * the old text and the edit can't drift. If tree-sitter cannot parse the file,
 * fall back to the same heuristic slicer used by read_files(symbols).
 */
export const handleRewriteSymbol = (async (params: {
    previousToolCallFinished: Promise<void>
    toolCall: any
    requestOptionalFile: RequestOptionalFileFn
    fileProcessingState: FileProcessingState
    fileContext: ProjectFileContext
    runId: string
}): Promise<{ output: any }> => {
  const { previousToolCallFinished, toolCall, requestOptionalFile } = params
  const {
    path: inputPath,
    symbol,
    content: newContent,
    occurrence,
    readCapability,
  } = toolCall.input as {
    path: string
    symbol: string
    content: string
    occurrence?: number
    readCapability?: string
  }
  const path = normalizeToolPath(inputPath)

  if (!path) {
    return errorResult(
      inputPath,
      formatUnsafeToolPathError('rewrite_symbol', inputPath),
    )
  }

  await previousToolCallFinished

  const capabilityScope = {
    projectId: params.fileContext?.projectRoot ?? '',
    path,
    runId: params.runId ?? '',
  }

  const raw = await requestOptionalFile({ ...params, filePath: path })
  if (raw === null) {
    return errorResult(
      path,
      'File does not exist. Use write_file to create it.',
    )
  }

  const normalized = raw.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const structure = await getFileStructure(raw, path)

  const astMatches = structure?.filter((s) => s.name === symbol) ?? []
  const matches =
    astMatches.length > 0
      ? astMatches.map((match) => {
          const extended = extendRangeToPrecedingComment(lines, match.startLine)
          const mintedCapability = mintSliceCapability({
            content: raw,
            startLine: extended.startLine,
            endLine: match.endLine,
            scope: capabilityScope,
          }).readCapability
          return {
            kind: match.kind,
            startLine: extended.startLine,
            endLine: match.endLine,
            oldString: lines
              .slice(extended.startLine - 1, match.endLine)
              .join('\n'),
            readCapability: mintedCapability,
          }
        })
      : (await extractSlices(raw, path, [symbol], occurrence ?? 5)).map(
          (slice) => ({
            kind: slice.kind ?? 'symbol',
            startLine: slice.startLine,
            endLine: slice.endLine,
            oldString: slice.content,
            readCapability:
              slice.readCapability ??
              mintSliceCapability({
                content: raw,
                startLine: slice.startLine,
                endLine: slice.endLine,
                scope: capabilityScope,
              }).readCapability,
          }),
        )

  if (matches.length === 0) {
    const parserContext =
      structure === null ? `rewrite_symbol could not parse ${path}, and ` : ''
    return errorResult(
      path,
      `${parserContext}symbol "${symbol}" was not found in ${path}. Use read_files symbols and pass its editAnchor.readCapability to rewrite_symbol, or read the exact range and pass its readCapability to replace_range.`,
    )
  }
  if (matches.length > 1 && occurrence === undefined) {
    const lineList = matches
      .map((m) => `${m.kind} at lines ${m.startLine}-${m.endLine}`)
      .join('; ')
    return errorResult(
      path,
      `Multiple top-level symbols named "${symbol}" in ${path} (${lineList}). Pass occurrence (1-indexed) to choose one, or use replace_range.`,
    )
  }
  const match = occurrence !== undefined ? matches[occurrence - 1] : matches[0]
  if (!match) {
    return errorResult(
      path,
      `occurrence ${occurrence} is out of range; ${matches.length} symbol(s) named "${symbol}" exist in ${path}.`,
    )
  }

  if (readCapability) {
    const capabilityError = validateRewriteSymbolReadCapability({
      readCapability,
      path,
      slice: {
        content: match.oldString,
        startLine: match.startLine,
        endLine: match.endLine,
      },
      scope: capabilityScope,
    })
    if (capabilityError) {
      markEditRequiresFreshRead({
        fileProcessingState: params.fileProcessingState,
        path,
        reason: 'stale_capability',
        sourceTool: 'rewrite_symbol',
      })
      return errorResult(path, capabilityError)
    }
  }

  // Delegate to the str_replace handler: it owns atomic apply, stale detection,
  // and the client write. A caller-provided symbol-slice capability has already
  // been exact-span validated; zero-capability calls retain the existing minted
  // structural anchor behavior outside strict authorization.
  return handleStrReplace({
    ...(params as any),
    previousToolCallFinished: Promise.resolve(),
    structuralRecovery: true,
    toolCall: {
      ...toolCall,
      toolName: 'str_replace',
      input: {
        path,
        replacements: [
          {
            oldString: match.oldString,
            newString: newContent,
            allowMultiple: false,
            basedOnRead:
              readCapability ??
              (params.fileProcessingState?.strictReadBeforeEdit
                ? undefined
                : match.readCapability),
          },
        ],
      },
    },
  } as any)
}) satisfies CodebuffToolHandlerFunction<any>
