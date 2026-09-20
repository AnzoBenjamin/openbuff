import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ContextArchiveSnapshot } from '@codebuff/common/types/context-archive'

export type { ContextArchiveSnapshot }

/**
 * Durable capped archive of the transcript as it existed immediately before a
 * compaction pass rewrote it — the RECALL leg of the fidelity pipeline. The
 * extraction layer (knowledge memory) and eviction tombstones lose information
 * by design; this archive makes that loss recoverable via `recall_context`.
 * Never enters the model context directly; captures are keyed by array
 * IDENTITY so re-settling the same array is a no-op. Eviction is deliberately
 * NOT archived (tombstones already instruct a tool re-run; fresh reads beat
 * stale bodies). Only semantic passes and the mechanical trim archive,
 * because those rewrites have no other recovery path.
 */
export const MAX_ARCHIVE_SNAPSHOTS = 8
export const MAX_ARCHIVE_MESSAGES = 200
export const MAX_ARCHIVE_MESSAGE_CHARS = 4_000
export const RECALL_MAX_RESULTS = 6
export const RECALL_SNIPPET_CHARS = 600

const truncate = (value: string): string =>
  value.length <= MAX_ARCHIVE_MESSAGE_CHARS
    ? value
    : value.slice(0, MAX_ARCHIVE_MESSAGE_CHARS) + '…[truncated in archive]'

const archiveMessage = (message: Message): Message => {
  if (message.role !== 'tool') return message
  const tool = message
  return {
    ...tool,
    content: tool.content.map((part) =>
      part.type === 'json'
        ? {
            ...part,
            value:
              typeof part.value === 'string'
                ? truncate(part.value)
                : truncate(JSON.stringify(part.value)),
          }
        : part,
    ),
  }
}

/**
 * Within-process identity dedupe: the same pre-compaction array settling
 * twice archives once. A module-level WeakSet rather than a snapshot-field
 * comparison because snapshots store MAPPED copies (truncation pass), never
 * the source reference itself. Serialized sessions reload into fresh arrays
 * anyway, so a missed dedupe after a reload is at worst a duplicate snapshot
 * — an optimization gap, never a correctness issue. Weak keys mean evicted
 * snapshots and dead transcripts are collectable.
 */
const archivedSources = new WeakSet<Message[]>()

/** Archive a pre-compaction transcript on `agentState`. Identity-keyed. */
export function archivePreCompaction(
  agentState: {
    compactionArchive?: ContextArchiveSnapshot[]
  },
  messages: Message[],
  action: ContextArchiveSnapshot['action'],
  keepRecentSteps: number,
): void {
  const source = messages
  if (archivedSources.has(source)) return
  const stored = source.slice(-MAX_ARCHIVE_MESSAGES)
  const snapshot: ContextArchiveSnapshot = {
    archivedAt: Date.now(),
    action,
    keepRecentSteps,
    stepBase: source.length - stored.length,
    messages: stored.map(archiveMessage),
  }
  agentState.compactionArchive = [
    ...(agentState.compactionArchive ?? []),
    snapshot,
  ].slice(-MAX_ARCHIVE_SNAPSHOTS)
  archivedSources.add(source)
}

export type RecallContextResult = {
  matches: Array<{ step: number; toolName: string; toolCallId: string; snippet: string }>
  snapshotsSearched: number
  /** Archive timestamps, newest first — the same order matches return in. */
  archivedAt: number[]
}

const toText = (message: Message): string => {
  if (message.role !== 'tool') return ''
  return message.content
    .map((part) =>
      part.type === 'json' ? JSON.stringify(part.value) : '[media]',
    )
    .join(' ')
}

/**
 * Query the archive: case-insensitive whole-word terms, ALL of which must
 * appear in a result's text (AND semantics). Newest snapshots win. Returns
 * bounded snippets plus provenance (archive timestamps) so the caller knows
 * the content is PRE-COMPACTION and possibly stale — verify against live
 * files before acting on it.
 */
export function recallFromArchive(
  archive: ContextArchiveSnapshot[] | undefined,
  query: string,
): RecallContextResult {
  const empty: RecallContextResult = {
    matches: [],
    snapshotsSearched: 0,
    archivedAt: [],
  }
  if (!archive || archive.length === 0) return empty
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (terms.length === 0) return empty

  const matches: RecallContextResult['matches'] = []
  for (const snapshot of [...archive].reverse()) {
    for (let i = snapshot.messages.length - 1; i >= 0; i--) {
      if (matches.length >= RECALL_MAX_RESULTS) {
        return {
          matches,
          snapshotsSearched: archive.length,
          archivedAt: [...archive].reverse().map((s) => s.archivedAt),
        }
      }
      const message = snapshot.messages[i]
      if (message.role !== 'tool') continue
      const text = toText(message)
      const lowered = text.toLowerCase()
      if (!terms.every((term) => lowered.includes(term))) continue
      const first = Math.min(
        ...terms.map((term) => lowered.indexOf(term)),
      )
      const start = Math.max(0, first - 120)
      matches.push({
        // Original-transcript step number, not the index within the archived
        // slice (they differ once the snapshot cap trims the oldest messages).
        step: i + (snapshot.stepBase ?? 0),
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        snippet: text.slice(start, start + RECALL_SNIPPET_CHARS),
      })
    }
  }
  const archivedAt = [...archive].reverse().map((s) => s.archivedAt)
  return {
    matches,
    snapshotsSearched: archive.length,
    archivedAt,
  }
}