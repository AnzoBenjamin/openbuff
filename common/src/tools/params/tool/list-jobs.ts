import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'list_jobs'
const endsAgentStep = true
// Ownership is runtime-injected from trusted run/session state by the SDK /
// agent-runtime; the model-facing schema deliberately exposes NO owner field
// (agents must not supply ownership identity).
const inputSchema = z
  .object({})
  .describe(
    "List this run's background jobs (shell processes and background agents, running and settled) and their statuses.",
  )

const description = `
List the background jobs owned by the current run from the unified registry — BOTH shell jobs (kind: 'process') started by run_terminal_command and background-agent jobs (kind: 'agent') started by spawn_agents({ background: true }). This includes still-running jobs and recently settled ones (completed/error/stopped/lost/cancelled) that are retained within the session/TTL.

Use this to rediscover jobIds you may have lost (for example after context compaction) so you can check_job/read_logs/kill_job a shell job or check_background_agent an agent job. This tool takes no agent-supplied input; the owner field is runtime-managed and agents must omit it.

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
          kind: z.enum(['process', 'agent']),
          command: z.string(),
          status: z.enum([
            'queued',
            'running',
            'stopping',
            'completed',
            'error',
            'stopped',
            'lost',
            'cancelled',
          ]),
          startedAt: z.number(),
          completedAt: z.number().optional(),
        }),
      ),
    }),
  ),
} satisfies $ToolParams
