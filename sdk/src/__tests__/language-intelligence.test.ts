import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'

import {
  createLanguageIntelligence,
  MAX_SYNC_FILE_BYTES,
  type LanguageIntelligenceService,
} from '../services/language-intelligence'
import {
  LspServerError,
  LspServerUnavailableError,
} from '../services/lsp-multiplexer'
import { codeAction } from '../tools/code-action'
import { renameSymbol } from '../tools/rename-symbol'

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
    // P4-T2 additive seams: an empty edit outcome by default, so the
    // semantic-edit tests only override what they need.
    prepareRenameParams: async () => ({
      range: {
        start: { line: 0, character: 13 },
        end: { line: 0, character: 16 },
      },
    }),
    rename: async () => ({
      'file:///repo/src/foo.ts': [],
    }),
    codeAction: async () => [],
    syncFile: async () => {},
    warmServerCount: () => 0,
    dispose: async () => {},
    ...overrides,
  }
}

function firstValue(output: Array<{ type: string; value: unknown }>): any {
  return output[0]?.value
}

/**
 * The paths actually READ through a mock filesystem adapter (its `readFile`
 * mock call log). Lets the fs-splice tests assert externally that every read
 * went through the injected adapter — and that a refused path was never
 * opened at all.
 */
function fsReadPaths(filesystem: unknown): string[] {
  const calls =
    (
      filesystem as {
        readFile?: { mock?: { calls?: unknown[][] } }
      }
    ).readFile?.mock?.calls
  if (!Array.isArray(calls)) return []
  return calls.map((call) => String(call[0]))
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

  test('a 1-based line 0 clamps to LSP line 0 instead of going negative', async () => {
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
      line: 0,
      character: 2,
    })
    // LSP rejects a negative line; the clamp degrades line 0 to the first line.
    expect(captured).toEqual({
      filePath: '/repo/src/foo.ts',
      position: { line: 0, character: 2 },
    })
    expect(firstValue(output).locations).toHaveLength(1)
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

  test('renameSymbol degrades with the service reason when prepareRename answers null', async () => {
    const service = createLanguageIntelligence({
      cwd: CWD,
      multiplexer: makeMultiplexer({
        prepareRenameParams: async () => null,
      }),
    })
    const output = await service.renameSymbol({
      path: 'src/foo.ts',
      line: 1,
      character: 0,
      new_name: 'bar',
    })
    expect(firstValue(output).unavailable?.reason).toBe('position is not renameable')
    // The unavailable surface never carries an errorMessage.
    expect(firstValue(output).errorMessage).toBeUndefined()
  })

  test('codeAction rejects every kind other than source.organizeImports for v1', async () => {
    const service = createLanguageIntelligence({
      cwd: CWD,
      multiplexer: makeMultiplexer({}),
    })
    const output = await service.codeAction({
      path: 'src/foo.ts',
      line: 1,
      character: 0,
      kind: 'refactor.extract',
    })
    expect(firstValue(output).unavailable?.reason).toBe(
      'unsupported action kind (v1 organizes imports only)',
    )
  })

  test('codeAction degrades honestly when no action carries edits', async () => {
    const service = createLanguageIntelligence({
      cwd: CWD,
      multiplexer: makeMultiplexer({
        codeAction: async () => [],
      }),
    })
    const output = await service.codeAction({
      path: 'src/foo.ts',
      line: 1,
      character: 0,
      kind: 'source.organizeImports',
    })
    expect(firstValue(output).unavailable?.reason).toBe(
      'no organize-imports action available',
    )
  })

  test('a LspServerError on the rename path degrades to the structured errorMessage', async () => {
    const service = createLanguageIntelligence({
      cwd: CWD,
      multiplexer: makeMultiplexer({
        rename: async () => {
          throw new LspServerError('server hiccup', { reason: 'crashed' })
        },
      }),
    })
    const output = await service.renameSymbol({
      path: 'src/foo.ts',
      line: 1,
      character: 0,
      new_name: 'bar',
    })
    expect(firstValue(output).errorMessage).toContain('crashed')
  })
})

describe('language-intelligence semantic edit splicing', () => {
  const tempRoots: string[] = []
  afterEach(() => {
    for (const root of tempRoots.splice(0))
      fs.rmSync(root, { recursive: true, force: true })
  })

  test('renameSymbol shifts the 1-based line exactly once and splices current disk bytes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-li-rename-'))
    tempRoots.push(root)
    fs.writeFileSync(path.join(root, 'a.ts'), 'const value = 1\nconst other = 2\n')
    const uri = `file://${[root, 'a.ts'].join('/').replace(/\\/g, '/')}`
    const captured: Array<{
      filePath: string
      position?: { line: number; character: number }
      newName?: string
    }> = []
    const service = createLanguageIntelligence({
      cwd: root,
      multiplexer: makeMultiplexer({
        prepareRenameParams: async (params) => {
          captured.push(params)
          return {
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 11 },
            },
          }
        },
        rename: async (params) => {
          captured.push(params)
          return {
            [uri]: [
              {
                range: {
                  start: { line: 1, character: 6 },
                  end: { line: 1, character: 11 },
                },
                newText: 'otherRenamed',
              },
            ],
          }
        },
      }),
    })
    const output = await service.renameSymbol({
      path: 'a.ts',
      line: 2,
      character: 6,
      new_name: 'otherRenamed',
    })
    // prepareRename and rename both received the SAME 0-based LSP position
    // (line 1 for the human-friendly 1-based line 2) — shifted exactly once,
    // with character passed through verbatim.
    expect(captured).toEqual([
      { filePath: path.join(root, 'a.ts'), position: { line: 1, character: 6 } },
      {
        filePath: path.join(root, 'a.ts'),
        position: { line: 1, character: 6 },
        newName: 'otherRenamed',
      },
    ])
    // The splice applied ONLY the rename range; the rest of the file is byte-
    // identical to what was on disk, deduped per file.
    expect(firstValue(output).changedFiles).toEqual([
      {
        path: path.join(root, 'a.ts'),
        newContent: 'const value = 1\nconst otherRenamed = 2\n',
      },
    ])
    // The service reads bytes from disk and returns them; it must NOT write.
    expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe(
      'const value = 1\nconst other = 2\n',
    )
  })

  // Normalization is mux-owned: mux.rename() returns the already-normalized
  // LspWorkspaceEditChanges shard (Record<uri, LspTextEdit[]>; the
  // documentChanges[version] plumbing is dropped there) and this service
  // consumes it verbatim. That conversion is pinned at the mux layer by the
  // sibling test 'rename normalizes documentChanges and skips a
  // non-text-edit entry honestly' in lsp-multiplexer.test.ts.
  test('renameSymbol consumes the mux-normalized workspace-edit shard verbatim', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-li-rename-'))
    tempRoots.push(root)
    fs.writeFileSync(path.join(root, 'a.ts'), 'const total = 1\n')
    const uri = `file://${[root, 'a.ts'].join('/').replace(/\\/g, '/')}`
    const service = createLanguageIntelligence({
      cwd: root,
      multiplexer: makeMultiplexer({
        rename: async () => ({
          [uri]: [
            {
              range: {
                start: { line: 0, character: 6 },
                end: { line: 0, character: 11 },
              },
              newText: 'sum',
            },
          ],
        }),
      }),
    })
    const output = await service.renameSymbol({
      path: 'a.ts',
      line: 1,
      character: 0,
      new_name: 'sum',
    })
    expect(firstValue(output).changedFiles).toEqual([
      {
        path: path.join(root, 'a.ts'),
        newContent: 'const sum = 1\n',
      },
    ])
  })

  test('renameSymbol with two files returns both spliced results', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-li-rename-'))
    tempRoots.push(root)
    fs.writeFileSync(path.join(root, 'a.ts'), 'const a = 1\n')
    fs.writeFileSync(path.join(root, 'b.ts'), 'const b = 2\nconst b2 = 3\n')
    const service = createLanguageIntelligence({
      cwd: root,
      multiplexer: makeMultiplexer({
        rename: async () => ({
          [`file://${[root, 'a.ts'].join('/').replace(/\\/g, '/')}`]: [
            {
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
              newText: 'aa',
            },
          ],
          [`file://${[root, 'b.ts'].join('/').replace(/\\/g, '/')}`]: [
            {
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
              newText: 'bb',
            },
          ],
        }),
      }),
    })
    const output = await service.renameSymbol({
      path: 'a.ts',
      line: 1,
      character: 0,
      new_name: 'aa',
    })
    const files = firstValue(output).changedFiles as Array<{
      path: string
      newContent: string
    }>
    expect(files).toHaveLength(2)
    const byPath = new Map(
      files.map((file) => [path.basename(file.path), file.newContent]),
    )
    expect(byPath.get('a.ts')).toBe('const aa = 1\n')
    expect(byPath.get('b.ts')).toBe('const bb = 2\nconst b2 = 3\n')
  })

  test('overlapping edits fail that file honestly without failing the whole call', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-li-rename-'))
    tempRoots.push(root)
    fs.writeFileSync(path.join(root, 'a.ts'), 'const a = 1\n')
    fs.writeFileSync(path.join(root, 'b.ts'), 'const b = 2\n')
    const service = createLanguageIntelligence({
      cwd: root,
      multiplexer: makeMultiplexer({
        rename: async () => ({
          [`file://${[root, 'a.ts'].join('/').replace(/\\/g, '/')}`]: [
            // Ranges that truly overlap: the whole-line span [0, 11) —
            // character 11 is the end of line 0 ('const a = 1' is 11 chars) —
            // containing the narrower span [6, 7). An end past the line's
            // length would be an out-of-bounds failure instead.
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 11 },
              },
              newText: 'whole',
            },
            {
              range: {
                start: { line: 0, character: 6 },
                end: { line: 0, character: 7 },
              },
              newText: 'a',
            },
          ],
          [`file://${[root, 'b.ts'].join('/').replace(/\\/g, '/')}`]: [],
        }),
      }),
    })
    const output = await service.renameSymbol({
      path: 'a.ts',
      line: 1,
      character: 0,
      new_name: 'aa',
    })
    expect(firstValue(output).errorMessage).toContain('overlap')
    expect(firstValue(output).changedFiles).toBeUndefined()
  })

  test('codeAction applies the first edit-carrying organize-imports action', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-li-ca-'))
    tempRoots.push(root)
    fs.writeFileSync(
      path.join(root, 'a.ts'),
      'import { b } from "./b"\n',
    )
    const uri = `file://${[root, 'a.ts'].join('/').replace(/\\/g, '/')}`
    const captured: Array<{
      filePath: string
      position?: { line: number; character: number }
      only?: string[]
    }> = []
    const service = createLanguageIntelligence({
      cwd: root,
      multiplexer: makeMultiplexer({
        codeAction: async (params) => {
          captured.push(params)
          return [
            // A command-only action is skipped (never resolved).
            { title: 'sort imports (command only)', changesByUri: {} },
            {
              title: 'Remove unused import',
              changesByUri: {
                [uri]: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 1, character: 0 },
                    },
                    newText: '',
                  },
                ],
              },
            },
          ]
        },
      }),
    })
    const output = await service.codeAction({
      path: 'a.ts',
      line: 1,
      character: 0,
      kind: 'source.organizeImports',
    })
    expect(captured).toEqual([
      {
        filePath: path.join(root, 'a.ts'),
        position: { line: 0, character: 0 },
        only: ['source.organizeImports'],
      },
    ])
    expect(firstValue(output).changedFiles).toEqual([
      {
        path: path.join(root, 'a.ts'),
        newContent: '',
      },
    ])
  })

  test('codeAction edits in one file with a failed read in another stays honest', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-li-ca-'))
    tempRoots.push(root)
    fs.writeFileSync(
      path.join(root, 'a.ts'),
      'import { b } from "./b"\nexport const a = 1\n',
    )
    const service = createLanguageIntelligence({
      cwd: root,
      multiplexer: makeMultiplexer({
        codeAction: async () => [
          {
            title: 'Remove unused import',
            changesByUri: {
              [`file://${[root, 'a.ts'].join('/').replace(/\\/g, '/')}`]: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 1, character: 0 },
                  },
                  newText: '',
                },
              ],
              // A uri whose file does not exist on disk.
              [`file://${[root, 'gone.ts'].join('/').replace(/\\/g, '/')}`]: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 },
                  },
                  newText: 'x',
                },
              ],
            },
          },
        ],
      }),
    })
    const output = await service.codeAction({
      path: 'a.ts',
      line: 1,
      character: 0,
      kind: 'source.organizeImports',
    })
    // The good file still splices; the bad one is recorded per file.
    const value = firstValue(output)
    expect(value.changedFiles).toEqual([
      {
        path: path.join(root, 'a.ts'),
        newContent: 'export const a = 1\n',
      },
    ])
    expect(value.errorMessage).toContain('gone.ts')
  })

  test('splice reads through the injected filesystem, never raw node disk', async () => {
    // Audit fix (fs splice): the service used to read node:fs/promises
    // directly, so a virtual-fs host (projectFiles / fsSource) would splice
    // bytes from real disk while the mutation broker committed into the
    // injected filesystem. The splice source is now the injected fs: the
    // content below exists ONLY in the mock filesystem.
    const mockFs = createMockFs({
      files: { '/repo/src/foo.ts': 'const total = 1\n' },
    })
    const service = createLanguageIntelligence({
      cwd: '/repo',
      fs: mockFs,
      multiplexer: makeMultiplexer({
        rename: async () => ({
          'file:///repo/src/foo.ts': [
            {
              range: {
                start: { line: 0, character: 6 },
                end: { line: 0, character: 11 },
              },
              newText: 'sum',
            },
          ],
        }),
      }),
    })
    const output = await service.renameSymbol({
      path: 'src/foo.ts',
      line: 1,
      character: 0,
      new_name: 'sum',
    })
    expect(firstValue(output).changedFiles).toEqual([
      { path: '/repo/src/foo.ts', newContent: 'const sum = 1\n' },
    ])
    // Every filesystem read went through the injected adapter.
    expect(fsReadPaths(mockFs)).toEqual(['/repo/src/foo.ts'])
  })

  test('a server-supplied uri outside the project / read roots is refused before any read', async () => {
    const mockFs = createMockFs({
      files: { '/repo/src/foo.ts': 'const total = 1\n' },
    })
    const service = createLanguageIntelligence({
      cwd: '/repo',
      fs: mockFs,
      multiplexer: makeMultiplexer({
        rename: async () => ({
          // An out-of-project uri (a path NOT under /repo). It is not under
          // the project, not an OS-temp root, and no external read roots are
          // configured, so the containment gate must refuse it.
          'file:///etc/secret.ts': [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              newText: 'x',
            },
          ],
        }),
      }),
    })
    const output = await service.renameSymbol({
      path: 'src/foo.ts',
      line: 1,
      character: 0,
      new_name: 'x',
    })
    expect(firstValue(output).errorMessage).toContain(
      'outside the project and the configured read roots',
    )
    expect(firstValue(output).changedFiles).toBeUndefined()
    // The refused path was NEVER opened, and the in-project file was not
    // read either: the whole rename had no applicable edits.
    expect(fsReadPaths(mockFs)).toEqual([])
  })

  test('syncMutatedFiles resolves containment before stat/read and skips refused paths', async () => {
    // Audit fix (fs splice): the sync loop used to read node:fs/promises
    // directly, so a path the mutation broker committed into a virtual fs
    // (or an out-of-project one) was read from real host disk anyway. Reads
    // now go through the injected fs, and every path is contained through the
    // same read-containment resolver the splice uses, fail-open per path.
    const mockFs = createMockFs({
      files: { '/repo/src/in-project.ts': 'export const inProject = 1\n' },
    })
    const synced: Array<{ filePath: string; text: string }> = []
    const service = createLanguageIntelligence({
      cwd: '/repo',
      fs: mockFs,
      multiplexer: makeMultiplexer({
        syncFile: async (params) => {
          synced.push({ filePath: params.filePath, text: params.text })
        },
      }),
    })
    await expect(
      service.syncMutatedFiles(['src/in-project.ts', '/etc/secret.ts']),
    ).resolves.toBeUndefined()
    // Only the contained path synced (through the mock fs), and the refused
    // path never touched the adapter at all.
    expect(synced).toEqual([
      { filePath: '/repo/src/in-project.ts', text: 'export const inProject = 1\n' },
    ])
    expect(fsReadPaths(mockFs)).toEqual(['/repo/src/in-project.ts'])
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

  test('forwards deleted paths as a didClose (close semantics, no disk read)', async () => {
    // P3 audit fix: syncMutatedFiles previously dropped action === 'delete'
    // paths entirely, so a warm language server kept stale open-document
    // state for deleted files. closedPaths are now forwarded as
    // syncFile({ close: true }) without ever reading the (deleted) file.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-li-close-'))
    tempRoots.push(root)
    fs.writeFileSync(path.join(root, 'live.ts'), 'export const live = 1\n')
    const synced: Array<{ filePath: string; version: number; text: string }> = []
    const closed: string[] = []
    const service = createLanguageIntelligence({
      cwd: root,
      multiplexer: makeMultiplexer({
        syncFile: async (params) => {
          if (params.close) {
            closed.push(params.filePath)
            return
          }
          synced.push(params)
        },
      }),
    })
    await service.syncMutatedFiles(['live.ts'], {
      closedPaths: ['deleted.ts', 'README.md', 'missing-dir/gone.ts'],
    })
    // The live path still syncs from disk; the deleted .ts path is closed;
    // non-source paths are skipped exactly like the sync loop.
    expect(synced).toEqual([
      {
        filePath: path.join(root, 'live.ts'),
        version: 1,
        text: 'export const live = 1\n',
      },
    ])
    expect(closed).toEqual([
      path.join(root, 'deleted.ts'),
      path.join(root, 'missing-dir/gone.ts'),
    ])
  })

  test('close path is fail-open per path and bounded per call', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-li-close-'))
    tempRoots.push(root)
    const closedPaths: string[] = []
    const service = createLanguageIntelligence({
      cwd: root,
      multiplexer: makeMultiplexer({
        syncFile: async (params) => {
          if (!params.close) return
          closedPaths.push(params.filePath)
          throw new Error('server hiccup on close')
        },
      }),
    })
    // 40 deleted paths: every close failure is swallowed and the call still
    // resolves; only the first 32 closed paths reach the multiplexer.
    const many = Array.from({ length: 40 }, (_, index) => `gone-${index}.ts`)
    await expect(
      service.syncMutatedFiles([], { closedPaths: many }),
    ).resolves.toBeUndefined()
    expect(closedPaths).toHaveLength(32)
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

describe('semantic-edit apply wrappers (rename_symbol / code_action)', () => {
  const capabilityIssuer = {
    projectId: '/repo',
    runId: 'semantic-edit-apply-tests',
  }

  function makeApplyService(
    overrides: Partial<
      Pick<LanguageIntelligenceService, 'renameSymbol' | 'codeAction'>
    >,
  ): LanguageIntelligenceService {
    // Structural fake: the apply wrappers dispatch ONLY through
    // renameSymbol/codeAction, so the remaining service members are never
    // reached in these tests. changeFiles' deps are cleanly injectable (a
    // mock filesystem), so the wrappers run against the REAL commit path.
    return { ...overrides } as unknown as LanguageIntelligenceService
  }

  test('renameSymbol routes the service splice through changeFiles and reduces the commit result', async () => {
    const mockFs = createMockFs({
      files: { '/repo/src/foo.ts': 'const foo = 1\n' },
    })
    const captured: Array<{
      path: string
      line: number
      character: number
      new_name: string
    }> = []
    const service = makeApplyService({
      renameSymbol: async (params) => {
        captured.push(params)
        return [
          {
            type: 'json' as const,
            value: {
              changedFiles: [
                {
                  path: '/repo/src/foo.ts',
                  newContent: 'const bar = 1\n',
                },
              ],
            },
          },
        ]
      },
    })
    const applied = await renameSymbol(
      service,
      { path: 'src/foo.ts', line: 1, character: 6, new_name: 'bar' },
      { cwd: '/repo', fs: mockFs, capabilityIssuer },
    )
    // Positions pass through VERBATIM: the service owns the 1-based->0-based
    // conversion, so the wrapper must not shift a second time.
    expect(captured).toEqual([
      { path: 'src/foo.ts', line: 1, character: 6, new_name: 'bar' },
    ])
    expect(applied.output[0]?.value).toMatchObject({
      applied: true,
      results: [{ path: 'src/foo.ts', applied: true }],
    })
    expect(applied.mutation?.outcome).toBe('applied')
    expect(await mockFs.readFile('/repo/src/foo.ts', 'utf-8')).toBe(
      'const bar = 1\n',
    )
  })

  test('codeAction returns an unavailable result verbatim and commits nothing', async () => {
    const mockFs = createMockFs({
      files: { '/repo/src/foo.ts': 'const foo = 1\n' },
    })
    const unavailable = {
      unavailable: { reason: 'no-server-spec', languageId: 'typescript' },
    }
    const service = makeApplyService({
      codeAction: async () => [
        { type: 'json' as const, value: unavailable },
      ],
    })
    const applied = await codeAction(
      service,
      {
        path: 'src/foo.ts',
        line: 1,
        character: 0,
        kind: 'source.organizeImports',
      },
      { cwd: '/repo', fs: mockFs },
    )
    expect(applied.output[0]?.value).toEqual(unavailable)
    expect(applied.mutation).toBeUndefined()
    expect(await mockFs.readFile('/repo/src/foo.ts', 'utf-8')).toBe(
      'const foo = 1\n',
    )
  })
})
