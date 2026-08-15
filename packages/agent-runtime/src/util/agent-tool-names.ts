import { filterByUnlockedTiers } from './base2-tool-tiers'

import type { AgentTemplate } from '../templates/types'

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
 * Progressive tool disclosure contract for `agentState.unlockedToolTiers`:
 *   - progressive canary off (`programmaticConfig.progressiveToolDisclosure
 *     === false`) → always return the template's toolNames unchanged. Stale
 *     non-empty unlocks from a prior canary-on run MUST NOT re-activate
 *     CORE+tiers filtering on resume/canary-off (would permanently shrink a
 *     full-surface template).
 *   - progressive on / unspecified + absent or empty array → return the
 *     template's toolNames unchanged (full mode-resolved surface for
 *     default-off / non-progressive agents; CORE-only static template for
 *     progressive base2 before any unlock).
 *   - progressive on / unspecified + non-empty array → narrow/expand to CORE
 *     plus those unlocked tiers, still capped by
 *     programmaticConfig.fullToolSurface when present.
 *
 * Empty must NOT trigger CORE filtering: resume/checkpoint consumers treat
 * `unlockedToolTiers: []` the same as the field being absent (full template
 * surface for non-progressive agents). Progressive core-only steps still work
 * because base2's static template.toolNames is already CORE-only when the
 * canary is on; publishing `[]` leaves that CORE list alone.
 *
 * Callers that gate model tool *execution* without agentState (notably the
 * tool executor) must pass a template whose `toolNames` already reflect this
 * effective surface for the current step — see run-agent-step.
 */
export function getEffectiveAgentToolNames(
  agentTemplate: AgentTemplate,
  agentState?: { unlockedToolTiers?: string[] },
): string[] {
  let names = [...agentTemplate.toolNames]
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
  // Explicit canary-off wins over any persisted unlock list. Resume after a
  // canary-on session (or flipping the canary off mid-session) must keep the
  // full mode-resolved template surface, not CORE + stale tiers.
  if (programmaticConfig?.progressiveToolDisclosure === false) {
    return names
  }
  const unlockedTiers = agentState?.unlockedToolTiers
  // Absent OR empty → template surface unchanged (resume/checkpoint contract).
  // Only a non-empty published tier list activates progressive CORE+tiers
  // filtering/expansion, and only when progressive disclosure is not off.
  if (Array.isArray(unlockedTiers) && unlockedTiers.length > 0) {
    // Additive ceiling: the template's mode-resolved full surface, when the
    // agent published one (base2 via programmaticConfig.fullToolSurface).
    // Unlocked tier tools are only re-added when the full surface includes
    // them, so plan-only / no-ask-user / fast mode gates are never widened.
    const rawSurface = programmaticConfig?.fullToolSurface
    const fullSurface = Array.isArray(rawSurface)
      ? rawSurface.filter((name): name is string => typeof name === 'string')
      : undefined
    const templateAllows = fullSurface
      ? (name: string) => fullSurface.includes(name)
      : undefined
    names = filterByUnlockedTiers(names, unlockedTiers, templateAllows)
  }
  return names
}
