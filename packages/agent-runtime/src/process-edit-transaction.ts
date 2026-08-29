import { applyPatch, createPatch, diffChars } from 'diff'
import {
  decodeReadCapabilityToken,
  getContentHash,
  normalizeLineEndings,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'
import {
  describeLineBounds,
  describeReanchorFailure,
  getLineCoordinates,
  getRangeSlice,
  reanchorCapabilityRange,
  resolveLineRange,
} from '@codebuff/common/util/line-coordinates'

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
  /**
   * Bounds decoded from the token, used ONLY for the authenticity equality
   * check against the capability the caller passed.
   */
  capabilityTokenStartLine: number
  capabilityTokenEndLine: number
  /**
   * Bounds where the capability-covered content actually lives in the original
   * snapshot. Equal to the token bounds unless the span was re-anchored.
   */
  capabilityStartLine: number
  capabilityEndLine: number
  capabilityHash: string
  /** Signed line delta applied by a re-anchor; absent when nothing shifted. */
  reanchoredBy?: number
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
  | 'no_match'
  | 'anchor_scope_mismatch'
  | 'preflight_failed'
  | 'generic'

type TransactionRecoveryAction =
  | 'rebuild_whole_transaction'
  | 'read_again'
  | 'change_edit_strategy'

type TransactionPreferredStrategy =
  | 'replace_range'
  | 'smaller_oldString'
  | 'rewrite_symbol'

type TransactionRecovery = {
  action: TransactionRecoveryAction
  requiresFreshRead: boolean
  paths: string[]
  failedEditIndex?: number
  failedReplacementIndex?: number
  preferredStrategy?: TransactionPreferredStrategy
  tool?: 'read_files'
  input?: { paths: string[] }
}

type TransactionFailure = {
  editIndex: number
  id?: string
  path: string
  errorMessage: string
  /** Optional whole-file capability echoed by the handler for residual recovery. */
  basedOnRead?: string
  /**
   * Structured failure classification for capability, match, or preflight failures.
   * Every failure this module reports carries one, so consumers must classify on
   * this field instead of regex-matching errorMessage (which would duplicate the
   * classification and let the copies drift). Still optional on the type so older
   * consumers can ignore it (the output schema strips unknown keys).
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
      requiresFreshRead?: boolean
      errorCode?: 'no_match' | 'stale_capability' | 'preflight_failed'
      recovery?: TransactionRecovery
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
  // Paths whose requested change resolved to an explicit already-applied
  // skipIfMissing deletion. Such an edit produces no diff, so the zero-change
  // branch below must report success (documented idempotent cleanup retry)
  // instead of 'edit_transaction produced no file changes.'
  const noOpSkipPaths = new Set<string>()
  // Every edit processed in this loop is a content edit (delete/move are
  // handled by the client-change builder in the handler). Counting them next to
  // the no-op skips is what lets the zero-change branch below distinguish "every
  // requested edit was an already-applied skipIfMissing deletion" from "a
  // co-present content edit legitimately produced no diff".
  let contentEditCount = 0
  let noOpSkipEditCount = 0
  const failures: TransactionFailure[] = []
  const transformationLedgerByPath = new Map<
    string,
    TransformationLedgerEntry[]
  >()
  const unmappableOriginalPaths = new Set<string>()
  for (let editIndex = 0; editIndex < edits.length; editIndex++) {
    const edit = edits[editIndex]
    if (!edit) continue
    const coalescedEdit = coalesceAdjacentStrReplaceEdits(edits, editIndex)
    const effectiveEdit = coalescedEdit?.edit ?? edit
    const nextEditIndex = coalescedEdit?.nextEditIndex ?? editIndex + 1

    if (!workingContentByPath.has(effectiveEdit.path)) {
      const errorMessage = `Cannot apply ${effectiveEdit.type} edit to ${effectiveEdit.path}: file was not preloaded for transaction preflight. Re-read the target file, then retry the whole transaction.`
      const failureKind = classifyTransactionFailureKind(errorMessage)
      failures.push({
        editIndex,
        ...(effectiveEdit.id && { id: effectiveEdit.id }),
        path: effectiveEdit.path,
        errorMessage,
        ...(failureKind && { failureKind }),
      })
      break
    }

    const resolvedEdit = resolveReplaceRangeEdit(
      effectiveEdit,
      initialContentByPath.get(effectiveEdit.path) ?? null,
    )
    if ('error' in resolvedEdit) {
      const failureKind =
        resolvedEdit.failureKind ??
        classifyTransactionFailureKind(resolvedEdit.error)
      failures.push({
        editIndex,
        ...(effectiveEdit.id && { id: effectiveEdit.id }),
        path: effectiveEdit.path,
        errorMessage: resolvedEdit.error,
        ...(failureKind && { failureKind }),
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
      const failureKind = classifyTransactionFailureKind(rangeAdjustment.error)
      failures.push({
        editIndex,
        ...(effectiveEdit.id && { id: effectiveEdit.id }),
        path: effectiveEdit.path,
        errorMessage: rangeAdjustment.error,
        ...(failureKind && { failureKind }),
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
      const failureKind =
        result.failureKind ?? classifyTransactionFailureKind(result.error)
      failures.push({
        editIndex: failedEdit.editIndex,
        ...(failedEdit.edit.id && { id: failedEdit.edit.id }),
        path: effectiveEdit.path,
        errorMessage: result.error,
        ...(failureKind && { failureKind }),
      })
      break
    }

    contentEditCount++
    if (result.hadNoOpSkip) {
      noOpSkipEditCount++
      noOpSkipPaths.add(effectiveEdit.path)
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
    const firstFailure = failures[0]!
    const uniquePaths = collectTransactionPaths(edits, initialContentByPath)
    const failedEdit = resolveFailedEdit(
      edits,
      firstFailure.editIndex,
      coalesceAdjacentStrReplaceEdits(edits, firstFailure.editIndex),
      firstFailure.errorMessage,
    )
    const recovery = buildTransactionRecovery({
      paths: uniquePaths,
      failure: firstFailure,
      failedReplacementIndex: failedEdit.failedReplacementIndex,
    })
    return {
      tool: 'edit_transaction',
      error: [
        `edit_transaction aborted during preflight at edit ${firstFailure.editIndex + 1} of ${edits.length}, so NO files were changed.`,
        'The detailed cause is listed once in failures below. If that failure requires fresh read/capability state, re-read EVERY target in this transaction in the current run, then rebuild and retry the whole transaction from that one current snapshot. Do not refresh only the first failed path while replaying stale tokens for the remaining targets.',
      ].join('\n\n'),
      failures,
      requiresFreshRead: recovery.requiresFreshRead,
      errorCode: recoveryErrorCode(firstFailure),
      recovery,
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
    // Documented contract: a transaction whose every requested change was an
    // explicit already-applied skipIfMissing deletion is a SUCCESSFUL
    // idempotent cleanup retry, not a failure. It reports zero file changes
    // plus the per-path skip messages so the caller can see why nothing
    // changed; the handler surfaces this without asking the client to apply an
    // empty change list.
    if (noOpSkipPaths.size > 0) {
      const skippedPaths = [...noOpSkipPaths]
      // Only assert the strong idempotent-cleanup claim when it is literally
      // true for EVERY content edit. A co-present content edit that legitimately
      // produced no diff (e.g. write_file with byte-identical content) also
      // lands here, and it is not an already-applied skipIfMissing deletion, so
      // that case reports the neutral wording instead.
      const everyEditWasNoOpSkip = noOpSkipEditCount === contentEditCount
      return {
        tool: 'edit_transaction',
        files: [],
        message: [
          everyEditWasNoOpSkip
            ? `edit_transaction made no file changes: every requested edit was an already-applied skipIfMissing deletion (${skippedPaths.join(', ')}).`
            : `edit_transaction made no file changes; skipped paths: ${skippedPaths.join(', ')}.`,
          ...skippedPaths.flatMap((path) => messagesByPath.get(path) ?? []),
        ].join('\n'),
      }
    }
    return {
      tool: 'edit_transaction',
      error:
        'edit_transaction produced no file changes. Re-read the target files/ranges and retry with replacements that change current content.',
      failures: [],
    }
  }

  // Mixed transaction: a path whose every replacement resolved to an
  // already-applied skipIfMissing deletion produces no files[] entry, so its
  // skip messages would be lost whenever another path did change. Surface them
  // on the success message instead of only through files[].
  const skippedOnlyPaths = [...noOpSkipPaths].filter(
    (skippedPath) => !files.some((file) => file.path === skippedPath),
  )
  return {
    tool: 'edit_transaction',
    files,
    message: [
      `edit_transaction preflight prepared ${files.length} coordinated file change(s).`,
      ...skippedOnlyPaths.flatMap(
        (skippedPath) => messagesByPath.get(skippedPath) ?? [],
      ),
    ].join('\n'),
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
): {
  editIndex: number
  edit: TransactionEdit
  failedReplacementIndex?: number
} {
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
    edit: edits[failedEditIndex] ?? edits[editIndex]!,
    ...(replacementIndex >= 0 && { failedReplacementIndex: replacementIndex }),
  }
}

function collectTransactionPaths(
  edits: TransactionEdit[],
  initialContentByPath: Map<string, string | null>,
): string[] {
  const paths = new Set<string>()
  for (const path of initialContentByPath.keys()) {
    if (path) paths.add(path)
  }
  for (const edit of edits) {
    if (edit.path) paths.add(edit.path)
  }
  return [...paths]
}

/**
 * Prose fallback for failures that do not already carry a structured kind. An
 * anchored scope mismatch is deliberately NOT detected here: processStrReplace
 * reports it as a real failureKind, so no marker token has to travel inside
 * model-facing prose where a quoted oldString could forge it.
 */
function classifyTransactionFailureKind(
  errorMessage: string,
): TransactionFailureKind | undefined {
  if (
    /not an exact contiguous match|Found \d+ occurrences of|Atomic str_replace batch aborted|only \d+ exact occurrence\(s\) of the oldString exist/i.test(
      errorMessage,
    )
  ) {
    return 'no_match'
  }
  // Scope mismatches (cross-run/path replay, out-of-range target, missing runtime
  // scope) are authenticity boundaries — not content-hash staleness.
  if (
    /different project, path, or agent run|outside the observed capability range|authenticated readCapability scope is unavailable|no runtime project\/path\/run scope/i.test(
      errorMessage,
    )
  ) {
    return 'capability_scope'
  }
  // Malformed or undecodable capability tokens / object-form basedOnRead.
  if (
    /Invalid basedOnRead|readCapability requires an authenticated|basedOnRead\.(?:startLine|endLine|hash) must/i.test(
      errorMessage,
    )
  ) {
    return 'capability_invalid'
  }
  if (
    /readCapability-covered (?:symbol )?content is stale|normalized capability metadata does not match|readCapability does not cover the exact original symbol replacement span/i.test(
      errorMessage,
    )
  ) {
    return 'capability_stale'
  }
  return 'generic'
}

function recoveryErrorCode(
  failure: TransactionFailure,
): 'no_match' | 'stale_capability' | 'preflight_failed' | undefined {
  if (
    failure.failureKind === 'capability_stale' ||
    failure.failureKind === 'capability_scope' ||
    failure.failureKind === 'capability_invalid'
  ) {
    return 'stale_capability'
  }
  if (failure.failureKind === 'no_match') return 'no_match'
  // The public errorCode enum intentionally does not grow: an anchored scope
  // mismatch is reported as no_match with the precise prose in the failure.
  if (failure.failureKind === 'anchor_scope_mismatch') return 'no_match'
  if (failure.failureKind === 'preflight_failed') return 'preflight_failed'
  if (classifyTransactionFailureKind(failure.errorMessage) === 'no_match') {
    return 'no_match'
  }
  return 'preflight_failed'
}

function buildTransactionRecovery(params: {
  paths: string[]
  failure: TransactionFailure
  failedReplacementIndex?: number
}): TransactionRecovery {
  const { paths, failure, failedReplacementIndex } = params
  const kind =
    failure.failureKind ?? classifyTransactionFailureKind(failure.errorMessage)
  const isCapability = typeof kind === 'string' && kind.startsWith('capability')
  // An anchored scope mismatch needs the same fresh-read handling as a match
  // failure, but the correct fix is a capability that actually covers the target
  // lines, so replace_range is the preferred strategy rather than a shorter
  // oldString.
  const isAnchorScopeMismatch = kind === 'anchor_scope_mismatch'
  const isMatchFailure = kind === 'no_match' || isAnchorScopeMismatch
  const prefersReplaceRange =
    isAnchorScopeMismatch ||
    /replace_range with its readCapability|Do not reconstruct huge blocks from memory|No useful candidate ranges found/i.test(
      failure.errorMessage,
    )
  const preferredStrategy: TransactionPreferredStrategy | undefined =
    prefersReplaceRange
      ? 'replace_range'
      : isMatchFailure
        ? 'smaller_oldString'
        : undefined

  return {
    action: 'rebuild_whole_transaction',
    requiresFreshRead: isCapability || isMatchFailure || kind === 'generic',
    paths,
    failedEditIndex: failure.editIndex,
    ...(failedReplacementIndex !== undefined && { failedReplacementIndex }),
    ...(preferredStrategy && { preferredStrategy }),
    tool: 'read_files',
    input: { paths },
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
  const coordinates = getLineCoordinates(content)
  // Resolve in capability space: read_files mints whole-file capabilities that
  // bind the trailing entry past the final newline, so resolving in visible
  // space here would drop provenance for exactly the whole-file case and let it
  // skip the transformation-ledger overlap checks.
  const resolved = resolveLineRange({ coordinates, startLine, endLine })
  if (!resolved.ok) {
    return null
  }
  const { lines } = coordinates
  let startOffset = 0
  for (let index = 0; index < resolved.startLine - 1; index++) {
    startOffset += lines[index]!.length + 1
  }
  let endOffset = startOffset
  // When endLine is maxCapabilityLine the final entry is the empty string after
  // the last newline, so this walk naturally ends at normalized.length.
  for (let index = resolved.startLine - 1; index < resolved.endLine; index++) {
    endOffset += lines[index]!.length
    if (index < resolved.endLine - 1) endOffset += 1
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
        entry.afterEnd -
        entry.afterStart -
        (entry.beforeEnd - entry.beforeStart)
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
      // a wrong-version token is classified by classifyTransactionFailureKind.
      ...(typeof decoded === 'string'
        ? { failureKind: 'capability_invalid' as const }
        : {}),
    }
  }
  // Re-anchor the CAPABILITY span here, before occurrence resolution and before
  // provenance mapping, so every downstream consumer sees ONE already-shifted
  // span. Shifting later instead would search the wrong window or shift twice.
  // With no snapshot content to search, today's behavior is kept: the freshness
  // re-hash downstream still fails closed.
  let capabilityStartLine = decoded.startLine
  let capabilityEndLine = decoded.endLine
  let reanchoredBy: number | undefined
  if (typeof currentContent === 'string') {
    const reanchored = reanchorCapabilityRange({
      coordinates: getLineCoordinates(currentContent),
      startLine: decoded.startLine,
      endLine: decoded.endLine,
      expectedHash: decoded.hash,
    })
    if (!reanchored.ok) {
      return {
        error: `replace_range blocked for ${edit.path}: the readCapability-covered content is stale. Re-read lines ${decoded.startLine}-${decoded.endLine} and retry with the fresh token. Cause: ${describeReanchorFailure(reanchored)}.`,
        failureKind: 'capability_stale' as const,
      }
    }
    if (reanchored.shiftedBy !== undefined) {
      capabilityStartLine = reanchored.startLine
      capabilityEndLine = reanchored.endLine
      reanchoredBy = reanchored.shiftedBy
    }
  }
  const capabilityFields = {
    capabilityTokenStartLine: decoded.startLine,
    capabilityTokenEndLine: decoded.endLine,
    capabilityStartLine,
    capabilityEndLine,
    capabilityHash: decoded.hash,
    ...(reanchoredBy !== undefined ? { reanchoredBy } : {}),
  }
  if (edit.occurrence) {
    // Resolve occurrence targeting to absolute original-snapshot lines here, so
    // the resolved bounds flow through provenance mapping and capability
    // verification exactly like explicit line bounds.
    if (typeof currentContent !== 'string') {
      return {
        error: `replace_range blocked for ${edit.path}: current content is unavailable, so the requested occurrence could not be resolved. Re-read the target range and retry.`,
        // Unresolved occurrence targeting is a match failure (not a capability
        // authenticity problem), so recovery/errorCode stay aligned with other
        // no_match cases.
        failureKind: 'no_match' as const,
      }
    }
    const resolved = resolveOccurrenceRangeInCapabilityRange({
      content: currentContent,
      match: edit.occurrence.match,
      occurrence: edit.occurrence.occurrence,
      capabilityStartLine,
      capabilityEndLine,
    })
    if (!resolved.range) {
      return {
        error: `replace_range blocked for ${edit.path}: found ${resolved.found} occurrence(s) of the requested match inside the authorized range ${capabilityStartLine}-${capabilityEndLine}, so occurrence ${edit.occurrence.occurrence ?? 1} does not exist. Re-read the range and target an existing occurrence or absolute lines.`,
        failureKind: 'no_match' as const,
      }
    }
    return {
      edit: {
        ...edit,
        // Already resolved inside the re-anchored window, so it must not shift
        // a second time.
        startLine: resolved.range.startLine,
        endLine: resolved.range.endLine,
        ...capabilityFields,
      },
    }
  }
  // Explicit (and capability-default) target lines were observed in the token's
  // line space, so they move with the capability span.
  const shift = reanchoredBy ?? 0
  return {
    edit: {
      ...edit,
      startLine: (edit.startLine ?? decoded.startLine) + shift,
      endLine: (edit.endLine ?? decoded.endLine) + shift,
      ...capabilityFields,
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
  const startOffset = mapOriginalOffset(
    originalSpan.startOffset,
    ledger,
    'right',
  )
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
    while (
      firstIndex > 0 &&
      ledger[firstIndex - 1]!.actionIndex === actionIndex
    ) {
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
          entry.afterEnd -
          entry.afterStart -
          (entry.beforeEnd - entry.beforeStart)
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
    | {
        beforeStart: number
        beforeEnd: number
        afterStart: number
        afterEnd: number
      }
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
    if (
      originalStart === null ||
      originalEnd === null ||
      originalEnd < originalStart
    ) {
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
          error:
            'a changed interval originated in text introduced by a prior edit',
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
      /**
       * True when EVERY replacement of this edit resolved to an already-applied
       * skipIfMissing deletion, i.e. the whole edit is a deliberate no-op rather
       * than a content change. A mixed batch (one already-applied skip plus a
       * replacement that really applies) is a content change and never sets
       * this, so its applied content is never discarded.
       */
      hadNoOpSkip?: boolean
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
      const coordinates = getLineCoordinates(initialContent)
      const { normalized, lines } = coordinates
      const authorizationTarget = edit.originalRange ?? {
        startLine: edit.startLine,
        endLine: edit.endLine,
      }
      {
        const decoded = decodeReadCapabilityToken(edit.readCapability)
        if (typeof decoded === 'string') {
          return { error: decoded, failureKind: 'capability_invalid' }
        }
        if (!readCapabilityIssuer?.projectId || !readCapabilityIssuer.runId) {
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
        // Authenticate original snapshot coordinates against the bounds the
        // TOKEN carries. A re-anchor may have moved where those bytes live, but
        // it never changes what the capability proved, so the equality check
        // stays on the token bounds.
        if (
          decoded.startLine !== edit.capabilityTokenStartLine ||
          decoded.endLine !== edit.capabilityTokenEndLine ||
          decoded.hash !== edit.capabilityHash
        ) {
          return {
            error: `replace_range blocked for ${edit.path}: normalized capability metadata does not match the authenticated readCapability. Re-read the target and retry with the fresh token.`,
            failureKind: 'capability_stale',
          }
        }
        const originalContent = await originalContentPromise
        // Freshness is re-verified at the ACTUAL located bounds: after a
        // re-anchor the proven bytes live there, and re-slicing the token's
        // original bounds would re-report the staleness the re-anchor resolved.
        const observedContent = getRangeSlice(
          getLineCoordinates(originalContent ?? ''),
          edit.capabilityStartLine,
          edit.capabilityEndLine,
        )
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
      // Bounds resolve in CAPABILITY space: a whole-file capability legally binds
      // the trailing entry past the final newline, so checking against the
      // visible ceiling would reject every whole-file range edit on a
      // newline-terminated file.
      let targetStartLine = edit.startLine
      let targetEndLine = edit.endLine
      let clampSuffix = ''
      if (!edit.mappedRange) {
        const resolved = resolveLineRange({
          coordinates,
          startLine: edit.startLine,
          endLine: edit.endLine,
        })
        if (!resolved.ok) {
          return {
            error: `replace_range ${edit.startLine}-${edit.endLine} is outside ${edit.path} (${describeLineBounds(coordinates)}).`,
          }
        }
        targetStartLine = resolved.startLine
        targetEndLine = resolved.endLine
        if (resolved.clampedFrom) {
          clampSuffix = ` Requested endLine ${resolved.clampedFrom.endLine} was clamped to line ${resolved.endLine}, the file's last capability line.`
        }
      }
      const narrowedTarget =
        authorizationTarget.startLine !== edit.capabilityStartLine ||
        authorizationTarget.endLine !== edit.capabilityEndLine
      const narrowedTargetSuffix = narrowedTarget
        ? ' within the readCapability-covered range'
        : ''
      // A relocated edit must never be silent: the message names the shift so
      // the reported lines can be reconciled with the ones that were read.
      const reanchorSuffix =
        edit.reanchoredBy === undefined
          ? ''
          : ` (re-anchored ${edit.reanchoredBy > 0 ? '+' : ''}${edit.reanchoredBy} lines after content shifted above the target)`
      const replacementContent = normalizeLineEndings(edit.newContent)
      const content = edit.mappedRange
        ? `${normalized.slice(0, edit.mappedRange.startOffset)}${replacementContent}${normalized.slice(edit.mappedRange.endOffset)}`
        : (() => {
            const replacementLines = replacementContent.split('\n')
            lines.splice(
              targetStartLine - 1,
              targetEndLine - targetStartLine + 1,
              ...replacementLines,
            )
            return lines.join('\n')
          })()
      return {
        content,
        messages: [
          `Replaced lines ${authorizationTarget.startLine}-${authorizationTarget.endLine} in ${edit.path}${narrowedTargetSuffix}${reanchorSuffix}.${clampSuffix}`,
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
        if (
          !originalMatch ||
          (!edit.occurrence && originalMatches.length > 1)
        ) {
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
