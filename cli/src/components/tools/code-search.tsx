import React from 'react'

import { DiscoveryOutput, discoveryStatus } from './discovery-output'
import {
  SearchGroups,
  statusGlyph,
  type SearchGroup,
} from './discovery-results'
import { SimpleToolCallItem } from './tool-call-item'
import { defineToolComponent } from './types'
import { countCodeSearchResults } from '../../utils/code-search-summary'
import {
  getStructuredErrorMessages,
  getToolOutputRecords,
} from '../../utils/tool-result-normalizer'

import type { ToolRenderConfig } from './types'

const MAX_TOTAL_MATCHES = 250

/**
 * Parse formatted code search output into per-file match groups. Understands
 * the grouped format produced by `formatCodeSearchOutput` (file header lines
 * plus `Line N:` entries) and raw ripgrep lines (`path:123:content`, with
 * `path-123-content` for context). Returns null when nothing is recognizable,
 * so the caller can fall back to the plain-text view.
 */
export function parseCodeSearchGroups(
  rawOutput: string,
): SearchGroup[] | null {
  const groups: SearchGroup[] = []
  let current: SearchGroup | null = null
  let structuredCount = 0

  for (const rawLine of rawOutput.split('\n')) {
    const trimmed = rawLine.trimEnd().trim()
    if (!trimmed || trimmed === '--') continue
    if (/^Found \d+ match(?:es)?$/.test(trimmed)) continue

    const headerMatch = trimmed.match(/^(?:\.\/)?[\w.@/-]+:$/)
    if (headerMatch) {
      current = {
        file: trimmed.slice(0, -1).replace(/^\.\//, ''),
        matches: [],
      }
      groups.push(current)
      continue
    }

    const entryMatch = trimmed.match(/^(?:Line\s+)?(\d+):\s?(.*)$/)
    if (entryMatch) {
      if (!current) return null
      current.matches.push({
        line: Number(entryMatch[1]),
        content: entryMatch[2],
      })
      structuredCount += 1
      continue
    }

    const ripgrepMatch = trimmed.match(/^(.+?)(?::|-)(\d+)(?::|-)(.+)$/)
    if (ripgrepMatch) {
      const file = ripgrepMatch[1].replace(/^\.\//, '')
      if (!current || current.file !== file) {
        current = { file, matches: [] }
        groups.push(current)
      }
      current.matches.push({
        line: Number(ripgrepMatch[2]),
        content: ripgrepMatch[3],
      })
      structuredCount += 1
      continue
    }

    if (!current) return null
  }

  if (groups.length === 0 || structuredCount === 0) return null

  let remaining = MAX_TOTAL_MATCHES
  const bounded: SearchGroup[] = []
  for (const group of groups) {
    if (remaining <= 0) break
    if (group.matches.length > remaining) {
      bounded.push({
        file: group.file,
        matches: group.matches.slice(0, remaining),
      })
      remaining = 0
    } else {
      bounded.push(group)
      remaining -= group.matches.length
    }
  }
  return bounded
}

/**
 * UI component for code_search tool.
 * The header line summarizes the query and match count with a status glyph;
 * the expanded body groups matches by file in collapsible sections with the
 * matched pattern emphasized.
 */
export const CodeSearchComponent = defineToolComponent({
  toolName: 'code_search',

  render(toolBlock, theme, options): ToolRenderConfig {
    const input = toolBlock.input as any
    const pattern = input?.pattern ?? ''
    const cwd = input?.cwd ?? ''

    const record = getToolOutputRecords(toolBlock.outputRaw)[0]
    const rawOutput =
      typeof record?.stdout === 'string'
        ? record.stdout
        : typeof record?.stdoutExcerpt === 'string'
          ? record.stdoutExcerpt
          : (toolBlock.output ?? '')
    const totalResults = countCodeSearchResults(rawOutput)
    const error = getStructuredErrorMessages(
      toolBlock.outputRaw ?? toolBlock.output,
    )[0]
    const hasOutput =
      toolBlock.outputRaw !== undefined || Boolean(toolBlock.output?.trim())
    const status = discoveryStatus({
      lifecycle: toolBlock.lifecycle,
      hasOutput,
      error,
      count: totalResults,
    })
    const { glyph, color } = statusGlyph(status, theme)
    const groups = error ? null : parseCodeSearchGroups(rawOutput)

    // Build single-line summary; the glyph replaces the old `· status` words.
    let summaryText = `Search "${pattern}"`
    if (cwd) {
      summaryText += ` in ${cwd}`
    }
    if (error || !hasOutput) {
      // Keep the summary short; error detail renders below.
    } else if (totalResults === 0) {
      summaryText += ' — no matches'
    } else if (status === 'running' || status === 'queued') {
      summaryText += ` — ${totalResults} match${totalResults === 1 ? '' : 'es'} so far`
    } else {
      const fileCount = groups?.length ?? 0
      summaryText += ` — ${totalResults} match${totalResults === 1 ? '' : 'es'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`
    }

    const outputLines = rawOutput
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
    const message =
      typeof record?.message === 'string' ? record.message : undefined

    return {
      collapsedPreview: `${summaryText} ${glyph}`,
      content: (
        <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
          <SimpleToolCallItem
            name="Search"
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
          ) : groups && groups.length > 0 ? (
            <SearchGroups groups={groups} pattern={pattern} cwd={cwd} />
          ) : (
            <DiscoveryOutput
              status={status}
              message={message}
              error={error}
              provenance={cwd || 'project root'}
              items={outputLines}
              maxVisibleItems={MAX_TOTAL_MATCHES}
              availableWidth={options.availableWidth}
              showHeader={false}
            />
          )}
        </box>
      ),
    }
  },
})
