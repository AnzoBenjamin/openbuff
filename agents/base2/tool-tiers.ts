import { buildArray } from '@codebuff/common/util/array'

import {
  BASE2_CORE_TOOL_NAMES,
  BASE2_TIER_TOOL_NAMES,
} from '@codebuff/agent-runtime/util/base2-tool-tiers'

import type { AllToolNames } from '../types/secret-agent-definition'

/** Progressive model-visible tool tiers for base2 (M1). */
export type ToolTier = 'core' | 'implement' | 'audit' | 'media_3d' | 'job_extra'

/**
 * Tier tool membership is owned by the runtime mirror in
 * `packages/agent-runtime/src/util/base2-tool-tiers.ts`
 * (`BASE2_CORE_TOOL_NAMES` / `BASE2_TIER_TOOL_NAMES`), because `agent-runtime`
 * must not import from `agents/` (wrong dependency direction). `agents` is the
 * correct direction, so these constants re-export the runtime truth instead of
 * duplicating it. Re-exporting (rather than copying) makes the two lists
 * identical BY CONSTRUCTION, so a one-sided edit to either list now fails at
 * compile time (missing/mismatched re-export) instead of only failing the
 * progressive-disclosure test suite at runtime.
 */

/** Base CORE names without mode conditionals — gates live in resolveModelToolNames. */
export const CORE_TOOLS: readonly string[] = BASE2_CORE_TOOL_NAMES

/** Base IMPLEMENT names without mode conditionals. */
export const IMPLEMENT_TOOLS: readonly string[] =
  BASE2_TIER_TOOL_NAMES.implement

/** Base AUDIT names without mode conditionals. */
export const AUDIT_TOOLS: readonly string[] = BASE2_TIER_TOOL_NAMES.audit

/** Base MEDIA_3D names without mode conditionals. */
export const MEDIA_3D_TOOLS: readonly string[] =
  BASE2_TIER_TOOL_NAMES.media_3d

/** Base JOB_EXTRA names without mode conditionals. */
export const JOB_EXTRA_TOOLS: readonly string[] =
  BASE2_TIER_TOOL_NAMES.job_extra

/** Canary-on starts core-only until handleSteps unlocks further tiers. */
export const DEFAULT_UNLOCKED_TIERS_WHEN_PROGRESSIVE: readonly ToolTier[] = []

/** Intent signals resolved from the current step context. */
export type ToolTierIntentSignals = {
  implementIntent: boolean
  auditIntent: boolean
  mediaIntent: boolean
  jobIntent: boolean
}

/**
 * Deterministically map base2 intent signals to the tool tiers they unlock.
 * CORE is always available and is therefore never returned here. Pure and
 * side-effect free. Tier decisions depend only on the four intent booleans
 * (phase is folded into the signals by `deriveIntentSignals`), so `phase`
 * is deliberately not a parameter here.
 */
export function resolveUnlockedTiersForPhase(params: {
  /** True when the current step involves editing/planning/validation. */
  implementIntent: boolean
  /** True when broad audit/coverage intent is detected. */
  auditIntent: boolean
  /** True when media/3d paths are present. */
  mediaIntent: boolean
  /** True when background job management is needed. */
  jobIntent: boolean
}): ToolTier[] {
  const tiers: ToolTier[] = []
  if (params.implementIntent) tiers.push('implement')
  if (params.auditIntent) tiers.push('audit')
  if (params.mediaIntent) tiers.push('media_3d')
  if (params.jobIntent) tiers.push('job_extra')
  return tiers
}

const IMPLEMENT_PHASES = new Set([
  'awaiting_validation',
  'repair_loop',
  'awaiting_review',
  'blocked',
])
const IMPLEMENT_KEYWORD_RE =
  /\b(?:implement|fix|refactor|update|create|add)\b/i
const AUDIT_KEYWORD_RE =
  /\b(?:audit|coverage|completeness|review[- ]across|systematic)\b/i
const MEDIA_PATH_RE =
  /\.(?:png|jpe?g|webp|gif|blend|obj|gltf|glb)\b/i
// Keep job_extra rare: require job-management phrasing, not bare
// kill/server/logs/watch/tail tokens that appear in ordinary prompts.
const JOB_KEYWORD_RE =
  /\b(?:(?:background|bg)\s+(?:job|agent|process|task|basher)|kill(?:_|\s+)(?:the\s+)?(?:job|process)|(?:list|check|kill)_jobs?|job(?:Id|\s*id)|tail\s+-f|watch\s+(?:the\s+)?(?:build|logs?|job|process)|long[- ]running\s+(?:dev\s+)?server|dev\s+server)\b/i

/**
 * Derive the intent signals that drive tool-tier unlocks from the current
 * active-work phase, gate state, and the last user prompt. Pure and
 * side-effect free; no imports from base2 so it can be inlined into the
 * serialized handleSteps generator.
 */
export function deriveIntentSignals(params: {
  /** Base2ActiveWorkPhase value as a plain string. */
  phase: string
  /** Number of files currently pending the validation/reviewer gate. */
  pendingGateFileCount: number
  /** True when any reviewer blockers are open. */
  hasOpenReviewerBlockers: boolean
  /** The current user prompt, when available. */
  lastUserPrompt?: string
}): ToolTierIntentSignals {
  const prompt = params.lastUserPrompt ?? ''
  const implementIntent =
    IMPLEMENT_PHASES.has(params.phase) ||
    params.pendingGateFileCount > 0 ||
    params.hasOpenReviewerBlockers ||
    IMPLEMENT_KEYWORD_RE.test(prompt)
  const auditIntent =
    AUDIT_KEYWORD_RE.test(prompt) || params.phase === 'awaiting_review'
  const mediaIntent = MEDIA_PATH_RE.test(prompt)
  const jobIntent = JOB_KEYWORD_RE.test(prompt)
  return { implementIntent, auditIntent, mediaIntent, jobIntent }
}

/** Env canary truthy set (mirrors progressive prompt disclosure). */
export function isProgressiveToolDisclosureEnvEnabled(
  raw: string | undefined,
): boolean {
  if (typeof raw !== 'string') return false
  const normalized = raw.trim().toLowerCase()
  return (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  )
}

type ResolveModelToolNamesParams = {
  mode: 'default' | 'fast'
  planOnly?: boolean
  executePlan?: boolean
  noAskUser?: boolean
  progressiveToolDisclosure: boolean
  /** When progressive on, tiers beyond core that are unlocked. Default []. */
  unlockedTiers?: ToolTier[]
}

function hasUnlockedTier(
  unlocked: ReadonlySet<ToolTier>,
  tier: Exclude<ToolTier, 'core'>,
): boolean {
  return unlocked.has(tier)
}

/**
 * Resolve the model-visible toolNames list for createBase2.
 *
 * - progressive off: full production surface (order matches today's createBase2).
 * - progressive on: CORE plus any unlockedTiers, still applying mode gates.
 *
 * Note: empty `unlockedTiers` here is the static template's core-only start
 * surface when progressive is on. That is distinct from the *persisted*
 * AgentState.unlockedToolTiers contract, where absent/empty means "leave the
 * template surface unchanged" (no progressive re-filter at runtime), and where
 * non-empty unlocks are ignored entirely when progressive disclosure is off so
 * resume/canary-off cannot permanently shrink a full-surface template.
 */
export function resolveModelToolNames(
  params: ResolveModelToolNamesParams,
): AllToolNames[] {
  const {
    mode,
    planOnly = false,
    executePlan = false,
    noAskUser = false,
    progressiveToolDisclosure,
    unlockedTiers = DEFAULT_UNLOCKED_TIERS_WHEN_PROGRESSIVE,
  } = params

  const isFast = mode === 'fast'
  const canDirectEdit = !planOnly
  const canRunTerminal = !planOnly && executePlan
  const canWriteTodos = !isFast && !planOnly

  // Full surface must stay byte-stable with pre-M1 createBase2 ordering so
  // existing base2 tests keep passing when the canary is off.
  if (!progressiveToolDisclosure) {
    return buildArray(
      'spawn_agents',
      'query_index',
      'read_files',
      'read_image',
      'inspect_3d_asset',
      'render_3d_preview',
      'read_subtree',
      'read_outline',
      'inspect_codebase_structure',
      canWriteTodos && 'write_todos',
      'create_plan',
      'update_plan_status',
      canDirectEdit && 'edit_transaction',
      canDirectEdit && 'edit_3d_asset',
      canRunTerminal && 'run_terminal_command',
      'suggest_followups',
      !noAskUser && 'ask_user',
      'skill',
      'list_directory',
      'glob',
      'code_search',
      'check_background_agent',
      'check_job',
      'kill_job',
      'read_logs',
      'list_jobs',
      'inspect_workspace',
      'get_task',
      'get_change_review_bundle',
      'inspect_environment',
      'get_affected_tests',
      'get_build_targets',
      !planOnly && 'run_targeted_validation',
      'inspect_feature_completeness',
      'evaluate_audit_coverage',
    )
  }

  const unlocked = new Set<ToolTier>(unlockedTiers)
  const includeImplement = hasUnlockedTier(unlocked, 'implement')
  const includeAudit = hasUnlockedTier(unlocked, 'audit')
  const includeMedia3d = hasUnlockedTier(unlocked, 'media_3d')
  const includeJobExtra = hasUnlockedTier(unlocked, 'job_extra')

  return buildArray(
    // CORE
    'spawn_agents',
    'query_index',
    'read_files',
    'read_outline',
    'read_subtree',
    'list_directory',
    'glob',
    'code_search',
    !noAskUser && 'ask_user',
    'skill',
    'suggest_followups',
    canWriteTodos && 'write_todos',
    'list_jobs',
    'check_job',
    'check_background_agent',
    'read_logs',
    // IMPLEMENT
    includeImplement && canDirectEdit && 'edit_transaction',
    includeImplement && 'create_plan',
    includeImplement && 'update_plan_status',
    includeImplement && 'inspect_workspace',
    includeImplement && 'inspect_environment',
    includeImplement && 'get_affected_tests',
    includeImplement && 'get_build_targets',
    includeImplement && !planOnly && 'run_targeted_validation',
    includeImplement && canRunTerminal && 'run_terminal_command',
    // AUDIT
    includeAudit && 'inspect_codebase_structure',
    includeAudit && 'inspect_feature_completeness',
    includeAudit && 'evaluate_audit_coverage',
    includeAudit && 'get_change_review_bundle',
    includeAudit && 'get_task',
    // MEDIA_3D
    includeMedia3d && 'read_image',
    includeMedia3d && 'inspect_3d_asset',
    includeMedia3d && 'render_3d_preview',
    includeMedia3d && canDirectEdit && 'edit_3d_asset',
    // JOB_EXTRA
    includeJobExtra && 'kill_job',
  )
}
