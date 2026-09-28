/**
 * D27: FTS5-backed recall over the compaction archive (index, not brute force).
 *
 * WHY AN INDEX: `recallFromArchive` (context-archive.ts) substring-scans every
 * archived tool message on every query. This module instead flattens the
 * archive into rows (`buildArchiveRecallRows`) and queries a SQLite FTS5
 * virtual table, so recall work is delegated to the index rather than repeated
 * full scans, and BM25 relevance ranking becomes available.
 *
 * WHY PER-CALL AND IN-MEMORY: the archive itself is in-memory per run on
 * `AgentState.compactionArchive`, bounded to 8 snapshots × 200 messages × 4k
 * chars (see context-archive.ts). An index over it needs no persistence: the
 * database is `:memory:` and built PER CALL — bounded, deterministic, and free
 * of cache-invalidation bugs (stale-index-vs-archive drift is impossible by
 * construction). No I/O beyond the in-memory db, no persistent on-disk store,
 * no new dependencies: FTS5 ships inside bun:sqlite.
 *
 * FAIL-OPEN SEMANTICS: if bun:sqlite is unavailable, the bundled SQLite build
 * lacks FTS5, the query cannot be expressed as safe FTS5 terms, the flattened
 * row set exceeds the build cap, or ANY index build/query step throws, the
 * call falls back to the existing
 * `recallFromArchive` scanner. Callers never see a thrown error from this
 * module; fallback results are byte-identical to the scanner's own.
 *
 * D27 EMPTY-VS-FAILED: an empty `matches` array with `indexState: 'indexed'`
 * means the index is healthy and genuinely nothing matched; `indexState:
 * 'fallback'` means the index could not be used and the results come from the
 * substring scanner. `indexError` is present only on fallback, bounded to
 * 300 chars with no stack (repo error-envelope convention).
 *
 * ORDERING CONTRACT (decided): matches are ordered newest-snapshot-first,
 * exactly like the `recallFromArchive` scanner — `ORDER BY row_index DESC`
 * (rows are inserted in archive array order, so descending row_index yields
 * the newest snapshot first and later messages within a snapshot first).
 * BM25 relevance ranking is available via the fts5 rank/bm25() column, but
 * recency-first ordering is kept to match the existing scanner contract;
 * exposing bm25 ordering is a follow-up for when a consumer needs it.
 */

import {
  RECALL_MAX_RESULTS,
  RECALL_SNIPPET_CHARS,
  recallFromArchive,
  stepProvenance,
} from './context-archive'

import type {
  ContextArchiveSnapshot,
  RecallContextResult,
} from './context-archive'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

/** One flattened archive tool message, in archive array order. */
export type ArchiveRecallRow = {
  archivedAt: number
  step: number
  toolName: string
  toolCallId: string
  text: string
}

/**
 * Defensive build cap: refuse to construct the FTS index over a flattened row
 * set whose total text exceeds this many characters and fall back instead.
 * The persisted archive contract (8×200×4k ≈ 6.4 MB) stays well under this, so
 * it only trips when a caller bypasses the archive caps.
 */
const MAX_INDEX_TEXT_CHARS = 16_000_000

/**
 * Serial form of an archived tool message's body — the exact text the
 * `recallFromArchive` scanner matches against, so snippets stay byte-identical
 * between the indexed and fallback paths. Mirrors the scanner's private
 * `toText` (json parts stringified, media parts as '[media]').
 */
const toText = (message: Message): string => {
  if (message.role !== 'tool') return ''
  return message.content
    .map((part) =>
      part.type === 'json' ? JSON.stringify(part.value) : '[media]',
    )
    .join(' ')
}

/**
 * Flatten every snapshot's tool messages (any `action`, eviction snapshots
 * included) to recall rows, in archive array order (this order IS the FTS
 * `row_index`). Step provenance reuses the SAME logic as `stepProvenance` in
 * context-archive.ts (D26 `steps` arrays for eviction snapshots, `stepBase`
 * slice-local numbering otherwise) — reused, not duplicated.
 */
export const buildArchiveRecallRows = (
  archive: ContextArchiveSnapshot[] | undefined,
): ArchiveRecallRow[] => {
  if (!archive || archive.length === 0) return []
  const rows: ArchiveRecallRow[] = []
  for (const snapshot of archive) {
    for (let i = 0; i < snapshot.messages.length; i++) {
      const message = snapshot.messages[i]
      if (message.role !== 'tool') continue
      rows.push({
        archivedAt: snapshot.archivedAt,
        step: stepProvenance(snapshot, i),
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        text: toText(message),
      })
    }
  }
  return rows
}

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
const FTS5_OPERATOR_CHARS = /[(){}\[\]^*:+]/g

/** A character FTS5's unicode61 tokenizer will keep as (part of) a token. */
const HAS_TOKEN_CHAR = /[\p{L}\p{N}]/u

/**
 * Sanitize a user query into safe FTS5 MATCH terms, or `null` when the query
 * cannot be expressed safely (any term with no token character — quoting it
 * would yield a zero-token phrase). Split on whitespace like the scanner,
 * replace operator characters with spaces, and wrap each word in double
 * quotes with internal double quotes doubled — so `AND`, `OR`, `NOT`, `NEAR`,
 * parentheses and unbalanced quotes are literal strings, never operators, and
 * no syntax error is possible. Joined with spaces this gives implicit AND —
 * the scanner's ALL-terms semantics. E.g. `he said "hello" (AND)` →
 * `"he" "said" """hello""" "AND"`.
 */
const sanitizeFtsQuery = (query: string): string[] | null => {
  const terms: string[] = []
  for (const word of query
    .toLowerCase()
    .replace(FTS5_OPERATOR_CHARS, ' ')
    .split(/\s+/)) {
    if (word.length === 0) continue
    if (!HAS_TOKEN_CHAR.test(word)) return null
    terms.push(`"${word.replace(/"/g, '""')}"`)
  }
  return terms.length > 0 ? terms : null
}

/**
 * Narrow structural subset of the bun:sqlite `Database` API this module uses,
 * so packages whose tsconfig lacks bun-types still typecheck; the dynamic
 * import result is narrowed to this shape before use.
 */
type SqliteDb = {
  run: (sql: string, ...params: unknown[]) => unknown
  query: (sql: string) => { all: (...params: unknown[]) => unknown[] }
  close: () => void
}

type BunSqliteModule = {
  Database: new (path: string) => SqliteDb
}

/** Row shape returned by the FTS5 SELECT (snake_case SQLite columns). */
type RecallRow = {
  row_index: number
  step: number
  tool_name: string
  tool_call_id: string
  archived_at: number
  text: string
}

/**
 * Open the per-call in-memory database. `opts.createDatabase` is the
 * sanctioned test/CI seam for forcing index failures deterministically
 * without depending on the host runtime's bundled SQLite build.
 */
const openInMemoryDb = async (opts?: {
  createDatabase?: (path: string) => unknown
}): Promise<SqliteDb> => {
  if (opts?.createDatabase) {
    return opts.createDatabase(':memory:') as SqliteDb
  }
  // Narrowed structurally to `SqliteDb` above. The `bun:sqlite` specifier is
  // unresolvable in tsconfigs without bun-types (e.g. the SDK declaration
  // build's tsconfig.build.json uses `types: ["node"]` and transitively
  // typechecks this file), so suppress the module-resolution error there; the
  // cast supplies the type and the fail-open path handles a missing module at
  // runtime.
  // @ts-ignore -- bun:sqlite has no type declarations without bun-types
  const { Database } = (await import('bun:sqlite')) as unknown as BunSqliteModule
  return new Database(':memory:')
}

export type ArchiveRecallIndexedResult = RecallContextResult & {
  /** 'indexed': the FTS5 path ran; 'fallback': scanner result, index unusable. */
  indexState: 'indexed' | 'fallback'
  /** Present only on fallback: bounded (≤300 chars) reason, no stack. */
  indexError?: string
}

/**
 * D27: the empty-result guidance message, with the fallback note appended
 * ONLY when the index fell back — so an empty result from a failed index is
 * distinguishable from one from a healthy index even in the message text.
 * The note is a fixed bounded string: raw `indexError` text is never
 * interpolated into model-visible output (error-envelope convention).
 */
export const recallEmptyResultMessage = (
  result: Pick<ArchiveRecallIndexedResult, 'indexState'>,
): string =>
  'No archived pre-compaction content matched. Archived transcripts exist only after a compaction pass rewrote history; verify facts against live files with read_files instead.' +
  (result.indexState === 'fallback'
    ? ' (archive index unavailable, fell back to substring scan)'
    : '')

/**
 * Recall from the compaction archive via a per-call in-memory FTS5 index,
 * failing open to `recallFromArchive` on any index problem. See the module
 * docblock for the full rationale and the D27 empty-vs-failed contract.
 */
export async function recallFromArchiveIndexed(
  archive: ContextArchiveSnapshot[] | undefined,
  query: string,
  opts?: { createDatabase?: (path: string) => unknown },
): Promise<ArchiveRecallIndexedResult> {
  const boundedError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error)
    return message.length <= 300 ? message : message.slice(0, 300)
  }
  const fallback = (indexError: string): ArchiveRecallIndexedResult => ({
    ...recallFromArchive(archive, query),
    indexState: 'fallback' as const,
    indexError,
  })

  // Degenerate inputs mirror the scanner exactly — and the index is healthy
  // (D27: NOT a failed index) for a missing/empty archive or a blank query.
  if (!archive || archive.length === 0) {
    return { ...recallFromArchive(archive, query), indexState: 'indexed' }
  }
  // Raw lowercased terms anchor snippets identically to the scanner; the
  // sanitized terms drive the MATCH query.
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (terms.length === 0) {
    return { ...recallFromArchive(archive, query), indexState: 'indexed' }
  }
  const sanitized = sanitizeFtsQuery(query)
  if (sanitized === null) {
    // A term with no token characters (e.g. `--`) cannot be expressed as a
    // safe FTS5 phrase; instead of returning a divergent empty result, fall
    // back so matching behavior stays identical to the scanner.
    return fallback(
      'archive recall index: query has no FTS5-expressible terms; fell back to substring scan',
    )
  }
  const rows = buildArchiveRecallRows(archive)
  const totalTextChars = rows.reduce((sum, row) => sum + row.text.length, 0)
  if (totalTextChars > MAX_INDEX_TEXT_CHARS) {
    return fallback(
      `archive recall index too large: ${totalTextChars} chars of archived text exceeds the ${MAX_INDEX_TEXT_CHARS}-char build cap`,
    )
  }
  const newestFirstArchivedAt = [...archive].reverse().map((s) => s.archivedAt)

  try {
    const db = await openInMemoryDb(opts)
    try {
      db.run(
        'CREATE VIRTUAL TABLE IF NOT EXISTS recall USING fts5(text, step UNINDEXED, tool_name UNINDEXED, tool_call_id UNINDEXED, archived_at UNINDEXED, row_index UNINDEXED)',
      )
      const insert =
        'INSERT INTO recall (text, step, tool_name, tool_call_id, archived_at, row_index) VALUES (?, ?, ?, ?, ?, ?)'
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        db.run(
          insert,
          row.text,
          row.step,
          row.toolName,
          row.toolCallId,
          row.archivedAt,
          i,
        )
      }
      const found = db
        .query(
          'SELECT row_index, step, tool_name, tool_call_id, archived_at, text FROM recall WHERE recall MATCH ? ORDER BY row_index DESC LIMIT ?',
        )
        .all(sanitized.join(' '), RECALL_MAX_RESULTS) as RecallRow[]
      const matches = found.map((row) => {
        // Same snippet semantics as the scanner: slice around the first term
        // occurrence so match shapes stay byte-identical to recallFromArchive.
        const lowered = row.text.toLowerCase()
        const first = Math.min(...terms.map((t) => lowered.indexOf(t)))
        const start = Math.max(0, first - 120)
        return {
          step: row.step,
          toolName: row.tool_name,
          toolCallId: row.tool_call_id,
          snippet: row.text.slice(start, start + RECALL_SNIPPET_CHARS),
        }
      })
      return {
        matches,
        snapshotsSearched: archive.length,
        archivedAt: newestFirstArchivedAt,
        indexState: 'indexed',
      }
    } finally {
      db.close()
    }
  } catch (error) {
    return fallback(boundedError(error))
  }
}
