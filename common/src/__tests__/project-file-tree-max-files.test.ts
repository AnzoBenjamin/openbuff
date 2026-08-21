import path from 'node:path'

import { describe, expect, test } from 'bun:test'

import { flattenTree, getProjectFileTree } from '../project-file-tree'

import type { CodebuffFileSystem } from '../types/filesystem'

const PROJECT_ROOT = '/synthetic-project-root'
const SUBDIRS = ['dir-a', 'dir-b', 'dir-c']
const FILES_PER_SUBDIR = 5000
const MAX_FILES = 50

/**
 * Builds a fully in-memory fs stub for a synthetic adversarial tree:
 *
 *   /synthetic-project-root
 *   ├── dir-a/  (5000 files)
 *   ├── dir-b/  (5000 files)
 *   └── dir-c/  (5000 files)
 *
 * `readdir` records every directory it is asked about so tests can prove
 * enumeration stops early instead of draining the whole tree. `stat` always
 * succeeds (throwing stats are swallowed by getProjectFileTree, which would
 * silently skew the counts), and ignore files resolve to empty content so
 * parseGitignore never hits real I/O or errors.
 */
function makeAdversarialFs() {
  const readdirCalls: string[] = []

  const fs = {
    readdir: async (dirPath: string): Promise<string[]> => {
      readdirCalls.push(dirPath)
      const relativeDir = path.relative(PROJECT_ROOT, dirPath)
      if (relativeDir === '') {
        return [...SUBDIRS]
      }
      if (SUBDIRS.includes(relativeDir)) {
        return Array.from(
          { length: FILES_PER_SUBDIR },
          (_, index) => `file-${String(index).padStart(4, '0')}.txt`,
        )
      }
      return []
    },
    stat: async (filePath: string) => {
      const relativePath = path.relative(PROJECT_ROOT, filePath)
      const isDirectory = SUBDIRS.includes(relativePath)
      return {
        isDirectory: () => isDirectory,
        isFile: () => !isDirectory,
        atimeMs: 0,
        mtimeMs: 0,
        ctimeMs: 0,
        birthtimeMs: 0,
        size: isDirectory ? 0 : 1,
      }
    },
    readFile: async (filePath: string): Promise<string> => {
      if (
        filePath.endsWith('.gitignore') ||
        filePath.endsWith('.openbuffignore')
      ) {
        return ''
      }
      throw Object.assign(new Error(`ENOENT: no such file: ${filePath}`), {
        code: 'ENOENT',
      })
    },
  } as unknown as CodebuffFileSystem

  return { fs, readdirCalls }
}

async function runScenario() {
  const { fs, readdirCalls } = makeAdversarialFs()
  const tree = await getProjectFileTree({
    projectRoot: PROJECT_ROOT,
    maxFiles: MAX_FILES,
    fs,
  })
  return { tree, readdirCalls }
}

describe('getProjectFileTree maxFiles cap', () => {
  test('stops enumerating once maxFiles files are collected instead of draining the tree', async () => {
    const { tree, readdirCalls } = await runScenario()

    const files = flattenTree(tree).filter((node) => node.type === 'file')
    expect(files).toHaveLength(MAX_FILES)

    // Only the root and the first subdir may be enumerated: the cap must fire
    // inside dir-a's entry loop, and the BFS while-condition must stop the
    // walk before dir-b/dir-c are ever readdir'd (15000 entries exist).
    expect(readdirCalls.length).toBeLessThanOrEqual(2)
    expect(readdirCalls).not.toContain(path.join(PROJECT_ROOT, 'dir-b'))
    expect(readdirCalls).not.toContain(path.join(PROJECT_ROOT, 'dir-c'))
  })

  test('yields a stable file count across repeated calls', async () => {
    const first = await runScenario()
    const second = await runScenario()

    const firstCount = flattenTree(first.tree).filter(
      (node) => node.type === 'file',
    ).length
    const secondCount = flattenTree(second.tree).filter(
      (node) => node.type === 'file',
    ).length

    expect(firstCount).toBe(MAX_FILES)
    expect(secondCount).toBe(firstCount)
    expect(second.readdirCalls.length).toBe(first.readdirCalls.length)
  })
})
