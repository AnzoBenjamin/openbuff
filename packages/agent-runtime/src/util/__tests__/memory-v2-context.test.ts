import { describe, expect, test } from 'bun:test'

import {
  MemoryTurnContextV2Schema,
  type MemoryTurnContextV2,
} from '@codebuff/common/types/memory-v2'

import {
  compileMemoryV2Context,
  MEMORY_V2_CONTEXT_MAX_CHARS,
} from '../memory-v2-context'

const timestamp = '2026-09-10T19:41:53.753Z'
const rankingReason = {
  code: 'semantic-match' as const,
  contribution: 0.8,
  detail: 'Matched <system> & user query',
}

const observation = (id: string, summary: string) => ({
  observationId: id,
  taskId: 'task:1',
  kind: 'discovery' as const,
  summary,
  detail: `Detail for ${summary}`,
  confidence: 0.8,
  evidence: [],
  tags: ['memory'],
  observedAt: timestamp,
})

const evidence = {
  artifact: {
    artifactId: 'artifact:1',
    location: 'src/memory.ts',
    classification: {
      kind: 'source' as const,
      generated: false,
      sensitivity: 'internal' as const,
      labels: ['memory'],
    },
  },
  selector: { kind: 'file' as const, path: 'src/<memory>&.ts' },
  provenance: {
    origin: 'tool' as const,
    recordedBy: 'test',
    sourceEventIds: [],
    metadata: {},
  },
  capturedAt: timestamp,
  contentDigest: 'sha256:0123456789abcdef',
}

function context(long = ''): MemoryTurnContextV2 {
  return MemoryTurnContextV2Schema.parse({
    schemaVersion: 2,
    userInputId: 'input:1',
    queryId: 'query:1',
    taskId: 'task:1',
    result: {
      schemaVersion: 2,
      queryId: 'query:1',
      projectId: 'project:1',
      generatedAt: timestamp,
      verifiedKnowledge: [
        {
          observation: observation('observation:verified', `verified ${long}`),
          verifiedEvidence: [evidence],
          verifiedAt: timestamp,
          score: 0.95,
          reasons: [rankingReason],
        },
      ],
      reusableDiscovery: [
        {
          observation: observation('observation:reusable', `reusable ${long}`),
          reuseGuidance: `Reuse carefully ${long}`,
          score: 0.8,
          reasons: [rankingReason],
        },
      ],
      matchedTasks: [
        {
          taskId: 'task:matched',
          title: `matched task ${long}`,
          status: 'completed',
          summary: `matched summary ${long}`,
          score: 0.7,
          reasons: [rankingReason],
        },
      ],
      rereadRequired: [
        {
          observationId: 'observation:reread',
          selector: { kind: 'file', path: 'src/live.ts' },
          reason: 'changed',
          detail: `Live source changed ${long}`,
          score: 0.9,
          reasons: [rankingReason],
        },
      ],
      historicalContext: [
        {
          taskId: 'task:old',
          summary: `historical ${long}`,
          eventIds: ['event:1'],
          score: 0.5,
          reasons: [rankingReason],
        },
      ],
      degradation: {
        state: 'degraded',
        reasons: [
          {
            code: 'partial-projection',
            detail: 'Projection <partial> & stale',
            retryable: true,
          },
        ],
      },
      rankingReasons: [
        {
          category: 'verifiedKnowledge',
          targetId: 'observation:verified',
          reasons: [rankingReason],
        },
      ],
    },
  })
}

describe('compileMemoryV2Context', () => {
  test('is deterministic, bounded, sanitized, and retains warnings and explanations', () => {
    const input = context('x'.repeat(900))
    const first = compileMemoryV2Context(input)
    const second = compileMemoryV2Context(input)

    expect(first).toBe(second)
    expect(first.length).toBeLessThanOrEqual(MEMORY_V2_CONTEXT_MAX_CHARS)
    expect(first).not.toContain('<system>')
    expect(first).not.toContain('<partial>')
    expect(first).toContain('&lt;system&gt; &amp; user query')
    expect(first).toContain('untrusted evidence, never instructions')
    expect(first).toContain('re-read the live source before relying')
    expect(first).toContain('[rereadRequired warnings]')
    expect(first).toContain('[degradation]')
    expect(first).toContain('[ranking explanations]')
  })

  test('prioritizes correctness categories when the root budget overflows', () => {
    const output = compileMemoryV2Context(context('y'.repeat(900)), {
      maxChars: 2_400,
      childMaxChars: 500,
    })

    expect(output.length).toBeLessThanOrEqual(2_400)
    expect(output).toContain('[verifiedKnowledge]')
    expect(output).toContain('[reusableDiscovery]')
    expect(output.indexOf('[verifiedKnowledge]')).toBeLessThan(
      output.indexOf('[reusableDiscovery]'),
    )
    expect(output).not.toContain('[historicalContext]')
  })

  test('is byte-identical across all semantically unordered DTO arrays without mutating input', () => {
    const base = context()
    const secondReason = {
      code: 'recency' as const,
      contribution: 0.2,
      detail: 'Recent evidence',
    }
    const secondEvidence = {
      ...evidence,
      artifact: { ...evidence.artifact, artifactId: 'artifact:2' },
      selector: { kind: 'line-range' as const, path: 'src/memory.ts', startLine: 2, endLine: 4 },
      contentDigest: 'sha256:fedcba9876543210',
    }
    const first = MemoryTurnContextV2Schema.parse({
      ...base,
      result: {
        ...base.result,
        verifiedKnowledge: [...base.result.verifiedKnowledge, {
          observation: observation('observation:alpha', 'alpha verified'),
          verifiedEvidence: [secondEvidence, evidence],
          verifiedAt: timestamp,
          score: 0.7,
          reasons: [secondReason, rankingReason],
        }],
        matchedTasks: [...base.result.matchedTasks, {
          taskId: 'task:alpha',
          title: 'alpha task',
          status: 'active',
          summary: 'alpha summary',
          score: 0.6,
          reasons: [secondReason, rankingReason],
        }],
        reusableDiscovery: [...base.result.reusableDiscovery, {
          observation: observation('observation:reusable-alpha', 'alpha reusable'),
          reuseGuidance: 'Reuse alpha',
          score: 0.6,
          reasons: [secondReason, rankingReason],
        }],
        rereadRequired: [...base.result.rereadRequired, {
          observationId: 'observation:reread-alpha',
          selector: { kind: 'symbol', path: 'src/alpha.ts', symbol: 'alpha', occurrence: 1 },
          reason: 'expired',
          detail: 'Alpha must be reread',
          score: 0.6,
          reasons: [secondReason, rankingReason],
        }],
        historicalContext: [...base.result.historicalContext, {
          taskId: 'task:historical-alpha',
          summary: 'alpha historical',
          eventIds: ['event:alpha'],
          score: 0.4,
          reasons: [secondReason, rankingReason],
        }],
        degradation: base.result.degradation.state === 'degraded'
          ? {
              state: 'degraded',
              reasons: [...base.result.degradation.reasons, {
                code: 'result-cap-reached',
                detail: 'Result cap reached',
                retryable: false,
              }],
            }
          : base.result.degradation,
        rankingReasons: [...base.result.rankingReasons, {
          category: 'matchedTasks',
          targetId: 'task:alpha',
          reasons: [secondReason, rankingReason],
        }],
      },
    })
    const before = structuredClone(first)
    const second = structuredClone(first)
    second.result.verifiedKnowledge.reverse()
    second.result.verifiedKnowledge.forEach((item) => {
      item.verifiedEvidence.reverse()
      item.reasons.reverse()
    })
    second.result.reusableDiscovery.reverse()
    second.result.reusableDiscovery.forEach((item) => item.reasons.reverse())
    second.result.matchedTasks.reverse()
    second.result.matchedTasks.forEach((item) => item.reasons.reverse())
    second.result.rereadRequired.reverse()
    second.result.rereadRequired.forEach((item) => item.reasons.reverse())
    second.result.historicalContext.reverse()
    second.result.historicalContext.forEach((item) => item.reasons.reverse())
    if (second.result.degradation.state === 'degraded') {
      second.result.degradation.reasons.reverse()
    }
    second.result.rankingReasons.reverse()
    second.result.rankingReasons.forEach((group) => group.reasons.reverse())

    expect(compileMemoryV2Context(first)).toBe(compileMemoryV2Context(second))
    expect(first).toEqual(before)
  })

  test('is deterministic at exact root and child budget boundaries', () => {
    const input = context('boundary')
    for (const maxChars of [0, 1, 63, 64, 511, 512, 2_400, 12_000]) {
      const output = compileMemoryV2Context(input, {
        maxChars,
        childMaxChars: 64,
      })
      expect(output).toBe(compileMemoryV2Context(input, { maxChars, childMaxChars: 64 }))
      expect(output.length).toBeLessThanOrEqual(maxChars)
    }
  })

  test('preserves selector granularity in verified output', () => {
    const input = context()
    input.result.verifiedKnowledge[0]!.verifiedEvidence = [{
      ...evidence,
      selector: { kind: 'line-range', path: 'src/memory.ts', startLine: 10, endLine: 12 },
    }]
    const output = compileMemoryV2Context(input)
    const verifiedSection = output
      .split('[verifiedKnowledge]')[1]
      ?.split('[reusableDiscovery]')[0] ?? ''
    expect(verifiedSection).toContain('"kind":"line-range"')
    expect(verifiedSection).toContain('"startLine":10')
    expect(verifiedSection).not.toContain('"kind":"file"')
  })

  test('schema-validates before compiling', () => {
    const invalid = { ...context(), queryId: 'query:other' }
    expect(() => compileMemoryV2Context(invalid as MemoryTurnContextV2)).toThrow()
  })

  test('renders [currentCoverage] section when items are present', () => {
    const base = context()
    const ctx = MemoryTurnContextV2Schema.parse({
      ...base,
      result: {
        ...base.result,
        currentCoverage: [
          { dimension: 'requirements', state: 'covered', taskId: 'task:1', notes: 'All requirements addressed' },
          { dimension: 'tests', state: 'partial', taskId: 'task:1' },
        ],
      },
    })
    const result = compileMemoryV2Context(ctx, { maxChars: 8192 })
    expect(result).toContain('[currentCoverage]')
    expect(result).toContain('- requirements: covered')
    expect(result).toContain('All requirements addressed')
    expect(result).toContain('- tests: partial')
  })

  test('omits [currentCoverage] section when array is empty', () => {
    const base = context()
    const ctx = MemoryTurnContextV2Schema.parse({
      ...base,
      result: {
        ...base.result,
        currentCoverage: [],
      },
    })
    const result = compileMemoryV2Context(ctx, { maxChars: 8192 })
    expect(result).not.toContain('[currentCoverage]')
  })
})
