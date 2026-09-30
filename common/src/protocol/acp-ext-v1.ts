/**
 * Openbuff ACP extension contracts (ext v1) for the `openbuff.dev` namespace
 * (P1-T1-DESIGN §6, roadmap decision D9).
 *
 * This module is the common-side protocol contract: Zod schemas for every
 * extension payload plus the pure projection functions that derive them from
 * the internal Openbuff contracts (§8). The ACP envelope types themselves come
 * from `@agentclientprotocol/sdk` and are never re-declared here. The wire is
 * pinned by the golden vectors in `__fixtures__/acp-ext-v1` (§8), exercised by
 * `__tests__/acp-ext-v1.golden.test.ts`.
 */

import z from 'zod/v4'

import type { Base2GateState } from '../../../agents/base2/gate-state'
import {
  FILESYSTEM_RESULT_MAX_ACTIONS,
  authorityCapabilityTierSchema,
  commitReceiptV1Schema,
  fileActionKindV1Schema,
  fileMutationOutcomeV1Schema,
  filesystemErrorCodeSchema,
  mutationActionOutcomeV1Schema,
  type FileMutationResultV1,
} from '../tools/results/filesystem'

/** The single `_meta` key every Openbuff ACP extension payload lives under. */
export const OPENBUFF_ACP_NS = 'openbuff.dev'

/** Wire version of the Openbuff ACP extension contract (§3.2). */
export const OPENBUFF_ACP_EXT_VERSION = 1

/** Sandbox tier reported by the P5 sandbox shim (§6.1). */
const sandboxTierV1Schema = z.enum([
  'lexical',
  'landlock',
  'landlock+seccomp',
  'seatbelt',
  'appcontainer',
  'microvm',
])

/** Network policy reported alongside the sandbox tier (§6.1). */
const sandboxNetworkV1Schema = z.enum(['unrestricted', 'allowlist', 'none'])

/**
 * Capability map advertised in `initialize`, returned by
 * `_openbuff.dev/capabilities/get`, and pushed as
 * `_openbuff.dev/capabilities_changed` (§6.1).
 */
export const capabilityMapV1Schema = z
  .object({
    kind: z.literal('openbuff.capabilities'),
    version: z.literal(1),
    generation: z.number().int().nonnegative(),
    sandbox: z
      .object({
        tier: sandboxTierV1Schema,
        // false for 'lexical': never overstated (SPEC principle 6).
        enforced: z.boolean(),
        network: sandboxNetworkV1Schema,
      })
      .strict(),
    index: z
      .object({
        state: z.enum(['absent', 'building', 'ready', 'stale']),
        files: z.number().int().nonnegative().optional(),
      })
      .strict(),
    lsp: z.array(
      z
        .object({
          language: z.string().min(1),
          server: z.string().min(1),
          state: z.enum(['starting', 'ready', 'failed']),
        })
        .strict(),
    ),
    sidecars: z.array(
      z
        .object({
          id: z.string().min(1),
          version: z.string().min(1),
          state: z.enum(['ready', 'degraded', 'failed']),
        })
        .strict(),
    ),
    lanes: z.object({ supported: z.boolean() }).strict(),
    journal: z.object({ resume: z.boolean(), replay: z.boolean() }).strict(),
    gate: z.object({ enabled: z.boolean() }).strict(),
  })
  .strict()

/** Recovery strategies on the internal filesystem error contract. */
const wireRecoveryStrategyV1Schema = z.enum([
  'discover_path',
  'read_again',
  'read_smaller_range',
  'choose_symbol',
  'change_edit_strategy',
  'choose_new_path',
  'use_supported_encoding',
  'retry',
  'inspect_rollback',
  'fix_result',
  'split_transaction',
])

/** Redaction-safe filesystem error: the internal error shape, `.strict()`. */
const wireFilesystemErrorV1Schema = z
  .object({
    code: filesystemErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    requiresFreshRead: z.boolean().optional(),
    recovery: wireRecoveryStrategyV1Schema.optional(),
  })
  .strict()

/**
 * Wire projection of a single mutation action (§6.2): the internal
 * FileMutationActionV1 with `afterContent`, `patch` and `editAnchor` DROPPED —
 * cap.v3 tokens are process-scoped authorities and must never leave the core,
 * and text content travels only in ACP `diff` content.
 */
const wireFileMutationActionV1Schema = z
  .object({
    actionId: z.string().min(1),
    index: z.number().int().nonnegative(),
    action: fileActionKindV1Schema,
    path: z.string().min(1),
    destinationPath: z.string().min(1).optional(),
    outcome: mutationActionOutcomeV1Schema,
    beforeHash: z.string().min(1).nullable(),
    afterHash: z.string().min(1).nullable(),
    error: wireFilesystemErrorV1Schema.optional(),
    rollback: z
      .object({
        attempted: z.boolean(),
        succeeded: z.boolean(),
        error: wireFilesystemErrorV1Schema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'move' && !value.destinationPath) {
      ctx.addIssue({
        code: 'custom',
        message: 'move actions require destinationPath',
      })
    }
    if (value.action !== 'move' && value.destinationPath) {
      ctx.addIssue({
        code: 'custom',
        message: 'only move actions may include destinationPath',
      })
    }
  })

/**
 * Redaction-enforcing wire projection of `FileMutationResultV1` (§6.2).
 * Differences from the internal contract:
 * - every action DROPS `afterContent`, `patch` and `editAnchor`,
 * - `freshCapabilities` is pinned to the empty tuple,
 * - `authorityReceipt` is kept verbatim (it holds only ids, hashes and
 *   statuses, so the internal `commitReceiptV1Schema` is reused as-is),
 * - paths stay project-relative, exactly as in the internal contract.
 *
 * GV-07 is the negative test for this invariant: a leaked cap.v3 token via
 * `freshCapabilities` or `editAnchor` MUST fail to parse.
 */
export const wireFileMutationResultV1Schema = z
  .object({
    kind: z.literal('file_mutation_result'),
    version: z.literal(1),
    operationId: z.string().min(1),
    outcome: fileMutationOutcomeV1Schema,
    actions: wireFileMutationActionV1Schema.array().max(
      FILESYSTEM_RESULT_MAX_ACTIONS,
    ),
    authorityTier: authorityCapabilityTierSchema.nullable(),
    receiptId: z.string().min(1).optional(),
    workspaceRevision: z.number().int().nonnegative().optional(),
    workspaceSnapshotId: z.string().min(1).optional(),
    authorityReceipt: commitReceiptV1Schema.optional(),
    errors: wireFilesystemErrorV1Schema.array(),
    // Redaction invariant (§6.2, GV-07): no fresh capability ever leaves the
    // core. The empty tuple is the only accepted value.
    freshCapabilities: z.tuple([]),
  })
  .strict()

/**
 * Receipt envelope attached to the `tool_call_update` of every file-mutating
 * tool as `_meta["openbuff.dev"].receipt`, and fetchable afterwards via
 * `_openbuff.dev/receipts/get` (§6.2).
 */
export const receiptEnvelopeV1Schema = z
  .object({
    kind: z.literal('openbuff.receipt_envelope'),
    version: z.literal(1),
    sessionId: z.string().min(1),
    toolCallId: z.string().min(1),
    laneId: z.literal('main'),
    mutation: wireFileMutationResultV1Schema,
  })
  .strict()

/**
 * Lane record (§6.3). The shape is frozen in v1 while behavior stays P1-only:
 * a single `main` lane; `lanes/create` and `/land` are refused until P6.
 */
export const laneV1Schema = z
  .object({
    kind: z.literal('openbuff.lane'),
    version: z.literal(1),
    laneId: z.string().min(1),
    status: z.enum(['active', 'landed', 'abandoned']),
    baseRevision: z.number().int().nonnegative(),
    workspaceSnapshotId: z.string().min(1).optional(),
    agentIds: z.array(z.string().min(1)),
  })
  .strict()

/**
 * Gate state notification payload for `_openbuff.dev/gate_state` (§6.4): a
 * projection of `Base2GateState` plus the base2 phase.
 */
export const gateStateV1Schema = z
  .object({
    kind: z.literal('openbuff.gate_state'),
    version: z.literal(1),
    sessionId: z.string().min(1),
    status: z.enum([
      'idle',
      'pending',
      'validating',
      'reviewing',
      'passed',
      'failed',
      'skipped',
    ]),
    pendingFiles: z.array(z.string()),
    passedFiles: z.array(z.string()),
    reviewerVerdict: z.string().min(1).optional(),
    validationSummary: z.string().min(1).optional(),
    fingerprint: z.string().min(1).optional(),
    progress: z.string().min(1).optional(),
    skipReason: z.string().min(1).optional(),
  })
  .strict()

export type CapabilityMapV1 = z.infer<typeof capabilityMapV1Schema>
export type WireFileMutationResultV1 = z.infer<
  typeof wireFileMutationResultV1Schema
>
export type ReceiptEnvelopeV1 = z.infer<typeof receiptEnvelopeV1Schema>
export type LaneV1 = z.infer<typeof laneV1Schema>
export type GateStateV1 = z.infer<typeof gateStateV1Schema>

/** ACP `tool_call.kind` values per §4.6. */
export type AcpToolKindV1 =
  | 'read'
  | 'search'
  | 'edit'
  | 'delete'
  | 'move'
  | 'execute'
  | 'fetch'
  | 'think'
  | 'other'

const READ_TOOLS = new Set([
  'read_files',
  'read_outline',
  'read_subtree',
  'read_image',
  'read_logs',
  'list_directory',
  'git_status',
])

const SEARCH_TOOLS = new Set([
  'code_search',
  'glob',
  'query_index',
  'find_files',
  'find_files_matching_content',
])

const EDIT_TOOLS = new Set([
  'str_replace',
  'write_file',
  'edit_transaction',
  'replace_range',
  'rewrite_symbol',
  'create_plan',
  'update_plan_status',
])

const EXECUTE_TOOLS = new Set([
  'run_terminal_command',
  'run_file_change_hooks',
  'run_targeted_validation',
  'kill_job',
])

const FETCH_TOOLS = new Set(['web_search', 'read_docs', 'browser_logs'])

const THINK_TOOLS = new Set(['think_deeply'])

/**
 * The single §4.6 tool `kind` table, in code and test-pinned.
 *
 * For mutating tools the mutation's action kinds refine the name-based kind:
 * a mutation whose only action is `delete` reports `delete`, one whose only
 * action is `move` reports `move`; mixed or empty action sets fall back to the
 * name-based kind. Everything unrecognized — including `spawn_agents` and
 * MCP/custom tools — maps to `other`.
 */
export function toolKind(
  toolName: string,
  mutation?: { actions: Array<{ action: string }> },
): AcpToolKindV1 {
  if (mutation && mutation.actions.length > 0) {
    const actions = new Set(mutation.actions.map((action) => action.action))
    if (actions.size === 1) {
      if (actions.has('delete')) return 'delete'
      if (actions.has('move')) return 'move'
    }
  }
  if (toolName.startsWith('inspect_')) return 'read'
  if (READ_TOOLS.has(toolName)) return 'read'
  if (SEARCH_TOOLS.has(toolName)) return 'search'
  if (EDIT_TOOLS.has(toolName)) return 'edit'
  if (EXECUTE_TOOLS.has(toolName)) return 'execute'
  if (FETCH_TOOLS.has(toolName)) return 'fetch'
  if (THINK_TOOLS.has(toolName)) return 'think'
  return 'other'
}

/**
 * Redacting projection of an internal `FileMutationResultV1` onto the wire
 * (§6.2): strips `afterContent`, `patch` and `editAnchor` from every action,
 * zeroes `freshCapabilities` to `[]`, and keeps `authorityReceipt` verbatim.
 * Field order matches `wireFileMutationResultV1Schema` so the output
 * round-trips byte-exactly through the golden-vector harness.
 */
export function toWireMutation(
  mutation: FileMutationResultV1,
): WireFileMutationResultV1 {
  return {
    kind: mutation.kind,
    version: mutation.version,
    operationId: mutation.operationId,
    outcome: mutation.outcome,
    actions: mutation.actions.map((action) => ({
      actionId: action.actionId,
      index: action.index,
      action: action.action,
      path: action.path,
      ...(action.destinationPath !== undefined
        ? { destinationPath: action.destinationPath }
        : {}),
      outcome: action.outcome,
      beforeHash: action.beforeHash,
      afterHash: action.afterHash,
      ...(action.error !== undefined ? { error: action.error } : {}),
      ...(action.rollback !== undefined ? { rollback: action.rollback } : {}),
    })),
    authorityTier: mutation.authorityTier,
    ...(mutation.receiptId !== undefined
      ? { receiptId: mutation.receiptId }
      : {}),
    ...(mutation.workspaceRevision !== undefined
      ? { workspaceRevision: mutation.workspaceRevision }
      : {}),
    ...(mutation.workspaceSnapshotId !== undefined
      ? { workspaceSnapshotId: mutation.workspaceSnapshotId }
      : {}),
    ...(mutation.authorityReceipt !== undefined
      ? { authorityReceipt: mutation.authorityReceipt }
      : {}),
    errors: mutation.errors,
    freshCapabilities: [],
  }
}

/**
 * Projects `Base2GateState` plus the base2 phase onto the ext v1 gate state
 * (§6.4). Field mapping: `pendingFiles` ← `pendingGateFiles`, `passedFiles` ←
 * `gatePassedFiles`, `reviewerVerdict` ← `gatePassedReviewerVerdict`,
 * `validationSummary` ← `gatePassedValidationSummary`, `fingerprint` ←
 * `gatePassedFingerprint` (an unkeyed sha256, not an authority), `progress` ←
 * `gateProgressLine`, `skipReason` ← `lastReviewerGateSkipReason`. Optional
 * fields are emitted only when the gate actually recorded a non-empty value.
 *
 * Status mapping: `awaiting_validation` → `pending`, `validating` →
 * `validating`, `reviewing` → `reviewing`, `final_response_allowed` →
 * `passed` when a reviewer verdict is recorded, `skipped` when the gate
 * explicitly recorded a skip reason, otherwise unmapped. Only statuses the
 * gate actually records are claimed — anything unrecognizable maps to
 * `idle` (the internal contract has no explicit failure record today, so
 * `failed` is never emitted by this projection).
 */
export function projectGateState(input: {
  state: Base2GateState
  phase: string
  sessionId: string
}): GateStateV1 {
  const { state, phase, sessionId } = input
  let status: GateStateV1['status']
  switch (phase) {
    case 'awaiting_validation':
      status = 'pending'
      break
    case 'validating':
      status = 'validating'
      break
    case 'reviewing':
      status = 'reviewing'
      break
    case 'final_response_allowed':
      status =
        state.gatePassedReviewerVerdict !== ''
          ? 'passed'
          : state.lastReviewerGateSkipReason !== ''
            ? 'skipped'
            : 'idle'
      break
    default:
      status = 'idle'
  }
  return {
    kind: 'openbuff.gate_state',
    version: 1,
    sessionId,
    status,
    pendingFiles: [...state.pendingGateFiles],
    passedFiles: [...state.gatePassedFiles],
    ...(state.gatePassedReviewerVerdict !== ''
      ? { reviewerVerdict: state.gatePassedReviewerVerdict }
      : {}),
    ...(state.gatePassedValidationSummary !== ''
      ? { validationSummary: state.gatePassedValidationSummary }
      : {}),
    ...(state.gatePassedFingerprint !== ''
      ? { fingerprint: state.gatePassedFingerprint }
      : {}),
    ...(state.gateProgressLine !== undefined && state.gateProgressLine !== ''
      ? { progress: state.gateProgressLine }
      : {}),
    ...(state.lastReviewerGateSkipReason !== ''
      ? { skipReason: state.lastReviewerGateSkipReason }
      : {}),
  }
}
