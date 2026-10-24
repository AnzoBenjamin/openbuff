import { describe, expect, test } from 'bun:test'

import { collapseHarnessTags } from '../output-hygiene'

describe('collapseHarnessTags', () => {
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
