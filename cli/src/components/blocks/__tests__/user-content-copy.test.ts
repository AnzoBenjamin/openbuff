import { describe, test, expect } from 'bun:test'

import {
  hasNewlineThreshold,
  scanChunkForStraddledLink,
} from '../user-content-copy'
import { hasMarkdown } from '../../../utils/markdown-renderer'
import { MAX_COLLAPSED_LINES } from '../../../utils/strings'

// Regression tests pinning the exported pure helpers of
// user-content-copy.tsx:
//
// - hasNewlineThreshold must stay behaviorally equivalent to the former
//   `split('\n').length >= threshold` collapse check (including the
//   off-by-one boundary: a 3-line message with MAX_COLLAPSED_LINES=3 is
//   collapsed) while remaining allocation-free and early-exiting.
// - scanChunkForStraddledLink must carry `[text](url)` state across chunk
//   boundaries so the incremental useContentHasMarkdown scan (hasMarkdown
//   per appended chunk + the state machine) returns exactly what a
//   whole-content hasMarkdown scan would — the O(C) total-scanning
//   invariant without ever re-scanning already-seen bytes.

describe('hasNewlineThreshold', () => {
  test('matches the former split semantics at the collapse boundary', () => {
    // 3 lines = 2 newlines: the old `split('\n').length >= 3` check
    // collapsed this, so the helper must too.
    expect(hasNewlineThreshold('line1\nline2\nline3', MAX_COLLAPSED_LINES)).toBe(
      true,
    )
    // 2 lines = 1 newline: below the threshold, not collapsed.
    expect(hasNewlineThreshold('line1\nline2', MAX_COLLAPSED_LINES)).toBe(false)
  })

  test('is equivalent to split("\\n").length >= threshold for all shapes', () => {
    const contents = [
      '',
      'a',
      'a\n',
      '\n',
      'a\nb',
      'a\n\nb',
      'a\nb\n',
      'a\nb\nc',
      'a\nb\nc\n',
      'a\nb\nc\nd',
      'a\nb\nc\nd\ne\nf\ng',
    ]
    for (const content of contents) {
      for (let threshold = 0; threshold <= 6; threshold++) {
        expect(hasNewlineThreshold(content, threshold)).toBe(
          content.split('\n').length >= threshold,
        )
      }
    }
  })

  test('treats threshold <= 1 as always collapsible (empty content included)', () => {
    for (const threshold of [0, 1]) {
      expect(hasNewlineThreshold('', threshold)).toBe(true)
      expect(hasNewlineThreshold('a', threshold)).toBe(true)
    }
  })
})

describe('scanChunkForStraddledLink', () => {
  test('stays in base when no link starts', () => {
    expect(scanChunkForStraddledLink('base', 'plain text 123 *')).toEqual({
      state: 'base',
      linkCompleted: false,
    })
  })

  test('enters link-text on an unclosed [', () => {
    expect(scanChunkForStraddledLink('base', 'see [docs')).toEqual({
      state: 'link-text',
      linkCompleted: false,
    })
  })

  test('completes a link fully inside one chunk and resets to base', () => {
    expect(scanChunkForStraddledLink('base', 'see [docs](http://x) now')).toEqual({
      state: 'base',
      linkCompleted: true,
    })
  })

  test('carries link-text across a chunk boundary to completion', () => {
    const first = scanChunkForStraddledLink('base', 'a [link')
    expect(first).toEqual({ state: 'link-text', linkCompleted: false })

    const second = scanChunkForStraddledLink(first.state, ' text](url) b')
    expect(second).toEqual({ state: 'base', linkCompleted: true })
  })

  test('carries link-close across a boundary (] and ( straddle chunks)', () => {
    const first = scanChunkForStraddledLink('base', 'a [x]')
    expect(first).toEqual({ state: 'link-close', linkCompleted: false })

    const second = scanChunkForStraddledLink(first.state, '(y) b')
    expect(second).toEqual({ state: 'base', linkCompleted: true })
  })

  test('resets to base when ] is not immediately followed by (', () => {
    expect(scanChunkForStraddledLink('base', '[a] (b)')).toEqual({
      state: 'base',
      linkCompleted: false,
    })
  })

  test('restarts a new link when ] is followed by [', () => {
    const first = scanChunkForStraddledLink('base', '[a]')
    expect(first).toEqual({ state: 'link-close', linkCompleted: false })

    const second = scanChunkForStraddledLink(first.state, '[b](c)')
    expect(second).toEqual({ state: 'base', linkCompleted: true })
  })

  test('stays in link-url until the closing ) ignoring interior brackets', () => {
    expect(scanChunkForStraddledLink('base', '[a](b[c](d')).toEqual({
      state: 'link-url',
      linkCompleted: false,
    })
  })

  test('an unterminated link never completes', () => {
    let state: ReturnType<typeof scanChunkForStraddledLink>['state'] = 'base'
    for (const chunk of ['[', 'un', 'closed']) {
      const result = scanChunkForStraddledLink(state, chunk)
      expect(result.linkCompleted).toBe(false)
      state = result.state
    }
    expect(state).toBe('link-text')
  })
})

describe('incremental scan equivalence with whole-content hasMarkdown', () => {
  // Simulates the useContentHasMarkdown incremental scan: hasMarkdown over
  // each newly appended chunk (its fast path) plus the straddled-link state
  // machine carrying across boundaries. The combined result must equal a
  // single whole-content hasMarkdown scan for every chunking — that equality
  // is what lets the stream scan only O(C) bytes total instead of re-running
  // the regex over the full O(C·T) content per tick.
  const incrementalScan = (chunks: string[]): boolean => {
    let state: ReturnType<typeof scanChunkForStraddledLink>['state'] = 'base'
    for (const chunk of chunks) {
      if (hasMarkdown(chunk)) return true
      const result = scanChunkForStraddledLink(state, chunk)
      if (result.linkCompleted) return true
      state = result.state
    }
    return false
  }

  const straddle = (content: string, cuts: number[]): string[] => {
    const chunks: string[] = []
    let prev = 0
    for (const cut of cuts) {
      chunks.push(content.slice(prev, cut))
      prev = cut
    }
    chunks.push(content.slice(prev))
    return chunks
  }

  const linkOnly = '[release notes](https://example.com/v1.2)'

  test('detects a link straddling every possible chunk boundary', () => {
    for (let cut = 1; cut < linkOnly.length; cut++) {
      const chunks = straddle(linkOnly, [cut])
      // No single chunk may contain the whole pattern, otherwise the fast
      // path masks the state machine under test.
      for (const chunk of chunks) {
        expect(hasMarkdown(chunk)).toBe(false)
      }
      expect(incrementalScan(chunks)).toBe(hasMarkdown(linkOnly))
      expect(incrementalScan(chunks)).toBe(true)
    }
  })

  test('detects a link straddling three chunks', () => {
    const chunks = straddle(linkOnly, [5, 20])
    for (const chunk of chunks) {
      expect(hasMarkdown(chunk)).toBe(false)
    }
    expect(incrementalScan(chunks)).toBe(hasMarkdown(linkOnly))
    expect(incrementalScan(chunks)).toBe(true)
  })

  test('matches whole-content hasMarkdown across chunkings and contents', () => {
    const contents = [
      'no markdown at all',
      'plain with *emphasis* inside a chunk',
      linkOnly,
      `before ${linkOnly} after`,
      '[a] (b) not a link',
      '[unclosed link',
      'x [a] y [b](c) z',
    ]
    for (const content of contents) {
      for (const size of [1, 2, 3, 7, content.length]) {
        const chunks: string[] = []
        for (let i = 0; i < content.length; i += size) {
          chunks.push(content.slice(i, i + size))
        }
        expect(incrementalScan(chunks)).toBe(hasMarkdown(content))
      }
    }
  })
})
