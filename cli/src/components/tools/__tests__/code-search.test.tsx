import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../../hooks/use-theme'
import { CodeSearchComponent } from '../code-search'

import type { ChatTheme } from '../../../types/theme-system'
import type { ToolBlock } from '../types'

initializeThemeStore()

const options = {
  availableWidth: 80,
  indentationOffset: 0,
  labelWidth: 10,
}

const createToolBlock = (
  output?: string,
): ToolBlock & { toolName: 'code_search' } => ({
  type: 'tool',
  toolName: 'code_search',
  toolCallId: 'code-search-test',
  input: {
    pattern: 'getAgentBaseName',
    cwd: 'cli/src/utils',
  },
  output,
})

describe('CodeSearchComponent', () => {
  test('groups matches by file with count badge and status glyph', () => {
    const result = CodeSearchComponent.render(
      createToolBlock(`Found 2 matches
./message-block-helpers.ts:
Line 13: export const getAgentBaseName = (type: string): string => {
Line 196: getAgentBaseName(options.agentType ?? '') === 'code-searcher'`),
      {} as ChatTheme,
      options,
    )

    const markup = renderToStaticMarkup(<>{result.content}</>)

    expect(markup).toContain(
      'Search &quot;getAgentBaseName&quot; in cli/src/utils — 2 matches in 1 file',
    )
    expect(markup).toContain('✓')
    expect(markup).toContain('message-block-helpers.ts (2)')
    expect(markup).toContain('| ')
    expect(markup).toContain('13')
    expect(markup).toContain('export const ')
    expect(markup).toContain('(type: string): string =&gt; {')
  })

  test('parses raw ripgrep lines into file groups', () => {
    const result = CodeSearchComponent.render(
      createToolBlock('Found 2 matches\n./a.ts:5:alpha\n./b.ts:7:beta'),
      {} as ChatTheme,
      options,
    )

    const markup = renderToStaticMarkup(<>{result.content}</>)

    expect(markup).toContain('a.ts (1)')
    expect(markup).toContain('b.ts (1)')
    expect(markup).toContain('alpha')
    expect(markup).toContain('beta')
  })

  test('shows the running glyph while streaming partial output', () => {
    const block = createToolBlock('Found 1 matches\n./a.ts:5:alpha')
    block.lifecycle = 'running'

    const result = CodeSearchComponent.render(block, {} as ChatTheme, options)
    const markup = renderToStaticMarkup(<>{result.content}</>)

    expect(markup).toContain('⟳')
    expect(markup).toContain('1 match so far')
  })

  test('renders the actionable structured error text with error glyph', () => {
    const block = createToolBlock()
    block.lifecycle = 'failed'
    block.outputRaw = [
      {
        type: 'json',
        value: {
          errorMessage:
            "Invalid cwd: Path '../outside' is outside the project directory.",
        },
      },
    ]

    const result = CodeSearchComponent.render(block, {} as ChatTheme, options)
    const markup = renderToStaticMarkup(<>{result.content}</>)

    expect(markup).toContain('✗')
    expect(markup).toContain('outside the project directory')
  })

  test('falls back to the plain-text view for unparseable output', () => {
    const result = CodeSearchComponent.render(
      createToolBlock('some plain output without structure'),
      {} as ChatTheme,
      options,
    )

    const markup = renderToStaticMarkup(<>{result.content}</>)

    expect(markup).toContain('some plain output without structure')
    expect(markup).not.toContain('Status:')
  })
})
