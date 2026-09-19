import { describe, expect, test } from 'bun:test'

import type {
  MemoryReuseReceiptV1,
  MemoryTurnContextV2,
} from '@codebuff/common/types/memory-v2'

import { correlateUsage, type UsageSignal } from '../usage-observer'

const capturedAt = '2025-01-02T03:04:05.000Z'
const digest = `sha256:${'a'.repeat(64)}`

const chunkEvidence = (chunkId: string) => ({
  artifact: {
    artifactId: `artifact-${chunkId}`,
    location: `src/${chunkId}.ts`,
    classification: {
      kind: 'source' as const,
      generated: false,
      sensitivity: 'internal' as const,
      labels: [],
    },
  },
  selector: {
    kind: 'chunk' as const,
    path: `src/${chunkId}.ts`,
    chunkId,
    qualifiedName: 'sym',
    startLine: 1,
    endLine: 10,
  },
  provenance: {
    origin: 'tool' as const,
    recordedBy: 'test',
    sourceEventIds: [],
    metadata: {},
  },
  capturedAt,
  contentDigest: digest,
})

const verifiedKnowledgeItem = (
  observationId: string,
  chunkIds: string[],
) => ({
  observation: {
    observationId,
    taskId: 'task-1',
    kind: 'discovery' as const,
    summary: observationId,
    detail: 'deterministic detail',
    confidence: 0.9,
    evidence: chunkIds.map(chunkEvidence),
    selectors: [],
    tags: ['test'],
    observedAt: capturedAt,
  },
  verifiedEvidence: chunkIds.map(chunkEvidence),
  verifiedAt: capturedAt,
  score: 1,
  reasons: [],
})

const buildContext = (
  verified: ReturnType<typeof verifiedKnowledgeItem>[],
): MemoryTurnContextV2 =>
  ({
    schemaVersion: 2,
    userInputId: 'input:1',
    queryId: 'query:1',
    result: {
      schemaVersion: 2,
      queryId: 'query:1',
      projectId: 'project:1',
      generatedAt: capturedAt,
      matchedTasks: [],
      verifiedKnowledge: verified,
      reusableDiscovery: [],
      rereadRequired: [],
      historicalContext: [],
      degradation: { state: 'none' },
      rankingReasons: [],
    },
  }) as unknown as MemoryTurnContextV2

const receipt = (
  overrides: Partial<MemoryReuseReceiptV1> = {},
): MemoryReuseReceiptV1 => ({
  schemaVersion: 1,
  turnId: 'input:1',
  skip: 0,
  narrow: 0,
  full: 0,
  recordsServed: 0,
  gapsRemaining: 0,
  recordedDecisions: 0,
  conceptExpanded: 0,
  byTool: [],
  ...overrides,
})

const byToolEntry = (
  overrides: Partial<NonNullable<MemoryReuseReceiptV1['byTool']>[number]>,
) => ({
  tool: 'read_files',
  decision: 'skip' as const,
  served: 1,
  gaps: 0,
  ...overrides,
})

describe('correlateUsage', () => {
  test('gate-skip: chunk covered by a skip entry yields exactly one used signal', () => {
    const context = buildContext([verifiedKnowledgeItem('observation:one', ['c1'])])
    const reuse = receipt({
      byTool: [byToolEntry({ coveredStableChunkIds: ['c1'] })],
    })

    expect(correlateUsage({ context, receipt: reuse })).toEqual([
      { observationId: 'observation:one', kind: 'used', mechanism: 'gate-skip' },
    ])
  })

  test('dedup: the same chunk covered by two tools produces one signal', () => {
    const context = buildContext([verifiedKnowledgeItem('observation:one', ['c1'])])
    const reuse = receipt({
      byTool: [
        byToolEntry({ tool: 'query_index', coveredStableChunkIds: ['c1'] }),
        byToolEntry({
          tool: 'code_search',
          decision: 'narrow',
          coveredStableChunkIds: ['c1'],
        }),
      ],
    })

    expect(correlateUsage({ context, receipt: reuse })).toEqual([
      { observationId: 'observation:one', kind: 'used', mechanism: 'gate-skip' },
    ])
  })

  test('ignored: full>=1 marks non-used injected observations reread-despite and never double-marks used ones', () => {
    const context = buildContext([
      verifiedKnowledgeItem('observation:used', ['c1']),
      verifiedKnowledgeItem('observation:missed', ['c2']),
    ])
    const reuse = receipt({
      full: 1,
      byTool: [byToolEntry({ coveredStableChunkIds: ['c1'] })],
    })

    expect(correlateUsage({ context, receipt: reuse })).toEqual([
      {
        observationId: 'observation:missed',
        kind: 'ignored',
        mechanism: 'reread-despite',
      },
      { observationId: 'observation:used', kind: 'used', mechanism: 'gate-skip' },
    ])
  })

  test('no ignored signals when the turn performed no full read', () => {
    const context = buildContext([verifiedKnowledgeItem('observation:one', ['c1'])])
    const reuse = receipt({
      byTool: [byToolEntry({ coveredStableChunkIds: ['c1'] })],
    })

    expect(correlateUsage({ context, receipt: reuse })).toEqual([
      { observationId: 'observation:one', kind: 'used', mechanism: 'gate-skip' },
    ])
  })

  test('determinism: identical inputs produce deep-equal, code-point-ordered output', () => {
    const context = buildContext([
      verifiedKnowledgeItem('observation:b', ['cB']),
      verifiedKnowledgeItem('observation:a', ['cA', 'cB']),
      verifiedKnowledgeItem('observation:c', ['cC']),
    ])
    const reuse = receipt({
      full: 1,
      byTool: [
        byToolEntry({ coveredStableChunkIds: ['cB', 'cA'] }),
      ],
    })

    const first = correlateUsage({ context, receipt: reuse })
    const second = correlateUsage({ context, receipt: reuse })
    expect(first).toEqual(second)
    const ids = first.map((signal: UsageSignal) => signal.observationId)
    expect([...ids].sort()).toEqual(ids)
    expect(first).toEqual([
      { observationId: 'observation:a', kind: 'used', mechanism: 'gate-skip' },
      { observationId: 'observation:b', kind: 'used', mechanism: 'gate-skip' },
      {
        observationId: 'observation:c',
        kind: 'ignored',
        mechanism: 'reread-despite',
      },
    ])
  })

  test('caps: more than 128 signals is sliced to 128 after sorting', () => {
    const observations = Array.from({ length: 140 }, (_, index) =>
      verifiedKnowledgeItem(`observation:cap-${String(index).padStart(3, '0')}`, [
        `chunk-${String(index).padStart(3, '0')}`,
      ]),
    )
    const context = buildContext(observations)
    const reuse = receipt({
      byTool: [
        byToolEntry({
          coveredStableChunkIds: observations.map((item) =>
            (item.observation.evidence[0].selector as { chunkId: string }).chunkId,
          ),
        }),
      ],
    })

    const signals = correlateUsage({ context, receipt: reuse })
    expect(signals).toHaveLength(128)
    expect(
      signals.every(
        (signal) =>
          signal.kind === 'used' && signal.mechanism === 'gate-skip',
      ),
    ).toBe(true)
  })

  test('no-op: empty byTool or empty injected categories yield []', () => {
    const populated = buildContext([
      verifiedKnowledgeItem('observation:one', ['c1']),
    ])
    expect(
      correlateUsage({ context: populated, receipt: receipt() }),
    ).toEqual([])
    expect(
      correlateUsage({
        context: buildContext([]),
        receipt: receipt({
          byTool: [byToolEntry({ coveredStableChunkIds: ['c1'] })],
        }),
      }),
    ).toEqual([])
  })
})
