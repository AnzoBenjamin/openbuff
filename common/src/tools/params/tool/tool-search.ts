import z from 'zod/v4'

import { jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'tool_search'
const endsAgentStep = true

const inputSchema = z.object({
  query: z.string().optional().describe('Tool or task name to search for.'),
})

const outputValueSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  query: z.string(),
  tiers: z.array(
    z.object({
      tier: z.string(),
      summary: z.string(),
      tools: z.array(z.string()),
    }),
  ),
})

export const toolSearchParams = {
  toolName,
  endsAgentStep,
  description:
    'Search mode-available tool tiers by name or task. Results contain names only; call tool_load to expose matching schemas on the next step.',
  inputSchema,
  outputSchema: jsonToolResultSchema(outputValueSchema),
} satisfies $ToolParams
