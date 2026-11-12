import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { rankNearPaths } from '@codebuff/common/util/path-suggestions'

import { createNodeFileSystem } from '../tools/node-filesystem'
import { getFilesStructured } from '../tools/read-files'

// read-search-12: a missing file returns `not_found` plus near-match paths.
describe('read_files not_found candidates', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ob-read-suggest-')))
    mkdirSync(path.join(root, 'src', 'auth'), { recursive: true })
    writeFileSync(path.join(root, 'src', 'missing.ts'), 'export {}\n')
    writeFileSync(path.join(root, 'src', 'auth', 'login.ts'), 'export {}\n')
    writeFileSync(path.join(root, 'src', 'unrelated.ts'), 'export {}\n')
    writeFileSync(path.join(root, '.env'), 'SECRET=fake\n')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function readMissing(filePath: string) {
    const result = await getFilesStructured({
      filePaths: [filePath],
      cwd: root,
      fs: createNodeFileSystem(),
    })
    return result.results[0] as {
      status: string
      error?: { code: string; recovery?: string; candidates?: string[] }
    }
  }

  test('typo in the basename suggests the near match', async () => {
    const item = await readMissing('src/missng.ts')
    expect(item.status).toBe('error')
    expect(item.error?.code).toBe('not_found')
    expect(item.error?.recovery).toBe('discover_path')
    expect(item.error?.candidates).toEqual(['src/missing.ts'])
  })

  test('a missing parent directory walks up and finds the file one level down', async () => {
    const item = await readMissing('src/auht/login.ts')
    expect(item.error?.code).toBe('not_found')
    expect(item.error?.candidates).toEqual(['src/auth/login.ts'])
  })

  test('no near match yields no candidates field', async () => {
    const item = await readMissing('src/zzzzzzzzzzzz.ts')
    expect(item.error?.code).toBe('not_found')
    expect(item.error?.candidates).toBeUndefined()
  })

  test('sensitive files are never suggested', async () => {
    const item = await readMissing('.envv')
    expect(item.error?.code).toBe('not_found')
    expect(item.error?.candidates ?? []).not.toContain('.env')
  })
})

describe('rankNearPaths', () => {
  test('ranks by basename distance, then same directory', () => {
    expect(
      rankNearPaths('src/missng.ts', [
        'lib/missing.ts',
        'src/missing.ts',
        'src/other.ts',
      ]),
    ).toEqual(['src/missing.ts', 'lib/missing.ts'])
  })

  test('never returns the requested path and caps at 3', () => {
    const ranked = rankNearPaths('a/b.ts', [
      'a/b.ts',
      'x/b.ts',
      'y/b.ts',
      'z/b.ts',
      'w/b.ts',
    ])
    expect(ranked).toHaveLength(3)
    expect(ranked).not.toContain('a/b.ts')
  })
})
