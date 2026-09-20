import type { Message } from './messages/codebuff-message'

/**
 * One capped snapshot of the transcript as it existed immediately before a
 * compaction pass rewrote it (the recall leg of the compaction fidelity
 * pipeline). Stored on `AgentState.compactionArchive`; read only by
 * `recall_context` results, which are budgeted per call — the archive itself
 * never enters the model context. Shape lives in `common` because both the
 * persisted session state (common) and the runtime archiver/recaller
 * (agent-runtime) consume it.
 */
export type ContextArchiveSnapshot = {
  archivedAt: number
  action: 'semantic_compaction' | 'mechanical_trim'
  /** Steps the caller pinned from eviction at archive time. */
  keepRecentSteps: number
  messages: Message[]
}
