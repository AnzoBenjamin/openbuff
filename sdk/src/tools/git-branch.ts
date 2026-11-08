import { gitStatus, runGit } from './git-status'

import type { ExecutionAdapterContext, Refusal } from '@codebuff/common/types/contracts/execution-context'

export interface GitBranchResult {
  branch: string
  created: boolean
  switched: boolean
  previousBranch?: string
  errorMessage?: string
  executionRefusal?: Refusal
}

/**
 * Branch names must start with an alphanumeric character and may contain
 * letters, digits, dots, slashes, and hyphens. This is intentionally stricter
 * than git's own rules to keep names predictable and shell-safe.
 */
const BRANCH_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/

/**
 * Create a new git branch, optionally switching to it.
 *
 * By default, refuses to branch when the working tree is dirty (reuses the
 * `gitStatus` helper for the dirty-tree check). Pass `allowDirty: true` to
 * skip the check — useful when intentionally moving uncommitted work to a
 * new branch.
 */
export async function gitBranch(params: {
  cwd: string
  branchName: string
  /** When true (default), create AND switch to the branch (`git checkout -b`). */
  switch?: boolean
  /** When true, skip the dirty-tree refusal check. Defaults to false. */
  allowDirty?: boolean
  signal?: AbortSignal
  executionContext?: ExecutionAdapterContext
}): Promise<GitBranchResult> {
  const { cwd, branchName } = params
  const doSwitch = params.switch ?? true
  const allowDirty = params.allowDirty ?? false

  // Validate branch name before spawning any git process
  if (!branchName || !BRANCH_NAME_REGEX.test(branchName)) {
    return {
      branch: branchName ?? '',
      created: false,
      switched: false,
      errorMessage: `Invalid branch name: "${branchName}". Branch names must start with an alphanumeric character and contain only [a-zA-Z0-9._/-].`,
    }
  }

  // Reuse gitStatus for dirty-tree refusal
  if (!allowDirty) {
    const statusResult = await gitStatus({
      cwd,
      signal: params.signal,
      executionContext: params.executionContext,
    })
    const firstEntry = statusResult[0]
    if (!firstEntry || firstEntry.type !== 'json') {
      return {
        branch: branchName,
        created: false,
        switched: false,
        errorMessage: 'Failed to read git status.',
      }
    }
    const statusValue = firstEntry.value
    if ('errorMessage' in statusValue && statusValue.errorMessage) {
      return {
        branch: branchName,
        created: false,
        switched: false,
        errorMessage: `git_status error: ${statusValue.errorMessage}`,
        ...('executionRefusal' in statusValue
          ? { executionRefusal: statusValue.executionRefusal as Refusal }
          : {}),
      }
    }
    if ('status' in statusValue && statusValue.status.trim().length > 0) {
      return {
        branch: branchName,
        created: false,
        switched: false,
        errorMessage: `Working tree is dirty. Commit or stash changes before branching.\nStatus:\n${statusValue.status}`,
      }
    }
  }

  // Capture previous branch for return info (only meaningful when switching)
  let previousBranch: string | undefined
  if (doSwitch) {
    const revResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, params.signal, {
      executionContext: params.executionContext,
      branchId: 'git-branch.prior',
    })
    if (revResult.executionRefusal) {
      return {
        branch: branchName,
        created: false,
        switched: false,
        errorMessage: revResult.stderr,
        executionRefusal: revResult.executionRefusal,
      }
    }
    if (revResult.exitCode === 0) {
      previousBranch = revResult.stdout.trim()
    }
  }

  const branchArgs = doSwitch
    ? ['checkout', '-b', branchName]
    : ['branch', branchName]
  const result = await runGit(branchArgs, cwd, params.signal, {
    executionContext: params.executionContext,
    branchId: doSwitch ? 'git-branch.create-switch' : 'git-branch.create',
  })
  if (result.exitCode !== 0) {
    return {
      branch: branchName,
      created: false,
      switched: false,
      errorMessage:
        result.stderr.trim() ||
        `git ${branchArgs.join(' ')} exited with code ${result.exitCode}.`,
      ...(result.executionRefusal ? { executionRefusal: result.executionRefusal } : {}),
    }
  }

  return {
    branch: branchName,
    created: true,
    switched: doSwitch,
    ...(previousBranch !== undefined ? { previousBranch } : {}),
  }
}
