import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

export const CONCEPT_EMBEDDING_TEXT_VERSION = '1'

const DEFAULT_CONCEPT_TIMEOUT_MS = 1500
const DEFAULT_CONCEPT_MAX_NEW_EMBEDDINGS = 32
const DEFAULT_CONCEPT_MAX_RESULTS = 8
const FINGERPRINT_LRU_LIMIT = 4
/** Persisted concept-store schema version (2: composite vector primary key). */
const CONCEPT_SCHEMA_VERSION = '2'

type Sha256Hex = string

function sha256Hex(text: string): Sha256Hex {
  return createHash('sha256').update(text).digest('hex')
}

export type ConceptEmbedFn = ((texts: string[]) => Promise<number[][]>) & {
  cacheKey?: string
}

export type ConceptCorpusEntry = {
  observationId: string
  kind: string
  summary: string
  detail?: string
  claimId?: string
}

export type ConceptExpansion = {
  observationIds: string[]
  modelDigest: string
  degraded: boolean
  degradedReason?: 'no-embedder' | 'timeout' | 'error'
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function conceptFingerprint(
  embed: ConceptEmbedFn | null | undefined,
): string {
  return sha256Hex(
    JSON.stringify({
      conceptEmbeddingTextVersion: CONCEPT_EMBEDDING_TEXT_VERSION,
      embedder: embed?.cacheKey ?? null,
    }),
  )
}

export function conceptEmbedText(params: {
  kind: string
  summary: string
  detail?: string
}): string {
  const parts = [params.kind, params.summary]
  if (params.detail && params.detail.trim().length > 0)
    parts.push(params.detail)
  return parts
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512)
}

export function conceptEmbeddingHash(text: string): string {
  return sha256Hex(text)
}

const CONCEPT_DDL = `
CREATE TABLE IF NOT EXISTS concept_vectors (
  embedding_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  claim_id TEXT NOT NULL DEFAULT '',
  observation_id TEXT NOT NULL,
  vector TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (embedding_hash, fingerprint)
);
CREATE TABLE IF NOT EXISTS fingerprint_lru (
  fingerprint TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS concept_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/**
 * Migrate a legacy concept store whose concept_vectors table was keyed by
 * embedding_hash alone: under that key, INSERT OR REPLACE from one model
 * fingerprint overwrote another model's rows, so vectors from different
 * fingerprints could not coexist. Rebuilds the table under the composite
 * (embedding_hash, fingerprint) primary key, copying every existing row (its
 * fingerprint column is already correct). Transactional: any failure rolls
 * back and openConceptDatabase degrades to null (semantics-off).
 */
function migrateConceptVectorsToCompositeKey(db: Database): void {
  const table = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'concept_vectors'",
    )
    .get() as { name: string } | null
  if (!table) return
  const columns = db.query('PRAGMA table_info(concept_vectors)').all() as Array<{
    name: string
    pk: number
  }>
  const primaryKeyColumns = columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name)
  const alreadyComposite =
    primaryKeyColumns.length === 2 &&
    primaryKeyColumns[0] === 'embedding_hash' &&
    primaryKeyColumns[1] === 'fingerprint'
  if (alreadyComposite || !primaryKeyColumns.includes('embedding_hash')) return
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DROP TABLE IF EXISTS concept_vectors_v1')
    db.exec('ALTER TABLE concept_vectors RENAME TO concept_vectors_v1')
    db.exec(`CREATE TABLE concept_vectors (
  embedding_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  claim_id TEXT NOT NULL DEFAULT '',
  observation_id TEXT NOT NULL,
  vector TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (embedding_hash, fingerprint)
)`)
    db.exec(`INSERT OR IGNORE INTO concept_vectors
         (embedding_hash, fingerprint, claim_id, observation_id, vector, updated_at)
       SELECT embedding_hash, fingerprint, claim_id, observation_id, vector, updated_at
         FROM concept_vectors_v1`)
    db.exec('DROP TABLE concept_vectors_v1')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function openConceptDatabase(projectRoot: string): Database | null {
  try {
    const dir = join(projectRoot, '.openbuff', 'memory', 'concept')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const dbPath = join(dir, 'concept-vectors.sqlite')
    const db = new Database(dbPath)
    migrateConceptVectorsToCompositeKey(db)
    db.exec(CONCEPT_DDL)
    const insertMeta = db.prepare(
      'INSERT OR IGNORE INTO concept_meta (key, value) VALUES (?, ?)',
    )
    insertMeta.run('conceptEmbeddingTextVersion', CONCEPT_EMBEDDING_TEXT_VERSION)
    db.prepare(
      'INSERT INTO concept_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('schemaVersion', CONCEPT_SCHEMA_VERSION)
    db.exec('PRAGMA journal_mode = DELETE')
    chmodSync(dbPath, 0o600)
    const journalPath = dbPath + '-journal'
    if (existsSync(journalPath)) {
      try {
        chmodSync(journalPath, 0o600)
      } catch {
        // best-effort: the journal file is transient and may vanish mid-chmod
      }
    }
    return db
  } catch {
    return null
  }
}

type PendingEmbedding = {
  embeddingHash: string
  embedText: string
  observationId: string
  claimId: string
}

/**
 * A persisted or embedded vector is usable only when it is a non-empty array
 * of finite numbers. Degraded embedder responses (empty arrays, short or
 * malformed payloads) are NEVER persisted and NEVER treated as cache hits:
 * a poisoned row would otherwise pin its corpus entry at similarity 0
 * forever, so such rows are re-embedded on the next call instead.
 */
function isValidVector(vector: unknown): vector is number[] {
  if (!Array.isArray(vector) || vector.length === 0) return false
  for (const component of vector) {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      return false
    }
  }
  return true
}

async function expandConceptRecallInner(
  params: Parameters<typeof expandConceptRecall>[0],
  embed: ConceptEmbedFn,
  db: Database,
  modelDigest: string,
  signal: { aborted: boolean },
): Promise<ConceptExpansion> {
  const budget = params.maxNewEmbeddings ?? DEFAULT_CONCEPT_MAX_NEW_EMBEDDINGS
  const queryText = conceptEmbedText({
    kind: 'query',
    summary: params.request.query,
  })

  const seen = new Set<string>()
  const pending: PendingEmbedding[] = []
  const cached = new Map<string, number[]>()
  for (const entry of params.corpus) {
    if (seen.has(entry.observationId)) continue
    seen.add(entry.observationId)
    const embedText = conceptEmbedText(entry)
    const embeddingHash = conceptEmbeddingHash(embedText)
    const row = db
      .prepare(
        'SELECT vector FROM concept_vectors WHERE embedding_hash = ? AND fingerprint = ?',
      )
      .get(embeddingHash, modelDigest) as { vector: string } | null
    if (row) {
      try {
        const cachedVector: unknown = JSON.parse(row.vector)
        if (isValidVector(cachedVector)) {
          cached.set(entry.observationId, cachedVector)
        } else {
          // Poisoned/degraded cache row: treat as a miss and re-embed.
          pending.push({
            embeddingHash,
            embedText,
            observationId: entry.observationId,
            claimId: entry.claimId ?? '',
          })
        }
      } catch {
        pending.push({
          embeddingHash,
          embedText,
          observationId: entry.observationId,
          claimId: entry.claimId ?? '',
        })
      }
    } else {
      pending.push({
        embeddingHash,
        embedText,
        observationId: entry.observationId,
        claimId: entry.claimId ?? '',
      })
    }
  }

  const embedTexts = [queryText, ...pending.map((p) => p.embedText)].slice(
    0,
    Math.max(0, budget),
  )
  const vectors = await embed(embedTexts)
  // The wrapper may already have resolved the caller's promise with a
  // degraded timeout while embed() was in flight. The abandoned inner fold
  // must not touch the wrapper-owned handle afterwards.
  if (signal.aborted) {
    return {
      observationIds: [],
      modelDigest,
      degraded: true,
      degradedReason: 'timeout',
    }
  }
  const queryVector = vectors[0]
  if (!isValidVector(queryVector)) {
    // A degraded query vector cannot be scored against; return the empty
    // non-degraded expansion without persisting anything.
    return { observationIds: [], modelDigest, degraded: false }
  }

  const embeddedByHash = new Map<string, number[]>()
  for (let i = 1; i < embedTexts.length; i++) {
    const candidateVector: unknown = vectors[i] ?? []
    if (!isValidVector(candidateVector)) continue
    embeddedByHash.set(conceptEmbeddingHash(embedTexts[i]!), candidateVector)
  }

  const now = Date.now()
  const insertVector = db.prepare(
    'INSERT OR REPLACE INTO concept_vectors (embedding_hash, fingerprint, claim_id, observation_id, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const scored: { observationId: string; score: number }[] = []
  for (const [observationId, vector] of cached) {
    scored.push({
      observationId,
      score: cosineSimilarity(queryVector, vector),
    })
  }
  for (const pendingEntry of pending) {
    // Abort gate: no vector INSERT OR REPLACE may happen after the caller
    // has already been told the expansion timed out.
    if (signal.aborted) {
      return {
        observationIds: [],
        modelDigest,
        degraded: true,
        degradedReason: 'timeout',
      }
    }
    const vector = embeddedByHash.get(pendingEntry.embeddingHash)
    if (!vector) continue
    insertVector.run(
      pendingEntry.embeddingHash,
      modelDigest,
      pendingEntry.claimId,
      pendingEntry.observationId,
      JSON.stringify(vector),
      now,
    )
    scored.push({
      observationId: pendingEntry.observationId,
      score: cosineSimilarity(queryVector, vector),
    })
  }

  // Abort gate: no LRU upsert or pruning writes may happen after the caller
  // has already been told the expansion timed out.
  if (signal.aborted) {
    return {
      observationIds: [],
      modelDigest,
      degraded: true,
      degradedReason: 'timeout',
    }
  }
  db.prepare(
    'INSERT OR REPLACE INTO fingerprint_lru (fingerprint, updated_at) VALUES (?, ?)',
  ).run(modelDigest, now)
  db.exec(
    `DELETE FROM fingerprint_lru WHERE fingerprint NOT IN (SELECT fingerprint FROM fingerprint_lru ORDER BY updated_at DESC, rowid DESC LIMIT ${FINGERPRINT_LRU_LIMIT})`,
  )
  // The vector rows are the LRU's payload: a fingerprint evicted from the
  // LRU loses its persisted vectors, so the cache stays bounded to the 4
  // retained fingerprints instead of accumulating rows forever.
  db.exec(
    'DELETE FROM concept_vectors WHERE fingerprint NOT IN (SELECT fingerprint FROM fingerprint_lru)',
  )

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.observationId < b.observationId
      ? -1
      : a.observationId > b.observationId
        ? 1
        : 0
  })
  const maxResults = params.maxResults ?? DEFAULT_CONCEPT_MAX_RESULTS
  return {
    observationIds: scored.slice(0, maxResults).map((s) => s.observationId),
    modelDigest,
    degraded: false,
  }
}

export async function expandConceptRecall(params: {
  projectRoot: string
  embed: ConceptEmbedFn | null
  request: { query: string }
  corpus: ConceptCorpusEntry[]
  timeoutMs?: number
  maxNewEmbeddings?: number
  maxResults?: number
}): Promise<ConceptExpansion> {
  const embed = params.embed
  if (!embed) {
    return {
      observationIds: [],
      modelDigest: conceptFingerprint(null),
      degraded: true,
      degradedReason: 'no-embedder',
    }
  }
  const modelDigest = conceptFingerprint(embed)
  const timeoutMs = params.timeoutMs ?? DEFAULT_CONCEPT_TIMEOUT_MS
  // The wrapper owns the handle for the whole expansion: the inner fold is
  // abandoned on timeout, so only a wrapper-owned close guarantees exactly
  // one close on both the completed and timed-out paths.
  const db = openConceptDatabase(params.projectRoot)
  if (!db) {
    return {
      observationIds: [],
      modelDigest,
      degraded: true,
      degradedReason: 'error',
    }
  }
  const signal = { aborted: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      expandConceptRecallInner(params, embed, db, modelDigest, signal),
      new Promise<ConceptExpansion>((resolve) => {
        timer = setTimeout(
          () => {
            signal.aborted = true
            resolve({
              observationIds: [],
              modelDigest,
              degraded: true,
              degradedReason: 'timeout',
            })
          },
          timeoutMs,
        )
      }),
    ])
  } catch {
    return {
      observationIds: [],
      modelDigest,
      degraded: true,
      degradedReason: 'error',
    }
  } finally {
    if (timer) clearTimeout(timer)
    try {
      db.close()
    } catch {
      // bun:sqlite throws on double-close; the wrapper is the only closer.
    }
  }
}
