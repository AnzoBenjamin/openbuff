import type { RunState } from '../../../sdk/src/run-state'
import type { AgentState } from '@codebuff/common/types/session-state'
import { rehashContextArchiveBodies } from '@codebuff/common/util/context-archive-body'
import type { ContextArchiveRetentionReceipt } from '@codebuff/common/types/context-archive'

export type ArchiveFlushOutcome = {
  persisted: number
  skipped: number
  status?: 'ok' | 'degraded' | 'unavailable'
  reasons?: string[]
  retention?: ContextArchiveRetentionReceipt
}

/** Called only on a sanitized private persistence tree, never on the live caller state. */
export function normalizePersistedArchive(runState: RunState): void {
  const main = runState.sessionState?.mainAgentState
  if (!main) return
  const pending = [main],
    seen = new Set<AgentState>()
  while (pending.length) {
    const state = pending.pop()!
    if (!state || seen.has(state)) continue
    seen.add(state)
    rehashContextArchiveBodies(state)
    if (Array.isArray(state.subagents)) pending.push(...state.subagents)
  }
}

/** Reference-only publication is allowed only after every snapshot commit and its lease release joined. */
export function projectCommittedArchive(
  runState: RunState,
  outcome: ArchiveFlushOutcome | undefined,
): void {
  const state = runState.sessionState?.mainAgentState
  if (!state?.compactionArchive?.length) return
  if (outcome?.retention) state.contextArchiveRetention = outcome.retention
  if (outcome?.retention?.status === 'cutoff' && outcome.skipped > 0) {
    // The storage receipt cannot attest which incoming references survived. Do not
    // publish guessed/dangling original refs or retain an overquota inline shadow.
    state.compactionArchive = state.compactionArchive.filter(
      (snapshot) => !snapshot.provenance?.some((provenance) => provenance.body),
    )
    state.contextArchiveBodies = undefined
    state.contextArchiveStorage = 'references'
    return
  }
  const referenced = new Set(
    state.compactionArchive.flatMap(
      (snapshot) =>
        snapshot.provenance?.flatMap((provenance) =>
          provenance.body ? [provenance.body.bodyId] : [],
        ) ?? [],
    ),
  )
  const confirmed =
    outcome &&
    outcome.status !== 'unavailable' &&
    outcome.skipped === 0 &&
    outcome.persisted === state.compactionArchive.length &&
    outcome.retention?.schemaVersion === 1 &&
    outcome.retention.retainedBodies >= referenced.size &&
    outcome.retention.status !== 'retention-capacity'
  if (!confirmed) {
    state.contextArchiveStorage = 'inline'
    return
  }
  state.compactionArchive = state.compactionArchive.map((snapshot) => ({
    ...snapshot,
    snapshotId: undefined,
    messages: snapshot.messages.map((message, index) => {
      const provenance = snapshot.provenance?.[index]
      if (message.role !== 'tool' || !provenance?.body) return message
      const { bodyId, sha256, utf8Bytes } = provenance.body
      return {
        ...message,
        content: [
          {
            type: 'json' as const,
            value: {
              kind: 'context_archive_body_reference',
              version: 1,
              toolCallId: message.toolCallId,
              sourceRunId:
                provenance.sourceRunId ?? snapshot.runId ?? state.runId ?? '',
              bodyId,
              sha256,
              utf8Bytes,
            },
          },
        ],
      }
    }),
    provenance: snapshot.provenance?.map((provenance) =>
      provenance.body
        ? {
            ...provenance,
            kind: 'pointer' as const,
            retainedRange: undefined,
            body: {
              bodyId: provenance.body.bodyId,
              sha256: provenance.body.sha256,
              utf8Bytes: provenance.body.utf8Bytes,
            },
          }
        : provenance,
    ),
  }))
  state.contextArchiveBodies = undefined
  state.contextArchiveStorage = 'references'
}
