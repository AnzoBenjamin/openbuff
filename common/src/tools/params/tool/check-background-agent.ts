import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'check_background_agent'
const endsAgentStep = false
const inputSchema = z
  .object({
    jobId: z
      .string()
      .min(1)
      .describe(
        'The jobId returned by spawn_agents({ background: true }) for the background agent turn.',
      ),
    cursor: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Optional sequence cursor from a prior response. Polling is idempotent for an explicit cursor; nextCursor can be supplied on the next call.',
      ),
    wait_for: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional substring to wait for in the new streamed chunks before returning (follow mode). Returns early as soon as it appears in any chunk payload. Useful for waiting until a background agent emits a specific milestone (e.g. a tool_result or a text marker).',
      ),
    timeout_seconds: z
      .number()
      .int()
      .min(0)
      .max(600)
      .default(0)
      .optional()
      .describe(
        'Max seconds to wait for new chunks / the wait_for pattern. 0 (default) returns immediately with whatever new chunks exist (poll mode); >0 blocks up to this long (follow mode).',
      ),
    cancel: z
      .boolean()
      .default(false)
      .optional()
      .describe(
        'When true, explicitly cancel the running background agent before returning its final status. Defaults to false.',
      ),
  })
  .describe(
    'Join/wait on a background agent turn started by spawn_agents({ background: true }): returns the sequenced agent_chunk events produced since the cursor plus the unified job state. Use it to observe a long-running background agent without blocking the turn.',
  )

const description = `
Poll or follow a spawn_agents({ background: true }) agent job. Returns agent_chunk \`events\`, \`nextCursor\`, \`state\`, and result/error when finished.

- Poll: immediate chunks since cursor (or last poll if omitted).
- Follow (wait_for and/or timeout_seconds > 0): block until match or settle; timeout is observational. Set cancel true to abort.
- Thread nextCursor; truncated/dropped mark eviction. In-process only — cannot outlive this CLI session.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    jobId: 'bg-agent-1234-1',
    wait_for: 'completed',
    timeout_seconds: 30,
  },
  endsAgentStep,
})}
`.trim()

export const checkBackgroundAgentParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z.object({
        jobId: z.string(),
        state: z.enum([
          'queued',
          'running',
          'stopping',
          'completed',
          'error',
          'stopped',
          'lost',
          'cancelled',
        ]),
        events: z
          .array(
            z.object({
              sequence: z.number().int().positive(),
              jobId: z.string(),
              timestamp: z.number(),
              payload: z.object({
                type: z.literal('agent_chunk'),
                chunkType: z.string(),
                // Opaque structured chunk payload
                // (text/tool_call/tool_result/subagent_*); any JSON shape.
                data: z.any(),
              }),
            }),
          )
          .describe(
            "Sequenced agent_chunk events since the consumer's cursor. Each payload is {type:'agent_chunk',chunkType,data}.",
          ),
        nextCursor: z.number().int().nonnegative(),
        truncated: z.boolean(),
        dropped: z.number().int().min(0),
        // Resolved agent turn result; opaque structured value.
        result: z.any().optional().describe('Resolved value when completed.'),
        error: z
          .string()
          .optional()
          .describe('Rejection message when errored.'),
        matched: z.boolean().optional(),
        timedOut: z.boolean().optional(),
        cancelled: z.boolean().optional(),
      }),
      z.object({
        jobId: z.string(),
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
