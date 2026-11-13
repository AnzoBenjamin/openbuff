import { expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  getDirectories,
  getDirectoriesAsync,
  hasGitDirectory,
  hasGitDirectoryAsync,
  isDirectoryPathQuery,
  readDirectoryListing,
} from '../directory-browser'

test('directory links match sync discovery, dangling/file links are skipped and badges recognize worktrees', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'openbuff-folder-fixture-'),
  )
  try {
    fs.mkdirSync(path.join(root, 'real'))
    fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true })
    fs.mkdirSync(path.join(root, 'worktree'))
    fs.mkdirSync(path.join(root, 'git-data'))
    fs.writeFileSync(
      path.join(root, 'git-data', 'HEAD'),
      'ref: refs/heads/main\n',
    )
    fs.writeFileSync(
      path.join(root, 'worktree', '.git'),
      'gitdir: ../git-data\n',
    )
    fs.mkdirSync(path.join(root, 'fake'))
    fs.writeFileSync(path.join(root, 'fake', '.git'), 'not a repository')
    fs.writeFileSync(path.join(root, 'file'), 'file')
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'))
    fs.symlinkSync(path.join(root, 'file'), path.join(root, 'linked-file'))
    fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'dangling'))
    const frames: string[][] = []
    const result = await readDirectoryListing(root, {
      onEntries: (entries) =>
        frames.push(
          entries.filter((entry) => entry.isGitRepo).map((entry) => entry.name),
        ),
    })
    expect(result.entries.map((entry) => entry.name)).toEqual(
      getDirectories(root).map((entry) => entry.name),
    )
    expect(
      (await getDirectoriesAsync(root)).some(
        (entry) => entry.name === 'linked',
      ),
    ).toBe(true)
    expect(
      result.entries.some(
        (entry) => entry.name === 'linked-file' || entry.name === 'dangling',
      ),
    ).toBe(false)
    expect(frames[0]).toEqual([])
    expect(frames.at(-1)).toEqual(['repo', 'worktree'])
    expect(hasGitDirectory(path.join(root, 'worktree'))).toBe(true)
    expect(await hasGitDirectoryAsync(path.join(root, 'fake'))).toBe(false)
    expect(result.omitted).toBe(1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('directory listing reports source errors, honors abort and recognizes explicit path forms', async () => {
  await expect(
    readDirectoryListing('/openbuff-directory-does-not-exist'),
  ).rejects.toThrow()
  const controller = new AbortController()
  controller.abort()
  await expect(
    readDirectoryListing('/tmp', { signal: controller.signal }),
  ).rejects.toThrow()
  for (const value of [
    '/bad',
    './bad',
    '../bad',
    'C:\\bad',
    '\\\\server\\bad',
    'nested/bad',
    '~/bad',
  ])
    expect(isDirectoryPathQuery(value)).toBe(true)
  expect(isDirectoryPathQuery('unmatched-name')).toBe(false)
})
