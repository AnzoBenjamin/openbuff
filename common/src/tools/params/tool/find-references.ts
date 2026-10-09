import z from 'zod/v4'

import { jsonToolResultSchema } from '../utils'

import { lspLocationSchema } from './go-to-definition'

import type { $ToolParams } from '../../constants'

/**
 * Read-only language-intelligence query backed by the LSP multiplexer.
 *
 * Positions follow the human-friendly 1-based line convention (editors and
 * `read_files` ranges number lines from 1); the SDK converts to the 0-based
 * LSP position internally. `character` is already 0-based, matching LSP.
 */
export const findReferencesParams = {
  toolName: 'find_references',
  endsAgentStep: true,
  description:
    'Finds all references to the symbol at a file position via the language server. Read-only. `line` is 1-based (human-friendly); `character` is 0-based. Returns a structured unavailable result when no language server is present for the file language.',
  inputSchema: z.object({
    path: z.string().min(1).describe('Project-relative file path.'),
    line: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .describe('1-based line number (as shown in editors and read_files).'),
    character: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .describe('0-based character offset within the line (LSP convention).'),
  }),
  outputSchema: jsonToolResultSchema(
    z.object({
      locations: z.array(lspLocationSchema).optional(),
      unavailable: z
        .object({
          reason: z.string(),
          languageId: z.string().optional(),
        })
        .optional(),
      errorMessage: z.string().optional(),
    }),
  ),
} satisfies $ToolParams<'find_references'>
