import {
  BASE2_CORE_TOOL_NAMES,
  BASE2_TIER_TOOL_NAMES,
  type UnlockedToolTier,
} from '@codebuff/agent-runtime/util/base2-tool-tiers'

import type { AllToolNames } from '../types/secret-agent-definition'

/**
 * Tier membership and the progressive tool-disclosure contract are owned by
 * packages/agent-runtime/src/util/base2-tool-tiers.ts; this module only
 * resolves the template's mode-gated surface from them.
 */

/** Alias of the runtime tier type so one contract keeps one name. */
export type { UnlockedToolTier }

/**
 * Canonical non-core tier order, and the default `unlockedTiers`. Pinned by
 * agents/__tests__/base2-progressive-tool-disclosure.test.ts.
 */
const NON_CORE_TIERS = Object.keys(BASE2_TIER_TOOL_NAMES) as UnlockedToolTier[]

type ModeGates = {
  isFast: boolean
  planOnly: boolean
  executePlan: boolean
  noAskUser: boolean
}

/**
 * Tools whose availability never depends on mode. This is an EXPLICIT
 * allow-list, not a fallback: `modeAllowsTool` denies anything that is neither
 * listed here nor handled by a mode-gated case, so a ToolName added to common
 * without extending this policy is denied (fail closed) until a reviewer
 * deliberately widens one of the two lists. The coverage test in
 * agents/__tests__/base2-progressive-tool-disclosure.test.ts asserts
 * MODE_NEUTRAL_TOOL_NAMES ∪ MODE_GATED_TOOL_NAMES == toolNames.
 */
export const MODE_NEUTRAL_TOOL_NAMES = [
  'add_subgoal',
  'add_message',
  'browser_logs',
  'check_background_agent',
  'check_job',
  'code_search',
  'create_plan',
  'end_turn',
  'find_files',
  'find_files_matching_content',
  'git_status',
  'git_branch',
  'get_task',
  'get_change_review_bundle',
  'inspect_workspace',
  'inspect_environment',
  'inspect_3d_asset',
  'get_affected_tests',
  'get_build_targets',
  'inspect_codebase_structure',
  'inspect_feature_completeness',
  'evaluate_audit_coverage',
  'glob',
  'kill_job',
  'list_directory',
  'list_jobs',
  'lookup_agent_info',
  'query_index',
  'recall_context',
  'record_decision',
  'read_docs',
  'read_files',
  'read_image',
  'render_3d_preview',
  'read_logs',
  'read_outline',
  'read_subtree',
  'replace_range',
  'rewrite_symbol',
  'render_ui',
  'run_file_change_hooks',
  'set_messages',
  'set_output',
  'skill',
  'spawn_agents',
  'spawn_agent_inline',
  'str_replace',
  'suggest_followups',
  'task_completed',
  'think_deeply',
  'update_plan_status',
  'update_subgoal',
  'web_search',
  'write_file',
  'write_audit_findings',
] as const satisfies readonly AllToolNames[]

/**
 * The only tools whose availability depends on mode rather than on tier.
 * Mode-gated tools are hardcoded here; see
 * agents/__tests__/base2-progressive-tool-disclosure.test.ts.
 */
export const MODE_GATED_TOOL_NAMES = [
  'ask_user',
  'write_todos',
  'edit_transaction',
  'edit_3d_asset',
  'run_targeted_validation',
  'run_terminal_command',
] as const satisfies readonly AllToolNames[]

const MODE_NEUTRAL_ALLOWED: ReadonlySet<AllToolNames> = new Set(
  MODE_NEUTRAL_TOOL_NAMES,
)

/** Exported for the exhaustiveness/fail-closed coverage test. */
export function modeAllowsTool(name: AllToolNames, gates: ModeGates): boolean {
  switch (name) {
    case 'ask_user':
      return !gates.noAskUser
    case 'write_todos':
      return !gates.isFast && !gates.planOnly
    case 'edit_transaction':
    case 'edit_3d_asset':
    case 'run_targeted_validation':
      return !gates.planOnly
    case 'run_terminal_command':
      return !gates.planOnly && gates.executePlan
    // M1-T6 fail-closed default: only names with an explicit MODE_NEUTRAL
    // policy pass. An unlisted tool (e.g. a future ToolName added to common
    // without updating this policy) is denied in every mode.
    default:
      return MODE_NEUTRAL_ALLOWED.has(name)
  }
}

type ResolveModelToolNamesParams = {
  mode: 'default' | 'fast'
  planOnly?: boolean
  executePlan?: boolean
  noAskUser?: boolean
  /**
   * Tiers beyond CORE to expose. Defaults to every non-core tier; pass `[]`
   * for a CORE-only surface. This is a set, not an ordering: the emitted list
   * follows the canonical tier order.
   *
   * Reached through createBase2's identically named public option; see
   * docs/configuration.md.
   */
  unlockedTiers?: UnlockedToolTier[]
}

/**
 * Resolve the model-visible toolNames list for createBase2: CORE first, then
 * one block per unlocked tier, minus the mode-gated tools.
 *
 * The mode gates here are base2's ONLY live surface gate; the runtime tier
 * ceiling is dormant because progressiveToolDisclosure is pinned false. See
 * packages/agent-runtime/src/util/base2-tool-tiers.ts.
 */
export function resolveModelToolNames(
  params: ResolveModelToolNamesParams,
): AllToolNames[] {
  const {
    mode,
    planOnly = false,
    executePlan = false,
    noAskUser = false,
    unlockedTiers = NON_CORE_TIERS,
  } = params

  const gates: ModeGates = {
    isFast: mode === 'fast',
    planOnly,
    executePlan,
    noAskUser,
  }
  const unlocked = new Set<UnlockedToolTier>(unlockedTiers)
  // Deduped so a name listed in both CORE and a tier surfaces exactly once.
  return [
    ...new Set<AllToolNames>([
      ...BASE2_CORE_TOOL_NAMES,
      // Single pass over the canonical tier order: no intermediate filtered
      // array, and locked tiers contribute nothing.
      ...NON_CORE_TIERS.flatMap((tier) =>
        unlocked.has(tier) ? BASE2_TIER_TOOL_NAMES[tier] : [],
      ),
    ]),
  ].filter((name) => modeAllowsTool(name, gates))
}
