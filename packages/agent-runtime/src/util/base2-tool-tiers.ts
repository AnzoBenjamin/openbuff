/**
 * Single owner of the base2 progressive tool-tier constants. Defined here
 * (rather than in `agents/base2/tool-tiers.ts`) because this package must not
 * import from `agents/` (wrong dependency direction); the base2 template
 * consumes these constants, so there is no second list to keep in sync. CORE
 * is always available, and each tier maps to the extra tools it unlocks.
 *
 * Canonical contract for progressive tool disclosure (other modules point here
 * instead of restating it):
 *   - CORE is listed unconditionally and is deliberately broader than any one
 *     mode's surface: `ask_user`/`write_todos` appear here even though
 *     fast/plan-only base2 withholds them. The template's own mode resolution
 *     (`modeAllowsTool` in agents/base2/tool-tiers.ts) is what gates those.
 *   - `filterByUnlockedTiers` only KEEPS names already present in its input and
 *     only APPENDS tier tools its required `templateAllows` ceiling admits, so
 *     it cannot widen beyond the template's mode-appropriate surface. The
 *     permissive branch is never implicit: allow-all requires the explicit
 *     `ALLOW_ALL_TIER_TOOLS` sentinel.
 *   - base2 pins `programmaticConfig.progressiveToolDisclosure: false`, so
 *     `getEffectiveAgentToolNames` returns early and base2 never reaches
 *     `filterByUnlockedTiers`. This runtime ceiling is therefore dormant for
 *     base2 and binds only a caller that does enable tier filtering.
 */

import type { ToolName } from '@codebuff/common/tools/constants'

/**
 * Base2 CORE tool names — always available when progressive disclosure is on.
 */
export const BASE2_CORE_TOOL_NAMES: readonly ToolName[] = [
  'spawn_agents',
  'query_index',
  'read_files',
  'read_outline',
  'read_subtree',
  'list_directory',
  'glob',
  'code_search',
  'ask_user',
  'skill',
  'suggest_followups',
  'write_todos',
  'list_jobs',
  'check_job',
  'check_background_agent',
  'read_logs',
]

export type ToolTier = 'core' | 'implement' | 'audit' | 'media_3d' | 'job_extra'

/**
 * The single name for "a tier that can actually be unlocked". CORE is
 * unconditional, so it is deliberately not expressible here. Consumers —
 * including the base2 template's `unlockedTiers` option — alias this type
 * instead of re-deriving an equivalent one.
 */
export type UnlockedToolTier = Exclude<ToolTier, 'core'>

/** Tools unlocked by each non-core base2 tier. */
export const BASE2_TIER_TOOL_NAMES: Record<
  UnlockedToolTier,
  readonly ToolName[]
> = {
  implement: [
    'edit_transaction',
    'create_plan',
    'update_plan_status',
    'inspect_workspace',
    'inspect_environment',
    'get_affected_tests',
    'get_build_targets',
    'run_targeted_validation',
    'run_terminal_command',
  ],
  audit: [
    'inspect_codebase_structure',
    'inspect_feature_completeness',
    'evaluate_audit_coverage',
    'get_change_review_bundle',
    'get_task',
  ],
  media_3d: [
    'read_image',
    'inspect_3d_asset',
    'render_3d_preview',
    'edit_3d_asset',
  ],
  job_extra: ['kill_job'],
}

/**
 * Explicit opt-out sentinel for the `templateAllows` ceiling: pass this to
 * admit every unlocked tier tool. The permissive branch must be chosen
 * deliberately — a caller that simply has no ceiling to pass (e.g. a
 * progressive template omitting `programmaticConfig.fullToolSurface`) must not
 * fail open into allow-all, or it would unlock every tier tool
 * (`run_terminal_command` included) with no mode ceiling.
 */
export const ALLOW_ALL_TIER_TOOLS = 'allow-all' as const

/**
 * Mode ceiling for the tier-tool append path: a membership predicate over the
 * template's mode-resolved full surface, or the explicit allow-all sentinel.
 */
export type TierToolCeiling =
  | ((name: string) => boolean)
  | typeof ALLOW_ALL_TIER_TOOLS

/** Cached set of all tier-gated tool names — avoids rebuilding per call. */
const TIER_GATED: ReadonlySet<string> = new Set(
  Object.values(BASE2_TIER_TOOL_NAMES).flat(),
)

/**
 * Compute the effective base2 tool surface for progressive tool disclosure:
 * the template's CORE-only list plus the tools for each unlocked tier.
 *
 * The template's `toolNames` is the static, mode-resolved list (CORE-only when
 * the canary built it). This helper:
 *   - keeps every template name that is CORE, non-tier, or belongs to an
 *     unlocked tier (preserving template order), and
 *   - appends any newly unlocked tier tool `templateAllows` admits and the
 *     input list did not already contain (in canonical tier order), so tiers
 *     unlock onto a core-only static template.
 *
 * `unlockedTiers` is `readonly unknown[]` because it carries persisted
 * `AgentState.unlockedToolTiers` state: non-string, `'core'`, unknown, and
 * duplicate entries are ignored.
 *
 * `templateAllows` is the mode ceiling and is REQUIRED so a new caller cannot
 * silently widen past its mode gates. Pass the `ALLOW_ALL_TIER_TOOLS` sentinel
 * to deliberately opt out (allow every tier tool), which is safe just for
 * callers whose input list carries no mode gates to preserve; there is no
 * implicit allow-all for a missing/unknown ceiling.
 *
 * Note: an *empty* `unlockedTiers` array here means CORE-only filtering of the
 * input list. Higher-level callers (`getEffectiveAgentToolNames`) must NOT
 * invoke this helper for absent/empty `agentState.unlockedToolTiers` — that
 * persisted-state contract means "leave the template surface unchanged" — and
 * must also skip it when progressive disclosure is explicitly off on the
 * template, even if a non-empty unlock list was persisted from a prior
 * canary-on run (resume/canary-off must not permanently shrink the
 * full-surface template).
 */
export function filterByUnlockedTiers(
  toolNames: string[],
  unlockedTiers: readonly unknown[],
  templateAllows: TierToolCeiling,
): string[] {
  // Bound the persisted tier list: ignore non-string, "core", unknown, dupes.
  const uniqueValidTiers: UnlockedToolTier[] = []
  const seenTier = new Set<string>()
  for (const raw of unlockedTiers) {
    if (typeof raw !== 'string') continue
    if (raw === 'core') continue
    if (seenTier.has(raw)) continue
    if (!Object.hasOwn(BASE2_TIER_TOOL_NAMES, raw)) continue
    seenTier.add(raw)
    uniqueValidTiers.push(raw as UnlockedToolTier)
  }
  const allowed = new Set<string>(BASE2_CORE_TOOL_NAMES)
  for (const tier of uniqueValidTiers) {
    for (const name of BASE2_TIER_TOOL_NAMES[tier]) {
      allowed.add(name)
    }
  }
  const result: string[] = []
  const seen = new Set<string>()
  const keep = (name: string): boolean => {
    if (seen.has(name)) return false
    // Keep CORE and non-tier template names; drop still-locked tier tools.
    if (!allowed.has(name) && TIER_GATED.has(name)) return false
    seen.add(name)
    return true
  }
  for (const name of toolNames) {
    if (keep(name)) result.push(name)
  }
  // Add newly unlocked tier tools the core-only template did not already list.
  // The templateAllows ceiling is what keeps this from re-adding a tier tool
  // the current mode forbids (e.g. edit_transaction / run_targeted_validation
  // in plan-only mode, or run_terminal_command outside execute-plan); only the
  // explicit ALLOW_ALL_TIER_TOOLS sentinel admits every unlocked tier tool.
  for (const tier of uniqueValidTiers) {
    for (const name of BASE2_TIER_TOOL_NAMES[tier]) {
      if (seen.has(name)) continue
      if (templateAllows !== ALLOW_ALL_TIER_TOOLS && !templateAllows(name)) {
        continue
      }
      seen.add(name)
      result.push(name)
    }
  }
  return result
}
