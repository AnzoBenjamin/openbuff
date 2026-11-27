import {
  promises as fs,
  closeSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'fs'
import path from 'path'

export type DirectoryEntry = {
  name: string
  path: string
  isParent: boolean
  isGitRepo: boolean
  isSymlink?: boolean
}

export function isDirectoryPathQuery(query: string): boolean {
  return (
    /^(?:[~/\\]|\.\.?[\\/]|[a-zA-Z]:[\\/])/.test(query) || /[\\/]/.test(query)
  )
}

export type DirectoryListing = {
  entries: DirectoryEntry[]
  state: 'ready' | 'partial'
  omitted: number
}

/** Publish directory names before optional badges, bound concurrent stat work, and retain access failures. */
export async function readDirectoryListing(
  dirPath: string,
  options: {
    signal?: AbortSignal
    onEntries?: (entries: DirectoryEntry[]) => void
  } = {},
): Promise<DirectoryListing> {
  const check = () => options.signal?.throwIfAborted()
  check()
  const items = await fs.readdir(dirPath, { withFileTypes: true })
  const entries: DirectoryEntry[] = []
  const parent = path.dirname(dirPath)
  if (parent !== dirPath)
    entries.push({ name: '..', path: parent, isParent: true, isGitRepo: false })
  let omitted = 0
  const candidates = items.filter(
    (item) =>
      !item.name.startsWith('.') &&
      (item.isDirectory() || item.isSymbolicLink()),
  )
  for (let index = 0; index < candidates.length; index += 32) {
    check()
    const batch = await Promise.all(
      candidates.slice(index, index + 32).map(async (item) => {
        const fullPath = path.join(dirPath, item.name)
        try {
          if (item.isSymbolicLink() && !(await fs.stat(fullPath)).isDirectory())
            return null
          return {
            name: item.name,
            path: fullPath,
            isParent: false,
            isGitRepo: false,
            isSymlink: item.isSymbolicLink(),
          }
        } catch {
          omitted++
          return null
        }
      }),
    )
    entries.push(
      ...batch.filter(
        (entry): entry is NonNullable<typeof entry> => entry !== null,
      ),
    )
  }
  const sorted = () =>
    [...entries].sort((a, b) =>
      a.isParent
        ? -1
        : b.isParent
          ? 1
          : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  check()
  options.onEntries?.(sorted())
  for (let index = 0; index < entries.length; index += 32) {
    check()
    await Promise.all(
      entries.slice(index, index + 32).map(async (entry) => {
        if (!entry.isParent)
          entry.isGitRepo = await hasGitDirectoryAsync(entry.path)
      }),
    )
    check()
    options.onEntries?.(sorted())
  }
  return { entries: sorted(), state: omitted ? 'partial' : 'ready', omitted }
}

/**
 * Get directory entries for a given path, including parent directory option.
 * Skips hidden directories (those starting with '.').
 */
export function getDirectories(dirPath: string): DirectoryEntry[] {
  const entries: DirectoryEntry[] = []

  // Add parent directory option if not at filesystem root
  const parentDir = path.dirname(dirPath)
  if (parentDir !== dirPath) {
    entries.push({
      name: '..',
      path: parentDir,
      isParent: true,
      isGitRepo: false,
    })
  }

  try {
    const items = readdirSync(dirPath)
    for (const item of items) {
      // Skip hidden directories
      if (item.startsWith('.')) continue

      const fullPath = path.join(dirPath, item)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          entries.push({
            name: item,
            path: fullPath,
            isParent: false,
            isGitRepo: hasGitDirectory(fullPath),
          })
        }
      } catch {
        // Skip items we can't stat
      }
    }
  } catch {
    // If we can't read the directory, just return parent option
  }

  // Sort non-parent entries alphabetically (case-insensitive)
  const parentEntry = entries.find((e) => e.isParent)
  const childEntries = entries.filter((e) => !e.isParent)
  childEntries.sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  )

  return parentEntry ? [parentEntry, ...childEntries] : childEntries
}

export async function getDirectoriesAsync(
  dirPath: string,
): Promise<DirectoryEntry[]> {
  try {
    return (await readDirectoryListing(dirPath)).entries
  } catch {
    const parent = path.dirname(dirPath)
    return parent !== dirPath
      ? [{ name: '..', path: parent, isParent: true, isGitRepo: false }]
      : []
  }
}

/**
 * Check if a directory contains a .git subdirectory.
 */
export function hasGitDirectory(dirPath: string): boolean {
  let fd: number | undefined
  try {
    const gitPath = path.join(dirPath, '.git')
    if (statSync(gitPath).isDirectory()) return true
    fd = openSync(gitPath, 'r')
    const data = Buffer.alloc(4096)
    const size = readSync(fd, data, 0, data.length, 0)
    const match = /^gitdir:\s*([^\r\n]+)\s*$/i.exec(
      data.subarray(0, size).toString('utf8').trim(),
    )
    if (!match) return false
    const target = path.resolve(dirPath, match[1])
    return (
      statSync(target).isDirectory() &&
      statSync(path.join(target, 'HEAD')).isFile()
    )
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export async function hasGitDirectoryAsync(dirPath: string): Promise<boolean> {
  let file: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    const marker = path.join(dirPath, '.git')
    if ((await fs.stat(marker)).isDirectory()) return true
    file = await fs.open(marker, 'r')
    const data = Buffer.alloc(4096)
    const { bytesRead } = await file.read(data, 0, data.length, 0)
    const match = /^gitdir:\s*([^\r\n]+)\s*$/i.exec(
      data.subarray(0, bytesRead).toString('utf8').trim(),
    )
    if (!match) return false
    const target = path.resolve(dirPath, match[1])
    return (
      (await fs.stat(target)).isDirectory() &&
      (await fs.stat(path.join(target, 'HEAD'))).isFile()
    )
  } catch {
    return false
  } finally {
    await file?.close()
  }
}
