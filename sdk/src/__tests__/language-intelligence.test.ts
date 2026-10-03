import { describe, expect, test } from 'bun:test'

import { createLanguageIntelligence } from '../services/language-intelligence'
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
