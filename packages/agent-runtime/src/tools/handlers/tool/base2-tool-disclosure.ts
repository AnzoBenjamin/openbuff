import {
  BASE2_TIER_TOOL_NAMES,
  type UnlockedToolTier,
} from '../../../util/base2-tool-tiers'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'

export interface AvailableToolTier {
  tier: UnlockedToolTier
  summary: string
  tools: string[]
}

const TIER_SUMMARIES: Record<UnlockedToolTier, string> = {
  implement:
    'Work on implementation tasks using the tools allowed in this mode.',
  audit: 'Inspect codebase structure, completeness, and review state.',
  media_3d: 'Inspect 3D assets or perform authorized edits.',
  job_extra: 'Manage background jobs available in this mode.',
}

export function getAvailableToolTiers(
  agentTemplate: AgentTemplate,
): AvailableToolTier[] | null {
  const config = agentTemplate.programmaticConfig as
    | {
        progressiveToolDisclosure?: unknown
        fullToolSurface?: unknown
      }
    | undefined
  if (
    config?.progressiveToolDisclosure !== true ||
    !Array.isArray(config.fullToolSurface)
  ) {
    return null
  }

  const fullSurface = new Set(
    config.fullToolSurface.filter(
      (name): name is string => typeof name === 'string',
    ),
  )
  return (Object.keys(BASE2_TIER_TOOL_NAMES) as UnlockedToolTier[])
    .map((tier) => ({
      tier,
      summary: TIER_SUMMARIES[tier],
      tools: BASE2_TIER_TOOL_NAMES[tier].filter((name) =>
        fullSurface.has(name),
      ),
    }))
    .filter((entry) => entry.tools.length > 0)
}
