import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import type { ContextArchiveSnapshot } from '../../../../common/src/types/context-archive'
import type { Message } from '../../../../common/src/types/messages/codebuff-message'

export const CONTEXT_ARCHIVE_STORE_DDL = `
CREATE TABLE IF NOT EXISTS context_archive_bodies (
  content_digest TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS context_archive_messages (
  message_id TEXT PRIMARY KEY,
  header_json TEXT NOT NULL CHECK(json_valid(header_json)),
  content_digest TEXT NOT NULL REFERENCES context_archive_bodies(content_digest),
  tool_name TEXT,
  tool_call_id TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS context_archive_messages_content ON context_archive_messages(content_digest);
CREATE TABLE IF NOT EXISTS context_archive_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  archived_at REAL NOT NULL,
  action TEXT NOT NULL,
  keep_recent_steps INTEGER NOT NULL,
  step_base INTEGER,
  reason TEXT,
  steps_json TEXT,
  manifest_hash TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  provenance_json TEXT,
  pinned INTEGER,
  expires_at REAL,
  created_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS context_archive_snapshots_time ON context_archive_snapshots(archived_at);
CREATE INDEX IF NOT EXISTS context_archive_snapshots_run_time ON context_archive_snapshots(run_id,archived_at DESC,snapshot_id);
CREATE TABLE IF NOT EXISTS context_archive_memberships (
  snapshot_id TEXT NOT NULL REFERENCES context_archive_snapshots(snapshot_id) ON DELETE CASCADE,
  msg_index INTEGER NOT NULL,
  message_id TEXT NOT NULL REFERENCES context_archive_messages(message_id),
  step INTEGER,
  PRIMARY KEY(snapshot_id,msg_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS context_archive_memberships_message ON context_archive_memberships(message_id);
CREATE TABLE IF NOT EXISTS context_archive_watermarks (
  run_id TEXT PRIMARY KEY,
  max_archived_at REAL NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS context_archive_migration_errors (
 source TEXT NOT NULL,run_id TEXT NOT NULL, archived_at REAL NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY(source,run_id,archived_at)
) WITHOUT ROWID;
`

const CONTEXT_ARCHIVE_EXTERNAL_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS context_archive_fts USING fts5(body, content='context_archive_bodies',content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS context_archive_bodies_ai AFTER INSERT ON context_archive_bodies BEGIN
 INSERT INTO context_archive_fts(rowid,body) VALUES (new.rowid,new.body);
END;
CREATE TRIGGER IF NOT EXISTS context_archive_bodies_ad AFTER DELETE ON context_archive_bodies BEGIN
 INSERT INTO context_archive_fts(context_archive_fts,rowid,body) VALUES ('delete',old.rowid,old.body);
END;
CREATE TRIGGER IF NOT EXISTS context_archive_bodies_au AFTER UPDATE OF body ON context_archive_bodies WHEN old.body!=new.body BEGIN
 INSERT INTO context_archive_fts(context_archive_fts,rowid,body) VALUES ('delete',old.rowid,old.body);
 INSERT INTO context_archive_fts(rowid,body) VALUES (new.rowid,new.body);
END;
`

export function archiveFtsAvailable(database: Database): boolean {
  return !!database
    .query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_archive_fts'",
    )
    .get()
}

export function disableArchiveFtsTriggers(database: Database): void {
  database.exec(
    'DROP TRIGGER IF EXISTS context_archive_bodies_ai; DROP TRIGGER IF EXISTS context_archive_bodies_ad; DROP TRIGGER IF EXISTS context_archive_bodies_au;',
  )
}

/** The old row tables are retained until each snapshot has a checked manifest. */
export function migrateContextArchiveSchema(database: Database): void {
  const columns = database
    .query('PRAGMA table_info(context_archive_snapshots)')
    .all() as Array<{ name: string }>
  if (columns.some((column) => column.name === 'messages_json')) {
    database.exec('DROP TABLE IF EXISTS context_archive_fts')
    database.exec(
      'ALTER TABLE context_archive_snapshots RENAME TO context_archive_legacy_snapshots',
    )
    const messages = database
      .query(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_archive_messages'",
      )
      .get()
    if (messages)
      database.exec(
        'ALTER TABLE context_archive_messages RENAME TO context_archive_legacy_messages',
      )
    database.exec(
      'DROP INDEX IF EXISTS context_archive_snapshots_time;DROP INDEX IF EXISTS context_archive_messages_content;',
    )
  } else if (
    columns.length &&
    !columns.some((column) => column.name === 'snapshot_id')
  ) {
    // The first normalized layout still keyed snapshots by timestamp.
    // Keep its references live until each immutable snapshot is checked.
    database.exec(
      'ALTER TABLE context_archive_snapshots RENAME TO context_archive_v5_snapshots',
    )
    database.exec(
      'ALTER TABLE context_archive_memberships RENAME TO context_archive_v5_memberships',
    )
    database.exec(
      'DROP INDEX IF EXISTS context_archive_snapshots_time;DROP INDEX IF EXISTS context_archive_memberships_message;',
    )
  }
  const errorColumns = database
    .query('PRAGMA table_info(context_archive_migration_errors)')
    .all() as Array<{ name: string }>
  if (
    errorColumns.length &&
    !errorColumns.some((column) => column.name === 'source')
  )
    database.exec('DROP TABLE context_archive_migration_errors')
  database.exec(CONTEXT_ARCHIVE_STORE_DDL)
  const currentColumns = new Set(
    (
      database
        .query('PRAGMA table_info(context_archive_snapshots)')
        .all() as Array<{ name: string }>
    ).map((column) => column.name),
  )
  for (const [name, type] of [
    ['provenance_json', 'TEXT'],
    ['pinned', 'INTEGER'],
    ['expires_at', 'REAL'],
  ])
    if (!currentColumns.has(name))
      database.exec(
        `ALTER TABLE context_archive_snapshots ADD COLUMN ${name} ${type}`,
      )
  const hadFts = archiveFtsAvailable(database)
  try {
    database.exec(CONTEXT_ARCHIVE_EXTERNAL_FTS_DDL)
    if (!hadFts)
      database.exec(
        "INSERT INTO context_archive_fts(context_archive_fts) VALUES ('rebuild')",
      )
  } catch {
    // Do not leave body triggers pointing at an unavailable optional index.
    disableArchiveFtsTriggers(database)
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const actions = new Set([
  'semantic_compaction',
  'mechanical_trim',
  'tool_result_eviction',
])

export interface PreparedArchiveSnapshot {
  snapshot: ContextArchiveSnapshot
  hash: string
  stepsJson: string | null
  messages: Array<{
    messageId: string
    contentDigest: string
    headerJson: string
    body: string
    toolName: string | null
    toolCallId: string | null
    step: number | null
  }>
}

export function prepareArchiveSnapshot(
  snapshot: ContextArchiveSnapshot,
): PreparedArchiveSnapshot | null {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    !Number.isFinite(snapshot.archivedAt) ||
    !actions.has(snapshot.action) ||
    !Number.isFinite(snapshot.keepRecentSteps) ||
    !Array.isArray(snapshot.messages) ||
    (snapshot.runId !== undefined &&
      (typeof snapshot.runId !== 'string' ||
        !snapshot.runId ||
        snapshot.runId.length > 2048))
  )
    return null
  if (
    !Number.isInteger(snapshot.keepRecentSteps) ||
    snapshot.keepRecentSteps < 0 ||
    (snapshot.reason !== undefined && typeof snapshot.reason !== 'string') ||
    (snapshot.stepBase !== undefined &&
      (!Number.isInteger(snapshot.stepBase) || snapshot.stepBase < 0)) ||
    (snapshot.steps !== undefined &&
      (!Array.isArray(snapshot.steps) ||
        snapshot.steps.length !== snapshot.messages.length ||
        snapshot.steps.some((step) => !Number.isInteger(step) || step < 0)))
  )
    return null
  if (
    (snapshot.pinned !== undefined && typeof snapshot.pinned !== 'boolean') ||
    (snapshot.expiresAt !== undefined &&
      !Number.isFinite(snapshot.expiresAt)) ||
    (snapshot.provenance !== undefined &&
      (!Array.isArray(snapshot.provenance) ||
        snapshot.provenance.length !== snapshot.messages.length ||
        snapshot.provenance.some(
          (entry) =>
            !entry ||
            !['original', 'excerpt', 'pointer', 'unknown'].includes(
              entry.kind,
            ) ||
            !Number.isSafeInteger(entry.step) ||
            entry.step < 0 ||
            (entry.sourceRunId !== undefined &&
              (typeof entry.sourceRunId !== 'string' ||
                !entry.sourceRunId ||
                entry.sourceRunId.length > 2048)) ||
            (entry.capturedAt !== undefined &&
              !Number.isFinite(entry.capturedAt)) ||
            (entry.body !== undefined &&
              (!entry.body ||
                !/^[a-f0-9]{64}$/.test(entry.body.sha256) ||
                entry.body.bodyId !== `sha256:${entry.body.sha256}` ||
                !Number.isSafeInteger(entry.body.utf8Bytes) ||
                entry.body.utf8Bytes < 0)) ||
            (entry.conflict !== undefined &&
              typeof entry.conflict !== 'boolean') ||
            (entry.retainedRange !== undefined &&
              (!Number.isSafeInteger(entry.retainedRange.startByte) ||
                !Number.isSafeInteger(entry.retainedRange.endByte) ||
                entry.retainedRange.startByte < 0 ||
                entry.retainedRange.endByte < entry.retainedRange.startByte ||
                (entry.body !== undefined &&
                  entry.retainedRange.endByte > entry.body.utf8Bytes))),
        )))
  )
    return null
  try {
    const messages = snapshot.messages.map((message, index) => {
      if (
        !message ||
        typeof message !== 'object' ||
        !['system', 'user', 'assistant', 'tool'].includes(message.role) ||
        message.content === undefined
      )
        throw new Error('Invalid archived message')
      if (
        message.role === 'tool' &&
        (typeof message.toolName !== 'string' ||
          typeof message.toolCallId !== 'string')
      )
        throw new Error('Invalid archived tool lineage')
      const { content, ...header } = message
      const body = stableJson(content),
        headerJson = stableJson(header)
      const contentDigest = hash(body),
        messageId = hash(`${contentDigest}\u0000${headerJson}`)
      return {
        messageId,
        contentDigest,
        headerJson,
        body,
        toolName: message.role === 'tool' ? message.toolName : null,
        toolCallId: message.role === 'tool' ? message.toolCallId : null,
        step:
          message.role === 'tool'
            ? (snapshot.steps?.[index] ?? index + (snapshot.stepBase ?? 0))
            : null,
      }
    })
    const stepsJson = snapshot.steps ? JSON.stringify(snapshot.steps) : null
    const manifest = stableJson({
      action: snapshot.action,
      keepRecentSteps: snapshot.keepRecentSteps,
      stepBase: snapshot.stepBase ?? null,
      reason: snapshot.reason ?? null,
      steps: snapshot.steps ?? null,
      messages: messages.map((message) => message.messageId),
      ...(snapshot.provenance !== undefined
        ? { provenance: snapshot.provenance }
        : {}),
      ...(snapshot.pinned !== undefined ? { pinned: snapshot.pinned } : {}),
      ...(snapshot.expiresAt !== undefined
        ? { expiresAt: snapshot.expiresAt }
        : {}),
    })
    return { snapshot, hash: hash(manifest), stepsJson, messages }
  } catch {
    return null
  }
}

/** Run, timestamp and the complete checked manifest form an immutable identity. */
export function archiveSnapshotId(
  runId: string,
  prepared: PreparedArchiveSnapshot,
): string {
  return hash(
    stableJson({
      runId,
      archivedAt: prepared.snapshot.archivedAt,
      manifestHash: prepared.hash,
    }),
  )
}

export function archiveSnapshotIdentity(
  snapshot: ContextArchiveSnapshot,
  runId = snapshot.runId ?? '',
): string | null {
  const prepared = prepareArchiveSnapshot(snapshot)
  return prepared ? archiveSnapshotId(runId, prepared) : null
}

/** One body per content digest, one message per header/content pair; snapshots store references. */
export function putArchiveSnapshot(
  database: Database,
  runId: string,
  prepared: PreparedArchiveSnapshot,
  createdAt: string,
): boolean {
  const s = prepared.snapshot
  const snapshotId = archiveSnapshotId(runId, prepared)
  if (
    database
      .query('SELECT 1 FROM context_archive_snapshots WHERE snapshot_id=?1')
      .get(snapshotId)
  )
    return false
  const body = database.query(
    'INSERT OR IGNORE INTO context_archive_bodies(content_digest,body) VALUES (?1,?2)',
  )
  const message = database.query(
    'INSERT OR IGNORE INTO context_archive_messages(message_id,header_json,content_digest,tool_name,tool_call_id) VALUES (?1,?2,?3,?4,?5)',
  )
  for (const entry of prepared.messages) {
    body.run(entry.contentDigest, entry.body)
    message.run(
      entry.messageId,
      entry.headerJson,
      entry.contentDigest,
      entry.toolName,
      entry.toolCallId,
    )
  }
  database
    .query(
      'INSERT INTO context_archive_snapshots(snapshot_id,run_id,archived_at,action,keep_recent_steps,step_base,reason,steps_json,manifest_hash,message_count,provenance_json,pinned,expires_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)',
    )
    .run(
      snapshotId,
      runId,
      s.archivedAt,
      s.action,
      s.keepRecentSteps,
      s.stepBase ?? null,
      s.reason ?? null,
      prepared.stepsJson,
      prepared.hash,
      prepared.messages.length,
      s.provenance ? JSON.stringify(s.provenance) : null,
      s.pinned === undefined ? null : s.pinned ? 1 : 0,
      s.expiresAt ?? null,
      createdAt,
    )
  const membership = database.query(
    'INSERT INTO context_archive_memberships(snapshot_id,msg_index,message_id,step) VALUES (?1,?2,?3,?4)',
  )
  prepared.messages.forEach((entry, index) =>
    membership.run(snapshotId, index, entry.messageId, entry.step),
  )
  return true
}

export function collectArchiveOrphans(database: Database, limit = 5000): void {
  const staged = database
    .query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_archive_v5_memberships'",
    )
    .get()
  const retainStaged = staged
    ? ' AND NOT EXISTS(SELECT 1 FROM context_archive_v5_memberships old WHERE old.message_id=m.message_id)'
    : ''
  database
    .query(
      `DELETE FROM context_archive_messages WHERE message_id IN (SELECT m.message_id FROM context_archive_messages m WHERE NOT EXISTS(SELECT 1 FROM context_archive_memberships r WHERE r.message_id=m.message_id)${retainStaged} LIMIT ?1)`,
    )
    .run(limit)
  database
    .query(
      'DELETE FROM context_archive_bodies WHERE content_digest IN (SELECT b.content_digest FROM context_archive_bodies b WHERE NOT EXISTS(SELECT 1 FROM context_archive_messages m WHERE m.content_digest=b.content_digest) LIMIT ?1)',
    )
    .run(limit)
}

export interface ArchiveManifestRow {
  snapshot_id: string
  run_id: string
  archived_at: number
  action: string
  keep_recent_steps: number
  step_base: number | null
  reason: string | null
  steps_json: string | null
  manifest_hash: string
  message_count: number
  provenance_json?: string | null
  pinned?: number | null
  expires_at?: number | null
}

type ArchiveMemberRow = {
  header_json: string
  body: string
  msg_index: number
  step: number | null
}

function decodeArchiveSnapshot(
  row: ArchiveManifestRow,
  members: ArchiveMemberRow[],
  checkIdentity: boolean,
): ContextArchiveSnapshot | null {
  try {
    if (
      members.length !== row.message_count ||
      (row.pinned != null && row.pinned !== 0 && row.pinned !== 1)
    )
      return null
    const snapshot: ContextArchiveSnapshot = {
      runId: row.run_id,
      archivedAt: row.archived_at,
      action: row.action as ContextArchiveSnapshot['action'],
      keepRecentSteps: row.keep_recent_steps,
      stepBase: row.step_base ?? undefined,
      reason: row.reason ?? undefined,
      steps: row.steps_json ? JSON.parse(row.steps_json) : undefined,
      provenance: row.provenance_json
        ? JSON.parse(row.provenance_json)
        : undefined,
      pinned: row.pinned == null ? undefined : row.pinned === 1,
      expiresAt: row.expires_at ?? undefined,
      messages: members.map(
        (member) =>
          ({
            ...JSON.parse(member.header_json),
            content: JSON.parse(member.body),
          }) as Message,
      ),
    }
    const prepared = prepareArchiveSnapshot(snapshot)
    if (!prepared || prepared.hash !== row.manifest_hash) return null
    if (
      members.some(
        (member, index) =>
          member.msg_index !== index ||
          member.step !== prepared.messages[index]!.step,
      )
    )
      return null
    const snapshotId = archiveSnapshotId(row.run_id, prepared)
    if (checkIdentity && row.snapshot_id !== snapshotId) return null
    return { ...snapshot, snapshotId }
  } catch {
    return null
  }
}

export function readArchiveSnapshot(
  database: Database,
  row: ArchiveManifestRow,
): ContextArchiveSnapshot | null {
  const members = database
    .query(
      'SELECT m.header_json,b.body,r.msg_index,r.step FROM context_archive_memberships r JOIN context_archive_messages m ON m.message_id=r.message_id JOIN context_archive_bodies b ON b.content_digest=m.content_digest WHERE r.snapshot_id=?1 ORDER BY r.msg_index',
    )
    .all(row.snapshot_id) as ArchiveMemberRow[]
  return decodeArchiveSnapshot(row, members, true)
}

/** Resumable migration: checked new references and legacy deletion share one transaction. */
export function migrateArchivePage(
  database: Database,
  limit = 4,
): { migrated: number; remaining: boolean; invalid: number } {
  const sources = [
    {
      source: 'legacy-json',
      table: 'context_archive_legacy_snapshots',
      members: 'context_archive_legacy_messages',
    },
    {
      source: 'normalized-v5',
      table: 'context_archive_v5_snapshots',
      members: 'context_archive_v5_memberships',
    },
  ] as const
  const hasTable = (table: string) =>
    !!database
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1")
      .get(table)
  return database
    .transaction(() => {
      let migrated = 0,
        remaining = false,
        admitted = 0
      for (const source of sources) {
        if (!hasTable(source.table)) continue
        const rows = database
          .query(
            `SELECT l.* FROM ${source.table} l WHERE NOT EXISTS (SELECT 1 FROM context_archive_migration_errors e WHERE e.source=?1 AND e.run_id=l.run_id AND e.archived_at=l.archived_at) ORDER BY run_id,archived_at LIMIT ?2`,
          )
          .all(source.source, Math.max(0, limit - admitted)) as Array<
          Record<string, unknown>
        >
        admitted += rows.length
        for (const row of rows) {
          let prepared: PreparedArchiveSnapshot | null = null
          try {
            if (source.source === 'legacy-json')
              prepared = prepareArchiveSnapshot({
                archivedAt: row.archived_at as number,
                action: row.action as ContextArchiveSnapshot['action'],
                keepRecentSteps: row.keep_recent_steps as number,
                stepBase:
                  row.step_base === null
                    ? undefined
                    : (row.step_base as number | undefined),
                reason:
                  row.reason === null
                    ? undefined
                    : (row.reason as string | undefined),
                steps: row.steps_json
                  ? JSON.parse(row.steps_json as string)
                  : undefined,
                messages: JSON.parse(row.messages_json as string),
              })
            else {
              const members = database
                .query(
                  'SELECT m.header_json,b.body,r.msg_index,r.step FROM context_archive_v5_memberships r JOIN context_archive_messages m ON m.message_id=r.message_id JOIN context_archive_bodies b ON b.content_digest=m.content_digest WHERE r.run_id=?1 AND r.archived_at=?2 ORDER BY r.msg_index',
                )
                .all(
                  row.run_id as string,
                  row.archived_at as number,
                ) as ArchiveMemberRow[]
              const snapshot = decodeArchiveSnapshot(
                row as unknown as ArchiveManifestRow,
                members,
                false,
              )
              if (snapshot) prepared = prepareArchiveSnapshot(snapshot)
            }
          } catch {}
          if (!prepared) {
            database
              .query(
                "INSERT OR IGNORE INTO context_archive_migration_errors(source,run_id,archived_at,reason) VALUES (?1,?2,?3,'invalid-snapshot')",
              )
              .run(
                source.source,
                row.run_id as string,
                row.archived_at as number,
              )
            continue
          }
          putArchiveSnapshot(
            database,
            row.run_id as string,
            prepared,
            row.created_at as string,
          )
          const manifest = database
            .query(
              'SELECT * FROM context_archive_snapshots WHERE snapshot_id=?1',
            )
            .get(
              archiveSnapshotId(row.run_id as string, prepared),
            ) as ArchiveManifestRow
          if (!readArchiveSnapshot(database, manifest))
            throw new Error('Archive migration manifest failed verification')
          database
            .query(
              'INSERT INTO context_archive_watermarks(run_id,max_archived_at,updated_at) VALUES (?1,?2,?3) ON CONFLICT(run_id) DO UPDATE SET max_archived_at=max(context_archive_watermarks.max_archived_at,excluded.max_archived_at),updated_at=excluded.updated_at',
            )
            .run(
              row.run_id as string,
              row.archived_at as number,
              row.created_at as string,
            )
          if (hasTable(source.members))
            database
              .query(
                `DELETE FROM ${source.members} WHERE run_id=?1 AND archived_at=?2`,
              )
              .run(row.run_id as string, row.archived_at as number)
          database
            .query(
              `DELETE FROM ${source.table} WHERE run_id=?1 AND archived_at=?2`,
            )
            .run(row.run_id as string, row.archived_at as number)
          migrated++
        }
        if (!database.query(`SELECT 1 FROM ${source.table} LIMIT 1`).get()) {
          database.exec(
            `DROP TABLE IF EXISTS ${source.members};DROP TABLE ${source.table};`,
          )
        } else if (
          database
            .query(
              `SELECT 1 FROM ${source.table} l WHERE NOT EXISTS (SELECT 1 FROM context_archive_migration_errors e WHERE e.source=?1 AND e.run_id=l.run_id AND e.archived_at=l.archived_at) LIMIT 1`,
            )
            .get(source.source)
        )
          remaining = true
      }
      const errorCount = database
        .query('SELECT COUNT(*) AS count FROM context_archive_migration_errors')
        .get() as { count: number }
      return { migrated, remaining, invalid: errorCount.count }
    })
    .immediate()
}

export function repairArchiveFts(database: Database): void {
  migrateContextArchiveSchema(database)
  if (archiveFtsAvailable(database))
    database.exec(
      "INSERT INTO context_archive_fts(context_archive_fts) VALUES ('rebuild')",
    )
}
