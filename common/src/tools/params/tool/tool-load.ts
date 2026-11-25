import z from 'zod/v4'

import { jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'tool_load'
const endsAgentStep = true

const inputSchema = z.object({
  tier: z.enum(['implement', 'audit', 'media_3d', 'job_extra']),
})

const outputValueSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  tier: z.string(),
  unlockedToolTiers: z.array(z.string()),
  loadedTools: z.array(z.string()),
  available: z.boolean(),
})

export const toolLoadParams = {
  toolName,
  endsAgentStep,
  description:
    'Load one mode-available tool tier. Its schemas become available on the next model step; restricted tools remain unavailable.',
  inputSchema,
  outputSchema: jsonToolResultSchema(outputValueSchema),
} satisfies $ToolParams
