import { useState } from 'react'
import { TextAttributes } from '@opentui/core'

import { Button } from '../button'
import { useTheme } from '../../hooks/use-theme'

import type { ReactNode } from 'react'
import type { ThemeName } from '../../types/theme-system'

interface DiffViewerProps {
  diffText: string
  availableWidth?: number
  /** Opt-in side-by-side render mode (degrades to unified when width < 40). */
  sideBySide?: boolean
  /** Render old/new line-number gutters. Defaults to true. */
  showLineNumbers?: boolean
  /** Allow per-hunk expand/collapse toggles. Defaults to true. */
  collapsible?: boolean
  /** Hunk indices (0-based) that start collapsed. Defaults to none. */
  initiallyCollapsedHunks?: number[]
}

const DIFF_LINE_COLORS: Record<ThemeName, { added: string; removed: string }> = {
  dark: {
    added: '#7ACC35',
    removed: '#BF6C69',
  },
  light: {
    added: '#4A9E1C',
    removed: '#C53030',
  },
}

type BodyLineType = 'add' | 'del' | 'context'

interface BodyLine {
  type: BodyLineType
  text: string
  oldNum: number | null
  newNum: number | null
}

interface Hunk {
  index: number
  header: string
  bodyLines: BodyLine[]
  oldStart: number
  newStart: number
  oldLen: number
  newLen: number
}

interface ParsedDiff {
  fileHeaders: string[]
  hunks: Hunk[]
}

export const DIFF_INITIAL_MAX_LINES = 80
export const DIFF_INITIAL_MAX_HUNKS = 8
// Retained export for backward compatibility: the native <diff> renderable is
// viewport-culled, so no client-side render-node cap logic remains.
export const DIFF_MAX_RENDER_NODES = 400

export function getInitiallyCollapsedDiffHunks(parsed: ParsedDiff): number[] {
  let visibleLines = 0
  return parsed.hunks
    .filter((hunk, index) => {
      if (index >= DIFF_INITIAL_MAX_HUNKS) return true
      if (visibleLines + hunk.bodyLines.length > DIFF_INITIAL_MAX_LINES) {
        return true
      }
      visibleLines += hunk.bodyLines.length
      return false
    })
    .map((hunk) => hunk.index)
}

const isFileHeaderLine = (line: string): boolean =>
  line.startsWith('diff ') ||
  line.startsWith('index ') ||
  // Only treat `--- a/...` / `+++ b/...` (git file-header form) as headers.
  // A bare `--- some text` is a deletion of a line starting with `--`
  // (common in SQL/Lua/Haskell comments), not a header, so it must stay in
  // the hunk body as a deletion.
  /^---\s+a\//.test(line) ||
  /^\+\+\+\s+b\//.test(line) ||
  line.startsWith('rename ') ||
  line.startsWith('similarity ')
// Note: lines starting with `\` ("No newline at end of file") are skipped
// earlier in parseDiffIntoHunks before isFileHeaderLine is consulted, so no
// `\` branch is needed here.

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@?(.*)$/

function parseHunkHeader(
  line: string,
): Pick<Hunk, 'oldStart' | 'newStart' | 'oldLen' | 'newLen'> {
  const m = line.match(HUNK_RE)
  if (m) {
    return {
      oldStart: parseInt(m[1], 10),
      newStart: parseInt(m[3], 10),
      // git diff convention: an omitted count means 1, not 0.
      oldLen: m[2] ? parseInt(m[2], 10) : 1,
      newLen: m[4] ? parseInt(m[4], 10) : 1,
    }
  }
  // Degenerate `@@` (no ranges) or any tolerant fallback: default to line 1.
  return { oldStart: 1, newStart: 1, oldLen: 0, newLen: 0 }
}

/**
 * Split a unified diff into leading file-header lines and a list of hunks.
 * Each hunk body line carries its (possibly null) old/new line number, with
 * running counters tracked the way `git diff` does:
 * - context: increments both old and new
 * - del: increments old only
 * - add: increments new only
 * `\\ No newline at end of file` markers are skipped (not rendered as rows).
 */
export function parseDiffIntoHunks(diffText: string): ParsedDiff {
  const rawLines = diffText.length
    ? diffText.replace(/\n+$/, '').split('\n')
    : []
  const fileHeaders: string[] = []
  const hunks: Hunk[] = []
  let currentHunk: Hunk | null = null
  let oldLine = 0
  let newLine = 0

  const pushHunk = () => {
    if (currentHunk) {
      hunks.push(currentHunk)
      currentHunk = null
    }
  }

  for (const raw of rawLines) {
    // No-newline marker: attach to prior line, never render as a body row.
    if (raw.startsWith('\\')) {
      if (!currentHunk) {
        fileHeaders.push(raw)
      }
      continue
    }

    if (raw.startsWith('@@')) {
      pushHunk()
      const { oldStart, newStart, oldLen, newLen } = parseHunkHeader(raw)
      currentHunk = {
        index: hunks.length,
        header: raw,
        bodyLines: [],
        oldStart,
        newStart,
        oldLen,
        newLen,
      }
      oldLine = oldStart
      newLine = newStart
      continue
    }

    if (!currentHunk) {
      // Leading file-header section before the first hunk.
      fileHeaders.push(raw)
      continue
    }

    // A new file section appearing after a hunk: close the hunk and treat as header.
    if (isFileHeaderLine(raw)) {
      pushHunk()
      fileHeaders.push(raw)
      continue
    }

    if (raw.startsWith('+')) {
      currentHunk.bodyLines.push({
        type: 'add',
        text: raw.slice(1),
        oldNum: null,
        newNum: newLine,
      })
      newLine += 1
    } else if (raw.startsWith('-')) {
      currentHunk.bodyLines.push({
        type: 'del',
        text: raw.slice(1),
        oldNum: oldLine,
        newNum: null,
      })
      oldLine += 1
    } else if (raw.startsWith(' ')) {
      currentHunk.bodyLines.push({
        type: 'context',
        text: raw.slice(1),
        oldNum: oldLine,
        newNum: newLine,
      })
      oldLine += 1
      newLine += 1
    } else if (raw === '') {
      // Blank line within a hunk: treat as empty context.
      currentHunk.bodyLines.push({
        type: 'context',
        text: '',
        oldNum: oldLine,
        newNum: newLine,
      })
      oldLine += 1
      newLine += 1
    } else {
      // Unknown content line: preserve as context.
      currentHunk.bodyLines.push({
        type: 'context',
        text: raw,
        oldNum: oldLine,
        newNum: newLine,
      })
      oldLine += 1
      newLine += 1
    }
  }

  pushHunk()
  return { fileHeaders, hunks }
}

/** Right-align a line number into `width` columns; null -> blank gutter. */
export function formatLineNumber(num: number | null, width = 4): string {
  if (num === null || num === undefined) return ' '.repeat(width)
  const s = String(num)
  if (s.length >= width) return s
  return ' '.repeat(width - s.length) + s
}

const hunkBodyPrefix = (type: BodyLineType): string =>
  type === 'add' ? '+' : type === 'del' ? '-' : ' '

/**
 * The line-number-gutter width gate: native gutters render only when the
 * caller wants them AND the terminal is wide enough. `showLineNumbers`
 * defaults to true, mirroring the DiffViewer prop default. Exported for the
 * test suite, which cannot observe non-DOM intrinsic props through
 * react-dom/server's static markup.
 */
export function showLineNumbersGate(
  width: number,
  showLineNumbers = true,
): boolean {
  return showLineNumbers && width >= 24
}

/**
 * Rebuild well-formed unified diff text for one hunk so the native `<diff>`
 * parser receives the `@@` header line plus body lines with their +/-/space
 * prefixes restored exactly as parsed. Unknown content lines (preserved
 * verbatim by parseDiffIntoHunks) are emitted as context so the native
 * parser never sees an invalid body prefix.
 */
const hunkToDiffText = (hunk: Hunk): string =>
  [
    hunk.header,
    ...hunk.bodyLines.map((line) => `${hunkBodyPrefix(line.type)}${line.text}`),
  ].join('\n')

export const DiffViewer = ({
  diffText,
  availableWidth,
  sideBySide = false,
  showLineNumbers = true,
  collapsible = true,
  initiallyCollapsedHunks = [],
}: DiffViewerProps) => {
  const theme = useTheme()
  const parsedDiff = parseDiffIntoHunks(diffText)
  const [collapsedHunks, setCollapsedHunks] = useState<Set<number>>(
    () =>
      new Set([
        ...getInitiallyCollapsedDiffHunks(parsedDiff),
        ...initiallyCollapsedHunks,
      ]),
  )
  const width = Math.max(10, availableWidth ?? 80)
  // The native <diff> renderable draws its own line-number gutters
  // (DiffRenderableOptions.showLineNumbers in @opentui/core); keep the
  // width >= 24 gate so cramped terminals stay gutter-free as before.
  const effectiveShowLineNumbers = showLineNumbersGate(
    width,
    showLineNumbers,
  )

  const toggleHunk = (index: number) => {
    setCollapsedHunks((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  // Side-by-side mode only when the terminal is wide enough (unchanged gate).
  const useSideBySide = sideBySide && width >= 40

  if (diffText.trim() === '') {
    return (
      <box
        style={{ flexDirection: 'column', gap: 0, width: '100%', flexGrow: 1 }}
      >
        <text style={{ wrapMode: 'none' }}>
          <span fg={theme.muted}>(no changes)</span>
        </text>
      </box>
    )
  }

  const { fileHeaders, hunks } = parsedDiff

  // File headers stay plain muted text (bold for the ---/+++ file pair);
  // they are not part of any hunk, so they never reach the native <diff>.
  const renderFileHeader = (line: string, idx: number): ReactNode => (
    <text key={`fh-${idx}`}>
      <span
        fg={theme.muted}
        attributes={
          line.startsWith('---') || line.startsWith('+++')
            ? TextAttributes.BOLD
            : undefined
        }
      >
        {line}
      </span>
    </text>
  )

  const renderHunkHeader = (hunk: Hunk): ReactNode => {
    const collapsed = collapsedHunks.has(hunk.index)
    const hasBody = hunk.bodyLines.length > 0
    const marker = collapsed ? '▸' : '▾'
    const label =
      collapsed && hasBody
        ? `${marker} ${hunk.header} (${hunk.bodyLines.length} lines hidden)`
        : `${marker} ${hunk.header}`

    if (collapsible && hasBody) {
      return (
        <box style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Button
            onClick={() => toggleHunk(hunk.index)}
            style={{ flexDirection: 'row' }}
          >
            <text style={{ wrapMode: 'none' }}>
              <span fg={theme.info} attributes={TextAttributes.BOLD}>
                {label}
              </span>
            </text>
          </Button>
        </box>
      )
    }

    const headerText =
      hasBody && collapsible ? `${marker} ${hunk.header}` : hunk.header
    return (
      <box style={{ flexDirection: 'row', alignItems: 'center' }}>
        <text style={{ wrapMode: 'none' }}>
          <span fg={theme.info} attributes={TextAttributes.BOLD}>
            {headerText}
          </span>
        </text>
      </box>
    )
  }

  return (
    <box
      style={{ flexDirection: 'column', gap: 0, width: '100%', flexGrow: 1 }}
    >
      {fileHeaders.map((line, idx) => renderFileHeader(line, idx))}
      {hunks.map((hunk) => {
        const collapsed = collapsedHunks.has(hunk.index)
        const hasBody = hunk.bodyLines.length > 0
        return (
          <box
            key={`hunk-${hunk.index}`}
            style={{ flexDirection: 'column', gap: 0, width: '100%' }}
          >
            {renderHunkHeader(hunk)}
            {!collapsed && hasBody ? (
              // One native <diff> renderable per visible hunk. Prop names map
              // 1:1 to DiffRenderableOptions (verified in node_modules/@opentui/react
              // src/types/components.d.ts, where DiffProps =
              // ComponentProps<DiffRenderableOptions, DiffRenderable>, and
              // node_modules/@opentui/core renderables/Diff.d.ts). syntaxStyle
              // is left undefined so the native defaults apply; the renderable
              // is viewport-culled, so no client-side render-node cap is needed.
              <diff
                diff={hunkToDiffText(hunk)}
                view={useSideBySide ? 'split' : 'unified'}
                syncScroll={useSideBySide}
                showLineNumbers={effectiveShowLineNumbers}
                addedSignColor={DIFF_LINE_COLORS[theme.name].added}
                removedSignColor={DIFF_LINE_COLORS[theme.name].removed}
                style={{ width: '100%' }}
              />
            ) : null}
          </box>
        )
      })}
    </box>
  )
}
