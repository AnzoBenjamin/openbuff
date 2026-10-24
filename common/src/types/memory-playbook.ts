import { createHash } from 'node:crypto'
import { z } from 'zod/v4'
import { MemoryProvenanceSchema } from './memory-v2'

export const PLAYBOOK_SCHEMA_VERSION = 1

export const PlaybookTriggerSchema = z.strictObject({
  tool: z.enum(['spawn_agents', 'spawn_agent_inline', 'run_terminal_command']),
  spawnAgentType: z.string().min(1).max(128).optional(),
  terminalAction: z
    .enum(['git-push', 'git-commit', 'git-stage', 'any'])
    .optional(),
  requireEvidence: z
    .array(
      z.strictObject({
        kind: z.enum([
          'toolSucceeded',
          'fileDigestUnchanged',
          'claimPinned',
          'observationPresent',
        ]),
        tool: z.string().max(128).optional(),
        commandPattern: z.string().max(256).optional(),
        withinMs: z.number().int().positive().optional(),
        path: z.string().max(1_024).optional(),
      }),
    )
    .max(8)
    .default([]),
})
export type PlaybookTrigger = z.infer<typeof PlaybookTriggerSchema>

export const PlaybookScopeSchema = z.strictObject({
  repos: z.array(z.string().max(1_024)).max(8).default([]),
  glob: z.array(z.string().max(256)).max(16).optional(),
  agentTypes: z.array(z.string().max(128)).max(8).optional(),
})
export type PlaybookScope = z.infer<typeof PlaybookScopeSchema>

export const PlaybookCountersSchema = z.strictObject({
  fired: z.number().int().nonnegative().default(0),
  blocked: z.number().int().nonnegative().default(0),
  compliedAfterBlock: z.number().int().nonnegative().default(0),
  falsePositives: z.number().int().nonnegative().default(0),
  bypassed: z.number().int().nonnegative().default(0),
  lastFiredAt: z.number().int().nonnegative().optional(),
  lastFalsePositiveAt: z.number().int().nonnegative().optional(),
})
export type PlaybookCounters = z.infer<typeof PlaybookCountersSchema>

export const PlaybookStatusSchema = z.enum([
  'candidate',
  'active',
  'verified',
  'retired',
])
export type PlaybookStatus = z.infer<typeof PlaybookStatusSchema>

export const PlaybookEnforcementSchema = z.enum([
  'block',
  'warn',
  'inject-only',
])
export type PlaybookEnforcement = z.infer<typeof PlaybookEnforcementSchema>

/**
 * A playbook (procedural memory) record: a reusable, scope-limited rule that
 * gates a tool invocation behind a required instruction.
 *
 * `triggerSignature` is the upsert/dedup key: two playbooks with the same
 * signature are the same rule, so an upsert updates counters/status in place
 * instead of inserting a duplicate row. See {@link computeTriggerSignature}.
 */
export const MemoryPlaybookSchema = z.strictObject({
  schemaVersion: z.literal(PLAYBOOK_SCHEMA_VERSION),
  playbookId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  taskId: z.string().max(128).optional(),
  title: z.string().min(1).max(200),
  instruction: z.string().min(1).max(4_096),
  trigger: PlaybookTriggerSchema,
  scope: PlaybookScopeSchema,
  status: PlaybookStatusSchema,
  enforcement: PlaybookEnforcementSchema,
  counters: PlaybookCountersSchema,
  provenance: MemoryProvenanceSchema,
  triggerSignature: z.string().min(1).max(128),
  expiresAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type MemoryPlaybook = z.infer<typeof MemoryPlaybookSchema>

export type PlaybookTriggerOutcome =
  | 'allowed'
  | 'blocked'
  | 'warned'
  | 'bypassed'

/**
 * Recursively sorts object keys and drops `undefined` members so
 * JSON.stringify produces a byte-stable canonical form regardless of the key
 * order the caller happened to use.
 */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(
      entries.map(([key, member]) => [key, canonicalize(member)]),
    )
  }
  return value
}

/**
 * Stable upsert/dedup key for a playbook: sha256 hex (64 chars) over the
 * canonical deterministic JSON of `{ tool, spawnAgentType, terminalAction,
 * requireEvidence, scope }`, with schema defaults applied
 * (`requireEvidence: []`, `repos: []`) and object keys recursively sorted.
 * Two playbooks with the same signature are the same rule. The
 * `common/src/util/stable-hash.ts` FNV-1a helper does not fit here: this key
 * must be collision-resistant across a persistent store, so node:crypto
 * sha256 is used instead.
 */
export const computeTriggerSignature = (
  trigger: PlaybookTrigger,
  scope: PlaybookScope,
): string => {
  // Re-parse through the schemas so schema-level defaults are always applied
  // before hashing: a caller that omitted `requireEvidence`/`repos` and one
  // that passed them explicitly must produce the same signature.
  const parsedTrigger = PlaybookTriggerSchema.parse(trigger)
  const parsedScope = PlaybookScopeSchema.parse(scope)
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalize({
          tool: parsedTrigger.tool,
          spawnAgentType: parsedTrigger.spawnAgentType,
          terminalAction: parsedTrigger.terminalAction,
          requireEvidence: parsedTrigger.requireEvidence,
          scope: {
            repos: parsedScope.repos,
            glob: parsedScope.glob,
            agentTypes: parsedScope.agentTypes,
          },
        }),
      ),
    )
    .digest('hex')
    .slice(0, 64)
}
