import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getHostReadProjectRoot,
  isProjectOnlyReadPolicy,
  normalizePathSpelling,
  type HostReadPolicy,
} from '@codebuff/common/util/project-path-containment'
import { isMandatorySensitiveReadPath } from '@codebuff/common/util/sensitive-paths'
import type { PathLike, BigIntStats, Dirent } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

const proc = (fd: number, child?: string) =>
  `/proc/self/fd/${fd}${child === undefined ? '' : `/${child}`}`
const refuse = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code })
}
export const projectReadUnavailable = (): never =>
  refuse(
    'STRICT_READ_UNAVAILABLE',
    'Strict project reads are unavailable for this filesystem view.',
  )
const unsafe = (): never =>
  refuse(
    'EACCES',
    'Strict project read refused an unsafe or outside-project target.',
  )
const changed = (): never =>
  refuse('ESTALE', 'The strict project read target changed during capture.')
const relative = (root: string, target: string): string | undefined => {
  const rel = path.relative(root, target)
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
    ? undefined
    : rel
}
const sensitive = (target: string) =>
  isMandatorySensitiveReadPath(target) ||
  isMandatorySensitiveReadPath(
    target
      .split(/[\\/]+/)
      .map((segment) => segment.replace(/[ .]+$/, ''))
      .join('/'),
  )
const sameIdentity = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev && left.ino === right.ino
const sameGeneration = (left: BigIntStats, right: BigIntStats) =>
  sameIdentity(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs
const flags = () =>
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
const closeQuietly = async (handle: FileHandle) => {
  await handle.close().catch(() => {})
}

function targetPath(policy: HostReadPolicy, file: PathLike) {
  if (!isProjectOnlyReadPolicy(policy)) return projectReadUnavailable()
  const roots = getHostReadProjectRoot(policy)
  let value: string
  if (typeof file === 'string') value = file
  else if (file instanceof URL && file.protocol === 'file:')
    value = fileURLToPath(file)
  else if (Buffer.isBuffer(file)) {
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(file)
    } catch {
      return unsafe()
    }
  } else return unsafe()
  const normalized = normalizePathSpelling(value)
  if (
    !value ||
    value.includes('\0') ||
    normalized.hasTraversalSegment ||
    /^[a-zA-Z]:/.test(normalized.canonical)
  )
    return unsafe()
  const full = path.resolve(roots.projectRoot, normalized.canonical || '.')
  const rel =
    relative(roots.projectRoot, full) ?? relative(roots.realProjectRoot, full)
  if (
    rel === undefined ||
    sensitive(full) ||
    sensitive(path.join(roots.realProjectRoot, rel))
  )
    return unsafe()
  return { ...roots, rel, target: path.join(roots.realProjectRoot, rel) }
}

type Held = { handle: FileHandle; path: string; before: BigIntStats }
export type GuardedProjectTarget = {
  handle: FileHandle
  path: string
  validate(): Promise<void>
  close(): Promise<void>
}

/**
 * Linux descriptor traversal, not an OS sandbox. The admission root strings
 * are reused, never recaptured. Single-link regular files and real directories
 * are checked before body I/O and again before publication. Metadata checks
 * do not provide immutable snapshots against concurrent same-inode writers.
 */
export async function openGuardedProjectTarget(
  policy: HostReadPolicy,
  file: PathLike,
  kind: 'file' | 'directory' | 'either' = 'file',
): Promise<GuardedProjectTarget> {
  if (
    process.platform !== 'linux' ||
    !fs.constants.O_NOFOLLOW ||
    !fs.constants.O_NONBLOCK ||
    !fs.constants.O_DIRECTORY
  )
    return projectReadUnavailable()
  const target = targetPath(policy, file)
  const held: Held[] = []
  let closed = false
  const cleanup = async () => {
    if (closed) return
    closed = true
    for (const entry of [...held].reverse()) await closeQuietly(entry.handle)
  }
  const descriptorPath = async (handle: FileHandle): Promise<string> => {
    try {
      return await fs.promises.realpath(proc(handle.fd))
    } catch {
      return projectReadUnavailable()
    }
  }
  const checkType = (
    stat: BigIntStats,
    expected: 'file' | 'directory' | 'either',
  ) => {
    if (stat.isFile()) {
      if (expected === 'directory' || stat.nlink !== 1n) unsafe()
    } else if (!stat.isDirectory() || expected === 'file') unsafe()
  }
  const validate = async () => {
    if (closed) return changed()
    if (
      (await fs.promises.realpath(target.projectRoot)) !==
      target.realProjectRoot
    )
      changed()
    for (let index = 0; index < held.length; index++) {
      const entry = held[index]!
      const actual = await entry.handle.stat({ bigint: true })
      checkType(actual, index === held.length - 1 ? kind : 'directory')
      if (
        !sameGeneration(entry.before, actual) ||
        (await descriptorPath(entry.handle)) !== entry.path ||
        sensitive(entry.path)
      )
        changed()
      const current = await fs.promises.lstat(entry.path, { bigint: true })
      if (current.isSymbolicLink() || !sameIdentity(actual, current)) changed()
    }
  }
  try {
    if (
      (await fs.promises.realpath(target.projectRoot)) !==
      target.realProjectRoot
    )
      changed()
    const expected = await fs.promises.lstat(target.realProjectRoot, {
      bigint: true,
    })
    const root = await fs.promises.open(
      target.realProjectRoot,
      flags() | fs.constants.O_DIRECTORY,
    )
    const rootStat = await root.stat({ bigint: true }).catch(async (error) => {
      await closeQuietly(root)
      throw error
    })
    held.push({ handle: root, path: target.realProjectRoot, before: rootStat })
    if (
      !rootStat.isDirectory() ||
      !sameIdentity(expected, rootStat) ||
      (await descriptorPath(root)) !== target.realProjectRoot
    )
      changed()
    let parent = root,
      expectedPath = target.realProjectRoot
    const segments = target.rel ? target.rel.split(path.sep) : []
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!
      const directory = index < segments.length - 1 || kind === 'directory'
      const handle = await fs.promises.open(
        proc(parent.fd, segment),
        flags() | (directory ? fs.constants.O_DIRECTORY : 0),
      )
      const stat = await handle.stat({ bigint: true }).catch(async (error) => {
        await closeQuietly(handle)
        throw error
      })
      expectedPath = path.join(expectedPath, segment)
      held.push({ handle, path: expectedPath, before: stat })
      checkType(stat, index < segments.length - 1 ? 'directory' : kind)
      if (
        (await descriptorPath(handle)) !== expectedPath ||
        sensitive(expectedPath)
      )
        changed()
      parent = handle
    }
    await validate()
    return {
      handle: parent,
      path: target.target,
      validate,
      async close() {
        try {
          await validate()
        } finally {
          await cleanup()
        }
      },
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** The bounded Node text reader gets only a validated held descriptor. */
export async function openGuardedProjectTextHandle(
  policy: HostReadPolicy,
  file: PathLike,
) {
  const target = await openGuardedProjectTarget(policy, file)
  return {
    stat: target.handle.stat.bind(target.handle),
    async read(
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) {
      await target.validate()
      return target.handle.read(buffer, offset, length, position)
    },
    close: target.close,
  }
}

/** Directory bodies are enumerated against a held descriptor, never a lexical reopen. */
export async function guardedProjectDirectory(
  policy: HostReadPolicy,
  file: PathLike,
): Promise<AsyncIterable<Dirent>> {
  // Acquire lazily: return() before the first next() must not leak a handle.
  return (async function* () {
    const target = await openGuardedProjectTarget(policy, file, 'directory')
    let directory: fs.Dir | undefined
    try {
      directory = await fs.promises.opendir(proc(target.handle.fd))
      for await (const entry of directory) {
        await target.validate()
        if (!entry.isFile() && !entry.isDirectory()) continue
        const full = path.join(target.path, entry.name)
        if (sensitive(full)) continue
        let child: GuardedProjectTarget
        try {
          child = await openGuardedProjectTarget(
            policy,
            full,
            entry.isDirectory() ? 'directory' : 'file',
          )
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (
            ['EACCES', 'ENOENT', 'ELOOP', 'ENOTDIR', 'ESTALE'].includes(
              code ?? '',
            )
          )
            continue
          throw error
        }
        await child.close()
        await target.validate()
        yield entry
      }
      await target.validate()
    } finally {
      await directory?.close().catch(() => {})
      await target.close()
    }
  })()
}
