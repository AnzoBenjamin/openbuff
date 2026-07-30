import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  jsonToolResultSchema,
} from '../utils'
import { readBlocksResultV1Schema } from '../../results/filesystem'

import type { $ToolParams } from '../../constants'

const DEFAULT_WINDOW_SIZE = 400
const DEFAULT_CONTEXT_LINES = 40

export const MAX_WINDOW_SIZE = 5_000
export const MAX_CONTEXT_LINES = 2_000
/** Mirrors sdk MAX_RANGE_READ_BYTES so a block read cannot exceed the range-read budget. */
export const MAX_READ_BLOCK_BYTES = 4_194_304

const toolName = 'read_blocks'
const endsAgentStep = true
const inputSchema = z
  .object({
    windows: z
      .array(
        z.object({
          path: z
            .string()
            .min(1)
            .describe(
              'File path to read in contiguous line windows, relative to the project root.',
            ),
          windowSize: z
            .number()
            .int()
            .min(1)
            .max(MAX_WINDOW_SIZE)
            .optional()
            .describe(
              `Lines per window. Defaults to ${DEFAULT_WINDOW_SIZE}, capped at ${MAX_WINDOW_SIZE}.`,
            ),
          window: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe(
              '1-indexed window number to return. Omit to get the window manifest (totalLines, windowSize, windowCount) plus the first window.',
            ),
        }),
      )
      .optional()
      .describe(
        'Windowed reads for large files. Each returned window is a COMPLETE contiguous line block that mints its own cap.v3 editAnchor, so you can edit it directly via replace_range/basedOnRead without a guess-shrink-retry loop.',
      ),
    around: z
      .array(
        z.object({
          path: z
            .string()
            .min(1)
            .describe(
              'File path to read a content-anchored block from, relative to the project root.',
            ),
          match: z
            .string()
            .min(1)
            .describe(
              'Exact literal string to anchor on. Robust to line-number drift.',
            ),
          occurrence: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe(
              '1-indexed occurrence of `match` to anchor on. Defaults to 1.',
            ),
          contextLines: z
            .number()
            .int()
            .min(0)
            .max(MAX_CONTEXT_LINES)
            .optional()
            .describe(
              `Lines of context to include on each side of the match, clamped at file boundaries. Defaults to ${DEFAULT_CONTEXT_LINES}, capped at ${MAX_CONTEXT_LINES}.`,
            ),
        }),
      )
      .optional()
      .describe(
        'Content-anchored reads: find the Nth exact literal match and return a complete bounded block around it, minting a cap.v3 editAnchor for that block.',
      ),
    symbols: z
      .array(
        z.object({
          path: z
            .string()
            .min(1)
            .describe(
              'File path to extract a symbol slice from, relative to the project root.',
            ),
          name: z
            .string()
            .min(1)
            .describe(
              'Top-level symbol name (function, class, interface, method) to pull, as shown by read_outline.',
            ),
          occurrence: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe(
              'When multiple top-level symbols share this name, the 1-indexed one to return. Defaults to 1. Matches rewrite_symbol occurrence semantics.',
            ),
        })
      )
      .optional()
      .describe(
        'Occurrence-aware symbol reads: pull the Nth top-level symbol with a given name. Parser-proven slices mint a cap.v3 editAnchor.',
      ),
  })
  .superRefine((value, ctx) => {
    if (
      (value.windows?.length ?? 0) === 0 &&
      (value.around?.length ?? 0) === 0 &&
      (value.symbols?.length ?? 0) === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['windows'],
        message:
          'read_blocks requires at least one window, around, or symbol selector.',
      })
    }
  })
  .describe(
    'Read one or more complete, capability-minting structural blocks from files: line windows, literal-anchored context blocks, or occurrence-aware symbol slices. Selector modes may be combined in one call.',
  )
const description = `
Read complete, capability-minting structural blocks from files — the read-side counterpart to edit_transaction for large files. Every COMPLETE block (window, around-block, or symbol slice) returns a structured editAnchor containing startLine, endLine, contentHash, and an authenticated cap.v3 readCapability bound to this project, path, and agent run. Copy editAnchor.readCapability verbatim to basedOnRead/readCapability on a follow-up edit; use the other fields for diagnostics only. Partial/failed blocks mint NO capability.

Important:
- Selector modes may be combined in one call; each selector returns one result item with a contiguous requestIndex and its own editAnchor.
- Windowed read: pass \`windows: [{ path, windowSize?, window? }]\`. The file is split into complete contiguous line windows (default windowSize ${DEFAULT_WINDOW_SIZE}). Pick \`window\` (1-indexed) or omit it to get the manifest (totalLines, windowSize, windowCount) plus the first window. Response items carry totalLines, windowSize, windowCount, and the returned window index.
- Content-anchored read: pass \`around: [{ path, match, occurrence?, contextLines? }]\`. Finds the 1-indexed occurrence (default 1) of the exact literal \`match\` and returns a complete block covering the match plus \`contextLines\` (default ${DEFAULT_CONTEXT_LINES}) on each side, clamped at file boundaries. Robust to line-number drift.
- Symbol read: pass \`symbols: [{ path, name, occurrence? }]\` to pull the Nth (default 1) top-level symbol with that name, mirroring rewrite_symbol's occurrence semantics. Pair with read_outline to discover names first.
- Line ranges are 1-indexed inclusive; totalLines is the true file line count. sourceContent is the exact undecorated normalized block text used for the block hash — use it, not memory, when an exact oldString is needed.
- Each returned block is bounded by a ${MAX_READ_BLOCK_BYTES}-byte budget; an over-budget block returns a too_large error instead, so request a smaller windowSize/contextLines.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    windows: [{ path: 'path/to/large-file.ts', window: 2 }],
    around: [
      {
        path: 'path/to/large-file.ts',
        match: 'export function loadConfig(',
        contextLines: 40,
      },
    ],
    symbols: [{ path: 'path/to/large-file.ts', name: 'loadConfig' }],
  },
  endsAgentStep,
})}
`.trim()

export const readBlocksParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(readBlocksResultV1Schema),
} satisfies $ToolParams
