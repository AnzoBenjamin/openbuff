import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type { ContextArchiveSnapshot } from '@codebuff/common/types/context-archive'

export type { ContextArchiveSnapshot }

/**
 * Durable capped archive of the transcript as it existed immediately before a
 * compaction pass rewrote it — the RECALL leg of the fidelity pipeline. The
 * extraction layer (knowledge memory) and eviction tombstones lose information
 * by design; this archive makes that loss recoverable via `recall_context`.
 * Never enters the model context directly; captures are keyed by array
 * IDENTITY so re-settling the same array is a no-op. D26 supersedes the old
 * "eviction is deliberately NOT archived" decision:
 * `archiveEvictedToolResults` now records tombstoned tool-result segments as
 * bounded, identity-keyed `tool_result_eviction` snapshots carrying the FULL
 * original content plus step provenance, so a stale tombstone no longer means
 * unrecoverable detail. Semantic passes, the mechanical trim, and evictions
 * all archive, because those rewrites have no other recovery path.
 */
export const MAX_ARCHIVE_SNAPSHOTS = 8
/**
 * D26 recall honesty: eviction snapshots carry the ORIGINAL (pre-tombstone)
 * tool-result bodies, so they get their OWN dedicated snapshot cap instead of
 * sharing MAX_ARCHIVE_SNAPSHOTS with semantic/mechanical snapshots. Sharing
 * the 8-snapshot cap let routine compaction passes evict eviction records
 * before recall ever ran. The eviction cap applies ONLY to
 * `tool_result_eviction` snapshots (dropped oldest-first when it overflows);
 * semantic/mechanical snapshots keep their own MAX_ARCHIVE_SNAPSHOTS cap and
 * oldest-dropped-first ordering unchanged.
 */
export const MAX_EVICTION_ARCHIVE_SNAPSHOTS = 16
export const MAX_ARCHIVE_MESSAGES = 200
export const MAX_ARCHIVE_MESSAGE_CHARS = 4_000
/**
 * D26 recall honesty: per-message truncation bound for EVICTION snapshots.
 * The default MAX_ARCHIVE_MESSAGE_CHARS (4k) contradicted the full-content
 * recall claim for evicted tool results — the tombstone leaves no other copy
 * of the body, so a 4k clip destroyed most of the recallable content.
 * Eviction snapshots therefore persist bodies up to this larger bound.
 * Semantic/mechanical snapshots keep the 4k bound unchanged.
 */
export const EVICTION_ARCHIVE_MESSAGE_CHARS = 64_000
export const RECALL_MAX_RESULTS = 6
export const RECALL_SNIPPET_CHARS = 600

const truncateWithCap = (value: string, maxChars: number): string =>
  value.length <= maxChars
    ? value
    : value.slice(0, maxChars) + '…[truncated in archive]'

const truncate = (value: string): string =>
  truncateWithCap(value, MAX_ARCHIVE_MESSAGE_CHARS)

const archiveMessageWithCap = (message: Message, maxChars: number): Message => {
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
                ? truncateWithCap(part.value, maxChars)
                : truncateWithCap(JSON.stringify(part.value), maxChars),
          }
        : part,
    ),
  }
}

const archiveMessage = (message: Message): Message =>
  archiveMessageWithCap(message, MAX_ARCHIVE_MESSAGE_CHARS)

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

/**
 * Collision-safe `archivedAt` minting (M3-T4): multiple compaction passes can
 * archive in the same millisecond (e.g. a semantic pass plus a mechanical trim
 * in one iteration), and downstream consumers key coverage and provenance per
 * `archivedAt` value — duplicate timestamps would mark BOTH same-tick
 * snapshots covered off a single consolidation, or report one snapshot's
 * timestamp twice. Monotonic per process: the wall clock when it advances,
 * bumped just past the previous mint on a same-millisecond collision.
 */
let lastMintedArchivedAt = 0
/**
 * A forward clock jump (NTP correction, VM resume) must not permanently
 * inflate the mint: without a bound, one jump makes lastMintedArchivedAt far
 * ahead of the wall clock and every later archive across ALL agent states
 * inherits timestamps minutes/hours ahead of reality, corrupting the
 * archivedAt provenance consumers sort and key coverage by (reliability
 * finding mintarchivedat-shared-monotonic-counter). Detections beyond this
 * window resync to the wall clock; same-millisecond collisions within the
 * window still bump monotonically.
 */
const MAX_MINT_AHEAD_OF_WALL_CLOCK_MS = 5_000
const mintArchivedAt = (now: number): number => {
  if (lastMintedArchivedAt > now + MAX_MINT_AHEAD_OF_WALL_CLOCK_MS) {
    lastMintedArchivedAt = now
  }
  lastMintedArchivedAt = Math.max(lastMintedArchivedAt + 1, now)
  return lastMintedArchivedAt
}

/**
 * Dedicated-cap append (D26 recall honesty): append `snapshot` and cap ONLY
 * the snapshots matched by `isCappedKind` at `keepNewestOfKind`, dropping that
 * kind's OLDEST entries first while leaving every other snapshot untouched
 * (each kind is capped by its own append path). Chronological order is
 * preserved, so an archive containing only the capped kind trims exactly like
 * the historical `.slice(-cap)`.
 */
function appendSnapshotWithDedicatedCap(
  existing: ContextArchiveSnapshot[] | undefined,
  snapshot: ContextArchiveSnapshot,
  isCappedKind: (action: ContextArchiveSnapshot['action']) => boolean,
  keepNewestOfKind: number,
): ContextArchiveSnapshot[] {
  const merged = [...(existing ?? []), snapshot]
  let kindSeen = 0
  const kept: ContextArchiveSnapshot[] = []
  for (let i = merged.length - 1; i >= 0; i--) {
    const entry = merged[i]
    if (isCappedKind(entry.action)) {
      if (kindSeen >= keepNewestOfKind) continue
      kindSeen += 1
    }
    kept.push(entry)
  }
  return kept.reverse()
}

/** Archive a pre-compaction transcript on `agentState`. Identity-keyed. */
export function archivePreCompaction(
  agentState: {
    compactionArchive?: ContextArchiveSnapshot[]
  },
  messages: Message[],
  action: ContextArchiveSnapshot['action'],
  keepRecentSteps: number,
  now?: number,
): void {
  const source = messages
  if (archivedSources.has(source)) return
  const stored = source.slice(-MAX_ARCHIVE_MESSAGES)
  const snapshot: ContextArchiveSnapshot = {
    archivedAt: mintArchivedAt(now ?? Date.now()),
    action,
    keepRecentSteps,
    stepBase: source.length - stored.length,
    messages: stored.map(archiveMessage),
  }
  // Semantic/mechanical snapshots keep their historical MAX_ARCHIVE_SNAPSHOTS
  // cap and oldest-dropped-first ordering; eviction snapshots are NOT counted
  // against it (they have their own MAX_EVICTION_ARCHIVE_SNAPSHOTS cap), so a
  // routine compaction pass can no longer evict eviction records.
  agentState.compactionArchive = appendSnapshotWithDedicatedCap(
    agentState.compactionArchive,
    snapshot,
    (snapshotAction) => snapshotAction !== 'tool_result_eviction',
    MAX_ARCHIVE_SNAPSHOTS,
  )
  archivedSources.add(source)
}

/** D26: why-clause stored on every `tool_result_eviction` snapshot. */
export const EVICTION_ARCHIVE_REASON =
  'deterministic tool-result eviction (stale recency)'

/**
 * D26: archive tombstoned tool-result segments as recoverable records
 * (content + provenance + eviction reason), bounded per run.
 *
 * Mirrors `archivePreCompaction` exactly where it matters: identity-keyed (a
 * toolCallId already recorded in an earlier `tool_result_eviction` snapshot is
 * skipped), the same append-new/shift-old discipline (the OLDEST eviction
 * snapshot is dropped when MAX_EVICTION_ARCHIVE_SNAPSHOTS would overflow,
 * never a semantic/mechanical snapshot), and the same collision-safe
 * `mintArchivedAt` timestamp threading. Bounded persisted size: at most
 * MAX_ARCHIVE_MESSAGES entries per snapshot (newest kept), and each archived
 * body routed through `archiveMessageWithCap` at the DEDICATED
 * EVICTION_ARCHIVE_MESSAGE_CHARS (64k) bound — larger than the 4k bound the
 * other snapshots use, because the evictor's tombstone leaves no other copy
 * of the body and the D26 recall claim is only honest if most of it survives.
 * In-memory only (on `agentState.compactionArchive`); no I/O.
 */
export function archiveEvictedToolResults(
  agentState: {
    compactionArchive?: ContextArchiveSnapshot[]
  },
  evicted: Array<{
    toolCallId: string
    toolName: string
    content: ToolMessage['content']
    stepIndex: number
  }>,
  now?: number,
): void {
  if (evicted.length === 0) return
  const existing = agentState.compactionArchive ?? []
  const archivedCallIds = new Set<string>()
  for (const snapshot of existing) {
    if (snapshot.action !== 'tool_result_eviction') continue
    for (const message of snapshot.messages) {
      if (message.role === 'tool') archivedCallIds.add(message.toolCallId)
    }
  }
  const fresh = evicted.filter((entry) => !archivedCallIds.has(entry.toolCallId))
  if (fresh.length === 0) return
  // Same per-snapshot message cap as `archivePreCompaction` (newest entries
  // win); only the per-message CHAR bound differs (see
  // EVICTION_ARCHIVE_MESSAGE_CHARS).
  const bounded = fresh.slice(-MAX_ARCHIVE_MESSAGES)
  const snapshot: ContextArchiveSnapshot = {
    archivedAt: mintArchivedAt(now ?? Date.now()),
    action: 'tool_result_eviction',
    // Eviction snapshots are not tied to a recency window of the archive
    // itself; provenance lives in `steps` instead.
    keepRecentSteps: 0,
    steps: bounded.map((entry) => entry.stepIndex),
    reason: EVICTION_ARCHIVE_REASON,
    // Routed through `archiveMessageWithCap` at the eviction-specific bound:
    // the tombstone left no other copy of these bodies, so the D26 recall
    // claim needs the larger EVICTION_ARCHIVE_MESSAGE_CHARS truncation.
    messages: bounded
      .map(
        (entry): Message => ({
          role: 'tool',
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          content: entry.content,
        }),
      )
      .map((message) =>
        archiveMessageWithCap(message, EVICTION_ARCHIVE_MESSAGE_CHARS),
      ),
  }
  // Eviction snapshots cap at their DEDICATED MAX_EVICTION_ARCHIVE_SNAPSHOTS
  // (oldest eviction snapshot dropped first); semantic/mechanical snapshots
  // in the same archive are untouched (they cap at MAX_ARCHIVE_SNAPSHOTS via
  // their own append path).
  agentState.compactionArchive = appendSnapshotWithDedicatedCap(
    existing,
    snapshot,
    (snapshotAction) => snapshotAction === 'tool_result_eviction',
    MAX_EVICTION_ARCHIVE_SNAPSHOTS,
  )
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
 * Original-transcript step number for an archived tool message. D26
 * `tool_result_eviction` snapshots carry a parallel `steps` array holding the
 * ORIGINAL-transcript step of each archived tool message — reporting the
 * slice-local index would misstate provenance for archived evictions. Every
 * other snapshot (and legacy eviction snapshots without `steps`) falls back
 * to `stepBase`-based slice-local numbering, per the documented contract.
 */
export const stepProvenance = (
  snapshot: ContextArchiveSnapshot,
  index: number,
): number => {
  if (
    snapshot.action === 'tool_result_eviction' &&
    Array.isArray(snapshot.steps) &&
    typeof snapshot.steps[index] === 'number'
  ) {
    return snapshot.steps[index]
  }
  return index + (snapshot.stepBase ?? 0)
}

/**
 * Query the archive: case-insensitive whole-word terms, ALL of which must
 * appear in a result's text (AND semantics). Scans EVERY snapshot regardless
 * of `action`: `tool_result_eviction` snapshots (D26) are first-class recall
 * sources and share this same bounded-snippet scanner. Newest snapshots win. Returns
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
  // snapshotsSearched must report the scan's ACTUAL progress, not the archive
  // length: an early exit (result cap hit) stops mid-archive, so only the
  // snapshots actually visited count as searched.
  let snapshotsSearched = 0
  for (const snapshot of [...archive].reverse()) {
    snapshotsSearched += 1
    for (let i = snapshot.messages.length - 1; i >= 0; i--) {
      if (matches.length >= RECALL_MAX_RESULTS) {
        return {
          matches,
          snapshotsSearched,
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
        // D26 `tool_result_eviction` snapshots carry the per-message original
        // step in their parallel `steps` array — slice-local indices there
        // would misreport provenance.
        step: stepProvenance(snapshot, i),
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        snippet: text.slice(start, start + RECALL_SNIPPET_CHARS),
      })
    }
  }
  const archivedAt = [...archive].reverse().map((s) => s.archivedAt)
  return {
    matches,
    snapshotsSearched,
    archivedAt,
  }
}