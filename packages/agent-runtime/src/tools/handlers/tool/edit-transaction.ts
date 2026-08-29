import {
  decodeReadCapabilityToken,
  getContentHash,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'
import {
  describeLineBounds,
  getLineCoordinates,
  getRangeSlice,
  isWholeFileCoveringRange,
} from '@codebuff/common/util/line-coordinates'
import {
  MAX_FILE_CHANGES_PER_TRANSACTION,
  MAX_TRANSACTION_FILE_BYTES,
  MAX_TRANSACTION_INPUT_BYTES,
  MAX_TRANSACTION_ROLLBACK_BYTES,
  MAX_TRANSACTION_UNIQUE_PATHS,
} from '@codebuff/common/actions'
import { PAYLOAD_TRUNCATED_ERROR_CODE } from '@codebuff/common/tools/params/utils'

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

const TRANSACTION_SNAPSHOT_CONCURRENCY = 8

/**
 * Conservative signal that a preflight syntax message is a transport-truncation
 * artifact (a payload cut in transit) rather than a genuine code-syntax error.
 * Only fires on SMALL payloads carrying `Unexpected )` / `Unexpected ,`: a real
 * file very rarely has more closers than openers, but a payload whose newString
 * was cut mid-expression ends exactly there. Genuine syntax errors on real file
 * content keep the normal preflight_failed path; this never overrides them.
 *
 * The closer-over-opener heuristic on the edit payload alone can mislabel a
 * malformed-but-NOT-truncated edit whose newString legitimately has more
 * closers than openers (e.g. a regex or `})();` fragment). To avoid that, the
 * raw truncation signal is ALSO required: the post-edit file content itself
 * must be unbalanced (more closers than openers) in the raw delimiter count.
 * A genuinely truncated edit payload leaves the synthesized file unbalanced,
 * whereas authored content that merely has extras inside a string/regex keeps
 * the whole file delimiter-balanced and stays on preflight_failed.
 */
function looksLikeTruncatedEditContent(
  edit: TransactionEdit,
  syntaxMessage: string,
  filePostEditContent: string,
): boolean {
  if (!/Unexpected [\),]/.test(syntaxMessage)) return false
  const fragments: string[] = []
  if (edit.type === 'str_replace') {
    for (const replacement of edit.replacements) {
      fragments.push(replacement.newString)
    }
  } else if (
    edit.type === 'write_file' ||
    edit.type === 'create' ||
    edit.type === 'rewrite_symbol'
  ) {
    fragments.push(edit.content)
  } else if (edit.type === 'replace_range') {
    fragments.push(edit.newContent)
  } else if (edit.type === 'patch') {
    fragments.push(edit.diff)
  } else {
    return false
  }
  const text = fragments.join('\n')
  // Truncation only makes sense for sub-slab payloads; large payloads fail at
  // argument-parse instead and never reach preflight.
  if (text.length > 64 * 1024) return false
  const balance = (open: string, close: string): number => {
    let delta = 0
    for (const ch of text) {
      if (ch === open) delta++
      else if (ch === close) delta--
    }
    return delta
  }
  // More closers than openers across the replacement content is the signature of
  // a mid-body cut (the extra closer belongs to enclosing structure that never
  // arrived), not of authored code.
  const payloadImbalance =
    balance('(', ')') < 0 || balance('[', ']') < 0 || balance('{', '}') < 0
  if (!payloadImbalance) return false
  // Corroborate with the raw truncation signal on the whole post-edit file: a
  // genuinely truncated edit leaves the synthesized file unbalanced; a
  // malformed-but-complete edit keeps it balanced and must stay preflight_failed.
  return isRawDelimiterUnbalanced(filePostEditContent)
}

/**
 * True when the whole post-edit file content has more closing than opening
 * delimiters in the raw character count. A genuinely truncated edit payload
 * (cut mid-body) makes the synthesized file end with unmatched closers; an
 * authored regex/`})();` fragment keeps the file balanced. String/comment/
 * regex-aware counting is intentionally NOT used here: this is a deliberately
 * cheap, conservative corroboration on top of the payload heuristic, and the
 * whole-file raw count is what a transport cut actually perturbs.
 */
function isRawDelimiterUnbalanced(content: string): boolean {
  let parens = 0
  let brackets = 0
  let braces = 0
  for (const ch of content) {
    if (ch === '(') parens++
    else if (ch === ')') parens--
    else if (ch === '[') brackets++
    else if (ch === ']') brackets--
    else if (ch === '{') braces++
    else if (ch === '}') braces--
  }
  return parens < 0 || brackets < 0 || braces < 0
}

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
      Array.isArray(edit.replacements) &&
      edit.replacements.some((replacement) => Boolean(replacement.basedOnRead)))
  )
}

/**
 * Server-side post-edit authority substitution. Preflight-time edit reshaping
 * only — never writes files, never partially applies, never touches reread
 * markers.
 *
 * When a capability-bearing edit proves stale ONLY because an earlier edit in
 * this same run already changed the file, the runtime provably knows the
 * current bytes from the confirmed post-edit anchor minted by that prior
 * confirmed apply. In that case, replace the provided capability with the
 * server's confirmed anchor capability instead of forcing a re-read.
 *
 * Fail closed — substitute ONLY when ALL of these hold; otherwise return the
 * edit unchanged so the existing strict capability path fires:
 * 1. The provided token decodes to a well-formed cap.v3 (an undecodable token
 *    is owned by the existing capability_invalid path).
 * 2. A confirmed post-edit anchor exists for the path.
 * 3. The anchor is whole-file (startLine === 1) — a scoped anchor never
 *    substitutes, least of all for a whole-file overwrite.
 * 4. The transaction snapshot content for the path is known.
 * 5. The anchor hash is fresh against the current snapshot — a mismatch means
 *    the file changed since the confirmed apply.
 * 6. The anchor's own capability re-decodes and is scope-bound to this same
 *    run + normalized path (cross-run / cross-path anti-replay).
 *
 * delete/move are never touched here (they are authorized separately via the
 * confirmed-anchor branch), and context_compacted markers are never cleared
 * by this substitution.
 */
function substituteConfirmedPostEditCapabilities(
  edits: TransactionEdit[],
  initialContentByPath: ReadonlyMap<string, string | null>,
  fileProcessingState: FileProcessingState,
  projectId: string,
  runId: string,
  logger: Logger,
): TransactionEdit[] {
  const confirmedCapabilityForPath = (
    path: string,
    providedToken: string,
  ): string | null => {
    if (typeof decodeReadCapabilityToken(providedToken) === 'string') {
      return null
    }
    const anchor = fileProcessingState.confirmedPostEditAnchorsByPath?.[path]
    if (!anchor) return null
    if (anchor.startLine !== 1) return null
    const snapshotContent = initialContentByPath.get(path)
    if (typeof snapshotContent !== 'string') return null
    if (anchor.contentHash !== getContentHash(snapshotContent)) return null
    const decodedAnchor = decodeReadCapabilityToken(anchor.readCapability)
    if (typeof decodedAnchor === 'string') return null
    if (
      !readCapabilityMatchesScope(decodedAnchor, { projectId, path, runId })
    ) {
      return null
    }
    return anchor.readCapability
  }

  return edits.map((edit, editIndex) => {
    const logSubstitution = (): void => {
      logger.info(
        { path: edit.path, editIndex },
        'Substituted stale read capability with confirmed post-edit anchor (server-known current content)',
      )
    }
    if (edit.type === 'str_replace') {
      if (!Array.isArray(edit.replacements)) return edit
      let substitutedAny = false
      const replacements = edit.replacements.map((replacement) => {
        if (!replacement.basedOnRead) return replacement
        const confirmed = confirmedCapabilityForPath(
          edit.path,
          replacement.basedOnRead,
        )
        if (confirmed === null || confirmed === replacement.basedOnRead) {
          return replacement
        }
        substitutedAny = true
        return { ...replacement, basedOnRead: confirmed }
      })
      if (!substitutedAny) return edit
      logSubstitution()
      return { ...edit, replacements }
    }
    if (edit.type === 'write_file') {
      if (!edit.basedOnRead) return edit
      const confirmed = confirmedCapabilityForPath(edit.path, edit.basedOnRead)
      if (confirmed === null || confirmed === edit.basedOnRead) return edit
      logSubstitution()
      return { ...edit, basedOnRead: confirmed }
    }
    if (edit.type === 'replace_range' || edit.type === 'rewrite_symbol') {
      if (!edit.readCapability) return edit
      const confirmed = confirmedCapabilityForPath(
        edit.path,
        edit.readCapability,
      )
      if (confirmed === null || confirmed === edit.readCapability) return edit
      logSubstitution()
      return { ...edit, readCapability: confirmed }
    }
    // create/structured/patch carry no read capability; delete/move are
    // authorized separately via the confirmed-anchor branch below.
    return edit
  })
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

  // Capability-bearing edits fail closed with zero I/O when the runtime has
  // no authoritative project/run scope. isCapabilityBearingEdit only needs the
  // normalized edits array, so this guard runs immediately after the
  // unsafe-path check — before previousToolCallFinished and snapshot loading.
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
    // A full-file RANGE read numbers lines in visible space and hashes the slice
    // without the trailing newline, while a whole-file paths read binds the
    // capability ceiling. Both are complete observations, so accept either and
    // re-hash exactly the slice the capability covered.
    const coordinates = getLineCoordinates(content)
    if (
      !isWholeFileCoveringRange(coordinates, decoded.startLine, decoded.endLine)
    ) {
      return {
        ok: false,
        error: `a range capability cannot authorize a whole-file overwrite for ${path} (capability covers lines ${decoded.startLine}-${decoded.endLine}; ${describeLineBounds(coordinates)}). Pass only a whole-file-covering cap.v3 from a complete paths or full-file range read.`,
      }
    }
    if (
      decoded.hash !==
      getContentHash(
        getRangeSlice(coordinates, decoded.startLine, decoded.endLine),
      )
    ) {
      return {
        ok: false,
        error: `write_file basedOnRead for ${path} did not match the current file content (stale hash). Re-read the whole file and retry with the fresh capability.`,
      }
    }
    return { ok: true }
  }

  // Memoize per (path, token): the same write_file edit can reach this helper
  // up to three times in one transaction (pre-loop, context_compacted branch,
  // and the generic basedOnRead branch). Validation is O(file size) and the
  // grant is idempotent, so caching the result avoids redundant decode+hash
  // without changing any outcome. Keyed on path+token; content is the same
  // snapshot within a transaction.
  const authorizeWholeFileFromCapabilityCache = new Map<
    string,
    { ok: true } | { ok: false; error: string }
  >()
  const authorizeWholeFileFromCapability = (
    path: string,
    content: string,
    token: string,
  ): { ok: true } | { ok: false; error: string } => {
    const cacheKey = `${path}\n${token}`
    const cached = authorizeWholeFileFromCapabilityCache.get(cacheKey)
    if (cached) return cached
    const auth = validateWriteFileBasedOnRead(path, content, token)
    if (!auth.ok) {
      authorizeWholeFileFromCapabilityCache.set(cacheKey, auth)
      return auth
    }
    freshWholeFileAuthorizationPaths.add(path)
    grantWholeFileReadAuthorization(fileProcessingState, path, content)
    clearEditRereadRequirement(fileProcessingState, path, {
      clearContextCompacted: true,
    })
    const result: { ok: true } = { ok: true }
    authorizeWholeFileFromCapabilityCache.set(cacheKey, result)
    return result
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
      // blocked until a complete whole-file read_files grant or explicit
      // whole-file basedOnRead. Unique str_replace apply also must not drop it.
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
        edit.replacements.every((replacement) =>
          Boolean(replacement.basedOnRead),
        )
      ) {
        continue
      }
      pathsNeedingAuth.add(edit.path)
    }
    for (const path of pathsNeedingAuth) {
      // pathsNeedingAuth already excluded fresh paths above, so no fresh
      // re-check is needed here.
      if (staleWholeFileAuthorizationPaths.has(path)) continue
      const content = initialContentByPath.get(path)
      if (typeof content !== 'string') continue
      // Transaction-local only: do not call grantWholeFileReadAuthorization and
      // do not add to freshWholeFileAuthorizationPaths (would authorize write_file).
      // Do not clear reread markers here — auto-reread only authorizes this
      // transaction's str_replace preflight. Failed-edit markers may drop on
      // successful unique apply; context_compacted stays until a whole-file
      // read_files grant or explicit whole-file basedOnRead.
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
              errorMessage: `Edit blocked: ${edit.path} had its exact read content removed from the active model context (context compaction). ${auth.error} Call read_files with paths: [${JSON.stringify(edit.path)}] and retry with the capability from that complete model-visible read.`,
            })
            return
          }
        }
        failures.push({
          editIndex,
          path: edit.path,
          errorMessage: `Edit blocked: ${edit.path} had its exact read content removed from the active model context (context compaction). Call read_files with paths: [${JSON.stringify(edit.path)}] before a whole-file overwrite and retry with the capability from that complete model-visible read; sticky hash match alone is not sufficient for write_file.`,
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
      // The anchor MUST be whole-file (startLine === 1): a confirmed post-edit
      // anchor is definitionally whole-file-verified, so this is a defensive
      // guard against a future partial/scoped anchor authorizing a destructive
      // whole-file operation (delete/move) it must never cover. This branch
      // intentionally does NOT consult editRereadRequirementsByPath markers: a
      // fresh whole-file anchor hash-match against the live snapshot is
      // stronger evidence than a marker, and markers are deliberately not
      // cleared here either (context_compacted must keep write_file blocked).
      if (edit.type === 'delete' || edit.type === 'move') {
        const anchor =
          fileProcessingState.confirmedPostEditAnchorsByPath?.[edit.path]
        const snapContent = initialContentByPath.get(edit.path)
        if (
          anchor &&
          anchor.startLine === 1 &&
          typeof snapContent === 'string' &&
          anchor.contentHash === getContentHash(snapContent)
        ) {
          // Clear any stale reread marker on the source key so a later move
          // does not leave a lingering marker; preserve context_compacted,
          // which must keep write_file blocked until a fresh whole-file read.
          if (
            getEditRereadRequirement(fileProcessingState, edit.path)?.reason !==
            'context_compacted'
          ) {
            clearEditRereadRequirement(fileProcessingState, edit.path)
          }
          return
        }
      }
      if (freshWholeFileAuthorizationPaths.has(edit.path)) {
        // Hash-fresh sticky authorizes this edit, but do not clear
        // context_compacted here. write_file stays blocked while the marker
        // remains unless basedOnRead already cleared it.
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
            errorMessage: `Edit blocked: ${auth.error} Call read_files with paths: [${JSON.stringify(edit.path)}] and retry with the capability from that complete model-visible read.`,
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
          ? ` Call read_files with ranges: [{ "path": ${JSON.stringify(edit.path)}, "startLine": ${edit.startLine ?? 1}, "endLine": ${edit.endLine ?? edit.startLine ?? 1} }] and retry with only its readCapability plus newContent.`
          : edit.type === 'rewrite_symbol'
            ? ` Call read_files with symbols: [{ "path": ${JSON.stringify(edit.path)}, "names": [${JSON.stringify(edit.symbol)}] }] and retry with the matching slice editAnchor.readCapability.`
            : ''
      const wholeFileRecovery = ` Call read_files with paths: [${JSON.stringify(edit.path)}] before retrying and use the capability from that complete model-visible read.`
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
          errorMessage: `Create destination already exists at ${edit.path}. Call read_files with paths: [${JSON.stringify(edit.path)}] before retrying with type "write_file" and its whole-file capability, or use "str_replace" for an in-place edit.`,
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

  // Server-side post-edit authority substitution: when an earlier confirmed
  // edit in this same run already proved the post-edit bytes of a target file,
  // replace any stale provided capability with the server's confirmed
  // post-edit anchor so the follow-up edit is not rejected with
  // stale_capability / forced re-read. The substituted edits feed ONLY
  // processEditTransaction below — the strict gate, authorization grants, and
  // all marker handling above still see the original edits, so substitution
  // can never clear a context_compacted reread requirement or grant sticky
  // authorization off a reshaped token.
  const substitutedEdits = substituteConfirmedPostEditCapabilities(
    edits,
    initialContentByPath,
    fileProcessingState,
    projectId,
    runId,
    logger,
  )
  const contentEdits = substitutedEdits.filter(
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
    // Single source of truth: processEditTransaction classifies every failure it
    // reports, so the handler keys off failureKind only. Re-deriving these flags
    // from failure prose would be a second copy of that classification (free to
    // drift), and any error text that merely quotes a marker would be
    // misclassified.
    const failureKinds = transactionResult.failures.map(
      (failure) => failure.failureKind,
    )
    const requiresFreshCapability = failureKinds.some(
      (kind) => typeof kind === 'string' && kind.startsWith('capability'),
    )
    // An anchored scope mismatch is a per-path targeting mistake: the supplied
    // capability was fresh and no file changed, only the offending path's read
    // scope is wrong. It selects the replace_range recovery strategy below.
    const isAnchorScopeMismatch = failureKinds.some(
      (kind) => kind === 'anchor_scope_mismatch',
    )
    const isMatchOrAtomicAbort = failureKinds.some(
      (kind) =>
        kind === 'no_match' ||
        kind === 'preflight_failed' ||
        kind === 'anchor_scope_mismatch',
    )
    // Only the paths that actually failed lose read authorization, for every
    // failure kind that reaches this branch. A preflight abort writes NO bytes,
    // so each non-failing target is still byte-identical to the snapshot this
    // transaction read. Retaining its authorization is not a trust widening:
    // isWholeFileReadAuthorizationFresh re-hashes the stored hash against the
    // live file and every replace_range / scoped str_replace re-hashes its
    // capability slice before applying, so a path an external actor changed
    // fails closed at its next use exactly as it does today. Narrowing only
    // removes a redundant re-read of files that provably did not change.
    // Guard failures can report an empty path (editIndex: -1), and one reported
    // failure may cover several coalesced same-path edits, so dedupe and drop
    // empty paths rather than counting failures.
    const failingPaths = Array.from(
      new Set(
        transactionResult.failures
          .map((failure) => failure.path)
          .filter((path) => Boolean(path)),
      ),
    )
    const failingPathSet = new Set(failingPaths)
    // Narrow only when the failing set is a proper subset of the targets: an
    // empty set (guard failure) or a set covering every target (single-path
    // transaction) must fall back to uniquePaths so recovery.paths is never
    // empty and never silently misdescribes the blast radius.
    const narrowInvalidationToFailingPaths =
      failingPaths.length > 0 &&
      uniquePaths.some((path) => !failingPathSet.has(path))
    const invalidationPaths = narrowInvalidationToFailingPaths
      ? failingPaths
      : uniquePaths
    // Match / atomic-batch aborts and capability failures both require one new
    // snapshot for every transaction target so multi-file retries cannot reuse
    // other paths from memory. Pure syntax failures never reach this branch.
    const requiresFreshRead =
      requiresFreshCapability ||
      isMatchOrAtomicAbort ||
      transactionResult.requiresFreshRead === true
    const recovery =
      transactionResult.recovery ??
      (requiresFreshRead
        ? {
            action: 'rebuild_whole_transaction' as const,
            requiresFreshRead: true,
            paths: uniquePaths,
            failedEditIndex: transactionResult.failures[0]?.editIndex,
            tool: 'read_files' as const,
            input: { paths: uniquePaths },
            ...(isMatchOrAtomicAbort && !requiresFreshCapability
              ? {
                  // An anchored scope mismatch needs a capability that actually
                  // covers the target lines, so replace_range beats a shorter
                  // oldString. Same rule as buildTransactionRecovery, keyed off
                  // the shared failureKind rather than a second prose regex.
                  preferredStrategy: isAnchorScopeMismatch
                    ? ('replace_range' as const)
                    : ('smaller_oldString' as const),
                }
              : {}),
          }
        : undefined)
    // processEditTransaction builds its own recovery via buildTransactionRecovery
    // (which always carries every transaction path), and the handler prefers it
    // when present. Narrowing the FINAL emitted object is what makes the rule
    // hold regardless of which branch produced the recovery.
    const scopedRecovery =
      recovery && narrowInvalidationToFailingPaths
        ? {
            ...recovery,
            paths: failingPaths,
            input: { paths: failingPaths },
          }
        : recovery
    const errorCode =
      transactionResult.errorCode ??
      (requiresFreshCapability
        ? ('stale_capability' as const)
        : isMatchOrAtomicAbort
          ? ('no_match' as const)
          : requiresFreshRead
            ? ('preflight_failed' as const)
            : undefined)
    invalidatePreparedEditPaths({
      fileProcessingState,
      paths: invalidationPaths,
      revokeReadAuthorization: requiresFreshRead,
      requiresFreshRead,
      ...(requiresFreshRead
        ? {
            reason: requiresFreshCapability
              ? ('stale_capability' as const)
              : ('preflight_failed' as const),
            sourceTool: 'edit_transaction',
          }
        : {}),
    })

    // Model-facing recovery instructions: name the exact next call, and be
    // explicit that the retained targets must NOT be re-read while the whole
    // transaction still has to be resent (nothing was applied).
    const multiTargetRecoveryProse = narrowInvalidationToFailingPaths
      ? [
          `Only ${failingPaths.join(', ')} lost read authorization and needs a fresh read; every other transaction target retains valid read state and does NOT need re-reading (this supersedes the generic re-read-every-target note above). Re-read ${failingPaths.join(', ')} only — for an anchored-scope or capability failure, a range that contains the target lines for that path is enough — then resend the whole transaction because no files were changed.`,
        ]
      : requiresFreshRead
        ? [
            `Atomic recovery requires fresh read state for every transaction target in this run: ${uniquePaths.join(', ')}. Re-read all targets and rebuild the complete transaction from one coherent snapshot; do not refresh only the first failed path or replay any other stale token/oldString from memory.`,
          ]
        : []

    return {
      output: [
        {
          type: 'json',
          value: {
            errorMessage: [transactionResult.error, ...multiTargetRecoveryProse]
              .filter(Boolean)
              .join('\n'),
            failures: transactionResult.failures,
            ...(requiresFreshRead && { requiresFreshRead: true }),
            ...(errorCode && { errorCode }),
            ...(scopedRecovery && { recovery: scopedRecovery }),
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
      const truncated = looksLikeTruncatedEditContent(
        edits[editIndex] ??
          ({ type: 'delete', path: file.path } as TransactionEdit),
        syntaxValidation.message,
        file.content,
      )
      return {
        output: [
          {
            type: 'json',
            value: {
              errorMessage: formatPreflightErrorMessage(
                'edit_transaction',
                file.path,
                truncated
                  ? `${syntaxValidation.message} — the edit payload appears cut in transport (unbalanced delimiters). Re-send the edit; keep each edit's newString/content well under the transport-safe band.`
                  : syntaxValidation.message,
              ),
              failures: [
                {
                  editIndex,
                  path: file.path,
                  errorMessage: syntaxValidation.message,
                  failureKind: truncated
                    ? PAYLOAD_TRUNCATED_ERROR_CODE
                    : 'preflight_failed',
                },
              ],
              errorCode: truncated
                ? PAYLOAD_TRUNCATED_ERROR_CODE
                : 'preflight_failed',
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
      const truncated = looksLikeTruncatedEditContent(
        edit,
        syntaxValidation.message,
        edit.content,
      )
      return {
        output: [
          {
            type: 'json',
            value: {
              errorMessage: formatPreflightErrorMessage(
                'edit_transaction',
                edit.path,
                truncated
                  ? `${syntaxValidation.message} — the edit payload appears cut in transport (unbalanced delimiters). Re-send the edit; keep each edit's newString/content well under the transport-safe band.`
                  : syntaxValidation.message,
              ),
              failures: [
                {
                  editIndex: edits.indexOf(edit),
                  path: edit.path,
                  errorMessage: syntaxValidation.message,
                  failureKind: truncated
                    ? PAYLOAD_TRUNCATED_ERROR_CODE
                    : 'preflight_failed',
                },
              ],
              errorCode: truncated
                ? PAYLOAD_TRUNCATED_ERROR_CODE
                : 'preflight_failed',
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

  // Idempotent-cleanup contract: when every content edit resolved to an
  // already-applied skipIfMissing deletion there is nothing for the client to
  // apply. Report the preflight success and its skip messages instead of
  // sending an empty change list, and leave read authorization state untouched
  // because no file changed.
  if (clientChanges.length === 0) {
    return {
      output: [
        {
          type: 'json',
          value: {
            message: transactionResult.message,
            files: transactionResult.files.map((file) => ({
              path: file.path,
              patch: file.patch,
              messages: file.messages,
            })),
          },
        },
      ],
    }
  }

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
      // Unique (non-allowMultiple) str_replace apply may drop failed-edit
      // markers, but the helper preserves context_compacted. Only a complete
      // whole-file read_files grant or explicit whole-file basedOnRead may
      // clear that reason (write_file basedOnRead already did so pre-apply).
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
