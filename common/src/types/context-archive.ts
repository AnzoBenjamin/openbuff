import type { Message } from './messages/codebuff-message'

/**
 * One capped snapshot of the transcript as it existed immediately before a
 * compaction pass rewrote it (the recall leg of the compaction fidelity
 * pipeline). Stored on `AgentState.compactionArchive`; read only by
 * `recall_context` results, which are budgeted per call — the archive itself
 * never enters the model context. Shape lives in `common` because both the
 * persisted session state (common) and the runtime archiver/recaller
 * (agent-runtime) consume it.
 *
 * D26: `tool_result_eviction` snapshots record evicted tool-result segments
 * and carry the ORIGINAL (pre-tombstone) content — in contrast to pre-
 * compaction full-transcript archives, whose tool bodies the runtime
 * truncation caps may trim — because the evictor's tombstone leaves no other
 * copy of the body. They honor the SAME persisted-size contract as every
 * snapshot on `AgentState.compactionArchive` (8 snapshots × 200 messages ×
 * 4k chars per message): per-message truncation applies on write.
 */
export type ContextArchiveSnapshot = {
  archivedAt: number
  action: 'semantic_compaction' | 'mechanical_trim' | 'tool_result_eviction'
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
  /**
   * D26 (`tool_result_eviction` snapshots only): parallel array to `messages`
   * giving the ORIGINAL-transcript step number of each archived tool message
   * — provenance for when the content was produced. Optional so earlier
   * serialized snapshots keep parsing.
   */
  steps?: number[]
  /**
   * D26 (`tool_result_eviction` snapshots only): why the segment was archived,
   * e.g. 'deterministic tool-result eviction (stale recency)'. Optional so
   * earlier serialized snapshots keep parsing.
   */
  reason?: string
  messages: Message[]
}
