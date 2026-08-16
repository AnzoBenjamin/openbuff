import {
  fileMutationResultV1Schema,
  getConfirmedAppliedActionsV1,
} from '@codebuff/common/tools/results/filesystem'
import {
  decodeReadCapabilityToken,
  encodeReadCapabilityToken,
  getContentHash,
  getExactContentHash,
  hasAuthoritativeReadCapabilityScope,
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
import type { ConfirmedPostEditAnchor } from '@codebuff/common/types/session-state'

type CoordinatedApplication<T extends ToolName> =
  | {
      status: 'applied'
      output: CodebuffToolOutput<T>
      confirmedAnchorsByPath: ReadonlyMap<string, ConfirmedPostEditAnchor>
    }
  | { status: 'rejected'; output: CodebuffToolOutput<T> }
  | { status: 'threw'; error: unknown }

const MAX_TOOL_OUTPUT_WALK_DEPTH = 6

/**
 * Iterative walk of untrusted tool-output trees. Recursion is avoided so
 * adversarial nesting cannot overflow the stack. The depth bound keeps
 * cyclic or huge objects from running forever; nodes past the bound are
 * ignored, matching the previous recursive helpers.
 */
function walkToolOutput(
  root: unknown,
  visit: (value: unknown, depth: number) => 'descend' | 'skip' | 'stop',
  children?: (value: unknown) => unknown[] | undefined,
): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) return false
    const { value, depth } = frame
    if (
      depth > MAX_TOOL_OUTPUT_WALK_DEPTH ||
      value === null ||
      value === undefined
    ) {
      continue
    }
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({ value: value[i], depth: depth + 1 })
      }
      continue
    }
    const decision = visit(value, depth)
    if (decision === 'stop') return true
    if (decision === 'skip' || typeof value !== 'object') continue
    const nested =
      children?.(value) ?? Object.values(value as Record<string, unknown>)
    for (let i = nested.length - 1; i >= 0; i--) {
      stack.push({ value: nested[i], depth: depth + 1 })
    }
  }
  return false
}

function hasExplicitError(value: unknown): boolean {
  return walkToolOutput(value, (node) => {
    if (typeof node !== 'object') return 'skip'
    const record = node as Record<string, unknown>
    if (
      // Only a non-empty errorMessage string signals an error; null/'' are
      // benign diagnostic placeholders (symmetric with error: null).
      (typeof record.errorMessage === 'string' &&
        record.errorMessage.length > 0) ||
      (record.error !== undefined && record.error !== null) ||
      record.success === false ||
      record.applied === false ||
      record.status === 'failed' ||
      record.status === 'error' ||
      record.status === 'blocked'
    ) {
      return 'stop'
    }
    return 'descend'
  })
}

type FileMutationResultV1 = Parameters<typeof getConfirmedAppliedActionsV1>[0]

type ConfirmedAppliedActionV1 = ReturnType<
  typeof getConfirmedAppliedActionsV1
>[number]

function collectEnvelopes(
  value: unknown,
  out: FileMutationResultV1[],
): void {
  walkToolOutput(value, (node) => {
    if (typeof node !== 'object') return 'skip'
    const parsed = fileMutationResultV1Schema.safeParse(node)
    if (parsed.success) {
      // Envelope nodes are atomic: never walk a parsed envelope's internals.
      // A non-applied or non-committed envelope simply contributes nothing
      // (explicit rejections are handled by hasExplicitError earlier).
      if (
        parsed.data.outcome === 'applied' &&
        parsed.data.authorityReceipt?.status === 'committed'
      ) {
        out.push(parsed.data)
      }
      return 'skip'
    }
    return 'descend'
  })
}

function getPositiveApplicationEvidence(
  value: unknown,
  paths: ReadonlySet<string>,
  projectId: string,
  runId: string,
  wholeFileContentByPath?: ReadonlyMap<string, string>,
): ReadonlyMap<string, ConfirmedPostEditAnchor> | null {
  const envelopes: FileMutationResultV1[] = []
  collectEnvelopes(value, envelopes)
  if (envelopes.length === 0) return null

  const confirmedPaths = new Set<string>()
  const confirmedActions: ConfirmedAppliedActionV1[] = []
  const mergedAnchors = new Map<string, ConfirmedPostEditAnchor>()
  for (const envelope of envelopes) {
    for (const action of getConfirmedAppliedActionsV1(envelope)) {
      confirmedActions.push(action)
      confirmedPaths.add(action.path)
      if (action.destinationPath) {
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
        const candidate: ConfirmedPostEditAnchor = {
          startLine: 1,
          endLine: record.endLine,
          contentHash: record.contentHash,
          readCapability,
          projectId,
          runId,
        }
        const existing = mergedAnchors.get(targetPath)
        if (!existing) {
          mergedAnchors.set(targetPath, candidate)
        } else if (
          // Fail closed on conflicting anchors for the same target across
          // envelopes: never pick a winner.
          existing.startLine !== candidate.startLine ||
          existing.endLine !== candidate.endLine ||
          existing.contentHash !== candidate.contentHash ||
          existing.readCapability !== candidate.readCapability
        ) {
          return null
        }
      }
    }
  }
  for (const path of paths) {
    if (!confirmedPaths.has(path)) return null
  }
  for (const [path, content] of wholeFileContentByPath ?? []) {
    // Snapshots outside confirmationPaths are excluded no-ops: they may be
    // present for sticky/anchor minting but must not demand a covering
    // applied action. Requiring one would return null and undo confirmed
    // paths that already have evidence.
    if (!paths.has(path)) continue
    const expected = getExactContentHash(content)
    const covering = confirmedActions.filter(
      (action) => (action.destinationPath ?? action.path) === path,
    )
    // Fail closed across the union: at least one action must cover the path
    // and every covering action must agree on the exact afterHash.
    if (covering.length === 0) return null
    for (const action of covering) {
      if (action.afterHash !== expected) return null
    }
  }
  return mergedAnchors
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

function isStructuredStaleCode(value: unknown): boolean {
  return value === 'stale_snapshot' || value === 'stale_state'
}

function collectStaleSnapshotPaths(value: unknown): {
  paths: Set<string>
  sawStructuredStale: boolean
} {
  const out = {
    paths: new Set<string>(),
    sawStructuredStale: false,
  }
  walkToolOutput(
    value,
    (node) => {
      if (typeof node !== 'object') return 'skip'
      const record = node as Record<string, unknown>
      const nestedError =
        record.error !== null &&
        typeof record.error === 'object' &&
        !Array.isArray(record.error)
          ? (record.error as Record<string, unknown>)
          : null
      // Classify on this record when it carries a structured stale code, or when
      // it owns `error: { code: 'stale_state' | 'stale_snapshot' }`, so a named
      // action is never treated as nameless just because the nested error object
      // has no path/file of its own.
      if (
        isStructuredStaleCode(record.errorCode) ||
        isStructuredStaleCode(record.code) ||
        (nestedError !== null && isStructuredStaleCode(nestedError.code))
      ) {
        out.sawStructuredStale = true
        if (typeof record.path === 'string' && record.path) {
          out.paths.add(record.path)
        } else if (typeof record.file === 'string' && record.file) {
          out.paths.add(record.file)
        }
      }
      return 'descend'
    },
    (node) => {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) {
        return undefined
      }
      const record = node as Record<string, unknown>
      const next: unknown[] = []
      // failures[] items stay at the same depth as sibling fields (not one
      // level deeper via the array node) so a shallow failures wrapper cannot
      // push a structured hit past the walk bound.
      if (Array.isArray(record.failures)) {
        next.push(...record.failures)
      }
      for (const [key, nested] of Object.entries(record)) {
        if (key === 'failures') continue
        next.push(nested)
      }
      return next
    },
  )
  return out
}

function outputIndicatesUnconfirmedApplication(value: unknown): boolean {
  return walkToolOutput(value, (node) => {
    if (typeof node === 'string' && /could not confirm/i.test(node)) {
      return 'stop'
    }
    return typeof node === 'object' ? 'descend' : 'skip'
  })
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

function synthesizePostEditAnchor(params: {
  projectId?: string
  runId?: string
  path: string
  content: string
}): ConfirmedPostEditAnchor | null {
  const { projectId, runId, path, content } = params
  if (!projectId || !runId) return null
  const scope = { projectId, path, runId }
  if (!hasAuthoritativeReadCapabilityScope(scope)) return null
  const contentHash = getContentHash(content)
  const endLine = normalizeLineEndings(content).split('\n').length
  return {
    startLine: 1,
    endLine,
    contentHash,
    readCapability: encodeReadCapabilityToken({
      startLine: 1,
      endLine,
      hash: contentHash,
      scope,
    }),
    projectId,
    runId,
  }
}

export function commitAppliedEditPaths(params: {
  fileProcessingState: FileProcessingState
  paths: Iterable<string>
  wholeFileContentByPath?: ReadonlyMap<string, string>
  confirmedAnchorsByPath?: ReadonlyMap<string, ConfirmedPostEditAnchor>
  projectId?: string
  runId?: string
  /**
   * Paths whose reread requirement (e.g. context_compacted) must NOT be
   * cleared by this commit. A confirmed apply normally clears the marker, but
   * a blind allowMultiple str_replace (replace-all) is not evidence the model
   * knows the file content, so the caller preserves the marker for those
   * paths to keep a later write_file blocked. Independently of this set, a
   * path whose reread reason is context_compacted is always treated as
   * preserved: a confirmed apply never clears compaction state.
   */
  preserveRereadRequirementsForPaths?: ReadonlySet<string>
}): ReadonlyMap<string, ConfirmedPostEditAnchor> {
  const {
    fileProcessingState,
    paths,
    wholeFileContentByPath,
    confirmedAnchorsByPath,
    projectId,
    runId,
    preserveRereadRequirementsForPaths,
  } = params
  const grantedAnchorsByPath = new Map<string, ConfirmedPostEditAnchor>(
    confirmedAnchorsByPath ?? [],
  )
  for (const path of new Set(paths)) {
    if (!path) continue
    // context_compacted stays authoritative across a confirmed apply: the
    // exact read content left the active model context, so a commit must
    // never clear it — only a fresh whole-file read (or an explicit
    // whole-file basedOnRead) may. Such paths count as preserved regardless
    // of the passed-in set.
    const contextCompacted =
      fileProcessingState.editRereadRequirementsByPath?.[path]?.reason ===
      'context_compacted'
    if (!contextCompacted && !preserveRereadRequirementsForPaths?.has(path)) {
      clearEditRereadRequirement(fileProcessingState, path)
    }
    const wholeFileContent = wholeFileContentByPath?.get(path)
    if (
      typeof wholeFileContent === 'string' &&
      fileProcessingState.strictReadBeforeEdit
    ) {
      // Sticky-from-confirmed-apply is granted iff a whole-file post-edit
      // anchor can be minted (client-verified 7-point anchor or
      // synthesizePostEditAnchor). Empty/non-authoritative scope does not
      // grant or overwrite sticky maps and does not store an anchor.
      const contentHash = getContentHash(wholeFileContent)
      const anchor =
        confirmedAnchorsByPath?.get(path) ??
        synthesizePostEditAnchor({
          projectId,
          runId,
          path,
          content: wholeFileContent,
        })
      if (anchor) {
        fileProcessingState.readAuthorizationsByPath ??= {}
        fileProcessingState.readAuthorizationHashesByPath ??= {}
        fileProcessingState.readAuthorizationsByPath[path] = true
        fileProcessingState.readAuthorizationHashesByPath[path] = contentHash
        fileProcessingState.confirmedPostEditAnchorsByPath ??= {}
        fileProcessingState.confirmedPostEditAnchorsByPath[path] = anchor
        grantedAnchorsByPath.set(path, anchor)
      }
    }
  }
  return grantedAnchorsByPath
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
  preserveRereadRequirementsForPaths?: ReadonlySet<string>
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
    const staleSnapshot = collectStaleSnapshotPaths(output)
    if (staleSnapshot.sawStructuredStale) {
      // Coordinated batches are all-or-nothing: drop prepared state for every
      // path even when only a subset of structured failures is stale.
      invalidatePreparedEditPaths({
        fileProcessingState: params.fileProcessingState,
        paths,
        requiresFreshRead: false,
      })
      // Revoke only paths named by structured stale hits. A top-level
      // stale_snapshot with no per-path file/path and no stale failures[]
      // fails closed onto every coordinated path.
      const stalePaths =
        staleSnapshot.paths.size > 0 ? [...staleSnapshot.paths] : paths
      invalidatePreparedEditPaths({
        fileProcessingState: params.fileProcessingState,
        paths: stalePaths,
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

  const grantedAnchorsByPath = commitAppliedEditPaths({
    fileProcessingState: params.fileProcessingState,
    paths,
    wholeFileContentByPath: params.wholeFileContentByPath,
    confirmedAnchorsByPath,
    projectId: params.projectId,
    runId: params.runId,
    preserveRereadRequirementsForPaths: params.preserveRereadRequirementsForPaths,
  })
  params.onApplied?.()
  // Surface the granted post-edit capabilities to the model: this output array
  // reaches message history but not the user-facing CLI rows, so the cap.v3
  // token is model-visible only (matching how read_files surfaces
  // readCapability). Purely additive — existing parts are never mutated.
  const appliedOutput =
    grantedAnchorsByPath.size > 0
      ? ([
          ...output,
          {
            type: 'json',
            value: {
              postEditCapabilities: [...grantedAnchorsByPath.entries()].map(
                ([path, anchor]) => ({
                  path,
                  contentHash: anchor.contentHash,
                  readCapability: anchor.readCapability,
                }),
              ),
            },
          },
        ] as CodebuffToolOutput<T>)
      : output
  return {
    status: 'applied',
    output: appliedOutput,
    confirmedAnchorsByPath: grantedAnchorsByPath,
  }
}
