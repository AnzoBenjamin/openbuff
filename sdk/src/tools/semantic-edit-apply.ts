import { changeFiles } from './change-file'
import { findFileMutationResult } from './write-audit-findings'

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
 * P4-T2: ONE apply core for both semantic-edit SDK tools (rename_symbol and
 * code_action), shared so the two wrappers cannot drift.
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

/** The single json value the two tools publish (identical outputSchema). */
type SemanticEditOutputValue =
  CodebuffToolOutput<'rename_symbol'>[number]['value']

function jsonOutput(value: SemanticEditOutputValue): CodebuffToolOutput<'rename_symbol'> {
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
  serviceError: string | undefined,
): SemanticEditOutputValue {
  const results = mutation.actions.map((action) => {
    if (action.outcome === 'applied') {
      return { path: action.path, applied: true }
    }
    return {
      path: action.path,
      applied: false,
      errorMessage:
        action.error?.message ??
        mutation.errors[0]?.message ??
        `the file change was ${action.outcome}`,
    }
  })
  const errorMessages = new Set<string>()
  if (serviceError) errorMessages.add(serviceError)
  if (mutation.outcome !== 'applied') {
    for (const error of mutation.errors) {
      errorMessages.add(error.message)
    }
  }
  return {
    applied: mutation.outcome === 'applied',
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
  const serviceError =
    typeof serviceValue.errorMessage === 'string'
      ? serviceValue.errorMessage
      : undefined
  if (changedFiles.length === 0) {
    // Defensive fail-closed: the service contract never yields an empty
    // list here, and an empty transaction is an honest failure, not a no-op.
    return {
      output: jsonOutput({
        errorMessage:
          serviceError ?? 'the language server returned no applicable edits',
      }),
    }
  }

  // Unguarded full-file writes: changeFiles resolves each path (the service
  // returns absolute in-project paths), snapshots the current bytes under the
  // path lock, and refuses a mutation whose freshness changed between the
  // service splice and the commit — so no pre-computed hash is needed here.
  const mutationOutput = await changeFiles({
    parameters: changedFiles.map((file) => ({
      type: 'file' as const,
      path: file.path,
      content: file.newContent,
    })),
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
  return { output: jsonOutput(buildApplyOutput(mutation, serviceError)), mutation }
}

export type SemanticEditApplyResult<
  T extends 'rename_symbol' | 'code_action',
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
