export const DECISION_RATIONALE_MARKERS = [
  'because',
  'so that',
  'instead of',
  'to avoid',
  'rather than',
  'chose',
  'rejected',
  'trade',
  'prefer',
  'must',
  'require',
] as const

export const DECISION_RATIONALE_MIN_LENGTH = 24

/** True when text is a genuine decision/constraint rationale: trimmed length >= 24 AND contains >=1 rationale marker (case-insensitive, bounded scan of first 2048 chars). */
export function hasDecisionRationale(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < DECISION_RATIONALE_MIN_LENGTH) return false
  const haystack = trimmed.slice(0, 2048).toLowerCase()
  return DECISION_RATIONALE_MARKERS.some((marker) => haystack.includes(marker))
}
