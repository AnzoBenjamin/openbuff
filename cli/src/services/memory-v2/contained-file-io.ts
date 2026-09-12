import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { isAbsolute } from 'node:path'

export type ContainedFileIoErrorCode =
  | 'unsupported'
  | 'invalid-path'
  | 'missing'
  | 'not-regular'
  | 'not-directory'
  | 'not-owner'
  | 'too-large'
  | 'changed'
  | 'exists'
  | 'io'

export class ContainedFileIoError extends Error {
  constructor(readonly code: ContainedFileIoErrorCode) {
    super(`contained-file-io:${code}`)
    this.name = 'ContainedFileIoError'
  }
}

/** Optional deterministic race hooks for tests. Production callers omit them. */
export type ContainedFileIoTestHooks = {
  afterRootDescriptor?: (descriptor: number) => void
  afterParentDescriptor?: (descriptor: number, component: string) => void
}

export type ContainedFileRead = {
  bytes: Buffer
  text: string
  digest: `sha256:${string}`
}

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const PROC_DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY
const FILE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW

function fail(code: ContainedFileIoErrorCode): never {
  throw new ContainedFileIoError(code)
}

function requireSupported(): void {
  if (
    process.platform !== 'linux' ||
    typeof constants.O_DIRECTORY !== 'number' ||
    typeof constants.O_NOFOLLOW !== 'number'
  ) fail('unsupported')
}

function components(path: string): string[] {
  if (!path || isAbsolute(path) || path.includes('\0') || path.includes('\\')) fail('invalid-path')
  const values = path.split('/')
  if (values.some((value) => !value || value === '.' || value === '..')) fail('invalid-path')
  return values
}

function procPath(descriptor: number, component?: string): string {
  return component === undefined
    ? `/proc/self/fd/${descriptor}`
    : `/proc/self/fd/${descriptor}/${component}`
}

function owned(stat: ReturnType<typeof fstatSync>): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid()
}

function verifyDirectory(descriptor: number): void {
  const stat = fstatSync(descriptor)
  if (!stat.isDirectory()) fail('not-directory')
  if (!owned(stat)) fail('not-owner')
}

function verifyRegular(descriptor: number): Stats {
  const stat: Stats = fstatSync(descriptor)
  if (!stat.isFile()) fail('not-regular')
  if (!owned(stat)) fail('not-owner')
  return stat
}

function openRoot(root: string, hooks: ContainedFileIoTestHooks, descriptors: number[]): number {
  requireSupported()
  let descriptor: number
  try {
    descriptor = openSync(root, DIRECTORY_FLAGS)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('missing')
    fail('io')
  }
  descriptors.push(descriptor)
  try {
    verifyDirectory(descriptor)
    try {
      const procDescriptor = openSync(procPath(descriptor), PROC_DIRECTORY_FLAGS)
      closeSync(procDescriptor)
    } catch {
      fail('unsupported')
    }
    hooks.afterRootDescriptor?.(descriptor)
    return descriptor
  } catch (error) {
    closeAll(descriptors)
    throw error
  }
}

function openChildDirectory(parent: number, component: string): number {
  try {
    return openSync(procPath(parent, component), DIRECTORY_FLAGS)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('missing')
    fail('io')
  }
}

function closeAll(descriptors: number[]): void {
  for (let index = descriptors.length - 1; index >= 0; index--) {
    try { closeSync(descriptors[index]!) } catch { /* Preserve the primary bounded error. */ }
  }
}

function traverse(
  rootDescriptor: number,
  names: string[],
  descriptors: number[],
  hooks: ContainedFileIoTestHooks,
): number {
  let parent = rootDescriptor
  for (const component of names) {
    const descriptor = openChildDirectory(parent, component)
    descriptors.push(descriptor)
    verifyDirectory(descriptor)
    hooks.afterParentDescriptor?.(descriptor, component)
    parent = descriptor
  }
  return parent
}

export function readContainedProjectFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
  hooks: ContainedFileIoTestHooks = {},
): ContainedFileRead {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) fail('too-large')
  const names = components(relativePath)
  const descriptors: number[] = []
  try {
    const rootDescriptor = openRoot(root, hooks, descriptors)
    const parent = traverse(rootDescriptor, names.slice(0, -1), descriptors, hooks)
    let file: number
    try {
      file = openSync(procPath(parent, names.at(-1)!), FILE_READ_FLAGS)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('missing')
      fail('io')
    }
    descriptors.push(file)
    const before = verifyRegular(file)
    if (before.size > maximumBytes) fail('too-large')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(file, bytes, offset, bytes.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    const after = verifyRegular(file)
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) fail('changed')
    return {
      bytes,
      text: bytes.toString('utf8'),
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    }
  } finally {
    closeAll(descriptors)
  }
}

export type ContainedDirectoryHandle = {
  writeExclusive: (name: string, content: string | Buffer) => void
  remove: (name: string) => void
  close: () => void
}

export function createContainedProjectDirectory(
  root: string,
  relativeDirectory: string,
  hooks: ContainedFileIoTestHooks = {},
): ContainedDirectoryHandle {
  const names = components(relativeDirectory)
  const descriptors: number[] = []
  let rootDescriptor: number
  try {
    rootDescriptor = openRoot(root, hooks, descriptors)
  } catch (error) {
    closeAll(descriptors)
    throw error
  }
  let parent = rootDescriptor
  try {
    for (const component of names) {
      const anchored = procPath(parent, component)
      try {
        mkdirSync(anchored, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') fail('io')
      }
      const descriptor = openChildDirectory(parent, component)
      descriptors.push(descriptor)
      verifyDirectory(descriptor)
      fchmodSync(descriptor, 0o700)
      hooks.afterParentDescriptor?.(descriptor, component)
      parent = descriptor
    }
  } catch (error) {
    closeAll(descriptors)
    throw error
  }

  const directoryDescriptor = parent
  let closed = false
  const leaf = (name: string): string => {
    const values = components(name)
    if (values.length !== 1) fail('invalid-path')
    return values[0]!
  }
  return {
    writeExclusive(name, content) {
      if (closed) fail('io')
      const validated = leaf(name)
      let descriptor: number
      try {
        descriptor = openSync(
          procPath(directoryDescriptor, validated),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
      } catch (error) {
        if (error instanceof ContainedFileIoError) throw error
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('exists')
        fail('io')
      }
      let complete = false
      try {
        verifyRegular(descriptor)
        fchmodSync(descriptor, 0o600)
        writeFileSync(descriptor, content)
        const after = verifyRegular(descriptor)
        if (after.size !== Buffer.byteLength(content)) fail('changed')
        complete = true
      } finally {
        closeSync(descriptor)
        if (!complete) {
          try { unlinkSync(procPath(directoryDescriptor, validated)) } catch { /* Best effort anchored cleanup. */ }
        }
      }
    },
    remove(name) {
      if (closed) return
      const validated = leaf(name)
      try {
        unlinkSync(procPath(directoryDescriptor, validated))
      } catch (error) {
        if (error instanceof ContainedFileIoError) throw error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('io')
      }
    },
    close() {
      if (closed) return
      closed = true
      closeAll(descriptors)
    },
  }
}
