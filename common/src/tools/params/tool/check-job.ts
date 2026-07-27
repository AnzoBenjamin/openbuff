import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'check_job'
const endsAgentStep = true
const inputSchema = z
  .object({
    jobId: z
      .string()
      .min(1)
      .describe(
        'The jobId returned by run_terminal_command with process_type: BACKGROUND.',
      ),
    wait_for: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional substring to wait for in the new output before returning (follow mode). Returns early as soon as it appears (e.g. "Listening on" / "compiled successfully").',
      ),
    timeout_seconds: z
      .number()
      .int()
      .min(0)
      .max(600)
      .default(0)
      .optional()
      .describe(
        'Max seconds to wait for new output / the wait_for pattern. 0 (default) returns immediately with whatever new output exists (poll mode); >0 blocks up to this long (follow mode).',
      ),
    kill_on_timeout: z
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Follow mode only: when true and the follow-timeout fires (deadline reached, wait_for not yet matched, job still running), send SIGTERM to the background job and reflect the post-kill status/exitCode plus `killed: true` in the result. Defaults to false so observational polling never terminates work unless explicitly requested. Poll mode (timeout_seconds 0/omitted) never kills regardless of this flag.',
      ),
  })
  .describe(
    'Join/wait on a background job started by run_terminal_command: returns the sequenced output events produced since the last check plus the unified job state and exit code. Use it to observe a long-running process without blocking the turn. To watch an arbitrary log file, start a `tail -f <file>` BACKGROUND job and check_job it with a wait_for pattern.',
  )

const description = `
Join (poll) or wait (follow) on a background job started by run_terminal_command with process_type: BACKGROUND. Every call returns a unified event-slice result from the job registry: \`events\` (the new \`{type:'output',data}\` events since your cursor), \`nextCursor\` (pass it back on the next call), \`state\` (running|completed|error|stopped|lost|cancelled), and \`exitCode\` when finished.

- Poll mode (no wait_for/timeout): returns immediately with the output events produced since your last check_job for this job.
- Follow mode (wait_for and/or timeout_seconds): blocks — bounded by timeout_seconds — until wait_for appears in new output or the job exits, then returns. \`matched\` indicates whether wait_for was seen. A timeout leaves the job running by default (\`timedOut: true\`); set kill_on_timeout to true only when the timeout should explicitly terminate it. Poll mode never kills.

The cursor is per-consumer: output events never repeat across calls that thread nextCursor. \`truncated\` flags that events at or below your cursor were evicted from the bounded buffer (\`dropped\` is the cumulative eviction count). If you need the full/latest tail without consuming incremental output, use read_logs with the jobId. Prefer check_job over blocking SYNC commands for dev servers, build watchers, and log tails.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    jobId: 'job-1234-1',
    wait_for: 'Listening on',
    timeout_seconds: 30,
  },
  endsAgentStep,
})}
`.trim()

export const checkJobParams = {
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
              payload: z.union([
                z.object({
                  type: z.literal('output'),
                  data: z.string(),
                }),
                z.object({
                  type: z.literal('agent_chunk'),
                  chunkType: z.string(),
                  data: z.any(),
                }),
                z.object({
                  type: z.literal('lifecycle'),
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
                  exitCode: z.number().nullable().optional(),
                  error: z.string().optional(),
                }),
                z.object({
                  type: z.literal('status'),
                  message: z.string().optional(),
                }),
              ]),
            }),
          )
          .describe(
            "Sequenced events since the consumer's cursor. Payloads match the unified job-registry JobEventPayload union ({type:'output',data} / {type:'agent_chunk',chunkType,data} / {type:'lifecycle',state,exitCode?,error?} / {type:'status',message?}); check_job primarily emits output events.",
          ),
        nextCursor: z.number().int().nonnegative(),
        truncated: z.boolean(),
        dropped: z.number().int().min(0),
        exitCode: z.number().nullable().optional(),
        matched: z.boolean().optional(),
        timedOut: z.boolean().optional(),
        killed: z.boolean().optional(),
        logFile: z.string().optional(),
        errorMessage: z.string().optional(),
      }),
      z.object({
        jobId: z.string(),
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
