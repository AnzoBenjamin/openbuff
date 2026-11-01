import { describe, expect, test } from 'bun:test'
import { computeProjectIndex } from '../run-state'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { getFileTokenScores, ParseCoverage } from '@codebuff/code-map/parse'

function makeCoverage(overrides: Partial<ParseCoverage> = {}): ParseCoverage {
  return {
    requestedFiles: 1,
    parsedFiles: 1,
    reusedFiles: 0,
    freshParsedFiles: 1,
    parsedBytes: 0,
    skippedFiles: 0,
    skippedKnownBytes: 0,
    skippedPrefixes: [],
    skippedLanguages: [],
    fileBudgetExceeded: false,
    byteBudgetExceeded: false,
    oversizedFiles: 0,
    maxFiles: 10_000,
    maxFileBytes: 1_000_000,
    maxTotalBytes: 64_000_000,
    truncated: false,
    ...overrides,
  }
}

describe('project index reuse', () => {
  test('reuses only unchanged complete results and isolates cached data', async () => {
    const files: Record<string, string> = { 'a.ts': 'first' }
    let parses = 0
    const fsIdentity = {} as CodebuffFileSystem
    const score: typeof getFileTokenScores = async (_root, paths, read) => {
      parses++
      const content = await read!(paths[0])
      return {
        tokenScores: { 'a.ts': { [content!]: 1 } },
        tokenCallers: {},
        parsed: {},
        diagnostics: [],
        coverage: makeCoverage({ parsedBytes: Buffer.byteLength(content!) }),
      }
    }
    const params = {
      cwd: '/project-index-cache-test',
      fsIdentity,
      fileTree: [],
      filePaths: ['a.ts'],
      readFile: (name: string) => files[name] ?? null,
    }

    const first = await computeProjectIndex(params, score)
    first.fileTokenScores['a.ts'].first = 99
    const reused = await computeProjectIndex(params, score)
    expect(parses).toBe(1)
    expect(reused.fileTokenScores['a.ts'].first).toBe(1)
    files['a.ts'] = 'second'
    const changed = await computeProjectIndex(params, score)
    expect(parses).toBe(2)
    expect(changed.fileTokenScores['a.ts'].second).toBe(1)
  })

  test('does not reuse an incomplete parse', async () => {
    let parses = 0
    const score: typeof getFileTokenScores = async () => {
      parses++
      return {
        tokenScores: {},
        tokenCallers: {},
        parsed: {},
        diagnostics: [],
        coverage: makeCoverage({
          parsedFiles: 0,
          freshParsedFiles: 0,
          skippedFiles: 1,
          byteBudgetExceeded: true,
          truncated: true,
        }),
      }
    }
    const params = {
      cwd: '/project-index-incomplete-test',
      fsIdentity: {} as CodebuffFileSystem,
      fileTree: [],
      filePaths: ['a.ts'],
      readFile: () => 'content',
    }
    await computeProjectIndex(params, score)
    await computeProjectIndex(params, score)
    expect(parses).toBe(2)
  })
})
