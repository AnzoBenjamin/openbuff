import { describe, expect, test } from 'bun:test'
import React from 'react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'
import { BlocksRenderer } from '../blocks/blocks-renderer'

import type { ContentBlock, ToolContentBlock } from '../../types/chat'

initializeThemeStore()

/**
 * Regression tests for the tool-fallback markdown-in-<text> crash (the D47
 * Stage 2 pattern, unapplied in ToolBranch).
 *
 * `ToolBranch` is the fallback renderer for every tool WITHOUT a registered
 * component (web_search, read_image, render_3d_preview, custom tools, ...).
 * recall_context / list_jobs / check_background_agent have since gained
 * registered components, so the fixture uses web_search to keep exercising
 * the fallback path. Its fallback text always contains a fenced code block built from the
 * tool input (`inputContent`), so `ContentWithMarkdown` returns a native
 * <markdown> renderable for every such block — and before the fix ToolBranch
 * wrapped that renderable inside a `<text>` element. A renderable cannot nest
 * inside a `<text>` element: OpenTUI's TextNodeRenderable throws during
 * commit, which the per-block error boundary in blocks-renderer.tsx catches
 * and replaces with "Could not render this tool block." Unregistered tools are
 * collapsed by default, so this fired whenever the user expanded such a block
 * (expanded job/agent/recall results).
 *
 * Harness mirrors single-block-markdown.test.tsx (testRender + act shim; the
 * cli/knowledge.md Test Conventions rule: render tests skip under production
 * NODE_ENV) plus the text-nesting.test.tsx chrome-survival assertions, so a
 * throw degrades to the block fallback line instead of a blank app and this
 * suite fails loudly while the bug is present.
 */
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

const actPassthrough = async (callback: () => Promise<void>): Promise<void> => {
  await callback()
  await Promise.resolve()
}

const act: (callback: () => Promise<void>) => Promise<void> =
  process.env.NODE_ENV === 'production'
    ? actPassthrough
    : ((React as any).act ?? actPassthrough)

// React's dev build only honors act() when this flag is set before the first
// render, so set it once at module scope.
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const renderFrame = async (node: React.ReactNode): Promise<string> => {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    setup = await testRender(
      <box style={{ flexDirection: 'column', width: 100 }}>{node}</box>,
      { width: 100, height: 40 },
    )
  })
  for (let pass = 0; pass < 2; pass++) {
    await act(async () => {
      await setup.renderOnce()
      await Promise.resolve()
    })
  }
  const frame: string = setup.captureCharFrame()
  setup.renderer.destroy()
  return frame
}

const makeToolBlock = (
  overrides: Partial<ToolContentBlock> = {},
): ToolContentBlock => ({
  type: 'tool',
  toolCallId: 'tool-fallback-1',
  toolName: 'web_search',
  input: { query: 'archive eviction floor' },
  output: 'matches: archive-recall-index.ts:209 buildArchiveRecallRows',
  ...overrides,
})

const renderTranscript = (blocks: ContentBlock[]): React.ReactNode => (
  <box style={{ flexDirection: 'column' }}>
    <text>STATUS LINE ABOVE</text>
    <BlocksRenderer
      sourceBlocks={blocks}
      messageId="msg-1"
      isLoading={false}
      isComplete
      isUser={false}
      textColor={chatThemes.dark.foreground}
      availableWidth={100}
      markdownPalette={createMarkdownPalette(chatThemes.dark)}
      onToggleCollapsed={() => {}}
      onBuildFast={() => {}}
      onInsertCommand={() => {}}
    />
    <text>INPUT BAR BELOW</text>
  </box>
)

describe('ToolBranch fallback renders markdown at box level', () => {
  renderTest(
    'expanded unregistered tool renders its result instead of the block error',
    async () => {
      const frame = await renderFrame(
        renderTranscript([makeToolBlock({ isCollapsed: false })]),
      )

      // The surrounding UI survives and the block is NOT replaced by the
      // per-block error boundary fallback.
      expect(frame).toContain('STATUS LINE ABOVE')
      expect(frame).toContain('INPUT BAR BELOW')
      expect(frame).not.toContain('Could not render this tool block.')
      // The fallback path renders the tool header...
      expect(frame).toContain('web_search')
      // ...and the expanded body paints both the fenced input and the plain
      // result string (tokens are asserted whole: word wrap never splits them).
      expect(frame).toContain('query')
      expect(frame).toContain('match')
    },
  )

  renderTest(
    'collapsed unregistered tool renders its header without throwing',
    async () => {
      const frame = await renderFrame(
        renderTranscript([makeToolBlock({ isCollapsed: undefined })]),
      )

      expect(frame).toContain('STATUS LINE ABOVE')
      expect(frame).toContain('INPUT BAR BELOW')
    expect(frame).not.toContain('Could not render this tool block.')
    expect(frame).toContain('web_search')
    },
  )
})
