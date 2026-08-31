import * as path from 'path'

import { MAX_LIST_DIRECTORY_ENTRIES } from '@codebuff/common/tools/params/tool/list-directory'

import { readBoundedEntries } from './bounded-readdir'
import {
  getScopedReadPolicyAliases,
  resolveFilePathForFileSystemReadOperation,
} from './path-utils'
import { isReadPathBlocked } from './read-policy'

import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { FileFilter } from './read-files'

/** Defined in common so the tool description states the same number. */
export { MAX_LIST_DIRECTORY_ENTRIES }

export { supportsStreamDirectory } from './bounded-readdir'

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
    // list_directory only reads, so it uses the read-only resolver.
    const resolved = await resolveFilePathForFileSystemReadOperation(
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
      // A non-'project' resolution has an ABSOLUTE relativePath (and therefore
      // an absolute relativeEntryPath), so the scoped `<scope>/<basename>`
      // aliases are added for the host fileFilter; without them a filter
      // written against project-relative globs would silently fail open.
      const policyAliases = [
        relativeEntryPath,
        ...getScopedReadPolicyAliases(resolved.scope, entry.name),
      ]
      if (policyAliases.some((alias) => isReadPathBlocked(alias, fileFilter)))
        continue
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
      error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
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
