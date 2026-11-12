import z from 'zod/v4'

import { jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

/**
 * Shared typed "cannot answer" result for every LSP tool. `status` tells the
 * model why: `not_installed` (the server binary is missing; `install` names
 * how to get it), `unavailable` (no warm server, unsupported language,
 * refused path). `nextStep` is always a concrete action.
 */
export const lspUnavailableSchema = z.object({
  reason: z.string(),
  languageId: z.string().optional(),
  status: z.enum(['unavailable', 'not_installed']).optional(),
  nextStep: z.string().optional(),
  /** Missing server command (argv[0]) when `status` is `not_installed`. */
  command: z.string().optional(),
  /** Install hint when `status` is `not_installed`. */
  install: z.string().optional(),
})

/**
 * Read-only language-intelligence query backed by the LSP multiplexer.
 *
 * Positions follow the human-friendly 1-based line convention (editors and
 * `read_files` ranges number lines from 1); the SDK converts to the 0-based
 * LSP position internally. `character` is already 0-based, matching LSP.
 */

const lspRangeSchema = z.object({
  start: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }),
  end: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }),
})

export const lspLocationSchema = z.object({
  uri: z.string(),
  path: z.string(),
  range: lspRangeSchema,
})

export const goToDefinitionParams = {
  toolName: 'go_to_definition',
  endsAgentStep: true,
  description:
    'Jumps to the definition of the symbol at a file position via the language server. Read-only. `line` is 1-based (human-friendly); `character` is 0-based. Returns a structured unavailable result when no language server is present for the file language.',
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
      unavailable: lspUnavailableSchema.optional(),
      errorMessage: z.string().optional(),
    }),
  ),
} satisfies $ToolParams<'go_to_definition'>
