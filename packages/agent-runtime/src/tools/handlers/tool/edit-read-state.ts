import type { FileProcessingState } from './write-file'
import type {
  EditRereadReason,
  EditRereadRequirement,
} from '@codebuff/common/types/session-state'

export function markEditRequiresFreshRead(params: {
  fileProcessingState: FileProcessingState
  path: string
  reason: EditRereadReason
  sourceTool?: string
  revokeReadAuthorization?: boolean
}): void {
  const {
    fileProcessingState,
    path,
    reason,
    sourceTool,
    revokeReadAuthorization = true,
  } = params
  fileProcessingState.failedEditRequiresReadByPath[path] = true
  fileProcessingState.editRereadRequirementsByPath ??= {}
  // Do not downgrade context_compacted to weaker preflight/no_match-class reasons:
  // write_file stays blocked with the compaction marker until a fresh whole-file read.
  // When retaining context_compacted, also keep the original sourceTool so error copy
  // attributes compaction (not a later weaker caller like str_replace).
  const existing = fileProcessingState.editRereadRequirementsByPath[path]
  const retainContextCompacted = existing?.reason === 'context_compacted'
  const effectiveReason = retainContextCompacted ? 'context_compacted' : reason
  const effectiveSourceTool = retainContextCompacted
    ? existing.sourceTool
    : sourceTool
  fileProcessingState.editRereadRequirementsByPath[path] = {
    reason: effectiveReason,
    ...(effectiveSourceTool ? { sourceTool: effectiveSourceTool } : {}),
  }
  if (revokeReadAuthorization) {
    delete fileProcessingState.readAuthorizationsByPath?.[path]
    delete fileProcessingState.readAuthorizationHashesByPath?.[path]
    delete fileProcessingState.modelVisibleReadAuthorizationHashesByPath?.[path]
    delete fileProcessingState.confirmedPostEditAnchorsByPath?.[path]
  }
}

export function clearEditRereadRequirement(
  fileProcessingState: FileProcessingState,
  path: string,
  options?: { clearContextCompacted?: boolean },
): void {
  const existing = fileProcessingState.editRereadRequirementsByPath?.[path]
  delete fileProcessingState.failedEditRequiresReadByPath[path]
  if (existing?.reason === 'context_compacted' && !options?.clearContextCompacted) {
    return
  }
  delete fileProcessingState.editRereadRequirementsByPath?.[path]
}

export function getEditRereadRequirement(
  fileProcessingState: FileProcessingState,
  path: string,
): EditRereadRequirement | undefined {
  return fileProcessingState.editRereadRequirementsByPath?.[path]
}

export function strictEditAuthorizationError(params: {
  fileProcessingState: FileProcessingState
  path: string
  toolName: string
  hasFreshWholeFileAuthorization: boolean
  hasScopedCapability?: boolean
  allowScopedCapability?: boolean
  authorizationWasStale?: boolean
  wholeFileRequired?: boolean
  /** Optional whole-file capability token to echo for recovery without a re-read round-trip. */
  freshReadCapability?: string
}):
  | {
      errorMessage: string
      errorCode: 'fresh_read_required'
      recovery: {
        /**
         * Fallback tool when no capability can be echoed. Automated consumers
         * must honor `preferredStrategy` first: when it is `'basedOnRead'`,
         * retry the edit with `basedOnRead` and do not call `tool` first.
         */
        tool: 'read_files'
        input: { paths: string[] }
        basedOnRead?: string
        /**
         * Primary recovery signal. `'basedOnRead'` means retry the blocked edit
         * with `recovery.basedOnRead` (skip exploratory re-read). `'read_files'`
         * means call `tool` with `input` because no capability is available.
         */
        preferredStrategy: 'basedOnRead' | 'read_files'
      }
    }
  | undefined {
  const {
    fileProcessingState,
    path,
    toolName,
    hasFreshWholeFileAuthorization,
    hasScopedCapability = false,
    allowScopedCapability = true,
    authorizationWasStale = false,
    wholeFileRequired = false,
    freshReadCapability,
  } = params
  const prior = getEditRereadRequirement(fileProcessingState, path)
  const recoveringFromFailedEdit = Boolean(
    fileProcessingState.failedEditRequiresReadByPath[path],
  )
  if (
    !fileProcessingState.strictReadBeforeEdit &&
    !prior &&
    !recoveringFromFailedEdit
  ) {
    return undefined
  }
  // Fresh hash match authorizes even when a prior context_compacted (or other)
  // reread requirement is still recorded — callers clear it after a successful
  // hash-fresh check.
  if (hasFreshWholeFileAuthorization) return undefined
  if (allowScopedCapability && hasScopedCapability) return undefined

  const firstLine = prior
    ? prior.reason === 'stale_snapshot'
      ? `${toolName} blocked for ${path}: a previous ${prior.sourceTool ?? 'edit'} found that the file changed after its last whole-file read and requires a fresh read before retrying.`
      : `${toolName} blocked for ${path}: a previous ${prior.sourceTool ?? 'edit'} ${formatReason(prior.reason)} and requires a fresh read before retrying.`
    : recoveringFromFailedEdit
      ? toolName === 'str_replace'
        ? `${toolName} blocked for ${path}: a previous str_replace failed for this file and requires a fresh read before retrying.`
        : `${toolName} blocked for ${path}: a previous edit failed and requires a fresh read before retrying.`
      : authorizationWasStale
        ? `${toolName} blocked for ${path}: the file changed after its last whole-file read, so the stored authorization was revoked.`
        : fileProcessingState.confirmedPostEditAnchorsByPath?.[path]
          ? `${toolName} blocked for ${path}: this file was created or edited earlier in this session. Retry the edit with basedOnRead set to the readCapability from that create/edit result (its confirmed post-edit anchor), instead of re-reading the file.`
          : `${toolName} blocked for ${path}: strict read-before-edit is enabled and no fresh read authorization exists.`
  const scopeNote = wholeFileRequired
    ? ' A prior range-anchored edit or scoped range capability cannot authorize a whole-file overwrite.'
    : ' A scoped edit may instead provide the fresh capability/hash returned by read_files.'
  // A post-edit cap minted under context_compacted must not be echoed as
  // basedOnRead: that would let write_file clear compaction without a real
  // whole-file read. Only a complete read_files grant (or an explicit
  // basedOnRead the caller already holds from that grant) may clear it.
  const echoPostEditCapability = prior?.reason !== 'context_compacted'
  const effectiveFreshReadCapability = echoPostEditCapability
    ? (freshReadCapability ??
      fileProcessingState.confirmedPostEditAnchorsByPath?.[path]?.readCapability)
    : undefined
  // Prefer capability-retry when a whole-file token is already available; keep
  // read_files only as the secondary path when no capability can be echoed.
  // recovery.preferredStrategy is the machine-readable primary signal so
  // automated consumers do not always re-read first when basedOnRead is set.
  const nextLine = effectiveFreshReadCapability
    ? `Next: retry with basedOnRead set to the capability below on the next edit (write_file basedOnRead, or basedOnRead on every str_replace replacement). Do not exploratory re-read first when basedOnRead is provided.\nbasedOnRead="${effectiveFreshReadCapability}"`
    : `Next: call read_files with paths: [${JSON.stringify(path)}].`
  return {
    errorMessage: `${firstLine}\n${nextLine}${scopeNote}`,
    errorCode: 'fresh_read_required',
    recovery: effectiveFreshReadCapability
      ? {
          // tool/input remain the documented fallback only; preferredStrategy +
          // basedOnRead are the primary signals for capability-first recovery.
          tool: 'read_files' as const,
          input: { paths: [path] },
          basedOnRead: effectiveFreshReadCapability,
          preferredStrategy: 'basedOnRead' as const,
        }
      : {
          tool: 'read_files' as const,
          input: { paths: [path] },
          preferredStrategy: 'read_files' as const,
        },
  }
}

function formatReason(reason: EditRereadReason): string {
  switch (reason) {
    case 'preflight_failed':
      return 'preflight failed'
    case 'stale_snapshot':
      return 'detected a stale file snapshot'
    case 'stale_capability':
      return 'used a stale read capability'
    case 'application_rejected':
      return 'application was rejected'
    case 'application_unconfirmed':
      return 'application could not be confirmed'
    case 'application_threw':
      return 'application threw'
    case 'context_compacted':
      return 'removed the exact read content from the active model context'
  }
}
