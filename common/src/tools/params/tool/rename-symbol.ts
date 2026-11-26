import z from 'zod/v4'

import { jsonToolResultSchema } from '../utils'

import { lspUnavailableSchema } from './go-to-definition'

import type { $ToolParams } from '../../constants'

/**
 * Semantic rename backed by the language server.
 *
 * The rename is applied through the workspace mutation broker, which is
 * hash-gated per file and records a single commit receipt. Positions follow
 * the human-friendly 1-based line convention (editors and `read_files` ranges
 * number lines from 1); the SDK converts to the 0-based LSP position
 * internally. `character` is a 0-based UTF-16 offset.
 */

export const semanticEditResultSchema = jsonToolResultSchema(
  z.object({
    applied: z.boolean().optional(),
    results: z
      .array(
        z.object({
          path: z.string(),
          applied: z.boolean(),
          errorMessage: z.string().optional(),
          annotations: z
            .array(
              z.object({
                id: z.string().min(1).max(128),
                label: z.string().min(1).max(256),
                description: z.string().max(1024).optional(),
              }),
            )
            .max(128)
            .optional(),
        }),
      )
      .optional(),
    unavailable: lspUnavailableSchema.optional(),
    errorMessage: z.string().optional(),
  }),
)

export const renameSymbolParams = {
  toolName: 'rename_symbol',
  endsAgentStep: true,
  description:
    'Renames the symbol at a file position through the language server and applies the complete WorkspaceEdit through the workspace mutation broker, guarded by pre-request document versions and exact bytes. `line` is 1-based; `character` is a 0-based UTF-16 offset. An unverified document, unsupported edit, or annotation requiring confirmation refuses the whole group.',
  inputSchema: z.object({
    path: z.string().min(1).describe('Project-relative file path.'),
    line: z.number().int().min(1).max(1_000_000),
    character: z.number().int().min(0).max(100_000),
    new_name: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .describe('New name for the symbol.'),
  }),
  outputSchema: semanticEditResultSchema,
} satisfies $ToolParams<'rename_symbol'>
