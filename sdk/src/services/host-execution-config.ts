import path from 'node:path'
import { z } from 'zod/v4'

const absolutePath = z
  .string()
  .min(1)
  .refine(
    (value) => path.isAbsolute(value) && !value.includes('\0'),
    'Requires an absolute path without NUL bytes',
  )
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const capability = z.enum([
  'exact-env',
  'cooperative-cancellation',
  'filesystem-isolation',
  'network-isolation',
  'process-tree-containment',
  'memory-limit',
  'deadline-termination',
])
const capabilities = z
  .array(capability)
  .refine(
    (values) => new Set(values).size === values.length,
    'Capabilities must not contain duplicates',
  )

/** A whole declaration: fragments cannot splice profile and installation authority. */
export const hostExecutionConfigSchema = z
  .strictObject({
    profile: z.strictObject({
      policy: z.enum([
        'read-only',
        'librarian-read-only',
        'git-commit',
        'dependency-mutation',
        'validation-diagnosis',
        'tmux-test',
        'workspace-write',
        'full-access',
      ]),
      preferredBackend: z.enum(['portable-ts', 'native-exec']),
      required: capabilities,
      optional: capabilities.optional(),
      allowBackendFallback: z.boolean(),
    }),
    native: z
      .strictObject({
        artifact: z.strictObject({
          path: absolutePath,
          sha256,
          platform: z.literal('linux-x64-gnu'),
          crateVersion: z.literal('0.1.0'),
          workspaceProtocol: z.literal('1'),
        }),
        bwrap: z.strictObject({ path: absolutePath, sha256 }),
        runtimePaths: z.array(absolutePath).min(1),
        network: z.enum(['deny', 'inherit']),
        landlock: z.enum(['disabled', 'optional', 'required']),
      })
      .optional(),
  })
  .superRefine((config, context) => {
    if (config.profile.preferredBackend === 'native-exec' && !config.native)
      context.addIssue({
        code: 'custom',
        path: ['native'],
        message:
          'Native selection requires an explicit installation declaration',
      })
    if (config.profile.preferredBackend === 'portable-ts' && config.native)
      context.addIssue({
        code: 'custom',
        path: ['native'],
        message: 'A native installation requires native backend selection',
      })
    if (
      config.profile.required.some((value) =>
        config.profile.optional?.includes(value),
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['profile'],
        message: 'Required and optional capabilities must be disjoint',
      })
  })

export type HostExecutionConfig = z.infer<typeof hostExecutionConfigSchema>
