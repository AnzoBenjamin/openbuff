import z from 'zod/v4'

import { jsonToolResultSchema } from '../utils'

import { lspLocationSchema } from './go-to-definition'

import type { $ToolParams } from '../../constants'

/**
 * Read-only workspace-wide symbol search backed by the LSP multiplexer
 * (`workspace/symbol` against the warm server for the current workspace).
 */
export const workspaceSymbolParams = {
  toolName: 'workspace_symbol',
  endsAgentStep: true,
  description:
    'Searches workspace-wide symbols (functions, classes, types, …) by name via the warm language server. Read-only. Returns a structured unavailable result when no language server is present for the workspace.',
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe('Symbol name (or substring) to search for, e.g. "createUser".'),
  }),
  outputSchema: jsonToolResultSchema(
    z.object({
      symbols: z
        .array(
          z.object({
            name: z.string(),
            kind: z.number(),
            location: lspLocationSchema,
            containerName: z.string().optional(),
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
} satisfies $ToolParams<'workspace_symbol'>
