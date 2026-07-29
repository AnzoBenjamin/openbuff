import { applyPatch, createPatch, diffChars } from 'diff'
import {
  decodeReadCapabilityToken,
  getContentHash,
  normalizeLineEndings,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'

import { processStrReplace } from './process-str-replace'
import { processStructuredEdit } from './process-structured-edit'
import {
  extractSlices,
  resolveOccurrenceRangeInCapabilityRange,
  validateRewriteSymbolReadCapability,
} from './structural-read'

import type { ReplacementReadCapability } from './process-str-replace'
import type {
  StructuredEditOperation,
  StructuredTransactionEdit,
} from './process-structured-edit'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ReadCapabilityIssuer } from '@codebuff/common/util/content-hash'

type StrReplaceTransactionEdit = {
  id?: string
  type: 'str_replace'
  path: string
  replacements: {
    oldString: string
    newString: string
    allowMultiple: boolean
    occurrenceIndex?: number
    basedOnRead?: string
    skipIfMissing?: boolean
  }[]
}

type TransactionEdit =
  | StrReplaceTransactionEdit
  | StructuredTransactionEdit
  | {
      id?: string
      type: 'replace_range'
      path: string
      startLine?: number
      endLine?: number
      occurrence?: { match: string; occurrence?: number }
      readCapability: string
      newContent: string
    }
  | {
      id?: string
      type: 'rewrite_symbol'
      path: string
      symbol: string
      content: string
      occurrence?: number
      readCapability?: string
    }
  | { id?: string; type: 'patch'; path: string; diff: string }
  | {
      id?: string
      type: 'write_file'
      path: string
      content: string
      basedOnRead?: string
    }

type ResolvedReplaceRangeTransactionEdit = {
  id?: string
  type: 'replace_range'
  path: string
  startLine: number
  endLine: number
  occurrence?: { match: string; occurrence?: number }
  capabilityStartLine: number
  capabilityEndLine: number
  capabilityHash: string
  readCapability: string
  newContent: string
  /** Internal immutable-snapshot bounds and exact mapped working span. */
  originalRange?: { startLine: number; endLine: number }
  mappedRange?: { startOffset: number; endOffset: number }
}

type ResolvedTransactionEdit =
  | Exclude<TransactionEdit, { type: 'replace_range' }>
  | ResolvedReplaceRangeTransactionEdit

type TransactionFailureKind =
  | 'capability_stale'
  | 'capability_scope'
  | 'capability_invalid'
  | 'generic'

type TransactionFailure = {
  editIndex: number
  id?: string
  path: string
  errorMessage: string
  /** Optional whole-file capability echoed by the handler for residual recovery. */
  basedOnRead?: string
  /**
   * Structured failure classification for capability freshness/scope failures.
   * Lets consumers classify without regex-matching errorMessage. Optional and
   * additive; older consumers ignore it (the output schema strips unknown keys).
   */
  failureKind?: TransactionFailureKind
}

type TransactionFileChange = {
  path: string
  content: string
  patch: string
  messages: string[]
}

export async function processEditTransaction(params: {
  edits: TransactionEdit[]
  initialContentByPath: Map<string, string | null>
  logger: Logger
  requireFreshReadCapabilityForPaths?: Set<string>
  readCapabilityIssuer?: ReadCapabilityIssuer
}): Promise<
  | {
      tool: 'edit_transaction'
      files: TransactionFileChange[]
      message: string
    }
  | {
      tool: 'edit_transaction'
      error: string
      failures: TransactionFailure[]
    }
> {
  const {
    edits,
    initialContentByPath,
    logger,
    requireFreshReadCapabilityForPaths = new Set<string>(),
    readCapabilityIssuer,
  } = params
  const workingContentByPath = new Map(initialContentByPath)
  const messagesByPath = new Map<string, string[]>()
  const failures: TransactionFailure[] = []
  const transformationLedgerByPath = new Map<string, TransformationLedgerEntry[]>()
  const unmappableOriginalPaths = new Set<string>()
  for (let editIndex = 0; editIndex < edits.length; editIndex++) {
    const edit = edits[editIndex]
    if (!edit) continue
    const coalescedEdit = coalesceAdjacentStrReplaceEdits(edits, editIndex)
    const effectiveEdit = coalescedEdit?.edit ?? edit
    const nextEditIndex = coalescedEdit?.nextEditIndex ?? editIndex + 1

    if (!workingContentByPath.has(effectiveEdit.path)) {
      failures.push({
        editIndex,
        ...(effectiveEdit.id && { id: effectiveEdit.id }),
        path: effectiveEdit.path,
        errorMessage: `Cannot apply ${effectiveEdit.type} edit to ${effectiveEdit.path}: file was not preloaded for transaction preflight. Re-read the target file, then retry the whole transaction.`,
      })
      break
    }

    const resolvedEdit = resolveReplaceRangeEdit(
      effectiveEdit,
      initialContentByPath.get(effectiveEdit.path) ?? null,
    )
    if ('error' in resolvedEdit) {
      failures.push({
        editIndex,
        ...(effectiveEdit.id && { id: effectiveEdit.id }),
        path: effectiveEdit.path,
        errorMessage: resolvedEdit.error,
        ...(resolvedEdit.failureKind && { failureKind: resolvedEdit.failureKind }),
      })
      break
    }
    const rangeAdjustment = getEffectiveReplaceRangeEdit(
      resolvedEdit.edit,
      initialContentByPath.get(effectiveEdit.path) ?? null,
      transformationLedgerByPath.get(effectiveEdit.path) ?? [],
      unmappableOriginalPaths.has(effectiveEdit.path),
    )
    if ('error' in rangeAdjustment) {
      failures.push({
        editIndex,
        ...(effectiveEdit.id && { id: effectiveEdit.id }),
        path: effectiveEdit.path,
        errorMessage: rangeAdjustment.error,
      })
      break
    }

    const currentContent = workingContentByPath.get(effectiveEdit.path)
    const result = await processTransactionEdit({
      edit: rangeAdjustment.edit,
      initialContentPromise: Promise.resolve(currentContent ?? null),
      originalContentPromise: Promise.resolve(
        initialContentByPath.get(effectiveEdit.path) ?? null,
      ),
      logger,
      requireFreshReadCapability: requireFreshReadCapabilityForPaths.has(
        effectiveEdit.path,
      ),
      readCapabilityIssuer,
    })

    if ('error' in result) {
      const failedEdit = resolveFailedEdit(
        edits,
        editIndex,
        coalescedEdit,
        result.error,
      )
      failures.push({
        editIndex: failedEdit.editIndex,
        ...(failedEdit.edit.id && { id: failedEdit.edit.id }),
        path: effectiveEdit.path,
        errorMessage: result.error,
        ...(result.failureKind && { failureKind: result.failureKind }),
      })
      break
    }

    const priorContent = currentContent ?? ''
    workingContentByPath.set(effectiveEdit.path, result.content)
    const ledgerResult = appendTransformationLedgerEntries(
      transformationLedgerByPath.get(effectiveEdit.path) ?? [],
      normalizeLineEndings(priorContent),
      normalizeLineEndings(result.content),
    )
    if ('error' in ledgerResult) {
      unmappableOriginalPaths.add(effectiveEdit.path)
    } else {
      transformationLedgerByPath.set(effectiveEdit.path, ledgerResult.ledger)
    }
    messagesByPath.set(effectiveEdit.path, [
      ...(messagesByPath.get(effectiveEdit.path) ?? []),
      ...result.messages,
    ])
    editIndex = nextEditIndex - 1
  }

  if (failures.length > 0) {
    const firstFailure = failures[0]
    return {
      tool: 'edit_transaction',
      error: [
        `edit_transaction aborted during preflight at edit ${firstFailure.editIndex + 1} of ${edits.length}, so NO files were changed.`,
        'The detailed cause is listed once in failures below. If that failure requires fresh read/capability state, re-read EVERY target in this transaction in the current run, then rebuild and retry the whole transaction from that one current snapshot. Do not refresh only the first failed path while replaying stale tokens for the remaining targets.',
      ].join('\n\n'),
      failures,
    }
  }

  const files: TransactionFileChange[] = []
  for (const [path, initialContent] of initialContentByPath.entries()) {
    const finalContent = workingContentByPath.get(path)
    if (typeof finalContent !== 'string') {
      continue
    }
    const comparisonContent = initialContent ?? ''
    if (comparisonContent === finalContent) continue

    let patch = createPatch(path, comparisonContent, finalContent)
    const lines = patch.split('\n')
    const hunkStartIndex = lines.findIndex((line) => line.startsWith('@@'))
    if (hunkStartIndex !== -1) {
      patch = lines.slice(hunkStartIndex).join('\n')
    }

    files.push({
      path,
      content: finalContent,
      patch,
      messages: messagesByPath.get(path) ?? [],
    })
  }

  if (files.length === 0) {
    return {
      tool: 'edit_transaction',
      error:
        'edit_transaction produced no file changes. Re-read the target files/ranges and retry with replacements that change current content.',
      failures: [],
    }
  }

  return {
    tool: 'edit_transaction',
    files,
    message: `edit_transaction preflight prepared ${files.length} coordinated file change(s).`,
  }
}

function coalesceAdjacentStrReplaceEdits(
  edits: TransactionEdit[],
  startIndex: number,
): {
  edit: StrReplaceTransactionEdit
  nextEditIndex: number
  replacementEditIndexes: number[]
} | null {
  const firstEdit = edits[startIndex]
  if (firstEdit?.type !== 'str_replace') return null

  const replacements = [...firstEdit.replacements]
  const replacementEditIndexes = firstEdit.replacements.map(() => startIndex)
  let nextEditIndex = startIndex + 1
  while (nextEditIndex < edits.length) {
    const nextEdit = edits[nextEditIndex]
    if (nextEdit?.type !== 'str_replace' || nextEdit.path !== firstEdit.path) {
      break
    }
    replacements.push(...nextEdit.replacements)
    replacementEditIndexes.push(
      ...nextEdit.replacements.map(() => nextEditIndex),
    )
    nextEditIndex++
  }

  if (nextEditIndex === startIndex + 1) return null

  return {
    edit: {
      ...firstEdit,
      replacements,
    },
    nextEditIndex,
    replacementEditIndexes,
  }
}

function resolveFailedEdit(
  edits: TransactionEdit[],
  editIndex: number,
  coalescedEdit: ReturnType<typeof coalesceAdjacentStrReplaceEdits>,
  errorMessage: string,
): { editIndex: number; edit: TransactionEdit } {
  const replacementMatch = errorMessage.match(/replacement (\d+)/i)
  const replacementIndex = replacementMatch
    ? Number.parseInt(replacementMatch[1], 10) - 1
    : -1
  const sourceEditIndex =
    replacementIndex >= 0
      ? coalescedEdit?.replacementEditIndexes[replacementIndex]
      : undefined
  const failedEditIndex = sourceEditIndex ?? editIndex
  return {
    editIndex: failedEditIndex,
    edit: edits[failedEditIndex] ?? edits[editIndex],
  }
}

type TransformationLedgerEntry = {
  actionIndex: number
  originalStart: number
  originalEnd: number
  beforeStart: number
  beforeEnd: number
  afterStart: number
  afterEnd: number
}

function originalLineSpan(
  content: string,
  startLine: number,
  endLine: number,
): { startOffset: number; endOffset: number } | null {
  const normalized = normalizeLineEndings(content)
  const lines = normalized.split('\n')
  const visibleLineCount =
    normalized.length === 0 ? 0 : lines.at(-1) === '' ? lines.length - 1 : lines.length
  if (startLine < 1 || endLine < startLine || endLine > visibleLineCount) {
    return null
  }
  let startOffset = 0
  for (let index = 0; index < startLine - 1; index++) {
    startOffset += lines[index]!.length + 1
  }
  let endOffset = startOffset
  for (let index = startLine - 1; index < endLine; index++) {
    endOffset += lines[index]!.length
    if (index < endLine - 1) endOffset += 1
  }
  return { startOffset, endOffset }
}

function mapOriginalOffset(
  originalOffset: number,
  ledger: TransformationLedgerEntry[],
  affinity: 'left' | 'right',
): number | null {
  let currentOffset = originalOffset
  for (const entry of ledger) {
    const isInsertion = entry.originalStart === entry.originalEnd
    if (
      originalOffset > entry.originalStart &&
      originalOffset < entry.originalEnd
    ) {
      return null
    }
    if (
      originalOffset > entry.originalEnd ||
      (originalOffset === entry.originalEnd && !isInsertion) ||
      (isInsertion &&
        originalOffset === entry.originalStart &&
        affinity === 'right')
    ) {
      currentOffset +=
        entry.afterEnd - entry.afterStart - (entry.beforeEnd - entry.beforeStart)
    }
  }
  return currentOffset
}

function resolveReplaceRangeEdit(
  edit: TransactionEdit,
  currentContent?: string | null,
):
  | { edit: ResolvedTransactionEdit }
  | { error: string; failureKind?: TransactionFailureKind } {
  if (edit.type !== 'replace_range') return { edit }
  const decoded = decodeReadCapabilityToken(edit.readCapability)
  if (typeof decoded === 'string' || decoded.tokenVersion !== 'v3') {
    return {
      error:
        typeof decoded === 'string'
          ? decoded
          : 'readCapability requires an authenticated project/path/run-bound cap.v3 token.',
      // Only a decode failure carries the structured capability-invalid kind;
      // a wrong-version token stays covered by the handler regex fallback.
      ...(typeof decoded === 'string'
        ? { failureKind: 'capability_invalid' as const }
        : {}),
    }
  }
  const startLine = edit.startLine ?? decoded.startLine
  const endLine = edit.endLine ?? decoded.endLine
  if (edit.occurrence) {
    // Resolve occurrence targeting to absolute original-snapshot lines here, so
    // the resolved bounds flow through provenance mapping and capability
    // verification exactly like explicit line bounds.
    if (typeof currentContent !== 'string') {
      return {
        error: `replace_range blocked for ${edit.path}: current content is unavailable, so the requested occurrence could not be resolved. Re-read the target range and retry.`,
        failureKind: 'generic' as const,
      }
    }
    const resolved = resolveOccurrenceRangeInCapabilityRange({
      content: currentContent,
      match: edit.occurrence.match,
      occurrence: edit.occurrence.occurrence,
      capabilityStartLine: decoded.startLine,
      capabilityEndLine: decoded.endLine,
    })
    if (!resolved.range) {
      return {
        error: `replace_range blocked for ${edit.path}: found ${resolved.found} occurrence(s) of the requested match inside the authorized range ${decoded.startLine}-${decoded.endLine}, so occurrence ${edit.occurrence.occurrence ?? 1} does not exist. Re-read the range and target an existing occurrence or absolute lines.`,
        failureKind: 'generic' as const,
      }
    }
    return {
      edit: {
        ...edit,
        startLine: resolved.range.startLine,
        endLine: resolved.range.endLine,
        capabilityStartLine: decoded.startLine,
        capabilityEndLine: decoded.endLine,
        capabilityHash: decoded.hash,
      },
    }
  }
  return {
    edit: {
      ...edit,
      startLine,
      endLine,
      capabilityStartLine: decoded.startLine,
      capabilityEndLine: decoded.endLine,
      capabilityHash: decoded.hash,
    },
  }
}

function getEffectiveReplaceRangeEdit(
  edit: ResolvedTransactionEdit,
  originalContent: string | null,
  ledger: TransformationLedgerEntry[],
  originalPathIsUnmappable: boolean,
): { edit: ResolvedTransactionEdit } | { error: string } {
  if (edit.type !== 'replace_range') return { edit }
  if (originalContent === null) return { edit }
  if (originalPathIsUnmappable) {
    return {
      error: `replace_range blocked for ${edit.path}: an earlier transaction action changed text without uniquely representable original-snapshot provenance.`,
    }
  }

  const originalSpan = originalLineSpan(
    originalContent,
    edit.startLine,
    edit.endLine,
  )
  if (!originalSpan) return { edit }
  for (const entry of ledger) {
    const insertionInside =
      entry.originalStart === entry.originalEnd &&
      entry.originalStart > originalSpan.startOffset &&
      entry.originalStart < originalSpan.endOffset
    const changedBytesOverlap =
      entry.originalStart < originalSpan.endOffset &&
      entry.originalEnd > originalSpan.startOffset
    if (insertionInside || changedBytesOverlap) {
      return {
        error: `replace_range blocked for ${edit.path}: original lines ${edit.startLine}-${edit.endLine} overlap bytes changed earlier in this transaction, so exact provenance is unavailable.`,
      }
    }
  }
  const startOffset = mapOriginalOffset(originalSpan.startOffset, ledger, 'right')
  const endOffset = mapOriginalOffset(originalSpan.endOffset, ledger, 'left')
  if (startOffset === null || endOffset === null || endOffset < startOffset) {
    return {
      error: `replace_range blocked for ${edit.path}: original lines ${edit.startLine}-${edit.endLine} do not map uniquely into current transaction content.`,
    }
  }
  return {
    edit: {
      ...edit,
      originalRange: { startLine: edit.startLine, endLine: edit.endLine },
      mappedRange: { startOffset, endOffset },
    },
  }
}

function mapWorkingOffsetToOriginal(
  workingOffset: number,
  ledger: TransformationLedgerEntry[],
  affinity: 'left' | 'right',
): number | null {
  let offset = workingOffset
  for (let index = ledger.length - 1; index >= 0; ) {
    const actionIndex = ledger[index]!.actionIndex
    let firstIndex = index
    while (firstIndex > 0 && ledger[firstIndex - 1]!.actionIndex === actionIndex) {
      firstIndex--
    }
    let actionDelta = 0
    for (let entryIndex = firstIndex; entryIndex <= index; entryIndex++) {
      const entry = ledger[entryIndex]!
      const isDeletion = entry.afterStart === entry.afterEnd
      if (offset > entry.afterStart && offset < entry.afterEnd) return null
      if (
        offset > entry.afterEnd ||
        (offset === entry.afterEnd && !isDeletion) ||
        (isDeletion && offset === entry.afterStart && affinity === 'right')
      ) {
        actionDelta +=
          entry.afterEnd - entry.afterStart - (entry.beforeEnd - entry.beforeStart)
      }
    }
    offset -= actionDelta
    index = firstIndex - 1
  }
  return offset
}

function appendTransformationLedgerEntries(
  existingLedger: TransformationLedgerEntry[],
  beforeContent: string,
  afterContent: string,
): { ledger: TransformationLedgerEntry[] } | { error: string } {
  if (beforeContent === afterContent) return { ledger: existingLedger }
  const actionIndex = (existingLedger.at(-1)?.actionIndex ?? -1) + 1
  const entries: TransformationLedgerEntry[] = []
  let beforeOffset = 0
  let afterOffset = 0
  let pending:
    | { beforeStart: number; beforeEnd: number; afterStart: number; afterEnd: number }
    | undefined
  const flush = (): boolean => {
    if (!pending) return true
    const originalStart = mapWorkingOffsetToOriginal(
      pending.beforeStart,
      existingLedger,
      'right',
    )
    const originalEnd = mapWorkingOffsetToOriginal(
      pending.beforeEnd,
      existingLedger,
      'left',
    )
    if (originalStart === null || originalEnd === null || originalEnd < originalStart) {
      return false
    }
    entries.push({
      ...pending,
      actionIndex,
      originalStart,
      originalEnd,
    })
    pending = undefined
    return true
  }
  for (const part of diffChars(beforeContent, afterContent)) {
    if (!part.added && !part.removed) {
      if (!flush()) {
        return {
          error: 'a changed interval originated in text introduced by a prior edit',
        }
      }
      beforeOffset += part.value.length
      afterOffset += part.value.length
      continue
    }
    pending ??= {
      beforeStart: beforeOffset,
      beforeEnd: beforeOffset,
      afterStart: afterOffset,
      afterEnd: afterOffset,
    }
    if (part.removed) {
      beforeOffset += part.value.length
      pending.beforeEnd = beforeOffset
    } else {
      afterOffset += part.value.length
      pending.afterEnd = afterOffset
    }
  }
  if (!flush()) {
    return {
      error: 'a changed interval originated in text introduced by a prior edit',
    }
  }
  return { ledger: [...existingLedger, ...entries] }
}

async function processTransactionEdit(params: {
  edit: ResolvedTransactionEdit
  initialContentPromise: Promise<string | null>
  originalContentPromise: Promise<string | null>
  logger: Logger
  requireFreshReadCapability: boolean
  readCapabilityIssuer?: ReadCapabilityIssuer
}): Promise<
  | {
      content: string
      messages: string[]
    }
  | {
      error: string
      failureKind?: TransactionFailureKind
    }
> {
  const {
    edit,
    initialContentPromise,
    originalContentPromise,
    logger,
    requireFreshReadCapability,
    readCapabilityIssuer,
  } = params
  switch (edit.type) {
    case 'str_replace': {
      const initialContent = await initialContentPromise
      return processStrReplace({
        path: edit.path,
        replacements: edit.replacements,
        atomic: true,
        transactionContext: true,
        requireFreshReadCapability,
        readCapabilityScope: readCapabilityIssuer
          ? { ...readCapabilityIssuer, path: edit.path }
          : undefined,
        initialContentPromise: Promise.resolve(initialContent),
        logger,
      })
    }
    case 'structured':
      return processStructuredEdit({
        edit: {
          ...edit,
          operation: edit.operation as StructuredEditOperation,
        },
        initialContentPromise,
        logger,
      })
    case 'replace_range': {
      const initialContent = await initialContentPromise
      if (initialContent === null) {
        return { error: `Cannot replace a range in missing file ${edit.path}.` }
      }
      const normalized = normalizeLineEndings(initialContent)
      const lines = normalized.split('\n')
      // visibleLineCount excludes a trailing-empty line so the requested
      // sub-range bounds check never permits a phantom line beyond the last
      // real line (preserves the original bounds behavior).
      const visibleLineCount =
        normalized.length === 0
          ? 0
          : lines.at(-1) === ''
            ? lines.length - 1
            : lines.length
      const authorizationTarget = edit.originalRange ?? {
        startLine: edit.startLine,
        endLine: edit.endLine,
      }
      {
        const decoded = decodeReadCapabilityToken(edit.readCapability)
        if (typeof decoded === 'string') {
          return { error: decoded, failureKind: 'capability_invalid' }
        }
        if (
          !readCapabilityIssuer?.projectId ||
          !readCapabilityIssuer.runId
        ) {
          return {
            error: `replace_range blocked for ${edit.path}: authenticated readCapability scope is unavailable. Re-read the target in a runtime with a nonempty project and run scope.`,
          }
        }
        const scope = { ...readCapabilityIssuer, path: edit.path }
        if (!readCapabilityMatchesScope(decoded, scope)) {
          return {
            error: `replace_range blocked for ${edit.path}: the readCapability belongs to a different project, path, or agent run. Re-read lines ${edit.startLine}-${edit.endLine} in this run and copy the new capability.`,
            failureKind: 'capability_scope',
          }
        }
        // Authenticate original snapshot coordinates. Prior edits may shift the
        // working target, but they do not change the bytes the capability proved.
        if (
          decoded.startLine !== edit.capabilityStartLine ||
          decoded.endLine !== edit.capabilityEndLine ||
          decoded.hash !== edit.capabilityHash
        ) {
          return {
            error: `replace_range blocked for ${edit.path}: normalized capability metadata does not match the authenticated readCapability. Re-read the target and retry with the fresh token.`,
            failureKind: 'capability_stale',
          }
        }
        const originalContent = await originalContentPromise
        const observedContent = normalizeLineEndings(originalContent ?? '')
          .split('\n')
          .slice(edit.capabilityStartLine - 1, edit.capabilityEndLine)
          .join('\n')
        if (getContentHash(observedContent) !== decoded.hash) {
          return {
            error: `replace_range blocked for ${edit.path}: the readCapability-covered content is stale. Re-read lines ${edit.capabilityStartLine}-${edit.capabilityEndLine} and retry with the fresh token.`,
            failureKind: 'capability_stale',
          }
        }
        if (
          authorizationTarget.startLine < edit.capabilityStartLine ||
          authorizationTarget.endLine > edit.capabilityEndLine
        ) {
          return {
            error: `replace_range blocked for ${edit.path}: target lines ${authorizationTarget.startLine}-${authorizationTarget.endLine} are outside the observed capability range ${edit.capabilityStartLine}-${edit.capabilityEndLine}.`,
            failureKind: 'capability_scope',
          }
        }
      }
      if (
        !edit.mappedRange &&
        (edit.startLine < 1 ||
          edit.endLine < edit.startLine ||
          edit.endLine > visibleLineCount)
      ) {
        return {
          error: `replace_range ${edit.startLine}-${edit.endLine} is outside ${edit.path} (${visibleLineCount} lines).`,
        }
      }
      const narrowedTarget =
        authorizationTarget.startLine !== edit.capabilityStartLine ||
        authorizationTarget.endLine !== edit.capabilityEndLine
      const narrowedTargetSuffix = narrowedTarget
        ? ' within the readCapability-covered range'
        : ''
      const replacementContent = normalizeLineEndings(edit.newContent)
      const content = edit.mappedRange
        ? `${normalized.slice(0, edit.mappedRange.startOffset)}${replacementContent}${normalized.slice(edit.mappedRange.endOffset)}`
        : (() => {
            const replacementLines = replacementContent.split('\n')
            lines.splice(
              edit.startLine - 1,
              edit.endLine - edit.startLine + 1,
              ...replacementLines,
            )
            return lines.join('\n')
          })()
      return {
        content,
        messages: [
          `Replaced lines ${authorizationTarget.startLine}-${authorizationTarget.endLine} in ${edit.path}${narrowedTargetSuffix}.`,
        ],
      }
    }
    case 'rewrite_symbol': {
      const initialContent = await initialContentPromise
      if (initialContent === null) {
        return {
          error: `Cannot rewrite a symbol in missing file ${edit.path}.`,
        }
      }
      const matches = await extractSlices(
        initialContent,
        edit.path,
        [edit.symbol],
        edit.occurrence ?? 5,
      )
      const match = edit.occurrence ? matches[edit.occurrence - 1] : matches[0]
      if (!match || (!edit.occurrence && matches.length > 1)) {
        return {
          error:
            matches.length > 1
              ? `Multiple symbols named ${edit.symbol} exist in ${edit.path}; pass occurrence.`
              : `Symbol ${edit.symbol} was not found in ${edit.path}.`,
        }
      }
      if (requireFreshReadCapability && !edit.readCapability) {
        return {
          error: `rewrite_symbol blocked for ${edit.path}: strict read-before-edit requires the fresh readCapability from the matching symbol slice.`,
        }
      }
      if (edit.readCapability) {
        const originalContent = await originalContentPromise
        const originalMatches = await extractSlices(
          originalContent ?? '',
          edit.path,
          [edit.symbol],
          edit.occurrence ?? 5,
        )
        const originalMatch = edit.occurrence
          ? originalMatches[edit.occurrence - 1]
          : originalMatches[0]
        if (!originalMatch || (!edit.occurrence && originalMatches.length > 1)) {
          return {
            error: `rewrite_symbol blocked for ${edit.path}: the original symbol replacement span is no longer uniquely resolvable.`,
          }
        }
        const capabilityError = validateRewriteSymbolReadCapability({
          readCapability: edit.readCapability,
          path: edit.path,
          slice: originalMatch,
          scope: readCapabilityIssuer,
        })
        if (capabilityError) return { error: capabilityError }
        if (match.content !== originalMatch.content) {
          return {
            error: `rewrite_symbol blocked for ${edit.path}: the symbol replacement bytes were changed earlier in this transaction.`,
          }
        }
      }
      const lines = normalizeLineEndings(initialContent).split('\n')
      lines.splice(
        match.startLine - 1,
        match.endLine - match.startLine + 1,
        ...normalizeLineEndings(edit.content).split('\n'),
      )
      return {
        content: lines.join('\n'),
        messages: [`Rewrote symbol ${edit.symbol} in ${edit.path}.`],
      }
    }
    case 'patch': {
      const initialContent = await initialContentPromise
      if (initialContent === null) {
        return { error: `Cannot apply a patch to missing file ${edit.path}.` }
      }
      const content = applyPatch(initialContent, edit.diff)
      return content === false
        ? { error: `Patch did not apply cleanly to ${edit.path}.` }
        : { content, messages: [`Applied patch to ${edit.path}.`] }
    }
    case 'write_file':
      return {
        content: edit.content,
        messages: [`Prepared whole-file content for ${edit.path}.`],
      }
    default: {
      const _exhaustive: never = edit
      return {
        error: `Unsupported transaction edit type: ${JSON.stringify(_exhaustive)}`,
      }
    }
  }
}
