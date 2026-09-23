import { describe, expect, test } from 'bun:test'

import { repairTruncatedToolInputJson } from '../llm'

describe('repairTruncatedToolInputJson', () => {
  test('repairs input cut mid-string by closing the quote and brackets', () => {
    expect(repairTruncatedToolInputJson('{"a":1,"b":"x')).toBe(
      '{"a":1,"b":"x"}',
    )
  })

  test('repairs trailing-comma junk', () => {
    expect(repairTruncatedToolInputJson('{"a":1,"b":[1,2],')).toBe(
      '{"a":1,"b":[1,2]}',
    )
  })

  test('repairs a dangling key left by the truncation', () => {
    expect(repairTruncatedToolInputJson('{"a":1,"b":')).toBe('{"a":1}')
  })

  test('returns already-valid JSON unchanged (idempotent)', () => {
    expect(repairTruncatedToolInputJson('{"a":1}')).toBe('{"a":1}')
  })

  test('repairs unbalanced nested brackets', () => {
    // M2-T5 repair: the repaired output must be VALID JSON with matching
    // nesting — both the `{` and `[` of the produced prefix close. (The
    // earlier pin here named an invalid single-closed expectation.)
    expect(repairTruncatedToolInputJson('{"a":{"b":[1')).toBe(
      '{"a":{"b":[1]}}',
    )
  })

  test('returns undefined when the broken structure cannot be repaired', () => {
    // Mismatched brackets: truncation repair cannot fix a wrong close.
    expect(repairTruncatedToolInputJson('{"a": 1]')).toBeUndefined()
    // A structural prefix that is not a complete JSON fragment.
    expect(repairTruncatedToolInputJson('{"a" tru')).toBeUndefined()
  })

  test('returns undefined for non-JSON values', () => {
    expect(repairTruncatedToolInputJson('plain text')).toBeUndefined()
    expect(repairTruncatedToolInputJson('')).toBeUndefined()
    expect(repairTruncatedToolInputJson('42')).toBeUndefined()
  })
})
