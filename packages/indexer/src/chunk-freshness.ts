import type { ChunkSidecar, ChunkSidecarEntry, MetadataIndex } from './types'

/** Maximum stable id length accepted from untrusted index data. */
const MAX_STABLE_ID_LENGTH = 128
const MAX_QUALIFIED_LENGTH = 512
const MAX_PATH_LENGTH = 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeStableId(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined
  const trimmed = candidate.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_STABLE_ID_LENGTH) return undefined
  // Stable ids are opaque but bounded to printable non-control characters so
  // a corrupt cache entry cannot inject control bytes into consumers.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined
  return trimmed
}

/**
 * Pure, deterministic sidecar record builder.
 *
 * Derives Record<stableChunkId, entry> from an in-memory index. Sorted keys,
 * bounded (cap 100/file already enforced upstream; re-applied defensively),
 * skips chunks without a valid stableChunkId. Never throws — returns {} on
 * invalid input.
 */
export function buildChunkSidecar(
  index: MetadataIndex,
): Record<string, ChunkSidecarEntry> {
  try {
    if (!isRecord(index) || !isRecord((index as MetadataIndex).files)) return {}
    const files = (index as MetadataIndex).files
    const out: Record<string, ChunkSidecarEntry> = {}
    for (const filePath of Object.keys(files).sort()) {
      const file = files[filePath]
      if (!file || file.path !== filePath) continue
      const chunks = Array.isArray(file.chunks) ? file.chunks.slice(0, 100) : []
      for (const chunk of chunks) {
        if (!isRecord(chunk as unknown as Record<string, unknown>)) continue
        const stableId = normalizeStableId(
          (chunk as { stableChunkId?: unknown }).stableChunkId,
        )
        if (!stableId) continue
        if (out[stableId] !== undefined) continue
        const qualifiedName =
          typeof chunk.qualifiedName === 'string' &&
          chunk.qualifiedName.length > 0
            ? chunk.qualifiedName.slice(0, MAX_QUALIFIED_LENGTH)
            : `${filePath}:${chunk.startLine ?? 0}-${chunk.endLine ?? 0}`.slice(
                0,
                MAX_QUALIFIED_LENGTH,
              )
        const startLine =
          typeof chunk.startLine === 'number' &&
          Number.isInteger(chunk.startLine) &&
          chunk.startLine >= 1
            ? chunk.startLine
            : 0
        const endLine =
          typeof chunk.endLine === 'number' &&
          Number.isInteger(chunk.endLine) &&
          chunk.endLine >= startLine
            ? chunk.endLine
            : startLine
        if (startLine === 0) continue
        const kind =
          typeof chunk.kind === 'string' ? chunk.kind.slice(0, 128) : 'unknown'
        const contentHash =
          typeof chunk.hash === 'string' ? chunk.hash.slice(0, 256) : ''
        if (!contentHash) continue
        out[stableId] = {
          file: filePath.slice(0, MAX_PATH_LENGTH),
          startLine,
          endLine,
          qualifiedName,
          kind,
          contentHash,
        }
      }
    }
    const sorted: Record<string, ChunkSidecarEntry> = {}
    for (const key of Object.keys(out).sort()) sorted[key] = out[key]!
    return sorted
  } catch {
    return {}
  }
}

/**
 * Pure bounded lookup of a single sidecar entry. Returns undefined for
 * missing/invalid inputs instead of throwing.
 */
export function resolveChunkEntry(
  sidecar: ChunkSidecar | Record<string, ChunkSidecarEntry> | null | undefined,
  stableChunkId: unknown,
): ChunkSidecarEntry | undefined {
  try {
    const id = normalizeStableId(stableChunkId)
    if (!id) return undefined
    if (!isRecord(sidecar)) return undefined
    const record = (sidecar as unknown as ChunkSidecar).chunks !== undefined
      ? (sidecar as unknown as ChunkSidecar).chunks
      : (sidecar as unknown as Record<string, ChunkSidecarEntry>)
    if (!isRecord(record)) return undefined
    const entry = (record as Record<string, unknown>)[id]
    if (!isRecord(entry)) return undefined
    if (
      typeof entry.file !== 'string' ||
      typeof entry.startLine !== 'number' ||
      typeof entry.endLine !== 'number' ||
      typeof entry.qualifiedName !== 'string' ||
      typeof entry.kind !== 'string' ||
      typeof entry.contentHash !== 'string'
    ) {
      return undefined
    }
    return entry as unknown as ChunkSidecarEntry
  } catch {
    return undefined
  }
}

export type ChunkFreshnessState = 'FRESH' | 'STALE' | 'ORPHAN' | 'SNAPSHOT-OLD'

export interface ChunkFreshnessSelector {
  stableChunkId?: unknown
  path: unknown
  contentHash?: unknown
  qualifiedName?: unknown
}

export interface ChunkFreshnessResult {
  state: ChunkFreshnessState
  reason: string
}

function inlineChunkHash(
  index: MetadataIndex,
  filePath: string,
  stableId: string,
): { hash?: string; qualifiedName?: string } {
  try {
    const file = index?.files?.[filePath]
    if (!file || !Array.isArray(file.chunks)) return {}
    for (const chunk of file.chunks.slice(0, 100)) {
      if ((chunk as { stableChunkId?: string }).stableChunkId === stableId) {
        return { hash: chunk.hash, qualifiedName: chunk.qualifiedName }
      }
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * Pure freshness predicate. No I/O, bounded, never throws (fail-closed to
 * STALE/ORPHAN).
 *
 * - FRESH: stableChunkId exists AND current chunk hash == recorded hash.
 * - STALE: exists but hash differs or qualifiedName moved.
 * - ORPHAN: stableChunkId missing/file deleted.
 * - SNAPSHOT-OLD: snapshotId differs but hashes match.
 */
export function evaluateChunkFreshness(
  selector: ChunkFreshnessSelector | null | undefined,
  index: MetadataIndex | null | undefined,
  sidecar: ChunkSidecar | Record<string, ChunkSidecarEntry> | null | undefined,
  currentSnapshotId: unknown,
): ChunkFreshnessResult {
  try {
    const stableId = normalizeStableId(selector?.stableChunkId)
    if (!stableId) {
      return { state: 'ORPHAN', reason: 'missing-stable-chunk-id' }
    }
    const entry = resolveChunkEntry(sidecar, stableId)
    if (!entry) {
      // Best-effort inline fallback for old caches without a sidecar: if the
      // live index still carries the chunk, a hash comparison can still prove
      // STALE; otherwise the id is unknown.
      if (
        index &&
        typeof selector?.path === 'string' &&
        typeof selector?.contentHash === 'string'
      ) {
        const inline = inlineChunkHash(index, selector.path, stableId)
        if (inline.hash !== undefined && inline.hash !== selector.contentHash) {
          return { state: 'STALE', reason: 'inline-hash-mismatch' }
        }
        if (inline.hash !== undefined && inline.hash === selector.contentHash) {
          // The live index proves the chunk exists and is unmodified; the
          // sidecar merely lags (its write is best-effort and can fail while
          // metadata.json commits). The documented FRESH definition is
          // "stableChunkId exists AND hash matches", so returning ORPHAN here
          // would discard live unmodified chunks whenever the sidecar write
          // failed. Reserve ORPHAN for 'not in sidecar AND not in live index'.
          return { state: 'FRESH', reason: 'inline-hash-match' }
        }
      }
      return { state: 'ORPHAN', reason: 'unknown-stable-chunk-id' }
    }
    // File deleted from the live index => orphan even though the sidecar
    // still records the chunk.
    if (!index || !isRecord(index.files) || index.files[entry.file] === undefined) {
      return { state: 'ORPHAN', reason: 'file-deleted' }
    }
    const selectorPath =
      typeof selector?.path === 'string' ? selector.path : undefined
    if (selectorPath !== undefined && selectorPath !== entry.file) {
      return { state: 'STALE', reason: 'file-moved' }
    }
    const selectorQualified =
      typeof selector?.qualifiedName === 'string'
        ? selector.qualifiedName.slice(0, MAX_QUALIFIED_LENGTH)
        : undefined
    if (
      selectorQualified !== undefined &&
      selectorQualified.length > 0 &&
      selectorQualified !== entry.qualifiedName
    ) {
      return { state: 'STALE', reason: 'qualified-name-moved' }
    }
    // Current hash: prefer the caller-supplied contentHash, fall back to the
    // live inline chunk hash for the same stable id.
    let currentHash: string | undefined
    if (
      typeof selector?.contentHash === 'string' &&
      selector.contentHash.length > 0
    ) {
      currentHash = selector.contentHash.slice(0, 256)
    } else {
      currentHash = inlineChunkHash(index, entry.file, stableId).hash
    }
    if (currentHash === undefined) {
      return { state: 'STALE', reason: 'missing-current-hash' }
    }
    if (currentHash !== entry.contentHash) {
      return { state: 'STALE', reason: 'hash-mismatch' }
    }
    const sidecarSnapshot =
      isRecord(sidecar) &&
      typeof (sidecar as unknown as ChunkSidecar).snapshotId === 'string'
        ? (sidecar as unknown as ChunkSidecar).snapshotId
        : undefined
    if (
      typeof currentSnapshotId === 'string' &&
      currentSnapshotId.length > 0 &&
      sidecarSnapshot !== undefined &&
      currentSnapshotId !== sidecarSnapshot
    ) {
      return { state: 'SNAPSHOT-OLD', reason: 'snapshot-id-mismatch' }
    }
    return { state: 'FRESH', reason: 'hash-match' }
  } catch {
    return { state: 'STALE', reason: 'evaluation-error' }
  }
}
