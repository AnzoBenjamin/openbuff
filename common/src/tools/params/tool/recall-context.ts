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
      .optional()
      .describe(
        'Case-insensitive search terms for archived pre-compaction transcript content. ALL terms must match a verbatim result (AND); stored background summaries use best-effort OR matching. Pass toolCallId instead to retrieve one archived tool result by its exact call id.',
      ),
    toolCallId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Exact retrieval: the toolCallId of an archived tool result (the id an eviction tombstone names). Returns the archived original pre-eviction body for that exact call.',
      ),
  })
  .superRefine((input, ctx) => {
    if (input.query === undefined && input.toolCallId === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide query (text search) or toolCallId (exact retrieval).',
      })
    }
  })
  .describe(
    'Search archived pre-compaction transcripts for verbatim conversation or tool facts a compaction pass removed from visible context.',
  )

const description = `
Search the archived pre-compaction transcripts for verbatim facts that a compaction pass removed from the visible context. Use when the retained <knowledge_memory> references a detail you need but the surrounding conversation or tool output was compacted away. Results are bounded snippets with provenance (which archive snapshot matched); archived content is PRE-COMPACTION and possibly stale, so verify against live files before editing. Returns an empty match list when nothing was archived or the terms do not appear. Passing toolCallId instead returns the archived ORIGINAL pre-eviction tool body for that exact call (bounded by the archive write cap), newest copy wins — it is the recovery path named by eviction tombstones.

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
