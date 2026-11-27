/** Versioned storage boundary shared by embedded and repository-service stores. */
export const INDEX_STORAGE_PROTOCOL_VERSION = 1 as const

export interface IndexStorageScope {
  repositoryId: string
  /** Worktree state is isolated. Immutable content objects use `@objects`. */
  worktreeId: string
}

export interface IndexStorageIdentity extends IndexStorageScope {
  projectRoot: string
  gitCommonDir?: string
}

export function indexStorageScope(
  identity: IndexStorageScope,
): IndexStorageScope {
  return {
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
  }
}

export interface IndexStorageRecord<T = unknown> {
  key: string
  /** Opaque, backend-issued version for compare-and-swap. */
  version: string
  value: T
}

export interface IndexStorageKey {
  scope: IndexStorageScope
  table: string
  key: string
}

export interface IndexStorageQuery {
  scope: IndexStorageScope
  table: string
  prefix?: string
  /** Exclusive key cursor; well-formed Unicode keys use UTF-8 byte order. */
  after?: string
  keys?: string[]
  limit?: number
}

export interface IndexStorageQueryResult<T = unknown> {
  records: IndexStorageRecord<T>[]
  /** Pass as `after` to continue. Absent when the query is exhausted. */
  cursor?: string
}

export interface IndexStorageCheck extends IndexStorageKey {
  /** `null` requires absence. */
  expectedVersion: string | null
}

export interface IndexStoragePut extends IndexStorageKey {
  value: unknown
}

export interface IndexStorageBatch {
  checks?: IndexStorageCheck[]
  puts?: IndexStoragePut[]
  deletes?: IndexStorageKey[]
}

export interface IndexStorageBatchResult {
  committed: boolean
  writes: number
  versions: Array<IndexStorageKey & { version: string }>
}

export interface IndexStorageStats {
  backend: string
  records: number
  bytes: number
  transactions: number
  writes: number
}

/**
 * A batch checks every expected version and publishes all changes atomically.
 * Failed checks produce no writes. Queries are paginated and never truncate
 * silently. Implementations must preserve these semantics across processes.
 */
export interface IndexStoragePort {
  readonly protocolVersion: typeof INDEX_STORAGE_PROTOCOL_VERSION
  get<T = unknown>(
    request: IndexStorageKey,
  ): Promise<IndexStorageRecord<T> | null>
  query<T = unknown>(
    request: IndexStorageQuery,
  ): Promise<IndexStorageQueryResult<T>>
  batch(request: IndexStorageBatch): Promise<IndexStorageBatchResult>
  stats(request?: { scope?: IndexStorageScope }): Promise<IndexStorageStats>
  close(): Promise<void>
}

export interface IndexStorageFactoryOptions {
  directory: string
  identity: IndexStorageIdentity
}

export type IndexStorageFactory = (
  options: IndexStorageFactoryOptions,
) => Promise<IndexStoragePort>

let configuredFactory: IndexStorageFactory | undefined

/** Install a service-backed or SDK-provided store before opening an index. */
export function setIndexStorageFactory(
  factory: IndexStorageFactory | undefined,
): void {
  configuredFactory = factory
}

export function getIndexStorageFactory(): IndexStorageFactory | undefined {
  return configuredFactory
}

export function compareIndexStorageKeys(first: string, second: string): number {
  return Buffer.compare(Buffer.from(first, 'utf8'), Buffer.from(second, 'utf8'))
}

/** Smallest Unicode scalar prefix greater than every key under this prefix. */
export function indexStoragePrefixUpperBound(
  prefix: string,
): string | undefined {
  const characters = Array.from(prefix)
  while (characters.length) {
    const last = characters.pop()!.codePointAt(0)!
    if (last === 0x10ffff) continue
    characters.push(String.fromCodePoint(last === 0xd7ff ? 0xe000 : last + 1))
    return characters.join('')
  }
  return undefined
}

export function validateIndexStorageScope(scope: IndexStorageScope): void {
  for (const value of [scope.repositoryId, scope.worktreeId]) {
    if (
      !isStorageText(value) ||
      !value.length ||
      Buffer.byteLength(value, 'utf8') > 256
    )
      throw new Error('Invalid repository scope')
  }
}

export function validateIndexStorageKey(request: IndexStorageKey): void {
  validateIndexStorageScope(request.scope)
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(request.table) ||
    !isStorageText(request.key) ||
    !request.key.length ||
    Buffer.byteLength(request.key, 'utf8') > 8192
  ) {
    throw new Error('Invalid storage key')
  }
}

export function validateIndexStorageQuery(request: IndexStorageQuery): void {
  validateIndexStorageKey({ ...request, key: 'query' })
  if (
    (request.prefix !== undefined && !isStorageText(request.prefix)) ||
    (request.after !== undefined && !isStorageText(request.after))
  )
    throw new Error('Invalid storage cursor or prefix')
  if (request.keys && request.keys.length > 4096)
    throw new Error('Key filter budget exceeded')
  for (const key of request.keys ?? [])
    validateIndexStorageKey({ ...request, key })
}

function isStorageText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.from(value, 'utf8').toString('utf8') === value
  )
}

export async function queryAllIndexStorage<T>(
  store: IndexStoragePort,
  request: IndexStorageQuery,
): Promise<IndexStorageRecord<T>[]> {
  const records: IndexStorageRecord<T>[] = []
  let after: string | undefined = request.after
  do {
    const page = await store.query<T>({ ...request, after })
    records.push(...page.records)
    if (page.cursor !== undefined && page.cursor === after) {
      throw new Error('Index storage returned a non-advancing cursor')
    }
    after = page.cursor
  } while (after !== undefined)
  return records
}
