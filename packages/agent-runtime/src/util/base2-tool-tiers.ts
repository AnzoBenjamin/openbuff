/**
 * Runtime-side mirror of the base2 progressive tool-tier constants in
 * `agents/base2/tool-tiers.ts`. Kept local to `agent-runtime` because this
 * package must not import from `agents/` (wrong dependency direction). The
 * two lists must stay in sync: CORE is always available, and each tier maps
 * to the extra tools it unlocks.
 *
 * Mode-gated tools (e.g. `run_terminal_command` is execute-plan only,
 * `ask_user`/`write_todos` are mode/flag gated) are still governed by the
 * template's own mode resolution — `filterByUnlockedTiers` only adds a tier
 * tool when the template could legitimately expose it, so it cannot widen
 * beyond the template's mode-appropriate ceiling.
 */

import type { ToolName } from '@codebuff/common/tools/constants'

/**
 * Base2 CORE tool names — always available when progressive disclosure is on.
 *
 * Semantically broader than the template's CORE surface: `ask_user` and
 * `write_todos` are listed unconditionally here, but fast/plan-only
 * progressive base2 never exposes them (they are mode-gated in the template's
 * buildArray). `filterByUnlockedTiers` only *keeps* names already present in
 * its input, and `base2` always passes the template's full surface as
 * `templateAllows` to cap tier adds, so this never widens the surfaced set.
 * The unconditional list is a deliberate ceiling: a runtime-side CORE-only
 * path MUST still pass `templateAllows` (or otherwise apply the same mode
 * gates), or it could expose `ask_user`/`write_todos` in a mode that forbids
 * them.
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

/** Tools unlocked by each non-core base2 tier. */
export const BASE2_TIER_TOOL_NAMES: Record<Exclude<ToolTier, 'core'>, readonly ToolName[]> = {
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

/** Cached set of all tier-gated tool names — avoids rebuilding per call. */
const TIER_GATED: ReadonlySet<string> = new Set(
  Object.values(BASE2_TIER_TOOL_NAMES).flat(),
)

/**
 * Compute the effective base2 tool surface for progressive tool disclosure:
 * the template's CORE-only list plus the tools for each unlocked tier.
 *
 * The template's `toolNames` is the static, mode-resolved list (CORE-only
 * when the canary built it). This helper:
 *   - keeps every template name that is CORE, non-tier, or belongs to an
 *     unlocked tier (preserving template order), and
 *   - appends any newly unlocked tier tool not already present (in canonical
 *     tier order), so tiers unlock onto a core-only static template.
 *
 * A tier tool that the template could not expose in this mode (e.g.
 * `edit_transaction` in plan-only mode) is NOT added: it only appears when
 * the template's mode resolution would have included it in the full surface.
 * Callers pass the template's full-surface membership via `templateAllows`
 * when they need that ceiling; by default every tier tool is allowed.
 *
 * Note: an *empty* `unlockedTiers` array here means CORE-only filtering of the
 * input list. Higher-level callers (`getEffectiveAgentToolNames`) must NOT
 * invoke this helper for absent/empty `agentState.unlockedToolTiers` — that
 * persisted-state contract means "leave the template surface unchanged".
 * Callers must also skip this helper when progressive disclosure is explicitly
 * off on the template, even if a non-empty unlock list was persisted from a
 * prior canary-on run (resume/canary-off must not permanently shrink the
 * full-surface template).
 */
export function filterByUnlockedTiers(
  toolNames: string[],
  unlockedTiers: string[],
  templateAllows?: (name: string) => boolean,
): string[] {
  // Narrow/bound unlockedTiers: ignore non-string, "core", unknown, duplicates.
  const uniqueValidTiers: Exclude<ToolTier, 'core'>[] = []
  const seenTier = new Set<string>()
  for (const raw of unlockedTiers) {
    if (typeof raw !== 'string') continue
    if (raw === 'core') continue
    if (seenTier.has(raw)) continue
    if (!Object.hasOwn(BASE2_TIER_TOOL_NAMES, raw)) continue
    seenTier.add(raw)
    uniqueValidTiers.push(raw as Exclude<ToolTier, 'core'>)
  }
  const allowed = new Set<string>(BASE2_CORE_TOOL_NAMES)
  for (const tier of uniqueValidTiers) {
    for (const name of BASE2_TIER_TOOL_NAMES[tier] ?? []) {
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
  // Add newly unlocked tier tools the core-only template did not already
  // list. Caller MUST pass templateAllows when operating on a mode-resolved
  // surface (fast/plan-only) — undefined defaults to allow-all only for
  // non-mode-gated callers/tests; mode-gated callers that omit the ceiling
  // risk widening beyond the template's mode-appropriate surface
  // (e.g. exposing ask_user/write_todos in fast/plan-only via CORE ceiling).
  for (const tier of uniqueValidTiers) {
    for (const name of BASE2_TIER_TOOL_NAMES[tier] ?? []) {
      if (seen.has(name)) continue
      if (templateAllows !== undefined && !templateAllows(name)) continue
      seen.add(name)
      result.push(name)
    }
  }
  return result
}
