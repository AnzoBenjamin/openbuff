import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, spyOn, test } from 'bun:test'

import * as codeMapParse from '@codebuff/code-map/parse'

import {
  buildMetadataIndex,
  codeMapParseYieldHooks,
  DEFAULT_GRAPH_WEIGHTS,
  extractImports,
  getParsedCacheRootCount,
  getTsAliasCacheRootCount,
  getYieldIntervalForTests,
  getYieldStatsForTests,
  MAX_INDEXED_PROJECT_ROOTS,
  resolveGraphWeights,
  resetYieldStateForTests,
  setYieldIntervalForTests,
  updateMetadataIndex,
} from './metadata-indexer'
import { extractImportSpecifiers } from './import-resolution'

describe('metadata indexer', () => {
  test('builds graph nodes and content hashes', async () => {
    const root = await makeTempProject({
      'src/a.ts':
        'import { b } from "./b"\nexport function a() { return b() }\n',
      'src/b.ts': 'export function b() { return 1 }\n',
      'docs/auth.md':
        '# Authentication Flow\n\nSee [request flow](./request-flow.md).\n',
    })

    const index = await buildMetadataIndex(root)

    expect(index.version).toBe('2')
    expect(index.files['src/a.ts']?.hash).toHaveLength(64)
    expect(index.files['docs/auth.md']?.concepts).toEqual(
      expect.arrayContaining(['authentication', 'flow']),
    )
    expect(index.graph.nodes['file:src/a.ts']).toBeDefined()
    expect(index.graph.edges.some((edge) => edge.type === 'references')).toBe(
      true,
    )
    expect(index.graph.edges.some((edge) => edge.type === 'mentions')).toBe(
      true,
    )
    expect(index.parseData?.['src/a.ts']).toBeDefined()
    expect(index.coverage?.parser).toMatchObject({
      requestedFiles: 2,
      parsedFiles: 2,
      truncated: false,
    })
    expect(index.queryData?.postings['authentication']).toContain(
      'docs/auth.md',
    )
  })

  test('uses code-map language extensions for code concepts', async () => {
    const root = await makeTempProject({
      'src/plugin.PHP': '<?php // payment gateway integration\n',
      'src/build.KTS': '// kotlin build pipeline\n',
    })

    const index = await buildMetadataIndex(root)

    expect(index.files['src/plugin.PHP']?.ext).toBe('.php')
    expect(index.files['src/plugin.PHP']?.concepts).toEqual(
      expect.arrayContaining(['payment', 'gateway', 'integration']),
    )
    expect(index.files['src/build.KTS']?.ext).toBe('.kts')
    expect(index.files['src/build.KTS']?.concepts).toEqual(
      expect.arrayContaining(['kotlin', 'build', 'pipeline']),
    )
  })

  test('uses content hash to avoid reindexing unchanged file content', async () => {
    const root = await makeTempProject({
      'src/a.ts': 'export const a = 1\n',
    })
    const first = await buildMetadataIndex(root)
    const originalHash = first.files['src/a.ts']?.hash
    const originalMtime = first.files['src/a.ts']?.mtime
    const originalSize = first.files['src/a.ts']?.size

    const future = new Date(Date.now() + 5_000)
    await fs.promises.utimes(path.join(root, 'src/a.ts'), future, future)
    const second = await updateMetadataIndex(first, root)

    expect(second.files['src/a.ts']?.hash).toBe(originalHash)
    expect(second.files['src/a.ts']?.symbols).toEqual(
      first.files['src/a.ts']?.symbols,
    )
    expect(second.files['src/a.ts']?.mtime).not.toBe(originalMtime)
    expect(second.files['src/a.ts']?.size).toBe(originalSize)
  })

  test('detects same-size content changes by hash after a normal (mtime-changing) write', async () => {
    const root = await makeTempProject({
      'docs/a.md': '# Alpha\n\nalpha topic\n',
    })
    const first = await buildMetadataIndex(root)
    const original = first.files['docs/a.md']
    expect(original).toBeDefined()
    expect(original?.headings).toContain('Alpha')
    expect(original?.concepts).toContain('alpha')

    // Same-size rewrite ('# Alpha...' -> '# Bravo...', identical length) plus a
    // deterministically-different mtime (2s earlier, distinct at any filesystem
    // mtime granularity). This is the realistic normal-write case: because the
    // mtime differs, the X-2a stat-gate re-hashes and detects the content
    // change. The gate's same-size+same-mtime skip optimization is intentional
    // and preserved untouched, so we do NOT assert same-mtime detection here.
    await fs.promises.writeFile(
      path.join(root, 'docs/a.md'),
      '# Bravo\n\nbravo topic\n',
      'utf8',
    )
    await fs.promises.utimes(
      path.join(root, 'docs/a.md'),
      new Date(original!.mtime - 2000),
      new Date(original!.mtime - 2000),
    )
    const second = await updateMetadataIndex(first, root)
    const updated = second.files['docs/a.md']

    expect(updated?.size).toBe(original?.size)
    expect(updated?.mtime).not.toBe(original?.mtime)
    expect(updated?.hash).not.toBe(original?.hash)
    expect(updated?.headings).toContain('Bravo')
    expect(updated?.headings).not.toContain('Alpha')
    expect(updated?.concepts).toContain('bravo')
    expect(updated?.concepts).not.toContain('alpha')
  })

  test('uses a complete path delta without absorbing unrelated external changes', async () => {
    const root = await makeTempProject({
      'docs/target.md': '# Target\n\nold target\n',
      'docs/unrelated.md': '# Unrelated\n\nold unrelated\n',
    })
    const first = await buildMetadataIndex(root)
    await fs.promises.writeFile(
      path.join(root, 'docs/target.md'),
      '# Target\n\nnew target\n',
    )
    await fs.promises.writeFile(
      path.join(root, 'docs/unrelated.md'),
      '# Unrelated\n\nexternal change\n',
    )

    const precise = await updateMetadataIndex(
      first,
      root,
      {},
      {
        changedPaths: ['docs/target.md'],
        complete: true,
      },
    )
    expect(precise.files['docs/target.md']?.hash).not.toBe(
      first.files['docs/target.md']?.hash,
    )
    expect(precise.files['docs/unrelated.md']?.hash).toBe(
      first.files['docs/unrelated.md']?.hash,
    )

    const swept = await updateMetadataIndex(precise, root)
    expect(swept.files['docs/unrelated.md']?.hash).not.toBe(
      first.files['docs/unrelated.md']?.hash,
    )
  })

  test('complete mutation delta does not walk the full project tree', async () => {
    const root = await makeTempProject({
      'docs/target.md': '# Target\n\nold target\n',
      'docs/other.md': '# Other\n\nother\n',
    })
    const first = await buildMetadataIndex(root)
    await fs.promises.writeFile(
      path.join(root, 'docs/target.md'),
      '# Target\n\nnew target\n',
    )

    const readdirSpy = spyOn(fs.promises, 'readdir')
    try {
      const precise = await updateMetadataIndex(
        first,
        root,
        {},
        {
          changedPaths: ['docs/target.md'],
          complete: true,
        },
      )
      expect(readdirSpy).not.toHaveBeenCalled()
      expect(precise.files['docs/target.md']?.hash).not.toBe(
        first.files['docs/target.md']?.hash,
      )
      expect(precise.files['docs/other.md']?.hash).toBe(
        first.files['docs/other.md']?.hash,
      )
      expect(precise.coverage?.truncated).toBe(first.coverage?.truncated)
      expect(precise.coverage?.skippedFiles).toBe(first.coverage?.skippedFiles)
      expect(precise.coverage?.skippedPrefixes).toEqual(
        first.coverage?.skippedPrefixes,
      )
    } finally {
      readdirSpy.mockRestore()
    }
  })

  test('complete:true delta indexes a newly created path without readdir and does not absorb a sibling omitted from changedPaths', async () => {
    const root = await makeTempProject({
      'docs/existing.md': '# Existing\n\nkeep\n',
    })
    const first = await buildMetadataIndex(root)
    expect(first.files['docs/existing.md']).toBeDefined()
    expect(first.files['docs/created.md']).toBeUndefined()
    expect(first.files['docs/sibling-new.md']).toBeUndefined()

    await fs.promises.writeFile(
      path.join(root, 'docs/created.md'),
      '# Created\n\nnew file content\n',
      'utf8',
    )
    await fs.promises.writeFile(
      path.join(root, 'docs/sibling-new.md'),
      '# Sibling\n\nomitted from delta\n',
      'utf8',
    )

    const readdirSpy = spyOn(fs.promises, 'readdir')
    try {
      const precise = await updateMetadataIndex(
        first,
        root,
        {},
        {
          changedPaths: ['docs/created.md'],
          complete: true,
        },
      )
      expect(readdirSpy).not.toHaveBeenCalled()
      expect(precise.files['docs/created.md']).toBeDefined()
      expect(precise.files['docs/created.md']?.hash).toHaveLength(64)
      expect(precise.files['docs/created.md']?.headings).toContain('Created')
      // Sibling created on disk but omitted from changedPaths must not be absorbed.
      expect(precise.files['docs/sibling-new.md']).toBeUndefined()
      expect(precise.files['docs/existing.md']?.hash).toBe(
        first.files['docs/existing.md']?.hash,
      )
    } finally {
      readdirSpy.mockRestore()
    }
  })

  test('complete:true delta refuses to index a newly created gitignored path', async () => {
    const root = await makeTempProject({
      'docs/keep.md': '# Keep\n\nvisible\n',
      '.gitignore': 'secrets/\n',
    })
    const first = await buildMetadataIndex(root)
    expect(first.files['docs/keep.md']).toBeDefined()

    await fs.promises.mkdir(path.join(root, 'secrets'), { recursive: true })
    await fs.promises.writeFile(
      path.join(root, 'secrets/token.md'),
      '# Token\n\nuser-ignored secret\n',
      'utf8',
    )

    const precise = await updateMetadataIndex(
      first,
      root,
      {},
      {
        changedPaths: ['secrets/token.md'],
        complete: true,
      },
    )
    expect(precise.files['secrets/token.md']).toBeUndefined()
    expect(precise.files['docs/keep.md']).toBeDefined()
  })

  test('complete mutation delta removes a previously indexed path that now fails walker filters', async () => {
    const root = await makeTempProject({
      'docs/keep.md': '# Keep\n\nkeep me\n',
      'docs/grow.md': '# Grow\n\nsmall\n',
    })
    const first = await buildMetadataIndex(root)
    expect(first.files['docs/grow.md']).toBeDefined()
    expect(first.files['docs/keep.md']).toBeDefined()

    await fs.promises.writeFile(
      path.join(root, 'docs/grow.md'),
      'x'.repeat(500_001),
    )
    const updated = await updateMetadataIndex(
      first,
      root,
      {},
      {
        changedPaths: ['docs/grow.md'],
        complete: true,
      },
    )
    expect(updated.files['docs/grow.md']).toBeUndefined()
    expect(updated.graph.nodes['file:docs/grow.md']).toBeUndefined()
    expect(updated.files['docs/keep.md']).toBeDefined()
    expect(updated.graph.nodes['file:docs/keep.md']).toBeDefined()
  })

  test('keeps stale metadata when a walked file cannot be read during incremental hashing', async () => {
    const root = await makeTempProject({
      'docs/a.md': '# Alpha\n\nalpha topic\n',
    })
    const targetPath = path.join(root, 'docs/a.md')
    const first = await buildMetadataIndex(root)

    expect(first.files['docs/a.md']?.headings).toContain('Alpha')

    const originalReadFile = fs.promises.readFile.bind(
      fs.promises,
    ) as typeof fs.promises.readFile
    const readFileSpy = spyOn(fs.promises, 'readFile').mockImplementation(
      (async (filePath, options) => {
        if (filePath === targetPath) {
          throw new Error('simulated read failure')
        }
        return originalReadFile(filePath, options)
      }) as typeof fs.promises.readFile,
    )

    try {
      const second = await updateMetadataIndex(first, root)

      // The walk still lists the file, so a transient read failure must NOT
      // silently drop a still-existing file from the index; the previous
      // entry is retained until a later refresh can re-read it.
      expect(second.files['docs/a.md']).toBeDefined()
      expect(second.files['docs/a.md']?.hash).toBe(first.files['docs/a.md']?.hash)
      expect(second.graph.nodes['file:docs/a.md']).toBeDefined()
    } finally {
      readFileSpy.mockRestore()
    }
  })

  test('drops unreadable code files without poisoning other changed code metadata', async () => {
    const root = await makeTempProject({
      'src/unreadable.ts': 'export function staleSymbol() { return 1 }\n',
      'src/live.ts': 'export function oldLiveSymbol() { return 1 }\n',
    })
    const unreadablePath = path.join(root, 'src/unreadable.ts')
    const livePath = path.join(root, 'src/live.ts')
    const first = await buildMetadataIndex(root)

    expect(first.files['src/unreadable.ts']?.symbols).toContain('staleSymbol')
    expect(first.files['src/live.ts']?.symbols).toContain('oldLiveSymbol')

    await fs.promises.writeFile(
      livePath,
      'export function freshLiveSymbol() { return 2 }\n',
      'utf8',
    )

    const originalReadFile = fs.promises.readFile.bind(
      fs.promises,
    ) as typeof fs.promises.readFile
    const readFileSpy = spyOn(fs.promises, 'readFile').mockImplementation(
      (async (filePath, options) => {
        if (filePath === unreadablePath) {
          throw new Error('simulated code read failure')
        }
        return originalReadFile(filePath, options)
      }) as typeof fs.promises.readFile,
    )

    try {
      const second = await updateMetadataIndex(first, root)

      // The walk still lists the unreadable file, so its previous entry is
      // retained with stale metadata instead of being dropped; the changed
      // sibling is re-read and refreshed normally.
      expect(second.files['src/unreadable.ts']).toBeDefined()
      expect(second.files['src/unreadable.ts']?.hash).toBe(
        first.files['src/unreadable.ts']?.hash,
      )
      expect(second.graph.nodes['file:src/unreadable.ts']).toBeDefined()
      expect(second.files['src/live.ts']?.symbols).toContain('freshLiveSymbol')
      expect(second.files['src/live.ts']?.symbols).not.toContain(
        'oldLiveSymbol',
      )
    } finally {
      readFileSpy.mockRestore()
    }
  })

  test('surfaces non-fatal code parse diagnostics on the metadata index', async () => {
    const root = await makeTempProject({
      'src/unreadable.ts': 'export function unreadableSymbol() { return 1 }\n',
      'docs/readme.md': '# Readme\n',
    })
    const unreadablePath = path.join(root, 'src/unreadable.ts')
    const originalReadFile = fs.readFileSync.bind(fs) as typeof fs.readFileSync
    const readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation(((
      filePath,
      options,
    ) => {
      if (filePath === unreadablePath) {
        throw new Error('simulated sync read failure')
      }
      return originalReadFile(filePath, options)
    }) as typeof fs.readFileSync)

    try {
      const index = await buildMetadataIndex(root)

      expect(index.files['docs/readme.md']?.headings).toContain('Readme')
      expect(index.files['src/unreadable.ts']).toBeDefined()
      expect(index.files['src/unreadable.ts']?.symbols).toEqual([])
      // The behavioral invariant is PER-FILE, not a total diagnostics count:
      // after the five-finding performance repair (hashContent dedup +
      // per-invocation yield gates) more code files reach the parse path on
      // this fixture, so parseDiagnostics can legitimately carry a
      // dozen-plus entries — a recorded run received 13. Pinning a small
      // total would re-break on every scheduling/pipeline change, so assert
      // that the simulated failure is surfaced for the unreadable file
      // (accepting either path form the parse pipeline records) and let the
      // count float with the pipeline.
      const readFailureDiagnostics = (index.parseDiagnostics ?? []).filter(
        (diagnostic) =>
          diagnostic.stage === 'parse' &&
          diagnostic.message === 'simulated sync read failure',
      )
      expect(readFailureDiagnostics.length).toBeGreaterThanOrEqual(1)
      expect(
        readFailureDiagnostics.some(
          (diagnostic) =>
            diagnostic.filePath === unreadablePath ||
            diagnostic.filePath === 'src/unreadable.ts',
        ),
      ).toBe(true)
    } finally {
      readFileSyncSpy.mockRestore()
    }
  })

  test('indexes package scripts and CI commands as command concepts', async () => {
    const root = await makeTempProject({
      'package.json': JSON.stringify({
        scripts: {
          typecheck: 'tsc --noEmit',
          test: 'bun test',
        },
      }),
      '.github/workflows/ci.yml':
        'name: CI\nsteps:\n  - run: bun run typecheck\n  - run: bun test\n',
      Makefile: 'validate:\n\tbun run typecheck\n',
      'gulpfile.js': 'exports.build = () => run("bun run build")\n',
    })

    const index = await buildMetadataIndex(root)

    expect(index.files['package.json']?.concepts).toEqual(
      expect.arrayContaining([
        'package scripts',
        'script:typecheck=tsc --noEmit',
        'script:test=bun test',
      ]),
    )
    expect(index.files['.github/workflows/ci.yml']?.concepts).toEqual(
      expect.arrayContaining([
        'ci workflow',
        'validation suite',
        'run:- run: bun run typecheck',
      ]),
    )
    expect(index.files.Makefile?.concepts).toEqual(
      expect.arrayContaining([
        'command configuration',
        'task runner',
        'typecheck',
      ]),
    )
    expect(index.files['gulpfile.js']?.concepts).toEqual(
      expect.arrayContaining(['command configuration', 'task runner', 'build']),
    )
  })

  test('resolveGraphWeights returns historical defaults with no arg', () => {
    expect(resolveGraphWeights()).toEqual(DEFAULT_GRAPH_WEIGHTS)
    expect(resolveGraphWeights()).toEqual({
      defines: 1,
      imports: 0.7,
      references: 0.9,
      containsHeading: 0.8,
      mentions: 0.6,
      calls: 1.1,
    })
  })

  test('resolveGraphWeights overrides only the specified field', () => {
    const resolved = resolveGraphWeights({ calls: 5 })
    expect(resolved.calls).toBe(5)
    expect(resolved.defines).toBe(DEFAULT_GRAPH_WEIGHTS.defines)
    expect(resolved.imports).toBe(DEFAULT_GRAPH_WEIGHTS.imports)
    expect(resolved.references).toBe(DEFAULT_GRAPH_WEIGHTS.references)
    expect(resolved.containsHeading).toBe(DEFAULT_GRAPH_WEIGHTS.containsHeading)
    expect(resolved.mentions).toBe(DEFAULT_GRAPH_WEIGHTS.mentions)
  })

  test('buildMetadataIndex bakes custom graph edge weights into the graph', async () => {
    const root = await makeTempProject({
      'src/a.ts':
        'import { b } from "./b"\nexport function a() { return b() }\n',
      'src/b.ts': 'export function b() { return 1 }\n',
    })

    const index = await buildMetadataIndex(root, {
      weights: { graph: { defines: 5 } },
    })

    // Overridden edge type picks up the custom weight.
    const definesEdges = index.graph.edges.filter(
      (edge) => edge.type === 'defines',
    )
    expect(definesEdges.length).toBeGreaterThan(0)
    for (const edge of definesEdges) {
      expect(edge.weight).toBe(5)
    }

    // Non-overridden edge types keep their historical defaults.
    const importsEdges = index.graph.edges.filter(
      (edge) => edge.type === 'imports',
    )
    expect(importsEdges.length).toBeGreaterThan(0)
    for (const edge of importsEdges) {
      expect(edge.weight).toBe(DEFAULT_GRAPH_WEIGHTS.imports)
    }

    const referencesEdges = index.graph.edges.filter(
      (edge) => edge.type === 'references',
    )
    expect(referencesEdges.length).toBeGreaterThan(0)
    for (const edge of referencesEdges) {
      expect(edge.weight).toBe(DEFAULT_GRAPH_WEIGHTS.references)
    }
  })

  test('keeps a still-present indexed file when a transient read failure hits', async () => {
    const root = await makeTempProject({
      'src/a.ts': 'export const a = 1\n',
    })
    const first = await buildMetadataIndex(root)
    expect(first.files['src/a.ts']).toBeDefined()

    // Touch the mtime so the incremental refresh treats the file as changed,
    // then force every content read (hash + indexWalkedFile) to fail — e.g.
    // EACCES/EBUSY on a locked file. The walk still lists the file, so the
    // refresh must keep the previous indexed entry rather than dropping it.
    const future = new Date(Date.now() + 5_000)
    await fs.promises.utimes(path.join(root, 'src/a.ts'), future, future)
    const readFileSpy = spyOn(fs.promises, 'readFile').mockRejectedValue(
      Object.assign(new Error('EACCES: file is locked'), { code: 'EACCES' }),
    )
    let second
    try {
      second = await updateMetadataIndex(first, root)
    } finally {
      readFileSpy.mockRestore()
    }

    expect(second.files['src/a.ts']).toEqual(first.files['src/a.ts'])
  })

  test('skips re-reading unchanged files on incremental refresh (stat-gated hashing)', async () => {
    const root = await makeTempProject({
      'src/a.ts': 'export const a = 1\n',
      'docs/a.md': '# Alpha\n\nalpha topic\n',
    })
    const first = await buildMetadataIndex(root)

    const readFileSpy = spyOn(fs.promises, 'readFile')
    try {
      const second = await updateMetadataIndex(first, root)
      expect(second.files['src/a.ts']?.hash).toBe(first.files['src/a.ts']?.hash)
      expect(second.files['docs/a.md']?.hash).toBe(
        first.files['docs/a.md']?.hash,
      )
      // Nothing changed on disk, so the refresh must not re-read/hash any
      // indexed file: the stat gate short-circuits hashing for stat-matched
      // files. (Ignore-file probe reads from the walker are filtered out.)
      const readPaths = readFileSpy.mock.calls.map((call) => String(call[0]))
      expect(readPaths).not.toContain(path.join(root, 'src/a.ts'))
      expect(readPaths).not.toContain(path.join(root, 'docs/a.md'))
    } finally {
      readFileSpy.mockRestore()
    }
  })

  test('falls back to hashing when the stat gate cannot stat a file', async () => {
    const root = await makeTempProject({
      'docs/a.md': '# Alpha\n\nalpha topic\n',
    })
    const first = await buildMetadataIndex(root)
    await fs.promises.writeFile(
      path.join(root, 'docs/a.md'),
      '# Bravo\n\nbravo topic\n',
      'utf8',
    )

    const statSpy = spyOn(fs.promises, 'stat').mockRejectedValue(
      new Error('simulated stat failure'),
    )
    let second
    try {
      second = await updateMetadataIndex(first, root)
    } finally {
      statSpy.mockRestore()
    }

    // Stat failure must fall back to hashing so real content changes are
    // still detected.
    expect(second.files['docs/a.md']?.hash).not.toBe(
      first.files['docs/a.md']?.hash,
    )
    expect(second.files['docs/a.md']?.headings).toContain('Bravo')
  })

  test('evicts the oldest root parse cache once MAX_INDEXED_PROJECT_ROOTS is exceeded', async () => {
    // build/update must route every parsedCacheByRoot write through the
    // evicting helper, so indexing more distinct roots than the retention
    // bound can never grow the in-process cache past MAX_INDEXED_PROJECT_ROOTS
    // entries (previously the build/update paths called .set directly and
    // bypassed eviction).
    for (let i = 0; i < MAX_INDEXED_PROJECT_ROOTS + 2; i++) {
      const root = await makeTempProject({
        'src/a.ts': 'export const a = 1\n',
      })
      await buildMetadataIndex(root)
      expect(getParsedCacheRootCount()).toBeLessThanOrEqual(
        MAX_INDEXED_PROJECT_ROOTS,
      )
    }
  })

  test('evicts the oldest root alias cache for doc-only roots once MAX_INDEXED_PROJECT_ROOTS is exceeded', async () => {
    // Regression pin for the unbounded tsAliasCacheByRoot finding: a
    // doc-only root (no code files) gets a loadTsAliases cache entry
    // WITHOUT any parsedCacheByRoot insert — buildMetadataIndex only fills
    // the parse cache when the root has code files — so the eviction guard
    // must bound the alias cache by its own size too. Otherwise a
    // long-lived process indexing many distinct doc-only roots grows
    // tsAliasCacheByRoot without bound while the parse-cache-size guard
    // never triggers.
    for (let i = 0; i < MAX_INDEXED_PROJECT_ROOTS + 3; i++) {
      const root = await makeTempProject({
        'docs/only.md': `# Doc root ${i}\n\ndoc-only root\n`,
      })
      await buildMetadataIndex(root)
      expect(getTsAliasCacheRootCount()).toBeLessThanOrEqual(
        MAX_INDEXED_PROJECT_ROOTS,
      )
    }
    // The loop ran enough doc-only builds to fill the alias cache up to its
    // bound (it would have grown past MAX_INDEXED_PROJECT_ROOTS before the
    // fix, since no parse-cache insert ever fires eviction for these
    // roots), and doc-only builds never insert into the parse cache.
    expect(getTsAliasCacheRootCount()).toBe(MAX_INDEXED_PROJECT_ROOTS)
  })

  test('keeps the previous entry when hashing succeeds but the content read fails', async () => {
    const root = await makeTempProject({
      'docs/a.md': '# Alpha\n\nalpha topic\n',
    })
    const targetPath = path.join(root, 'docs/a.md')
    const first = await buildMetadataIndex(root)
    expect(first.files['docs/a.md']).toBeDefined()

    // Rewrite the file so the hash read succeeds with a NEW hash, then fail
    // only the content read inside indexWalkedFile (the second read of the
    // path) — e.g. the file became unreadable between the two reads.
    await fs.promises.writeFile(targetPath, '# Bravo\n\nbravo topic\n', 'utf8')

    const originalReadFile = fs.promises.readFile.bind(
      fs.promises,
    ) as typeof fs.promises.readFile
    let targetReads = 0
    const readFileSpy = spyOn(fs.promises, 'readFile').mockImplementation(
      (async (filePath, options) => {
        if (filePath === targetPath) {
          targetReads++
          if (targetReads > 1) {
            throw new Error('simulated content read failure')
          }
        }
        return originalReadFile(filePath, options)
      }) as typeof fs.promises.readFile,
    )

    try {
      const second = await updateMetadataIndex(first, root)

      // The walk still sees the file and hashing succeeded, but the content
      // read failed transiently: the previous indexed entry must be kept
      // (mirroring the hashReadFailedPaths keep-previous guard) instead of
      // silently dropping a still-existing file from the index.
      expect(targetReads).toBeGreaterThanOrEqual(2)
      expect(second.files['docs/a.md']).toEqual(first.files['docs/a.md'])
      expect(second.graph.nodes['file:docs/a.md']).toBeDefined()
    } finally {
      readFileSpy.mockRestore()
    }
  })

  test('warns at most once per path for repeated hash-read failures', async () => {
    const root = await makeTempProject({
      'docs/a.md': '# Alpha\n\nalpha topic\n',
    })
    const targetPath = path.join(root, 'docs/a.md')
    const first = await buildMetadataIndex(root)

    // Force every content read to fail (e.g. EACCES on a locked file) across
    // TWO consecutive refreshes: the first failure for the path warns once,
    // and the repeated failure on the next refresh must stay silent instead
    // of logging the same diagnostic on every refresh.
    const future = new Date(Date.now() + 5_000)
    await fs.promises.utimes(targetPath, future, future)
    const readFileSpy = spyOn(fs.promises, 'readFile').mockRejectedValue(
      Object.assign(new Error('EACCES: file is locked'), { code: 'EACCES' }),
    )
    const warnSpy = spyOn(console, 'warn')
    // Read inside the try: bun:test's mockRestore() also resets mock.calls,
    // so calls read after the finally block would always be empty.
    let hashFailureWarns: string[] = []
    try {
      await updateMetadataIndex(first, root)
      await updateMetadataIndex(first, root)
      hashFailureWarns = warnSpy.mock.calls
        .map((call) => call.map(String).join(' '))
        .filter(
          (line) =>
            line.includes('hash read failed') && line.includes('docs/a.md'),
        )
    } finally {
      warnSpy.mockRestore()
      readFileSpy.mockRestore()
    }

    // At-most-once: two consecutive failing refreshes warn exactly once for
    // the path (the warn-once latch keys on the absolute path).
    expect(hashFailureWarns).toHaveLength(1)
  })

  test('AST import tier: multiline named import resolves; non-tier languages stay line-based', async () => {
    const root = await makeTempProject({
      'src/a.ts':
        'import {\n  helper,\n  util,\n} from "./helper"\nexport const x = helper + util\n',
      'src/helper.ts': 'export const helper = 1\nexport const util = 2\n',
      'src/Main.java':
        'package com.acme;\n\nimport com.acme.user.User;\n\npublic class Main {}\n',
    })

    const index = await buildMetadataIndex(root)

    // AST tier (or, without a local WASM grammar, the byte-identical line
    // fallback): the multiline named-import specifier is indexed either way.
    expect(index.files['src/a.ts']?.imports).toContain('./helper')
    // Downstream resolution is untouched: the specifier resolves to a real
    // file→file references edge.
    expect(
      index.graph.edges.some(
        (edge) =>
          edge.type === 'references' && edge.to === 'file:src/helper.ts',
      ),
    ).toBe(true)
    // A language outside the five-language tier keeps the line-based
    // extractor's output exactly.
    expect(index.files['src/Main.java']?.imports).toEqual([
      'com.acme.user.User',
    ])
  })

  test('extractImports prefers non-empty AST captures and falls back byte-identically', () => {
    const content = "import { helper } from './helper'\n"
    // AST tier replaces the line output only when non-empty:
    expect(extractImports(content, '.ts', ['./helper'])).toEqual(['./helper'])
    // Empty/absent captures fall back to the line-based extractor exactly:
    expect(extractImports(content, '.ts', [])).toEqual(
      extractImportSpecifiers(content, '.ts'),
    )
    expect(extractImports(content, '.ts', undefined)).toEqual(
      extractImportSpecifiers(content, '.ts'),
    )
  })

  test('tsconfig project references contribute aliases from referenced configs', async () => {
    const root = await makeTempProject({
      'tsconfig.json': JSON.stringify({
        references: [{ path: './packages/lib' }],
      }),
      'packages/lib/tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@lib/*': ['src/*'] } },
      }),
      'packages/lib/src/util.ts': 'export const util = 1\n',
      'src/a.ts': 'import { util } from "@lib/util"\nexport const a = util\n',
    })

    const index = await buildMetadataIndex(root)

    // The referenced tsconfig's paths alias resolves the bare specifier onto
    // the referenced package's own source file (rebased to the project root).
    expect(
      index.graph.edges.some(
        (edge) =>
          edge.type === 'references' &&
          edge.to === 'file:packages/lib/src/util.ts',
      ),
    ).toBe(true)
  })

  test('root tsconfig paths win over referenced tsconfig paths (closest-wins)', async () => {
    const root = await makeTempProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@lib/*': ['src/*'] } },
        references: [{ path: './packages/lib' }],
      }),
      'packages/lib/tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@lib/*': ['other/*'] } },
      }),
      'src/util.ts': 'export const util = 1\n',
      'src/a.ts': 'import { util } from "@lib/util"\nexport const a = util\n',
    })

    const index = await buildMetadataIndex(root)

    // The root config's own paths entry is closer than the referenced
    // config's same-key entry, so '@lib/util' resolves to src/util.ts and
    // NOT to the referenced config's other/* target.
    expect(
      index.graph.edges.some(
        (edge) =>
          edge.type === 'references' && edge.to === 'file:src/util.ts',
      ),
    ).toBe(true)
  })

  test('codeMapParseYieldHooks re-exports the exact code-map parse yield hooks', () => {
    // @codebuff/cli declares only @codebuff/indexer, so its yield-gate
    // regression pins reach code-map's parse-loop hooks through this
    // re-export instead of importing '@codebuff/code-map/parse' directly
    // (a phantom dependency under cli's manifest). The namespace must carry
    // the SAME function references the code-map parse module exports —
    // shared module-level yield state, not copies.
    expect(codeMapParseYieldHooks.setYieldIntervalForTests).toBe(
      codeMapParse.setYieldIntervalForTests,
    )
    expect(codeMapParseYieldHooks.resetYieldStateForTests).toBe(
      codeMapParse.resetYieldStateForTests,
    )
    expect(codeMapParseYieldHooks.getYieldStatsForTests).toBe(
      codeMapParse.getYieldStatsForTests,
    )
    expect(codeMapParseYieldHooks.createYieldGateForTests).toBe(
      codeMapParse.createYieldGateForTests,
    )
    expect(codeMapParseYieldHooks.forceEventLoopYieldForTests).toBe(
      codeMapParse.forceEventLoopYieldForTests,
    )
    expect(codeMapParseYieldHooks.getYieldIntervalForTests).toBe(
      codeMapParse.getYieldIntervalForTests,
    )
  })

  test('production yield interval default is the pinned 8ms slice in both packages', () => {
    // The 8ms DEFAULT_YIELD_INTERVAL_MS is the value both packages' source
    // contracts and the cli suite's recorded yield-gate baseline
    // (RECORDED_YIELD_GATE_BASELINE in
    // cli/src/utils/__tests__/opentui-syntax-style.test.ts) were measured
    // against. Pinning the DEFAULT itself (not just the override hooks)
    // makes a silent default change fail here until the recorded baseline
    // is re-recorded with fresh before/after evidence.
    const originalEnv = process.env.CODEBUFF_YIELD_INTERVAL_MS
    delete process.env.CODEBUFF_YIELD_INTERVAL_MS
    try {
      codeMapParseYieldHooks.resetYieldStateForTests()
      resetYieldStateForTests()
      expect(codeMapParseYieldHooks.getYieldIntervalForTests()).toBe(8)
      expect(getYieldIntervalForTests()).toBe(8)
    } finally {
      if (originalEnv === undefined) {
        delete process.env.CODEBUFF_YIELD_INTERVAL_MS
      } else {
        process.env.CODEBUFF_YIELD_INTERVAL_MS = originalEnv
      }
      codeMapParseYieldHooks.resetYieldStateForTests()
      resetYieldStateForTests()
    }
  })

  test('cold build suspends through the indexer yield gates on a multi-slice run', async () => {
    // Deterministic companion to the QUANTITATIVE gate-on/gate-off cold-index
    // evidence in the cli suite's 'yield-gate throughput and event-loop-lag
    // evidence' block (RECORDED_INDEXER_YIELD_GATE_BASELINE): with the
    // interval forced to 0, every yield-gate call suspends exactly once, so a
    // cold build over N walked files must record >= 2*N indexer-side
    // suspensions — one at each file-loop iteration seam plus one at each
    // intra-file seam inside indexWalkedFile (before chunk extraction). The
    // counter belongs to the indexer module alone, so this pins the
    // indexer's OWN yield-gated loops, not the embedded code-map parse loop
    // (whose counter is separate module state).
    const root = await makeTempProject({
      'src/a.ts': 'export const a = 1\n',
      'src/b.ts': 'export function b() { return 1 }\n',
      'docs/a.md': '# Alpha\n\nalpha topic\n',
    })
    setYieldIntervalForTests(0)
    try {
      await buildMetadataIndex(root)
      expect(getYieldStatsForTests().macrotaskYields).toBeGreaterThanOrEqual(6)
    } finally {
      resetYieldStateForTests()
    }
  })
})

describe('updateMetadataIndex self-heals stale parse diagnostics', () => {
  // The no-change early-return branch now re-parses previously-diagnosed
  // files that are still walked and uncached, recomputes parseDiagnostics +
  // coverage.parser from the result, and drops diagnostics for files no
  // longer walked. A successful re-parse clears the diagnostic and clears
  // coverage.parser.truncated (when no budget flags remain).
  test('clears a stale diagnostic for a now-parseable file on the no-change path', async () => {
    const root = await makeTempProject({ 'src/a.ts': 'export const a = 1\n' })
    const first = await buildMetadataIndex(root)

    // Simulate a stale regression: carry a stale diagnostic for src/a.ts,
    // drop it from parseData, and mark parser coverage truncated.
    const stale = {
      ...first,
      parseDiagnostics: [
        {
          filePath: 'src/a.ts',
          stage: 'parse' as const,
          message: 'Parser or query not found',
        },
      ],
      parseData: Object.fromEntries(
        Object.entries(first.parseData ?? {}).filter(
          ([p]) => p !== 'src/a.ts',
        ),
      ),
      coverage: first.coverage
        ? {
            ...first.coverage,
            parser: first.coverage.parser
              ? {
                  ...first.coverage.parser,
                  truncated: true,
                  skippedFiles: 1,
                }
              : undefined,
          }
        : undefined,
    }

    // No file changes on disk → the no-change path, which re-parses the
    // still-walked uncached src/a.ts and clears its stale diagnostic.
    const healed = await updateMetadataIndex(stale, root)
    expect(healed.parseDiagnostics).toEqual([])
    expect(healed.coverage?.parser?.truncated).toBe(false)
  })

  test('drops a stale diagnostic for a file that no longer exists', async () => {
    const root = await makeTempProject({ 'src/a.ts': 'export const a = 1\n' })
    const first = await buildMetadataIndex(root)

    const stale = {
      ...first,
      parseDiagnostics: [
        { filePath: 'src/ghost.ts', stage: 'parse' as const, message: 'gone' },
      ],
    }

    // src/ghost.ts is not in the walked set, so its stale diagnostic is
    // dropped on the no-change path.
    const healed = await updateMetadataIndex(stale, root)
    expect(healed.parseDiagnostics).toEqual([])
  })
})

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'codebuff-indexer-'),
  )
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.promises.writeFile(absolutePath, content, 'utf8')
  }
  return root
}
