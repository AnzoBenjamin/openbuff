import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  jsonToolResultSchema,
} from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'recall_context'
const endsAgentStep = false

const inputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(512)
  .describe(
    'Case-insensitive search terms for archived pre-compaction transcripts. ALL terms must match a verbatim result (AND); stored background summaries use best-effort OR matching.',
  ),
  })
  .describe(
    'Search archived pre-compaction transcripts for verbatim facts a compaction pass removed from visible context.',
  )

const description = `
Search the archived pre-compaction transcripts for verbatim facts that a compaction pass removed from the visible context. Use when the retained <knowledge_memory> references a detail you need but the surrounding tool output was compacted away. Results are bounded snippets with provenance (which archive snapshot matched); archived content is PRE-COMPACTION and possibly stale, so verify against live files before editing. Returns an empty match list when nothing was archived or the terms do not appear.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { query: 'magic-context eviction floor' },
  endsAgentStep,
})}
`.trim()

export const recallContextParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z.object({
        matches: z.array(
          z.object({
            step: z.number().int().nonnegative(),
            toolName: z.string(),
            toolCallId: z.string(),
            snippet: z.string(),
          }),
        ),
        snapshotsSearched: z.number().int().nonnegative(),
        archivedAt: z.array(z.number()),
        consolidations: z
          .array(
            z.object({
              consolidatedAt: z.number(),
              action: z.string(),
              sourceArchivedAts: z.array(z.number()),
              coveredMessages: z.number().int().nonnegative(),
              summary: z.string(),
            }),
          )
          .optional(),
        message: z.string().optional(),
      }),
      z.object({
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
