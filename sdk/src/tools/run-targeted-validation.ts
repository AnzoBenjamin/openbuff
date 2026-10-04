import { computeWorktreeSnapshotIdentity } from './get-change-review-bundle'
import {
  runFileChangeHooks,
  type DiagnosticDeltaHook,
} from './file-change-hooks'

import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { WorkspaceStateV1 } from '@codebuff/common/types/workspace-state'
import type { SemgrepRunner } from '../services/semgrep-baseline'

export async function runTargetedValidation(params: {
  cwd: string
  snapshotId: string
  files: string[]
  artifactKinds?: string[]
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  fileSystem?: CodebuffFileSystem
  runHooks?: typeof runFileChangeHooks
  /**
   * Opt-in diagnostic-delta preflight injector, forwarded to
   * runFileChangeHooks (a no-op unless OPENBUFF_DIAGNOSTIC_PREFLIGHT is set).
   */
  diagnosticDelta?: DiagnosticDeltaHook
  workspaceState?: WorkspaceStateV1
  /**
   * Accepted for backward compatibility. Targeted validation no longer builds
   * change-review bundles — both drift checks consult only the snapshotId via
   * the identity-only path — so no semgrep scan is driven from here anymore;
   * callers that need scanned findings use getChangeReviewBundle directly.
   */
  securityScanRunner?: SemgrepRunner
}): Promise<CodebuffToolOutput<'run_targeted_validation'>> {
  const artifactKinds = params.artifactKinds ?? []
  // Snapshot identity only (perf: bundle-identity-unbounded-sync-io): both
  // drift checks used to build two FULL change-review bundles per call — each
  // hashing the complete `git diff --binary HEAD` output and synchronously
  // reading every changed file's complete bytes — while consulting only the
  // snapshotId. computeWorktreeSnapshotIdentity computes the exact same
  // snapshotId without the presentation diff, harness-store lookups, or the
  // semgrep scan, with bounded asynchronous per-file reads.
  const before = await computeWorktreeSnapshotIdentity({
    cwd: params.cwd,
    workspaceState: params.workspaceState,
    signal: params.signal,
  })
  if ('errorMessage' in before || before.snapshotId !== params.snapshotId) {
    return [
      {
        type: 'json',
        value: {
          schemaVersion: 1,
          snapshotId:
            'snapshotId' in before ? before.snapshotId : params.snapshotId,
          workspaceRevision: params.workspaceState?.revision,
          workspaceSnapshotId: params.workspaceState?.snapshotId,
          files: params.files,
          artifactKinds,
          status: 'failed',
          assurance: 'none',
          summary:
            'Validation refused because the requested snapshot is stale or unavailable.',
          results: [],
        },
      },
    ]
  }
  const hookOutput = await (params.runHooks ?? runFileChangeHooks)({
    files: params.files,
    cwd: params.cwd,
    env: params.env,
    signal: params.signal,
    fileSystem: params.fileSystem,
    diagnosticDelta: params.diagnosticDelta,
  })
  const results = hookOutput.flatMap((part) =>
    part.type === 'json' && Array.isArray(part.value) ? part.value : [],
  ) as Array<Record<string, unknown>>
  const after = await computeWorktreeSnapshotIdentity({
    cwd: params.cwd,
    workspaceState: params.workspaceState,
    signal: params.signal,
  })
  const snapshotChanged =
    'errorMessage' in after || after.snapshotId !== before.snapshotId
  // A diagnostic-delta preflight rejection (diagnostic_delta_rejected) is a
  // hard validation failure even though that hook-result arm carries no
  // exitCode/errorMessage/permissionDenied — it signals NEW error-severity
  // diagnostics introduced by the validated files, so it must fail the gate.
  const failed = results.some(
    (result) =>
      (typeof result.exitCode === 'number' && result.exitCode !== 0) ||
      typeof result.errorMessage === 'string' ||
      result.permissionDenied === true ||
      result.validationStatus === 'diagnostic_delta_rejected',
  )
  const skipped =
    results.length === 0 ||
    results.every((result) =>
      ['no_hooks_configured', 'hooks_skipped'].includes(
        typeof result.validationStatus === 'string'
          ? result.validationStatus
          : '',
      ),
    )
  const status =
    snapshotChanged || failed ? 'failed' : skipped ? 'skipped' : 'passed'
  return [
    {
      type: 'json',
      value: {
        schemaVersion: 1,
        snapshotId: before.snapshotId,
        workspaceRevision: params.workspaceState?.revision,
        workspaceSnapshotId: params.workspaceState?.snapshotId,
        files: params.files,
        artifactKinds,
        status,
        assurance:
          snapshotChanged || failed ? 'none' : skipped ? 'reduced' : 'full',
        summary: snapshotChanged
          ? 'Validation evidence rejected because the worktree changed during validation.'
          : failed
            ? 'One or more targeted validation checks failed.'
            : skipped
              ? 'No matching configured validation checks ran.'
              : 'Targeted validation checks passed for the attested snapshot.',
        results,
      },
    },
  ]
}
