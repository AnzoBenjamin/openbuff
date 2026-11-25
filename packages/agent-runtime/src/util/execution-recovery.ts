import { executionRefusalSchema } from '@codebuff/common/tools/params/execution-refusal'

import type { ExecutionRefusal } from '@codebuff/common/tools/params/execution-refusal'
import type { WorkspaceStateV1 } from '@codebuff/common/types/workspace-state'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { FileProcessingState } from '../tools/handlers/tool/write-file'

/** Descriptive synchronization revokes reads; it never renews a registered action. */
export function applyHostWorkspaceState(
  state: AgentState,
  workspace: WorkspaceStateV1 | undefined,
  files?: FileProcessingState,
) {
  if (!workspace) return
  const changed =
    state.workspaceState?.snapshotId !== workspace.snapshotId ||
    state.workspaceState.revision !== workspace.revision
  state.workspaceState = workspace
  if (!changed) return
  const revoke = (target: AgentState | FileProcessingState) => {
    target.readAuthorizationsByPath = {}
    target.readAuthorizationHashesByPath = {}
    target.rawReadAuthorizationHashesByPath = {}
    target.confirmedPostEditAnchorsByPath = {}
  }
  revoke(state)
  if (files) {
    revoke(files)
    files.modelVisibleReadAuthorizationHashesByPath = {}
    files.modelVisibleRawReadAuthorizationHashesByPath = {}
  }
}

export function findExecutionRefusal(
  output: readonly unknown[],
): ExecutionRefusal | undefined {
  for (const part of output) {
    if (
      !part ||
      typeof part !== 'object' ||
      !('type' in part) ||
      part.type !== 'json' ||
      !('value' in part)
    )
      continue
    const value = part.value
    if (!value || typeof value !== 'object' || !('executionRefusal' in value))
      continue
    const parsed = executionRefusalSchema.safeParse(value.executionRefusal)
    if (parsed.success) return parsed.data
  }
  return undefined
}

/** One stale-authority recovery per run. Changing tools or reading memory cannot reset it. */
export function recordExecutionRefusal(
  state: AgentState,
  refusal: ExecutionRefusal,
  refreshed = false,
): string {
  if (refusal.reason === 'stale-authority') {
    const budget = (state.executionRecovery ??= { staleRefusals: 0 })
    budget.staleRefusals++
    if (budget.staleRefusals === 1 && refreshed) {
      return 'Execution authority was stale. The runtime refreshed the workspace view. Re-read live state and re-verify the staged changes and validation before attempting a mutation. The refused action was not retried.'
    }
  }
  state.runOutcome = {
    termination:
      refusal.reason === 'cancelled'
        ? 'cancelled'
        : refusal.reason === 'deadline-exhausted'
          ? 'deadline_exhausted'
          : 'failed',
    cause: { code: `execution_${refusal.reason}`, message: refusal.cause },
  }
  return `Execution stopped: ${refusal.cause}`
}
