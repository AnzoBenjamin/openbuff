import { test, expect } from 'bun:test'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import {
  captureTextDocument,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'
import { getExactContentHash } from '@codebuff/common/util/content-hash'
import { recordMemoryReadObservation } from '../memory-read-observation'
import type { ReadFilesItemV1 } from '@codebuff/common/tools/results/filesystem'
import type { MemoryTurnContextV2 } from '@codebuff/common/types/memory-v2'

const text = 'export const value = 1\n',
  hash = getExactContentHash(text)
const state = () => ({
  ...getInitialAgentState(),
  memoryV2EmittedObservationIds: ['a'],
  memoryV2Context: {
    result: {
      verifiedKnowledge: [
        {
          observation: { observationId: 'a' },
          verifiedEvidence: [
            {
              selector: { kind: 'file', path: 'src/a.ts' },
              contentDigest: hash,
            },
          ],
        },
      ],
      rereadRequired: [],
    },
  } as unknown as MemoryTurnContextV2,
})
const result = (path = 'src/a.ts'): ReadFilesItemV1 => ({
  selector: 'file',
  requestIndex: 0,
  status: 'ok',
  path,
  content: text,
  complete: true,
  template: false,
  editAnchor: {
    startLine: 1,
    endLine: 2,
    contentHash: hash,
    readCapability: 'unused',
    rawBasis: getRawReadBasis(captureTextDocument(text), 1, 2, 'whole'),
  },
})

test('B14 completed source read distinguishes unchanged reread from necessary refresh and unknown paths', () => {
  const unchanged = state()
  recordMemoryReadObservation({
    state: unchanged,
    results: [result()],
    requiredRefreshPaths: new Set(),
  })
  expect(unchanged.memoryReuse?.byTool?.[0].observedReads).toEqual([
    { path: 'src/a.ts', contentDigest: hash, reason: 'unchanged-reread' },
  ])
  const required = state()
  recordMemoryReadObservation({
    state: required,
    results: [result()],
    requiredRefreshPaths: new Set(['src/a.ts']),
  })
  expect(required.memoryReuse?.byTool?.[0].observedReads?.[0].reason).toBe(
    'required-refresh',
  )
  const unrelated = state()
  recordMemoryReadObservation({
    state: unrelated,
    results: [result('src/b.ts')],
    requiredRefreshPaths: new Set(),
  })
  expect(unrelated.memoryReuse?.byTool?.[0].observedReads?.[0].reason).toBe(
    'unknown',
  )
  const incomplete = state()
  recordMemoryReadObservation({
    state: incomplete,
    results: [{ ...result(), complete: false } as ReadFilesItemV1],
    requiredRefreshPaths: new Set(),
  })
  expect(incomplete.memoryReuse).toBeUndefined()
})
