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
  decodeJsonObjectString,
  recoverTruncatedJsonObject,
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

describe('decodeJsonObjectString', () => {
  test('decodes a plain JSON object string', () => {
    expect(decodeJsonObjectString('{"a":1}')).toEqual({ a: 1 })
  })

  test('decodes a fenced JSON block', () => {
    expect(decodeJsonObjectString('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(decodeJsonObjectString('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  test('strips a `// json` prologue', () => {
    expect(decodeJsonObjectString('// json\n{"a":1}')).toEqual({ a: 1 })
  })

  test('unwraps nested stringified JSON up to three layers deep', () => {
    const inner = { a: 1 }
    const once = JSON.stringify(inner)
    const twice = JSON.stringify(once)
    const thrice = JSON.stringify(twice)
    expect(decodeJsonObjectString(thrice)).toEqual(inner)
    expect(decodeJsonObjectString(twice)).toEqual(inner)
    expect(decodeJsonObjectString(once)).toEqual(inner)
  })

  test('returns non-object pristine JSON as the original string', () => {
    expect(decodeJsonObjectString('[1,2,3]')).toBe('[1,2,3]')
    expect(decodeJsonObjectString('"just a string"')).toBe('"just a string"')
    expect(decodeJsonObjectString('42')).toBe('42')
    expect(decodeJsonObjectString('null')).toBe('null')
  })

  test('falls back to truncated-object recovery for incomplete JSON', () => {
    const truncated = '{"verdict":"LOOKS_GOOD","snapshotFingerprint":"fp"'
    const recovered = decodeJsonObjectString(truncated)
    expect(recovered).toEqual({
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint: 'fp',
    })
  })

  test('returns the original input on unparseable non-object garbage', () => {
    const garbage = 'not json at all'
    expect(decodeJsonObjectString(garbage)).toBe(garbage)
  })

  test('passes native objects through unchanged', () => {
    const obj = { a: 1 }
    expect(decodeJsonObjectString(obj)).toBe(obj)
  })
})

describe('recoverTruncatedJsonObject', () => {
  test('objects without gate-critical keys never qualify (nothing to recover)', () => {
    // recoverTruncatedJsonObject is a truncated-payload fallback: even
    // fully-closed fields return undefined unless a gate-critical key
    // (verdict/snapshotFingerprint/reviewedFiles) survived the cut — pinned
    // legacy behavior via the hasGateCritical filter.
    expect(recoverTruncatedJsonObject('{"a":1}')).toBeUndefined()
    expect(recoverTruncatedJsonObject('{')).toBeUndefined()
    expect(recoverTruncatedJsonObject('[]')).toBeUndefined()
    expect(recoverTruncatedJsonObject('"text"')).toBeUndefined()
  })

  test('recovers only fields with fully-closed values, then gates on gate-critical keys', () => {
    // Trailing `c` object is cut mid-string: recovery keeps ONLY fields whose
    // values fully close; and the recovered set still needs a gate-critical
    // key to qualify at all — a {a,b}-only recoverable prefix returns
    // undefined, a gate-critical bearing one survives.
    expect(
      recoverTruncatedJsonObject('{"a":1,"b":"two","c":{"x":1,"notaflag'),
    ).toBeUndefined()
    const recovered = recoverTruncatedJsonObject(
      '{"verdict":"NON_BLOCKING","snapshotFingerprint":"fp","reviewedFiles":["a.ts"],"c":{"x":1,"notaflag',
    )
    expect(recovered).toEqual({
      verdict: 'NON_BLOCKING',
      snapshotFingerprint: 'fp',
      reviewedFiles: ['a.ts'],
    })
  })

  test('returns undefined when no gate-critical keys are present', () => {
    expect(
      recoverTruncatedJsonObject('{"message":"hello"}'),
    ).toBeUndefined()
  })

  test('recovers a non-reviewer receipt with attestation keys but untrusted verdict value unchanged', () => {
    const s =
      '{"schemaVersion":1,"verdict":"ISH","snapshotFingerprint":"fp","reviewedFiles":[],"findings":[],"coverage":"covered"'
    const recovered = recoverTruncatedJsonObject(s)
    expect(recovered).toEqual({
      schemaVersion: 1,
      verdict: 'ISH',
      snapshotFingerprint: 'fp',
      reviewedFiles: [],
      findings: [],
      coverage: 'covered',
    })
  })

  test('BLOCKING injection for a truncated reviewer receipt', () => {
    const s =
      '{"schemaVersion":1,"verdict":"LOOKS_GOOD","snapshotFingerprint":"fp","reviewedFiles":["a.ts"],"findings":[],"coverage":"covered"'
    const recovered = recoverTruncatedJsonObject(s)
    expect(recovered).toBeDefined()
    expect(recovered!.verdict).toBe('BLOCKING')
    expect(recovered!.requirementCoverage).toEqual([
      {
        requirement: 'requirementCoverage',
        status: 'uncertain',
        evidence: [TRUNCATION_DIMENSION_PLACEHOLDER],
      },
    ])
    const dims = recovered!.dimensions as Record<string, unknown>
    for (const key of REQUIRED_DIMENSION_KEYS) {
      expect(dims[key]).toBe(TRUNCATION_DIMENSION_PLACEHOLDER)
    }
  })

  test('preserves a fully-closed requirementCoverage array (no BLOCKING injection)', () => {
    // The array's closing `]` IS present even though the outer object stays
    // truncated: field-wise recovery captures the closed array, so the
    // placeholder fill never overrides captured values and the verdict is
    // NOT forced to BLOCKING (legacy behavior pinned by set-output-schema tests).
    const s =
      '{"schemaVersion":1,"verdict":"LOOKS_GOOD","snapshotFingerprint":"fp","reviewedFiles":[],"findings":[],"coverage":"covered","requirementCoverage":[{"requirement":"r1","status":"covered","evidence":["src"]}]'
    const recovered = recoverTruncatedJsonObject(s)
    expect(recovered!.verdict).toBe('LOOKS_GOOD')
    expect(recovered!.requirementCoverage).toEqual([
      { requirement: 'r1', status: 'covered', evidence: ['src'] },
    ])
  })

  test('fills only MISSING dimensions when a closed dimensions object is partially complete', () => {
    // The dims object itself closes (`}`) even though the outer object is
    // still truncated: a captured string dimension survives verbatim; only
    // keys that never landed get the placeholder. A dims object cut off
    // mid-body never lands at all and is placeholder-filled entirely.
    const s =
      '{"schemaVersion":1,"verdict":"BLOCKING","snapshotFingerprint":"fp","reviewedFiles":[],"findings":[],"coverage":"covered","dimensions":{"correctness":"good"}'
    const recovered = recoverTruncatedJsonObject(s)
    const dims = recovered!.dimensions as Record<string, unknown>
    expect(dims['correctness']).toBe('good')
    expect(dims['security']).toBe(TRUNCATION_DIMENSION_PLACEHOLDER)
  })
})
