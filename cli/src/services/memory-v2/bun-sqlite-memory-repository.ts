import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  MemoryAppendRequestSchema,
  MemoryEventDraftSchema,
  MemoryEventEnvelopeSchema,
  MemoryEventIdSchema,
  MemoryExportRequestSchema,
  ProjectIdSchema,
  MemoryHealthRequestSchema,
  MemoryRebuildRequestSchema,
  MemoryRetrievalRequestSchema,
  MemoryRetrievalResultSchema,
  MemoryVerifyOutcomeSchema,
  MemoryVerifyRequestSchema,
  type MemoryAppendOutcome,
  type MemoryAppendRequest,
  type MemoryEventDraft,
  type MemoryEventEnvelope,
  type MemoryExpectedTail,
  type MemoryExportOutcome,
  type MemoryExportRequest,
  type MemoryHealth,
  type MemoryHealthRequest,
  type MemoryOperationError,
  type MemoryQueryOutcome,
  type MemoryRebuildOutcome,
  type MemoryRebuildRequest,
  type MemoryRetrievalRequest,
  type MemoryObservation,
  type MemorySelector,
  type RankingReason,
  type MemoryVerifyOutcome,
  type MemoryVerifyRequest,
} from '../../../../common/src/types/memory-v2'
import type { MemoryRepositoryV2 } from '../../../../sdk/src/services/memory-v2/types'

export type RuntimeNeutralMemoryRepositoryV2 = MemoryRepositoryV2
export type RuntimeNeutralMemoryEventV2 = MemoryEventEnvelope

const SCHEMA_VERSION = 2
const DEFAULT_DATABASE_PATH = join('.openbuff', 'memory', 'memory-v2.sqlite')
const DEFAULT_BUSY_TIMEOUT_MS = 2_500
const MAX_BUSY_TIMEOUT_MS = 10_000
const PAGE_SIZE = 250
const MAX_QUERY_EVENTS = 10_000
const MAX_QUERY_PAYLOAD_BYTES = 8 * 1024 * 1024
const CANONICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'task.created',
  'task.transitioned',
  'session.started',
  'session.ended',
  'artifact.classified',
  'observation.recorded',
  'claim.consolidated',
  'claim.corrected',
  'claim.superseded',
  'claim.forgotten',
  'claim.pinned',
  'evidence.attached',
  'evidence.verified',
  'evidence.invalidated',
  'evidence.rebound',
  'migration.v1.reserved',
  'migration.v1.imported',
  'coverage.recorded',
])

export type MemoryV2FailureKind =
  | 'busy'
  | 'closed'
  | 'conflict'
  | 'corrupt'
  | 'incompatible'
  | 'invalid'
  | 'io'

export interface MemoryV2Failure {
  kind: MemoryV2FailureKind
  message: string
  retryable: boolean
}

export type MemoryV2Result<T> =
  | ({ status: 'ok' } & T)
  | { status: 'error'; error: MemoryV2Failure }

export interface MemoryV2EventInput {
  eventId: string
  idempotencyKey: string
  eventType: string
  occurredAt: string
  payload: unknown
  metadata?: unknown
  taskId?: string
  sessionId?: string
  artifactId?: string
}

export interface MemoryV2StoredEvent extends MemoryV2EventInput {
  sequence: number
  metadata: unknown
}

export interface MemoryV2AppendEntry {
  eventId: string
  sequence: number
  duplicate: boolean
}

export type MemoryV2AppendResult = MemoryV2Result<{
  events: MemoryV2AppendEntry[]
  appendedCount: number
  duplicateCount: number
  lastSequence: number
}>

export interface MemoryV2Capability {
  name: string
  available: boolean
  fallback: string | null
  value: string
}

export interface MemoryV2Health {
  status: 'healthy' | 'degraded' | 'unavailable'
  schemaVersion: number | null
  journalMode: string | null
  synchronous: string | null
  projectionCursor: number | null
  capabilities: MemoryV2Capability[]
  failure?: MemoryV2Failure
}

export interface BunSQLiteMemoryRepositoryOptions {
  repositoryRoot?: string
  databasePath?: string
  busyTimeoutMs?: number
}

export type BunSQLiteMemoryRepositoryOpenResult =
  | { status: 'ok'; repository: BunSQLiteMemoryRepository }
  | { status: 'error'; error: MemoryV2Failure }

export interface ProjectionRow {
  entityId: string
  taskId: string | null
  sessionId: string | null
  state: unknown
  sourceSequence: number
  updatedAt: string
}

export interface MemoryV2ProjectionSnapshot {
  cursor: number
  tasks: ProjectionRow[]
  sessions: ProjectionRow[]
  artifacts: ProjectionRow[]
  claims: ProjectionRow[]
  evidence: ProjectionRow[]
  discoveries: ProjectionRow[]
}

export interface MemoryV2UnsupportedResult {
  status: 'unsupported'
  capability: string
  message: string
}

interface PreparedEvent {
  eventId: string
  idempotencyKey: string
  eventType: string
  occurredAt: string
  payload: unknown
  payloadJson: string
  metadata: unknown
  metadataJson: string
  taskId: string | null
  sessionId: string | null
  artifactId: string | null
}

interface EventRow {
  sequence: number
  event_id: string
  idempotency_key: string
  event_type: string
  occurred_at: string
  payload_json: string
  metadata_json: string
  task_id: string | null
  session_id: string | null
  artifact_id: string | null
}

interface AppendTransactionResult {
  events: MemoryV2AppendEntry[]
  appendedCount: number
  duplicateCount: number
  lastSequence: number
  lastEventId: string | null
}

interface AppendGuard {
  projectId: string
  expectedTail?: MemoryExpectedTail
}

interface ProjectionDefinition {
  table: string
  payloadId: string
  explicitId: keyof Pick<PreparedEvent, 'taskId' | 'sessionId' | 'artifactId'> | null
}

interface FileIdentity {
  dev: number
  ino: number
}

interface PreparedDatabasePath {
  databasePath: string
  realRoot: string
  realParent: string
  existingIdentity: FileIdentity | null
}

interface QueryAdmissionRow {
  sequence: number
  payload_bytes: number
  metadata_bytes: number
}

interface QueryScanResult {
  rows: EventRow[]
  eventCapReached: boolean
  payloadBudgetReached: boolean
}

const PROJECTIONS: Record<string, ProjectionDefinition> = {
  task: { table: 'memory_tasks', payloadId: 'taskId', explicitId: 'taskId' },
  session: { table: 'memory_sessions', payloadId: 'sessionId', explicitId: 'sessionId' },
  artifact: { table: 'memory_artifacts', payloadId: 'artifactId', explicitId: 'artifactId' },
  claim: { table: 'memory_claims', payloadId: 'claimId', explicitId: null },
  evidence: { table: 'memory_evidence', payloadId: 'evidenceId', explicitId: null },
  discovery: { table: 'memory_discoveries', payloadId: 'discoveryId', explicitId: null },
}

const PROJECTION_TABLES = Object.values(PROJECTIONS).map(({ table }) => table)

export class MemoryV2StorageError extends Error {
  readonly failure: MemoryV2Failure

  constructor(failure: MemoryV2Failure) {
    super(failure.message)
    this.name = 'MemoryV2StorageError'
    this.failure = failure
  }
}

export class BunSQLiteMemoryRepository implements MemoryRepositoryV2 {
  readonly databasePath: string
  private closed = false

  private constructor(
    private readonly database: Database,
    databasePath: string,
  ) {
    this.databasePath = databasePath
  }

  static async open(
    options: BunSQLiteMemoryRepositoryOptions = {},
  ): Promise<BunSQLiteMemoryRepositoryOpenResult> {
    let database: Database | undefined

    try {
      const preparedPath = prepareDatabasePath(options)
      const timeout = boundedBusyTimeout(options.busyTimeoutMs)
      preflightExistingDatabase(preparedPath)
      database = new Database(preparedPath.databasePath, { create: true, strict: true })
      verifyOpenedDatabasePath(preparedPath)
      database.exec(`PRAGMA busy_timeout = ${timeout}`)
      database.exec('PRAGMA foreign_keys = ON')
      migrate(database)
      secureDatabaseFiles(preparedPath)
      database.exec('PRAGMA synchronous = NORMAL')
      const journalMode = readPragmaString(database, 'PRAGMA journal_mode = WAL', 'journal_mode')
      secureDatabaseFiles(preparedPath)
      recordRuntimeCapabilities(database, journalMode)
      secureDatabaseFiles(preparedPath)

      return {
        status: 'ok',
        repository: new BunSQLiteMemoryRepository(database, preparedPath.databasePath),
      }
    } catch (error) {
      if (database) {
        try {
          database.close()
        } catch {
          // Opening already failed; preserve the classified opening failure.
        }
      }
      return { status: 'error', error: classifyStorageError(error) }
    }
  }

  async appendEvents(
    inputs: readonly (MemoryV2EventInput | MemoryEventEnvelope)[],
  ): Promise<MemoryV2AppendResult> {
    const result = this.appendKernel(inputs)
    if (result.status === 'error') return result
    return {
      status: 'ok',
      events: result.events,
      appendedCount: result.appendedCount,
      duplicateCount: result.duplicateCount,
      lastSequence: result.lastSequence,
    }
  }

  async append(request: MemoryAppendRequest): Promise<MemoryAppendOutcome> {
    const parsed = MemoryAppendRequestSchema.safeParse(request)
    if (!parsed.success) return rejectedOutcome('The memory append request is invalid.')
    if (parsed.data.events.some((event) => event.projectId !== parsed.data.projectId)) {
      return rejectedOutcome('Every event must belong to the requested project.')
    }

    const result = this.appendKernel(parsed.data.events, {
      projectId: parsed.data.projectId,
      expectedTail: parsed.data.expectedTail ?? (
        parsed.data.expectedLastEventId === undefined
          ? undefined
          : { kind: 'event', eventId: parsed.data.expectedLastEventId }
      ),
    })
    if (result.status === 'error') return appendFailureOutcome(result.error)
    if (!result.lastEventId || result.events.length !== parsed.data.events.length) {
      return failedOutcome('internal', 'The memory store did not return the appended events.', false)
    }
    const lastEventId = MemoryEventIdSchema.safeParse(result.lastEventId)
    if (!lastEventId.success) {
      return failedOutcome('internal', 'The memory store returned an invalid last event ID.', false)
    }
    return {
      outcome: 'appended',
      entries: result.events.map((entry, index) => ({
        eventId: parsed.data.events[index]!.eventId,
        sequence: entry.sequence,
        duplicate: entry.duplicate,
      })),
      lastEventId: lastEventId.data,
    }
  }

  private appendKernel(
    inputs: readonly (MemoryV2EventInput | MemoryEventDraft | MemoryEventEnvelope)[],
    guard?: AppendGuard,
  ): MemoryV2Result<AppendTransactionResult> {
    const unavailable = this.requireOpen()
    if (unavailable) return unavailable

    let events: PreparedEvent[]
    try {
      events = inputs.map((input) => prepareEvent(input))
    } catch (error) {
      return { status: 'error', error: invalidEventFailure(error) }
    }

    if (events.length === 0) {
      return {
        status: 'ok',
        events: [],
        appendedCount: 0,
        duplicateCount: 0,
        lastSequence: this.readProjectionCursor(),
        lastEventId: this.readLastEventId(),
      }
    }

    const eventIds = new Set<string>()
    const idempotencyKeys = new Set<string>()
    for (const event of events) {
      if (eventIds.has(event.eventId) || idempotencyKeys.has(event.idempotencyKey)) {
        return {
          status: 'error',
          error: {
            kind: 'invalid',
            message: 'An append request cannot contain duplicate event IDs or idempotency keys.',
            retryable: false,
          },
        }
      }
      eventIds.add(event.eventId)
      idempotencyKeys.add(event.idempotencyKey)
    }

    let canonicalProjectId: string | null = null
    for (const event of events) {
      const metadata = objectValue(event.metadata)
      if (metadata.schemaVersion !== 2) continue
      const parsedProjectId = ProjectIdSchema.safeParse(metadata.projectId)
      if (!parsedProjectId.success) {
        return {
          status: 'error',
          error: invalidEventFailure(new Error(
            'Events that claim schemaVersion 2 must include a valid projectId.',
          )),
        }
      }
      if (canonicalProjectId !== null && canonicalProjectId !== parsedProjectId.data) {
        return {
          status: 'error',
          error: invalidEventFailure(new Error(
            'Every canonical event in a batch must belong to the same project.',
          )),
        }
      }
      canonicalProjectId = parsedProjectId.data
    }

    try {
      const append = this.database.transaction((prepared: PreparedEvent[]) => {
        const boundProjectId = this.readBoundProjectId()
        if (boundProjectId !== null && !ProjectIdSchema.safeParse(boundProjectId).success) {
          throw invalidProjectStoreError()
        }
        const existingCanonicalProjects = this.database.query(
          `SELECT DISTINCT json_extract(metadata_json, '$.projectId') AS project_id,
                           json_type(metadata_json, '$.projectId') AS project_type
             FROM memory_events
            WHERE json_extract(metadata_json, '$.schemaVersion') = 2
            LIMIT 2`,
        ).all() as Array<{ project_id: unknown; project_type: string | null }>
        let existingCanonicalProjectId: string | null = null
        for (const row of existingCanonicalProjects) {
          const parsedProjectId = row.project_type === 'text'
            ? ProjectIdSchema.safeParse(row.project_id)
            : null
          if (!parsedProjectId?.success) throw invalidProjectStoreError()
          if (existingCanonicalProjectId !== null
            && existingCanonicalProjectId !== parsedProjectId.data) {
            throw invalidProjectStoreError()
          }
          existingCanonicalProjectId = parsedProjectId.data
        }

        const projectIds = [
          boundProjectId,
          existingCanonicalProjectId,
          canonicalProjectId,
          guard?.projectId ?? null,
        ].filter((projectId): projectId is string => projectId !== null)
        const projectId = projectIds[0] ?? null
        if (projectIds.some((candidate) => candidate !== projectId)) {
          throw new MemoryV2StorageError({
            kind: 'invalid',
            message: 'Every event must belong to the requested project.',
            retryable: false,
          })
        }
        if (projectId !== null
          && prepared.some((event) => eventProjectId(event) !== projectId)) {
          throw new MemoryV2StorageError({
            kind: 'invalid',
            message: 'Every event must belong to the requested project.',
            retryable: false,
          })
        }

        const results: MemoryV2AppendEntry[] = []
        let hasNewEvent = false
        for (const event of prepared) {
          const existing = this.database
            .query(
              `SELECT sequence, event_id, idempotency_key, event_type, occurred_at,
                      payload_json, metadata_json, task_id, session_id, artifact_id
                 FROM memory_events
                WHERE event_id = ?1 OR idempotency_key = ?2
                ORDER BY sequence`,
            )
            .all(event.eventId, event.idempotencyKey) as EventRow[]
          if (existing.length === 0) {
            hasNewEvent = true
          } else if (existing.length !== 1 || !isIdempotentMatch(existing[0], event)) {
            throw new MemoryV2StorageError({
              kind: 'invalid',
              message: 'The event ID or idempotency key conflicts with an existing event.',
              retryable: false,
            })
          } else {
            results.push({ eventId: existing[0].event_id, sequence: existing[0].sequence, duplicate: true })
          }
        }

        const currentLastEventId = guard
          ? this.readLastEventIdForProject(guard.projectId)
          : this.readLastEventId()
        const staleTail = guard?.expectedTail?.kind === 'empty'
          ? currentLastEventId !== null
          : guard?.expectedTail?.kind === 'event'
            ? guard.expectedTail.eventId !== currentLastEventId
            : false
        if (hasNewEvent && staleTail) {
          throw new MemoryV2StorageError({
            kind: 'conflict',
            message: 'The memory store changed after the caller last read it.',
            retryable: true,
          })
        }

        if (projectId !== null) this.bindProject(projectId)
        if (hasNewEvent) {
          results.length = 0
          for (const event of prepared) {
            const existing = this.database
              .query(
                `SELECT sequence, event_id, idempotency_key, event_type, occurred_at,
                        payload_json, metadata_json, task_id, session_id, artifact_id
                   FROM memory_events WHERE event_id = ?1`,
              )
              .get(event.eventId) as EventRow | null
            if (existing) {
              results.push({ eventId: existing.event_id, sequence: existing.sequence, duplicate: true })
              continue
            }
            const inserted = this.database
              .query(
                `INSERT INTO memory_events (
                   event_id, idempotency_key, event_type, occurred_at, payload_json,
                   metadata_json, task_id, session_id, artifact_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
              )
              .run(
                event.eventId, event.idempotencyKey, event.eventType, event.occurredAt,
                event.payloadJson, event.metadataJson, event.taskId, event.sessionId, event.artifactId,
              )
            const sequence = Number(inserted.lastInsertRowid)
            applyProjection(this.database, event, sequence)
            setProjectionCursor(this.database, sequence)
            results.push({ eventId: event.eventId, sequence, duplicate: false })
          }
        }

        const appendedCount = results.filter(({ duplicate }) => !duplicate).length
        const last = guard
          ? this.database
              .query(
                `SELECT sequence, event_id FROM memory_events
                  WHERE json_extract(metadata_json, '$.projectId') = ?1
                  ORDER BY sequence DESC LIMIT 1`,
              )
              .get(guard.projectId) as { sequence: number; event_id: string } | null
          : this.database
              .query('SELECT sequence, event_id FROM memory_events ORDER BY sequence DESC LIMIT 1')
              .get() as { sequence: number; event_id: string } | null
        return {
          events: results,
          appendedCount,
          duplicateCount: results.length - appendedCount,
          lastSequence: results.length > 0
            ? Math.max(...results.map(({ sequence }) => sequence))
            : last?.sequence ?? 0,
          lastEventId: last?.event_id ?? null,
        }
      })
      return { status: 'ok', ...append.immediate(events) }
    } catch (error) {
      return { status: 'error', error: classifyStorageError(error) }
    }
  }

  async listEvents(options: {
    afterSequence?: number
    limit?: number
  } = {}): Promise<MemoryV2Result<{ events: MemoryV2StoredEvent[] }>> {
    const unavailable = this.requireOpen()
    if (unavailable) return unavailable

    const afterSequence = validNonNegativeInteger(options.afterSequence ?? 0)
    const limit = Math.min(validPositiveInteger(options.limit ?? PAGE_SIZE), 1_000)
    try {
      const rows = this.database
        .query(
          `SELECT sequence, event_id, idempotency_key, event_type, occurred_at,
                  payload_json, metadata_json, task_id, session_id, artifact_id
             FROM memory_events
            WHERE sequence > ?1
            ORDER BY sequence
            LIMIT ?2`,
        )
        .all(afterSequence, limit) as EventRow[]
      return { status: 'ok', events: rows.map(storedEventFromRow) }
    } catch (error) {
      return { status: 'error', error: classifyStorageError(error) }
    }
  }

  async *iterateEvents(options: {
    afterSequence?: number
    limit?: number
  } = {}): AsyncGenerator<MemoryV2StoredEvent, void> {
    let cursor = validNonNegativeInteger(options.afterSequence ?? 0)
    let remaining = Math.min(validPositiveInteger(options.limit ?? 1_000), 10_000)

    while (remaining > 0) {
      const result = await this.listEvents({
        afterSequence: cursor,
        limit: Math.min(PAGE_SIZE, remaining),
      })
      if (result.status === 'error') throw new MemoryV2StorageError(result.error)
      if (result.events.length === 0) return
      for (const event of result.events) {
        yield event
        cursor = event.sequence
        remaining -= 1
      }
    }
  }

  async rebuildProjections(): Promise<MemoryV2Result<{
    cursor: number
    projectedEvents: number
  }>> {
    const unavailable = this.requireOpen()
    if (unavailable) return unavailable

    try {
      const rebuild = this.database.transaction(() => {
        for (const table of PROJECTION_TABLES) this.database.exec(`DELETE FROM ${table}`)
        setProjectionCursor(this.database, 0)
        return replayProjections(this.database)
      })
      return { status: 'ok', ...rebuild.immediate() }
    } catch (error) {
      return { status: 'error', error: classifyStorageError(error) }
    }
  }

  async getProjectionSnapshot(): Promise<MemoryV2Result<MemoryV2ProjectionSnapshot>> {
    const unavailable = this.requireOpen()
    if (unavailable) return unavailable

    try {
      return {
        status: 'ok',
        cursor: this.readProjectionCursor(),
        tasks: readProjectionRows(this.database, 'memory_tasks'),
        sessions: readProjectionRows(this.database, 'memory_sessions'),
        artifacts: readProjectionRows(this.database, 'memory_artifacts'),
        claims: readProjectionRows(this.database, 'memory_claims'),
        evidence: readProjectionRows(this.database, 'memory_evidence'),
        discoveries: readProjectionRows(this.database, 'memory_discoveries'),
      }
    } catch (error) {
      return { status: 'error', error: classifyStorageError(error) }
    }
  }

  async getCapabilities(): Promise<MemoryV2Result<{ capabilities: MemoryV2Capability[] }>> {
    const unavailable = this.requireOpen()
    if (unavailable) return unavailable
    try {
      return { status: 'ok', capabilities: readCapabilities(this.database) }
    } catch (error) {
      return { status: 'error', error: classifyStorageError(error) }
    }
  }

  async query(request: MemoryRetrievalRequest): Promise<MemoryQueryOutcome> {
    const parsed = MemoryRetrievalRequestSchema.safeParse(request)
    if (!parsed.success) return rejectedOutcome('The memory query request is invalid.')
    const unavailable = this.requireOpen()
    if (unavailable) return operationFailureOutcome(unavailable.error)

    try {
      this.requireBoundProject(parsed.data.projectId)
      const scan = scanQueryRows(this.database, parsed.data.projectId)
      const events = scan.rows
        .reverse()
        .filter((row) => CANONICAL_EVENT_TYPES.has(row.event_type))
        .map(envelopeFromRow)
      return {
        outcome: 'result',
        result: buildLexicalResult(
          parsed.data,
          events,
          scan.eventCapReached,
          scan.payloadBudgetReached,
        ),
      }
    } catch (error) {
      const failure = classifyStorageError(error)
      return failure.kind === 'invalid'
        ? rejectedOutcome(failure.message)
        : operationFailureOutcome(failure)
    }
  }

  async verify(request: MemoryVerifyRequest): Promise<MemoryVerifyOutcome> {
    const parsed = MemoryVerifyRequestSchema.safeParse(request)
    if (!parsed.success) return rejectedOutcome('The memory verify request is invalid.')
    const action = parsed.data.action
    if (action.kind === 'verify' && 'path' in action.selector && !action.observedDigest) {
      return rejectedOutcome('Path-backed evidence verification requires an observed digest.')
    }
    const identity = stableJson({
      projectId: parsed.data.projectId,
      sessionId: parsed.data.sessionId,
      workspaceRevision: parsed.data.workspaceRevision,
      workspaceSnapshotId: parsed.data.workspaceSnapshotId,
      action,
    })
    const hash = createHash('sha256').update(identity).digest('hex')
    const timestamp = new Date(Date.UTC(2020, 0, 1) + (Number.parseInt(hash.slice(0, 8), 16) * 1_000)).toISOString()
    const eventType = action.kind === 'verify'
      ? 'evidence.verified'
      : action.kind === 'invalidate'
        ? 'evidence.invalidated'
        : 'evidence.rebound'
    const payload = action.kind === 'verify'
      ? {
          payloadSchemaVersion: 1 as const,
          observationId: action.observationId,
          selector: action.selector,
          verifier: 'bun-sqlite-memory-v2',
          verifiedAt: timestamp,
          ...(action.observedDigest ? { observedDigest: action.observedDigest } : {}),
          ...(parsed.data.workspaceRevision ? { workspaceRevision: parsed.data.workspaceRevision } : {}),
          ...(parsed.data.workspaceSnapshotId ? { workspaceSnapshotId: parsed.data.workspaceSnapshotId } : {}),
        }
      : action.kind === 'invalidate'
        ? {
            payloadSchemaVersion: 1 as const,
            observationId: action.observationId,
            selector: action.selector,
            reason: action.reason,
            detail: action.detail,
            invalidatedAt: timestamp,
          }
        : {
            payloadSchemaVersion: 1 as const,
            observationId: action.observationId,
            previousSelector: action.previousSelector,
            evidence: action.evidence,
            reason: action.reason,
          }
    const draft = MemoryEventDraftSchema.parse({
      schemaVersion: 2,
      eventSchemaVersion: 1,
      eventType,
      eventId: `verify:${hash.slice(0, 40)}`,
      projectId: parsed.data.projectId,
      sessionId: parsed.data.sessionId,
      occurredAt: timestamp,
      payload,
    })
    const appended = await this.append(MemoryAppendRequestSchema.parse({
      schemaVersion: 2,
      projectId: parsed.data.projectId,
      events: [draft],
    }))
    if (appended.outcome !== 'appended') return MemoryVerifyOutcomeSchema.parse(appended)
    try {
      const row = this.database
        .query(
          `SELECT sequence, event_id, idempotency_key, event_type, occurred_at,
                  payload_json, metadata_json, task_id, session_id, artifact_id
             FROM memory_events
            WHERE event_id = ?1
              AND json_extract(metadata_json, '$.projectId') = ?2
            LIMIT 1`,
        )
        .get(draft.eventId, parsed.data.projectId) as EventRow | null
      if (!row) return failedOutcome('internal', 'The committed verification event was not found.', false)
      return MemoryVerifyOutcomeSchema.parse({ outcome: 'recorded', event: envelopeFromRow(row) })
    } catch (error) {
      return MemoryVerifyOutcomeSchema.parse(operationFailureOutcome(classifyStorageError(error)))
    }
  }

  async rebuild(request: MemoryRebuildRequest): Promise<MemoryRebuildOutcome> {
    const parsed = MemoryRebuildRequestSchema.safeParse(request)
    if (!parsed.success) return rejectedOutcome('The memory rebuild request is invalid.')
    if (parsed.data.fromEventId !== undefined) {
      return rejectedOutcome('Partial projection rebuilds are not supported.')
    }
    try {
      this.requireBoundProject(parsed.data.projectId)
    } catch (error) {
      return rejectedOutcome(classifyStorageError(error).message)
    }
    const result = await this.rebuildProjections()
    if (result.status === 'error') return operationFailureOutcome(result.error)
    return {
      outcome: 'rebuilt',
      rebuildId: parsed.data.rebuildId,
      processedEvents: result.projectedEvents,
    }
  }

  async health(request: MemoryHealthRequest): Promise<MemoryHealth> {
    const parsed = MemoryHealthRequestSchema.safeParse(request)
    if (!parsed.success) {
      return commonHealth('unavailable', ['The memory health request is invalid.'])
    }
    if (this.closed) return commonHealth('unavailable', ['The memory store is closed.'])

    try {
      const schemaVersion = readPragmaNumber(this.database, 'PRAGMA user_version', 'user_version')
      const check = readPragmaString(this.database, 'PRAGMA quick_check(1)', 'quick_check')
      const journalMode = readPragmaString(this.database, 'PRAGMA journal_mode', 'journal_mode')
      const issues: string[] = []
      if (schemaVersion !== SCHEMA_VERSION) issues.push('The memory store schema is incompatible.')
      if (check !== 'ok') issues.push('The memory store failed its integrity check.')
      if (journalMode.toLowerCase() !== 'wal') issues.push('The memory store is not using WAL mode.')
      return commonHealth(
        schemaVersion !== SCHEMA_VERSION || check !== 'ok'
          ? 'unavailable'
          : issues.length > 0 ? 'degraded' : 'healthy',
        issues,
      )
    } catch (error) {
      return commonHealth('unavailable', [classifyStorageError(error).message])
    }
  }

  async export(request: MemoryExportRequest): Promise<MemoryExportOutcome> {
    const parsed = MemoryExportRequestSchema.safeParse(request)
    if (!parsed.success) return rejectedOutcome('The memory export request is invalid.')
    const unavailable = this.requireOpen()
    if (unavailable) return operationFailureOutcome(unavailable.error)

    try {
      this.requireBoundProject(parsed.data.projectId)
      let afterSequence = 0
      if (parsed.data.afterEventId !== undefined) {
        const cursor = this.database
          .query(
            `SELECT sequence FROM memory_events
              WHERE event_id = ?1
                AND json_extract(metadata_json, '$.projectId') = ?2`,
          )
          .get(parsed.data.afterEventId, parsed.data.projectId) as { sequence: number } | null
        if (!cursor) return rejectedOutcome('The export cursor was not found.', 'not-found')
        afterSequence = cursor.sequence
      }
      const rows = this.database
        .query(
          `SELECT sequence, event_id, idempotency_key, event_type, occurred_at,
                  payload_json, metadata_json, task_id, session_id, artifact_id
             FROM memory_events
            WHERE sequence > ?1
              AND json_extract(metadata_json, '$.projectId') = ?2
            ORDER BY sequence
            LIMIT ?3`,
        )
        .all(afterSequence, parsed.data.projectId, parsed.data.limit) as EventRow[]
      const events = rows.map(envelopeFromRow)
      return {
        outcome: 'page',
        events,
        nextAfterEventId: rows.length === parsed.data.limit
          ? rows[rows.length - 1]?.event_id as MemoryEventEnvelope['eventId']
          : null,
      }
    } catch (error) {
      const failure = classifyStorageError(error)
      return failure.kind === 'invalid'
        ? rejectedOutcome(failure.message)
        : operationFailureOutcome(failure)
    }
  }

  async kernelHealth(): Promise<MemoryV2Health> {
    if (this.closed) {
      return unavailableHealth({
        kind: 'closed',
        message: 'The memory store is closed.',
        retryable: false,
      })
    }

    try {
      const schemaVersion = readPragmaNumber(this.database, 'PRAGMA user_version', 'user_version')
      if (schemaVersion !== SCHEMA_VERSION) {
        return unavailableHealth({
          kind: 'incompatible',
          message: 'The memory store schema is incompatible with this CLI.',
          retryable: false,
        }, schemaVersion)
      }
      const check = readPragmaString(this.database, 'PRAGMA quick_check(1)', 'quick_check')
      if (check !== 'ok') {
        return unavailableHealth({
          kind: 'corrupt',
          message: 'The memory store failed its integrity check.',
          retryable: false,
        }, schemaVersion)
      }

      const journalMode = readPragmaString(this.database, 'PRAGMA journal_mode', 'journal_mode')
      const synchronous = String(readPragmaNumber(this.database, 'PRAGMA synchronous', 'synchronous'))
      return {
        status: journalMode.toLowerCase() === 'wal' ? 'healthy' : 'degraded',
        schemaVersion,
        journalMode,
        synchronous,
        projectionCursor: this.readProjectionCursor(),
        capabilities: readCapabilities(this.database),
      }
    } catch (error) {
      return unavailableHealth(classifyStorageError(error))
    }
  }

  async search(): Promise<MemoryV2UnsupportedResult> {
    return unsupported('semantic-search')
  }

  async compact(): Promise<MemoryV2UnsupportedResult> {
    return unsupported('compaction')
  }

  async deleteEvents(): Promise<MemoryV2UnsupportedResult> {
    return unsupported('canonical-event-deletion')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private requireOpen(): { status: 'error'; error: MemoryV2Failure } | null {
    return this.closed
      ? {
          status: 'error',
          error: {
            kind: 'closed',
            message: 'The memory store is closed.',
            retryable: false,
          },
        }
      : null
  }

  private bindProject(projectId: string): void {
    const bound = this.readBoundProjectId()
    if (bound !== null && bound !== projectId) {
      throw new MemoryV2StorageError({
        kind: 'invalid',
        message: 'This memory database is already bound to a different project.',
        retryable: false,
      })
    }
    if (bound === null) {
      this.database
        .query("INSERT INTO memory_projection_metadata(key, value) VALUES ('project_id', ?1)")
        .run(projectId)
    }
  }

  private requireBoundProject(projectId: string): void {
    const bound = this.readBoundProjectId()
    if (bound === null) {
      const eventful = this.database
        .query('SELECT 1 AS present FROM memory_events LIMIT 1')
        .get() as { present: number } | null
      if (eventful) {
        throw new MemoryV2StorageError({
          kind: 'invalid',
          message: 'This eventful memory database is not bound to a valid project.',
          retryable: false,
        })
      }
      return
    }
    if (bound !== projectId) {
      throw new MemoryV2StorageError({
        kind: 'invalid',
        message: 'This memory database is bound to a different project.',
        retryable: false,
      })
    }
  }

  private readBoundProjectId(): string | null {
    const row = this.database
      .query("SELECT value FROM memory_projection_metadata WHERE key = 'project_id'")
      .get() as { value: string } | null
    return row?.value ?? null
  }

  private readLastEventIdForProject(projectId: string): string | null {
    const row = this.database
      .query(
        `SELECT event_id FROM memory_events
          WHERE json_extract(metadata_json, '$.projectId') = ?1
          ORDER BY sequence DESC LIMIT 1`,
      )
      .get(projectId) as { event_id: string } | null
    return row?.event_id ?? null
  }

  private readLastEventId(): string | null {
    const row = this.database
      .query('SELECT event_id FROM memory_events ORDER BY sequence DESC LIMIT 1')
      .get() as { event_id: string } | null
    return row?.event_id ?? null
  }

  private readProjectionCursor(): number {
    const row = this.database
      .query("SELECT value FROM memory_projection_metadata WHERE key = 'cursor'")
      .get() as { value: string } | null
    return row ? Number(row.value) : 0
  }
}

export async function openBunSQLiteMemoryRepository(
  options: BunSQLiteMemoryRepositoryOptions = {},
): Promise<BunSQLiteMemoryRepositoryOpenResult> {
  return BunSQLiteMemoryRepository.open(options)
}

function prepareDatabasePath(options: BunSQLiteMemoryRepositoryOptions): PreparedDatabasePath {
  const root = resolve(options.repositoryRoot ?? process.cwd())
  const requested = options.databasePath ?? DEFAULT_DATABASE_PATH
  const databasePath = isAbsolute(requested) ? resolve(requested) : resolve(root, requested)
  if (!isContainedPath(root, databasePath)) throw containedDatabaseError()

  mkdirSync(root, { recursive: true, mode: 0o700 })
  assertSafeDirectory(root)
  const realRoot = realpathSync(root)
  const parent = dirname(databasePath)
  const parentRelation = relative(root, parent)
  let current = root
  for (const component of parentRelation.split(/[\\/]/).filter(Boolean)) {
    current = join(current, component)
    if (existsSync(current)) assertSafeDirectory(current)
    else mkdirSync(current, { mode: 0o700 })
    chmodSync(current, 0o700)
  }

  const realParent = realpathSync(parent)
  if (!isContainedPath(realRoot, realParent)) throw containedDatabaseError()
  const entries = databasePaths(databasePath).map((path) => ({ path, entry: lstatExisting(path) }))
  for (const { entry } of entries) if (entry) assertSafeFileEntry(entry)
  const existingIdentity = entries[0]!.entry ? fileIdentity(databasePath) : null
  return { databasePath, realRoot, realParent, existingIdentity }
}

function databasePaths(databasePath: string): string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
}

function assertOwned(entry: Stats): void {
  if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) throw unsafeFilesystemError()
}

function assertSafeDirectory(path: string): void {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw unsafeFilesystemError()
  assertOwned(entry)
}

function lstatExisting(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code: unknown }).code === 'ENOENT') return null
    throw error
  }
}

function assertSafeFileEntry(entry: Stats): void {
  if (entry.isSymbolicLink() || !entry.isFile()) throw unsafeFilesystemError()
  assertOwned(entry)
}

function assertSafeFile(path: string): void {
  const entry = lstatExisting(path)
  if (!entry) throw unsafeFilesystemError()
  assertSafeFileEntry(entry)
}

function fileIdentity(path: string): FileIdentity {
  const entry = statSync(path)
  return { dev: entry.dev, ino: entry.ino }
}

function verifyOpenedDatabasePath(prepared: PreparedDatabasePath): void {
  const realDatabase = realpathSync(prepared.databasePath)
  if (!isContainedPath(prepared.realRoot, realDatabase)
    || !isContainedPath(prepared.realParent, realDatabase)
    || realpathSync(dirname(prepared.databasePath)) !== prepared.realParent) throw containedDatabaseError()
  assertSafeFile(prepared.databasePath)
  if (prepared.existingIdentity) {
    const opened = fileIdentity(prepared.databasePath)
    if (opened.dev !== prepared.existingIdentity.dev || opened.ino !== prepared.existingIdentity.ino) {
      throw unsafeFilesystemError()
    }
  }
  for (const path of databasePaths(prepared.databasePath).slice(1)) {
    const entry = lstatExisting(path)
    if (entry) assertSafeFileEntry(entry)
  }
}

function secureDatabaseFiles(prepared: PreparedDatabasePath): void {
  verifyOpenedDatabasePath(prepared)
  for (const path of databasePaths(prepared.databasePath)) {
    const entry = lstatExisting(path)
    if (!entry) continue
    assertSafeFileEntry(entry)
    chmodSync(path, 0o600)
  }
}

function preflightExistingDatabase(prepared: PreparedDatabasePath): void {
  if (!prepared.existingIdentity) return
  for (const path of databasePaths(prepared.databasePath)) {
    const entry = lstatExisting(path)
    if (entry) assertSafeFileEntry(entry)
  }
  let database: Database | undefined
  try {
    database = new Database(prepared.databasePath, { readonly: true, strict: true })
    const version = readPragmaNumber(database, 'PRAGMA user_version', 'user_version')
    if (readPragmaString(database, 'PRAGMA quick_check(1)', 'quick_check') !== 'ok') throw corruptStoreError()
    if (version > SCHEMA_VERSION) {
      throw new MemoryV2StorageError({
        kind: 'incompatible', message: 'The memory store was created by a newer, incompatible CLI.', retryable: false,
      })
    }
    if (version === 1 || version === 2) validateSchemaShape(database, version)
    else if (version !== 0) throw incompatibleSchemaError()
  } finally {
    database?.close()
  }
}

function validateSchemaShape(database: Database, version: number): void {
  const requiredTables = ['memory_events', 'memory_projection_metadata', 'memory_store_capabilities']
  if (version === 2) requiredTables.push(...PROJECTION_TABLES)
  const tables = database.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${requiredTables.map(() => '?').join(',')})`,
  ).all(...requiredTables) as Array<{ name: string }>
  if (tables.length !== requiredTables.length) throw incompatibleSchemaError()

  assertTableColumns(database, 'memory_events', [
    'sequence', 'event_id', 'idempotency_key', 'event_type', 'occurred_at',
    'payload_json', 'metadata_json', 'task_id', 'session_id', 'artifact_id',
  ])
  assertTableColumns(database, 'memory_projection_metadata', ['key', 'value'])
  assertTableColumns(database, 'memory_store_capabilities', ['name', 'available', 'fallback', 'value'])
  if (version === 2) {
    for (const table of PROJECTION_TABLES) {
      assertTableColumns(database, table, [
        'entity_id', 'task_id', 'session_id', 'state_json', 'source_sequence', 'updated_at',
      ])
    }
  }

  const triggers = database.query(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name IN ('memory_events_no_update', 'memory_events_no_delete')`,
  ).all() as Array<{ name: string; sql: string | null }>
  if (triggers.length !== 2) throw incompatibleSchemaError()
  for (const [name, operation] of [
    ['memory_events_no_update', 'update'],
    ['memory_events_no_delete', 'delete'],
  ] as const) {
    const sql = triggers.find((trigger) => trigger.name === name)?.sql
      ?.toLowerCase().replace(/\s+/g, ' ')
    if (!sql?.includes(`before ${operation} on memory_events`)
      || !sql.includes("raise(abort, 'canonical memory events are append only')")) {
      throw incompatibleSchemaError()
    }
  }
}

function assertTableColumns(database: Database, table: string, required: readonly string[]): void {
  const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  const names = new Set(columns.map(({ name }) => name))
  if (required.some((name) => !names.has(name))) throw incompatibleSchemaError()
}

function unsafeFilesystemError(): MemoryV2StorageError {
  return new MemoryV2StorageError({
    kind: 'incompatible', message: 'The memory store contains an unsafe filesystem entry.', retryable: false,
  })
}

function incompatibleSchemaError(): MemoryV2StorageError {
  return new MemoryV2StorageError({
    kind: 'incompatible', message: 'The memory store schema is incompatible with this CLI.', retryable: false,
  })
}

function corruptStoreError(): MemoryV2StorageError {
  return new MemoryV2StorageError({
    kind: 'corrupt', message: 'The memory store failed its integrity check.', retryable: false,
  })
}

function isContainedPath(parent: string, child: string): boolean {
  const relation = relative(parent, child)
  return relation !== '..'
    && !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(relation)
}

function containedDatabaseError(): MemoryV2StorageError {
  return new MemoryV2StorageError({
    kind: 'incompatible',
    message: 'The memory database must be contained within the repository.',
    retryable: false,
  })
}

function boundedBusyTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BUSY_TIMEOUT_MS
  if (!Number.isInteger(value) || value < 0) {
    throw new MemoryV2StorageError({
      kind: 'invalid',
      message: 'The SQLite busy timeout must be a non-negative integer.',
      retryable: false,
    })
  }
  return Math.min(Math.max(value, 1), MAX_BUSY_TIMEOUT_MS)
}

function migrate(database: Database): void {
  const version = readPragmaNumber(database, 'PRAGMA user_version', 'user_version')
  if (version > SCHEMA_VERSION) throw incompatibleSchemaError()

  database.exec('BEGIN IMMEDIATE')
  try {
    if (version < 1) database.exec(MIGRATION_1)
    if (version < 2) database.exec(MIGRATION_2)
    inferAndBindProject(database)
    if (version === 1) replayProjections(database)
    if (version !== SCHEMA_VERSION) database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function inferAndBindProject(database: Database): void {
  const bound = database.query(
    "SELECT value FROM memory_projection_metadata WHERE key = 'project_id'",
  ).get() as { value: string } | null
  const parsedBound = bound ? ProjectIdSchema.safeParse(bound.value) : null
  if (parsedBound && !parsedBound.success) throw invalidProjectStoreError()

  const count = (database.query('SELECT COUNT(*) AS count FROM memory_events').get() as { count: number }).count
  if (count === 0) return
  const rows = database.query(
    `SELECT json_extract(metadata_json, '$.projectId') AS project_id,
            json_type(metadata_json, '$.projectId') AS project_type
       FROM memory_events
      WHERE json_extract(metadata_json, '$.schemaVersion') = 2`,
  ).all() as Array<{ project_id: unknown; project_type: string | null }>
  if (rows.length === 0) return

  const projects = new Set<string>()
  for (const row of rows) {
    const parsedProjectId = row.project_type === 'text'
      ? ProjectIdSchema.safeParse(row.project_id)
      : null
    if (!parsedProjectId?.success) throw invalidProjectStoreError()
    projects.add(parsedProjectId.data)
    if (projects.size > 1) throw invalidProjectStoreError()
  }
  const projectId = [...projects][0]
  if (!projectId) throw invalidProjectStoreError()
  if (parsedBound?.success && parsedBound.data !== projectId) throw invalidProjectStoreError()
  if (!bound) database.query(
    "INSERT INTO memory_projection_metadata(key, value) VALUES ('project_id', ?1)",
  ).run(projectId)
}

function invalidProjectStoreError(): MemoryV2StorageError {
  return new MemoryV2StorageError({
    kind: 'incompatible', message: 'The memory store contains invalid or mixed project identities.', retryable: false,
  })
}

function replayProjections(database: Database): { cursor: number; projectedEvents: number } {
  let cursor = 0
  let projectedEvents = 0
  while (true) {
    const rows = database
      .query(
        `SELECT sequence, event_id, idempotency_key, event_type, occurred_at,
                payload_json, metadata_json, task_id, session_id, artifact_id
           FROM memory_events
          WHERE sequence > ?1
          ORDER BY sequence
          LIMIT ?2`,
      )
      .all(cursor, PAGE_SIZE) as EventRow[]
    if (rows.length === 0) break
    for (const row of rows) {
      validateCanonicalProjectionRow(row)
      applyProjection(database, preparedEventFromRow(row), row.sequence)
      cursor = row.sequence
      projectedEvents += 1
    }
  }
  const tail = (database
    .query('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM memory_events')
    .get() as { sequence: number }).sequence
  if (cursor !== tail) throw new Error('Projection replay did not reach the canonical tail.')
  setProjectionCursor(database, tail)
  return { cursor: tail, projectedEvents }
}

const MIGRATION_1 = `
  CREATE TABLE memory_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    task_id TEXT,
    session_id TEXT,
    artifact_id TEXT
  );
  CREATE INDEX memory_events_task_sequence ON memory_events(task_id, sequence);
  CREATE INDEX memory_events_session_sequence ON memory_events(session_id, sequence);
  CREATE TRIGGER memory_events_no_update BEFORE UPDATE ON memory_events
  BEGIN SELECT RAISE(ABORT, 'canonical memory events are append only'); END;
  CREATE TRIGGER memory_events_no_delete BEFORE DELETE ON memory_events
  BEGIN SELECT RAISE(ABORT, 'canonical memory events are append only'); END;
  CREATE TABLE memory_projection_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
  INSERT INTO memory_projection_metadata(key, value) VALUES ('cursor', '0');
  CREATE TABLE memory_store_capabilities (
    name TEXT PRIMARY KEY,
    available INTEGER NOT NULL CHECK (available IN (0, 1)),
    fallback TEXT,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
`

const MIGRATION_2 = `
  CREATE TABLE memory_tasks (
    entity_id TEXT PRIMARY KEY, task_id TEXT, session_id TEXT, state_json TEXT NOT NULL,
    source_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE memory_sessions (
    entity_id TEXT PRIMARY KEY, task_id TEXT, session_id TEXT, state_json TEXT NOT NULL,
    source_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE memory_artifacts (
    entity_id TEXT PRIMARY KEY, task_id TEXT, session_id TEXT, state_json TEXT NOT NULL,
    source_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE memory_claims (
    entity_id TEXT PRIMARY KEY, task_id TEXT, session_id TEXT, state_json TEXT NOT NULL,
    source_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE memory_evidence (
    entity_id TEXT PRIMARY KEY, task_id TEXT, session_id TEXT, state_json TEXT NOT NULL,
    source_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE memory_discoveries (
    entity_id TEXT PRIMARY KEY, task_id TEXT, session_id TEXT, state_json TEXT NOT NULL,
    source_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL
  ) WITHOUT ROWID;
`

function recordRuntimeCapabilities(database: Database, journalMode: string): void {
  let fts5 = false
  try {
    database.exec('CREATE VIRTUAL TABLE temp.memory_v2_fts_probe USING fts5(value)')
    database.exec('DROP TABLE temp.memory_v2_fts_probe')
    fts5 = true
  } catch {
    fts5 = false
  }

  const write = database.query(
    `INSERT INTO memory_store_capabilities(name, available, fallback, value)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(name) DO UPDATE SET
       available = excluded.available,
       fallback = excluded.fallback,
       value = excluded.value
     WHERE available IS NOT excluded.available
       OR fallback IS NOT excluded.fallback
       OR value IS NOT excluded.value`,
  )
  write.run('fts5', fts5 ? 1 : 0, fts5 ? null : 'lexical-scan-v1', fts5 ? 'fts5' : 'lexical-scan-v1')
  write.run('journal_mode', journalMode.toLowerCase() === 'wal' ? 1 : 0, journalMode.toLowerCase() === 'wal' ? null : journalMode, journalMode)
  write.run('lexical_fallback', 1, null, 'unicode-codepoint-order-v1')
  write.run('query', 1, null, 'bounded-lexical-v1')
  write.run('verify', 1, null, 'append-only-v1')
}

function prepareEvent(
  input: MemoryV2EventInput | MemoryEventDraft | MemoryEventEnvelope,
): PreparedEvent {
  if (!input || typeof input !== 'object') throw new Error('Event must be an object.')
  const value = input as unknown as Record<string, unknown>
  const eventId = requiredString(value.eventId ?? value.id, 'eventId', 512)
  const isEnvelope = value.schemaVersion === 2 && value.eventSchemaVersion === 1
  const idempotencyKey = requiredString(
    value.idempotencyKey ?? (isEnvelope ? `event:${eventId}` : value.eventId),
    'idempotencyKey',
    512,
  )
  const eventType = requiredString(value.eventType ?? value.type, 'eventType', 256)
  const occurredAt = requiredString(value.occurredAt ?? value.timestamp, 'occurredAt', 64)
  if (Number.isNaN(Date.parse(occurredAt))) throw new Error('occurredAt must be an ISO timestamp.')
  const payload = value.payload ?? {}
  const payloadRecord = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : {}
  const metadata = value.metadata ?? compactObject({
    schemaVersion: value.schemaVersion,
    eventSchemaVersion: value.eventSchemaVersion,
    projectId: value.projectId,
    sessionId: value.sessionId,
  })

  return {
    eventId,
    idempotencyKey,
    eventType,
    occurredAt,
    payload,
    payloadJson: stableJson(payload),
    metadata,
    metadataJson: stableJson(metadata),
    taskId: optionalString(value.taskId ?? payloadRecord.taskId, 'taskId', 512),
    sessionId: optionalString(value.sessionId, 'sessionId', 512),
    artifactId: optionalString(value.artifactId ?? payloadRecord.artifactId, 'artifactId', 512),
  }
}

function compactObject(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

function stableJson(value: unknown): string {
  const seen = new Set<object>()
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('JSON numbers must be finite.')
      return item
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) throw new Error('JSON values cannot contain cycles.')
      seen.add(item)
      const result = item.map(normalize)
      seen.delete(item)
      return result
    }
    if (typeof item === 'object') {
      if (seen.has(item)) throw new Error('JSON values cannot contain cycles.')
      seen.add(item)
      const record = item as Record<string, unknown>
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort(compareUnicodeCodePoints)) {
        if (record[key] !== undefined) result[key] = normalize(record[key])
      }
      seen.delete(item)
      return result
    }
    throw new Error('Event payload and metadata must be JSON values.')
  }
  return JSON.stringify(normalize(value))
}

function applyProjection(database: Database, event: PreparedEvent, sequence: number): void {
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : {}
  const canonical = event.metadata && typeof event.metadata === 'object'
    && (event.metadata as Record<string, unknown>).schemaVersion === 2

  switch (event.eventType) {
    case 'task.created':
      upsertProjection(database, 'memory_tasks', projectionId(payload.taskId), event, sequence, payload.taskId, {
        ...payload,
        status: payload.initialStatus,
      })
      return
    case 'task.transitioned': {
      const taskId = projectionId(payload.taskId)
      upsertProjection(database, 'memory_tasks', taskId, event, sequence, payload.taskId, {
        ...readProjectionState(database, 'memory_tasks', taskId),
        ...payload,
        status: payload.toStatus,
      })
      return
    }
    case 'session.started':
    case 'session.ended': {
      const sessionId = event.sessionId
      upsertProjection(database, 'memory_sessions', sessionId, event, sequence, payload.taskId, {
        ...readProjectionState(database, 'memory_sessions', sessionId),
        ...payload,
        sessionId,
        status: event.eventType === 'session.ended' ? payload.status : 'active',
      })
      return
    }
    case 'artifact.classified':
      upsertProjection(database, 'memory_artifacts', projectionId(payload.artifactId ?? nestedValue(payload.artifact, 'artifactId')), event, sequence, payload.taskId, payload)
      return
    case 'observation.recorded': {
      const observation = objectValue(payload.observation)
      const observationId = projectionId(observation.observationId)
      upsertProjection(database, 'memory_discoveries', observationId, event, sequence, observation.taskId, observation)
      upsertClaim(database, event, sequence, observationId, 'canonical', observation)
      return
    }
    case 'claim.consolidated': {
      for (const sourceId of stringArray(payload.sourceObservationIds)) {
        markProjectionLifecycle(database, 'memory_discoveries', sourceId, event, sequence, 'superseded')
        markProjectionLifecycle(database, 'memory_claims', sourceId, event, sequence, 'superseded')
      }
      const observation = objectValue(payload.canonicalObservation)
      const observationId = projectionId(observation.observationId)
      upsertProjection(database, 'memory_discoveries', observationId, event, sequence, observation.taskId, observation)
      upsertClaim(database, event, sequence, observationId, 'consolidated', observation)
      return
    }
    case 'claim.corrected':
      upsertClaim(database, event, sequence, projectionId(payload.observationId), 'corrected', payload)
      upsertClaim(database, event, sequence, projectionId(nestedValue(payload.correction, 'observationId')), 'canonical', objectValue(payload.correction))
      return
    case 'claim.superseded':
      upsertClaim(database, event, sequence, projectionId(payload.observationId), 'superseded', payload)
      return
    case 'claim.forgotten':
      for (const observationId of stringArray(payload.observationIds)) {
        upsertClaim(database, event, sequence, observationId, 'forgotten', payload)
      }
      return
    case 'claim.pinned':
      upsertClaim(database, event, sequence, projectionId(payload.observationId), 'pinned', payload)
      return
    case 'evidence.attached':
      for (const evidence of objectArray(payload.evidence)) {
        upsertEvidence(database, event, sequence, projectionId(payload.observationId), evidence, 'attached')
      }
      return
    case 'coverage.recorded':
      upsertProjection(database, 'memory_discoveries', projectionId(payload.taskId + ':' + payload.dimension), event, sequence, payload.taskId, payload)
      return
    case 'evidence.verified':
      upsertEvidence(database, event, sequence, projectionId(payload.observationId), payload, 'verified')
      return
    case 'evidence.invalidated':
      upsertEvidence(database, event, sequence, projectionId(payload.observationId), payload, 'invalidated')
      return
    case 'evidence.rebound': {
      const observationId = projectionId(payload.observationId)
      const previousSelector = objectValue(payload.previousSelector)
      const replacement = objectValue(payload.evidence)
      upsertEvidence(database, event, sequence, observationId, { selector: previousSelector }, 'rebound')
      upsertEvidence(database, event, sequence, observationId, replacement, 'attached')
      return
    }
    default:
      if (canonical) return
  }

  const kind = event.eventType.split(/[.:/]/, 1)[0].toLowerCase()
  const definition = PROJECTIONS[kind]
  if (!definition) return
  const explicit = definition.explicitId ? event[definition.explicitId] : null
  const candidate = projectionId(explicit ?? payload[definition.payloadId] ?? payload.id)
  upsertProjection(database, definition.table, candidate, event, sequence, event.taskId, payload)
}

function readProjectionState(database: Database, table: string, entityId: string | null): Record<string, unknown> {
  if (!entityId) return {}
  const row = database.query(`SELECT state_json FROM ${table} WHERE entity_id = ?1`).get(entityId) as { state_json: string } | null
  return row ? objectValue(JSON.parse(row.state_json) as unknown) : {}
}

function markProjectionLifecycle(database: Database, table: string, entityId: string, event: PreparedEvent, sequence: number, lifecycle: string): void {
  const prior = readProjectionState(database, table, entityId)
  if (Object.keys(prior).length > 0) upsertProjection(database, table, entityId, event, sequence, prior.taskId, { ...prior, lifecycle })
}

function upsertClaim(
  database: Database,
  event: PreparedEvent,
  sequence: number,
  observationId: string | null,
  lifecycle: string,
  value: Record<string, unknown>,
): void {
  const prior = readProjectionState(database, 'memory_claims', observationId)
  upsertProjection(database, 'memory_claims', observationId, event, sequence, value.taskId, {
    ...prior,
    lifecycle,
    observationId,
    value: { ...objectValue(prior.value), ...value },
  })
}

function upsertEvidence(
  database: Database,
  event: PreparedEvent,
  sequence: number,
  observationId: string | null,
  value: Record<string, unknown>,
  lifecycle: string,
): void {
  const selector = objectValue(value.selector)
  if (!observationId || Object.keys(selector).length === 0) return
  const entityId = `${observationId}:${stableJson(selector)}`
  const prior = readProjectionState(database, 'memory_evidence', entityId)
  const evidence = Object.keys(objectValue(prior.evidence)).length > 0
    ? objectValue(prior.evidence)
    : lifecycle === 'attached' ? value : {}
  upsertProjection(database, 'memory_evidence', entityId, event, sequence, value.taskId, {
    ...prior,
    lifecycle,
    observationId,
    evidence,
    freshness: lifecycle === 'attached' ? {} : value,
  })
}

function upsertProjection(
  database: Database,
  table: string,
  entityId: string | null,
  event: PreparedEvent,
  sequence: number,
  taskId: unknown,
  state: unknown,
): void {
  if (!entityId) return
  database
    .query(
      `INSERT INTO ${table} (
         entity_id, task_id, session_id, state_json, source_sequence, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(entity_id) DO UPDATE SET
         task_id = excluded.task_id,
         session_id = excluded.session_id,
         state_json = excluded.state_json,
         source_sequence = excluded.source_sequence,
         updated_at = excluded.updated_at`,
    )
    .run(entityId, projectionId(taskId) ?? event.taskId, event.sessionId, stableJson(state), sequence, event.occurredAt)
}

function projectionId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function nestedValue(value: unknown, key: string): unknown {
  return objectValue(value)[key]
}

function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectValue) : []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(projectionId).filter((item): item is string => item !== null) : []
}

function setProjectionCursor(database: Database, sequence: number): void {
  database
    .query("UPDATE memory_projection_metadata SET value = ?1 WHERE key = 'cursor'")
    .run(String(sequence))
}

function isIdempotentMatch(row: EventRow, event: PreparedEvent): boolean {
  return row.event_id === event.eventId
    && row.idempotency_key === event.idempotencyKey
    && row.event_type === event.eventType
    && row.occurred_at === event.occurredAt
    && row.payload_json === event.payloadJson
    && row.metadata_json === event.metadataJson
    && row.task_id === event.taskId
    && row.session_id === event.sessionId
    && row.artifact_id === event.artifactId
}

function validateCanonicalProjectionRow(row: EventRow): void {
  const metadata = objectValue(JSON.parse(row.metadata_json) as unknown)
  if (metadata.schemaVersion !== 2 || !CANONICAL_EVENT_TYPES.has(row.event_type)) return
  try {
    envelopeFromRow(row)
  } catch {
    throw new MemoryV2StorageError({
      kind: 'incompatible',
      message: 'The memory store contains an invalid canonical event.',
      retryable: false,
    })
  }
}

function preparedEventFromRow(row: EventRow): PreparedEvent {
  const payload = JSON.parse(row.payload_json) as unknown
  const metadata = JSON.parse(row.metadata_json) as unknown
  return {
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    payload,
    payloadJson: row.payload_json,
    metadata,
    metadataJson: row.metadata_json,
    taskId: row.task_id,
    sessionId: row.session_id,
    artifactId: row.artifact_id,
  }
}

function eventProjectId(event: PreparedEvent): string | null {
  if (!event.metadata || typeof event.metadata !== 'object') return null
  const projectId = (event.metadata as Record<string, unknown>).projectId
  return typeof projectId === 'string' ? projectId : null
}

function envelopeFromRow(row: EventRow): MemoryEventEnvelope {
  const event = preparedEventFromRow(row)
  if (!event.metadata || typeof event.metadata !== 'object') {
    throw new Error('Stored canonical event metadata is invalid.')
  }
  const metadata = event.metadata as Record<string, unknown>
  const parsed = MemoryEventEnvelopeSchema.safeParse({
    schemaVersion: metadata.schemaVersion,
    eventSchemaVersion: metadata.eventSchemaVersion,
    eventType: event.eventType,
    eventId: event.eventId,
    projectId: metadata.projectId,
    sessionId: metadata.sessionId,
    sequence: row.sequence,
    occurredAt: event.occurredAt,
    payload: event.payload,
  })
  if (!parsed.success) throw new Error('Stored canonical event is invalid.')
  return parsed.data
}

function storedEventFromRow(row: EventRow): MemoryV2StoredEvent {
  const event = preparedEventFromRow(row)
  return {
    sequence: row.sequence,
    eventId: event.eventId,
    idempotencyKey: event.idempotencyKey,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    payload: event.payload,
    metadata: event.metadata,
    taskId: event.taskId ?? undefined,
    sessionId: event.sessionId ?? undefined,
    artifactId: event.artifactId ?? undefined,
  }
}

function readProjectionRows(database: Database, table: string): ProjectionRow[] {
  const rows = database
    .query(
      `SELECT entity_id, task_id, session_id, state_json, source_sequence, updated_at
         FROM ${table} ORDER BY entity_id`,
    )
    .all() as Array<{
      entity_id: string
      task_id: string | null
      session_id: string | null
      state_json: string
      source_sequence: number
      updated_at: string
    }>
  return rows.map((row) => ({
    entityId: row.entity_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    state: JSON.parse(row.state_json) as unknown,
    sourceSequence: row.source_sequence,
    updatedAt: row.updated_at,
  }))
}

function selectorKey(selector: MemorySelector): string {
  if (selector.kind === 'uri-fragment') return `${selector.uri.toLowerCase()}#${selector.fragment.toLowerCase()}`
  const base = selector.path.replaceAll('\\', '/').toLowerCase()
  if (selector.kind === 'symbol') return `${base}#${selector.symbol.toLowerCase()}`
  if (selector.kind === 'json-pointer') return `${base}#${selector.pointer.toLowerCase()}`
  if (selector.kind === 'line-range') return `${base}:${selector.startLine}-${selector.endLine}`
  return base
}

function scanQueryRows(database: Database, projectId: string): QueryScanResult {
  const admission = database.query(
    `SELECT sequence,
            length(CAST(payload_json AS BLOB)) AS payload_bytes,
            length(CAST(metadata_json AS BLOB)) AS metadata_bytes
       FROM memory_events
      WHERE json_extract(metadata_json, '$.projectId') = ?1
      ORDER BY sequence DESC
      LIMIT ?2`,
  ).all(projectId, MAX_QUERY_EVENTS + 1) as QueryAdmissionRow[]
  const sequences: number[] = []
  let bytes = 0
  let payloadBudgetReached = false
  for (const row of admission.slice(0, MAX_QUERY_EVENTS)) {
    const rowBytes = row.payload_bytes + row.metadata_bytes
    if (bytes + rowBytes > MAX_QUERY_PAYLOAD_BYTES) {
      payloadBudgetReached = true
      break
    }
    sequences.push(row.sequence)
    bytes += rowBytes
  }
  if (sequences.length === 0) {
    return { rows: [], eventCapReached: admission.length > MAX_QUERY_EVENTS, payloadBudgetReached }
  }
  const rows = database.query(
    `SELECT sequence, event_id, idempotency_key, event_type, occurred_at,
            payload_json, metadata_json, task_id, session_id, artifact_id
       FROM memory_events
      WHERE sequence IN (${sequences.map(() => '?').join(',')})
      ORDER BY sequence DESC`,
  ).all(...sequences) as EventRow[]
  return { rows, eventCapReached: admission.length > MAX_QUERY_EVENTS, payloadBudgetReached }
}

function lexicalTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9._:/-]+/).filter((token) => token.length > 1).slice(0, 128))
}

function reason(code: RankingReason['code'], contribution: number, detail: string): RankingReason {
  return { code, contribution, detail }
}

function buildLexicalResult(
  request: MemoryRetrievalRequest,
  events: MemoryEventEnvelope[],
  eventCapReached: boolean,
  payloadBudgetReached: boolean,
) {
  type ObservationState = {
    observation: MemoryObservation
    sourceSequence: number
    sourceEventId: string
    forgotten: boolean
    superseded: boolean
    corrected: boolean
    pinned: boolean
    freshness: Map<string, {
      state: 'verified' | 'invalid'
      at: string
      reason?: string
      observedDigest?: string
      workspaceRevision?: number
      workspaceSnapshotId?: string
    }>
  }
  type TaskState = { taskId: string; title: string; objective: string; status: 'created' | 'active' | 'blocked' | 'completed' | 'failed' | 'cancelled'; sourceSequence: number; eventId: string }
  const observations = new Map<string, ObservationState>()
  const tasks = new Map<string, TaskState>()

  for (const event of events) {
    if (event.eventType === 'task.created') {
      tasks.set(event.payload.taskId, {
        taskId: event.payload.taskId,
        title: event.payload.title,
        objective: event.payload.objective,
        status: event.payload.initialStatus,
        sourceSequence: event.sequence,
        eventId: event.eventId,
      })
    } else if (event.eventType === 'task.transitioned') {
      const task = tasks.get(event.payload.taskId)
      if (task) tasks.set(task.taskId, { ...task, status: event.payload.toStatus, sourceSequence: event.sequence, eventId: event.eventId })
    } else if (event.eventType === 'observation.recorded') {
      observations.set(event.payload.observation.observationId, {
        observation: event.payload.observation,
        sourceSequence: event.sequence,
        sourceEventId: event.eventId,
        forgotten: false,
        superseded: false,
        corrected: false,
        pinned: false,
        freshness: new Map(),
      })
    } else if (event.eventType === 'evidence.attached') {
      const state = observations.get(event.payload.observationId)
      if (state) state.observation = { ...state.observation, evidence: [...state.observation.evidence, ...event.payload.evidence].slice(0, 32) }
    } else if (event.eventType === 'claim.consolidated') {
      for (const id of event.payload.sourceObservationIds) {
        const source = observations.get(id)
        if (source) source.superseded = true
      }
      observations.set(event.payload.canonicalObservation.observationId, {
        observation: event.payload.canonicalObservation,
        sourceSequence: event.sequence,
        sourceEventId: event.eventId,
        forgotten: false,
        superseded: false,
        corrected: false,
        pinned: false,
        freshness: new Map(),
      })
    } else if (event.eventType === 'claim.corrected') {
      const prior = observations.get(event.payload.observationId)
      if (prior) prior.corrected = true
      observations.set(event.payload.correction.observationId, {
        observation: event.payload.correction,
        sourceSequence: event.sequence,
        sourceEventId: event.eventId,
        forgotten: false,
        superseded: false,
        corrected: false,
        pinned: prior?.pinned ?? false,
        freshness: new Map(),
      })
    } else if (event.eventType === 'claim.forgotten') {
      for (const id of event.payload.observationIds) {
        const state = observations.get(id)
        if (state) state.forgotten = true
      }
    } else if (event.eventType === 'claim.superseded') {
      const state = observations.get(event.payload.observationId)
      if (state) state.superseded = true
    } else if (event.eventType === 'claim.pinned') {
      const state = observations.get(event.payload.observationId)
      if (state) state.pinned = true
    } else if (event.eventType === 'evidence.verified') {
      const state = observations.get(event.payload.observationId)
      state?.freshness.set(selectorKey(event.payload.selector), {
        state: 'verified',
        at: event.payload.verifiedAt,
        observedDigest: event.payload.observedDigest,
        workspaceRevision: event.payload.workspaceRevision,
        workspaceSnapshotId: event.payload.workspaceSnapshotId,
      })
    } else if (event.eventType === 'evidence.invalidated') {
      const state = observations.get(event.payload.observationId)
      state?.freshness.set(selectorKey(event.payload.selector), { state: 'invalid', at: event.payload.invalidatedAt, reason: event.payload.reason })
    } else if (event.eventType === 'evidence.rebound') {
      const state = observations.get(event.payload.observationId)
      if (state) {
        state.observation = { ...state.observation, evidence: [...state.observation.evidence.filter((e) => selectorKey(e.selector) !== selectorKey(event.payload.previousSelector)), event.payload.evidence] }
        state.freshness.delete(selectorKey(event.payload.previousSelector))
      }
    }
  }

  const queryTokens = lexicalTokens([request.query, ...request.selectors.map(selectorKey)].join(' '))
  const requestedSelectors = new Set(request.selectors.map(selectorKey))
  const contextMatches = (evidence: MemoryObservation['evidence'][number], freshness: ObservationState['freshness'] extends Map<string, infer F> ? F : never) => {
    if (freshness.state !== 'verified') return false
    if ('path' in evidence.selector && freshness.observedDigest !== evidence.contentDigest) return false
    const requestHasContext = request.workspaceRevision !== undefined || request.workspaceSnapshotId !== undefined
    const verificationHasContext = freshness.workspaceRevision !== undefined || freshness.workspaceSnapshotId !== undefined
    if (requestHasContext || verificationHasContext) {
      return request.workspaceRevision === freshness.workspaceRevision
        && request.workspaceSnapshotId === freshness.workspaceSnapshotId
    }
    return true
  }
  const rank = (text: string, taskId: string | undefined, selectors: MemorySelector[], verified: boolean, pinned: boolean, sourceSequence: number) => {
    const candidateTokens = lexicalTokens(text)
    let tokenMatches = 0
    for (const token of queryTokens) if (candidateTokens.has(token)) tokenMatches++
    const selectorMatch = selectors.some((selector) => requestedSelectors.has(selectorKey(selector)))
    const taskMatch = request.taskId !== undefined && request.taskId === taskId
    const reasons: RankingReason[] = []
    if (taskMatch) reasons.push(reason('task-match', 0.25, 'The task ID exactly matches the requested task.'))
    if (selectorMatch) reasons.push(reason('selector-match', 0.25, 'A selector exactly matches the request.'))
    if (tokenMatches > 0) reasons.push(reason('semantic-match', Math.min(0.3, tokenMatches * 0.06), `${tokenMatches} lexical token match(es).`))
    if (verified) reasons.push(reason('verified-evidence', 0.15, 'The observation has current verified evidence.'))
    if (pinned) reasons.push(reason('reusability', 0.04, 'The observation is pinned.'))
    reasons.push(reason('recency', 0.01, `Canonical source sequence ${sourceSequence}.`))
    return { score: Math.min(1, reasons.reduce((sum, item) => sum + Math.max(0, item.contribution), 0)), reasons, exact: Number(taskMatch) + Number(selectorMatch), tokenMatches, verified: Number(verified), pinned: Number(pinned), sourceSequence }
  }
  const compare = <T extends { ranking: ReturnType<typeof rank>; id: string }>(left: T, right: T) =>
    right.ranking.exact - left.ranking.exact
    || right.ranking.tokenMatches - left.ranking.tokenMatches
    || right.ranking.verified - left.ranking.verified
    || right.ranking.pinned - left.ranking.pinned
    || right.ranking.sourceSequence - left.ranking.sourceSequence
    || compareUnicodeCodePoints(left.id, right.id)

  const taskCandidates = [...tasks.values()]
    .filter((task) => !request.taskId || task.taskId === request.taskId)
    .map((task) => ({ id: task.taskId, task, ranking: rank(`${task.taskId} ${task.title} ${task.objective}`, task.taskId, [], false, false, task.sourceSequence) }))
    .filter((item) => item.ranking.tokenMatches > 0 || item.ranking.exact > 0)
    .sort(compare)
  const observationCandidates = [...observations.values()]
    .map((state) => {
      const selectors = state.observation.selectors ?? state.observation.evidence.map(({ selector }) => selector)
      const verified = state.observation.evidence.some((evidence) => {
        const freshness = state.freshness.get(selectorKey(evidence.selector))
        return freshness !== undefined && contextMatches(evidence, freshness)
      })
      return { id: state.observation.observationId, state, selectors, ranking: rank(`${state.observation.taskId} ${state.observation.kind} ${state.observation.summary} ${state.observation.detail} ${selectors.map(selectorKey).join(' ')}`, state.observation.taskId, selectors, verified, state.pinned, state.sourceSequence) }
    })
    .filter((item) => (!request.taskId || item.state.observation.taskId === request.taskId)
      && (request.artifactKinds.length === 0 || item.state.observation.evidence.some(({ artifact }) => request.artifactKinds.includes(artifact.classification.kind)))
      && (item.ranking.tokenMatches > 0 || item.ranking.exact > 0 || item.state.pinned))
    .sort(compare)

  const limit = request.maxResultsPerCategory
  const verifiedCandidates = observationCandidates.filter(({ state }) => !state.forgotten && !state.superseded && !state.corrected && state.observation.evidence.some((evidence) => {
    const freshness = state.freshness.get(selectorKey(evidence.selector))
    return freshness !== undefined && contextMatches(evidence, freshness)
  }))
  const reusableCandidates = observationCandidates.filter(({ state }) => !state.forgotten && !state.superseded && !state.corrected && state.observation.kind === 'discovery')
  const rereadCandidates = observationCandidates.filter(({ state }) => !state.forgotten && !state.superseded && !state.corrected).flatMap(({ state, selectors, ranking }) => selectors.map((selector) => {
    const freshness = state.freshness.get(selectorKey(selector))
    const evidence = state.observation.evidence.find((item) => selectorKey(item.selector) === selectorKey(selector))
    if (freshness && evidence && contextMatches(evidence, freshness)) return null
    const rereadReason = freshness?.reason === 'missing' ? 'missing' : freshness?.reason === 'expired' ? 'expired' : freshness?.state === 'invalid' ? 'changed' : 'never-verified'
    return { observationId: state.observation.observationId, selector, reason: rereadReason as 'never-verified' | 'changed' | 'missing' | 'expired', detail: freshness?.state === 'invalid' ? 'The latest evidence state is invalidated; reread before use.' : 'This selector requires verification in the current workspace context.', score: ranking.score, reasons: [...ranking.reasons, reason('stale-evidence', -0.2, 'Current evidence is unavailable.')].slice(0, 16) }
  }).filter((item): item is NonNullable<typeof item> => item !== null))
  const historicalCandidates = request.includeHistorical
    ? observationCandidates.filter(({ state }) => state.forgotten || state.superseded || state.corrected)
    : []
  const matchedTasks = taskCandidates.slice(0, limit).map(({ task, ranking }) => ({ taskId: task.taskId, title: task.title, status: task.status, summary: task.objective, score: ranking.score, reasons: ranking.reasons }))
  const verifiedKnowledge = verifiedCandidates.slice(0, limit).map(({ state, ranking }) => {
    const verifiedSelectors = [...state.freshness].filter(([key, freshness]) => {
      const evidence = state.observation.evidence.find((item) => selectorKey(item.selector) === key)
      return evidence !== undefined && contextMatches(evidence, freshness)
    })
    const verifiedEvidence = verifiedSelectors.map(([key]) => state.observation.evidence.find((evidence) => selectorKey(evidence.selector) === key)).filter((evidence): evidence is MemoryObservation['evidence'][number] => evidence !== undefined)
    const verifiedAt = verifiedSelectors.map(([, freshness]) => freshness.at).sort(compareUnicodeCodePoints).at(-1)!
    return { observation: state.observation, verifiedEvidence, verifiedAt, score: ranking.score, reasons: ranking.reasons }
  }).filter(({ verifiedEvidence }) => verifiedEvidence.length > 0)
  const reusableDiscovery = reusableCandidates.slice(0, limit).map(({ state, ranking }) => ({ observation: state.observation, reuseGuidance: state.pinned ? 'Pinned discovery; verify selectors before reuse.' : 'Verify selectors before reusing this discovery.', score: ranking.score, reasons: ranking.reasons }))
  const rereadRequired = rereadCandidates.slice(0, limit)
  const historicalContext = historicalCandidates.slice(0, limit).map(({ state, ranking }) => ({ taskId: state.observation.taskId, summary: state.observation.summary, eventIds: [state.sourceEventId], score: ranking.score, reasons: [...ranking.reasons, reason('historical-only', -0.1, 'This observation is historical only.')].slice(0, 16) }))
  const categories = { matchedTasks, verifiedKnowledge, reusableDiscovery, rereadRequired, historicalContext }
  const rankingReasons = [
    ...matchedTasks.map((value) => ({ category: 'matchedTasks' as const, targetId: value.taskId, reasons: value.reasons })),
    ...verifiedKnowledge.map((value) => ({ category: 'verifiedKnowledge' as const, targetId: value.observation.observationId, reasons: value.reasons })),
    ...reusableDiscovery.map((value) => ({ category: 'reusableDiscovery' as const, targetId: value.observation.observationId, reasons: value.reasons })),
    ...rereadRequired.map((value) => ({ category: 'rereadRequired' as const, targetId: value.observationId, reasons: value.reasons })),
    ...historicalContext.map((value) => ({ category: 'historicalContext' as const, targetId: value.taskId ?? value.eventIds[0]!, reasons: value.reasons })),
  ]
  const resultCapReached = eventCapReached
    || taskCandidates.length > limit
    || verifiedCandidates.length > limit
    || reusableCandidates.length > limit
    || rereadCandidates.length > limit
    || historicalCandidates.length > limit
  const degradationReasons = [
    ...(resultCapReached ? [{ code: 'result-cap-reached' as const, detail: 'The deterministic result or event cap was reached.', retryable: false }] : []),
    ...(payloadBudgetReached ? [{ code: 'resource-budget' as const, detail: 'The deterministic query resource budget was reached.', retryable: false }] : []),
  ]
  return MemoryRetrievalResultSchema.parse({
    schemaVersion: 2,
    queryId: request.queryId,
    projectId: request.projectId,
    generatedAt: events.at(-1)?.occurredAt ?? '1970-01-01T00:00:00.000Z',
    ...categories,
    degradation: degradationReasons.length > 0 ? { state: 'degraded', reasons: degradationReasons } : { state: 'none' },
    rankingReasons: rankingReasons.slice(0, limit * 5),
  })
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!)
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index]! - rightPoints[index]!
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

function readCapabilities(database: Database): MemoryV2Capability[] {
  const rows = database
    .query('SELECT name, available, fallback, value FROM memory_store_capabilities ORDER BY name')
    .all() as Array<{ name: string; available: number; fallback: string | null; value: string }>
  return rows.map((row) => ({ ...row, available: row.available === 1 }))
}

function readPragmaString(database: Database, sql: string, key: string): string {
  const row = database.query(sql).get() as Record<string, unknown> | null
  const value = row?.[key] ?? (row ? Object.values(row)[0] : undefined)
  if (typeof value !== 'string') throw new Error('Unexpected SQLite pragma response.')
  return value
}

function readPragmaNumber(database: Database, sql: string, key: string): number {
  const row = database.query(sql).get() as Record<string, unknown> | null
  const value = row?.[key] ?? (row ? Object.values(row)[0] : undefined)
  if (typeof value !== 'number') throw new Error('Unexpected SQLite pragma response.')
  return value
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
    throw new Error(`${name} must be a non-empty bounded string.`)
  }
  return value
}

function optionalString(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null) return null
  return requiredString(value, name, max)
}

function validNonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new MemoryV2StorageError({
    kind: 'invalid', message: 'The event cursor must be a non-negative integer.', retryable: false,
  })
  return value
}

function validPositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new MemoryV2StorageError({
    kind: 'invalid', message: 'The event limit must be a positive integer.', retryable: false,
  })
  return value
}

function operationError(
  code: MemoryOperationError['code'],
  message: string,
  retryable: boolean,
): MemoryOperationError {
  return { code, message, retryable }
}

function rejectedOutcome(
  message: string,
  code: MemoryOperationError['code'] = 'invalid-request',
): { outcome: 'rejected'; error: MemoryOperationError } {
  return { outcome: 'rejected', error: operationError(code, message, false) }
}

function failedOutcome(
  code: MemoryOperationError['code'],
  message: string,
  retryable: boolean,
): { outcome: 'failed'; error: MemoryOperationError } {
  return { outcome: 'failed', error: operationError(code, message, retryable) }
}

function operationFailureOutcome(
  failure: MemoryV2Failure,
): { outcome: 'failed'; error: MemoryOperationError } {
  return failedOutcome(
    failure.kind === 'busy' || failure.kind === 'closed' || failure.kind === 'io'
      ? 'unavailable'
      : 'internal',
    failure.message,
    failure.retryable,
  )
}

function appendFailureOutcome(failure: MemoryV2Failure): MemoryAppendOutcome {
  if (failure.kind === 'conflict') {
    return {
      outcome: 'rejected',
      error: operationError('conflict', failure.message, true),
    }
  }
  if (failure.kind === 'invalid') return rejectedOutcome(failure.message)
  return operationFailureOutcome(failure)
}

function commonHealth(
  status: MemoryHealth['status'],
  issues: string[],
): MemoryHealth {
  return {
    schemaVersion: 2,
    status,
    checkedAt: new Date().toISOString(),
    authority: status === 'unavailable'
      ? { kind: 'unavailable', writable: false, reason: issues[0] ?? 'The memory store is unavailable.' }
      : { kind: 'authoritative', writable: true, source: 'Bun SQLite Memory V2' },
    backend: {
      backendId: 'bun-sqlite-memory-v2',
      kind: 'local-persistent',
      persistence: 'durable',
      capabilities: ['append', 'query', 'verify', 'rebuild', 'health', 'export'],
    },
    issues,
  }
}

function invalidEventFailure(error: unknown): MemoryV2Failure {
  return {
    kind: 'invalid',
    message: error instanceof Error ? error.message : 'The event is invalid.',
    retryable: false,
  }
}

function classifyStorageError(error: unknown): MemoryV2Failure {
  if (error instanceof MemoryV2StorageError) return error.failure
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code).toUpperCase()
    : ''
  const message = error instanceof Error ? error.message.toUpperCase() : ''
  const signature = `${code} ${message}`

  if (signature.includes('SQLITE_BUSY') || signature.includes('SQLITE_LOCKED')
    || signature.includes('DATABASE IS LOCKED') || code === '5' || code === '6') {
    return { kind: 'busy', message: 'The memory store is busy; retry shortly.', retryable: true }
  }
  if (signature.includes('SQLITE_CORRUPT') || signature.includes('SQLITE_NOTADB') || signature.includes('NOT A DATABASE') || signature.includes('MALFORMED')) {
    return { kind: 'corrupt', message: 'The memory store is corrupt or unreadable.', retryable: false }
  }
  if (signature.includes('SQLITE_SCHEMA') || signature.includes('SQLITE_MISMATCH')) {
    return { kind: 'incompatible', message: 'The memory store schema is incompatible with this CLI.', retryable: false }
  }
  return { kind: 'io', message: 'The memory store could not complete a local I/O operation.', retryable: false }
}

function unavailableHealth(failure: MemoryV2Failure, schemaVersion: number | null = null): MemoryV2Health {
  return {
    status: 'unavailable',
    schemaVersion,
    journalMode: null,
    synchronous: null,
    projectionCursor: null,
    capabilities: [],
    failure,
  }
}

function unsupported(capability: string): MemoryV2UnsupportedResult {
  return {
    status: 'unsupported',
    capability,
    message: `Memory V2 ${capability} is not implemented by the Bun SQLite kernel.`,
  }
}
