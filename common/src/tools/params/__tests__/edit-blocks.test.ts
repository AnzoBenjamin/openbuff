import { afterEach, describe, expect, it } from 'bun:test'

import {
  __setEditBlocksEnabledForTest,
  areEditBlocksEnabled,
  parseEditBlocks,
} from '../edit-blocks'
import { normalizeTransactionEditList } from '../utils'
import { editTransactionParams } from '../tool/edit-transaction'

/** Builds one SEARCH/REPLACE block; body strings may contain \n. */
function block(path: string, search: string, replace: string): string {
  return [
    path,
    '<<<<<<< SEARCH',
    search,
    '=======',
    replace,
    '>>>>>>> REPLACE',
  ].join('\n')
}

describe('parseEditBlocks', () => {
  it('parses a single block into one str_replace edit with one replacement', () => {
    expect(
      parseEditBlocks(
        block('src/a.ts', 'const value = 1', 'const value = 2'),
      ),
    ).toEqual({
      edits: [
        {
          path: 'src/a.ts',
          replacements: [
            { oldString: 'const value = 1', newString: 'const value = 2' },
          ],
        },
      ],
    })
  })

  it('preserves multi-line bodies exactly, including blank lines inside bodies', () => {
    const result = parseEditBlocks(
      block('f.ts', 'line1\n\nline3', 'r1\n\nr3'),
    )
    expect(result).toEqual({
      edits: [
        {
          path: 'f.ts',
          replacements: [
            { oldString: 'line1\n\nline3', newString: 'r1\n\nr3' },
          ],
        },
      ],
    })
  })

  it('coalesces two consecutive same-path blocks into one edit, in order', () => {
    const text = [
      block('a.ts', 'one', 'ONE'),
      '',
      block('a.ts', 'two', 'TWO'),
    ].join('\n')
    expect(parseEditBlocks(text)).toEqual({
      edits: [
        {
          path: 'a.ts',
          replacements: [
            { oldString: 'one', newString: 'ONE' },
            { oldString: 'two', newString: 'TWO' },
          ],
        },
      ],
    })
  })

  it('produces two edits in order for two different paths', () => {
    const text = [block('a.ts', 'x', 'y'), '', block('b.ts', 'p', 'q')].join(
      '\n',
    )
    expect(parseEditBlocks(text)).toEqual({
      edits: [
        { path: 'a.ts', replacements: [{ oldString: 'x', newString: 'y' }] },
        { path: 'b.ts', replacements: [{ oldString: 'p', newString: 'q' }] },
      ],
    })
  })

  it('parses a deletion with an empty replacement body', () => {
    // No line at all between the divider and the REPLACE marker.
    const text = [
      'a.ts',
      '<<<<<<< SEARCH',
      'gone line',
      '=======',
      '>>>>>>> REPLACE',
    ].join('\n')
    expect(parseEditBlocks(text)).toEqual({
      edits: [
        {
          path: 'a.ts',
          replacements: [{ oldString: 'gone line', newString: '' }],
        },
      ],
    })
  })

  it('handles \r\n line endings without corrupting bodies', () => {
    const text = block('a.ts', 'old\nlines', 'new\nlines').replace(
      /\n/g,
      '\r\n',
    )
    expect(parseEditBlocks(text)).toEqual({
      edits: [
        {
          path: 'a.ts',
          replacements: [
            { oldString: 'old\nlines', newString: 'new\nlines' },
          ],
        },
      ],
    })
  })

  it('does not parse `<<<<<<< HEAD` as a block', () => {
    const result = parseEditBlocks(
      ['a.ts', '<<<<<<< HEAD', 'old', '=======', 'new', '>>>>>>> REPLACE'].join(
        '\n',
      ),
    )
    expect('error' in result && result.error.code).toBe('unparseable_block')
  })

  it('does not parse a double-space SEARCH marker', () => {
    const result = parseEditBlocks(
      [
        'a.ts',
        '<<<<<<<  SEARCH',
        'old',
        '=======',
        'new',
        '>>>>>>> REPLACE',
      ].join('\n'),
    )
    expect('error' in result && result.error.code).toBe('unparseable_block')
  })

  it('does not parse a SEARCH marker with trailing whitespace', () => {
    const result = parseEditBlocks(
      [
        'a.ts',
        '<<<<<<< SEARCH ',
        'old',
        '=======',
        'new',
        '>>>>>>> REPLACE',
      ].join('\n'),
    )
    expect('error' in result && result.error.code).toBe('unparseable_block')
  })

  it('fails closed on a 6-equals divider instead of guessing block bounds', () => {
    // The 6-equals line is body content (it does not match the exact
    // divider), so the following REPLACE marker line becomes a body line —
    // a marker collision. Either way the payload is never parsed as blocks.
    const result = parseEditBlocks(
      [
        'a.ts',
        '<<<<<<< SEARCH',
        'old',
        '======',
        'new',
        '>>>>>>> REPLACE',
      ].join('\n'),
    )
    expect('error' in result && result.error.code).toBe('marker_collision')
  })

  it('fails closed on an 8-equals divider', () => {
    const result = parseEditBlocks(
      [
        'a.ts',
        '<<<<<<< SEARCH',
        'old',
        '========',
        'new',
        '>>>>>>> REPLACE',
      ].join('\n'),
    )
    expect('error' in result && result.error.code).toBe('marker_collision')
  })

  it('reports marker_collision with blockIndex when a SEARCH body contains a marker-like line', () => {
    const result = parseEditBlocks(
      block('a.ts', 'x\n<<<<<<< SEARCH\ny', 'z'),
    )
    if (!('error' in result)) {
      throw new Error('expected a parse error')
    }
    expect(result.error.code).toBe('marker_collision')
    expect(result.error.blockIndex).toBe(0)
    expect(result.error.message).toContain('marker-like line')
  })

  it('reports marker_collision for a REPLACE body containing the literal divider', () => {
    // A body line of exactly 7 equals inside a body is the collision case.
    const result = parseEditBlocks(
      block('a.ts', 'old', 'new\n=======\nmore'),
    )
    if (!('error' in result)) {
      throw new Error('expected a parse error')
    }
    expect(result.error.code).toBe('marker_collision')
    expect(result.error.blockIndex).toBe(0)
    expect(result.error.message).toContain('=======')
  })

  it('reports unparseable_block for text before the first block', () => {
    const result = parseEditBlocks(`Please edit:\n${block('a.ts', 'x', 'y')}`)
    expect('error' in result && result.error.code).toBe('unparseable_block')
  })

  it('reports unparseable_block for text after the last REPLACE marker', () => {
    const result = parseEditBlocks(`${block('a.ts', 'x', 'y')}\nDone.`)
    expect('error' in result && result.error.code).toBe('unparseable_block')
  })

  it('reports unparseable_block for an empty SEARCH body', () => {
    const result = parseEditBlocks(
      [
        'a.ts',
        '<<<<<<< SEARCH',
        '=======',
        'new',
        '>>>>>>> REPLACE',
      ].join('\n'),
    )
    if (!('error' in result)) {
      throw new Error('expected a parse error')
    }
    expect(result.error.code).toBe('unparseable_block')
    expect(result.error.blockIndex).toBe(0)
    expect(result.error.message).toContain('empty SEARCH body')
  })

  it('reports unparseable_block when the REPLACE marker is missing', () => {
    const result = parseEditBlocks(
      ['a.ts', '<<<<<<< SEARCH', 'old', '=======', 'new'].join('\n'),
    )
    expect('error' in result && result.error.code).toBe('unparseable_block')
  })
})

describe('areEditBlocksEnabled', () => {
  afterEach(() => {
    // undefined = clear the cached flag so the next call re-reads env.
    __setEditBlocksEnabledForTest(undefined)
  })

  it('uses a truthy-set regex on the trimmed OPENBUFF_EDIT_BLOCKS value', () => {
    const original = process.env.OPENBUFF_EDIT_BLOCKS
    try {
      for (const value of ['1', 'true', 'YES', 'on', ' true ']) {
        process.env.OPENBUFF_EDIT_BLOCKS = value
        __setEditBlocksEnabledForTest(undefined)
        expect(areEditBlocksEnabled()).toBe(true)
      }
      for (const value of ['0', 'false', '', 'off', 'enabled', ' maybe ']) {
        process.env.OPENBUFF_EDIT_BLOCKS = value
        __setEditBlocksEnabledForTest(undefined)
        expect(areEditBlocksEnabled()).toBe(false)
      }
      delete process.env.OPENBUFF_EDIT_BLOCKS
      __setEditBlocksEnabledForTest(undefined)
      expect(areEditBlocksEnabled()).toBe(false)
    } finally {
      if (original === undefined) {
        delete process.env.OPENBUFF_EDIT_BLOCKS
      } else {
        process.env.OPENBUFF_EDIT_BLOCKS = original
      }
    }
  })
})

describe('normalizeTransactionEditList with edit blocks', () => {
  afterEach(() => {
    __setEditBlocksEnabledForTest(undefined)
  })

  it('behaves exactly as today with the flag OFF (falls into the JSON error path)', () => {
    __setEditBlocksEnabledForTest(false)
    const blockText = block('a.ts', 'old', 'new')
    // A non-JSON string is returned unchanged by the existing stringified-JSON
    // handling; the block format must not change that when the flag is off.
    expect(normalizeTransactionEditList(blockText)).toEqual(blockText)
  })

  it('with the flag ON, a JSON-stringified edits array still uses the existing JSON path', () => {
    __setEditBlocksEnabledForTest(true)
    const edits = [
      { path: 'a.ts', replacements: [{ oldString: 'a', newString: 'b' }] },
    ]
    // No SEARCH markers, so the cheap guard skips the block parser entirely.
    expect(normalizeTransactionEditList(JSON.stringify(edits))).toEqual([
      {
        path: 'a.ts',
        replacements: [{ oldString: 'a', newString: 'b' }],
        type: 'str_replace',
      },
    ])
  })

  it('with the flag ON, a JSON payload whose oldString contains a SEARCH-like line is NOT translated', () => {
    __setEditBlocksEnabledForTest(true)
    const jsonPayload = JSON.stringify([
      {
        path: 'a.ts',
        replacements: [
          { oldString: '<<<<<<< SEARCH\nkeep me', newString: 'replaced' },
        ],
      },
    ])
    // The cheap guard fires (the substring exists inside the JSON string),
    // but the block parser fails closed on JSON content and the input passes
    // through unchanged to the JSON pipeline, which infers str_replace.
    expect(normalizeTransactionEditList(jsonPayload)).toEqual([
      {
        path: 'a.ts',
        replacements: [
          { oldString: '<<<<<<< SEARCH\nkeep me', newString: 'replaced' },
        ],
        type: 'str_replace',
      },
    ])
  })

  it('with the flag ON, a parse-error block payload passes through unchanged', () => {
    __setEditBlocksEnabledForTest(true)
    const badPayload = `oops:\n${block('a.ts', 'old', 'new')}`
    expect(normalizeTransactionEditList(badPayload)).toEqual(badPayload)
  })

  it('with the flag ON, valid blocks translate into canonical str_replace edits', () => {
    __setEditBlocksEnabledForTest(true)
    const blockText = [
      block('a.ts', 'old one', 'new one'),
      '',
      block('a.ts', 'old two', 'new two'),
      '',
      block('b.ts', 'old three', 'new three'),
    ].join('\n')
    expect(normalizeTransactionEditList(blockText)).toEqual([
      {
        type: 'str_replace',
        path: 'a.ts',
        replacements: [
          { oldString: 'old one', newString: 'new one' },
          { oldString: 'old two', newString: 'new two' },
        ],
      },
      {
        type: 'str_replace',
        path: 'b.ts',
        replacements: [{ oldString: 'old three', newString: 'new three' }],
      },
    ])
  })
})

describe('edit_transaction input schema with edit blocks', () => {
  afterEach(() => {
    __setEditBlocksEnabledForTest(undefined)
  })

  it('with the flag ON, a block payload parses through the existing input schema as str_replace', () => {
    __setEditBlocksEnabledForTest(true)
    const blockText = [
      block('src/a.ts', 'const value = 1', 'const value = 2'),
      '',
      block('src/b.ts', 'expect(x).toBe(1)', 'expect(x).toBe(2)'),
    ].join('\n')
    const result = editTransactionParams.inputSchema.safeParse({
      edits: blockText,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.edits).toEqual([
        {
          type: 'str_replace',
          path: 'src/a.ts',
          replacements: [
            {
              oldString: 'const value = 1',
              newString: 'const value = 2',
              allowMultiple: false,
            },
          ],
        },
        {
          type: 'str_replace',
          path: 'src/b.ts',
          replacements: [
            {
              oldString: 'expect(x).toBe(1)',
              newString: 'expect(x).toBe(2)',
              allowMultiple: false,
            },
          ],
        },
      ])
    }
  })

  it('with the flag OFF, a block payload fails schema validation exactly as before this feature', () => {
    __setEditBlocksEnabledForTest(false)
    const blockText = block('src/a.ts', 'const value = 1', 'const value = 2')
    const result = editTransactionParams.inputSchema.safeParse({
      edits: blockText,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      // Same failure class the payload produced before edit blocks existed.
      expect(result.error.issues.length).toBeGreaterThan(0)
    }
  })

  it('with the flag ON, a JSON payload still parses through the existing JSON path in the schema', () => {
    __setEditBlocksEnabledForTest(true)
    const result = editTransactionParams.inputSchema.safeParse({
      edits: JSON.stringify([
        { path: 'a.ts', replacements: [{ oldString: 'a', newString: 'b' }] },
      ]),
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.edits[0]?.type).toBe('str_replace')
    }
  })
})
