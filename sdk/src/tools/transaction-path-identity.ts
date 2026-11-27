import { createHash } from 'node:crypto'
import path from 'node:path'

import { MAX_TRANSACTION_FILE_BYTES } from '@codebuff/common/actions'
import { isSandboxSensitivePath } from '@codebuff/common/util/filesystem-sandbox'
import type {
  CodebuffFileSystem,
  CodebuffTransactionParentIdentity,
} from '@codebuff/common/types/filesystem'

const isMissing = (error: unknown): boolean =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === 'ENOENT'

/** The adapter's actual directory, not merely the persisted lexical path. */
export async function captureTransactionPath(
  cwd: string,
  fs: CodebuffFileSystem,
  entryPath: string,
): Promise<{ fullPath: string; parent: CodebuffTransactionParentIdentity }> {
  if (
    path.isAbsolute(entryPath) ||
    entryPath.includes('\\') ||
    entryPath.includes('\0') ||
    entryPath.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(
      'Transaction intent path is not contained in the workspace.',
    )

  const root = await fs.realpath(cwd)
  const fullPath = path.resolve(root, entryPath)
  if (
    isSandboxSensitivePath(entryPath, fs.hostReadPolicy) ||
    isSandboxSensitivePath(fullPath, fs.hostReadPolicy)
  ) {
    throw new Error('Transaction recovery cannot access a protected path.')
  }
  const relative = path.relative(root, fullPath)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      'Transaction intent path is not contained in the workspace.',
    )
  }
  const parentPath = path.dirname(fullPath)
  const identity = await fs.stat(parentPath, { bigint: true })
  if (
    !identity.isDirectory() ||
    (await fs.realpath(parentPath)) !== parentPath ||
    typeof identity.dev === 'undefined' ||
    typeof identity.ino === 'undefined'
  ) {
    throw new Error(
      `Transaction recovery refuses an unverified parent directory for ${entryPath}.`,
    )
  }
  return {
    fullPath,
    parent: {
      canonicalPath: parentPath,
      dev: String(identity.dev),
      ino: String(identity.ino),
    },
  }
}

function sameParent(
  a: CodebuffTransactionParentIdentity,
  b: CodebuffTransactionParentIdentity,
): boolean {
  return (
    a.canonicalPath === b.canonicalPath && a.dev === b.dev && a.ino === b.ino
  )
}

export async function verifyTransactionParent(
  cwd: string,
  fs: CodebuffFileSystem,
  entryPath: string,
  parent: CodebuffTransactionParentIdentity,
): Promise<string> {
  const live = await captureTransactionPath(cwd, fs, entryPath)
  if (!sameParent(live.parent, parent)) {
    throw new Error(
      `Transaction recovery refuses the replaced parent of ${entryPath}.`,
    )
  }
  return live.fullPath
}

/** An unavailable read is not evidence that a file is absent. */
export async function observeTransactionPath(
  cwd: string,
  fs: CodebuffFileSystem,
  entryPath: string,
  parent: CodebuffTransactionParentIdentity,
): Promise<{ fullPath: string; hash: string | null; mode?: number }> {
  const fullPath = await verifyTransactionParent(cwd, fs, entryPath, parent)
  const stat = () => (fs.lstat ? fs.lstat(fullPath) : fs.stat(fullPath))
  const before = await stat().catch((error) => {
    if (isMissing(error)) return null
    throw error
  })
  if (before === null) {
    await verifyTransactionParent(cwd, fs, entryPath, parent)
    return { fullPath, hash: null }
  }
  if (
    !before.isFile() ||
    before.size > MAX_TRANSACTION_FILE_BYTES ||
    (await fs.realpath(fullPath)) !== fullPath
  ) {
    throw new Error(
      `Transaction recovery refuses an unsafe or oversized target: ${entryPath}.`,
    )
  }
  const bytes = await fs.readFile(fullPath)
  const after = await stat()
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    (fs.lstat &&
      (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)) ||
    (await fs.realpath(fullPath)) !== fullPath
  )
    throw new Error(`Transaction target changed while reading: ${entryPath}.`)
  await verifyTransactionParent(cwd, fs, entryPath, parent)
  if (Buffer.byteLength(bytes) > MAX_TRANSACTION_FILE_BYTES) {
    throw new Error(
      `Transaction recovery target exceeds the byte limit: ${entryPath}.`,
    )
  }
  return {
    fullPath,
    hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    mode: before.mode & 0o7777,
  }
}
