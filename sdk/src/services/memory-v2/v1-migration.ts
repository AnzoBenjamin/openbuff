import {
  MemoryAppendOutcomeSchema,
  MemoryAppendRequestSchema,
  MemoryEventIdSchema,
  ObservationIdSchema,
  TaskIdSchema,
  type MemoryEventDraft,
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
const MAX_EXPORT_PAGES = 10
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
type V1MigrationSourceItemCounts = Record<V1MigrationCategory, number>

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

export type V1MigrationWarningCode =
  | 'goal-excluded'
  | 'observation-cap-reached'
  | 'legacy-evidence-unverified'
  | 'stale-evidence-omitted'
  | 'unsafe-path-omitted'
  | 'empty-field-omitted'
  | 'text-truncated'

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
      reason: 'checksum-mismatch' | 'repository-rejected' | 'repository-failed'
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

const hashToken = (value: string): string =>
  stableHash(value).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 96)

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
  return MemoryEventIdSchema.parse(`event:migration:reservation:${hashToken(identity)}`)
}

function eventId(identity: string, index: number) {
  return MemoryEventIdSchema.parse(`event:migration:${hashToken(`${identity}:${index}`)}`)
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

type MigrationMarkerLookup =
  | {
      state: 'none'
      lastEventId?: MemoryEventId
      prior?: MigrationMarkerMetadata
      reserved: boolean
    }
  | {
      state: 'conflict'
      lastEventId?: MemoryEventId
      prior?: MigrationMarkerMetadata
      reserved: boolean
    }
  | {
      state: 'exact'
      lastEventId: MemoryEventId
      marker: MigrationMarkerMetadata
      prior?: MigrationMarkerMetadata
      reserved: boolean
    }

function isV1MigrationWarningCode(value: string): value is V1MigrationWarningCode {
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
  let prior: MigrationMarkerMetadata | undefined

  for (let page = 0; page < MAX_EXPORT_PAGES; page++) {
    const outcome = await repository.export({
      schemaVersion: 2,
      projectId,
      ...(afterEventId ? { afterEventId } : {}),
      limit: 1_000,
    })
    if (outcome.outcome !== 'page') throw new Error('Migration marker lookup failed')

    for (const event of outcome.events) {
      lastEventId = event.eventId
      if (event.eventType === 'migration.v1.reserved') {
        if (event.payload.sourceRevision === revision) {
          if (
            event.payload.migrationId === getV1MigrationIdentity({ projectId, revision, checksum }) &&
            event.payload.sourceChecksum === checksum
          ) reserved = true
          else conflict = true
        }
        continue
      }
      if (event.eventType !== 'migration.v1.imported') continue

      const marker: MigrationMarkerMetadata = {
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
      const sourceRevision = event.payload.sourceRevision
      if (sourceRevision === revision) {
        if (event.payload.sourceChecksum === checksum) exact = marker
        else conflict = true
      } else if (sourceRevision !== undefined && sourceRevision < revision) {
        prior = marker
      }
    }

    if (!outcome.nextAfterEventId) {
      if (conflict) return { state: 'conflict', lastEventId, prior, reserved }
      if (exact && lastEventId) return { state: 'exact', lastEventId, marker: exact, prior, reserved }
      return { state: 'none', lastEventId, prior, reserved }
    }
    afterEventId = outcome.nextAfterEventId
    lastEventId = outcome.nextAfterEventId
  }
  throw new Error('Migration marker lookup exceeded page limit')
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
    ...(marker.sourceItemCounts ? { sourceItemCounts: marker.sourceItemCounts } : {}),
    ...(marker.truncatedFields === undefined
      ? {}
      : { truncatedFields: marker.truncatedFields }),
  }
}

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
    return { outcome: 'rejected', reason: 'checksum-mismatch', revision, checksum }
  }
  const recomputed = stableHash(
    JSON.stringify({ revision, updatedAt, memory: parsedDraft.data }),
  )
  if (recomputed !== checksum) {
    return { outcome: 'rejected', reason: 'checksum-mismatch', revision, checksum }
  }

  const identity = getV1MigrationIdentity({ projectId, revision, checksum })
  const bodyIdentity = getV1MigrationBodyIdentity({ projectId, revision, checksum })
  let lookup: MigrationMarkerLookup
  try {
    lookup = await findMigrationMarker(repository, projectId, revision, checksum)
  } catch {
    return { outcome: 'failed', reason: 'repository-failed', revision, checksum }
  }
  if (lookup.state === 'conflict') {
    return { outcome: 'rejected', reason: 'checksum-mismatch', revision, checksum }
  }
  if (lookup.state === 'exact') {
    return outcomeFromMarker({
      marker: lookup.marker,
      revision,
      checksum,
      identity,
      lastEventId: lookup.lastEventId,
    })
  }

  let expectedTail = lookup.lastEventId
    ? { kind: 'event' as const, eventId: lookup.lastEventId }
    : { kind: 'empty' as const }
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
  const addObservation = (observation: (typeof observations)[number]): boolean => {
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

  const drafts: MemoryEventDraft[] = []
  drafts.push(
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
          objective: 'Preserve bounded legacy operational memory without importing its goal.',
          initialStatus: 'created',
        },
      }),
      bodyIdentity,
      0,
    ),
  )

  const importedObservationIds: ObservationId[] = []
  observations.forEach((item, index) => {
    const observationId = ObservationIdFor(bodyIdentity, index)
    importedObservationIds.push(observationId)
    drafts.push(
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
              kind: item.category === 'blockers' ? 'warning' : 'discovery',
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

  if (lookup.prior) {
    const currentObservationIds = new Set(importedObservationIds)
    const retirementIdentity = `v1-retire:${hashToken(
      `${bodyIdentity}:${lookup.prior.eventId}`,
    )}`
    lookup.prior.importedObservationIds
      .filter((observationId) => !currentObservationIds.has(observationId))
      .forEach((observationId, index) => {
        drafts.push(
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
      })
  }

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

  const reloadOwnership = async (): Promise<MigrationMarkerLookup | V1MigrationOutcome> => {
    try {
      const reloaded = await findMigrationMarker(repository, projectId, revision, checksum)
      if (reloaded.state === 'conflict') {
        return { outcome: 'rejected', reason: 'checksum-mismatch', revision, checksum }
      }
      return reloaded
    } catch {
      return { outcome: 'failed', reason: 'repository-failed', revision, checksum }
    }
  }

  if (!lookup.reserved) {
    try {
      const reserved = MemoryAppendOutcomeSchema.parse(
        await repository.append(MemoryAppendRequestSchema.parse({
          schemaVersion: 2,
          projectId,
          expectedTail,
          events: [reservation],
        })),
      )
      if (reserved.outcome === 'appended') {
        expectedTail = { kind: 'event', eventId: reserved.lastEventId }
        lookup = { ...lookup, reserved: true, lastEventId: reserved.lastEventId }
      } else if (reserved.error.code === 'conflict' && reserved.error.retryable) {
        const reloaded = await reloadOwnership()
        if ('outcome' in reloaded) return reloaded
        if (reloaded.state === 'exact') {
          return outcomeFromMarker({ marker: reloaded.marker, revision, checksum, identity, lastEventId: reloaded.lastEventId })
        }
        if (!reloaded.reserved) return { outcome: 'failed', reason: 'repository-failed', revision, checksum }
        lookup = reloaded
        expectedTail = reloaded.lastEventId
          ? { kind: 'event', eventId: reloaded.lastEventId }
          : { kind: 'empty' }
      } else {
        return {
          outcome: reserved.outcome === 'rejected' ? 'rejected' : 'failed',
          reason: reserved.outcome === 'rejected' ? 'repository-rejected' : 'repository-failed',
          revision,
          checksum,
        }
      }
    } catch {
      return { outcome: 'failed', reason: 'repository-failed', revision, checksum }
    }
  }

  const revalidateAfterConflict = async (): Promise<MigrationMarkerLookup | V1MigrationOutcome> => {
    let revalidated: MigrationMarkerLookup
    try {
      revalidated = await findMigrationMarker(repository, projectId, revision, checksum)
    } catch {
      return { outcome: 'failed', reason: 'repository-failed', revision, checksum }
    }
    if (revalidated.state === 'conflict') {
      return { outcome: 'rejected', reason: 'checksum-mismatch', revision, checksum }
    }
    if (revalidated.state === 'exact') {
      return outcomeFromMarker({
        marker: revalidated.marker,
        revision,
        checksum,
        identity,
        lastEventId: revalidated.lastEventId,
      })
    }
    return revalidated
  }

  for (let offset = 0; offset < drafts.length; offset += APPEND_PAGE_SIZE) {
    let recoveries = 0
    while (true) {
      const remainingDrafts = drafts.slice(offset, offset + APPEND_PAGE_SIZE)
      const existingIds = new Map<string, MemoryEventId>()
      try {
        let afterEventId: MemoryEventId | undefined
        for (let page = 0; page < MAX_EXPORT_PAGES; page++) {
          const exported = await repository.export({
            schemaVersion: 2,
            projectId,
            ...(afterEventId ? { afterEventId } : {}),
            limit: 1_000,
          })
          if (exported.outcome !== 'page') throw new Error('Migration progress lookup failed')
          for (const event of exported.events) existingIds.set(event.eventId, event.eventId)
          if (!exported.nextAfterEventId) break
          afterEventId = exported.nextAfterEventId
        }
      } catch {
        return { outcome: 'failed', reason: 'repository-failed', revision, checksum }
      }
      const events = remainingDrafts.filter((draft) => !existingIds.has(draft.eventId))
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
        return { outcome: 'failed', reason: 'repository-failed', revision, checksum }
      }
      if (outcome.outcome === 'appended') {
        expectedTail = { kind: 'event', eventId: outcome.lastEventId }
        break
      }
      if (outcome.error.code === 'conflict' && outcome.error.retryable && recoveries < 2) {
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
        reason: outcome.outcome === 'rejected' ? 'repository-rejected' : 'repository-failed',
        revision,
        checksum,
      }
    }
  }

  const warningList = [...warnings].slice(0, 100)
  const marker = withMigrationEventId(
    createMemoryEventDraft({
      projectId,
      sessionId,
      userInputId: identity,
      sourceIndex: MAX_OBSERVATIONS + 1,
      occurredAt,
      eventType: 'migration.v1.imported',
      payload: {
        payloadSchemaVersion: 1,
        sourceSchemaVersion: 1,
        legacyRecordKey: identity,
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
    identity,
    MAX_OBSERVATIONS + 1,
  )
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
      if (markerOutcome.error.code === 'conflict' && markerOutcome.error.retryable) {
        const recovered = await revalidateAfterConflict()
        if ('outcome' in recovered) return recovered
        return { outcome: 'failed', reason: 'repository-failed', revision, checksum }
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
    return {
      outcome: markerDuplicate ? 'no-op' : 'imported',
      revision,
      checksum,
      identity,
      importedTaskId,
      importedObservationIds,
      omittedFields,
      warnings: warningList,
      lastEventId: markerOutcome.lastEventId,
      sourceItemCounts,
      truncatedFields,
    }
  } catch {
    return { outcome: 'failed', reason: 'repository-failed', revision, checksum }
  }
}

function TaskIdFor(identity: string): TaskId {
  return TaskIdSchema.parse(`task:migration:${hashToken(identity)}`)
}

function ObservationIdFor(identity: string, index: number): ObservationId {
  return ObservationIdSchema.parse(`observation:migration:${hashToken(`${identity}:${index}`)}`)
}

function withMigrationEventId(
  draft: MemoryEventDraft,
  identity: string,
  index: number,
): MemoryEventDraft {
  return { ...draft, eventId: eventId(identity, index) }
}
