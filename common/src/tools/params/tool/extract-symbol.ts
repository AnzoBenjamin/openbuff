import z from 'zod/v4'

import { semanticEditResultSchema } from './rename-symbol'

import type { $ToolParams } from '../../constants'

/**
 * Language-server extract refactor applied through the workspace mutation
 * broker (hash-gated per file; a create-file edit becomes a broker create).
 *
 * Positions follow the human-friendly 1-based line convention (editors and
 * `read_files` ranges number lines from 1); the SDK converts to the 0-based
 * LSP position internally. `character` is a 0-based UTF-16 offset.
 */

export const extractSymbolParams = {
  toolName: 'extract_symbol',
  endsAgentStep: true,
  description:
    'Extracts a symbol through a concrete, command-free language-server WorkspaceEdit that updates the source and creates exactly `destination_path`. The broker applies the complete edit against the pre-request document basis. `line` is 1-based; `character` is a 0-based UTF-16 offset. The destination must be a new project-relative file. Command-backed offers and mismatched destinations are refused.',
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
  outputSchema: semanticEditResultSchema,
} satisfies $ToolParams<'extract_symbol'>
