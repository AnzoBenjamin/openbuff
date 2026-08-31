import path from 'path'

import {
  MAX_IMAGE_FILE_SIZE,
  SUPPORTED_IMAGE_EXTENSIONS,
  getImageMimeType,
  isSupportedImageExtension,
} from '@codebuff/common/constants/images'
import { FILE_READ_STATUS } from '@codebuff/common/old-constants'

import {
  getScopedReadPolicyAliases,
  resolveFilePathForFileSystemReadOperation,
} from './path-utils'
import { isReadPathBlocked } from './read-policy'

import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { FileFilter } from './read-files'

const READ_IMAGE_MAX_TOTAL_BYTES = 25 * 1024 * 1024

function isInsideRoot(rootRealPath: string, target: string): boolean {
  const relative = path.relative(rootRealPath, target)
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

export async function readImages(params: {
  paths: string[]
  cwd: string
  fs: CodebuffFileSystem
  signal?: AbortSignal
  fileFilter?: FileFilter
}): Promise<CodebuffToolOutput<'read_image'>> {
  const { paths, cwd, fs, signal, fileFilter } = params
  const images: Array<{
    path: string
    status: 'attached' | 'error'
    mediaType?: string
    sizeBytes?: number
    message: string
  }> = []
  const mediaResults: CodebuffToolOutput<'read_image'> = []
  let totalAttachedBytes = 0

  let rootRealPath: string
  try {
    rootRealPath = await fs.realpath(cwd)
  } catch {
    rootRealPath = path.resolve(cwd)
  }

  type ProcessedImage =
    | {
        kind: 'error'
        entry: {
          path: string
          status: 'error'
          mediaType?: string
          sizeBytes?: number
          message: string
        }
      }
    | {
        kind: 'attach'
        entry: {
          path: string
          status: 'attached'
          mediaType: string
          sizeBytes: number
          message: string
        }
        buffer: Buffer
        mediaType: string
      }

  const processOne = async (imagePath: string): Promise<ProcessedImage> => {
    if (signal?.aborted) {
      return {
        kind: 'error',
        entry: {
          path: imagePath,
          status: 'error',
          message: 'Image read cancelled.',
        },
      }
    }
    // Read-only tool, so it resolves through the read-only containment
    // resolver.
    const resolvedPath = await resolveFilePathForFileSystemReadOperation(
      cwd,
      imagePath,
      fs,
    )
    if (!resolvedPath) {
      return {
        kind: 'error',
        entry: {
          path: imagePath,
          status: 'error',
          message: FILE_READ_STATUS.OUTSIDE_PROJECT,
        },
      }
    }

    const { relativePath, operationPath: fullPath } = resolvedPath
    const ext = path.extname(relativePath).toLowerCase()
    if (!isSupportedImageExtension(ext)) {
      return {
        kind: 'error',
        entry: {
          path: relativePath,
          status: 'error',
          message: `Unsupported image format "${ext || '(none)'}". Supported: ${Array.from(SUPPORTED_IMAGE_EXTENSIONS).join(', ')}`,
        },
      }
    }

    // A non-'project' resolution carries an ABSOLUTE relativePath, so the
    // scoped `<scope>/<basename>` aliases are added for the host fileFilter;
    // without them a filter written against project-relative globs would
    // silently fail open. The basename comes from the dereferenced
    // `operationPath`, exactly like read-files.ts's `authorizeReadTarget`, so
    // the two tools present the same key to a host policy.
    const policyAliases = [
      relativePath,
      ...getScopedReadPolicyAliases(resolvedPath.scope, fullPath),
    ]
    if (policyAliases.some((alias) => isReadPathBlocked(alias, fileFilter))) {
      return {
        kind: 'error',
        entry: {
          path: relativePath,
          status: 'error',
          message: FILE_READ_STATUS.IGNORED,
        },
      }
    }

    // INVARIANT (single dereference): `fullPath` IS the resolver's
    // `operationPath` — the ONE already-dereferenced path it validated, both
    // lexically and after realpath, against the boundary that matches its
    // scope, plus the fail-closed mandatory-sensitive refusal. Read handlers
    // must operate on `operationPath` and must NEVER independently re-resolve
    // it: a second `fs.realpath` here would reopen exactly the TOCTOU window
    // the single-dereference contract exists to close (a symlink swapped
    // between the resolver's realpath and ours would redirect the read to an
    // arbitrary file, while the extension gate above only ever sees the
    // pre-dereference `relativePath`). `read-files.ts`, `read-logs.ts` and
    // `list-directory.ts` already follow this.
    //
    // The project-root check below is now a redundant ASSERTION on resolver
    // output rather than the primary control: a 'project' resolution has
    // already been contained against the real project root. An 'external-read'
    // (allowlisted readableRoots) or 'owned-temp' resolution is legitimately
    // outside the project root and was contained against its own boundary, so
    // asserting it against the project root would reject every such read —
    // which is exactly the documented read_image support for readableRoots.
    if (
      resolvedPath.scope === 'project' &&
      !isInsideRoot(rootRealPath, fullPath)
    ) {
      return {
        kind: 'error',
        entry: {
          path: relativePath,
          status: 'error',
          message: FILE_READ_STATUS.OUTSIDE_PROJECT,
        },
      }
    }
    // A non-existent file needs no special handling here: the fs.stat below
    // produces the normal DOES_NOT_EXIST error (see its catch).
    const safePath = fullPath

    try {
      const stats = await fs.stat(safePath)
      if (!stats.isFile()) {
        return {
          kind: 'error',
          entry: {
            path: relativePath,
            status: 'error',
            message: `Path is not a file: ${relativePath}`,
          },
        }
      }
      if (stats.size > MAX_IMAGE_FILE_SIZE) {
        return {
          kind: 'error',
          entry: {
            path: relativePath,
            status: 'error',
            sizeBytes: stats.size,
            message: `Image is too large: ${(stats.size / (1024 * 1024)).toFixed(1)}MB exceeds ${(MAX_IMAGE_FILE_SIZE / (1024 * 1024)).toFixed(1)}MB limit.`,
          },
        }
      }

      const mediaType = getImageMimeType(ext)
      if (!mediaType) {
        return {
          kind: 'error',
          entry: {
            path: relativePath,
            status: 'error',
            message: `Could not determine image media type: ${relativePath}`,
          },
        }
      }

      const data = await fs.readFile(safePath)
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
      return {
        kind: 'attach',
        entry: {
          path: relativePath,
          status: 'attached',
          mediaType,
          sizeBytes: buffer.length,
          message: 'Image attached as original media.',
        },
        buffer,
        mediaType,
      }
    } catch (error) {
      const message =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
          ? FILE_READ_STATUS.DOES_NOT_EXIST
          : FILE_READ_STATUS.ERROR
      return {
        kind: 'error',
        entry: { path: relativePath, status: 'error', message },
      }
    }
  }

  // Run all per-image I/O concurrently. Results are index-aligned with
  // `paths`, so the total-bytes cap below is applied in input order —
  // preserving the existing semantics where an earlier image can exhaust
  // the budget for a later one. Error entries are emitted unchanged.
  const processed = await Promise.all(paths.map(processOne))

  for (const item of processed) {
    if (item.kind === 'error') {
      images.push(item.entry)
      continue
    }
    if (totalAttachedBytes + item.buffer.length > READ_IMAGE_MAX_TOTAL_BYTES) {
      images.push({
        path: item.entry.path,
        status: 'error',
        mediaType: item.mediaType,
        sizeBytes: item.buffer.length,
        message: `Total attached image size would exceed ${(READ_IMAGE_MAX_TOTAL_BYTES / (1024 * 1024)).toFixed(1)}MB. Attach fewer or smaller images.`,
      })
      continue
    }

    totalAttachedBytes += item.buffer.length
    images.push(item.entry)
    mediaResults.push({
      type: 'media',
      data: item.buffer.toString('base64'),
      mediaType: item.mediaType,
    })
  }

  return [
    {
      type: 'json',
      value: { images },
    },
    ...mediaResults,
  ]
}
