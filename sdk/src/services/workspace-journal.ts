import {
  advanceWorkspaceState,
  createInitialWorkspaceState,
} from '@codebuff/common/types/workspace-state'

import { LocalHarnessStore } from './local-harness-store'
import { resolveBootstrapWorkspaceIdentity } from './workspace-bootstrap'
import type { WorkspaceIdentitySource } from './workspace-bootstrap'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'

import type { LocalHarnessRecord } from './local-harness-store'
import type {
  WorkspaceChangeAction,
  WorkspaceStateV1,
} from '@codebuff/common/types/workspace-state'

type WorkspaceJournalRecord = LocalHarnessRecord & {
  state: WorkspaceStateV1
}

export class WorkspaceJournalService {
  private constructor(
    private readonly store: LocalHarnessStore,
    readonly repositoryId: string,
    readonly workspaceId: string,
    readonly identitySource: WorkspaceIdentitySource,
  ) {}

  static async create(params: {
    rootDir: string
    cwd: string
    executionContext?: ExecutionAdapterContext
  }): Promise<WorkspaceJournalService> {
    const captured = { ...params }
    const identity = await resolveBootstrapWorkspaceIdentity(captured)
    return new WorkspaceJournalService(
      new LocalHarnessStore(captured.rootDir),
      identity.repositoryId,
      identity.workspaceId,
      identity.identitySource,
    )
  }

  read(): WorkspaceStateV1 {
    const record = this.store.read(
      this.repositoryId,
      'workspace-journals',
      'workspace',
    ) as WorkspaceJournalRecord | undefined
    return record?.state ?? createInitialWorkspaceState()
  }

  advance(params: {
    runId: string
    source: string
    operationId?: string
    receiptId?: string
    actions: WorkspaceChangeAction[]
  }): WorkspaceStateV1 {
    return this.store.withKindLock(
      this.repositoryId,
      'workspace-journals',
      () => {
        const existing = this.store.read(
          this.repositoryId,
          'workspace-journals',
          'workspace',
        ) as WorkspaceJournalRecord | undefined
        const current = existing?.state ?? createInitialWorkspaceState()
        const state = advanceWorkspaceState(current, params)
        const timestamp = new Date(state.updatedAt).toISOString()
        this.store.put(
          'workspace-journals',
          {
            schemaVersion: 1,
            id: 'workspace',
            revision: existing ? existing.revision + 1 : 0,
            repositoryId: this.repositoryId,
            workspaceId: this.workspaceId,
            runId: params.runId || 'unknown-run',
            snapshotId: state.snapshotId,
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp,
            state,
          },
          existing?.revision,
        )
        return state
      },
    )
  }
}
