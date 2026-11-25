import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  INDEX_STORAGE_PROTOCOL_VERSION,
  compareIndexStorageKeys,
  indexStoragePrefixUpperBound,
  validateIndexStorageKey,
  validateIndexStorageQuery,
  validateIndexStorageScope,
  type IndexStorageBatch,
  type IndexStorageBatchResult,
  type IndexStorageFactoryOptions,
  type IndexStorageKey,
  type IndexStoragePort,
  type IndexStorageQuery,
  type IndexStorageQueryResult,
  type IndexStorageRecord,
  type IndexStorageScope,
  type IndexStorageStats,
} from './storage-port'

const DEFAULT_PAGE_SIZE = 512
const MAX_PAGE_SIZE = 4_096

interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | null
  all(...params: unknown[]): Record<string, unknown>[]
  run(...params: unknown[]): unknown
}

interface SqliteDatabase {
  exec(sql: string): void
  query(sql: string): SqliteStatement
  close(): void
}

/** Dynamic import keeps SDK/Node consumers free of Bun-only module loading. */
export async function createEmbeddedIndexStorage(
  options: IndexStorageFactoryOptions,
): Promise<IndexStoragePort> {
  // Git worktrees share immutable content in the common admin directory;
  // their mutable projections remain separated by worktree scope.
  const directory = options.identity.gitCommonDir
    ? path.join(options.identity.gitCommonDir, 'openbuff-index')
    : options.directory
  if (options.identity.gitCommonDir) {
    const { assertCacheOwnership, writeOwnerFile } =
      await import('./index-store')
    await assertCacheOwnership(directory)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await writeOwnerFile(directory)
  } else await fs.mkdir(directory, { recursive: true })
  if (typeof process.versions.bun === 'string') {
    const sqliteModule = 'bun:sqlite'
    const { Database } = await import(sqliteModule)
    return new SqliteIndexStorage(
      new Database(path.join(directory, 'index.sqlite'), {
        create: true,
      }) as SqliteDatabase,
    )
  }
  return DirectoryIndexStorage.open(path.join(directory, 'storage-v1'))
}

/** Normalized rows and one atomic publication/CAS transaction in SQLite WAL. */
export class SqliteIndexStorage implements IndexStoragePort {
  readonly protocolVersion = INDEX_STORAGE_PROTOCOL_VERSION

  constructor(private readonly database: SqliteDatabase) {
    database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS index_records (
        repository_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        key TEXT NOT NULL,
        version TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (repository_id, worktree_id, table_name, key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS index_store_counters (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        transactions INTEGER NOT NULL,
        writes INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO index_store_counters VALUES (1, 0, 0);
    `)
  }

  async get<T>(
    request: IndexStorageKey,
  ): Promise<IndexStorageRecord<T> | null> {
    validateIndexStorageKey(request)
    const row = this.database
      .query(
        'SELECT key, version, value FROM index_records WHERE repository_id=? AND worktree_id=? AND table_name=? AND key=?',
      )
      .get(...keyParameters(request))
    return row ? decodeSqliteRecord<T>(row) : null
  }

  async query<T>(
    request: IndexStorageQuery,
  ): Promise<IndexStorageQueryResult<T>> {
    validateIndexStorageQuery(request)
    const conditions = ['repository_id=?', 'worktree_id=?', 'table_name=?']
    const parameters: unknown[] = [
      request.scope.repositoryId,
      request.scope.worktreeId,
      request.table,
    ]
    if (request.prefix !== undefined) {
      conditions.push('key>=?')
      parameters.push(request.prefix)
      const upper = indexStoragePrefixUpperBound(request.prefix)
      if (upper !== undefined) {
        conditions.push('key<?')
        parameters.push(upper)
      }
    }
    if (request.after !== undefined) {
      conditions.push('key>?')
      parameters.push(request.after)
    }
    if (request.keys !== undefined) {
      if (request.keys.length === 0) return { records: [] }
      conditions.push(`key IN (${request.keys.map(() => '?').join(',')})`)
      parameters.push(...request.keys)
    }
    const limit = pageSize(request.limit)
    parameters.push(limit + 1)
    const rows = this.database
      .query(
        `SELECT key,version,value FROM index_records WHERE ${conditions.join(' AND ')} ORDER BY key LIMIT ?`,
      )
      .all(...parameters)
    const hasMore = rows.length > limit
    const records = rows.slice(0, limit).map(decodeSqliteRecord<T>)
    return {
      records,
      ...(hasMore ? { cursor: records[records.length - 1]!.key } : {}),
    }
  }

  async batch(request: IndexStorageBatch): Promise<IndexStorageBatchResult> {
    for (const key of [
      ...(request.checks ?? []),
      ...(request.puts ?? []),
      ...(request.deletes ?? []),
    ])
      validateIndexStorageKey(key)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const versionStatement = this.database.query(
        'SELECT version FROM index_records WHERE repository_id=? AND worktree_id=? AND table_name=? AND key=?',
      )
      for (const check of request.checks ?? []) {
        const row = versionStatement.get(...keyParameters(check))
        if ((row?.version ?? null) !== check.expectedVersion) {
          this.database.exec('ROLLBACK')
          return { committed: false, writes: 0, versions: [] }
        }
      }
      const putStatement = this.database.query(
        'INSERT INTO index_records VALUES (?,?,?,?,?,?) ON CONFLICT(repository_id,worktree_id,table_name,key) DO UPDATE SET version=excluded.version,value=excluded.value',
      )
      const versions: IndexStorageBatchResult['versions'] = []
      for (const put of request.puts ?? []) {
        const version = randomUUID()
        putStatement.run(
          ...keyParameters(put),
          version,
          JSON.stringify(put.value),
        )
        versions.push({
          scope: put.scope,
          table: put.table,
          key: put.key,
          version,
        })
      }
      const deleteStatement = this.database.query(
        'DELETE FROM index_records WHERE repository_id=? AND worktree_id=? AND table_name=? AND key=?',
      )
      for (const entry of request.deletes ?? []) {
        deleteStatement.run(...keyParameters(entry))
      }
      const writes =
        (request.puts?.length ?? 0) + (request.deletes?.length ?? 0)
      this.database
        .query(
          'UPDATE index_store_counters SET transactions=transactions+1,writes=writes+? WHERE id=1',
        )
        .run(writes)
      this.database.exec('COMMIT')
      return { committed: true, writes, versions }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async stats(request?: {
    scope?: IndexStorageScope
  }): Promise<IndexStorageStats> {
    const scope = request?.scope
    if (scope) validateIndexStorageScope(scope)
    const condition = scope ? ' WHERE repository_id=? AND worktree_id=?' : ''
    const params = scope ? [scope.repositoryId, scope.worktreeId] : []
    const row = this.database
      .query(
        `SELECT COUNT(*) AS records,COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM index_records${condition}`,
      )
      .get(...params)!
    const counters = this.database
      .query('SELECT transactions,writes FROM index_store_counters WHERE id=1')
      .get()!
    return {
      backend: 'bun-sqlite',
      records: Number(row.records),
      bytes: Number(row.bytes),
      transactions: Number(counters.transactions),
      writes: Number(counters.writes),
    }
  }

  async close(): Promise<void> {
    this.database.close()
  }
}

interface DirectoryReference extends IndexStorageKey {
  version: string | null
  bytes?: number
}

interface DirectoryTransaction {
  sequence: number
  records: DirectoryReference[]
}

interface DirectoryCheckpoint extends DirectoryTransaction {
  transactions: number
  writes: number
}

const DIRECTORY_CHECKPOINT_TRANSACTIONS = 128

/**
 * Portable normalized fallback. Values are immutable individual objects;
 * atomic transaction manifests contain only keys/versions. Readers never
 * observe partially written batches, and unchanged objects are never rewritten.
 */
export class DirectoryIndexStorage implements IndexStoragePort {
  readonly protocolVersion = INDEX_STORAGE_PROTOCOL_VERSION
  private readonly records = new Map<string, DirectoryReference>()
  private sequence = 0
  private transactions = 0
  private writes = 0
  private checkpointSequence = 0
  private checkpointStamp = ''
  private operationQueue: Promise<unknown> = Promise.resolve()
  private closed = false

  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<DirectoryIndexStorage> {
    const store = new DirectoryIndexStorage(directory)
    await fs.mkdir(path.join(directory, 'objects'), { recursive: true })
    await fs.mkdir(path.join(directory, 'transactions'), { recursive: true })
    await store.runLocked(() => store.refreshNow())
    return store
  }

  private async refreshNow(): Promise<void> {
    const checkpointPath = path.join(this.directory, 'checkpoint.json')
    const checkpointStat = await fs
      .stat(checkpointPath)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
    const stamp = checkpointStat
      ? `${checkpointStat.mtimeMs}:${checkpointStat.ctimeMs}:${checkpointStat.size}`
      : ''
    if (stamp !== this.checkpointStamp) {
      const checkpoint = JSON.parse(
        await fs.readFile(checkpointPath, 'utf8'),
      ) as DirectoryCheckpoint
      if (
        !Number.isSafeInteger(checkpoint.sequence) ||
        checkpoint.sequence < 0 ||
        !Array.isArray(checkpoint.records)
      ) {
        throw new Error('Invalid index storage checkpoint')
      }
      if (checkpoint.sequence > this.sequence) {
        this.records.clear()
        for (const record of checkpoint.records)
          this.records.set(recordIdentity(record), record)
        this.sequence = checkpoint.sequence
        this.transactions = checkpoint.transactions
        this.writes = checkpoint.writes
      }
      this.checkpointSequence = checkpoint.sequence
      this.checkpointStamp = stamp
    }
    const names = (await fs.readdir(path.join(this.directory, 'transactions')))
      .filter((name) => /^\d{16}\.json$/.test(name))
      .sort()
    for (const name of names) {
      const sequence = Number(name.slice(0, 16))
      if (sequence <= this.sequence) continue
      const transaction = JSON.parse(
        await fs.readFile(
          path.join(this.directory, 'transactions', name),
          'utf8',
        ),
      ) as DirectoryTransaction
      if (
        transaction.sequence !== this.sequence + 1 ||
        !Array.isArray(transaction.records)
      ) {
        throw new Error('Index storage transaction journal is incomplete')
      }
      for (const record of transaction.records) {
        const key = recordIdentity(record)
        if (record.version === null) this.records.delete(key)
        else this.records.set(key, record)
      }
      this.sequence = transaction.sequence
      this.transactions += 1
      this.writes += transaction.records.length
    }
  }

  private async readReference<T>(
    reference: DirectoryReference,
  ): Promise<IndexStorageRecord<T>> {
    const value = JSON.parse(
      await fs.readFile(this.objectPath(reference), 'utf8'),
    ) as T
    return { key: reference.key, version: reference.version!, value }
  }

  async get<T>(
    request: IndexStorageKey,
  ): Promise<IndexStorageRecord<T> | null> {
    validateIndexStorageKey(request)
    return this.runLocked(async () => {
      await this.refreshNow()
      const reference = this.records.get(recordIdentity(request))
      return reference ? this.readReference<T>(reference) : null
    })
  }

  async query<T>(
    request: IndexStorageQuery,
  ): Promise<IndexStorageQueryResult<T>> {
    validateIndexStorageQuery(request)
    return this.runLocked(async () => {
      await this.refreshNow()
      const keySet = request.keys ? new Set(request.keys) : undefined
      const references = Array.from(this.records.values())
        .filter(
          (record) =>
            record.scope.repositoryId === request.scope.repositoryId &&
            record.scope.worktreeId === request.scope.worktreeId &&
            record.table === request.table &&
            (request.prefix === undefined ||
              record.key.startsWith(request.prefix)) &&
            (request.after === undefined ||
              compareIndexStorageKeys(record.key, request.after) > 0) &&
            (!keySet || keySet.has(record.key)),
        )
        .sort((a, b) => compareIndexStorageKeys(a.key, b.key))
      const limit = pageSize(request.limit)
      const records = await Promise.all(
        references
          .slice(0, limit)
          .map((record) => this.readReference<T>(record)),
      )
      return {
        records,
        ...(references.length > limit
          ? { cursor: records[records.length - 1]!.key }
          : {}),
      }
    })
  }

  async batch(request: IndexStorageBatch): Promise<IndexStorageBatchResult> {
    for (const key of [
      ...(request.checks ?? []),
      ...(request.puts ?? []),
      ...(request.deletes ?? []),
    ])
      validateIndexStorageKey(key)
    return this.runLocked(async () => {
      await this.refreshNow()
      for (const check of request.checks ?? []) {
        const reference = this.records.get(recordIdentity(check))
        if ((reference?.version ?? null) !== check.expectedVersion) {
          return { committed: false, writes: 0, versions: [] }
        }
      }
      const references: DirectoryReference[] = []
      const versions: IndexStorageBatchResult['versions'] = []
      for (const put of request.puts ?? []) {
        const version = randomUUID()
        const content = JSON.stringify(put.value)
        const reference: DirectoryReference = {
          scope: put.scope,
          table: put.table,
          key: put.key,
          version,
          bytes: Buffer.byteLength(content),
        }
        await atomicWriteFile(this.objectPath(reference), content)
        references.push(reference)
        versions.push({
          scope: put.scope,
          table: put.table,
          key: put.key,
          version,
        })
      }
      for (const entry of request.deletes ?? []) {
        references.push({ ...entry, version: null })
      }
      const sequence = this.sequence + 1
      const transaction: DirectoryTransaction = {
        sequence,
        records: references,
      }
      await atomicWriteFile(
        path.join(
          this.directory,
          'transactions',
          `${String(sequence).padStart(16, '0')}.json`,
        ),
        JSON.stringify(transaction),
      )
      await this.refreshNow()
      if (
        this.sequence - this.checkpointSequence >=
        DIRECTORY_CHECKPOINT_TRANSACTIONS
      ) {
        await this.checkpointAndCollect()
      }
      return { committed: true, writes: references.length, versions }
    })
  }

  async stats(request?: {
    scope?: IndexStorageScope
  }): Promise<IndexStorageStats> {
    if (request?.scope) validateIndexStorageScope(request.scope)
    return this.runLocked(async () => {
      await this.refreshNow()
      const records = Array.from(this.records.values()).filter(
        (record) =>
          !request?.scope ||
          (record.scope.repositoryId === request.scope.repositoryId &&
            record.scope.worktreeId === request.scope.worktreeId),
      )
      return {
        backend: 'node-directory',
        records: records.length,
        bytes: records.reduce((sum, record) => sum + (record.bytes ?? 0), 0),
        transactions: this.transactions,
        writes: this.writes,
      }
    })
  }

  async close(): Promise<void> {
    this.closed = true
    await this.operationQueue
  }

  /** Readers hold the same lock as checkpoint collection until values are loaded. */
  private runLocked<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Index storage is closed'))
    const running = this.operationQueue.then(() =>
      this.withWriterLock(operation),
    )
    this.operationQueue = running.catch(() => {})
    return running
  }

  private async checkpointAndCollect(): Promise<void> {
    const checkpoint: DirectoryCheckpoint = {
      sequence: this.sequence,
      records: Array.from(this.records.values()),
      transactions: this.transactions,
      writes: this.writes,
    }
    const checkpointPath = path.join(this.directory, 'checkpoint.json')
    // Publish the complete reference checkpoint before discarding journal files.
    // A restart during collection can restore either the checkpoint or its tail.
    await atomicWriteFile(checkpointPath, JSON.stringify(checkpoint))
    this.checkpointSequence = checkpoint.sequence
    const stat = await fs.stat(checkpointPath)
    this.checkpointStamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
    const transactionDirectory = path.join(this.directory, 'transactions')
    for (const name of await fs.readdir(transactionDirectory)) {
      if (
        /^\d{16}\.json$/.test(name) &&
        Number(name.slice(0, 16)) <= this.checkpointSequence
      ) {
        await fs.unlink(path.join(transactionDirectory, name))
      }
    }
    const referencedObjects = new Set(
      Array.from(this.records.values()).map((reference) =>
        path.basename(this.objectPath(reference)),
      ),
    )
    const objectDirectory = path.join(this.directory, 'objects')
    for (const name of await fs.readdir(objectDirectory)) {
      if (/^[a-f0-9]{64}\.json$/.test(name) && !referencedObjects.has(name)) {
        await fs.unlink(path.join(objectDirectory, name))
      }
    }
    await syncDirectory(transactionDirectory)
    await syncDirectory(objectDirectory)
  }

  private objectPath(reference: DirectoryReference): string {
    const digest = createHash('sha256')
      .update(recordIdentity(reference))
      .update('\0')
      .update(reference.version!)
      .digest('hex')
    return path.join(this.directory, 'objects', `${digest}.json`)
  }

  private async withWriterLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.directory, '.writer.lock')
    const token = `${process.pid}\n${randomUUID()}\n`
    const deadline = Date.now() + 10_000
    let handle: Awaited<ReturnType<typeof fs.open>>
    for (;;) {
      try {
        handle = await fs.open(lockPath, 'wx')
        await handle.writeFile(token)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() >= deadline)
          throw new Error(
            `Index storage writer lock requires recovery: ${lockPath}`,
          )
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    try {
      return await operation()
    } finally {
      await handle.close()
      if ((await fs.readFile(lockPath, 'utf8').catch(() => '')) === token) {
        await fs.unlink(lockPath)
      }
    }
  }
}

function keyParameters(request: IndexStorageKey): unknown[] {
  return [
    request.scope.repositoryId,
    request.scope.worktreeId,
    request.table,
    request.key,
  ]
}

function decodeSqliteRecord<T>(
  row: Record<string, unknown>,
): IndexStorageRecord<T> {
  return {
    key: row.key as string,
    version: row.version as string,
    value: JSON.parse(row.value as string) as T,
  }
}

function pageSize(limit?: number): number {
  return Math.max(
    1,
    Math.min(
      MAX_PAGE_SIZE,
      Number.isFinite(limit) ? Math.floor(limit!) : DEFAULT_PAGE_SIZE,
    ),
  )
}

function recordIdentity(record: IndexStorageKey): string {
  return JSON.stringify([
    record.scope.repositoryId,
    record.scope.worktreeId,
    record.table,
    record.key,
  ])
}

async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  const file = await fs.open(temporaryPath, 'wx')
  try {
    await file.writeFile(content)
    await file.sync()
  } finally {
    await file.close()
  }
  await fs.rename(temporaryPath, filePath)
  await syncDirectory(path.dirname(filePath))
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(directory, 'r')
    await handle.sync()
  } catch (error) {
    // Platforms that cannot open/fsync directories still retain atomic rename.
    if (
      !['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      throw error
  } finally {
    await handle?.close()
  }
}
