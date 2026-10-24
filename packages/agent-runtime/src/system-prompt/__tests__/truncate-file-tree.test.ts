import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import {
  getStubProjectFileContext,
  printFileTree,
} from '@codebuff/common/util/file'

import { knowledgeFilesPrompt } from '../prompts'
import { truncateFileTreeBasedOnTokenBudget } from '../truncate-file-tree'
import * as tokenCounter from '../../util/token-counter'

import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { FileTreeNode } from '@codebuff/common/util/file'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** Unique symbol name that only appears in with-tokens prints. */
const UNIQUE_SYMBOL = 'UniqueSymbolAlphaOnlyInTokenScores'

const minimalTree: FileTreeNode[] = [
  {
    name: 'src',
    type: 'directory',
    filePath: 'src',
    children: [
      {
        name: 'main.ts',
        type: 'file',
        filePath: 'src/main.ts',
      },
    ],
  },
]

const fileTokenScores = {
  'src/main.ts': {
    [UNIQUE_SYMBOL]: 10,
  },
}

describe('truncateFileTreeBasedOnTokenBudget preferPathOnly', () => {
  afterEach(() => {
    mock.restore()
  })

  it('returns path-only tree (no symbols) when preferPathOnly and path-only fits but symbols would not', () => {
    // Distinguish symbol-rich vs path-only content via mock token counter.
    spyOn(tokenCounter, 'countTokensJson').mockImplementation((text) => {
      const s = typeof text === 'string' ? text : JSON.stringify(text)
      // Symbol-rich print is large; path-only is small.
      if (s.includes(UNIQUE_SYMBOL)) {
        return 10_000
      }
      return Math.max(1, s.length)
    })
    spyOn(tokenCounter, 'countTokens').mockImplementation((text) =>
      Math.max(1, String(text).length),
    )

    const fileContext = {
      ...getStubProjectFileContext(),
      fileTree: minimalTree,
      fileTokenScores,
    }

    // Budget between path-only size and symbol-rich size (10_000).
    const pathOnly = truncateFileTreeBasedOnTokenBudget({
      fileContext,
      tokenBudget: 500,
      logger,
      preferPathOnly: true,
    })

    expect(pathOnly.printedTree).toContain('main.ts')
    expect(pathOnly.printedTree).not.toContain(UNIQUE_SYMBOL)
    expect(pathOnly.truncationLevel).toBe('none')
    expect(pathOnly.tokenCount).toBeLessThanOrEqual(500)
    expect(pathOnly.tokenCount).toBeLessThan(10_000)
  })

  it('keeps symbols when preferPathOnly is false and the full tree fits', () => {
    spyOn(tokenCounter, 'countTokensJson').mockImplementation((text) => {
      const s = typeof text === 'string' ? text : JSON.stringify(text)
      return Math.max(1, s.length)
    })

    const fileContext = {
      ...getStubProjectFileContext(),
      fileTree: minimalTree,
      fileTokenScores,
    }

    const result = truncateFileTreeBasedOnTokenBudget({
      fileContext,
      tokenBudget: 50_000,
      logger,
      preferPathOnly: false,
    })

    expect(result.printedTree).toContain(UNIQUE_SYMBOL)
    expect(result.truncationLevel).toBe('none')
  })

  it('falls through to depth-based path-only when preferPathOnly and path-only exceeds budget', () => {
    // Force path-only content over a tiny budget so preferPathOnly skips the
    // "fits" branch and depth-based truncation still prints without symbols.
    spyOn(tokenCounter, 'countTokensJson').mockImplementation((text) => {
      const s = typeof text === 'string' ? text : JSON.stringify(text)
      if (s.includes(UNIQUE_SYMBOL)) {
        return 10_000
      }
      // Path-only prints are still "large" relative to a tiny budget.
      return Math.max(200, s.length)
    })
    spyOn(tokenCounter, 'countTokens').mockImplementation((text) =>
      Math.max(1, String(text).length),
    )

    const deepTree: FileTreeNode[] = [
      {
        name: 'src',
        type: 'directory',
        filePath: 'src',
        children: [
          {
            name: 'a',
            type: 'directory',
            filePath: 'src/a',
            children: [
              {
                name: 'b',
                type: 'directory',
                filePath: 'src/a/b',
                children: [
                  {
                    name: 'deep1.ts',
                    type: 'file',
                    filePath: 'src/a/b/deep1.ts',
                  },
                  {
                    name: 'deep2.ts',
                    type: 'file',
                    filePath: 'src/a/b/deep2.ts',
                  },
                  {
                    name: 'deep3.ts',
                    type: 'file',
                    filePath: 'src/a/b/deep3.ts',
                  },
                ],
              },
            ],
          },
          {
            name: 'root.ts',
            type: 'file',
            filePath: 'src/root.ts',
          },
        ],
      },
    ]

    const deepScores = {
      'src/a/b/deep1.ts': { [UNIQUE_SYMBOL]: 10 },
      'src/a/b/deep2.ts': { [UNIQUE_SYMBOL]: 10 },
      'src/a/b/deep3.ts': { [UNIQUE_SYMBOL]: 10 },
      'src/root.ts': { [UNIQUE_SYMBOL]: 10 },
    }

    const fileContext = {
      ...getStubProjectFileContext(),
      fileTree: deepTree,
      fileTokenScores: deepScores,
    }

    const result = truncateFileTreeBasedOnTokenBudget({
      fileContext,
      tokenBudget: 50,
      logger,
      preferPathOnly: true,
    })

    expect(result.truncationLevel).toBe('depth-based')
    expect(result.printedTree).not.toContain(UNIQUE_SYMBOL)
    // Depth-based still emits path-only names (no symbol tokens).
    expect(result.printedTree).not.toMatch(/\bUniqueSymbol\w*\b/)
  })
})

describe('truncateFileTreeBasedOnTokenBudget depth-based sampling', () => {
  afterEach(() => {
    mock.restore()
  })

  it('keeps the depth-based estimate finite when the sample prices every file name at zero tokens', () => {
    // Char-count token mock keeps the estimate self-consistent with the printed
    // tree; countTokens returns 0 for the sampled names, so the sample average
    // is 0 and the estimate would divide by zero without the documented
    // fallback (pre-fix: NaN average -> Infinity estimate -> every file wiped).
    spyOn(tokenCounter, 'countTokensJson').mockImplementation((text) => {
      const s = typeof text === 'string' ? text : JSON.stringify(text)
      return Math.max(1, s.length)
    })
    spyOn(tokenCounter, 'countTokens').mockImplementation(() => 0)

    const files: FileTreeNode[] = Array.from(
      { length: 200 },
      (_, index): FileTreeNode => {
        const name = `file${String(index).padStart(3, '0')}.ts`
        return { name, type: 'file', filePath: `src/${name}` }
      },
    )
    const tree: FileTreeNode[] = [
      { name: 'src', type: 'directory', filePath: 'src', children: files },
    ]

    // Budget below the path-only render so the depth-based level is reached,
    // but close enough that the finite estimate removes only part of the tree.
    const pathOnlyTokens = printFileTree(tree).length
    const result = truncateFileTreeBasedOnTokenBudget({
      fileContext: {
        ...getStubProjectFileContext(),
        fileTree: tree,
        fileTokenScores: {},
      },
      tokenBudget: pathOnlyTokens - 500,
      logger,
      preferPathOnly: true,
    })

    expect(result.truncationLevel).toBe('depth-based')
    expect(result.printedTree.length).toBeGreaterThan(0)
    expect(result.printedTree).toContain('src')
    expect(Number.isFinite(result.tokenCount)).toBe(true)
  })

  it('returns the path-only render of the filtered tree when it has no files left', () => {
    // Every token count is above any budget, so the depth-based level is
    // reached even for a tree that filters down to nothing.
    spyOn(tokenCounter, 'countTokensJson').mockImplementation(() => 10_000)
    spyOn(tokenCounter, 'countTokens').mockImplementation(() => 0)

    let warnCount = 0
    const captureLogger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {
        warnCount += 1
      },
      error: () => {},
    }

    const generatedOnlyTree: FileTreeNode[] = [
      {
        name: 'dist',
        type: 'directory',
        filePath: 'dist',
        children: [
          {
            name: 'bundle.min.js',
            type: 'file',
            filePath: 'dist/bundle.min.js',
          },
        ],
      },
    ]

    const result = truncateFileTreeBasedOnTokenBudget({
      fileContext: {
        ...getStubProjectFileContext(),
        fileTree: generatedOnlyTree,
        fileTokenScores: {},
      },
      tokenBudget: 100,
      logger: captureLogger,
      preferPathOnly: true,
    })

    // The empty filtered tree still renders through printFileTree rather than
    // leaking the '' seed out to the agent.
    expect(result.truncationLevel).toBe('depth-based')
    expect(result.printedTree).toBe(printFileTree([]))
    expect(Number.isFinite(result.tokenCount)).toBe(true)
    // The removal loop only runs when the estimate is a positive finite number:
    // its bounded-iteration warning proves the NaN estimate is gone.
    expect(warnCount).toBeGreaterThan(0)
  })
})

describe('knowledgeFilesPrompt M3 shrink', () => {
  it('is a short always-on blurb pointing at the full guide', () => {
    expect(knowledgeFilesPrompt).toContain('agents/guides/knowledge-files.md')
    expect(knowledgeFilesPrompt).toContain('knowledge.md')
    expect(knowledgeFilesPrompt.toLowerCase()).toContain('concise')
    // Short blurb target (~150 tok); char length is a coarse proxy.
    expect(knowledgeFilesPrompt.length).toBeLessThan(600)
  })

  it('full essay lives in agents/guides/knowledge-files.md, not the always-on prompt', () => {
    // Resolve monorepo root from this file so the package-cwd CI job still finds
    // agents/guides (cwd may be packages/agent-runtime rather than repo root).
    const guideRel = path.join('agents', 'guides', 'knowledge-files.md')
    let dir = path.dirname(fileURLToPath(import.meta.url))
    let guidePath = path.join(dir, guideRel)
    while (!existsSync(guidePath)) {
      const parent = path.dirname(dir)
      if (parent === dir) {
        guidePath = path.join(process.cwd(), guideRel)
        break
      }
      dir = parent
      guidePath = path.join(dir, guideRel)
    }
    const guide = readFileSync(guidePath, 'utf8')
    // Phrase unique to the full essay body.
    const uniqueEssayPhrase =
      'They are another way to take notes in this "Memento"-style environment.'
    expect(guide).toContain(uniqueEssayPhrase)
    expect(knowledgeFilesPrompt).not.toContain(uniqueEssayPhrase)
  })
})
