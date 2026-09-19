import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MemoryAppendRequestSchema,
  MemoryEventDraftSchema,
  MemoryRetrievalRequestSchema,
  type MemoryEventDraft,
} from '../../../../../common/src/types/memory-v2'

import {
  BunSQLiteMemoryRepository,
  openBunSQLiteMemoryRepository,
  type BunSQLiteMemoryRepositoryOptions,
} from '../bun-sqlite-memory-repository'
import {
  conceptEmbedText,
  expandConceptRecall,
  type ConceptEmbedFn,
  type ConceptExpansion,
} from '../concept-index'

// Mirrors the temp-repo helper pattern of bun-sqlite-memory-repository.test.ts.

const repositories: { close(): Promise<void> }[] = []

function temporaryRepository(): string {
  return mkdtempSync(join(tmpdir(), 'openbuff-memory-v2-'))
}

function draft(eventId: string): MemoryEventDraft {
  return MemoryEventDraftSchema.parse({
    schemaVersion: 2,
    eventSchemaVersion: 1,
    eventType: 'task.created',
    eventId,
    projectId: 'project-1',
    sessionId: 'session-1',
    occurredAt: '2025-01-02T03:04:05.000Z',
    payload: {
      payloadSchemaVersion: 1,
      taskId: 'task-1',
      title: 'Task task-1',
      objective: 'Exercise the public Memory V2 port.',
      initialStatus: 'created',
    },
  })
}

function canonicalDraft(
  eventType: string,
  eventId: string,
  payload: unknown,
): MemoryEventDraft {
  return MemoryEventDraftSchema.parse({
    schemaVersion: 2,
    eventSchemaVersion: 1,
    eventType,
    eventId,
    projectId: 'project-1',
    sessionId: 'session-1',
    occurredAt: '2025-01-02T03:04:05.000Z',
    payload,
  })
}

function evidenceFixture() {
  return {
    artifact: {
      artifactId: 'artifact-src/example.ts',
      location: 'src/example.ts',
      classification: {
        kind: 'source' as const,
        generated: false,
        sensitivity: 'internal' as const,
        labels: [],
      },
    },
    selector: { kind: 'file' as const, path: 'src/example.ts' },
    provenance: {
      origin: 'repository' as const,
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {},
    },
    capturedAt: '2025-01-02T03:04:05.000Z',
    contentDigest:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    excerpt: 'deterministic evidence',
  }
}

function observationFixture(
  observationId: string,
  overrides: {
    kind?: 'decision' | 'discovery'
    summary?: string
    detail?: string
  } = {},
) {
  const evidence = [evidenceFixture()]
  return {
    observationId,
    taskId: 'task-1',
    kind: overrides.kind ?? ('discovery' as const),
    summary: overrides.summary ?? `Discovery ${observationId}`,
    detail: overrides.detail ?? 'A deterministic canonical observation.',
    confidence: 0.9,
    evidence,
    selectors: evidence.map(({ selector }) => selector),
    provenance: {
      origin: 'repository' as const,
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {},
    },
    tags: ['deterministic'],
    observedAt: '2025-01-02T03:04:05.000Z',
  }
}

const QUERY = 'postgres session storage'
const OBSERVATION_A_ID = 'observation-a'
const OBSERVATION_B_ID = 'observation-b'
const OBSERVATION_A_SUMMARY = 'Use postgres for session storage durability'
const OBSERVATION_B_SUMMARY = 'Keep session persistence across restarts'
const OBSERVATION_A_DETAIL = 'Durable session storage was chosen deliberately.'
const OBSERVATION_B_DETAIL = 'Sessions survive process restarts via a store.'

// The fake embedder assigns explicit 4-dim vectors so BOTH observation embed
// texts land near the query text vector: the corpus engineering is the point,
// not a real model. Observation A additionally matches the query lexically.
const QUERY_EMBED_TEXT = conceptEmbedText({ kind: 'query', summary: QUERY })
const OBSERVATION_A_EMBED_TEXT = conceptEmbedText({
  kind: 'decision',
  summary: OBSERVATION_A_SUMMARY,
  detail: OBSERVATION_A_DETAIL,
})
const OBSERVATION_B_EMBED_TEXT = conceptEmbedText({
  kind: 'decision',
  summary: OBSERVATION_B_SUMMARY,
  detail: OBSERVATION_B_DETAIL,
})

const fakeEmbed: ConceptEmbedFn = async (texts: string[]) =>
  texts.map((text) => {
    if (text === QUERY_EMBED_TEXT) return [1, 0.9, 0, 0]
    if (text === OBSERVATION_A_EMBED_TEXT) return [0.9, 1, 0, 0]
    if (text === OBSERVATION_B_EMBED_TEXT) return [0.85, 0.95, 0, 0]
    return [0, 0, 0, 1]
  })
fakeEmbed.cacheKey = 'test-model-v1'

function retrievalRequest(queryId: string) {
  return MemoryRetrievalRequestSchema.parse({
    schemaVersion: 2,
    queryId,
    projectId: 'project-1',
    sessionId: 'session-1',
    query: QUERY,
    taskId: 'task-1',
    selectors: [],
    artifactKinds: [],
    includeHistorical: false,
    maxResultsPerCategory: 10,
  })
}

async function seed(repository: BunSQLiteMemoryRepository): Promise<void> {
  const observationA = observationFixture(OBSERVATION_A_ID, {
    kind: 'decision',
    summary: OBSERVATION_A_SUMMARY,
    detail: OBSERVATION_A_DETAIL,
  })
  const observationB = observationFixture(OBSERVATION_B_ID, {
    kind: 'decision',
    summary: OBSERVATION_B_SUMMARY,
    detail: OBSERVATION_B_DETAIL,
  })
  const appended = await repository.append(
    MemoryAppendRequestSchema.parse({
      schemaVersion: 2,
      projectId: 'project-1',
      events: [
        draft('task-created'),
        canonicalDraft('observation.recorded', 'observation-a-recorded', {
          payloadSchemaVersion: 1,
          observation: observationA,
        }),
        canonicalDraft('observation.recorded', 'observation-b-recorded', {
          payloadSchemaVersion: 1,
          observation: observationB,
        }),
      ],
    }),
  )
  expect(appended.outcome).toBe('appended')
}

async function openWith(
  recallExpander?: BunSQLiteMemoryRepositoryOptions['recallExpander'],
) {
  const result = await openBunSQLiteMemoryRepository({
    repositoryRoot: temporaryRepository(),
    recallExpander,
  })
  if (result.status === 'error') throw new Error(result.error.message)
  repositories.push(result.repository)
  await seed(result.repository)
  // The concept vector cache is keyed by the shared project root (captured by
  // the caller's expander closure); each repository keeps its own db file.
  return result.repository
}

function categories(result: unknown): Record<string, unknown> {
  const record = result as Record<string, unknown>
  return {
    matchedTasks: record.matchedTasks,
    verifiedKnowledge: record.verifiedKnowledge,
    reusableDiscovery: record.reusableDiscovery,
    rereadRequired: record.rereadRequired,
    historicalContext: record.historicalContext,
  }
}

function queryString(result: unknown): string {
  return JSON.stringify(categories(result))
}

afterEach(async () => {
  while (repositories.length > 0) {
    const repository = repositories.pop()
    if (repository) await repository.close()
  }
})

describe('concept recall firewall', () => {
  test('advisory expansion is additive and the authoritative view stays byte-identical', async () => {
    const tmpRoot = temporaryRepository()
    const repositoryOff = await openWith()
    const repositoryOn = await openWith((params) =>
      expandConceptRecall({
        projectRoot: tmpRoot,
        embed: fakeEmbed,
        request: params.request,
        corpus: params.corpus,
        timeoutMs: 500,
      }),
    )
    const request = retrievalRequest('query-1')

    const resultOff = await repositoryOff.query(request)
    const resultOn = await repositoryOn.query(request)
    expect(resultOff.outcome).toBe('result')
    expect(resultOn.outcome).toBe('result')
    if (resultOff.outcome !== 'result' || resultOn.outcome !== 'result') return

    // (a) Authoritative (non-advisory) view is byte-identical in every category.
    const authoritativeOn = resultOn.result.reusableDiscovery.filter(
      (entry) => entry.reasons[0]?.code !== 'concept-advisory',
    )
    expect(JSON.stringify(authoritativeOn)).toBe(
      JSON.stringify(resultOff.result.reusableDiscovery),
    )
    expect(queryString(resultOn.result)).not.toBe(queryString(resultOff.result))
    expect(
      JSON.stringify({
        matchedTasks: resultOn.result.matchedTasks,
        verifiedKnowledge: resultOn.result.verifiedKnowledge,
        rereadRequired: resultOn.result.rereadRequired,
        historicalContext: resultOn.result.historicalContext,
      }),
    ).toBe(
      JSON.stringify({
        matchedTasks: resultOff.result.matchedTasks,
        verifiedKnowledge: resultOff.result.verifiedKnowledge,
        rereadRequired: resultOff.result.rereadRequired,
        historicalContext: resultOff.result.historicalContext,
      }),
    )

    // (b) Observation B (no lexical overlap) surfaces ONLY as the advisory tail.
    const advisoryB = resultOn.result.reusableDiscovery.find(
      (entry) => entry.observation.observationId === OBSERVATION_B_ID,
    )
    expect(advisoryB).toBeDefined()
    expect(advisoryB?.reasons[0]?.code).toBe('concept-advisory')
    expect(advisoryB?.score).toBe(0)
    expect(
      resultOff.result.reusableDiscovery.some(
        (entry) => entry.observation.observationId === OBSERVATION_B_ID,
      ),
    ).toBe(false)
  })

  test('warm concept cache returns byte-identical results to the cold query', async () => {
    const tmpRoot = temporaryRepository()
    const repositoryOn = await openWith((params) =>
      expandConceptRecall({
        projectRoot: tmpRoot,
        embed: fakeEmbed,
        request: params.request,
        corpus: params.corpus,
        timeoutMs: 500,
      }),
    )
    const request = retrievalRequest('query-1')

    const cold = await repositoryOn.query(request)
    const warm = await repositoryOn.query(request)
    expect(cold.outcome).toBe('result')
    expect(warm.outcome).toBe('result')
    if (cold.outcome !== 'result' || warm.outcome !== 'result') return
    expect(JSON.stringify(warm.result)).toBe(JSON.stringify(cold.result))
  })

  test('degraded expansion leaves every category byte-identical to semantics-off', async () => {
    const tmpRoot = temporaryRepository()
    const repositoryOff = await openWith()
    const degradedExpander = async (): Promise<ConceptExpansion> => ({
      observationIds: [],
      modelDigest: 'x',
      degraded: true,
      degradedReason: 'no-embedder',
    })
    const repositoryDegraded = await openWith(() => degradedExpander())
    const request = retrievalRequest('query-1')

    const resultOff = await repositoryOff.query(request)
    const resultDegraded = await repositoryDegraded.query(request)
    expect(resultOff.outcome).toBe('result')
    expect(resultDegraded.outcome).toBe('result')
    if (resultOff.outcome !== 'result' || resultDegraded.outcome !== 'result')
      return
    expect(queryString(resultDegraded.result)).toBe(queryString(resultOff.result))
  })
})
