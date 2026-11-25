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
  /** Original run provenance when hydrated into a different conversation. */
  runId?: string
  /** Durable identity independent of timestamp collisions. */
  snapshotId?: string
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
  /** Parallel, explicit fullness/source metadata; missing legacy metadata is unknown. */
  provenance?: ContextArchiveMessageProvenance[]
  /** Operator-selected retention only; pins protect the transitive body closure. */
  pinned?: boolean
  expiresAt?: number
}

/** Hashes describe recalled UTF-8 text, not the serialized message-content digest. */
export type ContextArchiveBodyReference = {
  bodyId: string
  sha256: string
  utf8Bytes: number
}

export interface ContextArchiveBody extends ContextArchiveBodyReference {
  text: string
}

export type ContextArchiveMessageProvenance = {
  kind: 'original' | 'excerpt' | 'pointer' | 'unknown'
  sourceRunId?: string
  toolCallId?: string
  step: number
  capturedAt?: number
  body?: ContextArchiveBodyReference
  retainedRange?: { startByte: number; endByte: number }
  /** Conflicting originals cannot be resolved by choosing the newest copy. */
  conflict?: boolean
}

export interface ContextArchiveRetentionPolicy {
  mode: 'rolling' | 'keep-until-delete'
  maxBytes?: number
  ttlMs?: number
  maxSnapshots?: number
}

export interface ContextArchiveRetentionReceipt {
  schemaVersion: 1
  status: 'ok' | 'cutoff' | 'retention-capacity'
  mode: ContextArchiveRetentionPolicy['mode']
  logicalBytes: number
  retainedSnapshots: number
  retainedBodies: number
  droppedSnapshots: number
  expiredSnapshots: number
  cutoffArchivedAt?: number
  maxBytes?: number
  ttlMs?: number
  reasons?: string[]
  /** Allocated storage overhead is separate from the logical retention charge. */
  sqliteBytes?: number
  walBytes?: number
}

export interface ContextArchiveBodyPageRequest {
  toolCallId: string
  sourceRunId?: string
  expectedSha256?: string
  offsetBytes?: number
  maxBytes?: number
}

export type ContextArchiveBodyPageOutcome =
  | {
      status: 'ok'
      runId: string
      step: number
      toolName: string
      toolCallId: string
      bodyId: string
      sha256: string
      utf8Bytes: number
      startByte: number
      endByte: number
      nextOffset: number | null
      text: string
      retention?: ContextArchiveRetentionReceipt
    }
  | {
      status:
        | 'missing'
        | 'expired'
        | 'ambiguous'
        | 'corrupt'
        | 'unavailable'
        | 'invalid-cursor'
      reason: string
      retention?: ContextArchiveRetentionReceipt
    }
