/**
 * Single source of truth for "what does an observed read block authorize".
 *
 * Every read surface (read_files paths/ranges, read_blocks windows/around/
 * symbol slices) funnels its observed coverage through
 * `classifyReadBlockAuthority` instead of hand-rolling its own
 * `startLine === 1 && endLine === totalLines` check.
 *
 * A `'whole_file'` verdict is what later lets write_file overwrite an entire
 * file, so it requires ALL of:
 *  - a COMPLETE block (never truncated/partial),
 *  - capability eligibility (heuristic, non-parser-proven symbol slices are
 *    excluded),
 *  - real undecorated `sourceContent` (numbered display content is never
 *    accepted),
 *  - coverage of exactly 1..totalLines of a non-empty file.
 *
 * The ladder is pure: it never mutates state and never calls
 * `grantWholeFileReadAuthorization`. Callers act on the verdict.
 */

export type ReadBlockAuthority = 'whole_file' | 'scoped' | 'none'

export type ReadBlockCoverage = {
  complete: boolean
  startLine: number
  endLine: number
  totalLines: number
  /** Exact undecorated normalized text. Numbered display content is NOT accepted. */
  sourceContent: string | undefined
  /** False for heuristic (non-parser-proven) symbol slices. */
  capabilityEligible?: boolean
}

export function classifyReadBlockAuthority(
  c: ReadBlockCoverage,
): ReadBlockAuthority {
  if (!c.complete) return 'none'
  if (c.capabilityEligible === false) return 'none'
  if (c.sourceContent === undefined) return 'none'
  if (c.startLine === 1 && c.endLine === c.totalLines && c.totalLines > 0) {
    return 'whole_file'
  }
  return 'scoped'
}
