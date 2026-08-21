// Shared bounded/streaming directory read for SDK tools.

import { MAX_LIST_DIRECTORY_ENTRIES } from '@codebuff/common/tools/params/tool/list-directory'

import type {
  CodebuffFileSystem,
  CodebuffStreamDirectory,
} from '@codebuff/common/types/filesystem'
import type { Dirent } from 'fs'

/**
 * The streaming capability when it is usable, otherwise `undefined`. Usable
 * means callable AND paired with this adapter's current `readdir`: a decorating
 * adapter copies `streamDirectory` over as an own property while overriding
 * `readdir`, so the pairing is what keeps the listing on the adapter's own
 * view. Mis-wiring guard, not a trust boundary: see `CodebuffStreamDirectory`.
 */
export function resolveStreamDirectory(
  fs: CodebuffFileSystem,
): CodebuffStreamDirectory | undefined {
  const streamDirectory = fs.streamDirectory
  return typeof streamDirectory === 'function' &&
    streamDirectory.readdirView === fs.readdir
    ? streamDirectory
    : undefined
}

/**
 * Whether `fs` provides usable streaming directory iteration, i.e. whether
 * `list_directory` takes the bounded streaming path for this adapter.
 *
 * Published as the capability-detection entry point for `streamDirectory`
 * because presence of the member is only half the condition:
 * `detectFilesystemCapabilities` reports members, and cannot express the
 * `readdirView` pairing. Consumers asking "does this adapter stream?" must use
 * this so their answer cannot drift from the decision the tool actually makes.
 */
export function supportsStreamDirectory(fs: CodebuffFileSystem): boolean {
  return resolveStreamDirectory(fs) !== undefined
}

/**
 * Read at most `MAX_LIST_DIRECTORY_ENTRIES + 1` entries: one past the cap makes
 * "over the cap" decidable without counting the whole directory. See
 * `CodebuffStreamDirectory` in common for the streaming contract this relies on.
 */
export async function readBoundedEntries(
  fs: CodebuffFileSystem,
  directoryPath: string,
): Promise<Dirent[]> {
  const limit = MAX_LIST_DIRECTORY_ENTRIES + 1
  const streamDirectory = resolveStreamDirectory(fs)
  if (!streamDirectory) {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true })
    return entries.slice(0, limit)
  }

  const entries: Dirent[] = []
  for await (const entry of await streamDirectory.call(fs, directoryPath)) {
    entries.push(entry)
    if (entries.length === limit) break
  }
  return entries
}
