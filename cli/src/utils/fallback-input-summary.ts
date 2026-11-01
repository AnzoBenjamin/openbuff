/**
 * Human-shaped rendering of a tool input and result for the
 * unregistered-tool fallback path.
 *
 * `blocks/tool-branch.tsx` is the last-resort view for tools without a
 * registered renderer (custom tools, MCP tools, and restored-removed tools).
 * It used to fenced-dump the whole input as pretty-printed JSON, which is
 * exactly the raw-JSON wall the humanized renderers in `components/tools/`
 * replaced. These helpers give that path a human shape: scalar and
 * string-list entries become `key: value` rows, and only an input with no
 * readable scalar still falls back to bounded JSON, because there is no
 * honest field-per-line view of a purely nested structure.
 *
 * Pure functions only - no React, no I/O - so the shaping stays unit-testable
 * without rendering a block.
 */

/** Cap on `key: value` rows so a wide tool input cannot flood the block. */
export const MAX_FALLBACK_INPUT_ROWS = 8

/** Cap on a single row's value, keeping long commands and urls readable. */
export const MAX_FALLBACK_INPUT_VALUE_CHARS = 160

/** Cap on the bounded-JSON escape hatch for a purely nested input. */
export const MAX_FALLBACK_INPUT_JSON_CHARS = 2_000

/** Cap on a fallback result body so a huge output cannot stall the TUI. */
export const MAX_FALLBACK_OUTPUT_CHARS = 8_000

function truncateText(text: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  return text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `key: value` rows for every scalar and string-list entry of a tool input,
 * in the input's own emission order. Returns an empty string when the input
 * carries nothing readable as a row (absent, primitive, or nested-only), so
 * the caller can fall back to bounded JSON for that shapeless case.
 */
export function summarizeFallbackInput(input: unknown): string {
  if (!isRecordValue(input)) return ''

  const rows: string[] = []
  let skippedKeys = 0

  for (const [key, value] of Object.entries(input)) {
    if (rows.length >= MAX_FALLBACK_INPUT_ROWS) {
      skippedKeys += 1
      continue
    }
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length === 0) {
        skippedKeys += 1
        continue
      }
      rows.push(
        `${key}: ${truncateText(trimmed, MAX_FALLBACK_INPUT_VALUE_CHARS)}`,
      )
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      rows.push(`${key}: ${value}`)
      continue
    }
    if (typeof value === 'boolean') {
      rows.push(`${key}: ${value ? 'yes' : 'no'}`)
      continue
    }
    if (Array.isArray(value)) {
      const items = value.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      )
      if (items.length === 0) {
        skippedKeys += 1
        continue
      }
      rows.push(
        `${key}: ${truncateText(items.join(', '), MAX_FALLBACK_INPUT_VALUE_CHARS)}`,
      )
      continue
    }
    skippedKeys += 1
  }

  if (rows.length === 0) return ''
  if (skippedKeys > 0) {
    rows.push(
      `… ${skippedKeys} more field${skippedKeys === 1 ? '' : 's'} omitted`,
    )
  }
  return rows.join('\n')
}

/**
 * Whether the input is present at all. A tool called with no arguments (or an
 * explicit `{}`) renders as a bare header rather than a `{}` fence.
 */
export function hasFallbackInputValue(input: unknown): boolean {
  if (input === undefined || input === null) return false
  if (isRecordValue(input)) return Object.keys(input).length > 0
  return true
}

/** Bounded pretty JSON for an input with no human-shaped rows. */
export function boundedFallbackJson(input: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    serialized = String(input)
  }
  return truncateText(serialized, MAX_FALLBACK_INPUT_JSON_CHARS)
}

/** Bounded plain-text body for a fallback result. */
export function boundedFallbackOutput(output: string): string {
  return truncateText(output, MAX_FALLBACK_OUTPUT_CHARS)
}

/** Format complete JSON tool results as readable fields; leave prose untouched. */
export function formatFallbackOutput(output: string): string {
  const text = output.trim()
  if (text.length > 500_000 || !/^[\[{]/.test(text)) {
    return boundedFallbackOutput(output)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return boundedFallbackOutput(output)
  }
  if (!parsed || typeof parsed !== 'object')
    return boundedFallbackOutput(output)

  const rows: string[] = []
  let omitted = 0
  const visit = (value: unknown, label: string, depth: number): void => {
    if (rows.length >= 30) {
      omitted++
      return
    }
    if (value !== null && typeof value === 'object') {
      if (depth >= 4) {
        rows.push(`${label}: [nested details omitted]`)
        return
      }
      const entries = Array.isArray(value) ? value : Object.entries(value)
      if (entries.length === 0) {
        rows.push(
          `${label || 'result'}: ${Array.isArray(value) ? 'none' : 'empty'}`,
        )
      } else {
        for (let index = 0; index < entries.length; index++) {
          if (rows.length >= 30) {
            omitted += entries.length - index
            break
          }
          const [key, item] = Array.isArray(value)
            ? [String(index + 1), entries[index]]
            : (entries[index] as [string, unknown])
          const readableKey = key
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/_/g, ' ')
            .toLowerCase()
          visit(
            item,
            label ? `${label} · ${readableKey}` : readableKey,
            depth + 1,
          )
        }
      }
      return
    }
    const rendered = typeof value === 'string' ? value : String(value)
    rows.push(`${label ? `${label}: ` : ''}${truncateText(rendered, 2000)}`)
  }
  visit(parsed, '', 0)
  if (omitted) rows.push(`… ${omitted} more entries omitted`)
  return boundedFallbackOutput(rows.join('\n'))
}
