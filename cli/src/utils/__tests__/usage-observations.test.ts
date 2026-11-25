import { afterEach, expect, test } from 'bun:test'
import {
  clearUsageObservations,
  recordUsageObservation,
  usageSnapshot,
} from '../usage-observations'

afterEach(clearUsageObservations)
test('B09 usage preserves root/child model observations, fractional costs and partial token totals', () => {
  recordUsageObservation('session', 'turn', {
    type: 'usage',
    runId: 'root',
    model: 'p/model',
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 4,
    complete: true,
    costCents: 0.0018,
    costStatus: 'estimated',
  })
  recordUsageObservation('session', 'turn', {
    type: 'usage',
    runId: 'child',
    model: 'p/other',
    inputTokens: 5,
    complete: false,
    costStatus: 'unknown',
    costReason: 'missing output tokens',
  })
  const snapshot = usageSnapshot('session')
  expect(snapshot.observations).toBe(2)
  expect(snapshot.inputTokens).toBe(15)
  expect(snapshot.outputTokens).toBe(2)
  expect(snapshot.outputComplete).toBe(false)
  expect(snapshot.knownCostCents).toBeCloseTo(0.0018, 12)
  expect(snapshot.unknownCosts).toBe(1)
  expect(snapshot.rows.map((row) => row.runId)).toEqual(['root', 'child'])
  expect(usageSnapshot('other').observations).toBe(0)
})
test('bounded rows preserve cumulative totals and explicit omissions; identical requests are not collapsed', () => {
  for (let index = 0; index < 150; index++)
    recordUsageObservation('session', 'turn', {
      type: 'usage',
      runId: 'root',
      inputTokens: 1,
      outputTokens: 1,
      complete: true,
      costCents: 0.01,
      costStatus: 'observed',
    })
  const snapshot = usageSnapshot('session')
  expect(snapshot.observations).toBe(150)
  expect(snapshot.rows).toHaveLength(100)
  expect(snapshot.omittedRows).toBe(50)
  expect(snapshot.inputTokens).toBe(150)
  expect(snapshot.knownCostCents).toBeCloseTo(1.5, 10)
})
test('aggregate overflow retains bounded finite subtotals and explicitly marks incomplete accounting', () => {
  for (let index = 0; index < 2; index++)
    recordUsageObservation('s', 't', {
      type: 'usage',
      runId: 'run',
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 1,
      complete: true,
      costStatus: 'observed',
      costCents: 1e308,
    })
  const snapshot = usageSnapshot('s')
  expect(snapshot.aggregateOverflow).toBe(true)
  expect(Number.isFinite(snapshot.knownCostCents)).toBe(true)
  expect(Number.isSafeInteger(snapshot.inputTokens)).toBe(true)
})

test('unknown legacy and subscription costs never manufacture zero-price completeness', () => {
  recordUsageObservation('s', 't', {
    type: 'usage',
    runId: 'root',
    inputTokens: 0,
    outputTokens: 0,
    complete: true,
  })
  recordUsageObservation('s', 't', {
    type: 'usage',
    runId: 'child',
    complete: false,
    costStatus: 'subscription',
  })
  expect(usageSnapshot('s')).toMatchObject({
    unknownCosts: 1,
    subscriptionRequests: 1,
    knownCostCents: 0,
  })
})
