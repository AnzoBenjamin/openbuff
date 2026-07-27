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
Join (poll) or wait (follow) on a background agent turn started by spawn_agents with background: true. Every call returns a unified event-slice result from the job registry: \`events\` (the new \`{type:'agent_chunk',chunkType,data}\` events since the cursor), \`nextCursor\` (pass it back on the next call), \`state\` (running|completed|error|cancelled), and the resolved result/error when finished.

- Poll mode (no wait_for/timeout): returns immediately with the agent_chunk events (text, tool_call, tool_result, subagent_* payloads) produced since the supplied cursor (or since your last poll when the cursor is omitted).
- Follow mode (wait_for and/or timeout_seconds): blocks — bounded by timeout_seconds — until wait_for appears in any new chunk payload or the job settles, then returns. \`matched\` indicates whether wait_for was seen. A follow-timeout is observational (\`timedOut: true\`) and leaves the agent running. Set \`cancel: true\` to explicitly abort it.

The cursor is per-consumer: chunk events never repeat across calls that thread nextCursor. \`truncated\` flags that events at or below the cursor were evicted from the bounded buffer (\`dropped\` is the cumulative eviction count). Background agent turns are in-process coroutines — they cannot outlive this CLI session and are not recoverable across crashes (their partial state is preserved only via mid-turn checkpointing).

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
