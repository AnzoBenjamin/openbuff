import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../../hooks/use-theme'
import {
  FindReferencesComponent,
  GoToDefinitionComponent,
  HoverTypeComponent,
  WorkspaceSymbolComponent,
} from '../language-intelligence'

import type { ChatTheme } from '../../../types/theme-system'
import type { ToolBlock, ToolComponent } from '../types'

initializeThemeStore()

const options = {
  availableWidth: 80,
  indentationOffset: 0,
  labelWidth: 10,
}

type LiToolName =
  | 'go_to_definition'
  | 'find_references'
  | 'hover_type'
  | 'workspace_symbol'

const createToolBlock = <T extends LiToolName>(
  toolName: T,
  outputRaw?: unknown,
  input: Record<string, unknown> = {},
): ToolBlock & { toolName: T } => ({
  type: 'tool',
  toolName,
  toolCallId: `${toolName}-test`,
  input,
  outputRaw,
})

const renderMarkup = <T extends LiToolName>(
  component: ToolComponent<T>,
  block: ToolBlock & { toolName: T },
): string =>
  renderToStaticMarkup(
    <>{component.render(block, {} as ChatTheme, options).content}</>,
  )

describe('language intelligence renderers', () => {
  test('all four tool names render a titled card', () => {
    const outputRaw = [
      {
        type: 'json',
        value: {
          locations: [
            { path: 'src/a.ts', range: { start: { line: 0, character: 0 } } },
          ],
        },
      },
    ]

    expect(
      renderMarkup(
        GoToDefinitionComponent,
        createToolBlock('go_to_definition', outputRaw),
      ),
    ).toContain('Definition')
    expect(
      renderMarkup(
        FindReferencesComponent,
        createToolBlock('find_references', outputRaw),
      ),
    ).toContain('References')
    expect(
      renderMarkup(
        HoverTypeComponent,
        createToolBlock('hover_type', outputRaw),
      ),
    ).toContain('Type')
    expect(
      renderMarkup(
        WorkspaceSymbolComponent,
        createToolBlock('workspace_symbol', outputRaw),
      ),
    ).toContain('Symbols')
  })

  test('ready results list shortened locations with the ready glyph', () => {
    const markup = renderMarkup(
      GoToDefinitionComponent,
      createToolBlock(
        'go_to_definition',
        [
          {
            type: 'json',
            value: {
              locations: [
                {
                  path: 'src/index.ts',
                  range: { start: { line: 9, character: 4 } },
                },
              ],
            },
          },
        ],
        { path: 'src/index.ts', line: 10 },
      ),
    )

    expect(markup).toContain('✓')
    expect(markup).toContain('1 location')
    expect(markup).toContain('index.ts:10:5')
    expect(markup).not.toContain('src/index.ts:10:5')
  })

  test('multiple references render the plural location count', () => {
    const markup = renderMarkup(
      FindReferencesComponent,
      createToolBlock('find_references', [
        {
          type: 'json',
          value: {
            locations: [
              { path: 'src/a.ts', range: { start: { line: 0, character: 0 } } },
              { path: 'src/b.ts', range: { start: { line: 4, character: 2 } } },
            ],
          },
        },
      ]),
    )

    expect(markup).toContain('2 locations')
    expect(markup).toContain('a.ts:1:1')
    expect(markup).toContain('b.ts:5:3')
  })

  test('workspace_symbol renders symbol name, container, and location', () => {
    const markup = renderMarkup(
      WorkspaceSymbolComponent,
      createToolBlock(
        'workspace_symbol',
        [
          {
            type: 'json',
            value: {
              symbols: [
                {
                  name: 'renderTool',
                  containerName: 'Renderer',
                  location: {
                    path: 'src/render.ts',
                    range: { start: { line: 11, character: 2 } },
                  },
                },
              ],
            },
          },
        ],
        { query: 'renderTool' },
      ),
    )

    expect(markup).toContain('renderTool')
    expect(markup).toContain('Renderer')
    expect(markup).toContain('src/render.ts:12:3')
  })

  test('hover_type renders the hover text for a ready result', () => {
    const markup = renderMarkup(
      HoverTypeComponent,
      createToolBlock(
        'hover_type',
        [{ type: 'json', value: { hover: { contents: 'const foo: string' } } }],
        { path: 'src/foo.ts', line: 3 },
      ),
    )

    expect(markup).toContain('const foo: string')
  })

  test('failed results render the error glyph and message', () => {
    const block = createToolBlock('hover_type')
    block.lifecycle = 'failed'
    block.outputRaw = [
      { type: 'json', value: { errorMessage: 'language server crashed' } },
    ]

    const markup = renderMarkup(HoverTypeComponent, block)
    expect(markup).toContain('✗')
    expect(markup).toContain('language server crashed')
  })

  test('unavailable results render a muted settled glyph, not a spinner', () => {
    const markup = renderMarkup(
      GoToDefinitionComponent,
      createToolBlock('go_to_definition', [
        {
          type: 'json',
          value: {
            unavailable: { reason: 'no gopls binary found' },
            locations: [],
          },
        },
      ]),
    )

    expect(markup).toContain('–')
    expect(markup).toContain('no gopls binary found')
    expect(markup).not.toContain('⟳')
    expect(markup).not.toContain('✓')
  })

  test('ready-but-empty results render an explicit muted no-results line', () => {
    const markup = renderMarkup(
      FindReferencesComponent,
      createToolBlock('find_references', [
        { type: 'json', value: { locations: [] } },
      ]),
    )

    expect(markup).toContain('✓')
    expect(markup).toContain('no results')
    expect(markup).not.toContain('0 locations')
  })

  test('source contains no standalone JSX whitespace expressions', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'language-intelligence.tsx'),
      'utf8',
    )

    expect(source).not.toContain("{' '}")
  })
})
