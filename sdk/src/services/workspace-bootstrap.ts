import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { createDirectHostExecution } from '../host-execution'
import { ExecutionRefusalError } from './execution-launch'
import { NotGitRepositoryError, resolveWorkspaceIdentity } from './repository-identity'

import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'

export type WorkspaceIdentitySource = 'git-observed' | 'filesystem-not-git'

export function captureWorkspaceBootstrapExecution(params: Readonly<{
  cwd: string; executionContext?: ExecutionAdapterContext
}>): ExecutionAdapterContext {
  if (params.executionContext) return params.executionContext
  const captured = createDirectHostExecution({ cwd: path.resolve(params.cwd) })
  if (!captured.ok) throw new ExecutionRefusalError(captured)
  return captured.value.hostServices.bootstrap
}

/** Direct callers capture once; only an observed not-repository failure permits fallback. */
export async function resolveBootstrapWorkspaceIdentity(params: Readonly<{
  cwd: string
  executionContext?: ExecutionAdapterContext
}>): Promise<Readonly<{ repositoryId: string; workspaceId: string; identitySource: WorkspaceIdentitySource }>> {
  const cwd = path.resolve(params.cwd)
  const executionContext = captureWorkspaceBootstrapExecution({ cwd, executionContext: params.executionContext })
  try {
    const identity = await resolveWorkspaceIdentity({ cwd, executionContext })
    return Object.freeze({ repositoryId: identity.repositoryId, workspaceId: identity.workspaceId,
      identitySource: 'git-observed' as const })
  } catch (error) {
    if (!(error instanceof NotGitRepositoryError)) throw error
    let canonical = cwd
    try { canonical = fs.realpathSync.native(cwd) } catch { /* Preserve the observed non-Git path. */ }
    const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 24)
    return Object.freeze({ repositoryId: digest, workspaceId: digest, identitySource: 'filesystem-not-git' as const })
  }
}
