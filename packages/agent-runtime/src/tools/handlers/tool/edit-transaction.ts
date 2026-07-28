import {
  decodeReadCapabilityToken,
  getContentHash,
  normalizeLineEndings,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'
import {
  MAX_FILE_CHANGES_PER_TRANSACTION,
  MAX_TRANSACTION_FILE_BYTES,
  MAX_TRANSACTION_INPUT_BYTES,
  MAX_TRANSACTION_ROLLBACK_BYTES,
  MAX_TRANSACTION_UNIQUE_PATHS,
} from '@codebuff/common/actions'

import {
  formatUnsafeToolPathError,
  grantWholeFileReadAuthorization,
  hasWholeFileReadAuthorization,
  isWholeFileReadAuthorizationFresh,
  normalizeToolPath,
  revokeWholeFileReadAuthorization,
} from './write-file'
import {
  clearEditRereadRequirement,
  getEditRereadRequirement,
} from './edit-read-state'
import {
  coordinateEditApplication,
  invalidatePreparedEditPaths,
} from './edit-application-coordinator'
import { processEditTransaction } from '../../../process-edit-transaction'
import {
  preflightValidateSyntax,
  formatPreflightErrorMessage,
} from '../../../util/preflight-syntax-validation'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type { FileProcessingState } from './write-file'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { FileChange } from '@codebuff/common/actions'
import type { RequestOptionalFileFn } from '@codebuff/common/types/contracts/client'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { ProjectFileContext } from '@codebuff/common/util/file'

export const TRANSACTION_SNAPSHOT_CONCURRENCY = 8

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++
        results[index] = await mapper(values[index]!, index)
      }
    },
  )
  await Promise.all(workers)
  return results
}

type TransactionEdit =
  CodebuffToolCall<'edit_transaction'>['input']['edits'][number]

function isCapabilityBearingEdit(edit: TransactionEdit): boolean {
  return (
    (edit.type === 'replace_range' && Boolean(edit.readCapability)) ||
    (edit.type === 'rewrite_symbol' && Boolean(edit.readCapability)) ||
    (edit.type === 'write_file' && Boolean(edit.basedOnRead)) ||
    (edit.type === 'str_replace' &&
      edit.replacements.some((replacement) => Boolean(replacement.basedOnRead)))
  )
}

export const handleEditTransaction = (async (
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: CodebuffToolCall<'edit_transaction'>

    fileProcessingState: FileProcessingState
    logger: Logger

    requestClientToolCall: (
      toolCall: ClientToolCall<'edit_transaction'>,
    ) => Promise<CodebuffToolOutput<'edit_transaction'>>
    requestOptionalFile: RequestOptionalFileFn
    fileContext?: ProjectFileContext
    runId?: string
  } & ParamsExcluding<RequestOptionalFileFn, 'filePath'>,
): Promise<{ output: CodebuffToolOutput<'edit_transaction'> }> => {
  const {
    previousToolCallFinished,
    toolCall,
    fileProcessingState,
    logger,
    requestClientToolCall,
    requestOptionalFile,
  } = params
  const edits = toolCall.input.edits.map((edit) => ({
    ...edit,
    path: normalizeToolPath(edit.path),
    ...(edit.type === 'move'
      ? { destinationPath: normalizeToolPath(edit.destinationPath) }
      : {}),
  }))

  const requestedPaths = new Set(
    edits.flatMap((edit) =>
      edit.type === 'move' ? [edit.path, edit.destinationPath] : [edit.path],
    ),
  )
  const inputBytes = Buffer.byteLength(JSON.stringify(edits))
  const requestLimitMessage =
    edits.length > MAX_FILE_CHANGES_PER_TRANSACTION
      ? `edit_transaction accepts at most ${MAX_FILE_CHANGES_PER_TRANSACTION} edits.`
      : requestedPaths.size > MAX_TRANSACTION_UNIQUE_PATHS
        ? `edit_transaction accepts at most ${MAX_TRANSACTION_UNIQUE_PATHS} unique paths.`
        : inputBytes > MAX_TRANSACTION_INPUT_BYTES
          ? `edit_transaction input exceeds the ${MAX_TRANSACTION_INPUT_BYTES}-byte limit.`
          : null
  if (requestLimitMessage) {
    return {
      output: [
        {
          type: 'json',
          value: {
            errorMessage: `${requestLimitMessage} Split the work into bounded transactions.`,
            failures: [
              {
                editIndex: -1,
                path: [...requestedPaths].join(', '),
                errorMessage: requestLimitMessage,
              },
            ],
          },
        },
      ],
    }
  }

  // Block the whole transaction rather than forwarding an unsafe/empty path.
  // Report the original input so the agent can correct the exact edit.
  const unsafePathIndex = edits.findIndex(
    (edit) => !edit.path || (edit.type === 'move' && !edit.destinationPath),
  )
  if (unsafePathIndex !== -1) {
    const originalEdit = toolCall.input.edits[unsafePathIndex]
    const originalPath =
      originalEdit.type === 'move' && !edits[unsafePathIndex].destinationPath
        ? originalEdit.destinationPath
        : originalEdit.path
    return {
      output: [
        {
          type: 'json',
          value: {
            errorMessage: formatUnsafeToolPathError(
              'edit_transaction',
              originalPath,
            ),
            failures: [
              {
                editIndex: unsafePathIndex,
                path: originalPath,
                errorMessage: formatUnsafeToolPathError(
                  'edit_transaction',
                  originalPath,
                ),
              },
            ],
          },
        },
      ],
    }
  }

  await previousToolCallFinished

  const uniquePaths = Array.from(requestedPaths)
  const initialContentByPath = new Map<string, string | null>()
  const snapshots = await mapWithConcurrency(
    uniquePaths,
    TRANSACTION_SNAPSHOT_CONCURRENCY,
    async (path) => {
      const previousPromises = fileProcessingState.promisesByPath[path]
      const previousEdit = previousPromises?.[previousPromises.length - 1]
      const initialContent = previousEdit
        ? await previousEdit.then((maybeResult) =>
            maybeResult && 'content' in maybeResult
              ? maybeResult.content
              : requestOptionalFile({ ...params, filePath: path }),
          )
        : await requestOptionalFile({ ...params, filePath: path })

      return initialContent
    },
  )
  uniquePaths.forEach((path, index) => {
    initialContentByPath.set(path, snapshots[index]!)
  })
  let rollbackBytes = 0
  for (const [index, path] of uniquePaths.entries()) {
    const content = snapshots[index]
    const bytes = content === null ? 0 : Buffer.byteLength(content)
    rollbackBytes += bytes
    if (
      bytes > MAX_TRANSACTION_FILE_BYTES ||
      rollbackBytes > MAX_TRANSACTION_ROLLBACK_BYTES
    ) {
      const message =
        bytes > MAX_TRANSACTION_FILE_BYTES
          ? `Transaction file ${path} exceeds the ${MAX_TRANSACTION_FILE_BYTES}-byte per-file limit.`
          : `Transaction rollback state exceeds the ${MAX_TRANSACTION_ROLLBACK_BYTES}-byte limit.`
      return {
        output: [
          {
            type: 'json',
            value: {
              errorMessage: `${message} No files were changed. Split the work into bounded transactions or range edits.`,
              failures: [
                {
                  editIndex: -1,
                  path,
                  errorMessage: message,
                },
              ],
            },
          },
        ],
      }
    }
  }

  const projectId = params.fileContext?.projectRoot ?? ''
  const runId = params.runId ?? ''
  const hasCapabilityBearingEdit = edits.some(isCapabilityBearingEdit)
  if (hasCapabilityBearingEdit && (!projectId || !runId)) {
    return {
      output: [
        {
          type: 'json',
          value: {
            errorMessage:
              'edit_transaction blocked: capability-bearing edits require a nonempty authoritative projectId and runId.',
            failures: edits.flatMap((edit, editIndex) =>
              isCapabilityBearingEdit(edit)
                ? [
                    {
                      editIndex,
                      path: edit.path,
                      errorMessage:
                        'Authenticated capability scope is unavailable; re-read and retry in a runtime with a nonempty project and run scope.',
                    },
                  ]
                : [],
            ),
          },
        },
      ],
    }
  }
  /**
   * Validate write_file basedOnRead: must be whole-file covering, scope-bound,
   * and hash-fresh against current content. Partial ranges never authorize.
   */
  const validateWriteFileBasedOnRead = (
    path: string,
    content: string,
    token: string,
  ): { ok: true } | { ok: false; error: string } => {
    const decoded = decodeReadCapabilityToken(token)
    if (typeof decoded === 'string') {
      return { ok: false, error: decoded }
    }
    if (!readCapabilityMatchesScope(decoded, { projectId, path, runId })) {
      return {
        ok: false,
        error: `write_file basedOnRead for ${path} belongs to a different project, path, or agent run. Re-read the whole file and pass the fresh capability.`,
      }
    }
    const lineCount = normalizeLineEndings(content).split('\n').length
    if (decoded.startLine !== 1 || decoded.endLine !== lineCount) {
      return {
        ok: false,
        error: `a range capability cannot authorize a whole-file overwrite for ${path} (capability covers lines ${decoded.startLine}-${decoded.endLine}; file has ${lineCount} lines). Pass only a whole-file-covering cap.v3 from a complete paths or full-file range read.`,
      }
    }
    if (decoded.hash !== getContentHash(content)) {
      return {
        ok: false,
        error: `write_file basedOnRead for ${path} did not match the current file content (stale hash). Re-read the whole file and retry with the fresh capability.`,
      }
    }
    return { ok: true }
  }

  const authorizeWholeFileFromCapability = (
    path: string,
    content: string,
    token: string,
  ): { ok: true } | { ok: false; error: string } => {
    const auth = validateWriteFileBasedOnRead(path, content, token)
    if (!auth.ok) return auth
    freshWholeFileAuthorizationPaths.add(path)
    grantWholeFileReadAuthorization(fileProcessingState, path, content)
    clearEditRereadRequirement(fileProcessingState, path)
    return { ok: true }
  }

  const freshWholeFileAuthorizationPaths = new Set<string>()
  const staleWholeFileAuthorizationPaths = new Set<string>()
  for (const path of uniquePaths) {
    const initialContent = initialContentByPath.get(path)
    const hasStoredAuthorization = hasWholeFileReadAuthorization(
      fileProcessingState,
      path,
    )
    const isFresh =
      typeof initialContent === 'string' &&
      isWholeFileReadAuthorizationFresh(
        fileProcessingState,
        path,
        initialContent,
      )
    if (isFresh) {
      freshWholeFileAuthorizationPaths.add(path)
      // Do not clear context_compacted on mere hash-fresh: write_file must stay
      // blocked until a real re-read or explicit whole-file basedOnRead. str_replace
      // clears the marker when it proceeds below (unique oldString is the safety bound).
      const rereadReq = getEditRereadRequirement(fileProcessingState, path)
      if (rereadReq?.reason !== 'context_compacted') {
        clearEditRereadRequirement(fileProcessingState, path)
      }
    } else if (hasStoredAuthorization) {
      staleWholeFileAuthorizationPaths.add(path)
      revokeWholeFileReadAuthorization(fileProcessingState, path)
    }
  }

  // Explicit write_file basedOnRead: whole-file covering + hash-fresh authorizes
  // this path for the transaction (including clearing context_compacted).
  for (const edit of edits) {
    if (edit.type !== 'write_file' || !edit.basedOnRead) continue
    if (freshWholeFileAuthorizationPaths.has(edit.path)) {
      // Still honor explicit capability for context_compacted: sticky alone is not enough.
      const rereadReq = getEditRereadRequirement(fileProcessingState, edit.path)
      if (rereadReq?.reason === 'context_compacted') {
        const content = initialContentByPath.get(edit.path)
        if (typeof content === 'string') {
          // Result intentionally discarded: an invalid capability is reported
          // by the strict-gate re-validation below; this call only grants
          // authorization when the capability is valid.
          authorizeWholeFileFromCapability(edit.path, content, edit.basedOnRead)
        }
      }
      continue
    }
    const content = initialContentByPath.get(edit.path)
    if (typeof content !== 'string') continue
    // Result intentionally discarded: an invalid capability is reported by the
    // strict-gate re-validation below; this call only grants authorization when
    // the capability is valid.
    authorizeWholeFileFromCapability(edit.path, content, edit.basedOnRead)
  }

  // Auto-reread-once per unique path for str_replace auth misses only.
  // write_file whole-file overwrites must keep the standalone floor: prior
  // complete whole-file sticky hash match (or explicit capability). Snapshots
  // already loaded content via requestOptionalFile — authorize *this*
  // transaction's str_replace edits from that content without minting durable
  // sticky (so a later write_file cannot chain off a blind server re-read).
  // Post-apply grant of *new* content after successful application may still
  // refresh sticky from observed post-edit bytes (onApplied below).
  // Unique-only contract: any allowMultiple:true replacement on a path is
  // not evidence the model knows the file content. It is excluded from
  // auto-reread authorization below, and its context_compacted marker is
  // preserved through the apply (passed to coordinateEditApplication as
  // preserveRereadRequirementsForPaths) so a later write_file stays blocked.
  const pathsWithAllowMultiple = new Set<string>()
  for (const edit of edits) {
    if (edit.type !== 'str_replace') continue
    if (
      Array.isArray(edit.replacements) &&
      edit.replacements.some(
        (replacement) => replacement.allowMultiple === true,
      )
    ) {
      pathsWithAllowMultiple.add(edit.path)
    }
  }
  const autoRereadAuthorizedPaths = new Set<string>()
  if (fileProcessingState.strictReadBeforeEdit) {
    const pathsNeedingAuth = new Set<string>()
    for (const edit of edits) {
      if (edit.type !== 'str_replace') continue
      if (freshWholeFileAuthorizationPaths.has(edit.path)) continue
      if (pathsWithAllowMultiple.has(edit.path)) continue
      if (
        Array.isArray(edit.replacements) &&
        edit.replacements.length > 0 &&
        edit.replacements.every((replacement) => Boolean(replacement.basedOnRead))
      ) {
        continue
      }
      pathsNeedingAuth.add(edit.path)
    }
    for (const path of pathsNeedingAuth) {
      if (freshWholeFileAuthorizationPaths.has(path)) continue
      if (staleWholeFileAuthorizationPaths.has(path)) continue
      const content = initialContentByPath.get(path)
      if (typeof content !== 'string') continue
      // Transaction-local only: do not call grantWholeFileReadAuthorization and
      // do not add to freshWholeFileAuthorizationPaths (would authorize write_file).
      // Do not clear reread markers here — auto-reread only authorizes this
      // transaction's str_replace preflight. Markers (context_compacted /
      // failed-edit) remain until successful non-allowMultiple apply
      // (onApplied) so a failed unique/no-match still keeps write_file
      // blocked under context_compacted.
      autoRereadAuthorizedPaths.add(path)
    }
  }

  const requireFreshReadCapabilityForPaths = new Set<string>()
  if (fileProcessingState.strictReadBeforeEdit) {
    const failures: Array<{
      editIndex: number
      path: string
      errorMessage: string
    }> = []
    edits.forEach((edit, editIndex) => {
      if (
        edit.type === 'create' &&
        initialContentByPath.get(edit.path) === null
      ) {
        return
      }
      // write_file: context_compacted blocks overwrite even when sticky hash matches,
      // unless an explicit whole-file-covering basedOnRead authorizes (handled above).
      if (
        edit.type === 'write_file' &&
        getEditRereadRequirement(fileProcessingState, edit.path)?.reason ===
          'context_compacted'
      ) {
        // Retry validation when basedOnRead was present but failed earlier, or absent.
        if (edit.basedOnRead) {
          const content = initialContentByPath.get(edit.path)
          if (typeof content === 'string') {
            const auth = authorizeWholeFileFromCapability(
              edit.path,
              content,
              edit.basedOnRead,
            )
            if (auth.ok) {
              return
            }
            failures.push({
              editIndex,
              path: edit.path,
              errorMessage: `Edit blocked: ${edit.path} had its exact read content removed from the active model context (context compaction). ${auth.error} Call read_files with paths: ["${edit.path}"] and retry with the capability from that complete model-visible read.`,
            })
            return
          }
        }
        failures.push({
          editIndex,
          path: edit.path,
          errorMessage: `Edit blocked: ${edit.path} had its exact read content removed from the active model context (context compaction). Call read_files with paths: ["${edit.path}"] before a whole-file overwrite and retry with the capability from that complete model-visible read; sticky hash match alone is not sufficient for write_file.`,
        })
        return
      }
      // delete/move: a fresh confirmed post-edit anchor on the source path
      // (e.g. minted when that path was created via a `create` edit earlier in
      // the run) authorizes the delete/move without another read, but only when
      // the anchor hash matches the transaction's snapshotted current content.
      // A mismatch means the file changed since that confirmed apply — fail
      // closed via the generic block. A move's destination needs no read
      // authorization here: it is a non-existent target whose safety is already
      // enforced by the lifecycle preflight ('Move destination already exists').
      if (edit.type === 'delete' || edit.type === 'move') {
        const anchor =
          fileProcessingState.confirmedPostEditAnchorsByPath?.[edit.path]
        const snapContent = initialContentByPath.get(edit.path)
        if (
          anchor &&
          typeof snapContent === 'string' &&
          anchor.contentHash === getContentHash(snapContent)
        ) {
          return
        }
      }
      if (freshWholeFileAuthorizationPaths.has(edit.path)) {
        // Hash-fresh sticky authorizes this edit, but do not clear
        // context_compacted here for str_replace — only after successful apply
        // in onApplied. write_file stays blocked above while the marker remains
        // unless basedOnRead already cleared it.
        if (
          edit.type !== 'write_file' &&
          edit.type !== 'str_replace' &&
          getEditRereadRequirement(fileProcessingState, edit.path)?.reason !==
            'context_compacted'
        ) {
          clearEditRereadRequirement(fileProcessingState, edit.path)
        }
        return
      }
      // Auto-reread authorizes str_replace only in this transaction.
      if (
        edit.type === 'str_replace' &&
        autoRereadAuthorizedPaths.has(edit.path)
      ) {
        return
      }
      // write_file basedOnRead that failed validation must surface a clear error.
      if (edit.type === 'write_file' && edit.basedOnRead) {
        const content = initialContentByPath.get(edit.path)
        if (typeof content === 'string') {
          const auth = authorizeWholeFileFromCapability(
            edit.path,
            content,
            edit.basedOnRead,
          )
          if (auth.ok) {
            return
          }
          failures.push({
            editIndex,
            path: edit.path,
            errorMessage: `Edit blocked: ${auth.error} Call read_files with paths: ["${edit.path}"] and retry with the capability from that complete model-visible read.`,
          })
          return
        }
      }
      // Per-edit basedOnRead anchors satisfy strict mode without a prior read,
      // but every replacement must carry its own scoped capability.
      const hasBasedOnRead =
        edit.type === 'str_replace' &&
        Array.isArray(edit.replacements) &&
        edit.replacements.length > 0 &&
        edit.replacements.every((replacement) =>
          Boolean(replacement.basedOnRead),
        )
      if (hasBasedOnRead) {
        requireFreshReadCapabilityForPaths.add(edit.path)
        return
      }
      const hasScopedReadCapability =
        (edit.type === 'replace_range' || edit.type === 'rewrite_symbol') &&
        Boolean(edit.readCapability)
      if (hasScopedReadCapability) {
        requireFreshReadCapabilityForPaths.add(edit.path)
        return
      }
      const rangeRecovery =
        edit.type === 'replace_range'
          ? ` Call read_files with ranges: [{ "path": "${edit.path}", "startLine": ${edit.startLine ?? 1}, "endLine": ${edit.endLine ?? edit.startLine ?? 1} }] and retry with only its readCapability plus newContent.`
          : edit.type === 'rewrite_symbol'
            ? ` Call read_files with symbols: [{ "path": "${edit.path}", "names": ["${edit.symbol}"] }] and retry with the matching slice editAnchor.readCapability.`
            : ''
      const wholeFileRecovery = ` Call read_files with paths: ["${edit.path}"] before retrying and use the capability from that complete model-visible read.`
      failures.push({
        editIndex,
        path: edit.path,
        errorMessage: staleWholeFileAuthorizationPaths.has(edit.path)
          ? `Edit blocked: ${edit.path} changed after its last whole-file read, so the stored authorization was revoked.${rangeRecovery || wholeFileRecovery}`
          : `Edit blocked: strict read-before-edit is enabled and no fresh read authorization exists for ${edit.path}.${rangeRecovery || wholeFileRecovery} Only a complete whole-file read registers reusable authorization for ${edit.path}; a range read only yields a scoped capability that must be passed explicitly as basedOnRead/readCapability on the edit. If you already read ${edit.path} this session, that authorization may have been dropped: a read and edit emitted in the same step do not authorize until the next step, and context compaction may mark earlier implicit reads for re-check — re-read before retrying when the file changed.`,
      })
    })
    if (failures.length > 0) {
      return {
        output: [
          {
            type: 'json',
            value: {
              errorMessage: [
                'edit_transaction blocked: strict read-before-edit is enabled and one or more paths have no read authorization.',
                "Follow each failure's exact recovery selector. Complete a model-visible read_files refresh before retrying; for replace_range, re-read that range and use only its readCapability.",
              ].join('\n'),
              failures,
            },
          },
        ],
      }
    }
  }

  const lifecycleFailures = edits.flatMap((edit, editIndex) => {
    const source = initialContentByPath.get(edit.path)
    if (edit.type === 'create' && source !== null) {
      return [
        {
          editIndex,
          path: edit.path,
          errorMessage: `Create destination already exists at ${edit.path}. Call read_files with paths: ["${edit.path}"] before retrying with type "write_file" and its whole-file capability, or use "str_replace" for an in-place edit.`,
        },
      ]
    }
    if (
      (edit.type === 'delete' || edit.type === 'move') &&
      typeof source !== 'string'
    ) {
      return [
        {
          editIndex,
          path: edit.path,
          errorMessage: `${edit.type === 'delete' ? 'Delete' : 'Move'} source does not exist.`,
        },
      ]
    }
    if (
      edit.type === 'move' &&
      initialContentByPath.get(edit.destinationPath) !== null
    ) {
      return [
        {
          editIndex,
          path: edit.destinationPath,
          errorMessage: 'Move destination already exists.',
        },
      ]
    }
    return []
  })
  if (lifecycleFailures.length > 0) {
    return {
      output: [
        {
          type: 'json',
          value: {
            errorMessage:
              'edit_transaction lifecycle preflight failed; no changes were applied.',
            failures: lifecycleFailures,
          },
        },
      ],
    }
  }

  const contentEdits = edits.filter(
    (edit) =>
      edit.type === 'str_replace' ||
      edit.type === 'structured' ||
      edit.type === 'replace_range' ||
      edit.type === 'rewrite_symbol' ||
      edit.type === 'patch' ||
      edit.type === 'write_file',
  )
  const transactionResult =
    contentEdits.length > 0
      ? await processEditTransaction({
          edits: contentEdits,
          initialContentByPath,
          logger,
          requireFreshReadCapabilityForPaths,
          readCapabilityIssuer: {
            projectId,
            runId,
          },
        })
      : {
          tool: 'edit_transaction' as const,
          message: `Prepared ${edits.length} lifecycle edit(s).`,
          files: [],
        }

  if ('error' in transactionResult) {
    const failureText = transactionResult.failures
      .map((failure) => failure.errorMessage)
      .join('\n')
    const requiresFreshCapability =
      transactionResult.failures.some(
        (failure) =>
          typeof failure.failureKind === 'string' &&
          failure.failureKind.startsWith('capability'),
      ) ||
      /different project, path, or agent run|Invalid basedOnRead|readCapability-covered (?:symbol )?content is stale|normalized capability metadata does not match|readCapability does not cover the exact original symbol replacement span/i.test(
        failureText,
      )
    // Deterministic preflight failures made no writes and preserve existing
    // authorization. Capability freshness/scope failures are different: retrying
    // the atomic transaction requires one new snapshot for every target so no
    // stale token from another path is replayed alongside the refreshed failure.
    invalidatePreparedEditPaths({
      fileProcessingState,
      paths: uniquePaths,
      revokeReadAuthorization: requiresFreshCapability,
      requiresFreshRead: requiresFreshCapability,
      ...(requiresFreshCapability
        ? { reason: 'stale_capability' as const, sourceTool: 'edit_transaction' }
        : {}),
    })

    return {
      output: [
        {
          type: 'json',
          value: {
            errorMessage: requiresFreshCapability
              ? [
                  transactionResult.error,
                  `Atomic recovery requires fresh read state for every transaction target in this run: ${uniquePaths.join(', ')}. Re-read all targets and rebuild the complete transaction with only those fresh capabilities; do not refresh only the first failed path or replay any other stale token.`,
                ].join('\n')
              : transactionResult.error,
            failures: transactionResult.failures,
          },
        },
      ],
    }
  }

  // --- VIRTUAL COMPILE TRANSACTIONS: Preflight Syntax Validation ---
  // Uses the shared preflightValidateSyntax utility which handles JS/TS
  // (Bun.Transpiler), Python (structural validation), and Go (structural
  // validation). In Node.js, JS/TS validation is gracefully skipped.
  for (const file of transactionResult.files) {
    const syntaxValidation = preflightValidateSyntax(file.path, file.content)
    if (!syntaxValidation.valid) {
      // A preflight syntax failure is NOT a stale-anchor failure: the edits
      // were structurally applied but the resulting content has a syntax
      // error. Don't force a re-read (markAllTransactionPathsAsRequiringRead)
      // — the agent only needs to fix the syntax, not re-read all files.
      // Report the first edit index that targeted this path so the agent can
      // identify which edit produced the broken content (multiple edits can
      // target the same path; the first is the most actionable starting point).
      const editIndex = edits.findIndex((edit) => edit.path === file.path)
      return {
        output: [
          {
            type: 'json',
            value: {
              errorMessage: formatPreflightErrorMessage(
                'edit_transaction',
                file.path,
                syntaxValidation.message,
              ),
              failures: [
                {
                  editIndex,
                  path: file.path,
                  errorMessage: syntaxValidation.message,
                },
              ],
            },
          },
        ],
      }
    }
  }

  for (const edit of edits) {
    if (edit.type !== 'create') continue
    const syntaxValidation = preflightValidateSyntax(edit.path, edit.content)
    if (!syntaxValidation.valid) {
      return {
        output: [
          {
            type: 'json',
            value: {
              errorMessage: formatPreflightErrorMessage(
                'edit_transaction',
                edit.path,
                syntaxValidation.message,
              ),
              failures: [
                {
                  editIndex: edits.indexOf(edit),
                  path: edit.path,
                  errorMessage: syntaxValidation.message,
                },
              ],
            },
          },
        ],
      }
    }
  }

  const preparedContentByPath = new Map(
    transactionResult.files.map((file) => [file.path, file]),
  )
  const firstContentEditIndexByPath = new Map<string, number>()
  edits.forEach((edit, index) => {
    if (
      !['create', 'delete', 'move'].includes(edit.type) &&
      !firstContentEditIndexByPath.has(edit.path)
    ) {
      firstContentEditIndexByPath.set(edit.path, index)
    }
  })
  const clientChanges: Array<{ index: number; change: FileChange }> = []
  for (const [path, file] of preparedContentByPath) {
    const initial = initialContentByPath.get(path) ?? null
    clientChanges.push({
      index: firstContentEditIndexByPath.get(path)!,
      change: {
        type: 'patch',
        path,
        content: file.patch,
        expectedHash: initial === null ? null : getContentHash(initial),
      },
    })
  }
  edits.forEach((edit, index) => {
    if (edit.type === 'create') {
      clientChanges.push({
        index,
        change: {
          type: 'file',
          path: edit.path,
          content: edit.content,
          expectedHash: null,
        },
      })
    } else if (edit.type === 'delete') {
      const initial = initialContentByPath.get(edit.path)
      if (typeof initial === 'string') {
        clientChanges.push({
          index,
          change: {
            type: 'delete',
            path: edit.path,
            expectedHash: getContentHash(initial),
          },
        })
      }
    } else if (edit.type === 'move') {
      const initial = initialContentByPath.get(edit.path)
      if (typeof initial === 'string') {
        clientChanges.push({
          index,
          change: {
            type: 'move',
            path: edit.path,
            destinationPath: edit.destinationPath,
            expectedHash: getContentHash(initial),
            destinationExpectedHash: null,
          },
        })
      }
    }
  })
  clientChanges.sort((a, b) => a.index - b.index)

  // Only paths that produced an actual client change can emit an `applied`
  // action, so scope the positive-evidence confirmation set to those paths.
  // A content edit that resolved to a no-op is excluded from `clientChanges`
  // and must not be required for confirmation.
  const confirmationPaths = new Set<string>()
  for (const { change } of clientChanges) {
    confirmationPaths.add(change.path)
    if (change.type === 'move' && typeof change.destinationPath === 'string') {
      confirmationPaths.add(change.destinationPath)
    }
  }

  const wholeFileContentByPath = new Map(
    transactionResult.files.map((file) => [file.path, file.content]),
  )
  for (const edit of edits) {
    if (edit.type === 'create') {
      wholeFileContentByPath.set(edit.path, edit.content)
    } else if (edit.type === 'move') {
      const sourceContent = initialContentByPath.get(edit.path)
      if (typeof sourceContent === 'string') {
        wholeFileContentByPath.set(edit.destinationPath, sourceContent)
      }
    }
  }
  const application = await coordinateEditApplication<'edit_transaction'>({
    toolName: 'edit_transaction',
    fileProcessingState,
    paths: uniquePaths,
    projectId,
    runId,
    confirmationPaths,
    wholeFileContentByPath,
    rejectionRequiresRead: false,
    // A blind allowMultiple str_replace apply must not clear context_compacted:
    // it is not evidence the model knows the file content, so keep write_file
    // blocked for those paths even after a confirmed apply.
    preserveRereadRequirementsForPaths: pathsWithAllowMultiple,
    apply: () =>
      requestClientToolCall({
        toolCallId: toolCall.toolCallId,
        toolName: 'edit_transaction',
        input: clientChanges.map(({ change }) => change),
      }),
    onApplied: () => {
      // Paths that successfully applied a str_replace in this transaction may
      // clear context_compacted (unique oldString safety bound, post-apply only).
      // allowMultiple (replace-all) applies do NOT clear context_compacted: a
      // blind global replace is not evidence the model knows the file content;
      // only a unique-anchor apply or a fresh read clears the marker.
      // write_file authorized via whole-file basedOnRead already cleared markers
      // pre-apply and refreshes sticky from post-edit content below.
      const appliedNonAllowMultipleStrReplacePaths = new Set(
        edits
          .filter(
            (edit) =>
              edit.type === 'str_replace' &&
              !(
                Array.isArray(edit.replacements) &&
                edit.replacements.some(
                  (replacement) => replacement.allowMultiple === true,
                )
              ),
          )
          .map((edit) => edit.path),
      )
      const appliedWriteFilePaths = new Set(
        edits
          .filter((edit) => edit.type === 'write_file')
          .map((edit) => edit.path),
      )
      for (const file of transactionResult.files) {
        if (
          appliedWriteFilePaths.has(file.path) ||
          appliedNonAllowMultipleStrReplacePaths.has(file.path)
        ) {
          clearEditRereadRequirement(fileProcessingState, file.path)
        }
        const fileProcessingResult = Promise.resolve({
          tool: 'edit_transaction' as const,
          path: file.path,
          toolCallId: toolCall.toolCallId,
          content: file.content,
          patch: file.patch,
          messages: file.messages,
        })
        if (!fileProcessingState.promisesByPath[file.path]) {
          fileProcessingState.promisesByPath[file.path] = []
        }
        fileProcessingState.promisesByPath[file.path].push(fileProcessingResult)
        fileProcessingState.allPromises.push(fileProcessingResult)
      }
    },
  })

  if (application.status === 'threw') {
    return {
      output: [
        {
          type: 'json',
          value: {
            errorMessage: [
              'edit_transaction failed while applying its preflighted coordinated changes.',
              `Client threw: ${application.error instanceof Error ? application.error.message : String(application.error)}`,
              'No in-memory transaction state was recorded. Re-read all affected files before retrying.',
            ].join('\n'),
            failures: [
              {
                editIndex: -1,
                path: transactionResult.files
                  .map((file) => file.path)
                  .join(', '),
                errorMessage:
                  application.error instanceof Error
                    ? application.error.message
                    : String(application.error),
              },
            ],
          },
        },
      ],
    }
  }

  if (application.status === 'rejected') {
    return { output: application.output }
  }

  return { output: application.output }
}) satisfies CodebuffToolHandlerFunction<'edit_transaction'>
