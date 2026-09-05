import { coerceToObject } from '@codebuff/common/tools/params/utils'
import { agentHandoffSchema } from '@codebuff/common/tools/params/tool/spawn-agents'
import { buildArray } from '@codebuff/common/util/array'
import { schemaToJsonStr } from '@codebuff/common/util/zod-schema'
import { z } from 'zod/v4'

import { getAgentTemplate } from './agent-registry'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { AgentRuntimeDeps } from '@codebuff/common/types/contracts/agent-runtime'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { AgentTemplateType } from '@codebuff/common/types/session-state'
import type { ToolSet } from 'ai'

/**
 * Injected resolver for a child's declared context window, threaded through
 * `AgentRuntimeDeps`. Synchronous and may return `undefined`, so callers must
 * never await it and must stay byte-identical when it is absent.
 */
export type ResolveModelContextWindow = NonNullable<
  AgentRuntimeDeps['resolveModelContextWindow']
>

function ensureJsonSchemaCompatible(schema: z.ZodType): z.ZodType {
  try {
    z.toJSONSchema(schema, { io: 'input' })
    return schema
  } catch {
    const fallback = z.object({}).passthrough()
    return schema.description ? fallback.describe(schema.description) : fallback
  }
}

/**
 * Gets the short agent name from a fully qualified agent ID.
 * E.g., 'codebuff/file-picker@1.0.0' -> 'file-picker'
 */
export function getAgentShortName(agentType: AgentTemplateType): string {
  const withoutVersion = agentType.split('@')[0]
  const parts = withoutVersion.split('/')
  return parts[parts.length - 1]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function promptNamesParamKey(prompt: string, key: string): boolean {
  if (!prompt || !key) return false
  if (prompt.includes('`' + key + '`')) return true
  if (prompt.includes('params.' + key)) return true
  // Identifier form only: object/JSON key (`command:` or `"searchQueries":`),
  // never a bare English word such as "manager" or "directories".
  return new RegExp('\\b' + escapeRegExp(key) + '[\'"]?\\s*:').test(prompt)
}

/**
 * Required keys from a child's `inputSchema.params`.
 * Runtime templates store Zod (`z.toJSONSchema(..., { io: 'input' })`);
 * agent definitions use JSON Schema with a `required` array.
 */
export function getRequiredAgentParamKeys(paramsSchema: unknown): string[] {
  if (!paramsSchema) return []

  let jsonSchema: unknown = paramsSchema
  if (paramsSchema instanceof z.ZodType) {
    try {
      jsonSchema = z.toJSONSchema(paramsSchema, { io: 'input' })
    } catch {
      return []
    }
  }

  if (!jsonSchema || typeof jsonSchema !== 'object') return []
  const required = (jsonSchema as { required?: unknown }).required
  if (!Array.isArray(required)) return []
  return required.filter((key): key is string => typeof key === 'string')
}

const REPAIR_EDITOR_HANDOFF_HINT =
  'Requires a versioned `handoff` with schemaVersion 1, taskId, objective, at least one finding, and explicit permissions.'

function formatRequiredSpawnContractHint(
  agentType: AgentTemplateType,
  agentTemplate: AgentTemplate,
): string {
  const shortName =
    getAgentShortName(agentType) || getAgentShortName(agentTemplate.id)
  const prompt = agentTemplate.spawnerPrompt ?? ''

  if (shortName === 'repair-editor') {
    return promptNamesParamKey(prompt, 'handoff')
      ? ''
      : REPAIR_EDITOR_HANDOFF_HINT
  }

  const missing = getRequiredAgentParamKeys(
    agentTemplate.inputSchema?.params,
  ).filter((key) => !promptNamesParamKey(prompt, key))
  if (missing.length === 0) return ''
  return `Required params: ${missing.map((key) => '`' + key + '`').join(', ')}.`
}

/** Compact token rendering for catalog lines: `200_000` -> `200k`. */
function formatContextWindowTokens(tokens: number): string {
  return tokens >= 1_000
    ? `${Math.round(tokens / 1000)}k`
    : `${Math.round(tokens)}`
}

/**
 * Compact catalog line for the "You can spawn the following agents" addendum.
 * Appends a one-line required-params/handoff hint when the child's contract
 * is not already named in `spawnerPrompt`, then the child's context window as
 * ` [context ~200k]` when the caller resolved one, so the parent can size
 * delegated work. An unknown window appends nothing, keeping the catalog
 * byte-identical for callers that inject no resolver.
 */
export function formatCompactAgentCatalogLine(
  agentType: AgentTemplateType,
  agentTemplate: AgentTemplate | null | undefined,
  contextWindowTokens?: number,
): string {
  const windowSuffix =
    typeof contextWindowTokens === 'number' &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
      ? ` [context ~${formatContextWindowTokens(contextWindowTokens)}]`
      : ''
  if (!agentTemplate) return `- ${agentType}${windowSuffix}`

  const prompt = agentTemplate.spawnerPrompt
  const hint = formatRequiredSpawnContractHint(agentType, agentTemplate)
  if (prompt) {
    return hint
      ? `- ${agentType}: ${prompt} ${hint}${windowSuffix}`
      : `- ${agentType}: ${prompt}${windowSuffix}`
  }
  if (hint) return `- ${agentType}: ${hint}${windowSuffix}`
  return `- ${agentType}${windowSuffix}`
}

/**
 * Converts an agent ID into the provider-facing tool name used for direct
 * subagent calls. Agent IDs remain hyphenated; tool names use underscores.
 */
export function getAgentToolName(agentType: AgentTemplateType): string {
  return getAgentShortName(agentType).replace(/-/g, '_')
}

/** Runtime-internal agents stay declared for programmatic permission checks,
 * but must never be advertised as model-callable capabilities. */
export function getModelVisibleSpawnableAgents(
  spawnableAgents: AgentTemplateType[],
): AgentTemplateType[] {
  return spawnableAgents.filter(
    (agentType) => getAgentShortName(agentType) !== 'context-pruner',
  )
}

export function buildAgentToolInputSchema(
  agentTemplate: AgentTemplate,
): z.ZodType {
  const { inputSchema } = agentTemplate

  // Build schema with prompt and params as top-level fields (consistent with spawn_agents)
  // Preserve the original optionality from the inputSchema
  let schemaFields: Record<string, z.ZodType> = {}

  if (inputSchema?.prompt) {
    schemaFields.prompt = inputSchema.prompt
  }

  if (inputSchema?.params) {
    schemaFields.params = z.preprocess(coerceToObject, inputSchema.params)
  }

  schemaFields.handoff = agentHandoffSchema
    .optional()
    .describe(
      'Optional structured handoff payload. Purely additive — children that do not consume `handoff` continue to receive `prompt` and `params` as before.',
    )
  schemaFields.background = z
    .boolean()
    .optional()
    .describe('Launch the agent as a background job when true.')

  return z
    .object(schemaFields)
    .describe(
      agentTemplate.spawnerPrompt ||
        `Spawn the ${agentTemplate.displayName} agent`,
    )
}

/**
 * Builds AI SDK tool definitions for spawnable agents.
 * These tools allow the model to call agents directly as tool calls.
 */
export async function buildAgentToolSet(
  params: {
    spawnableAgents: AgentTemplateType[]
    spawnableAgentToolMode?: AgentTemplate['spawnableAgentToolMode']
    agentTemplates: Record<string, AgentTemplate>
    logger: Logger
  } & ParamsExcluding<
    typeof getAgentTemplate,
    'agentId' | 'localAgentTemplates'
  >,
): Promise<ToolSet> {
  const {
    spawnableAgents: declaredSpawnableAgents,
    spawnableAgentToolMode = 'direct',
    agentTemplates,
  } = params
  const spawnableAgents = getModelVisibleSpawnableAgents(
    declaredSpawnableAgents,
  )

  if (spawnableAgentToolMode === 'generic') {
    return {}
  }

  const toolSet: ToolSet = {}

  for (const agentType of spawnableAgents) {
    const agentTemplate = await getAgentTemplate({
      ...params,
      agentId: agentType,
      localAgentTemplates: agentTemplates,
    })

    if (!agentTemplate) continue

    const toolName = getAgentToolName(agentType)
    const inputSchema = ensureJsonSchemaCompatible(
      buildAgentToolInputSchema(agentTemplate),
    )

    // Use the same structure as other tools in toolParams
    toolSet[toolName] = {
      description:
        agentTemplate.spawnerPrompt ||
        `Spawn the ${agentTemplate.displayName} agent`,
      inputSchema,
    }
  }

  return toolSet
}

/**
 * Builds the description of a single agent for the system prompt.
 */
function buildSingleAgentDescription(
  agentType: AgentTemplateType,
  agentTemplate: AgentTemplate | null,
  contextWindowTokens?: number,
): string {
  if (!agentTemplate) {
    // Fallback for unknown agents
    return `- ${agentType}: Dynamic agent (description not available)
prompt: {"description": "A coding task to complete", "type": "string"}
params: None`
  }

  const { inputSchema } = agentTemplate
  const inputSchemaStr = inputSchema
    ? [
        `prompt: ${schemaToJsonStr(inputSchema.prompt)}`,
        `params: ${schemaToJsonStr(inputSchema.params)}`,
      ].join('\n')
    : ['prompt: None', 'params: None'].join('\n')

  return buildArray(
    formatCompactAgentCatalogLine(
      agentType,
      agentTemplate,
      contextWindowTokens,
    ),
    agentTemplate.includeMessageHistory &&
      'This agent can see the current message history.',
    agentTemplate.inheritParentSystemPrompt &&
      "This agent inherits the parent's system prompt for prompt caching.",
    inputSchemaStr,
  ).join('\n')
}

/**
 * Builds the full spawnable agents specification for subagent instructions.
 * This is used when inheritSystemPrompt is true to tell subagents which agents they can spawn.
 */
export async function buildFullSpawnableAgentsSpec(
  params: {
    spawnableAgents: AgentTemplateType[]
    agentTemplates: Record<string, AgentTemplate>
    logger: Logger
    /** Optional; when absent the spec is byte-identical to the pre-window output. */
    resolveModelContextWindow?: ResolveModelContextWindow
  } & ParamsExcluding<
    typeof getAgentTemplate,
    'agentId' | 'localAgentTemplates'
  >,
): Promise<string> {
  const { spawnableAgents: declaredSpawnableAgents, agentTemplates } = params
  const spawnableAgents = getModelVisibleSpawnableAgents(
    declaredSpawnableAgents,
  )
  if (spawnableAgents.length === 0) {
    return ''
  }

  const subAgentTypesAndTemplates = await Promise.all(
    spawnableAgents.map(async (agentType) => {
      const agentTemplate = await getAgentTemplate({
        ...params,
        agentId: agentType,
        localAgentTemplates: agentTemplates,
      })
      return [
        agentType,
        agentTemplate,
        params.resolveModelContextWindow?.({
          agentId: agentTemplate?.id ?? agentType,
          model: agentTemplate?.model,
        }),
      ] as const
    }),
  )

  const agentsDescription = subAgentTypesAndTemplates
    .map(([agentType, agentTemplate, contextWindowTokens]) =>
      buildSingleAgentDescription(
        agentType,
        agentTemplate,
        contextWindowTokens,
      ),
    )
    .filter(Boolean)
    .join('\n\n')

  return `You are a subagent that can only spawn the following agents using the spawn_agents tool:

${agentsDescription}`
}
