import React from 'react'

import { DiscoveryOutput, discoveryStatus } from './discovery-output'
import {
  FileGroups,
  statusGlyph,
  type FileGroup,
} from './discovery-results'
import { SimpleToolCallItem } from './tool-call-item'
import { defineToolComponent } from './types'
import {
  getStructuredErrorMessages,
  getToolOutputRecords,
} from '../../utils/tool-result-normalizer'

import type { ToolRenderConfig } from './types'

/**
 * Group matched file paths by their containing directory so large result sets
 * render as a compact tree instead of a flat wall of paths.
 */
export function groupFilesByDirectory(files: string[]): FileGroup[] {
  const groups: FileGroup[] = []
  const byDir = new Map<string, FileGroup>()
  for (const file of files) {
    const dir = file.slice(0, Math.max(file.lastIndexOf('/'), 0))
    let group = byDir.get(dir)
    if (!group) {
      group = { dir, files: [] }
      byDir.set(dir, group)
      groups.push(group)
    }
    group.files.push(file)
  }
  return groups
}

/**
 * UI component for glob tool.
 * The header line summarizes the pattern and match count with a status glyph;
 * the expanded body groups files by directory in collapsible sections.
 */
export const GlobComponent = defineToolComponent({
  toolName: 'glob',

  render(toolBlock, theme, options): ToolRenderConfig {
    const input = toolBlock.input as any
    const pattern = input?.pattern ?? ''
    const cwd = input?.cwd ?? ''

    const record = getToolOutputRecords(toolBlock.outputRaw)[0]
    const files = Array.isArray(record?.files)
      ? record.files.filter((file): file is string => typeof file === 'string')
      : []
    const count =
      typeof record?.count === 'number' ? record.count : files.length
    const error = getStructuredErrorMessages(
      toolBlock.outputRaw ?? toolBlock.output,
    )[0]
    const hasOutput =
      toolBlock.outputRaw !== undefined || Boolean(toolBlock.output?.trim())
    const status = discoveryStatus({
      lifecycle: toolBlock.lifecycle,
      hasOutput,
      error,
      count,
    })
    const { glyph, color } = statusGlyph(status, theme)

    if (!pattern) {
      return { content: null }
    }

    // Build single-line summary; the glyph replaces the old `· status` words.
    let summaryText = `Glob "${pattern}"`
    if (cwd) {
      summaryText += ` in ${cwd}`
    }
    if (error || !hasOutput) {
      // Keep the summary short; error detail renders below.
    } else if (count === 0) {
      summaryText += ' — no files'
    } else if (status === 'running' || status === 'queued') {
      summaryText += ` — ${count} file${count === 1 ? '' : 's'} so far`
    } else {
      const dirCount = groupFilesByDirectory(files).length
      summaryText += ` — ${count} file${count === 1 ? '' : 's'} in ${dirCount} dir${dirCount === 1 ? '' : 's'}`
    }

    const groups = error ? [] : groupFilesByDirectory(files)

    return {
      collapsedPreview: `${summaryText} ${glyph}`,
      content: (
        <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
          <SimpleToolCallItem
            name="Glob"
            description={
              <>
                {summaryText}
                {' '}
                <span fg={color}>{glyph}</span>
              </>
            }
          />
          {error ? (
            <text style={{ wrapMode: 'word' }}>
              <span fg={theme.error}>{error}</span>
            </text>
          ) : groups.length > 0 ? (
            <FileGroups groups={groups} cwd={cwd} />
          ) : (
            <DiscoveryOutput
              status={status}
              message={
                typeof record?.message === 'string'
                  ? record.message
                  : undefined
              }
              error={error}
              provenance={cwd || 'project root'}
              items={files}
              availableWidth={options.availableWidth}
              showHeader={false}
            />
          )}
        </box>
      ),
    }
  },
})
