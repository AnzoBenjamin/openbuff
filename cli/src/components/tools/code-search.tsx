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
export function parseCodeSearchGroups(rawOutput: string): SearchGroup[] | null {
  const groups: SearchGroup[] = []
  let current: SearchGroup | null = null
  let structuredCount = 0

  for (const rawLine of rawOutput.split('\n')) {
    const trimmed = rawLine.trimEnd().trim()
    if (!trimmed || trimmed === '--') continue
    if (/^Found \d+ match(?:es)?$/.test(trimmed)) continue

    const headerMatch = trimmed.match(/^.+:$/)
    if (headerMatch) {
      current = {
        file: trimmed.slice(0, -1).replace(/^\.\//, ''),
        matches: [],
      }
      groups.push(current)
      continue
    }

    const entryMatch = rawLine.match(/^\s*(?:Line\s+)?(\d+):\s?(.*)$/)
    if (entryMatch) {
      if (!current) return null
      current.matches.push({
        line: Number(entryMatch[1]),
        content: entryMatch[2],
      })
      structuredCount += 1
      continue
    }

    const ripgrepMatch = rawLine.match(/^(.+?)(:|-)(\d+)\2(.*)$/)
    if (ripgrepMatch) {
      const file = ripgrepMatch[1].replace(/^\.\//, '')
      if (!current || current.file !== file) {
        current = { file, matches: [] }
        groups.push(current)
      }
      current.matches.push({
        line: Number(ripgrepMatch[3]),
        content: ripgrepMatch[4],
        context: ripgrepMatch[2] === '-',
      })
      structuredCount += 1
      continue
    }

    // A structural line we cannot identify must never carry a later row
    // into the previous source group. Limit notices remain in raw capture.
    current = null
  }

  if (groups.length === 0 || structuredCount === 0) return null

  return groups
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
    const allGroups = parseCodeSearchGroups(rawOutput)
    const filesOnly =
      typeof input?.flags === 'string' &&
      /(?:^|\s)(?:-l|--files-with-matches)(?:\s|$)/.test(input.flags)
    const memory =
      typeof record?.message === 'string' &&
      /served from verified memory/i.test(record.message)
    const matchingFiles = filesOnly
      ? rawOutput
          .split('\n')
          .filter((line) => line.trim() && !line.startsWith('[')).length
      : 0
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
    const groups = error ? null : allGroups
    const capturedRows =
      groups?.reduce((count, group) => count + group.matches.length, 0) ?? 0
    let remainingRows = MAX_TOTAL_MATCHES
    const previewGroups = groups?.flatMap((group) => {
      const shown = Math.min(group.matches.length, remainingRows)
      remainingRows -= shown
      return shown ? [{ ...group, matches: group.matches.slice(0, shown) }] : []
    })
    const limitNotices = rawOutput
      .split('\n')
      .filter(
        (line) =>
          /limit|stopped early|truncat/i.test(line) &&
          !/^(?:Line\s+)?\d+:/.test(line.trim()),
      )
    const previewNotice =
      capturedRows > MAX_TOTAL_MATCHES
        ? `showing ${MAX_TOTAL_MATCHES} of ${capturedRows} captured rows · Inspect for all retained rows`
        : undefined

    // Build single-line summary; the glyph replaces the old `· status` words.
    let summaryText = `Search "${pattern}"`
    if (cwd) {
      summaryText += ` in ${cwd}`
    }
    if (error || !hasOutput) {
      // Keep the summary short; error detail renders below.
    } else if (memory) {
      summaryText += ' — verified memory evidence · fresh search skipped'
    } else if (filesOnly) {
      summaryText += ` — ${matchingFiles} matching files`
    } else if (
      totalResults === 0 &&
      rawOutput.trim() &&
      !/^Found 0 match(?:es)?$/.test(rawOutput.trim())
    ) {
      summaryText += ' — captured evidence · match count unknown'
    } else if (totalResults === 0) {
      summaryText += ' — no matches'
    } else if (status === 'running' || status === 'queued') {
      summaryText += ` — ${totalResults} match${totalResults === 1 ? '' : 'es'} so far`
    } else {
      const fileCount = groups?.length ?? 0
      summaryText += ` — ${totalResults} match${totalResults === 1 ? '' : 'es'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`
    }

    if (
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'unavailable'
    )
      summaryText += ` · ${status}`
    if (limitNotices.length) {
      const kinds = [
        limitNotices.some(line => /global|total/i.test(line)) ? 'global limit' : '',
        limitNotices.some(line => /per[ -]file/i.test(line)) ? 'per-file limit' : '',
        limitNotices.some(line => /byte/i.test(line)) ? 'byte limit' : '',
      ].filter(Boolean)
      summaryText += ` · partial search (${kinds.join(', ') || 'source limit'}); more may exist`
    }
    if (previewNotice) summaryText += ` · ${previewNotice}`

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
                {summaryText} <span fg={color}>{glyph}</span>
              </>
            }
          />
          {error ? (
            <text style={{ wrapMode: 'word' }}>
              <span fg={theme.error}>{error}</span>
            </text>
          ) : groups && groups.length > 0 ? (
            <box style={{ flexDirection: 'column', width: '100%' }}>
              <SearchGroups
                groups={previewGroups ?? []}
                pattern={pattern}
                cwd={cwd}
              />
              {[message, ...limitNotices, previewNotice]
                .filter(Boolean)
                .map((notice, index) => (
                  <text key={index} fg={theme.warning}>
                    {notice}
                  </text>
                ))}
            </box>
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
