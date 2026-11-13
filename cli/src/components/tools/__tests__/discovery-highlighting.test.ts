import { expect, test } from 'bun:test'
import { splitPatternSegments } from '../discovery-results'

test('untrusted patterns are highlighted literally without evaluating catastrophic regex', () => {
  const text = 'a'.repeat(10_000) + '!'
  expect(splitPatternSegments(text, '(a+)+$')).toEqual([{ text, match: false }])
  expect(splitPatternSegments('a [literal] b', '[literal]')).toEqual([
    { text: 'a ', match: false },
    { text: '[literal]', match: true },
    { text: ' b', match: false },
  ])
})
