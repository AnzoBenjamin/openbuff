import { afterAll, describe, expect, test } from 'bun:test'
import React from 'react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'
import { BlocksRenderer } from '../blocks/blocks-renderer'
import { ContentWithMarkdown } from '../blocks/content-with-markdown'
import { MessageWithAgents } from '../message-with-agents'
import { useMessageBlockStore } from '../../state/message-block-store'
import { RGBA } from '@opentui/core'
import {
  getSharedTreeSitterClient,
  resetTreeSitterClientStateForTests,
} from '../../utils/tree-sitter-client'

import type { ChatMessage, ContentBlock } from '../../types/chat'
import type { Renderable } from '@opentui/core'

initializeThemeStore()
let nativeSetupCreated = false
afterAll(async () => {
  if (!nativeSetupCreated) return
  await getSharedTreeSitterClient()?.destroy()
  resetTreeSitterClientStateForTests()
})

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
 * that production NODE_ENV runs skip native tests; test:native-ui executes
 * them with the supported Bun runtime and development React.
 *
 * Native markdown parses in a worker after mount. Await actual body text
 * with bounded polling rather than treating an empty frame without an error
 * message as success. Dispose the renderer after every capture.
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

async function waitForText(
  setup: Awaited<
    ReturnType<typeof import('@opentui/react/test-utils').testRender>
  >,
  texts: readonly string[],
): Promise<string> {
  let frame = ''
  for (let pass = 0; pass < 100; pass++) {
    await act(async () => {
      await setup.renderOnce()
      // Yield to the real parser worker, including cold initialization.
      await Bun.sleep(10)
    })
    frame = setup.captureCharFrame()
    if (texts.every((text) => frame.includes(text))) return frame
  }
  throw new Error(`Markdown text did not paint: ${texts.join(', ')}\n${frame}`)
}

const renderFrame = async (
  node: React.ReactNode,
  texts: readonly string[],
): Promise<string> => {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    setup = await testRender(
      <box style={{ flexDirection: 'column', width: 100 }}>{node}</box>,
      { width: 100, height: 40 },
    )
  })
  nativeSetupCreated = true
  try {
    return await waitForText(setup, texts)
  } finally {
    await act(async () => setup.dispose())
  }
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
  renderTest('markdown uses the width of its containing message', async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let setup!: Awaited<ReturnType<typeof testRender>>
    await act(async () => {
      setup = await testRender(
        <box style={{ flexDirection: 'column', width: 100 }}>
          {renderTranscript([
            {
              type: 'text',
              content:
                'Validation is green after the third security repair: 53/53 across `token-counter` and runtime typecheck.',
            },
          ])}
        </box>,
        { width: 100, height: 20 },
      )
    })
    nativeSetupCreated = true
    try {
      await act(async () => {
        await setup.renderOnce()
      })
      const visit = (node: Renderable): Renderable[] => [
        node,
        ...node.getChildren().flatMap(visit),
      ]
      const markdown = visit(setup.renderer.root).find(
        (node) => node.constructor.name === 'MarkdownRenderable',
      )
      expect(markdown?.width).toBe(100)
    } finally {
      await act(async () => setup.dispose())
    }
  })
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
        ['Hello world with - dashes and code'],
      )

      expect(frame).toContain('Hello world with - dashes and code')
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
        ['Plain prose without any special characters'],
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
        ['User note with emphasis'],
      )

      expect(frame).toContain('User note with emphasis')
      expect(frame).not.toContain('Could not render')
    },
  )

  renderTest(
    'light-theme heading, prose and list text paint with the palette foreground',
    async () => {
      const { testRender } = await import('@opentui/react/test-utils')
      const theme = chatThemes.light
      const palette = createMarkdownPalette(theme)
      let setup!: Awaited<ReturnType<typeof testRender>>
      await act(async () => {
        setup = await testRender(
          <box width={80} height={16} backgroundColor={theme.surface}>
            <ContentWithMarkdown
              content={
                '## Readable heading\n\nHuman readable prose on a light background.\n\n- Readable list item'
              }
              isStreaming={false}
              codeBlockWidth={80}
              palette={palette}
            />
          </box>,
          { width: 80, height: 16 },
        )
      })
      nativeSetupCreated = true
      try {
        const texts = [
          'Readable heading',
          'Human readable prose on a light background.',
          'Readable list item',
        ]
        await waitForText(setup, texts)
        const lines = setup.captureSpans().lines
        const expected = RGBA.fromHex(palette.codeTextFg)
        for (const text of texts) {
          const line = lines.find((line) =>
            line.spans
              .map((span) => span.text)
              .join('')
              .includes(text),
          )
          expect(line).toBeDefined()
          const span = line!.spans.find((span) => span.text.includes(text))
          expect(span).toBeDefined()
          expect(span!.fg.toInts()).toEqual(expected.toInts())
        }
      } finally {
        await act(async () => setup.dispose())
      }
    },
  )

  renderTest(
    'expanded agent markdown uses the light-theme body foreground',
    async () => {
      const { testRender } = await import('@opentui/react/test-utils')
      const theme = chatThemes.light
      const palette = createMarkdownPalette(theme)
      const previousContext = useMessageBlockStore.getState().context
      const body = 'Expanded agent prose stays readable.'
      const message: ChatMessage = {
        id: 'native-light-agent',
        variant: 'agent',
        content: `## Agent result\n\n${body}`,
        timestamp: '2026-11-10T00:00:00.000Z',
        agent: {
          agentName: 'Code reviewer',
          agentType: 'test-agent',
          responseCount: 1,
        },
        metadata: { isCollapsed: false },
      }
      let setup: Awaited<ReturnType<typeof testRender>> | undefined
      try {
        useMessageBlockStore.getState().setContext({
          theme,
          markdownPalette: palette,
          messageTree: null,
          isWaitingForResponse: false,
          timerStartTime: null,
          availableWidth: 80,
        })
        await act(async () => {
          setup = await testRender(
            <box width={80} height={18} backgroundColor={theme.surface}>
              <MessageWithAgents
                message={message}
                depth={0}
                isLastMessage={false}
                availableWidth={80}
              />
            </box>,
            { width: 80, height: 18 },
          )
        })
        nativeSetupCreated = true
        await waitForText(setup!, ['Agent result', body])
        const line = setup!.captureSpans().lines.find((line) =>
          line.spans
            .map((span) => span.text)
            .join('')
            .includes(body),
        )
        expect(line).toBeDefined()
        const bodySpan = line!.spans.find((span) => span.text.includes(body))
        expect(bodySpan).toBeDefined()
        expect(bodySpan!.fg.toInts()).toEqual(
          RGBA.fromHex(theme.foreground).toInts(),
        )
      } finally {
        if (setup) await act(async () => setup!.dispose())
        useMessageBlockStore.getState().setContext(previousContext)
      }
    },
  )
})
