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
  fileProcessingState.editRereadRequirementsByPath[path] = {
    reason,
    ...(sourceTool ? { sourceTool } : {}),
  }
  if (revokeReadAuthorization) {
    delete fileProcessingState.readAuthorizationsByPath?.[path]
    delete fileProcessingState.readAuthorizationHashesByPath?.[path]
    delete fileProcessingState.modelVisibleReadAuthorizationHashesByPath?.[path]
  }
}

export function clearEditRereadRequirement(
  fileProcessingState: FileProcessingState,
  path: string,
): void {
  delete fileProcessingState.failedEditRequiresReadByPath[path]
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
        tool: 'read_files'
        input: { paths: string[] }
        basedOnRead?: string
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
  // Fall back to the confirmed post-edit anchor's capability (from a create
  // or edit earlier this session) only when the caller did not supply one.
  const effectiveFreshReadCapability =
    freshReadCapability ??
    fileProcessingState.confirmedPostEditAnchorsByPath?.[path]?.readCapability
  // Prefer capability-retry when a whole-file token is already available; keep
  // read_files only as the secondary path when no capability can be echoed.
  const nextLine = effectiveFreshReadCapability
    ? `Next: retry with basedOnRead set to the capability below on the next edit (write_file basedOnRead, or basedOnRead on every str_replace replacement). Do not exploratory re-read first when basedOnRead is provided.\nbasedOnRead="${effectiveFreshReadCapability}"`
    : `Next: call read_files with paths: [${JSON.stringify(path)}].`
  return {
    errorMessage: `${firstLine}\n${nextLine}${scopeNote}`,
    errorCode: 'fresh_read_required',
    recovery: {
      tool: 'read_files',
      input: { paths: [path] },
      ...(effectiveFreshReadCapability
        ? { basedOnRead: effectiveFreshReadCapability }
        : {}),
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
