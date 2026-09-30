import { describe, expect, test } from 'bun:test'

import { hasIncompleteCodeFence, hasMarkdown } from '../markdown-renderer'

describe('markdown-renderer helpers', () => {
  describe('hasMarkdown', () => {
    test('returns false for plain text without markdown markers', () => {
      expect(hasMarkdown('just a plain sentence')).toBe(false)
      expect(hasMarkdown('')).toBe(false)
    })

    test('returns true for emphasis, inline code, headings, quotes and lists', () => {
      expect(hasMarkdown('**bold**')).toBe(true)
      expect(hasMarkdown('_italic_')).toBe(true)
      expect(hasMarkdown('run `ls`')).toBe(true)
      expect(hasMarkdown('# Heading')).toBe(true)
      expect(hasMarkdown('> quoted')).toBe(true)
      expect(hasMarkdown('- item')).toBe(true)
    })

    test('returns true for links and code fences', () => {
      expect(hasMarkdown('[label](https://example.com)')).toBe(true)
      expect(hasMarkdown('```js\ncode\n```')).toBe(true)
    })
  })

  describe('hasIncompleteCodeFence', () => {
    test('returns false for text without fences', () => {
      expect(hasIncompleteCodeFence('plain text')).toBe(false)
      expect(hasIncompleteCodeFence('')).toBe(false)
    })

    test('returns false for an even fence count (all fences closed)', () => {
      expect(hasIncompleteCodeFence('```js\ncode\n```')).toBe(false)
      expect(hasIncompleteCodeFence('```js\na\n```\n```ts\nb\n```')).toBe(
        false,
      )
    })

    test('returns true for an odd fence count (open fence)', () => {
      expect(hasIncompleteCodeFence('```js\nconsole.log(')).toBe(true)
      expect(hasIncompleteCodeFence('```js\na\n```\n```ts\nb')).toBe(true)
    })

    test('counts fences with content between them', () => {
      const content = [
        'before',
        '```js',
        'const a = 1',
        '```',
        'middle',
        '```ts',
        'const b = 2',
        '```',
        'after',
      ].join('\n')
      expect(hasIncompleteCodeFence(content)).toBe(false)
    })
  })
})
