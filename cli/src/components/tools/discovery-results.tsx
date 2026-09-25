import { TextAttributes } from '@opentui/core'
import React, { useState } from 'react'

import { Button } from '../button'
import { useTheme } from '../../hooks/use-theme'

import type { ChatTheme } from '../../types/theme-system'

export interface SearchMatch {
  line: number
  content: string
}

export interface SearchGroup {
  file: string
  matches: SearchMatch[]
}

export interface FileGroup {
  dir: string
  files: string[]
}

const PREVIEW_ENTRIES = 3

/**
 * Map a discovery status string to a colored status glyph. Errors keep their
 * full detail text elsewhere; the glyph is the glanceable signal.
 */
export function statusGlyph(
  status: string,
  theme: ChatTheme,
): { glyph: string; color: string } {
  if (status === 'failed') return { glyph: '✗', color: theme.error }
  if (status.startsWith('complete') || status.startsWith('ready')) {
    return { glyph: '✓', color: theme.success }
  }
  return { glyph: '⟳', color: theme.primary }
}

/**
 * Display a result path relative to the search scope when possible so
 * grouped headers stay short.
 */
export function shortenPath(path: string, cwd: string): string {
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  return path
}

export interface HighlightSegment {
  text: string
  match: boolean
}

/**
 * Split content into matched/unmatched segments for emphasis rendering.
 * Tolerates invalid or pathological patterns: invalid regex falls back to a
 * case-insensitive literal split; oversized patterns skip highlighting.
 */
export function splitPatternSegments(
  text: string,
  pattern: string,
): HighlightSegment[] {
  if (!text || !pattern || pattern.length > 200) {
    return [{ text, match: false }]
  }
  let re: RegExp | null = null
  try {
    re = new RegExp(pattern, 'gi')
  } catch {
    re = null
  }
  if (!re) {
    const needle = pattern.toLowerCase()
    const haystack = text.toLowerCase()
    const segments: HighlightSegment[] = []
    let from = 0
    let at = haystack.indexOf(needle)
    while (at !== -1) {
      if (at > from) {
        segments.push({ text: text.slice(from, at), match: false })
      }
      segments.push({ text: text.slice(at, at + needle.length), match: true })
      from = at + needle.length
      at = haystack.indexOf(needle, from)
    }
    if (from < text.length) {
      segments.push({ text: text.slice(from), match: false })
    }
    return segments.length > 0 ? segments : [{ text, match: false }]
  }
  const segments: HighlightSegment[] = []
  let last = 0
  re.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ text: text.slice(last, match.index), match: false })
    }
    const matched = match[0]
    if (matched.length === 0) {
      re.lastIndex += 1
      continue
    }
    segments.push({ text: matched, match: true })
    last = match.index + matched.length
    if (segments.length > 1000) break
  }
  if (last < text.length) {
    segments.push({ text: text.slice(last), match: false })
  }
  return segments
}

/**
 * Render content with matched pattern substrings emphasized.
 */
export function HighlightedContent({
  content,
  pattern,
}: {
  content: string
  pattern: string
}) {
  const theme = useTheme()
  const segments = splitPatternSegments(content, pattern)
  return (
    <text style={{ wrapMode: 'none' }}>
      {segments.map((segment, index) => (
        <span
          key={index}
          fg={segment.match ? theme.primary : theme.foreground}
          attributes={segment.match ? TextAttributes.BOLD : undefined}
        >
          {segment.text}
        </span>
      ))}
    </text>
  )
}

/**
 * A single collapsible result group. Default collapsed to the first
 * PREVIEW_ENTRIES entries; clicking the header toggles.
 */
export function CollapsibleGroup({
  label,
  count,
  entries,
  badge,
  previewCount,
}: {
  label: string
  count: number
  entries: React.ReactNode[]
  /** Optional badge text rendered instead of the entry count. */
  badge?: string
  /** How many entries to show before expansion. Defaults to 3. */
  previewCount?: number
}) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const visibleCount = expanded
    ? entries.length
    : Math.min(previewCount ?? PREVIEW_ENTRIES, entries.length)
  const hiddenCount = entries.length - visibleCount

  return (
    <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
      <Button onClick={() => setExpanded((value) => !value)}>
        <text style={{ wrapMode: 'word' }}>
          <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
            {expanded ? '▾ ' : '▸ '}
          </span>
          <span fg={theme.directory}>
            {`${label} (${badge ?? count})`}
          </span>
        </text>
      </Button>
      {entries.slice(0, visibleCount)}
      {hiddenCount > 0 ? (
        <text style={{ wrapMode: 'none' }}>
          <span fg={theme.muted}>{`    … ${hiddenCount} more`}</span>
        </text>
      ) : null}
    </box>
  )
}

/**
 * Grouped code_search matches: one collapsible group per file with a count
 * badge, dimmed line numbers, and pattern-match emphasis on the content.
 */
export function SearchGroups({
  groups,
  pattern,
  cwd,
}: {
  groups: SearchGroup[]
  pattern: string
  cwd: string
}) {
  const theme = useTheme()
  const widths = groups.map((group) =>
    Math.max(...group.matches.map((match) => String(match.line).length), 1),
  )
  const lineWidth = Math.max(...widths, 1)

  return (
    <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
      {groups.map((group) => (
        <CollapsibleGroup
          key={group.file}
          label={shortenPath(group.file, cwd)}
          count={group.matches.length}
          entries={group.matches.map((match, index) => (
            <box
              key={`${match.line}-${index}`}
              style={{ flexDirection: 'row', gap: 0, width: '100%' }}
            >
              <text style={{ wrapMode: 'none' }}>
                <span fg={theme.muted}>
                  {`  ${String(match.line).padStart(lineWidth)} | `}
                </span>
              </text>
              <HighlightedContent content={match.content} pattern={pattern} />
            </box>
          ))}
        />
      ))}
    </box>
  )
}

/**
 * Grouped glob matches: one collapsible group per directory with a count
 * badge, basenames as entries, and paths shortened relative to the scope.
 */
export function FileGroups({
  groups,
  cwd,
}: {
  groups: FileGroup[]
  cwd: string
}) {
  const theme = useTheme()

  return (
    <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
      {groups.map((group) => (
        <CollapsibleGroup
          key={group.dir || '.'}
          label={group.dir ? shortenPath(group.dir, cwd) : '.'}
          count={group.files.length}
          entries={group.files.map((file, index) => {
            const basename = file.slice(file.lastIndexOf('/') + 1)
            return (
              <text key={`${file}-${index}`} style={{ wrapMode: 'none' }}>
                <span fg={theme.muted}>{'    '}</span>
                <span fg={theme.foreground}>{basename}</span>
              </text>
            )
          })}
        />
      ))}
    </box>
  )
}
