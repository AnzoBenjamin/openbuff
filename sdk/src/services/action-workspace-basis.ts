import { buildFileMutationResultFromReceiptV1, getConfirmedAppliedActionsV1 } from '@codebuff/common/tools/results/filesystem'
import { advanceWorkspaceState } from '@codebuff/common/types/workspace-state'

import type { CommitReceiptV1 } from '@codebuff/common/tools/results/filesystem'
import type { ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import type { WorkspaceChangeAction, WorkspaceStateV1 } from '@codebuff/common/types/workspace-state'

type Coordinates = Readonly<{ snapshotId: string; revision: number }> | undefined
type ConfirmedWorkspaceTransition = Readonly<{
  before: WorkspaceStateV1 | undefined
  after: WorkspaceStateV1
  source: string
  operationId: string
  receiptId?: string
  actions: readonly WorkspaceChangeAction[]
  canonicalReceipt?: CommitReceiptV1
}>

/** Keep the original B02 basis fixed while recognizing its confirmed local effects. */
export function createActionWorkspaceBasis(identity: ToolExecutionIdentity, workspaceAtStart: WorkspaceStateV1 | undefined) {
  const original = Object.freeze({ basisId: identity.basisId, actionId: identity.actionId,
    workspaceSnapshotId: identity.workspaceSnapshotId, workspaceRevision: identity.basis.workspaceRevision })
  const coordinates = (state: WorkspaceStateV1 | undefined): Coordinates => state
    ? Object.freeze({ snapshotId: state.snapshotId, revision: state.revision }) : undefined
  const initial = coordinates(workspaceAtStart)
  let confirmed = initial
  const isCurrent = (basisId: string, state: WorkspaceStateV1 | undefined) => basisId === original.basisId &&
    (original.workspaceSnapshotId === undefined || original.workspaceSnapshotId === initial?.snapshotId) &&
    (original.workspaceRevision === undefined || original.workspaceRevision === initial?.revision) &&
    state?.snapshotId === confirmed?.snapshotId && state?.revision === confirmed?.revision
  return Object.freeze({
    isCurrent,
    confirmTransition(transition: ConfirmedWorkspaceTransition): boolean {
      if (!isCurrent(original.basisId, transition.before)) return false
      const receipt = transition.canonicalReceipt
      if (!receipt || receipt.callId !== original.actionId || receipt.operationId !== transition.operationId ||
        receipt.receiptId !== transition.receiptId) return false
      try {
        const actions = getConfirmedAppliedActionsV1(buildFileMutationResultFromReceiptV1(receipt)).map(action => ({
          action: action.action, path: action.path,
          ...(action.destinationPath ? { destinationPath: action.destinationPath } : {}),
          beforeHash: action.beforeHash, afterHash: action.afterHash,
        }))
        if (!actions.length || JSON.stringify(actions) !== JSON.stringify(transition.actions)) return false
        const expected = advanceWorkspaceState(transition.before, { source: transition.source,
          operationId: transition.operationId, receiptId: transition.receiptId, actions })
        if (expected.snapshotId !== transition.after.snapshotId || expected.revision !== transition.after.revision) return false
        confirmed = coordinates(transition.after)
        return true
      } catch { return false }
    },
  })
}

export type ActionWorkspaceBasis = ReturnType<typeof createActionWorkspaceBasis>
export type { ConfirmedWorkspaceTransition }
