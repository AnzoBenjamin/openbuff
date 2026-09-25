import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../../hooks/use-theme'
import { GlobComponent } from '../glob'
import { ListDirectoryComponent } from '../list-directory'

import type { ChatTheme } from '../../../types/theme-system'
import type { ToolBlock } from '../types'

initializeThemeStore()

const options = {
  availableWidth: 80,
  indentationOffset: 0,
  labelWidth: 10,
}

describe('discovery tool renderers', () => {
  test('glob groups files by directory with count badge and status glyph', () => {
    const block: ToolBlock & { toolName: 'glob' } = {
      type: 'tool',
      toolName: 'glob',
      toolCallId: 'glob-1',
      input: { pattern: '*.ts', cwd: 'src' },
      lifecycle: 'succeeded',
      outputRaw: [
        {
          type: 'json',
          value: {
            files: ['src/a.ts', 'src/b.ts'],
            count: 2,
            message: 'Found 2 files.',
          },
        },
      ],
    }

    const rendered = GlobComponent.render(block, {} as ChatTheme, options)
    const markup = renderToStaticMarkup(<>{rendered.content}</>)
    expect(markup).toContain(
      'Glob &quot;*.ts&quot; in src — 2 files in 1 dir',
    )
    expect(markup).toContain('✓')
    expect(markup).toContain('src (2)')
    expect(markup).toContain('a.ts')
    expect(markup).not.toContain('Status:')

    block.lifecycle = 'failed'
    block.outputRaw = [
      { type: 'json', value: { errorMessage: 'Invalid cwd: outside project' } },
    ]
    const failed = GlobComponent.render(block, {} as ChatTheme, options)
    const failedMarkup = renderToStaticMarkup(<>{failed.content}</>)
    expect(failedMarkup).toContain('✗')
    expect(failedMarkup).toContain('Invalid cwd: outside project')
  })

  test('glob shows a more-affordance for large directory groups', () => {
    const files = [
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
    ]
    const block: ToolBlock & { toolName: 'glob' } = {
      type: 'tool',
      toolName: 'glob',
      toolCallId: 'glob-2',
      input: { pattern: '*.ts', cwd: '' },
      lifecycle: 'succeeded',
      outputRaw: [
        {
          type: 'json',
          value: { files, count: files.length, message: 'Found 4 files.' },
        },
      ],
    }

    const rendered = GlobComponent.render(block, {} as ChatTheme, options)
    const markup = renderToStaticMarkup(<>{rendered.content}</>)
    expect(markup).toContain('src (4)')
    expect(markup).toContain('a.ts')
    expect(markup).toContain('c.ts')
    expect(markup).toContain('… 1 more')
  })

  test('list_directory renders a collapsible group with dir/file badge', () => {
    const block: ToolBlock & { toolName: 'list_directory' } = {
      type: 'tool',
      toolName: 'list_directory',
      toolCallId: 'list-1',
      input: { path: 'src' },
      lifecycle: 'succeeded',
      outputRaw: [
        {
          type: 'json',
          value: {
            path: 'src',
            directories: ['components'],
            files: ['index.ts'],
          },
        },
      ],
    }

    const rendered = ListDirectoryComponent.render(
      block,
      {} as ChatTheme,
      options,
    )
    const markup = renderToStaticMarkup(<>{rendered.content}</>)
    expect(markup).toContain('List src — 1 dir, 1 file')
    expect(markup).toContain('✓')
    expect(markup).toContain('src (1d/1f)')
    expect(markup).toContain('components/')
    expect(markup).toContain('index.ts')
    expect(markup).not.toContain('Status:')
  })

  test('list_directory ignores null and non-object directory entries without crashing', () => {
    const block: ToolBlock & { toolName: 'list_directory' } = {
      type: 'tool',
      toolName: 'list_directory',
      toolCallId: 'list-null',
      input: { directories: [null, { path: 'src' }, 42, { path: '   ' }] },
      lifecycle: 'succeeded',
      outputRaw: [
        {
          type: 'json',
          value: {
            path: 'src',
            directories: [],
            files: ['index.ts'],
          },
        },
      ],
    }

    const rendered = ListDirectoryComponent.render(
      block,
      {} as ChatTheme,
      options,
    )
    const markup = renderToStaticMarkup(<>{rendered.content}</>)
    expect(markup).toContain('List src')
    expect(markup).not.toContain('42')
  })

  test('list_directory returns no content when only invalid directory entries are supplied', () => {
    const block: ToolBlock & { toolName: 'list_directory' } = {
      type: 'tool',
      toolName: 'list_directory',
      toolCallId: 'list-null-empty',
      input: { directories: [null, 42, { path: '   ' }] },
      lifecycle: 'succeeded',
      outputRaw: [
        { type: 'json', value: { path: '', directories: [], files: [] } },
      ],
    }

    const rendered = ListDirectoryComponent.render(
      block,
      {} as ChatTheme,
      options,
    )
    expect(rendered.content).toBeNull()
  })
})
