import z from 'zod/v4'

import { jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

/**
 * Language-server extract refactor applied through the workspace mutation
 * broker (hash-gated per file; a create-file edit becomes a broker create).
 *
 * Positions follow the human-friendly 1-based line convention (editors and
 * `read_files` ranges number lines from 1); the SDK converts to the 0-based
 * LSP position internally. `character` is already 0-based, matching LSP.
 */

export const extractSymbolParams = {
  toolName: 'extract_symbol',
  endsAgentStep: true,
  description:
    'Extracts the symbol at a file position into a new file via the language server and applies the returned WorkspaceEdit through the workspace mutation broker (hash-gated per file; a create-file edit becomes a broker create). `line` is 1-based (human-friendly); `character` is 0-based (LSP). `destination_path` is project-relative and must be a NEW file path (the broker refuses an existing target). Returns a structured unavailable result when no language server is present for the file language or the server offers no extract refactor that creates a destination file.',
  inputSchema: z.object({
    path: z.string().min(1).describe('Project-relative file path.'),
    line: z.number().int().min(1).max(1_000_000),
    character: z.number().int().min(0).max(100_000),
    destination_path: z
      .string()
      .min(1)
      .max(512)
      .describe(
        'Project-relative NEW file path for the extracted code; must not exist yet.',
      ),
    symbol_name: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .describe(
        'Name for the extracted symbol in the destination file (advisory-only: currently ignored — the language server picks its own name).',
      ),
  }),
  outputSchema: jsonToolResultSchema(
    z.object({
      applied: z.boolean().optional(),
      results: z
        .array(
          z.object({
            path: z.string(),
            applied: z.boolean(),
            errorMessage: z.string().optional(),
          }),
        )
        .optional(),
      unavailable: z
        .object({
          reason: z.string(),
          languageId: z.string().optional(),
        })
        .optional(),
      errorMessage: z.string().optional(),
    }),
  ),
} satisfies $ToolParams<'extract_symbol'>
