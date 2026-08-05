/** Rank CORE tool Anthropic-shaped schema costs (M5-T1). */
import { countTokensJson } from '../packages/agent-runtime/src/util/token-counter'
import { toolParams } from '../common/src/tools/list'
import type { ToolName } from '../common/src/tools/constants'
import {
  CORE_TOOLS,
  resolveModelToolNames,
} from '../agents/base2/tool-tiers'
import z from 'zod/v4'

function measureOne(name: string) {
  const def = (toolParams as Record<
    string,
    (typeof toolParams)[ToolName] | undefined
  >)[name]
  if (!def) return { name, tokens: -1, descLen: 0, descPreview: '' }
  let input_schema: unknown
  try {
    const schema = (def.providerInputSchema ?? def.inputSchema) as z.ZodType
    input_schema = z.toJSONSchema(schema, { io: 'input' })
  } catch {
    input_schema = { type: 'object', properties: {} }
  }
  const payload = {
    name,
    ...(def.description ? { description: def.description } : {}),
    ...(input_schema ? { input_schema } : {}),
  }
  return {
    name,
    tokens: countTokensJson(payload),
    descLen: typeof def.description === 'string' ? def.description.length : 0,
    descPreview:
      typeof def.description === 'string'
        ? def.description.slice(0, 160).replace(/\n/g, ' ')
        : '',
  }
}

const core = [...CORE_TOOLS].map(measureOne).sort((a, b) => b.tokens - a.tokens)
const coreTotal = core.reduce((s, x) => s + (x.tokens > 0 ? x.tokens : 0), 0)
const full = resolveModelToolNames({
  mode: 'default',
  progressiveToolDisclosure: false,
})
const fullTotal = full
  .map(measureOne)
  .reduce((s, x) => s + (x.tokens > 0 ? x.tokens : 0), 0)
const progressiveCore = resolveModelToolNames({
  mode: 'default',
  progressiveToolDisclosure: true,
  unlockedTiers: [],
})
const progressiveCoreTotal = progressiveCore
  .map(measureOne)
  .reduce((s, x) => s + (x.tokens > 0 ? x.tokens : 0), 0)

console.log(
  JSON.stringify(
    {
      coreTotal,
      progressiveCoreTotal,
      fullTotal,
      coreCount: core.length,
      fullCount: full.length,
      coreRanked: core,
    },
    null,
    2,
  ),
)
