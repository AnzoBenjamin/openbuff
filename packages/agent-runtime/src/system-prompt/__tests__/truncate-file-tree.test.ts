import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { getStubProjectFileContext } from '@codebuff/common/util/file'

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
