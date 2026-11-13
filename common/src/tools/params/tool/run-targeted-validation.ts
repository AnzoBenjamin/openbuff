import z from 'zod/v4'

import { jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'run_targeted_validation'
const endsAgentStep = true

export const runTargetedValidationParams = {
  toolName,
  endsAgentStep,
  description:
    'Runs configured validation hooks selected by the supplied files against an expected change-review snapshot. artifact_kinds are labels returned in the evidence; they do not select or filter hooks. Fails closed when the snapshot is stale or changes during validation, and returns structured scoped evidence.',
  inputSchema: z.object({
    snapshot_id: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
    artifact_kinds: z
      .array(z.string().min(1))
      .default([])
      .optional()
      .describe(
        'Optional labels echoed in the result; hook selection depends on files, not these labels.',
      ),
  }),
  outputSchema: jsonToolResultSchema(
    z.object({
      schemaVersion: z.literal(1),
      snapshotId: z.string(),
      workspaceRevision: z.number().int().nonnegative().optional(),
      workspaceSnapshotId: z.string().optional(),
      files: z.array(z.string()),
      artifactKinds: z.array(z.string()),
      status: z.enum(['passed', 'failed', 'skipped']),
      assurance: z.enum(['full', 'reduced', 'none']),
      summary: z.string(),
      results: z.array(z.record(z.string(), z.any())),
    }),
  ),
} satisfies $ToolParams
