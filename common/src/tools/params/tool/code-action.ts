import z from 'zod/v4'

import { jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

/**
 * Language-server source actions applied through the workspace mutation
 * broker (hash-gated per file). v1 supports organize imports only; further
 * kinds land with the extract slice.
 *
 * Positions follow the human-friendly 1-based line convention (editors and
 * `read_files` ranges number lines from 1); the SDK converts to the 0-based
 * LSP position internally. `character` is already 0-based, matching LSP.
 */

export const codeActionParams = {
  toolName: 'code_action',
  endsAgentStep: true,
  description:
    'Runs a class of source actions (v1: organize imports) at a file position via the language server and applies the returned WorkspaceEdit through the workspace mutation broker (hash-gated per file). `line` is 1-based (human-friendly); `character` is 0-based (LSP). Returns a structured unavailable result when no language server is present for the file language.',
  inputSchema: z.object({
    path: z.string().min(1).describe('Project-relative file path.'),
    line: z.number().int().min(1).max(1_000_000),
    character: z.number().int().min(0).max(100_000),
    kind: z
      .enum(['source.organizeImports'] as const)
      .describe('v1 supports organize imports only; further kinds land with the extract slice.'),
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
} satisfies $ToolParams<'code_action'>
