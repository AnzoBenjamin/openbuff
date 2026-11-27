import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../hooks/use-theme'
import { AgentBranchItem } from '../blocks/agent-branch-item'
import { ToolCallItem } from '../tools/tool-call-item'

initializeThemeStore()

const hasWrappedLine = (markup: string, prefix: string): boolean =>
  markup.includes(`${prefix}\n`)

describe('subagent card width containment', () => {
  const renderTool = (
    preview: string,
    availableWidth: number,
    streaming = false,
  ) =>
    renderToStaticMarkup(
      <ToolCallItem
        name="Search"
        content={null}
        isCollapsed
        isStreaming={streaming}
        streamingPreview={preview}
        finishedPreview={preview}
        availableWidth={availableWidth}
      />,
    )

  test('keeps short tool summaries in the header without duplicating them', () => {
    const markup = renderTool('2 files found', 40)
    expect(markup.replace(/<[^>]+>/g, '')).toBe('• Search · 2 files found')
    expect(markup.match(/2 files found/g)).toHaveLength(1)
  })

  test('measures terminal cells when deciding if a summary fits', () => {
    const wide = renderTool('界界界', 17).replace(/<[^>]+>/g, '')
    const narrow = renderTool('界界界', 16).replace(/<[^>]+>/g, '')
    expect(wide).toContain('Search · 界界界')
    expect(narrow).not.toContain('Search ·')
    expect(narrow).toContain('界界界')
  })

  test('preserves multiline output and running status', () => {
    const multiline = renderTool('first line\nFailed: second line', 80).replace(
      /<[^>]+>/g,
      '',
    )
    expect(multiline).not.toContain('Search ·')
    expect(multiline).toContain('first line\nFailed: second line')
    expect(renderTool('Checking files', 80, true).replace(/<[^>]+>/g, '')).toBe(
      '• Search running · Checking files',
    )
  })

  test('wraps collapsed agent preview to the card content width', () => {
    const markup = renderToStaticMarkup(
      <AgentBranchItem
        name="Editor"
        isCollapsed={true}
        isStreaming={false}
        preview="abcdefghijklmnopqrst"
        availableWidth={14}
      />,
    )

    expect(hasWrappedLine(markup, 'abcdefghij')).toBe(true)
  })

  test('wraps expanded agent text children to the card content width', () => {
    const markup = renderToStaticMarkup(
      <AgentBranchItem
        name="Editor"
        isCollapsed={false}
        isStreaming={false}
        preview=""
        availableWidth={14}
      >
        abcdefghijklmnopqrst
      </AgentBranchItem>,
    )

    expect(hasWrappedLine(markup, 'abcdefghij')).toBe(true)
  })

  test('contains keyed expanded child components inside the card width', () => {
    const markup = renderToStaticMarkup(
      <AgentBranchItem
        name="Editor"
        isCollapsed={false}
        isStreaming={false}
        preview=""
        availableWidth={14}
      >
        <box key="wide-tool-output" style={{ width: 100 }}>
          <text>abcdefghijklmnopqrstuvwxyz</text>
        </box>
      </AgentBranchItem>,
    )

    expect(markup).toContain(
      'flex-grow:1;flex-shrink:1;min-width:0;width:100%;overflow:hidden;gap:1',
    )
  })

  test('wraps collapsed tool preview inside its available width', () => {
    const markup = renderToStaticMarkup(
      <ToolCallItem
        name="run_terminal_command"
        content={null}
        isCollapsed={true}
        isStreaming={false}
        streamingPreview=""
        finishedPreview="abcdefghijklmnopqrst"
        availableWidth={14}
      />,
    )

    expect(hasWrappedLine(markup, 'abcdefghijkl')).toBe(true)
  })
})
