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
  /**
   * Index of the first message of `messages` within the ORIGINAL transcript
   * (0 when the whole history fit in the snapshot cap). `step` provenance in
   * `recall_context` results is this base plus the index within the stored
   * slice, so the reported step numbers refer to the original transcript
   * rather than the archived slice. Optional so earlier serialized snapshots
   * keep parsing; absent falls back to slice-local numbering.
   */
  stepBase?: number
  messages: Message[]
}
