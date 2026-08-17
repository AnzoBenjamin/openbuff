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
 * The only tools whose availability depends on mode rather than on tier.
 * Mode-gated tools are hardcoded here; see
 * agents/__tests__/base2-progressive-tool-disclosure.test.ts.
 */
function modeAllowsTool(name: AllToolNames, gates: ModeGates): boolean {
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
    default:
      return true
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
