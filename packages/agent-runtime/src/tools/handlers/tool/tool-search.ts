import { jsonToolResult } from '@codebuff/common/util/messages'

import { getAvailableToolTiers } from './base2-tool-disclosure'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'

export const handleToolSearch: CodebuffToolHandlerFunction<
  'tool_search'
> = async ({ agentTemplate, toolCall }) => {
  const query = toolCall.input.query?.trim() ?? ''
  const availableTiers = getAvailableToolTiers(agentTemplate)
  if (!availableTiers) {
    return {
      output: jsonToolResult({ status: 'unavailable', query, tiers: [] }),
    }
  }

  const normalizedQuery = query.toLowerCase()
  const tiers = availableTiers
    .map((entry) => ({
      ...entry,
      tools: entry.tools.filter(
        (name) =>
          !normalizedQuery ||
          name.toLowerCase().includes(normalizedQuery) ||
          entry.tier.includes(normalizedQuery) ||
          entry.summary.toLowerCase().includes(normalizedQuery),
      ),
    }))
    .filter((entry) => entry.tools.length > 0)

  return {
    output: jsonToolResult({ status: 'ok', query, tiers }),
  }
}
