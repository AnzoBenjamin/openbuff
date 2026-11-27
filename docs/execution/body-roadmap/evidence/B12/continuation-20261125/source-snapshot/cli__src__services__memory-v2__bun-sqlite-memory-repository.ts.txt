import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { checkSQLiteIntegrity } from './sqlite-integrity-check'
import {
  KNOWLEDGE_PROJECTION_DDL,
  KNOWLEDGE_FTS_DDL,
  KNOWLEDGE_PRODUCER_VERSION,
  applyKnowledgeEvent,
  advanceKnowledgeCursor,
  knowledgeCursor,
  clearKnowledgeProjection,
  exactKnowledgeIdentity,
  knowledgeFreshnessKey,
  type KnowledgeObservationState,
  type KnowledgeTaskState,
} from './knowledge-projection'
import {
  knowledgeQueryPlan,
  readKnowledgeQuery,
  scanKnowledgeQuery,
  type KnowledgeQueryRows,
} from './knowledge-query'
import {
  migrateContextArchiveSchema,
  migrateArchivePage,
  archiveFtsAvailable,
  prepareArchiveSnapshot,
  putArchiveSnapshot,
  readArchiveSnapshot,
  collectArchiveOrphans,
  repairArchiveFts,
  disableArchiveFtsTriggers,
  archiveSnapshotId,
  type ArchiveManifestRow,
} from './context-archive-store'

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
  MemoryObservationSchema,
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
  type MemoryProvenance,
  type MemoryRebuildOutcome,
  type MemoryRebuildRequest,
  type MemoryRetrievalRequest,
  type MemoryObservation,
  type MemorySelector,
  type RankingReason,
  type MemoryVerifyOutcome,
  type MemoryVerifyRequest,
} from '../../../../common/src/types/memory-v2'
import {
  deriveUsefulnessTier,
  scoreUsefulness,
  type UsefulnessTier,
} from './usefulness-scorer'
import {
  observationIdsReferencedBy,
  selectCompactionCandidates,
  type GCRelevantEnvelope,
} from '../../../../common/src/util/compaction-eligibility'
import type { ContextArchiveSnapshot } from '../../../../common/src/types/context-archive'
import { sanitizeFtsQuery } from '../../../../common/src/util/fts5-query'
import type {
  ContextArchiveSearchMatch,
  ContextArchiveSearchOutcome,
  GcCandidateSelection,
  MemoryObservationStatusEntry,
  MemoryObservationStatusReadRequest,
  MemoryRepositoryV2,
  MemoryStoreStats,
  PrivilegedCompactionInput,
  PrivilegedCompactionResult,
} from '../../../../sdk/src/services/memory-v2/types'
import {
  detectContradictions,
  extractStableChunkIds,
  resolveSupersessionHead,
  type ContradictionCandidate,
} from '../../../../common/src/util/contradiction-detector'
import type { ConceptCorpusEntry, ConceptExpansion } from './concept-index'
import {
  MemoryPlaybookSchema,
  PlaybookCountersSchema,
  computeTriggerSignature,
  type MemoryPlaybook,
  type PlaybookEnforcement,
  type PlaybookGateOutcome,
  type PlaybookScope,
  type PlaybookStatus,
  type PlaybookTrigger,
} from '../../../../common/src/types/memory-playbook'
import type {
  PlaybookStoreContract,
  PlaybookUpsertInput,
} from '../../../../common/src/types/contracts/playbook-store'

export type RuntimeNeutralMemoryRepositoryV2 = MemoryRepositoryV2
export type RuntimeNeutralMemoryEventV2 = MemoryEventEnvelope

/**
 * Store file schema version (PRAGMA user_version). Bumped 2 -> 3 by the P7
 * mixed-version repair: a build whose own SCHEMA_VERSION is lower than the
 * store's fails closed at open (its preflight/migrate reject version > their
 * SCHEMA_VERSION), so a pre-P7 build sharing this store can never open it —
 * closing the window where its GC selection (unaware of claim.reinforced)
 * could archive a reinforced observation and where its projection rebuild
 * could leave claim_dedup stale.
 *
 * Bumped 3 -> 4 by the context-archive persistence tables (the cross-session
 * recall_context source): the additive DDL is idempotent, so a v3 store
 * upgrades in place, while the existing version > SCHEMA_VERSION guard makes
 * an OLDER binary fail closed on a v4 store — a pre-archive build sharing
 * this file can never open it, so it cannot compact or rebuild a store whose
 * context_archive_* side tables it does not maintain.
 *
 * Version 5 adds current knowledge and shared archive bodies. Version 6
 * gives each checked archive manifest an immutable identity; timestamp
 * collisions no longer overwrite actions or ordered message memberships.
 */
const SCHEMA_VERSION = 6
const DEFAULT_DATABASE_PATH = join('.openbuff', 'memory', 'memory-v2.sqlite')
const DEFAULT_BUSY_TIMEOUT_MS = 2_500
const MAX_BUSY_TIMEOUT_MS = 10_000
const PAGE_SIZE = 250
const MAX_REPLAY_EVENTS = 10_000
const GC_SELECT_LIMIT = 10_000
const COMPACTION_APPLY_MAX = 100
/** Context-archive TTL: recall only surfaces recent pre-compaction context. */
const CONTEXT_ARCHIVE_TTL_MS = 30 * 24 * 3600 * 1000
/** Max snapshots the TTL prune removes per persist flush (bounded work). */
const CONTEXT_ARCHIVE_PRUNE_CAP = 500
/** Default/capped snapshot count for loadContextArchiveSnapshots. */
const CONTEXT_ARCHIVE_LOAD_LIMIT_DEFAULT = 24
const CONTEXT_ARCHIVE_LOAD_LIMIT_MAX = 1000
/** Default/capped match count and internal scan cap for searchContextArchive. */
const CONTEXT_ARCHIVE_SEARCH_LIMIT_DEFAULT = 6
const CONTEXT_ARCHIVE_SEARCH_LIMIT_MAX = 64
const CONTEXT_ARCHIVE_SEARCH_SCAN_CAP = 500
/** Snippet shape: up to 120 chars of lead-in, 600 chars total. */
const CONTEXT_ARCHIVE_SNIPPET_CONTEXT = 120
const CONTEXT_ARCHIVE_SNIPPET_CHARS = 600
/** Metadata key tracking the claim_dedup cold-start backfill cursor. */
const CLAIM_DEDUP_BACKFILL_KEY = 'claim_dedup_backfill'
/** Event types the shared P6 compaction-eligibility selection consumes. */
const GC_RELEVANT_EVENT_TYPES: readonly string[] = [
  'observation.recorded',
  'claim.forgotten',
  'claim.superseded',
  'claim.corrected',
  'claim.consolidated',
  'claim.pinned',
  'claim.reinforced',
  'evidence.attached',
  'evidence.verified',
  'evidence.invalidated',
  'evidence.rebound',
  'observation.reused',
]
/** Multi-referencing events that never belong to a single observation group. */
const GC_SHARED_EVENT_TYPES: readonly string[] = [
  'claim.forgotten',
  'claim.consolidated',
  'claim.corrected',
  'observation.reused',
]
const DIGEST_PATTERN = /^[a-z0-9][a-z0-9+.-]{0,31}:[A-Fa-f0-9]{16,256}$/
const NO_DELETE_TRIGGER_SQL = `CREATE TRIGGER memory_events_no_delete BEFORE DELETE ON memory_events BEGIN SELECT RAISE(ABORT, 'canonical memory events are append only'); END;`
const CANONICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'task.created',
  'task.transitioned',
  'session.started',
  'session.ended',
  'artifact.classified',
  'observation.recorded',
  'observation.reused',
  'claim.consolidated',
  'claim.corrected',
  'claim.superseded',
  'claim.forgotten',
  'claim.pinned',
  'claim.reinforced',
  'claim.archived',
  'evidence.attached',
  'evidence.verified',
  'evidence.invalidated',
  'evidence.rebound',
  'migration.v1.reserved',
  'migration.v1.imported',
  'coverage.recorded',
  'query.started',
  'query.completed',
  'query.failed',
  'projection.rebuild.requested',
  'projection.rebuild.completed',
  'projection.rebuild.failed',
])

export type MemoryV2FailureKind =
  | 'busy'
  | 'closed'
  | 'conflict'
  | 'corrupt'
  | 'incompatible'
  | 'invalid'
  | 'io'
  | 'unsupported-open'

export interface MemoryV2Failure {
  kind: MemoryV2FailureKind
  message: string
  retryable: boolean
}

export type MemoryV2Result<T> =
  | ({ status: 'ok' } & T)
  | { status: 'error'; error: MemoryV2Failure }

/**
 * The honest posture of a bun:sqlite store open. bun:sqlite accepts only a
 * path string, and SQLite opens the main database plus its -wal/-shm sidecars
 * by derived pathname inside its own VFS. The pathname hardening in this
 * module is therefore best-effort defense-in-depth: it cannot prove that the
 * files SQLite opened are the files that were validated beforehand.
 */
export type SQLiteOpenPosture = 'pathname-best-effort-unverified-open'

/** The single posture every bun:sqlite open has; see SQLiteOpenPosture. */
export const SQLITE_OPEN_POSTURE: SQLiteOpenPosture =
  'pathname-best-effort-unverified-open'

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
  /** Honest posture of the underlying open; never a proven-safe claim. */
  openPosture?: SQLiteOpenPosture
  failure?: MemoryV2Failure
}

export interface BunSQLiteMemoryRepositoryOptions {
  repositoryRoot?: string
  databasePath?: string
  busyTimeoutMs?: number
  /**
   * Strict opt-in gate. When true, open() refuses every bun:sqlite store
   * because this driver offers no descriptor-relative or no-follow/beneath
   * open (see SQLITE_OPEN_POSTURE): it returns a typed, non-retryable
   * 'unsupported-open' failure and performs no SQLite or filesystem mutation.
   * Defaults to false, which keeps the store usable with the pathname
   * hardening below as best-effort defense-in-depth.
   */
  requireSecureOpen?: boolean
  /**
   * Advisory semantic recall expansion. The expander receives the retrieval
   * request plus a bounded corpus of active observations and may return extra
   * observation ids appended AFTER the lexical ranking as a concept-advisory
   * tail. The expander must degrade internally (never throw); when absent,
   * recall expansion is off and results are purely lexical.
   */
  recallExpander?: (params: {
    request: MemoryRetrievalRequest
    corpus: ConceptCorpusEntry[]
  }) => Promise<ConceptExpansion | null>
}

export type BunSQLiteMemoryRepositoryOpenResult =
  | {
      status: 'ok'
      repository: BunSQLiteMemoryRepository
      openPosture: SQLiteOpenPosture
    }
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
  explicitId:
    | keyof Pick<PreparedEvent, 'taskId' | 'sessionId' | 'artifactId'>
    | null
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

interface UsageRow {
  observation_id: string
  used_count: number
  ignored_count: number
  staled_count: number
  last_mechanism: string | null
  last_turn_id: string | null
  last_sequence: number
}

interface ClaimDedupRow {
  claim_id: string
  observation_id: string
}

interface ObservationStatusRow {
  entity_id: string
  task_id: string | null
  state_json: string
  claim_state_json?: string | null
}

interface PlaybookRow {
  playbook_id: string
  workspace_id: string
  task_id: string | null
  title: string
  instruction: string
  trigger_json: string
  scope_json: string
  status: string
  enforcement: string
  counters_json: string
  provenance_json: string
  trigger_signature: string
  expires_at: number | null
  created_at: number
  updated_at: number
}

interface ContextArchiveMessageRow {
  snapshot_id?: string
  run_id: string
  archived_at: number
  tool_call_id: string | null
  tool_name: string | null
  step: number | null
  body: string
}

/**
 * memory_claims has no dedicated status column: retraction state lives in the
 * projection state JSON's `lifecycle` field. upsertClaim writes
 * 'forgotten'/'superseded'/'corrected' on the claim.forgotten/superseded/
 * corrected folds, markProjectionLifecycle writes 'superseded' on
 * consolidation sources, and claim.archived folds write 'archived'. Rows whose
 * lifecycle is one of these retraction markers map to 'retracted'; a readable
 * state with a recognized non-retraction lifecycle ('canonical',
 * consolidation-head 'consolidated', 'pinned') maps to 'active'. A row whose
 * state_json is unreadable, is not an object, or lacks a recognizable
 * lifecycle maps to 'unknown' — the fail-closed branch: supersession-safety
 * callers accept only 'active' targets, so a corrupted projection row can
 * never be superseded. Observation ids absent from memory_claims are omitted
 * entirely so unknown targets cannot be superseded either.
 */
const RETRACTED_CLAIM_LIFECYCLES: ReadonlySet<string> = new Set([
  'forgotten',
  'superseded',
  'corrected',
  'archived',
])

const PROJECTIONS: Record<string, ProjectionDefinition> = {
  task: { table: 'memory_tasks', payloadId: 'taskId', explicitId: 'taskId' },
  session: {
    table: 'memory_sessions',
    payloadId: 'sessionId',
    explicitId: 'sessionId',
  },
  artifact: {
    table: 'memory_artifacts',
    payloadId: 'artifactId',
    explicitId: 'artifactId',
  },
  claim: { table: 'memory_claims', payloadId: 'claimId', explicitId: null },
  evidence: {
    table: 'memory_evidence',
    payloadId: 'evidenceId',
    explicitId: null,
  },
  discovery: {
    table: 'memory_discoveries',
    payloadId: 'discoveryId',
    explicitId: null,
  },
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

export class BunSQLiteMemoryRepository
  implements MemoryRepositoryV2, PlaybookStoreContract
{
  readonly databasePath: string
  private closed = false
  private integrityCheck: Promise<boolean> | undefined
  private knowledgeRepair: Promise<void> | undefined
  private archiveMigration: Promise<number> | undefined

  private constructor(
    private readonly database: Database,
    databasePath: string,
    private readonly recallExpander?: BunSQLiteMemoryRepositoryOptions['recallExpander'],
  ) {
    this.databasePath = databasePath
  }

  private async checkIntegrity(): Promise<boolean> {
    if (this.databasePath === ':memory:') {
      return (
        readPragmaString(
          this.database,
          'PRAGMA quick_check(1)',
          'quick_check',
        ) === 'ok'
      )
    }
    // Both health APIs can be called together. Share their in-flight scan;
    // never scan a large database on the terminal's event loop.
    const pending = (this.integrityCheck ??= checkSQLiteIntegrity(
      this.databasePath,
    ))
    try {
      return await pending
    } finally {
      if (this.integrityCheck === pending) this.integrityCheck = undefined
    }
  }

  static async open(
    options: BunSQLiteMemoryRepositoryOptions = {},
  ): Promise<BunSQLiteMemoryRepositoryOpenResult> {
    let database: Database | undefined

    try {
      // Strict mode refuses every bun:sqlite open before any filesystem or
      // SQLite mutation: no descriptor-relative/no-follow open exists for
      // this driver, so the requested guarantee cannot be met.
      if (options.requireSecureOpen === true) {
        throw new MemoryV2StorageError(insecureOpenUnavailableFailure())
      }
      const preparedPath = prepareDatabasePath(options)
      const timeout = boundedBusyTimeout(options.busyTimeoutMs)
      await preflightExistingDatabase(preparedPath)
      // The integrity scan yields to a worker. Recheck the admitted file
      // identity before any writable open after that asynchronous boundary.
      if (preparedPath.existingIdentity) verifyOpenedDatabasePath(preparedPath)
      database = new Database(preparedPath.databasePath, {
        create: true,
        strict: true,
      })
      verifyOpenedDatabasePath(preparedPath)
      database.exec(`PRAGMA busy_timeout = ${timeout}`)
      database.exec('PRAGMA foreign_keys = ON')
      migrate(database)
      secureDatabaseFiles(preparedPath)
      database.exec('PRAGMA synchronous = NORMAL')
      const journalMode = readPragmaString(
        database,
        'PRAGMA journal_mode = WAL',
        'journal_mode',
      )
      secureDatabaseFiles(preparedPath)
      recordRuntimeCapabilities(database, journalMode)
      secureDatabaseFiles(preparedPath)

      return {
        status: 'ok',
        repository: new BunSQLiteMemoryRepository(
          database,
          preparedPath.databasePath,
          options.recallExpander,
        ),
        openPosture: SQLITE_OPEN_POSTURE,
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
    try {
      await this.ensureKnowledgeProjection()
    } catch (error) {
      return { status: 'error', error: classifyStorageError(error) }
    }
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
    if (!parsed.success)
      return rejectedOutcome('The memory append request is invalid.')
    if (
      parsed.data.events.some(
        (event) => event.projectId !== parsed.data.projectId,
      )
    ) {
      return rejectedOutcome(
        'Every event must belong to the requested project.',
      )
    }

    try {
      await this.ensureKnowledgeProjection()
    } catch (error) {
      return appendFailureOutcome(classifyStorageError(error))
    }

    const result = this.appendKernel(parsed.data.events, {
      projectId: parsed.data.projectId,
      expectedTail:
        parsed.data.expectedTail ??
        (parsed.data.expectedLastEventId === undefined
          ? undefined
          : { kind: 'event', eventId: parsed.data.expectedLastEventId }),
    })
    if (result.status === 'error') return appendFailureOutcome(result.error)
    if (
      !result.lastEventId ||
      result.events.length !== parsed.data.events.length
    ) {
      return failedOutcome(
        'internal',
        'The memory store did not return the appended events.',
        false,
      )
    }
    const lastEventId = MemoryEventIdSchema.safeParse(result.lastEventId)
    if (!lastEventId.success) {
      return failedOutcome(
        'internal',
        'The memory store returned an invalid last event ID.',
        false,
      )
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
    inputs: readonly (
      | MemoryV2EventInput
      | MemoryEventDraft
      | MemoryEventEnvelope
    )[],
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
      if (
        eventIds.has(event.eventId) ||
        idempotencyKeys.has(event.idempotencyKey)
      ) {
        return {
          status: 'error',
          error: {
            kind: 'invalid',
            message:
              'An append request cannot contain duplicate event IDs or idempotency keys.',
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
          error: invalidEventFailure(
            new Error(
              'Events that claim schemaVersion 2 must include a valid projectId.',
            ),
          ),
        }
      }
      if (
        canonicalProjectId !== null &&
        canonicalProjectId !== parsedProjectId.data
      ) {
        return {
          status: 'error',
          error: invalidEventFailure(
            new Error(
              'Every canonical event in a batch must belong to the same project.',
            ),
          ),
        }
      }
      canonicalProjectId = parsedProjectId.data
    }

    try {
      const append = this.database.transaction((prepared: PreparedEvent[]) => {
        const boundProjectId = this.readBoundProjectId()
        if (
          boundProjectId !== null &&
          !ProjectIdSchema.safeParse(boundProjectId).success
        ) {
          throw invalidProjectStoreError()
        }
        const existingCanonicalProjects = this.database
          .query(
            `SELECT DISTINCT json_extract(metadata_json, '$.projectId') AS project_id,
                           json_type(metadata_json, '$.projectId') AS project_type
             FROM memory_events
            WHERE json_extract(metadata_json, '$.schemaVersion') = 2
            LIMIT 2`,
          )
          .all() as Array<{ project_id: unknown; project_type: string | null }>
        let existingCanonicalProjectId: string | null = null
        for (const row of existingCanonicalProjects) {
          const parsedProjectId =
            row.project_type === 'text'
              ? ProjectIdSchema.safeParse(row.project_id)
              : null
          if (!parsedProjectId?.success) throw invalidProjectStoreError()
          if (
            existingCanonicalProjectId !== null &&
            existingCanonicalProjectId !== parsedProjectId.data
          ) {
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
        if (
          projectId !== null &&
          prepared.some((event) => eventProjectId(event) !== projectId)
        ) {
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
          } else if (
            existing.length !== 1 ||
            !isIdempotentMatch(existing[0], event)
          ) {
            throw new MemoryV2StorageError({
              kind: 'invalid',
              message:
                'The event ID or idempotency key conflicts with an existing event.',
              retryable: false,
            })
          } else {
            results.push({
              eventId: existing[0].event_id,
              sequence: existing[0].sequence,
              duplicate: true,
            })
          }
        }

        const currentLastEventId = guard
          ? this.readLastEventIdForProject(guard.projectId)
          : this.readLastEventId()
        const staleTail =
          guard?.expectedTail?.kind === 'empty'
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
              results.push({
                eventId: existing.event_id,
                sequence: existing.sequence,
                duplicate: true,
              })
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
                event.eventId,
                event.idempotencyKey,
                event.eventType,
                event.occurredAt,
                event.payloadJson,
                event.metadataJson,
                event.taskId,
                event.sessionId,
                event.artifactId,
              )
            const sequence = Number(inserted.lastInsertRowid)
            applyProjection(this.database, event, sequence)
            setProjectionCursor(this.database, sequence)
            setClaimDedupBackfillCursor(this.database, sequence)
            results.push({ eventId: event.eventId, sequence, duplicate: false })
          }
        }

        const appendedCount = results.filter(
          ({ duplicate }) => !duplicate,
        ).length
        const last = guard
          ? (this.database
              .query(
                `SELECT sequence, event_id FROM memory_events
                  WHERE json_extract(metadata_json, '$.projectId') = ?1
                  ORDER BY sequence DESC LIMIT 1`,
              )
              .get(guard.projectId) as {
              sequence: number
              event_id: string
            } | null)
          : (this.database
              .query(
                'SELECT sequence, event_id FROM memory_events ORDER BY sequence DESC LIMIT 1',
              )
              .get() as { sequence: number; event_id: string } | null)
        return {
          events: results,
          appendedCount,
          duplicateCount: results.length - appendedCount,
          lastSequence:
            results.length > 0
              ? Math.max(...results.map(({ sequence }) => sequence))
              : (last?.sequence ?? 0),
          lastEventId: last?.event_id ?? null,
        }
      })
      return { status: 'ok', ...append.immediate(events) }
    } catch (error) {
      return { status: 'error', error: classifyStorageError(error) }
    }
  }

  async listEvents(
    options: {
      afterSequence?: number
      limit?: number
    } = {},
  ): Promise<MemoryV2Result<{ events: MemoryV2StoredEvent[] }>> {
    const unavailable = this.requireOpen()
    if (unavailable) return unavailable

    const afterSequence = validNonNegativeInteger(options.afterSequence ?? 0)
    const limit = Math.min(
      validPositiveInteger(options.limit ?? PAGE_SIZE),
      1_000,
    )
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

  async *iterateEvents(
    options: {
      afterSequence?: number
      limit?: number
    } = {},
  ): AsyncGenerator<MemoryV2StoredEvent, void> {
    let cursor = validNonNegativeInteger(options.afterSequence ?? 0)
    let remaining = Math.min(
      validPositiveInteger(options.limit ?? 1_000),
      10_000,
    )

    while (remaining > 0) {
      const result = await this.listEvents({
        afterSequence: cursor,
        limit: Math.min(PAGE_SIZE, remaining),
      })
      if (result.status === 'error')
        throw new MemoryV2StorageError(result.error)
      if (result.events.length === 0) return
      for (const event of result.events) {
        yield event
        cursor = event.sequence
        remaining -= 1
      }
    }
  }

  async rebuildProjections(): Promise<
    MemoryV2Result<{
      cursor: number
      projectedEvents: number
      truncated: boolean
    }>
  > {
    const unavailable = this.requireOpen()
    if (unavailable) return unavailable

    try {
      const rebuild = this.database.transaction(() => {
        for (const table of PROJECTION_TABLES)
          this.database.exec(`DELETE FROM ${table}`)
        this.database.exec('DELETE FROM memory_usage')
        // claim_dedup is rebuilt from the surviving log during the replay.
        this.database.exec('DELETE FROM claim_dedup')
        clearKnowledgeProjection(this.database)
        setProjectionCursor(this.database, 0)
        return replayProjections(this.database)
      })
      return { status: 'ok', ...rebuild.immediate() }
    } catch (error) {
      return { status: 'error', error: classifyStorageError(error) }
    }
  }

  async getProjectionSnapshot(): Promise<
    MemoryV2Result<MemoryV2ProjectionSnapshot>
  > {
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

  /**
   * Bounded read of the P4 usage projection. Filters by the bound project
   * (single-project stores) and either the given observation ids (max 64) or
   * up to 256 rows in code-point order of observation_id.
   */
  async getUsage(params: {
    projectId: string
    observationIds?: string[]
  }): Promise<
    MemoryV2Result<{
      usage: Array<{
        observationId: string
        usedCount: number
        ignoredCount: number
        staledCount: number
        lastMechanism: string | null
        lastTurnId: string | null
        lastSequence: number
      }>
    }>
  > {
    const unavailable = this.requireOpen()
    if (unavailable) return unavailable

    try {
      this.requireBoundProject(params.projectId)
      const filtered = Array.isArray(params.observationIds)
        ? params.observationIds
            .filter(
              (id): id is string =>
                typeof id === 'string' && id.length > 0 && id.length <= 512,
            )
            .slice(0, 64)
        : undefined
      if (filtered !== undefined && filtered.length === 0) {
        return { status: 'ok', usage: [] }
      }
      await this.ensureKnowledgeProjection()
      const rows = this.database
        .query(
          `WITH ids AS (
        SELECT observation_id FROM memory_usage
        UNION SELECT observation_id FROM memory_knowledge WHERE project_id=? AND (json_extract(state_json,'$.used')>0 OR json_extract(state_json,'$.ignored')>0)
      )
      SELECT ids.observation_id,
        COALESCE(json_extract(k.state_json,'$.used'),u.used_count,0) AS used_count,
        COALESCE(json_extract(k.state_json,'$.ignored'),u.ignored_count,0) AS ignored_count,
        COALESCE(u.staled_count,0) AS staled_count,
        COALESCE(json_extract(k.state_json,'$.lastUsage.mechanism'),u.last_mechanism) AS last_mechanism,
        COALESCE(json_extract(k.state_json,'$.lastUsage.turnId'),u.last_turn_id) AS last_turn_id,
        COALESCE(json_extract(k.state_json,'$.lastUsage.sequence'),u.last_sequence,0) AS last_sequence
      FROM ids LEFT JOIN memory_usage u ON u.observation_id=ids.observation_id
      LEFT JOIN memory_knowledge k ON k.observation_id=ids.observation_id
      ${filtered ? `WHERE ids.observation_id IN (${filtered.map(() => '?').join(',')})` : ''}
      ORDER BY ids.observation_id LIMIT 256`,
        )
        .all(params.projectId, ...(filtered ?? [])) as UsageRow[]
      return {
        status: 'ok',
        usage: rows.map((row) => ({
          observationId: row.observation_id,
          usedCount: row.used_count,
          ignoredCount: row.ignored_count,
          staledCount: row.staled_count,
          lastMechanism: row.last_mechanism ?? null,
          lastTurnId: row.last_turn_id ?? null,
          lastSequence: row.last_sequence,
        })),
      }
    } catch (error) {
      return { status: 'error', error: classifyStorageError(error) }
    }
  }

  /**
   * Bounded read of the P7 claim-dedup projection. Filters by the bound
   * project (single-project stores) and either the given claim ids (max 64)
   * or up to 256 rows in code-point order of claim_id.
   */
  async getClaimDedup(params: {
    projectId: string
    claimIds?: string[]
  }): Promise<
    MemoryV2Result<{
      entries: Array<{
        claimId: string
        observationId: string
      }>
    }>
  > {
    const unavailable = this.requireOpen()
    if (unavailable) return unavailable

    try {
      this.requireBoundProject(params.projectId)
      const filtered = Array.isArray(params.claimIds)
        ? params.claimIds
            .filter(
              (id): id is string =>
                typeof id === 'string' && id.length >= 1 && id.length <= 64,
            )
            .slice(0, 64)
        : undefined
      if (filtered !== undefined && filtered.length === 0) {
        return { status: 'ok', entries: [] }
      }
      const rows =
        filtered !== undefined
          ? (this.database
              .query(
                `SELECT claim_id, observation_id
                   FROM claim_dedup
                  WHERE claim_id IN (${filtered
                    .map((_, index) => `?${index + 1}`)
                    .join(', ')})
                  ORDER BY claim_id
                  LIMIT 256`,
              )
              .all(...filtered) as ClaimDedupRow[])
          : (this.database
              .query(
                `SELECT claim_id, observation_id
                   FROM claim_dedup
                  ORDER BY claim_id
                  LIMIT 256`,
              )
              .all() as ClaimDedupRow[])
      return {
        status: 'ok',
        entries: rows.map((row) => ({
          claimId: row.claim_id,
          observationId: row.observation_id,
        })),
      }
    } catch (error) {
      return { status: 'error', error: classifyStorageError(error) }
    }
  }

  /**
   * Bounded read of the P7 observation lifecycle status projection. Filters
   * by the bound project (single-project stores) and the given observation
   * ids (max 64), returning up to 256 rows in code-point order of
   * observation_id. Targets absent from memory_claims are omitted from the
   * result so callers fail closed on unknown ids.
   */
  async getObservationStatus(
    params: MemoryObservationStatusReadRequest,
  ): Promise<MemoryV2Result<{ entries: MemoryObservationStatusEntry[] }>> {
    const unavailable = this.requireOpen()
    if (unavailable) return unavailable

    try {
      this.requireBoundProject(params.projectId)
      const filtered = Array.isArray(params.observationIds)
        ? [...new Set(params.observationIds)]
            .filter(
              (id): id is string =>
                typeof id === 'string' && id.length >= 1 && id.length <= 128,
            )
            .slice(0, 64)
        : []
      if (filtered.length === 0) {
        return { status: 'ok', entries: [] }
      }
      await this.ensureKnowledgeProjection()
      const rows = this.database
        .query(
          `SELECT k.observation_id AS entity_id,k.task_id,k.state_json,c.state_json AS claim_state_json
             FROM memory_knowledge k LEFT JOIN memory_claims c ON c.entity_id=k.observation_id
            WHERE k.project_id=? AND k.observation_id IN (${filtered.map(() => '?').join(', ')})
            ORDER BY k.observation_id
            LIMIT 256`,
        )
        .all(params.projectId, ...filtered) as ObservationStatusRow[]
      return {
        status: 'ok',
        entries: rows
          .map((row) => {
            let state: unknown
            let readable = true
            try {
              state = JSON.parse(row.state_json) as unknown
            } catch {
              // Unreadable or malformed projection state fails closed: the
              // row maps to 'unknown', which supersession-safety callers
              // (accepting only 'active' targets) treat as ineligible.
              readable = false
              state = undefined
            }
            let legacyLifecycle: unknown
            try {
              if (row.claim_state_json)
                legacyLifecycle = nestedValue(
                  JSON.parse(row.claim_state_json),
                  'lifecycle',
                )
            } catch {
              readable = false
            }
            const knowledge = objectValue(state)
            const validFlags = ['forgotten', 'superseded', 'corrected'].every(
              (key) => typeof knowledge[key] === 'boolean',
            )
            if (
              !validFlags ||
              (row.claim_state_json && typeof legacyLifecycle !== 'string')
            )
              readable = false
            return {
              observationId: row.entity_id,
              taskId: row.task_id ?? '',
              status: !readable
                ? ('unknown' as const)
                : knowledge.forgotten ||
                    knowledge.superseded ||
                    knowledge.corrected
                  ? ('retracted' as const)
                  : ('active' as const),
            }
          })
          .sort((left, right) =>
            compareUnicodeCodePoints(left.observationId, right.observationId),
          ),
      }
    } catch (error) {
      return { status: 'error', error: classifyStorageError(error) }
    }
  }

  /** Incremental immutable bodies/messages with ordered snapshot memberships. */
  async persistContextArchiveSnapshots(request: {
    runId: string
    snapshots: ContextArchiveSnapshot[]
  }): Promise<{
    persisted: number
    skipped: number
    status?: 'ok' | 'degraded' | 'unavailable'
    reasons?: string[]
  }> {
    const snapshots = Array.isArray(request?.snapshots) ? request.snapshots : []
    const unavailable = (reason: string) => ({
      persisted: 0,
      skipped: snapshots.length,
      status: 'unavailable' as const,
      reasons: [reason],
    })
    if (this.requireOpen()) return unavailable('store-closed')
    const runId = typeof request?.runId === 'string' ? request.runId : ''
    if (!runId || runId.length > 2048)
      return {
        persisted: 0,
        skipped: snapshots.length,
        status: 'degraded',
        reasons: ['invalid-run-id'],
      }
    if (!snapshots.length) return { persisted: 0, skipped: 0, status: 'ok' }
    try {
      const invalidLegacy = await this.ensureArchiveMigration()
      const prepared = snapshots.map(prepareArchiveSnapshot)
      const valid = prepared.filter(
        (snapshot): snapshot is NonNullable<typeof snapshot> =>
          snapshot !== null,
      )
      const now = new Date().toISOString()
      const flush = this.database.transaction(() => {
        if (!archiveFtsAvailable(this.database))
          disableArchiveFtsTriggers(this.database)
        // Retention removes references first; shared messages/bodies survive while referenced.
        const stale = this.database
          .query(
            'SELECT snapshot_id FROM context_archive_snapshots WHERE archived_at<?1 AND run_id!=?2 ORDER BY archived_at LIMIT ?3',
          )
          .all(
            Date.now() - CONTEXT_ARCHIVE_TTL_MS,
            runId,
            CONTEXT_ARCHIVE_PRUNE_CAP,
          ) as Array<{ snapshot_id: string }>
        for (const row of stale)
          this.database
            .query('DELETE FROM context_archive_snapshots WHERE snapshot_id=?1')
            .run(row.snapshot_id)
        for (const snapshot of valid)
          putArchiveSnapshot(
            this.database,
            snapshot.snapshot.runId ?? runId,
            snapshot,
            now,
          )
        // A partially invalid incoming set cannot erase a valid prior archive.
        if (valid.length === snapshots.length) {
          const identities = valid
            .filter((snapshot) => (snapshot.snapshot.runId ?? runId) === runId)
            .map((snapshot) => archiveSnapshotId(runId, snapshot))
          if (identities.length)
            this.database
              .query(
                `DELETE FROM context_archive_snapshots WHERE run_id=? AND snapshot_id NOT IN (${identities.map(() => '?').join(',')})`,
              )
              .run(runId, ...identities)
        }
        if (valid.length) {
          for (const owner of new Set(
            valid.map((snapshot) => snapshot.snapshot.runId ?? runId),
          )) {
            const row = this.database
              .query(
                'SELECT max(archived_at) AS max FROM context_archive_snapshots WHERE run_id=?1',
              )
              .get(owner) as { max: number }
            this.database
              .query(
                'INSERT INTO context_archive_watermarks(run_id,max_archived_at,updated_at) VALUES (?1,?2,?3) ON CONFLICT(run_id) DO UPDATE SET max_archived_at=excluded.max_archived_at,updated_at=excluded.updated_at WHERE max_archived_at!=excluded.max_archived_at',
              )
              .run(owner, row.max, now)
          }
        }
        this.database.exec(
          'DELETE FROM context_archive_watermarks WHERE NOT EXISTS(SELECT 1 FROM context_archive_snapshots s WHERE s.run_id=context_archive_watermarks.run_id)',
        )
        collectArchiveOrphans(this.database)
        return {
          persisted: valid.length,
          skipped: snapshots.length - valid.length,
        }
      })
      const counts = flush.immediate()
      const reasons = [
        ...(counts.skipped ? ['invalid-snapshot'] : []),
        ...(invalidLegacy ? ['legacy-migration-incomplete'] : []),
        ...(!archiveFtsAvailable(this.database) ? ['fts-unavailable'] : []),
      ]
      return {
        ...counts,
        status: reasons.length ? 'degraded' : 'ok',
        ...(reasons.length ? { reasons } : {}),
      }
    } catch {
      return unavailable('storage-failed')
    }
  }

  async loadContextArchiveSnapshots(
    request: { runId?: string; limit?: number } = {},
  ): Promise<{
    snapshots: ContextArchiveSnapshot[]
    status?: 'ok' | 'degraded' | 'unavailable'
    reasons?: string[]
  }> {
    if (this.requireOpen())
      return { snapshots: [], status: 'unavailable', reasons: ['store-closed'] }
    const runId =
      typeof request.runId === 'string' && request.runId ? request.runId : null
    const limit =
      typeof request.limit === 'number' &&
      Number.isFinite(request.limit) &&
      request.limit >= 0
        ? Math.min(Math.floor(request.limit), CONTEXT_ARCHIVE_LOAD_LIMIT_MAX)
        : CONTEXT_ARCHIVE_LOAD_LIMIT_DEFAULT
    try {
      const invalidLegacy = await this.ensureArchiveMigration()
      const rows = this.database
        .query(
          `SELECT * FROM context_archive_snapshots${runId ? ' WHERE run_id=?' : ''} ORDER BY archived_at DESC,run_id,snapshot_id LIMIT ?`,
        )
        .all(...(runId ? [runId] : []), limit) as ArchiveManifestRow[]
      const snapshots: ContextArchiveSnapshot[] = []
      for (const row of rows) {
        const snapshot = readArchiveSnapshot(this.database, row)
        if (snapshot) snapshots.push(snapshot)
        await yieldToEventLoop()
      }
      const reasons = [
        ...(snapshots.length < rows.length ? ['invalid-manifest'] : []),
        ...(invalidLegacy ? ['legacy-migration-incomplete'] : []),
      ]
      return {
        snapshots,
        status: reasons.length ? 'degraded' : 'ok',
        ...(reasons.length ? { reasons } : {}),
      }
    } catch {
      return {
        snapshots: [],
        status: 'unavailable',
        reasons: ['storage-failed'],
      }
    }
  }

  async searchContextArchive(request: {
    query: string
    limit?: number
  }): Promise<ContextArchiveSearchOutcome> {
    const empty: ContextArchiveSearchOutcome = {
      matches: [],
      snapshotsSearched: 0,
      status: 'ok',
    }
    if (this.requireOpen())
      return { ...empty, status: 'unavailable', reasons: ['store-closed'] }
    const query = typeof request?.query === 'string' ? request.query : ''
    const terms = sanitizeFtsQuery(query)
    if (!terms) return empty
    const limit =
      typeof request.limit === 'number' &&
      Number.isFinite(request.limit) &&
      request.limit > 0
        ? Math.min(Math.floor(request.limit), CONTEXT_ARCHIVE_SEARCH_LIMIT_MAX)
        : CONTEXT_ARCHIVE_SEARCH_LIMIT_DEFAULT
    try {
      const invalidLegacy = await this.ensureArchiveMigration()
      const reasons = invalidLegacy ? ['legacy-migration-incomplete'] : []
      const from = `FROM context_archive_bodies b JOIN context_archive_messages m ON m.content_digest=b.content_digest JOIN context_archive_memberships r ON r.message_id=m.message_id JOIN context_archive_snapshots s ON s.snapshot_id=r.snapshot_id`
      const select =
        'SELECT s.snapshot_id,s.run_id,s.archived_at,m.tool_name,m.tool_call_id,r.step,b.body'
      if (archiveFtsAvailable(this.database)) {
        try {
          const rows = this.database
            .query(
              `${select} ${from} JOIN context_archive_fts ON context_archive_fts.rowid=b.rowid WHERE context_archive_fts MATCH ?1 AND m.tool_name IS NOT NULL ORDER BY rank,s.archived_at DESC,r.msg_index DESC LIMIT ?2`,
            )
            .all(
              terms.join(' '),
              CONTEXT_ARCHIVE_SEARCH_SCAN_CAP,
            ) as ContextArchiveMessageRow[]
          const literalTerms = terms.map((term) =>
            term.slice(1, -1).replaceAll('""', '"'),
          )
          return {
            matches: buildArchiveSearchMatches(rows, literalTerms, limit),
            snapshotsSearched: countDistinctArchiveSnapshots(rows),
            status: reasons.length ? 'degraded' : 'ok',
            ...(reasons.length ? { reasons } : {}),
          }
        } catch {
          reasons.push('fts-failed')
        }
      } else reasons.push('fts-unavailable')
      const loweredTerms = terms.map((term) =>
        term.slice(1, -1).replaceAll('""', '"'),
      )
      const clauses = loweredTerms
        .map(() => "lower(b.body) LIKE ? ESCAPE '\\'")
        .join(' AND ')
      const rows = this.database
        .query(
          `${select} ${from} WHERE m.tool_name IS NOT NULL AND ${clauses} ORDER BY s.archived_at DESC,r.msg_index DESC LIMIT ?`,
        )
        .all(
          ...loweredTerms.map((term) => `%${escapeLikePattern(term)}%`),
          CONTEXT_ARCHIVE_SEARCH_SCAN_CAP,
        ) as ContextArchiveMessageRow[]
      return {
        matches: buildArchiveSearchMatches(rows, loweredTerms, limit),
        snapshotsSearched: countDistinctArchiveSnapshots(rows),
        status: 'degraded',
        reasons,
      }
    } catch {
      return { ...empty, status: 'unavailable', reasons: ['storage-failed'] }
    }
  }

  async repairContextArchive(): Promise<{
    status: 'ok' | 'degraded'
    reasons?: string[]
  }> {
    if (this.requireOpen())
      return { status: 'degraded', reasons: ['store-closed'] }
    try {
      this.database.exec('DELETE FROM context_archive_migration_errors')
      const invalid = await this.ensureArchiveMigration()
      this.database
        .transaction(() => repairArchiveFts(this.database))
        .immediate()
      return invalid
        ? { status: 'degraded', reasons: ['legacy-migration-incomplete'] }
        : { status: 'ok' }
    } catch {
      return { status: 'degraded', reasons: ['repair-failed'] }
    }
  }

  /** Bounded exact cross-task maintenance; it never creates a policy or a semantic fact. */
  async consolidateExact(request: {
    projectId: string
    maxGroups?: number
    now?: number
  }): Promise<{
    status: 'ok' | 'degraded'
    reinforced: number
    superseded: number
    reason?: string
  }> {
    const degraded = (reason: string) => ({
      status: 'degraded' as const,
      reinforced: 0,
      superseded: 0,
      reason,
    })
    if (this.requireOpen()) return degraded('store-closed')
    if (!ProjectIdSchema.safeParse(request.projectId).success)
      return degraded('invalid-project')
    try {
      this.requireBoundProject(request.projectId)
      await this.ensureKnowledgeProjection()
      const maxGroups =
        typeof request.maxGroups === 'number' &&
        Number.isFinite(request.maxGroups)
          ? Math.max(0, Math.min(16, Math.floor(request.maxGroups)))
          : 4
      const tail = this.readLastEventIdForProject(request.projectId)
      const groups = this.database
        .query(
          "SELECT exact_identity FROM memory_knowledge WHERE project_id=?1 AND lifecycle='active' GROUP BY exact_identity HAVING COUNT(*)>1 AND COUNT(DISTINCT task_id)>1 AND sum(pinned=0)>0 ORDER BY min(source_sequence),exact_identity LIMIT ?2",
        )
        .all(request.projectId, maxGroups) as Array<{ exact_identity: string }>
      const at =
        typeof request.now === 'number' && Number.isFinite(request.now)
          ? new Date(request.now).toISOString()
          : new Date().toISOString()
      const drafts: MemoryEventDraft[] = []
      for (const group of groups) {
        const rows = this.database
          .query(
            `WITH head AS MATERIALIZED (
              SELECT observation_id FROM memory_knowledge
              WHERE project_id=?1 AND exact_identity=?2 AND lifecycle='active'
              ORDER BY pinned DESC,source_sequence,observation_id LIMIT 1
            )
            SELECT state_json FROM memory_knowledge
            WHERE project_id=?1 AND exact_identity=?2 AND lifecycle='active'
              AND (pinned=0 OR observation_id=(SELECT observation_id FROM head))
            ORDER BY pinned DESC,source_sequence,observation_id LIMIT 16`,
          )
          .all(request.projectId, group.exact_identity) as Array<{
          state_json: string
        }>
        const states = rows.map(
          (row) => JSON.parse(row.state_json) as KnowledgeObservationState,
        )
        const head = states[0]
        if (!head) continue
        for (const source of states.slice(1)) {
          // Explicit duplicate pins remain independently inspectable and active.
          if (source.pinned) continue
          if (
            exactKnowledgeIdentity(source.observation) !==
            exactKnowledgeIdentity(head.observation)
          )
            continue
          const identity = createHash('sha256')
            .update(
              `${KNOWLEDGE_PRODUCER_VERSION}:${request.projectId}:${source.sourceEventId}:${head.sourceEventId}`,
            )
            .digest('hex')
          drafts.push(
            MemoryEventDraftSchema.parse({
              schemaVersion: 2,
              eventSchemaVersion: 1,
              eventType: 'claim.reinforced',
              eventId: `event:exact-reinforce:${identity}`,
              projectId: request.projectId,
              sessionId: 'session:exact-maintenance',
              occurredAt: at,
              payload: {
                payloadSchemaVersion: 1,
                observationId: head.observation.observationId,
                claimId: group.exact_identity,
                reason: `Exact cross-task corroboration from ${source.observation.observationId}`,
                reinforcedAt: at,
                reinforcedBy: 'current-knowledge-exact-maintenance',
              },
            }),
          )
          drafts.push(
            MemoryEventDraftSchema.parse({
              schemaVersion: 2,
              eventSchemaVersion: 1,
              eventType: 'claim.superseded',
              eventId: `event:exact-supersede:${identity}`,
              projectId: request.projectId,
              sessionId: 'session:exact-maintenance',
              occurredAt: at,
              payload: {
                payloadSchemaVersion: 1,
                observationId: source.observation.observationId,
                supersededByObservationId: head.observation.observationId,
                reason:
                  'Exact content and dependency duplicate; canonical source and corroboration remain auditable.',
              },
            }),
          )
        }
      }
      if (!drafts.length) return { status: 'ok', reinforced: 0, superseded: 0 }
      const appended = this.appendKernel(drafts, {
        projectId: request.projectId,
        expectedTail: tail
          ? { kind: 'event', eventId: MemoryEventIdSchema.parse(tail) }
          : { kind: 'empty' },
      })
      if (appended.status === 'error') return degraded(appended.error.kind)
      return {
        status: 'ok',
        reinforced: drafts.length / 2,
        superseded: drafts.length / 2,
      }
    } catch {
      return degraded('maintenance-failed')
    }
  }

  /**
   * Active, unexpired procedural playbooks for one workspace (the runtime
   * playbook gate's per-turn input). Every row is revalidated through
   * MemoryPlaybookSchema and its JSON columns, so a corrupt row throws
   * instead of coercing into a partially-populated rule.
   */
  async listPlaybooks(workspaceId: string): Promise<MemoryPlaybook[]> {
    const unavailable = this.requireOpen()
    if (unavailable) throw new MemoryV2StorageError(unavailable.error)
    try {
      const rows = this.database
        .query(
          `SELECT ${PLAYBOOK_SELECT_COLUMNS}
             FROM memory_playbooks
            WHERE workspace_id = ?1
              AND status IN ('active','verified')
              AND (expires_at IS NULL OR expires_at > ?2)
            ORDER BY created_at, playbook_id`,
        )
        .all(workspaceId, Date.now()) as PlaybookRow[]
      return rows.map((row) => playbookFromRow(row))
    } catch (error) {
      if (error instanceof MemoryV2StorageError) throw error
      throw new MemoryV2StorageError(classifyStorageError(error))
    }
  }

  /**
   * Every playbook row for one workspace regardless of status/expiry — the
   * Phase-4 lifecycle evaluator's input, where the gate-facing read above
   * filters retired and expired rows out. Same revalidation as listPlaybooks:
   * every row is rebuilt through MemoryPlaybookSchema, so a corrupt row
   * throws instead of coercing into a partially-populated rule.
   */
  async listAllPlaybooks(workspaceId: string): Promise<MemoryPlaybook[]> {
    const unavailable = this.requireOpen()
    if (unavailable) throw new MemoryV2StorageError(unavailable.error)
    try {
      const rows = this.database
        .query(
          `SELECT ${PLAYBOOK_SELECT_COLUMNS}
             FROM memory_playbooks
            WHERE workspace_id = ?1
            ORDER BY created_at, playbook_id`,
        )
        .all(workspaceId) as PlaybookRow[]
      return rows.map((row) => playbookFromRow(row))
    } catch (error) {
      if (error instanceof MemoryV2StorageError) throw error
      throw new MemoryV2StorageError(classifyStorageError(error))
    }
  }

  /**
   * Insert-or-update a playbook keyed by computeTriggerSignature(trigger,
   * scope): two playbooks with the same signature are the same rule, so an
   * existing row keeps its playbookId, createdAt and counters while its
   * instruction/enforcement/scope/provenance/expiry are refreshed. The
   * assembled record is validated with MemoryPlaybookSchema BEFORE the write,
   * so a non-evaluable or schema-invalid payload never reaches the store.
   */
  async upsertPlaybookByTriggerSignature(
    input: PlaybookUpsertInput,
  ): Promise<MemoryPlaybook> {
    const unavailable = this.requireOpen()
    if (unavailable) throw new MemoryV2StorageError(unavailable.error)
    try {
      const triggerSignature = computeTriggerSignature(
        input.trigger,
        input.scope,
      )
      const now = Date.now()
      const existing = this.readPlaybookRow(input.workspaceId, triggerSignature)
      const playbook = MemoryPlaybookSchema.parse({
        schemaVersion: 1,
        playbookId: existing?.playbook_id ?? randomUUID(),
        workspaceId: input.workspaceId,
        taskId: existing ? (existing.task_id ?? undefined) : input.taskId,
        title: input.title,
        instruction: input.instruction,
        trigger: input.trigger,
        scope: input.scope,
        status: input.status,
        enforcement: input.enforcement,
        counters: existing
          ? (JSON.parse(existing.counters_json) as unknown)
          : PlaybookCountersSchema.parse({}),
        provenance: input.provenance,
        triggerSignature,
        expiresAt: input.expiresAt,
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
      })
      if (existing) {
        this.database
          .query(
            `UPDATE memory_playbooks
                SET title = ?1,
                    instruction = ?2,
                    status = ?3,
                    enforcement = ?4,
                    trigger_json = ?5,
                    scope_json = ?6,
                    provenance_json = ?7,
                    expires_at = ?8,
                    updated_at = ?9
              WHERE playbook_id = ?10`,
          )
          .run(
            playbook.title,
            playbook.instruction,
            playbook.status,
            playbook.enforcement,
            JSON.stringify(playbook.trigger),
            JSON.stringify(playbook.scope),
            JSON.stringify(playbook.provenance),
            playbook.expiresAt ?? null,
            playbook.updatedAt,
            playbook.playbookId,
          )
      } else {
        this.database
          .query(
            `INSERT INTO memory_playbooks (
               playbook_id, workspace_id, task_id, title, instruction,
               trigger_json, scope_json, status, enforcement, counters_json,
               provenance_json, trigger_signature, expires_at, created_at,
               updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
          )
          .run(
            playbook.playbookId,
            playbook.workspaceId,
            playbook.taskId ?? null,
            playbook.title,
            playbook.instruction,
            JSON.stringify(playbook.trigger),
            JSON.stringify(playbook.scope),
            playbook.status,
            playbook.enforcement,
            JSON.stringify(playbook.counters),
            JSON.stringify(playbook.provenance),
            playbook.triggerSignature,
            playbook.expiresAt ?? null,
            playbook.createdAt,
            playbook.updatedAt,
          )
      }
      const stored = this.readPlaybookRow(input.workspaceId, triggerSignature)
      if (!stored) {
        throw new MemoryV2StorageError({
          kind: 'corrupt',
          message: 'The playbook could not be reloaded after the write.',
          retryable: false,
        })
      }
      return playbookFromRow(stored)
    } catch (error) {
      if (error instanceof MemoryV2StorageError) throw error
      throw new MemoryV2StorageError(classifyStorageError(error))
    }
  }

  /**
   * Fold one gate outcome into a playbook's counters: every outcome bumps
   * `fired` and lastFiredAt, the matching specific counter when one applies
   * ('warned' has none), and a false positive also stamps
   * lastFalsePositiveAt.
   */
  async recordPlaybookGateOutcome(
    playbookId: string,
    outcome: PlaybookGateOutcome,
  ): Promise<void> {
    const unavailable = this.requireOpen()
    if (unavailable) throw new MemoryV2StorageError(unavailable.error)
    try {
      const row = this.database
        .query(
          'SELECT counters_json FROM memory_playbooks WHERE playbook_id = ?1',
        )
        .get(playbookId) as { counters_json: string } | null
      if (!row) {
        throw new MemoryV2StorageError({
          kind: 'invalid',
          message: 'The playbook was not found.',
          retryable: false,
        })
      }
      const now = Date.now()
      const prior = PlaybookCountersSchema.parse(
        JSON.parse(row.counters_json) as unknown,
      )
      const counters = PlaybookCountersSchema.parse({
        ...prior,
        fired: prior.fired + 1,
        blocked: prior.blocked + (outcome === 'blocked' ? 1 : 0),
        bypassed: prior.bypassed + (outcome === 'bypassed' ? 1 : 0),
        compliedAfterBlock:
          prior.compliedAfterBlock + (outcome === 'compliedAfterBlock' ? 1 : 0),
        falsePositives:
          prior.falsePositives + (outcome === 'falsePositive' ? 1 : 0),
        lastFiredAt: now,
        ...(outcome === 'falsePositive' ? { lastFalsePositiveAt: now } : {}),
      })
      this.database
        .query(
          `UPDATE memory_playbooks
              SET counters_json = ?1, updated_at = ?2
            WHERE playbook_id = ?3`,
        )
        .run(JSON.stringify(counters), now, playbookId)
    } catch (error) {
      if (error instanceof MemoryV2StorageError) throw error
      throw new MemoryV2StorageError(classifyStorageError(error))
    }
  }

  /** Change a playbook's lifecycle status (e.g. retire a noisy rule). */
  async setPlaybookStatus(
    playbookId: string,
    status: PlaybookStatus,
  ): Promise<void> {
    const unavailable = this.requireOpen()
    if (unavailable) throw new MemoryV2StorageError(unavailable.error)
    try {
      this.database
        .query(
          `UPDATE memory_playbooks
              SET status = ?1, updated_at = ?2
            WHERE playbook_id = ?3`,
        )
        .run(status, Date.now(), playbookId)
    } catch (error) {
      if (error instanceof MemoryV2StorageError) throw error
      throw new MemoryV2StorageError(classifyStorageError(error))
    }
  }

  /**
   * Idempotent install of the built-in seed playbooks for one workspace.
   *
   * Deliberately NOT part of migrate(): the table is keyed by workspaceId,
   * which is unknown at migration time, so the caller seeds its own
   * workspace. Each seed is checked independently and skipped when a
   * playbook with that seed's trigger signature already exists for the
   * workspace. Exact host-owned legacy seeds upgrade their prerequisite
   * while preserving operator state; existing current identities skip.
   */
  async ensureSeedPlaybooks(workspaceId: string): Promise<void> {
    const unavailable = this.requireOpen()
    if (unavailable) throw new MemoryV2StorageError(unavailable.error)
    for (const seed of SEED_PLAYBOOKS) {
      this.database
        .transaction(() =>
          upgradeOwnedSeedPlaybook(this.database, workspaceId, seed),
        )
        .immediate()
      const triggerSignature = computeTriggerSignature(seed.trigger, seed.scope)
      try {
        const existing = this.database
          .query(
            `SELECT 1 AS present FROM memory_playbooks
              WHERE workspace_id = ?1 AND trigger_signature = ?2
              LIMIT 1`,
          )
          .get(workspaceId, triggerSignature) as { present: number } | null
        if (existing) continue
      } catch (error) {
        if (error instanceof MemoryV2StorageError) throw error
        throw new MemoryV2StorageError(classifyStorageError(error))
      }
      await this.upsertPlaybookByTriggerSignature({
        workspaceId,
        title: seed.title,
        instruction: seed.instruction,
        trigger: seed.trigger,
        scope: seed.scope,
        status: seed.status,
        enforcement: seed.enforcement,
        provenance: seed.provenance,
      })
    }
  }

  private readPlaybookRow(
    workspaceId: string,
    triggerSignature: string,
  ): PlaybookRow | null {
    return this.database
      .query(
        `SELECT ${PLAYBOOK_SELECT_COLUMNS}
           FROM memory_playbooks
          WHERE workspace_id = ?1 AND trigger_signature = ?2
          LIMIT 1`,
      )
      .get(workspaceId, triggerSignature) as PlaybookRow | null
  }

  async getCapabilities(): Promise<
    MemoryV2Result<{ capabilities: MemoryV2Capability[] }>
  > {
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
    if (!parsed.success)
      return rejectedOutcome('The memory query request is invalid.')
    const unavailable = this.requireOpen()
    if (unavailable) return operationFailureOutcome(unavailable.error)

    try {
      this.requireBoundProject(parsed.data.projectId)
      await this.ensureKnowledgeProjection()
      const plan = knowledgeQueryPlan(parsed.data, !!this.recallExpander)
      const scan =
        this.databasePath === ':memory:'
          ? readKnowledgeQuery(this.database, plan)
          : await scanKnowledgeQuery(this.databasePath, plan)
      const closed = this.requireOpen()
      if (closed) return operationFailureOutcome(closed.error)
      const events = scan.coverage.map((row) =>
        MemoryEventEnvelopeSchema.parse(JSON.parse(row.event_json)),
      )
      return {
        outcome: 'result',
        result: await buildLexicalResult(
          parsed.data,
          events,
          scan.candidateCapReached,
          false,
          this.recallExpander,
          scan,
          async (ids) => {
            if (this.closed) return []
            const eligibleIds = ids
              .filter((id) => typeof id === 'string')
              .slice(0, 8)
            if (!eligibleIds.length) return []
            const rows = this.database
              .query(
                `SELECT state_json FROM memory_knowledge WHERE project_id=? AND lifecycle='active' AND observation_id IN (${eligibleIds.map(() => '?').join(',')})`,
              )
              .all(parsed.data.projectId, ...eligibleIds) as Array<{
              state_json: string
            }>
            return rows.map(
              (row) => JSON.parse(row.state_json) as KnowledgeObservationState,
            )
          },
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
    if (!parsed.success)
      return rejectedOutcome('The memory verify request is invalid.')
    const action = parsed.data.action
    if (
      action.kind === 'verify' &&
      'path' in action.selector &&
      !action.observedDigest
    ) {
      return rejectedOutcome(
        'Path-backed evidence verification requires an observed digest.',
      )
    }
    const identity = stableJson({
      projectId: parsed.data.projectId,
      sessionId: parsed.data.sessionId,
      workspaceRevision: parsed.data.workspaceRevision,
      workspaceSnapshotId: parsed.data.workspaceSnapshotId,
      action,
    })
    const hash = createHash('sha256').update(identity).digest('hex')
    const timestamp = new Date(
      Date.UTC(2020, 0, 1) + Number.parseInt(hash.slice(0, 8), 16) * 1_000,
    ).toISOString()
    const eventType =
      action.kind === 'verify'
        ? 'evidence.verified'
        : action.kind === 'invalidate'
          ? 'evidence.invalidated'
          : 'evidence.rebound'
    const payload =
      action.kind === 'verify'
        ? {
            payloadSchemaVersion: 1 as const,
            observationId: action.observationId,
            selector: action.selector,
            verifier: 'bun-sqlite-memory-v2',
            verifiedAt: timestamp,
            ...(action.observedDigest
              ? { observedDigest: action.observedDigest }
              : {}),
            ...(parsed.data.workspaceRevision
              ? { workspaceRevision: parsed.data.workspaceRevision }
              : {}),
            ...(parsed.data.workspaceSnapshotId
              ? { workspaceSnapshotId: parsed.data.workspaceSnapshotId }
              : {}),
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
    const appended = await this.append(
      MemoryAppendRequestSchema.parse({
        schemaVersion: 2,
        projectId: parsed.data.projectId,
        events: [draft],
      }),
    )
    if (appended.outcome !== 'appended')
      return MemoryVerifyOutcomeSchema.parse(appended)
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
      if (!row)
        return failedOutcome(
          'internal',
          'The committed verification event was not found.',
          false,
        )
      return MemoryVerifyOutcomeSchema.parse({
        outcome: 'recorded',
        event: envelopeFromRow(row),
      })
    } catch (error) {
      return MemoryVerifyOutcomeSchema.parse(
        operationFailureOutcome(classifyStorageError(error)),
      )
    }
  }

  async rebuild(request: MemoryRebuildRequest): Promise<MemoryRebuildOutcome> {
    const parsed = MemoryRebuildRequestSchema.safeParse(request)
    if (!parsed.success)
      return rejectedOutcome('The memory rebuild request is invalid.')
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
      return commonHealth('unavailable', [
        'The memory health request is invalid.',
      ])
    }
    if (this.closed)
      return commonHealth('unavailable', ['The memory store is closed.'])

    try {
      const schemaVersion = readPragmaNumber(
        this.database,
        'PRAGMA user_version',
        'user_version',
      )
      const check = (await this.checkIntegrity()) ? 'ok' : 'failed'
      const journalMode = readPragmaString(
        this.database,
        'PRAGMA journal_mode',
        'journal_mode',
      )
      const issues: string[] = []
      if (schemaVersion !== SCHEMA_VERSION)
        issues.push('The memory store schema is incompatible.')
      if (check !== 'ok')
        issues.push('The memory store failed its integrity check.')
      if (journalMode.toLowerCase() !== 'wal')
        issues.push('The memory store is not using WAL mode.')
      return commonHealth(
        schemaVersion !== SCHEMA_VERSION || check !== 'ok'
          ? 'unavailable'
          : issues.length > 0
            ? 'degraded'
            : 'healthy',
        issues,
      )
    } catch (error) {
      return commonHealth('unavailable', [classifyStorageError(error).message])
    }
  }

  async export(request: MemoryExportRequest): Promise<MemoryExportOutcome> {
    const parsed = MemoryExportRequestSchema.safeParse(request)
    if (!parsed.success)
      return rejectedOutcome('The memory export request is invalid.')
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
          .get(parsed.data.afterEventId, parsed.data.projectId) as {
          sequence: number
        } | null
        if (!cursor)
          return rejectedOutcome(
            'The export cursor was not found.',
            'not-found',
          )
        afterSequence = cursor.sequence
      }
      // Tolerant reader: `skippedUnknownCount` counts rows whose event_type is
      // not a recognized canonical type (unknown/future types), which are
      // skipped so a future additive event type never bricks an older reader.
      // A KNOWN canonical type that fails strict decode is a hard error
      // (surfaced as a failed/rejected export outcome), never silently dropped.
      // export() issues exactly ONE raw query per call and builds the page from
      // that single raw page:
      // - `nextAfterEventId` is the authoritative opaque cursor, driven by the
      //   RAW rows (never recomputed from the filtered events), and a `null`
      //   cursor is the only terminal signal. It can advance past skipped tail
      //   rows, so an empty `events[]` MAY be paired with a non-null cursor
      //   when the whole raw page was dropped; consumers must guard
      //   loop-termination on the cursor, never on `events.length`.
      // - `rawTailEventId` is the id of the last RAW row in the page
      //   (decodable or not) and is the authoritative source for
      //   store-tail/CAS derivation; it is omitted only when the page observed
      //   zero raw rows.
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
        .all(
          afterSequence,
          parsed.data.projectId,
          parsed.data.limit,
        ) as EventRow[]
      const events: MemoryEventEnvelope[] = []
      let skippedUnknownCount = 0
      for (const row of rows) {
        if ((events.length + skippedUnknownCount) % 128 === 0)
          await yieldToEventLoop()
        if (!CANONICAL_EVENT_TYPES.has(row.event_type)) {
          skippedUnknownCount += 1
          continue
        }
        events.push(envelopeFromRow(row))
      }
      const lastRow = rows[rows.length - 1]
      const nextAfterEventId: MemoryEventEnvelope['eventId'] | null =
        rows.length === parsed.data.limit
          ? (lastRow!.event_id as MemoryEventEnvelope['eventId'])
          : null
      return {
        outcome: 'page',
        events,
        nextAfterEventId,
        ...(rows.length > 0
          ? {
              rawTailEventId: lastRow!
                .event_id as MemoryEventEnvelope['eventId'],
            }
          : {}),
        skippedUnknownCount,
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
      const schemaVersion = readPragmaNumber(
        this.database,
        'PRAGMA user_version',
        'user_version',
      )
      if (schemaVersion !== SCHEMA_VERSION) {
        return unavailableHealth(
          {
            kind: 'incompatible',
            message: 'The memory store schema is incompatible with this CLI.',
            retryable: false,
          },
          schemaVersion,
        )
      }
      const check = (await this.checkIntegrity()) ? 'ok' : 'failed'
      if (check !== 'ok') {
        return unavailableHealth(
          {
            kind: 'corrupt',
            message: 'The memory store failed its integrity check.',
            retryable: false,
          },
          schemaVersion,
        )
      }

      const journalMode = readPragmaString(
        this.database,
        'PRAGMA journal_mode',
        'journal_mode',
      )
      const synchronous = String(
        readPragmaNumber(this.database, 'PRAGMA synchronous', 'synchronous'),
      )
      return {
        status: journalMode.toLowerCase() === 'wal' ? 'healthy' : 'degraded',
        schemaVersion,
        journalMode,
        synchronous,
        openPosture: SQLITE_OPEN_POSTURE,
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

  async getStoreStats(request: {
    projectId: string
  }): Promise<MemoryStoreStats> {
    const unavailable = this.requireOpen()
    if (unavailable) throw new MemoryV2StorageError(unavailable.error)
    try {
      this.requireBoundProject(request.projectId)
      const count = (
        this.database
          .query(
            `SELECT COUNT(*) AS count FROM memory_events
              WHERE json_extract(metadata_json, '$.projectId') = ?1`,
          )
          .get(request.projectId) as { count: number }
      ).count
      const pageCount = readPragmaNumber(
        this.database,
        'PRAGMA page_count',
        'page_count',
      )
      const pageSize = readPragmaNumber(
        this.database,
        'PRAGMA page_size',
        'page_size',
      )
      return { eventCount: count, bytes: pageCount * pageSize }
    } catch (error) {
      if (error instanceof MemoryV2StorageError) throw error
      throw new MemoryV2StorageError(classifyStorageError(error))
    }
  }

  async selectGCandidates(request: {
    projectId: string
    olderThanDays: number
    maxEvents: number
  }): Promise<GcCandidateSelection> {
    const unavailable = this.requireOpen()
    if (unavailable) throw new MemoryV2StorageError(unavailable.error)
    try {
      this.requireBoundProject(request.projectId)
      if (
        !Number.isInteger(request.olderThanDays) ||
        request.olderThanDays < 1 ||
        request.olderThanDays > 365
      ) {
        throw new MemoryV2StorageError({
          kind: 'invalid',
          message: 'The GC olderThanDays must be an integer between 1 and 365.',
          retryable: false,
        })
      }
      if (
        !Number.isInteger(request.maxEvents) ||
        request.maxEvents < 1 ||
        request.maxEvents > GC_SELECT_LIMIT
      ) {
        throw new MemoryV2StorageError({
          kind: 'invalid',
          message: 'The GC maxEvents must be an integer between 1 and 10000.',
          retryable: false,
        })
      }
      const eventTypePlaceholders = GC_RELEVANT_EVENT_TYPES.map(
        (_, index) => `?${index + 3}`,
      ).join(',')
      const rows = this.database
        .query(
          `SELECT event_id, event_type, sequence, occurred_at, payload_json FROM memory_events
            WHERE json_extract(metadata_json, '$.projectId') = ?1
              AND event_type IN (${eventTypePlaceholders})
            ORDER BY sequence ASC
            LIMIT ?2`,
        )
        .all(
          request.projectId,
          GC_SELECT_LIMIT,
          ...GC_RELEVANT_EVENT_TYPES,
        ) as Array<{
        event_id: string
        event_type: string
        sequence: number
        occurred_at: string
        payload_json: string
      }>
      const envelopes: GCRelevantEnvelope[] = []
      let asOfTurnWall = '1970-01-01T00:00:00.000Z'
      for (const row of rows) {
        let payload: unknown
        try {
          payload = JSON.parse(row.payload_json) as unknown
        } catch {
          // Malformed payload rows are skipped; selection is best-effort.
          // The privileged compaction pre-check remains fail-closed.
          continue
        }
        envelopes.push({
          eventType: row.event_type,
          eventId: row.event_id,
          sequence: Number(row.sequence),
          occurredAt: row.occurred_at,
          payload,
        })
        if (row.occurred_at > asOfTurnWall) asOfTurnWall = row.occurred_at
      }
      const selection = selectCompactionCandidates({
        envelopes,
        maxEvents: request.maxEvents,
        asOfTurnWall,
      })
      return {
        eventIds: selection.eventIds as GcCandidateSelection['eventIds'],
      }
    } catch (error) {
      if (error instanceof MemoryV2StorageError) throw error
      throw new MemoryV2StorageError(classifyStorageError(error))
    }
  }

  async inspectForGC(request: {
    projectId: string
    olderThanDays: number
    maxEvents: number
  }): Promise<GcCandidateSelection> {
    return this.selectGCandidates(request)
  }

  async privilegedCompact(
    input: PrivilegedCompactionInput,
  ): Promise<PrivilegedCompactionResult> {
    const unavailable = this.requireOpen()
    if (unavailable) throw new MemoryV2StorageError(unavailable.error)
    try {
      this.requireBoundProject(input.projectId)
    } catch (error) {
      throw error instanceof MemoryV2StorageError
        ? error
        : new MemoryV2StorageError(classifyStorageError(error))
    }
    const fail = (message: string): never => {
      throw new MemoryV2StorageError({
        kind: 'invalid',
        message,
        retryable: false,
      })
    }
    if (
      !Array.isArray(input.eventIds) ||
      input.eventIds.length < 1 ||
      input.eventIds.length > COMPACTION_APPLY_MAX
    ) {
      fail(
        'The privileged compaction event list must contain 1 to 100 event IDs.',
      )
    }
    for (const id of input.eventIds) {
      if (!MemoryEventIdSchema.safeParse(id).success)
        fail('The privileged compaction event IDs are invalid.')
    }
    if (
      !Array.isArray(input.archiveLines) ||
      input.archiveLines.length !== input.eventIds.length
    ) {
      fail('The privileged compaction archive lines must match the event list.')
    }
    if (
      typeof input.archiveHash !== 'string' ||
      !DIGEST_PATTERN.test(input.archiveHash)
    ) {
      fail('The privileged compaction archive hash is invalid.')
    }
    if (
      typeof input.archivePath !== 'string' ||
      input.archivePath.length < 1 ||
      input.archivePath.length > 1024
    ) {
      fail('The privileged compaction archive path is invalid.')
    }
    const draft = MemoryEventDraftSchema.safeParse(input.archiveClaimDraft)
    if (!draft.success || draft.data.eventType !== 'claim.archived') {
      fail('The privileged compaction archive claim is invalid.')
    }
    const claim = draft.data as Extract<
      typeof draft.data,
      { eventType: 'claim.archived' }
    >
    if (claim.projectId !== input.projectId) {
      fail('The privileged compaction archive claim project does not match.')
    }
    if (
      claim.payload.archivedEventIds.length !== input.eventIds.length ||
      claim.payload.archivedEventIds.some(
        (id, index) => id !== input.eventIds[index],
      )
    ) {
      fail('The privileged compaction archive claim events do not match.')
    }
    if (
      claim.payload.archiveHash !== input.archiveHash ||
      claim.payload.archivePath !== input.archivePath
    ) {
      fail(
        'The privileged compaction archive claim hash or path does not match.',
      )
    }
    const expectedHash = `sha256:${createHash('sha256').update(stableJson(input.archiveLines)).digest('hex')}`
    if (expectedHash !== input.archiveHash) {
      fail(
        'The privileged compaction archive hash does not match the archive lines.',
      )
    }
    const before = await this.getStoreStats({ projectId: input.projectId })
    const placeholders = input.eventIds.map(() => '?').join(',')
    const projectParamIndex = input.eventIds.length + 1
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.database
        .query(
          `SELECT event_id FROM memory_events
            WHERE event_id IN (${placeholders})
              AND json_extract(metadata_json, '$.projectId') = ?${projectParamIndex}`,
        )
        .all(...input.eventIds, input.projectId) as Array<{ event_id: string }>
      if (existing.length !== input.eventIds.length) {
        fail(
          'The privileged compaction events were not found for this project.',
        )
      }
      // P6 fail-closed closure verification BEFORE the delete trigger is
      // dropped: every observation referenced by a batch event must have its
      // anchor 'observation.recorded' inside the batch (group closure), and
      // no shared event outside the batch may reference an archived
      // observation (resurrection / shared-event corruption gate).
      const batchRows = this.database
        .query(
          `SELECT event_id, event_type, sequence, occurred_at, payload_json FROM memory_events
            WHERE event_id IN (${placeholders})
              AND json_extract(metadata_json, '$.projectId') = ?${projectParamIndex}`,
        )
        .all(...input.eventIds, input.projectId) as Array<{
        event_id: string
        event_type: string
        sequence: number
        occurred_at: string
        payload_json: string
      }>
      const batchEnvelopes: GCRelevantEnvelope[] = []
      for (const row of batchRows) {
        let payload: unknown
        try {
          payload = JSON.parse(row.payload_json) as unknown
        } catch {
          fail(
            'The privileged compaction batch contains a malformed event payload.',
          )
        }
        batchEnvelopes.push({
          eventType: row.event_type,
          eventId: row.event_id,
          sequence: Number(row.sequence),
          occurredAt: row.occurred_at,
          payload,
        })
      }
      const referencedObservationIds = new Set<string>()
      const batchAnchoredObservationIds = new Set<string>()
      const batchEventIdSet = new Set(
        batchEnvelopes.map((envelope) => envelope.eventId),
      )
      for (const envelope of batchEnvelopes) {
        for (const id of observationIdsReferencedBy(
          envelope.eventType,
          envelope.payload,
        )) {
          referencedObservationIds.add(id)
        }
        if (envelope.eventType === 'observation.recorded') {
          for (const id of observationIdsReferencedBy(
            envelope.eventType,
            envelope.payload,
          )) {
            batchAnchoredObservationIds.add(id)
          }
        }
      }
      for (const id of referencedObservationIds) {
        if (!batchAnchoredObservationIds.has(id)) {
          fail(
            `The privileged compaction batch does not close the observation group for ${id}: the observation.recorded anchor is missing.`,
          )
        }
      }
      const batchEventTypePlaceholders = GC_RELEVANT_EVENT_TYPES.map(
        (_, index) => `?${input.eventIds.length + 1 + index}`,
      ).join(',')
      const sharedOutside = this.database
        .query(
          `SELECT event_id, event_type, payload_json FROM memory_events
            WHERE event_id NOT IN (${placeholders})
              AND event_type IN (${batchEventTypePlaceholders})
              AND json_extract(metadata_json, '$.projectId') = ?${
                input.eventIds.length + GC_RELEVANT_EVENT_TYPES.length + 1
              }`,
        )
        .all(
          ...input.eventIds,
          ...GC_RELEVANT_EVENT_TYPES,
          input.projectId,
        ) as Array<{
        event_id: string
        event_type: string
        payload_json: string
      }>
      for (const row of sharedOutside) {
        if (!GC_SHARED_EVENT_TYPES.includes(row.event_type)) continue
        if (batchEventIdSet.has(row.event_id)) continue
        let payload: unknown
        try {
          payload = JSON.parse(row.payload_json) as unknown
        } catch {
          // Outside rows keep selection's tolerant posture; only batch rows
          // are fail-closed here.
          continue
        }
        const references = observationIdsReferencedBy(row.event_type, payload)
        const conflict = references.find((id) =>
          referencedObservationIds.has(id),
        )
        if (conflict !== undefined) {
          fail(
            `Privileged compaction closure violated: shared event ${row.event_id} outside the batch references archived observation ${conflict}.`,
          )
        }
      }
      this.database.exec('DROP TRIGGER IF EXISTS memory_events_no_delete')
      const deleted = this.database
        .query(
          `DELETE FROM memory_events
            WHERE event_id IN (${placeholders})
              AND json_extract(metadata_json, '$.projectId') = ?${projectParamIndex}`,
        )
        .run(...input.eventIds, input.projectId) as unknown as {
        changes: unknown
      }
      if (Number(deleted.changes) !== input.eventIds.length) {
        fail('The privileged compaction delete did not remove every event.')
      }
      this.database.exec(NO_DELETE_TRIGGER_SQL)
      const prepared = prepareEvent(claim)
      const duplicate = this.database
        .query('SELECT event_id FROM memory_events WHERE event_id = ?1')
        .get(prepared.eventId) as { event_id: string } | null
      if (duplicate) {
        fail('The privileged compaction archive claim already exists.')
      }
      this.database
        .query(
          `INSERT INTO memory_events (
             event_id, idempotency_key, event_type, occurred_at, payload_json,
             metadata_json, task_id, session_id, artifact_id
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .run(
          prepared.eventId,
          prepared.idempotencyKey,
          prepared.eventType,
          prepared.occurredAt,
          prepared.payloadJson,
          prepared.metadataJson,
          prepared.taskId,
          prepared.sessionId,
          prepared.artifactId,
        )
      for (const table of PROJECTION_TABLES)
        this.database.exec(`DELETE FROM ${table}`)
      // The usage projection must stay consistent with the surviving event log:
      // clearing the canonical events (including archived 'observation.reused'
      // events) invalidates their usage counters, so memory_usage is rebuilt
      // from scratch exactly like every other projection table (matches
      // rebuildProjections).
      this.database.exec('DELETE FROM memory_usage')
      // claim_dedup is rebuilt from the surviving log during the replay.
      this.database.exec('DELETE FROM claim_dedup')
      clearKnowledgeProjection(this.database)
      setProjectionCursor(this.database, 0)
      replayProjections(this.database, Number.MAX_SAFE_INTEGER)
      this.database.exec('COMMIT')
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // Preserve the primary compaction failure.
      }
      if (error instanceof MemoryV2StorageError) throw error
      throw new MemoryV2StorageError(classifyStorageError(error))
    }
    try {
      this.database.exec('VACUUM')
    } catch (error) {
      throw new MemoryV2StorageError(classifyStorageError(error))
    }
    const after = await this.getStoreStats({ projectId: input.projectId })
    return {
      archivedEventIds: [
        ...input.eventIds,
      ] as PrivilegedCompactionResult['archivedEventIds'],
      beforeCount: before.eventCount,
      afterCount: after.eventCount,
      beforeBytes: before.bytes,
      afterBytes: after.bytes,
    }
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
        message:
          'This memory database is already bound to a different project.',
        retryable: false,
      })
    }
    if (bound === null) {
      this.database
        .query(
          "INSERT INTO memory_projection_metadata(key, value) VALUES ('project_id', ?1)",
        )
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
          message:
            'This eventful memory database is not bound to a valid project.',
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
      .query(
        "SELECT value FROM memory_projection_metadata WHERE key = 'project_id'",
      )
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
      .query(
        'SELECT event_id FROM memory_events ORDER BY sequence DESC LIMIT 1',
      )
      .get() as { event_id: string } | null
    return row?.event_id ?? null
  }

  private readProjectionCursor(): number {
    const row = this.database
      .query(
        "SELECT value FROM memory_projection_metadata WHERE key = 'cursor'",
      )
      .get() as { value: string } | null
    return row ? Number(row.value) : 0
  }

  /** Repair pages commit their cursor with their data, so interruption/reopen resumes safely. */
  private async ensureKnowledgeProjection(): Promise<void> {
    if (this.closed) return
    if (this.knowledgeRepair) return this.knowledgeRepair
    this.knowledgeRepair = (async () => {
      const producer = this.database
        .query(
          "SELECT value FROM memory_knowledge_metadata WHERE key='producer'",
        )
        .get() as { value: string } | null
      if (producer?.value !== KNOWLEDGE_PRODUCER_VERSION)
        throw incompatibleSchemaError()
      const cursor = knowledgeCursor(this.database)
      const checkpoint = this.database
        .query(
          "SELECT value FROM memory_knowledge_metadata WHERE key='cursorEventId'",
        )
        .get() as { value: string } | null
      const anchor = cursor
        ? (this.database
            .query('SELECT event_id FROM memory_events WHERE sequence=?1')
            .get(cursor) as { event_id: string } | null)
        : null
      if (
        cursor > 0 &&
        (!anchor || (checkpoint?.value && checkpoint.value !== anchor.event_id))
      )
        this.database
          .transaction(() => clearKnowledgeProjection(this.database))
          .immediate()
      if (
        !this.database
          .query(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_knowledge_fts'",
          )
          .get()
      )
        this.database.exec(
          'DROP TRIGGER IF EXISTS memory_knowledge_ai;DROP TRIGGER IF EXISTS memory_knowledge_ad;DROP TRIGGER IF EXISTS memory_knowledge_au;',
        )
      while (!this.closed) {
        const repaired = this.database
          .transaction(() => {
            const cursor = knowledgeCursor(this.database)
            const rows = this.database
              .query(
                `SELECT sequence,event_id,idempotency_key,event_type,occurred_at,payload_json,metadata_json,task_id,session_id,artifact_id FROM memory_events WHERE sequence>?1 ORDER BY sequence LIMIT ?2`,
              )
              .all(cursor, PAGE_SIZE) as EventRow[]
            for (const row of rows) {
              validateCanonicalProjectionRow(row)
              const metadata = JSON.parse(row.metadata_json) as Record<
                string,
                unknown
              >
              if (
                metadata.schemaVersion === 2 &&
                CANONICAL_EVENT_TYPES.has(row.event_type)
              )
                applyKnowledgeEvent(this.database, envelopeFromRow(row))
              advanceKnowledgeCursor(
                this.database,
                row.sequence,
                row.occurred_at,
                row.event_id,
              )
            }
            return rows.length
          })
          .immediate()
        if (repaired === 0) break
        await yieldToEventLoop()
      }
    })()
    try {
      await this.knowledgeRepair
    } finally {
      this.knowledgeRepair = undefined
    }
  }

  private async ensureArchiveMigration(): Promise<number> {
    if (this.archiveMigration) return this.archiveMigration
    this.archiveMigration = (async () => {
      let invalid = 0
      while (!this.closed) {
        const page = migrateArchivePage(this.database)
        invalid = page.invalid
        if (!page.remaining) break
        await yieldToEventLoop()
      }
      return invalid
    })()
    try {
      return await this.archiveMigration
    } finally {
      this.archiveMigration = undefined
    }
  }
}

export async function openBunSQLiteMemoryRepository(
  options: BunSQLiteMemoryRepositoryOptions = {},
): Promise<BunSQLiteMemoryRepositoryOpenResult> {
  return BunSQLiteMemoryRepository.open(options)
}

function prepareDatabasePath(
  options: BunSQLiteMemoryRepositoryOptions,
): PreparedDatabasePath {
  const root = resolve(options.repositoryRoot ?? process.cwd())
  const requested = options.databasePath ?? DEFAULT_DATABASE_PATH
  const databasePath = isAbsolute(requested)
    ? resolve(requested)
    : resolve(root, requested)
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
  const entries = databasePaths(databasePath).map((path) => ({
    path,
    entry: lstatExisting(path),
  }))
  for (const { entry } of entries) if (entry) assertSafeFileEntry(entry)
  const existingIdentity = entries[0]!.entry ? fileIdentity(databasePath) : null
  return { databasePath, realRoot, realParent, existingIdentity }
}

function databasePaths(databasePath: string): string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
}

function assertOwned(entry: Stats): void {
  if (typeof process.getuid === 'function' && entry.uid !== process.getuid())
    throw unsafeFilesystemError()
}

function assertSafeDirectory(path: string): void {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isDirectory())
    throw unsafeFilesystemError()
  assertOwned(entry)
}

function lstatExisting(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: unknown }).code === 'ENOENT'
    )
      return null
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
  if (
    !isContainedPath(prepared.realRoot, realDatabase) ||
    !isContainedPath(prepared.realParent, realDatabase) ||
    realpathSync(dirname(prepared.databasePath)) !== prepared.realParent
  )
    throw containedDatabaseError()
  assertSafeFile(prepared.databasePath)
  if (prepared.existingIdentity) {
    const opened = fileIdentity(prepared.databasePath)
    if (
      opened.dev !== prepared.existingIdentity.dev ||
      opened.ino !== prepared.existingIdentity.ino
    ) {
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

async function preflightExistingDatabase(
  prepared: PreparedDatabasePath,
): Promise<void> {
  if (!prepared.existingIdentity) return
  for (const path of databasePaths(prepared.databasePath)) {
    const entry = lstatExisting(path)
    if (entry) assertSafeFileEntry(entry)
  }
  let database: Database | undefined
  try {
    database = new Database(prepared.databasePath, {
      readonly: true,
      strict: true,
    })
    const version = readPragmaNumber(
      database,
      'PRAGMA user_version',
      'user_version',
    )
    if (version > SCHEMA_VERSION) {
      throw new MemoryV2StorageError({
        kind: 'incompatible',
        message: 'The memory store was created by a newer, incompatible CLI.',
        retryable: false,
      })
    }
    if (version >= 1 && version <= SCHEMA_VERSION)
      validateSchemaShape(database, version)
    else if (version !== 0) throw incompatibleSchemaError()
    // Keep the corruption gate before every writable open, but run its full
    // database scan off the TUI thread. Worker failure also refuses the open.
    if (!(await checkSQLiteIntegrity(prepared.databasePath))) {
      throw corruptStoreError()
    }
  } finally {
    database?.close()
  }
}

function validateSchemaShape(database: Database, version: number): void {
  const requiredTables = [
    'memory_events',
    'memory_projection_metadata',
    'memory_store_capabilities',
  ]
  if (version >= 2) requiredTables.push(...PROJECTION_TABLES)
  const tables = database
    .query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${requiredTables.map(() => '?').join(',')})`,
    )
    .all(...requiredTables) as Array<{ name: string }>
  if (tables.length !== requiredTables.length) throw incompatibleSchemaError()

  assertTableColumns(database, 'memory_events', [
    'sequence',
    'event_id',
    'idempotency_key',
    'event_type',
    'occurred_at',
    'payload_json',
    'metadata_json',
    'task_id',
    'session_id',
    'artifact_id',
  ])
  assertTableColumns(database, 'memory_projection_metadata', ['key', 'value'])
  assertTableColumns(database, 'memory_store_capabilities', [
    'name',
    'available',
    'fallback',
    'value',
  ])
  if (version >= 2) {
    for (const table of PROJECTION_TABLES) {
      assertTableColumns(database, table, [
        'entity_id',
        'task_id',
        'session_id',
        'state_json',
        'source_sequence',
        'updated_at',
      ])
    }
  }

  const triggers = database
    .query(
      `SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name IN ('memory_events_no_update', 'memory_events_no_delete')`,
    )
    .all() as Array<{ name: string; sql: string | null }>
  if (triggers.length !== 2) throw incompatibleSchemaError()
  for (const [name, operation] of [
    ['memory_events_no_update', 'update'],
    ['memory_events_no_delete', 'delete'],
  ] as const) {
    const sql = triggers
      .find((trigger) => trigger.name === name)
      ?.sql?.toLowerCase()
      .replace(/\s+/g, ' ')
    if (
      !sql?.includes(`before ${operation} on memory_events`) ||
      !sql.includes("raise(abort, 'canonical memory events are append only')")
    ) {
      throw incompatibleSchemaError()
    }
  }
}

function assertTableColumns(
  database: Database,
  table: string,
  required: readonly string[],
): void {
  const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
  }>
  const names = new Set(columns.map(({ name }) => name))
  if (required.some((name) => !names.has(name))) throw incompatibleSchemaError()
}

function unsafeFilesystemError(): MemoryV2StorageError {
  return new MemoryV2StorageError({
    kind: 'incompatible',
    message: 'The memory store contains an unsafe filesystem entry.',
    retryable: false,
  })
}

function incompatibleSchemaError(): MemoryV2StorageError {
  return new MemoryV2StorageError({
    kind: 'incompatible',
    message: 'The memory store schema is incompatible with this CLI.',
    retryable: false,
  })
}

function corruptStoreError(): MemoryV2StorageError {
  return new MemoryV2StorageError({
    kind: 'corrupt',
    message: 'The memory store failed its integrity check.',
    retryable: false,
  })
}

/**
 * The typed outcome of a refused strict open. bun:sqlite opens the database
 * and its -wal/-shm sidecars by pathname and cannot accept a descriptor, so a
 * descriptor-relative/no-follow open cannot be proven for any path and the
 * store is left unopened.
 */
function insecureOpenUnavailableFailure(): MemoryV2Failure {
  return {
    kind: 'unsupported-open',
    message:
      'SQLite secure open is not available: bun:sqlite opens the database and its -wal/-shm sidecars by pathname; a descriptor-relative/no-follow open cannot be proven, so the store is left unopened (fail-closed).',
    retryable: false,
  }
}

function isContainedPath(parent: string, child: string): boolean {
  const relation = relative(parent, child)
  return (
    relation !== '..' &&
    !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(relation)
  )
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
  const version = readPragmaNumber(
    database,
    'PRAGMA user_version',
    'user_version',
  )
  if (version > SCHEMA_VERSION) throw incompatibleSchemaError()

  database.exec('BEGIN IMMEDIATE')
  try {
    if (version < 1) database.exec(MIGRATION_1)
    if (version < 2) database.exec(MIGRATION_2)
    // Additive P4 projection table: created idempotently on every open so
    // existing stores gain it without a structural migration.
    database.exec(MEMORY_USAGE_DDL)
    // Additive P7 projection table: created idempotently on every open so
    // existing stores gain it without a structural migration. This build
    // also bumps PRAGMA user_version to the current SCHEMA_VERSION below, so a
    // pre-P7 build sharing the file fails closed at its own open (version
    // > its SCHEMA_VERSION) instead of compacting/rebuilding a store whose
    // claim.reinforced protection it cannot see.
    database.exec(CLAIM_DEDUP_DDL)
    database.exec(KNOWLEDGE_PROJECTION_DDL)
    const hadKnowledgeFts = !!database
      .query(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_knowledge_fts'",
      )
      .get()
    try {
      database.exec(KNOWLEDGE_FTS_DDL)
      if (!hadKnowledgeFts)
        database.exec(
          "INSERT INTO memory_knowledge_fts(memory_knowledge_fts) VALUES ('rebuild')",
        )
    } catch {
      /* Indexed selectors remain available without FTS5. */
    }
    const knowledgeProducer = database
      .query("SELECT value FROM memory_knowledge_metadata WHERE key='producer'")
      .get() as { value: string } | null
    if (knowledgeProducer?.value === 'current-knowledge-1') {
      if (
        !database
          .query(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_knowledge_fts'",
          )
          .get()
      )
        database.exec(
          'DROP TRIGGER IF EXISTS memory_knowledge_ai;DROP TRIGGER IF EXISTS memory_knowledge_ad;DROP TRIGGER IF EXISTS memory_knowledge_au;',
        )
      // Version 1 collapsed symbol occurrences in evidence freshness. Keep
      // canonical history and resume the corrected projection from zero.
      clearKnowledgeProjection(database)
      database
        .query(
          "UPDATE memory_knowledge_metadata SET value=?1 WHERE key='producer'",
        )
        .run(KNOWLEDGE_PRODUCER_VERSION)
    }
    // Bodies and manifests migrate transactionally, with payload backfill
    // deferred to bounded resumable pages on the archive surface.
    migrateContextArchiveSchema(database)
    // Additive procedural-memory table: created idempotently on every open so
    // existing stores gain it without a structural migration. Nothing here
    // touches the canonical event log or its append-only triggers.
    database.exec(MEMORY_PLAYBOOKS_DDL)
    inferAndBindProject(database)
    // A v1->v2 migration replay must stay correct-and-complete: truncating it
    // would leave the projections partially applied while the migration commits,
    // so it intentionally replays fully (no total-event budget). Failure still
    // rolls the whole migration back. replayProjections advances the claim_dedup
    // backfill marker to the replay tail itself.
    if (version === 1) {
      replayProjections(database, Number.MAX_SAFE_INTEGER)
    } else {
      // P7 cold-start backfill: pre-existing v2 stores gain the claim_dedup
      // projection additively (no user_version bump), so it is derived here
      // from the surviving canonical log on open instead of staying empty
      // until the first duplicate arrives or an explicit
      // rebuildProjections()/privilegedCompact() runs. Incremental: a recorded
      // marker bounds the replay to events appended since the last backfill,
      // covering histories written by builds that never maintained it.
      backfillClaimDedup(database)
    }
    // stale-claim-dedup-after-legacy-compaction repair (defense in depth
    // behind the user_version gate above): any path that deletes canonical
    // events and rebuilds the projections without maintaining claim_dedup
    // (e.g. a pre-P7 build that pre-dates the gate) leaves dedup rows whose
    // anchor observations no longer exist in memory_claims. A stale row
    // would make a later record_decision dedup-hit the deleted observation
    // and replace the capture with a claim.reinforced event that folds to
    // nothing — silently losing the new decision text. Drop every dedup row
    // whose observation is absent from memory_claims; the incremental
    // backfill above already folded the surviving log, so this removes only
    // genuinely stale anchors.
    database.exec(
      'DELETE FROM claim_dedup WHERE observation_id NOT IN (SELECT entity_id FROM memory_claims)',
    )
    if (version !== SCHEMA_VERSION)
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function inferAndBindProject(database: Database): void {
  const bound = database
    .query(
      "SELECT value FROM memory_projection_metadata WHERE key = 'project_id'",
    )
    .get() as { value: string } | null
  const parsedBound = bound ? ProjectIdSchema.safeParse(bound.value) : null
  if (parsedBound && !parsedBound.success) throw invalidProjectStoreError()

  const count = (
    database.query('SELECT COUNT(*) AS count FROM memory_events').get() as {
      count: number
    }
  ).count
  if (count === 0) return
  const rows = database
    .query(
      `SELECT json_extract(metadata_json, '$.projectId') AS project_id,
            json_type(metadata_json, '$.projectId') AS project_type
       FROM memory_events
      WHERE json_extract(metadata_json, '$.schemaVersion') = 2`,
    )
    .all() as Array<{ project_id: unknown; project_type: string | null }>
  if (rows.length === 0) return

  const projects = new Set<string>()
  for (const row of rows) {
    const parsedProjectId =
      row.project_type === 'text'
        ? ProjectIdSchema.safeParse(row.project_id)
        : null
    if (!parsedProjectId?.success) throw invalidProjectStoreError()
    projects.add(parsedProjectId.data)
    if (projects.size > 1) throw invalidProjectStoreError()
  }
  const projectId = [...projects][0]
  if (!projectId) throw invalidProjectStoreError()
  if (parsedBound?.success && parsedBound.data !== projectId)
    throw invalidProjectStoreError()
  if (!bound)
    database
      .query(
        "INSERT INTO memory_projection_metadata(key, value) VALUES ('project_id', ?1)",
      )
      .run(projectId)
}

function invalidProjectStoreError(): MemoryV2StorageError {
  return new MemoryV2StorageError({
    kind: 'incompatible',
    message: 'The memory store contains invalid or mixed project identities.',
    retryable: false,
  })
}

function replayProjections(
  database: Database,
  maxEvents: number = MAX_REPLAY_EVENTS,
): {
  cursor: number
  projectedEvents: number
  truncated: boolean
} {
  let cursor = 0
  let projectedEvents = 0
  let truncated = false
  // A full replay rebuilds every projection (claim_dedup included) from
  // scratch, so the claim_dedup backfill marker restarts together with the
  // projection cursor and is advanced to the replay tail on every exit —
  // otherwise the next store open would re-fold the whole log.
  setClaimDedupBackfillCursor(database, 0)
  while (true) {
    if (projectedEvents >= maxEvents) {
      truncated = true
      break
    }
    const rows = database
      .query(
        `SELECT sequence, event_id, idempotency_key, event_type, occurred_at,
                payload_json, metadata_json, task_id, session_id, artifact_id
           FROM memory_events
          WHERE sequence > ?1
          ORDER BY sequence
          LIMIT ?2`,
      )
      .all(
        cursor,
        Math.min(PAGE_SIZE, maxEvents - projectedEvents),
      ) as EventRow[]
    if (rows.length === 0) break
    for (const row of rows) {
      validateCanonicalProjectionRow(row)
      applyProjection(database, preparedEventFromRow(row), row.sequence)
      cursor = row.sequence
      projectedEvents += 1
    }
  }
  const tail = (
    database
      .query('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM memory_events')
      .get() as { sequence: number }
  ).sequence
  if (truncated && cursor < tail) {
    // The replay budget was exhausted before reaching the canonical tail. Record
    // the last replayed sequence as the cursor (not the tail, which would falsely
    // claim the projections are complete) and surface the truncation signal.
    setProjectionCursor(database, cursor)
    // claim_dedup was folded exactly through `cursor`, so the incremental
    // backfill marker must advance to the same point.
    setClaimDedupBackfillCursor(database, cursor)
    return { cursor, projectedEvents, truncated: true }
  }
  if (cursor !== tail)
    throw new Error('Projection replay did not reach the canonical tail.')
  setProjectionCursor(database, tail)
  setClaimDedupBackfillCursor(database, tail)
  return { cursor: tail, projectedEvents, truncated: false }
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

const MEMORY_USAGE_DDL = `
  CREATE TABLE IF NOT EXISTS memory_usage (
    observation_id TEXT PRIMARY KEY,
    used_count INTEGER NOT NULL DEFAULT 0,
    ignored_count INTEGER NOT NULL DEFAULT 0,
    staled_count INTEGER NOT NULL DEFAULT 0,
    last_mechanism TEXT,
    last_turn_id TEXT,
    last_sequence INTEGER NOT NULL DEFAULT -1
  ) WITHOUT ROWID;
`

const CLAIM_DEDUP_DDL = `
  CREATE TABLE IF NOT EXISTS claim_dedup (
    claim_id TEXT PRIMARY KEY,
    observation_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS claim_dedup_observation ON claim_dedup(observation_id);
`

/**
 * Context-archive persistence side tables (the cross-session recall_context
 * source). Purely additive: nothing here touches memory_events, claims,
 * observations, projections, the MIGRATION_1 triggers, or the replay
 * semantics — recall reads never flow back into the canonical log.
 *
 * PRIVACY NOTE: tool bodies persist as sanitized by the CLI's
 * sanitizeForChatPersistence — saveChatState flushes the already-sanitized
 * run state, so this store never persists tool bodies less redacted than
 * the per-session run-state.json written by the same pass
 * (cli/src/utils/run-state-storage.ts saveChatState); this store lives in
 * the same user-local, project-bound trust domain.
 */
const PLAYBOOK_SELECT_COLUMNS = `playbook_id, workspace_id, task_id, title, instruction,
       trigger_json, scope_json, status, enforcement, counters_json,
       provenance_json, trigger_signature, expires_at, created_at, updated_at`

/**
 * Procedural-memory table (memory_playbooks): purely additive, created
 * idempotently on every open so existing stores gain it without a structural
 * migration. The unique (workspace_id, trigger_signature) index is the
 * playbook upsert/dedup key; the (workspace_id, status) index serves the
 * active-playbook lookup the runtime gate performs every turn.
 */
const MEMORY_PLAYBOOKS_DDL = `
  CREATE TABLE IF NOT EXISTS memory_playbooks (
    playbook_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    task_id TEXT,
    title TEXT NOT NULL,
    instruction TEXT NOT NULL,
    trigger_json TEXT NOT NULL CHECK (json_valid(trigger_json)),
    scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
    status TEXT NOT NULL,
    enforcement TEXT NOT NULL,
    counters_json TEXT NOT NULL CHECK (json_valid(counters_json)),
    provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
    trigger_signature TEXT NOT NULL,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_playbooks_workspace_status
    ON memory_playbooks(workspace_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS memory_playbooks_workspace_signature
    ON memory_playbooks(workspace_id, trigger_signature);
`

/**
 * Built-in seed playbooks installed per workspace by
 * {@link BunSQLiteMemoryRepository.ensureSeedPlaybooks}. Each seed is keyed
 * by its computeTriggerSignature(trigger, scope); the per-seed existence
 * check in that method skips a seed already present for the workspace, so
 * exact host-owned legacy rows are upgraded to validation receipts while
 * operator state and text survive. User-owned rules remain independent.
 */
const SEED_PLAYBOOKS: ReadonlyArray<{
  trigger: PlaybookTrigger
  scope: PlaybookScope
  title: string
  instruction: string
  status: PlaybookStatus
  enforcement: PlaybookEnforcement
  provenance: MemoryProvenance
}> = [
  {
    trigger: {
      tool: 'spawn_agents',
      spawnAgentType: 'git-committer',
      requireEvidence: [
        {
          kind: 'validationSucceeded',
          validationKinds: ['ci-local', 'package-checks'],
          withinMs: 1_800_000,
        },
      ],
    },
    scope: { repos: [] },
    title: 'Run the repo CI check before committing',
    instruction:
      'Before spawning git-committer to commit or push, require a successful host validation receipt for the repository CI check or the appropriate package checks whose source and configuration dependencies still match. Reuse a valid receipt produced by another actor; otherwise run the required check.',
    status: 'active',
    enforcement: 'warn',
    provenance: {
      origin: 'migration',
      recordedBy: 'bun-sqlite-memory-v2',
      sourceEventIds: [],
      metadata: {},
    },
  },
  {
    // A matching host-attested validation receipt can be reused across actors.
    trigger: {
      tool: 'run_terminal_command',
      terminalAction: 'git-push',
      requireEvidence: [
        {
          kind: 'validationSucceeded',
          validationKinds: ['ci-local', 'package-checks'],
          withinMs: 1_800_000,
        },
      ],
    },
    scope: { repos: [] },
    title: 'Run the repo CI check before pushing directly',
    instruction:
      'Before a direct git push, require a successful host validation receipt for the repository CI check or the appropriate package checks with matching source and configuration dependencies. A valid receipt produced by any actor is reusable. Run the required check when no valid receipt exists; do not push after failed or skipped validation.',
    status: 'active',
    enforcement: 'warn',
    provenance: {
      origin: 'migration',
      recordedBy: 'bun-sqlite-memory-v2',
      sourceEventIds: [],
      metadata: {},
    },
  },
]

/** Upgrade only the two exact host-owned legacy recipes; operator text and quality survive. */
function upgradeOwnedSeedPlaybook(
  database: Database,
  workspaceId: string,
  seed: (typeof SEED_PLAYBOOKS)[number],
): void {
  const legacyTrigger = {
    ...seed.trigger,
    requireEvidence: [
      {
        kind: 'toolSucceeded' as const,
        tool: 'run_terminal_command',
        commandPattern: '*check:ci-local*',
        withinMs: 14_400_000,
      },
    ],
  }
  const legacySignature = computeTriggerSignature(legacyTrigger, seed.scope)
  const old = database
    .query(
      `SELECT ${PLAYBOOK_SELECT_COLUMNS} FROM memory_playbooks WHERE workspace_id=?1 AND trigger_signature=?2`,
    )
    .get(workspaceId, legacySignature) as PlaybookRow | null
  if (!old) return
  const provenance = JSON.parse(old.provenance_json) as MemoryProvenance
  if (
    provenance.origin !== 'migration' ||
    provenance.recordedBy !== 'bun-sqlite-memory-v2'
  )
    return
  if (
    stableJson(JSON.parse(old.trigger_json)) !== stableJson(legacyTrigger) ||
    stableJson(JSON.parse(old.scope_json)) !== stableJson(seed.scope)
  )
    return
  const nextSignature = computeTriggerSignature(seed.trigger, seed.scope)
  const collision = database
    .query(
      `SELECT ${PLAYBOOK_SELECT_COLUMNS} FROM memory_playbooks WHERE workspace_id=?1 AND trigger_signature=?2`,
    )
    .get(workspaceId, nextSignature) as PlaybookRow | null
  let counters = PlaybookCountersSchema.parse(JSON.parse(old.counters_json))
  if (collision) {
    const collisionProvenance = JSON.parse(
      collision.provenance_json,
    ) as MemoryProvenance
    if (
      collisionProvenance.origin !== 'migration' ||
      collisionProvenance.recordedBy !== 'bun-sqlite-memory-v2'
    ) {
      // Existing operator policy owns the new identity. Preserve the old row
      // for inspection, with its prior state recorded in provenance.
      database
        .query(
          "UPDATE memory_playbooks SET status='retired',provenance_json=?1 WHERE playbook_id=?2",
        )
        .run(
          JSON.stringify({
            ...provenance,
            metadata: {
              ...provenance.metadata,
              legacyStatus: provenance.metadata.legacyStatus ?? old.status,
              seedMigration: 'validation-receipts-1',
            },
          }),
          old.playbook_id,
        )
      return
    }
    const other = PlaybookCountersSchema.parse(
      JSON.parse(collision.counters_json),
    )
    counters = {
      ...counters,
      fired: counters.fired + other.fired,
      blocked: counters.blocked + other.blocked,
      compliedAfterBlock:
        counters.compliedAfterBlock + other.compliedAfterBlock,
      falsePositives: counters.falsePositives + other.falsePositives,
      bypassed: counters.bypassed + other.bypassed,
      ...(counters.lastFiredAt || other.lastFiredAt
        ? {
            lastFiredAt: Math.max(
              counters.lastFiredAt ?? 0,
              other.lastFiredAt ?? 0,
            ),
          }
        : {}),
      ...(counters.lastFalsePositiveAt || other.lastFalsePositiveAt
        ? {
            lastFalsePositiveAt: Math.max(
              counters.lastFalsePositiveAt ?? 0,
              other.lastFalsePositiveAt ?? 0,
            ),
          }
        : {}),
    }
    database
      .query('DELETE FROM memory_playbooks WHERE playbook_id=?1')
      .run(collision.playbook_id)
  }
  const originalInstruction = seed.trigger.spawnAgentType
    ? 'Run the repository CI check (e.g. `bun run check:ci-local`, or the package-appropriate typecheck/test script) successfully in this session before spawning git-committer to commit or push.'
    : "Before any direct `git push` from the orchestrator, run the repository CI check yourself with run_terminal_command in this session (e.g. `bun run check:ci-local`, or the package-appropriate typecheck/test script) as its own command and let it succeed first. Do not delegate the check to a subagent — a subagent's runs are not visible to this check — and do not push on a red or skipped check."
  database
    .query(
      'UPDATE memory_playbooks SET trigger_json=?1,trigger_signature=?2,instruction=?3,counters_json=?4,provenance_json=?5,updated_at=?6 WHERE playbook_id=?7',
    )
    .run(
      JSON.stringify(seed.trigger),
      nextSignature,
      old.instruction === originalInstruction
        ? seed.instruction
        : old.instruction,
      JSON.stringify(counters),
      JSON.stringify({
        ...provenance,
        metadata: {
          ...provenance.metadata,
          seedMigration: 'validation-receipts-1',
        },
      }),
      Date.now(),
      old.playbook_id,
    )
}

/** Escape LIKE wildcards so a user term matches literally. */
function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** Count distinct (run_id, archived_at) snapshots among scanned rows. */
function countDistinctArchiveSnapshots(
  rows: ContextArchiveMessageRow[],
): number {
  const seen = new Set<string>()
  for (const row of rows)
    seen.add(row.snapshot_id ?? `${row.run_id}\u0000${row.archived_at}`)
  return seen.size
}

/**
 * Build bounded matches from scanned message rows: each match carries a
 * snippet centered on the first occurrence of any query term (mirroring the
 * runtime scanner's snippet shape). Rows beyond `limit` are dropped but
 * still count toward snapshotsSearched.
 */
function buildArchiveSearchMatches(
  rows: ContextArchiveMessageRow[],
  terms: string[],
  limit: number,
): ContextArchiveSearchMatch[] {
  const matches: ContextArchiveSearchMatch[] = []
  for (const row of rows) {
    if (matches.length >= limit) break
    const lowered = row.body.toLowerCase()
    const offsets = terms
      .map((term) => lowered.indexOf(term))
      .filter((offset) => offset >= 0)
    const first = offsets.length > 0 ? Math.min(...offsets) : 0
    const start = Math.max(0, first - CONTEXT_ARCHIVE_SNIPPET_CONTEXT)
    matches.push({
      runId: row.run_id,
      archivedAt: row.archived_at,
      step: row.step ?? 0,
      toolName: row.tool_name ?? '',
      toolCallId: row.tool_call_id ?? '',
      snippet: row.body.slice(start, start + CONTEXT_ARCHIVE_SNIPPET_CHARS),
    })
  }
  return matches
}

function recordRuntimeCapabilities(
  database: Database,
  journalMode: string,
): void {
  let fts5 = false
  try {
    database.exec(
      'CREATE VIRTUAL TABLE temp.memory_v2_fts_probe USING fts5(value)',
    )
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
  write.run(
    'fts5',
    fts5 ? 1 : 0,
    fts5 ? null : 'lexical-scan-v1',
    fts5 ? 'fts5' : 'lexical-scan-v1',
  )
  write.run(
    'journal_mode',
    journalMode.toLowerCase() === 'wal' ? 1 : 0,
    journalMode.toLowerCase() === 'wal' ? null : journalMode,
    journalMode,
  )
  write.run('lexical_fallback', 1, null, 'unicode-codepoint-order-v1')
  write.run('query', 1, null, 'bounded-lexical-v1')
  write.run('verify', 1, null, 'append-only-v1')
}

function prepareEvent(
  input: MemoryV2EventInput | MemoryEventDraft | MemoryEventEnvelope,
): PreparedEvent {
  if (!input || typeof input !== 'object')
    throw new Error('Event must be an object.')
  const value = input as unknown as Record<string, unknown>
  const eventId = requiredString(value.eventId ?? value.id, 'eventId', 512)
  const isEnvelope = value.schemaVersion === 2 && value.eventSchemaVersion === 1
  const idempotencyKey = requiredString(
    value.idempotencyKey ?? (isEnvelope ? `event:${eventId}` : value.eventId),
    'idempotencyKey',
    512,
  )
  const eventType = requiredString(
    value.eventType ?? value.type,
    'eventType',
    256,
  )
  const occurredAt = requiredString(
    value.occurredAt ?? value.timestamp,
    'occurredAt',
    64,
  )
  if (Number.isNaN(Date.parse(occurredAt)))
    throw new Error('occurredAt must be an ISO timestamp.')
  const payload = value.payload ?? {}
  const payloadRecord =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {}
  const metadata =
    value.metadata ??
    compactObject({
      schemaVersion: value.schemaVersion,
      eventSchemaVersion: value.eventSchemaVersion,
      projectId: value.projectId,
      sessionId: value.sessionId,
    })

  const prepared: PreparedEvent = {
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
    artifactId: optionalString(
      value.artifactId ?? payloadRecord.artifactId,
      'artifactId',
      512,
    ),
  }
  if (
    objectValue(metadata).schemaVersion === 2 &&
    CANONICAL_EVENT_TYPES.has(eventType)
  )
    envelopeFromPrepared(prepared, 1)
  return prepared
}

function compactObject(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  )
}

function stableJson(value: unknown): string {
  const seen = new Set<object>()
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item))
        throw new Error('JSON numbers must be finite.')
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

function applyProjection(
  database: Database,
  event: PreparedEvent,
  sequence: number,
  maintainKnowledge = true,
): void {
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {}
  const canonical =
    event.metadata &&
    typeof event.metadata === 'object' &&
    (event.metadata as Record<string, unknown>).schemaVersion === 2

  if (maintainKnowledge) {
    if (canonical && CANONICAL_EVENT_TYPES.has(event.eventType))
      applyKnowledgeEvent(database, envelopeFromPrepared(event, sequence))
    advanceKnowledgeCursor(database, sequence, event.occurredAt, event.eventId)
  }

  switch (event.eventType) {
    case 'task.created':
      upsertProjection(
        database,
        'memory_tasks',
        projectionId(payload.taskId),
        event,
        sequence,
        payload.taskId,
        {
          ...payload,
          status: payload.initialStatus,
        },
      )
      return
    case 'task.transitioned': {
      const taskId = projectionId(payload.taskId)
      upsertProjection(
        database,
        'memory_tasks',
        taskId,
        event,
        sequence,
        payload.taskId,
        {
          ...readProjectionState(database, 'memory_tasks', taskId),
          ...payload,
          status: payload.toStatus,
        },
      )
      return
    }
    case 'session.started':
    case 'session.ended': {
      const sessionId = event.sessionId
      upsertProjection(
        database,
        'memory_sessions',
        sessionId,
        event,
        sequence,
        payload.taskId,
        {
          ...readProjectionState(database, 'memory_sessions', sessionId),
          ...payload,
          sessionId,
          status:
            event.eventType === 'session.ended' ? payload.status : 'active',
        },
      )
      return
    }
    case 'artifact.classified':
      upsertProjection(
        database,
        'memory_artifacts',
        projectionId(
          payload.artifactId ?? nestedValue(payload.artifact, 'artifactId'),
        ),
        event,
        sequence,
        payload.taskId,
        payload,
      )
      return
    case 'observation.recorded': {
      const observation = objectValue(payload.observation)
      const observationId = projectionId(observation.observationId)
      upsertProjection(
        database,
        'memory_discoveries',
        observationId,
        event,
        sequence,
        observation.taskId,
        observation,
      )
      upsertClaim(
        database,
        event,
        sequence,
        observationId,
        'canonical',
        observation,
      )
      const provenance = objectValue(observation.provenance)
      const claimId = nestedValue(objectValue(provenance.metadata), 'claimId')
      upsertClaimDedup(database, claimId, observationId, sequence)
      return
    }
    case 'claim.consolidated': {
      for (const sourceId of stringArray(payload.sourceObservationIds)) {
        markProjectionLifecycle(
          database,
          'memory_discoveries',
          sourceId,
          event,
          sequence,
          'superseded',
        )
        markProjectionLifecycle(
          database,
          'memory_claims',
          sourceId,
          event,
          sequence,
          'superseded',
        )
        database
          .query('DELETE FROM claim_dedup WHERE observation_id = ?1')
          .run(sourceId)
      }
      const observation = objectValue(payload.canonicalObservation)
      const observationId = projectionId(observation.observationId)
      upsertProjection(
        database,
        'memory_discoveries',
        observationId,
        event,
        sequence,
        observation.taskId,
        observation,
      )
      upsertClaim(
        database,
        event,
        sequence,
        observationId,
        'consolidated',
        observation,
      )
      // claim-dedup-not-seeded-for-replacement-observations repair: seed the
      // dedup projection from the canonical head's provenance exactly like
      // the observation.recorded fold, so a duplicate record for the same
      // derived claim reinforces the surviving claim instead of creating a
      // fresh observation row (first-wins semantics keep replay determinism).
      const consolidatedProvenance = objectValue(observation.provenance)
      const consolidatedClaimId = nestedValue(
        objectValue(consolidatedProvenance.metadata),
        'claimId',
      )
      upsertClaimDedup(database, consolidatedClaimId, observationId, sequence)
      return
    }
    case 'claim.corrected':
      upsertClaim(
        database,
        event,
        sequence,
        projectionId(payload.observationId),
        'corrected',
        payload,
      )
      upsertClaim(
        database,
        event,
        sequence,
        projectionId(nestedValue(payload.correction, 'observationId')),
        'canonical',
        objectValue(payload.correction),
      )
      database
        .query('DELETE FROM claim_dedup WHERE observation_id = ?1')
        .run(projectionId(payload.observationId))
      {
        // claim-dedup-not-seeded-for-replacement-observations repair: seed
        // the dedup projection from the correction observation's provenance
        // exactly like the observation.recorded fold, so a duplicate record
        // for the same derived claim reinforces the surviving correction
        // instead of creating a fresh observation row (first-wins semantics
        // keep replay determinism).
        const correction = objectValue(payload.correction)
        const correctionProvenance = objectValue(correction.provenance)
        const correctionClaimId = nestedValue(
          objectValue(correctionProvenance.metadata),
          'claimId',
        )
        upsertClaimDedup(
          database,
          correctionClaimId,
          projectionId(correction.observationId),
          sequence,
        )
      }
      return
    case 'claim.superseded':
      upsertClaim(
        database,
        event,
        sequence,
        projectionId(payload.observationId),
        'superseded',
        payload,
      )
      database
        .query('DELETE FROM claim_dedup WHERE observation_id = ?1')
        .run(projectionId(payload.observationId))
      return
    case 'claim.forgotten':
      for (const observationId of stringArray(payload.observationIds)) {
        upsertClaim(
          database,
          event,
          sequence,
          observationId,
          'forgotten',
          payload,
        )
        database
          .query('DELETE FROM claim_dedup WHERE observation_id = ?1')
          .run(observationId)
      }
      return
    case 'claim.pinned':
      upsertClaim(
        database,
        event,
        sequence,
        projectionId(payload.observationId),
        'pinned',
        payload,
      )
      return
    case 'claim.archived':
      for (const archivedEventId of stringArray(payload.archivedEventIds)) {
        upsertClaim(
          database,
          event,
          sequence,
          projectionId(archivedEventId),
          'archived',
          payload,
        )
      }
      return
    case 'evidence.attached':
      for (const evidence of objectArray(payload.evidence)) {
        upsertEvidence(
          database,
          event,
          sequence,
          projectionId(payload.observationId),
          evidence,
          'attached',
        )
      }
      return
    case 'coverage.recorded':
      upsertProjection(
        database,
        'memory_discoveries',
        projectionId(payload.taskId + ':' + payload.dimension),
        event,
        sequence,
        payload.taskId,
        payload,
      )
      return
    case 'observation.reused': {
      const usageTurnId = projectionId(payload.turnId)
      for (const entry of objectArray(payload.used)) {
        upsertUsage(
          database,
          entry.observationId,
          sequence,
          entry.mechanism,
          usageTurnId,
          'used_count',
        )
      }
      for (const entry of objectArray(payload.ignored)) {
        upsertUsage(
          database,
          entry.observationId,
          sequence,
          entry.mechanism,
          usageTurnId,
          'ignored_count',
        )
      }
      return
    }
    case 'evidence.verified':
      upsertEvidence(
        database,
        event,
        sequence,
        projectionId(payload.observationId),
        payload,
        'verified',
      )
      return
    case 'evidence.invalidated':
      upsertEvidence(
        database,
        event,
        sequence,
        projectionId(payload.observationId),
        payload,
        'invalidated',
      )
      return
    case 'evidence.rebound': {
      const observationId = projectionId(payload.observationId)
      const previousSelector = objectValue(payload.previousSelector)
      const replacement = objectValue(payload.evidence)
      upsertEvidence(
        database,
        event,
        sequence,
        observationId,
        { selector: previousSelector },
        'rebound',
      )
      upsertEvidence(
        database,
        event,
        sequence,
        observationId,
        replacement,
        'attached',
      )
      return
    }
    default:
      if (canonical) return
  }

  const kind = event.eventType.split(/[.:/]/, 1)[0].toLowerCase()
  const definition = PROJECTIONS[kind]
  if (!definition) return
  const explicit = definition.explicitId ? event[definition.explicitId] : null
  const candidate = projectionId(
    explicit ?? payload[definition.payloadId] ?? payload.id,
  )
  upsertProjection(
    database,
    definition.table,
    candidate,
    event,
    sequence,
    event.taskId,
    payload,
  )
}

function readProjectionState(
  database: Database,
  table: string,
  entityId: string | null,
): Record<string, unknown> {
  if (!entityId) return {}
  const row = database
    .query(`SELECT state_json FROM ${table} WHERE entity_id = ?1`)
    .get(entityId) as { state_json: string } | null
  return row ? objectValue(JSON.parse(row.state_json) as unknown) : {}
}

function markProjectionLifecycle(
  database: Database,
  table: string,
  entityId: string,
  event: PreparedEvent,
  sequence: number,
  lifecycle: string,
): void {
  const prior = readProjectionState(database, table, entityId)
  if (Object.keys(prior).length > 0)
    upsertProjection(database, table, entityId, event, sequence, prior.taskId, {
      ...prior,
      lifecycle,
    })
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
  upsertProjection(
    database,
    'memory_claims',
    observationId,
    event,
    sequence,
    value.taskId,
    {
      ...prior,
      lifecycle,
      observationId,
      value: { ...objectValue(prior.value), ...value },
    },
  )
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
  const evidence =
    Object.keys(objectValue(prior.evidence)).length > 0
      ? objectValue(prior.evidence)
      : lifecycle === 'attached'
        ? value
        : {}
  upsertProjection(
    database,
    'memory_evidence',
    entityId,
    event,
    sequence,
    value.taskId,
    {
      ...prior,
      lifecycle,
      observationId,
      evidence,
      freshness: lifecycle === 'attached' ? {} : value,
    },
  )
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
    .run(
      entityId,
      projectionId(taskId) ?? event.taskId,
      event.sessionId,
      stableJson(state),
      sequence,
      event.occurredAt,
    )
}

/**
 * Monotonic usage projection for 'observation.reused' events: increments one
 * counter per entry, guarded by the event sequence so duplicate replays never
 * double-count. Never deletes; staled_count stays reserved (P4 never emits
 * 'staled').
 */
function upsertUsage(
  database: Database,
  observationId: unknown,
  sequence: number,
  mechanism: unknown,
  turnId: string | null,
  column: 'used_count' | 'ignored_count',
): void {
  const id = projectionId(observationId)
  if (!id) return
  const prior = database
    .query(
      `SELECT used_count, ignored_count, last_sequence
         FROM memory_usage WHERE observation_id = ?1`,
    )
    .get(id) as {
    used_count: number
    ignored_count: number
    last_sequence: number
  } | null
  if (prior && sequence <= prior.last_sequence) return
  const usedCount = (prior?.used_count ?? 0) + (column === 'used_count' ? 1 : 0)
  const ignoredCount =
    (prior?.ignored_count ?? 0) + (column === 'ignored_count' ? 1 : 0)
  database
    .query(
      `INSERT INTO memory_usage (
         observation_id, used_count, ignored_count, staled_count,
         last_mechanism, last_turn_id, last_sequence
       ) VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6)
       ON CONFLICT(observation_id) DO UPDATE SET
         used_count = excluded.used_count,
         ignored_count = excluded.ignored_count,
         staled_count = excluded.staled_count,
         last_mechanism = excluded.last_mechanism,
         last_turn_id = excluded.last_turn_id,
         last_sequence = excluded.last_sequence`,
    )
    .run(id, usedCount, ignoredCount, projectionId(mechanism), turnId, sequence)
}

/**
 * First-wins claim-dedup projection (P7): records the claim id an observation's
 * provenance carries, mapping it to the observation that first introduced it.
 * Replay-deterministic: a claim id already present is skipped regardless of
 * sequence, so replays never rebind a claim to a later observation.
 */
function upsertClaimDedup(
  database: Database,
  claimId: unknown,
  observationId: string | null,
  _sequence: number,
): void {
  const id =
    typeof claimId === 'string' && /^[0-9a-f]{64}$/.test(claimId)
      ? claimId
      : null
  if (!id || !observationId) return
  const existing = database
    .query('SELECT observation_id FROM claim_dedup WHERE claim_id = ?1')
    .get(id) as { observation_id: string } | null
  if (existing) return
  database
    .query('INSERT INTO claim_dedup (claim_id, observation_id) VALUES (?1, ?2)')
    .run(id, observationId)
}

function projectionId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    ? value
    : null
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function nestedValue(value: unknown, key: string): unknown {
  return objectValue(value)[key]
}

function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectValue) : []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(projectionId).filter((item): item is string => item !== null)
    : []
}

function setProjectionCursor(database: Database, sequence: number): void {
  database
    .query(
      "UPDATE memory_projection_metadata SET value = ?1 WHERE key = 'cursor'",
    )
    .run(String(sequence))
}

function readClaimDedupBackfillCursor(database: Database): number {
  const row = database
    .query('SELECT value FROM memory_projection_metadata WHERE key = ?1')
    .get(CLAIM_DEDUP_BACKFILL_KEY) as { value: string } | null
  const parsed = row ? Number(row.value) : 0
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function setClaimDedupBackfillCursor(
  database: Database,
  sequence: number,
): void {
  database
    .query(
      `INSERT INTO memory_projection_metadata(key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(CLAIM_DEDUP_BACKFILL_KEY, String(sequence))
}

/**
 * Cold-start backfill of the P7 claim-dedup projection: pre-existing v2
 * stores gain claim_dedup additively on open (no user_version bump), so the
 * projection is derived here from the surviving canonical log instead of
 * staying empty until the first duplicate arrives or an explicit
 * rebuildProjections()/privilegedCompact() runs. Incremental: a recorded
 * metadata marker bounds the replay to events appended since the last
 * backfill, so mixed-version histories (written by builds that never
 * maintained the marker) are folded exactly once and steady-state opens do
 * no work. The fold is the same first-wins + lifecycle-delete replay the
 * projection applies per event, so a suffix replay yields exactly the
 * full-replay state. Fail-closed parity with replayProjections: every row
 * passes validateCanonicalProjectionRow before folding, so a malformed
 * canonical event fails the open exactly as a rebuild would instead of
 * silently diverging the dedup state. Runs inside the migrate()
 * transaction: failure rolls the whole open back.
 */
function backfillClaimDedup(database: Database): void {
  let cursor = readClaimDedupBackfillCursor(database)
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
      applyProjection(database, preparedEventFromRow(row), row.sequence, false)
      cursor = row.sequence
    }
  }
  setClaimDedupBackfillCursor(database, cursor)
}

function isIdempotentMatch(row: EventRow, event: PreparedEvent): boolean {
  return (
    row.event_id === event.eventId &&
    row.idempotency_key === event.idempotencyKey &&
    row.event_type === event.eventType &&
    row.occurred_at === event.occurredAt &&
    row.payload_json === event.payloadJson &&
    row.metadata_json === event.metadataJson &&
    row.task_id === event.taskId &&
    row.session_id === event.sessionId &&
    row.artifact_id === event.artifactId
  )
}

function validateCanonicalProjectionRow(row: EventRow): void {
  const metadata = objectValue(JSON.parse(row.metadata_json) as unknown)
  if (
    metadata.schemaVersion !== 2 ||
    !CANONICAL_EVENT_TYPES.has(row.event_type)
  )
    return
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
  return envelopeFromPrepared(event, row.sequence)
}

function envelopeFromPrepared(
  event: PreparedEvent,
  sequence: number,
): MemoryEventEnvelope {
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
    sequence,
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

/**
 * Rebuild one stored playbook row through MemoryPlaybookSchema: every JSON
 * column is parsed and schema-validated, so a corrupt store throws loudly
 * instead of surfacing a silently coerced rule to the gate.
 */
function playbookFromRow(row: PlaybookRow): MemoryPlaybook {
  return MemoryPlaybookSchema.parse({
    schemaVersion: 1,
    playbookId: row.playbook_id,
    workspaceId: row.workspace_id,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    title: row.title,
    instruction: row.instruction,
    trigger: JSON.parse(row.trigger_json) as unknown,
    scope: JSON.parse(row.scope_json) as unknown,
    status: row.status,
    enforcement: row.enforcement,
    counters: JSON.parse(row.counters_json) as unknown,
    provenance: JSON.parse(row.provenance_json) as unknown,
    triggerSignature: row.trigger_signature,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function readProjectionRows(
  database: Database,
  table: string,
): ProjectionRow[] {
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
  if (selector.kind === 'uri-fragment')
    return `${selector.uri.toLowerCase()}#${selector.fragment.toLowerCase()}`
  const base = selector.path.replaceAll('\\', '/').toLowerCase()
  if (selector.kind === 'symbol')
    return `${base}#${selector.symbol.toLowerCase()}`
  if (selector.kind === 'json-pointer')
    return `${base}#${selector.pointer.toLowerCase()}`
  if (selector.kind === 'line-range')
    return `${base}:${selector.startLine}-${selector.endLine}`
  if (selector.kind === 'chunk')
    return `${base}#chunk:${selector.chunkId.toLowerCase()}:${selector.startLine}-${selector.endLine}`
  return base
}

function lexicalTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9._:/-]+/)
      .filter((token) => token.length > 1)
      .slice(0, 128),
  )
}

function reason(
  code: RankingReason['code'],
  contribution: number,
  detail: string,
): RankingReason {
  return { code, contribution, detail }
}

async function buildLexicalResult(
  request: MemoryRetrievalRequest,
  events: MemoryEventEnvelope[],
  eventCapReached: boolean,
  payloadBudgetReached: boolean,
  recallExpander?: BunSQLiteMemoryRepositoryOptions['recallExpander'],
  projection?: KnowledgeQueryRows,
  loadConceptStates?: (ids: string[]) => Promise<KnowledgeObservationState[]>,
) {
  type ObservationState = Omit<KnowledgeObservationState, 'freshness'> & {
    freshness: Map<string, KnowledgeObservationState['freshness'][string]>
  }
  type TaskState = KnowledgeTaskState
  const observations = new Map<string, ObservationState>()
  const tasks = new Map<string, TaskState>()
  const supersededBy = new Map<string, string>()
  for (let index = 0; index < (projection?.observations.length ?? 0); index++) {
    if (index % 32 === 0) await yieldToEventLoop()
    const state = JSON.parse(
      projection!.observations[index]!.state_json,
    ) as KnowledgeObservationState
    // Parse through the canonical schema before any derived projection can be injected.
    const observation = MemoryObservationSchema.parse(state.observation)
    observations.set(observation.observationId, {
      ...state,
      observation,
      freshness: new Map(Object.entries(state.freshness)),
    })
    if (state.supersededBy)
      supersededBy.set(observation.observationId, state.supersededBy)
  }
  for (const row of projection?.tasks ?? []) {
    const task = JSON.parse(row.state_json) as TaskState
    tasks.set(task.taskId, task)
  }
  // The optional semantic index receives the complete eligible durable corpus.
  // Candidate ranking remains bounded; corpus admission is independent of log age.
  const conceptCorpus: ConceptCorpusEntry[] = (projection?.corpus ?? []).map(
    (row) => ({
      observationId: row.observation_id,
      kind: row.kind,
      summary: row.summary,
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.claim_id && /^[0-9a-f]{64}$/.test(row.claim_id)
        ? { claimId: row.claim_id }
        : {}),
    }),
  )
  const projectedAt = projection?.metadata.find(
    (row) => row.key === 'generatedAt',
  )?.value
  const asOfTurnWall =
    projectedAt ?? events.at(-1)?.occurredAt ?? '1970-01-01T00:00:00.000Z'

  const queryTokens = lexicalTokens(
    [request.query, ...request.selectors.map(selectorKey)].join(' '),
  )
  const requestedSelectors = new Set(request.selectors.map(selectorKey))
  const contextMatches = (
    evidence: MemoryObservation['evidence'][number],
    freshness: ObservationState['freshness'] extends Map<string, infer F>
      ? F
      : never,
  ) => {
    if (freshness.state !== 'verified') return false
    if (
      freshness.selector &&
      stableJson(freshness.selector) !== stableJson(evidence.selector)
    )
      return false
    // Strict honesty gate for every path-bearing selector (file, line-range,
    // symbol, json-pointer, chunk): the observed digest must equal the
    // evidence contentDigest (for chunk selectors this is chunk.hash, not the
    // file hash). Digest-less path evidence never counts as verified so
    // verifiedKnowledge cannot carry a path selector without a digest.
    if ('path' in evidence.selector) {
      if (evidence.contentDigest === undefined) return false
      if (freshness.observedDigest !== evidence.contentDigest) return false
    }
    const dependencyDigests = request.dependencyDigests
    const dependencyKey = selectorKey(evidence.selector)
    if (
      dependencyDigests &&
      Object.prototype.hasOwnProperty.call(dependencyDigests, dependencyKey) &&
      dependencyDigests[dependencyKey] !== freshness.observedDigest
    )
      return false
    // Facts follow source dependencies; current operational assertions still
    // require the exact workspace stamp that produced their receipt.
    const operational =
      evidence.provenance.metadata.validityScope === 'workspace' ||
      [
        'git_status',
        'run_terminal_command',
        'run_targeted_validation',
        'run_file_change_hooks',
      ].includes(evidence.provenance.toolName ?? '') ||
      evidence.artifact.classification.labels.some((label) =>
        ['workspace-state', 'clean-worktree', 'validation-result'].includes(
          label,
        ),
      )
    if (
      !operational &&
      dependencyDigests &&
      Object.prototype.hasOwnProperty.call(dependencyDigests, dependencyKey)
    )
      return true
    const requestHasContext =
      request.workspaceRevision !== undefined ||
      request.workspaceSnapshotId !== undefined
    const verificationHasContext =
      freshness.workspaceRevision !== undefined ||
      freshness.workspaceSnapshotId !== undefined
    if (requestHasContext || verificationHasContext) {
      return (
        request.workspaceRevision === freshness.workspaceRevision &&
        request.workspaceSnapshotId === freshness.workspaceSnapshotId
      )
    }
    return true
  }
  // Bounded-lexical-v1 weight table (deterministic core, score capped at 1.0
  // via Math.min(1, ...)): task-match 0.25 + selector-match 0.25 +
  // chunk selector-match 0.05 + lexical-match (query) <= 0.24 (0.06/token) +
  // excerpt-token overlap (lexical-match code) <= 0.06 (0.02/token, max 3
  // tokens, only when an evidence excerpt is present; combined lexical
  // family <= 0.30, preserving the original lexical cap) +
  // verified-evidence 0.12 + digest-freshness (verified-evidence code)
  // <= 0.03 (only when verified evidence has matching contentDigest +
  // exact revision/snapshot; combined verified family <= 0.15, preserving
  // the original verified cap) + reusability (pinned) 0.04 + reusability
  // (usage) <= 0.05 (bounded P4 usefulness correlation, display-only; the
  // score itself stays Math.min(1, ...)) + recency 0.01.
  // New-weight sum 0.06 + 0.03 + 0.05 = 0.14 <= 1; worst-case raw sum stays
  // bounded and the final score is capped at 1.0. Tiebreak stays
  // exact > token > verified > pinned > sequence (see compare below);
  // observation ordering additionally applies retraction, freshness class,
  // tier, and usefulness via compareObservations — the age/tier reordering
  // (agent-explicit decisions outranking discovery at equal lexical weight)
  // is intended S3 behavior, not a regression. Reasons stay within 1..16
  // entries.
  const rank = (
    text: string,
    taskId: string | undefined,
    selectors: MemorySelector[],
    verified: boolean,
    pinned: boolean,
    sourceSequence: number,
    excerptOverlap = 0,
    digestFresh = false,
    usefulness = 0,
  ) => {
    const candidateTokens = lexicalTokens(text)
    let tokenMatches = 0
    for (const token of queryTokens)
      if (candidateTokens.has(token)) tokenMatches++
    const selectorMatch = selectors.some((selector) =>
      requestedSelectors.has(selectorKey(selector)),
    )
    const taskMatch = request.taskId !== undefined && request.taskId === taskId
    const reasons: RankingReason[] = []
    if (taskMatch)
      reasons.push(
        reason(
          'task-match',
          0.25,
          'The task ID exactly matches the requested task.',
        ),
      )
    if (selectorMatch)
      reasons.push(
        reason(
          'selector-match',
          0.25,
          'A selector exactly matches the request.',
        ),
      )
    const chunkSelectorMatch = selectors.some(
      (selector) =>
        selector.kind === 'chunk' &&
        requestedSelectors.has(selectorKey(selector)),
    )
    if (chunkSelectorMatch)
      reasons.push(
        reason(
          'selector-match',
          0.05,
          'Chunk selector exactly matches the request.',
        ),
      )
    if (tokenMatches > 0)
      reasons.push(
        reason(
          'lexical-match',
          Math.min(0.24, tokenMatches * 0.06),
          `${tokenMatches} lexical token match(es).`,
        ),
      )
    if (excerptOverlap > 0)
      reasons.push(
        reason(
          'lexical-match',
          Math.min(0.06, excerptOverlap * 0.02),
          `${excerptOverlap} excerpt token overlap(s).`,
        ),
      )
    if (verified)
      reasons.push(
        reason(
          'verified-evidence',
          0.12,
          'The observation has current verified evidence.',
        ),
      )
    if (verified && digestFresh)
      reasons.push(
        reason(
          'verified-evidence',
          0.03,
          'Digest and workspace revision/snapshot exactly match.',
        ),
      )
    if (pinned)
      reasons.push(reason('reusability', 0.04, 'The observation is pinned.'))
    if (usefulness > 0)
      reasons.push(
        reason(
          'reusability',
          Math.min(0.05, (usefulness / 1000) * 0.05),
          'P4 usage correlation score.',
        ),
      )
    reasons.push(
      reason('recency', 0.01, `Canonical source sequence ${sourceSequence}.`),
    )
    return {
      score: Math.min(
        1,
        reasons.reduce((sum, item) => sum + Math.max(0, item.contribution), 0),
      ),
      reasons,
      exact: Number(taskMatch) + Number(selectorMatch),
      tokenMatches,
      verified: Number(verified),
      pinned: Number(pinned),
      sourceSequence,
    }
  }
  const compare = <T extends { ranking: ReturnType<typeof rank>; id: string }>(
    left: T,
    right: T,
  ) =>
    right.ranking.exact - left.ranking.exact ||
    right.ranking.tokenMatches - left.ranking.tokenMatches ||
    right.ranking.verified - left.ranking.verified ||
    right.ranking.pinned - left.ranking.pinned ||
    right.ranking.sourceSequence - left.ranking.sourceSequence ||
    compareUnicodeCodePoints(left.id, right.id)
  // Observation-specific deterministic ordering: retraction first, then
  // freshness class, agent-explicit tier, P4 usefulness (integer score), and
  // only then the lexical core. The old verified key is dropped as redundant
  // with freshnessClass. Tasks keep `compare` unchanged.
  const tierRank = (t: UsefulnessTier) =>
    t === 'explicit' ? 2 : t === 'outcome' ? 1 : 0
  const compareObservations = <
    T extends {
      ranking: ReturnType<typeof rank>
      id: string
      tier: UsefulnessTier
      usefulness: number
      conceptRank: number
      freshnessClass: number
      retracted: boolean
    },
  >(
    left: T,
    right: T,
  ) =>
    Number(left.retracted) - Number(right.retracted) ||
    right.freshnessClass - left.freshnessClass ||
    tierRank(right.tier) - tierRank(left.tier) ||
    right.usefulness - left.usefulness ||
    right.conceptRank - left.conceptRank ||
    right.ranking.exact - left.ranking.exact ||
    right.ranking.tokenMatches - left.ranking.tokenMatches ||
    right.ranking.pinned - left.ranking.pinned ||
    right.ranking.sourceSequence - left.ranking.sourceSequence ||
    compareUnicodeCodePoints(left.id, right.id)

  const taskCandidates = [...tasks.values()]
    .filter((task) => !request.taskId || task.taskId === request.taskId)
    .map((task) => ({
      id: task.taskId,
      task,
      ranking: rank(
        `${task.taskId} ${task.title} ${task.objective}`,
        task.taskId,
        [],
        false,
        false,
        task.sourceSequence,
      ),
    }))
    .filter((item) => item.ranking.tokenMatches > 0 || item.ranking.exact > 0)
    .sort(compare)
  const observationCandidates = [...observations.values()]
    .map((state) => {
      const selectors =
        state.observation.selectors ??
        state.observation.evidence.map(({ selector }) => selector)
      const verified = state.observation.evidence.some((evidence) => {
        const freshness = state.freshness.get(
          knowledgeFreshnessKey(evidence.selector),
        )
        return freshness !== undefined && contextMatches(evidence, freshness)
      })
      // Digest-freshness: true only when verified evidence carries a matching
      // contentDigest (chunk.hash for chunk selectors, not the file hash) plus
      // exact revision/snapshot equality already enforced by contextMatches.
      const digestFresh = state.observation.evidence.some((evidence) => {
        const freshness = state.freshness.get(
          knowledgeFreshnessKey(evidence.selector),
        )
        return (
          freshness !== undefined &&
          contextMatches(evidence, freshness) &&
          evidence.contentDigest !== undefined &&
          freshness.observedDigest === evidence.contentDigest
        )
      })
      // Excerpt-token overlap: distinct request queryTokens found in the union
      // of present evidence.excerpt tokens; zero when no excerpt is present.
      const excerptTokens = new Set<string>()
      for (const evidence of state.observation.evidence) {
        if (
          typeof evidence.excerpt === 'string' &&
          evidence.excerpt.length > 0
        ) {
          for (const token of lexicalTokens(evidence.excerpt))
            excerptTokens.add(token)
        }
      }
      let excerptOverlap = 0
      if (excerptTokens.size > 0) {
        for (const token of queryTokens)
          if (excerptTokens.has(token)) excerptOverlap++
      }
      // Usefulness-v1 scoring: tier from kind + provenance, integer score
      // from folded usage counters against the deterministic as-of clock.
      const tier = deriveUsefulnessTier({
        kind: state.observation.kind,
        provenance: state.observation.provenance,
      })
      const usefulness = scoreUsefulness({
        used: state.used,
        ignored: state.ignored,
        staled: 0,
        reinforced: state.reinforced,
        pinned: state.pinned ? 1 : 0,
        createdAtWall: state.observation.observedAt,
        asOfTurnWall,
        tier,
      }).score
      const freshnessClass =
        verified && digestFresh
          ? 3
          : verified
            ? 2
            : [...state.freshness.values()].some(
                  (freshness) => freshness.state === 'invalid',
                )
              ? 1
              : 0
      const retracted = state.forgotten || state.superseded || state.corrected
      return {
        id: state.observation.observationId,
        state,
        selectors,
        tier,
        usefulness,
        conceptRank: 0,
        freshnessClass,
        retracted,
        ranking: rank(
          `${state.observation.taskId} ${state.observation.kind} ${state.observation.summary} ${state.observation.detail} ${selectors.map(selectorKey).join(' ')}`,
          state.observation.taskId,
          selectors,
          verified,
          state.pinned,
          state.sourceSequence,
          excerptOverlap,
          digestFresh,
          usefulness,
        ),
      }
    })
    .filter(
      (item) =>
        (!request.taskId || item.state.observation.taskId === request.taskId) &&
        (request.artifactKinds.length === 0 ||
          item.state.observation.evidence.some(({ artifact }) =>
            request.artifactKinds.includes(artifact.classification.kind),
          )) &&
        (item.ranking.tokenMatches > 0 ||
          item.ranking.exact > 0 ||
          item.state.pinned),
    )
    .sort(compareObservations)

  const limit = request.maxResultsPerCategory
  const verifiedCandidates = observationCandidates.filter(
    ({ state }) =>
      !state.forgotten &&
      !state.superseded &&
      !state.corrected &&
      state.observation.evidence.some((evidence) => {
        const freshness = state.freshness.get(
          knowledgeFreshnessKey(evidence.selector),
        )
        return freshness !== undefined && contextMatches(evidence, freshness)
      }),
  )
  const reusableCandidates = observationCandidates.filter(
    ({ state }) =>
      !state.forgotten &&
      !state.superseded &&
      !state.corrected &&
      (state.observation.kind === 'discovery' ||
        state.observation.kind === 'fact' ||
        state.observation.kind === 'decision' ||
        state.observation.kind === 'constraint'),
  )
  const rereadCandidates = observationCandidates
    .filter(
      ({ state }) => !state.forgotten && !state.superseded && !state.corrected,
    )
    .flatMap(({ state, selectors, ranking }) =>
      selectors
        .map((selector) => {
          const freshness = state.freshness.get(knowledgeFreshnessKey(selector))
          const evidence = state.observation.evidence.find(
            (item) => selectorKey(item.selector) === selectorKey(selector),
          )
          if (freshness && evidence && contextMatches(evidence, freshness))
            return null
          const rereadReason =
            request.dependencyDigests &&
            Object.prototype.hasOwnProperty.call(
              request.dependencyDigests,
              selectorKey(selector),
            ) &&
            request.dependencyDigests[selectorKey(selector)] !==
              evidence?.contentDigest
              ? 'changed'
              : freshness?.reason === 'missing'
                ? 'missing'
                : freshness?.reason === 'expired'
                  ? 'expired'
                  : freshness?.state === 'invalid'
                    ? 'changed'
                    : 'never-verified'
          return {
            observationId: state.observation.observationId,
            selector,
            reason: rereadReason as
              | 'never-verified'
              | 'changed'
              | 'missing'
              | 'expired'
              | 'contradiction-suspected',
            detail:
              freshness?.state === 'invalid'
                ? 'The latest evidence state is invalidated; reread before use.'
                : 'This selector requires verification in the current workspace context.',
            score: ranking.score,
            reasons: [
              ...ranking.reasons,
              reason(
                'stale-evidence',
                -0.2,
                'Current evidence is unavailable.',
              ),
            ].slice(0, 16),
          }
        })
        .filter((item): item is NonNullable<typeof item> => item !== null),
    )
  const historicalCandidates = request.includeHistorical
    ? observationCandidates.filter(
        ({ state }) => state.forgotten || state.superseded || state.corrected,
      )
    : []
  // P7 contradiction flagging: group live decision/constraint observations by
  // stable chunk ids carried under the canonical `stableChunkId` key in
  // evidence provenance metadata — the exact key and value shape the capture
  // writer persists (extractStableChunkIds), never a value-shape scan over
  // arbitrary metadata keys. Then append additive reread entries for each
  // flagged member not already scheduled by the staleness pass. Zero-selector
  // observations are skipped, entries reuse the existing reread shape, and the
  // merge happens before the existing reread cap so determinism and bounds are
  // preserved.
  const contradictionCandidates: ContradictionCandidate[] =
    observationCandidates.flatMap(({ state }) => {
      const stableChunkIds = [
        ...new Set(
          state.observation.evidence.flatMap((evidence) =>
            extractStableChunkIds(evidence.provenance.metadata),
          ),
        ),
      ]
      return [
        {
          observationId: state.observation.observationId,
          kind: state.observation.kind,
          stableChunkIds,
          forgotten: state.forgotten,
          superseded: state.superseded,
          corrected: state.corrected,
        },
      ]
    })
  const flaggedContradictionIds = new Set(
    detectContradictions({
      observations: contradictionCandidates,
    }).flatMap(({ observationIds }) => observationIds),
  )
  const existingRereadIds = new Set(
    rereadCandidates.map(({ observationId }) => observationId),
  )
  for (const candidate of observationCandidates) {
    if (!flaggedContradictionIds.has(candidate.id)) continue
    if (existingRereadIds.has(candidate.id)) continue
    const firstSelector = candidate.selectors[0]
    if (firstSelector === undefined) continue
    rereadCandidates.push({
      observationId: candidate.id,
      selector: firstSelector,
      reason: 'contradiction-suspected' as const,
      detail:
        'contradiction_suspected: reconcile — resolve via record_decision(supersedes:[...])',
      score: 0,
      reasons: [
        ...candidate.ranking.reasons,
        reason(
          'stale-evidence',
          -0.2,
          'Contradiction suspected against another live observation.',
        ),
      ].slice(0, 16),
    })
  }
  const matchedTasks = taskCandidates
    .slice(0, limit)
    .map(({ task, ranking }) => ({
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      summary: task.objective,
      score: ranking.score,
      reasons: ranking.reasons,
    }))
  const verifiedKnowledge = verifiedCandidates
    .slice(0, limit)
    .map(({ state, ranking }) => {
      const verifiedSelectors = [...state.freshness].filter(
        ([key, freshness]) => {
          const evidence = state.observation.evidence.find(
            (item) => knowledgeFreshnessKey(item.selector) === key,
          )
          return evidence !== undefined && contextMatches(evidence, freshness)
        },
      )
      const verifiedEvidence = verifiedSelectors
        .map(([key]) =>
          state.observation.evidence.find(
            (evidence) => knowledgeFreshnessKey(evidence.selector) === key,
          ),
        )
        .filter(
          (evidence): evidence is MemoryObservation['evidence'][number] =>
            evidence !== undefined,
        )
      const verifiedAt = verifiedSelectors
        .map(([, freshness]) => freshness.at)
        .sort(compareUnicodeCodePoints)
        .at(-1)!
      return {
        observation: state.observation,
        verifiedEvidence,
        verifiedAt,
        score: ranking.score,
        reasons: ranking.reasons,
      }
    })
    .filter(({ verifiedEvidence }) => verifiedEvidence.length > 0)
  const reusableDiscovery = reusableCandidates
    .slice(0, limit)
    .map(({ state, ranking }) => ({
      observation: state.observation,
      reuseGuidance:
        state.observation.kind === 'discovery'
          ? state.pinned
            ? 'Pinned discovery; verify selectors before reuse.'
            : 'Verify selectors before reusing this discovery.'
          : `${state.pinned ? 'Pinned unverified' : 'Unverified'} ${state.observation.kind}; verify supporting selectors before reuse.`,
      score: ranking.score,
      reasons: ranking.reasons,
    }))
  // P8 wave 2a concept-advisory tail: appended AFTER the lexical
  // reusableDiscovery array is final, so it never reorders or displaces the
  // lexical prefix. The expander is strictly advisory: a null or degraded
  // expansion and any thrown error leave the lexical result untouched, and
  // appended entries are capped at 8 active, non-duplicate observations.
  if (recallExpander) {
    try {
      const expansion = await recallExpander({ request, corpus: conceptCorpus })
      if (expansion && !expansion.degraded) {
        if (loadConceptStates) {
          for (const state of await loadConceptStates(
            expansion.observationIds,
          )) {
            const observation = MemoryObservationSchema.parse(state.observation)
            observations.set(observation.observationId, {
              ...state,
              observation,
              freshness: new Map(Object.entries(state.freshness)),
            })
          }
        }
        let appended = 0
        for (const id of expansion.observationIds) {
          // The result schema caps reusableDiscovery at 100 entries; never
          // push past that bound, or the final parse would fail the query.
          if (appended >= 8 || reusableDiscovery.length >= 100) break
          const state = observations.get(id)
          if (!state || state.forgotten || state.superseded || state.corrected)
            continue
          if (request.taskId && state.observation.taskId !== request.taskId)
            continue
          if (
            request.artifactKinds.length &&
            !state.observation.evidence.some((evidence) =>
              request.artifactKinds.includes(
                evidence.artifact.classification.kind,
              ),
            )
          )
            continue
          if (reusableDiscovery.some((e) => e.observation.observationId === id))
            continue
          reusableDiscovery.push({
            observation: state.observation,
            reuseGuidance: 'Verify selectors before reusing this discovery.',
            score: 0,
            reasons: [
              reason(
                'concept-advisory',
                0,
                'Advisory semantic recall expansion matched this observation.',
              ),
            ],
          })
          appended += 1
        }
      }
    } catch {
      // Advisory only: expansion failures never fail the query.
    }
  }
  const rereadRequired = rereadCandidates.slice(0, limit)
  const historicalContext = historicalCandidates
    .slice(0, limit)
    .map(({ state, ranking }) => {
      // P7 supersession head: for a retracted predecessor, resolve the tail of
      // its supersession chain and include the head observation's source event
      // id when it is known, keeping the own event first and the list within
      // the schema's 1..100 bound.
      const headId = resolveSupersessionHead(
        state.observation.observationId,
        supersededBy,
      )
      const headSourceEventId =
        headId !== state.observation.observationId
          ? observationCandidates.find(({ id }) => id === headId)?.state
              .sourceEventId
          : undefined
      const eventIds = [
        ...new Set(
          headSourceEventId
            ? [state.sourceEventId, headSourceEventId]
            : [state.sourceEventId],
        ),
      ].slice(0, 100)
      return {
        taskId: state.observation.taskId,
        summary: state.observation.summary,
        eventIds,
        score: ranking.score,
        reasons: [
          ...ranking.reasons,
          reason(
            'historical-only',
            -0.1,
            'This observation is historical only.',
          ),
        ].slice(0, 16),
      }
    })
  const latestCoverageByKey = new Map<
    string,
    {
      payload: Extract<
        MemoryEventEnvelope,
        { eventType: 'coverage.recorded' }
      >['payload']
      sequence: number
    }
  >()
  for (const event of events) {
    if (event.eventType !== 'coverage.recorded') continue
    const key = `${event.payload.taskId}:${event.payload.dimension}`
    const prior = latestCoverageByKey.get(key)
    if (!prior || event.sequence > prior.sequence) {
      latestCoverageByKey.set(key, {
        payload: event.payload,
        sequence: event.sequence,
      })
    }
  }
  const currentCoverage = [...latestCoverageByKey.entries()]
    .filter(([, entry]) => {
      if (
        request.taskId !== undefined &&
        entry.payload.taskId !== request.taskId
      )
        return false
      const requestHasContext =
        request.workspaceRevision !== undefined ||
        request.workspaceSnapshotId !== undefined
      const payloadHasContext =
        entry.payload.workspaceRevision !== undefined ||
        entry.payload.workspaceSnapshotId !== undefined
      if (requestHasContext || payloadHasContext) {
        return (
          request.workspaceRevision === entry.payload.workspaceRevision &&
          request.workspaceSnapshotId === entry.payload.workspaceSnapshotId
        )
      }
      return true
    })
    .sort(([leftKey], [rightKey]) =>
      compareUnicodeCodePoints(leftKey, rightKey),
    )
    .slice(0, 5)
    .map(([, entry]) => {
      const item: {
        dimension: typeof entry.payload.dimension
        state: typeof entry.payload.state
        taskId: typeof entry.payload.taskId
        notes?: string
        workspaceRevision?: number
        workspaceSnapshotId?: string
      } = {
        dimension: entry.payload.dimension,
        state: entry.payload.state,
        taskId: entry.payload.taskId,
        notes: entry.payload.notes.slice(0, 1024),
      }
      if (entry.payload.workspaceRevision !== undefined)
        item.workspaceRevision = entry.payload.workspaceRevision
      if (entry.payload.workspaceSnapshotId !== undefined)
        item.workspaceSnapshotId = entry.payload.workspaceSnapshotId
      return item
    })
  const categories = {
    matchedTasks,
    verifiedKnowledge,
    reusableDiscovery,
    rereadRequired,
    historicalContext,
  }
  const rankingReasons = [
    ...matchedTasks.map((value) => ({
      category: 'matchedTasks' as const,
      targetId: value.taskId,
      reasons: value.reasons,
    })),
    ...verifiedKnowledge.map((value) => ({
      category: 'verifiedKnowledge' as const,
      targetId: value.observation.observationId,
      reasons: value.reasons,
    })),
    ...reusableDiscovery.map((value) => ({
      category: 'reusableDiscovery' as const,
      targetId: value.observation.observationId,
      reasons: value.reasons,
    })),
    ...rereadRequired.map((value) => ({
      category: 'rereadRequired' as const,
      targetId: value.observationId,
      reasons: value.reasons,
    })),
    ...historicalContext.map((value) => ({
      category: 'historicalContext' as const,
      targetId: value.taskId ?? value.eventIds[0]!,
      reasons: value.reasons,
    })),
  ]
  const resultCapReached =
    eventCapReached ||
    taskCandidates.length > limit ||
    verifiedCandidates.length > limit ||
    reusableCandidates.length > limit ||
    rereadCandidates.length > limit ||
    historicalCandidates.length > limit
  const degradationReasons = [
    ...(projection?.lexicalFallback
      ? [
          {
            code: 'partial-projection' as const,
            detail:
              'The optional full-text index is unavailable; an indexed-scope lexical fallback was used.',
            retryable: true,
          },
        ]
      : []),
    ...(projection &&
    Number(
      projection.metadata.find((row) => row.key === 'cursor')?.value ?? 0,
    ) <
      Number(
        projection.metadata.find((row) => row.key === 'canonicalTail')?.value ??
          0,
      )
      ? [
          {
            code: 'partial-projection' as const,
            detail:
              'The knowledge projection has not reached the canonical tail.',
            retryable: true,
          },
        ]
      : []),
    ...(resultCapReached
      ? [
          {
            code: 'result-cap-reached' as const,
            detail: 'The indexed candidate or result cap was reached.',
            retryable: false,
          },
        ]
      : []),
    ...(payloadBudgetReached
      ? [
          {
            code: 'resource-budget' as const,
            detail: 'The deterministic query resource budget was reached.',
            retryable: false,
          },
        ]
      : []),
  ]
  return MemoryRetrievalResultSchema.parse({
    schemaVersion: 2,
    queryId: request.queryId,
    projectId: request.projectId,
    generatedAt: asOfTurnWall,
    ...categories,
    currentCoverage,
    degradation:
      degradationReasons.length > 0
        ? { state: 'degraded', reasons: degradationReasons }
        : { state: 'none' },
    rankingReasons: rankingReasons.slice(0, limit * 5),
  })
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!)
  const rightPoints = Array.from(
    right,
    (character) => character.codePointAt(0)!,
  )
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index]! - rightPoints[index]!
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

function readCapabilities(database: Database): MemoryV2Capability[] {
  const rows = database
    .query(
      'SELECT name, available, fallback, value FROM memory_store_capabilities ORDER BY name',
    )
    .all() as Array<{
    name: string
    available: number
    fallback: string | null
    value: string
  }>
  return rows.map((row) => ({ ...row, available: row.available === 1 }))
}

function readPragmaString(
  database: Database,
  sql: string,
  key: string,
): string {
  const row = database.query(sql).get() as Record<string, unknown> | null
  const value = row?.[key] ?? (row ? Object.values(row)[0] : undefined)
  if (typeof value !== 'string')
    throw new Error('Unexpected SQLite pragma response.')
  return value
}

function readPragmaNumber(
  database: Database,
  sql: string,
  key: string,
): number {
  const row = database.query(sql).get() as Record<string, unknown> | null
  const value = row?.[key] ?? (row ? Object.values(row)[0] : undefined)
  if (typeof value !== 'number')
    throw new Error('Unexpected SQLite pragma response.')
  return value
}

function requiredString(value: unknown, name: string, max: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.includes('\0')
  ) {
    throw new Error(`${name} must be a non-empty bounded string.`)
  }
  return value
}

function optionalString(
  value: unknown,
  name: string,
  max: number,
): string | null {
  if (value === undefined || value === null) return null
  return requiredString(value, name, max)
}

function validNonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new MemoryV2StorageError({
      kind: 'invalid',
      message: 'The event cursor must be a non-negative integer.',
      retryable: false,
    })
  return value
}

function validPositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new MemoryV2StorageError({
      kind: 'invalid',
      message: 'The event limit must be a positive integer.',
      retryable: false,
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

function operationFailureOutcome(failure: MemoryV2Failure): {
  outcome: 'failed'
  error: MemoryOperationError
} {
  return failedOutcome(
    failure.kind === 'busy' ||
      failure.kind === 'closed' ||
      failure.kind === 'io' ||
      failure.kind === 'unsupported-open'
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
    authority:
      status === 'unavailable'
        ? {
            kind: 'unavailable',
            writable: false,
            reason: issues[0] ?? 'The memory store is unavailable.',
          }
        : {
            kind: 'authoritative',
            writable: true,
            source: 'Bun SQLite Memory V2',
          },
    backend: {
      backendId: 'bun-sqlite-memory-v2',
      kind: 'local-persistent',
      persistence: 'durable',
      capabilities: [
        'append',
        'query',
        'verify',
        'rebuild',
        'health',
        'export',
      ],
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
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code).toUpperCase()
      : ''
  const message = error instanceof Error ? error.message.toUpperCase() : ''
  const signature = `${code} ${message}`

  if (
    signature.includes('SQLITE_BUSY') ||
    signature.includes('SQLITE_LOCKED') ||
    signature.includes('DATABASE IS LOCKED') ||
    code === '5' ||
    code === '6'
  ) {
    return {
      kind: 'busy',
      message: 'The memory store is busy; retry shortly.',
      retryable: true,
    }
  }
  if (
    signature.includes('SQLITE_CORRUPT') ||
    signature.includes('SQLITE_NOTADB') ||
    signature.includes('NOT A DATABASE') ||
    signature.includes('MALFORMED')
  ) {
    return {
      kind: 'corrupt',
      message: 'The memory store is corrupt or unreadable.',
      retryable: false,
    }
  }
  if (
    signature.includes('SQLITE_SCHEMA') ||
    signature.includes('SQLITE_MISMATCH')
  ) {
    return {
      kind: 'incompatible',
      message: 'The memory store schema is incompatible with this CLI.',
      retryable: false,
    }
  }
  return {
    kind: 'io',
    message: 'The memory store could not complete a local I/O operation.',
    retryable: false,
  }
}

function unavailableHealth(
  failure: MemoryV2Failure,
  schemaVersion: number | null = null,
): MemoryV2Health {
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
