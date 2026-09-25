import z from 'zod/v4'
import { jsonValueSchema } from './json'

export const agentRoleSchema = z.enum([
  'orchestrator',
  'explorer',
  'thinker',
  'editor',
  'repair-editor',
  'test-writer',
  'doc-writer',
  'dependency-manager',
  'debugger',
  'validator',
  'reviewer',
  'security-reviewer',
  'committer',
  'synthesizer',
  'specialist',
  'general',
])

export type AgentRole = z.infer<typeof agentRoleSchema>

export const agentRequirementSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    required: z.boolean(),
  })
  .strict()

export const agentAcceptanceCriterionSchema = z
  .object({
    id: z.string().min(1),
    behavior: z.string().min(1),
    verification: z.string().min(1),
  })
  .strict()

export const agentEvidenceReferenceSchema = z
  .object({
    path: z.string().min(1),
    symbols: z.array(z.string()),
    reason: z.string().min(1),
    confidence: z.enum(['confirmed', 'inferred', 'unknown']),
    freshnessHash: z.string().min(1).optional(),
    workspaceRevision: z.number().int().nonnegative().optional(),
  })
  .strict()

export const agentFindingSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    files: z.array(z.string().min(1)),
    snapshotFingerprint: z.string().min(1),
    // Q4-3 (gate-robustness fix): the reviewer family that reported the
    // finding (code-reviewer / security-reviewer / a specialist agent type).
    // Optional for legacy envelopes; when present it lets repair-progress
    // reconciliation scope `findingsAddressed` to the OWNING family instead
    // of accepting any family's id.
    reviewer: z.string().min(1).optional(),
  })
  .strict()

export const agentCapabilityRequestSchema = z
  .object({
    readablePaths: z.array(z.string().min(1)),
    writablePaths: z.array(z.string().min(1)),
    allowedTools: z.array(z.string().min(1)),
  })
  .strict()

/**
 * Canonical, versioned task envelope accepted by every spawn boundary.
 *
 * The envelope is deliberately strict: versioned handoffs are control-plane
 * data, not an open-ended prompt bag. Optional legacy/free-form spawn params
 * remain available outside `handoff`.
 */
export const agentHandoffSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    role: agentRoleSchema,
    objective: z.string().min(1),
    requirements: z.array(agentRequirementSchema),
    acceptanceCriteria: z.array(agentAcceptanceCriterionSchema),
    context: z.union([
      z.array(agentEvidenceReferenceSchema),
      z.record(z.string(), z.unknown()),
      z.string(),
    ]),
    currentBehavior: z.string().optional(),
    desiredBehavior: z.string().optional(),
    invariants: z.array(z.string()).default([]),
    nonGoals: z.array(z.string()),
    risks: z.array(z.string()).default([]),
    unknowns: z.array(z.string()).default([]),
    findings: z.array(agentFindingSchema),
    permissions: agentCapabilityRequestSchema,
    workspaceRevision: z.number().int().nonnegative().optional(),
    workspaceSnapshotId: z.string().min(1).optional(),
    summary: z.string().optional(),
    artifacts: z.array(z.string()).default([]),
    successCriteria: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
  })
  .strict()

export type AgentHandoff = z.infer<typeof agentHandoffSchema>

export const agentChangedFileReceiptSchema = z
  .object({
    path: z.string().min(1),
    beforeHash: z.string().optional(),
    afterHash: z.string().optional(),
    mutationReceiptId: z.string().optional(),
  })
  .strict()

export const agentReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: z.string().min(1),
    taskId: z.string().min(1),
    role: agentRoleSchema,
    agentId: z.string().min(1),
    status: z.enum(['completed', 'partial', 'blocked', 'failed', 'cancelled']),
    workspaceRevision: z.number().int().nonnegative().optional(),
    workspaceSnapshotId: z.string().min(1).optional(),
    changedFiles: z.array(agentChangedFileReceiptSchema),
    requirementsAddressed: z.array(z.string()),
    acceptanceCriteriaAddressed: z.array(z.string()),
    findingsAddressed: z.array(z.string()),
    evidence: z.array(
      z
        .object({
          id: z.string().min(1),
          kind: z.enum([
            'read',
            'edit',
            'validation',
            'review',
            'decision',
            'artifact',
          ]),
          summary: z.string(),
          source: z.string().optional(),
          freshnessHash: z.string().optional(),
          workspaceRevision: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ),
    assumptions: z.array(z.string()),
    unresolved: z.array(z.string()),
    requestedValidation: z.array(z.string()),
    artifacts: z.array(z.string()),
    errors: z.array(
      z
        .object({
          code: z.string().optional(),
          message: z.string(),
          retryable: z.boolean().optional(),
        })
        .strict(),
    ),
    output: jsonValueSchema.optional(),
    truncated: z
      .object({
        omittedItems: z.number().int().nonnegative().default(0),
        omittedChars: z.number().int().nonnegative().default(0),
        artifact: z.string().optional(),
      })
      .strict()
      .optional(),
    /**
     * Observational telemetry about how much context the finished child
     * actually used: the tokens it ended on, the window it ran against, and
     * that ratio as a percent (clamped, so a child that overran its declared
     * window still produces a valid receipt). Purely informational — the
     * parent may use it to size later delegations (more, narrower shards when
     * a child came back near its window). Optional, so every existing receipt
     * stays valid and no consumer migration is required.
     */
    contextUsage: z
      .object({
        tokens: z.number().int().min(0),
        windowTokens: z.number().int().min(0).optional(),
        percentOfWindow: z.number().int().min(0).max(100).optional(),
        compactionCount: z.number().int().min(0).optional(),
      })
      .optional(),
    /**
     * Compact reviewer attestation core attached by the runtime so the gate's
     * walker can attest even when the full structured result payload was
     * truncated in transit; additive + optional so every existing receipt
     * stays valid.
     */
    review: z
      .object({
        verdict: z.enum(['LOOKS_GOOD', 'NON_BLOCKING', 'BLOCKING']),
        snapshotFingerprint: z.string().optional(),
        reviewedFiles: z.array(z.string()).optional(),
        coverage: z.enum(['covered', 'missing', 'n/a']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type AgentReceipt = z.infer<typeof agentReceiptSchema>

export function isDirectOrchestratorEditEligible(params: {
  fileCount: number
  estimatedChangedLines: number
  behaviorChange: boolean
  publicContractChange: boolean
  requiresTests: boolean
  securityOrConcurrencyRisk: boolean
  hasOpenFindings: boolean
}): boolean {
  return (
    params.fileCount === 1 &&
    params.estimatedChangedLines <= 12 &&
    !params.behaviorChange &&
    !params.publicContractChange &&
    !params.requiresTests &&
    !params.securityOrConcurrencyRisk &&
    !params.hasOpenFindings
  )
}
