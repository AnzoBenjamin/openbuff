import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

import type { MarkdownPalette } from '../markdown-renderer'

// Same registry-wide leak-guard pattern as
// components/blocks/__tests__/content-with-markdown.test.tsx: capture the real
// @opentui/core module first, spread its exports, and have the counting stub
// delegate back to the real module once disarmed (bun's --isolate reuses
// worker processes across test files, so an unconditional stub would leak
// stubbed SyntaxStyle behavior into later files in the same worker).
const realOpenTuiCore = (await import(
  '@opentui/core'
)) as typeof import('@opentui/core')

interface StubSyntaxStyle {
  stubId: number
  styles: Record<string, unknown>
}

let fromStylesCalls = 0
const fromStylesInputs: Record<string, unknown>[] = []
let coreStubArmed = true

mock.module('@opentui/core', () => ({
  // Real exports first (registry-wide leak guard); the counting stub below
  // must keep winning while armed.
  ...realOpenTuiCore,
  SyntaxStyle: {
    fromStyles: (styles: Record<string, unknown>) => {
      if (!coreStubArmed) {
        return realOpenTuiCore.SyntaxStyle.fromStyles(
          styles as Parameters<
            typeof realOpenTuiCore.SyntaxStyle.fromStyles
          >[0],
        )
      }
      fromStylesCalls += 1
      fromStylesInputs.push(styles)
      return { stubId: fromStylesCalls, styles }
    },
  },
}))

afterAll(() => {
  coreStubArmed = false
})

const {
  createMarkdownSyntaxStyle,
  clearMarkdownSyntaxStyleCacheForTests,
} = await import('../opentui-syntax-style')

const makePalette = (): Partial<MarkdownPalette> => ({
  inlineCodeFg: '#a8a8ff',
  codeBackground: '#1e1e2e',
  codeHeaderFg: '#c0c0ff',
  headingFg: { 1: '#ffffff' },
  listBulletFg: '#89dceb',
  blockquoteBorderFg: '#5b5b7a',
  blockquoteTextFg: '#cdd6f4',
  codeMonochrome: false,
  linkFg: '#89b4fa',
})

describe('createMarkdownSyntaxStyle memoization', () => {
  beforeEach(() => {
    clearMarkdownSyntaxStyleCacheForTests()
    fromStylesCalls = 0
    fromStylesInputs.length = 0
  })

  test('returns the same handle for repeated calls with the same palette object', () => {
    const palette = makePalette()

    const first = createMarkdownSyntaxStyle(palette)
    const second = createMarkdownSyntaxStyle(palette)

    expect(second).toBe(first)
    expect(fromStylesCalls).toBe(1)
  })

  test('allocates once per distinct palette object, not per call', () => {
    // Deep-equal palettes are distinct objects: each gets its own handle, but
    // repeated renders with the SAME object must not allocate again.
    const a = createMarkdownSyntaxStyle(makePalette())
    const b = createMarkdownSyntaxStyle(makePalette())

    expect(a).not.toBe(b)
    expect(fromStylesCalls).toBe(2)
  })

  test('passes the palette mapping through unchanged on the cached handle', () => {
    const style = createMarkdownSyntaxStyle(makePalette()) as unknown as StubSyntaxStyle

    // The cache must not alter the style content: the mapping emitted by the
    // single fromStyles call is byte-identical to the unmemoized factory.
    expect(fromStylesInputs).toHaveLength(1)
    expect(style.styles['markup.raw']).toEqual({
      fg: '#a8a8ff',
      bg: '#1e1e2e',
      bold: true,
    })
    expect(style.styles['markup.link']).toEqual({ fg: '#89b4fa' })
  })

  test('undefined palette is memoized too', () => {
    const first = createMarkdownSyntaxStyle()
    const second = createMarkdownSyntaxStyle(undefined)

    expect(second).toBe(first)
    expect(fromStylesCalls).toBe(1)
  })

  test('clearMarkdownSyntaxStyleCacheForTests forces a fresh allocation', () => {
    const palette = makePalette()

    const first = createMarkdownSyntaxStyle(palette)
    clearMarkdownSyntaxStyleCacheForTests()
    const second = createMarkdownSyntaxStyle(palette)

    expect(second).not.toBe(first)
    expect(fromStylesCalls).toBe(2)
  })
})
