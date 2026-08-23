/**
 * FNV-1a (32-bit) rendered as zero-padded lowercase hex.
 *
 * Single canonical copy of this algorithm. It was previously duplicated in:
 * - packages/agent-runtime/src/util/task-memory.ts (commitTaskMemory checksums)
 * - sdk/src/services/task-memory-store.ts (persisted task-memory checksums)
 * - sdk/src/run.ts (git_status observation fingerprints)
 *
 * Output must remain byte-compatible across every caller; the canonical
 * vectors ('' -> '811c9dc5', 'a' -> 'e40c292c', padded 8-hex) are pinned in
 * sdk/src/__tests__/task-memory-store.test.ts. Do not fork this algorithm;
 * import it instead.
 */
export function stableHash(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
