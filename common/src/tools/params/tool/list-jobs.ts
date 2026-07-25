import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'list_jobs'
const endsAgentStep = true
const inputSchema = z
  .object({
    owner: z
      .object({
        clientSessionId: z.string(),
        rootRunId: z.string(),
        parentRunId: z.string(),
        parentAgentId: z.string(),
      })
      .optional()
      .describe('Runtime-managed; agents must omit.'),
  })
  .describe(
    "List this run's background shell jobs (running and settled) and their statuses.",
  )

const description = `
List the background shell jobs owned by the current run — both still-running jobs and recently settled ones (completed/error/stopped/lost) that are retained within the session/TTL.

Use this to rediscover jobIds you may have lost (for example after context compaction) so you can check_job/read_logs/kill_job them. This tool takes no agent-supplied input; the owner field is runtime-managed and agents must omit it.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {},
  endsAgentStep,
})}
`.trim()

export const listJobsParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.object({
      jobs: z.array(
        z.object({
          jobId: z.string(),
          command: z.string(),
          status: z.enum([
            'running',
            'completed',
            'error',
            'lost',
            'stopped',
          ]),
          startedAt: z.number(),
          completedAt: z.number().optional(),
        }),
      ),
    }),
  ),
} satisfies $ToolParams
