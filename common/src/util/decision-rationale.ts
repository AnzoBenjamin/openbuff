/**
 * Tier 1D: markers now require actual reasoning structure (causal or
 * comparative) instead of accepting bare imperative keywords. The previous
 * lexicon included 'must'/'require'/'prefer', which match ordinary
 * instructions and made the decision-quality gate nearly a no-op.
 */
export const DECISION_RATIONALE_MARKERS = [
  'because',
  'since',
  'so that',
  'in order to',
  'to avoid',
  'rather than',
  'instead of',
  'chosen over',
  'due to',
  'allows',
  'enables',
  'prevents',
  'rejected',
] as const

export const DECISION_RATIONALE_MIN_LENGTH = 24

/** True when text is a genuine decision/constraint rationale: trimmed length >= 24 AND contains >=1 rationale marker (case-insensitive, bounded scan of first 2048 chars). */
export function hasDecisionRationale(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < DECISION_RATIONALE_MIN_LENGTH) return false
  const haystack = trimmed.slice(0, 2048).toLowerCase()
  return DECISION_RATIONALE_MARKERS.some((marker) => haystack.includes(marker))
}
