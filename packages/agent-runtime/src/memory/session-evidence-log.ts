/**
 * Deterministic playbook-gate evidence ledger (Phase 1).
 *
 * An in-memory, per-session record of tool invocations that SUCCEEDED, kept so
 * the playbook gate can answer "did a matching tool call already succeed
 * recently?" without any model call, filesystem read, or prose parsing. The
 * ledger is append-only, bounded, and holds nothing beyond an optional command
 * string, so it can ride on agent state without meaningfully growing a
 * serialized session.
 */
export type SessionEvidenceEntry = {
  toolName: string
  commandText?: string
  atMs: number
}

/** Hard cap: only the most-recent entries are ever retained. */
export const SESSION_EVIDENCE_LOG_MAX_ENTRIES = 200

export const createSessionEvidenceLog = () => ({
  entries: [] as SessionEvidenceEntry[],
})

export type SessionEvidenceLog = ReturnType<typeof createSessionEvidenceLog>

/**
 * Append one successful tool invocation, dropping the oldest entries once the
 * cap is exceeded. Mutates in place (splice, not reassignment) so the ledger
 * identity stays stable for the whole session — agent state may hold the same
 * object across steps.
 */
export const recordSessionEvidence = (
  log: SessionEvidenceLog,
  entry: SessionEvidenceEntry,
): void => {
  log.entries.push(entry)
  const overflow = log.entries.length - SESSION_EVIDENCE_LOG_MAX_ENTRIES
  if (overflow > 0) {
    log.entries.splice(0, overflow)
  }
}

/**
 * Playbook command patterns are literal substrings wrapped in `*` wildcards
 * (`*check:ci-local*`). Trim the surrounding wildcard runs so only the literal
 * needle survives — a wildcard inside the needle is never a regex operator, so
 * no regex is ever compiled from a playbook-supplied pattern.
 */
const stripSurroundingWildcards = (pattern: string): string =>
  pattern.trim().replace(/^\*+/, '').replace(/\*+$/, '')

export type SessionEvidenceQuery = {
  tool: string
  commandPattern?: string
  withinMs?: number
  nowMs: number
}

/**
 * True when SOME recorded entry satisfies the query. All comparisons are
 * deterministic and cheap:
 *  - `toolName` must match exactly;
 *  - the command pattern (when present) is a case-insensitive LITERAL substring
 *    test against the recorded command text; a pattern made only of wildcards
 *    constrains nothing;
 *  - `withinMs` (when present) requires the entry to be at most that old, so a
 *    stale success never satisfies a freshness-bound requirement.
 */
export const sessionEvidenceMatches = (
  log: SessionEvidenceLog,
  query: SessionEvidenceQuery,
): boolean => {
  const needle = query.commandPattern
    ? stripSurroundingWildcards(query.commandPattern).toLowerCase()
    : ''
  return log.entries.some(
    (entry) =>
      entry.toolName === query.tool &&
      (needle.length === 0 ||
        (typeof entry.commandText === 'string' &&
          entry.commandText.toLowerCase().includes(needle))) &&
      (query.withinMs === undefined ||
        query.nowMs - entry.atMs <= query.withinMs),
  )
}
