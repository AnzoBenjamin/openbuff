/**
 * Shared djb2 string hash helper.
 *
 * Produces a stable short base-36 string for React keys and dedup suffixes.
 * Extracted here so prompt-history-search-screen and index-status-box do not
 * duplicate the same logic.
 *
 * Implementation iterates over UTF-16 code units via `charCodeAt` (not
 * `codePointAt`) — surrogate pairs (e.g. emoji) therefore contribute as two
 * separate steps. This is intentional parity with the previous inline
 * implementations; switching to code-point iteration would change existing
 * keys/dedup suffixes. If cross-runtime Unicode stability beyond UTF-16 is
 * required, switch to `codePointAt` iteration and re-key persisted state.
 *
 * Deterministic examples (UTF-16 / djb2 ^ variant):
 *  - hashString('') === '45h' // 5381 >>> 0 base36
 *  - hashString('hello') is stable across calls (ascii)
 *  - hashString('😀') hashes as two UTF-16 units (D83D + DE00) and is stable
 */
export const hashString = (value: string): string => {
  let hash = 5381
  for (let i = 0; i < value.length; i++)
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i)
  return (hash >>> 0).toString(36)
}
