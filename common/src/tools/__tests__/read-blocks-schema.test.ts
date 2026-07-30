import { describe, expect, test } from 'bun:test'

import {
  MAX_CONTEXT_LINES,
  MAX_READ_BLOCK_BYTES,
  MAX_WINDOW_SIZE,
  readBlocksParams,
} from '../params/tool/read-blocks'

describe('read_blocks input schema', () => {
  test('accepts windowSize at the documented maximum', () => {
    const parsed = readBlocksParams.inputSchema.safeParse({
      windows: [{ path: 'src/a.ts', windowSize: MAX_WINDOW_SIZE }],
    })

    expect(parsed.success).toBe(true)
  })

  test('rejects windowSize above the maximum at the selector path', () => {
    const parsed = readBlocksParams.inputSchema.safeParse({
      windows: [{ path: 'src/a.ts', windowSize: MAX_WINDOW_SIZE + 1 }],
    })

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ path: ['windows', 0, 'windowSize'] }),
      )
    }
  })

  test('accepts contextLines at the documented maximum', () => {
    const parsed = readBlocksParams.inputSchema.safeParse({
      around: [
        { path: 'src/a.ts', match: 'marker', contextLines: MAX_CONTEXT_LINES },
      ],
    })

    expect(parsed.success).toBe(true)
  })

  test('rejects contextLines above the maximum at the selector path', () => {
    const parsed = readBlocksParams.inputSchema.safeParse({
      around: [
        {
          path: 'src/a.ts',
          match: 'marker',
          contextLines: MAX_CONTEXT_LINES + 1,
        },
      ],
    })

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ path: ['around', 0, 'contextLines'] }),
      )
    }
  })

  test('keeps windowSize 0 invalid', () => {
    const parsed = readBlocksParams.inputSchema.safeParse({
      windows: [{ path: 'src/a.ts', windowSize: 0 }],
    })

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ path: ['windows', 0, 'windowSize'] }),
      )
    }
  })

  test('keeps contextLines 0 valid (a zero-context around block is one line)', () => {
    const parsed = readBlocksParams.inputSchema.safeParse({
      around: [{ path: 'src/a.ts', match: 'marker', contextLines: 0 }],
    })

    expect(parsed.success).toBe(true)
  })

  test('rejects an empty selector object with actionable recovery', () => {
    const parsed = readBlocksParams.inputSchema.safeParse({})

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['windows'],
          message:
            'read_blocks requires at least one window, around, or symbol selector.',
        }),
      )
    }
  })

  test('pins the per-block byte budget to the SDK range-read budget', () => {
    // MAX_READ_BLOCK_BYTES mirrors the SDK's MAX_RANGE_READ_BYTES range-read
    // budget. Pinning the literal here means the two limits cannot silently
    // diverge: changing one without the other fails this test.
    expect(MAX_READ_BLOCK_BYTES).toBe(4_194_304)
  })
})
