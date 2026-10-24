import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../../hooks/use-theme'
import {
  DiffViewer,
  DIFF_INITIAL_MAX_HUNKS,
  DIFF_INITIAL_MAX_LINES,
  formatLineNumber,
  getInitiallyCollapsedDiffHunks,
  parseDiffIntoHunks,
  showLineNumbersGate,
} from '../diff-viewer'

initializeThemeStore()

const render = (props: React.ComponentProps<typeof DiffViewer>): string =>
  renderToStaticMarkup(<DiffViewer {...props} />)

// Attribute casing on the native <diff> element is not guaranteed by
// react-dom/server, so casing-sensitive attribute assertions run against a
// lowercased copy of the markup.
const lower = (markup: string): string => markup.toLowerCase()

describe('DiffViewer', () => {
  test('[PERF-M02] initial render plan caps hunks and lines', () => {
    const diff = Array.from(
      { length: DIFF_INITIAL_MAX_HUNKS + 2 },
      (_, index) =>
        `@@ -${index + 1},10 +${index + 1},10 @@\n${Array.from({ length: 10 }, () => ' context').join('\n')}`,
    ).join('\n')
    const parsed = parseDiffIntoHunks(diff)
    const collapsed = getInitiallyCollapsedDiffHunks(parsed)
    const visible = parsed.hunks.filter(
      (hunk) => !collapsed.includes(hunk.index),
    )
    expect(visible.length).toBeLessThanOrEqual(DIFF_INITIAL_MAX_HUNKS)
    expect(
      visible.reduce((sum, hunk) => sum + hunk.bodyLines.length, 0),
    ).toBeLessThanOrEqual(DIFF_INITIAL_MAX_LINES)
  })

  test('[PERF-M02] toggles the native line-number gutters via the width gate', () => {
    const diffText = '@@ -1,2 +1,2 @@\n context\n-old\n+new\n'
    // The native <diff> renderable is not a DOM intrinsic element, so
    // react-dom/server does not serialize its props into the static markup —
    // the width gate is asserted against the component's own gate logic
    // (the same computation the renderable's showLineNumbers prop receives).
    expect(showLineNumbersGate(20)).toBe(false)
    expect(showLineNumbersGate(24)).toBe(true)
    expect(showLineNumbersGate(80)).toBe(true)
    // The gate honors the caller's explicit opt-out regardless of width.
    expect(showLineNumbersGate(80, false)).toBe(false)
  })

  describe('parseDiffIntoHunks', () => {
    test('parses a standard hunk header and tracks old/new line numbers', () => {
      const { fileHeaders, hunks } = parseDiffIntoHunks(
        '@@ -1,2 +1,2 @@\n context\n-old\n+new\n',
      )

      expect(fileHeaders).toEqual([])
      expect(hunks).toHaveLength(1)

      const hunk = hunks[0]
      expect(hunk.header).toBe('@@ -1,2 +1,2 @@')
      expect(hunk.oldStart).toBe(1)
      expect(hunk.newStart).toBe(1)
      expect(hunk.oldLen).toBe(2)
      expect(hunk.newLen).toBe(2)

      // context: old=1 new=1 ; del: old=2 new=null ; add: old=null new=2
      expect(hunk.bodyLines).toEqual([
        { type: 'context', text: 'context', oldNum: 1, newNum: 1 },
        { type: 'del', text: 'old', oldNum: 2, newNum: null },
        { type: 'add', text: 'new', oldNum: null, newNum: 2 },
      ])
    })

    test('tolerates a degenerate `@@` hunk header with no ranges', () => {
      const { hunks } = parseDiffIntoHunks('@@\n-oldLine\n+newLine\n')
      expect(hunks).toHaveLength(1)
      expect(hunks[0].oldStart).toBe(1)
      expect(hunks[0].newStart).toBe(1)
      expect(hunks[0].oldLen).toBe(0)
      expect(hunks[0].newLen).toBe(0)
      expect(hunks[0].bodyLines).toEqual([
        { type: 'del', text: 'oldLine', oldNum: 1, newNum: null },
        { type: 'add', text: 'newLine', oldNum: null, newNum: 1 },
      ])
    })

    test('splits leading file headers from hunks', () => {
      const { fileHeaders, hunks } = parseDiffIntoHunks(
        'diff --git a/x b/x\nindex abc..def 100644\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n keep\n',
      )
      expect(fileHeaders).toEqual([
        'diff --git a/x b/x',
        'index abc..def 100644',
        '--- a/x',
        '+++ b/x',
      ])
      expect(hunks).toHaveLength(1)
    })

    test('skips no-newline markers as body rows', () => {
      const { hunks } = parseDiffIntoHunks(
        '@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n',
      )
      expect(hunks[0].bodyLines).toHaveLength(2)
      expect(hunks[0].bodyLines[0].type).toBe('del')
      expect(hunks[0].bodyLines[1].type).toBe('add')
    })
  })

  describe('formatLineNumber', () => {
    test('right-aligns numbers and blanks nulls', () => {
      expect(formatLineNumber(1)).toBe('   1')
      expect(formatLineNumber(12345)).toBe('12345')
      expect(formatLineNumber(null)).toBe('    ')
      expect(formatLineNumber(7, 6)).toBe('     7')
    })
  })

  test('renders one native <diff> per visible hunk in unified view by default', () => {
    const markup = render({
      diffText: '@@ -1,2 +1,2 @@\n context\n-old\n+new\n',
      availableWidth: 80,
    })
    expect(markup).toContain('<diff')
    expect(markup).toContain('view="unified"')
    // The per-hunk text fed to the native parser keeps the @@ header and the
    // +/- body prefixes (serialized into the diff attribute).
    expect(markup).toContain('-old')
    expect(markup).toContain('+new')
  })

  test('collapsed hunks emit no <diff> element, only their toggle button', () => {
    const diff = '@@ -1,2 +1,2 @@\n context\n-old\n+new\n'

    const expanded = render({ diffText: diff, availableWidth: 80 })
    expect(expanded).toContain('▾')
    expect(expanded).toContain('<diff')
    expect(expanded).toContain('-old')

    const collapsed = render({
      diffText: diff,
      availableWidth: 80,
      initiallyCollapsedHunks: [0],
    })
    expect(collapsed).toContain('▸')
    expect(collapsed).toContain('lines hidden')
    expect(collapsed).not.toContain('<diff')
    expect(collapsed).not.toContain('-old')
    expect(collapsed).not.toContain('+new')
  })

  test('collapsed-hunk indices refer to parse order; other hunks still render', () => {
    const diff = '@@ -1,1 +1,1 @@\n-old\n+new\n@@ -5,1 +5,1 @@\n-a\n+b\n'
    const markup = render({
      diffText: diff,
      availableWidth: 80,
      initiallyCollapsedHunks: [0],
    })
    // Exactly one <diff> element: the second (visible) hunk only.
    expect(markup.split('<diff').length - 1).toBe(1)
    expect(markup).not.toContain('-old')
    expect(markup).toContain('-a')
    expect(markup).toContain('+b')
  })

  test('file headers render as plain text outside any <diff> element', () => {
    const markup = render({
      diffText:
        'diff --git a/x b/x\nindex abc..def 100644\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n keep\n',
      availableWidth: 80,
    })
    expect(markup).toContain('diff --git a/x b/x')
    expect(markup).toContain('index abc..def 100644')
    expect(markup).toContain('--- a/x')
    expect(markup).toContain('+++ b/x')
    expect(markup).toContain('<diff')
  })

  test('collapsible=false omits the toggle marker but keeps the header and body', () => {
    const markup = render({
      diffText: '@@ -1,2 +1,2 @@\n context\n-old\n+new\n',
      availableWidth: 80,
      collapsible: false,
    })
    expect(markup).toContain('@@ -1,2 +1,2 @@')
    expect(markup).not.toContain('▾')
    expect(markup).not.toContain('▸')
    expect(markup).toContain('<diff')
    expect(markup).toContain('-old')
  })

  test('side-by-side mode renders the native diff in split view on wide terminals', () => {
    const markup = render({
      diffText: '@@ -1,2 +1,2 @@\n context\n-old\n+new\n',
      availableWidth: 80,
      sideBySide: true,
    })
    // `view` serializes into the static markup; `syncScroll` is a boolean
    // prop on a custom OpenTUI element and does not serialize through
    // react-dom/server, so it is not observable here. The degrade test below
    // pins the unified `view` instead.
    expect(markup).toContain('view="split"')
  })

  test('side-by-side degrades to unified view when width < 40', () => {
    const markup = render({
      diffText: '@@ -1,2 +1,2 @@\n context\n-old\n+new\n',
      availableWidth: 30,
      sideBySide: true,
    })
    expect(markup).toContain('view="unified"')
    expect(markup).not.toContain('view="split"')
    expect(lower(markup)).not.toContain('syncscroll="true"')
  })

  test('backward compat: only diffText + availableWidth keeps -old/+new substrings', () => {
    const markup = render({
      diffText: '@@\n-oldLine\n+newLine\n',
      availableWidth: 80,
    })
    expect(markup).toContain('-oldLine')
    expect(markup).toContain('+newLine')
  })

  test('empty diff renders a muted no-changes placeholder and no <diff>', () => {
    const markup = render({ diffText: '   \n  ', availableWidth: 80 })
    expect(markup).toContain('(no changes)')
    expect(markup).not.toContain('<diff')
  })
})
