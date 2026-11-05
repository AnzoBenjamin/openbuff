import stringWidth from 'string-width'
import { sliceTextCells } from './text-boundaries'

export function clipEvidenceLine(text: string, maxCells: number): string {
  return stringWidth(text) > maxCells
    ? sliceTextCells(text, 0, Math.max(0, maxCells - 1)) + '…'
    : text
}

/** A bounded plain-text projection of retained data for command inspectors. */
export function formatBoundedEvidence(
  value: unknown,
  maxChars = 16000,
): string {
  let remaining = 1000
  let remainingChars = maxChars
  let limited = false
  const seen = new WeakSet<object>()
  const project = (item: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 8) {
      limited = true
      return '[detail limit]'
    }
    if (typeof item === 'string') {
      if (item.length > remainingChars) limited = true
      const text = item.slice(0, remainingChars)
      remainingChars -= text.length
      return text
    }
    if (typeof item === 'bigint') return String(item)
    if (typeof item !== 'object' || item === null) return item
    if (seen.has(item)) return '[repeated reference]'
    seen.add(item)
    if (Array.isArray(item)) {
      if (item.length > 200) limited = true
      return item.slice(0, 200).map((entry) => project(entry, depth + 1))
    }
    const result: Record<string, unknown> = {}
    let count = 0
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue
      if (++count > 100 || remaining <= 0) {
        limited = true
        break
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (key.length > 256) limited = true
      result[key.slice(0, 256)] =
        descriptor && 'value' in descriptor
          ? project(descriptor.value, depth + 1)
          : '[accessor not read]'
    }
    return result
  }
  let text: string
  try {
    if (typeof value === 'string' && value.length > maxChars) limited = true
    text =
      typeof value === 'string'
        ? value.slice(0, maxChars)
        : (JSON.stringify(project(value, 0), null, 2) ?? String(value))
  } catch {
    text = '[evidence cannot be serialized]'
  }
  text = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  if (text.length > maxChars) limited = true
  return (
    text.slice(0, maxChars) +
    (limited
      ? '\n[Detail preview bounded; use recorded --json export for retained event fields.]'
      : '')
  )
}
