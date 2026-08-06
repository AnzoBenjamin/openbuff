import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'query_index'
const endsAgentStep = true

const inputSchema = z
  .object({
    query: z
      .string()
      .optional()
      .default('')
      .describe(
        `Natural language query or keyword terms describing the files you are looking for. Optional for graph modes when from/to paths are provided. For example: "authentication", "database migrations", "editor mutation logic", "React components".`,
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .default(20)
      .describe('Maximum number of results to return. Defaults to 20.'),
    fileTypes: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe(
        `Optional list of file extensions to filter results (without dot). E.g. ["ts", "tsx"] for TypeScript only.`,
      ),
    pathPrefixes: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe(
        'Optional normalized project-relative directory prefixes. Results outside every prefix are excluded before ranking/limiting.',
      ),
    mode: z
      .enum([
        'search',
        'neighbors',
        'path',
        'explain',
        'commands',
        'references',
      ])
      .optional()
      .default('search')
      .describe(
        'search|explain|neighbors|path|commands|references — see tool description.',
      ),
    from: z
      .string()
      .optional()
      .describe(
        'Optional source file path for neighbors, path, and references modes.',
      ),
    to: z
      .string()
      .optional()
      .describe(
        'Optional target file path for path mode. Also used as the seed file for references mode when from is omitted or not indexed.',
      ),
  })
  .superRefine((input, ctx) => {
    for (const [index, prefix] of (input.pathPrefixes ?? []).entries()) {
      const normalized = prefix.replace(/\\/g, '/').replace(/^\.\//, '')
      if (
        normalized.startsWith('/') ||
        /^[A-Za-z]:\//.test(normalized) ||
        normalized.split('/').includes('..') ||
        /[?*{}[\]]/.test(normalized)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['pathPrefixes', index],
          message:
            'pathPrefixes must contain project-relative directory prefixes without traversal or glob syntax',
        })
      }
    }
    const mode = input.mode ?? 'search'
    if (
      (mode === 'search' || mode === 'explain') &&
      input.query.trim().length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['query'],
        message: 'query is required for search and explain modes',
      })
    }
    if (
      mode === 'neighbors' &&
      !input.from &&
      input.query.trim().length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'from or query is required for neighbors mode',
      })
    }
    if (
      mode === 'path' &&
      (!input.from || !input.to) &&
      input.query.trim().length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['query'],
        message: 'query or both from/to paths are required for path mode',
      })
    }
    if (
      mode === 'references' &&
      !input.from &&
      !input.to &&
      input.query.trim().length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'from, to, or query is required for references mode',
      })
    }
  })
  .describe(
    `Query the local codebase graph index to find relevant files ranked by symbol names, imports, headings, paths, doc concepts, and graph relationships. The index is built automatically on startup.`,
  )

const description = `
Query the local codebase graph index (paths, symbols, imports, docs, commands, graph edges). Discovery only — verify with read_files before editing; fall back to read_subtree if the index is empty/building.

Modes: search (default ranked files), explain (with rationale), neighbors, path (from/to), commands (scripts/CI/validation), references (importers/callers of a seed file).

Tips: natural language or symbol names (createUser); mode "commands" for run/validation suites; optional fileTypes/pathPrefixes filters.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { query: 'authentication' },
  endsAgentStep,
})}
`.trim()

export const queryIndexParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.object({
      results: z.array(
        z.object({
          path: z.string(),
          indexedHash: z.string().optional(),
          score: z.number(),
          matchedOn: z.array(z.string()),
          symbols: z.array(z.string()).optional(),
          headings: z.array(z.string()).optional(),
          matchedSnippets: z.array(z.string()).optional(),
          matchedSnippetsOmittedForLength: z.literal(true).optional(),
          relatedFiles: z
            .array(
              z.object({
                path: z.string(),
                score: z.number(),
                reason: z.string(),
                via: z.string().optional(),
              }),
            )
            .optional(),
          relatedFilesOmittedForLength: z.literal(true).optional(),
          explanation: z.string().optional(),
        }),
      ),
      kind: z.literal('query_index_result'),
      schemaVersion: z.literal(1),
      totalIndexed: z.number(),
      indexAge: z.number(),
      snapshot: z
        .object({
          schemaVersion: z.literal(1),
          snapshotId: z.string(),
          indexVersion: z.literal('2'),
          builtAt: z.number(),
          workspaceRevision: z.union([z.string(), z.number()]).optional(),
        })
        .optional(),
      message: z.string(),
      status: z
        .object({
          state: z.enum([
            'disabled',
            'building',
            'ready',
            'stale',
            'degraded',
            'failed',
            'empty',
          ]),
          ready: z.boolean(),
          stale: z.boolean(),
          refreshing: z.boolean(),
          semantic: z.enum([
            'disabled',
            'building',
            'ready',
            'unavailable',
            'failed',
          ]),
          totalIndexed: z.number(),
          indexAge: z.number(),
          diagnostics: z.array(
            z.object({
              filePath: z.string(),
              stage: z.enum(['language', 'read', 'parse']),
              message: z.string(),
            }),
          ),
          coverage: z
            .object({
              truncated: z.boolean(),
              maxFiles: z.number(),
              skippedFiles: z.number(),
              skippedPrefixes: z.array(z.string()),
              parser: z
                .object({
                  requestedFiles: z.number(),
                  parsedFiles: z.number(),
                  reusedFiles: z.number(),
                  freshParsedFiles: z.number(),
                  parsedBytes: z.number(),
                  skippedFiles: z.number(),
                  skippedKnownBytes: z.number(),
                  skippedPrefixes: z.array(z.string()),
                  skippedLanguages: z.array(z.string()),
                  fileBudgetExceeded: z.boolean(),
                  byteBudgetExceeded: z.boolean(),
                  oversizedFiles: z.number(),
                  maxFiles: z.number(),
                  maxFileBytes: z.number(),
                  maxTotalBytes: z.number(),
                  truncated: z.boolean(),
                })
                .optional(),
            })
            .optional(),
          lastBuildError: z
            .object({
              stage: z.enum([
                'load',
                'walk',
                'parse',
                'persist',
                'semantic',
                'unknown',
              ]),
              message: z.string(),
              timestamp: z.number(),
              retryable: z.boolean(),
              cachePath: z.string().optional(),
            })
            .optional(),
          message: z.string(),
        })
        .optional(),
    }),
  ),
} satisfies $ToolParams
