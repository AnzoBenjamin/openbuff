import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONCEPT_EMBEDDING_TEXT_VERSION,
  conceptEmbeddingHash,
  conceptEmbedText,
  conceptFingerprint,
  expandConceptRecall,
  openConceptDatabase,
  type ConceptCorpusEntry,
  type ConceptEmbedFn,
} from '../concept-index'

describe('concept-index', () => {
  let projectRoot: string | undefined

  function makeProjectRoot(): string {
    projectRoot = mkdtempSync(join(tmpdir(), 'concept-index-test-'))
    return projectRoot
  }

  afterEach(() => {
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true })
      projectRoot = undefined
    }
  })

  function deterministicVector(text: string): number[] {
    const digest = createHash('sha256').update(text).digest()
    return Array.from(digest.subarray(0, 16)).map(
      (byte) => (byte - 128) / 128,
    )
  }

  function fakeEmbedder(cacheKey: string): ConceptEmbedFn & {
    embeddedTexts: string[][]
    callCount: number
  } {
    const embed = ((texts: string[]) => {
      embed.callCount += 1
      embed.embeddedTexts.push(texts)
      return Promise.resolve(texts.map((text) => deterministicVector(text)))
    }) as ConceptEmbedFn & {
      embeddedTexts: string[][]
      callCount: number
    }
    embed.cacheKey = cacheKey
    embed.embeddedTexts = []
    embed.callCount = 0
    return embed
  }

  function corpusEntry(
    observationId: string,
    summary: string,
  ): ConceptCorpusEntry {
    return {
      observationId,
      kind: 'observation',
      summary,
      claimId: `claim-${observationId}`,
    }
  }

  test('returns no-embedder degraded expansion when embed is null', async () => {
    const root = makeProjectRoot()
    const result = await expandConceptRecall({
      projectRoot: root,
      embed: null,
      request: { query: 'auth flow' },
      corpus: [corpusEntry('obs-1', 'login handling')],
    })
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe('no-embedder')
    expect(result.observationIds).toEqual([])
  })

  test('conceptEmbedText normalizes whitespace and bounds to 512 chars', () => {
    const text = conceptEmbedText({
      kind: 'observation',
      summary: '  handles\n\nlogin   flow  ',
      detail: 'with\tretries',
    })
    expect(text).toBe('observation handles login flow with retries')

    const bounded = conceptEmbedText({
      kind: 'k',
      summary: 'x'.repeat(600),
    })
    expect(bounded.length).toBe(512)
    expect(bounded.startsWith('k ')).toBe(true)
  })

  test('cache hit: second call re-embeds only the query', async () => {
    const root = makeProjectRoot()
    const embed = fakeEmbedder('embedder-a')
    const corpus = [
      corpusEntry('obs-1', 'login handling'),
      corpusEntry('obs-2', 'token refresh'),
    ]
    const first = await expandConceptRecall({
      projectRoot: root,
      embed,
      request: { query: 'auth flow' },
      corpus,
    })
    expect(first.degraded).toBe(false)
    expect(embed.embeddedTexts[0]).toHaveLength(3)
    expect(first.observationIds.length).toBeGreaterThan(0)

    const second = await expandConceptRecall({
      projectRoot: root,
      embed,
      request: { query: 'auth flow' },
      corpus,
    })
    expect(second.degraded).toBe(false)
    expect(second.modelDigest).toBe(first.modelDigest)
    expect(embed.embeddedTexts[1]).toHaveLength(1)
    expect(embed.embeddedTexts[1][0]).toBe(
      conceptEmbedText({ kind: 'query', summary: 'auth flow' }),
    )
    expect(second.observationIds).toEqual(first.observationIds)
  })

  test('changed summary re-embeds the changed entry', async () => {
    const root = makeProjectRoot()
    const embed = fakeEmbedder('embedder-a')
    await expandConceptRecall({
      projectRoot: root,
      embed,
      request: { query: 'q' },
      corpus: [corpusEntry('obs-1', 'original summary')],
    })
    const second = await expandConceptRecall({
      projectRoot: root,
      embed,
      request: { query: 'q' },
      corpus: [corpusEntry('obs-1', 'changed summary')],
    })
    expect(second.degraded).toBe(false)
    expect(embed.embeddedTexts[1]).toHaveLength(2)
    expect(embed.embeddedTexts[1]).toContain(
      conceptEmbedText({ kind: 'observation', summary: 'changed summary' }),
    )
  })

  test('different cacheKey re-embeds everything under a new fingerprint', async () => {
    const root = makeProjectRoot()
    const corpus = [corpusEntry('obs-1', 'login handling')]
    const embed = fakeEmbedder('embedder-a')
    await expandConceptRecall({
      projectRoot: root,
      embed,
      request: { query: 'q' },
      corpus,
    })
    const rebadged = fakeEmbedder('embedder-b')
    const second = await expandConceptRecall({
      projectRoot: root,
      embed: rebadged,
      request: { query: 'q' },
      corpus,
    })
    expect(second.degraded).toBe(false)
    expect(second.modelDigest).not.toBe(conceptFingerprint(null))
    expect(rebadged.embeddedTexts[0]).toHaveLength(2)
  })

  test('vectors from different fingerprints coexist under the composite key', async () => {
    const root = makeProjectRoot()
    const corpus = [corpusEntry('obs-1', 'login handling')]
    const embedA = fakeEmbedder('embedder-a')
    await expandConceptRecall({
      projectRoot: root,
      embed: embedA,
      request: { query: 'q' },
      corpus,
    })
    const embedB = fakeEmbedder('embedder-b')
    await expandConceptRecall({
      projectRoot: root,
      embed: embedB,
      request: { query: 'q' },
      corpus,
    })
    const db = openConceptDatabase(root)
    if (!db) throw new Error('expected concept database to open')
    try {
      const rows = db
        .prepare('SELECT fingerprint FROM concept_vectors')
        .all() as { fingerprint: string }[]
      expect(new Set(rows.map((row) => row.fingerprint))).toEqual(
        new Set([conceptFingerprint(embedA), conceptFingerprint(embedB)]),
      )
    } finally {
      db.close()
    }
    // Switching back to embedder-a is a cache hit: only the query is
    // re-embedded, proving embedder-b never evicted embedder-a's rows.
    const third = await expandConceptRecall({
      projectRoot: root,
      embed: embedA,
      request: { query: 'q' },
      corpus,
    })
    expect(third.degraded).toBe(false)
    expect(embedA.embeddedTexts[1]).toHaveLength(1)
    expect(embedA.embeddedTexts[1][0]).toBe(
      conceptEmbedText({ kind: 'query', summary: 'q' }),
    )
  })

  test('legacy v1 concept_vectors store migrates to the composite key without losing rows', () => {
    const root = makeProjectRoot()
    const conceptDir = join(root, '.openbuff', 'memory', 'concept')
    mkdirSync(conceptDir, { recursive: true })
    const legacy = new Database(join(conceptDir, 'concept-vectors.sqlite'))
    legacy.exec(`CREATE TABLE concept_vectors (
      embedding_hash TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      claim_id TEXT NOT NULL DEFAULT '',
      observation_id TEXT NOT NULL,
      vector TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    const fingerprint = conceptFingerprint(fakeEmbedder('embedder-legacy'))
    legacy
      .prepare(
        'INSERT INTO concept_vectors (embedding_hash, fingerprint, claim_id, observation_id, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('legacy-hash', fingerprint, 'claim-1', 'obs-1', '[1,0]', 42)
    legacy.close()

    const db = openConceptDatabase(root)
    if (!db) throw new Error('expected concept database to open')
    try {
      const columns = db
        .query('PRAGMA table_info(concept_vectors)')
        .all() as { name: string; pk: number }[]
      const primaryKeyColumns = columns
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name)
      expect(primaryKeyColumns).toEqual(['embedding_hash', 'fingerprint'])
      const row = db
        .prepare(
          'SELECT claim_id, observation_id, vector FROM concept_vectors WHERE embedding_hash = ? AND fingerprint = ?',
        )
        .get('legacy-hash', fingerprint) as {
        claim_id: string
        observation_id: string
        vector: string
      } | null
      expect(row).not.toBeNull()
      expect(row?.claim_id).toBe('claim-1')
      expect(row?.observation_id).toBe('obs-1')
      expect(row?.vector).toBe('[1,0]')
      const schemaVersion = db
        .prepare("SELECT value FROM concept_meta WHERE key = 'schemaVersion'")
        .get() as { value: string }
      expect(schemaVersion.value).toBe('2')
    } finally {
      db.close()
    }
  })

  test('fingerprint LRU keeps at most 4 newest cacheKeys', async () => {
    const root = makeProjectRoot()
    for (let i = 0; i < 5; i++) {
      const result = await expandConceptRecall({
        projectRoot: root,
        embed: fakeEmbedder(`embedder-${i}`),
        request: { query: 'q' },
        corpus: [corpusEntry('obs-1', 'login handling')],
      })
      expect(result.degraded).toBe(false)
    }
    const db = openConceptDatabase(root)
    if (!db) throw new Error('expected concept database to open')
    try {
      const rows = db
        .prepare(
          'SELECT fingerprint FROM fingerprint_lru ORDER BY updated_at DESC, rowid DESC',
        )
        .all() as { fingerprint: string }[]
      expect(rows).toHaveLength(4)
      const expected = conceptFingerprint(fakeEmbedder('embedder-4'))
      expect(rows[0].fingerprint).toBe(expected)
      // The vector cache is the LRU's payload: an evicted fingerprint loses
      // its persisted vectors, so the store stays bounded to 4 fingerprints.
      const vectorRows = db
        .prepare('SELECT fingerprint FROM concept_vectors GROUP BY fingerprint')
        .all() as { fingerprint: string }[]
      expect(vectorRows).toHaveLength(4)
      expect(
        vectorRows.some(
          (row) =>
            row.fingerprint === conceptFingerprint(fakeEmbedder('embedder-0')),
        ),
      ).toBe(false)
    } finally {
      db.close()
    }
  })

  test('budget cap limits new embeddings', async () => {
    const root = makeProjectRoot()
    const embed = fakeEmbedder('embedder-a')
    const corpus: ConceptCorpusEntry[] = Array.from({ length: 40 }, (_, i) =>
      corpusEntry(`obs-${i}`, `summary ${i}`),
    )
    const result = await expandConceptRecall({
      projectRoot: root,
      embed,
      request: { query: 'q' },
      corpus,
      maxNewEmbeddings: 10,
    })
    expect(result.degraded).toBe(false)
    const embeddedCount = embed.embeddedTexts[0].length
    expect(embeddedCount).toBeLessThanOrEqual(10)
    // Query text consumed one budget slot; corpus texts start with obs-0 in order.
    expect(embed.embeddedTexts[0][0]).toBe(
      conceptEmbedText({ kind: 'query', summary: 'q' }),
    )
  })

  test('throwing embedder yields degraded error expansion', async () => {
    const root = makeProjectRoot()
    const throwing = (async () => {
      throw new Error('embedder exploded')
    }) as unknown as ConceptEmbedFn
    throwing.cacheKey = 'throwing'
    const result = await expandConceptRecall({
      projectRoot: root,
      embed: throwing,
      request: { query: 'q' },
      corpus: [corpusEntry('obs-1', 'login handling')],
    })
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe('error')
    expect(result.observationIds).toEqual([])
    expect(result.modelDigest).toBe(conceptFingerprint(throwing))
  })

  test('timeout yields degraded timeout expansion', async () => {
    const root = makeProjectRoot()
    const never = (async () => {
      await new Promise(() => {})
    }) as unknown as ConceptEmbedFn
    never.cacheKey = 'never'
    const result = await expandConceptRecall({
      projectRoot: root,
      embed: never,
      request: { query: 'q' },
      corpus: [corpusEntry('obs-1', 'login handling')],
      timeoutMs: 50,
    })
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe('timeout')
    expect(result.observationIds).toEqual([])
  })

  test('slow embed resolving after timeout persists no vector writes', async () => {
    const root = makeProjectRoot()
    const slow = (async (texts: string[]) => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      return texts.map((text) => deterministicVector(text))
    }) as unknown as ConceptEmbedFn
    slow.cacheKey = 'slow'
    const result = await expandConceptRecall({
      projectRoot: root,
      embed: slow,
      request: { query: 'q' },
      corpus: [corpusEntry('obs-1', 'login handling')],
      timeoutMs: 50,
    })
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe('timeout')
    expect(result.observationIds).toEqual([])

    // Let the abandoned inner fold resume after the slow embed resolves:
    // it must hit the abort gates before any write, and the wrapper-owned
    // handle must have been closed exactly once without a double-close
    // error.
    await new Promise((resolve) => setTimeout(resolve, 600))
    const db = openConceptDatabase(root)
    if (!db) throw new Error('expected concept database to open')
    try {
      const vectorRows = db
        .prepare('SELECT fingerprint FROM concept_vectors')
        .all() as { fingerprint: string }[]
      expect(vectorRows).toHaveLength(0)
      const lruRows = db
        .prepare('SELECT fingerprint FROM fingerprint_lru')
        .all() as { fingerprint: string }[]
      expect(lruRows).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  test('database files get restrictive permissions', () => {
    if (process.platform !== 'linux') return
    const root = makeProjectRoot()
    const db = openConceptDatabase(root)
    if (!db) throw new Error('expected concept database to open')
    try {
      const dbPath = join(
        root,
        '.openbuff',
        'memory',
        'concept',
        'concept-vectors.sqlite',
      )
      expect((statSync(dbPath).mode & 0o777)).toBe(0o600)
      expect(
        statSync(join(root, '.openbuff', 'memory', 'concept')).mode & 0o777,
      ).toBe(0o700)
      const meta = db
        .prepare(
          "SELECT value FROM concept_meta WHERE key = 'conceptEmbeddingTextVersion'",
        )
        .get() as { value: string }
      expect(meta.value).toBe(CONCEPT_EMBEDDING_TEXT_VERSION)
      const schemaVersion = db
        .prepare(
          "SELECT value FROM concept_meta WHERE key = 'schemaVersion'",
        )
        .get() as { value: string }
      expect(schemaVersion.value).toBe('2')
    } finally {
      db.close()
    }
  })

  test('a poisoned empty cached vector is treated as a miss and re-embedded', async () => {
    const root = makeProjectRoot()
    // Seed the cache with an empty-array vector for one entry (simulating a
    // legacy degraded embedder response). It must NOT be treated as a hit.
    const db = openConceptDatabase(root)
    if (!db) throw new Error('expected concept database to open')
    const poisonedHash = conceptEmbeddingHash(
      conceptEmbedText({ kind: 'observation', summary: 'login handling' }),
    )
    db.prepare(
      'INSERT OR REPLACE INTO concept_vectors (embedding_hash, fingerprint, claim_id, observation_id, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      poisonedHash,
      conceptFingerprint(fakeEmbedder('embedder-a')),
      'claim-obs-1',
      'obs-1',
      '[]',
      0,
    )
    db.close()

    const embed = fakeEmbedder('embedder-a')
    const first = await expandConceptRecall({
      projectRoot: root,
      embed,
      request: { query: 'auth flow' },
      corpus: [corpusEntry('obs-1', 'login handling')],
    })
    expect(first.degraded).toBe(false)
    // The poisoned row was a miss: the corpus text got re-embedded alongside
    // the query (2 texts: query + poisoned entry).
    expect(embed.embeddedTexts[0]).toHaveLength(2)
    // And the stored row is no longer the empty array.
    const dbAfter = openConceptDatabase(root)
    if (!dbAfter) throw new Error('expected concept database to open')
    try {
      const row = dbAfter
        .prepare(
          'SELECT vector FROM concept_vectors WHERE embedding_hash = ? AND fingerprint = ?',
        )
        .get(poisonedHash, conceptFingerprint(embed)) as {
        vector: string
      } | null
      expect(row).not.toBeNull()
      expect(JSON.parse(row!.vector).length).toBeGreaterThan(0)
    } finally {
      dbAfter.close()
    }

    // A malformed embedder response is never persisted: subsequent calls
    // re-embed rather than treating the empty result as a valid hit.
    const emptyEmbedder = ((texts: string[]) =>
      Promise.resolve(texts.map(() => []))) as ConceptEmbedFn
    emptyEmbedder.cacheKey = 'empty'
    const second = await expandConceptRecall({
      projectRoot: root,
      embed: emptyEmbedder,
      request: { query: 'auth flow' },
      corpus: [corpusEntry('obs-1', 'login handling')],
    })
    expect(second.degraded).toBe(false)
    expect(second.observationIds).toEqual([])
    const dbThird = openConceptDatabase(root)
    if (!dbThird) throw new Error('expected concept database to open')
    try {
      const rows = dbThird
        .prepare(
          'SELECT vector FROM concept_vectors WHERE fingerprint = ?',
        )
        .all(conceptFingerprint(emptyEmbedder)) as { vector: string }[]
      expect(rows).toHaveLength(0)
    } finally {
      dbThird.close()
    }
  })
})
