import React from 'react'

import { discoveryStatus } from './discovery-output'
import { CollapsibleGroup, statusGlyph } from './discovery-results'
import { SimpleToolCallItem } from './tool-call-item'
import { defineToolComponent } from './types'
import { useTheme } from '../../hooks/use-theme'
import {
  getStructuredErrorMessages,
  getToolOutputRecords,
} from '../../utils/tool-result-normalizer'

import type { ToolRenderConfig } from './types'

/**
 * UI component for list_directory tool.
 * The header line summarizes the queried directories and entry counts with a
 * status glyph; the expanded body lists entries in one collapsible group per
 * queried directory.
 */
export const ListDirectoryComponent = defineToolComponent({
  toolName: 'list_directory',

  render(toolBlock, theme, options): ToolRenderConfig {
    const input = toolBlock.input as any

    // Extract directories from input
    let directories: string[] = []

    if (Array.isArray(input?.directories)) {
      directories = input.directories
        .filter(
          (dir: any) =>
            dir !== null &&
            typeof dir === 'object' &&
            typeof dir.path === 'string' &&
            dir.path.trim().length > 0,
        )
        .map((dir: any) => dir.path)
    } else if (
      typeof input?.path === 'string' &&
      input.path.trim().length > 0
    ) {
      directories = [input.path.trim()]
    }

    if (directories.length === 0) {
      return { content: null }
    }

    const record = getToolOutputRecords(toolBlock.outputRaw)[0]
    const files = Array.isArray(record?.files)
      ? record.files.filter((file): file is string => typeof file === 'string')
      : []
    const childDirectories = Array.isArray(record?.directories)
      ? record.directories.filter(
          (directory): directory is string => typeof directory === 'string',
        )
      : []
    const entries = [
      ...childDirectories.map((directory) => `${directory}/`),
      ...files,
    ]
    const error = getStructuredErrorMessages(
      toolBlock.outputRaw ?? toolBlock.output,
    )[0]
    const hasOutput =
      toolBlock.outputRaw !== undefined || Boolean(toolBlock.output?.trim())
    const status = discoveryStatus({
      lifecycle: toolBlock.lifecycle,
      hasOutput,
      error,
      count: entries.length,
    })
    const { glyph, color } = statusGlyph(status, theme)
    const label = directories.join(', ')

    let summaryText = `List ${label}`
    if (error || !hasOutput) {
      // Keep the summary short; error detail renders below.
    } else if (entries.length === 0) {
      summaryText += ' — empty'
    } else if (status === 'running' || status === 'queued') {
      summaryText += ` — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} so far`
    } else {
      summaryText += ` — ${childDirectories.length} dir${childDirectories.length === 1 ? '' : 's'}, ${files.length} file${files.length === 1 ? '' : 's'}`
    }

    // Use a wrapper component to access theme
    const ListDirectoryContent = () => {
      const contentTheme = useTheme()
      return (
        <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
          <SimpleToolCallItem
            name="List"
            description={
              <>
                {summaryText}
                {' '}
                <span fg={color}>{glyph}</span>
              </>
            }
            descriptionColor={contentTheme.directory}
          />
          {error ? (
            <text style={{ wrapMode: 'word' }}>
              <span fg={contentTheme.error}>{error}</span>
            </text>
          ) : entries.length > 0 ? (
            <CollapsibleGroup
              label={label}
              count={entries.length}
              badge={`${childDirectories.length}d/${files.length}f`}
              entries={entries.map((entry, index) => (
                <text
                  key={`${entry}-${index}`}
                  style={{ wrapMode: 'none' }}
                >
                  <span fg={contentTheme.muted}>{'    '}</span>
                  <span fg={contentTheme.foreground}>{entry}</span>
                </text>
              ))}
            />
          ) : null}
        </box>
      )
    }

    return {
      collapsedPreview: `${summaryText} ${glyph}`,
      content: <ListDirectoryContent />,
    }
  },
})
