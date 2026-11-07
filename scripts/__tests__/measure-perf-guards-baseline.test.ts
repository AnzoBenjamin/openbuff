/**
 * Smoke test for the fixed-baseline perf benchmark runner.
 *
 * The script's defaults (5 runs × per-case iteration counts) are a real
 * measurement baseline and far too slow for CI, so runPerfGuardsBaseline is
 * driven here with 1 timed run, 0 warmups, and every case scaled to a single
 * timed op. The assertion is behavioral, not numeric: the full case list
 * (CASE 1-13, including the X-2 token-count / code-search / X-2a hot-path /
 * stream-parse rows, the wave-2 capture/cache rows, and the wave-3 identity-
 * window and escalation rows) completes without throwing and returns
 * measured rows.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  runPerfGuardsBaseline,
  serialIdentityHash,
  mapThenJoinIdentityHash,
} from '../measure-perf-guards-baseline'
import { hashIdentityFileBytes } from '../../sdk/src/tools/get-change-review-bundle'

describe('CASE 12 independent identity baselines', () => {
  let fixtureRoot: string
  const files = ['empty.txt', 'quoted " path.txt', 'tail.txt']

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'perf-identity-contract-'))
    writeFileSync(join(fixtureRoot, files[0]!), Buffer.alloc(0))
    writeFileSync(join(fixtureRoot, files[1]!), 'UTF-8 identity: λ\0🧪\n')
    writeFileSync(join(fixtureRoot, files[2]!), Buffer.alloc(400_001, 0xab))
  })

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  async function expectShippedParity(inputFiles = files): Promise<string> {
    const hash = createHash('sha256')
    await hashIdentityFileBytes(hash, fixtureRoot, inputFiles)
    const expected = hash.digest('hex')
    expect(await serialIdentityHash(fixtureRoot, inputFiles)).toBe(expected)
    expect(await mapThenJoinIdentityHash(fixtureRoot, inputFiles)).toBe(expected)
    return expected
  }

  test('matches the shipped oracle for empty, quoted-path and complete binary content', async () => {
    await expectShippedParity()
  })

  test('normalizes unsorted repeated paths to the same unique-file identity', async () => {
    const original = await expectShippedParity()
    expect(await expectShippedParity(['tail.txt', ...files, 'empty.txt'])).toBe(original)
  })

  test('tail edits beyond the former prefix budget change both baseline identities', async () => {
    const original = await expectShippedParity()
    const bytes = Buffer.alloc(400_001, 0xab)
    bytes[400_000] = 0xcd
    writeFileSync(join(fixtureRoot, 'tail.txt'), bytes)
    expect(await expectShippedParity()).not.toBe(original)
  })

  test('mtime-only changes preserve content identity', async () => {
    const original = await expectShippedParity()
    utimesSync(join(fixtureRoot, 'tail.txt'), new Date(0), new Date(0))
    expect(await expectShippedParity()).toBe(original)
  })

  test.skipIf(process.platform === 'win32')(
    'mode changes alter identity without changing content',
    async () => {
      chmodSync(join(fixtureRoot, 'tail.txt'), 0o644)
      const original = await expectShippedParity()
      chmodSync(join(fixtureRoot, 'tail.txt'), 0o600)
      expect(await expectShippedParity()).not.toBe(original)
    },
  )

  test('a missing baseline fixture fails rather than silently removing a contribution', async () => {
    rmSync(join(fixtureRoot, 'tail.txt'))
    await expect(serialIdentityHash(fixtureRoot, files)).rejects.toThrow()
    await expect(mapThenJoinIdentityHash(fixtureRoot, files)).rejects.toThrow()
  })
})

describe('measure-perf-guards-baseline runner smoke', () => {
  test('completes every case and returns measured rows', async () => {
    const rows = await runPerfGuardsBaseline({
      runs: 1,
      warmups: 0,
      // Collapse every case to a single timed op (measure() floors the
      // scaled iteration count at 1).
      iterationsScale: 0.01,
    })

    expect(Array.isArray(rows)).toBe(true)
    // Cases 1-5 and 10-13 each push at least one CaseRow (CASE 1, 2, 3, 3c,
    // 3d, 4, 4d, 5, 10, 11, 12, 12b, 13); the X-2 cases (6-9) print absolute
    // rows without pushing.
    expect(rows.length).toBeGreaterThanOrEqual(10)
    const cases = new Set(rows.map((row) => row.case))
    for (const expected of [
      'CASE 1',
      'CASE 2',
      'CASE 3',
      'CASE 4',
      'CASE 5',
      'CASE 10',
      'CASE 11',
    ]) {
      expect(cases.has(expected)).toBe(true)
    }
    // The backfilled evidence rows for this wave's remaining unmeasured
    // seams: the identity-read window (like-for-like), the retention and
    // escalation contract rows, and their parity/contract assertions.
    for (const expected of ['CASE 12', 'CASE 12b', 'CASE 13']) {
      expect(cases.has(expected)).toBe(true)
    }
    for (const row of rows) {
      expect(row.before.medianMsPerOp).toBeGreaterThan(0)
      expect(row.after.medianMsPerOp).toBeGreaterThan(0)
    }
    // CASE 13 drives a real SIGTERM-ignoring child whose pre-fix reaping
    // waits for the child's natural exit (~1.5s) and is NOT scaled by
    // iterationsScale, so the smoke run carries several seconds of fixed
    // wall-clock cost; give it a generous ceiling instead of the 5s default.
  }, 60_000)
})
