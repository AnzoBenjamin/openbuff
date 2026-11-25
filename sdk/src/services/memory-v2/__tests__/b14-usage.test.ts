import { describe, expect, test } from 'bun:test'
import { correlateUsage } from '../usage-observer'
import type {
  MemoryTurnContextV2,
  MemoryReuseReceiptV1,
} from '@codebuff/common/types/memory-v2'

const hash = `sha256:${'a'.repeat(64)}`
const context = {
  schemaVersion: 2,
  userInputId: 'turn',
  queryId: 'query',
  result: {
    verifiedKnowledge: ['a', 'b'].map((id) => ({
      observation: {
        observationId: id,
        evidence: [
          {
            selector: {
              kind: 'chunk',
              path: `src/${id}.ts`,
              chunkId: `chunk-${id}`,
              startLine: 1,
              endLine: 2,
            },
            contentDigest: hash,
          },
        ],
      },
      verifiedEvidence: [
        {
          selector: {
            kind: 'chunk',
            path: `src/${id}.ts`,
            chunkId: `chunk-${id}`,
            startLine: 1,
            endLine: 2,
          },
          contentDigest: hash,
        },
      ],
    })),
    reusableDiscovery: [],
  },
} as unknown as MemoryTurnContextV2
const receipt = (entry: Record<string, unknown>): MemoryReuseReceiptV1 =>
  ({
    schemaVersion: 1,
    turnId: 'turn',
    skip: 0,
    narrow: 0,
    full: 1,
    recordsServed: 0,
    gapsRemaining: 0,
    recordedDecisions: 0,
    conceptExpanded: 0,
    byTool: [
      { tool: 'read_files', decision: 'full', served: 0, gaps: 0, ...entry },
    ],
  }) as MemoryReuseReceiptV1

describe('B14 source-specific emitted-memory usage', () => {
  test('an unrelated full read cannot penalize either retrieved observation', () => {
    expect(
      correlateUsage({
        context,
        receipt: receipt({
          observedReads: [
            {
              path: 'src/c.ts',
              startLine: 1,
              endLine: 2,
              contentDigest: hash,
              reason: 'unchanged-reread',
            },
          ],
        }),
        emittedObservationIds: ['a', 'b'],
      }),
    ).toEqual([])
  })
  test('only actual emitted matching-source unchanged reread gets an efficiency signal', () => {
    const read = receipt({
      observedReads: [
        {
          path: 'src/a.ts',
          startLine: 1,
          endLine: 2,
          contentDigest: hash,
          reason: 'unchanged-reread',
        },
      ],
    })
    expect(
      correlateUsage({
        context,
        receipt: read,
        emittedObservationIds: ['a', 'b'],
      }),
    ).toEqual([
      { observationId: 'a', kind: 'ignored', mechanism: 'reread-despite' },
    ])
    expect(
      correlateUsage({ context, receipt: read, emittedObservationIds: ['b'] }),
    ).toEqual([])
    expect(
      correlateUsage({ context, receipt: read, emittedObservationIds: [] }),
    ).toEqual([])
  })
  test('required refresh, changed bytes, unknown use and incomplete reads never imply ignored', () => {
    for (const entry of [
      {
        path: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        contentDigest: hash,
        reason: 'required-refresh',
      },
      {
        path: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        contentDigest: hash,
        reason: 'unknown',
      },
      {
        path: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        contentDigest: `sha256:${'b'.repeat(64)}`,
        reason: 'unchanged-reread',
      },
      {
        path: 'src/a.ts',
        startLine: 1,
        endLine: 1,
        contentDigest: hash,
        reason: 'unchanged-reread',
      },
    ])
      expect(
        correlateUsage({
          context,
          receipt: receipt({ observedReads: [entry] }),
          emittedObservationIds: ['a'],
        }),
      ).toEqual([])
    expect(
      correlateUsage({
        context,
        receipt: receipt({}),
        emittedObservationIds: ['a'],
      }),
    ).toEqual([])
  })
  test('a skip for an unrendered observation is not measured use', () => {
    const reuse = receipt({
      decision: 'skip',
      coveredStableChunkIds: ['chunk-a'],
    })
    expect(
      correlateUsage({ context, receipt: reuse, emittedObservationIds: ['b'] }),
    ).toEqual([])
  })
})
