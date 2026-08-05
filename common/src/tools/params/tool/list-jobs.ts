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
    "List this run's background jobs (shell processes and background agents, running and settled) with statuses, bucketed pending process/log output relative to the last check_job consumer cursor (agents usually show pending: 'none'), and a gap flag.",
  )

const description = `
List this run's background jobs: process (run_terminal_command BACKGROUND) and agent (spawn_agents background). Includes running and recently settled jobs.

Each entry has status, pending output buckets vs last check_job cursor (agents often pending: 'none'), gap when buffer events were dropped, and optional tail/exitCode. Use to rediscover jobIds for check_job/read_logs/kill_job or check_background_agent. Unchanged digests may return { unchanged: true, note } (with no jobs field). No agent-supplied input (owner is runtime-managed).

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
    z.union([
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
            pending: z.enum(['none', '<10', '<100', '<1k', '1k+']),
            gap: z.boolean(),
            exitCode: z.number().nullable().optional(),
            tail: z.array(z.string()).max(10).optional(),
          }),
        ),
        note: z.string(),
        truncatedCount: z.number().optional(),
      }),
      // Suppressed variant: the per-turn change-gate (applyListJobsDigestGate)
      // swaps the full digest for this payload when nothing changed — it
      // deliberately omits `jobs` so an empty array can't read as "no jobs".
      z.object({
        unchanged: z.literal(true),
        note: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
