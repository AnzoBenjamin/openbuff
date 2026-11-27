import type { Database } from 'bun:sqlite'
import type {
  ContextArchiveBody,
  ContextArchiveBodyPageOutcome,
  ContextArchiveBodyPageRequest,
  ContextArchiveRetentionPolicy,
  ContextArchiveRetentionReceipt,
} from '../../../../common/src/types/context-archive'
import {
  DEFAULT_CONTEXT_ARCHIVE_MAX_BYTES,
  DEFAULT_CONTEXT_ARCHIVE_MAX_SNAPSHOTS,
  DEFAULT_CONTEXT_ARCHIVE_TTL_MS,
  isContextArchiveBody,
  pageContextArchiveBody,
  createContextArchiveBody,
} from '../../../../common/src/util/context-archive-body'
import {
  archiveSnapshotId,
  collectArchiveOrphans,
  archiveFtsAvailable,
  disableArchiveFtsTriggers,
  readArchiveSnapshot,
  prepareArchiveSnapshot,
  type PreparedArchiveSnapshot,
  type ArchiveManifestRow,
} from './context-archive-store'

export const ARCHIVE_ORIGINAL_DDL = `
CREATE TABLE IF NOT EXISTS context_archive_original_bodies (
 body_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, utf8_bytes INTEGER NOT NULL, text TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS context_archive_originals (
 run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, body_id TEXT NOT NULL,
 captured_at REAL NOT NULL, step INTEGER NOT NULL, tool_name TEXT NOT NULL,
 retired_reason TEXT, PRIMARY KEY(run_id,tool_call_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS context_archive_original_refs (
 snapshot_id TEXT NOT NULL REFERENCES context_archive_snapshots(snapshot_id) ON DELETE CASCADE,
 msg_index INTEGER NOT NULL, run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
 body_id TEXT NOT NULL REFERENCES context_archive_original_bodies(body_id),
 PRIMARY KEY(snapshot_id,msg_index), FOREIGN KEY(run_id,tool_call_id) REFERENCES context_archive_originals(run_id,tool_call_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS context_archive_original_refs_source ON context_archive_original_refs(run_id,tool_call_id);
CREATE INDEX IF NOT EXISTS context_archive_original_refs_body ON context_archive_original_refs(body_id);
CREATE TABLE IF NOT EXISTS context_archive_cutoffs (
 run_id TEXT PRIMARY KEY, archived_at REAL NOT NULL, reason TEXT NOT NULL
) WITHOUT ROWID;
`

export class ArchiveInputError extends Error {}
export class ArchiveCapacityError extends Error {}

export function captureArchiveRetention(
  input?: ContextArchiveRetentionPolicy,
): Readonly<ContextArchiveRetentionPolicy> {
  const selected = input ? { ...input } : { mode: 'rolling' as const }
  if (!['rolling', 'keep-until-delete'].includes(selected.mode))
    throw new ArchiveInputError('Unknown archive retention mode.')
  for (const [key, value] of Object.entries(selected)) {
    if (key === 'mode') continue
    if (
      !['maxBytes', 'ttlMs', 'maxSnapshots'].includes(key) ||
      !Number.isSafeInteger(value) ||
      (value as number) < 1
    )
      throw new ArchiveInputError(
        'Archive retention limits must be positive safe integers.',
      )
  }
  if (selected.mode === 'keep-until-delete') {
    if (
      selected.maxBytes !== undefined ||
      selected.ttlMs !== undefined ||
      selected.maxSnapshots !== undefined
    )
      throw new ArchiveInputError(
        'Keep-until-delete is unbounded aggregate retention, not a rolling quota.',
      )
    return Object.freeze(selected)
  }
  return Object.freeze({
    mode: 'rolling',
    maxBytes: selected.maxBytes ?? DEFAULT_CONTEXT_ARCHIVE_MAX_BYTES,
    ttlMs: selected.ttlMs ?? DEFAULT_CONTEXT_ARCHIVE_TTL_MS,
    maxSnapshots:
      selected.maxSnapshots ?? DEFAULT_CONTEXT_ARCHIVE_MAX_SNAPSHOTS,
  })
}

type OriginalRow = {
  run_id: string
  tool_call_id: string
  body_id: string
  captured_at: number
  step: number
  tool_name: string
  retired_reason: string | null
}
const textOf = (content: unknown): string | undefined => {
  if (!Array.isArray(content) || content.some((part) => part?.type !== 'json'))
    return undefined
  return content
    .map((part) =>
      typeof part.value === 'string' ? part.value : JSON.stringify(part.value),
    )
    .join(' ')
}

import type { ContextArchiveSnapshot } from '../../../../common/src/types/context-archive'

/** A supplied verified body has one physical full-text copy; snapshot rows retain only its immutable reference. */
export function prepareOriginalArchiveSnapshot(
  snapshot: ContextArchiveSnapshot,
): PreparedArchiveSnapshot | null {
  const prepared = prepareArchiveSnapshot(snapshot)
  if (!prepared || !snapshot.provenance) return prepared
  const projected: ContextArchiveSnapshot = {
    ...snapshot,
    snapshotId: undefined,
    messages: snapshot.messages.map((message, index) => {
      const provenance = snapshot.provenance![index],
        reference = provenance.body
      if (message.role !== 'tool' || !reference) return message
      const content = textOf(message.content)
      if (
        provenance.kind === 'original' &&
        (content === undefined ||
          createContextArchiveBody(content).sha256 !== reference.sha256)
      )
        throw new ArchiveInputError(
          'A declared full original does not match its immutable UTF-8 text reference.',
        )
      return {
        ...message,
        content: [
          {
            type: 'json' as const,
            value: {
              kind: 'context_archive_body_reference',
              version: 1,
              toolCallId: message.toolCallId,
              sourceRunId: provenance.sourceRunId ?? snapshot.runId ?? '',
              bodyId: reference.bodyId,
              sha256: reference.sha256,
              utf8Bytes: reference.utf8Bytes,
            },
          },
        ],
      }
    }),
    provenance: snapshot.provenance.map((provenance) =>
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
  }
  return prepareArchiveSnapshot(projected)
}

export function archiveRetentionReceipt(
  database: Database,
  policy: Readonly<ContextArchiveRetentionPolicy>,
  counts: { dropped?: number; expired?: number; capacity?: boolean } = {},
): ContextArchiveRetentionReceipt {
  const value = (sql: string) => (database.query(sql).get() as { n: number }).n
  // Logical payload: content-addressed objects are charged once; referenced metadata is charged separately.
  const logicalBytes =
    value(
      `SELECT coalesce(sum(length(CAST(body AS BLOB))+length(content_digest)),0) n FROM context_archive_bodies`,
    ) +
    value(
      `SELECT coalesce(sum(length(CAST(header_json AS BLOB))+length(message_id)+length(content_digest)),0) n FROM context_archive_messages`,
    ) +
    value(
      `SELECT coalesce(sum(length(snapshot_id)+length(run_id)+length(action)+length(manifest_hash)+coalesce(length(CAST(reason AS BLOB)),0)+coalesce(length(CAST(steps_json AS BLOB)),0)+coalesce(length(CAST(provenance_json AS BLOB)),0)+64),0) n FROM context_archive_snapshots`,
    ) +
    value(
      `SELECT coalesce(sum(length(snapshot_id)+length(message_id)+16),0) n FROM context_archive_memberships`,
    ) +
    value(
      `SELECT coalesce(sum(length(CAST(text AS BLOB))+length(body_id)+length(sha256)+8),0) n FROM context_archive_original_bodies`,
    ) +
    value(
      `SELECT coalesce(sum(length(run_id)+length(tool_call_id)+length(body_id)+length(tool_name)+coalesce(length(retired_reason),0)+24),0) n FROM context_archive_originals`,
    ) +
    value(
      `SELECT coalesce(sum(length(snapshot_id)+length(run_id)+length(tool_call_id)+length(body_id)+8),0) n FROM context_archive_original_refs`,
    ) +
    value(
      `SELECT coalesce(sum(length(run_id)+length(reason)+8),0) n FROM context_archive_cutoffs`,
    )
  const cutoff = (
    database
      .query('SELECT max(archived_at) n FROM context_archive_cutoffs')
      .get() as { n: number | null }
  ).n
  const dropped = counts.dropped ?? 0,
    expired = counts.expired ?? 0
  const pageCount = (
    database.query('PRAGMA page_count').get() as { page_count: number }
  ).page_count
  const pageSize = (
    database.query('PRAGMA page_size').get() as { page_size: number }
  ).page_size
  return {
    schemaVersion: 1,
    status: counts.capacity
      ? 'retention-capacity'
      : dropped || expired || cutoff !== null
        ? 'cutoff'
        : 'ok',
    mode: policy.mode,
    maxBytes: policy.maxBytes,
    ttlMs: policy.ttlMs,
    logicalBytes,
    retainedSnapshots: value(
      'SELECT count(*) n FROM context_archive_snapshots',
    ),
    retainedBodies: value(
      'SELECT count(*) n FROM context_archive_original_bodies',
    ),
    droppedSnapshots: dropped,
    expiredSnapshots: expired,
    ...(cutoff !== null ? { cutoffArchivedAt: cutoff } : {}),
    sqliteBytes: pageCount * pageSize,
  }
}

export function archiveSnapshotAdmissible(
  database: Database,
  runId: string,
  prepared: PreparedArchiveSnapshot,
  policy: Readonly<ContextArchiveRetentionPolicy>,
  now: number,
): boolean {
  const snapshot = prepared.snapshot,
    id = archiveSnapshotId(runId, prepared)
  if (
    database
      .query('SELECT 1 FROM context_archive_snapshots WHERE snapshot_id=?1')
      .get(id)
  )
    return true
  const cutoff = database
    .query('SELECT archived_at FROM context_archive_cutoffs WHERE run_id=?1')
    .get(runId) as { archived_at: number } | null
  if (cutoff && snapshot.archivedAt <= cutoff.archived_at) return false
  if (
    snapshot.provenance?.some((provenance) => {
      if (!provenance.body || !provenance.toolCallId) return false
      const original = database
        .query(
          'SELECT retired_reason FROM context_archive_originals WHERE run_id=?1 AND tool_call_id=?2',
        )
        .get(provenance.sourceRunId ?? runId, provenance.toolCallId) as {
        retired_reason: string | null
      } | null
      return (
        !!original?.retired_reason ||
        (!snapshot.pinned &&
          policy.mode === 'rolling' &&
          (provenance.capturedAt ?? snapshot.archivedAt) + policy.ttlMs! <= now)
      )
    })
  )
    return false
  return (
    (snapshot.expiresAt === undefined || snapshot.expiresAt > now) &&
    (snapshot.pinned ||
      policy.mode === 'keep-until-delete' ||
      snapshot.archivedAt + policy.ttlMs! > now)
  )
}

/** Called inside the snapshot publication transaction, after the normalized snapshot is inserted. */
export function putArchiveOriginals(
  database: Database,
  runId: string,
  prepared: PreparedArchiveSnapshot,
  supplied: Record<string, ContextArchiveBody> | undefined,
  policy: Readonly<ContextArchiveRetentionPolicy>,
  now: number,
): void {
  const snapshot = prepared.snapshot,
    snapshotId = archiveSnapshotId(runId, prepared)
  snapshot.provenance?.forEach((provenance, index) => {
    if (provenance.conflict)
      throw new ArchiveInputError('Conflicting original result identity.')
    const reference = provenance.body
    if (!reference) {
      if (provenance.kind === 'original')
        throw new ArchiveInputError(
          'Original provenance has no immutable body reference.',
        )
      return
    }
    const message = snapshot.messages[index]
    if (
      message.role !== 'tool' ||
      provenance.toolCallId !== message.toolCallId ||
      !Number.isSafeInteger(provenance.step) ||
      provenance.step < 0
    )
      throw new ArchiveInputError(
        'Original source-call lineage does not match the archived message.',
      )
    const owner = provenance.sourceRunId ?? runId
    const capturedAt = provenance.capturedAt
    if (
      !owner ||
      owner.length > 2048 ||
      !Number.isFinite(capturedAt) ||
      capturedAt! > now + 5000
    )
      throw new ArchiveInputError('Original source/time provenance is invalid.')
    const existing = database
      .query(
        'SELECT * FROM context_archive_originals WHERE run_id=?1 AND tool_call_id=?2',
      )
      .get(owner, message.toolCallId) as OriginalRow | null
    if (existing?.retired_reason)
      throw new ArchiveInputError(
        'Original is past its persisted retention cutoff.',
      )
    if (
      existing &&
      (existing.body_id !== reference.bodyId ||
        existing.step !== provenance.step ||
        existing.tool_name !== message.toolName ||
        existing.captured_at !== capturedAt)
    )
      throw new ArchiveInputError(
        'Conflicting immutable original for one source-run/call identity.',
      )
    const cutoff = database
      .query('SELECT archived_at FROM context_archive_cutoffs WHERE run_id=?1')
      .get(owner) as { archived_at: number } | null
    if (!existing && cutoff && capturedAt! <= cutoff.archived_at)
      throw new ArchiveInputError(
        'An old envelope cannot resurrect a cut-off original.',
      )
    if (
      !snapshot.pinned &&
      policy.mode === 'rolling' &&
      capturedAt! + policy.ttlMs! <= now
    )
      throw new ArchiveInputError('A pointer cannot renew an expired original.')
    const stored = database
      .query(
        'SELECT body_id bodyId,sha256,utf8_bytes utf8Bytes,text FROM context_archive_original_bodies WHERE body_id=?1',
      )
      .get(reference.bodyId) as ContextArchiveBody | null
    const body = supplied?.[reference.bodyId] ?? stored
    if (
      !body ||
      body.utf8Bytes > DEFAULT_CONTEXT_ARCHIVE_MAX_BYTES ||
      !isContextArchiveBody(body) ||
      body.bodyId !== reference.bodyId ||
      body.sha256 !== reference.sha256 ||
      body.utf8Bytes !== reference.utf8Bytes ||
      (stored &&
        (stored.sha256 !== body.sha256 || stored.text !== body.text)) ||
      (provenance.kind === 'original' && textOf(message.content) !== body.text)
    )
      throw new ArchiveInputError('Missing or corrupt original text/reference.')
    database
      .query(
        'INSERT OR IGNORE INTO context_archive_original_bodies(body_id,sha256,utf8_bytes,text) VALUES (?1,?2,?3,?4)',
      )
      .run(body.bodyId, body.sha256, body.utf8Bytes, body.text)
    database
      .query(
        'INSERT OR IGNORE INTO context_archive_originals(run_id,tool_call_id,body_id,captured_at,step,tool_name) VALUES (?1,?2,?3,?4,?5,?6)',
      )
      .run(
        owner,
        message.toolCallId,
        body.bodyId,
        capturedAt!,
        provenance.step,
        message.toolName,
      )
    database
      .query(
        'INSERT OR IGNORE INTO context_archive_original_refs(snapshot_id,msg_index,run_id,tool_call_id,body_id) VALUES (?1,?2,?3,?4,?5)',
      )
      .run(snapshotId, index, owner, message.toolCallId, body.bodyId)
  })
}

function removeSnapshot(
  database: Database,
  row: { snapshot_id: string; run_id: string; archived_at: number },
  reason: string,
): void {
  database
    .query(
      `INSERT INTO context_archive_cutoffs(run_id,archived_at,reason) VALUES (?1,?2,?3)
    ON CONFLICT(run_id) DO UPDATE SET archived_at=max(archived_at,excluded.archived_at),reason=excluded.reason`,
    )
    .run(row.run_id, row.archived_at, reason)
  database
    .query('DELETE FROM context_archive_snapshots WHERE snapshot_id=?1')
    .run(row.snapshot_id)
}

export function collectArchiveOriginalOrphans(
  database: Database,
  reason: string,
): void {
  database
    .query(
      `UPDATE context_archive_originals SET retired_reason=?1 WHERE retired_reason IS NULL AND NOT EXISTS
    (SELECT 1 FROM context_archive_original_refs r WHERE r.run_id=context_archive_originals.run_id AND r.tool_call_id=context_archive_originals.tool_call_id)`,
    )
    .run(reason)
  database.exec(
    `DELETE FROM context_archive_original_bodies WHERE NOT EXISTS (SELECT 1 FROM context_archive_original_refs r WHERE r.body_id=context_archive_original_bodies.body_id)`,
  )
  collectArchiveOrphans(database)
}

/** Caller owns an IMMEDIATE transaction: expiry, cutoff, reference removal and byte quota commit together. */
export function enforceArchiveRetention(
  database: Database,
  policy: Readonly<ContextArchiveRetentionPolicy>,
  now: number,
): ContextArchiveRetentionReceipt {
  if (!Number.isFinite(now))
    throw new ArchiveInputError('Invalid archive clock.')
  if (!archiveFtsAvailable(database)) disableArchiveFtsTriggers(database)
  const expired = database
    .query(
      `SELECT s.snapshot_id,s.run_id,s.archived_at FROM context_archive_snapshots s WHERE
    (s.expires_at IS NOT NULL AND s.expires_at<=?1) OR (?2=1 AND coalesce(s.pinned,0)=0 AND
      (s.archived_at+?3<=?1 OR EXISTS (SELECT 1 FROM context_archive_original_refs r JOIN context_archive_originals o
        ON o.run_id=r.run_id AND o.tool_call_id=r.tool_call_id WHERE r.snapshot_id=s.snapshot_id AND o.captured_at+?3<=?1)))
    ORDER BY s.archived_at,s.snapshot_id`,
    )
    .all(now, policy.mode === 'rolling' ? 1 : 0, policy.ttlMs ?? 0) as Array<{
    snapshot_id: string
    run_id: string
    archived_at: number
  }>
  expired.forEach((row) => removeSnapshot(database, row, 'expiry'))
  collectArchiveOriginalOrphans(
    database,
    expired.length ? 'expiry' : 'retention-reconciliation',
  )
  let dropped = 0,
    receipt = archiveRetentionReceipt(database, policy, {
      expired: expired.length,
    })
  while (
    policy.mode === 'rolling' &&
    (receipt.logicalBytes > policy.maxBytes! ||
      receipt.retainedSnapshots > policy.maxSnapshots!)
  ) {
    const row = database
      .query(
        'SELECT snapshot_id,run_id,archived_at FROM context_archive_snapshots WHERE coalesce(pinned,0)=0 ORDER BY archived_at,snapshot_id LIMIT 1',
      )
      .get() as {
      snapshot_id: string
      run_id: string
      archived_at: number
    } | null
    if (!row)
      throw new ArchiveCapacityError(
        'Protected archive closure or required cutoff metadata exceeds the retention quota.',
      )
    removeSnapshot(database, row, 'quota')
    dropped++
    collectArchiveOriginalOrphans(database, 'quota')
    receipt = archiveRetentionReceipt(database, policy, {
      dropped,
      expired: expired.length,
    })
  }
  return receipt
}

export function readOriginalBodyPage(
  database: Database,
  request: ContextArchiveBodyPageRequest,
): ContextArchiveBodyPageOutcome {
  const rows = database
    .query(
      `SELECT * FROM context_archive_originals WHERE tool_call_id=?1 AND (?2 IS NULL OR run_id=?2) ORDER BY run_id LIMIT 2`,
    )
    .all(request.toolCallId, request.sourceRunId ?? null) as OriginalRow[]
  if (!rows.length)
    return {
      status: 'missing',
      reason: 'No retained original exists for this source-run/call identity.',
    }
  if (rows.length > 1)
    return {
      status: 'ambiguous',
      reason:
        'This call ID belongs to multiple source runs; supply sourceRunId.',
    }
  const row = rows[0]
  if (row.retired_reason)
    return {
      status: 'expired',
      reason: `The original was removed by retention (${row.retired_reason}); no body reference remains usable.`,
    }
  const members = database
    .query(
      `SELECT s.*,r.msg_index FROM context_archive_original_refs r
    JOIN context_archive_snapshots s ON s.snapshot_id=r.snapshot_id WHERE r.run_id=?1 AND r.tool_call_id=?2 LIMIT 500`,
    )
    .all(row.run_id, row.tool_call_id) as Array<
    ArchiveManifestRow & { msg_index: number }
  >
  const verified = members.some((member) => {
    const snapshot = readArchiveSnapshot(database, member),
      provenance = snapshot?.provenance?.[member.msg_index]
    const message = snapshot?.messages[member.msg_index]
    return (
      message?.role === 'tool' &&
      message.toolCallId === row.tool_call_id &&
      message.toolName === row.tool_name &&
      provenance?.toolCallId === row.tool_call_id &&
      (provenance.sourceRunId ?? snapshot?.runId) === row.run_id &&
      provenance.step === row.step &&
      provenance.capturedAt === row.captured_at &&
      provenance.body?.bodyId === row.body_id &&
      !provenance.conflict
    )
  })
  const body = database
    .query(
      'SELECT body_id bodyId,sha256,utf8_bytes utf8Bytes,text FROM context_archive_original_bodies WHERE body_id=?1',
    )
    .get(row.body_id) as ContextArchiveBody | null
  if (!verified || !body)
    return {
      status: 'corrupt',
      reason:
        'A retained original has missing or invalid checked manifest/body/reference membership.',
    }
  const page = pageContextArchiveBody(body, request)
  if ('status' in page) return page
  return {
    status: 'ok',
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    step: row.step,
    bodyId: body.bodyId,
    sha256: body.sha256,
    utf8Bytes: body.utf8Bytes,
    ...page,
  }
}

/** Scoped SQL candidates precede the result cap; original text is not replaced by its pointer projection. */
export function searchOriginalArchive(
  database: Database,
  terms: readonly string[],
  limit: number,
): {
  matches: import('../../../../common/src/types/context-archive-search').ContextArchiveSearchMatch[]
  snapshotIds: string[]
  capped: boolean
} {
  if (!terms.length) return { matches: [], snapshotIds: [], capped: false }
  const clauses = terms.map(() => 'instr(lower(b.text),?)>0').join(' AND ')
  const rows = database
    .query(
      `SELECT o.run_id,o.tool_call_id,o.tool_name,o.step,b.body_id,b.sha256,b.utf8_bytes,b.text,
    s.snapshot_id,s.archived_at FROM context_archive_original_bodies b JOIN context_archive_originals o ON o.body_id=b.body_id
    JOIN context_archive_original_refs r ON r.run_id=o.run_id AND r.tool_call_id=o.tool_call_id
    JOIN context_archive_snapshots s ON s.snapshot_id=r.snapshot_id WHERE o.retired_reason IS NULL AND ${clauses}
    ORDER BY s.archived_at DESC,s.snapshot_id,r.msg_index DESC LIMIT 500`,
    )
    .all(...terms.map((term) => term.toLowerCase())) as Array<{
    run_id: string
    tool_call_id: string
    tool_name: string
    step: number
    body_id: string
    sha256: string
    utf8_bytes: number
    text: string
    snapshot_id: string
    archived_at: number
  }>
  const seen = new Set<string>(),
    matches: import('../../../../common/src/types/context-archive-search').ContextArchiveSearchMatch[] =
      []
  for (const row of rows) {
    const key = JSON.stringify([row.run_id, row.tool_call_id])
    if (seen.has(key)) continue
    seen.add(key)
    if (
      !isContextArchiveBody({
        bodyId: row.body_id,
        sha256: row.sha256,
        utf8Bytes: row.utf8_bytes,
        text: row.text,
      })
    )
      continue
    const lowered = row.text.toLowerCase(),
      first = Math.min(
        ...terms.map((term) => lowered.indexOf(term.toLowerCase())),
      )
    const start = Math.max(0, first - 120)
    matches.push({
      runId: row.run_id,
      archivedAt: row.archived_at,
      step: row.step,
      toolName: row.tool_name,
      toolCallId: row.tool_call_id,
      snippet: row.text.slice(start, start + 600),
      body: {
        bodyId: row.body_id,
        sha256: row.sha256,
        utf8Bytes: row.utf8_bytes,
      },
    })
    if (matches.length >= limit) break
  }
  return {
    matches,
    snapshotIds: [...new Set(rows.map((row) => row.snapshot_id))],
    capped: rows.length === 500,
  }
}
