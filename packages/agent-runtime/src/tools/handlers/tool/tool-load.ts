import { jsonToolResult } from '@codebuff/common/util/messages'

import {
  BASE2_TIER_TOOL_NAMES,
  type UnlockedToolTier,
} from '../../../util/base2-tool-tiers'
import { getAvailableToolTiers } from './base2-tool-disclosure'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'

export const handleToolLoad: CodebuffToolHandlerFunction<'tool_load'> = async ({
  agentState,
  agentTemplate,
  toolCall,
}) => {
  const tier = toolCall.input.tier
  const availableTiers = getAvailableToolTiers(agentTemplate)
  const availableTierNames = new Set(
    availableTiers?.map((entry) => entry.tier) ?? [],
  )
  const currentTiers = new Set(
    (agentState.unlockedToolTiers ?? []).filter(
      (candidate): candidate is UnlockedToolTier =>
        Object.hasOwn(BASE2_TIER_TOOL_NAMES, candidate) &&
        availableTierNames.has(candidate as UnlockedToolTier),
    ),
  )
  const unlockedToolTiers = (
    Object.keys(BASE2_TIER_TOOL_NAMES) as UnlockedToolTier[]
  ).filter((candidate) => currentTiers.has(candidate))
  const availableTier = availableTiers?.find((entry) => entry.tier === tier)

  if (!availableTier) {
    return {
      output: jsonToolResult({
        status: 'unavailable',
        tier,
        unlockedToolTiers,
        loadedTools: [],
        available: false,
      }),
    }
  }

  currentTiers.add(tier)
  const nextUnlockedTiers = (
    Object.keys(BASE2_TIER_TOOL_NAMES) as UnlockedToolTier[]
  ).filter((candidate) => currentTiers.has(candidate))
  agentState.unlockedToolTiers = nextUnlockedTiers

  return {
    output: jsonToolResult({
      status: 'ok',
      tier,
      unlockedToolTiers: nextUnlockedTiers,
      loadedTools: availableTier.tools,
      available: true,
    }),
  }
}
