import z from 'zod/v4'

import { jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

/**
 * Semantic rename backed by the language server.
 *
 * The rename is applied through the workspace mutation broker, which is
 * hash-gated per file and records a single commit receipt. Positions follow
 * the human-friendly 1-based line convention (editors and `read_files` ranges
 * number lines from 1); the SDK converts to the 0-based LSP position
 * internally. `character` is already 0-based, matching LSP.
 */

export const renameSymbolParams = {
  toolName: 'rename_symbol',
  endsAgentStep: true,
  description:
    'Renames the symbol at a file position via the language server and applies the returned WorkspaceEdit through the workspace mutation broker (hash-gated per file with a single recorded commit receipt). `line` is 1-based (human-friendly); `character` is 0-based (LSP). Returns a structured unavailable result when no language server is present for the file language.',
  inputSchema: z.object({
    path: z.string().min(1).describe('Project-relative file path.'),
    line: z.number().int().min(1).max(1_000_000),
    character: z.number().int().min(0).max(100_000),
    new_name: z.string().trim().min(1).max(256).describe('New name for the symbol.'),
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
} satisfies $ToolParams<'rename_symbol'>
