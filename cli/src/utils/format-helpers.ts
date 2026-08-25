/**
 * Shared formatting helpers used across commands and UI renderers.
 * Centralized here to avoid UI -> command layer violations and cross-command coupling.
 */
export function pluralizeEntries(count: number): string {
  return count === 1 ? 'entry' : 'entries'
}

export function formatAge(milliseconds: number): string {
  const clamped = Math.max(0, milliseconds)
  if (clamped < 1_000) return '<1s'
  const seconds = Math.floor(clamped / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  // Intentionally coarser than the hour branch: at multi-day scales minutes
  // add noise, so the day branch truncates to "Nd Nh" (e.g. "2d 5h") without
  // a minutes component. This shape is pinned by format-helpers.test.ts and
  // consumed as-is by memory command/UI rendering.
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * Turn a status line into a title: trimmed, with trailing periods dropped.
 * All consecutive trailing '.' characters are stripped (so "Hello.." becomes
 * "Hello" rather than "Hello." — an ellipsis is not preserved as a single
 * dot). Renderer-specific wording stays with the renderer, so an empty or
 * whitespace-only line yields '' and the caller names its own fallback (see
 * index-status-box: `deriveTitle(line) || 'Index status'`).
 */
export const deriveTitle = (statusLine: string): string => {
  const trimmed = statusLine.trim()
  if (trimmed.length === 0) return ''
  return trimmed.replace(/\.+$/, '')
}
