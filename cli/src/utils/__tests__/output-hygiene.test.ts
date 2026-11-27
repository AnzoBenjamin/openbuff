import { describe, expect, test } from 'bun:test'

import { collapseHarnessTags } from '../output-hygiene'

describe('collapseHarnessTags', () => {
  test('preserves fenced and inline source examples while folding matching prose annotations', () => {
    for (const fence of ['```xml', '~~~~xml']) {
      const closing = fence.startsWith('`') ? '```' : '~~~~'
      const source = `${fence}\n<system_warning>literal source</system_warning>\n${closing}\n`
      expect(
        collapseHarnessTags(
          source + '<system_note>annotation</system_note>\nVisible',
        ),
      ).toBe(source + 'Visible')
    }
    for (const source of [
      '`<system_note>literal</system_note>`',
      '``literal ` <system_note>source</system_note>``',
      '`multiline\n<system_note>source</system_note>\ncode`',
    ]) {
      expect(
        collapseHarnessTags(source + '<system_note>annotation</system_note>'),
      ).toBe(source)
    }
    const mismatched = '<system_note>retained</system_warning>'
    expect(collapseHarnessTags(mismatched)).toBe(mismatched)
    const unclosed = '~~~xml\n<system_note>retained source</system_note>'
    expect(collapseHarnessTags(unclosed)).toBe(unclosed)
  })
  test('removes a paired system_warning tag and its content', () => {
    const input =
      'Before.\n<system_warning>Memory note: cached hash drifted.</system_warning>\nAfter.'
    expect(collapseHarnessTags(input)).toBe('Before.\nAfter.')
  })

  test('removes multiline tag bodies and sibling harness tag names', () => {
    expect(
      collapseHarnessTags(
        '<system_note>line one\nline two</system_note>visible text',
      ),
    ).toBe('visible text')
  })

  test('returns the input unchanged when no harness tag is present', () => {
    const input = 'Plain prose with <b>html</b> and <system> config blocks.'
    expect(collapseHarnessTags(input)).toBe(input)
  })

  test('leaves an unclosed tag untouched rather than over-stripping', () => {
    const input = 'streaming so far <system_warning>partial'
    expect(collapseHarnessTags(input)).toBe(input)
  })

  test('collapses to empty string when the tag was the whole content', () => {
    expect(
      collapseHarnessTags('<system_warning>internal only</system_warning>'),
    ).toBe('')
  })

  test('does not mutate the caller string and is pure', () => {
    const input = 'a<system_warning>x</system_warning>b'
    const result = collapseHarnessTags(input)
    expect(result).toBe('ab')
    expect(input).toBe('a<system_warning>x</system_warning>b')
    expect(collapseHarnessTags(input)).toBe(result)
  })
})
