import { describe, expect, test } from 'bun:test'

import {
  MemoryAppendRequestSchema,
  MemoryEventEnvelopeSchema,
  MemoryExportManifestV2Schema,
  MemoryHealthSchema,
  ProjectIdSchema,
  type MemoryAppendRequest,
  type MemoryEventEnvelope,
  type MemoryRebuildOutcome,
  type MemoryVerifyOutcome,
} from '@codebuff/common/types/memory-v2'

import { MemoryV2OperatorService } from '../operator-service'
import type { MemoryRepositoryV2 } from '../types'

const projectId = ProjectIdSchema.parse('project:operator')
const timestamp = '2026-09-10T19:41:53.753Z'
const sessionId = 'session:operator'

const observationEvent = (
  sequence: number,
  observationId: string,
  summary: string,
  path = 'src/a.ts',
  taskId = 'task:operator',
): MemoryEventEnvelope =>
  MemoryEventEnvelopeSchema.parse({
    schemaVersion: 2,
    eventSchemaVersion: 1,
    eventType: 'observation.recorded',
    eventId: `event:observation-${sequence}`,
    projectId,
    sessionId,
    sequence,
    occurredAt: timestamp,
    payload: {
      payloadSchemaVersion: 1,
      observation: {
        observationId,
        taskId,
        kind: 'fact',
        summary,
        detail: `Detail for ${summary}`,
        confidence: 0.8,
        evidence: [
          {
            artifact: {
              artifactId: `artifact:${sequence}`,
              location: path,
              classification: {
                kind: 'source',
                generated: false,
                sensitivity: 'internal',
                labels: [],
              },
            },
            selector: { kind: 'file', path },
            provenance: {
              origin: 'tool',
              recordedBy: 'test',
              sourceEventIds: [],
              metadata: { secret: 'do-not-export', safe: 'yes' },
            },
            capturedAt: timestamp,
            excerpt: 'raw source body',
          },
        ],
        selectors: [{ kind: 'file', path }],
        tags: ['test'],
        observedAt: timestamp,
      },
    },
  })

class RepositoryStub implements MemoryRepositoryV2 {
  events: MemoryEventEnvelope[]
  appendRequests: MemoryAppendRequest[] = []
  verifyResults: MemoryVerifyOutcome[] = []
  verifyCalls = 0
  rebuildCalls = 0
  mutateDuringRebuild = false
  appendFailureCall: number | undefined
  appendConflictMutations = new Map<number, MemoryEventEnvelope[]>()
  exportFailureCall: number | undefined
  repeatExportCursor = false
  healthFailure = false
  rebuildResults: Array<MemoryRebuildOutcome | Error> = []
  exportCalls = 0
  healthCalls = 0

  constructor(events: MemoryEventEnvelope[] = []) {
    this.events = [...events]
  }

  async append(request: Parameters<MemoryRepositoryV2['append']>[0]) {
    const parsed = MemoryAppendRequestSchema.parse(request)
    this.appendRequests.push(parsed)
    if (this.appendRequests.length === this.appendFailureCall) {
      return {
        outcome: 'failed' as const,
        error: { code: 'unavailable' as const, message: 'sensitive append error', retryable: true },
      }
    }
    const conflictMutation = this.appendConflictMutations.get(this.appendRequests.length)
    if (conflictMutation) {
      this.events.push(...conflictMutation)
      return {
        outcome: 'failed' as const,
        error: { code: 'conflict' as const, message: 'sensitive conflict', retryable: true },
      }
    }
    const expectedTail = parsed.expectedTail ?? (
      parsed.expectedLastEventId === undefined
        ? { kind: 'any' as const }
        : { kind: 'event' as const, eventId: parsed.expectedLastEventId }
    )
    const actualLastEventId = this.events.at(-1)?.eventId
    const tailMatches = expectedTail.kind === 'any'
      || (expectedTail.kind === 'empty' && actualLastEventId === undefined)
      || (expectedTail.kind === 'event' && expectedTail.eventId === actualLastEventId)
    if (!tailMatches) {
      return {
        outcome: 'failed' as const,
        error: { code: 'conflict' as const, message: 'cursor mismatch', retryable: true },
      }
    }
    const entries = parsed.events.map((draft) => {
      const existing = this.events.find((event) => event.eventId === draft.eventId)
      if (existing) {
        const { sequence: _sequence, ...existingDraft } = existing
        if (JSON.stringify(existingDraft) !== JSON.stringify(draft)) {
          throw new Error('deterministic event content conflict')
        }
        return { eventId: draft.eventId, sequence: existing.sequence, duplicate: true }
      }
      const sequence = this.events.length + 1
      this.events.push(MemoryEventEnvelopeSchema.parse({ ...draft, sequence }))
      return { eventId: draft.eventId, sequence, duplicate: false }
    })
    return {
      outcome: 'appended' as const,
      entries,
      lastEventId: entries.at(-1)!.eventId,
    }
  }

  async query(): Promise<never> {
    throw new Error('not used')
  }

  async verify() {
    this.verifyCalls++
    return (
      this.verifyResults.shift() ?? {
        outcome: 'failed' as const,
        error: { code: 'unavailable' as const, message: 'verification failed', retryable: true },
      }
    )
  }

  async rebuild(request: Parameters<MemoryRepositoryV2['rebuild']>[0]) {
    this.rebuildCalls++
    const configured = this.rebuildResults.shift()
    if (configured instanceof Error) throw configured
    if (configured) return configured
    if (this.mutateDuringRebuild) {
      this.events.push(observationEvent(this.events.length + 1, 'observation:intruder', 'Changed'))
    }
    return { outcome: 'rebuilt' as const, rebuildId: request.rebuildId, processedEvents: this.events.length }
  }

  async health() {
    this.healthCalls++
    if (this.healthFailure) throw new Error('sensitive health failure')
    return MemoryHealthSchema.parse({
      schemaVersion: 2,
      status: 'healthy',
      checkedAt: timestamp,
      authority: { kind: 'authoritative', writable: true, source: 'test' },
      backend: {
        backendId: 'test',
        kind: 'in-memory',
        persistence: 'ephemeral',
        capabilities: ['append', 'query', 'verify', 'rebuild', 'health', 'export'],
      },
      issues: [],
    })
  }

  async export(request: Parameters<MemoryRepositoryV2['export']>[0]) {
    this.exportCalls++
    if (this.exportCalls === this.exportFailureCall) {
      return {
        outcome: 'failed' as const,
        error: { code: 'unavailable' as const, message: 'sensitive export error', retryable: true },
      }
    }
    const start = request.afterEventId
      ? this.events.findIndex((event) => event.eventId === request.afterEventId) + 1
      : 0
    const events = this.events.slice(start, start + request.limit)
    const hasMore = start + events.length < this.events.length
    return {
      outcome: 'page' as const,
      events,
      nextAfterEventId: this.repeatExportCursor
        ? request.afterEventId ?? events.at(-1)?.eventId ?? null
        : hasMore
          ? events.at(-1)!.eventId
          : null,
    }
  }
}

const consolidationRequest = {
  schemaVersion: 2 as const,
  projectId,
  sessionId,
  taskId: 'task:operator',
  policyVersion: 'policy:1',
  mode: 'preview' as const,
  occurredAt: timestamp,
  maxGroups: 5,
}

describe('MemoryV2OperatorService', () => {
  test('previews deterministic consolidation without writes and exact apply retry is idempotent', async () => {
    const repository = new RepositoryStub([
      observationEvent(1, 'observation:1', 'One'),
      observationEvent(2, 'observation:2', 'Two'),
    ])
    const service = new MemoryV2OperatorService(repository)
    const first = await service.consolidate(consolidationRequest)
    const second = await service.consolidate(consolidationRequest)
    expect(first).toEqual(second)
    expect(first.outcome).toBe('preview')
    expect(repository.appendRequests).toHaveLength(0)

    const applied = await service.consolidate({ ...consolidationRequest, mode: 'apply' })
    expect(applied.outcome).toBe('applied')
    expect(repository.events.filter((event) => event.eventType === 'claim.consolidated')).toHaveLength(1)
    expect(repository.events.filter((event) => event.eventType === 'claim.superseded')).toHaveLength(2)
    expect(await service.consolidate({ ...consolidationRequest, mode: 'apply' })).toMatchObject({
      outcome: 'no-op',
    })
  })

  test.each(['correct', 'forget', 'pin'] as const)('%s preview is no-write and apply appends one explicit event', async (kind) => {
    const repository = new RepositoryStub([
      observationEvent(1, 'observation:1', 'Original'),
    ])
    const service = new MemoryV2OperatorService(repository)
    const action = (() => {
      if (kind === 'correct') {
        const payload = observationEvent(1, 'observation:correction', 'Corrected').payload
        if (!('observation' in payload)) throw new Error('invalid fixture')
        return {
          kind,
          observationId: 'observation:1',
          correction: payload.observation,
          reason: 'Correct the claim',
        }
      }
      if (kind === 'forget') {
        return {
          kind,
          observationIds: ['observation:1'],
          reason: 'user-request' as const,
          requestedBy: 'test',
          evidenceDisposition: 'remove-references' as const,
        }
      }
      return { kind, observationId: 'observation:1', reason: 'Important', pinnedBy: 'test' }
    })()
    const request = { schemaVersion: 2, projectId, sessionId, taskId: 'task:operator', occurredAt: timestamp, action }
    expect(await service.correct({ ...request, mode: 'preview' })).toMatchObject({ outcome: 'preview' })
    expect(repository.events).toHaveLength(1)
    expect(await service.correct({ ...request, mode: 'apply' })).toMatchObject({ outcome: 'applied' })
    expect(repository.events).toHaveLength(2)
    expect(repository.events[1]!.eventType).toBe(`claim.${kind === 'correct' ? 'corrected' : kind === 'forget' ? 'forgotten' : 'pinned'}`)
  })

  test('correction actions reject missing and cross-task targets while same-task correction succeeds', async () => {
    const target = observationEvent(1, 'observation:1', 'Original')
    const correctionPayload = observationEvent(2, 'observation:correction', 'Corrected').payload
    if (!('observation' in correctionPayload)) throw new Error('invalid fixture')
    const action = {
      kind: 'correct' as const,
      observationId: 'observation:1',
      correction: correctionPayload.observation,
      reason: 'Correct the claim',
    }
    const base = {
      schemaVersion: 2,
      projectId,
      sessionId,
      taskId: 'task:operator',
      occurredAt: timestamp,
      mode: 'apply' as const,
    }
    const missingRepository = new RepositoryStub()
    expect(await new MemoryV2OperatorService(missingRepository).correct({ ...base, action })).toMatchObject({
      outcome: 'rejected',
      error: { code: 'invalid-request', retryable: false },
    })
    expect(missingRepository.appendRequests).toHaveLength(0)

    const crossTaskRepository = new RepositoryStub([target])
    expect(
      await new MemoryV2OperatorService(crossTaskRepository).correct({
        ...base,
        taskId: 'task:other',
        action,
      }),
    ).toMatchObject({ outcome: 'rejected', error: { code: 'invalid-request' } })
    expect(crossTaskRepository.appendRequests).toHaveLength(0)

    const crossTaskCorrectionPayload = observationEvent(
      2,
      'observation:cross-task-correction',
      'Wrong task',
      'src/a.ts',
      'task:other',
    ).payload
    if (!('observation' in crossTaskCorrectionPayload)) throw new Error('invalid fixture')
    expect(
      await new MemoryV2OperatorService(new RepositoryStub([target])).correct({
        ...base,
        action: { ...action, correction: crossTaskCorrectionPayload.observation },
      }),
    ).toMatchObject({ outcome: 'rejected', error: { code: 'invalid-request' } })

    const sameTaskRepository = new RepositoryStub([target])
    expect(
      await new MemoryV2OperatorService(sameTaskRepository).correct({
        ...base,
        taskId: 'task:operator',
        action,
      }),
    ).toMatchObject({ outcome: 'applied' })
  })

  test.each(['forget', 'pin'] as const)('%s rejects missing and cross-task targets', async (kind) => {
    const action = kind === 'forget'
      ? {
          kind,
          observationIds: ['observation:1'],
          reason: 'user-request' as const,
          requestedBy: 'test',
          evidenceDisposition: 'remove-references' as const,
        }
      : { kind, observationId: 'observation:1', reason: 'Important', pinnedBy: 'test' }
    const request = {
      schemaVersion: 2,
      projectId,
      sessionId,
      taskId: 'task:operator',
      occurredAt: timestamp,
      mode: 'apply' as const,
      action,
    }
    const missingRepository = new RepositoryStub()
    expect(await new MemoryV2OperatorService(missingRepository).correct(request)).toMatchObject({
      outcome: 'rejected',
      error: { code: 'invalid-request' },
    })
    const crossTaskRepository = new RepositoryStub([
      observationEvent(1, 'observation:1', 'Other', 'src/a.ts', 'task:other'),
    ])
    expect(await new MemoryV2OperatorService(crossTaskRepository).correct(request)).toMatchObject({
      outcome: 'rejected',
      error: { code: 'invalid-request' },
    })
    expect(crossTaskRepository.appendRequests).toHaveLength(0)
  })

  test('revalidation preview is no-write and apply preserves failed verification results', async () => {
    const repository = new RepositoryStub([
      observationEvent(1, 'observation:1', 'Original'),
    ])
    const service = new MemoryV2OperatorService(repository)
    const action = {
      kind: 'invalidate' as const,
      observationId: 'observation:1',
      selector: { kind: 'file' as const, path: 'src/a.ts' },
      reason: 'changed' as const,
      detail: 'Changed on disk',
    }
    expect(await service.revalidate({ schemaVersion: 2, projectId, sessionId, taskId: 'task:operator', mode: 'preview', actions: [action] })).toMatchObject({ outcome: 'preview' })
    expect(repository.verifyCalls).toBe(0)
    const applied = await service.revalidate({ schemaVersion: 2, projectId, sessionId, taskId: 'task:operator', mode: 'apply', actions: [action] })
    expect(applied).toMatchObject({ outcome: 'applied', results: [{ result: { outcome: 'failed' } }] })
    expect(repository.verifyCalls).toBe(1)
  })

  test('revalidation rejects missing and cross-task targets before verify', async () => {
    const action = {
      kind: 'invalidate' as const,
      observationId: 'observation:1',
      selector: { kind: 'file' as const, path: 'src/a.ts' },
      reason: 'changed' as const,
      detail: 'Changed on disk',
    }
    const request = {
      schemaVersion: 2,
      projectId,
      sessionId,
      taskId: 'task:operator',
      mode: 'apply' as const,
      actions: [action],
    }
    const missingRepository = new RepositoryStub()
    expect(await new MemoryV2OperatorService(missingRepository).revalidate(request)).toMatchObject({
      outcome: 'rejected',
      error: { code: 'invalid-request' },
    })
    expect(missingRepository.verifyCalls).toBe(0)

    const crossTaskRepository = new RepositoryStub([
      observationEvent(1, 'observation:1', 'Other', 'src/a.ts', 'task:other'),
    ])
    expect(await new MemoryV2OperatorService(crossTaskRepository).revalidate(request)).toMatchObject({
      outcome: 'rejected',
      error: { code: 'invalid-request' },
    })
    expect(crossTaskRepository.verifyCalls).toBe(0)
  })

  test('repair verifies canonical count and hash and reports mutation mismatch', async () => {
    const repository = new RepositoryStub([observationEvent(1, 'observation:1', 'One')])
    const service = new MemoryV2OperatorService(repository)
    const request = {
      schemaVersion: 2,
      projectId,
      sessionId,
      mode: 'apply',
      rebuildId: 'rebuild:1',
      projectionNames: ['observations'],
    }
    expect(await service.repair(request)).toMatchObject({ outcome: 'repaired' })
    repository.mutateDuringRebuild = true
    expect(await service.repair({ ...request, rebuildId: 'rebuild:2' })).toMatchObject({ outcome: 'integrity-mismatch' })
  })

  test('exports deterministic sanitized manifests and labels optionally included stale sources', async () => {
    const source = observationEvent(1, 'observation:1', 'One')
    const forgotten = MemoryEventEnvelopeSchema.parse({
      schemaVersion: 2,
      eventSchemaVersion: 1,
      eventType: 'claim.forgotten',
      eventId: 'event:forgotten',
      projectId,
      sessionId,
      sequence: 2,
      occurredAt: timestamp,
      payload: {
        payloadSchemaVersion: 1,
        observationIds: ['observation:1'],
        reason: 'user-request',
        requestedBy: 'test',
        evidenceDisposition: 'remove-references',
      },
    })
    const repository = new RepositoryStub([source, forgotten])
    const service = new MemoryV2OperatorService(repository)
    const request = { schemaVersion: 2, projectId, generatedAt: timestamp, includeStale: false, rendering: 'json' }
    const first = await service.exportManifest(request)
    expect(first).toEqual(await service.exportManifest(request))
    expect(first.outcome).toBe('exported')
    if (first.outcome !== 'exported') return
    expect(first.manifest.events.map(({ event }) => String(event.eventId))).toEqual([
      'event:forgotten',
    ])
    expect(JSON.stringify(first.manifest)).not.toContain('do-not-export')
    expect(JSON.stringify(first.manifest)).not.toContain('raw source body')

    const included = await service.exportManifest({ ...request, includeStale: true })
    expect(included).toMatchObject({
      outcome: 'exported',
      manifest: { events: [{ lifecycle: 'stale', staleReasons: ['forgotten'] }, { lifecycle: 'active' }] },
    })
  })

  test('redacts free-text tokens, private keys, and assignments with a bounded warning', async () => {
    const source = observationEvent(
      1,
      'observation:secrets',
      'Use ghp_abcdefghijklmnopqrstuvwxyz and github_pat_abcdefghijklmnopqrstuvwxyz',
    )
    if (source.eventType !== 'observation.recorded') throw new Error('invalid fixture')
    source.payload.observation.provenance = {
      origin: 'tool',
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {
        apiKey: 'metadata-api-key',
        client_secret: 'metadata-client-secret',
        privateKey: 'metadata-private-key',
        accessToken: 'metadata-access-token',
        refresh_token: 'metadata-refresh-token',
        password: 'metadata-password',
      },
    }
    source.payload.observation.detail = [
      'Authorization: Bearer abc.def.ghi',
      'AWS AKIAABCDEFGHIJKLMNOP',
      'PASSWORD=hunter2 API_TOKEN="token-value"',
      'apiKey=free-api clientSecret:free-client privateKey=free-private',
      'accessToken=free-access refreshToken=free-refresh password=free-password',
      '-----BEGIN PRIVATE KEY-----',
      'private-key-body',
      '-----END PRIVATE KEY-----',
    ].join('\n')
    const outcome = await new MemoryV2OperatorService(new RepositoryStub([source])).exportManifest({
      schemaVersion: 2,
      projectId,
      generatedAt: timestamp,
      includeStale: true,
      rendering: 'json',
    })
    expect(outcome.outcome).toBe('exported')
    if (outcome.outcome !== 'exported') return
    const encoded = JSON.stringify(outcome.manifest)
    expect(encoded).not.toContain('ghp_')
    expect(encoded).not.toContain('github_pat_')
    expect(encoded).not.toContain('abc.def.ghi')
    expect(encoded).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(encoded).not.toContain('hunter2')
    expect(encoded).not.toContain('token-value')
    expect(encoded).not.toContain('private-key-body')
    expect(encoded).not.toContain('metadata-api-key')
    expect(encoded).not.toContain('metadata-client-secret')
    expect(encoded).not.toContain('metadata-private-key')
    expect(encoded).not.toContain('metadata-access-token')
    expect(encoded).not.toContain('metadata-refresh-token')
    expect(encoded).not.toContain('metadata-password')
    expect(encoded).not.toContain('free-api')
    expect(encoded).not.toContain('free-client')
    expect(encoded).not.toContain('free-private')
    expect(encoded).not.toContain('free-access')
    expect(encoded).not.toContain('free-refresh')
    expect(encoded).not.toContain('free-password')
    expect(encoded).toContain('[REDACTED]')
    expect(outcome.manifest.warnings.join('\n')).toMatch(/Redacted \d+ sensitive value/)
    expect(outcome.manifest.warnings.length).toBeLessThanOrEqual(100)
  })

  test('round-trips into an empty target, exact retry rebuilds then no-ops, conflict and checksum tampering reject', async () => {
    const source = new RepositoryStub([observationEvent(1, 'observation:1', 'One')])
    const exported = await new MemoryV2OperatorService(source).exportManifest({
      schemaVersion: 2,
      projectId,
      generatedAt: timestamp,
      includeStale: true,
      rendering: 'json',
    })
    if (exported.outcome !== 'exported') throw new Error('export failed')
    const target = new RepositoryStub()
    const service = new MemoryV2OperatorService(target)
    const request = {
      schemaVersion: 2,
      projectId,
      manifest: exported.manifest,
      rebuildId: 'rebuild:import',
      projectionNames: ['all'],
      pageSize: 1,
    }
    expect(await service.importManifest(request)).toMatchObject({ outcome: 'imported', importedEvents: 1 })
    expect(target.rebuildCalls).toBe(1)
    expect(await service.importManifest(request)).toMatchObject({ outcome: 'no-op' })
    expect(target.rebuildCalls).toBe(2)

    const conflict = new RepositoryStub([observationEvent(1, 'observation:other', 'Other')])
    expect(await new MemoryV2OperatorService(conflict).importManifest(request)).toMatchObject({ outcome: 'rejected' })
    const invalid = MemoryExportManifestV2Schema.parse({ ...exported.manifest, checksum: `sha256:${'f'.repeat(64)}` })
    expect(await new MemoryV2OperatorService(new RepositoryStub()).importManifest({ ...request, manifest: invalid })).toMatchObject({ outcome: 'rejected' })
  })

  test('rejects an oversized manifest events value before schema work or repository writes', async () => {
    const repository = new RepositoryStub()
    const outcome = await new MemoryV2OperatorService(repository).importManifest({
      schemaVersion: 2,
      projectId,
      manifest: { events: [{ detail: 'x'.repeat(32 * 1024 * 1024) }] },
      rebuildId: 'rebuild:oversized',
      projectionNames: ['all'],
      pageSize: 1,
    })
    expect(outcome).toMatchObject({
      outcome: 'rejected',
      error: {
        code: 'invalid-request',
        message: 'Manifest events exceed the import size limit',
        retryable: false,
      },
    })
    expect(repository.exportCalls).toBe(0)
    expect(repository.appendRequests).toHaveLength(0)
    expect(repository.rebuildCalls).toBe(0)
  })

  test('strips imported verification lifecycle events after checksum validation', async () => {
    const observation = observationEvent(1, 'observation:1', 'One')
    const invalidated = MemoryEventEnvelopeSchema.parse({
      schemaVersion: 2,
      eventSchemaVersion: 1,
      eventType: 'evidence.invalidated',
      eventId: 'event:invalidated',
      projectId,
      sessionId,
      sequence: 2,
      occurredAt: timestamp,
      payload: {
        payloadSchemaVersion: 1,
        observationId: 'observation:1',
        selector: { kind: 'file', path: 'src/a.ts' },
        reason: 'changed',
        detail: 'Changed on disk',
        invalidatedAt: timestamp,
      },
    })
    const exported = await new MemoryV2OperatorService(
      new RepositoryStub([observation, invalidated]),
    ).exportManifest({
      schemaVersion: 2,
      projectId,
      generatedAt: timestamp,
      includeStale: true,
      rendering: 'json',
    })
    if (exported.outcome !== 'exported') throw new Error('fixture export failed')
    expect(exported.manifest.warnings.join('\n')).toContain('verification-state-stripped: 1')

    const target = new RepositoryStub()
    const service = new MemoryV2OperatorService(target)
    const request = {
      schemaVersion: 2,
      projectId,
      manifest: exported.manifest,
      rebuildId: 'rebuild:strip-verification',
      projectionNames: ['all'],
      pageSize: 1,
    }
    expect(await service.importManifest(request)).toMatchObject({
      outcome: 'imported',
      importedEvents: 1,
    })
    expect(target.events.map((event) => event.eventType)).toEqual(['observation.recorded'])
    expect(await service.importManifest(request)).toMatchObject({
      outcome: 'no-op',
      reason: expect.stringContaining('verification-state-stripped=1'),
    })
  })

  test('guards each import page with the advancing canonical tail cursor', async () => {
    const sourceEvents = [
      observationEvent(1, 'observation:1', 'One'),
      observationEvent(2, 'observation:2', 'Two'),
      observationEvent(3, 'observation:3', 'Three'),
    ]
    const exported = await new MemoryV2OperatorService(new RepositoryStub(sourceEvents)).exportManifest({
      schemaVersion: 2,
      projectId,
      generatedAt: timestamp,
      includeStale: true,
      rendering: 'json',
    })
    if (exported.outcome !== 'exported') throw new Error('fixture export failed')
    const target = new RepositoryStub()
    const request = {
      schemaVersion: 2,
      projectId,
      manifest: exported.manifest,
      rebuildId: 'rebuild:cursor',
      projectionNames: ['all'],
      pageSize: 1,
    }
    expect(await new MemoryV2OperatorService(target).importManifest(request)).toMatchObject({
      outcome: 'imported',
    })
    expect(target.appendRequests.map(({ expectedTail }) => expectedTail)).toEqual([
      { kind: 'empty' },
      { kind: 'event', eventId: sourceEvents[0]!.eventId },
      { kind: 'event', eventId: sourceEvents[1]!.eventId },
    ])
  })

  test('retryable append conflict reloads an exact prefix and resumes', async () => {
    const sourceEvents = [
      observationEvent(1, 'observation:1', 'One'),
      observationEvent(2, 'observation:2', 'Two'),
      observationEvent(3, 'observation:3', 'Three'),
    ]
    const exported = await new MemoryV2OperatorService(new RepositoryStub(sourceEvents)).exportManifest({
      schemaVersion: 2,
      projectId,
      generatedAt: timestamp,
      includeStale: true,
      rendering: 'json',
    })
    if (exported.outcome !== 'exported') throw new Error('fixture export failed')
    const target = new RepositoryStub()
    target.appendConflictMutations.set(2, [exported.manifest.events[1]!.event])
    const outcome = await new MemoryV2OperatorService(target).importManifest({
      schemaVersion: 2,
      projectId,
      manifest: exported.manifest,
      rebuildId: 'rebuild:conflict-prefix',
      projectionNames: ['all'],
      pageSize: 1,
    })
    expect(outcome).toMatchObject({ outcome: 'imported' })
    expect(target.events.map(({ eventId }) => eventId)).toEqual(
      sourceEvents.map(({ eventId }) => eventId),
    )
    expect(target.appendRequests.map(({ expectedTail }) => expectedTail)).toEqual([
      { kind: 'empty' },
      { kind: 'event', eventId: sourceEvents[0]!.eventId },
      { kind: 'event', eventId: sourceEvents[1]!.eventId },
    ])
    expect(target.rebuildCalls).toBe(1)
  })

  test('retryable append conflict rejects a non-prefix target without rebuilding', async () => {
    const sourceEvents = [
      observationEvent(1, 'observation:1', 'One'),
      observationEvent(2, 'observation:2', 'Two'),
    ]
    const exported = await new MemoryV2OperatorService(new RepositoryStub(sourceEvents)).exportManifest({
      schemaVersion: 2,
      projectId,
      generatedAt: timestamp,
      includeStale: true,
      rendering: 'json',
    })
    if (exported.outcome !== 'exported') throw new Error('fixture export failed')
    const target = new RepositoryStub()
    const intruder = observationEvent(2, 'observation:intruder', 'Intruder')
    if (intruder.eventType !== 'observation.recorded') throw new Error('invalid fixture')
    delete intruder.payload.observation.evidence[0]!.excerpt
    intruder.payload.observation.evidence[0]!.provenance.metadata = { safe: 'yes' }
    target.appendConflictMutations.set(2, [intruder])
    const outcome = await new MemoryV2OperatorService(target).importManifest({
      schemaVersion: 2,
      projectId,
      manifest: exported.manifest,
      rebuildId: 'rebuild:conflict-non-prefix',
      projectionNames: ['all'],
      pageSize: 1,
    })
    expect(outcome).toMatchObject({
      outcome: 'rejected',
      error: { code: 'conflict', retryable: false },
    })
    expect(target.rebuildCalls).toBe(0)
  })

  test.each(['returned', 'thrown'] as const)(
    'retries rebuild after a complete import when rebuild previously %s failure',
    async (kind) => {
      const source = new RepositoryStub([
        observationEvent(1, 'observation:1', 'One'),
        observationEvent(2, 'observation:2', 'Two'),
      ])
      const exported = await new MemoryV2OperatorService(source).exportManifest({
        schemaVersion: 2, projectId, generatedAt: timestamp, includeStale: true, rendering: 'json',
      })
      if (exported.outcome !== 'exported') throw new Error('fixture export failed')
      const target = new RepositoryStub()
      target.rebuildResults.push(
        kind === 'thrown'
          ? new Error('sensitive rebuild failure')
          : {
              outcome: 'failed',
              error: { code: 'unavailable', message: 'rebuild unavailable', retryable: true },
            },
      )
      const service = new MemoryV2OperatorService(target)
      const request = {
        schemaVersion: 2, projectId, manifest: exported.manifest,
        rebuildId: 'rebuild:recovery', projectionNames: ['all'], pageSize: 1,
      }
      const failed = await service.importManifest(request)
      expect(failed).toMatchObject({ outcome: 'failed' })
      expect(JSON.stringify(failed)).not.toContain('sensitive')
      expect(JSON.stringify(failed)).not.toContain('rebuild unavailable')
      expect(target.events).toHaveLength(2)
      expect(target.rebuildCalls).toBe(1)

      expect(await service.importManifest(request)).toMatchObject({ outcome: 'no-op' })
      expect(target.rebuildCalls).toBe(2)
      expect(target.events).toHaveLength(2)
      expect(new Set(target.events.map((event) => event.eventId)).size).toBe(2)
    },
  )

  test('recovers a page-N import failure without rebuilding early or duplicating events', async () => {
    const source = new RepositoryStub([
      observationEvent(1, 'observation:1', 'One'),
      observationEvent(2, 'observation:2', 'Two'),
      observationEvent(3, 'observation:3', 'Three'),
    ])
    const exported = await new MemoryV2OperatorService(source).exportManifest({
      schemaVersion: 2, projectId, generatedAt: timestamp, includeStale: true, rendering: 'json',
    })
    if (exported.outcome !== 'exported') throw new Error('fixture export failed')
    const target = new RepositoryStub()
    target.appendFailureCall = 2
    const service = new MemoryV2OperatorService(target)
    const request = {
      schemaVersion: 2, projectId, manifest: exported.manifest,
      rebuildId: 'rebuild:paged', projectionNames: ['all'], pageSize: 1,
    }
    expect(await service.importManifest(request)).toMatchObject({ outcome: 'failed' })
    expect(target.events).toHaveLength(1)
    expect(target.rebuildCalls).toBe(0)

    target.appendFailureCall = undefined
    expect(await service.importManifest(request)).toMatchObject({ outcome: 'imported', importedEvents: 3 })
    expect(target.events.map((event) => event.eventId)).toEqual(
      exported.manifest.events.map(({ event }) => event.eventId),
    )
    expect(target.rebuildCalls).toBe(1)
  })

  test.each(['page-failure', 'repeated-cursor', 'health-failure'] as const)(
    'returns a bounded retryable export failure for %s',
    async (failure) => {
      const repository = new RepositoryStub([observationEvent(1, 'observation:1', 'One')])
      if (failure === 'page-failure') repository.exportFailureCall = 1
      if (failure === 'repeated-cursor') repository.repeatExportCursor = true
      if (failure === 'health-failure') repository.healthFailure = true
      const outcome = await new MemoryV2OperatorService(repository).exportManifest({
        schemaVersion: 2, projectId, generatedAt: timestamp, includeStale: true, rendering: 'json',
      })
      expect(outcome).toMatchObject({
        outcome: 'failed',
        error:
          failure === 'page-failure'
            ? { code: 'unavailable', message: 'Memory repository export failed', retryable: true }
            : { code: 'internal', message: 'Memory operator failed', retryable: true },
      })
      expect(JSON.stringify(outcome)).not.toContain('sensitive')
    },
  )
})
