import { createHash } from 'node:crypto'
import path from 'node:path'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

export function diagnosticFileSet(cwd: string, files: string[]): string[] {
  return [...new Set(files.map((file) => path.resolve(cwd, file)))].sort()
}

/** Bound the extra postimage observation; adapters without bounded reads decline. */
export async function diagnosticPostimageMatches(params: {
  fs: CodebuffFileSystem
  hashes: Record<string, string | null>
  signal?: AbortSignal
}): Promise<boolean> {
  const entries = Object.entries(params.hashes)
  if (entries.length === 0 || entries.length > 32 || !params.fs.readRange)
    return false
  const chunkBytes = 64 * 1024
  const maxFileBytes = 2 * 1024 * 1024
  const maxTotalBytes = 4 * 1024 * 1024
  let totalBytes = 0
  try {
    for (const [file, expected] of entries) {
      if (params.signal?.aborted) return false
      if (expected === null) {
        try {
          await params.fs.stat(file)
          return false
        } catch (error) {
          if (
            !(
              error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'ENOENT'
            )
          )
            return false
        }
        continue
      }
      const hash = createHash('sha256')
      let offset = 0
      for (;;) {
        if (params.signal?.aborted) return false
        const range = await params.fs.readRange(
          file,
          offset,
          offset + chunkBytes,
        )
        if (
          range.data.byteLength > chunkBytes ||
          range.endExclusive !== offset + range.data.byteLength
        )
          return false
        offset += range.data.byteLength
        totalBytes += range.data.byteLength
        if (offset > maxFileBytes || totalBytes > maxTotalBytes) return false
        hash.update(range.data)
        if (range.data.byteLength < chunkBytes) break
      }
      if (`sha256:${hash.digest('hex')}` !== expected) return false
    }
    return !params.signal?.aborted
  } catch {
    return false
  }
}
