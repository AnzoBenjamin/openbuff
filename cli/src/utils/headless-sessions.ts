import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import { getProjectStorageKey } from '../project-files'
import { getConfigDir } from './auth'
import { sanitizeForChatPersistence } from './payload-sanitizer'
import type { RunState } from '@openbuff/sdk'

/** A storage quota, not a productive-work limit. Oversized state is refused, never clipped. */
export const HEADLESS_SESSION_MAX_BYTES = 64 * 1024 * 1024
export function isHeadlessSessionId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
}
export class HeadlessSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeadlessSessionError'
  }
}
export type HeadlessSessionLease = {
  readonly sessionId: string
  readonly agentId?: string
  readonly previousRun?: RunState
  save(state: RunState, agentId: string): Promise<void>
  close(): Promise<void>
}
export type HeadlessSessionStore = {
  readonly directory: string
  acquire(options: {
    continue?: boolean
    continueId?: string
    signal?: AbortSignal
  }): Promise<HeadlessSessionLease>
}
function fail(message: string): never {
  throw new HeadlessSessionError(message)
}
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')
const at = (fd: number, name?: string) =>
  `/proc/self/fd/${fd}${name ? `/${name}` : ''}`
const directoryFlags =
  fs.constants.O_RDONLY |
  fs.constants.O_DIRECTORY |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK
const readFlags =
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
const writeFlags =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function validRunState(value: unknown): value is RunState {
  if (
    !object(value) ||
    !object(value.output) ||
    !['error', 'lastMessage', 'structuredOutput'].includes(
      String(value.output.type),
    )
  )
    return false
  const session = value.sessionState
  if (!object(session) || !object(session.fileContext)) return false
  const agent = session.mainAgentState
  return (
    object(agent) &&
    typeof agent.agentId === 'string' &&
    object(agent.agentContext) &&
    Array.isArray(agent.subagents) &&
    Array.isArray(agent.childRunIds) &&
    Array.isArray(agent.ancestorRunIds) &&
    typeof agent.stepsRemaining === 'number' &&
    Number.isFinite(agent.stepsRemaining) &&
    Array.isArray(agent.messageHistory) &&
    agent.messageHistory.every(
      (message) =>
        object(message) &&
        ['user', 'assistant', 'system', 'tool'].includes(
          String(message.role),
        ) &&
        (typeof message.content === 'string' || Array.isArray(message.content)),
    )
  )
}

function checkDirectory(fd: number, privateDirectory: boolean): void {
  const stat = fs.fstatSync(fd)
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o022) !== 0 ||
    (privateDirectory && (stat.mode & 0o077) !== 0)
  )
    fail(
      'Headless session directories must be real, owner-controlled directories (private directories require mode 0700).',
    )
}

/** The selected config root is trusted; every descendant is opened against its held parent. */
function openDirectoryChain(
  configDir: string,
  components: string[],
  create: boolean,
) {
  if (
    process.platform !== 'linux' ||
    typeof fs.constants.O_NOFOLLOW !== 'number'
  )
    fail(
      'Headless session storage is unavailable: verified directory-descriptor traversal requires Linux /proc/self/fd.',
    )
  const descriptors: number[] = []
  const close = () => {
    for (const fd of descriptors.splice(0).reverse()) {
      try {
        fs.closeSync(fd)
      } catch {
        /* Keep the original storage failure. */
      }
    }
  }
  try {
    if (create) fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
    if (fs.lstatSync(configDir).isSymbolicLink())
      fail('Headless session config directory must not be a symlink.')
    const canonical = fs.realpathSync(configDir)
    const expected = fs.statSync(canonical)
    let fd = fs.openSync(canonical, directoryFlags)
    descriptors.push(fd)
    const observed = fs.fstatSync(fd)
    if (
      expected.dev !== observed.dev ||
      expected.ino !== observed.ino ||
      fs.realpathSync(at(fd)) !== canonical
    )
      fail('Headless session config directory changed during capture.')
    checkDirectory(fd, false)
    for (const [index, component] of components.entries()) {
      if (create) {
        try {
          fs.mkdirSync(at(fd, component), { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      fd = fs.openSync(at(fd, component), directoryFlags)
      descriptors.push(fd)
      checkDirectory(fd, index >= 2)
    }
    return { fd, close }
  } catch (error) {
    close()
    if (error instanceof HeadlessSessionError) throw error
    fail(
      'Headless session store is missing or unsafe; no new conversation was substituted.',
    )
  }
}

async function readRecord(fd: number, name: string, maxBytes: number) {
  const handle = await fs.promises.open(at(fd, name), readFlags)
  try {
    const before = await handle.stat()
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      !Number.isSafeInteger(before.size) ||
      before.size > maxBytes
    )
      fail('Headless session record is unsafe or exceeds its byte quota.')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await handle.stat()
    if (
      offset !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail('Headless session record changed during capture.')
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return { text, value: JSON.parse(text) as unknown }
    } catch {
      return fail(
        'Headless session record is corrupt; repair or select another session explicitly.',
      )
    }
  } finally {
    await handle.close()
  }
}

async function atomicWrite(
  fd: number,
  name: string,
  text: string,
): Promise<void> {
  // Never follow an existing record link, even though rename would replace the link itself.
  try {
    const existing = await fs.promises.lstat(at(fd, name))
    if (
      !existing.isFile() ||
      existing.nlink !== 1 ||
      (existing.mode & 0o077) !== 0
    )
      fail('Headless session record replacement is unsafe.')
  } catch (error) {
    if (!missing(error)) throw error
  }
  const temp = `.${name}.${process.pid}.${randomUUID()}.tmp`
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(at(fd, temp), writeFlags, 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    if ((await handle.stat()).nlink !== 1)
      fail('Headless session temporary record gained an alias.')
    await handle.close()
    handle = undefined
    await fs.promises.rename(at(fd, temp), at(fd, name))
    fs.fsyncSync(fd)
  } finally {
    await handle?.close()
    try {
      await fs.promises.unlink(at(fd, temp))
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
}

/**
 * Private, project-scoped conversation snapshots. This starts a NEW turn, not
 * automatic replay of interrupted effects. Cooperative leases refuse busy or
 * abandoned owners; no timestamp/PID-based stale-lock takeover is attempted.
 * Directory handles and owner-only files protect the local storage boundary.
 * The host-selected config root must remain stable; external same-user writers
 * are detected before publication but are not kernel-excluded by the lease.
 */
export function createHeadlessSessionStore(options: {
  projectRoot: string
  configDir?: string
  maxBytes?: number
}): HeadlessSessionStore {
  const configDir = path.resolve(options.configDir ?? getConfigDir())
  const projectRoot = fs.realpathSync(options.projectRoot)
  const components = [
    'projects',
    getProjectStorageKey(projectRoot),
    'headless-sessions',
  ]
  const directory = path.join(configDir, ...components)
  const maxBytes = options.maxBytes ?? HEADLESS_SESSION_MAX_BYTES
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > HEADLESS_SESSION_MAX_BYTES
  )
    fail('Invalid headless session byte quota.')
  return {
    directory,
    async acquire(selection) {
      selection.signal?.throwIfAborted()
      if (
        selection.continueId !== undefined &&
        (!selection.continue || !isHeadlessSessionId(selection.continueId))
      )
        fail('Invalid headless continuation session ID.')
      const store = openDirectoryChain(
        configDir,
        components,
        !selection.continue,
      )
      let sessionFd: number | undefined
      let lock: fs.promises.FileHandle | undefined
      let lockIdentity: fs.Stats | undefined
      let released = false
      const release = async () => {
        if (released) return
        released = true
        try {
          if (lock && sessionFd !== undefined && lockIdentity) {
            try {
              const observed = await fs.promises.lstat(at(sessionFd, '.lock'))
              if (
                observed.dev === lockIdentity.dev &&
                observed.ino === lockIdentity.ino
              )
                await fs.promises.unlink(at(sessionFd, '.lock'))
            } catch (error) {
              if (!missing(error)) throw error
            }
          }
        } finally {
          try {
            await lock?.close()
          } finally {
            if (sessionFd !== undefined) fs.closeSync(sessionFd)
            store.close()
          }
        }
      }
      try {
        let sessionId = selection.continueId
        if (selection.continue && sessionId === undefined) {
          const pointer = (
            await readRecord(store.fd, 'last-session.json', 4096)
          ).value
          if (
            !object(pointer) ||
            pointer.version !== 1 ||
            typeof pointer.sessionId !== 'string' ||
            !isHeadlessSessionId(pointer.sessionId)
          )
            fail(
              'Headless last-session pointer is corrupt; choose a session ID explicitly.',
            )
          sessionId = pointer.sessionId
        }
        sessionId ??= randomUUID()
        if (!selection.continue)
          fs.mkdirSync(at(store.fd, sessionId), { mode: 0o700 })
        sessionFd = fs.openSync(at(store.fd, sessionId), directoryFlags)
        checkDirectory(sessionFd, true)
        selection.signal?.throwIfAborted()
        try {
          lock = await fs.promises.open(
            at(sessionFd, '.lock'),
            writeFlags,
            0o600,
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            fail(
              'Headless session is busy or has an abandoned owner lock; no automatic takeover is permitted.',
            )
          throw error
        }
        lockIdentity = await lock.stat()
        await lock.writeFile(
          JSON.stringify({ pid: process.pid, owner: randomUUID() }),
          'utf8',
        )
        selection.signal?.throwIfAborted()
        let previousRun: RunState | undefined,
          agentId: string | undefined,
          expected: string | undefined
        if (selection.continue) {
          const record = await readRecord(sessionFd, 'state.json', maxBytes)
          const value = record.value
          if (
            !object(value) ||
            value.version !== 1 ||
            value.sessionId !== sessionId ||
            value.projectRoot !== projectRoot ||
            typeof value.agentId !== 'string' ||
            !value.agentId ||
            !validRunState(value.runState)
          )
            fail(
              'Selected headless session is corrupt or belongs to another project.',
            )
          if (value.contentSha256 !== digest(JSON.stringify(value.runState)))
            fail(
              'Selected headless session failed its content integrity check.',
            )
          previousRun = value.runState
          agentId = value.agentId
          expected = digest(record.text)
        }
        selection.signal?.throwIfAborted()
        const heldFd = sessionFd
        const heldSessionId = sessionId
        let closing = false,
          pending: Promise<void> = Promise.resolve()
        return {
          sessionId: heldSessionId,
          agentId,
          previousRun,
          save(state, chosenAgentId) {
            if (closing || released)
              return Promise.reject(
                new HeadlessSessionError('Headless session lease is closed.'),
              )
            if (!validRunState(state) || !chosenAgentId)
              return Promise.reject(
                new HeadlessSessionError(
                  'Run has no valid conversation state to persist.',
                ),
              )
            const clean = sanitizeForChatPersistence(state)
            const body = JSON.stringify(clean)
            const text = JSON.stringify({
              version: 1,
              sessionId: heldSessionId,
              projectRoot,
              agentId: chosenAgentId,
              contentSha256: digest(body),
              runState: clean,
            })
            if (Buffer.byteLength(text, 'utf8') > maxBytes)
              return Promise.reject(
                new HeadlessSessionError(
                  'Headless session exceeds its byte quota; the previous snapshot is retained without truncation.',
                ),
              )
            const save = pending.then(async () => {
              let observed: string | undefined
              try {
                observed = digest(
                  (await readRecord(heldFd, 'state.json', maxBytes)).text,
                )
              } catch (error) {
                if (!missing(error)) throw error
              }
              if (observed !== expected)
                fail(
                  'Headless session changed outside its lease; the foreign snapshot is retained.',
                )
              await atomicWrite(heldFd, 'state.json', text)
              expected = digest(text)
              await atomicWrite(
                store.fd,
                'last-session.json',
                JSON.stringify({ version: 1, sessionId: heldSessionId }),
              )
            })
            pending = save.catch(() => {})
            return save
          },
          async close() {
            closing = true
            await pending
            await release()
          },
        }
      } catch (error) {
        await release()
        if (selection.signal?.aborted) throw selection.signal.reason
        if (error instanceof HeadlessSessionError) throw error
        fail(
          'Selected headless session is missing, unsafe or unavailable; no fresh conversation was substituted.',
        )
      }
    },
  }
}
