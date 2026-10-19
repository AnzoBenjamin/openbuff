import { describe, expect, test } from 'bun:test'

import {
  ATTESTATION_CORE_KEYS,
  GATE_CRITICAL_KEYS,
  MODEL_PAYLOAD_JSON_CHAR_LIMIT,
  REQUIRED_DIMENSION_KEYS,
  REVIEWER_COVERAGE_VALUES,
  REVIEWER_VERDICT_VALUES,
  TRUNCATION_DIMENSION_PLACEHOLDER,
  isReceiptShape,
  unwrapArbitraryEnvelope,
} from '../model-payload-recovery'

describe('isReceiptShape', () => {
  test('accepts a native receipt object', () => {
    expect(
      isReceiptShape({ verdict: 'LOOKS_GOOD', snapshotFingerprint: 'abc' }),
    ).toBe(true)
  })

  test('rejects non-objects, null, and arrays', () => {
    expect(isReceiptShape(null)).toBe(false)
    expect(isReceiptShape(undefined)).toBe(false)
    expect(isReceiptShape('verdict')).toBe(false)
    expect(isReceiptShape(42)).toBe(false)
    expect(
      isReceiptShape(['verdict', 'snapshotFingerprint']),
    ).toBe(false)
  })

  test('rejects objects missing either string field', () => {
    expect(isReceiptShape({ verdict: 'LOOKS_GOOD' })).toBe(false)
    expect(isReceiptShape({ snapshotFingerprint: 'abc' })).toBe(false)
    expect(
      isReceiptShape({ verdict: 42, snapshotFingerprint: 'abc' }),
    ).toBe(false)
    expect(
      isReceiptShape({ verdict: 'LOOKS_GOOD', snapshotFingerprint: 42 }),
    ).toBe(false)
  })
})

describe('unwrapArbitraryEnvelope', () => {
  test('returns a native receipt at top level unchanged', () => {
    const receipt = { verdict: 'BLOCKING', snapshotFingerprint: 'fp' }
    expect(unwrapArbitraryEnvelope(receipt)).toBe(receipt)
  })

  test('unwraps a receipt under an arbitrary key (field-name agnostic)', () => {
    const receipt = { verdict: 'LOOKS_GOOD', snapshotFingerprint: 'fp' }
    for (const key of ['jsonKey', 'jsonValue', 'output', 'result', 'weird']) {
      expect(unwrapArbitraryEnvelope({ [key]: receipt })).toBe(receipt)
    }
  })

  test('unwraps a stringified receipt under an arbitrary key', () => {
    const receipt = { verdict: 'LOOKS_GOOD', snapshotFingerprint: 'fp' }
    const envelope = { jsonValue: JSON.stringify(receipt) }
    const unwrapped = unwrapArbitraryEnvelope(envelope)
    expect(unwrapped).toEqual(receipt)
  })

  test('unwraps a fenced stringified receipt', () => {
    const receipt = { verdict: 'NON_BLOCKING', snapshotFingerprint: 'fp' }
    const envelope = { data: '```json\n' + JSON.stringify(receipt) + '\n```' }
    expect(unwrapArbitraryEnvelope(envelope)).toEqual(receipt)
  })

  test('leaves semi-receipt shapes (missing one field) untouched for schema diagnosis', () => {
    const semi = { verdict: 'LOOKS_GOOD', other: 1 }
    expect(unwrapArbitraryEnvelope(semi)).toBe(semi)
    const semi2 = { snapshotFingerprint: 'fp' }
    expect(unwrapArbitraryEnvelope(semi2)).toBe(semi2)
  })

  test('returns undefined input unchanged', () => {
    expect(unwrapArbitraryEnvelope(undefined)).toBeUndefined()
  })

  test('falls through on malformed JSON strings and non-receipt objects', () => {
    const malformed = { body: '{verdict: oops' }
    expect(unwrapArbitraryEnvelope(malformed)).toBe(malformed)
    const nonReceipt = { data: JSON.stringify({ message: 'hello' }) }
    expect(unwrapArbitraryEnvelope(nonReceipt)).toBe(nonReceipt)
  })

  test('falls through on arrays (not receipts)', () => {
    const values = [{ verdict: 'BLOCKING', snapshotFingerprint: 'fp' }] as unknown
    expect(isReceiptShape(values)).toBe(false)
    const arr = { values }
    expect(unwrapArbitraryEnvelope(arr)).toBe(arr)
  })

  test('oversize string candidates are skipped (opt-in bound respected)', () => {
    const receipt = { verdict: 'BLOCKING', snapshotFingerprint: 'fp' }
    const big = JSON.stringify(receipt)
    expect(big.length).toBeLessThanOrEqual(MODEL_PAYLOAD_JSON_CHAR_LIMIT)
    expect(big.length).toBeGreaterThan(0)
    // With a tighter bound, the stringified receipt is not unwrapped.
    const envelope = { jsonValue: big }
    const tightened = unwrapArbitraryEnvelope(envelope, { maxJsonChars: 10 })
    expect(tightened).toBe(envelope)
    // Default bound accepts it.
    expect(unwrapArbitraryEnvelope(envelope)).toEqual(receipt)
  })

  test('shared constants keep their traded values', () => {
    expect([...GATE_CRITICAL_KEYS]).toEqual([
      'verdict',
      'snapshotFingerprint',
      'reviewedFiles',
    ])
    expect([...ATTESTATION_CORE_KEYS]).toEqual([
      'schemaVersion',
      'verdict',
      'snapshotFingerprint',
      'reviewedFiles',
      'findings',
      'coverage',
    ])
    expect([...REQUIRED_DIMENSION_KEYS]).toEqual([
      'correctness',
      'security',
      'tests',
      'apiCompatibility',
      'performance',
    ])
    expect(REVIEWER_VERDICT_VALUES.has('LOOKS_GOOD')).toBe(true)
    expect(REVIEWER_VERDICT_VALUES.has('BLOCKING')).toBe(true)
    expect(REVIEWER_COVERAGE_VALUES.has('covered')).toBe(true)
    expect(TRUNCATION_DIMENSION_PLACEHOLDER).toBe(
      'recovered-from-truncated-receipt',
    )
  })

  test('model default char limit stays at the historical 1M bound', () => {
    expect(MODEL_PAYLOAD_JSON_CHAR_LIMIT).toBe(1_000_000)
  })
})
