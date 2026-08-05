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
        'Follow mode only: SIGTERM the job on follow-timeout. Poll mode never kills. Default false.',
      ),
  })
  .describe(
    'Join/wait on a background job started by run_terminal_command: returns the sequenced output events produced since the last check plus the unified job state and exit code. Use it to observe a long-running process without blocking the turn. To watch an arbitrary log file, start a `tail -f <file>` BACKGROUND job and check_job it with a wait_for pattern.',
  )

const description = `
Poll or follow a BACKGROUND run_terminal_command job. Returns new \`events\`, \`nextCursor\`, \`state\`, and \`exitCode\` when finished.

- Poll (no wait_for / timeout_seconds 0): immediate new output since last cursor.
- Follow (wait_for and/or timeout_seconds > 0): block until match or exit; \`matched\` / \`timedOut\`. Timeout leaves job running unless kill_on_timeout. Poll never kills.
- Thread nextCursor so events do not repeat; truncated/dropped mark buffer eviction. Prefer read_logs(jobId) for a non-consuming tail snapshot.

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
        touchedPaths: z
          .array(z.string())
          .optional()
          .describe(
            'Optional project-relative paths newly dirtied between BACKGROUND job start and first settled check_job observation (git dirty delta). Emitted once; omitted when not a git repo, snapshot missing, or on subsequent polls.',
          ),
      }),
      z.object({
        jobId: z.string(),
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
