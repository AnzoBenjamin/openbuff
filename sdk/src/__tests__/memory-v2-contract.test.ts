import { describe, expect, test } from 'bun:test'

import type {
  MemoryAppendOutcome,
  MemoryAppendRequest,
  MemoryEventDraft,
  MemoryEventEnvelope,
  MemoryExportOutcome,
  MemoryExportRequest,
  MemoryHealth,
  MemoryHealthRequest,
  MemoryQueryOutcome,
  MemoryRebuildOutcome,
  MemoryRebuildRequest,
  MemoryRepositoryV2,
  MemoryRetrievalRequest,
  MemoryVerifyOutcome,
  MemoryVerifyRequest,
} from '../index'
import {
  MemoryAppendRequestSchema,
  MemoryEventDraftSchema,
  MemoryEventEnvelopeSchema,
  MemoryRetrievalRequestSchema,
} from '../index'

const timestamp = '2026-09-10T19:41:53.753Z'

class FakeMemoryRepositoryV2 implements MemoryRepositoryV2 {
  readonly events: MemoryEventEnvelope[] = []
  private readonly drafts = new Map<string, MemoryEventDraft>()

  async append(request: MemoryAppendRequest): Promise<MemoryAppendOutcome> {
    if (request.events.some((event) => event.projectId !== request.projectId)) {
      return {
        outcome: 'rejected',
        error: {
          code: 'invalid-request',
          message: 'Every event must belong to the requested project.',
          retryable: false,
        },
      }
    }
    const projectEvents = this.events.filter((event) => event.projectId === request.projectId)
    const currentLastEventId = projectEvents.at(-1)?.eventId
    const expectedTail = request.expectedTail ?? (
      request.expectedLastEventId === undefined
        ? { kind: 'any' as const }
        : { kind: 'event' as const, eventId: request.expectedLastEventId }
    )
    const tailMatches = expectedTail.kind === 'any'
      || (expectedTail.kind === 'empty' && currentLastEventId === undefined)
      || (expectedTail.kind === 'event' && expectedTail.eventId === currentLastEventId)
    if (!tailMatches) {
      return {
        outcome: 'rejected',
        error: { code: 'conflict', message: 'The memory store changed.', retryable: true },
      }
    }

    const stagedDrafts = new Map(this.drafts)
    const pending: MemoryEventEnvelope[] = []
    const entries: Array<{ eventId: MemoryEventDraft['eventId']; sequence: number; duplicate: boolean }> = []
    for (const draft of request.events) {
      const existingDraft = stagedDrafts.get(draft.eventId)
      const existingEvent = [...this.events, ...pending].find(
        (event) => event.eventId === draft.eventId,
      )
      if (existingDraft && existingEvent) {
        if (JSON.stringify(existingDraft) !== JSON.stringify(draft)) {
          return {
            outcome: 'rejected',
            error: { code: 'conflict', message: 'The event ID already exists.', retryable: false },
          }
        }
        entries.push({ eventId: draft.eventId, sequence: existingEvent.sequence, duplicate: true })
        continue
      }

      const event = MemoryEventEnvelopeSchema.parse({
        ...draft,
        sequence: this.events.length + pending.length + 1,
      })
      stagedDrafts.set(draft.eventId, draft)
      pending.push(event)
      entries.push({ eventId: draft.eventId, sequence: event.sequence, duplicate: false })
    }

    this.events.push(...pending)
    for (const draft of request.events) this.drafts.set(draft.eventId, draft)
    const lastEventId = this.events
      .filter((event) => event.projectId === request.projectId)
      .at(-1)!.eventId
    return { outcome: 'appended', entries, lastEventId }
  }

  async query(request: MemoryRetrievalRequest): Promise<MemoryQueryOutcome> {
    return {
      outcome: 'result',
      result: {
        schemaVersion: 2,
        queryId: request.queryId,
        projectId: request.projectId,
        generatedAt: timestamp,
        matchedTasks: [],
        verifiedKnowledge: [],
        reusableDiscovery: [],
        rereadRequired: [],
        historicalContext: [],
        currentCoverage: [],
        degradation: { state: 'none' },
        rankingReasons: [],
      },
    }
  }

  async verify(_request: MemoryVerifyRequest): Promise<MemoryVerifyOutcome> {
    return {
      outcome: 'failed',
      error: { code: 'not-found', message: 'Observation not found', retryable: false },
    }
  }

  async rebuild(request: MemoryRebuildRequest): Promise<MemoryRebuildOutcome> {
    return { outcome: 'rebuilt', rebuildId: request.rebuildId, processedEvents: this.events.length }
  }

  async health(_request: MemoryHealthRequest): Promise<MemoryHealth> {
    return {
      schemaVersion: 2,
      status: 'healthy',
      checkedAt: timestamp,
      authority: { kind: 'authoritative', writable: true, source: 'fake' },
      backend: {
        backendId: 'fake',
        kind: 'in-memory',
        persistence: 'ephemeral',
        capabilities: ['append', 'query', 'verify', 'rebuild', 'health', 'export'],
      },
      issues: [],
    }
  }

  async export(request: MemoryExportRequest): Promise<MemoryExportOutcome> {
    return {
      outcome: 'page',
      events: this.events.slice(0, request.limit),
      nextAfterEventId: null,
    }
  }
}

describe('MemoryRepositoryV2 public contract', () => {
  test('supports a compile-time and runtime fake implementation', async () => {
    const event = MemoryEventDraftSchema.parse({
      schemaVersion: 2,
      eventSchemaVersion: 1,
      eventType: 'task.created',
      eventId: 'event:1',
      projectId: 'project:demo',
      sessionId: 'session:1',
      occurredAt: timestamp,
      payload: {
        payloadSchemaVersion: 1,
        taskId: 'task:1',
        title: 'Exercise the repository contract',
        objective: 'Prove the port has no runtime-specific types.',
        initialStatus: 'created',
      },
    })
    const appendRequest = MemoryAppendRequestSchema.parse({
      schemaVersion: 2,
      projectId: 'project:demo',
      events: [event],
    })
    const queryRequest = MemoryRetrievalRequestSchema.parse({
      schemaVersion: 2,
      queryId: 'query:1',
      projectId: 'project:demo',
      sessionId: 'session:1',
      query: 'repository contract',
      selectors: [],
      artifactKinds: [],
      includeHistorical: false,
      maxResultsPerCategory: 10,
    })
    const repository: MemoryRepositoryV2 = new FakeMemoryRepositoryV2()

    const appendOutcome = await repository.append(appendRequest)
    const staleEmpty = await repository.append(MemoryAppendRequestSchema.parse({
      ...appendRequest,
      expectedTail: { kind: 'empty' },
    }))
    const duplicateOutcome = await repository.append(appendRequest)
    const queryOutcome = await repository.query(queryRequest)
    const exportOutcome = await repository.export({
      schemaVersion: 2,
      projectId: appendRequest.projectId,
      limit: 10,
    })

    expect(appendOutcome).toEqual({
      outcome: 'appended',
      entries: [{ eventId: event.eventId, sequence: 1, duplicate: false }],
      lastEventId: event.eventId,
    })
    expect(staleEmpty).toMatchObject({
      outcome: 'rejected',
      error: { code: 'conflict', retryable: true },
    })
    expect(duplicateOutcome).toEqual({
      outcome: 'appended',
      entries: [{ eventId: event.eventId, sequence: 1, duplicate: true }],
      lastEventId: event.eventId,
    })
    expect(
      MemoryAppendRequestSchema.safeParse({
        ...appendRequest,
        events: [{ ...event, sequence: 99 }],
      }).success,
    ).toBe(false)
    expect(queryOutcome.outcome).toBe('result')
    expect(exportOutcome.outcome).toBe('page')
    if (exportOutcome.outcome === 'page') {
      expect(exportOutcome.events).toEqual([{ ...event, sequence: 1 }])
    }
  })
})
