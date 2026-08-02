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
List the background jobs owned by the current run from the unified registry — BOTH shell jobs (kind: 'process') started by run_terminal_command and background-agent jobs (kind: 'agent') started by spawn_agents({ background: true }). This includes still-running jobs and recently settled ones (completed/error/stopped/lost/cancelled) that are retained within the session/TTL.

Each job includes bucketed pending output relative to the last check_job consumer cursor for process/log output (agent jobs are listed for rediscovery and usually show pending: 'none' for line buckets) and a gap flag when events were truncated from the buffer. When gap is true, pending is a lower bound counted from only the retained (non-truncated) events after the check_job cursor — a flooded job may show pending: 'none' alongside gap: true because older events were evicted from the ring. Terminal jobs may include a short tail (last ≤10 output lines) and exitCode. The top-level note is declarative (no action required unless you need the output). Use this to rediscover jobIds after context compaction so you can check_job/read_logs/kill_job a shell job or check_background_agent an agent job. If nothing changed since the previous list_jobs result this turn, the tool may instead return a small suppression payload of the form { unchanged: true, note } (with no jobs field), meaning the earlier digest is still current. This tool takes no agent-supplied input; the owner field is runtime-managed and agents must omit it.

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
