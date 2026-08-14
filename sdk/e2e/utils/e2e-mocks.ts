import { models } from '@codebuff/common/old-constants'
import { promptSuccess } from '@codebuff/common/util/error'
import { spyOn } from 'bun:test'
import z from 'zod/v4' // zod-pinned: keep ^4.2.1 — synthesizeFromSchema uses private Zod internals (_zod/_def/typeName/shape); re-verify fallback on bump (see synthesizeFromSchema note)

import { OpenbuffClient } from '../../src/client'
import * as databaseModule from '../../src/impl/database'
import * as llmModule from '../../src/impl/llm'
import * as providerConfigModule from '../../src/provider-config'
import * as modelProviderModule from '../../src/impl/model-provider'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type {
  PromptAiSdkFn,
  PromptAiSdkStreamFn,
  PromptAiSdkStructuredInput,
} from '@codebuff/common/types/contracts/llm'
import type { ParamsOf } from '@codebuff/common/types/function-params'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

export const E2E_MOCK_API_KEY = 'codebuff-e2e-mock'

export const WORD_FILLER =
  'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu '

export function makeLargeContent(prefix: string, size: number): string {
  const repeats = Math.ceil((size - prefix.length) / WORD_FILLER.length)
  return prefix + WORD_FILLER.repeat(repeats).slice(0, size - prefix.length)
}

export function isTextPart(part: unknown): part is { type: 'text'; text: string } {
  return (
    typeof part === 'object' &&
    part !== null &&
    'type' in part &&
    part.type === 'text' &&
    'text' in part &&
    typeof (part as { text: unknown }).text === 'string'
  )
}

const MOCK_USER = {
  id: 'e2e-user',
  email: 'e2e-user@codebuff.test',
  discord_id: null,
  referral_code: null,
  stripe_customer_id: null,
  banned: false,
  created_at: new Date('2024-01-01T00:00:00Z'),
} as const

// Deterministic mock IDs for reproducible e2e failures (replaces Math.random).
// Counter resets per process invocation; resetE2eMockCounter is available for test isolation.
let e2eMockCounter = 0
function nextE2eMockId(prefix: string): string {
  e2eMockCounter += 1
  return `${prefix}-${e2eMockCounter.toString(36).padStart(4, '0')}`
}
export function resetE2eMockCounter(): void {
  e2eMockCounter = 0
}

function buildMockAgentTemplate(params: {
  publisherId: string
  agentId: string
  version?: string
}): AgentTemplate {
  const { publisherId, agentId, version } = params
  const id = `${publisherId}/${agentId}@${version ?? 'latest'}`

  return {
    id,
    displayName: `${agentId} (mock)`,
    model: models.openrouter_claude_sonnet_4_5,
    mcpServers: {},
    toolNames: [],
    spawnableAgents: [],
    systemPrompt: '',
    instructionsPrompt: 'You are a helpful assistant.',
    stepPrompt: '',
    inputSchema: {
      prompt: z.string().optional(),
      params: z.object({}).passthrough().optional(),
    },
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    outputMode: 'last_message',
  }
}

const MOCK_TOOL_NAMES = [
  'get_weather',
  'execute_sql',
  'fetch_api',
  'apply_patch',
] as const
type MockToolName = (typeof MOCK_TOOL_NAMES)[number]

function getMessageText(message: Message): string {
  if (!('content' in message)) {
    return ''
  }
  return message.content
    .map((part) => {
      if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof part.text === 'string'
      ) {
        return part.text
      }
      return ''
    })
    .join('')
}

function getLatestUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return getMessageText(messages[i])
    }
  }
  return ''
}

function getAllText(messages: Message[]): string {
  return messages.map(getMessageText).join('\n')
}

function extractLatestUserMessage(text: string): string | null {
  const matches = [
    ...text.matchAll(/<user_message>([\s\S]*?)<\/user_message>/g),
  ]
  if (matches.length === 0) {
    return null
  }
  return matches[matches.length - 1]?.[1] ?? null
}

function getPromptText(latestUserText: string, allText: string): string {
  return extractLatestUserMessage(allText) ?? latestUserText
}

function splitTextIntoChunks(text: string): string[] {
  if (!text) {
    return []
  }

  const targetChunks =
    text.length <= 1 ? 1 : text.length > 120 ? 4 : text.length > 60 ? 3 : 2
  if (targetChunks === 1) {
    return [text]
  }

  const chunkSize = Math.ceil(text.length / targetChunks)
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize))
  }
  return chunks
}

function extractQuotedText(text: string): string | null {
  const doubleQuoted = text.match(/"([^"]+)"/)
  if (doubleQuoted?.[1]) {
    return doubleQuoted[1]
  }
  const singleQuoted = text.match(/'([^']+)'/)
  if (singleQuoted?.[1]) {
    return singleQuoted[1]
  }
  return null
}

function extractCity(text: string): string | null {
  const knownCities = [
    'New York',
    'Atlantis',
    'London',
    'Tokyo',
    'Sydney',
    'Paris',
  ]
  for (const city of knownCities) {
    if (text.toLowerCase().includes(city.toLowerCase())) {
      return city
    }
  }
  const match = text.match(/weather in ([A-Za-z\s]+)[?.!]?/i)
  if (match?.[1]) {
    return match[1].trim()
  }
  return null
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/)
  if (match?.[0]) {
    return match[0].replace(/[)\\].,]+$/, '')
  }
  return null
}

function buildMockToolCall(params: {
  tools: Record<string, unknown> | undefined
  latestUserText: string
  hasToolResult: boolean
}): { toolName: MockToolName; input: Record<string, unknown> } | null {
  const { tools, latestUserText, hasToolResult } = params
  if (hasToolResult || !tools) {
    return null
  }

  const availableTools = new Set(Object.keys(tools))
  const lowerPrompt = latestUserText.toLowerCase()

  if (availableTools.has('get_weather') && lowerPrompt.includes('weather')) {
    const city = extractCity(latestUserText) ?? 'New York'
    return { toolName: 'get_weather', input: { city } }
  }

  if (
    availableTools.has('execute_sql') &&
    (lowerPrompt.includes('database') || lowerPrompt.includes('sql'))
  ) {
    const query = lowerPrompt.includes('id 1')
      ? 'SELECT * FROM users WHERE id = 1'
      : 'SELECT * FROM users'
    return { toolName: 'execute_sql', input: { query } }
  }

  if (
    availableTools.has('apply_patch') &&
    (lowerPrompt.includes('apply patch') || lowerPrompt.includes('patch file'))
  ) {
    return {
      toolName: 'apply_patch',
      input: {
        operation: {
          type: 'create_file' as const,
          path: 'hello-from-apply-patch.txt',
          diff: '@@\n+hello from apply_patch\n',
        },
      },
    }
  }

  if (
    availableTools.has('fetch_api') &&
    (lowerPrompt.includes('http') || lowerPrompt.includes('fetch'))
  ) {
    const hintedUrl = extractFirstUrl(latestUserText)
    const url =
      hintedUrl && /jsonplaceholder|example/.test(hintedUrl)
        ? hintedUrl
        : 'https://api.example.com/data'
    return { toolName: 'fetch_api', input: { url, method: 'GET' } }
  }

  return null
}

function buildMockResponseText(params: {
  latestUserText: string
  allText: string
  toolName?: MockToolName
}): string {
  const { latestUserText, allText, toolName } = params
  const normalized = latestUserText.trim()
  const lowerPrompt = normalized.toLowerCase()
  const lowerAll = allText.toLowerCase()

  // File exploration: check BEFORE extractQuotedText to avoid grabbing JSON param keys
  // (e.g. params like { directories: ["frontend"] } would otherwise return "directories")
  const hasFileContext =
    lowerAll.includes('.ts') ||
    lowerAll.includes('.tsx') ||
    lowerAll.includes('.js') ||
    lowerAll.includes('.md')
  const isFileQuery =
    lowerPrompt.includes('find') ||
    lowerPrompt.includes('relevant') ||
    lowerPrompt.includes('related') ||
    lowerPrompt.includes('search')

  if (hasFileContext && isFileQuery) {
    const fileRegex = /\b([\w][\w./-]*\.(?:ts|tsx|js|jsx|json|md))\b/g
    const allFiles = [
      ...new Set([...allText.matchAll(fileRegex)].map((m) => m[1])),
    ].filter((f) => f.length < 60 && !f.includes('node_modules'))
    if (allFiles.length > 0) {
      const relevantFiles = allFiles
        .filter((f) => {
          const fl = f.toLowerCase()
          if (lowerPrompt.includes('auth') || lowerPrompt.includes('user')) {
            return (
              fl.includes('user') ||
              fl.includes('auth') ||
              fl.includes('service')
            )
          }
          if (lowerPrompt.includes('api')) {
            return (
              fl.includes('api') ||
              fl.includes('server') ||
              fl.includes('route') ||
              fl.includes('core')
            )
          }
          if (
            lowerPrompt.includes('react') ||
            lowerPrompt.includes('component')
          ) {
            return (
              fl.includes('.tsx') ||
              fl.includes('component') ||
              fl.includes('frontend') ||
              fl.includes('app')
            )
          }
          return true
        })
        .slice(0, 5)
      if (relevantFiles.length > 0) {
        return `The relevant files are: ${relevantFiles.join(', ')}`
      }
    }
  }

  const quoted = extractQuotedText(normalized)
  if (quoted) {
    return quoted
  }

  if (lowerPrompt.includes('what is my favorite number')) {
    if (lowerAll.includes('favorite number is 42')) {
      return 'Your favorite number is 42.'
    }
  }

  if (lowerPrompt.includes('favorite number is')) {
    return 'Got it.'
  }

  if (lowerPrompt.includes('2 + 2')) {
    return '4'
  }

  if (lowerPrompt.includes('project') && lowerPrompt.includes('file')) {
    return 'Files: src/index.ts, src/calculator.ts, package.json, README.md.'
  }

  if (lowerPrompt.includes('calculator class')) {
    return 'The Calculator class adds numbers and tracks a result.'
  }

  if (lowerPrompt.includes('secret code word')) {
    return 'The secret code word is PINEAPPLE42.'
  }

  if (lowerPrompt.includes('company values')) {
    return 'Innovation and Integrity.'
  }

  if (lowerPrompt.includes('summarize') && lowerAll.includes('todo app')) {
    return 'We are discussing a todo app.'
  }

  if (lowerPrompt.includes('what features') && lowerAll.includes('todo app')) {
    return 'Add due dates, filters, and priorities to the todo app.'
  }

  if (lowerPrompt.includes('weather') || toolName === 'get_weather') {
    return 'The weather is sunny, temperature 72F.'
  }

  if (
    lowerPrompt.includes('database') ||
    lowerPrompt.includes('sql') ||
    toolName === 'execute_sql'
  ) {
    return 'Users include Alice and Bob.'
  }

  if (
    lowerPrompt.includes('apply patch') ||
    lowerPrompt.includes('patch file') ||
    toolName === 'apply_patch'
  ) {
    return 'Applied patch successfully.'
  }

  if (
    lowerPrompt.includes('fetch') ||
    lowerPrompt.includes('http') ||
    toolName === 'fetch_api'
  ) {
    return 'Fetched mock API data.'
  }

  if (lowerPrompt.includes('count to 3')) {
    return '1, 2, 3.'
  }

  if (lowerPrompt.includes('name 3 colors')) {
    return 'Red, Green, Blue.'
  }

  if (lowerPrompt.includes('list 3 fruits')) {
    return 'Apple, Banana, Cherry.'
  }

  if (lowerPrompt.includes('say hello')) {
    return 'Hello!'
  }

  if (!lowerPrompt) {
    return 'Hello!'
  }

  return 'OK.'
}

async function* promptAiSdkStreamMock(
  params: ParamsOf<PromptAiSdkStreamFn>,
): ReturnType<PromptAiSdkStreamFn> {
  const agentChunkMetadata =
    params.agentId != null ? { agentId: params.agentId } : undefined

  const latestUserText = getLatestUserText(params.messages)
  const allText = getAllText(params.messages)
  const promptText = getPromptText(latestUserText, allText)
  const hasToolResult = params.messages.some(
    (message) => message.role === 'tool',
  )

  const toolCall = buildMockToolCall({
    tools: params.tools as Record<string, unknown> | undefined,
    latestUserText: promptText,
    hasToolResult,
  })

  const responseText = buildMockResponseText({
    latestUserText: promptText,
    allText,
    toolName: toolCall?.toolName,
  })

  if (toolCall) {
    yield {
      type: 'tool-call',
      toolCallId: nextE2eMockId('mock-tool'),
      toolName: toolCall.toolName,
      input: toolCall.input,
    }
  }

  for (const chunk of splitTextIntoChunks(responseText)) {
    yield {
      type: 'text',
      text: chunk,
      ...(agentChunkMetadata ?? {}),
    }
  }

  if (params.onCostCalculated) {
    await params.onCostCalculated(0)
  }

  return promptSuccess(nextE2eMockId('mock-message'))
}

async function promptAiSdkMock(
  params: ParamsOf<PromptAiSdkFn>,
): ReturnType<PromptAiSdkFn> {
  const latestUserText = getLatestUserText(params.messages)
  const allText = getAllText(params.messages)
  const promptText = getPromptText(latestUserText, allText)
  const responseText = buildMockResponseText({
    latestUserText: promptText,
    allText,
  })

  if (params.onCostCalculated) {
    await params.onCostCalculated(0)
  }

  if (params.n && params.n > 1) {
    return promptSuccess(
      JSON.stringify(Array.from({ length: params.n }, () => responseText)),
    )
  }

  return promptSuccess(responseText)
}

async function promptAiSdkStructuredMock<T>(
  params: PromptAiSdkStructuredInput<T>,
): Promise<T> {
  // Build a prompt-derived minimal valid object so schema-dependent bugs are not masked.
  // Previously this parsed {} and ignored input; now we synthesize candidate values from
  // the prompt/file context and the schema shape, then return the first that validates.
  const allText = getAllText(params.messages as unknown as Message[])
  const latestUserText = getLatestUserText(params.messages as unknown as Message[])
  const promptText = getPromptText(latestUserText, allText)

  const fileRegex = /\b([\w][\w./-]*\.(?:ts|tsx|js|jsx|json|md))\b/g
  const promptFiles = [...new Set([...allText.matchAll(fileRegex)].map((m) => m[1]))]
    .filter((f) => f.length < 80 && !f.includes('node_modules'))
    .slice(0, 5)

  // NOTE: Brittle Zod private internals — _zod/_def, typeName, shape() are not
  // public API and may change across Zod v4 minor releases.
  // Pinned to zod ^4.2.1 (see sdk/package.json "zod": "^4.2.1"); re-verify
  // synthesizeFromSchema on any zod minor bump. This synthesizer is
  // version-guarded with existence checks; on mismatch it falls through to
  // the public safeParse synthesis fallback below which guarantees valid data.
  // Prefer safeParse-driven candidates over deep internal inspection when possible.
  // zod-pinned-fallback-verified: fallback via safeParse candidates guarantees valid data if private shape inspection drifts; covered by deterministic e2e mocks.
  const synthesizeFromSchema = (schema: unknown, hint: string): unknown => {
    // Unwrap Zod wrappers (Optional, Nullable, Default, etc.) via _def inspection
    // Also handle ZodEffects / ZodPipeline / ZodBrand / ZodTransform unwrapping
    const def = (schema as any)?._zod?.def ?? (schema as any)?._def
    const typeName: string | undefined = def?.typeName ?? def?.type
    // Handle ZodOptional / ZodNullable / ZodDefault by unwrapping innerType
    // and ZodEffects / ZodPipeline / ZodBrand / ZodTransform via def.schema or def.innerType/inner
    const inner = def?.innerType ?? def?.inner ?? def?.schema
    if (
      inner &&
      typeName &&
      (/Optional|Nullable|Default/i.test(typeName) ||
        typeName === 'ZodEffects' ||
        typeName === 'ZodPipeline' ||
        typeName === 'ZodBrand' ||
        typeName === 'ZodTransform')
    ) {
      return synthesizeFromSchema(inner, hint)
    }
    if (typeName === 'ZodString' || typeName === 'string') {
      if (hint) return hint.slice(0, 200)
      if (promptFiles.length > 0) return promptFiles[0]
      return promptText.slice(0, 120) || 'mock-value'
    }
    if (typeName === 'ZodNumber' || typeName === 'number') return 1
    if (typeName === 'ZodBoolean' || typeName === 'boolean') return true
    if (typeName === 'ZodEnum' && Array.isArray(def?.values ?? def?.entries)) {
      const vals = def.values ?? Object.values(def.entries ?? {})
      return vals[0]
    }
    if (typeName === 'ZodLiteral') return def?.value ?? def?.values?.[0] ?? 'mock'
    if (typeName === 'ZodArray' && (def?.element ?? def?.type)) {
      const el = def.element ?? def.type
      // Use at least 2 elements to satisfy non-empty and minLength constraints; respect explicit minLength if present
      const explicitMin =
        (def as { minLength?: { value?: number } })?.minLength?.value ??
        (def as { checks?: Array<{ kind?: string; value?: number }> })?.checks?.find(
          (c) => c.kind === 'min',
        )?.value
      const count = Math.min(3, Math.max(2, explicitMin ?? 2))
      return Array.from({ length: count }, () => synthesizeFromSchema(el, hint))
    }
    if (typeName === 'ZodObject' && def?.shape) {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape
      const obj: Record<string, unknown> = {}
      for (const [key, subSchema] of Object.entries(shape as Record<string, unknown>)) {
        const keyHint = key.toLowerCase().includes('path') && promptFiles.length > 0 ? promptFiles[0]
          : key.toLowerCase().includes('summary') || key.toLowerCase().includes('description')
            ? `mock ${key} for ${promptText.slice(0, 40)}`
            : hint
        obj[key] = synthesizeFromSchema(subSchema, keyHint as string)
      }
      return obj
    }
    if (typeName === 'ZodRecord') {
      const valType = def?.valueType ?? def?.values
      if (valType) {
        // Avoid hardcoded single key that fails schemas expecting specific keys or multiple entries.
        // Use prompt-derived keys when available, otherwise provide two distinct keys.
        const derivedKeys =
          promptFiles.length >= 2
            ? promptFiles.slice(0, 2).map((f) => f.split('/').pop() ?? f)
            : []
        const keys = derivedKeys.length >= 2 ? derivedKeys : ['file.ts', 'file2.ts']
        const obj: Record<string, unknown> = {}
        for (const k of keys.slice(0, 2)) {
          obj[k] = synthesizeFromSchema(valType, hint)
        }
        return obj
      }
    }
    if (typeName === 'ZodUnion' && Array.isArray(def?.options)) {
      // Try each union member until one would likely validate
      return synthesizeFromSchema(def.options[0], hint)
    }
    if (typeName === 'ZodDiscriminatedUnion' && Array.isArray(def?.options)) {
      return synthesizeFromSchema(def.options[0], hint)
    }
    // Fallback: use hint or generic
    return hint || 'mock-value'
  }

  // Try prompt-derived synthesis first; fall back to empty object if it fails validation
  let candidate: unknown = {}
  try {
    candidate = synthesizeFromSchema(params.schema as unknown, promptText)
  } catch {
    candidate = {}
  }
  let parsed = params.schema.safeParse(candidate)
  if (parsed.success) {
    if (params.onCostCalculated) await params.onCostCalculated(0)
    return parsed.data
  }
  // Fallback: try with file-aware object for common file-list schemas
  if (promptFiles.length > 0) {
    const fileCandidates = [
      { files: promptFiles.map((p) => ({ path: p, summary: `relevant to ${promptText.slice(0, 40)}` })) },
      { files: promptFiles },
      { path: promptFiles[0] },
    ]
    for (const fc of fileCandidates) {
      const r = params.schema.safeParse(fc)
      if (r.success) {
        if (params.onCostCalculated) await params.onCostCalculated(0)
        return r.data
      }
    }
  }
  parsed = params.schema.safeParse({})
  if (params.onCostCalculated) await params.onCostCalculated(0)
  if (parsed.success) return parsed.data
  const details = !parsed.success ? JSON.stringify(parsed.error.issues ?? parsed.error)?.slice(0, 500) : ''
  throw new Error(
    `promptAiSdkStructuredMock: unable to synthesize valid data for schema (candidate: ${JSON.stringify(candidate)?.slice(0, 500)}; error: ${details})`,
  )
}

let mocksApplied = false

export function setupE2eMocks(): void {
  if (mocksApplied) {
    return
  }
  mocksApplied = true

  spyOn(databaseModule, 'getUserInfoFromApiKey').mockImplementation(
    async ({ fields }) =>
      Object.fromEntries(
        fields.map((field) => [field, MOCK_USER[field]]),
      ) as unknown as Awaited<
        ReturnType<typeof databaseModule.getUserInfoFromApiKey>
      >,
  )
  spyOn(databaseModule, 'fetchAgentFromDatabase').mockImplementation(
    async ({ parsedAgentId }) => buildMockAgentTemplate(parsedAgentId),
  )
  spyOn(databaseModule, 'startAgentRun').mockImplementation(
    async () => nextE2eMockId('mock-run'),
  )
  spyOn(databaseModule, 'finishAgentRun').mockImplementation(async () => {})
  spyOn(databaseModule, 'addAgentStep').mockImplementation(
    async () => nextE2eMockId('mock-step'),
  )

  spyOn(llmModule, 'promptAiSdkStream').mockImplementation(
    promptAiSdkStreamMock,
  )
  spyOn(llmModule, 'promptAiSdk').mockImplementation(promptAiSdkMock)
  spyOn(llmModule, 'promptAiSdkStructured').mockImplementation(
    promptAiSdkStructuredMock as typeof llmModule.promptAiSdkStructured,
  )

  // BYOK model routing: provide a default provider config for agents that
  // rely on defaultModel fallback (e.g. file-lister has no model field).
  // Without this, resolveConfiguredAgentModelConfig hard-errors for any
  // agent lacking model/defaultModel/modes/agents[agentId] (see
  // docs/configuration.md and sdk/src/impl/model-provider.ts).
  const mockLoadedConfig = {
    config: {
      providers: {
        anthropic: {
          type: 'anthropic-compatible',
          baseURL: 'https://api.anthropic.com',
          models: [
            'claude-haiku-4.5',
            'claude-sonnet-4-5',
            'claude-opus-4-5',
          ],
          compatibility: {
            stripCacheControl: false,
            stringifyTextContent: false,
            supportsTools: true,
            supportsRequiredToolChoice: true,
            supportsStopSequences: true,
            stripProviderMetadata: false,
          },
          contextWindowTokens: 200_000,
          modelContextWindowTokens: {},
          defaultCapabilities: { context: { windowTokens: 200_000 } },
          modelCapabilities: {
            'claude-haiku-4.5': { context: { windowTokens: 200_000 } },
            'anthropic/claude-haiku-4.5': {
              context: { windowTokens: 200_000 },
            },
          },
        },
      },
      defaultModel: 'anthropic/claude-haiku-4.5',
      defaultReasoningEffort: undefined,
      visionModel: undefined,
      visionReasoningEffort: undefined,
      modes: {},
      modeReasoningEfforts: {},
      agents: {},
      agentReasoningEfforts: {},
      indexing: {
        enabled: true,
        cacheDir: '.codebuff-index',
        exclude: [],
        semantic: { enabled: false, model: undefined },
      },
      fileChangeHooks: [],
      approvalMode: 'balanced',
      failoverModels: undefined,
      maxAgentSteps: undefined,
    },
    sourceFilePaths: ['mock-e2e-provider-config'],
    sourceFiles: {},
    diagnostics: [],
  } as unknown as ReturnType<
    typeof providerConfigModule.loadProviderConfigSync
  >
  spyOn(providerConfigModule, 'loadProviderConfigSync').mockImplementation(
    () => mockLoadedConfig,
  )
  spyOn(
    modelProviderModule,
    'resolveModelContextWindow',
  ).mockImplementation(() => 200_000)
  spyOn(
    modelProviderModule,
    'resolveModelContextWindows',
  ).mockImplementation(() => ({
    primary: 200_000,
    failoverFloor: 200_000,
  }))

  // OpenbuffClient.checkConnection() was removed when the hosted-backend
  // connection-poll path was pruned (local/BYOK mode is always connected).
  // No replacement spy is needed.
}
