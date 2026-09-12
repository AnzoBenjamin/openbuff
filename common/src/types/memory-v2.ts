import { z } from 'zod/v4'

const MAX_ID_LENGTH = 128
const MAX_PATH_LENGTH = 1_024
const MAX_TEXT_LENGTH = 16_384
const MAX_ITEMS = 100

export const MemoryAuthorityModeSchema = z.enum([
  'json-v1',
  'shadow-v2',
  'sqlite-v2-opt-in',
])
export type MemoryAuthorityMode = z.infer<typeof MemoryAuthorityModeSchema>

const opaqueId = <Brand extends string>(brand: Brand) =>
  z
    .string()
    .min(1)
    .max(MAX_ID_LENGTH)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .brand<Brand>()

export const ProjectIdSchema = opaqueId('ProjectId')
export type ProjectId = z.infer<typeof ProjectIdSchema>
export const TaskIdSchema = opaqueId('TaskId')
export type TaskId = z.infer<typeof TaskIdSchema>
export const MemorySessionIdSchema = opaqueId('MemorySessionId')
export type MemorySessionId = z.infer<typeof MemorySessionIdSchema>
export const QueryIdSchema = opaqueId('QueryId')
export type QueryId = z.infer<typeof QueryIdSchema>
export const MemoryEventIdSchema = opaqueId('MemoryEventId')
export type MemoryEventId = z.infer<typeof MemoryEventIdSchema>
export const ObservationIdSchema = opaqueId('ObservationId')
export type ObservationId = z.infer<typeof ObservationIdSchema>

export type MemoryJsonValue =
  | null
  | boolean
  | number
  | string
  | MemoryJsonValue[]
  | { [key: string]: MemoryJsonValue }

const MAX_MEMORY_JSON_CONTAINER_DEPTH = 32
const memoryJsonPrimitiveSchema = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(4_096),
])
const memoryJsonDepthLimitSchema: z.ZodType<MemoryJsonValue> = z.custom<MemoryJsonValue>(
  () => false,
  { message: 'Memory JSON values may contain at most 32 nested containers' },
)

const memoryJsonValueSchemaAtDepth = (depth: number): z.ZodType<MemoryJsonValue> => {
  if (depth === MAX_MEMORY_JSON_CONTAINER_DEPTH) {
    const terminalSchema: z.ZodType<MemoryJsonValue> = z.union([
      memoryJsonPrimitiveSchema,
      memoryJsonDepthLimitSchema,
    ])
    return terminalSchema
  }

  const nestedValueSchema: z.ZodType<MemoryJsonValue> = memoryJsonValueSchemaAtDepth(depth + 1)
  const valueSchema: z.ZodType<MemoryJsonValue> = z.union([
    memoryJsonPrimitiveSchema,
    z.array(nestedValueSchema).max(64),
    z
      .record(z.string().min(1).max(128), nestedValueSchema)
      .refine((value) => Object.keys(value).length <= 64, {
        message: 'JSON objects may contain at most 64 keys',
      }),
  ])
  return valueSchema
}

export const MemoryJsonValueSchema: z.ZodType<MemoryJsonValue> = memoryJsonValueSchemaAtDepth(0)

export const MemoryMetadataSchema = z
  .record(z.string().min(1).max(128), MemoryJsonValueSchema)
  .refine((value) => Object.keys(value).length <= 64, {
    message: 'Metadata may contain at most 64 keys',
  })
export type MemoryMetadata = z.infer<typeof MemoryMetadataSchema>

const timestampSchema = z.iso.datetime({ offset: true })
const pathSchema = z.string().min(1).max(MAX_PATH_LENGTH)
const shortTextSchema = z.string().min(1).max(1_024)
const longTextSchema = z.string().min(1).max(MAX_TEXT_LENGTH)
const digestSchema = z.string().regex(/^[a-z0-9][a-z0-9+.-]{0,31}:[A-Fa-f0-9]{16,256}$/)

export const MemorySelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: pathSchema }).strict(),
  z
    .object({
      kind: z.literal('line-range'),
      path: pathSchema,
      startLine: z.number().int().positive().max(10_000_000),
      endLine: z.number().int().positive().max(10_000_000),
    })
    .strict()
    .refine((selector) => selector.endLine >= selector.startLine, {
      message: 'endLine must be greater than or equal to startLine',
      path: ['endLine'],
    }),
  z
    .object({
      kind: z.literal('symbol'),
      path: pathSchema,
      symbol: z.string().min(1).max(512),
      occurrence: z.number().int().positive().max(1_000_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('json-pointer'),
      path: pathSchema,
      pointer: z.string().max(2_048).refine((value) => value === '' || value.startsWith('/'), {
        message: 'JSON pointer must be empty or begin with /',
      }),
    })
    .strict(),
  z
    .object({
      kind: z.literal('uri-fragment'),
      uri: z.string().min(1).max(2_048),
      fragment: z.string().min(1).max(1_024),
    })
    .strict(),
])
export type MemorySelector = z.infer<typeof MemorySelectorSchema>

export const ArtifactClassificationSchema = z
  .object({
    kind: z.enum([
      'source',
      'test',
      'configuration',
      'documentation',
      'generated',
      'dependency',
      'data',
      'binary',
      'other',
    ]),
    language: z.string().min(1).max(64).optional(),
    generated: z.boolean(),
    sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']),
    labels: z.array(z.string().min(1).max(64)).max(32),
  })
  .strict()
export type ArtifactClassification = z.infer<typeof ArtifactClassificationSchema>

export const MemoryArtifactSchema = z
  .object({
    artifactId: z.string().min(1).max(256),
    location: z.string().min(1).max(2_048),
    digest: digestSchema.optional(),
    classification: ArtifactClassificationSchema,
  })
  .strict()
export type MemoryArtifact = z.infer<typeof MemoryArtifactSchema>

export const MemoryProvenanceSchema = z
  .object({
    origin: z.enum(['user', 'tool', 'repository', 'derived', 'migration']),
    recordedBy: z.string().min(1).max(256),
    sourceEventIds: z.array(MemoryEventIdSchema).max(32),
    sourceSessionId: MemorySessionIdSchema.optional(),
    toolName: z.string().min(1).max(128).optional(),
    metadata: MemoryMetadataSchema,
  })
  .strict()
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>

export const MemoryEvidenceSchema = z
  .object({
    artifact: MemoryArtifactSchema,
    selector: MemorySelectorSchema,
    provenance: MemoryProvenanceSchema,
    capturedAt: timestampSchema,
    contentDigest: digestSchema.optional(),
    excerpt: z.string().max(MAX_TEXT_LENGTH).optional(),
  })
  .strict()
export type MemoryEvidence = z.infer<typeof MemoryEvidenceSchema>

export const TaskStatusSchema = z.enum([
  'created',
  'active',
  'blocked',
  'completed',
  'failed',
  'cancelled',
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const MemoryObservationSchema = z
  .object({
    observationId: ObservationIdSchema,
    taskId: TaskIdSchema,
    kind: z.enum(['fact', 'decision', 'constraint', 'discovery', 'warning', 'outcome']),
    summary: shortTextSchema,
    detail: longTextSchema,
    confidence: z.number().min(0).max(1),
    evidence: z.array(MemoryEvidenceSchema).max(32),
    selectors: z.array(MemorySelectorSchema).max(32).optional(),
    provenance: MemoryProvenanceSchema.optional(),
    tags: z.array(z.string().min(1).max(64)).max(32),
    observedAt: timestampSchema,
  })
  .strict()
export type MemoryObservation = z.infer<typeof MemoryObservationSchema>

const payloadVersionShape = { payloadSchemaVersion: z.literal(1) } as const

export const TaskCreatedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    taskId: TaskIdSchema,
    title: shortTextSchema,
    objective: longTextSchema,
    parentTaskId: TaskIdSchema.optional(),
    initialStatus: z.literal('created'),
  })
  .strict()
export type TaskCreatedPayload = z.infer<typeof TaskCreatedPayloadSchema>

export const TaskTransitionedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    taskId: TaskIdSchema,
    fromStatus: TaskStatusSchema,
    toStatus: TaskStatusSchema,
    reason: shortTextSchema,
  })
  .strict()
  .refine((payload) => payload.fromStatus !== payload.toStatus, {
    message: 'Task transition must change status',
    path: ['toStatus'],
  })
export type TaskTransitionedPayload = z.infer<typeof TaskTransitionedPayloadSchema>

export const EvidenceAttachedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    observationId: ObservationIdSchema,
    evidence: z.array(MemoryEvidenceSchema).min(1).max(32),
  })
  .strict()
export type EvidenceAttachedPayload = z.infer<typeof EvidenceAttachedPayloadSchema>

export const ArtifactClassifiedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    artifactId: z.string().min(1).max(256),
    location: z.string().min(1).max(2_048),
    previousClassification: ArtifactClassificationSchema.optional(),
    classification: ArtifactClassificationSchema,
    provenance: MemoryProvenanceSchema,
  })
  .strict()
export type ArtifactClassifiedPayload = z.infer<typeof ArtifactClassifiedPayloadSchema>

export const ObservationRecordedPayloadSchema = z
  .object({ ...payloadVersionShape, observation: MemoryObservationSchema })
  .strict()
export type ObservationRecordedPayload = z.infer<typeof ObservationRecordedPayloadSchema>

export const CoverageRecordedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    taskId: TaskIdSchema,
    dimension: z.enum(['requirements', 'implementation', 'tests', 'validation', 'risk']),
    state: z.enum(['not-covered', 'partial', 'covered', 'not-applicable']),
    selectors: z.array(MemorySelectorSchema).max(64),
    notes: z.string().max(4_096),
    workspaceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    workspaceSnapshotId: z.string().min(1).max(256).optional(),
  })
  .strict()
export type CoverageRecordedPayload = z.infer<typeof CoverageRecordedPayloadSchema>

export const EvidenceVerifiedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    observationId: ObservationIdSchema,
    selector: MemorySelectorSchema,
    verifier: z.string().min(1).max(256),
    verifiedAt: timestampSchema,
    observedDigest: digestSchema.optional(),
    workspaceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    workspaceSnapshotId: z.string().min(1).max(256).optional(),
  })
  .strict()
export type EvidenceVerifiedPayload = z.infer<typeof EvidenceVerifiedPayloadSchema>

export const EvidenceInvalidatedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    observationId: ObservationIdSchema,
    selector: MemorySelectorSchema,
    reason: z.enum(['missing', 'changed', 'moved', 'unreadable', 'contradicted', 'expired']),
    detail: z.string().min(1).max(4_096),
    invalidatedAt: timestampSchema,
  })
  .strict()
export type EvidenceInvalidatedPayload = z.infer<typeof EvidenceInvalidatedPayloadSchema>

export const EvidenceReboundPayloadSchema = z
  .object({
    ...payloadVersionShape,
    observationId: ObservationIdSchema,
    previousSelector: MemorySelectorSchema,
    evidence: MemoryEvidenceSchema,
    reason: shortTextSchema,
  })
  .strict()
export type EvidenceReboundPayload = z.infer<typeof EvidenceReboundPayloadSchema>

export const ClaimConsolidatedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    sourceObservationIds: z.array(ObservationIdSchema).min(2).max(100),
    canonicalObservation: MemoryObservationSchema,
    reason: longTextSchema,
  })
  .strict()
export type ClaimConsolidatedPayload = z.infer<typeof ClaimConsolidatedPayloadSchema>

export const ClaimSupersededPayloadSchema = z
  .object({
    ...payloadVersionShape,
    observationId: ObservationIdSchema,
    supersededByObservationId: ObservationIdSchema,
    reason: longTextSchema,
  })
  .strict()
export type ClaimSupersededPayload = z.infer<typeof ClaimSupersededPayloadSchema>

export const ClaimCorrectedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    observationId: ObservationIdSchema,
    correction: MemoryObservationSchema,
    reason: longTextSchema,
  })
  .strict()
export type ClaimCorrectedPayload = z.infer<typeof ClaimCorrectedPayloadSchema>

export const ClaimForgottenPayloadSchema = z
  .object({
    ...payloadVersionShape,
    observationIds: z.array(ObservationIdSchema).min(1).max(100),
    reason: z.enum(['user-request', 'retention-policy', 'invalid', 'sensitive', 'duplicate']),
    requestedBy: z.string().min(1).max(256),
    evidenceDisposition: z.enum(['retain-artifacts', 'remove-references']),
  })
  .strict()
export type ClaimForgottenPayload = z.infer<typeof ClaimForgottenPayloadSchema>

export const ClaimPinnedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    observationId: ObservationIdSchema,
    reason: shortTextSchema,
    pinnedBy: z.string().min(1).max(256),
    pinnedAt: timestampSchema,
  })
  .strict()
export type ClaimPinnedPayload = z.infer<typeof ClaimPinnedPayloadSchema>

export const V1MigrationReservedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    migrationId: z.string().min(1).max(256),
    sourceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sourceChecksum: z.string().min(1).max(256),
  })
  .strict()
export type V1MigrationReservedPayload = z.infer<typeof V1MigrationReservedPayloadSchema>

export const V1MigrationPayloadSchema = z
  .object({
    ...payloadVersionShape,
    sourceSchemaVersion: z.literal(1),
    legacyRecordKey: z.string().min(1).max(512),
    importedTaskId: TaskIdSchema,
    importedObservationIds: z.array(ObservationIdSchema).max(100),
    sourceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    sourceChecksum: z.string().min(1).max(256).optional(),
    sourceItemCounts: z
      .record(
        z.string().min(1).max(64),
        z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      )
      .refine((value) => Object.keys(value).length <= 16, {
        message: 'sourceItemCounts may contain at most 16 keys',
      })
      .optional(),
    truncatedFields: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    omittedFields: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    warnings: z.array(z.string().min(1).max(1_024)).max(100),
  })
  .strict()
export type V1MigrationPayload = z.infer<typeof V1MigrationPayloadSchema>

export const ProjectionRebuildRequestedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    rebuildId: QueryIdSchema,
    projectionNames: z.array(z.string().min(1).max(128)).min(1).max(32),
    fromEventId: MemoryEventIdSchema.optional(),
    requestedBy: z.string().min(1).max(256),
  })
  .strict()
export type ProjectionRebuildRequestedPayload = z.infer<
  typeof ProjectionRebuildRequestedPayloadSchema
>

export const ProjectionRebuildCompletedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    rebuildId: QueryIdSchema,
    projectionNames: z.array(z.string().min(1).max(128)).min(1).max(32),
    processedEvents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    completedAt: timestampSchema,
  })
  .strict()
export type ProjectionRebuildCompletedPayload = z.infer<
  typeof ProjectionRebuildCompletedPayloadSchema
>

export const ProjectionRebuildFailedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    rebuildId: QueryIdSchema,
    projectionNames: z.array(z.string().min(1).max(128)).min(1).max(32),
    error: z.string().min(1).max(4_096),
    retryable: z.boolean(),
    failedAt: timestampSchema,
  })
  .strict()
export type ProjectionRebuildFailedPayload = z.infer<typeof ProjectionRebuildFailedPayloadSchema>

export const SessionStartedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    startedAt: timestampSchema,
  })
  .strict()
export type SessionStartedPayload = z.infer<typeof SessionStartedPayloadSchema>

const terminalStatusSchema = z.enum(['completed', 'failed', 'cancelled'])

export const SessionEndedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    status: terminalStatusSchema,
    endedAt: timestampSchema,
  })
  .strict()
export type SessionEndedPayload = z.infer<typeof SessionEndedPayloadSchema>

export const QueryStartedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    queryId: QueryIdSchema,
    taskId: TaskIdSchema,
    userInputId: z.string().min(1).max(MAX_ID_LENGTH),
    mode: z.enum(['shadow', 'inject']),
    startedAt: timestampSchema,
  })
  .strict()
export type QueryStartedPayload = z.infer<typeof QueryStartedPayloadSchema>

export const QueryCategoryCountsSchema = z
  .object({
    matchedTasks: z.number().int().nonnegative().max(MAX_ITEMS),
    verifiedKnowledge: z.number().int().nonnegative().max(MAX_ITEMS),
    reusableDiscovery: z.number().int().nonnegative().max(MAX_ITEMS),
    rereadRequired: z.number().int().nonnegative().max(MAX_ITEMS),
    historicalContext: z.number().int().nonnegative().max(MAX_ITEMS),
  })
  .strict()
export type QueryCategoryCounts = z.infer<typeof QueryCategoryCountsSchema>

export const QueryDegradationSummarySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none') }).strict(),
  z
    .object({
      state: z.literal('degraded'),
      reasons: z
        .array(
          z
            .object({
              code: z.enum([
                'backend-unavailable',
                'partial-projection',
                'verification-unavailable',
                'result-cap-reached',
                'authority-unavailable',
                'resource-budget',
              ]),
              retryable: z.boolean(),
            })
            .strict(),
        )
        .min(1)
        .max(16),
    })
    .strict(),
])
export type QueryDegradationSummary = z.infer<typeof QueryDegradationSummarySchema>

export const QueryCompletedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    queryId: QueryIdSchema,
    taskId: TaskIdSchema,
    completedAt: timestampSchema,
    counts: QueryCategoryCountsSchema,
    degradation: QueryDegradationSummarySchema,
  })
  .strict()
export type QueryCompletedPayload = z.infer<typeof QueryCompletedPayloadSchema>

export const QueryFailedPayloadSchema = z
  .object({
    ...payloadVersionShape,
    queryId: QueryIdSchema,
    taskId: TaskIdSchema,
    failedAt: timestampSchema,
    error: z.string().min(1).max(1_024),
    retryable: z.boolean(),
  })
  .strict()
export type QueryFailedPayload = z.infer<typeof QueryFailedPayloadSchema>

const eventDraft = <EventType extends string, Payload extends z.ZodType>(
  eventType: EventType,
  payload: Payload,
) =>
  z
    .object({
      schemaVersion: z.literal(2),
      eventSchemaVersion: z.literal(1),
      eventType: z.literal(eventType),
      eventId: MemoryEventIdSchema,
      projectId: ProjectIdSchema,
      sessionId: MemorySessionIdSchema,
      occurredAt: timestampSchema,
      payload,
    })
    .strict()

const eventEnvelope = <EventType extends string, Payload extends z.ZodType>(
  eventType: EventType,
  payload: Payload,
) =>
  eventDraft(eventType, payload).extend({
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })

export const MemoryEventDraftSchema = z.discriminatedUnion('eventType', [
  eventDraft('session.started', SessionStartedPayloadSchema),
  eventDraft('session.ended', SessionEndedPayloadSchema),
  eventDraft('query.started', QueryStartedPayloadSchema),
  eventDraft('query.completed', QueryCompletedPayloadSchema),
  eventDraft('query.failed', QueryFailedPayloadSchema),
  eventDraft('task.created', TaskCreatedPayloadSchema),
  eventDraft('task.transitioned', TaskTransitionedPayloadSchema),
  eventDraft('evidence.attached', EvidenceAttachedPayloadSchema),
  eventDraft('artifact.classified', ArtifactClassifiedPayloadSchema),
  eventDraft('observation.recorded', ObservationRecordedPayloadSchema),
  eventDraft('coverage.recorded', CoverageRecordedPayloadSchema),
  eventDraft('evidence.verified', EvidenceVerifiedPayloadSchema),
  eventDraft('evidence.invalidated', EvidenceInvalidatedPayloadSchema),
  eventDraft('evidence.rebound', EvidenceReboundPayloadSchema),
  eventDraft('claim.consolidated', ClaimConsolidatedPayloadSchema),
  eventDraft('claim.superseded', ClaimSupersededPayloadSchema),
  eventDraft('claim.corrected', ClaimCorrectedPayloadSchema),
  eventDraft('claim.forgotten', ClaimForgottenPayloadSchema),
  eventDraft('claim.pinned', ClaimPinnedPayloadSchema),
  eventDraft('migration.v1.reserved', V1MigrationReservedPayloadSchema),
  eventDraft('migration.v1.imported', V1MigrationPayloadSchema),
  eventDraft('projection.rebuild.requested', ProjectionRebuildRequestedPayloadSchema),
  eventDraft('projection.rebuild.completed', ProjectionRebuildCompletedPayloadSchema),
  eventDraft('projection.rebuild.failed', ProjectionRebuildFailedPayloadSchema),
])
export type MemoryEventDraft = z.infer<typeof MemoryEventDraftSchema>

export const MemoryEventEnvelopeSchema = z.discriminatedUnion('eventType', [
  eventEnvelope('session.started', SessionStartedPayloadSchema),
  eventEnvelope('session.ended', SessionEndedPayloadSchema),
  eventEnvelope('query.started', QueryStartedPayloadSchema),
  eventEnvelope('query.completed', QueryCompletedPayloadSchema),
  eventEnvelope('query.failed', QueryFailedPayloadSchema),
  eventEnvelope('task.created', TaskCreatedPayloadSchema),
  eventEnvelope('task.transitioned', TaskTransitionedPayloadSchema),
  eventEnvelope('evidence.attached', EvidenceAttachedPayloadSchema),
  eventEnvelope('artifact.classified', ArtifactClassifiedPayloadSchema),
  eventEnvelope('observation.recorded', ObservationRecordedPayloadSchema),
  eventEnvelope('coverage.recorded', CoverageRecordedPayloadSchema),
  eventEnvelope('evidence.verified', EvidenceVerifiedPayloadSchema),
  eventEnvelope('evidence.invalidated', EvidenceInvalidatedPayloadSchema),
  eventEnvelope('evidence.rebound', EvidenceReboundPayloadSchema),
  eventEnvelope('claim.consolidated', ClaimConsolidatedPayloadSchema),
  eventEnvelope('claim.superseded', ClaimSupersededPayloadSchema),
  eventEnvelope('claim.corrected', ClaimCorrectedPayloadSchema),
  eventEnvelope('claim.forgotten', ClaimForgottenPayloadSchema),
  eventEnvelope('claim.pinned', ClaimPinnedPayloadSchema),
  eventEnvelope('migration.v1.reserved', V1MigrationReservedPayloadSchema),
  eventEnvelope('migration.v1.imported', V1MigrationPayloadSchema),
  eventEnvelope('projection.rebuild.requested', ProjectionRebuildRequestedPayloadSchema),
  eventEnvelope('projection.rebuild.completed', ProjectionRebuildCompletedPayloadSchema),
  eventEnvelope('projection.rebuild.failed', ProjectionRebuildFailedPayloadSchema),
])
export type MemoryEventEnvelope = z.infer<typeof MemoryEventEnvelopeSchema>
export type MemoryEventType = MemoryEventEnvelope['eventType']

export const RankingReasonSchema = z
  .object({
    code: z.enum([
      'semantic-match',
      'task-match',
      'selector-match',
      'recency',
      'verified-evidence',
      'reusability',
      'historical-only',
      'stale-evidence',
      'authority-penalty',
    ]),
    contribution: z.number().min(-1).max(1),
    detail: z.string().min(1).max(1_024),
  })
  .strict()
export type RankingReason = z.infer<typeof RankingReasonSchema>

const rankedShape = {
  score: z.number().min(0).max(1),
  reasons: z.array(RankingReasonSchema).min(1).max(16),
} as const

export const MemoryRetrievalRequestSchema = z
  .object({
    schemaVersion: z.literal(2),
    queryId: QueryIdSchema,
    projectId: ProjectIdSchema,
    sessionId: MemorySessionIdSchema,
    query: z.string().min(1).max(8_192),
    taskId: TaskIdSchema.optional(),
    workspaceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    workspaceSnapshotId: z.string().min(1).max(256).optional(),
    selectors: z.array(MemorySelectorSchema).max(32),
    artifactKinds: z.array(ArtifactClassificationSchema.shape.kind).max(16),
    includeHistorical: z.boolean(),
    maxResultsPerCategory: z.number().int().positive().max(MAX_ITEMS),
  })
  .strict()
export type MemoryRetrievalRequest = z.infer<typeof MemoryRetrievalRequestSchema>

export const MatchedTaskSchema = z
  .object({
    taskId: TaskIdSchema,
    title: shortTextSchema,
    status: TaskStatusSchema,
    summary: longTextSchema,
    ...rankedShape,
  })
  .strict()
export type MatchedTask = z.infer<typeof MatchedTaskSchema>

export const VerifiedKnowledgeSchema = z
  .object({
    observation: MemoryObservationSchema,
    verifiedEvidence: z.array(MemoryEvidenceSchema).min(1).max(32),
    verifiedAt: timestampSchema,
    ...rankedShape,
  })
  .strict()
  .superRefine((knowledge, context) => {
    knowledge.verifiedEvidence.forEach((evidence, index) => {
      if ('path' in evidence.selector && evidence.contentDigest === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Verified path-backed evidence must include a content digest',
          path: ['verifiedEvidence', index, 'contentDigest'],
        })
      }
    })
  })
export type VerifiedKnowledge = z.infer<typeof VerifiedKnowledgeSchema>

export const ReusableDiscoverySchema = z
  .object({
    observation: MemoryObservationSchema,
    reuseGuidance: z.string().min(1).max(4_096),
    ...rankedShape,
  })
  .strict()
export type ReusableDiscovery = z.infer<typeof ReusableDiscoverySchema>

export const RereadRequiredSchema = z
  .object({
    observationId: ObservationIdSchema,
    selector: MemorySelectorSchema,
    reason: z.enum(['never-verified', 'changed', 'missing', 'expired', 'authority-unavailable']),
    detail: z.string().min(1).max(1_024),
    ...rankedShape,
  })
  .strict()
export type RereadRequired = z.infer<typeof RereadRequiredSchema>

export const HistoricalContextSchema = z
  .object({
    taskId: TaskIdSchema.optional(),
    summary: longTextSchema,
    eventIds: z.array(MemoryEventIdSchema).min(1).max(100),
    ...rankedShape,
  })
  .strict()
export type HistoricalContext = z.infer<typeof HistoricalContextSchema>

export const RetrievalDegradationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none') }).strict(),
  z
    .object({
      state: z.literal('degraded'),
      reasons: z
        .array(
          z
            .object({
              code: z.enum([
                'backend-unavailable',
                'partial-projection',
                'verification-unavailable',
                'result-cap-reached',
                'authority-unavailable',
                'resource-budget',
              ]),
              detail: z.string().min(1).max(1_024),
              retryable: z.boolean(),
            })
            .strict(),
        )
        .min(1)
        .max(16),
    })
    .strict(),
])
export type RetrievalDegradation = z.infer<typeof RetrievalDegradationSchema>

export const RankingReasonGroupSchema = z
  .object({
    category: z.enum([
      'matchedTasks',
      'verifiedKnowledge',
      'reusableDiscovery',
      'rereadRequired',
      'historicalContext',
    ]),
    targetId: z.string().min(1).max(256),
    reasons: z.array(RankingReasonSchema).min(1).max(16),
  })
  .strict()
export type RankingReasonGroup = z.infer<typeof RankingReasonGroupSchema>

export const CurrentCoverageItemSchema = z
  .object({
    dimension: z.enum(['requirements', 'implementation', 'tests', 'validation', 'risk']),
    state: z.enum(['not-covered', 'partial', 'covered', 'not-applicable']),
    taskId: TaskIdSchema,
    notes: z.string().max(1_024).optional(),
    workspaceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    workspaceSnapshotId: z.string().min(1).max(256).optional(),
  })
  .strict()
export type CurrentCoverageItem = z.infer<typeof CurrentCoverageItemSchema>

export const MemoryRetrievalResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    queryId: QueryIdSchema,
    projectId: ProjectIdSchema,
    generatedAt: timestampSchema,
    matchedTasks: z.array(MatchedTaskSchema).max(MAX_ITEMS),
    verifiedKnowledge: z.array(VerifiedKnowledgeSchema).max(MAX_ITEMS),
    reusableDiscovery: z.array(ReusableDiscoverySchema).max(MAX_ITEMS),
    rereadRequired: z.array(RereadRequiredSchema).max(MAX_ITEMS),
    historicalContext: z.array(HistoricalContextSchema).max(MAX_ITEMS),
    currentCoverage: z.array(CurrentCoverageItemSchema).max(5).default([]),
    degradation: RetrievalDegradationSchema,
    rankingReasons: z.array(RankingReasonGroupSchema).max(MAX_ITEMS * 5),
  })
  .strict()
  .superRefine((result, context) => {
    const verifiedObservationIds = new Set(
      result.verifiedKnowledge.map((item) => item.observation.observationId),
    )
    result.rereadRequired.forEach((item, index) => {
      if (verifiedObservationIds.has(item.observationId)) {
        context.addIssue({
          code: 'custom',
          message: 'An observation cannot be both verified and reread-required',
          path: ['rereadRequired', index, 'observationId'],
        })
      }
    })
  })
export type MemoryRetrievalResult = z.infer<typeof MemoryRetrievalResultSchema>

/** Strict plain-JSON retrieval context attached to one trusted user turn. */
export const MemoryTurnContextV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    userInputId: z.string().min(1).max(MAX_ID_LENGTH),
    queryId: QueryIdSchema,
    taskId: TaskIdSchema.optional(),
    result: MemoryRetrievalResultSchema,
  })
  .strict()
  .refine((context) => context.result.queryId === context.queryId, {
    message: 'Retrieval result queryId must match the turn queryId',
    path: ['result', 'queryId'],
  })
export type MemoryTurnContextV2 = z.infer<typeof MemoryTurnContextV2Schema>

export const MemoryAuthoritySchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('authoritative'), writable: z.literal(true), source: shortTextSchema })
    .strict(),
  z
    .object({
      kind: z.literal('read-only'),
      writable: z.literal(false),
      source: shortTextSchema,
      reason: shortTextSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      writable: z.literal(false),
      reason: shortTextSchema,
    })
    .strict(),
])
export type MemoryAuthority = z.infer<typeof MemoryAuthoritySchema>

export const MemoryBackendSchema = z
  .object({
    backendId: z.string().min(1).max(128),
    kind: z.enum(['in-memory', 'local-persistent', 'remote', 'custom']),
    persistence: z.enum(['ephemeral', 'durable', 'unknown']),
    capabilities: z
      .array(z.enum(['append', 'query', 'verify', 'rebuild', 'health', 'export']))
      .max(6),
  })
  .strict()
export type MemoryBackend = z.infer<typeof MemoryBackendSchema>

export const MemoryHealthSchema = z
  .object({
    schemaVersion: z.literal(2),
    status: z.enum(['healthy', 'degraded', 'unavailable']),
    checkedAt: timestampSchema,
    authority: MemoryAuthoritySchema,
    backend: MemoryBackendSchema,
    issues: z.array(z.string().min(1).max(1_024)).max(32),
  })
  .strict()
export type MemoryHealth = z.infer<typeof MemoryHealthSchema>

export const MemoryOperationErrorSchema = z
  .object({
    code: z.enum([
      'invalid-request',
      'conflict',
      'not-authoritative',
      'not-found',
      'unavailable',
      'internal',
    ]),
    message: z.string().min(1).max(4_096),
    retryable: z.boolean(),
  })
  .strict()
export type MemoryOperationError = z.infer<typeof MemoryOperationErrorSchema>

export const MemoryExpectedTailSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('any') }).strict(),
  z.object({ kind: z.literal('empty') }).strict(),
  z.object({ kind: z.literal('event'), eventId: MemoryEventIdSchema }).strict(),
])
export type MemoryExpectedTail = z.infer<typeof MemoryExpectedTailSchema>

export const MemoryAppendRequestSchema = z
  .object({
    schemaVersion: z.literal(2),
    projectId: ProjectIdSchema,
    events: z.array(MemoryEventDraftSchema).min(1).max(MAX_ITEMS),
    expectedTail: MemoryExpectedTailSchema.optional(),
    expectedLastEventId: MemoryEventIdSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.expectedTail !== undefined && request.expectedLastEventId !== undefined) {
      if (
        request.expectedTail.kind !== 'event' ||
        request.expectedTail.eventId !== request.expectedLastEventId
      ) {
        context.addIssue({
          code: 'custom',
          message: 'expectedTail and expectedLastEventId must describe the same event tail',
          path: ['expectedTail'],
        })
      }
    }
    request.events.forEach((event, index) => {
      if (event.projectId !== request.projectId) {
        context.addIssue({
          code: 'custom',
          message: 'Event projectId must match the append request projectId',
          path: ['events', index, 'projectId'],
        })
      }
    })
  })
export type MemoryAppendRequest = z.infer<typeof MemoryAppendRequestSchema>

export const MemoryAppendEntrySchema = z
  .object({
    eventId: MemoryEventIdSchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    duplicate: z.boolean(),
  })
  .strict()
export type MemoryAppendEntry = z.infer<typeof MemoryAppendEntrySchema>

export const MemoryAppendOutcomeSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('appended'),
      entries: z.array(MemoryAppendEntrySchema).min(1).max(MAX_ITEMS),
      lastEventId: MemoryEventIdSchema,
    })
    .strict(),
  z.object({ outcome: z.literal('rejected'), error: MemoryOperationErrorSchema }).strict(),
  z.object({ outcome: z.literal('failed'), error: MemoryOperationErrorSchema }).strict(),
])
export type MemoryAppendOutcome = z.infer<typeof MemoryAppendOutcomeSchema>

export const MemoryQueryOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('result'), result: MemoryRetrievalResultSchema }).strict(),
  z.object({ outcome: z.literal('rejected'), error: MemoryOperationErrorSchema }).strict(),
  z.object({ outcome: z.literal('failed'), error: MemoryOperationErrorSchema }).strict(),
])
export type MemoryQueryOutcome = z.infer<typeof MemoryQueryOutcomeSchema>

export const MemoryVerifyRequestSchema = z
  .object({
    schemaVersion: z.literal(2),
    projectId: ProjectIdSchema,
    sessionId: MemorySessionIdSchema,
    workspaceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    workspaceSnapshotId: z.string().min(1).max(256).optional(),
    action: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('verify'),
          observationId: ObservationIdSchema,
          selector: MemorySelectorSchema,
          observedDigest: digestSchema.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('invalidate'),
          observationId: ObservationIdSchema,
          selector: MemorySelectorSchema,
          reason: EvidenceInvalidatedPayloadSchema.shape.reason,
          detail: z.string().min(1).max(4_096),
        })
        .strict(),
      z
        .object({
          kind: z.literal('rebind'),
          observationId: ObservationIdSchema,
          previousSelector: MemorySelectorSchema,
          evidence: MemoryEvidenceSchema,
          reason: shortTextSchema,
        })
        .strict(),
    ]),
  })
  .strict()
export type MemoryVerifyRequest = z.infer<typeof MemoryVerifyRequestSchema>

export const MemoryVerifyOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('recorded'), event: MemoryEventEnvelopeSchema }).strict(),
  z.object({ outcome: z.literal('rejected'), error: MemoryOperationErrorSchema }).strict(),
  z.object({ outcome: z.literal('failed'), error: MemoryOperationErrorSchema }).strict(),
])
export type MemoryVerifyOutcome = z.infer<typeof MemoryVerifyOutcomeSchema>

export const MemoryRebuildRequestSchema = z
  .object({
    schemaVersion: z.literal(2),
    projectId: ProjectIdSchema,
    rebuildId: QueryIdSchema,
    projectionNames: z.array(z.string().min(1).max(128)).min(1).max(32),
    fromEventId: MemoryEventIdSchema.optional(),
  })
  .strict()
export type MemoryRebuildRequest = z.infer<typeof MemoryRebuildRequestSchema>

export const MemoryRebuildOutcomeSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('rebuilt'),
      rebuildId: QueryIdSchema,
      processedEvents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ outcome: z.literal('rejected'), error: MemoryOperationErrorSchema }).strict(),
  z.object({ outcome: z.literal('failed'), error: MemoryOperationErrorSchema }).strict(),
])
export type MemoryRebuildOutcome = z.infer<typeof MemoryRebuildOutcomeSchema>

export const MemoryHealthRequestSchema = z
  .object({ schemaVersion: z.literal(2), projectId: ProjectIdSchema.optional() })
  .strict()
export type MemoryHealthRequest = z.infer<typeof MemoryHealthRequestSchema>

export const MemoryExportRequestSchema = z
  .object({
    schemaVersion: z.literal(2),
    projectId: ProjectIdSchema,
    afterEventId: MemoryEventIdSchema.optional(),
    limit: z.number().int().positive().max(1_000),
  })
  .strict()
export type MemoryExportRequest = z.infer<typeof MemoryExportRequestSchema>

export const MemoryExportOutcomeSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('page'),
      events: z.array(MemoryEventEnvelopeSchema).max(1_000),
      nextAfterEventId: MemoryEventIdSchema.nullable(),
    })
    .strict(),
  z.object({ outcome: z.literal('rejected'), error: MemoryOperationErrorSchema }).strict(),
  z.object({ outcome: z.literal('failed'), error: MemoryOperationErrorSchema }).strict(),
])
export type MemoryExportOutcome = z.infer<typeof MemoryExportOutcomeSchema>

const operatorScopeShape = {
  schemaVersion: z.literal(2),
  projectId: ProjectIdSchema,
  sessionId: MemorySessionIdSchema,
} as const
const operationModeSchema = z.enum(['preview', 'apply'])

export const MemoryConsolidationCandidateSchema = z
  .object({
    taskId: TaskIdSchema,
    facet: z.string().min(1).max(2_048),
    observationKind: MemoryObservationSchema.shape.kind,
    sourceObservationIds: z.array(ObservationIdSchema).min(2).max(32),
    canonicalObservationId: ObservationIdSchema,
  })
  .strict()
export type MemoryConsolidationCandidate = z.infer<typeof MemoryConsolidationCandidateSchema>

export const MemoryConsolidationRequestSchema = z
  .object({
    ...operatorScopeShape,
    taskId: TaskIdSchema.optional(),
    policyVersion: z.string().min(1).max(128),
    mode: operationModeSchema,
    occurredAt: timestampSchema,
    maxGroups: z.number().int().positive().max(5).default(5),
  })
  .strict()
export type MemoryConsolidationRequest = z.infer<typeof MemoryConsolidationRequestSchema>

const consolidationResultShape = {
  candidates: z.array(MemoryConsolidationCandidateSchema).max(5),
  plannedEvents: z.array(MemoryEventDraftSchema).max(100),
} as const
export const MemoryConsolidationOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('preview'), ...consolidationResultShape }).strict(),
  z
    .object({
      outcome: z.literal('applied'),
      ...consolidationResultShape,
      entries: z.array(MemoryAppendEntrySchema).max(100),
    })
    .strict(),
  z.object({ outcome: z.literal('no-op'), reason: shortTextSchema }).strict(),
  z.object({ outcome: z.literal('rejected'), error: MemoryOperationErrorSchema }).strict(),
  z.object({ outcome: z.literal('failed'), error: MemoryOperationErrorSchema }).strict(),
])
export type MemoryConsolidationOutcome = z.infer<typeof MemoryConsolidationOutcomeSchema>

export const MemoryCorrectionActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('correct'),
      observationId: ObservationIdSchema,
      correction: MemoryObservationSchema,
      reason: longTextSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('forget'),
      observationIds: z.array(ObservationIdSchema).min(1).max(100),
      reason: ClaimForgottenPayloadSchema.shape.reason,
      requestedBy: z.string().min(1).max(256),
      evidenceDisposition: ClaimForgottenPayloadSchema.shape.evidenceDisposition,
    })
    .strict(),
  z
    .object({
      kind: z.literal('pin'),
      observationId: ObservationIdSchema,
      reason: shortTextSchema,
      pinnedBy: z.string().min(1).max(256),
    })
    .strict(),
])
export type MemoryCorrectionAction = z.infer<typeof MemoryCorrectionActionSchema>

export const MemoryCorrectionRequestSchema = z
  .object({
    ...operatorScopeShape,
    taskId: TaskIdSchema,
    mode: operationModeSchema,
    occurredAt: timestampSchema,
    action: MemoryCorrectionActionSchema,
  })
  .strict()
export type MemoryCorrectionRequest = z.infer<typeof MemoryCorrectionRequestSchema>

export const MemoryCorrectionOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('preview'), plannedEvents: z.array(MemoryEventDraftSchema).min(1).max(1) }).strict(),
  z.object({ outcome: z.literal('applied'), plannedEvents: z.array(MemoryEventDraftSchema).min(1).max(1), entry: MemoryAppendEntrySchema }).strict(),
  z.object({ outcome: z.literal('no-op'), reason: shortTextSchema }).strict(),
  z.object({ outcome: z.literal('rejected'), error: MemoryOperationErrorSchema }).strict(),
  z.object({ outcome: z.literal('failed'), error: MemoryOperationErrorSchema }).strict(),
])
export type MemoryCorrectionOutcome = z.infer<typeof MemoryCorrectionOutcomeSchema>

export const MemoryRevalidationRequestSchema = z
  .object({
    ...operatorScopeShape,
    taskId: TaskIdSchema,
    mode: operationModeSchema,
    actions: z.array(MemoryVerifyRequestSchema.shape.action).min(1).max(100),
  })
  .strict()
export type MemoryRevalidationRequest = z.infer<typeof MemoryRevalidationRequestSchema>

export const MemoryRevalidationResultSchema = z
  .object({ action: MemoryVerifyRequestSchema.shape.action, result: MemoryVerifyOutcomeSchema })
  .strict()
export type MemoryRevalidationResult = z.infer<typeof MemoryRevalidationResultSchema>

export const MemoryRevalidationOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('preview'), actions: z.array(MemoryVerifyRequestSchema.shape.action).min(1).max(100) }).strict(),
  z.object({ outcome: z.literal('applied'), results: z.array(MemoryRevalidationResultSchema).min(1).max(100) }).strict(),
  z.object({ outcome: z.literal('rejected'), error: MemoryOperationErrorSchema }).strict(),
  z.object({ outcome: z.literal('failed'), error: MemoryOperationErrorSchema }).strict(),
])
export type MemoryRevalidationOutcome = z.infer<typeof MemoryRevalidationOutcomeSchema>

export const MemoryProjectionRepairRequestSchema = z
  .object({
    ...operatorScopeShape,
    mode: operationModeSchema,
    rebuildId: QueryIdSchema,
    projectionNames: z.array(z.string().min(1).max(128)).min(1).max(32),
    fromEventId: MemoryEventIdSchema.optional(),
  })
  .strict()
export type MemoryProjectionRepairRequest = z.infer<typeof MemoryProjectionRepairRequestSchema>

const canonicalIntegrityShape = {
  eventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  checksum: digestSchema,
} as const
export const MemoryProjectionRepairOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('preview'), before: z.object(canonicalIntegrityShape).strict() }).strict(),
  z.object({ outcome: z.literal('repaired'), before: z.object(canonicalIntegrityShape).strict(), after: z.object(canonicalIntegrityShape).strict(), rebuild: MemoryRebuildOutcomeSchema }).strict(),
  z.object({ outcome: z.literal('integrity-mismatch'), before: z.object(canonicalIntegrityShape).strict(), after: z.object(canonicalIntegrityShape).strict() }).strict(),
  z.object({ outcome: z.literal('rejected'), error: MemoryOperationErrorSchema }).strict(),
  z.object({ outcome: z.literal('failed'), error: MemoryOperationErrorSchema }).strict(),
])
export type MemoryProjectionRepairOutcome = z.infer<typeof MemoryProjectionRepairOutcomeSchema>

export const MemoryExportEventV2Schema = z
  .object({
    event: MemoryEventEnvelopeSchema,
    lifecycle: z.enum(['active', 'stale']),
    staleReasons: z.array(z.enum(['forgotten', 'superseded', 'corrected'])).max(3),
  })
  .strict()
export type MemoryExportEventV2 = z.infer<typeof MemoryExportEventV2Schema>

export const MemoryExportManifestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    manifestVersion: z.literal(2),
    format: z.literal('memory-v2-json'),
    projectId: ProjectIdSchema,
    generatedAt: timestampSchema,
    canonicalEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    canonicalSequenceRange: z
      .object({ first: z.number().int().nonnegative(), last: z.number().int().nonnegative() })
      .strict()
      .nullable(),
    events: z.array(MemoryExportEventV2Schema).max(10_000),
    health: MemoryHealthSchema,
    checksum: digestSchema,
    labels: z.object({ generated: z.literal(true), authoritative: z.literal(false) }).strict(),
    stalePolicy: z.object({ includeStale: z.boolean(), excludedEventCount: z.number().int().nonnegative().max(10_000) }).strict(),
    warnings: z.array(z.string().min(1).max(1_024)).max(100),
  })
  .strict()
export type MemoryExportManifestV2 = z.infer<typeof MemoryExportManifestV2Schema>

export const MemoryManifestExportRequestSchema = z
  .object({
    schemaVersion: z.literal(2),
    projectId: ProjectIdSchema,
    generatedAt: timestampSchema,
    includeStale: z.boolean().default(false),
    rendering: z.enum(['json', 'json-and-markdown']).default('json'),
  })
  .strict()
export type MemoryManifestExportRequest = z.infer<typeof MemoryManifestExportRequestSchema>

export const MemoryManifestExportOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('exported'), manifest: MemoryExportManifestV2Schema, markdown: z.string().max(1_000_000).optional() }).strict(),
  z.object({ outcome: z.literal('rejected'), error: MemoryOperationErrorSchema }).strict(),
  z.object({ outcome: z.literal('failed'), error: MemoryOperationErrorSchema }).strict(),
])
export type MemoryManifestExportOutcome = z.infer<typeof MemoryManifestExportOutcomeSchema>

export const MemoryManifestImportRequestSchema = z
  .object({
    schemaVersion: z.literal(2),
    projectId: ProjectIdSchema,
    manifest: MemoryExportManifestV2Schema,
    rebuildId: QueryIdSchema,
    projectionNames: z.array(z.string().min(1).max(128)).min(1).max(32),
    pageSize: z.number().int().positive().max(100).default(100),
  })
  .strict()
  .refine((request) => request.manifest.projectId === request.projectId, {
    message: 'Manifest projectId must match the import request projectId',
    path: ['manifest', 'projectId'],
  })
export type MemoryManifestImportRequest = z.infer<typeof MemoryManifestImportRequestSchema>

export const MemoryManifestImportOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('imported'), importedEvents: z.number().int().nonnegative().max(10_000), rebuild: MemoryRebuildOutcomeSchema }).strict(),
  z.object({ outcome: z.literal('no-op'), reason: shortTextSchema }).strict(),
  z.object({ outcome: z.literal('rejected'), error: MemoryOperationErrorSchema }).strict(),
  z.object({ outcome: z.literal('failed'), error: MemoryOperationErrorSchema }).strict(),
])
export type MemoryManifestImportOutcome = z.infer<typeof MemoryManifestImportOutcomeSchema>
