import { describe, expect, test } from 'bun:test'

import {
  boundedFallbackJson,
  boundedFallbackOutput,
  formatFallbackOutput,
  hasFallbackInputValue,
  MAX_FALLBACK_INPUT_ROWS,
  MAX_FALLBACK_INPUT_JSON_CHARS,
  MAX_FALLBACK_OUTPUT_CHARS,
  summarizeFallbackInput,
} from '../fallback-input-summary'

describe('summarizeFallbackInput', () => {
  test('renders scalar and string-list entries as key: value rows', () => {
    expect(
      summarizeFallbackInput({
        query: 'archive eviction floor',
        limit: 5,
        verbose: true,
        paths: ['sdk/src', 'cli/src'],
      }),
    ).toBe(
      'query: archive eviction floor\nlimit: 5\nverbose: yes\npaths: sdk/src, cli/src',
    )
  })

  test('omits empty strings and nested objects with an honest note', () => {
    expect(
      summarizeFallbackInput({
        empty: '   ',
        nested: { deep: true },
        path: 'src/index.ts',
      }),
    ).toBe('path: src/index.ts\n… 2 more fields omitted')
  })

  test('returns no rows for a nested-only input so the caller uses bounded JSON', () => {
    expect(summarizeFallbackInput({ nested: { deep: { deeper: 1 } } })).toBe('')
  })

  test('returns no rows for primitive and absent inputs', () => {
    expect(summarizeFallbackInput(undefined)).toBe('')
    expect(summarizeFallbackInput('just a string')).toBe('')
    expect(summarizeFallbackInput(['a', 'b'])).toBe('')
  })

  test('caps the row count and reports the remainder', () => {
    const input = Object.fromEntries(
      Array.from({ length: MAX_FALLBACK_INPUT_ROWS + 4 }, (_unused, index) => [
        `key${index}`,
        index,
      ]),
    )
    const lines = summarizeFallbackInput(input).split('\n')
    expect(lines).toHaveLength(MAX_FALLBACK_INPUT_ROWS + 1)
    expect(lines.at(-1)).toBe('… 4 more fields omitted')
  })

  test('truncates an over-long value while keeping the key readable', () => {
    const summary = summarizeFallbackInput({ command: 'x'.repeat(400) })
    const value = summary.slice('command: '.length)
    // The cap bounds the VALUE, not the whole `key: value` row, so the row is
    // the prefix plus a 160-char value (159 kept + the ellipsis).
    expect(summary.startsWith('command: ')).toBe(true)
    expect(value).toHaveLength(160)
    expect(value.endsWith('…')).toBe(true)
  })
})

describe('hasFallbackInputValue', () => {
  test('is false for absent and empty-record inputs', () => {
    expect(hasFallbackInputValue(undefined)).toBe(false)
    expect(hasFallbackInputValue(null)).toBe(false)
    expect(hasFallbackInputValue({})).toBe(false)
  })

  test('is true for populated records, arrays, and primitives', () => {
    expect(hasFallbackInputValue({ a: 1 })).toBe(true)
    expect(hasFallbackInputValue(['a'])).toBe(true)
    expect(hasFallbackInputValue('a')).toBe(true)
    expect(hasFallbackInputValue(0)).toBe(true)
  })
})

describe('bounded fallback bodies', () => {
  test('formats structured tool results and retains nested values', () => {
    expect(
      formatFallbackOutput(
        JSON.stringify({
          status: 'failed',
          diagnostics: [{ filePath: 'src/a.ts', message: 'not found' }],
          retryable: false,
        }),
      ),
    ).toBe(
      'status: failed\ndiagnostics · 1 · file path: src/a.ts\ndiagnostics · 1 · message: not found\nretryable: false',
    )
  })

  test('preserves prose and makes truncation of structured entries visible', () => {
    expect(formatFallbackOutput('plain output')).toBe('plain output')
    expect(formatFallbackOutput('{not json')).toBe('{not json')
    expect(
      formatFallbackOutput(
        JSON.stringify(Array.from({ length: 35 }, (_, i) => i)),
      ),
    ).toContain('… 5 more entries omitted')
  })

  test('bounds pretty JSON', () => {
    const json = boundedFallbackJson({ deep: { deeper: 'x'.repeat(5_000) } })
    expect(json.length).toBe(MAX_FALLBACK_INPUT_JSON_CHARS)
    expect(json.endsWith('…')).toBe(true)
  })

  test('bounds plain output', () => {
    const body = boundedFallbackOutput('y'.repeat(9_000))
    expect(body.length).toBe(MAX_FALLBACK_OUTPUT_CHARS)
    expect(body.endsWith('…')).toBe(true)
  })

  test('survives an unserializable value', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(boundedFallbackJson(cyclic)).toContain(
      '[shared or circular reference]',
    )
  })
})

test('nested fallback projection is bounded without invoking accessors or serializing the full collection', () => {
  const input = {
    scalar: 'visible',
    nested: new Array(1_000_000),
    get accessor() {
      throw new Error('accessor evaluated')
    },
  }
  expect(summarizeFallbackInput(input)).toContain('scalar: visible')
  expect(boundedFallbackJson(input).length).toBeLessThanOrEqual(
    MAX_FALLBACK_INPUT_JSON_CHARS,
  )
})
