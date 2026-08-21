/**
 * Containment tests consolidated into sdk/src/tools/__tests__/list-directory.test.ts.
 * This file is retained as a deprecated alias to avoid breaking tooling that
 * resolves the old path; it intentionally contains no duplicate containment
 * suite to avoid maintenance drift (RF-4).
 */
import { describe, expect, test } from 'bun:test'

describe('listDirectory containment (deprecated alias)', () => {
  test('canonical suite lives in sdk/src/tools/__tests__/list-directory.test.ts', () => {
    expect(true).toBe(true)
  })
})
