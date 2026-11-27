import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { ParsedFileTokens } from '@codebuff/code-map'

import { createEmbeddedIndexStorage } from './embedded-storage'
import {
  assertCacheOwnership,
  computeIndexSnapshotId,
  getIndexDir,
  loadLegacyIndex,
  setIndexPublicationToken,
  withCacheLock,
  writeOwnerFile,
} from './index-store'
import {
  getIndexStorageFactory,
  indexStorageScope,
  queryAllIndexStorage,
  type IndexStorageFactory,
  type IndexStorageFactoryOptions,
  type IndexStorageBatch,
  type IndexStorageBatchResult,
  type IndexStorageIdentity,
  type IndexStorageKey,
  type IndexStoragePort,
  type IndexStoragePut,
  type IndexStorageQuery,
  type IndexStorageQueryResult,
  type IndexStorageRecord,
  type IndexStorageScope,
  type IndexStorageStats,
} from './storage-port'
import { buildIndexQueryData } from './query-data'
import { withoutStaleScipProjection } from './scip-ingest'
import { canonicalJson } from './stable-json'
import type {
  IndexedFile,
  IndexEdge,
  IndexGraph,
  IndexMutationDelta,
  IndexNode,
  MetadataIndex,
} from './types'

export const NORMALIZED_INDEX_MARKER = '.openbuff-normalized-index'
const IDENTITY_FILE = 'identity.json'
const REPOSITORY_ID_FILE = 'openbuff-repository-id'
const WORKTREE_ID_FILE = 'openbuff-worktree-id'
export const INDEX_FACT_TABLES = [
  'files',
  'parses',
  'parse_metadata',
  'nodes',
  'edges',
  'structural_edges',
  'postings',
  'adjacency',
  'graph_files',
  'definitions',
  'callers',
] as const
const TABLES = INDEX_FACT_TABLES
type FactTable = (typeof TABLES)[number]
const CHECKPOINT_GENERATIONS = 32
const MAX_OBJECT_BATCH_BYTES = 2_000_000
const MAX_BATCH_ROWS = 256
const MAX_OBJECT_READ_CONCURRENCY = 4

interface ObjectReference {
  objectKey: string | null
}

interface ContentObject {
  schemaVersion: 1
  kind: FactTable
  payload: unknown
  source?: { hash: string; language: string; extractionFingerprint: string }
}

interface EdgeFact {
  edge: IndexEdge
  order: number
}

interface PostingFact {
  paths: string[]
  documentFrequency: number
}

interface GraphFileFact {
  nodes: string[]
  edges: string[]
}

export interface IndexGenerationManifest {
  schemaVersion: 1
  generationId: string
  parentGenerationId?: string
  checkpoint: boolean
  depth: number
  projectRoot: string
  repositoryId: string
  worktreeId: string
  indexVersion: MetadataIndex['version']
  snapshotId: string
  builtAt: number
  fileCount: number
  nextEdgeOrder: number
  indexedJournalCursor: number
  workspaceRevision?: string | number
  graphConfigFingerprint?: string
  sourceConfigFingerprint?: string
  parseDiagnostics?: MetadataIndex['parseDiagnostics']
  coverage?: MetadataIndex['coverage']
  parserDegraded?: boolean
  freshness?: MetadataIndex['freshness']
  unverifiedPaths?: string[]
}

interface GenerationHead {
  generationId: string
  parentGenerationId?: string
  builtAt: number
  snapshotId: string
}

interface OpenStorage {
  identity: IndexStorageIdentity
  store: ReopeningIndexStorage
  factory: IndexStorageFactory | undefined
}

interface PersistedStorageIdentity extends IndexStorageIdentity {
  rootFileIdentity?: string
}

interface LoadedGeneration {
  index: MetadataIndex
  manifest: IndexGenerationManifest
  headVersion: string
  references: Map<FactTable, Map<string, string>>
  facts: Map<FactTable, Map<string, unknown>>
}

const openStores = new Map<string, Promise<OpenStorage>>()
const loadedGenerations = new WeakMap<IndexStoragePort, LoadedGeneration>()
export const MAX_OPEN_INDEX_STORES = 16

/** Reopens an evicted backend when a caller still holds its port. */
class ReopeningIndexStorage implements IndexStoragePort {
  readonly protocolVersion = 1
  private opening: Promise<IndexStoragePort> | undefined
  private releasing: Promise<void> = Promise.resolve()
  private activeRequests = 0
  private suspendRequested = false
  private evicted = false
  private closed = false
  private drain: (() => void) | undefined

  constructor(
    private readonly factory: IndexStorageFactory,
    private readonly options: IndexStorageFactoryOptions,
  ) {}

  private async use<T>(
    operation: (store: IndexStoragePort) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error('Index storage is closed')
    this.activeRequests += 1
    try {
      await this.releasing
      this.opening ??= this.openBackend()
      return await operation(await this.opening)
    } finally {
      this.activeRequests -= 1
      if (this.activeRequests === 0) {
        this.drain?.()
        this.drain = undefined
        if (this.suspendRequested || this.evicted) await this.releaseBackend()
      }
    }
  }

  private async openBackend(): Promise<IndexStoragePort> {
    try {
      const store = await this.factory(this.options)
      if (store.protocolVersion !== 1) {
        await store.close()
        throw new Error('Unsupported index storage protocol version')
      }
      return store
    } catch (error) {
      this.opening = undefined
      throw error
    }
  }

  get<T>(request: IndexStorageKey): Promise<IndexStorageRecord<T> | null> {
    return this.use((store) => store.get<T>(request))
  }
  query<T>(request: IndexStorageQuery): Promise<IndexStorageQueryResult<T>> {
    return this.use((store) => store.query<T>(request))
  }
  batch(request: IndexStorageBatch): Promise<IndexStorageBatchResult> {
    return this.use((store) => store.batch(request))
  }
  stats(request?: { scope?: IndexStorageScope }): Promise<IndexStorageStats> {
    return this.use((store) => store.stats(request))
  }
  initialize(): Promise<void> {
    return this.use(async () => {})
  }

  async suspend(): Promise<void> {
    this.evicted = true
    this.suspendRequested = true
    if (this.activeRequests === 0) await this.releaseBackend()
  }

  private releaseBackend(): Promise<void> {
    const opening = this.opening
    this.opening = undefined
    this.suspendRequested = false
    const release = this.releasing.then(async () => {
      if (opening) await (await opening).close()
    })
    this.releasing = release.catch(() => {})
    return release
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.activeRequests)
      await new Promise<void>((resolve) => {
        this.drain = resolve
      })
    await this.releaseBackend()
  }
}

/** Test/diagnostic hook for the bounded process-local backend cache. */
export function getOpenIndexStorageCount(): number {
  return openStores.size
}

async function trimOpenIndexStorageCache(): Promise<void> {
  while (openStores.size > MAX_OPEN_INDEX_STORES) {
    const oldest = openStores.entries().next().value
    if (!oldest) break
    openStores.delete(oldest[0])
    await (await oldest[1]).store.suspend()
  }
}

/** Content identity is independent of root aliases; worktrees never share state. */
export async function getIndexStorageIdentity(
  projectRoot: string,
  cacheDir = '.codebuff-index',
): Promise<IndexStorageIdentity> {
  const directory = getIndexDir(projectRoot, cacheDir)
  await assertCacheOwnership(directory)
  await fs.mkdir(directory, { recursive: true })
  // Existing identities can be checked without re-entering the legacy lock,
  // which may already be held by the migration path.
  try {
    const saved = JSON.parse(
      await fs.readFile(path.join(directory, IDENTITY_FILE), 'utf8'),
    ) as PersistedStorageIdentity
    const canonicalRoot = await fs.realpath(projectRoot)
    const stat = await fs.stat(canonicalRoot)
    const gitDirectories = await findGitDirectories(canonicalRoot)
    const identitiesMatch = gitDirectories
      ? (
          await fs.readFile(
            path.join(gitDirectories.commonDir, REPOSITORY_ID_FILE),
            'utf8',
          )
        ).trim() === saved.repositoryId &&
        (
          await fs.readFile(
            path.join(gitDirectories.gitDir, WORKTREE_ID_FILE),
            'utf8',
          )
        ).trim() === saved.worktreeId
      : !saved.gitCommonDir &&
        (saved.rootFileIdentity === `${stat.dev}:${stat.ino}` ||
          (!saved.rootFileIdentity && saved.projectRoot === canonicalRoot))
    if (
      saved.projectRoot === canonicalRoot &&
      validIdentity(saved.repositoryId) &&
      validIdentity(saved.worktreeId) &&
      identitiesMatch
    )
      return saved
  } catch {
    // Missing or incomplete identity requires locked initialization below.
  }
  // Identity and owner creation must not precede the lock's recovery check.
  return withCacheLock(directory, async () => {
    await assertCacheOwnership(directory)
    await writeOwnerFile(directory)
    const canonicalRoot = await fs.realpath(projectRoot)
    const identityPath = path.join(directory, IDENTITY_FILE)
    let saved: PersistedStorageIdentity | undefined
    try {
      saved = JSON.parse(
        await fs.readFile(identityPath, 'utf8'),
      ) as PersistedStorageIdentity
    } catch {
      /* A missing identity is a new, isolated worktree. */
    }
    const stat = await fs.stat(canonicalRoot)
    const rootFileIdentity = `${stat.dev}:${stat.ino}`
    const gitDirectories = await findGitDirectories(canonicalRoot)
    const reusableNonGitIdentity =
      !gitDirectories &&
      !saved?.gitCommonDir &&
      (saved?.rootFileIdentity === rootFileIdentity ||
        (!saved?.rootFileIdentity && saved?.projectRoot === canonicalRoot))
    const repositoryId = gitDirectories
      ? await readOrCreateId(
          path.join(gitDirectories.commonDir, REPOSITORY_ID_FILE),
        )
      : reusableNonGitIdentity && validIdentity(saved?.repositoryId)
        ? saved.repositoryId
        : randomUUID()
    const worktreeId = gitDirectories
      ? await readOrCreateId(path.join(gitDirectories.gitDir, WORKTREE_ID_FILE))
      : reusableNonGitIdentity && validIdentity(saved?.worktreeId)
        ? saved.worktreeId
        : randomUUID()
    if (
      saved?.projectRoot === canonicalRoot &&
      saved.repositoryId === repositoryId &&
      saved.worktreeId === worktreeId
    )
      return saved
    const identity: PersistedStorageIdentity = {
      projectRoot: canonicalRoot,
      repositoryId,
      worktreeId,
      rootFileIdentity,
      ...(gitDirectories ? { gitCommonDir: gitDirectories.commonDir } : {}),
    }
    await atomicWrite(identityPath, JSON.stringify(identity))
    return identity
  })
}

export async function openIndexStorage(
  projectRoot: string,
  cacheDir = '.codebuff-index',
): Promise<OpenStorage> {
  const directory = getIndexDir(projectRoot, cacheDir)
  const factory = getIndexStorageFactory()
  const cached = openStores.get(directory)
  if (cached) {
    const opened = await cached
    const identity = await getIndexStorageIdentity(projectRoot, cacheDir)
    if (
      opened.factory === factory &&
      opened.identity.repositoryId === identity.repositoryId &&
      opened.identity.worktreeId === identity.worktreeId
    ) {
      opened.identity = identity
      openStores.delete(directory)
      openStores.set(directory, cached)
      return opened
    }
    openStores.delete(directory)
    await opened.store.close()
  }
  const opening = (async () => {
    const identity = await getIndexStorageIdentity(projectRoot, cacheDir)
    const store = new ReopeningIndexStorage(
      factory ?? createEmbeddedIndexStorage,
      { directory, identity },
    )
    // Establish backend/protocol validity before publishing this handle.
    await store.initialize()
    return { identity, store, factory }
  })()
  openStores.set(directory, opening)
  try {
    const opened = await opening
    await trimOpenIndexStorageCache()
    return opened
  } catch (error) {
    if (openStores.get(directory) === opening) openStores.delete(directory)
    throw error
  }
}

/** Explicit lifecycle hook used by SDK adapters, worktree switches, and tests. */
export async function closeIndexStorage(
  projectRoot: string,
  cacheDir = '.codebuff-index',
): Promise<void> {
  const directory = getIndexDir(projectRoot, cacheDir)
  const opening = openStores.get(directory)
  if (!opening) return
  openStores.delete(directory)
  const opened = await opening
  loadedGenerations.delete(opened.store)
  await opened.store.close()
}

/** Open a committed immutable generation without waiting for source reconciliation. */
export async function loadIndexGeneration(
  projectRoot: string,
  cacheDir = '.codebuff-index',
  options?: {
    expectedSnapshotId?: string
    migrateLegacy?: boolean
    onDiscovery?: (index: MetadataIndex) => void
  },
): Promise<MetadataIndex | null> {
  const opened = await openIndexStorage(projectRoot, cacheDir)
  const loaded = await readGeneration(opened, projectRoot)
  if (loaded) {
    if (
      options?.expectedSnapshotId !== undefined &&
      loaded.manifest.snapshotId !== options.expectedSnapshotId
    )
      return null
    options?.onDiscovery?.(loaded.index)
    return loaded.index
  }
  if (options?.migrateLegacy === false) return null
  const previousDiscovery = await loadLegacyIndex(
    projectRoot,
    cacheDir,
    options,
  )
  if (!previousDiscovery) return null
  options?.onDiscovery?.({
    ...withoutStaleScipProjection(previousDiscovery),
    repositoryId: opened.identity.repositoryId,
    worktreeId: opened.identity.worktreeId,
    freshness: 'unverified',
  })
  return withCacheLock(getIndexDir(projectRoot, cacheDir), async () => {
    const concurrent = await readGeneration(opened, projectRoot)
    if (concurrent) return concurrent.index
    const legacy = await loadLegacyIndex(projectRoot, cacheDir, options)
    if (!legacy) return null
    const upgraded: MetadataIndex = {
      ...withoutStaleScipProjection(legacy),
      repositoryId: opened.identity.repositoryId,
      worktreeId: opened.identity.worktreeId,
      freshness: 'unverified',
    }
    // Legacy parsing/configuration identities are unknown. Preserve summaries
    // for discovery, but do not label them as current parser output. Keeping
    // the legacy ownership lock through publication excludes legacy writers.
    const saved = await publishIndexGeneration(
      upgraded,
      projectRoot,
      cacheDir,
      {
        expectedPublicationToken: null,
      },
    )
    if (!saved)
      return (await readGeneration(opened, projectRoot))?.index ?? upgraded
    return upgraded
  })
}

export interface PublishIndexGenerationOptions {
  expectedBuiltAt?: number | null
  expectedSnapshotId?: string | null
  expectedPublicationToken?: string | null
  onVerifiedWrite?: (verified: boolean) => void
}

/**
 * Stage immutable facts in bounded batches, then atomically CAS the small
 * generation head and journal checkpoint. Failed publication leaves the last
 * valid generation available; staged objects have no authority until reachable.
 */
export async function saveIndexGeneration(
  index: MetadataIndex,
  projectRoot: string,
  cacheDir = '.codebuff-index',
  options: PublishIndexGenerationOptions = {},
): Promise<boolean> {
  options.onVerifiedWrite?.(false)
  await getIndexStorageIdentity(projectRoot, cacheDir)
  return withCacheLock(getIndexDir(projectRoot, cacheDir), () =>
    publishIndexGeneration(index, projectRoot, cacheDir, options),
  )
}

async function publishIndexGeneration(
  index: MetadataIndex,
  projectRoot: string,
  cacheDir: string,
  options: PublishIndexGenerationOptions,
): Promise<boolean> {
  const opened = await openIndexStorage(projectRoot, cacheDir)
  const { identity, store } = opened
  const current = await readGeneration(opened, projectRoot)
  const currentToken = current?.headVersion ?? null
  if (
    (has(options, 'expectedPublicationToken') &&
      options.expectedPublicationToken !== currentToken) ||
    (has(options, 'expectedBuiltAt') &&
      options.expectedBuiltAt !== (current?.manifest.builtAt ?? null)) ||
    (has(options, 'expectedSnapshotId') &&
      options.expectedSnapshotId !== (current?.manifest.snapshotId ?? null)) ||
    (current && current.manifest.builtAt > index.builtAt)
  )
    return false
  if (index.projectRoot !== projectRoot)
    throw new Error('Index publication belongs to another project root')

  index.repositoryId = identity.repositoryId
  index.worktreeId = identity.worktreeId
  const scope = indexStorageScope(identity)
  const objectScope: IndexStorageScope = {
    repositoryId: identity.repositoryId,
    worktreeId: '@objects',
  }
  const { acquireIndexPublicationLease, collectIndexGarbage } =
    await import('./index-retention')
  const lease = await acquireIndexPublicationLease(store, objectScope)
  const generationId = randomUUID()
  const checkpoint =
    !current || current.manifest.depth >= CHECKPOINT_GENERATIONS
  const gathered = gatherFacts(index, current)
  const references = new Map<FactTable, Map<string, string>>()
  const objectPuts = new Map<string, IndexStoragePut>()
  const projectionPuts: IndexStoragePut[] = []
  for (const table of TABLES) {
    const currentFacts = current?.facts.get(table)
    const currentReferences = current?.references.get(table)
    const tableReferences = new Map<string, string>()
    references.set(table, tableReferences)
    for (const [key, payload] of gathered.facts.get(table) ?? []) {
      let objectKey = currentReferences?.get(key)
      const parseIdentityChanged =
        table === 'parses' &&
        (current?.index.files[key]?.hash !== index.files[key]?.hash ||
          current?.index.parseFingerprints?.[key] !==
            index.parseFingerprints?.[key])
      if (
        !objectKey ||
        parseIdentityChanged ||
        !sameFact(table, currentFacts?.get(key), payload)
      ) {
        const object: ContentObject = {
          schemaVersion: 1,
          kind: table,
          payload,
          ...(table === 'parses'
            ? {
                source: {
                  hash: index.files[key]!.hash,
                  language: index.files[key]!.ext,
                  extractionFingerprint:
                    index.parseFingerprints?.[key] ?? 'legacy-unverified',
                },
              }
            : {}),
        }
        objectKey = contentObjectKey(object)
        objectPuts.set(objectKey, {
          scope: objectScope,
          table: 'objects',
          key: objectKey,
          value: object,
        })
      }
      tableReferences.set(key, objectKey)
      if (checkpoint || currentReferences?.get(key) !== objectKey) {
        projectionPuts.push({
          scope,
          table,
          key: `${generationId}/${key}`,
          value: { objectKey } satisfies ObjectReference,
        })
      }
    }
    if (!checkpoint) {
      for (const key of currentReferences?.keys() ?? []) {
        if (!tableReferences.has(key)) {
          projectionPuts.push({
            scope,
            table,
            key: `${generationId}/${key}`,
            value: { objectKey: null } satisfies ObjectReference,
          })
        }
      }
    }
  }

  let writes = 0
  // Content-addressed parse objects are shared safely across worktrees. Query
  // before writing avoids replacing already-present immutable values.
  const objectKeys = Array.from(objectPuts.keys())
  for (let offset = 0; offset < objectKeys.length; offset += MAX_BATCH_ROWS) {
    const keys = objectKeys.slice(offset, offset + MAX_BATCH_ROWS)
    const existingObjects = await queryAllIndexStorage<ContentObject>(store, {
      scope: objectScope,
      table: 'objects',
      keys,
    })
    for (const record of existingObjects) {
      if (
        record.value.schemaVersion === 1 &&
        contentObjectKey(record.value) === record.key
      )
        objectPuts.delete(record.key)
    }
  }
  writes += await putInBatches(store, Array.from(objectPuts.values()))
  writes += await putInBatches(store, projectionPuts)

  const manifest: IndexGenerationManifest = {
    schemaVersion: 1,
    generationId,
    ...(current ? { parentGenerationId: current.manifest.generationId } : {}),
    checkpoint,
    depth: checkpoint ? 0 : current!.manifest.depth + 1,
    projectRoot: identity.projectRoot,
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    indexVersion: index.version,
    snapshotId: computeIndexSnapshotId(index),
    builtAt: index.builtAt,
    fileCount: index.fileCount,
    nextEdgeOrder: gathered.nextEdgeOrder,
    indexedJournalCursor:
      index.indexedJournalCursor ?? current?.manifest.indexedJournalCursor ?? 0,
    workspaceRevision: index.workspaceRevision,
    graphConfigFingerprint: index.graphConfigFingerprint,
    sourceConfigFingerprint: index.sourceConfigFingerprint,
    parseDiagnostics: index.parseDiagnostics,
    coverage: index.coverage,
    parserDegraded: index.parserDegraded,
    freshness: index.freshness,
    unverifiedPaths: index.unverifiedPaths,
  }
  const head: GenerationHead = {
    generationId,
    parentGenerationId: current?.manifest.generationId,
    builtAt: manifest.builtAt,
    snapshotId: manifest.snapshotId,
  }
  const publication = await store.batch({
    checks: [
      { scope, table: 'state', key: 'head', expectedVersion: currentToken },
      {
        scope: objectScope,
        table: 'state',
        key: 'retention-lease',
        expectedVersion: lease?.version ?? null,
      },
    ],
    puts: [
      { scope, table: 'generations', key: generationId, value: manifest },
      { scope, table: 'state', key: 'head', value: head },
      {
        scope,
        table: 'state',
        key: 'checkpoint',
        value: {
          indexedJournalCursor: manifest.indexedJournalCursor,
          generationId,
        },
      },
      {
        scope: objectScope,
        table: 'worktrees',
        key: scope.worktreeId,
        value: { worktreeId: scope.worktreeId, generationId },
      },
    ],
  })
  if (!publication.committed) return false
  const headVersion = publication.versions.find(
    (entry) => entry.table === 'state' && entry.key === 'head',
  )!.version
  index.generationId = generationId
  index.indexedJournalCursor = manifest.indexedJournalCursor
  if (index.updateStats)
    index.updateStats.persistenceWrites = writes + publication.writes
  setIndexPublicationToken(index, headVersion)
  // Match the cold reader even when a caller publishes a legacy graph.
  const discovery = withoutStaleScipProjection(index)
  if (discovery !== index) setIndexPublicationToken(discovery, headVersion)
  loadedGenerations.set(store, {
    index: discovery,
    manifest,
    headVersion,
    references,
    facts: gathered.facts,
  })
  await atomicWrite(
    path.join(getIndexDir(projectRoot, cacheDir), NORMALIZED_INDEX_MARKER),
    '1\n',
  )
  options.onVerifiedWrite?.(true)
  if (checkpoint && current) {
    try {
      await collectIndexGarbage(projectRoot, cacheDir)
    } catch (error) {
      console.debug('[indexer] index retention deferred:', error)
    }
  }
  return true
}

export interface IndexMutationJournalEntry {
  sequence: number
  timestamp: number
  kind: 'mutation' | 'coverage-gap'
  delta: IndexMutationDelta
}

/** Sequenced, durable watcher/mutation journal with optimistic concurrent append. */
export async function recordIndexMutation(
  projectRoot: string,
  delta: IndexMutationDelta,
  cacheDir = '.codebuff-index',
): Promise<number> {
  const { store, identity } = await openIndexStorage(projectRoot, cacheDir)
  const scope = indexStorageScope(identity)
  for (let attempt = 0; attempt < 64; attempt++) {
    const cursor = await store.get<{ sequence: number }>({
      scope,
      table: 'state',
      key: 'journal',
    })
    const sequence = (cursor?.value.sequence ?? 0) + 1
    const entry: IndexMutationJournalEntry = {
      sequence,
      timestamp: Date.now(),
      kind:
        delta.coverageGap || delta.complete !== true
          ? 'coverage-gap'
          : 'mutation',
      delta,
    }
    const result = await store.batch({
      checks: [
        {
          scope,
          table: 'state',
          key: 'journal',
          expectedVersion: cursor?.version ?? null,
        },
      ],
      puts: [
        {
          scope,
          table: 'journal',
          key: String(sequence).padStart(16, '0'),
          value: entry,
        },
        { scope, table: 'state', key: 'journal', value: { sequence } },
      ],
    })
    if (result.committed) return sequence
  }
  throw new Error('Index mutation journal append lost repeated CAS races')
}

export async function loadIndexMutationJournal(
  projectRoot: string,
  after = 0,
  cacheDir = '.codebuff-index',
): Promise<IndexMutationJournalEntry[]> {
  const { store, identity } = await openIndexStorage(projectRoot, cacheDir)
  const scope = indexStorageScope(identity)
  const entries = await queryAllIndexStorage<IndexMutationJournalEntry>(store, {
    scope,
    table: 'journal',
    after: String(after).padStart(16, '0'),
  })
  return entries
    .map((record) => record.value)
    .filter((entry) => entry.sequence > after)
}

async function readGeneration(
  opened: OpenStorage,
  projectRoot: string,
): Promise<LoadedGeneration | null> {
  const { store, identity } = opened
  const scope = indexStorageScope(identity)
  const head = await store.get<GenerationHead>({
    scope,
    table: 'state',
    key: 'head',
  })
  if (!head) return null
  const cached = loadedGenerations.get(store)
  if (
    cached?.headVersion === head.version &&
    cached.index.projectRoot === projectRoot
  )
    return cached
  let generationId: string | undefined = head.value.generationId
  const visited = new Set<string>()
  while (generationId && !visited.has(generationId)) {
    visited.add(generationId)
    const record = await store.get<IndexGenerationManifest>({
      scope,
      table: 'generations',
      key: generationId,
    })
    if (!record || !validManifest(record.value, opened.identity)) {
      generationId =
        generationId === head.value.generationId
          ? head.value.parentGenerationId
          : undefined
      continue
    }
    try {
      const references = await readGenerationReferences(
        store,
        scope,
        record.value,
      )
      const facts = await readGenerationFacts(store, scope, references)
      const index = hydrateIndex(projectRoot, record.value, facts)
      if (computeIndexSnapshotId(index) !== record.value.snapshotId)
        throw new Error('Index generation source manifest is corrupt')
      const loaded: LoadedGeneration = {
        index,
        manifest: record.value,
        headVersion: head.version,
        references,
        facts,
      }
      setIndexPublicationToken(index, head.version)
      loadedGenerations.set(store, loaded)
      return loaded
    } catch {
      // An interrupted/corrupt derived generation does not erase a valid
      // committed parent. Its immutable objects are still independently read.
      generationId = record.value.parentGenerationId
    }
  }
  return null
}

export async function readGenerationReferences(
  store: IndexStoragePort,
  scope: IndexStorageScope,
  manifest: IndexGenerationManifest,
): Promise<Map<FactTable, Map<string, string>>> {
  const references = new Map<FactTable, Map<string, string>>()
  const seen = new Map<FactTable, Set<string>>()
  for (const table of TABLES) {
    references.set(table, new Map())
    seen.set(table, new Set())
  }
  let current: IndexGenerationManifest | undefined = manifest
  const visited = new Set<string>()
  while (current) {
    if (visited.has(current.generationId))
      throw new Error('Cyclic index generation manifest')
    if (visited.size >= CHECKPOINT_GENERATIONS + 1)
      throw new Error('Index generation checkpoint depth exceeded')
    visited.add(current.generationId)
    const prefix = `${current.generationId}/`
    const tableRecords = await Promise.all(
      TABLES.map(async (table) => ({
        table,
        records: await queryAllIndexStorage<ObjectReference>(store, {
          scope,
          table,
          prefix,
        }),
      })),
    )
    for (const { table, records } of tableRecords) {
      for (const record of records) {
        const key = record.key.slice(prefix.length)
        if (seen.get(table)!.has(key)) continue
        seen.get(table)!.add(key)
        if (typeof record.value.objectKey === 'string')
          references.get(table)!.set(key, record.value.objectKey)
        else if (record.value.objectKey !== null)
          throw new Error('Invalid index object reference')
      }
    }
    if (current.checkpoint) break
    if (!current.parentGenerationId)
      throw new Error('Missing index generation checkpoint')
    current = (
      await store.get<IndexGenerationManifest>({
        scope,
        table: 'generations',
        key: current.parentGenerationId,
      })
    )?.value
    if (!current) throw new Error('Missing parent index generation')
  }
  return references
}

async function readGenerationFacts(
  store: IndexStoragePort,
  scope: IndexStorageScope,
  references: Map<FactTable, Map<string, string>>,
): Promise<Map<FactTable, Map<string, unknown>>> {
  const objectScope = {
    repositoryId: scope.repositoryId,
    worktreeId: '@objects',
  }
  const objects = new Map<string, ContentObject>()
  const keys = Array.from(
    new Set(
      Array.from(references.values()).flatMap((table) =>
        Array.from(table.values()),
      ),
    ),
  )
  for (
    let offset = 0;
    offset < keys.length;
    offset += MAX_BATCH_ROWS * MAX_OBJECT_READ_CONCURRENCY
  ) {
    const batches: string[][] = []
    for (let batch = 0; batch < MAX_OBJECT_READ_CONCURRENCY; batch++) {
      const start = offset + batch * MAX_BATCH_ROWS
      if (start >= keys.length) break
      batches.push(keys.slice(start, start + MAX_BATCH_ROWS))
    }
    const pages = await Promise.all(
      batches.map((batchKeys) =>
        queryAllIndexStorage<ContentObject>(store, {
          scope: objectScope,
          table: 'objects',
          keys: batchKeys,
          limit: MAX_BATCH_ROWS,
        }),
      ),
    )
    for (const records of pages)
      for (const record of records) {
        if (
          record.value.schemaVersion !== 1 ||
          contentObjectKey(record.value) !== record.key
        )
          throw new Error('Corrupt index content object')
        objects.set(record.key, record.value)
      }
  }
  const facts = new Map<FactTable, Map<string, unknown>>()
  for (const table of TABLES) {
    const entries = new Map<string, unknown>()
    facts.set(table, entries)
    for (const [key, objectKey] of references.get(table) ?? []) {
      const object = objects.get(objectKey)
      if (!object || object.kind !== table)
        throw new Error('Missing index content object')
      entries.set(key, object.payload)
    }
  }
  return facts
}

function hydrateIndex(
  projectRoot: string,
  manifest: IndexGenerationManifest,
  facts: Map<FactTable, Map<string, unknown>>,
): MetadataIndex {
  const files = Object.fromEntries(facts.get('files') ?? []) as Record<
    string,
    IndexedFile
  >
  for (const [key, file] of Object.entries(files)) {
    if (
      file.path !== key ||
      typeof file.hash !== 'string' ||
      !Array.isArray(file.symbols) ||
      !Array.isArray(file.imports) ||
      !Array.isArray(file.concepts) ||
      !Array.isArray(file.headings)
    ) {
      throw new Error('Invalid indexed file in generation')
    }
  }
  const nodes = Object.fromEntries(facts.get('nodes') ?? []) as Record<
    string,
    IndexNode
  >
  const edgeFacts = Array.from(facts.get('edges') ?? [])
    .map(([key, value]) => {
      const fact = value as EdgeFact
      assertOpaqueEdgeKey(key, fact.edge)
      return [key, fact] as const
    })
    .sort((a, b) => a[1].order - b[1].order)
  const edges = edgeFacts.map(([, fact]) => fact.edge)
  const edgeIndexes = new Map(edgeFacts.map(([key], index) => [key, index]))
  const edgeByKey = new Map(edgeFacts.map(([key, fact]) => [key, fact.edge]))
  const structuralEdges = new Map(
    Array.from(facts.get('structural_edges') ?? []).map(([key, value]) => {
      const edge = value as IndexEdge
      assertOpaqueEdgeKey(key, edge)
      return [key, edge] as const
    }),
  )
  const graph: IndexGraph = { nodes, edges }
  const postings: Record<string, string[]> = Object.create(null)
  const documentFrequencies: Record<string, number> = Object.create(null)
  for (const [key, value] of facts.get('postings') ?? []) {
    const posting = value as PostingFact
    postings[key] = posting.paths
    documentFrequencies[key] = posting.documentFrequency
  }
  const adjacency: Record<string, number[]> = {}
  for (const [key, value] of facts.get('adjacency') ?? []) {
    adjacency[key] = (value as string[])
      .map((edgeKey) => {
        const index = edgeIndexes.get(edgeKey)
        if (index === undefined) throw new Error('Invalid adjacency object')
        return index
      })
      .sort((a, b) => a - b)
  }
  const graphData: Record<string, IndexGraph> = {}
  for (const [key, value] of facts.get('graph_files') ?? []) {
    const fact = value as GraphFileFact
    graphData[key] = {
      nodes: Object.fromEntries(
        fact.nodes
          .map((nodeId) => [nodeId, nodes[nodeId]])
          .filter(([, node]) => node),
      ),
      edges: fact.edges
        .map(
          (edgeKey) => structuralEdges.get(edgeKey) ?? edgeByKey.get(edgeKey),
        )
        .filter((edge): edge is IndexEdge => Boolean(edge)),
    }
  }
  const index: MetadataIndex = {
    version: manifest.indexVersion,
    projectRoot,
    repositoryId: manifest.repositoryId,
    worktreeId: manifest.worktreeId,
    generationId: manifest.generationId,
    builtAt: manifest.builtAt,
    fileCount: Object.keys(files).length,
    files,
    graph,
    queryData: { postings, documentFrequencies, adjacency },
    parseData: Object.fromEntries(facts.get('parses') ?? []) as Record<
      string,
      ParsedFileTokens
    >,
    parseFingerprints: facts.get('parse_metadata')?.size
      ? (Object.fromEntries(facts.get('parse_metadata')!) as Record<
          string,
          string
        >)
      : undefined,
    graphData: facts.get('graph_files')?.size ? graphData : undefined,
    graphConfigFingerprint: manifest.graphConfigFingerprint,
    sourceConfigFingerprint: manifest.sourceConfigFingerprint,
    graphDependencies: facts.get('graph_files')?.size
      ? {
          definitions: Object.assign(
            Object.create(null),
            Object.fromEntries(facts.get('definitions') ?? []),
          ) as Record<string, string[]>,
          callers: Object.assign(
            Object.create(null),
            Object.fromEntries(facts.get('callers') ?? []),
          ) as Record<string, string[]>,
        }
      : undefined,
    parseDiagnostics: manifest.parseDiagnostics,
    coverage: manifest.coverage,
    parserDegraded: manifest.parserDegraded,
    workspaceRevision: manifest.workspaceRevision,
    indexedJournalCursor: manifest.indexedJournalCursor,
    freshness: manifest.freshness,
    unverifiedPaths: manifest.unverifiedPaths,
  }
  return withoutStaleScipProjection(index)
}

function gatherFacts(
  index: MetadataIndex,
  current: LoadedGeneration | null,
): {
  facts: Map<FactTable, Map<string, unknown>>
  nextEdgeOrder: number
} {
  const facts = new Map<FactTable, Map<string, unknown>>()
  for (const table of TABLES) facts.set(table, new Map())
  for (const [key, value] of Object.entries(index.files))
    facts.get('files')!.set(key, value)
  for (const [key, value] of Object.entries(index.parseData ?? {})) {
    if (index.files[key]) facts.get('parses')!.set(key, value)
  }
  for (const [key, value] of Object.entries(index.parseFingerprints ?? {})) {
    if (index.files[key]) facts.get('parse_metadata')!.set(key, value)
  }
  for (const [key, value] of Object.entries(
    index.graphDependencies?.definitions ?? {},
  ))
    facts.get('definitions')!.set(key, value)
  for (const [key, value] of Object.entries(
    index.graphDependencies?.callers ?? {},
  ))
    facts.get('callers')!.set(key, value)
  for (const [key, value] of Object.entries(index.graph.nodes))
    facts.get('nodes')!.set(key, value)
  let nextEdgeOrder = current?.manifest.nextEdgeOrder ?? 0
  const adjacency = new Map<string, string[]>()
  for (const edge of index.graph.edges) {
    const key = stableIndexEdgeKey(edge)
    const previous = current?.facts.get('edges')?.get(key) as
      | EdgeFact
      | undefined
    facts.get('edges')!.set(key, {
      edge,
      order: previous?.order ?? nextEdgeOrder++,
    } satisfies EdgeFact)
    ;(
      adjacency.get(edge.from) ?? adjacency.set(edge.from, []).get(edge.from)!
    ).push(key)
    if (edge.to !== edge.from)
      (adjacency.get(edge.to) ?? adjacency.set(edge.to, []).get(edge.to)!).push(
        key,
      )
  }
  const queryData =
    index.queryData ?? buildIndexQueryData(index.files, index.graph)
  for (const [key, paths] of Object.entries(queryData.postings)) {
    facts.get('postings')!.set(key, {
      paths,
      documentFrequency: queryData.documentFrequencies[key] ?? paths.length,
    } satisfies PostingFact)
  }
  for (const [key, edges] of adjacency)
    facts.get('adjacency')!.set(key, edges.sort())
  for (const [key, value] of Object.entries(index.graphData ?? {})) {
    for (const edge of value.edges)
      facts.get('structural_edges')!.set(stableIndexEdgeKey(edge), edge)
    facts.get('graph_files')!.set(key, {
      nodes: Object.keys(value.nodes).sort(),
      edges: value.edges.map(stableIndexEdgeKey).sort(),
    } satisfies GraphFileFact)
  }
  return { facts, nextEdgeOrder }
}

export function stableIndexEdgeKey(edge: IndexEdge): string {
  const identity = [
    edge.from,
    edge.to,
    edge.type,
    edge.identityDigest === undefined ? (edge.label ?? '') : null,
    edge.confidence ?? 'heuristic',
    edge.producer?.name ?? '',
  ]
  // Keep the serialized preimage byte-for-byte for edges without a digest.
  // With a digest, the display label can change without changing identity.
  if (edge.identityDigest !== undefined) identity.push(edge.identityDigest)
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

function assertOpaqueEdgeKey(key: string, edge: IndexEdge): void {
  if (edge.identityDigest !== undefined && stableIndexEdgeKey(edge) !== key) {
    throw new Error('Invalid opaque identity in index edge projection')
  }
}

function sameFact(table: FactTable, previous: unknown, next: unknown): boolean {
  if (previous === next) return true
  if (table === 'edges') {
    const before = previous as EdgeFact | undefined
    const after = next as EdgeFact
    if (before?.edge === after.edge && before.order === after.order) return true
  }
  if (table === 'postings') {
    const before = previous as PostingFact | undefined
    const after = next as PostingFact
    if (
      before?.paths === after.paths &&
      before.documentFrequency === after.documentFrequency
    )
      return true
  }
  return (
    previous !== undefined && canonicalJson(previous) === canonicalJson(next)
  )
}

function contentObjectKey(object: ContentObject): string {
  return createHash('sha256')
    .update('index-object:1\0')
    .update(canonicalJson(object))
    .digest('hex')
}

async function putInBatches(
  store: IndexStoragePort,
  puts: IndexStoragePut[],
): Promise<number> {
  let batch: IndexStoragePut[] = []
  let bytes = 0
  let writes = 0
  const flush = async () => {
    if (batch.length === 0) return
    const result = await store.batch({ puts: batch })
    if (!result.committed)
      throw new Error('Index storage refused immutable staging batch')
    writes += result.writes
    batch = []
    bytes = 0
  }
  for (const put of puts) {
    const size = Buffer.byteLength(JSON.stringify(put))
    if (
      batch.length >= MAX_BATCH_ROWS ||
      (bytes + size > MAX_OBJECT_BATCH_BYTES && batch.length)
    )
      await flush()
    batch.push(put)
    bytes += size
  }
  await flush()
  return writes
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function validManifest(
  manifest: IndexGenerationManifest,
  identity: IndexStorageIdentity,
): boolean {
  return (
    manifest?.schemaVersion === 1 &&
    manifest.indexVersion === '2' &&
    manifest.repositoryId === identity.repositoryId &&
    manifest.worktreeId === identity.worktreeId &&
    typeof manifest.generationId === 'string' &&
    Number.isFinite(manifest.builtAt) &&
    typeof manifest.snapshotId === 'string'
  )
}

function has(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

async function findGitDirectories(
  projectRoot: string,
): Promise<{ gitDir: string; commonDir: string } | undefined> {
  try {
    let gitDir = path.join(projectRoot, '.git')
    const stat = await fs.stat(gitDir)
    if (stat.isFile()) {
      const pointer = await fs.readFile(gitDir, 'utf8')
      const match = /^gitdir:\s*(.+)\s*$/m.exec(pointer)
      if (!match) return undefined
      gitDir = path.resolve(projectRoot, match[1]!.trim())
    }
    const worktreeGitDir = await fs.realpath(gitDir)
    try {
      const common = (
        await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')
      ).trim()
      gitDir = path.resolve(gitDir, common)
    } catch {
      /* Main worktree. */
    }
    return { gitDir: worktreeGitDir, commonDir: await fs.realpath(gitDir) }
  } catch {
    return undefined
  }
}

async function readOrCreateId(filePath: string): Promise<string> {
  try {
    const existing = (await fs.readFile(filePath, 'utf8')).trim()
    if (validIdentity(existing)) return existing
  } catch {
    /* New repository. */
  }
  const id = randomUUID()
  try {
    await fs.writeFile(filePath, `${id}\n`, { flag: 'wx' })
    return id
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = (await fs.readFile(filePath, 'utf8')).trim()
    if (!validIdentity(existing))
      throw new Error('Invalid persisted repository identity')
    return existing
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx')
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, filePath)
}
