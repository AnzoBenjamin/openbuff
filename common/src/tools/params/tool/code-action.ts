import z from 'zod/v4'

import { semanticEditResultSchema } from './rename-symbol'

import type { $ToolParams } from '../../constants'

/**
 * Language-server source actions applied through the workspace mutation
 * broker (hash-gated per file). v1 supports organize imports only; further
 * kinds land with the extract slice.
 *
 * Positions follow the human-friendly 1-based line convention (editors and
 * `read_files` ranges number lines from 1); the SDK converts to the 0-based
 * LSP position internally. `character` is a 0-based UTF-16 offset.
 */

export const codeActionParams = {
  toolName: 'code_action',
  endsAgentStep: true,
  description:
    'Organizes imports through a concrete, command-free language-server WorkspaceEdit. The broker applies the complete edit against versions and exact bytes captured before the request. `line` is 1-based; `character` is a 0-based UTF-16 offset. Unsupported actions or edits are refused without applying a subset.',
  inputSchema: z.object({
    path: z.string().min(1).describe('Project-relative file path.'),
    line: z.number().int().min(1).max(1_000_000),
    character: z.number().int().min(0).max(100_000),
    kind: z
      .enum(['source.organizeImports'] as const)
      .describe(
        'v1 supports organize imports only; further kinds land with the extract slice.',
      ),
  }),
  outputSchema: semanticEditResultSchema,
} satisfies $ToolParams<'code_action'>
