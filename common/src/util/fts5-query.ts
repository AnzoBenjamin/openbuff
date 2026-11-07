/**
 * Shared FTS5 query sanitizer for archive recall.
 *
 * Hoisted verbatim from
 * packages/agent-runtime/src/util/archive-recall-index.ts (D27) so that both
 * the runtime's per-call in-memory index and the cli memory store's durable
 * `context_archive_fts` table sanitize MATCH queries with the SAME logic: a
 * query that is safe for one is safe for the other, and the sanitization
 * semantics of the in-memory and persisted recall paths can never drift.
 */

/**
 * FTS5 query-syntax operator characters. Replaced with spaces (not stripped)
 * so each resulting word becomes its own quoted term: `a:b` must stay
 * findable the way the scanner finds the substring `a:b`, and FTS5 tokenizes
 * `a:b` in archived text as the adjacent tokens `a`,`b` — hit by the ANDed
 * terms `a` and `b`, but NOT by the fused token `ab`. Hyphens are NOT FTS5
 * operators and are kept, so a quoted `keystone-fact-3` stays one adjacency
 * phrase matching hyphenated text exactly. Double quotes are handled by
 * doubling (below), not by this class.
 */
export const FTS5_OPERATOR_CHARS = /[(){}\[\]^*:+]/g

/** A character FTS5's unicode61 tokenizer will keep as (part of) a token. */
export const HAS_TOKEN_CHAR = /[\p{L}\p{N}]/u

/**
 * Sanitize a user query into safe FTS5 MATCH terms, or `null` when NO term
 * can be expressed safely (a term with no token character — quoting it would
 * yield a zero-token phrase). Terms without a token character are DROPPED
 * rather than failing the whole query: a single `--`-style term must not
 * disable the FTS path for the remaining valid terms. Split on whitespace
 * like the scanner, replace operator characters with spaces, and wrap each
 * word in double quotes with internal double quotes doubled — so `AND`,
 * `OR`, `NOT`, `NEAR`, parentheses and unbalanced quotes are literal
 * strings, never operators, and no syntax error is possible. Joined with
 * spaces this gives implicit AND — the scanner's ALL-terms semantics. E.g.
 * `he said "hello" (AND)` → `"he" "said" """hello""" "AND"`.
 */
export const sanitizeFtsQuery = (query: string): string[] | null => {
  const terms: string[] = []
  for (const word of query
    .toLowerCase()
    .replace(FTS5_OPERATOR_CHARS, ' ')
    .split(/\s+/)) {
    if (word.length === 0) continue
    // A token-less word cannot be quoted into an FTS5 phrase: drop it and
    // keep the remaining expressible terms (never disable the whole query).
    if (!HAS_TOKEN_CHAR.test(word)) continue
    terms.push(`"${word.replace(/"/g, '""')}"`)
  }
  return terms.length > 0 ? terms : null
}
