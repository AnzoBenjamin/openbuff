import { describe, expect, test } from 'bun:test'

import {
  createStructuredPreview,
  formatStructuredPreview,
  parseStructuredPreview,
} from '../structured-preview'

describe('structured preview', () => {
  test('strips terminal escape sequences and controls from labels and values', () => {
    const text = formatStructuredPreview({
      ['\u001b[31mstatus\u001b[0m']:
        '\u001b]0;fake title\u0007Ready\u0000\u0008',
      message: 'first line\nsecond line',
    })
    expect(text).toContain('status: Ready')
    expect(text).toContain('first line\nsecond line')
    expect(text).not.toContain('fake title')
    expect(text).not.toMatch(/[\u0000\u0007\u0008\u001b]/)
  })
  test('groups nested records and lists without repeating a complete field path', () => {
    const text = formatStructuredPreview({
      status: 'ready',
      diagnostics: [{ filePath: 'src/a.ts', message: 'Missing export' }],
      retryable: false,
    })
    expect(text).toBe(
      'status: ready\ndiagnostics:\n  1.\n    file path: src/a.ts\n    message: Missing export\nretryable: No',
    )
    expect(text).not.toContain('diagnostics · 1 ·')
    expect(text).not.toContain('"filePath"')
  })

  test('decodes complete serialized containers and keeps malformed text readable', () => {
    expect(
      formatStructuredPreview({ details: '{"files":["a.ts"]}' }),
    ).toContain('files:\n    1. a.ts')
    expect(formatStructuredPreview({ details: '{unfinished' })).toContain(
      '{unfinished',
    )
    expect(parseStructuredPreview('x'.repeat(500_001))).toBeUndefined()
  })

  test('bounds large sparse collections without evaluating accessors', () => {
    let reads = 0
    const rows = createStructuredPreview({
      get detail() {
        reads++
        throw new Error('evaluated')
      },
      files: new Array(1_000_000),
    })
    expect(reads).toBe(0)
    expect(rows.length).toBeLessThanOrEqual(31)
    expect(rows.at(-1)?.value).toContain('Preview limited')
  })

  test('bounds deep and cyclic values while permitting shared subtrees', () => {
    const shared = { path: 'src/a.ts' }
    const value: Record<string, unknown> = { first: shared, second: shared }
    value.self = value
    const text = formatStructuredPreview(value)
    expect(text.match(/path: src\/a.ts/g)).toHaveLength(2)
    expect(text).toContain('Circular reference')
    expect(
      formatStructuredPreview({ a: { b: { c: { d: { e: { f: 1 } } } } } }),
    ).toContain('Nested details')
  })

  test('caps long labels and values with a visible inspection hint', () => {
    const text = formatStructuredPreview({
      ['x'.repeat(20_000)]: 'y'.repeat(100_000),
    })
    expect(text.length).toBeLessThan(8_500)
    expect(text).toContain('Preview limited · Inspect')
  })
})
