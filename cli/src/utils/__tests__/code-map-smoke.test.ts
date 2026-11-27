import { describe, expect, test } from 'bun:test'

import { formatCodeMapSmoke, runCodeMapSmoke } from '../code-map-smoke'

describe('code-map release smoke probe (N09)', () => {
  test('indexes the TS fixture with symbols, calls and imports', async () => {
    const result = await runCodeMapSmoke()
    expect(result.ok).toBe(true)
    expect(result.symbols).toBeGreaterThan(0)
    expect(result.calls).toBeGreaterThan(0)
    expect(result.imports).toBeGreaterThan(0)
    expect(formatCodeMapSmoke(result)).toStartWith('code-map smoke ok (')
  })

  test('fails when queries are missing or extraction is empty', async () => {
    const result = await runCodeMapSmoke({
      getStatus: () => ({
        total: 1,
        available: [],
        missing: ['tree-sitter-typescript-tags.scm'],
      }),
      scoreFiles: (async () => ({
        parsed: { 'main.ts': { identifiers: [], calls: [], numLines: 1 } },
      })) as never,
    })
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'missing tag queries: tree-sitter-typescript-tags.scm',
      'no symbols extracted',
      'no calls extracted',
      'no imports extracted',
    ])
    expect(formatCodeMapSmoke(result)).toStartWith('code-map smoke FAIL')
  })
})
