import { describe, expect, test } from 'bun:test'

import {
  CHANGES,
  MAX_FILE_CHANGES_PER_TRANSACTION,
  MAX_TRANSACTION_INPUT_BYTES,
  MAX_TRANSACTION_UNIQUE_PATHS,
} from '../../actions'
import { editTransactionParams } from '../params/tool/edit-transaction'

describe('edit transaction resource limits', () => {
  test('bounds SDK transaction change count', () => {
    const result = CHANGES.safeParse(
      Array.from(
        { length: MAX_FILE_CHANGES_PER_TRANSACTION + 1 },
        (_, index) => ({
          type: 'file' as const,
          path: `file-${index}.txt`,
          content: 'x',
          expectedHash: null,
        }),
      ),
    )
    expect(result.success).toBe(false)
  })

  test('bounds model-facing unique paths', () => {
    const result = editTransactionParams.inputSchema.safeParse({
      edits: Array.from(
        { length: MAX_TRANSACTION_UNIQUE_PATHS },
        (_, index) => ({
          type: 'move' as const,
          path: `source-${index}.txt`,
          destinationPath: `destination-${index}.txt`,
        }),
      ),
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          /unique paths/i.test(issue.message),
        ),
      ).toBe(true)
    }
  })

  test('reports an array-shape error, not an edits-count error, for a stringified edits payload', () => {
    const edit = {
      id: 'x',
      type: 'str_replace' as const,
      path: 'src/a.ts',
      replacements: [
        {
          oldString: 'export const value = 1\nexport const label = "before"',
          newString: 'export const value = 2\nexport const label = "after"',
        },
      ],
    }
    // A truncated encoding is what `normalizeTransactionEditList` deliberately
    // leaves unrepaired, so `edits` reaches the list schema as a raw string.
    // That string is far longer than MAX_FILE_CHANGES_PER_TRANSACTION
    // *characters*, which is exactly why the old chained `.max()` misfired: Zod
    // measured the string's length and emitted "at most 128 edits" even though
    // the payload described a single edit.
    const stringifiedEdits = JSON.stringify([edit]).slice(0, -1)
    expect(stringifiedEdits.length).toBeGreaterThan(
      MAX_FILE_CHANGES_PER_TRANSACTION,
    )

    const result = editTransactionParams.inputSchema.safeParse({
      edits: stringifiedEdits,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          /at most \d+ edits/i.test(issue.message),
        ),
      ).toBe(false)
      expect(
        result.error.issues.some((issue) =>
          /cannot be empty/i.test(issue.message),
        ),
      ).toBe(false)
      expect(
        result.error.issues.some(
          (issue) =>
            issue.code === 'invalid_type' &&
            issue.path.length === 1 &&
            issue.path[0] === 'edits',
        ),
      ).toBe(true)
    }
  })

  test('bounds model-facing edit count for a real array', () => {
    const result = editTransactionParams.inputSchema.safeParse({
      edits: Array.from(
        { length: MAX_FILE_CHANGES_PER_TRANSACTION + 1 },
        (_, index) => ({
          type: 'str_replace' as const,
          path: `file-${index}.ts`,
          replacements: [
            { oldString: 'const value = 1', newString: 'const value = 2' },
          ],
        }),
      ),
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          /at most \d+ edits/i.test(issue.message),
        ),
      ).toBe(true)
    }
  })

  test('rejects an empty model-facing edit list', () => {
    const result = editTransactionParams.inputSchema.safeParse({ edits: [] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          /cannot be empty/i.test(issue.message),
        ),
      ).toBe(true)
      // The bounds moved into superRefine but must keep the codes chained
      // .min()/.max() emitted, so a consumer branching on issue.code (rather
      // than on message text) keeps matching.
      expect(
        result.error.issues.some((issue) => issue.code === 'too_small'),
      ).toBe(true)
    }
  })

  test('keeps the too_big issue code for an oversized edit list', () => {
    const result = editTransactionParams.inputSchema.safeParse({
      edits: Array.from(
        { length: MAX_FILE_CHANGES_PER_TRANSACTION + 1 },
        (_, index) => ({
          type: 'str_replace' as const,
          path: `file-${index}.ts`,
          replacements: [
            { oldString: 'const value = 1', newString: 'const value = 2' },
          ],
        }),
      ),
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.code === 'too_big')).toBe(
        true,
      )
    }
  })

  test('bounds total transaction input bytes without serializing the payload', () => {
    const result = editTransactionParams.inputSchema.safeParse({
      edits: [
        {
          type: 'create' as const,
          path: 'src/huge.ts',
          content: 'x'.repeat(MAX_TRANSACTION_INPUT_BYTES + 1),
        },
      ],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          /exceeds the \d+-byte limit/i.test(issue.message),
        ),
      ).toBe(true)
    }
  })

  test('accepts a payload whose per-field bytes stay under the input limit', () => {
    const result = editTransactionParams.inputSchema.safeParse({
      edits: [
        {
          type: 'create' as const,
          path: 'src/small.ts',
          content: 'export const value = 1\n',
        },
      ],
    })
    expect(result.success).toBe(true)
  })
})
