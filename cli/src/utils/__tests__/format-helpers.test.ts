import { describe, expect, test } from 'bun:test'

import { deriveTitle, formatAge, pluralizeEntries } from '../format-helpers'

describe('pluralizeEntries', () => {
  test('returns entry for singular', () => {
    expect(pluralizeEntries(1)).toBe('entry')
  })

  test('returns entries for zero and plural', () => {
    expect(pluralizeEntries(0)).toBe('entries')
    expect(pluralizeEntries(2)).toBe('entries')
    expect(pluralizeEntries(100)).toBe('entries')
  })
})

describe('formatAge', () => {
  test('clamps negative to <1s', () => {
    expect(formatAge(-500)).toBe('<1s')
  })

  test('formats sub-second', () => {
    expect(formatAge(0)).toBe('<1s')
    expect(formatAge(500)).toBe('<1s')
    expect(formatAge(999)).toBe('<1s')
  })

  test('formats seconds', () => {
    expect(formatAge(1_000)).toBe('1s')
    expect(formatAge(59_000)).toBe('59s')
  })

  test('formats minutes', () => {
    expect(formatAge(60_000)).toBe('1m')
    expect(formatAge(90_000)).toBe('1m')
    expect(formatAge(3_600_000 - 1)).toBe('59m')
  })

  test('formats hours and minutes', () => {
    expect(formatAge(3_600_000)).toBe('1h 0m')
    expect(formatAge(3_600_000 + 60_000)).toBe('1h 1m')
    expect(formatAge(86_400_000 - 1)).toBe('23h 59m')
  })

  test('formats days and hours', () => {
    expect(formatAge(86_400_000)).toBe('1d 0h')
    expect(formatAge(86_400_000 * 2 + 3_600_000 * 5)).toBe('2d 5h')
  })

  test('day branch intentionally drops minutes for coarse granularity', () => {
    // Minutes are truncated at day scale (documented in formatAge).
    expect(
      formatAge(86_400_000 * 2 + 3_600_000 * 5 + 58 * 60_000),
    ).toBe('2d 5h')
    expect(formatAge(86_400_000 * 10)).toBe('10d 0h')
  })
})

describe('deriveTitle', () => {
  test('derives no title of its own for empty or whitespace', () => {
    // The wording for an empty status line belongs to the renderer, which
    // supplies it with `deriveTitle(line) || 'Index status'`, so this shared
    // util names nothing itself.
    expect(deriveTitle('')).toBe('')
    expect(deriveTitle('   ')).toBe('')
    expect(deriveTitle('\n\t ')).toBe('')
  })

  test('a non-empty line derives a title of its own', () => {
    expect(deriveTitle('Indexed 3 files.')).toBe('Indexed 3 files')
  })

  test('trims and strips trailing period', () => {
    expect(deriveTitle('Hello.')).toBe('Hello')
    expect(deriveTitle('  Hello.  ')).toBe('Hello')
    expect(deriveTitle('Hello world.')).toBe('Hello world')
  })

  test('strips multiple trailing dots', () => {
    // Pins /\.+$/ — an ellipsis is not preserved as a single dot.
    expect(deriveTitle('Hello..')).toBe('Hello')
    expect(deriveTitle('Hello...')).toBe('Hello')
    expect(deriveTitle('Hello....  ')).toBe('Hello')
  })

  test('returns trimmed string when no trailing period', () => {
    expect(deriveTitle('  Hello world  ')).toBe('Hello world')
    expect(deriveTitle('Status: ok')).toBe('Status: ok')
  })
})
