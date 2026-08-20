import fs from 'fs'
import path from 'path'
import { describe, expect, test } from 'bun:test'
import { listDirectory } from '../list-directory'
import { OWNED_TEMP_SEGMENT_PATTERNS_FS_AWARE } from '../path-utils'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

function makeFs(overrides: Partial<CodebuffFileSystem> = {}): CodebuffFileSystem {
  return {
    readdir: async () => [],
    realpath: async (p: string) => String(p),
    mkdir: async () => undefined,
    readFile: async () => '',
    stat: async () => ({ isDirectory: () => false }) as unknown as never,
    unlink: async () => undefined,
    writeFile: async () => undefined,
    ...overrides,
  } as unknown as CodebuffFileSystem
}

describe('listDirectory containment', () => {
  test('rejects sibling /project-evil when project is /project', async () => {
    const fs = makeFs({
      readdir: async () => {
        throw new Error('should not reach readdir')
      },
    })
    const result = await listDirectory({ directoryPath: '/project-evil', projectPath: '/project', fs })
    expect((result[0].value as { errorMessage?: string }).errorMessage).toMatch(/outside the project directory/i)
  })
  test('rejects nested sibling /project-evil/sub', async () => {
    const fs = makeFs()
    const result = await listDirectory({ directoryPath: '/project-evil/sub', projectPath: '/project', fs })
    expect((result[0].value as { errorMessage?: string }).errorMessage).toMatch(/outside the project directory/i)
  })
  test('rejects sibling-prefix via relative traversal that resolves to sibling', async () => {
    const fs = makeFs({
      readdir: async () => {
        throw new Error('should not reach readdir')
      },
    })
    const result = await listDirectory({ directoryPath: '../project-evil', projectPath: '/project', fs })
    expect((result[0].value as { errorMessage?: string }).errorMessage).toMatch(/outside the project directory/i)
  })
  test('rejects symlink escape via injected filesystem realpath', async () => {
    const fs = makeFs({
      realpath: (async (input: import('fs').PathLike) => {
        const s = String(input)
        if (s === '/virtual/repo/link') return '/outside'
        return s
      }) as unknown as CodebuffFileSystem['realpath'],
      readdir: async () => {
        throw new Error('should not reach readdir for symlink escape')
      },
    })
    const result = await listDirectory({ directoryPath: 'link', projectPath: '/virtual/repo', fs })
    expect((result[0].value as { errorMessage?: string }).errorMessage).toMatch(/outside the project directory/i)
  })
  test('rejects symlink escape via nested path under symlinked directory', async () => {
    const fs = makeFs({
      realpath: (async (input: import('fs').PathLike) => {
        const s = String(input)
        if (s === '/virtual/repo/evil') return '/outside'
        if (s === '/virtual/repo/evil/subdir') return '/outside/subdir'
        return String(input)
      }) as unknown as CodebuffFileSystem['realpath'],
      readdir: async () => {
        throw new Error('should not reach readdir for nested symlink escape')
      },
    })
    const result = await listDirectory({ directoryPath: 'evil/subdir', projectPath: '/virtual/repo', fs })
    expect((result[0].value as { errorMessage?: string }).errorMessage).toMatch(/outside the project directory/i)
  })
  test('still rejects absolute sibling even when lexical prefix matches', async () => {
    const fs = makeFs({
      readdir: async () => {
        throw new Error('should not reach readdir')
      },
    })
    const result = await listDirectory({ directoryPath: '/a/project-evil', projectPath: '/a/project', fs })
    expect((result[0].value as { errorMessage?: string }).errorMessage).toMatch(/outside the project directory/i)
  })
  test('allows legitimate in-project directory when symlink points inside', async () => {
    const fs = makeFs({
      realpath: (async (input: import('fs').PathLike) => {
        const s = String(input)
        if (s === '/virtual/repo/link') return '/virtual/repo/real'
        return s
      }) as unknown as CodebuffFileSystem['realpath'],
      readdir: async () => [{ name: 'file.txt', isDirectory: () => false, isFile: () => true } as unknown as never],
    })
    const result = await listDirectory({ directoryPath: 'link', projectPath: '/virtual/repo', fs })
    expect((result[0].value as { errorMessage?: string }).errorMessage).toBeUndefined()
    expect((result[0].value as { files?: string[] }).files).toContain('file.txt')
  })
  test('allows legitimate in-project directory', async () => {
    const fs = makeFs({
      readdir: async () => [{ name: 'file.txt', isDirectory: () => false, isFile: () => true } as unknown as never],
    })
    const result = await listDirectory({ directoryPath: 'src', projectPath: '/virtual/repo', fs })
    expect((result[0].value as { errorMessage?: string }).errorMessage).toBeUndefined()
    expect((result[0].value as { files?: string[] }).files).toContain('file.txt')
  })
  test('caps huge directory listings via error to preserve persisted error contract', async () => {
    const hugeEntries = Array.from({ length: 5001 }, (_, i) => ({
      name: `file-${i}.txt`,
      isDirectory: () => false,
      isFile: () => true,
    }))
    const fs = makeFs({
      readdir: async () => hugeEntries as unknown as never,
    })
    const result = await listDirectory({ directoryPath: 'huge', projectPath: '/virtual/repo', fs })
    const value = result[0].value as {
      errorMessage?: string
      files?: string[]
      truncated?: boolean
      totalEntries?: number
      warning?: string
    }
    // Must preserve the original error contract for large dirs so persisted
    // error handling and consumers expecting errorMessage continue to work.
    // A future truncated-success shape would be additive optional fields.
    expect(value.errorMessage).toMatch(/too large|exceeds limit/i)
    expect(value.files).toBeUndefined()
    expect(value.truncated).toBeUndefined()
  })
})

describe('owned-temp patterns stay in sync with common', () => {
  test('FS-aware patterns match common/src/util/project-path-containment.ts', async () => {
    // Drift guard for RF-2: sdk/src/tools/path-utils.ts now re-exports the
    // canonical OWNED_TEMP_SEGMENT_PATTERNS from common instead of duplicating.
    // This test verifies the export still matches the source.
    const commonPath = path.resolve(import.meta.dir, '../../../../common/src/util/project-path-containment.ts')
    const commonContent = await fs.promises.readFile(commonPath, 'utf-8')
    const patternBlock = commonContent.match(/export const OWNED_TEMP_SEGMENT_PATTERNS[^=]*= \[([\s\S]*?)\]/)
    if (!patternBlock) throw new Error('Could not locate OWNED_TEMP_SEGMENT_PATTERNS in common')
    const sourcesInCommon = [...patternBlock[1].matchAll(/\/\^([^/]+)\$\//g)].map((m) => m[1])
    // Reconstruct full source strings with anchors as stored in RegExp.source
    const expectedSources = sourcesInCommon.map((inner) => `^${inner}$`)
    const actualSources = OWNED_TEMP_SEGMENT_PATTERNS_FS_AWARE.map((r) => r.source)
    expect(actualSources).toEqual(expectedSources)
  })
})
