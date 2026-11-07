import { expect, test } from 'bun:test'
import stringWidth from 'string-width'
import {
  nextGrapheme,
  previousGrapheme,
  sliceTextCells,
} from '../text-boundaries'

test.each(['👩🏽‍💻', 'e\u0301', '🇺🇬', '界'])(
  'cursor and deletion boundaries preserve the complete cluster %s',
  (cluster) => {
    const text = `a${cluster}b`
    expect(nextGrapheme(text, 1)).toBe(1 + cluster.length)
    expect(previousGrapheme(text, 1 + cluster.length)).toBe(1)
    expect(
      text.slice(0, previousGrapheme(text, 1 + cluster.length)) +
        text.slice(1 + cluster.length),
    ).toBe('ab')
  },
)
test('cell slices stay within width and never split wide or combining content', () => {
  expect(sliceTextCells('a👩🏽‍💻b', 0, 2)).toBe('a')
  expect(sliceTextCells('a👩🏽‍💻b', 1, 2)).toBe('👩🏽‍💻')
  expect(sliceTextCells('e\u0301界x', 0, 3)).toBe('e\u0301界')
  expect(stringWidth(sliceTextCells('界'.repeat(20), 0, 9))).toBe(8)
})
