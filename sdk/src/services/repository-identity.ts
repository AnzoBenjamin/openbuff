import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { runGit, runGitBounded } from '../tools/git-status'
import { ExecutionRefusalError } from './execution-launch'

import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'

function canonicalPath(value: string): string {
  const resolved = path.resolve(value)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function identity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

export type WorkspaceIdentity = {
  repositoryId: string
  workspaceId: string
  repositoryRoot: string
  gitCommonDir: string
  canonicalRoot: string
}

/** Only an observed Git not-repository failure permits a filesystem fallback. */
export class NotGitRepositoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotGitRepositoryError'
  }
}

export async function resolveWorkspaceIdentity(params: {
  cwd: string
  signal?: AbortSignal
  executionContext?: ExecutionAdapterContext
  phase?: string
  /**
   * Optional wall-clock deadline for both rev-parse spawns (reliability:
   * bundle-rev-parse-head-unbounded): the bundle's identity path resolves
   * repository identity under the same deadline as every other identity
   * spawn. An omitted local limit still respects the captured parent budget.
   * Bootstrap callers must supply their registered host-observation context.
   */
  timeoutMs?: number
}): Promise<WorkspaceIdentity> {
  params = { ...params, signal: params.executionContext?.signal ?? params.signal }
  const bounded =
    params.timeoutMs !== undefined
      ? { timeoutMs: params.timeoutMs, maxOutputBytes: 8 * 1024 * 1024 }
      : undefined
  const [root, commonDir] = await Promise.all([
    bounded !== undefined
      ? runGitBounded(
          ['rev-parse', '--show-toplevel'],
          params.cwd,
          params.signal,
          { ...bounded, executionContext: params.executionContext, branchId: 'identity.bounded.root', phase: params.phase },
        )
      : runGit(['rev-parse', '--show-toplevel'], params.cwd, params.signal, {
          executionContext: params.executionContext,
          branchId: 'identity.legacy.root',
          phase: params.phase,
        }),
    bounded !== undefined
      ? runGitBounded(
          ['rev-parse', '--git-common-dir'],
          params.cwd,
          params.signal,
          { ...bounded, executionContext: params.executionContext, branchId: 'identity.bounded.common-dir', phase: params.phase },
        )
      : runGit(['rev-parse', '--git-common-dir'], params.cwd, params.signal, {
          executionContext: params.executionContext,
          branchId: 'identity.legacy.common-dir',
          phase: params.phase,
        }),
  ])
  const refusal = root.executionRefusal ?? commonDir.executionRefusal
  if (refusal) throw new ExecutionRefusalError(refusal)
  if (root.exitCode !== 0 || commonDir.exitCode !== 0) {
    const failures = [root, commonDir].filter(result => result.exitCode !== 0)
    const message = failures.map(result => result.stderr.trim()).find(Boolean)
      || 'Unable to resolve Git repository identity.'
    if (failures.every(result => result.exitCode === 128
      && /^fatal: not a git repository(?:\s|:|$)/m.test(result.stderr))) {
      throw new NotGitRepositoryError(message)
    }
    throw new Error(message)
  }
  if (!root.stdout.trim() || !commonDir.stdout.trim()) {
    throw new Error('Git repository identity response is empty.')
  }
  const repositoryRoot = canonicalPath(
    path.resolve(params.cwd, root.stdout.trim()),
  )
  const gitCommonDir = canonicalPath(
    path.resolve(repositoryRoot, commonDir.stdout.trim()),
  )
  return {
    repositoryId: identity(gitCommonDir),
    workspaceId: identity(repositoryRoot),
    repositoryRoot,
    gitCommonDir,
    canonicalRoot: path.dirname(gitCommonDir),
  }
}
