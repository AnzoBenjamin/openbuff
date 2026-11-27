import type {
  ContextArchiveBody,
  ContextArchiveMessageProvenance,
  ContextArchiveSnapshot,
} from '@codebuff/common/types/context-archive'
import type { AgentState } from '@codebuff/common/types/session-state'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import {
  createContextArchiveBody,
  contextArchiveBodyReference,
  isContextArchiveBody,
  isContextArchiveBodyPointer,
  DEFAULT_CONTEXT_ARCHIVE_MAX_BYTES,
  DEFAULT_CONTEXT_ARCHIVE_TTL_MS,
} from '@codebuff/common/util/context-archive-body'
import { isEvictedToolResult } from './tool-result-eviction'

export type ArchiveState = Pick<
  AgentState,
  | 'runId'
  | 'compactionArchive'
  | 'contextArchiveBodies'
  | 'contextArchiveRetention'
>

export const archiveToolText = (message: ToolMessage): string =>
  message.content
    .map((part) =>
      part.type === 'json'
        ? typeof part.value === 'string'
          ? part.value
          : JSON.stringify(part.value)
        : '[media]',
    )
    .join(' ')

/** Snapshot text remains capped; only this dictionary captures originals before loss. */
export function captureArchiveOriginals(
  state: ArchiveState,
  snapshot: ContextArchiveSnapshot,
  originals: Message[],
): {
  snapshot: ContextArchiveSnapshot
  bodies: Record<string, ContextArchiveBody>
} {
  const bodies = { ...state.contextArchiveBodies }
  let addedBytes = Object.values(bodies).reduce(
    (sum, body) => sum + (body?.utf8Bytes ?? 0),
    0,
  )
  const provenance = originals.map(
    (message, index): ContextArchiveMessageProvenance => {
      const step = snapshot.steps?.[index] ?? index + (snapshot.stepBase ?? 0)
      if (message.role !== 'tool')
        return { kind: 'unknown', step, sourceRunId: state.runId }
      const prior = (state.compactionArchive ?? [])
        .flatMap((entry) => entry.provenance ?? [])
        .filter(
          (entry) => entry.toolCallId === message.toolCallId && entry.body,
        )
      const pointer =
        isEvictedToolResult(message) ||
        message.content.some(
          (part) =>
            part.type === 'json' && isContextArchiveBodyPointer(part.value),
        )
      const text = archiveToolText(message)
      const source =
        prior.find((entry) => entry.sourceRunId === state.runId) ??
        (new Set(prior.map((entry) => entry.sourceRunId)).size === 1 && pointer
          ? prior[0]
          : undefined)
      const base = {
        step: source?.step ?? step,
        toolCallId: message.toolCallId,
        sourceRunId: source?.sourceRunId ?? state.runId,
        capturedAt: source?.capturedAt ?? snapshot.archivedAt,
      }
      if (pointer)
        return {
          ...base,
          kind: 'pointer',
          body: source?.body,
          conflict: source?.conflict,
        }
      if (
        message.content.some((part) => part.type !== 'json') ||
        text.endsWith('…[truncated in archive]')
      )
        return { ...base, kind: 'unknown' }
      if (Buffer.byteLength(text, 'utf8') > DEFAULT_CONTEXT_ARCHIVE_MAX_BYTES)
        return { ...base, kind: 'excerpt' }
      const body = createContextArchiveBody(text)
      if (!isContextArchiveBody(body)) return { ...base, kind: 'unknown' }
      if (source?.body && source.body.sha256 !== body.sha256)
        return { ...base, kind: 'unknown', body: source.body, conflict: true }
      if (!bodies[body.bodyId]) {
        if (addedBytes + body.utf8Bytes > DEFAULT_CONTEXT_ARCHIVE_MAX_BYTES)
          return { ...base, kind: 'excerpt' }
        bodies[body.bodyId] = body
        addedBytes += body.utf8Bytes
      }
      const stored = snapshot.messages[index]
      const storedText = stored.role === 'tool' ? archiveToolText(stored) : ''
      const prefix = storedText.endsWith('…[truncated in archive]')
        ? storedText.slice(0, -'…[truncated in archive]'.length)
        : storedText
      return {
        ...base,
        kind: storedText === text ? 'original' : 'excerpt',
        body: contextArchiveBodyReference(body),
        retainedRange: text.startsWith(prefix)
          ? { startByte: 0, endByte: Buffer.byteLength(prefix, 'utf8') }
          : undefined,
      }
    },
  )
  return { snapshot: { ...snapshot, runId: state.runId, provenance }, bodies }
}

/** Publish refs and GC together; a protected-overcapacity insertion leaves the prior state intact. */
export function publishArchiveState(
  state: ArchiveState,
  snapshots: ContextArchiveSnapshot[],
  supplied: Record<string, ContextArchiveBody>,
): boolean {
  const before = state.compactionArchive ?? []
  const collect = (entries: ContextArchiveSnapshot[]) => {
    const ids = new Set(
      entries.flatMap(
        (snapshot) =>
          snapshot.provenance?.flatMap((entry) =>
            entry.body ? [entry.body.bodyId] : [],
          ) ?? [],
      ),
    )
    return Object.fromEntries(
      Object.entries(supplied).filter(([id]) => ids.has(id)),
    )
  }
  let kept = [...snapshots],
    bodies = collect(kept),
    dropped = 0
  const charge = () =>
    Buffer.byteLength(JSON.stringify(kept), 'utf8') +
    Object.values(bodies).reduce(
      (sum, body) =>
        sum +
        body.utf8Bytes +
        Buffer.byteLength(JSON.stringify(contextArchiveBodyReference(body))),
      0,
    )
  while (charge() > DEFAULT_CONTEXT_ARCHIVE_MAX_BYTES) {
    const index = kept.findIndex((snapshot) => !snapshot.pinned)
    if (index < 0) {
      state.contextArchiveRetention = {
        schemaVersion: 1,
        status: 'retention-capacity',
        mode: 'rolling',
        maxBytes: DEFAULT_CONTEXT_ARCHIVE_MAX_BYTES,
        logicalBytes: charge(),
        retainedSnapshots: before.length,
        retainedBodies: Object.keys(state.contextArchiveBodies ?? {}).length,
        droppedSnapshots: 0,
        expiredSnapshots: 0,
        reasons: ['protected-hot-archive-overcapacity'],
      }
      return false
    }
    kept.splice(index, 1)
    dropped++
    bodies = collect(kept)
  }
  state.compactionArchive = kept
  state.contextArchiveBodies = bodies
  if (dropped)
    state.contextArchiveRetention = {
      schemaVersion: 1,
      status: 'cutoff',
      mode: 'rolling',
      maxBytes: DEFAULT_CONTEXT_ARCHIVE_MAX_BYTES,
      logicalBytes: charge(),
      retainedSnapshots: kept.length,
      retainedBodies: Object.keys(bodies).length,
      droppedSnapshots: dropped,
      expiredSnapshots: 0,
      reasons: ['hot-archive-byte-quota'],
    }
  return true
}

export type SelectedArchiveOriginal = {
  body: ContextArchiveBody
  provenance: ContextArchiveMessageProvenance
  snapshot: ContextArchiveSnapshot
  index: number
}

/** Known originals outrank newer pointers/excerpts; conflicting or ambiguous identities fail closed. */
export function selectArchiveOriginal(
  archive: ContextArchiveSnapshot[],
  toolCallId: string,
  options: {
    bodies?: Record<string, ContextArchiveBody>
    sourceRunId?: string
    now?: number
  },
):
  | SelectedArchiveOriginal
  | {
      status: 'corrupt' | 'ambiguous' | 'expired' | 'unavailable'
      reason: string
    }
  | undefined {
  const candidates = archive.flatMap((snapshot) =>
    snapshot.messages.flatMap((message, index) => {
      const provenance = snapshot.provenance?.[index]
      if (
        !provenance ||
        provenance.toolCallId !== toolCallId ||
        !provenance.body ||
        (options.sourceRunId !== undefined &&
          (provenance.sourceRunId ?? snapshot.runId) !== options.sourceRunId)
      )
        return []
      return [{ snapshot, index, provenance }]
    }),
  )
  if (!candidates.length) return undefined
  if (
    new Set(
      candidates.map(
        (entry) => entry.provenance.sourceRunId ?? entry.snapshot.runId ?? '',
      ),
    ).size > 1
  )
    return {
      status: 'ambiguous',
      reason:
        'This call ID exists in multiple source runs; supply sourceRunId.',
    }
  if (
    candidates.some((entry) => entry.provenance.conflict) ||
    new Set(candidates.map((entry) => entry.provenance.body!.sha256)).size > 1
  )
    return {
      status: 'corrupt',
      reason:
        'Conflicting immutable originals exist for this source-run/call identity.',
    }
  const selected =
    candidates.find((entry) => entry.provenance.kind === 'original') ??
    candidates[0]
  const reference = selected.provenance.body!
  if (
    options.now !== undefined &&
    !candidates.some(
      (entry) =>
        (entry.snapshot.expiresAt === undefined ||
          entry.snapshot.expiresAt > options.now!) &&
        (entry.snapshot.pinned ||
          (entry.provenance.capturedAt ?? entry.snapshot.archivedAt) +
            DEFAULT_CONTEXT_ARCHIVE_TTL_MS >
            options.now!),
    )
  )
    return {
      status: 'expired',
      reason:
        'The original is outside the retained lifetime; a pointer cannot renew it.',
    }
  let body = options.bodies?.[reference.bodyId]
  if (!body) {
    // Compatibility with callers carrying only snapshots: recover only a proven full representation, never an excerpt or pointer.
    const full = candidates.find(
      (entry) =>
        entry.provenance.kind === 'original' &&
        entry.snapshot.messages[entry.index].role === 'tool',
    )
    if (full)
      body = createContextArchiveBody(
        archiveToolText(full.snapshot.messages[full.index] as ToolMessage),
      )
  }
  if (!body)
    return {
      status: 'unavailable',
      reason:
        'Only a reference/excerpt remains locally; retrieve the retained original from the host archive.',
    }
  if (
    !isContextArchiveBody(body) ||
    body.sha256 !== reference.sha256 ||
    body.bodyId !== reference.bodyId ||
    body.utf8Bytes !== reference.utf8Bytes
  )
    return {
      status: 'corrupt',
      reason: 'The original text does not match its immutable body reference.',
    }
  return { ...selected, body }
}
