import { getContentHash, normalizeLineEndings } from './content-hash'

/**
 * The two 1-indexed line spaces the read/edit toolchain works in, derived once
 * so that no caller has to re-implement the trailing-empty-entry rule (and then
 * drift from the rule `read_files` actually mints capabilities with).
 */
export type LineCoordinates = {
  /** LF-normalized content. */
  normalized: string
  /** normalized.split('\n') — retains the trailing empty entry. */
  lines: string[]
  /** Lines a reader sees; excludes the trailing empty split entry. 0 for empty content. */
  visibleLineCount: number
  /**
   * Highest 1-indexed line a read capability may legally bind. Equals
   * lines.length, i.e. visibleLineCount + 1 whenever content ends in a
   * newline. read_files mints capabilities in THIS space, so every edit-time
   * bounds check must use it as the ceiling.
   */
  maxCapabilityLine: number
}

export function getLineCoordinates(content: string): LineCoordinates {
  const normalized = normalizeLineEndings(content)
  const lines = normalized.split('\n')
  return {
    normalized,
    lines,
    // Empty content splits to [''], which is a single empty entry rather than a
    // visible line, so it collapses to zero here just like a trailing newline.
    visibleLineCount:
      normalized.length === 0
        ? 0
        : lines.at(-1) === ''
          ? lines.length - 1
          : lines.length,
    maxCapabilityLine: lines.length,
  }
}

export type ResolveLineRangeResult =
  | {
      ok: true
      startLine: number
      endLine: number
      /** Present only when endLine was reduced to maxCapabilityLine. */
      clampedFrom?: { startLine: number; endLine: number }
    }
  | {
      ok: false
      reason: 'inverted' | 'start_beyond_file'
      visibleLineCount: number
      maxCapabilityLine: number
    }

/**
 * Resolve a requested 1-indexed inclusive range against current content in
 * CAPABILITY space. endLine values above maxCapabilityLine are clamped (and
 * reported) rather than rejected; a startLine above maxCapabilityLine or an
 * inverted range still fails closed.
 */
export function resolveLineRange(params: {
  coordinates: LineCoordinates
  startLine: number
  endLine: number
}): ResolveLineRangeResult {
  const { coordinates, startLine, endLine } = params
  const { visibleLineCount, maxCapabilityLine } = coordinates
  if (endLine < startLine) {
    return {
      ok: false,
      reason: 'inverted',
      visibleLineCount,
      maxCapabilityLine,
    }
  }
  // A startLine below 1 is not a distinct recovery case: like a startLine past
  // the ceiling, there is no line it could address, and the fix is the same
  // fresh read of a range that exists.
  if (startLine < 1 || startLine > maxCapabilityLine) {
    return {
      ok: false,
      reason: 'start_beyond_file',
      visibleLineCount,
      maxCapabilityLine,
    }
  }
  if (endLine > maxCapabilityLine) {
    return {
      ok: true,
      startLine,
      endLine: maxCapabilityLine,
      clampedFrom: { startLine, endLine },
    }
  }
  return { ok: true, startLine, endLine }
}

/**
 * The exact bytes read_files hashes when it mints a capability for
 * startLine..endLine, so it is the only correct input to a freshness re-hash.
 * Hashing the whole file instead would disagree with any capability whose
 * range stops at the last visible line of newline-terminated content.
 */
export function getRangeSlice(
  coordinates: LineCoordinates,
  startLine: number,
  endLine: number,
): string {
  return coordinates.lines.slice(startLine - 1, endLine).join('\n')
}

/**
 * Hashing every same-length window of a file costs O(lines x windowLines)
 * bytes, so a long capability over a long file could otherwise stall an edit
 * preflight. Past this budget the scan is refused outright rather than run over
 * a prefix: an incomplete scan could observe one match, miss a second identical
 * span in the unscanned remainder, and then relocate an authorized edit onto
 * the wrong lines.
 */
export const MAX_REANCHOR_SCAN_LINE_PRODUCT = 2_000_000

export type ReanchorCapabilityRangeResult =
  | {
      ok: true
      startLine: number
      endLine: number
      /** Present only when the span moved; the signed line delta to apply. */
      shiftedBy?: number
    }
  | {
      ok: false
      reason: 'not_found' | 'ambiguous' | 'over_budget'
      /** Present only for 'ambiguous': how many identical spans were found. */
      matchCount?: number
    }

/**
 * Locate the span that still hashes to a capability's hash, tolerating lines
 * inserted or deleted ABOVE it. This widens WHERE an authorization applies
 * without widening WHAT it authorizes: only an exact hash match of the full
 * capability slice relocates it, and only when that match is unique in the
 * file, so a missing or duplicated span fails closed exactly like a plain
 * freshness re-hash. Windows are cut with `getRangeSlice` in capability line
 * space, the same rule read_files mints and verifies capabilities with.
 */
export function reanchorCapabilityRange(params: {
  coordinates: LineCoordinates
  startLine: number
  endLine: number
  expectedHash: string
}): ReanchorCapabilityRangeResult {
  const { coordinates, startLine, endLine, expectedHash } = params
  const windowLineCount = endLine - startLine + 1
  if (windowLineCount < 1) return { ok: false, reason: 'not_found' }
  if (
    startLine >= 1 &&
    endLine <= coordinates.maxCapabilityLine &&
    getContentHash(getRangeSlice(coordinates, startLine, endLine)) ===
      expectedHash
  ) {
    // Unchanged location: no delta is reported, so callers keep their bounds.
    return { ok: true, startLine, endLine }
  }
  // A window longer than the current file has nowhere left to sit; that is a
  // stale capability, not a scan error.
  const lastWindowStart = coordinates.lines.length - windowLineCount + 1
  if (lastWindowStart < 1) return { ok: false, reason: 'not_found' }
  if (
    coordinates.lines.length * windowLineCount >
    MAX_REANCHOR_SCAN_LINE_PRODUCT
  ) {
    return { ok: false, reason: 'over_budget' }
  }
  const matchStarts: number[] = []
  for (let candidate = 1; candidate <= lastWindowStart; candidate++) {
    const slice = getRangeSlice(
      coordinates,
      candidate,
      candidate + windowLineCount - 1,
    )
    if (getContentHash(slice) === expectedHash) matchStarts.push(candidate)
  }
  if (matchStarts.length === 0) return { ok: false, reason: 'not_found' }
  if (matchStarts.length > 1) {
    return { ok: false, reason: 'ambiguous', matchCount: matchStarts.length }
  }
  const matchStart = matchStarts[0]!
  return {
    ok: true,
    startLine: matchStart,
    endLine: matchStart + windowLineCount - 1,
    shiftedBy: matchStart - startLine,
  }
}

/**
 * Shared model-facing cause clause for a refused re-anchor, so the transaction
 * and standalone applicators name the same distinguishing reason.
 */
export function describeReanchorFailure(
  result: Extract<ReanchorCapabilityRangeResult, { ok: false }>,
): string {
  if (result.reason === 'ambiguous') {
    return `the observed content now appears at ${result.matchCount ?? 2} identical candidate spans, so the target is ambiguous`
  }
  if (result.reason === 'over_budget') {
    return 'the file is too large to search for the observed content'
  }
  return 'the observed content was not found anywhere in the file'
}

/**
 * Both ceilings describe a genuine whole-file observation: the visible form is
 * what a full-file range read reports, the capability form what a whole-file
 * paths read mints. Accepting only one of them would reject half of the
 * capabilities read_files legitimately issues, while a proper subset still
 * fails because it never covers the final line.
 */
export function isWholeFileCoveringRange(
  coordinates: LineCoordinates,
  startLine: number,
  endLine: number,
): boolean {
  return (
    startLine === 1 &&
    (endLine === coordinates.visibleLineCount ||
      endLine === coordinates.maxCapabilityLine)
  )
}

/**
 * Shared model-facing sentence describing the two ceilings, so every
 * diagnostic in the read/edit flow words it identically.
 */
export function describeLineBounds(coordinates: LineCoordinates): string {
  const visible = `the file has ${coordinates.visibleLineCount} visible line(s)`
  // With no trailing newline both ceilings coincide, and naming the second one
  // would only invite a phantom line number.
  if (coordinates.visibleLineCount === coordinates.maxCapabilityLine) {
    return visible
  }
  return `${visible}; a read capability may bind up to line ${coordinates.maxCapabilityLine} (the trailing entry a read reports past the final newline)`
}
