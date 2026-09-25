import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..', '..')

/**
 * M4-T3 flake ledger schema (single source: the 'Record test flakiness' step
 * in .github/workflows/ci.yml, which writes suite -> last observed
 * nick-fields/retry `total_attempts`). A suite whose recorded attempts stay
 * above 1 is flaking under the x3 retry and needs its isolation fixed, not
 * more retries.
 */
describe('flake ledger', () => {
  const ledger: Record<string, unknown> = JSON.parse(
    readFileSync(join(repoRoot, 'scripts', 'flake-ledger.json'), 'utf8'),
  )

  const ciYml = readFileSync(
    join(repoRoot, '.github', 'workflows', 'ci.yml'),
    'utf8',
  )

  /** Suite names from the workflow's test-job package matrix. */
  function matrixPackages(): string[] {
    const match = ciYml.match(/package:\s*\n\s*\[([^\]]+)\]/)
    expect(match).not.toBeNull()
    return match![1]!
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  }

  test('ledger keys are CI test-job suites, values are attempt counts', () => {
    const packages = matrixPackages()
    for (const [suite, attempts] of Object.entries(ledger)) {
      expect(packages).toContain(suite)
      expect(typeof attempts).toBe('number')
      expect(Number.isInteger(attempts)).toBe(true)
      expect(attempts as number).toBeGreaterThanOrEqual(1)
    }
  })

  test('workflow consumes exactly the checked-in ledger path', () => {
    expect(ciYml).toContain('scripts/flake-ledger.json')
  })
})
