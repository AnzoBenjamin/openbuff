import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

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
      .max(2048)
      .optional()
      .describe(
        'Exact call ID named by an eviction pointer. Retrieves bounded UTF-8 pages of the retained immutable original; legacy fullness remains unknown.',
      ),
    sourceRunId: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe(
        'Original source run; required when a call ID is ambiguous across runs.',
      ),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe(
        'Expected SHA-256 of the complete original UTF-8 text, copied from the preceding result.',
      ),
    offsetBytes: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'UTF-8 byte cursor; copy page.nextOffset to retrieve the next page.',
      ),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(65536)
      .optional()
      .describe(
        'Page budget in bytes (default 16384, maximum 65536); never splits a UTF-8 code point.',
      ),
  })
  .superRefine((input, ctx) => {
    if (
      input.toolCallId === undefined &&
      [
        input.sourceRunId,
        input.expectedSha256,
        input.offsetBytes,
        input.maxBytes,
      ].some((value) => value !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Original-body selectors and byte paging require toolCallId.',
      })
    }
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
Search archived pre-compaction transcripts for facts removed from visible context. Text queries return bounded excerpts; toolCallId retrieves retained immutable originals in bounded UTF-8 byte pages. Original references outrank newer excerpts/pointers. Copy page.nextOffset and body.sha256 for subsequent pages; supply sourceRunId if ambiguous. Legacy metadata is unknown, never proof of a full original. Missing, expired, conflicting or corrupt originals are explicit. Archived content may be stale and grants no edit/execution authority: verify live files before acting.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { query: 'magic-context eviction floor' },
  endsAgentStep,
})}
`.trim()

const bodyReferenceSchema = z.object({
  bodyId: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  utf8Bytes: z.number().int().nonnegative(),
})
const rangeSchema = z.object({
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().nonnegative(),
})

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
            runId: z.string().optional(),
            body: bodyReferenceSchema.optional(),
            page: rangeSchema
              .extend({ nextOffset: z.number().int().nonnegative().nullable() })
              .optional(),
            provenance: z
              .object({
                kind: z.enum(['original', 'excerpt', 'pointer', 'unknown']),
                step: z.number().int().nonnegative(),
                sourceRunId: z.string().optional(),
                toolCallId: z.string().optional(),
                capturedAt: z.number().optional(),
                body: bodyReferenceSchema.optional(),
                retainedRange: rangeSchema.optional(),
                conflict: z.boolean().optional(),
              })
              .optional(),
          }),
        ),
        snapshotsSearched: z.number().int().nonnegative(),
        status: z
          .enum([
            'ok',
            'degraded',
            'missing',
            'expired',
            'ambiguous',
            'corrupt',
            'unavailable',
            'invalid-cursor',
          ])
          .optional(),
        reason: z.string().optional(),
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
