import {
  MemoryAppendOutcomeSchema,
  MemoryAppendRequestSchema,
  MemoryEventDraftSchema,
  MemoryEventIdSchema,
  MemoryExportOutcomeSchema,
  ObservationIdSchema,
  TaskIdSchema,
  type MemoryEventDraft,
  type MemoryEventEnvelope,
  type MemoryEventId,
  type MemorySessionId,
  type ObservationId,
  type ProjectId,
  type TaskId,
} from '@codebuff/common/types/memory-v2'
import {
  taskMemoryDraftV1Schema,
  type TaskMemoryV1,
} from '@codebuff/common/types/task-memory'
import { classifyMemoryArtifactPath } from '@codebuff/common/util/memory-artifact-policy'
import { stableHash } from '@codebuff/common/util/stable-hash'

import { createMemoryEventDraft } from './event-factory'
import type { MemoryRepositoryV2 } from './types'

const MAX_OBSERVATIONS = 100
const APPEND_PAGE_SIZE = 100
const MAX_TEXT = 1_024
const MAX_AGGREGATE_DETAIL = 16_384

const MIGRATION_CATEGORIES = [
  'requirements',
  'decisions',
  'files-inspected',
  'edits-made',
  'validation-results',
  'review-receipts',
  'blockers',
  'next-actions',
  'historical-summary',
  'path-evidence',
] as const

type V1MigrationCategory = (typeof MIGRATION_CATEGORIES)[number]
export type V1MigrationSourceItemCounts = Record<V1MigrationCategory, number>

function newSourceItemCounts(): V1MigrationSourceItemCounts {
  return Object.fromEntries(
    MIGRATION_CATEGORIES.map((category) => [category, 0]),
  ) as V1MigrationSourceItemCounts
}

function markerSourceItemCounts(
  counts: Partial<Record<V1MigrationCategory, number>> | undefined,
): V1MigrationSourceItemCounts | undefined {
  if (!counts) return undefined
  const normalized = newSourceItemCounts()
  for (const category of MIGRATION_CATEGORIES) {
    normalized[category] = counts[category] ?? 0
  }
  return normalized
}

/**
 * @deprecated Memory V1 compatibility surface; use Memory V2. Removal will occur only after the documented compatibility window and migration audit.
 */
export type V1MigrationWarningCode =
  | 'goal-excluded'
  | 'observation-cap-reached'
  | 'legacy-evidence-unverified'
  | 'stale-evidence-omitted'
  | 'unsafe-path-omitted'
  | 'empty-field-omitted'
  | 'text-truncated'

/**
 * @deprecated Memory V1 compatibility surface; use Memory V2. Removal will occur only after the documented compatibility window and migration audit.
 */
export type V1MigrationOutcome =
  | { outcome: 'no-record' }
  | {
      outcome: 'imported' | 'no-op'
      revision: number
      checksum: string
      identity: string
      importedTaskId: TaskId
      importedObservationIds: ObservationId[]
      omittedFields: number
      warnings: V1MigrationWarningCode[]
      lastEventId?: MemoryEventId
      sourceItemCounts?: V1MigrationSourceItemCounts
      truncatedFields?: number
    }
  | {
      outcome: 'rejected' | 'failed'
      reason:
        | 'checksum-mismatch'
        | 'invalid-record'
        | 'repository-rejected'
        | 'repository-failed'
      revision?: number
      checksum?: string
    }

const bounded = (value: string, limit = MAX_TEXT): string =>
  value.trim().slice(0, limit)

const boundedText = (
  value: string,
  limit = MAX_TEXT,
): { value: string; truncated: boolean } => {
  const trimmed = value.trim()
  return { value: trimmed.slice(0, limit), truncated: trimmed.length > limit }
}

/**
 * stableHash is FNV-1a 32-bit -> a fixed 8-hex-char token. The sanitizing
 * regex strips nothing from that output, so the slice(0, 96) cap is a no-op
 * safeguard. Collision tolerance is governed by the 32-bit hash space
 * (birthday-bound collisions become non-negligible around ~2^16 distinct
 * tokens), not by the 96-char cap, which never further shortens the token.
 */
const hashToken = (value: string): string =>
  stableHash(value)
    .replace(/[^A-Za-z0-9._:-]/g, '')
    .slice(0, 96)

/**
 * @deprecated Memory V1 compatibility surface; use Memory V2. Removal will occur only after the documented compatibility window and migration audit.
 */
export function getV1MigrationIdentity(params: {
  projectId: ProjectId
  revision: number
  checksum: string
}): string {
  return `v1:${params.revision}:${hashToken(`${params.projectId}:${params.revision}`)}`
}

function getV1MigrationBodyIdentity(params: {
  projectId: ProjectId
  revision: number
  checksum: string
}): string {
  return `v1-body:${params.revision}:${hashToken(
    `${params.projectId}:${params.revision}:${params.checksum}`,
  )}`
}

function reservationEventId(identity: string): MemoryEventId {
  return MemoryEventIdSchema.parse(
    `event:migration:reservation:${hashToken(identity)}`,
  )
}

function eventId(identity: string, index: number) {
  return MemoryEventIdSchema.parse(
    `event:migration:${hashToken(`${identity}:${index}`)}`,
  )
}

type MigrationMarkerMetadata = {
  eventId: MemoryEventId
  importedTaskId: TaskId
  importedObservationIds: ObservationId[]
  omittedFields: number
  warnings: V1MigrationWarningCode[]
  sourceItemCounts?: V1MigrationSourceItemCounts
  truncatedFields?: number
}

type ImportedMarkerEvent = Extract<
  MemoryEventEnvelope,
  { eventType: 'migration.v1.imported' }
>

type MigrationMarkerLookup =
  | {
      state: 'none'
      lastEventId?: MemoryEventId
      prior?: MigrationMarkerMetadata
      reserved: boolean
      events: MemoryEventEnvelope[]
    }
  | {
      state: 'conflict'
      lastEventId?: MemoryEventId
      prior?: MigrationMarkerMetadata
      reserved: boolean
      events: MemoryEventEnvelope[]
    }
  | {
      state: 'exact'
      lastEventId: MemoryEventId
      marker: MigrationMarkerMetadata
      prior?: MigrationMarkerMetadata
      reserved: boolean
      events: MemoryEventEnvelope[]
    }

function isV1MigrationWarningCode(
  value: string,
): value is V1MigrationWarningCode {
  switch (value) {
    case 'goal-excluded':
    case 'observation-cap-reached':
    case 'legacy-evidence-unverified':
    case 'stale-evidence-omitted':
    case 'unsafe-path-omitted':
    case 'empty-field-omitted':
    case 'text-truncated':
      return true
    default:
      return false
  }
}

function markerMetadata(event: ImportedMarkerEvent): MigrationMarkerMetadata {
  return {
    eventId: event.eventId,
    importedTaskId: event.payload.importedTaskId,
    importedObservationIds: [...event.payload.importedObservationIds],
    omittedFields: event.payload.omittedFields ?? 0,
    warnings: event.payload.warnings.filter(isV1MigrationWarningCode),
    ...(event.payload.sourceItemCounts
      ? {
          sourceItemCounts: markerSourceItemCounts(
            event.payload.sourceItemCounts,
          ),
        }
      : {}),
    ...(event.payload.truncatedFields === undefined
      ? {}
      : { truncatedFields: event.payload.truncatedFields }),
  }
}

function isV1MigrationCategory(value: unknown): value is V1MigrationCategory {
  return (
    typeof value === 'string' &&
    (MIGRATION_CATEGORIES as readonly string[]).includes(value)
  )
}

type ImportedObservationEvent = Extract<
  MemoryEventEnvelope,
  { eventType: 'observation.recorded' }
>

type CanonicalMarkerSourceItemCounts = NonNullable<
  ImportedMarkerEvent['payload']['sourceItemCounts']
>

/**
 * The marker payload must carry the V1 source fields every remaining
 * ownership check depends on.
 */
function hasCanonicalMarkerSourceFields(
  payload: ImportedMarkerEvent['payload'],
): payload is ImportedMarkerEvent['payload'] & {
  sourceRevision: number
  sourceChecksum: string
  sourceItemCounts: CanonicalMarkerSourceItemCounts
} {
  return (
    payload.sourceRevision !== undefined &&
    payload.sourceChecksum !== undefined &&
    payload.sourceItemCounts !== undefined
  )
}

/**
 * The marker payload must reproduce the deterministic identities, payload
 * schema versions, and observation id sequence emitted by this migration.
 */
function hasCanonicalMarkerPayloadShape(params: {
  marker: ImportedMarkerEvent
  projectId: ProjectId
  identity: string
  expectedTaskId: TaskId
  expectedObservationIds: ObservationId[]
}): boolean {
  const {
    marker,
    projectId,
    identity,
    expectedTaskId,
    expectedObservationIds,
  } = params
  return !(
    marker.payload.legacyRecordKey !== identity ||
    marker.projectId !== projectId ||
    marker.eventId !== eventId(identity, MAX_OBSERVATIONS + 1) ||
    marker.payload.payloadSchemaVersion !== 1 ||
    marker.payload.sourceSchemaVersion !== 1 ||
    marker.payload.importedTaskId !== expectedTaskId ||
    expectedObservationIds.some(
      (observationId, index) =>
        observationId !== marker.payload.importedObservationIds[index],
    )
  )
}

/**
 * Exactly one canonical reservation event must exist, matching the marker
 * envelope and the V1 source fields.
 */
function hasValidMigrationReservation(params: {
  marker: ImportedMarkerEvent
  events: MemoryEventEnvelope[]
  projectId: ProjectId
  identity: string
  sourceRevision: number
  sourceChecksum: string
}): boolean {
  const {
    marker,
    events,
    projectId,
    identity,
    sourceRevision,
    sourceChecksum,
  } = params
  const reservations = events.filter(
    (event) => event.eventId === reservationEventId(identity),
  )
  if (reservations.length !== 1) return false
  const reservation = reservations[0]!
  return !(
    reservation.eventType !== 'migration.v1.reserved' ||
    reservation.projectId !== projectId ||
    reservation.sessionId !== marker.sessionId ||
    reservation.occurredAt !== marker.occurredAt ||
    reservation.payload.payloadSchemaVersion !== 1 ||
    reservation.payload.migrationId !== identity ||
    reservation.payload.sourceRevision !== sourceRevision ||
    reservation.payload.sourceChecksum !== sourceChecksum
  )
}

/**
 * Exactly one canonical task.created event must exist for the imported task,
 * matching the marker envelope and the deterministic import text.
 */
function hasValidImportedTaskEvent(params: {
  marker: ImportedMarkerEvent
  events: MemoryEventEnvelope[]
  projectId: ProjectId
  bodyIdentity: string
  expectedTaskId: TaskId
  sourceRevision: number
}): boolean {
  const {
    marker,
    events,
    projectId,
    bodyIdentity,
    expectedTaskId,
    sourceRevision,
  } = params
  const expectedTaskEventId = eventId(bodyIdentity, 0)
  const taskEvents = events.filter(
    (event) => event.eventId === expectedTaskEventId,
  )
  if (taskEvents.length !== 1) return false
  const task = taskEvents[0]!
  return !(
    task.eventType !== 'task.created' ||
    task.projectId !== projectId ||
    task.sessionId !== marker.sessionId ||
    task.occurredAt !== marker.occurredAt ||
    task.payload.payloadSchemaVersion !== 1 ||
    task.payload.taskId !== expectedTaskId ||
    task.payload.title !==
      `Imported legacy task memory revision ${sourceRevision}` ||
    task.payload.objective !==
      'Preserve bounded legacy operational memory without importing its goal.' ||
    task.payload.initialStatus !== 'created'
  )
}

function v1CategoryObservationKind(
  category: V1MigrationCategory,
): 'discovery' | 'warning' {
  // V1 migration deterministic body preserves audit exactness across upgrade
  // and rollback: blockers have always been warning; every other category is
  // discovery. Changing blockers to discovery breaks audit exactness for
  // pre-existing imports on upgrade and new imports on rollback, so the
  // canonical body keeps warning. Reclassification, if needed, must stay
  // additive and never rewrite this deterministic body.
  if (category === 'blockers') return 'warning'
  return 'discovery'
}

/**
 * Compatibility window for mixed-version V1 imports.
 *
 * A previous revision emitted blockers as discovery. During the window the
 * audit and ownership validators accept both the canonical warning and the
 * legacy discovery kind for blockers so pre-existing imports certify exact
 * on upgrade and new canonical imports certify exact on rollback. No other
 * category has a window: decisions and all remaining categories remain
 * strict discovery.
 */
function isCompatibleV1CategoryKind(
  category: V1MigrationCategory,
  kind: string,
): boolean {
  if (category === 'blockers')
    return kind === 'warning' || kind === 'discovery'
  return kind === v1CategoryObservationKind(category)
}

/**
 * Order-insensitive draft equality with the blockers-kind compatibility
 * window applied: an expected warning blockers observation also matches a
 * persisted discovery blockers observation (and vice versa) when every other
 * field is identical. All other categories require exact equality.
 */
function equalImportedObservationDraftWithKindWindow(
  expected: MemoryEventDraft,
  actual: MemoryEventEnvelope,
): boolean {
  if (equalEventDraft(expected, actual)) return true
  try {
    const expectedParsed = MemoryEventDraftSchema.parse(expected)
    const actualDraft = normalizedEventDraft(actual)
    if (
      expectedParsed.eventType !== 'observation.recorded' ||
      actualDraft.eventType !== 'observation.recorded'
    )
      return false
    const expectedCategory =
      expectedParsed.payload.observation.provenance?.metadata.category
    const actualCategory = actualDraft.payload.observation.provenance?.metadata
      .category
    if (expectedCategory !== 'blockers' || actualCategory !== 'blockers')
      return false
    const allowed = new Set(['warning', 'discovery'])
    if (
      !allowed.has(expectedParsed.payload.observation.kind) ||
      !allowed.has(actualDraft.payload.observation.kind)
    )
      return false
    const normalizedExpected = MemoryEventDraftSchema.parse({
      ...expectedParsed,
      payload: {
        ...expectedParsed.payload,
        observation: {
          ...expectedParsed.payload.observation,
          kind: actualDraft.payload.observation.kind,
        },
      },
    })
    return equalEventDraft(normalizedExpected, actual)
  } catch {
    return false
  }
}

/**
 * A single imported observation event must match the deterministic body shape
 * for its category, within the source item counts and canonical ordering.
 */
function hasValidImportedObservationEvent(params: {
  marker: ImportedMarkerEvent
  event: ImportedObservationEvent
  projectId: ProjectId
  expectedTaskId: TaskId
  observationId: ObservationId
  category: V1MigrationCategory
  categoryIndex: number
  occurrences: number
  previousCategoryIndex: number
  sourceRevision: number
  sourceChecksum: string
  sourceItemCounts: CanonicalMarkerSourceItemCounts
}): boolean {
  const {
    marker,
    event,
    projectId,
    expectedTaskId,
    observationId,
    category,
    categoryIndex,
    occurrences,
    previousCategoryIndex,
    sourceRevision,
    sourceChecksum,
    sourceItemCounts,
  } = params
  const observation = event.payload.observation
  const expectedSummary =
    category === 'path-evidence'
      ? 'Legacy path evidence requires reread'
      : category === 'historical-summary'
        ? 'Legacy historical summary'
        : `Legacy ${category} items (${sourceItemCounts[category] ?? 0})`
  if (
    categoryIndex < previousCategoryIndex ||
    (occurrences > 1 && category !== 'path-evidence') ||
    (sourceItemCounts[category] ?? 0) < occurrences ||
    event.projectId !== projectId ||
    event.sessionId !== marker.sessionId ||
    event.occurredAt !== marker.occurredAt ||
    event.payload.payloadSchemaVersion !== 1 ||
    observation.observationId !== observationId ||
    observation.taskId !== expectedTaskId ||
    !isCompatibleV1CategoryKind(category, observation.kind) ||
    observation.summary !== expectedSummary ||
    observation.detail.length > MAX_AGGREGATE_DETAIL ||
    observation.confidence !== 0.25 ||
    observation.evidence.length !== 0 ||
    observation.observedAt !== marker.occurredAt ||
    observation.provenance?.origin !== 'migration' ||
    observation.provenance.recordedBy !== 'sdk-memory-v1-import' ||
    observation.provenance.sourceEventIds.length !== 0 ||
    observation.provenance.sourceSessionId !== marker.sessionId ||
    observation.provenance.metadata.revision !== sourceRevision ||
    observation.provenance.metadata.checksum !== sourceChecksum ||
    JSON.stringify(observation.tags) !==
      JSON.stringify(['legacy-v1', category, 'unverified'])
  )
    return false
  const selectors = observation.selectors ?? []
  if (category === 'path-evidence') {
    if (selectors.length !== 1 || selectors[0]?.kind !== 'file') return false
    const decision = classifyMemoryArtifactPath(selectors[0].path)
    if (!decision.allowed || !decision.normalizedPath) return false
  } else if (selectors.length !== 0) {
    return false
  }
  return true
}

/**
 * Every expected observation event must exist exactly once, in canonical
 * category order and within the per-category source item counts.
 */
function hasValidImportedObservationEvents(params: {
  marker: ImportedMarkerEvent
  events: MemoryEventEnvelope[]
  projectId: ProjectId
  bodyIdentity: string
  expectedTaskId: TaskId
  expectedObservationIds: ObservationId[]
  sourceRevision: number
  sourceChecksum: string
  sourceItemCounts: CanonicalMarkerSourceItemCounts
}): boolean {
  const {
    marker,
    events,
    projectId,
    bodyIdentity,
    expectedTaskId,
    expectedObservationIds,
    sourceRevision,
    sourceChecksum,
    sourceItemCounts,
  } = params
  let previousCategoryIndex = -1
  const categoryOccurrences = new Map<V1MigrationCategory, number>()
  for (const [index, observationId] of expectedObservationIds.entries()) {
    const expectedEventId = eventId(bodyIdentity, index + 1)
    const matching = events.filter((event) => event.eventId === expectedEventId)
    if (matching.length !== 1) return false
    const event = matching[0]!
    if (event.eventType !== 'observation.recorded') return false
    const observation = event.payload.observation
    const category = observation.provenance?.metadata.category
    if (!isV1MigrationCategory(category)) return false
    const categoryIndex = MIGRATION_CATEGORIES.indexOf(category)
    const occurrences = (categoryOccurrences.get(category) ?? 0) + 1
    categoryOccurrences.set(category, occurrences)
    if (
      !hasValidImportedObservationEvent({
        marker,
        event,
        projectId,
        expectedTaskId,
        observationId,
        category,
        categoryIndex,
        occurrences,
        previousCategoryIndex,
        sourceRevision,
        sourceChecksum,
        sourceItemCounts,
      })
    )
      return false
    previousCategoryIndex = categoryIndex
  }
  return true
}

/**
 * Return cleanup authority only for a canonical marker whose reservation and
 * complete referenced body have the deterministic shape emitted by this
 * migration. Repair markers and migration-looking provenance deliberately do
 * not authorize destructive retirement: without the old V1 source they cannot
 * be distinguished from user-authored events strongly enough to delete data.
 */
function validatedMigrationOwnedMarkerMetadata(params: {
  marker: ImportedMarkerEvent
  events: MemoryEventEnvelope[]
  projectId: ProjectId
}): MigrationMarkerMetadata | undefined {
  const { marker, events, projectId } = params
  if (!hasCanonicalMarkerSourceFields(marker.payload)) return undefined
  const { sourceRevision, sourceChecksum, sourceItemCounts } = marker.payload

  const identity = getV1MigrationIdentity({
    projectId,
    revision: sourceRevision,
    checksum: sourceChecksum,
  })
  const bodyIdentity = getV1MigrationBodyIdentity({
    projectId,
    revision: sourceRevision,
    checksum: sourceChecksum,
  })
  const expectedTaskId = TaskIdFor(bodyIdentity)
  const expectedObservationIds = marker.payload.importedObservationIds.map(
    (_, index) => ObservationIdFor(bodyIdentity, index),
  )
  if (
    !hasCanonicalMarkerPayloadShape({
      marker,
      projectId,
      identity,
      expectedTaskId,
      expectedObservationIds,
    })
  )
    return undefined
  if (
    !hasValidMigrationReservation({
      marker,
      events,
      projectId,
      identity,
      sourceRevision,
      sourceChecksum,
    })
  )
    return undefined
  if (
    !hasValidImportedTaskEvent({
      marker,
      events,
      projectId,
      bodyIdentity,
      expectedTaskId,
      sourceRevision,
    })
  )
    return undefined
  if (
    !hasValidImportedObservationEvents({
      marker,
      events,
      projectId,
      bodyIdentity,
      expectedTaskId,
      expectedObservationIds,
      sourceRevision,
      sourceChecksum,
      sourceItemCounts,
    })
  )
    return undefined

  return markerMetadata(marker)
}

async function findMigrationMarker(
  repository: MemoryRepositoryV2,
  projectId: ProjectId,
  revision: number,
  checksum: string,
): Promise<MigrationMarkerLookup> {
  let afterEventId: MemoryEventId | undefined
  let lastEventId: MemoryEventId | undefined
  let exact: MigrationMarkerMetadata | undefined
  let conflict = false
  let reserved = false
  const events: MemoryEventEnvelope[] = []
  const priorCandidates: ImportedMarkerEvent[] = []
  // Loop-invariant: projectId, revision, and checksum are function params, so
  // compute the migration identity once instead of per reservation event.
  const identity = getV1MigrationIdentity({ projectId, revision, checksum })

  // Cursor-resumable scan: termination is `nextAfterEventId` exhaustion,
  // not a page-count ceiling.
  while (true) {
    const outcome = await repository.export({
      schemaVersion: 2,
      projectId,
      ...(afterEventId ? { afterEventId } : {}),
      limit: 1_000,
    })
    if (outcome.outcome !== 'page')
      throw new Error('Migration marker lookup failed')

    for (const event of outcome.events) {
      events.push(event)
      if (event.eventType === 'migration.v1.reserved') {
        if (event.payload.sourceRevision === revision) {
          if (
            event.payload.migrationId === identity &&
            event.payload.sourceChecksum === checksum
          )
            reserved = true
          else conflict = true
        }
        continue
      }
      if (event.eventType !== 'migration.v1.imported') continue

      const sourceRevision = event.payload.sourceRevision
      if (sourceRevision === revision) {
        if (event.payload.sourceChecksum === checksum)
          exact = markerMetadata(event)
        else conflict = true
      } else if (sourceRevision !== undefined && sourceRevision < revision) {
        priorCandidates.push(event)
      }
    }

    lastEventId = outcome.rawTailEventId ?? lastEventId
    if (!outcome.nextAfterEventId) {
      const prior = [...priorCandidates]
        .reverse()
        .map((marker) =>
          validatedMigrationOwnedMarkerMetadata({ marker, events, projectId }),
        )
        .find((metadata) => metadata !== undefined)
      if (conflict)
        return { state: 'conflict', lastEventId, prior, reserved, events }
      if (exact && lastEventId)
        return {
          state: 'exact',
          lastEventId,
          marker: exact,
          prior,
          reserved,
          events,
        }
      return { state: 'none', lastEventId, prior, reserved, events }
    }
    afterEventId = outcome.nextAfterEventId
  }
}

function outcomeFromMarker(params: {
  marker: MigrationMarkerMetadata
  revision: number
  checksum: string
  identity: string
  lastEventId: MemoryEventId
}): V1MigrationOutcome {
  const { marker, revision, checksum, identity, lastEventId } = params
  return {
    outcome: 'no-op',
    revision,
    checksum,
    identity,
    importedTaskId: marker.importedTaskId,
    importedObservationIds: marker.importedObservationIds,
    omittedFields: marker.omittedFields,
    warnings: marker.warnings,
    lastEventId,
    ...(marker.sourceItemCounts
      ? { sourceItemCounts: marker.sourceItemCounts }
      : {}),
    ...(marker.truncatedFields === undefined
      ? {}
      : { truncatedFields: marker.truncatedFields }),
  }
}

type V1MigrationBuild = {
  identity: string
  representationIdentity: string
  bodyIdentity: string
  occurredAt: string
  importedTaskId: TaskId
  importedObservationIds: ObservationId[]
  omittedFields: number
  warnings: V1MigrationWarningCode[]
  sourceItemCounts: V1MigrationSourceItemCounts
  truncatedFields: number
  bodyDrafts: MemoryEventDraft[]
  markerDraft: MemoryEventDraft
}

function normalizedEventDraft(event: MemoryEventEnvelope): MemoryEventDraft {
  const { sequence: _sequence, ...draft } = event
  return MemoryEventDraftSchema.parse(draft)
}

/**
 * Canonicalize a value for order-insensitive comparison: plain-object keys are
 * emitted in sorted order (matching the recursive key-sort the Bun SQLite
 * repository applies via stableJson before persisting), arrays keep their
 * order, and primitives pass through. Without this, a record-valued payload
 * field (e.g. sourceItemCounts) survives a stableJson round-trip with
 * alphabetically sorted keys while the in-memory draft keeps insertion order,
 * so a naive JSON.stringify comparison would always report a mismatch on the
 * real provider even though both sides carry identical content.
 */
function canonicalizeForCompare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForCompare)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalizeForCompare(record[key])
    }
    return sorted
  }
  return value
}

function equalEventDraft(
  expected: MemoryEventDraft,
  actual: MemoryEventEnvelope,
): boolean {
  return (
    JSON.stringify(
      canonicalizeForCompare(MemoryEventDraftSchema.parse(expected)),
    ) === JSON.stringify(canonicalizeForCompare(normalizedEventDraft(actual)))
  )
}

function validatedCompleteBuildMarker(
  lookup: Extract<MigrationMarkerLookup, { state: 'exact' }>,
  build: V1MigrationBuild,
): MigrationMarkerMetadata | undefined {
  const markerEvents = lookup.events.filter(
    (event): event is ImportedMarkerEvent =>
      event.eventId === build.markerDraft.eventId &&
      event.eventType === 'migration.v1.imported',
  )
  if (
    markerEvents.length !== 1 ||
    !equalEventDraft(build.markerDraft, markerEvents[0]!)
  )
    return undefined

  const completeBody = build.bodyDrafts.every((draft) => {
    const matching = lookup.events.filter(
      (event) => event.eventId === draft.eventId,
    )
    return (
      matching.length === 1 &&
      equalImportedObservationDraftWithKindWindow(draft, matching[0]!)
    )
  })
  return completeBody ? markerMetadata(markerEvents[0]!) : undefined
}

/** Pure source-to-events transform shared by import and audit. */
function buildTaskMemoryV1Migration(params: {
  memory: TaskMemoryV1
  projectId: ProjectId
  sessionId: MemorySessionId
  representationIdentity?: string
}): V1MigrationBuild {
  const { memory, projectId, sessionId } = params
  const { revision, updatedAt, checksum } = memory
  const identity = getV1MigrationIdentity({ projectId, revision, checksum })
  const representationIdentity = params.representationIdentity ?? identity
  const canonicalBodyIdentity = getV1MigrationBodyIdentity({
    projectId,
    revision,
    checksum,
  })
  const bodyIdentity =
    representationIdentity === identity
      ? canonicalBodyIdentity
      : `${canonicalBodyIdentity}:${hashToken(representationIdentity)}`
  const occurredAt = new Date(updatedAt).toISOString()
  const importedTaskId = TaskIdFor(bodyIdentity)
  const warnings = new Set<V1MigrationWarningCode>()
  let omittedFields = 0
  let truncatedFields = 0
  if (bounded(memory.goal)) warnings.add('goal-excluded')

  const sourceItemCounts = newSourceItemCounts()
  const recordTruncation = () => {
    truncatedFields++
    omittedFields++
    warnings.add('text-truncated')
  }
  const observations: Array<{
    category: V1MigrationCategory
    summary: string
    detail: string
    selector?: { kind: 'file'; path: string }
  }> = []
  const addObservation = (
    observation: (typeof observations)[number],
  ): boolean => {
    if (observations.length >= MAX_OBSERVATIONS) {
      omittedFields++
      warnings.add('observation-cap-reached')
      return false
    }
    observations.push(observation)
    return true
  }
  const categories = [
    ['requirements', memory.requirements],
    ['decisions', memory.decisions],
    ['files-inspected', memory.filesInspected],
    ['edits-made', memory.editsMade],
    ['validation-results', memory.validationResults],
    ['review-receipts', memory.reviewReceipts],
    ['blockers', memory.blockers],
    ['next-actions', memory.nextActions],
  ] as const
  for (const [category, values] of categories) {
    const nonEmpty: string[] = []
    for (const value of values) {
      const item = boundedText(String(value))
      if (item.truncated) recordTruncation()
      if (item.value) nonEmpty.push(item.value)
    }
    if (nonEmpty.length === 0) continue
    const aggregate = boundedText(nonEmpty.join('\n'), MAX_AGGREGATE_DETAIL)
    if (aggregate.truncated) recordTruncation()
    sourceItemCounts[category] += nonEmpty.length
    addObservation({
      category,
      summary: `Legacy ${category} items (${nonEmpty.length})`,
      detail: aggregate.value,
    })
  }

  const historical = boundedText(memory.historicalSummary)
  if (historical.truncated) recordTruncation()
  if (historical.value) {
    sourceItemCounts['historical-summary']++
    addObservation({
      category: 'historical-summary',
      summary: 'Legacy historical summary',
      detail: historical.value,
    })
  }

  for (const evidence of memory.evidence) {
    warnings.add('legacy-evidence-unverified')
    if (evidence.stale === true) {
      omittedFields++
      warnings.add('stale-evidence-omitted')
      continue
    }
    if (typeof evidence.path !== 'string') {
      omittedFields++
      warnings.add('unsafe-path-omitted')
      continue
    }
    const decision = classifyMemoryArtifactPath(evidence.path)
    if (!decision.allowed || !decision.normalizedPath) {
      omittedFields++
      warnings.add('unsafe-path-omitted')
      continue
    }
    const summary = boundedText(
      evidence.summary || 'Legacy path discovery requires live verification.',
    )
    if (summary.truncated) recordTruncation()
    sourceItemCounts['path-evidence']++
    addObservation({
      category: 'path-evidence',
      summary: 'Legacy path evidence requires reread',
      detail: summary.value,
      selector: { kind: 'file', path: decision.normalizedPath },
    })
  }

  const bodyDrafts: MemoryEventDraft[] = [
    withMigrationEventId(
      createMemoryEventDraft({
        projectId,
        sessionId,
        userInputId: bodyIdentity,
        occurredAt,
        eventType: 'task.created',
        payload: {
          payloadSchemaVersion: 1,
          taskId: importedTaskId,
          title: `Imported legacy task memory revision ${revision}`,
          objective:
            'Preserve bounded legacy operational memory without importing its goal.',
          initialStatus: 'created',
        },
      }),
      bodyIdentity,
      0,
    ),
  ]
  const importedObservationIds: ObservationId[] = []
  observations.forEach((item, index) => {
    const observationId = ObservationIdFor(bodyIdentity, index)
    importedObservationIds.push(observationId)
    bodyDrafts.push(
      withMigrationEventId(
        createMemoryEventDraft({
          projectId,
          sessionId,
          userInputId: bodyIdentity,
          sourceIndex: index + 1,
          occurredAt,
          eventType: 'observation.recorded',
          payload: {
            payloadSchemaVersion: 1,
            observation: {
              observationId,
              taskId: importedTaskId,
              kind: v1CategoryObservationKind(item.category),
              summary: item.summary,
              detail: item.detail,
              confidence: 0.25,
              evidence: [],
              ...(item.selector ? { selectors: [item.selector] } : {}),
              provenance: {
                origin: 'migration',
                recordedBy: 'sdk-memory-v1-import',
                sourceEventIds: [],
                sourceSessionId: sessionId,
                metadata: { category: item.category, revision, checksum },
              },
              tags: ['legacy-v1', item.category, 'unverified'],
              observedAt: occurredAt,
            },
          },
        }),
        bodyIdentity,
        index + 1,
      ),
    )
  })

  const warningList = [...warnings].slice(0, 100)
  const markerDraft = withMigrationEventId(
    createMemoryEventDraft({
      projectId,
      sessionId,
      userInputId: representationIdentity,
      sourceIndex: MAX_OBSERVATIONS + 1,
      occurredAt,
      eventType: 'migration.v1.imported',
      payload: {
        payloadSchemaVersion: 1,
        sourceSchemaVersion: 1,
        legacyRecordKey: representationIdentity,
        importedTaskId,
        importedObservationIds,
        sourceRevision: revision,
        sourceChecksum: checksum,
        omittedFields,
        sourceItemCounts,
        truncatedFields,
        warnings: warningList,
      },
    }),
    representationIdentity,
    MAX_OBSERVATIONS + 1,
  )
  return {
    identity,
    representationIdentity,
    bodyIdentity,
    occurredAt,
    importedTaskId,
    importedObservationIds,
    omittedFields,
    warnings: warningList,
    sourceItemCounts,
    truncatedFields,
    bodyDrafts,
    markerDraft,
  }
}

export type V1MigrationAuditReader = Pick<MemoryRepositoryV2, 'export'>

export type V1MigrationAuditOutcome =
  | { outcome: 'no-record' }
  | {
      outcome: 'not-migrated'
      revision: number
      checksum: string
      repositoryLastEventId?: MemoryEventId
    }
  | {
      outcome: 'exact'
      revision: number
      checksum: string
      identity: string
      markerEventId: MemoryEventId
      repositoryLastEventId: MemoryEventId
      importedTaskId: TaskId
      importedObservationIds: ObservationId[]
      omittedFields: number
      warnings: V1MigrationWarningCode[]
      sourceItemCounts?: V1MigrationSourceItemCounts
      truncatedFields?: number
    }
  | {
      outcome: 'incomplete' | 'mismatch'
      reason:
        | 'reservation-only'
        | 'legacy-marker-unverifiable'
        | 'missing-imported-task'
        | 'missing-imported-observations'
        | 'imported-body-mismatch'
        | 'revision-conflict'
        | 'checksum-conflict'
      revision: number
      checksum: string
      repositoryLastEventId?: MemoryEventId
      markerEventId?: MemoryEventId
      missingEventIds?: MemoryEventId[]
    }
  | {
      outcome: 'rejected' | 'failed'
      reason:
        | 'checksum-mismatch'
        | 'invalid-record'
        | 'repository-rejected'
        | 'repository-failed'
        | 'invalid-export'
        | 'wrong-project'
        | 'pagination-invalid'
        | 'page-limit-exceeded'
      revision?: number
      checksum?: string
    }

type V1MigrationAuditScan =
  | {
      outcome: 'complete'
      events: MemoryEventEnvelope[]
      duplicateEventIds: MemoryEventId[]
      wrongProjectEventIds: MemoryEventId[]
      repositoryLastEventId?: MemoryEventId
    }
  | Extract<V1MigrationAuditOutcome, { outcome: 'rejected' | 'failed' }>

async function scanV1MigrationAuditEvents(
  repository: V1MigrationAuditReader,
  projectId: ProjectId,
): Promise<V1MigrationAuditScan> {
  const events: MemoryEventEnvelope[] = []
  const eventIds = new Set<MemoryEventId>()
  const duplicateEventIds = new Set<MemoryEventId>()
  const wrongProjectEventIds = new Set<MemoryEventId>()
  const cursors = new Set<MemoryEventId>()
  let afterEventId: MemoryEventId | undefined
  let repositoryLastEventId: MemoryEventId | undefined

  // Cursor-resumable scan: termination is `nextAfterEventId` exhaustion,
  // not a page-count ceiling, mirroring findMigrationMarker and the import
  // progress lookup so stores larger than the former ten-page export scan
  // still audit completely.
  while (true) {
    let raw: unknown
    try {
      raw = await repository.export({
        schemaVersion: 2,
        projectId,
        ...(afterEventId ? { afterEventId } : {}),
        limit: 1_000,
      })
    } catch {
      return { outcome: 'failed', reason: 'repository-failed' }
    }
    const parsed = MemoryExportOutcomeSchema.safeParse(raw)
    if (!parsed.success) return { outcome: 'failed', reason: 'invalid-export' }
    const exported = parsed.data
    if (exported.outcome !== 'page') {
      return {
        outcome: exported.outcome,
        reason:
          exported.outcome === 'rejected'
            ? 'repository-rejected'
            : 'repository-failed',
      }
    }

    for (const event of exported.events) {
      if (event.projectId !== projectId) wrongProjectEventIds.add(event.eventId)
      if (eventIds.has(event.eventId)) duplicateEventIds.add(event.eventId)
      else eventIds.add(event.eventId)
      events.push(event)
    }
    repositoryLastEventId = exported.rawTailEventId ?? repositoryLastEventId

    const nextAfterEventId = exported.nextAfterEventId ?? undefined
    if (!nextAfterEventId) {
      return {
        outcome: 'complete',
        events,
        duplicateEventIds: [...duplicateEventIds],
        wrongProjectEventIds: [...wrongProjectEventIds],
        repositoryLastEventId,
      }
    }
    if (nextAfterEventId === afterEventId || cursors.has(nextAfterEventId)) {
      return { outcome: 'failed', reason: 'pagination-invalid' }
    }
    cursors.add(nextAfterEventId)
    afterEventId = nextAfterEventId
  }
}

function auditMigrationMarkerBody(params: {
  marker: ImportedMarkerEvent
  events: MemoryEventEnvelope[]
  memory: TaskMemoryV1
  projectId: ProjectId
  repositoryLastEventId: MemoryEventId
}): V1MigrationAuditOutcome {
  const { marker, events, memory, projectId, repositoryLastEventId } = params
  const { revision, checksum } = memory
  const build = buildTaskMemoryV1Migration({
    memory,
    projectId,
    sessionId: marker.sessionId,
    representationIdentity: marker.payload.legacyRecordKey,
  })
  const markerResult = (
    outcome: 'incomplete' | 'mismatch',
    reason:
      | 'missing-imported-task'
      | 'missing-imported-observations'
      | 'imported-body-mismatch',
    missingEventIds?: MemoryEventId[],
  ): V1MigrationAuditOutcome => ({
    outcome,
    reason,
    revision,
    checksum,
    repositoryLastEventId,
    markerEventId: marker.eventId,
    ...(missingEventIds?.length
      ? { missingEventIds: missingEventIds.slice(0, MAX_OBSERVATIONS) }
      : {}),
  })
  if (!equalEventDraft(build.markerDraft, marker)) {
    return markerResult('mismatch', 'imported-body-mismatch')
  }
  const byEventId = new Map<MemoryEventId, MemoryEventEnvelope[]>()
  for (const event of events) {
    const matching = byEventId.get(event.eventId) ?? []
    matching.push(event)
    byEventId.set(event.eventId, matching)
  }
  const expectedTask = build.bodyDrafts[0]!
  const taskMatches = byEventId.get(expectedTask.eventId) ?? []
  if (taskMatches.length === 0) {
    return markerResult('incomplete', 'missing-imported-task')
  }
  if (
    taskMatches.length !== 1 ||
    !equalEventDraft(expectedTask, taskMatches[0]!)
  ) {
    return markerResult('mismatch', 'imported-body-mismatch')
  }

  const missingObservationIds: MemoryEventId[] = []
  for (const expected of build.bodyDrafts.slice(1)) {
    const matching = byEventId.get(expected.eventId) ?? []
    if (matching.length === 0) {
      missingObservationIds.push(expected.eventId)
      continue
    }
    if (
      matching.length !== 1 ||
      !equalImportedObservationDraftWithKindWindow(expected, matching[0]!)
    ) {
      return markerResult('mismatch', 'imported-body-mismatch')
    }
  }
  if (missingObservationIds.length) {
    return markerResult(
      'incomplete',
      'missing-imported-observations',
      missingObservationIds,
    )
  }

  return {
    outcome: 'exact',
    revision,
    checksum,
    identity: build.identity,
    markerEventId: marker.eventId,
    repositoryLastEventId,
    importedTaskId: build.importedTaskId,
    importedObservationIds: build.importedObservationIds,
    omittedFields: build.omittedFields,
    warnings: build.warnings,
    sourceItemCounts: build.sourceItemCounts,
    truncatedFields: build.truncatedFields,
  }
}

export async function auditTaskMemoryV1Migration(params: {
  memory?: TaskMemoryV1
  projectId: ProjectId
  repository: V1MigrationAuditReader
}): Promise<V1MigrationAuditOutcome> {
  const { memory, projectId, repository } = params
  if (!memory) return { outcome: 'no-record' }

  const { revision, updatedAt, checksum, ...candidateDraft } = memory
  const parsedDraft = taskMemoryDraftV1Schema.safeParse(candidateDraft)
  if (!parsedDraft.success) {
    // A record that fails its own schema is corrupt, not merely hash-drifted:
    // callers must be able to distinguish 'rebuild from source' from 'the
    // record itself is unreadable', so this is never 'checksum-mismatch'.
    return {
      outcome: 'rejected',
      reason: 'invalid-record',
      revision,
      checksum,
    }
  }
  const recomputed = stableHash(
    JSON.stringify({ revision, updatedAt, memory: parsedDraft.data }),
  )
  if (recomputed !== checksum) {
    return {
      outcome: 'rejected',
      reason: 'checksum-mismatch',
      revision,
      checksum,
    }
  }

  const scanned = await scanV1MigrationAuditEvents(repository, projectId)
  if (scanned.outcome !== 'complete') {
    return { ...scanned, revision, checksum }
  }
  const identity = getV1MigrationIdentity({ projectId, revision, checksum })
  const matchingReservations = scanned.events.filter(
    (event) =>
      event.eventType === 'migration.v1.reserved' &&
      event.payload.sourceRevision === revision &&
      event.payload.sourceChecksum === checksum &&
      event.payload.migrationId === identity,
  )
  const conflictingReservation = scanned.events.some(
    (event) =>
      event.eventType === 'migration.v1.reserved' &&
      event.payload.sourceRevision === revision &&
      (event.payload.sourceChecksum !== checksum ||
        event.payload.migrationId !== identity),
  )
  const exactMarkers = scanned.events.filter(
    (event): event is ImportedMarkerEvent =>
      event.eventType === 'migration.v1.imported' &&
      event.payload.sourceRevision === revision &&
      event.payload.sourceChecksum === checksum,
  )
  const conflictingMarker = scanned.events.some(
    (event) =>
      event.eventType === 'migration.v1.imported' &&
      event.payload.sourceRevision === revision &&
      event.payload.sourceChecksum !== undefined &&
      event.payload.sourceChecksum !== checksum,
  )
  const legacyMarkers = scanned.events.filter(
    (event): event is ImportedMarkerEvent =>
      event.eventType === 'migration.v1.imported' &&
      event.payload.legacyRecordKey === identity &&
      (event.payload.sourceRevision === undefined ||
        event.payload.sourceChecksum === undefined),
  )
  const unverifiableRevisionMarker = scanned.events.some(
    (event) =>
      event.eventType === 'migration.v1.imported' &&
      event.payload.sourceRevision === revision &&
      event.payload.sourceChecksum === undefined,
  )
  const auditEvidence = {
    revision,
    checksum,
    ...(scanned.repositoryLastEventId
      ? { repositoryLastEventId: scanned.repositoryLastEventId }
      : {}),
  }

  if (exactMarkers.length > 0 && scanned.wrongProjectEventIds.length > 0) {
    const build = buildTaskMemoryV1Migration({
      memory,
      projectId,
      sessionId: exactMarkers[0]!.sessionId,
    })
    const expectedIds = new Set([
      build.markerDraft.eventId,
      ...build.bodyDrafts.map((draft) => draft.eventId),
    ])
    if (
      scanned.wrongProjectEventIds.some((eventId) => expectedIds.has(eventId))
    ) {
      return {
        outcome: 'mismatch',
        reason: 'imported-body-mismatch',
        markerEventId: exactMarkers[0]!.eventId,
        ...auditEvidence,
      }
    }
    return { outcome: 'failed', reason: 'wrong-project', revision, checksum }
  }
  if (scanned.wrongProjectEventIds.length > 0) {
    return { outcome: 'failed', reason: 'wrong-project', revision, checksum }
  }
  if (scanned.duplicateEventIds.length > 0) {
    if (exactMarkers.length > 0) {
      const build = buildTaskMemoryV1Migration({
        memory,
        projectId,
        sessionId: exactMarkers[0]!.sessionId,
      })
      const expectedIds = new Set([
        build.markerDraft.eventId,
        ...build.bodyDrafts.map((draft) => draft.eventId),
      ])
      if (
        scanned.duplicateEventIds.some((eventId) => expectedIds.has(eventId))
      ) {
        return {
          outcome: 'mismatch',
          reason: 'imported-body-mismatch',
          markerEventId: exactMarkers[0]!.eventId,
          ...auditEvidence,
        }
      }
    }
    return {
      outcome: 'failed',
      reason: 'pagination-invalid',
      revision,
      checksum,
    }
  }
  if (conflictingReservation || conflictingMarker) {
    return {
      outcome: 'mismatch',
      reason: 'checksum-conflict',
      ...auditEvidence,
    }
  }
  if (
    matchingReservations.length > 1 ||
    legacyMarkers.length > 1 ||
    (unverifiableRevisionMarker && exactMarkers.length > 0)
  ) {
    return {
      outcome: 'mismatch',
      reason: 'revision-conflict',
      ...auditEvidence,
    }
  }
  if (exactMarkers.length > 0) {
    let latestFailure: V1MigrationAuditOutcome | undefined
    for (const marker of [...exactMarkers].reverse()) {
      const audited = auditMigrationMarkerBody({
        marker,
        events: scanned.events,
        memory,
        projectId,
        repositoryLastEventId: scanned.repositoryLastEventId!,
      })
      if (audited.outcome === 'exact') return audited
      latestFailure ??= audited
    }
    return latestFailure!
  }
  if (legacyMarkers.length === 1) {
    return {
      outcome: 'incomplete',
      reason: 'legacy-marker-unverifiable',
      markerEventId: legacyMarkers[0]!.eventId,
      ...auditEvidence,
    }
  }
  if (unverifiableRevisionMarker) {
    return {
      outcome: 'mismatch',
      reason: 'revision-conflict',
      ...auditEvidence,
    }
  }
  if (matchingReservations.length === 1) {
    return {
      outcome: 'incomplete',
      reason: 'reservation-only',
      ...auditEvidence,
    }
  }
  return { outcome: 'not-migrated', ...auditEvidence }
}

/**
 * @deprecated Memory V1 compatibility surface; use Memory V2. Removal will occur only after the documented compatibility window and migration audit.
 */
export async function importTaskMemoryV1(params: {
  memory?: TaskMemoryV1
  projectId: ProjectId
  sessionId: MemorySessionId
  repository: MemoryRepositoryV2
}): Promise<V1MigrationOutcome> {
  const { memory, projectId, sessionId, repository } = params
  if (!memory) return { outcome: 'no-record' }

  const { revision, updatedAt, checksum, ...candidateDraft } = memory
  const parsedDraft = taskMemoryDraftV1Schema.safeParse(candidateDraft)
  if (!parsedDraft.success) {
    // A record that fails its own schema is corrupt, not merely hash-drifted:
    // callers must be able to distinguish 'rebuild from source' from 'the
    // record itself is unreadable', so this is never 'checksum-mismatch'.
    return {
      outcome: 'rejected',
      reason: 'invalid-record',
      revision,
      checksum,
    }
  }
  const recomputed = stableHash(
    JSON.stringify({ revision, updatedAt, memory: parsedDraft.data }),
  )
  if (recomputed !== checksum) {
    return {
      outcome: 'rejected',
      reason: 'checksum-mismatch',
      revision,
      checksum,
    }
  }

  let build = buildTaskMemoryV1Migration({ memory, projectId, sessionId })
  const identity = build.identity
  let lookup: MigrationMarkerLookup
  try {
    lookup = await findMigrationMarker(
      repository,
      projectId,
      revision,
      checksum,
    )
  } catch {
    return {
      outcome: 'failed',
      reason: 'repository-failed',
      revision,
      checksum,
    }
  }
  if (lookup.state === 'conflict') {
    return {
      outcome: 'rejected',
      reason: 'checksum-mismatch',
      revision,
      checksum,
    }
  }
  if (lookup.state === 'exact') {
    const audited = await auditTaskMemoryV1Migration({
      memory,
      projectId,
      repository,
    })
    if (audited.outcome === 'exact') {
      return outcomeFromMarker({
        marker: {
          eventId: audited.markerEventId,
          importedTaskId: audited.importedTaskId,
          importedObservationIds: audited.importedObservationIds,
          omittedFields: audited.omittedFields,
          warnings: audited.warnings,
          ...(audited.sourceItemCounts
            ? { sourceItemCounts: audited.sourceItemCounts }
            : {}),
          ...(audited.truncatedFields === undefined
            ? {}
            : { truncatedFields: audited.truncatedFields }),
        },
        revision,
        checksum,
        identity,
        lastEventId: lookup.lastEventId,
      })
    }
    if (audited.outcome === 'rejected' || audited.outcome === 'failed') {
      return {
        outcome: 'failed',
        reason: 'repository-failed',
        revision,
        checksum,
      }
    }
    const representationIdentity = `v1-repair:${hashToken(
      `${identity}:${lookup.marker.eventId}:representation-2`,
    )}`
    build = buildTaskMemoryV1Migration({
      memory,
      projectId,
      sessionId,
      representationIdentity,
    })
  }

  const {
    bodyIdentity,
    occurredAt,
    importedTaskId,
    importedObservationIds,
    omittedFields,
    sourceItemCounts,
    truncatedFields,
  } = build
  let expectedTail = lookup.lastEventId
    ? { kind: 'event' as const, eventId: lookup.lastEventId }
    : { kind: 'empty' as const }
  const drafts = [...build.bodyDrafts]

  // Retirement (claim.forgotten) drafts for a prior validated marker are
  // intentionally NOT part of the body pages: they are appended only after
  // the replacement import is durably marked (see the post-marker block
  // below), so a permanent marker-append failure can never strand prior
  // memory claims as forgotten without a replacement.

  const reservation = {
    ...createMemoryEventDraft({
      projectId,
      sessionId,
      userInputId: identity,
      occurredAt,
      eventType: 'migration.v1.reserved',
      payload: {
        payloadSchemaVersion: 1,
        migrationId: identity,
        sourceRevision: revision,
        sourceChecksum: checksum,
      },
    }),
    eventId: reservationEventId(identity),
  }

  const reloadOwnership = async (): Promise<
    MigrationMarkerLookup | V1MigrationOutcome
  > => {
    try {
      const reloaded = await findMigrationMarker(
        repository,
        projectId,
        revision,
        checksum,
      )
      if (reloaded.state === 'conflict') {
        return {
          outcome: 'rejected',
          reason: 'checksum-mismatch',
          revision,
          checksum,
        }
      }
      return reloaded
    } catch {
      return {
        outcome: 'failed',
        reason: 'repository-failed',
        revision,
        checksum,
      }
    }
  }

  if (!lookup.reserved) {
    try {
      const reserved = MemoryAppendOutcomeSchema.parse(
        await repository.append(
          MemoryAppendRequestSchema.parse({
            schemaVersion: 2,
            projectId,
            expectedTail,
            events: [reservation],
          }),
        ),
      )
      if (reserved.outcome === 'appended') {
        expectedTail = { kind: 'event', eventId: reserved.lastEventId }
        lookup = {
          ...lookup,
          reserved: true,
          lastEventId: reserved.lastEventId,
          events: [
            ...lookup.events,
            { ...reservation, sequence: reserved.entries[0]!.sequence },
          ],
        }
      } else if (
        reserved.error.code === 'conflict' &&
        reserved.error.retryable
      ) {
        const reloaded = await reloadOwnership()
        if ('outcome' in reloaded) return reloaded
        if (reloaded.state === 'exact') {
          const validatedMarker = validatedCompleteBuildMarker(reloaded, build)
          if (!validatedMarker)
            return {
              outcome: 'failed',
              reason: 'repository-failed',
              revision,
              checksum,
            }
          return outcomeFromMarker({
            marker: validatedMarker,
            revision,
            checksum,
            identity,
            lastEventId: reloaded.lastEventId,
          })
        }
        if (!reloaded.reserved)
          return {
            outcome: 'failed',
            reason: 'repository-failed',
            revision,
            checksum,
          }
        lookup = reloaded
        expectedTail = reloaded.lastEventId
          ? { kind: 'event', eventId: reloaded.lastEventId }
          : { kind: 'empty' }
      } else {
        return {
          outcome: reserved.outcome === 'rejected' ? 'rejected' : 'failed',
          reason:
            reserved.outcome === 'rejected'
              ? 'repository-rejected'
              : 'repository-failed',
          revision,
          checksum,
        }
      }
    } catch {
      return {
        outcome: 'failed',
        reason: 'repository-failed',
        revision,
        checksum,
      }
    }
  }

  const revalidateAfterConflict = async (): Promise<
    MigrationMarkerLookup | V1MigrationOutcome
  > => {
    let revalidated: MigrationMarkerLookup
    try {
      revalidated = await findMigrationMarker(
        repository,
        projectId,
        revision,
        checksum,
      )
    } catch {
      return {
        outcome: 'failed',
        reason: 'repository-failed',
        revision,
        checksum,
      }
    }
    if (revalidated.state === 'conflict') {
      return {
        outcome: 'rejected',
        reason: 'checksum-mismatch',
        revision,
        checksum,
      }
    }
    if (revalidated.state === 'exact') {
      const validatedMarker = validatedCompleteBuildMarker(revalidated, build)
      if (!validatedMarker)
        return {
          outcome: 'failed',
          reason: 'repository-failed',
          revision,
          checksum,
        }
      return outcomeFromMarker({
        marker: validatedMarker,
        revision,
        checksum,
        identity,
        lastEventId: revalidated.lastEventId,
      })
    }
    return revalidated
  }

  const existingEvents = new Map<MemoryEventId, MemoryEventEnvelope[]>()
  // Cursor-resumable progress lookup: on large stores (>10k canonical
  // events) the pre-existing imported body can extend past any fixed
  // page ceiling, so termination is `nextAfterEventId` exhaustion —
  // not a page-count cap — to keep re-entrant dedup sound.
  //
  // The scan runs ONCE before the paged body-append loop (plus once per
  // conflict recovery) instead of once per batch: per-batch full-store
  // rescans made backfill quadratic in store size.
  const scanExistingEvents = async (): Promise<boolean> => {
    existingEvents.clear()
    let afterEventId: MemoryEventId | undefined
    while (true) {
      let exported
      try {
        exported = await repository.export({
          schemaVersion: 2,
          projectId,
          ...(afterEventId ? { afterEventId } : {}),
          limit: 1_000,
        })
      } catch {
        return false
      }
      if (exported.outcome !== 'page') return false
      for (const event of exported.events) {
        const matching = existingEvents.get(event.eventId) ?? []
        matching.push(event)
        existingEvents.set(event.eventId, matching)
      }
      if (!exported.nextAfterEventId) break
      afterEventId = exported.nextAfterEventId
    }
    return true
  }
  if (!(await scanExistingEvents())) {
    return {
      outcome: 'failed',
      reason: 'repository-failed',
      revision,
      checksum,
    }
  }

  for (let offset = 0; offset < drafts.length; offset += APPEND_PAGE_SIZE) {
    let recoveries = 0
    while (true) {
      const remainingDrafts = drafts.slice(offset, offset + APPEND_PAGE_SIZE)
      if (recoveries > 0) {
        // After a conflict the repository tail may have moved under us, so
        // refresh the dedup map once per recovery instead of rescanning the
        // full store for every batch.
        if (!(await scanExistingEvents())) {
          return {
            outcome: 'failed',
            reason: 'repository-failed',
            revision,
            checksum,
          }
        }
      }
      for (const draft of remainingDrafts) {
        const matching = existingEvents.get(draft.eventId) ?? []
        if (
          matching.length > 0 &&
          (matching.length !== 1 ||
            !equalImportedObservationDraftWithKindWindow(draft, matching[0]!))
        )
          return {
            outcome: 'failed',
            reason: 'repository-failed',
            revision,
            checksum,
          }
      }
      const events = remainingDrafts.filter(
        (draft) => !existingEvents.has(draft.eventId),
      )
      if (events.length === 0) break
      let outcome
      try {
        outcome = MemoryAppendOutcomeSchema.parse(
          await repository.append(
            MemoryAppendRequestSchema.parse({
              schemaVersion: 2,
              projectId,
              expectedTail,
              events,
            }),
          ),
        )
      } catch {
        return {
          outcome: 'failed',
          reason: 'repository-failed',
          revision,
          checksum,
        }
      }
      if (outcome.outcome === 'appended') {
        expectedTail = { kind: 'event', eventId: outcome.lastEventId }
        break
      }
      if (
        outcome.error.code === 'conflict' &&
        outcome.error.retryable &&
        recoveries < 2
      ) {
        recoveries++
        const recovered = await revalidateAfterConflict()
        if ('outcome' in recovered) return recovered
        expectedTail = recovered.lastEventId
          ? { kind: 'event', eventId: recovered.lastEventId }
          : { kind: 'empty' }
        continue
      }
      return {
        outcome: outcome.outcome === 'rejected' ? 'rejected' : 'failed',
        reason:
          outcome.outcome === 'rejected'
            ? 'repository-rejected'
            : 'repository-failed',
        revision,
        checksum,
      }
    }
  }

  const marker = build.markerDraft
  try {
    const markerOutcome = MemoryAppendOutcomeSchema.parse(
      await repository.append(
        MemoryAppendRequestSchema.parse({
          schemaVersion: 2,
          projectId,
          expectedTail,
          events: [marker],
        }),
      ),
    )
    if (markerOutcome.outcome !== 'appended') {
      if (
        markerOutcome.error.code === 'conflict' &&
        markerOutcome.error.retryable
      ) {
        const recovered = await revalidateAfterConflict()
        if ('outcome' in recovered) return recovered
        return {
          outcome: 'failed',
          reason: 'repository-failed',
          revision,
          checksum,
        }
      }
      return {
        outcome: markerOutcome.outcome === 'rejected' ? 'rejected' : 'failed',
        reason:
          markerOutcome.outcome === 'rejected'
            ? 'repository-rejected'
            : 'repository-failed',
        revision,
        checksum,
      }
    }
    const markerDuplicate = markerOutcome.entries[0]?.duplicate === true
    const completed = await reloadOwnership()
    if (
      'outcome' in completed ||
      completed.state !== 'exact' ||
      !validatedCompleteBuildMarker(completed, build)
    )
      return {
        outcome: 'failed',
        reason: 'repository-failed',
        revision,
        checksum,
      }

    // Retirement AFTER the confirmed marker: claim.forgotten events retire
    // prior imported observations only once the replacement import is
    // durably marked, so a permanent marker-append failure can never strand
    // prior memory claims as forgotten without a replacement. A permanent
    // retirement failure is fail-safe (duplicate claims remain active; no
    // data is destroyed) and is never reported as a generic repository
    // failure of the import itself.
    let outcomeLastEventId = completed.lastEventId
    if (lookup.prior) {
      const currentObservationIds = new Set(importedObservationIds)
      const retirementIdentity = `v1-retire:${hashToken(
        `${bodyIdentity}:${lookup.prior.eventId}`,
      )}`
      const retirementDrafts = lookup.prior.importedObservationIds
        .filter((observationId) => !currentObservationIds.has(observationId))
        .map((observationId, index) =>
          withMigrationEventId(
            createMemoryEventDraft({
              projectId,
              sessionId,
              userInputId: retirementIdentity,
              sourceIndex: index + 1,
              occurredAt,
              eventType: 'claim.forgotten',
              payload: {
                payloadSchemaVersion: 1,
                observationIds: [observationId],
                reason: 'duplicate',
                requestedBy: bounded(`migration:${revision}`, 256),
                evidenceDisposition: 'remove-references',
              },
            }),
            retirementIdentity,
            index,
          ),
        )
      let retirementTail: typeof expectedTail = {
        kind: 'event',
        eventId: completed.lastEventId,
      }
      for (
        let offset = 0;
        offset < retirementDrafts.length;
        offset += APPEND_PAGE_SIZE
      ) {
        try {
          const retired = MemoryAppendOutcomeSchema.parse(
            await repository.append(
              MemoryAppendRequestSchema.parse({
                schemaVersion: 2,
                projectId,
                expectedTail: retirementTail,
                events: retirementDrafts.slice(
                  offset,
                  offset + APPEND_PAGE_SIZE,
                ),
              }),
            ),
          )
          if (retired.outcome === 'appended') {
            retirementTail = { kind: 'event', eventId: retired.lastEventId }
            outcomeLastEventId = retired.lastEventId
            continue
          }
          // Fail-safe: leave prior claims active rather than forgetting
          // them without a durable replacement.
          break
        } catch {
          break
        }
      }
    }
    return {
      outcome: markerDuplicate ? 'no-op' : 'imported',
      revision,
      checksum,
      identity,
      importedTaskId,
      importedObservationIds,
      omittedFields,
      warnings: build.warnings,
      lastEventId: outcomeLastEventId,
      sourceItemCounts,
      truncatedFields,
    }
  } catch {
    return {
      outcome: 'failed',
      reason: 'repository-failed',
      revision,
      checksum,
    }
  }
}

function TaskIdFor(identity: string): TaskId {
  return TaskIdSchema.parse(`task:migration:${hashToken(identity)}`)
}

function ObservationIdFor(identity: string, index: number): ObservationId {
  return ObservationIdSchema.parse(
    `observation:migration:${hashToken(`${identity}:${index}`)}`,
  )
}

function withMigrationEventId(
  draft: MemoryEventDraft,
  identity: string,
  index: number,
): MemoryEventDraft {
  return { ...draft, eventId: eventId(identity, index) }
}
