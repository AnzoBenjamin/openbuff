import { describe, expect, test } from 'bun:test'

import { getInitialAgentState } from '../session-state'
import {
  CoverageRecordedPayloadSchema,
  CurrentCoverageItemSchema,
  EvidenceVerifiedPayloadSchema,
  MemoryAppendOutcomeSchema,
  MemoryAppendRequestSchema,
  MemoryExpectedTailSchema,
  MemoryAuthorityModeSchema,
  MemoryEventDraftSchema,
  MemoryEventEnvelopeSchema,
  MemoryConsolidationRequestSchema,
  MemoryCorrectionRequestSchema,
  MemoryExportManifestV2Schema,
  MemoryJsonValueSchema,
  MemoryManifestImportRequestSchema,
  MemoryProjectionRepairRequestSchema,
  MemoryRevalidationRequestSchema,
  MemoryRetrievalRequestSchema,
  MemoryRetrievalResultSchema,
  MemorySelectorSchema,
  MemoryEvidenceSchema,
  MemoryProvenanceSchema,
  MemoryTurnContextV2Schema,
  ProjectIdSchema,
  QueryDegradationSummarySchema,
  RetrievalDegradationSchema,
  V1MigrationPayloadSchema,
  V1MigrationReservedPayloadSchema,
  type MemoryEventId,
} from '../memory-v2'

const timestamp = '2026-09-10T19:41:53.753Z'

const baseEvent = {
  schemaVersion: 2,
  eventSchemaVersion: 1,
  eventId: 'event:1',
  projectId: 'project:demo',
  sessionId: 'session:1',
  sequence: 1,
  occurredAt: timestamp,
}

const provenance = {
  origin: 'tool',
  recordedBy: 'memory-test',
  sourceEventIds: [],
  toolName: 'read_files',
  metadata: {},
}

const classification = {
  kind: 'source',
  language: 'typescript',
  generated: false,
  sensitivity: 'internal',
  labels: ['memory'],
}

const evidence = {
  artifact: {
    artifactId: 'artifact:memory-v2',
    location: 'common/src/types/memory-v2.ts',
    digest: 'sha256:0123456789abcdef',
    classification,
  },
  selector: {
    kind: 'symbol',
    path: 'common/src/types/memory-v2.ts',
    symbol: 'MemoryEventEnvelopeSchema',
    occurrence: 1,
  },
  provenance,
  capturedAt: timestamp,
  contentDigest: 'sha256:fedcba9876543210',
}

const observation = {
  observationId: 'observation:1',
  taskId: 'task:1',
  kind: 'discovery',
  summary: 'Memory V2 is schema validated',
  detail: 'The event envelope validates its payload through a discriminated union.',
  confidence: 0.95,
  evidence: [evidence],
  tags: ['contracts'],
  observedAt: timestamp,
}

const rankingReason = {
  code: 'verified-evidence',
  contribution: 0.8,
  detail: 'The selector was verified against the artifact digest.',
}

describe('Memory V2 bounded shared contracts', () => {
  test('accepts 32 nested JSON containers and rejects 33 with a bounded message', () => {
    let depth32: unknown = 'value'
    for (let depth = 0; depth < 32; depth += 1) {
      depth32 = [depth32]
    }

    expect(MemoryJsonValueSchema.safeParse(depth32).success).toBe(true)

    const depth33 = [depth32]
    const result = MemoryJsonValueSchema.safeParse(depth33)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).toContain(
        'Memory JSON values may contain at most 32 nested containers',
      )
    }
  })

  test('accepts resource-budget query and retrieval degradation', () => {
    expect(
      QueryDegradationSummarySchema.safeParse({
        state: 'degraded',
        reasons: [{ code: 'resource-budget', retryable: true }],
      }).success,
    ).toBe(true)
    expect(
      RetrievalDegradationSchema.safeParse({
        state: 'degraded',
        reasons: [
          {
            code: 'resource-budget',
            detail: 'The bounded scan stopped at its payload budget.',
            retryable: false,
          },
        ],
      }).success,
    ).toBe(true)
  })

  test('accepts workspace freshness fields on verified evidence', () => {
    const payload = {
      payloadSchemaVersion: 1,
      observationId: 'observation:1',
      selector: evidence.selector,
      verifier: 'memory-test',
      verifiedAt: timestamp,
      workspaceRevision: 7,
      workspaceSnapshotId: 'snapshot:7',
    }

    expect(EvidenceVerifiedPayloadSchema.parse(payload)).toEqual(payload)
  })

  test('accepts a strict bounded V1 migration reservation payload', () => {
    const payload = {
      payloadSchemaVersion: 1,
      migrationId: 'v1:3:revision-owner',
      sourceRevision: 3,
      sourceChecksum: 'checksum:source',
    }
    expect(V1MigrationReservedPayloadSchema.parse(payload)).toEqual(payload)
    expect(V1MigrationReservedPayloadSchema.safeParse({ ...payload, unexpected: true }).success).toBe(false)
    expect(V1MigrationReservedPayloadSchema.safeParse({ ...payload, migrationId: 'x'.repeat(257) }).success).toBe(false)
  })

  test('bounds V1 migration source item counts and accepts truncation metadata', () => {
    const payload = {
      payloadSchemaVersion: 1,
      sourceSchemaVersion: 1,
      legacyRecordKey: 'legacy-task-memory',
      importedTaskId: 'task:1',
      importedObservationIds: ['observation:1'],
      sourceItemCounts: { tasks: 1, observations: 4 },
      truncatedFields: 2,
      warnings: [],
    }

    expect(V1MigrationPayloadSchema.parse(payload)).toEqual(payload)
    expect(
      V1MigrationPayloadSchema.safeParse({
        ...payload,
        sourceItemCounts: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`source-${index}`, index]),
        ),
      }).success,
    ).toBe(false)
  })
})

describe('Memory V2 event contracts', () => {
  test('keeps Memory V2 state optional and plain-JSON compatible', () => {
    const state = getInitialAgentState()
    expect(state.memoryV2).toBeUndefined()
    expect(state.memoryAuthority).toBeUndefined()
    expect(state.memoryV2Context).toBeUndefined()
    expect(structuredClone(state).memoryV2).toBeUndefined()
    expect(structuredClone(state).memoryAuthority).toBeUndefined()
    expect(structuredClone(state).memoryV2Context).toBeUndefined()
  })

  test.each([
    {
      ...baseEvent,
      eventType: 'task.created',
      payload: {
        payloadSchemaVersion: 1,
        taskId: 'task:1',
        title: 'Add Memory V2',
        objective: 'Publish additive contracts.',
        initialStatus: 'created',
      },
    },
    {
      ...baseEvent,
      eventId: 'event:2',
      sequence: 2,
      eventType: 'artifact.classified',
      payload: {
        payloadSchemaVersion: 1,
        artifactId: 'artifact:memory-v2',
        location: 'common/src/types/memory-v2.ts',
        classification,
        provenance,
      },
    },
    {
      ...baseEvent,
      eventId: 'event:3',
      sequence: 3,
      eventType: 'observation.recorded',
      payload: { payloadSchemaVersion: 1, observation },
    },
    {
      ...baseEvent,
      eventId: 'event:4',
      sequence: 4,
      eventType: 'evidence.verified',
      payload: {
        payloadSchemaVersion: 1,
        observationId: 'observation:1',
        selector: evidence.selector,
        verifier: 'memory-test',
        verifiedAt: timestamp,
        observedDigest: 'sha256:fedcba9876543210',
      },
    },
    {
      ...baseEvent,
      eventId: 'event:5',
      sequence: 5,
      eventType: 'claim.consolidated',
      payload: {
        payloadSchemaVersion: 1,
        sourceObservationIds: ['observation:old-1', 'observation:old-2'],
        canonicalObservation: observation,
        reason: 'The observations describe the same validated contract.',
      },
    },
    {
      ...baseEvent,
      eventId: 'event:reserved',
      sequence: 6,
      eventType: 'migration.v1.reserved',
      payload: {
        payloadSchemaVersion: 1,
        migrationId: 'v1:3:revision-owner',
        sourceRevision: 3,
        sourceChecksum: 'checksum:source',
      },
    },
    {
      ...baseEvent,
      eventId: 'event:6',
      sequence: 6,
      eventType: 'migration.v1.imported',
      payload: {
        payloadSchemaVersion: 1,
        sourceSchemaVersion: 1,
        legacyRecordKey: 'legacy-task-memory',
        importedTaskId: 'task:1',
        importedObservationIds: ['observation:1'],
        warnings: [],
      },
    },
    {
      ...baseEvent,
      eventId: 'event:7',
      sequence: 7,
      eventType: 'projection.rebuild.completed',
      payload: {
        payloadSchemaVersion: 1,
        rebuildId: 'rebuild:1',
        projectionNames: ['verified-knowledge'],
        processedEvents: 7,
        completedAt: timestamp,
      },
    },
    {
      ...baseEvent,
      eventId: 'event:8',
      sequence: 8,
      eventType: 'claim.pinned',
      payload: {
        payloadSchemaVersion: 1,
        observationId: 'observation:1',
        reason: 'Keep this claim visible',
        pinnedBy: 'memory-test',
        pinnedAt: timestamp,
      },
    },
  ])('accepts representative $eventType events', (event) => {
    expect(MemoryEventEnvelopeSchema.parse(event)).toEqual(event)
  })

  test('accepts strict lifecycle payloads and bounds visible query failures', () => {
    const lifecycleEvents = [
      {
        ...baseEvent,
        eventType: 'session.started',
        payload: { payloadSchemaVersion: 1, startedAt: timestamp },
      },
      {
        ...baseEvent,
        eventType: 'session.ended',
        payload: { payloadSchemaVersion: 1, status: 'completed', endedAt: timestamp },
      },
      {
        ...baseEvent,
        eventType: 'query.started',
        payload: {
          payloadSchemaVersion: 1,
          queryId: 'query:1',
          taskId: 'task:1',
          userInputId: 'input:1',
          mode: 'shadow',
          startedAt: timestamp,
        },
      },
      {
        ...baseEvent,
        eventType: 'query.completed',
        payload: {
          payloadSchemaVersion: 1,
          queryId: 'query:1',
          taskId: 'task:1',
          completedAt: timestamp,
          counts: {
            matchedTasks: 1,
            verifiedKnowledge: 2,
            reusableDiscovery: 3,
            rereadRequired: 4,
            historicalContext: 5,
          },
          degradation: {
            state: 'degraded',
            reasons: [{ code: 'verification-unavailable', retryable: false }],
          },
        },
      },
      {
        ...baseEvent,
        eventType: 'query.failed',
        payload: {
          payloadSchemaVersion: 1,
          queryId: 'query:1',
          taskId: 'task:1',
          failedAt: timestamp,
          error: 'Repository unavailable',
          retryable: true,
        },
      },
    ]

    for (const event of lifecycleEvents) {
      expect(MemoryEventEnvelopeSchema.safeParse(event).success).toBe(true)
    }
    expect(
      MemoryEventEnvelopeSchema.safeParse({
        ...lifecycleEvents[3],
        payload: { ...lifecycleEvents[3]!.payload, rawResults: ['not allowed'] },
      }).success,
    ).toBe(false)
    expect(
      MemoryEventEnvelopeSchema.safeParse({
        ...lifecycleEvents[4],
        payload: { ...lifecycleEvents[4]!.payload, error: 'x'.repeat(1_025) },
      }).success,
    ).toBe(false)
  })

  test('separates producer drafts from sequenced committed events', () => {
    const draft = MemoryEventDraftSchema.parse({
      schemaVersion: 2,
      eventSchemaVersion: 1,
      eventType: 'task.created',
      eventId: 'event:draft',
      projectId: 'project:demo',
      sessionId: 'session:1',
      occurredAt: timestamp,
      payload: {
        payloadSchemaVersion: 1,
        taskId: 'task:1',
        title: 'Append a draft',
        objective: 'Let the repository assign its sequence.',
        initialStatus: 'created',
      },
    })
    const request = MemoryAppendRequestSchema.parse({
      schemaVersion: 2,
      projectId: 'project:demo',
      events: [draft],
    })
    const outcome = MemoryAppendOutcomeSchema.parse({
      outcome: 'appended',
      entries: [{ eventId: draft.eventId, sequence: 7, duplicate: false }],
      lastEventId: draft.eventId,
    })

    expect(request.events).toEqual([draft])
    expect(MemoryEventDraftSchema.safeParse({ ...draft, sequence: 99 }).success).toBe(false)
    expect(MemoryEventEnvelopeSchema.safeParse(draft).success).toBe(false)
    expect(outcome.outcome).toBe('appended')
    if (outcome.outcome === 'appended') {
      const acceptBrandedEventId = (_eventId: MemoryEventId): void => undefined
      acceptBrandedEventId(outcome.entries[0]!.eventId)
      expect(outcome.entries).toEqual([
        { eventId: draft.eventId, sequence: 7, duplicate: false },
      ])
    }
  })

  test('validates strict explicit append tails and legacy combinations', () => {
    const draft = MemoryEventDraftSchema.parse({
      schemaVersion: 2,
      eventSchemaVersion: 1,
      eventType: 'session.started',
      eventId: 'event:tail-test',
      projectId: 'project:demo',
      sessionId: 'session:1',
      occurredAt: timestamp,
      payload: { payloadSchemaVersion: 1, startedAt: timestamp },
    })
    const base = { schemaVersion: 2, projectId: 'project:demo', events: [draft] }
    for (const expectedTail of [
      { kind: 'any' },
      { kind: 'empty' },
      { kind: 'event', eventId: 'event:prior' },
    ]) {
      expect(MemoryAppendRequestSchema.safeParse({ ...base, expectedTail }).success).toBe(true)
    }
    expect(MemoryExpectedTailSchema.safeParse({ kind: 'empty', eventId: 'event:nope' }).success).toBe(false)
    expect(MemoryExpectedTailSchema.safeParse({ kind: 'event' }).success).toBe(false)
    expect(MemoryExpectedTailSchema.safeParse({ kind: 'unknown' }).success).toBe(false)
    expect(MemoryAppendRequestSchema.safeParse({
      ...base,
      expectedTail: { kind: 'event', eventId: 'event:prior' },
      expectedLastEventId: 'event:prior',
    }).success).toBe(true)
    for (const expectedTail of [
      { kind: 'any' },
      { kind: 'empty' },
      { kind: 'event', eventId: 'event:different' },
    ]) {
      expect(MemoryAppendRequestSchema.safeParse({
        ...base,
        expectedTail,
        expectedLastEventId: 'event:prior',
      }).success).toBe(false)
    }
    expect(MemoryAppendRequestSchema.safeParse(base).success).toBe(true)
    expect(MemoryAppendRequestSchema.safeParse({ ...base, expectedLastEventId: 'event:prior' }).success).toBe(true)
  })

  test('accepts only the three public authority modes', () => {
    expect(MemoryAuthorityModeSchema.options).toEqual([
      'json-v1',
      'shadow-v2',
      'sqlite-v2-opt-in',
    ])
    expect(MemoryAuthorityModeSchema.safeParse('inject').success).toBe(false)
  })

  test('rejects malformed opaque IDs', () => {
    expect(ProjectIdSchema.safeParse('project with spaces').success).toBe(false)
    expect(
      MemoryEventEnvelopeSchema.safeParse({ ...baseEvent, projectId: '', eventType: 'task.created' })
        .success,
    ).toBe(false)
  })

  test('rejects invalid payload bounds', () => {
    const result = MemoryEventEnvelopeSchema.safeParse({
      ...baseEvent,
      eventType: 'coverage.recorded',
      payload: {
        payloadSchemaVersion: 1,
        taskId: 'task:1',
        dimension: 'tests',
        state: 'covered',
        selectors: [],
        notes: 'x'.repeat(4_097),
      },
    })

    expect(result.success).toBe(false)
  })

  test('enforces the event discriminant against its payload', () => {
    const result = MemoryEventEnvelopeSchema.safeParse({
      ...baseEvent,
      eventType: 'task.created',
      payload: { payloadSchemaVersion: 1, observation },
    })

    expect(result.success).toBe(false)
  })

  test('validates strict bounded operator requests and manifests', () => {
    expect(MemoryConsolidationRequestSchema.parse({
      schemaVersion: 2, projectId: 'project:demo', sessionId: 'session:1',
      policyVersion: 'policy:1', mode: 'preview', occurredAt: timestamp,
    }).maxGroups).toBe(5)
    expect(MemoryCorrectionRequestSchema.safeParse({
      schemaVersion: 2, projectId: 'project:demo', sessionId: 'session:1', taskId: 'task:1',
      mode: 'apply', occurredAt: timestamp,
      action: { kind: 'pin', observationId: 'observation:1', reason: 'Important', pinnedBy: 'test' },
    }).success).toBe(true)
    expect(MemoryCorrectionRequestSchema.safeParse({
      schemaVersion: 2, projectId: 'project:demo', sessionId: 'session:1',
      mode: 'apply', occurredAt: timestamp,
      action: { kind: 'pin', observationId: 'observation:1', reason: 'Important', pinnedBy: 'test' },
    }).success).toBe(false)
    expect(MemoryRevalidationRequestSchema.safeParse({
      schemaVersion: 2, projectId: 'project:demo', sessionId: 'session:1', taskId: 'task:1', mode: 'preview', actions: [],
    }).success).toBe(false)
    expect(MemoryRevalidationRequestSchema.safeParse({
      schemaVersion: 2, projectId: 'project:demo', sessionId: 'session:1', mode: 'preview', actions: [{ kind: 'invalidate', observationId: 'observation:1', selector: { kind: 'file', path: 'src/a.ts' }, reason: 'changed', detail: 'changed' }],
    }).success).toBe(false)
    expect(MemoryProjectionRepairRequestSchema.safeParse({
      schemaVersion: 2, projectId: 'project:demo', sessionId: 'session:1', mode: 'apply',
      rebuildId: 'rebuild:1', projectionNames: [],
    }).success).toBe(false)
    expect(MemoryExportManifestV2Schema.safeParse({
      schemaVersion: 2, manifestVersion: 2, format: 'markdown',
    }).success).toBe(false)
  })

  test.each([
    ['unknown event type', MemoryEventEnvelopeSchema, {
      ...baseEvent,
      eventType: 'task.unknown',
      payload: { payloadSchemaVersion: 1 },
    }],
    ['future envelope version', MemoryEventEnvelopeSchema, {
      ...baseEvent,
      schemaVersion: 3,
      eventType: 'task.created',
      payload: { payloadSchemaVersion: 1, taskId: 'task:1', title: 'Title', objective: 'Objective', initialStatus: 'created' },
    }],
    ['future event version', MemoryEventEnvelopeSchema, {
      ...baseEvent,
      eventSchemaVersion: 2,
      eventType: 'task.created',
      payload: { payloadSchemaVersion: 1, taskId: 'task:1', title: 'Title', objective: 'Objective', initialStatus: 'created' },
    }],
    ['future payload version', MemoryEventEnvelopeSchema, {
      ...baseEvent,
      eventType: 'task.created',
      payload: { payloadSchemaVersion: 2, taskId: 'task:1', title: 'Title', objective: 'Objective', initialStatus: 'created' },
    }],
    ['event envelope key', MemoryEventEnvelopeSchema, {
      ...baseEvent,
      eventType: 'task.created',
      unexpected: true,
      payload: { payloadSchemaVersion: 1, taskId: 'task:1', title: 'Title', objective: 'Objective', initialStatus: 'created' },
    }],
    ['event payload key', MemoryEventEnvelopeSchema, {
      ...baseEvent,
      eventType: 'task.created',
      payload: { payloadSchemaVersion: 1, taskId: 'task:1', title: 'Title', objective: 'Objective', initialStatus: 'created', unexpected: true },
    }],
    ['selector key', MemorySelectorSchema, { ...evidence.selector, unexpected: true }],
    ['evidence key', MemoryEvidenceSchema, { ...evidence, unexpected: true }],
    ['provenance key', MemoryProvenanceSchema, { ...provenance, unexpected: true }],
  ])('rejects %s', (_name, schema, candidate) => {
    expect(schema.safeParse(candidate).success).toBe(false)
  })

  test('rejects unknown keys at request, result, context, and manifest boundaries', () => {
    const draft = {
      schemaVersion: 2,
      eventSchemaVersion: 1,
      eventType: 'session.started',
      eventId: 'event:draft-boundary',
      projectId: 'project:demo',
      sessionId: 'session:1',
      occurredAt: timestamp,
      payload: { payloadSchemaVersion: 1, startedAt: timestamp },
    }
    const appendRequest = { schemaVersion: 2, projectId: 'project:demo', events: [draft] }
    const retrievalRequest = {
      schemaVersion: 2,
      queryId: 'query:boundary',
      projectId: 'project:demo',
      sessionId: 'session:1',
      query: 'boundary query',
      selectors: [],
      artifactKinds: [],
      includeHistorical: false,
      maxResultsPerCategory: 10,
    }
    const operatorRequest = {
      schemaVersion: 2,
      projectId: 'project:demo',
      sessionId: 'session:1',
      policyVersion: 'policy:1',
      mode: 'preview',
      occurredAt: timestamp,
    }
    const result = {
      schemaVersion: 2,
      queryId: 'query:boundary',
      projectId: 'project:demo',
      generatedAt: timestamp,
      matchedTasks: [],
      verifiedKnowledge: [],
      reusableDiscovery: [],
      rereadRequired: [],
      historicalContext: [],
      degradation: { state: 'none' },
      rankingReasons: [],
    }
    const turnContext = {
      schemaVersion: 2,
      userInputId: 'input:boundary',
      queryId: 'query:boundary',
      result,
    }
    const manifest = {
      schemaVersion: 2,
      manifestVersion: 2,
      format: 'memory-v2-json',
      projectId: 'project:demo',
      generatedAt: timestamp,
      canonicalEventCount: 0,
      canonicalSequenceRange: null,
      events: [],
      health: {
        schemaVersion: 2,
        status: 'healthy',
        checkedAt: timestamp,
        authority: { kind: 'authoritative', writable: true, source: 'test' },
        backend: {
          backendId: 'backend:test',
          kind: 'in-memory',
          persistence: 'ephemeral',
          capabilities: ['append', 'query'],
        },
        issues: [],
      },
      checksum: 'sha256:0123456789abcdef',
      labels: { generated: true, authoritative: false },
      stalePolicy: { includeStale: false, excludedEventCount: 0 },
      warnings: [],
    }

    const strictBoundaries = [
      [MemoryAppendRequestSchema, appendRequest],
      [MemoryRetrievalRequestSchema, retrievalRequest],
      [MemoryConsolidationRequestSchema, operatorRequest],
      [MemoryRetrievalResultSchema, result],
      [MemoryTurnContextV2Schema, turnContext],
      [MemoryExportManifestV2Schema, manifest],
    ] as const
    for (const [schema, candidate] of strictBoundaries) {
      expect(schema.safeParse({ ...candidate, unexpected: true }).success).toBe(false)
    }

    expect(MemoryAppendRequestSchema.safeParse({
      ...appendRequest,
      events: [{ ...draft, projectId: 'project:other' }],
    }).success).toBe(false)
    expect(MemoryManifestImportRequestSchema.safeParse({
      schemaVersion: 2,
      projectId: 'project:other',
      manifest,
      rebuildId: 'rebuild:boundary',
      projectionNames: ['verified-knowledge'],
    }).success).toBe(false)
  })
})

describe('Memory V2 retrieval result', () => {
  test('keeps trust and reuse categories structurally separate', () => {
    const result = {
      schemaVersion: 2,
      queryId: 'query:1',
      projectId: 'project:demo',
      generatedAt: timestamp,
      matchedTasks: [
        {
          taskId: 'task:1',
          title: 'Add Memory V2',
          status: 'completed',
          summary: 'Added versioned contracts.',
          score: 0.9,
          reasons: [rankingReason],
        },
      ],
      verifiedKnowledge: [
        {
          observation,
          verifiedEvidence: [evidence],
          verifiedAt: timestamp,
          score: 0.95,
          reasons: [rankingReason],
        },
      ],
      reusableDiscovery: [],
      rereadRequired: [],
      historicalContext: [],
      currentCoverage: [],
      degradation: { state: 'none' },
      rankingReasons: [
        {
          category: 'verifiedKnowledge',
          targetId: 'observation:1',
          reasons: [rankingReason],
        },
      ],
    }

    expect(MemoryRetrievalResultSchema.parse(result)).toEqual(result)
    expect(
      MemoryRetrievalResultSchema.safeParse({
        ...result,
        verifiedKnowledge: [
          {
            ...result.verifiedKnowledge[0],
            verifiedEvidence: [{ ...evidence, contentDigest: undefined }],
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      MemoryRetrievalResultSchema.safeParse({
        ...result,
        rereadRequired: [
          {
            observationId: 'observation:1',
            selector: { kind: 'symbol', path: 'common/src/types/memory-v2.ts', symbol: 'MemoryEventEnvelopeSchema', occurrence: 1 },
            reason: 'changed',
            detail: 'The same observation cannot remain verified.',
            score: 0.9,
            reasons: [rankingReason],
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      MemoryRetrievalResultSchema.safeParse({
        ...result,
        verifiedKnowledge: [
          {
            ...result.verifiedKnowledge[0],
            verifiedEvidence: [
              {
                ...evidence,
                selector: { kind: 'line-range', path: 'common/src/types/memory-v2.ts', startLine: 1, endLine: 5 },
              },
            ],
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      MemoryRetrievalResultSchema.safeParse({
        ...result,
        verifiedKnowledge: undefined,
      }).success,
    ).toBe(false)

    const request = {
      schemaVersion: 2,
      queryId: 'query:1',
      projectId: 'project:demo',
      sessionId: 'session:1',
      query: 'current workspace query',
      taskId: 'task:1',
      workspaceRevision: 7,
      workspaceSnapshotId: 'snapshot:7',
      selectors: [],
      artifactKinds: [],
      includeHistorical: true,
      maxResultsPerCategory: 10,
    }
    expect(MemoryRetrievalRequestSchema.parse(request)).toEqual(request)

    const context = {
      schemaVersion: 2,
      userInputId: 'input:1',
      queryId: 'query:1',
      taskId: 'task:1',
      result,
    }
    expect(MemoryTurnContextV2Schema.parse(context)).toEqual(context)
    expect(structuredClone(MemoryTurnContextV2Schema.parse(context))).toEqual(context)
    expect(
      MemoryTurnContextV2Schema.safeParse({ ...context, queryId: 'query:other' }).success,
    ).toBe(false)
  })
})

describe('CoverageRecordedPayload and CurrentCoverageItem schemas', () => {
  test('accepts workspace fields on CoverageRecordedPayload', () => {
    const payload = {
      payloadSchemaVersion: 1,
      taskId: 'task:1',
      dimension: 'tests',
      state: 'covered',
      selectors: [],
      notes: 'All tests pass',
      workspaceRevision: 3,
      workspaceSnapshotId: 'snap:3',
    }
    expect(CoverageRecordedPayloadSchema.parse(payload)).toEqual(payload)
  })

  test('CoverageRecordedPayload remains valid without workspace fields', () => {
    const payload = {
      payloadSchemaVersion: 1,
      taskId: 'task:1',
      dimension: 'requirements',
      state: 'partial',
      selectors: [],
      notes: 'Some requirements covered',
    }
    expect(CoverageRecordedPayloadSchema.parse(payload)).toEqual(payload)
  })

  test('rejects unknown keys on CoverageRecordedPayload', () => {
    expect(
      CoverageRecordedPayloadSchema.safeParse({
        payloadSchemaVersion: 1,
        taskId: 'task:1',
        dimension: 'tests',
        state: 'covered',
        selectors: [],
        notes: 'ok',
        unexpected: true,
      }).success,
    ).toBe(false)
  })

  test('accepts valid CurrentCoverageItem', () => {
    const item = {
      dimension: 'implementation',
      state: 'covered',
      taskId: 'task:1',
      notes: 'Complete',
      workspaceRevision: 5,
      workspaceSnapshotId: 'snap:5',
    }
    expect(CurrentCoverageItemSchema.parse(item)).toEqual(item)
  })

  test('CurrentCoverageItem works without optional fields', () => {
    const item = {
      dimension: 'risk',
      state: 'not-applicable',
      taskId: 'task:2',
    }
    expect(CurrentCoverageItemSchema.parse(item)).toEqual(item)
  })

  test('rejects unknown keys on CurrentCoverageItem', () => {
    expect(
      CurrentCoverageItemSchema.safeParse({
        dimension: 'tests',
        state: 'partial',
        taskId: 'task:1',
        unexpected: true,
      }).success,
    ).toBe(false)
  })

  test('currentCoverage defaults to empty array in MemoryRetrievalResult', () => {
    const result = MemoryRetrievalResultSchema.parse({
      schemaVersion: 2,
      queryId: 'query:1',
      projectId: 'project:demo',
      generatedAt: timestamp,
      matchedTasks: [],
      verifiedKnowledge: [],
      reusableDiscovery: [],
      rereadRequired: [],
      historicalContext: [],
      degradation: { state: 'none' },
      rankingReasons: [],
    })
    expect(result.currentCoverage).toEqual([])
  })

  test('currentCoverage items round-trip through MemoryRetrievalResult', () => {
    const result = MemoryRetrievalResultSchema.parse({
      schemaVersion: 2,
      queryId: 'query:1',
      projectId: 'project:demo',
      generatedAt: timestamp,
      matchedTasks: [],
      verifiedKnowledge: [],
      reusableDiscovery: [],
      rereadRequired: [],
      historicalContext: [],
      currentCoverage: [
        { dimension: 'tests', state: 'covered', taskId: 'task:1' },
      ],
      degradation: { state: 'none' },
      rankingReasons: [],
    })
    expect(result.currentCoverage).toHaveLength(1)
    expect(result.currentCoverage[0]).toMatchObject({
      dimension: 'tests',
      state: 'covered',
      taskId: 'task:1',
    })
  })
})
