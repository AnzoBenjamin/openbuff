import {
  ALLOW_ALL_TIER_TOOLS,
  filterByUnlockedTiers,
  type TierToolCeiling,
} from './base2-tool-tiers'

import type { AgentTemplate } from '../templates/types'

/**
 * Resolve a template's published `programmaticConfig.fullToolSurface` into the
 * `templateAllows` ceiling `filterByUnlockedTiers` requires. A missing or
 * unrecognized value fails CLOSED; allow-all must be the explicit
 * `ALLOW_ALL_TIER_TOOLS` sentinel (see ./base2-tool-tiers.ts).
 */
function resolveTierCeiling(rawSurface: unknown): TierToolCeiling {
  if (rawSurface === ALLOW_ALL_TIER_TOOLS) return ALLOW_ALL_TIER_TOOLS
  if (!Array.isArray(rawSurface)) return () => false
  // Set (built once) rather than a per-candidate array scan: the append loop in
  // filterByUnlockedTiers membership-tests every unlocked tier tool.
  const fullSurface = new Set<string>(
    rawSurface.filter((name): name is string => typeof name === 'string'),
  )
  return (name) => fullSurface.has(name)
}

/**
 * Return the tools an agent is actually allowed to expose at runtime.
 *
 * Structured-output agents need `set_output` to publish their declared result
 * schema. Some older/dynamic templates declared `outputMode` without listing
 * that reporting tool, which left the model unable to finish and caused the
 * executor to reject an otherwise valid `set_output` call. This derived
 * capability is intentionally narrow: it adds no filesystem, process, network,
 * or delegation authority.
 *
 * Progressive tool disclosure: ./base2-tool-tiers.ts owns that contract (CORE
 * membership, keep-vs-append behaviour, and the fail-closed `templateAllows`
 * ceiling). This caller only decides *whether* to filter at all:
 *   - `programmaticConfig.progressiveToolDisclosure === false` → return the
 *     template's toolNames unchanged, even when a prior canary-on run persisted
 *     unlocks, so resume/canary-off cannot permanently shrink a full-surface
 *     template.
 *   - absent OR empty `agentState.unlockedToolTiers` → toolNames unchanged.
 *     Resume/checkpoint consumers treat `[]` the same as the field being
 *     absent; progressive base2 still works because its static template
 *     surface is already CORE-only before any unlock.
 *   - non-empty `unlockedToolTiers` → delegate to `filterByUnlockedTiers` with
 *     the ceiling resolved from `programmaticConfig.fullToolSurface`.
 *
 * Callers that gate model tool *execution* without agentState (notably the
 * tool executor) must pass a template whose `toolNames` already reflect this
 * effective surface for the current step — see run-agent-step.
 */
export function getEffectiveAgentToolNames(
  agentTemplate: AgentTemplate,
  agentState?: { unlockedToolTiers?: string[] },
): string[] {
  const names = [...agentTemplate.toolNames]
  const programmaticToolNames = agentTemplate.programmaticToolNames ?? []
  if (
    agentTemplate.outputMode === 'structured_output' &&
    !names.includes('set_output') &&
    !programmaticToolNames.includes('set_output')
  ) {
    names.push('set_output')
  }
  const programmaticConfig = agentTemplate.programmaticConfig as
    | { progressiveToolDisclosure?: unknown; fullToolSurface?: unknown }
    | undefined
  if (programmaticConfig?.progressiveToolDisclosure === false) {
    return names
  }
  const unlockedTiers = agentState?.unlockedToolTiers
  if (!Array.isArray(unlockedTiers) || unlockedTiers.length === 0) {
    return names
  }
  return filterByUnlockedTiers(
    names,
    unlockedTiers,
    resolveTierCeiling(programmaticConfig?.fullToolSurface),
  )
}
