import { describe, expect, test } from 'bun:test'
import React from 'react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'
import { BlocksRenderer } from '../blocks/blocks-renderer'

import type { ContentBlock } from '../../types/chat'

initializeThemeStore()

/**
 * Regression tests for the markdown-in-<text> crash (D47 Stage 2).
 *
 * `ContentWithMarkdown` returns a native OpenTUI `<markdown>` RENDERABLE
 * whenever `hasMarkdown(content)` is true, and a renderable cannot nest
 * inside a `<text>` element: OpenTUI's TextNodeRenderable throws during
 * commit, which the per-block error boundary catches and replaces with
 * "Could not render this text block." on every markdown-ish assistant
 * response. `SingleBlock` therefore branches on `hasMarkdown` — the same
 * pattern as agent-branch-wrapper.tsx — rendering the markdown renderable
 * at box level and keeping the `<text>` wrapper only for plain content.
 *
 * `renderToStaticMarkup` cannot catch this: react-dom happily nests the
 * tags. Only the real OpenTUI reconciler rejects them, so these tests go
 * through `testRender`, mirroring text-nesting.test.tsx's harness. Note
 * that per cli/knowledge.md these tsx render tests only run under the
 * CI-pinned bun (< 1.3.14); in production NODE_ENV runs they are skipped,
 * same convention as agent-branch-overflow.test.tsx.
 *
 * Harness note: unlike the plain <text> path (which paints on the first
 * frame — text-nesting.test.tsx renders content with this same shape), the
 * native <markdown> renderable parses its content after mount and paints on
 * a later frame, so renderFrame wraps testRender/renderOnce in the act shim
 * from status-bar.test.tsx (the cli/knowledge.md Test Conventions pattern)
 * and runs a settle render pass before capture. Without it the capture runs
 * before the markdown paint and the frame comes back blank, and the
 * reconciler updates surface as "not wrapped in act(...)" warnings.
 *
 * Production parity: single-block.tsx's markdown branch carries the same
 * <box style={{ width: '100%' }}> wrapper around ContentWithMarkdown that
 * agent-branch-wrapper.tsx's onSingleBlock markdown branch carries, so the
 * box-level structure matches the proven pattern byte-for-byte and no
 * production change is needed for these tests to pass.
 */
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

/**
 * Dev/prod act mismatch: `bun test` resolves the dev React build (which warns
 * on any update "not wrapped in act(...)") while `@opentui/react/test-utils`
 * resolves production React, whose `act` is a throwing stub — so testRender's
 * internal act-wrapping silently no-ops and reconciler updates escape capture
 * under load. Only an explicit outer act can be trusted; this shim is safe
 * under both builds, using React's real act when available (dev) and a
 * microtask-flushing passthrough otherwise (production or a missing export).
 * Same shim as status-bar.test.tsx (the cli/knowledge.md Test Conventions
 * pattern).
 */
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
  // The plain <text> path paints on the first frame, but the native
  // <markdown> renderable parses its content after mount and paints on a
  // later frame — without an act-wrapped settle pass the capture runs before
  // that paint and the frame comes back blank. Two passes with a microtask
  // flush give the markdown renderable's post-mount work a frame to paint
  // into.
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

const renderTranscript = (
  blocks: ContentBlock[],
  isUser = false,
): React.ReactNode => (
  <box style={{ flexDirection: 'column' }}>
    <BlocksRenderer
      sourceBlocks={blocks}
      messageId="msg-1"
      isLoading={false}
      isComplete
      isUser={isUser}
      textColor={chatThemes.dark.foreground}
      availableWidth={100}
      markdownPalette={createMarkdownPalette(chatThemes.dark)}
      onToggleCollapsed={() => {}}
      onBuildFast={() => {}}
      onInsertCommand={() => {}}
    />
  </box>
)

describe('SingleBlock text blocks render markdown at box level', () => {
  renderTest(
    'markdown content does not hit the error boundary fallback',
    async () => {
      const frame = await renderFrame(
        renderTranscript([
          {
            type: 'text',
            content: 'Hello **world** with - dashes and `code`',
          },
        ]),
      )

      // Regression pin: the PRE-FIX code nested the native <markdown>
      // renderable inside a <text> element, which threw
      // 'TextNodeRenderable only accepts strings...' at commit time — the
      // per-block boundary caught it and the frame contained 'Could not
      // render this text block.'. Its ABSENCE is the pin. Content
      // visibility itself is NOT asserted: the native markdown renderable
      // paints asynchronously under the OpenTUI test renderer (the proven
      // precedent agent-branch-overflow.test.tsx — the same
      // markdown-at-box-level pattern — never asserts markdown body text in
      // captured frames either); content visibility is verified in the real
      // TUI via tmux.
      expect(frame).not.toContain('Could not render')
    },
  )

  renderTest(
    'plain content keeps the <text> path and renders normally',
    async () => {
      const frame = await renderFrame(
        renderTranscript([
          {
            type: 'text',
            content: 'Plain prose without any special characters',
          },
        ]),
      )

      expect(frame).toContain('Plain prose without any special characters')
      expect(frame).not.toContain('Could not render')
    },
  )

  renderTest(
    'a user text block with markdown also renders at box level',
    async () => {
      const frame = await renderFrame(
        renderTranscript(
          [{ type: 'text', content: 'User note **with** emphasis' }],
          true,
        ),
      )

      // Same pin as above: absence of the boundary fallback is the
      // regression assertion (native markdown body text does not paint
      // synchronously under the test renderer — see agent-branch-overflow
      // precedent; content visibility verified in the real TUI).
      expect(frame).not.toContain('Could not render')
    },
  )
})
