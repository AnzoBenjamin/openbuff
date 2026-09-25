import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { FileVector } from './semantic'
import type { ChunkSidecar, MetadataIndex } from './types'
import { buildIndexQueryData } from './query-data'
import { buildChunkSidecar } from './chunk-freshness'

const INDEX_FILE = 'metadata.json'
export const CHUNKS_FILE = 'chunks.json'
export const CHUNK_SIDECAR_VERSION = 1 as const
const INDEX_VERSION = '2'
const SEMANTIC_VECTOR_FILE = 'semantic-vectors.json'
const SEMANTIC_VECTOR_VERSION = '3'
const LEGACY_SEMANTIC_VECTOR_VERSIONS = new Set(['1', '2'])
const MAX_SEMANTIC_FINGERPRINTS = 4
/**
 * Union-merge retention bound (reliability finding
 * semantic-vector-union-merge-unbounded-growth): beyond the vectors for the
 * current index snapshot, at most this many carried-over embedding hashes
 * survive a save. Without a bound the per-fingerprint union-merge retained
 * every embeddingHash ever written, so the on-disk vector cache grew
 * monotonically with the project's cumulative edit history (vectors for
 * deleted files and superseded file revisions were never pruned).
 */
export const MAX_CARRIED_SEMANTIC_VECTORS = 1_024
export const MAX_INDEX_AGE_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_CACHE_DIR = '.codebuff-index'
const OWNER_FILE = '.openbuff-index-owner'
const LOCK_FILE = '.openbuff-index.lock'
const LOCK_TIMEOUT_MS = 10_000
const STALE_LOCK_MS = 5 * 60_000
/**
 * The lock holder touches the lock file's mtime at this interval so a
 * slow-but-live writer (large serialize + fsync) is never age-reclaimed
 * mid-operation. Must be well under STALE_LOCK_MS.
 */
const LOCK_HEARTBEAT_MS = 30_000

/**
 * P8.6b / M4-S6: whether saveIndex may side-effect-write `.git/info/exclude`.
 * Defaults OFF: mutating a user's git metadata as an unadvertised side effect
 * of indexing is opt-in, not opt-out. Callers that want the historical
 * behavior enable it via {@link setWriteGitExclude} — globally, or scoped to
 * one project root.
 */
let writeGitExcludeDefault = false
const writeGitExcludeByRoot = new Map<string, boolean>()

export function setWriteGitExclude(
  enabled: boolean,
  projectRoot?: string,
): void {
  if (projectRoot === undefined) {
    writeGitExcludeDefault = enabled
    return
  }
  writeGitExcludeByRoot.set(projectRoot, enabled)
}

/** Line already written this session, keyed by projectRoot + line. */
const writtenGitExcludeLines = new Set<string>()

export function sanitizeIndexCacheDir(cacheDir = DEFAULT_CACHE_DIR): string {
  const normalized = cacheDir
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')

  if (
    !normalized ||
    path.isAbsolute(cacheDir) ||
    path.posix.isAbsolute(normalized)
  ) {
    return DEFAULT_CACHE_DIR
  }

  const segments = normalized.split('/').filter(Boolean)
  if (
    segments.length !== 1 ||
    !segments[0].startsWith('.') ||
    segments[0] === '.git' ||
    segments.some(
      (segment) =>
        segment === '.' || segment === '..' || segment.includes('\0'),
    )
  ) {
    return DEFAULT_CACHE_DIR
  }

  return segments.join('/')
}

export function getIndexDir(
  projectRoot: string,
  cacheDir = DEFAULT_CACHE_DIR,
): string {
  return path.join(projectRoot, sanitizeIndexCacheDir(cacheDir))
}

export async function loadIndex(
  projectRoot: string,
  cacheDir = '.codebuff-index',
  options?: { expectedSnapshotId?: string },
): Promise<MetadataIndex | null> {
  const indexPath = path.join(getIndexDir(projectRoot, cacheDir), INDEX_FILE)
  try {
    const content = await fs.promises.readFile(indexPath, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return null
    }
    if (!isMetadataIndex(parsed, projectRoot)) return null
    // P8.2a: validate each IndexedFile entry at load. Malformed entries are
    // dropped here so callers treat them as rebuild-worthy rather than as
    // silently corrupt data feeding hash/ranking logic.
    sanitizeIndexedFiles(parsed)
    if (options?.expectedSnapshotId !== undefined) {
      const expected = options.expectedSnapshotId
      if (
        typeof expected !== 'string' ||
        expected.length === 0 ||
        expected.length > 256
      )
        return null
      let snapshotId: string
      try {
        snapshotId = computeIndexSnapshotId(parsed)
      } catch {
        return null
      }
      if (snapshotId !== expected) return null
    }
    // P8.2b: validate the persisted query accelerators at load. A
    // structurally corrupt queryData would otherwise poison postings/adjacency
    // for every query; rebuild it once here (degrade once at load, not per
    // query) instead of trusting corrupt data.
    if (
      !parsed.queryData ||
      !isValidQueryData(parsed.queryData, parsed.graph)
    ) {
      parsed.queryData = buildIndexQueryData(parsed.files, parsed.graph)
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return null
  }
}

export async function saveIndex(
  index: MetadataIndex,
  projectRoot: string,
  cacheDir = '.codebuff-index',
  options: { expectedBuiltAt?: number | null } = {},
): Promise<boolean> {
  const dir = getIndexDir(projectRoot, cacheDir)
  await assertCacheOwnership(dir)
  await ensureGitInfoExcludes(projectRoot, cacheDir)
  await fs.promises.mkdir(dir, { recursive: true })
  await writeOwnerFile(dir)
  const indexPath = path.join(dir, INDEX_FILE)
  return await withCacheLock(dir, async () => {
    const current = await readJsonFile(indexPath)
    const currentBuiltAt =
      isRecord(current) &&
      current.projectRoot === projectRoot &&
      typeof current.builtAt === 'number'
        ? current.builtAt
        : null
    if (
      Object.prototype.hasOwnProperty.call(options, 'expectedBuiltAt') &&
      currentBuiltAt !== options.expectedBuiltAt
    ) {
      return false
    }
    if (currentBuiltAt !== null && currentBuiltAt > index.builtAt) {
      // A newer inter-process build won the race. Do not replace it with an
      // older snapshot that began before the winning process.
      return false
    }
    await atomicWriteJson(indexPath, index)
    // Sidecar shares the same lock txn + CAS/newest-wins gate above so it
    // can never describe a snapshot that lost the race. Best-effort: a
    // sidecar write failure must not fail the metadata persist.
    try {
      await atomicWriteJson(
        path.join(dir, CHUNKS_FILE),
        buildChunkSidecarDocument(index),
      )
    } catch {
      // Best-effort only; metadata.json remains authoritative.
    }
    return true
  })
}

export interface CachedSemanticVector {
  embeddingHash: string
  vector: number[]
}

interface SemanticVectorCacheV3 {
  version: typeof SEMANTIC_VECTOR_VERSION
  projectRoot: string
  fingerprints: Record<
    string,
    {
      updatedAt: number
      vectors: Record<string, number[]>
    }
  >
}

/**
 * Load compatible vectors for one embedding configuration. Invalid, foreign,
 * or unknown cache schemas are treated as misses so lexical indexing remains
 * available and the next successful build can safely replace the cache.
 */
export async function loadSemanticVectors(
  projectRoot: string,
  fingerprint: string,
  cacheDir = DEFAULT_CACHE_DIR,
): Promise<CachedSemanticVector[]> {
  const cache = await readSemanticVectorCache(projectRoot, cacheDir)
  if (!cache) return []
  const entry = cache.fingerprints[fingerprint]
  if (!entry) return []
  return Object.entries(entry.vectors).map(([embeddingHash, vector]) => ({
    embeddingHash,
    vector,
  }))
}

/** Persist vectors atomically, retaining a small bounded set of model caches. */
export async function saveSemanticVectors(
  projectRoot: string,
  fingerprint: string,
  vectors: FileVector[],
  cacheDir = DEFAULT_CACHE_DIR,
  options: { expectedUpdatedAt?: number } = {},
): Promise<void> {
  const dir = getIndexDir(projectRoot, cacheDir)
  await assertCacheOwnership(dir)
  await ensureGitInfoExcludes(projectRoot, cacheDir)
  await fs.promises.mkdir(dir, { recursive: true })
  await writeOwnerFile(dir)

  const cachePath = path.join(dir, SEMANTIC_VECTOR_FILE)
  await withCacheLock(dir, async () => {
    const existing =
      (await readSemanticVectorCache(projectRoot, cacheDir)) ??
      emptySemanticVectorCache(projectRoot)
    const currentEntry = existing.fingerprints[fingerprint]
    // Generation CAS (mirrors saveIndex's expectedBuiltAt): when the caller
    // pins the fingerprint generation it observed, a parallel writer that
    // already advanced the generation wins and this stale write is dropped
    // instead of clobbering it.
    if (
      currentEntry &&
      options.expectedUpdatedAt !== undefined &&
      currentEntry.updatedAt !== options.expectedUpdatedAt
    ) {
      return
    }
    // Union-merge over the entry currently on disk so a writer that raced
    // the lock cannot erase vectors for embedding hashes it never observed.
    // Bounded merge: vectors for the current index always win, and only the
    // most recent MAX_CARRIED_SEMANTIC_VECTORS carried-over hashes survive,
    // so vectors for deleted files and superseded file revisions are pruned
    // as the index advances instead of accumulating forever (reliability
    // finding semantic-vector-union-merge-unbounded-growth).
    const savedHashes = new Set<string>()
    for (const entry of vectors) {
      if (entry.embeddingHash && isValidVector(entry.vector)) {
        savedHashes.add(entry.embeddingHash)
      }
    }
    // Carried-over vectors first, in their on-disk (insertion) order, so the
    // merged entry's key order stays stable across saves and callers that
    // inspect loadSemanticVectors see existing hashes before newly added
    // ones.
    const carried: Array<[string, number[]]> = []
    for (const [hash, vector] of Object.entries(currentEntry?.vectors ?? {})) {
      if (!savedHashes.has(hash)) carried.push([hash, vector])
    }
    const dropped = Math.max(0, carried.length - MAX_CARRIED_SEMANTIC_VECTORS)
    const byHash: Record<string, number[]> = {}
    for (let i = dropped; i < carried.length; i++) {
      byHash[carried[i]![0]] = carried[i]![1]
    }
    // The current write's vectors land last but still win: the loop above
    // only fills hashes the current write never observed.
    for (const entry of vectors) {
      if (entry.embeddingHash && isValidVector(entry.vector)) {
        byHash[entry.embeddingHash] = entry.vector
      }
    }
    existing.fingerprints[fingerprint] = {
      // Strictly advance the generation: when two writes land in the same
      // millisecond, a raw Date.now() would leave the generation unchanged
      // and the expectedUpdatedAt CAS could never detect the second writer
      // as stale. Bumping past the previous value keeps every successful
      // write observationally distinct for the CAS.
      updatedAt: Math.max(Date.now(), (currentEntry?.updatedAt ?? 0) + 1),
      vectors: byHash,
    }

    const retained = Object.entries(existing.fingerprints)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SEMANTIC_FINGERPRINTS)
    existing.fingerprints = Object.fromEntries(retained)
    await atomicWriteJson(cachePath, existing)
  })
}

async function assertCacheOwnership(dir: string): Promise<void> {
  try {
    const entries = await fs.promises.readdir(dir)
    const legacyOwned = entries.every(
      (entry) =>
        entry === INDEX_FILE ||
        entry === SEMANTIC_VECTOR_FILE ||
        entry === CHUNKS_FILE ||
        // The lock file a crashed holder left behind and the
        // `.release.*`/`.reclaim.*` scratch files a defensive release/reclaim
        // restore race can leak are OUR artifacts, not foreign content: a
        // legacy cache dir (no owner.json) must not be permanently bricked
        // with 'Refusing to use non-owned index cache directory' by one of
        // them (reliability finding
        // reclaim-scratch-leak-bricks-legacy-cache-dir).
        entry === LOCK_FILE ||
        entry.startsWith('.release.') ||
        entry.startsWith('.reclaim.'),
    )
    if (entries.length > 0 && !entries.includes(OWNER_FILE) && !legacyOwned) {
      throw new Error(`Refusing to use non-owned index cache directory: ${dir}`)
    }
    // Best-effort sweep of our old scratch artifacts (same finding): entries
    // older than the stale-lock bound cannot belong to a live operation.
    for (const entry of entries) {
      if (!entry.startsWith('.release.') && !entry.startsWith('.reclaim.')) {
        continue
      }
      const scratchPath = path.join(dir, entry)
      try {
        const stat = await fs.promises.stat(scratchPath)
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          await fs.promises.rm(scratchPath, { force: true })
        }
      } catch {
        // Vanished or unreadable: nothing to sweep.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function writeOwnerFile(dir: string): Promise<void> {
  await fs.promises
    .writeFile(path.join(dir, OWNER_FILE), 'openbuff-index\n', { flag: 'wx' })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
}

function emptySemanticVectorCache(projectRoot: string): SemanticVectorCacheV3 {
  return {
    version: SEMANTIC_VECTOR_VERSION,
    projectRoot,
    fingerprints: {},
  }
}

async function readSemanticVectorCache(
  projectRoot: string,
  cacheDir: string,
): Promise<SemanticVectorCacheV3 | null> {
  const cachePath = path.join(
    getIndexDir(projectRoot, cacheDir),
    SEMANTIC_VECTOR_FILE,
  )
  try {
    const parsed: unknown = JSON.parse(
      await fs.promises.readFile(cachePath, 'utf8'),
    )
    return normalizeSemanticVectorCache(parsed, projectRoot)
  } catch {
    return null
  }
}

function normalizeSemanticVectorCache(
  value: unknown,
  projectRoot: string,
): SemanticVectorCacheV3 | null {
  if (!isRecord(value) || value.projectRoot !== projectRoot) return null

  if (
    value.version === SEMANTIC_VECTOR_VERSION &&
    isRecord(value.fingerprints)
  ) {
    const fingerprints: SemanticVectorCacheV3['fingerprints'] = {}
    for (const [fingerprint, rawEntry] of Object.entries(value.fingerprints)) {
      if (!isRecord(rawEntry) || !isRecord(rawEntry.vectors)) continue
      const vectors = normalizeVectorRecord(rawEntry.vectors)
      fingerprints[fingerprint] = {
        updatedAt:
          typeof rawEntry.updatedAt === 'number' &&
          Number.isFinite(rawEntry.updatedAt)
            ? rawEntry.updatedAt
            : 0,
        vectors,
      }
    }
    return { version: SEMANTIC_VECTOR_VERSION, projectRoot, fingerprints }
  }

  // Older schemas were keyed by content hash even though the embedded text
  // included the path. Reusing them would be semantically stale after rename
  // or for duplicate-content files, so treat them as safe misses.
  if (
    typeof value.version === 'string' &&
    LEGACY_SEMANTIC_VECTOR_VERSIONS.has(value.version)
  )
    return null

  return null
}

function normalizeVectorRecord(
  value: Record<string, unknown>,
): Record<string, number[]> {
  const vectors: Record<string, number[]> = {}
  for (const [hash, vector] of Object.entries(value)) {
    if (hash.length > 0 && isValidVector(vector)) vectors[hash] = vector
  }
  return vectors
}

function isValidVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (component) =>
        typeof component === 'number' && Number.isFinite(component),
    )
  )
}

export function computeIndexSnapshotId(index: MetadataIndex): string {
  const hash = createHash('sha256').update(
    `${index.version}\0${index.projectRoot}\0${index.workspaceRevision ?? 'unknown'}\0`,
  )
  for (const filePath of Object.keys(index.files).sort()) {
    hash.update(filePath).update('\0').update(index.files[filePath]!.hash)
  }
  return hash.digest('hex')
}

const MAX_CHUNK_SIDECAR_ENTRIES = 200_000
const MAX_CHUNK_SIDECAR_BYTES = 8_000_000

/**
 * Pure derived sidecar document builder. Deterministic (sorted keys via
 * buildChunkSidecar), bounded, never throws — falls back to an empty chunk
 * map and an 'unknown' snapshot id on invalid input so saveIndex stays
 * fail-open for the sidecar while metadata.json remains authoritative.
 */
export function buildChunkSidecarDocument(index: MetadataIndex): ChunkSidecar {
  let snapshotId = 'unknown'
  try {
    snapshotId = computeIndexSnapshotId(index)
  } catch {
    snapshotId = 'unknown'
  }
  let chunks: ChunkSidecar['chunks'] = {}
  try {
    chunks = buildChunkSidecar(index)
  } catch {
    chunks = {}
  }
  return {
    version: CHUNK_SIDECAR_VERSION,
    snapshotId,
    ...(index?.workspaceRevision !== undefined
      ? { workspaceRevision: index.workspaceRevision }
      : {}),
    builtAt:
      typeof index?.builtAt === 'number' && Number.isFinite(index.builtAt)
        ? index.builtAt
        : Date.now(),
    projectRoot:
      typeof index?.projectRoot === 'string' ? index.projectRoot : '',
    chunks,
  }
}

function normalizeChunkSidecar(
  value: unknown,
  projectRoot: string,
): ChunkSidecar | null {
  if (!isRecord(value)) return null
  if (value.version !== CHUNK_SIDECAR_VERSION) return null
  if (value.projectRoot !== projectRoot) return null
  if (
    typeof value.snapshotId !== 'string' ||
    value.snapshotId.length === 0 ||
    value.snapshotId.length > 256
  ) {
    return null
  }
  if (typeof value.builtAt !== 'number' || !Number.isFinite(value.builtAt)) {
    return null
  }
  if (!isRecord(value.chunks)) return null
  const entries = Object.entries(value.chunks)
  if (entries.length > MAX_CHUNK_SIDECAR_ENTRIES) return null
  const chunks: ChunkSidecar['chunks'] = {}
  for (const [stableId, raw] of entries) {
    if (stableId.length === 0 || stableId.length > 128) continue
    if (!isRecord(raw)) continue
    if (
      typeof raw.file !== 'string' ||
      raw.file.length === 0 ||
      raw.file.length > 1024 ||
      typeof raw.startLine !== 'number' ||
      !Number.isInteger(raw.startLine) ||
      raw.startLine < 1 ||
      raw.startLine > 10_000_000 ||
      typeof raw.endLine !== 'number' ||
      !Number.isInteger(raw.endLine) ||
      raw.endLine < raw.startLine ||
      raw.endLine > 10_000_000 ||
      typeof raw.qualifiedName !== 'string' ||
      raw.qualifiedName.length === 0 ||
      raw.qualifiedName.length > 512 ||
      typeof raw.kind !== 'string' ||
      raw.kind.length === 0 ||
      raw.kind.length > 128 ||
      typeof raw.contentHash !== 'string' ||
      raw.contentHash.length === 0 ||
      raw.contentHash.length > 256
    ) {
      continue
    }
    chunks[stableId] = {
      file: raw.file,
      startLine: raw.startLine,
      endLine: raw.endLine,
      qualifiedName: raw.qualifiedName,
      kind: raw.kind,
      contentHash: raw.contentHash,
    }
  }
  const sorted: ChunkSidecar['chunks'] = {}
  for (const key of Object.keys(chunks).sort()) sorted[key] = chunks[key]!
  const revision = value.workspaceRevision
  return {
    version: CHUNK_SIDECAR_VERSION,
    snapshotId: value.snapshotId,
    ...(typeof revision === 'string' || typeof revision === 'number'
      ? { workspaceRevision: revision }
      : {}),
    builtAt: value.builtAt,
    projectRoot: value.projectRoot,
    chunks: sorted,
  }
}

/**
 * Best-effort sidecar load. Missing/invalid/foreign files return null and
 * never fail the metadata load; callers fall back to chunkId/inline chunks.
 * Bounded: refuses oversized payloads without parsing the full metadata.json.
 */
export async function loadChunkSidecar(
  projectRoot: string,
  cacheDir = DEFAULT_CACHE_DIR,
): Promise<ChunkSidecar | null> {
  const sidecarPath = path.join(getIndexDir(projectRoot, cacheDir), CHUNKS_FILE)
  try {
    const content = await fs.promises.readFile(sidecarPath, 'utf8')
    if (content.length > MAX_CHUNK_SIDECAR_BYTES) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return null
    }
    return normalizeChunkSidecar(parsed, projectRoot)
  } catch {
    return null
  }
}

/**
 * Persist a validated sidecar atomically under the cache lock.
 *
 * Signature note (compatibility): this function previously returned
 * `Promise<void>` and silently dropped invalid input; it now returns
 * `Promise<boolean>` so callers can distinguish a committed write from a
 * rejected one and fall back to chunkId/inline chunks instead of leaving
 * stale sidecar content under the shared lock while metadata.json advances.
 * A `Promise<boolean>` return is assignable wherever a `Promise<void>`
 * callback was expected, so `Promise<void>`-typed adapters keep compiling —
 * but consumers built against the previous `.d.ts` should re-baseline and
 * branch on the boolean instead of assuming every call committed.
 * Returns `true` when the validated sidecar was written; `false` when the
 * strict validator or the entry-count check rejected the input.
 */
export async function saveChunkSidecar(
  projectRoot: string,
  sidecar: ChunkSidecar,
  cacheDir = DEFAULT_CACHE_DIR,
): Promise<boolean> {
  const normalized = normalizeChunkSidecar(sidecar, projectRoot)
  if (!normalized) return false
  // Strict save validation: sanitization drops invalid entries, so a
  // caller-built sidecar whose entry count shrank contains data outside the
  // validator contract. Reject the write (leaving any prior sidecar intact)
  // instead of silently stripping entries under the shared lock.
  if (
    Object.keys(normalized.chunks).length !== Object.keys(sidecar.chunks).length
  ) {
    return false
  }
  const dir = getIndexDir(projectRoot, cacheDir)
  await assertCacheOwnership(dir)
  await ensureGitInfoExcludes(projectRoot, cacheDir)
  await fs.promises.mkdir(dir, { recursive: true })
  await writeOwnerFile(dir)
  const sidecarPath = path.join(dir, CHUNKS_FILE)
  await withCacheLock(dir, async () => {
    await atomicWriteJson(sidecarPath, normalized)
  })
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMetadataIndex(
  value: unknown,
  projectRoot: string,
): value is MetadataIndex {
  if (
    !isRecord(value) ||
    value.version !== INDEX_VERSION ||
    value.projectRoot !== projectRoot ||
    typeof value.builtAt !== 'number' ||
    !Number.isFinite(value.builtAt) ||
    !isRecord(value.files) ||
    !isRecord(value.graph)
  ) {
    return false
  }
  if (!isRecord(value.graph.nodes) || !Array.isArray(value.graph.edges)) {
    return false
  }
  value.fileCount = Object.keys(value.files).length
  return true
}

/**
 * P8.2a: drop IndexedFile entries whose persisted shape is malformed. A valid
 * entry needs string path/hash/ext plus symbols/imports/headings/concepts
 * arrays; older writers may have produced partial entries, and a missing-key
 * entry is rebuild-worthy, not silently corrupt. Mutates `index.files` (the
 * already-validated record) and recomputes `fileCount`.
 */
function sanitizeIndexedFiles(index: {
  files: Record<string, unknown>
  fileCount: number
}): void {
  const files = index.files
  for (const filePath of Object.keys(files)) {
    const entry = files[filePath]
    if (!isRecord(entry) || !isValidIndexedFileShape(entry)) {
      delete files[filePath]
    }
  }
  index.fileCount = Object.keys(files).length
}

function isValidIndexedFileShape(entry: Record<string, unknown>): boolean {
  const requiredStringKeys = ['path', 'hash', 'ext'] as const
  for (const key of requiredStringKeys) {
    if (typeof entry[key] !== 'string') return false
  }
  const requiredArrayKeys = [
    'symbols',
    'imports',
    'headings',
    'concepts',
  ] as const
  for (const key of requiredArrayKeys) {
    if (
      !Array.isArray(entry[key]) ||
      (entry[key] as unknown[]).some((item) => typeof item !== 'string')
    ) {
      return false
    }
  }
  return (
    typeof entry.mtime === 'number' &&
    Number.isFinite(entry.mtime) &&
    typeof entry.size === 'number' &&
    Number.isFinite(entry.size)
  )
}

/**
 * P8.2b: structural validation of the persisted {
 * queryData.IndexQueryData} accelerators. Postings values must be string
 * arrays naming paths; adjacency edge indexes must be numeric and within
 * range of graph.edges so indexing them cannot throw or yield undefined
 * edges downstream.
 */
function isValidQueryData(
  queryData: unknown,
  graph: { edges?: unknown[] } | undefined,
): boolean {
  if (!isRecord(queryData) || !isRecord(queryData.postings)) return false
  if (!isRecord(queryData.documentFrequencies)) return false
  if (!isRecord(queryData.adjacency)) return false
  const edgeCount = graph?.edges?.length ?? 0
  for (const paths of Object.values(queryData.postings)) {
    if (!Array.isArray(paths)) return false
    for (const filePath of paths) {
      const value: unknown = filePath
      if (typeof value !== 'string') return false
    }
  }
  for (const edgeIndexes of Object.values(queryData.adjacency)) {
    if (!Array.isArray(edgeIndexes)) return false
    for (const edgeIndex of edgeIndexes) {
      const value: unknown = edgeIndex
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0 ||
        value >= edgeCount
      ) {
        return false
      }
    }
  }
  return true
}

async function withCacheLock<T>(
  dir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(dir, LOCK_FILE)
  const deadline = Date.now() + LOCK_TIMEOUT_MS

  // Release a lock we verifiably own: clear the heartbeat, close the open
  // handle, and remove the lock file only when the atomically displaced
  // bytes still hold our token (see releaseOwnedLock below). Shared by
  // every exit path below — the critical section, a failed owner-token
  // verification, and an error during lock initialization — so no path can
  // leak the 30s heartbeat timer or the open file handle, and the
  // just-created lock file is always released by the path that created it
  // (reliability finding withcachelock-verify-continue-skips-release).
  const release = async (
    heartbeat: ReturnType<typeof setInterval>,
    handle: fs.promises.FileHandle,
    ownerToken: string,
  ): Promise<void> => {
    clearInterval(heartbeat)
    await handle.close().catch(() => {})
    try {
      await releaseOwnedLock(lockPath, ownerToken)
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }

  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx')
      const ownerToken = `${process.pid}:${randomUUID()}`
      // Heartbeat: keep the lock mtime fresh while the operation runs so a
      // slow-but-live holder is not reclaimed by the STALE_LOCK_MS age
      // heuristic (see the EEXIST branch below).
      const heartbeat = setInterval(() => {
        // Token-verified touch (reliability finding
        // heartbeat-utimes-touches-displaced-lock): clearInterval in release()
        // cannot cancel a utimes already in flight, and a tick that races our
        // release and a competitor's re-acquire would refresh the NEW owner's
        // lock mtime, extending its apparent freshness and delaying
        // legitimate age-based reclaim. Verify the lock still holds OUR token
        // immediately before (and after) touching so an in-flight tick that
        // lost the lock is a no-op. Non-throwing on ENOENT.
        void fs.promises
          .readFile(lockPath, 'utf8')
          .then((content) => {
            if (!content.startsWith(`${ownerToken}\n`)) return
            const now = new Date()
            return fs.promises.utimes(lockPath, now, now).catch(() => {})
          })
          .catch(() => {})
      }, LOCK_HEARTBEAT_MS)
      // unref the heartbeat: a wedged operation must not keep the event loop
      // alive indefinitely via this timer alone (reliability finding
      // heartbeat-timer-pinned-to-operation).
      heartbeat.unref?.()
      // Phase 1: write our token and verify it is verifiably on disk. The
      // finally releases the heartbeat, the handle, and the just-created
      // lock file whenever the phase does NOT end acquired — including the
      // failed-verification path, whose `continue` below can no longer skip
      // cleanup (reliability finding withcachelock-verify-continue-skips-release).
      let acquired = false
      try {
        await handle.writeFile(`${ownerToken}\n${Date.now()}\n`, 'utf8')
        // Close the create-vs-owner-write window (reliability finding
        // withcachelock-lockfile-open-race): a waiter that snapshotted the
        // previous dead owner's content could reclaim between our 'wx'
        // create and this token write. Only run the critical section when
        // OUR token is verifiably on disk.
        try {
          acquired = (await fs.promises.readFile(lockPath, 'utf8')).startsWith(
            `${ownerToken}\n`,
          )
        } catch {
          acquired = false
        }
      } finally {
        if (!acquired) {
          await release(heartbeat, handle, ownerToken)
        }
      }
      if (!acquired) continue
      // Phase 2: the verified critical section. The heartbeat timer and the
      // handle stay live for the operation and are released exactly once,
      // whether the operation returns or throws.
      try {
        return await operation()
      } finally {
        await release(heartbeat, handle, ownerToken)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        // Snapshot the lock file once and make every reclaim decision from
        // that snapshot, so the liveness probe and the age check reason about
        // the same bytes the reclaim below verifies.
        const content = await fs.promises.readFile(lockPath, 'utf8')
        const stat = await fs.promises.stat(lockPath)
        // Liveness first: reclaim immediately when the process that created
        // the lock is no longer alive, so a crashed indexer does not block
        // every build for the full STALE_LOCK_MS window. The age heuristic
        // below must never preempt this check — stealing a slow-but-live
        // writer's lock breaks mutual exclusion mid-operation.
        const deadOwner = isLockOwnerDead(content)
        // Age fallback for a live or ambiguous owner: a genuine holder keeps
        // the mtime fresh via the heartbeat, so this only fires for a
        // genuinely abandoned lock (e.g. one whose pid cannot be probed).
        const ageStale = Date.now() - stat.mtimeMs > STALE_LOCK_MS
        if (deadOwner || ageStale) {
          // Rename-verified reclaim: the lock is moved aside atomically and
          // only deleted when the displaced bytes still hold the stale
          // content judged above, so a competing waiter that already
          // reclaimed and re-acquired never loses its live lock here.
          if (await reclaimStaleLock(lockPath, content)) continue
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw statError
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for index cache lock: ${lockPath}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

/**
 * Determines whether the process that wrote a lock file is no longer alive.
 * The lock's first line is `${pid}:${uuid}` (see withCacheLock); `content` is
 * the caller's snapshot of the file, so the liveness verdict and the
 * subsequent content-verified reclaim (see {@link reclaimStaleLock}) reason
 * about the same bytes. A dead owner lets a crashed indexer's lock be
 * reclaimed immediately instead of waiting out STALE_LOCK_MS. Conservative:
 * any ambiguity (empty lock, unparseable pid, our own pid, or a live/foreign
 * process) returns false so a genuinely held lock is never stolen.
 */
function isLockOwnerDead(content: string): boolean {
  const firstLine = content.split('\n', 1)[0] ?? ''
  const pidText = firstLine.split(':', 1)[0] ?? ''
  const pid = Number.parseInt(pidText, 10)
  if (!Number.isInteger(pid) || pid <= 0) return false
  // Never reclaim our own lock; that would corrupt an in-progress operation.
  if (pid === process.pid) return false
  try {
    // Signal 0 runs existence/permission checks without delivering a signal.
    // ESRCH means the process no longer exists (dead owner). EPERM means it
    // exists but is owned by another user (alive) — do not reclaim.
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * Reclaim a stale lock by removing the lock file from its namespace — but
 * only when it still holds the exact `staleContent` that was judged
 * reclaimable. Ownership is verified BEFORE the rename (reliability finding
 * release-owned-lock-displaces-foreign-lock): renaming first would displace
 * a competing waiter's live lock when the stale snapshot was already
 * reclaimed and re-acquired, and a third waiter acquiring during the
 * rename→restore window would leave the displaced live lock destroyed —
 * two processes in the critical section. Lock content is only ever replaced
 * via remove+create (never in place), so a read verified as stale cannot be
 * legitimately replaced between this read and the atomic rename; the rename
 * therefore displaces exactly the stale bytes. A vanished path (ENOENT)
 * means another waiter reclaimed it first. The defensive displaced-bytes
 * check restores unexpected content via link (EEXIST-safe) and never
 * deletes possibly-live lock bytes. Returns true when the caller may
 * proceed to (re)acquire.
 */
export async function reclaimStaleLock(
  lockPath: string,
  staleContent: string,
): Promise<boolean> {
  let observed: string
  try {
    observed = await fs.promises.readFile(lockPath, 'utf8')
  } catch {
    // The lock is gone: another waiter already reclaimed it.
    return true
  }
  if (observed !== staleContent) {
    // A fresh owner token: the lock was re-acquired after the staleness
    // snapshot was taken. Never displace a live lock — do not proceed.
    return false
  }
  const displacedPath = `${lockPath}.reclaim.${process.pid}.${randomUUID()}`
  try {
    await fs.promises.rename(lockPath, displacedPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Another waiter reclaimed the stale lock between our verified read
      // and this rename.
      return true
    }
    throw error
  }
  let displaced: string
  try {
    displaced = await fs.promises.readFile(displacedPath, 'utf8')
  } catch {
    // The displaced lock vanished before it could be judged; nothing was
    // deleted and the lock namespace is free either way.
    return true
  }
  if (displaced !== staleContent) {
    // Defensive: content changed between the verified read and the rename
    // without a remove+create (no known code path does this). Restore via
    // link (EEXIST-safe) and never delete possibly-live lock bytes; a
    // leaked scratch file is the safe failure mode.
    try {
      await fs.promises.link(displacedPath, lockPath)
      try {
        await fs.promises.rm(displacedPath, { force: true })
      } catch {
        // Our scratch name is gone; the lock survives at lockPath.
      }
    } catch {
      // Lock path occupied by a newer waiter; leave the scratch copy.
    }
    return false
  }
  try {
    await fs.promises.rm(displacedPath, { force: true })
  } catch {
    // Already gone.
  }
  return true
}

/**
 * Release a lock we believe we own by deleting the lock file — but only
 * when the bytes at the lock path still hold `ownerToken`. Ownership is
 * verified BEFORE the rename (reliability finding
 * release-owned-lock-displaces-foreign-lock): renaming first would displace
 * a competing waiter's live lock when our lock was already reclaimed and
 * re-acquired, and a third waiter acquiring during the rename→restore
 * window would leave the displaced live lock destroyed. A reclaim that
 * takes our live lock must first prove our owner pid dead
 * (isLockOwnerDead), so a read verified as ours cannot be legitimately
 * replaced between this read and the atomic rename; the rename therefore
 * displaces exactly our own bytes. Lock content is only ever replaced via
 * remove+create (never in place). The defensive displaced-bytes check
 * restores unexpected content via link (EEXIST-safe) and never deletes
 * possibly-live lock bytes.
 */
export async function releaseOwnedLock(
  lockPath: string,
  ownerToken: string,
): Promise<void> {
  let observed: string
  try {
    observed = await fs.promises.readFile(lockPath, 'utf8')
  } catch {
    // A stale-lock recovery already removed our lock from the namespace.
    return
  }
  if (!observed.startsWith(`${ownerToken}\n`)) {
    // Not ours: someone else's live (or stale) lock occupies the path.
    // Never displace or delete bytes we do not own.
    return
  }
  const displacedPath = `${lockPath}.release.${process.pid}.${randomUUID()}`
  try {
    await fs.promises.rename(lockPath, displacedPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Reclaimed between our verified read and the rename.
      return
    }
    throw error
  }
  let displaced: string
  try {
    displaced = await fs.promises.readFile(displacedPath, 'utf8')
  } catch {
    // The displaced lock vanished before it could be judged; nothing was
    // deleted and the lock namespace is free either way.
    return
  }
  if (!displaced.startsWith(`${ownerToken}\n`)) {
    // Defensive: content changed between the verified read and the rename
    // without a remove+create (no known code path does this). Restore via
    // link (EEXIST-safe) and never delete possibly-live lock bytes; a
    // leaked scratch file is the safe failure mode.
    try {
      await fs.promises.link(displacedPath, lockPath)
      try {
        await fs.promises.rm(displacedPath, { force: true })
      } catch {
        // Our scratch name is gone; the lock survives at lockPath.
      }
    } catch {
      // Lock path occupied by a newer waiter; leave the scratch copy.
    }
    return
  }
  try {
    await fs.promises.rm(displacedPath, { force: true })
  } catch {
    // Already gone.
  }
}

/**
 * Serialize compactly for large index artifacts (reliability finding
 * atomicwritejson-pretty-prints-large-artifacts): pretty-printing roughly
 * doubles bytes and CPU on every refresh for metadata.json,
 * semantic-vectors.json, and the chunk sidecar. Small documents keep the
 * pretty format for debuggability; anything larger serializes compactly.
 */
const PRETTY_PRINT_MAX_CHARS = 4_096

async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const pretty = JSON.stringify(value, null, 2)
  const payload =
    pretty.length > PRETTY_PRINT_MAX_CHARS ? JSON.stringify(value) : pretty
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(temporaryPath, 'wx')
    await handle.writeFile(payload, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.promises.rename(temporaryPath, filePath)
  } finally {
    await handle?.close().catch(() => {})
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

async function ensureGitInfoExcludes(
  projectRoot: string,
  cacheDir: string,
): Promise<void> {
  const normalizedCacheDir = sanitizeIndexCacheDir(cacheDir)
  // Default-off toggle (M4-S6): decide before touching the exclude file so a
  // disabled toggle performs no I/O against .git at all.
  const writeEnabled =
    writeGitExcludeByRoot.get(projectRoot) ?? writeGitExcludeDefault
  if (!writeEnabled) return

  const gitDir = path.join(projectRoot, '.git')
  const infoDir = path.join(gitDir, 'info')
  const excludePath = path.join(infoDir, 'exclude')

  try {
    const stat = await fs.promises.stat(gitDir)
    if (!stat.isDirectory()) return
    await fs.promises.mkdir(infoDir, { recursive: true })
    let existing = ''
    try {
      existing = await fs.promises.readFile(excludePath, 'utf8')
    } catch {}
    const excludeLine = `/${normalizedCacheDir}/`
    // P8.6b: skip everything (including the exclude-file read) when the exact
    // line was already written for this project this session, keeping the
    // write rate bounded.
    const dedupKey = `${projectRoot}\0${excludeLine}`
    if (writtenGitExcludeLines.has(dedupKey)) return
    if (existing.split('\n').includes(excludeLine)) {
      writtenGitExcludeLines.add(dedupKey)
      return
    }
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
    await fs.promises.appendFile(
      excludePath,
      `${prefix}${excludeLine}\n`,
      'utf8',
    )
  } catch {
    // Best-effort only. Index writes must not fail just because git metadata is unavailable.
  }
}

export function isIndexStale(
  index: MetadataIndex,
  maxAgeMs = MAX_INDEX_AGE_MS,
): boolean {
  return Date.now() - index.builtAt > maxAgeMs
}

export function isIndexReady(
  index: MetadataIndex | null,
): index is MetadataIndex {
  return index !== null && index.fileCount > 0
}
