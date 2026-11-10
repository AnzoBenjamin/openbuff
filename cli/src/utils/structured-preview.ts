/** A bounded, human-readable projection. Captured data stays in the reader. */
export interface StructuredPreviewRow {
  depth: number
  label?: string
  value?: string
  heading?: boolean
}

const MAX_ROWS = 30
const MAX_CHARACTERS = 8_000
const MAX_DEPTH = 4

/** Keep captured terminal controls from becoming commands in the preview. */
export function cleanPreviewText(text: string): string {
  return Bun.stripANSI(text).replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    '',
  )
}

export function humanizeFieldName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
}

export function parseStructuredPreview(text: string): unknown | undefined {
  if (text.length > 500_000) return undefined
  const trimmed = text.trim()
  if (!/^[\[{]/.test(trimmed)) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

export function createStructuredPreview(
  value: unknown,
): StructuredPreviewRow[] {
  const rows: StructuredPreviewRow[] = []
  const ancestors = new WeakSet<object>()
  let characters = 0
  let limited = false
  const append = (row: StructuredPreviewRow): boolean => {
    if (rows.length >= MAX_ROWS || characters >= MAX_CHARACTERS) {
      limited = true
      return false
    }
    if (row.label && row.label.length > 160) {
      row.label = `${row.label.slice(0, 159)}…`
      limited = true
    }
    const budget = Math.max(
      0,
      Math.min(2_000, MAX_CHARACTERS - characters - (row.label?.length ?? 0)),
    )
    const text = row.value
    if (text && text.length > budget) {
      row.value = `${text.slice(0, Math.max(0, budget - 1))}…`
      limited = true
    }
    if (row.label) row.label = cleanPreviewText(row.label).replace(/\s+/g, ' ')
    if (row.value) row.value = cleanPreviewText(row.value)
    characters += (row.label?.length ?? 0) + (row.value?.length ?? 0)
    rows.push(row)
    return true
  }
  const visit = (item: unknown, depth: number, label?: string): void => {
    if (rows.length >= MAX_ROWS || characters >= MAX_CHARACTERS) {
      limited = true
      return
    }
    if (typeof item === 'string') {
      const parsed = parseStructuredPreview(item)
      if (parsed !== undefined) {
        visit(parsed, depth, label)
        return
      }
    }
    if (item === null || typeof item !== 'object') {
      append({
        depth,
        label,
        value:
          item === null || item === undefined
            ? 'None'
            : typeof item === 'boolean'
              ? item
                ? 'Yes'
                : 'No'
              : String(item),
      })
      return
    }
    if (ancestors.has(item)) {
      append({
        depth,
        label,
        value: 'Circular reference · Inspect for details',
      })
      return
    }
    if (depth >= MAX_DEPTH) {
      append({ depth, label, value: 'Nested details · Inspect to read' })
      limited = true
      return
    }
    ancestors.add(item)
    if (label && !append({ depth, label, heading: true })) return
    const childDepth = label ? depth + 1 : depth
    let count = 0
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        if (rows.length >= MAX_ROWS || characters >= MAX_CHARACTERS) {
          limited = true
          break
        }
        const descriptor = Object.getOwnPropertyDescriptor(item, index)
        visit(
          descriptor && 'value' in descriptor
            ? descriptor.value
            : 'Unavailable in preview',
          childDepth,
          `${index + 1}.`,
        )
        count++
      }
    } else {
      for (const key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue
        if (rows.length >= MAX_ROWS || characters >= MAX_CHARACTERS) {
          limited = true
          break
        }
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        visit(
          descriptor && 'value' in descriptor
            ? descriptor.value
            : 'Accessor not evaluated',
          childDepth,
          humanizeFieldName(key),
        )
        count++
      }
    }
    if (!count)
      append({
        depth: childDepth,
        value: Array.isArray(item)
          ? 'No results returned'
          : 'No fields returned',
      })
    ancestors.delete(item)
  }
  visit(value, 0)
  if (limited)
    rows.push({
      depth: 0,
      value: 'Preview limited · Inspect for captured details',
    })
  return rows
}

export function formatStructuredPreview(value: unknown): string {
  return createStructuredPreview(value)
    .map(
      (row) =>
        `${'  '.repeat(row.depth)}${row.label ? `${row.label}${row.label.endsWith('.') ? (row.heading ? '' : ' ') : row.heading ? ':' : ': '}` : ''}${row.value ?? ''}`,
    )
    .join('\n')
}

/** Prefer an explicit human summary; otherwise keep the first value's label. */
export function summarizeStructuredPreview(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['summary', 'message', 'headline', 'detail']) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      const text =
        descriptor && 'value' in descriptor ? descriptor.value : undefined
      if (
        typeof text === 'string' &&
        text.trim() &&
        parseStructuredPreview(text) === undefined
      )
        return cleanPreviewText(text.slice(0, 2_000)).trim()
    }
  }
  if (Array.isArray(value) && value.length === 0) return 'No results returned'
  const rows = createStructuredPreview(value)
  const index = rows.findIndex((item) => !item.heading && item.value)
  const row = rows[index]
  if (!row) return ''
  if (row.label?.endsWith('.')) {
    const group = rows
      .slice(0, index)
      .findLast(
        (item) => item.heading && item.label && !item.label.endsWith('.'),
      )
    return group ? `${group.label}: ${row.value}` : `${row.label} ${row.value}`
  }
  return `${row.label ? `${row.label}: ` : ''}${row.value}`
}
