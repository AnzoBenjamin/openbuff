import z from 'zod/v4'
import { jsonToolResultSchema } from '../utils'
import type { $ToolParams } from '../../constants'

export const getAffectedTestsParams = {
  toolName: 'get_affected_tests',
  endsAgentStep: true,
  description:
    'Maps changed source files to existing nearby test candidates and package roots without running tests.',
  inputSchema: z.object({ files: z.array(z.string().min(1)).min(1) }),
  outputSchema: jsonToolResultSchema(
    z.object({
      targets: z.array(
        z.object({
          source: z.string(),
          candidates: z.array(z.string()),
          packageRoot: z.string(),
        }),
      ),
      impact: z
        .array(
          z.object({
            source: z.string(),
            packageRoot: z.string(),
            tiers: z.object({
              convention: z.array(z.string()),
              graph: z.array(z.string()),
              buildTool: z.array(z.string()),
              coverage: z.array(z.string()),
            }),
            candidates: z.array(
              z.object({
                path: z.string(),
                tier: z.enum(['convention', 'graph', 'build-tool', 'coverage']),
                confidence: z.enum(['high', 'medium', 'low']),
              }),
            ),
            graphNote: z
              .string()
              .optional()
              .describe(
                'Why the graph tier contributed nothing, when known (e.g. the indexer reverse-dependency graph is not wired into this tool yet).',
              ),
          }),
        )
        .optional(),
    }),
  ),
} satisfies $ToolParams
