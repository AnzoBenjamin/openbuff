import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdir, lstat } from 'node:fs/promises'
import path from 'node:path'
import type {
  IndexStoragePort,
  IndexStorageKey,
  IndexStorageRecord,
  IndexStorageQuery,
  IndexStorageQueryResult,
  IndexStorageBatch,
  IndexStorageBatchResult,
  IndexStorageScope,
  IndexStorageStats,
} from './storage-port'

const MAX_FRAME = 32 * 1024 * 1024
export class RepositoryServiceError extends Error {
  constructor(
    message: string,
    readonly outcome: 'unavailable' | 'protocol' | 'indeterminate',
  ) {
    super(message)
    this.name = 'RepositoryServiceError'
  }
}

/** Private, versioned IPC. An uncertain write is never replayed automatically. */
export async function openRepositoryServiceStorage(options: {
  directory: string
  executable: string
  timeoutMs?: number
}): Promise<IndexStoragePort> {
  if (
    !path.isAbsolute(options.directory) ||
    !path.isAbsolute(options.executable)
  )
    throw new RepositoryServiceError(
      'Repository service requires absolute paths',
      'protocol',
    )
  await mkdir(options.directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(options.directory)
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.getuid && metadata.uid !== process.getuid()) ||
    metadata.mode & 0o077
  )
    throw new RepositoryServiceError(
      'Repository service directory is not private',
      'protocol',
    )
  const socketPath = path.join(options.directory, 'service.sock')
  if (Buffer.byteLength(socketPath) > 103)
    throw new RepositoryServiceError(
      'Repository service socket path is too long',
      'protocol',
    )
  let socket: net.Socket | undefined
  let opening: Promise<void> | undefined
  let closed = false
  let sequence = 0
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
      mutation: boolean
    }
  >()
  const timeout = options.timeoutMs ?? 15_000
  const fail = (reason: string) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(
        new RepositoryServiceError(
          reason,
          item.mutation ? 'indeterminate' : 'unavailable',
        ),
      )
    }
    pending.clear()
  }
  async function connect(): Promise<void> {
    if (closed)
      throw new RepositoryServiceError(
        'Repository service client is closed',
        'unavailable',
      )
    if (socket && !socket.destroyed) return
    if (opening) return opening
    opening = new Promise<void>((resolve, reject) => {
      const candidate = net.createConnection(socketPath)
      let buffered = Buffer.alloc(0)
      const connectTimer = setTimeout(
        () => candidate.destroy(new Error('Repository connection timed out')),
        1_000,
      )
      candidate.once('connect', () => {
        clearTimeout(connectTimer)
        socket = candidate
        resolve()
      })
      candidate.on('error', (error) => {
        clearTimeout(connectTimer)
        reject(error)
        fail('Repository service connection failed')
      })
      candidate.on('close', () => {
        if (socket === candidate) socket = undefined
        fail('Repository service connection closed')
      })
      candidate.on('data', (data) => {
        buffered = Buffer.concat([buffered, data])
        if (buffered.length > MAX_FRAME) {
          candidate.destroy()
          return
        }
        let boundary: number
        while ((boundary = buffered.indexOf(10)) >= 0) {
          const line = buffered.subarray(0, boundary)
          buffered = buffered.subarray(boundary + 1)
          try {
            const reply = JSON.parse(line.toString('utf8'))
            const item = pending.get(reply.id)
            if (!item || typeof reply.ok !== 'boolean')
              throw new Error('Invalid repository response')
            pending.delete(reply.id)
            clearTimeout(item.timer)
            if (reply.ok) item.resolve(reply.result)
            else
              item.reject(
                new RepositoryServiceError(
                  reply.error?.message ?? 'Repository request failed',
                  'protocol',
                ),
              )
          } catch {
            candidate.destroy()
            return
          }
        }
      })
    }).finally(() => {
      opening = undefined
    })
    return opening
  }
  try {
    await connect()
  } catch {
    const child = spawn(options.executable, ['--serve', options.directory], {
      detached: true,
      stdio: 'ignore',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    })
    let launchError: Error | undefined
    child.on('error', (error) => {
      launchError = error
    })
    child.unref()
    const deadline = Date.now() + 5_000
    while (true) {
      if (launchError)
        throw new RepositoryServiceError(
          'Repository service could not start',
          'unavailable',
        )
      try {
        await connect()
        break
      } catch {
        if (Date.now() >= deadline)
          throw new RepositoryServiceError(
            'Repository service startup timed out',
            'unavailable',
          )
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }
  }
  async function call<T>(method: string, params: unknown): Promise<T> {
    await connect()
    const id = `request-${++sequence}`
    const frame =
      JSON.stringify({ id, protocolVersion: 1, method, params }) + '\n'
    if (Buffer.byteLength(frame) > MAX_FRAME)
      throw new RepositoryServiceError(
        'Repository request exceeds frame budget',
        'protocol',
      )
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new RepositoryServiceError(
            'Repository request timed out',
            method === 'batch' ? 'indeterminate' : 'unavailable',
          ),
        )
        socket?.destroy()
      }, timeout)
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        mutation: method === 'batch',
      })
      socket!.write(frame)
    })
  }
  const hello = await call<{ protocolVersion: number; backend: string }>(
    'hello',
    {},
  )
  if (hello.protocolVersion !== 1 || hello.backend !== 'rust-sqlite') {
    socket?.destroy()
    throw new RepositoryServiceError(
      'Repository service version mismatch',
      'protocol',
    )
  }
  return {
    protocolVersion: 1,
    get: <T>(request: IndexStorageKey) =>
      call<IndexStorageRecord<T> | null>('get', request),
    query: <T>(request: IndexStorageQuery) =>
      call<IndexStorageQueryResult<T>>('query', request),
    batch: (request: IndexStorageBatch) =>
      call<IndexStorageBatchResult>('batch', request),
    stats: (request?: { scope?: IndexStorageScope }) =>
      call<IndexStorageStats>('stats', request ?? {}),
    async close() {
      closed = true
      socket?.destroy()
      fail('Repository client closed')
    },
  }
}
