import * as path from 'path'

import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import { resolveFilePathForFileSystemOperation } from './path-utils'
import { isReadPathBlocked } from './read-policy'
import type { FileFilter } from './read-files'

/**
 * Maximum entries before the listing returns an error. Exported and
 * documented so callers can reason about the cap. Large directories return
 * an errorMessage (not a truncated success) to preserve the persisted error
 * contract and let consumers detect the cap via error handling. Callers that
 * need large listings should narrow `path` or supply a `fileFilter`.
 * A future `maxEntries` param may allow per-call configurability without
 * breaking the current error-based contract; any truncated-success shape
 * would be introduced as an additive optional field (truncated/totalEntries)
 * so persisted schemas remain detectable.
 *
 * Note on large directories: `fs.readdir` materializes all entries before the
 * cap is checked, so a 500k-entry directory still allocates before the 5k
 * error is returned and could OOM. Streaming via `fs.opendir` would avoid
 * this but is not available through the `CodebuffFileSystem` abstraction and
 * would require a capability extension; callers should narrow `path` or use a
 * fileFilter to avoid pathological directories. The cap therefore documents
 * the contract but does not prevent the underlying readdir allocation.
 */
export const MAX_LIST_DIRECTORY_ENTRIES = 5000

export async function listDirectory(params: {
  directoryPath: string
  projectPath: string
  fs: CodebuffFileSystem
  fileFilter?: FileFilter
}): Promise<CodebuffToolOutput<'list_directory'>> {
  const { directoryPath, projectPath, fs, fileFilter } = params

  let resolvedPathForError: string | undefined
  try {
    // Reuse the shared containment helper so list_directory gets the same
    // lexical + symlink-resolved protection as read_files.
    // The previous `startsWith(projectPath)` check was a weak string prefix
    // that admitted sibling directories like /project-evil/ (whose path starts
    // with the string /project) and relied on lexical comparison alone.
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
    const resolvedPath = resolved.operationPath
    resolvedPathForError = resolvedPath

    // readdir is inherently non-streaming in Node's fs and in CodebuffFileSystem;
    // all Dirent objects are allocated before MAX_LIST_DIRECTORY_ENTRIES is enforced.
    // See the MAX_LIST_DIRECTORY_ENTRIES doc comment for OOM implications and mitigation.
    const entries = await fs.readdir(resolvedPath, {
      withFileTypes: true,
    })

    // Large-directory guard: preserve the original error contract for
    // directories exceeding the cap so persisted error handling and consumers
    // expecting errorMessage continue to work. The cap is documented via the
    // exported MAX_LIST_DIRECTORY_ENTRIES constant. Callers that need large
    // listings should narrow `path` or supply a `fileFilter`. A future
    // truncated-success shape (truncated/totalEntries/warning) would be
    // introduced as additive optional fields on the success union, never by
    // replacing this error with a success.
    if (entries.length > MAX_LIST_DIRECTORY_ENTRIES) {
      return [
        {
          type: 'json',
          value: {
            errorMessage: `Directory listing too large: ${entries.length} entries exceeds limit of ${MAX_LIST_DIRECTORY_ENTRIES}. Use a more specific path or a fileFilter to narrow the listing.`,
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
    const rawMessage = error instanceof Error ? error.message : String(error)
    // Sanitize absolute realpath leaks: replace absolute paths with the logical directoryPath (RF-7)
    let sanitized = rawMessage
    if (projectPath) sanitized = sanitized.replaceAll(projectPath, directoryPath)
    if (resolvedPathForError) sanitized = sanitized.replaceAll(resolvedPathForError, directoryPath)
    if (!sanitized.includes(directoryPath)) {
      sanitized = `Failed to list directory '${directoryPath}'`
    } else {
      sanitized = `Failed to list directory: ${sanitized}`
    }
    return [
      {
        type: 'json',
        value: {
          errorMessage: sanitized,
        },
      },
    ]
  }
}
