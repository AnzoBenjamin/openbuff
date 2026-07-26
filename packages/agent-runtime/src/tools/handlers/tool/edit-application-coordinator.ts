import {
  fileMutationResultV1Schema,
  getConfirmedAppliedActionsV1,
} from '@codebuff/common/tools/results/filesystem'
import {
  decodeReadCapabilityToken,
  getContentHash,
  getExactContentHash,
  normalizeLineEndings,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'

import {
  clearEditRereadRequirement,
  markEditRequiresFreshRead,
} from './edit-read-state'

import type { FileProcessingState } from './write-file'
import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { ToolName } from '@codebuff/common/tools/constants'

type ConfirmedPostEditAnchor = {
  startLine: number
  endLine: number
  contentHash: string
  readCapability: string
}

type CoordinatedApplication<T extends ToolName> =
  | {
      status: 'applied'
      output: CodebuffToolOutput<T>
      confirmedAnchorsByPath: ReadonlyMap<string, ConfirmedPostEditAnchor>
    }
  | { status: 'rejected'; output: CodebuffToolOutput<T> }
  | { status: 'threw'; error: unknown }

function hasExplicitError(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || value === undefined) return false
  if (Array.isArray(value)) {
    return value.some((item) => hasExplicitError(item, depth + 1))
  }
  if (typeof value !== 'object') return false

  const record = value as Record<string, unknown>
  if (
    record.errorMessage !== undefined ||
    (record.error !== undefined && record.error !== null) ||
    record.success === false ||
    record.applied === false ||
    record.status === 'failed' ||
    record.status === 'error' ||
    record.status === 'blocked'
  ) {
    return true
  }
  return Object.values(record).some((nested) =>
    hasExplicitError(nested, depth + 1),
  )
}

function getPositiveApplicationEvidence(
  value: unknown,
  paths: ReadonlySet<string>,
  projectId: string,
  runId: string,
  wholeFileContentByPath?: ReadonlyMap<string, string>,
  depth = 0,
): ReadonlyMap<string, ConfirmedPostEditAnchor> | null {
  if (depth > 6 || value === null || value === undefined) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const evidence = getPositiveApplicationEvidence(
        item,
        paths,
        projectId,
        runId,
        wholeFileContentByPath,
        depth + 1,
      )
      if (evidence) return evidence
    }
    return null
  }
  const parsed = fileMutationResultV1Schema.safeParse(value)
  if (parsed.success) {
    if (
      parsed.data.outcome !== 'applied' ||
      parsed.data.authorityReceipt?.status !== 'committed'
    ) {
      return null
    }
    const confirmedActions = getConfirmedAppliedActionsV1(parsed.data)
    const confirmedPaths = new Set<string>()
    const confirmedAnchorsByPath = new Map<string, ConfirmedPostEditAnchor>()
    for (const action of confirmedActions) {
      confirmedPaths.add(action.path)
      if (action.action === 'move' && action.destinationPath) {
        confirmedPaths.add(action.destinationPath)
      }
      const targetPath = action.destinationPath ?? action.path
      const actionRecord = action as unknown as Record<string, unknown>
      const anchor = actionRecord.editAnchor
      if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) continue
      const record = anchor as Record<string, unknown>
      const content = wholeFileContentByPath?.get(targetPath)
      const readCapability = record.readCapability
      const decoded =
        typeof readCapability === 'string'
          ? decodeReadCapabilityToken(readCapability)
          : null
      if (
        typeof content === 'string' &&
        typeof readCapability === 'string' &&
        record.startLine === 1 &&
        record.endLine === normalizeLineEndings(content).split('\n').length &&
        record.contentHash === getContentHash(content) &&
        decoded !== null &&
        typeof decoded !== 'string' &&
        readCapabilityMatchesScope(decoded, { projectId, path: targetPath, runId }) &&
        decoded.startLine === record.startLine &&
        decoded.endLine === record.endLine &&
        decoded.hash === record.contentHash
      ) {
        confirmedAnchorsByPath.set(targetPath, {
          startLine: 1,
          endLine: record.endLine,
          contentHash: record.contentHash,
          readCapability,
        })
      }
    }
    if (![...paths].every((path) => confirmedPaths.has(path))) return null
    for (const [path, content] of wholeFileContentByPath ?? []) {
      const matchingAction = confirmedActions.find(
        (action) => (action.destinationPath ?? action.path) === path,
      )
      if (
        !matchingAction ||
        matchingAction.afterHash !== getExactContentHash(content)
      ) {
        return null
      }
    }
    return confirmedAnchorsByPath
  }
  if (typeof value !== 'object') return null
  for (const nested of Object.values(value as Record<string, unknown>)) {
    const evidence = getPositiveApplicationEvidence(
      nested,
      paths,
      projectId,
      runId,
      wholeFileContentByPath,
      depth + 1,
    )
    if (evidence) return evidence
  }
  return null
}

function unconfirmedApplicationOutput<T extends ToolName>(
  paths: string[],
  clientOutput?: CodebuffToolOutput<T>,
): CodebuffToolOutput<T> {
  return [
    ...(clientOutput ?? []),
    {
      type: 'json',
      value: {
        ...(paths.length === 1 ? { file: paths[0] } : {}),
        errorMessage:
          'The client returned no positive edit application evidence, so the harness could not confirm that any filesystem change occurred. Re-read affected files before retrying.',
        ...(paths.length > 1
          ? {
              failures: paths.map((path) => ({
                editIndex: -1,
                path,
                errorMessage: 'Client application was not confirmed.',
              })),
            }
          : {}),
      },
    },
  ] as CodebuffToolOutput<T>
}

export function editOutputHasError<T extends ToolName>(
  output: CodebuffToolOutput<T>,
): boolean {
  return hasExplicitError(output)
}

function outputIndicatesStaleSnapshot(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || value === undefined) return false
  if (Array.isArray(value)) {
    return value.some((item) => outputIndicatesStaleSnapshot(item, depth + 1))
  }
  if (typeof value === 'string') {
    return /(?:stale\s+(?:snapshot|hash|range)|content\s+(?:changed|mismatch)|expected\s+hash)/i.test(
      value,
    )
  }
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).some((nested) =>
    outputIndicatesStaleSnapshot(nested, depth + 1),
  )
}

function outputIndicatesUnconfirmedApplication(
  value: unknown,
  depth = 0,
): boolean {
  if (depth > 6 || value === null || value === undefined) return false
  if (Array.isArray(value)) {
    return value.some((item) =>
      outputIndicatesUnconfirmedApplication(item, depth + 1),
    )
  }
  if (typeof value === 'string') {
    return /could not confirm/i.test(value)
  }
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).some((nested) =>
    outputIndicatesUnconfirmedApplication(nested, depth + 1),
  )
}

export function invalidatePreparedEditPaths(params: {
  fileProcessingState: FileProcessingState
  paths: Iterable<string>
  revokeReadAuthorization?: boolean
  requiresFreshRead?: boolean
  reason?: Parameters<typeof markEditRequiresFreshRead>[0]['reason']
  sourceTool?: string
}): void {
  const {
    fileProcessingState,
    paths,
    revokeReadAuthorization = true,
    requiresFreshRead = true,
    reason = 'application_rejected',
    sourceTool,
  } = params
  for (const path of new Set(paths)) {
    if (!path) continue
    delete fileProcessingState.promisesByPath[path]
    if (requiresFreshRead) {
      markEditRequiresFreshRead({
        fileProcessingState,
        path,
        reason,
        sourceTool,
        revokeReadAuthorization,
      })
    }
  }
}

export function commitAppliedEditPaths(params: {
  fileProcessingState: FileProcessingState
  paths: Iterable<string>
  wholeFileContentByPath?: ReadonlyMap<string, string>
  confirmedAnchorsByPath?: ReadonlyMap<string, ConfirmedPostEditAnchor>
}): void {
  const {
    fileProcessingState,
    paths,
    wholeFileContentByPath,
    confirmedAnchorsByPath,
  } = params
  for (const path of new Set(paths)) {
    if (!path) continue
    clearEditRereadRequirement(fileProcessingState, path)
    const wholeFileContent = wholeFileContentByPath?.get(path)
    const confirmedAnchor = confirmedAnchorsByPath?.get(path)
    if (
      typeof wholeFileContent === 'string' &&
      confirmedAnchor &&
      fileProcessingState.strictReadBeforeEdit
    ) {
      fileProcessingState.readAuthorizationsByPath ??= {}
      fileProcessingState.readAuthorizationHashesByPath ??= {}
      fileProcessingState.confirmedPostEditAnchorsByPath ??= {}
      fileProcessingState.readAuthorizationsByPath[path] = true
      fileProcessingState.readAuthorizationHashesByPath[path] =
        confirmedAnchor.contentHash
      fileProcessingState.confirmedPostEditAnchorsByPath[path] = confirmedAnchor
    }
  }
}

export async function coordinateEditApplication<T extends ToolName>(params: {
  toolName: T
  fileProcessingState: FileProcessingState
  paths: Iterable<string>
  projectId: string
  runId: string
  apply: () => Promise<CodebuffToolOutput<T>>
  wholeFileContentByPath?: ReadonlyMap<string, string>
  onApplied?: () => void
  rejectionRequiresRead?: boolean
  confirmationPaths?: Iterable<string>
}): Promise<CoordinatedApplication<T>> {
  const paths = [...new Set(params.paths)]
  const confirmationPaths =
    params.confirmationPaths === undefined
      ? new Set(paths)
      : new Set(params.confirmationPaths)
  let output: CodebuffToolOutput<T>
  try {
    output = await params.apply()
  } catch (error) {
    invalidatePreparedEditPaths({
      fileProcessingState: params.fileProcessingState,
      paths,
      reason: 'application_threw',
      sourceTool: params.toolName,
    })
    return { status: 'threw', error }
  }

  if (output.length === 0) {
    invalidatePreparedEditPaths({
      fileProcessingState: params.fileProcessingState,
      paths,
      reason: 'application_unconfirmed',
      sourceTool: params.toolName,
    })
    return {
      status: 'rejected',
      output: unconfirmedApplicationOutput<T>(paths),
    }
  }

  if (editOutputHasError(output)) {
    if (outputIndicatesStaleSnapshot(output)) {
      invalidatePreparedEditPaths({
        fileProcessingState: params.fileProcessingState,
        paths,
        reason: 'stale_snapshot',
        sourceTool: params.toolName,
      })
    } else if (outputIndicatesUnconfirmedApplication(output)) {
      // An unconfirmed-application wrapper (e.g. an empty client result wrapped
      // into a 'could not confirm' error) may reflect a partial write, so it
      // always requires a re-read regardless of `rejectionRequiresRead`.
      invalidatePreparedEditPaths({
        fileProcessingState: params.fileProcessingState,
        paths,
        reason: 'application_unconfirmed',
        sourceTool: params.toolName,
      })
    } else {
      // An explicit client rejection confirms that no prepared mutation was
      // applied. Drop speculative prepared state, but preserve valid read
      // authorization; unlike unconfirmed output or a throw, this outcome is
      // deterministic and does not require a re-read.
      invalidatePreparedEditPaths({
        fileProcessingState: params.fileProcessingState,
        paths,
        revokeReadAuthorization: params.rejectionRequiresRead ?? true,
        requiresFreshRead: params.rejectionRequiresRead ?? true,
      })
    }
    return { status: 'rejected', output }
  }

  const confirmedAnchorsByPath = getPositiveApplicationEvidence(
    output,
    confirmationPaths,
    params.projectId,
    params.runId,
    params.wholeFileContentByPath,
  )
  if (!confirmedAnchorsByPath) {
    invalidatePreparedEditPaths({
      fileProcessingState: params.fileProcessingState,
      paths,
      reason: 'application_unconfirmed',
      sourceTool: params.toolName,
    })
    return {
      status: 'rejected',
      output: unconfirmedApplicationOutput<T>(paths, output),
    }
  }

  commitAppliedEditPaths({
    fileProcessingState: params.fileProcessingState,
    paths,
    wholeFileContentByPath: params.wholeFileContentByPath,
    confirmedAnchorsByPath,
  })
  params.onApplied?.()
  return { status: 'applied', output, confirmedAnchorsByPath }
}
