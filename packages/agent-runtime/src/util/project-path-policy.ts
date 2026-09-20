/**
 * Shared conservative project-relative path policy, used by the eviction
 * module's importance-derived protection set and the compaction verifier's
 * expected-fact derivation. A single declaration keeps the two path checks
 * from drifting: no absolute forms, no traversal segments, no glob syntax,
 * bounded length. A candidate that merely looks path-like (contains a
 * separator or an extension) is accepted; false positives only PROTECT or
 * report more, which is the safe direction. False negatives degrade to the
 * previous recency-only eviction / weaker-verification behavior.
 */
export const looksLikeProjectPath = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 1024) return false
  if (trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)) return false
  if (/[?*{[\]}]/.test(trimmed)) return false
  if (trimmed.split('/').includes('..')) return false
  return trimmed.includes('/') || trimmed.includes('.')
}
