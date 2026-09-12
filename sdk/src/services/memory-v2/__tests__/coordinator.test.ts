import { describe, expect, test } from 'bun:test'

import {
  MemoryAppendRequestSchema,
  MemoryQueryOutcomeSchema,
  ProjectIdSchema,
  type MemoryAppendOutcome,
  type MemoryEventDraft,
  type MemoryEventId,
  type MemoryExportOutcome,
  type MemoryRetrievalRequest,
  type MemoryRetrievalResult,
  type QueryId,
} from '@codebuff/common/types/memory-v2'
import { taskMemoryDraftV1Schema } from '@codebuff/common/types/task-memory'
import { stableHash } from '@codebuff/common/util/stable-hash'
import { getInitialAgentState } from '@codebuff/common/types/session-state'

import {
  computeMemoryParity,
  extractV1MigrationExtras,
  MemoryV2Coordinator,
} from '../coordinator'
import {
  deriveMemoryEventId,
  deriveMemorySessionId,
  deriveQueryId,
  deriveTaskId,
} from '../event-factory'
import type { MemoryRepositoryV2, MemoryV2ClientConfig } from '../types'
import type { V1MigrationOutcome } from '../v1-migration'

const projectId = ProjectIdSchema.parse('project:test')
const generatedAt = '2026-09-10T19:41:53.753Z'

class RepositoryStub implements MemoryRepositoryV2 {
  readonly requests: ReturnType<typeof MemoryAppendRequestSchema.parse>[] = []
  readonly queryRequests: MemoryRetrievalRequest[] = []
  readonly exportRequests: Parameters<MemoryRepositoryV2['export']>[0][] = []
  inFlight = 0
  maxInFlight = 0
  failAppend = false
  failNextAppend = false
  appendConflictsRemaining = 0
  exportTailEventId: MemoryEventId | undefined
  exportScript: Array<MemoryExportOutcome | unknown | Error> | undefined
  queryFailure: 'rejected' | 'failed' | 'throw' | 'invalid' | undefined
  queryProjectId = projectId
  queryIdOverride: QueryId | undefined
  queryDegradation: MemoryRetrievalResult['degradation'] = { state: 'none' }
  appendGate: ((requestIndex: number) => Promise<void>) | undefined

  async append(request: Parameters<MemoryRepositoryV2['append']>[0]): Promise<MemoryAppendOutcome> {
    const parsed = MemoryAppendRequestSchema.parse(request)
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    const requestIndex = this.requests.length
    this.requests.push(parsed)
    await this.appendGate?.(requestIndex)
    this.inFlight--
    if (this.failAppend || this.failNextAppend) {
      this.failNextAppend = false
      throw new Error('repository offline')
    }
    if (this.appendConflictsRemaining > 0) {
      this.appendConflictsRemaining--
      return {
        outcome: 'failed',
        error: {
          code: 'conflict',
          message: 'repository tail moved',
          retryable: true,
        },
      }
    }
    const last = parsed.events.at(-1)!
    return {
      outcome: 'appended',
      entries: parsed.events.map((event, index) => ({
        eventId: event.eventId,
        sequence: (requestIndex + 1) * 100 + index,
        duplicate: false,
      })),
      lastEventId: last.eventId,
    }
  }

  async query(
    request: MemoryRetrievalRequest,
  ): Promise<ReturnType<typeof MemoryQueryOutcomeSchema.parse>> {
    this.queryRequests.push(request)
    if (this.queryFailure === 'throw') throw new Error('sensitive backend detail')
    if (this.queryFailure === 'invalid') return { malformed: 'result' } as never
    if (this.queryFailure === 'rejected' || this.queryFailure === 'failed') {
      return MemoryQueryOutcomeSchema.parse({
        outcome: this.queryFailure,
        error: {
          code: this.queryFailure === 'rejected' ? 'invalid-request' : 'unavailable',
          message: 'sensitive backend detail',
          retryable: this.queryFailure === 'failed',
        },
      })
    }
    return MemoryQueryOutcomeSchema.parse({
      outcome: 'result',
      result: {
        schemaVersion: 2,
        queryId: this.queryIdOverride ?? request.queryId,
        projectId: this.queryProjectId,
        generatedAt,
        matchedTasks: [],
        verifiedKnowledge: [],
        reusableDiscovery: [],
        rereadRequired: [],
        historicalContext: [],
        degradation: this.queryDegradation,
        rankingReasons: [],
      },
    })
  }

  async verify(): Promise<never> {
    throw new Error('not used')
  }
  async rebuild(): Promise<never> {
    throw new Error('not used')
  }
  async health(): Promise<never> {
    throw new Error('not used')
  }
  async export(request: Parameters<MemoryRepositoryV2['export']>[0]) {
    this.exportRequests.push(request)
    const scripted = this.exportScript?.shift()
    if (scripted instanceof Error) throw scripted
    if (scripted !== undefined) return scripted as MemoryExportOutcome
    type ExportPage = Extract<MemoryExportOutcome, { outcome: 'page' }>
    const events = this.exportTailEventId
      ? ([{
          schemaVersion: 2,
          eventSchemaVersion: 1,
          eventType: 'session.started',
          eventId: this.exportTailEventId,
          projectId,
          sessionId: 'session:export',
          occurredAt: generatedAt,
          sequence: 1,
          payload: { payloadSchemaVersion: 1, startedAt: generatedAt },
        }] as unknown as ExportPage['events'])
      : []
    return { outcome: 'page' as const, events, nextAfterEventId: null }
  }
}

const config = (
  repository: MemoryRepositoryV2 | undefined,
  mode: MemoryV2ClientConfig['mode'] = 'shadow',
): MemoryV2ClientConfig => ({
  ...(repository ? { repository } : {}),
  projectId,
  mode,
  capture: 'safe',
})

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const taskMemory = (requirements: string[] = ['sensitive requirement']) => {
  const draft = taskMemoryDraftV1Schema.parse({
    schemaVersion: 1,
    goal: 'sensitive goal',
    requirements,
    decisions: [],
    filesInspected: [],
    editsMade: [],
    validationResults: [],
    reviewReceipts: [],
    blockers: [],
    nextActions: [],
    historicalSummary: '',
    evidence: [],
  })
  const revision = 7
  const updatedAt = Date.parse(generatedAt)
  return {
    ...draft,
    revision,
    updatedAt,
    checksum: stableHash(JSON.stringify({ revision, updatedAt, memory: draft })),
  }
}

const allEvents = (repository: RepositoryStub): MemoryEventDraft[] =>
  repository.requests.flatMap((request) => request.events)

const migrationOutcome = (params: {
  importedObservationCount: number
  sourceItemCounts?: unknown
  truncatedFields?: unknown
}): V1MigrationOutcome => ({
  outcome: 'imported',
  revision: 7,
  checksum: 'checksum:parity',
  identity: 'identity:parity',
  importedObservationIds: Array.from(
    { length: params.importedObservationCount },
    (_, index) => `observation:parity-${index}`,
  ),
  omittedFields: [],
  warnings: [],
  ...(params.sourceItemCounts !== undefined
    ? { sourceItemCounts: params.sourceItemCounts }
    : {}),
  ...(params.truncatedFields !== undefined
    ? { truncatedFields: params.truncatedFields }
    : {}),
} as unknown as V1MigrationOutcome)

const emptyRetrievalResult = (): MemoryRetrievalResult => {
  const outcome = MemoryQueryOutcomeSchema.parse({
    outcome: 'result',
    result: {
      schemaVersion: 2,
      queryId: 'query:parity',
      projectId,
      generatedAt,
      matchedTasks: [],
      verifiedKnowledge: [],
      reusableDiscovery: [],
      rereadRequired: [],
      historicalContext: [],
      degradation: { state: 'none' },
      rankingReasons: [],
    },
  })
  if (outcome.outcome !== 'result') throw new Error('Expected retrieval result')
  return outcome.result
}

describe('Memory V2 event factory', () => {
  test('derives stable, source-isolated IDs from trusted identity fields', () => {
    const sessionId = deriveMemorySessionId({ projectId, userInputId: 'input:1' })
    const input = {
      projectId,
      sessionId,
      userInputId: 'input:1',
      callId: 'call:1',
      eventType: 'observation.recorded' as const,
    }
    expect(deriveMemoryEventId(input)).toBe(deriveMemoryEventId(input))
    expect(deriveMemoryEventId(input)).not.toBe(
      deriveMemoryEventId({ ...input, sourceIndex: 1 }),
    )
    expect(deriveTaskId(input)).not.toBe(deriveQueryId(input))
  })
})

describe('MemoryV2Coordinator lifecycle', () => {
  test('explicit authority wins over legacy mode and json-v1 performs no V2 operations', async () => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator({ ...config(repository, 'inject'), authority: 'json-v1' })
    await coordinator.prepareTurn({ agentState: state, trustedUserInputId: 'input:json-v1', query: 'none' })
    expect(repository.requests).toHaveLength(0)
    expect(repository.queryRequests).toHaveLength(0)
    expect(state.memoryAuthority).toMatchObject({ requested: 'json-v1', active: 'json-v1', fallbackOccurred: false })
  })

  test('invalid runtime authority safely selects json-v1 and performs no V2 work', async () => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    const invalidConfig = {
      ...config(repository, 'inject'),
      authority: 'invalid-runtime-authority',
    } as unknown as MemoryV2ClientConfig
    const coordinator = new MemoryV2Coordinator(invalidConfig)

    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:invalid-authority',
      query: 'must not query',
    })

    expect(repository.requests).toHaveLength(0)
    expect(repository.queryRequests).toHaveLength(0)
    expect(repository.exportRequests).toHaveLength(0)
    expect(state.memoryAuthority).toMatchObject({
      requested: 'json-v1',
      active: 'json-v1',
      fallbackOccurred: false,
      reason: 'invalid-authority',
    })
  })

  test('explicit opt-in without a repository remains active with empty context', async () => {
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator({
      ...config(undefined, 'shadow'),
      authority: 'sqlite-v2-opt-in',
    })

    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:no-repository',
      query: 'unavailable backend',
    })

    expect(state.memoryV2Context).toBeUndefined()
    expect(state.memoryAuthority).toMatchObject({
      requested: 'sqlite-v2-opt-in',
      active: 'sqlite-v2-opt-in',
      fallbackOccurred: false,
      reason: 'backend-unavailable',
    })
  })

  test('isolates fresh tasks and reuses an interrupted persisted turn', async () => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator(config(repository), undefined, () => generatedAt)
    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:1',
      query: 'first',
    })
    const first = structuredClone(state.memoryV2!)

    const fresh = new MemoryV2Coordinator(config(repository), undefined, () => generatedAt)
    await fresh.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:2',
      query: 'second',
    })
    expect(state.memoryV2!.activeTask.taskId).not.toBe(first.activeTask.taskId)
    expect(state.memoryV2!.turn.queryId).not.toBe(first.turn.queryId)

    state.memoryV2 = first
    const beforeResume = allEvents(repository).length
    const queriesBeforeResume = repository.queryRequests.length
    const resumed = new MemoryV2Coordinator(config(repository), undefined, () => '2027-01-01T00:00:00.000Z')
    await resumed.prepareTurn({
      agentState: state,
      trustedUserInputId: 'different-runtime-input',
      query: 'resume',
      resumeInterruptedTurn: true,
    })
    expect(state.memoryV2!.activeTask.taskId).toBe(first.activeTask.taskId)
    expect(state.memoryV2!.turn.queryId).toBe(first.turn.queryId)
    expect(state.memoryV2!.turn.startedAt).toBe(first.turn.startedAt)
    expect(allEvents(repository).length).toBe(beforeResume)
    expect(repository.queryRequests).toHaveLength(queriesBeforeResume + 1)
    expect(repository.queryRequests.at(-1)).toMatchObject({
      queryId: first.turn.queryId,
      taskId: first.activeTask.taskId,
    })
  })

  test('passes reconciled workspace state and injects only successful inject-mode results', async () => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    state.workspaceState = {
      ...state.workspaceState!,
      revision: 9,
      snapshotId: 'snapshot:9',
    }
    const inject = new MemoryV2Coordinator(config(repository, 'inject'), undefined, () => generatedAt)
    await inject.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:inject',
      query: 'inject current memory',
      workspaceState: state.workspaceState,
    })

    expect(repository.queryRequests.at(-1)).toMatchObject({
      workspaceRevision: 9,
      workspaceSnapshotId: 'snapshot:9',
    })
    expect(state.memoryV2Context).toMatchObject({
      schemaVersion: 2,
      userInputId: 'input:inject',
      queryId: state.memoryV2!.turn.queryId,
      taskId: state.memoryV2!.activeTask.taskId,
    })
    expect(state.memoryAuthority?.active).toBe('sqlite-v2-opt-in')

    const shadow = new MemoryV2Coordinator(config(repository, 'shadow'), undefined, () => generatedAt)
    await shadow.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:shadow',
      query: 'shadow query',
    })
    expect(state.memoryV2Context).toBeUndefined()
    expect(state.memoryAuthority?.active).toBe('json-v1')

    const successful = new MemoryV2Coordinator(config(repository, 'inject'), undefined, () => generatedAt)
    await successful.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:successful',
      query: 'successful query',
    })
    expect(state.memoryV2Context).toBeDefined()
    repository.queryFailure = 'failed'
    const failed = new MemoryV2Coordinator(config(repository, 'inject'), undefined, () => generatedAt)
    await failed.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:failed',
      query: 'failed query',
    })
    expect(state.memoryV2Context).toBeUndefined()
    expect(state.memoryAuthority).toMatchObject({
      requested: 'sqlite-v2-opt-in',
      active: 'sqlite-v2-opt-in',
      fallbackOccurred: false,
      reason: 'query-failed',
    })
  })

  test.each([
    ['rejected', 'query-rejected'],
    ['failed', 'query-failed'],
    ['throw', 'query-threw'],
    ['invalid', 'query-invalid-result'],
  ] as const)('bounds %s query failures and keeps opt-in fail-closed', async (failure, reason) => {
    const repository = new RepositoryStub()
    repository.queryFailure = failure
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator(config(repository, 'inject'), undefined, () => generatedAt)

    await expect(
      coordinator.prepareTurn({
        agentState: state,
        trustedUserInputId: `input:${failure}`,
        query: 'sensitive query text',
      }),
    ).resolves.toBeUndefined()

    expect(state.memoryV2Context).toBeUndefined()
    expect(state.memoryAuthority).toMatchObject({
      requested: 'sqlite-v2-opt-in',
      active: 'sqlite-v2-opt-in',
      fallbackOccurred: false,
      reason,
    })
    expect(JSON.stringify(state.memoryAuthority)).not.toContain('sensitive backend detail')
  })

  test('rejects a mismatched query project and keeps opt-in fail-closed', async () => {
    const repository = new RepositoryStub()
    repository.queryProjectId = ProjectIdSchema.parse('project:other')
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator(config(repository, 'inject'), undefined, () => generatedAt)

    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:mismatched-project',
      query: 'must correlate',
    })

    expect(state.memoryV2Context).toBeUndefined()
    expect(state.memoryAuthority).toMatchObject({
      requested: 'sqlite-v2-opt-in',
      active: 'sqlite-v2-opt-in',
      fallbackOccurred: false,
      reason: 'query-invalid-result',
    })
  })

  test('treats resource-budget retrieval degradation as fail-closed', async () => {
    const repository = new RepositoryStub()
    repository.queryDegradation = {
      state: 'degraded',
      reasons: [{
        code: 'resource-budget',
        detail: 'The bounded scan stopped at its payload budget.',
        retryable: true,
      }],
    }
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator(config(repository, 'inject'), undefined, () => generatedAt)

    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:resource-budget',
      query: 'bounded query',
    })

    expect(state.memoryV2Context).toBeUndefined()
    expect(state.memoryAuthority).toMatchObject({
      requested: 'sqlite-v2-opt-in',
      active: 'sqlite-v2-opt-in',
      fallbackOccurred: false,
      reason: 'backend-unavailable',
    })
  })

  test.each(['rejected', 'failed', 'throw', 'invalid'] as const)(
    'keeps shadow %s query failure non-fatal',
    async (failure) => {
      const repository = new RepositoryStub()
      repository.queryFailure = failure
      const state = getInitialAgentState()
      const coordinator = new MemoryV2Coordinator(config(repository, 'shadow'), undefined, () => generatedAt)
      await expect(
        coordinator.prepareTurn({
          agentState: state,
          trustedUserInputId: `input:shadow-${failure}`,
          query: 'continue with V1',
        }),
      ).resolves.toBeUndefined()
      expect(state.memoryAuthority).toMatchObject({
        requested: 'shadow-v2',
        active: 'json-v1',
        fallbackOccurred: false,
      })
    },
  )

  test.each([
    { classification: 'match', sourceItemCounts: { requirements: 1, evidence: 1 }, imported: 2 },
    { classification: 'v1-ahead', sourceItemCounts: { requirements: 2, evidence: 1 }, imported: 2 },
    { classification: 'v2-ahead', sourceItemCounts: { requirements: 1 }, imported: 2 },
    { classification: 'unavailable', sourceItemCounts: undefined, imported: 2 },
  ] as const)(
    'computes $classification parity from migration source item counts',
    ({ classification, sourceItemCounts, imported }) => {
      const parity = computeMemoryParity({
        memory: taskMemory(),
        result: emptyRetrievalResult(),
        migration: migrationOutcome({
          importedObservationCount: imported,
          sourceItemCounts,
        }),
      })

      expect(parity.classification).toBe(classification)
      expect(Object.keys(parity).sort()).toEqual([
        'checksum',
        'classification',
        'counts',
        'reasonCodes',
        'revision',
      ])
      expect(JSON.stringify(parity)).not.toContain('sensitive')
    },
  )

  test('extracts summed source counts and one direct safe truncated-field count', () => {
    expect(extractV1MigrationExtras(migrationOutcome({
      importedObservationCount: 0,
      sourceItemCounts: { requirements: 2, evidence: [1, 2] },
      truncatedFields: 4,
    }))).toMatchObject({ sourceItemCount: 5, truncatedFields: 4 })

    expect(extractV1MigrationExtras(migrationOutcome({
      importedObservationCount: 0,
      truncatedFields: [4],
    })).truncatedFields).toBeUndefined()
    expect(extractV1MigrationExtras(migrationOutcome({
      importedObservationCount: 0,
      truncatedFields: Number.MAX_SAFE_INTEGER + 1,
    })).truncatedFields).toBeUndefined()
  })

  test('rebases retryable append conflicts and retries the same deterministic batch at most twice', async () => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator(config(repository), undefined, () => generatedAt)
    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:conflict-retry',
      query: 'capture',
    })
    const beforeRetry = repository.requests.length
    repository.exportTailEventId = deriveMemoryEventId({
      projectId,
      sessionId: state.memoryV2!.sessionId,
      userInputId: 'input:conflict-retry',
      callId: 'call:concurrent-tail',
      eventType: 'observation.recorded',
    })
    repository.appendConflictsRemaining = 2

    await coordinator.recordToolObservation({
      toolName: 'get_build_targets',
      callId: 'call:conflict-retry',
      userInputId: 'input:conflict-retry',
      input: { files: ['src/conflict.ts'] },
      output: [{ type: 'json', value: { targets: ['sdk'] } }],
      native: true,
    })

    const attempts = repository.requests.slice(beforeRetry)
    expect(attempts).toHaveLength(3)
    expect(repository.exportRequests).toHaveLength(2)
    expect(attempts[1]!.expectedTail).toEqual({
      kind: 'event',
      eventId: repository.exportTailEventId,
    })
    expect(attempts[2]!.expectedTail).toEqual({
      kind: 'event',
      eventId: repository.exportTailEventId,
    })
    expect(attempts.every((attempt) => attempt.expectedTail !== undefined)).toBe(true)
    expect(attempts.every((attempt) => attempt.expectedLastEventId === undefined)).toBe(true)
    expect(attempts[1]!.events).toEqual(attempts[0]!.events)
    expect(attempts[2]!.events).toEqual(attempts[0]!.events)
    expect(state.memoryV2!.lastEventId).toBe(attempts[2]!.events.at(-1)!.eventId)
  })

  test('serializes concurrent captures in invocation order with exact cursor chaining through terminal append', async () => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator(config(repository), undefined, () => generatedAt)
    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:gated',
      query: 'capture',
    })
    const initialRequest = repository.requests.at(-1)!
    const gates = [deferred(), deferred(), deferred()]
    const entered = [deferred(), deferred(), deferred()]
    const firstGatedIndex = repository.requests.length
    repository.appendGate = async (requestIndex) => {
      const gateIndex = requestIndex - firstGatedIndex
      entered[gateIndex]!.resolve()
      await gates[gateIndex]!.promise
    }

    const first = coordinator.recordToolObservation({
      toolName: 'get_build_targets', callId: 'call:first', userInputId: 'input:gated',
      input: { files: ['src/first.ts'] }, output: [{ type: 'json', value: { targets: ['first'] } }], native: true,
    })
    const second = coordinator.recordToolObservation({
      toolName: 'get_affected_tests', callId: 'call:second', userInputId: 'input:gated',
      input: { files: ['src/second.ts'] }, output: [{ type: 'json', value: { tests: ['second.test.ts'] } }], native: true,
    })
    const terminal = coordinator.finishTurn({
      agentState: state,
      output: { type: 'structuredOutput', value: {} },
    })

    await entered[0]!.promise
    expect(repository.requests).toHaveLength(firstGatedIndex + 1)
    gates[0]!.resolve()
    await entered[1]!.promise
    expect(repository.requests).toHaveLength(firstGatedIndex + 2)
    gates[1]!.resolve()
    await entered[2]!.promise
    expect(repository.requests).toHaveLength(firstGatedIndex + 3)
    gates[2]!.resolve()
    await Promise.all([first, second, terminal])

    const gated = repository.requests.slice(firstGatedIndex)
    expect(gated.map((request) => request.events[0]!.eventType)).toEqual([
      'observation.recorded',
      'observation.recorded',
      'query.completed',
    ])
    expect(gated[0]!.expectedTail).toEqual({
      kind: 'event',
      eventId: initialRequest.events.at(-1)!.eventId,
    })
    expect(gated[1]!.expectedTail).toEqual({
      kind: 'event',
      eventId: gated[0]!.events.at(-1)!.eventId,
    })
    expect(gated[2]!.expectedTail).toEqual({
      kind: 'event',
      eventId: gated[1]!.events.at(-1)!.eventId,
    })
    expect(state.memoryV2!.lastEventId).toBe(gated[2]!.events.at(-1)!.eventId)
  })

  test('serializes concurrent captures, advances cursors, and finishes once', async () => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator(config(repository), undefined, () => generatedAt)
    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:1',
      query: 'capture',
    })
    await Promise.all([
      coordinator.recordToolObservation({
        toolName: 'get_build_targets',
        callId: 'call:1',
        userInputId: 'input:1',
        input: { files: ['src/a.ts'] },
        output: [{ type: 'json', value: { targets: ['sdk'] } }],
        native: true,
      }),
      coordinator.recordToolObservation({
        toolName: 'get_affected_tests',
        callId: 'call:2',
        userInputId: 'input:1',
        input: { files: ['src/b.ts'] },
        output: [{ type: 'json', value: { tests: ['a.test.ts'] } }],
        native: true,
      }),
    ])
    await coordinator.finishTurn({
      agentState: state,
      output: { type: 'structuredOutput', value: {} },
    })
    const count = allEvents(repository).length
    await coordinator.finishTurn({
      agentState: state,
      output: { type: 'error', message: 'late failure' },
    })

    expect(repository.maxInFlight).toBe(1)
    expect(allEvents(repository).length).toBe(count)
    expect(state.memoryV2!.turn.status).toBe('completed')
    expect(state.memoryV2!.lastEventId).toBe(repository.requests.at(-1)!.events.at(-1)!.eventId)
    expect(repository.requests.every((request) => request.expectedTail !== undefined)).toBe(true)
    expect(repository.requests.every((request) => request.expectedLastEventId === undefined)).toBe(true)
  })

  test('parks a failed terminal append and later commits the unchanged decision', async () => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator(config(repository), undefined, () => generatedAt)
    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:terminal-retry',
      query: 'finish reliably',
    })
    const beforeTerminal = repository.requests.length
    repository.failNextAppend = true

    await coordinator.finishTurn({
      agentState: state,
      output: { type: 'structuredOutput', value: { result: 'completed' } },
    })

    expect(state.memoryV2!.turn.status).toBe('finishing')
    expect(state.memoryV2!.pendingTerminal).toMatchObject({
      status: 'completed',
      endedAt: generatedAt,
      query: {
        outcome: 'completed',
        counts: {
          matchedTasks: 0,
          verifiedKnowledge: 0,
          reusableDiscovery: 0,
          rereadRequired: 0,
          historicalContext: 0,
        },
        degradation: { state: 'none' },
      },
    })
    const failedBatch = repository.requests.at(-1)!.events

    await coordinator.finishTurn({
      agentState: state,
      output: { type: 'error', message: 'must not replace parked decision' },
    })

    const terminalAttempts = repository.requests.slice(beforeTerminal)
    expect(terminalAttempts).toHaveLength(2)
    expect(terminalAttempts[1]!.events).toEqual(failedBatch)
    expect(state.memoryV2!.turn.status).toBe('completed')
    expect(state.memoryV2!.activeTask.status).toBe('completed')
    expect(state.memoryV2!.pendingTerminal).toBeUndefined()
    expect(terminalAttempts[1]!.events.at(-1)).toMatchObject({
      eventType: 'session.ended',
      payload: { status: 'completed', endedAt: generatedAt },
    })
  })

  test.each([
    {
      name: 'failed',
      output: { type: 'error' as const, message: 'run failed' },
      signal: undefined,
      expected: 'failed' as const,
    },
    {
      name: 'cancelled',
      output: { type: 'error' as const, message: 'aborted' },
      signal: AbortSignal.abort(),
      expected: 'cancelled' as const,
    },
  ])('records $name terminal lifecycle status', async ({ output, signal, expected }) => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator(config(repository), undefined, () => generatedAt)
    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: `input:${expected}`,
      query: expected,
    })
    await coordinator.finishTurn({ agentState: state, output, signal })

    expect(state.memoryV2!.turn.status).toBe(expected)
    expect(allEvents(repository).at(-1)).toMatchObject({
      eventType: 'session.ended',
      payload: { status: expected },
    })
  })

  test('captures only recognized successful native structured metadata with bounded paths', async () => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator(config(repository), undefined, () => generatedAt)
    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:1',
      query: 'capture',
    })
    const before = allEvents(repository).length
    await coordinator.recordToolObservation({
      toolName: 'code_search',
      callId: 'call:safe',
      userInputId: 'input:1',
      input: { files: ['src/good.ts', '../secret', '/etc/passwd'] },
      output: [{ type: 'json', value: { matches: [{ path: 'src/good.ts' }] } }],
      native: true,
    })
    const observationEvent = allEvents(repository).at(-1)!
    expect(allEvents(repository).length).toBe(before + 1)
    expect(observationEvent.eventType).toBe('observation.recorded')
    if (observationEvent.eventType === 'observation.recorded') {
      expect(observationEvent.payload.observation.selectors).toEqual([
        { kind: 'file', path: 'src/good.ts' },
      ])
      expect(observationEvent.payload.observation.evidence).toEqual([])
      expect(observationEvent.payload.observation.provenance?.metadata.outputDigest).toMatch(
        /^sha256:[a-f0-9]{64}$/,
      )
    }

    for (const attempt of [
      coordinator.recordToolObservation({
        toolName: 'run_terminal_command',
        callId: 'call:terminal',
        userInputId: 'input:1',
        input: {},
        output: [{ type: 'json', value: { stdout: 'secret' } }],
        native: true,
      }),
      coordinator.recordToolObservation({
        toolName: 'code_search',
        callId: 'call:error',
        userInputId: 'input:1',
        input: {},
        output: [{ type: 'json', value: { errorMessage: 'secret error' } }],
        native: true,
      }),
      coordinator.recordToolObservation({
        toolName: 'code_search',
        callId: 'call:custom',
        userInputId: 'input:1',
        input: {},
        output: [{ type: 'json', value: { matches: [] } }],
        native: false,
      }),
    ]) {
      await attempt
    }
    expect(allEvents(repository).length).toBe(before + 1)
  })

  test('filters private memory, generated, dependency, binary, secret, log, and build paths', async () => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator(config(repository), undefined, () => generatedAt)
    await coordinator.prepareTurn({ agentState: state, trustedUserInputId: 'input:policy', query: 'capture' })
    const before = allEvents(repository).length
    await coordinator.recordToolObservation({
      toolName: 'code_search', callId: 'call:policy', userInputId: 'input:policy',
      input: { files: ['.openbuff/memory/export.json', 'node_modules/pkg/index.js', 'generated/client.ts', 'assets/logo.png', '.env', 'logs/agent.log', 'dist/index.js'] },
      output: [{ type: 'json', value: { matches: [] } }], native: true,
    })
    expect(allEvents(repository)).toHaveLength(before)
    await coordinator.recordToolObservation({
      toolName: 'code_search', callId: 'call:mixed-policy', userInputId: 'input:policy',
      input: { files: ['src/good.ts', '.openbuff/backups/memory.json'] },
      output: [{ type: 'json', value: { matches: [] } }], native: true,
    })
    const event = allEvents(repository).at(-1)!
    expect(event.eventType).toBe('observation.recorded')
    if (event.eventType === 'observation.recorded') {
      expect(event.payload.observation.selectors).toEqual([{ kind: 'file', path: 'src/good.ts' }])
      expect(event.payload.observation.detail).toContain('1 project-relative path')
    }
  })

  test('captures only confirmed mutation actions', async () => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator(config(repository), undefined, () => generatedAt)
    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:1',
      query: 'mutate',
    })
    await coordinator.recordToolObservation({
      toolName: 'write_file',
      callId: 'call:write',
      userInputId: 'input:1',
      input: { path: 'src/new.ts' },
      native: true,
      output: [
        {
          type: 'json',
          value: {
            kind: 'file_mutation_result',
            version: 1,
            operationId: 'operation:1',
            outcome: 'applied',
            actions: [
              {
                actionId: 'action:1',
                index: 0,
                action: 'create',
                path: 'src/new.ts',
                outcome: 'applied',
                beforeHash: null,
                afterHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              },
            ],
            authorityTier: 'portable_path',
            receiptId: 'receipt:1',
            authorityReceipt: {
              kind: 'commit_receipt',
              version: 1,
              receiptId: 'receipt:1',
              operationId: 'operation:1',
              callId: 'call:write',
              authorityTier: 'portable_path',
              status: 'committed',
              actions: [
                {
                  actionId: 'action:1',
                  index: 0,
                  action: 'create',
                  path: 'src/new.ts',
                  status: 'committed',
                  beforeHash: null,
                  afterHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                },
              ],
              finalHashes: {
                'src/new.ts':
                  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              },
            },
            errors: [],
            freshCapabilities: [],
          },
        },
      ],
    })
    const event = allEvents(repository).at(-1)!
    expect(event.eventType).toBe('observation.recorded')
    if (event.eventType === 'observation.recorded') {
      expect(event.payload.observation.provenance?.metadata.actions).toEqual([
        {
          action: 'create',
          path: 'src/new.ts',
          beforeHash: null,
          afterHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      ])
    }

    const beforePrivateMutation = allEvents(repository).length
    await coordinator.recordToolObservation({
      toolName: 'write_file',
      callId: 'call:private-write',
      userInputId: 'input:1',
      input: { path: '.openbuff/memory/export.json' },
      native: true,
      output: [
        {
          type: 'json',
          value: {
            kind: 'file_mutation_result',
            version: 1,
            operationId: 'operation:private',
            outcome: 'applied',
            actions: [{
              actionId: 'action:private', index: 0, action: 'create',
              path: '.openbuff/memory/export.json', outcome: 'applied', beforeHash: null,
              afterHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            }],
            authorityTier: 'portable_path',
            receiptId: 'receipt:private',
            authorityReceipt: {
              kind: 'commit_receipt', version: 1, receiptId: 'receipt:private',
              operationId: 'operation:private', callId: 'call:private-write',
              authorityTier: 'portable_path', status: 'committed',
              actions: [{
                actionId: 'action:private', index: 0, action: 'create',
                path: '.openbuff/memory/export.json', status: 'committed', beforeHash: null,
                afterHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              }],
              finalHashes: { '.openbuff/memory/export.json': 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
            },
            errors: [],
            freshCapabilities: [],
          },
        },
      ],
    })
    expect(allEvents(repository)).toHaveLength(beforePrivateMutation)
  })

  test('append failure keeps opt-in fail-closed and remains non-fatal in shadow', async () => {
    const repository = new RepositoryStub()
    repository.failAppend = true
    const warnings: unknown[] = []
    const logger = { warn: (fields: unknown) => warnings.push(fields) }

    const shadowState = getInitialAgentState()
    const shadow = new MemoryV2Coordinator(config(repository, 'shadow'), logger, () => generatedAt)
    await expect(shadow.prepareTurn({
      agentState: shadowState,
      trustedUserInputId: 'input:shadow-failure',
      query: 'continue despite failure',
    })).resolves.toBeUndefined()
    expect(shadowState.memoryAuthority).toMatchObject({
      requested: 'shadow-v2', active: 'json-v1', fallbackOccurred: false,
      reason: 'lifecycle-append-failed',
    })

    const optInState = getInitialAgentState()
    const optIn = new MemoryV2Coordinator(config(repository, 'inject'), logger, () => generatedAt)
    await expect(optIn.prepareTurn({
      agentState: optInState,
      trustedUserInputId: 'input:opt-in-failure',
      query: 'fall back',
    })).resolves.toBeUndefined()
    expect(optInState.memoryV2!.lastEventId).toBeUndefined()
    expect(optInState.memoryV2Context).toBeUndefined()
    expect(optInState.memoryAuthority).toMatchObject({
      requested: 'sqlite-v2-opt-in',
      active: 'sqlite-v2-opt-in',
      fallbackOccurred: false,
      reason: 'lifecycle-append-failed',
    })
    expect(warnings.length).toBeGreaterThan(0)
  })

  test('rejects a mismatched query id without context or parity', async () => {
    const repository = new RepositoryStub()
    repository.queryIdOverride = deriveQueryId({
      projectId,
      sessionId: deriveMemorySessionId({ projectId, userInputId: 'other' }),
      userInputId: 'other',
    })
    const state = getInitialAgentState()
    state.taskMemory = taskMemory()
    const coordinator = new MemoryV2Coordinator(config(repository, 'inject'), undefined, () => generatedAt)

    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:mismatched-query',
      query: 'must correlate',
    })

    expect(state.memoryV2Context).toBeUndefined()
    expect(state.memoryAuthority?.parity).toBeUndefined()
    expect(state.memoryAuthority).toMatchObject({
      active: 'sqlite-v2-opt-in',
      reason: 'query-invalid-result',
    })
  })

  test('replays persisted terminal data before a new lifecycle', async () => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    const first = new MemoryV2Coordinator(config(repository), undefined, () => generatedAt)
    await first.prepareTurn({ agentState: state, trustedUserInputId: 'input:first', query: 'first' })
    repository.failNextAppend = true
    await first.finishTurn({ agentState: state, output: { type: 'structuredOutput', value: {} } })
    const failedBatch = structuredClone(repository.requests.at(-1)!.events)
    const checkpoint = structuredClone(state)
    const before = repository.requests.length

    const second = new MemoryV2Coordinator(config(repository), undefined, () => '2027-01-01T00:00:00.000Z')
    await second.prepareTurn({
      agentState: checkpoint,
      trustedUserInputId: 'input:second',
      query: 'second',
    })

    expect(repository.requests[before]!.events).toEqual(failedBatch)
    expect(repository.requests[before + 1]!.events[0]!.eventType).toBe('session.started')
    expect(checkpoint.memoryV2!.pendingTerminal).toBeUndefined()
  })

  test('emits coverage.recorded events from evaluate_audit_coverage results', async () => {
    const repository = new RepositoryStub()
    const state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator(config(repository), undefined, () => generatedAt)
    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:coverage',
      query: 'capture',
    })
    const before = allEvents(repository).length
    await coordinator.recordToolObservation({
      toolName: 'evaluate_audit_coverage',
      callId: 'call:coverage',
      userInputId: 'input:coverage',
      input: {},
      output: [{ type: 'json', value: { status: 'complete', features: [{ feature: 'auth' }] } }],
      native: true,
      workspaceState: { schemaVersion: 1 as const, revision: 5, snapshotId: 'snap:5', updatedAt: Date.now(), changes: [] },
    })
    const newEvents = allEvents(repository).slice(before)
    const observationEvents = newEvents.filter((e) => e.eventType === 'observation.recorded')
    const coverageEvents = newEvents.filter((e) => e.eventType === 'coverage.recorded')
    expect(observationEvents).toHaveLength(1)
    expect(coverageEvents).toHaveLength(1)
    const coveragePayload = coverageEvents[0]!.payload
    expect(coveragePayload).toMatchObject({
      payloadSchemaVersion: 1,
      dimension: 'validation',
      state: 'covered',
      workspaceRevision: 5,
      workspaceSnapshotId: 'snap:5',
    })
    expect(coveragePayload.selectors).toEqual([{ kind: 'file', path: 'auth' }])
    expect(coveragePayload.notes).toContain('complete')
  })

  test('fails closed when conflict tail export cannot produce a valid page', async () => {
    const failures: Array<unknown> = [
      { outcome: 'failed', error: { code: 'unavailable', message: 'no', retryable: true } },
      { malformed: true },
      new Error('export threw'),
      { outcome: 'page', events: [], nextAfterEventId: 'event:next' },
    ]
    for (const scripted of failures) {
      const repository = new RepositoryStub()
      const state = getInitialAgentState()
      const coordinator = new MemoryV2Coordinator(config(repository), undefined, () => generatedAt)
      await coordinator.prepareTurn({ agentState: state, trustedUserInputId: 'input:tail-failure', query: 'tail' })
      repository.appendConflictsRemaining = 1
      repository.exportScript = [scripted]
      const before = repository.requests.length
      await coordinator.recordToolObservation({
        toolName: 'get_build_targets', callId: 'call:tail-failure', userInputId: 'input:tail-failure',
        input: { files: ['src/a.ts'] }, output: [{ type: 'json', value: { targets: ['sdk'] } }], native: true,
      })
      expect(repository.requests.slice(before)).toHaveLength(1)
      expect(repository.requests.at(-1)!.expectedTail).toBeDefined()
    }
  })
})
