import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  configureExternalReadRoots,
  resetExternalReadRootsForTesting,
} from '@codebuff/common/util/project-path-containment'

import {
  getProjectPathLookupKeys,
  getScopedReadPolicyAliases,
  isSafeProjectRelativePath,
  resolveFilePathForFileSystemOperation,
  resolveFilePathForFileSystemReadOperation,
  resolveFilePathForOperation,
  resolveFilePathForReadOperation,
  resolveFilePathWithinProject,
} from '../tools/path-utils'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

describe('[SEC-H01] isSafeProjectRelativePath', () => {
  test('rejects traversal, drive, UNC, and NUL inputs; allows in-project absolute POSIX form', () => {
    expect(isSafeProjectRelativePath('../secret')).toBe(false)
    expect(isSafeProjectRelativePath('src/../secret')).toBe(false)
    expect(isSafeProjectRelativePath('/repo/file.ts')).toBe(true)
    expect(isSafeProjectRelativePath('C:\\repo\\file.ts')).toBe(false)
    expect(isSafeProjectRelativePath('\\\\server\\share\\file.ts')).toBe(false)
    expect(isSafeProjectRelativePath('src/secret\0.txt')).toBe(false)
    expect(isSafeProjectRelativePath('src/file.ts')).toBe(true)
    expect(isSafeProjectRelativePath('..config')).toBe(true)
  })
})

describe('resolveFilePathWithinProject', () => {
  test('normalizes relative paths to full and project-relative paths', () => {
    expect(resolveFilePathWithinProject('/repo', 'src/file.ts')).toMatchObject({
      fullPath: '/repo/src/file.ts',
      relativePath: 'src/file.ts',
    })
  })

  test('normalizes absolute paths inside the project', () => {
    expect(
      resolveFilePathWithinProject('/repo', '/repo/src/file.ts'),
    ).toMatchObject({
      fullPath: '/repo/src/file.ts',
      relativePath: 'src/file.ts',
    })
  })

  test('accepts the project root itself', () => {
    expect(resolveFilePathWithinProject('/repo', '/repo')).toMatchObject({
      fullPath: '/repo',
      relativePath: '',
    })
    expect(resolveFilePathWithinProject('/repo', '.')).toMatchObject({
      fullPath: '/repo',
      relativePath: '',
    })
  })

  test('allows file names that start with two dots inside the project', () => {
    expect(
      resolveFilePathWithinProject('/repo', '/repo/..config'),
    ).toMatchObject({
      fullPath: '/repo/..config',
      relativePath: '..config',
    })
  })

  test('rejects paths outside the project', () => {
    expect(resolveFilePathWithinProject('/repo', '../outside.ts')).toBeNull()
    expect(resolveFilePathWithinProject('/repo', '/outside.ts')).toBeNull()
    expect(
      resolveFilePathWithinProject('/repo', '/repo-sibling/file.ts'),
    ).toBeNull()
  })
})

describe('getProjectPathLookupKeys', () => {
  test('returns the normalized relative key before the original absolute key', () => {
    expect(getProjectPathLookupKeys('/repo', '/repo/src/file.ts')).toEqual([
      'src/file.ts',
      '/repo/src/file.ts',
    ])
  })

  test('dedupes relative paths that are already normalized', () => {
    expect(getProjectPathLookupKeys('/repo', 'src/file.ts')).toEqual([
      'src/file.ts',
    ])
  })

  test('returns only the original key for paths outside the project', () => {
    expect(getProjectPathLookupKeys('/repo', '/outside.ts')).toEqual([
      '/outside.ts',
    ])
  })
})

describe('resolveFilePathWithinProject — symlink containment', () => {
  let tmpDir: string
  let outsideDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-utils-'))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
    // In-project symlink that escapes: tmpDir/evil -> outsideDir
    fs.symlinkSync(outsideDir, path.join(tmpDir, 'evil'))
    // Legit in-project symlink: tmpDir/link -> tmpDir/real
    fs.mkdirSync(path.join(tmpDir, 'real'))
    fs.symlinkSync(path.join(tmpDir, 'real'), path.join(tmpDir, 'link'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  })

  test('rejects a symlink that points outside the project', () => {
    expect(resolveFilePathWithinProject(tmpDir, 'evil')).toBeNull()
    expect(resolveFilePathWithinProject(tmpDir, 'evil/file.ts')).toBeNull()
  })

  test('rejects an outside symlink even when the target file does not exist', () => {
    expect(
      resolveFilePathWithinProject(tmpDir, 'evil/nonexistent.ts'),
    ).toBeNull()
  })

  test('allows a symlink that points inside the project', () => {
    expect(resolveFilePathWithinProject(tmpDir, 'link/file.ts')).toMatchObject({
      fullPath: path.join(tmpDir, 'link', 'file.ts'),
      relativePath: path.join('link', 'file.ts'),
    })
  })

  test('pins filesystem operations to the dereferenced in-project target', () => {
    expect(resolveFilePathForOperation(tmpDir, 'link/file.ts')).toMatchObject({
      operationPath: path.join(tmpDir, 'real', 'file.ts'),
      relativePath: path.join('link', 'file.ts'),
    })
  })

  test('pins missing create targets through an in-project directory symlink', () => {
    expect(
      resolveFilePathForOperation(tmpDir, 'link/missing/nested.ts'),
    ).toMatchObject({
      operationPath: path.join(tmpDir, 'real', 'missing', 'nested.ts'),
    })
  })

  test('preserves the final symlink for unlink-style operations', () => {
    expect(
      resolveFilePathForOperation(tmpDir, 'link', {
        followFinalSymlink: false,
      }),
    ).toMatchObject({
      operationPath: path.join(tmpDir, 'link'),
    })
  })

  test('preserves lexical behavior for synthetic non-existent paths', () => {
    // The original tests use '/repo' which doesn't exist on disk.
    // resolveRealPath must fall back to the lexical path in that case.
    expect(resolveFilePathWithinProject('/repo', 'src/file.ts')).toMatchObject({
      fullPath: '/repo/src/file.ts',
      relativePath: 'src/file.ts',
    })
  })
})

test('filesystem operations resolve symlinks through the injected filesystem', async () => {
  const virtualFs = {
    realpath: async (input: string) => {
      if (input === '/virtual/repo') return '/virtual/repo'
      if (input === '/virtual/repo/link') return '/outside'
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
  } as unknown as CodebuffFileSystem

  await expect(
    resolveFilePathForFileSystemOperation(
      '/virtual/repo',
      'link/file.ts',
      virtualFs,
    ),
  ).resolves.toBeNull()
})

describe('read-only operation resolvers', () => {
  let projectDir: string
  let externalRoot: string
  let externalFile: string

  /** Host-realpath-backed adapter for the async read resolver. */
  const hostFileSystem = {
    realpath: async (input: string) => fs.realpathSync(input),
  } as unknown as CodebuffFileSystem

  beforeEach(() => {
    resetExternalReadRootsForTesting()
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-resolver-proj-'))
    externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'read-resolver-ext-'))
    externalFile = path.join(externalRoot, 'notes.txt')
    fs.writeFileSync(externalFile, 'notes\n')
    fs.writeFileSync(
      path.join(projectDir, 'in-project.ts'),
      'export const a = 1\n',
    )
  })

  afterEach(() => {
    // The registry is module state: reset unconditionally so no later test
    // file inherits an open external read boundary.
    resetExternalReadRootsForTesting()
    fs.rmSync(projectDir, { recursive: true, force: true })
    fs.rmSync(externalRoot, { recursive: true, force: true })
  })

  test('an in-project path resolves identically to the write-path resolver', () => {
    configureExternalReadRoots([externalRoot])

    expect(resolveFilePathForReadOperation(projectDir, 'in-project.ts')).toEqual(
      resolveFilePathForOperation(projectDir, 'in-project.ts'),
    )
  })

  test('an allowlisted external file resolves with scope external-read', () => {
    configureExternalReadRoots([externalRoot])

    const resolved = resolveFilePathForReadOperation(projectDir, externalFile)
    expect(resolved).not.toBeNull()
    expect(resolved!.scope).toBe('external-read')
    expect(resolved!.operationPath).toBe(resolved!.realFullPath)
    // Outside the project, so `relativePath` is the absolute resolved path.
    expect(resolved!.relativePath).toBe(path.resolve(externalFile))

    // The write twin stays blind to the read allowlist.
    expect(resolveFilePathForOperation(projectDir, externalFile)).toBeNull()
  })

  test('the async read resolver agrees with the sync one', async () => {
    configureExternalReadRoots([externalRoot])

    const resolved = await resolveFilePathForFileSystemReadOperation(
      projectDir,
      externalFile,
      hostFileSystem,
    )
    expect(resolved).not.toBeNull()
    expect(resolved!.scope).toBe('external-read')
    expect(resolved!.operationPath).toBe(resolved!.realFullPath)

    // The write twin refuses it through the same injected filesystem.
    await expect(
      resolveFilePathForFileSystemOperation(
        projectDir,
        externalFile,
        hostFileSystem,
      ),
    ).resolves.toBeNull()
  })

  test('refuses the external file while the registry is unconfigured', () => {
    expect(resolveFilePathForReadOperation(projectDir, externalFile)).toBeNull()
  })
})

describe('getScopedReadPolicyAliases', () => {
  test('returns no extra aliases for a project-scoped path', () => {
    // The project-relative path is already the key a host policy targets, so
    // adding a bare basename alias there would widen host filters.
    expect(getScopedReadPolicyAliases('project', 'src/notes.png')).toEqual([])
  })

  test('builds basename and <scope>/<basename> keys for non-project scopes', () => {
    // The absolute relativePath of an external-read/owned-temp resolution never
    // matches a project-relative glob, so these are the keys a host filter can
    // actually target. Same alias shape read-files.ts builds.
    expect(
      getScopedReadPolicyAliases('external-read', '/external-root/notes.png'),
    ).toEqual(['notes.png', 'external-read/notes.png'])
    expect(
      getScopedReadPolicyAliases('owned-temp', '/tmp/openbuff-x/job.log'),
    ).toEqual(['job.log', 'owned-temp/job.log'])
  })

  test('normalizes backslash separators before taking the basename', () => {
    // On a POSIX host a backslash is a legal filename character, so the
    // normalization is what keeps the alias a bare basename rather than a
    // whole path fragment.
    expect(
      getScopedReadPolicyAliases('external-read', '/external-root\\notes.png'),
    ).toEqual(['notes.png', 'external-read/notes.png'])
  })
})
