import type { ContextArchiveSnapshot } from './context-archive'

/**
 * One background LLM consolidation of archived pre-compaction snapshots
 * (prototype leg of the compaction fidelity pipeline, canary-gated). Where
 * `recall_context` recovers VERBATIM snippets from
 * `AgentState.compactionArchive`, a consolidation is a bounded SUMMARY the
 * background consolidator child wrote over one or more archived snapshots —
 * cheaper to surface than raw snippets when the agent needs the gist of what
 * a compaction pass removed. Stored on `AgentState.contextConsolidations`;
 * read by `recall_context` results (budgeted per call). The archive itself is
 * never consumed by the model directly.
 */
export type ContextConsolidation = {
  consolidatedAt: number
  /** `archivedAt` of every source snapshot contributing to this summary. */
  sourceArchivedAts: number[]
  action: ContextArchiveSnapshot['action']
  /** Bounded LLM-written summary; keyword-searchable, identifiers verbatim. */
  summary: string
  /** Total snapshot messages the summary input was built from. */
  coveredMessages: number
}
