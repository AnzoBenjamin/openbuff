import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

const OPEN_MARKER = '// <gate-helpers-generated>'
const CLOSE_MARKER = '// </gate-helpers-generated>'

// The test file lives at agents/__tests__/, so ../../ reaches the repo root.
const repoRoot = new URL('../../', import.meta.url).pathname

/** Trim trailing whitespace on each line so the comparison ignores it. */
function normalizeTrailingWhitespace(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
}

/** Extract the marker region (inclusive of both marker lines) from base2.ts. */
function extractRegion(source: string): string {
  const start = source.indexOf(OPEN_MARKER)
  if (start === -1) {
    throw new Error(`Unable to find ${OPEN_MARKER} marker in base2.ts`)
  }
  const closeStart = source.indexOf(CLOSE_MARKER, start)
  if (closeStart === -1) {
    throw new Error(`Unable to find ${CLOSE_MARKER} marker in base2.ts`)
  }
  return source.slice(start, closeStart + CLOSE_MARKER.length)
}

describe('gate-helpers freshness', () => {
  test('generated region matches base2.ts inline block', () => {
    const generated = execSync('bun run scripts/generate-gate-helpers.ts', {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()

    const base2Source = readFileSync(
      new URL('../base2/base2.ts', import.meta.url),
      'utf8',
    )
    const region = extractRegion(base2Source)

    if (
      normalizeTrailingWhitespace(region) !==
      normalizeTrailingWhitespace(generated)
    ) {
      throw new Error(
        'gate-helpers region in base2.ts is stale — run: bun run scripts/generate-gate-helpers.ts --write agents/base2/base2.ts',
      )
    }

    // Sanity check: the generator strips `export` modifiers so the region can
    // be spliced verbatim into the serialized handleSteps generator body.
    expect(region).not.toContain('export ')
  })
})
