import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildBunTestArgs,
  discoverCliTestFiles,
  isCliTestFileName,
  requireDiscoveredTestFiles,
} from '../../scripts/run-cli-tests'

describe('isCliTestFileName', () => {
  it('accepts .test.ts and .test.tsx suites', () => {
    expect(isCliTestFileName('chat.test.ts')).toBe(true)
    expect(isCliTestFileName('status-bar.test.tsx')).toBe(true)
  })

  it('rejects live integration suites so the default run never drives tmux', () => {
    expect(isCliTestFileName('rerender-perf.integration.test.ts')).toBe(false)
    expect(isCliTestFileName('integration-tmux.integration.test.ts')).toBe(false)
  })

  it('rejects non-test sources and helper modules', () => {
    expect(isCliTestFileName('chat.ts')).toBe(false)
    expect(isCliTestFileName('test-utils.ts')).toBe(false)
    expect(isCliTestFileName('chat.test-utils.ts')).toBe(false)
    // A directory named like a suite is not a suite.
    expect(isCliTestFileName('nested.test.ts')).toBe(true)
    expect(isCliTestFileName('thing.test.json')).toBe(false)
  })
})

describe('discoverCliTestFiles', () => {
  const withTempTree = (build: (root: string) => void): string[] => {
    const root = mkdtempSync(join(tmpdir(), 'cli-test-discovery-'))
    try {
      build(root)
      return discoverCliTestFiles(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  const write = (root: string, relativePath: string) => {
    const absolutePath = join(root, relativePath)
    const segments = relativePath.split('/')
    if (segments.length > 1) {
      mkdirSync(join(root, ...segments.slice(0, -1)), { recursive: true })
    }
    writeFileSync(absolutePath, '// fixture\n')
  }

  it('collects nested suites as sorted POSIX-relative paths', () => {
    const files = withTempTree((root) => {
      write(root, 'src/zeta.test.ts')
      write(root, 'src/alpha.test.tsx')
      write(root, 'src/components/__tests__/deep.test.ts')
      write(root, 'src/chat.ts')
    })

    expect(files).toEqual([
      'src/alpha.test.tsx',
      'src/components/__tests__/deep.test.ts',
      'src/zeta.test.ts',
    ])
  })

  it('prunes node_modules, .git, and dist', () => {
    const files = withTempTree((root) => {
      write(root, 'src/kept.test.ts')
      write(root, 'node_modules/leaked.test.ts')
      write(root, 'dist/leaked.test.ts')
      write(root, '.git/leaked.test.ts')
      write(root, 'src/node_modules/leaked.test.ts')
    })

    expect(files).toEqual(['src/kept.test.ts'])
  })

  it('excludes live integration suites discovered in the tree', () => {
    const files = withTempTree((root) => {
      write(root, 'src/__tests__/rerender-perf.integration.test.ts')
      write(root, 'src/__tests__/plain.test.ts')
    })

    expect(files).toEqual(['src/__tests__/plain.test.ts'])
  })

  it('returns an empty list for an empty tree instead of inventing entries', () => {
    expect(withTempTree(() => {})).toEqual([])
  })
})

describe('requireDiscoveredTestFiles', () => {
  it('fails closed on an empty discovery so the run cannot be a vacuous green', () => {
    expect(() => requireDiscoveredTestFiles([])).toThrow(
      'No test files found in cli',
    )
  })

  it('accepts a non-empty discovery', () => {
    expect(() => requireDiscoveredTestFiles(['src/chat.test.ts'])).not.toThrow()
  })
})

describe('buildBunTestArgs', () => {
  it('always isolates and lists the discovered files', () => {
    expect(buildBunTestArgs(['src/a.test.ts', 'src/b.test.tsx'])).toEqual([
      'test',
      '--isolate',
      'src/a.test.ts',
      'src/b.test.tsx',
    ])
  })

  it('forwards caller-supplied flags after the file list', () => {
    expect(buildBunTestArgs(['src/a.test.ts'], ['--bail=1'])).toEqual([
      'test',
      '--isolate',
      'src/a.test.ts',
      '--bail=1',
    ])
  })
})
