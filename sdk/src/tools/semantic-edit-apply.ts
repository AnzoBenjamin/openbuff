import { changeFiles } from './change-file'
import { findFileMutationResult } from './write-audit-findings'
import { getConfirmedAppliedActionsV1 } from '@codebuff/common/tools/results/filesystem'
import { resolveProjectPathForFileSystemRead } from '@codebuff/common/util/project-path-containment'

import type { FileChange } from '@codebuff/common/actions'
import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { FileMutationResultV1 } from '@codebuff/common/tools/results/filesystem'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ReadCapabilityIssuer } from '@codebuff/common/util/content-hash'
import type { RenameCodeActionResult } from '../services/language-intelligence'
import type { FileFilter } from './read-files'
import type { FilesystemAuthorityPolicy } from './filesystem-authority'
import type { TransactionIntentLog } from './transaction-intent-log'

/**
 * P4-T2: ONE apply core for the semantic-edit SDK tools (rename_symbol,
 * code_action, and extract_symbol), shared so the wrappers cannot drift.
 *
 * The language-intelligence SERVICE never writes to disk: it splices the
 * language server's WorkspaceEdit into CURRENT disk bytes and returns per-file
 * contents (`changedFiles`) or an honest `unavailable`/`errorMessage` result.
 * THIS layer owns applying those contents through `changeFiles` — the one
 * production multi-file commit path (per-file broker CAS, CommitReceiptV1s,
 * P2-T5 durable intent log, rollback) — and reducing its
 * `FileMutationResultV1` into the tools' published named result shape.
 * No direct fs write, extra broker call, or extra receipt structure happens
 * here: the commit machinery owns journaling and intent records (run.ts picks
 * the mutation up via the compact-receipt channel; writeAuditFindings
 * precedent).
 */

/**
 * Injected deps that `changeFiles` needs. run.ts passes the exact same set the
 * edit_transaction (write_file / str_replace / edit_transaction / replace_range)
 * branches do; direct callers (tests) inject a mock filesystem instead.
 */
export type SemanticEditApplyDeps = {
  cwd: string
  fs: CodebuffFileSystem
  signal?: AbortSignal
  fileFilter?: FileFilter
  filesystemPolicy?: FilesystemAuthorityPolicy
  capabilityIssuer?: ReadCapabilityIssuer
  /** P2-T5: durable transaction-intent log; changeFiles owns its use. */
  intentLog?: TransactionIntentLog
  callId?: string
  logger?: Logger
}

/**
 * The single json value the semantic-edit tools publish (identical
 * outputSchema). extract_symbol's outputSchema is shape-identical to
 * code_action's, so this shared value — and the `jsonOutput` cast below,
 * typed as CodebuffToolOutput<'rename_symbol'> — covers it unchanged.
 */
type SemanticEditOutputValue =
  CodebuffToolOutput<'rename_symbol'>[number]['value']

function jsonOutput(
  value: SemanticEditOutputValue,
): CodebuffToolOutput<'rename_symbol'> {
  return [{ type: 'json', value }]
}

/**
 * Reduces changeFiles' `FileMutationResultV1` into the published named result,
 * honestly: `applied` mirrors the aggregate outcome, a per-path entry is
 * `applied` only when that action applied, and every known failure message
 * (service splice failures, transaction errors, action errors — deduped) is
 * surfaced once as the top-level errorMessage so the model can react.
 */
function buildApplyOutput(
  mutation: FileMutationResultV1,
  planned: Extract<
    RenameCodeActionResult,
    { changedFiles: unknown }
  >['changedFiles'],
): SemanticEditOutputValue {
  const confirmedActionIds = new Set(
    getConfirmedAppliedActionsV1(mutation).map((action) => action.actionId),
  )
  const results = mutation.actions.map((action, index) => {
    const annotations = planned[index]?.annotations
    const metadata = annotations?.length ? { annotations } : {}
    if (confirmedActionIds.has(action.actionId)) {
      return { path: action.path, applied: true, ...metadata }
    }
    return {
      path: action.path,
      applied: false,
      ...metadata,
      errorMessage:
        action.error?.message ??
        mutation.errors[0]?.message ??
        `the file change was ${action.outcome}`,
    }
  })
  const errorMessages = new Set<string>()
  if (mutation.outcome !== 'applied') {
    for (const error of mutation.errors) {
      errorMessages.add(error.message)
    }
  }
  return {
    applied:
      mutation.outcome === 'applied' &&
      confirmedActionIds.size === mutation.actions.length,
    results,
    ...(errorMessages.size > 0
      ? { errorMessage: [...errorMessages].join('; ') }
      : {}),
  }
}

export const NO_RESULT_ERROR = 'Language server returned no structured result.'

/**
 * The shared core behind {@link applySemanticRenameEdit} and
 * {@link applySemanticCodeActionEdit}. Both tools' output schemas are the
 * same `{ applied?, results?, unavailable?, errorMessage? }` tuple, so the
 * core builds against the shared shape once.
 */
export async function applySemanticEdit(
  serviceValue: RenameCodeActionResult,
  deps: SemanticEditApplyDeps,
): Promise<{
  output: CodebuffToolOutput<'rename_symbol'>
  mutation?: FileMutationResultV1
}> {
  if ('unavailable' in serviceValue || !('changedFiles' in serviceValue)) {
    return { output: jsonOutput(serviceValue) }
  }
  const changedFiles = serviceValue.changedFiles
  if (serviceValue.errorMessage !== undefined || changedFiles.length === 0) {
    return {
      output: jsonOutput({
        applied: false,
        errorMessage:
          serviceValue.errorMessage ??
          'the language server returned no applicable edits',
      }),
    }
  }

  const targets = new Set<string>()
  const parameters: FileChange[] = []
  const claimPath = async (target: string, requireIdentity: boolean) => {
    const contained = await resolveProjectPathForFileSystemRead(
      deps.cwd,
      target,
      deps.fs,
      deps.fs.hostReadPolicy,
    )
    if (
      contained?.scope !== 'project' ||
      targets.has(contained.realFullPath) ||
      (requireIdentity && contained.fullPath !== contained.realFullPath)
    )
      return undefined
    targets.add(contained.realFullPath)
    return contained.realFullPath
  }
  const pathRefused = () => ({
    output: jsonOutput({
      applied: false,
      errorMessage:
        'The semantic edit contains an outside, aliased or duplicate target; no files were changed.',
    }),
  })
  for (const file of changedFiles) {
    const basis = file.expectedRawHash
    if (
      basis !== null &&
      (typeof basis !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(basis))
    ) {
      return {
        output: jsonOutput({
          applied: false,
          errorMessage:
            'Missing exact semantic edit basis; no files were changed.',
        }),
      }
    }
    const resource = file.kind === 'delete' || file.kind === 'move'
    const path = await claimPath(file.path, resource || basis === null)
    if (!path) return pathRefused()
    if (file.kind === 'move') {
      const destinationPath = await claimPath(file.destinationPath, true)
      if (!destinationPath) return pathRefused()
      parameters.push({
        type: 'move',
        path,
        destinationPath,
        expectedHash: file.expectedHash,
        expectedRawHash: file.expectedRawHash,
        destinationExpectedHash: null,
      })
    } else if (file.kind === 'delete') {
      parameters.push({
        type: 'delete',
        path,
        expectedHash: file.expectedHash,
        expectedRawHash: file.expectedRawHash,
      })
    } else {
      parameters.push({
        type: 'file',
        path,
        content: file.newContent,
        expectedRawHash: basis,
        ...(basis === null ? { expectedHash: null } : {}),
      })
    }
  }
  // Bind to the exact splice input. Taking a new basis under the lock would
  // silently clobber concurrent appends, BOM changes and EOL-only drift.
  const mutationOutput = await changeFiles({
    parameters,
    cwd: deps.cwd,
    fs: deps.fs,
    signal: deps.signal,
    fileFilter: deps.fileFilter,
    filesystemPolicy: deps.filesystemPolicy,
    capabilityIssuer: deps.capabilityIssuer,
    intentLog: deps.intentLog,
    callId: deps.callId,
    logger: deps.logger,
  })
  const mutation = findFileMutationResult(mutationOutput)
  if (!mutation) {
    // changeFiles' contract always emits a file_mutation_result json part;
    // fail closed rather than inventing an applied result.
    return {
      output: jsonOutput({
        applied: false,
        errorMessage: 'the file transaction produced no structured result',
      }),
    }
  }
  return {
    output: jsonOutput(buildApplyOutput(mutation, changedFiles)),
    mutation,
  }
}

/**
 * P4-T2 (extract slice): widened to cover extract_symbol. Its outputSchema is
 * shape-identical to rename_symbol's / code_action's, so `output` carries the
 * exact same union shape for all three tools.
 */
export type SemanticEditApplyResult<
  T extends 'rename_symbol' | 'code_action' | 'extract_symbol',
> = {
  /** Published result in the tool's own outputSchema shape. */
  output: CodebuffToolOutput<T>
  /**
   * The underlying `file_mutation_result` produced by changeFiles' broker
   * commit. The tools' published output is a compact named result, so run.ts
   * carries the mutation through the compact-receipt channel (the
   * writeAuditFindings precedent) for workspace-state advance, post-commit LSP
   * sync, and mutation observers. It is returned for applied AND not-applied
   * commits; receivers gate on the confirmed actions, not on presence.
   */
  mutation?: FileMutationResultV1
}
