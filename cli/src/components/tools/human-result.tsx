import React from 'react'

import { SimpleToolCallItem } from './tool-call-item'
import { useTheme } from '../../hooks/use-theme'
import { wrapTextPreservingNewlines } from '../../utils/text-layout'

import type { ChatTheme } from '../../types/theme-system'

/**
 * Shared building blocks for the human-facing tool renderers.
 *
 * Every tool that used to fall through to the raw-JSON fallback in
 * `blocks/tool-branch.tsx` now gets a renderer built from these pieces so the
 * whole family reads the same way: one bold `Name summary ✓` header line, then
 * indented dim `label: value` detail rows, then bounded entry lists with an
 * honest overflow note. Nothing here formats a JSON blob — a value that cannot
 * be summarized renders as one trimmed line instead.
 */

/** Left padding applied to a renderer's body, matching the discovery cards. */
export const RESULT_BODY_INDENT = 2
/** Extra indent for per-entry detail rows under a header. */
export const RESULT_ROW_INDENT = 3

/** Narrowest body column any renderer should try to draw into. */
export const MIN_RESULT_WIDTH = 10

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** First non-empty trimmed string among the candidates. */
export function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

/** First finite number among the candidates. */
export function readNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

/** Non-empty strings from an unknown value, ignoring every other shape. */
export function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      )
    : []
}

/** Object entries from an unknown value, ignoring every other shape. */
export function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : []
}

export function truncateText(text: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  return text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

export function pluralize(
  count: number,
  singular: string,
  plural?: string,
): string {
  return count === 1 ? singular : (plural ?? `${singular}s`)
}

export function formatCount(
  count: number,
  singular: string,
  plural?: string,
): string {
  return `${count} ${pluralize(count, singular, plural)}`
}

/** Body column width for a renderer, honoring the surrounding indent. */
export function bodyWidth(availableWidth: number | undefined): number {
  return Math.max(MIN_RESULT_WIDTH, (availableWidth ?? 80) - RESULT_BODY_INDENT)
}

/** Detail-row width: body width minus the detail indent. */
export function rowWidth(availableWidth: number | undefined): number {
  return Math.max(
    MIN_RESULT_WIDTH,
    (availableWidth ?? 80) - RESULT_BODY_INDENT - RESULT_ROW_INDENT,
  )
}

/* ------------------------------------------------------------------ *
 * Outcome tone: the one place verdict words map to glyph + color.
 * ------------------------------------------------------------------ */

export {
  classifyOutputOutcome as outcomeTone,
  normalizeOutcomeKey,
} from '../../utils/output-outcome'
import {
  classifyOutputOutcome as outcomeTone,
  normalizeOutcomeKey,
  type OutputOutcomeTone as OutcomeTone,
} from '../../utils/output-outcome'
export type { OutputOutcomeTone as OutcomeTone } from '../../utils/output-outcome'

export const OUTCOME_GLYPH: Record<OutcomeTone, string> = {
  good: '✓',
  warn: '▲',
  bad: '✗',
  neutral: '•',
}

export function outcomeColor(tone: OutcomeTone, theme: ChatTheme): string {
  switch (tone) {
    case 'good':
      return theme.success
    case 'warn':
      return theme.warning
    case 'bad':
      return theme.error
    default:
      return theme.muted
  }
}

export function outcomeGlyph(
  tone: OutcomeTone,
  theme: ChatTheme,
): { glyph: string; color: string } {
  return { glyph: OUTCOME_GLYPH[tone], color: outcomeColor(tone, theme) }
}

/** Glanceable glyph for an explicit status word (failed/ready/...). */
export function statusGlyphFor(
  status: string | undefined,
  theme: ChatTheme,
): { glyph: string; color: string } {
  const tone = outcomeTone(status)
  // A settled-but-empty result (`ready · no matches`) is a legitimate answer,
  // not a warning, so an explicit ready/complete state never reads amber.
  const key = normalizeOutcomeKey(status)
  if (key !== undefined && key.startsWith('ready')) {
    return { glyph: OUTCOME_GLYPH.good, color: theme.success }
  }
  if (key === 'no_matches') {
    return { glyph: OUTCOME_GLYPH.neutral, color: theme.muted }
  }
  return outcomeGlyph(tone, theme)
}

/* ------------------------------------------------------------------ *
 * Layout primitives
 * ------------------------------------------------------------------ */

export interface ResultHeaderProps {
  /** Bold label, e.g. `Search`, `Index`, `Rename`. */
  name: string
  /** Human summary of what the call did. */
  summary: React.ReactNode
  /** Trailing status glyph. */
  glyph?: string
  /** Color for the trailing glyph. */
  glyphColor?: string
}

/**
 * The single header line every humanized renderer opens with:
 * `• Name summary ✓`.
 */
export function ResultHeader({
  name,
  summary,
  glyph,
  glyphColor,
}: ResultHeaderProps) {
  return (
    <SimpleToolCallItem
      name={name}
      description={
        <>
          {summary}
          {glyph ? (
            <>
              {' '}
              <span fg={glyphColor}>{glyph}</span>
            </>
          ) : null}
        </>
      }
    />
  )
}

export interface DetailRowProps {
  /** Optional dim label rendered as `label: `. */
  label?: string
  value: React.ReactNode
  /** Wrap width for a string value. */
  width: number
  valueColor?: string
  /**
   * @deprecated no-op; retained for source compatibility. Detail rows always
   * render in the default theme font, so this flag has no effect. It stays on
   * the exported props so existing callers that spread a shared row-options
   * object containing `monospace` into `<DetailRow {...rowOptions} />` keep
   * compiling. Drop it in a clearly marked breaking release.
   */
  monospace?: boolean
}

/**
 * One dim `label: value` detail row under a header. `monospace` is accepted
 * but intentionally unused (deprecated no-op kept for source compatibility).
 */
export function DetailRow({ label, value, width, valueColor }: DetailRowProps) {
  const theme = useTheme()
  return (
    <text style={{ wrapMode: 'word' }}>
      {label ? <span fg={theme.muted}>{`${label}: `}</span> : null}
      <span fg={valueColor ?? theme.foreground}>
        {typeof value === 'string'
          ? wrapTextPreservingNewlines(value, Math.max(1, width))
          : value}
      </span>
    </text>
  )
}

export interface EntryRowProps {
  /** Numeric prefix shown before the entry, e.g. an index or line number. */
  prefix?: string
  value: React.ReactNode
  width: number
  valueColor?: string
  bold?: boolean
}

/** One list entry with a dim leading prefix. */
export function EntryRow({
  prefix,
  value,
  width,
  valueColor,
  bold = false,
}: EntryRowProps) {
  const theme = useTheme()
  return (
    <text style={{ wrapMode: 'word' }}>
      {prefix ? <span fg={theme.muted}>{`${prefix} `}</span> : null}
      <span
        fg={valueColor ?? theme.foreground}
        attributes={bold ? 1 : undefined}
      >
        {typeof value === 'string'
          ? wrapTextPreservingNewlines(value, Math.max(1, width))
          : value}
      </span>
    </text>
  )
}

/** `… N more omitted` note, shown only when something was hidden. */
export function OverflowNote({
  hiddenCount,
  noun,
}: {
  hiddenCount: number
  noun: string
}) {
  const theme = useTheme()
  if (hiddenCount <= 0) return null
  return (
    <text style={{ wrapMode: 'word' }}>
      <span fg={theme.warning}>
        {`… ${formatCount(hiddenCount, noun)} omitted from this view`}
      </span>
    </text>
  )
}

/** Error line in the theme's error color, wrapped. */
export function ErrorRow({
  message,
  width,
}: {
  message: string
  width: number
}) {
  const theme = useTheme()
  return (
    <text style={{ wrapMode: 'word' }}>
      <span fg={theme.error}>
        {wrapTextPreservingNewlines(message, Math.max(1, width))}
      </span>
    </text>
  )
}

/** Full renderer body: indented column with the caller's rows. */
export function ResultBody({ children }: { children: React.ReactNode }) {
  return (
    <box
      style={{
        flexDirection: 'column',
        gap: 0,
        paddingLeft: RESULT_BODY_INDENT,
        width: '100%',
      }}
    >
      {children}
    </box>
  )
}

/**
 * Outer wrapper every humanized renderer returns: a column holding the header
 * line plus the body rows.
 */
export function ResultShell({ children }: { children: React.ReactNode }) {
  return (
    <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
      {children}
    </box>
  )
}

/** Standard collapsed preview: `summary ✓`. */
export function previewWithGlyph(summary: string, glyph: string): string {
  return `${summary} ${glyph}`
}
