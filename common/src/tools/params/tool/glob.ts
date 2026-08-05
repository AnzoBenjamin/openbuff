import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'glob'
const endsAgentStep = false
const inputSchema = z
  .object({
    pattern: z
      .string()
      .min(1, 'Pattern cannot be empty')
      .describe(
        'Glob pattern to match files against (e.g., *.js, src/glob/*.ts, glob/test/glob/*.go).',
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        'Optional working directory to search within, relative to project root. If provided, the glob pattern is matched against paths relative to this cwd, while returned files remain project-relative. If not provided, searches from project root.',
      ),
  })
  .describe(
    `Search for files matching a glob pattern. Returns matching file paths sorted by modification time (newest first, then path for deterministic ties).`,
  )
const description = `
Find files by glob name pattern (not content). Optional \`cwd\` scopes pattern evaluation; results stay project-relative. Supports *, **, ?, [abc], {a,b}. Sorted by mtime then path.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: '**/*.test.ts' },
  endsAgentStep,
})}
`.trim()

export const globParams = {
  toolName,
  description,
  endsAgentStep,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z.object({
        files: z.array(z.string()).describe('Array of matching file paths'),
        count: z
          .number()
          .describe('Total number of files matching the pattern'),
        message: z.string().describe('Success message'),
      }),
      z.object({
        errorMessage: z.string().describe('Error message if search failed'),
      }),
    ]),
  ),
} satisfies $ToolParams
