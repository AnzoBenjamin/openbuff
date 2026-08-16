import { publisher } from '../constants'
import { type SecretAgentDefinition } from '../types/secret-agent-definition'

import type { StepText } from '../types/agent-definition'
import type { ToolResultOutput } from '../types/util-types'

const MAX_LISTED_FILES = 8

export const createFileLister = (): Omit<SecretAgentDefinition, 'id'> => ({
  displayName: 'Liszt the File Lister',
  publisher,
  // file-lister is the internal worker of `file-picker` (its sole spawner via
  // file-picker's `spawnableAgents`). It is intentionally NOT in any
  // orchestrator's spawnable list — the orchestrator spawns `file-picker`,
  // which fans out to file-lister internally. Keep this contract narrow.
  spawnerPrompt: `Internal worker for the file-picker agent. Lists up to ${MAX_LISTED_FILES} files that are relevant to the prompt within the given project-relative directories. Unless you know which directories are relevant, omit the directories parameter.`,
  inputSchema: {
    prompt: {
      type: 'string',
      description: 'A coding task to complete',
    },
    params: {
      type: 'object' as const,
      properties: {
        directories: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description:
            'Optional project-relative directories to search. Absolute paths, traversal, and glob syntax are rejected. At most 8 valid directories are used; extra entries are ignored.',
        },
      },
      required: [],
    },
  },
  outputMode: 'last_message',
  includeMessageHistory: false,
  toolNames: ['query_index', 'read_subtree'],
  spawnableAgents: [],

  systemPrompt: `You are an expert at finding relevant files in a codebase and listing them out.`,
  instructionsPrompt: `Instructions:
- List at most ${MAX_LISTED_FILES} exact project-relative file paths that are relevant to the prompt, separated by newlines.
- Prefer paths surfaced by the local codebase graph index when they are relevant. Treat relatedFiles as useful adjacent context, but also use the repository tree context to avoid missing obvious nearby files.
- Do not write any introductory commentary.
- Do not write any analysis or any English text at all.
- Do not use any more tools. Do not call query_index or read_subtree again.

Here's an example response with made up file paths (these are not real file paths, just an example):
<example_response>
example/src/widget.ts
example/src/gadget.ts
example/lib/factory.ts
example/lib/types/widget.ts
example/tests/widget.test.ts
docs/example/overview.md
docs/example/api.md
config/example.json
</example_response>

Again: Do not call any tools or write anything else other than the chosen file paths on new lines. Go.
`.trim(),

  handleSteps: function* ({ prompt, params }) {
    // Keep helpers inside handleSteps: bundled programmatic agents serialize
    // this generator without its module-level closures.
    const extractFilePathsFromPrintedTree = (printedTree: string): string[] => {
      const lines = printedTree
        .split('\n')
        .filter((rawLine) => rawLine.trim().length > 0)
      const indentSizes = lines
        .map((rawLine) => rawLine.length - rawLine.trimStart().length)
        .filter((indent) => indent > 0)
      const indentWidth = Math.max(
        1,
        indentSizes.reduce((width, indent) => {
          let a = width
          let b = indent
          while (b !== 0) {
            const next = a % b
            a = b
            b = next
          }
          return a
        }, indentSizes[0] ?? 1),
      )

      const paths: string[] = []
      const directoryStack: string[] = []
      let previousFileDepth: number | undefined

      for (const rawLine of lines) {
        const leading = rawLine.length - rawLine.trimStart().length
        const depth = Math.floor(leading / indentWidth)
        const name = rawLine.trim().replace(/\s+\d+\s*$/, '')

        // Parsed symbols are printed one indentation level below their file.
        if (previousFileDepth !== undefined && depth > previousFileDepth) {
          continue
        }
        previousFileDepth = undefined

        if (name.endsWith('/')) {
          directoryStack.length = depth
          directoryStack[depth] = name.slice(0, -1)
          continue
        }

        const path = [...directoryStack.slice(0, depth), name]
          .filter(Boolean)
          .join('/')
        if (path.length > 0) paths.push(path)
        previousFileDepth = depth
      }

      if (paths.length > 0) {
        return Array.from(new Set(paths))
      }

      const fallbackPaths: string[] = []
      const filePathPattern =
        /(?:^|[^A-Za-z0-9_./-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md))\b/g
      let match: RegExpExecArray | null
      while ((match = filePathPattern.exec(printedTree)) !== null) {
        fallbackPaths.push(match[1])
      }
      return Array.from(new Set(fallbackPaths))
    }
    const extractFilePathsFromSubtree = (
      toolResult: ToolResultOutput[] | undefined,
    ): string[] => {
      const subtreeEntries = (toolResult ?? []).flatMap((part) => {
        if (part.type !== 'json' || !Array.isArray(part.value)) return []
        return part.value.filter(
          (
            value,
          ): value is {
            path?: string
            type?: string
            printedTree?: string
          } =>
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value),
        )
      })
      const paths: string[] = []

      for (const entry of subtreeEntries) {
        if (
          entry.type === 'file' &&
          typeof entry.path === 'string' &&
          entry.path.length > 0
        ) {
          paths.push(entry.path.replace(/\\/g, '/').replace(/^\.\//, ''))
          continue
        }
        if (
          entry.type === 'directory' &&
          typeof entry.printedTree === 'string'
        ) {
          paths.push(...extractFilePathsFromPrintedTree(entry.printedTree))
        }
      }

      return Array.from(new Set(paths))
    }
    const extractFilePathsFromQueryIndex = (
      toolResult: ToolResultOutput[] | undefined,
    ): string[] => {
      const paths: string[] = []

      for (const part of toolResult ?? []) {
        if (part.type !== 'json') continue
        const value = part.value
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          continue
        }
        if (!('results' in value) || !Array.isArray(value.results)) {
          continue
        }

        for (const item of value.results) {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            continue
          }
          if (
            'path' in item &&
            typeof item.path === 'string' &&
            item.path.length > 0
          ) {
            paths.push(item.path)
          }
          if (!('relatedFiles' in item) || !Array.isArray(item.relatedFiles)) {
            continue
          }
          for (const related of item.relatedFiles) {
            if (
              typeof related === 'object' &&
              related !== null &&
              !Array.isArray(related) &&
              'path' in related &&
              typeof related.path === 'string' &&
              related.path.length > 0
            ) {
              paths.push(related.path)
            }
          }
        }
      }

      return paths
    }
    const isWithinDirectory = (path: string): boolean =>
      directories.some(
        (directory) =>
          path === directory || path.startsWith(`${directory}/`),
      )
    const rankFilePaths = (paths: string[]): string[] => {
      const keywords = Array.from(
        new Set((prompt ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? []),
      )
      return paths
        .map((path, index) => ({
          path,
          index,
          score: keywords.reduce(
            (score, keyword) =>
              score + (path.toLowerCase().includes(keyword) ? 1 : 0),
            0,
          ),
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, 8)
        .map(({ path }) => path)
    }
    const rawDirectories = Array.isArray(params?.directories)
      ? params.directories
      : []
    const directories = Array.from(
      new Set(
        rawDirectories
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.replace(/\\/g, '/').replace(/^\.\//, ''))
          .map((value) => value.replace(/\/+$/, ''))
          .filter(
            (value) =>
              value.length > 0 &&
              value !== '.' &&
              !value.startsWith('/') &&
              !/^[A-Za-z]:\//.test(value) &&
              !value.split('/').includes('..') &&
              !/[?*{}[\]]/.test(value),
          ),
      ),
    ).slice(0, 8)
    if (rawDirectories.length > 0 && directories.length === 0) {
      yield {
        type: 'STEP_TEXT',
        text: 'No valid project-relative directory scope was provided.',
      } satisfies StepText
      return
    }
    const scopedPrompt =
      directories.length > 0
        ? `${prompt ?? ''}\nOnly return files within: ${directories.join(', ')}`
        : prompt
    let indexResult: ToolResultOutput[] | undefined
    if (typeof prompt === 'string' && prompt.trim().length > 0) {
      const { toolResult } = yield {
        toolName: 'query_index',
        input: {
          query: scopedPrompt,
          limit: 24,
          ...(directories.length > 0 ? { pathPrefixes: directories } : {}),
        },
      }
      indexResult = toolResult
    }
    const { toolResult: subtreeResult } = yield {
      toolName: 'read_subtree',
      input: {
        paths: directories,
        maxTokens: 8_000,
      },
    }

    const candidatePaths = Array.from(
      new Set([
        ...extractFilePathsFromQueryIndex(indexResult),
        ...extractFilePathsFromSubtree(subtreeResult),
      ]),
    )
    const scopedPaths =
      directories.length > 0
        ? candidatePaths.filter(isWithinDirectory)
        : candidatePaths
    const rankedPaths = rankFilePaths(scopedPaths)
    if (rankedPaths.length > 0) {
      yield {
        type: 'STEP_TEXT',
        text: rankedPaths.join('\n'),
      } satisfies StepText
      return
    }

    yield 'STEP'
  },
})

const definition: SecretAgentDefinition = {
  id: 'file-lister',
  ...createFileLister(),
}

export default definition
