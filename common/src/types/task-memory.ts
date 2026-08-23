import { z } from 'zod/v4'

const boundedText = (max: number) => z.string().max(max)

/**
 * Canonical array-length caps for the draft lists below. Exported so
 * consumers (e.g. the SDK task-memory store) merge against the exact
 * limits this schema enforces instead of hand-mirroring them and
 * drifting silently.
 */
export const TASK_MEMORY_LIST_CAPS = {
  requirements: 64,
  decisions: 64,
  filesInspected: 128,
  editsMade: 128,
  validationResults: 64,
  reviewReceipts: 64,
  blockers: 64,
  nextActions: 32,
  evidence: 256,
} as const

export const taskMemoryEvidenceV1Schema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum([
    'requirement',
    'decision',
    'read',
    'edit',
    'validation',
    'review',
    'blocker',
    'handoff',
    'note',
  ]),
  summary: boundedText(2_000),
  source: boundedText(1_000).optional(),
  path: boundedText(1_000).optional(),
  freshnessHash: boundedText(256).optional(),
  workspaceRevision: z.number().int().nonnegative().optional(),
  verifiedAt: z.number().int().nonnegative().optional(),
  supersedes: z.array(z.string().min(1).max(160)).max(16).optional(),
  stale: z.boolean().optional(),
})

export const taskMemoryDraftV1Schema = z.object({
  schemaVersion: z.literal(1),
  goal: boundedText(8_000).default(''),
  requirements: z
    .array(boundedText(2_000))
    .max(TASK_MEMORY_LIST_CAPS.requirements)
    .default([]),
  decisions: z
    .array(boundedText(2_000))
    .max(TASK_MEMORY_LIST_CAPS.decisions)
    .default([]),
  filesInspected: z
    .array(boundedText(1_500))
    .max(TASK_MEMORY_LIST_CAPS.filesInspected)
    .default([]),
  editsMade: z
    .array(boundedText(1_500))
    .max(TASK_MEMORY_LIST_CAPS.editsMade)
    .default([]),
  validationResults: z
    .array(boundedText(2_000))
    .max(TASK_MEMORY_LIST_CAPS.validationResults)
    .default([]),
  reviewReceipts: z
    .array(boundedText(4_000))
    .max(TASK_MEMORY_LIST_CAPS.reviewReceipts)
    .default([]),
  blockers: z
    .array(boundedText(2_000))
    .max(TASK_MEMORY_LIST_CAPS.blockers)
    .default([]),
  nextActions: z
    .array(boundedText(2_000))
    .max(TASK_MEMORY_LIST_CAPS.nextActions)
    .default([]),
  historicalSummary: boundedText(24_000).default(''),
  evidence: z
    .array(taskMemoryEvidenceV1Schema)
    .max(TASK_MEMORY_LIST_CAPS.evidence)
    .default([]),
  workspaceRevision: z.number().int().nonnegative().optional(),
  workspaceSnapshotId: boundedText(256).optional(),
})

export const taskMemoryV1Schema = taskMemoryDraftV1Schema.extend({
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  checksum: z.string().min(1).max(64),
})

export type TaskMemoryEvidenceV1 = z.infer<typeof taskMemoryEvidenceV1Schema>
export type TaskMemoryDraftV1 = z.infer<typeof taskMemoryDraftV1Schema>
export type TaskMemoryV1 = z.infer<typeof taskMemoryV1Schema>
