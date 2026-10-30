import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { runGit, runGitBounded } from '../tools/git-status'

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

export async function resolveWorkspaceIdentity(params: {
  cwd: string
  signal?: AbortSignal
  /**
   * Optional wall-clock deadline for both rev-parse spawns (reliability:
   * bundle-rev-parse-head-unbounded): the bundle's identity path resolves
   * repository identity under the same deadline as every other identity
   * spawn. Unset callers (workspace-journal, mutation-broker) keep the
   * historical unbounded behavior; a timeout resolves exitCode -1 and the
   * throw below fires — bounded latency, unchanged contract.
   */
  timeoutMs?: number
}): Promise<WorkspaceIdentity> {
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
          bounded,
        )
      : runGit(['rev-parse', '--show-toplevel'], params.cwd, params.signal),
    bounded !== undefined
      ? runGitBounded(
          ['rev-parse', '--git-common-dir'],
          params.cwd,
          params.signal,
          bounded,
        )
      : runGit(['rev-parse', '--git-common-dir'], params.cwd, params.signal),
  ])
  if (root.exitCode !== 0 || commonDir.exitCode !== 0) {
    throw new Error(
      root.stderr.trim() ||
        commonDir.stderr.trim() ||
        'Unable to resolve Git repository identity.',
    )
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
