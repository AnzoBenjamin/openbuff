/**
 * N10: fixed prompt cost of an agent definition, in estimated tokens.
 *
 * Counts the system, instructions and step prompts plus the provider-facing
 * tool definitions (name, description, input schema) the agent sends on
 * every call. Excludes per-run content (file tree, messages, skills), so the
 * number only moves when the agent definition or tool schemas change.
 * Offline: no LLM or network calls.
 */
import { getToolSet } from '@codebuff/agent-runtime/tools/prompts'
import {
  countTokens,
  countTokensJson,
} from '@codebuff/agent-runtime/util/token-counter'

export interface StaticPromptDefinition {
  model?: string
  toolNames?: readonly string[]
  systemPrompt?: string
  instructionsPrompt?: string
  stepPrompt?: string
}

export interface StaticPromptTokens {
  total: number
  promptTokens: number
  toolTokens: number
  toolCount: number
}

export async function computeStaticPromptTokens(
  definition: StaticPromptDefinition,
): Promise<StaticPromptTokens> {
  const prompts = [
    definition.systemPrompt,
    definition.instructionsPrompt,
    definition.stepPrompt,
  ].filter(
    (text): text is string => typeof text === 'string' && text.length > 0,
  )
  const promptTokens = prompts.reduce(
    (sum, text) => sum + countTokens(text, definition.model),
    0,
  )
  const tools = await getToolSet({
    toolNames: [...(definition.toolNames ?? [])],
    additionalToolDefinitions: async () => ({}),
    agentTools: {},
    skills: {},
  })
  const toolShape = Object.entries(tools).map(([name, tool]) => {
    const inputSchema = (tool as { inputSchema?: unknown }).inputSchema
    return {
      name,
      ...(tool.description && { description: tool.description }),
      ...(inputSchema ? { input_schema: inputSchema } : {}),
    }
  })
  const toolTokens =
    toolShape.length > 0 ? countTokensJson(toolShape, definition.model) : 0
  return {
    total: promptTokens + toolTokens,
    promptTokens,
    toolTokens,
    toolCount: toolShape.length,
  }
}
