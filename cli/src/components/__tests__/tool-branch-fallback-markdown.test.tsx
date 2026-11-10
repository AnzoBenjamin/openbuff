import { describe, expect, test } from 'bun:test'
import React from 'react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes, createMarkdownPalette } from '../../utils/theme-system'
import { BlocksRenderer } from '../blocks/blocks-renderer'

import type { ContentBlock, ToolContentBlock } from '../../types/chat'

initializeThemeStore()

/**
 * Native regressions for human-readable tool output and the historical
 * tool-fallback Markdown-in-<text> crash.
 *
 * `ToolBranch` is the fallback renderer for every tool WITHOUT a registered
 * component (read_image, render_3d_preview, custom tools, ...). web_search,
 * recall_context, list_jobs, and check_background_agent have since gained
 * registered components, so the fixture migrated to read_image to keep
 * exercising the fallback path. Structured inputs/results now use grouped
 * fields, while plain result text may use optional native Markdown. Both
 * belong under a box host. Before the fix ToolBranch wrapped native Markdown
 * inside a `<text>` element. A renderable cannot nest
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
  toolName: 'read_image',
  input: { path: 'screenshots/current-01.png' },
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
    'serialized MCP results display readable fields once rather than raw JSON',
    async () => {
      const result = {
        message: 'Located the export',
        matches: [{ filePath: 'src/a.ts', line: 12 }],
      }
      for (const structuredContent of [undefined, result]) {
        const frame = await renderFrame(
          renderTranscript([
            makeToolBlock({
              isCollapsed: false,
              output: undefined,
              outputRaw: [
                {
                  type: 'json',
                  value: {
                    kind: 'mcp_tool_result',
                    schemaVersion: 1,
                    structuredContent,
                    content: [{ type: 'text', text: JSON.stringify(result) }],
                  },
                },
              ],
            }),
          ]),
        )
        expect(frame).toContain('Located the export')
        expect(frame).toContain('file path: src/a.ts')
        expect(frame.match(/file path: src\/a.ts/g)).toHaveLength(1)
        expect(frame).not.toContain('"matches"')
        expect(frame).not.toContain('"filePath"')
        expect(frame).toContain('Inspect captured output')
      }
    },
  )

  renderTest(
    'review receipts use a human heading with their visible verdict',
    async () => {
      const frame = await renderFrame(
        renderTranscript([
          makeToolBlock({
            toolName: 'set_output',
            isCollapsed: true,
            lifecycle: 'succeeded',
            input: {
              data: { verdict: 'LOOKS_GOOD', summary: 'Changes verified' },
            },
            output: undefined,
            outputRaw: [{ type: 'json', value: { message: 'Output set' } }],
          }),
        ]),
      )
      expect(frame).toContain('Review result · ✓ Review passed')
      expect(frame).toContain('Changes verified')
      expect(frame).not.toContain('Set output')
    },
  )

  renderTest(
    'saved array results display their actual content in the transcript',
    async () => {
      const frame = await renderFrame(
        renderTranscript([
          makeToolBlock({
            toolName: 'set_output',
            isCollapsed: false,
            lifecycle: 'succeeded',
            input: { data: ['src/a.ts', 'src/b.ts'] },
            output: undefined,
            outputRaw: [{ type: 'json', value: { message: 'Output set' } }],
          }),
        ]),
      )
      expect(frame).toContain('Result saved')
      expect(frame).toContain('Agent result')
      expect(frame).not.toContain('Set output')
      expect(frame).toContain('1. src/a.ts')
      expect(frame).toContain('2. src/b.ts')
      expect(frame).toContain('Inspect captured output')
    },
  )

  renderTest(
    'collapsed messages remain a short summary rather than a wrapped wall',
    async () => {
      const frame = await renderFrame(
        renderTranscript([
          makeToolBlock({
            output: undefined,
            outputRaw: [
              {
                type: 'json',
                value: { message: `Result: ${'x'.repeat(2_000)}` },
              },
            ],
          }),
        ]),
      )
      expect(frame).toContain('Result: ')
      expect(frame.match(/x/g)?.length ?? 0).toBeLessThan(140)
      expect(frame).toContain('…')
    },
  )

  renderTest(
    'collapsed structured results prefer their message over protocol numbers',
    async () => {
      const frame = await renderFrame(
        renderTranscript([
          makeToolBlock({
            output: undefined,
            outputRaw: [
              {
                type: 'json',
                value: { version: 1, message: 'Located the requested export' },
              },
            ],
          }),
        ]),
      )
      expect(frame).toContain('Located the requested export')
      expect(
        frame.split('\n').find((line) => line.includes('Read image')),
      ).toContain('Read image · Located the requested export')
      expect(frame).not.toContain('version: 1')
    },
  )

  renderTest(
    'standard MCP content renders before transport details, with raw inspection retained',
    async () => {
      const frame = await renderFrame(
        renderTranscript([
          makeToolBlock({
            isCollapsed: false,
            output: undefined,
            outputRaw: [
              {
                type: 'json',
                value: {
                  kind: 'mcp_tool_result',
                  schemaVersion: 1,
                  content: [
                    { type: 'text', text: 'The requested export is in a.ts.' },
                  ],
                  _meta: { debug: 'protocol-only' },
                },
              },
            ],
          }),
        ]),
      )
      expect(frame).toContain('The requested export is in a.ts.')
      expect(frame).toContain('Inspect captured output')
      expect(frame).not.toContain('schema version')
      expect(frame).not.toContain('protocol-only')
      expect(frame).not.toContain('mcp tool result')
    },
  )

  renderTest(
    'successful empty collections are visible and inspectable',
    async () => {
      const frame = await renderFrame(
        renderTranscript([
          makeToolBlock({
            isCollapsed: false,
            lifecycle: 'succeeded',
            output: undefined,
            outputRaw: [],
          }),
        ]),
      )
      expect(frame).toContain('No results returned')
      expect(frame).toContain('Inspect captured output')
    },
  )

  renderTest(
    'failure summaries remain visible when bounded details omit a late error field',
    async () => {
      const payload = {
        ...Object.fromEntries(
          Array.from({ length: 40 }, (_, index) => [`field${index}`, index]),
        ),
        errorMessage: 'Image could not load',
      }
      const frame = await renderFrame(
        renderTranscript([
          makeToolBlock({
            isCollapsed: false,
            lifecycle: 'failed',
            output: undefined,
            outputRaw: [{ type: 'json', value: payload }],
          }),
        ]),
      )
      expect(frame).toContain('Failed · Image could not load')
      expect(frame).toContain('Preview limited')
    },
  )

  renderTest(
    'nested inputs and captured structured results render as readable native rows',
    async () => {
      const frame = await renderFrame(
        renderTranscript([
          makeToolBlock({
            isCollapsed: false,
            input: { options: { filePath: 'src/a.ts', verify: true } },
            output: undefined,
            outputRaw: [
              {
                type: 'json',
                value: {
                  summary: 'Export located',
                  matches: [{ filePath: 'src/a.ts', line: 12 }],
                },
              },
            ],
          }),
        ]),
      )
      expect(frame).toContain('Export located')
      expect(frame).toContain('matches:')
      expect(frame).toContain('file path: src/a.ts')
      expect(frame).toContain('verify: Yes')
      expect(frame).toContain('Inspect input')
      expect(frame).toContain('Inspect captured output')
      expect(frame).not.toContain('"filePath"')
      expect(frame).not.toContain('```json')
      expect(frame.indexOf('Export located')).toBeLessThan(
        frame.indexOf('Input'),
      )
    },
  )

  renderTest(
    'expanded unregistered tool renders its result instead of the block error',
    async () => {
      const frame = await renderFrame(
        renderTranscript([
          makeToolBlock({
            isCollapsed: false,
            output: '**Result:**\n- Export located in src/a.ts',
          }),
        ]),
      )

      // The surrounding UI survives and the block is NOT replaced by the
      // per-block error boundary fallback.
      expect(frame).toContain('STATUS LINE ABOVE')
      expect(frame).toContain('INPUT BAR BELOW')
      expect(frame).not.toContain('Could not render this tool block.')
      // The fallback path renders the tool header...
      expect(frame).toContain('Read image')
      // This case explicitly supplies Markdown, whose body is asynchronous;
      // the synchronous structured-result cases above assert their own rows.
      // ContentWithMarkdown returns a native renderable here, so
      // ContentWithMarkdown returns the native <markdown> renderable, which
      // parses after mount and paints on a later frame. single-block-markdown
      // .test.tsx documents that precedent: captured frames never assert
      // markdown body text. This file's regression pin is that the block-level
      // <markdown> no longer throws during commit (the D47 Stage 2 crash),
      // which the assertions above cover. Human-shaped fallback rows are pinned
      // synchronously by the collapsed case below and exhaustively in
      // the structured preview and display-adapter suites.
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
      expect(frame).toContain('Read image')
      // The collapsed preview is a synchronous <text> path (ToolCallItem paints
      // finishedPreview directly), so — unlike the async markdown body — it IS
      // assertable in a captured frame. It carries the last non-empty body
      // line, with markdown punctuation stripped, which pins the human-shaped
      // fallback result reaching the UI rather than a raw JSON fence.
      expect(frame).toContain('archive-recall-index.ts:209')
    },
  )
})
