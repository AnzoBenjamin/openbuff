import * as path from 'path'

import { MAX_LIST_DIRECTORY_ENTRIES } from '@codebuff/common/tools/params/tool/list-directory'

import { resolveFilePathForFileSystemOperation } from './path-utils'
import { isReadPathBlocked } from './read-policy'

import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type {
  CodebuffFileSystem,
  CodebuffStreamDirectory,
} from '@codebuff/common/types/filesystem'
import type { Dirent } from 'fs'
import type { FileFilter } from './read-files'

/** Defined in common so the tool description states the same number. */
export { MAX_LIST_DIRECTORY_ENTRIES }

/**
 * The streaming capability when it is usable, otherwise `undefined`. Usable
 * means callable AND paired with this adapter's current `readdir`: a decorating
 * adapter copies `streamDirectory` over as an own property while overriding
 * `readdir`, so the pairing is what keeps the listing on the adapter's own
 * view. Mis-wiring guard, not a trust boundary: see `CodebuffStreamDirectory`.
 */
function resolveStreamDirectory(
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
async function readBoundedEntries(
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

export async function listDirectory(params: {
  directoryPath: string
  projectPath: string
  fs: CodebuffFileSystem
  fileFilter?: FileFilter
}): Promise<CodebuffToolOutput<'list_directory'>> {
  const { directoryPath, projectPath, fs, fileFilter } = params

  try {
    // Reuse the shared containment helper so list_directory gets the same
    // lexical + symlink-resolved protection as read_files; a bare
    // `startsWith(projectPath)` prefix check admits siblings like /project-evil.
    const resolved = await resolveFilePathForFileSystemOperation(
      projectPath,
      directoryPath,
      fs,
    )
    if (!resolved) {
      return [
        {
          type: 'json',
          value: {
            errorMessage: `Invalid path: Path '${directoryPath}' is outside the project directory.`,
          },
        },
      ]
    }

    const entries = await readBoundedEntries(fs, resolved.operationPath)

    if (entries.length > MAX_LIST_DIRECTORY_ENTRIES) {
      return [
        {
          type: 'json',
          value: {
            // Deliberate text change (no exact total). The "more than" bound
            // is what the streaming path can prove: it stops at cap + 1 and
            // never learns the true total. The `readdir` fallback does know
            // the total, but the message stays uniform so consumers see one
            // shape either way. See the SDK CHANGELOG [Unreleased] entry for
            // what consumers matching on text must migrate to.
            // `fileFilter` is host-supplied, not a tool input, so the guidance
            // names something the model can actually do.
            errorMessage: `Directory listing too large: more than ${MAX_LIST_DIRECTORY_ENTRIES} entries. List a specific subdirectory instead.`,
          },
        },
      ]
    }

    const files: string[] = []
    const directories: string[] = []

    for (const entry of entries) {
      const relativeEntryPath = path.posix.join(
        resolved.relativePath.replace(/\\/g, '/'),
        entry.name,
      )
      if (isReadPathBlocked(relativeEntryPath, fileFilter)) continue
      if (entry.isDirectory()) {
        directories.push(entry.name)
      } else if (entry.isFile()) {
        files.push(entry.name)
      }
    }

    return [
      {
        type: 'json',
        value: {
          files,
          directories,
          path: directoryPath,
        },
      },
    ]
  } catch (error) {
    // Only the caller-supplied logical path and the errno code are reported: an
    // fs error can name absolute realpaths this call never resolved. Replaces
    // the previous `Failed to list directory: <fs message>` shape; see the SDK
    // CHANGELOG [Unreleased] entry for the consumer migration.
    const errnoCode =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined
    // An errno code is a short fixed uppercase token, never a path; drop
    // anything else — including over-long uppercase text — so this branch
    // cannot become a new leak channel.
    const detail =
      typeof errnoCode === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(errnoCode)
        ? ` (${errnoCode})`
        : ''
    return [
      {
        type: 'json',
        value: {
          errorMessage: `Failed to list directory '${directoryPath}'${detail}`,
        },
      },
    ]
  }
}
