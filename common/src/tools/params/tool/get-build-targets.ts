import z from 'zod/v4'
import { jsonToolResultSchema } from '../utils'
import type { $ToolParams } from '../../constants'

export const getBuildTargetsParams = {
  toolName: 'get_build_targets',
  endsAgentStep: true,
  description:
    'Returns affected package manifests and available typecheck/test/lint/build scripts for changed files without executing them.',
  inputSchema: z.object({ files: z.array(z.string().min(1)).min(1) }),
  outputSchema: jsonToolResultSchema(
    z.object({
      targets: z.array(
        z.object({
          packageRoot: z.string(),
          scripts: z.array(z.string()),
          manifest: z.string(),
          manager: z.string().optional(),
          commands: z.array(z.string()).optional(),
          confidence: z.enum(['confirmed', 'inferred', 'unknown']).optional(),
        }),
      ),
      owningTargets: z
        .array(
          z.object({
            file: z.string(),
            ecosystem: z.string(),
            confidence: z.enum(['confirmed', 'inferred', 'unknown']),
            targets: z.array(
              z.object({
                name: z.string(),
                kind: z.enum(['package', 'crate', 'module', 'project', 'target']),
                root: z.string(),
                testCommand: z.string().optional(),
                buildCommand: z.string().optional(),
              }),
            ),
          }),
        )
        .optional()
        .describe(
          'Best-effort per-file owning build-target resolution from the build-graph service; absent when resolution failed.',
        ),
      truncated: z
        .boolean()
        .optional()
        .describe(
          'true when the input file list exceeded the per-call cap and some files were not considered',
        ),
    }),
  ),
} satisfies $ToolParams
