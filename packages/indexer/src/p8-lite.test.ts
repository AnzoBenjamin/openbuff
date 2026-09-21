import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { IndexManager } from './index-manager'
import {
  computeIndexSnapshotId,
  loadIndex,
  saveIndex,
  setWriteGitExclude,
} from './index-store'
import { compareRevisions } from './metadata-indexer'
import { statProjectFiles } from './file-walker'
import type {
  IndexedFile,
  MetadataIndex,
} from './types'

const roots: string[] = []

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-p8lite-'))
  roots.push(root)
  return root
}

afterEach(() => {
  // Ensure other tests sharing the singleton store aren't blocked by an
  // opt-out left enabled.
  setWriteGitExclude(true)
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

describe('P8.3 compareRevisions', () => {
  test('orders numeric revisions numerically across string/number forms', () => {
    const cases: Array<[
      string | number,
      string | number,
      number,
    ]> = [
      [9, 10, -1],
      ['9', 10, -1],
      [9, '10', -1],
      ['9', '10', -1],
      ['10', '9', 1],
      [10, 9, 1],
      ['007', '7', 0],
      [42, 42, 0],
      ['abc', 'abd', -1],
      [1, 'abc', -1],
    ]
    for (const [a, b, expected] of cases) {
      expect(Math.sign(compareRevisions(a, b))).toBe(expected)
    }
  })

  test('treats undefined operands as equal (guard skips)', () => {
    expect(compareRevisions(undefined, 5)).toBe(0)
    expect(compareRevisions(5, undefined)).toBe(0)
    expect(compareRevisions(undefined, undefined)).toBe(0)
  })
})

describe('P8.2 load-time validation', () => {
  const validFile = (filePath: string): IndexedFile => ({
    path: filePath,
    mtime: 1,
    size: 1,
    hash: 'hash-' + filePath,
    ext: '.ts',
    symbols: ['sym'],
    imports: [],
    headings: [],
    concepts: [],
  })

  test('drops malformed file entries at load instead of trusting them', async () => {
    const root = makeProject()
    const persisted = {
      version: '2' as const,
      projectRoot: root,
      builtAt: 1,
      fileCount: 3,
      files: {
        'good.ts': validFile('good.ts'),
        // Missing required arrays -> rebuild-worthy, not corrupt.
        'partial.ts': { path: 'partial.ts', mtime: 1, size: 1 } as unknown,
        // Wrong type for a required array.
        'badarr.ts': {
          ...validFile('badarr.ts'),
          symbols: 'not-an-array',
        } as unknown,
      },
      graph: { nodes: {}, edges: [] },
    }
    // Intentionally corrupt per-file entries keep their raw shape; the real
    // MetadataIndex type does not admit them, so the test fixture casts once.
    const persistedAsIndex = persisted as unknown as MetadataIndex
    expect(await saveIndex(persistedAsIndex, root)).toBe(true)

    const loaded = await loadIndex(root)
    expect(loaded?.files['good.ts']?.hash).toBe('hash-good.ts')
    expect(loaded?.files['partial.ts']).toBeUndefined()
    expect(loaded?.files['badarr.ts']).toBeUndefined()
    expect(loaded?.fileCount).toBe(1)
  })

  test('rebuilds structurally corrupt queryData at load (once, not per query)', async () => {
    const root = makeProject()
    const files = { 'src/a.ts': { ...validFile('src/a.ts'), hash: 'hash-a' } }
    const persisted = {
      version: '2' as const,
      projectRoot: root,
      builtAt: 1,
      fileCount: 1,
      files,
      graph: { nodes: {}, edges: [] },
      // Adjacency claims an edge index far beyond edges.length -> corrupt.
      queryData: {
        postings: { sym: ['src/a.ts'] },
        documentFrequencies: { sym: 1 },
        adjacency: { 'file:src/a.ts': [999] },
      },
    }
    expect(await saveIndex(persisted, root)).toBe(true)

    const loaded = await loadIndex(root)
    expect(loaded).not.toBeNull()
    // Corrupt adjacency replaced by a rebuilt (valid) accelerator set.
    expect(loaded?.queryData?.adjacency).toEqual({})
    expect(loaded?.queryData?.postings.sym).toEqual(['src/a.ts'])
  })

  test('keeps a valid persisted queryData untouched', async () => {
    const root = makeProject()
    const persisted = {
      version: '2' as const,
      projectRoot: root,
      builtAt: 1,
      fileCount: 1,
      files: { 'src/a.ts': { ...validFile('src/a.ts'), hash: 'hash-a' } },
      graph: { nodes: {}, edges: [] },
    }
    expect(await saveIndex(persisted, root)).toBe(true)
    const loaded = await loadIndex(root)
    expect(loaded?.queryData?.postings.sym).toEqual(['src/a.ts'])
  })
})

describe('P8.6 statProjectFiles symlink semantics', () => {
  test('skips symlink entries without following them out of the project', async () => {
    const root = makeProject()
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const realFile = 1\n')
    // Symlink out of the project (either direction must be skipped).
    try {
      fs.symlinkSync(
        path.join(os.tmpdir(), 'openbuff-p8lite-outside.ts'),
        path.join(root, 'link-out.ts'),
      )
      fs.writeFileSync(
        path.join(os.tmpdir(), 'openbuff-p8lite-outside.ts'),
        'export const outside = 1\n',
      )
      fs.symlinkSync('a.ts', path.join(root, 'link-in.ts'))
    } catch {
      // Symlinks unavailable on this platform/filesystem — nothing to assert.
      return
    }

    const files = await statProjectFiles(root, ['a.ts', 'link-out.ts', 'link-in.ts'])
    const paths = files.map((file) => file.relativePath).sort()
    expect(paths).toEqual(['a.ts'])
  })
})

describe('P8.6b git info exclude toggle', () => {
  test('skips the .git/info/exclude side effect when opted out', async () => {
    const root = makeProject()
    fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.git', 'info', 'exclude'),
      'custom\n',
    )
    setWriteGitExclude(false)
    await saveIndex(
      {
        version: '2' as const,
        projectRoot: root,
        builtAt: 1,
        fileCount: 0,
        files: {},
        graph: { nodes: {}, edges: [] },
      },
      root,
    )
    expect(
      fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'),
    ).toBe('custom\n')
  })
})

describe('P8.4 stale-delta revision monotonicity in IndexManager._build', () => {
  test('does not regress workspaceRevision when a stale complete delta is rejected', async () => {
    const root = makeProject()
    const seeded: MetadataIndex = {
      version: '2',
      projectRoot: root,
      builtAt: 1,
      fileCount: 1,
      workspaceRevision: 12,
      files: {
        'src/a.ts': {
          path: 'src/a.ts',
          mtime: 1,
          size: 1,
          hash: 'hash-a',
          ext: '.ts',
          symbols: [],
          imports: [],
          headings: [],
          concepts: [],
        },
      },
      graph: { nodes: {}, edges: [] },
    }
    expect(await saveIndex(seeded, root)).toBe(true)
    const seededSnapshotId = computeIndexSnapshotId(seeded)

    const mgr = IndexManager.getInstance(root, {})
    // Revision 9 is older than the incorporated revision 12:
    // updateMetadataIndex must reject the stale complete delta without
    // applying it, and _build must not stamp the stale revision onto the
    // returned (and re-persisted) index.
    mgr.markPathsChanged({
      changedPaths: ['src/a.ts'],
      complete: true,
      revision: 9,
    })
    await mgr.waitUntilReady(10_000)

    const internal = mgr as unknown as { index: MetadataIndex }
    // The persisted workspace journal revision stays monotonic (no
    // regression from 12 to 9), so already-incorporated deltas stay stale.
    expect(internal.index.workspaceRevision).toBe(12)
    expect((await loadIndex(root))?.workspaceRevision).toBe(12)
    // The content-addressed snapshotId must not churn on a rejected delta.
    expect(computeIndexSnapshotId(internal.index)).toBe(seededSnapshotId)
    expect(internal.index.parserDegraded).toBeUndefined()
  })
})
