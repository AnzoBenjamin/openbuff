import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  createLanguageIntelligence,
  MAX_SYNC_FILE_BYTES,
} from '../services/language-intelligence'
import {
  LspServerError,
  LspServerUnavailableError,
} from '../services/lsp-multiplexer'

import type {
  LspHover,
  LspLocation,
  LspMultiplexer,
  LspWorkspaceSymbol,
} from '../services/lsp-multiplexer'
import type { SupportedLanguageId } from '@codebuff/common/util/language-capabilities'

const CWD = '/repo'

function makeLocation(overrides: Partial<LspLocation> = {}): LspLocation {
  return {
    uri: 'file:///repo/src/foo.ts',
    range: {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 6 },
    },
    ...overrides,
  }
}

function makeMultiplexer(
  overrides: Partial<LspMultiplexer> = {},
): LspMultiplexer {
  return {
    definition: async () => makeLocation(),
    references: async () => [makeLocation()],
    hover: async (): Promise<LspHover> => ({ contents: 'const foo: number' }),
    documentSymbol: async () => [],
    workspaceSymbol: async (): Promise<LspWorkspaceSymbol[]> => [],
    syncFile: async () => {},
    warmServerCount: () => 0,
    dispose: async () => {},
    ...overrides,
  }
}

function firstValue(output: Array<{ type: string; value: unknown }>): any {
  return output[0]?.value
}

describe('language-intelligence service', () => {
  test('go_to_definition returns structured locations and converts 1-based line to 0-based', async () => {
    let captured: { filePath: string; position: { line: number; character: number } } | undefined
    const service = createLanguageIntelligence({
      cwd: CWD,
      multiplexer: makeMultiplexer({
        definition: async (params) => {
          captured = params
          return makeLocation()
        },
      }),
    })
    const output = await service.goToDefinition({
      path: 'src/foo.ts',
      line: 5,
      character: 3,
    })
    expect(captured).toEqual({
      filePath: '/repo/src/foo.ts',
      position: { line: 4, character: 3 },
    })
    expect(firstValue(output).locations).toEqual([
      {
        uri: 'file:///repo/src/foo.ts',
        path: '/repo/src/foo.ts',
        range: {
          start: { line: 1, character: 2 },
          end: { line: 1, character: 6 },
        },
      },
    ])
  })

  test('find_references returns a flattened locations array', async () => {
    const service = createLanguageIntelligence({
      cwd: CWD,
      multiplexer: makeMultiplexer({
        references: async () => [
          makeLocation(),
          makeLocation({ uri: 'file:///repo/src/bar.ts' }),
        ],
      }),
    })
    const output = await service.findReferences({
      path: 'src/foo.ts',
      line: 2,
      character: 1,
    })
    const locations = firstValue(output).locations
    expect(locations).toHaveLength(2)
    expect(locations[1].path).toBe('/repo/src/bar.ts')
  })

  test('hover_type returns the hover payload', async () => {
    const service = createLanguageIntelligence({
      cwd: CWD,
      multiplexer: makeMultiplexer({
        hover: async () => ({ contents: 'const foo: number' }),
      }),
    })
    const output = await service.hoverType({
      path: 'src/foo.ts',
      line: 1,
      character: 6,
    })
    expect(firstValue(output).hover).toEqual({ contents: 'const foo: number' })
  })

  test('workspace_symbol returns structured symbols with location paths', async () => {
    const service = createLanguageIntelligence({
      cwd: CWD,
      multiplexer: makeMultiplexer({
        workspaceSymbol: async () => [
          {
            name: 'createUser',
            kind: 12,
            containerName: 'users',
            location: makeLocation(),
          },
        ],
      }),
    })
    const output = await service.workspaceSymbol({ query: 'createUser' })
    expect(firstValue(output).symbols).toEqual([
      {
        name: 'createUser',
        kind: 12,
        containerName: 'users',
        location: {
          uri: 'file:///repo/src/foo.ts',
          path: '/repo/src/foo.ts',
          range: {
            start: { line: 1, character: 2 },
            end: { line: 1, character: 6 },
          },
        },
      },
    ])
  })

  test('LspServerError degrades to a structured errorMessage, never throws', async () => {
    const service = createLanguageIntelligence({
      cwd: CWD,
      multiplexer: makeMultiplexer({
        definition: async () => {
          throw new LspServerError('boom', { reason: 'crashed' })
        },
      }),
    })
    const output = await service.goToDefinition({
      path: 'src/foo.ts',
      line: 1,
      character: 0,
    })
    expect(firstValue(output).errorMessage).toContain('crashed')
  })
})

describe('language-intelligence per-language resolution', () => {
  test.each([
    ['src/foo.ts', 'typescript'],
    ['src/foo.py', 'python'],
  ] as const)('resolves %s to %s', async (filePath, languageId) => {
    let observed: SupportedLanguageId | undefined
    const service = createLanguageIntelligence({
      cwd: CWD,
      multiplexer: makeMultiplexer({
        definition: async () => {
          throw new LspServerUnavailableError(
            `Language '${languageId}' has no languageServer tool spec.`,
            { reason: 'no-server-spec', languageId },
          )
        },
      }),
    })
    const output = await service.goToDefinition({
      path: filePath,
      line: 1,
      character: 0,
    })
    observed = firstValue(output).unavailable?.languageId as SupportedLanguageId
    expect(observed).toBe(languageId)
    expect(firstValue(output).unavailable?.reason).toBe('no-server-spec')
  })

  test('an unknown extension returns the typed unavailable result', async () => {
    const service = createLanguageIntelligence({
      cwd: CWD,
      multiplexer: makeMultiplexer({
        definition: async () => {
          throw new LspServerUnavailableError(
            `No supported language for file 'README'.`,
            { reason: 'unsupported-language' },
          )
        },
      }),
    })
    const output = await service.goToDefinition({
      path: 'README',
      line: 1,
      character: 0,
    })
    const value = firstValue(output)
    expect(value.unavailable?.reason).toBe('unsupported-language')
    expect(value.errorMessage).toBeUndefined()
  })
})

describe('language-intelligence syncMutatedFiles', () => {
  const tempRoots: string[] = []
  afterEach(() => {
    for (const root of tempRoots.splice(0))
      fs.rmSync(root, { recursive: true, force: true })
  })

  test('pushes on-disk bytes with monotonically increasing versions and skips unsupported files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-li-sync-'))
    tempRoots.push(root)
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1\n')
    fs.writeFileSync(path.join(root, 'README.md'), 'docs')
    const synced: Array<{ filePath: string; version: number; text: string }> = []
    const service = createLanguageIntelligence({
      cwd: root,
      multiplexer: makeMultiplexer({
        syncFile: async (params) => {
          synced.push(params)
        },
      }),
    })
    await service.syncMutatedFiles(['a.ts', 'README.md'])
    await service.syncMutatedFiles(['a.ts'])
    // Each committed path syncs the current disk bytes (never a cache) with a
    // per-path monotonically increasing version; non-source files are skipped.
    // Sync runs with bounded parallelism, so ordering between distinct paths
    // is not asserted — only the exact set of synced documents and versions.
    expect(synced).toEqual([
      {
        filePath: path.join(root, 'a.ts'),
        version: 1,
        text: 'export const a = 1\n',
      },
      {
        filePath: path.join(root, 'a.ts'),
        version: 2,
        text: 'export const a = 1\n',
      },
    ])
  })

  test('is fail-open per path and caps at 32 paths per call', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-li-sync-'))
    tempRoots.push(root)
    fs.writeFileSync(path.join(root, 'a.ts'), 'x')
    fs.writeFileSync(path.join(root, 'b.ts'), 'y')
    const versions: number[] = []
    const service = createLanguageIntelligence({
      cwd: root,
      multiplexer: makeMultiplexer({
        syncFile: async (params) => {
          versions.push(params.version)
          if (params.filePath.endsWith('b.ts')) {
            throw new Error('server hiccup')
          }
        },
      }),
    })
    // Alternating paths plus one that does not exist: every failure mode
    // (server error, missing file) is swallowed and the call still resolves.
    const manyPaths = Array.from({ length: 40 }, (_, index) =>
      index % 2 === 0 ? 'a.ts' : index === 39 ? 'missing.ts' : 'b.ts',
    )
    await expect(
      service.syncMutatedFiles(manyPaths),
    ).resolves.toBeUndefined()
    // 40 supplied paths are capped at 32 sync attempts.
    expect(versions.length).toBe(32)
  })

  test('syncs distinct paths with bounded parallelism, preserving per-path versions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-li-sync-'))
    tempRoots.push(root)
    const PATH_COUNT = 8
    const paths = Array.from(
      { length: PATH_COUNT },
      (_, index) => `src/file-${index}.ts`,
    )
    for (const projectPath of paths) {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true })
      fs.writeFileSync(
        path.join(root, projectPath),
        `export const file${paths.indexOf(projectPath)} = 1\n`,
      )
    }
    let inFlight = 0
    let maxInFlight = 0
    let completed = 0
    const service = createLanguageIntelligence({
      cwd: root,
      multiplexer: makeMultiplexer({
        syncFile: async (params) => {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight--
          completed++
          expect(params.version).toBe(1)
        },
      }),
    })
    await service.syncMutatedFiles(paths)
    // Every distinct path was synced exactly once, and the sync ran with
    // bounded parallelism: more than one round-trip was in flight at a time,
    // but never an unbounded number (the serial pre-fix loop would keep
    // maxInFlight at 1; the unbounded Promise.all shape would spike to 8).
    expect(completed).toBe(PATH_COUNT)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(PATH_COUNT)
  })

  test('skips files larger than the per-file read cap', async () => {
    // perf: sync-mutated-files-unbounded-file-read — a single large generated
    // file committed in a mutation batch must not produce an unbounded read
    // + LSP frame on the path that awaits inline after every committed
    // mutation. Files at or above MAX_SYNC_FILE_BYTES are skipped entirely
    // while ordinary files still sync.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-li-sync-'))
    tempRoots.push(root)
    fs.writeFileSync(path.join(root, 'small.ts'), 'export const a = 1\n')
    fs.writeFileSync(
      path.join(root, 'huge.ts'),
      'x'.repeat(MAX_SYNC_FILE_BYTES + 1),
    )
    const syncedPaths: string[] = []
    const service = createLanguageIntelligence({
      cwd: root,
      multiplexer: makeMultiplexer({
        syncFile: async (params) => {
          syncedPaths.push(params.filePath)
        },
      }),
    })
    await expect(
      service.syncMutatedFiles(['small.ts', 'huge.ts']),
    ).resolves.toBeUndefined()
    expect(syncedPaths).toEqual([path.join(root, 'small.ts')])
  })

  test('no-ops when the multiplexer was never built (no cold start)', async () => {
    const service = createLanguageIntelligence({ cwd: '/repo' })
    await expect(
      service.syncMutatedFiles(['src/a.ts']),
    ).resolves.toBeUndefined()
    // The sync must not have lazily built a multiplexer: a subsequent query
    // still hits the no-spawner degradation instead of a spawned server.
    const output = await service.goToDefinition({
      path: 'src/a.ts',
      line: 1,
      character: 0,
    })
    expect(firstValue(output).errorMessage).toContain(
      'No LSP spawner configured',
    )
  })

  test('the per-path sync-version map stays bounded across many synced paths', async () => {
    // perf: sync-versions-map-unbounded. The per-run version map used to be an
    // unbounded Map keyed by absolute path; it is now a bounded LRU. Asserted
    // entirely through externally visible syncFile calls: three disjoint
    // 32-path batches fill and then overflow the 64-entry bound, so the first
    // batch is fully evicted. A still-cached path keeps its monotonic version
    // (batch 2 re-syncs at version 2) while every evicted batch-1 path
    // re-opens at version 1 — with the current on-disk bytes, so eviction can
    // never serve stale content.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-li-sync-'))
    tempRoots.push(root)
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    const BATCH = 32
    const makePaths = (batch: number) =>
      Array.from(
        { length: BATCH },
        (_, index) => `src/b${batch}-file-${index}.ts`,
      )
    for (let batch = 0; batch < 3; batch++) {
      for (const projectPath of makePaths(batch)) {
        fs.writeFileSync(path.join(root, projectPath), 'export const x = 1\n')
      }
    }
    const versionsByPath = new Map<string, number[]>()
    const service = createLanguageIntelligence({
      cwd: root,
      multiplexer: makeMultiplexer({
        syncFile: async (params) => {
          const list = versionsByPath.get(params.filePath) ?? []
          list.push(params.version)
          versionsByPath.set(params.filePath, list)
        },
      }),
    })
    await service.syncMutatedFiles(makePaths(0))
    await service.syncMutatedFiles(makePaths(1))
    // The map now holds exactly its 64-entry bound.
    await service.syncMutatedFiles(makePaths(2))
    // Batch 3 overflowed the bound: every batch-1 entry was evicted. Refresh
    // batch 1 first (still cached -> monotonic version 2), then batch 0
    // (evicted -> re-opened at version 1).
    await service.syncMutatedFiles(makePaths(1))
    await service.syncMutatedFiles(makePaths(0))
    for (let index = 0; index < BATCH; index++) {
      const b0 = versionsByPath.get(path.resolve(root, makePaths(0)[index]))
      expect(b0).toEqual([1, 1])
      const b1 = versionsByPath.get(path.resolve(root, makePaths(1)[index]))
      expect(b1).toEqual([1, 2])
      const b2 = versionsByPath.get(path.resolve(root, makePaths(2)[index]))
      expect(b2).toEqual([1])
    }
  })
})
