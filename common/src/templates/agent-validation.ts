import { z } from 'zod/v4'

import {
  assertZodSchemaTransportable,
  jsonSchemaAllowsString,
  jsonSchemaToZod,
  projectZodSchema,
} from '../util/json-schema'

import {
  DynamicAgentDefinitionSchema,
  DynamicAgentTemplateSchema,
} from '../types/dynamic-agent-template'

import type { AgentTemplate } from '../types/agent-template'
import type { DynamicAgentTemplate } from '../types/dynamic-agent-template'
import type { Logger } from '@codebuff/common/types/contracts/logger'

export interface DynamicAgentValidationError {
  filePath: string
  message: string
}

/**
 * Collect all agent IDs from template files without full validation
 */
export function collectAgentIds(params: {
  agentTemplates?: Record<string, DynamicAgentTemplate>
  logger: Logger
}): { agentIds: string[]; spawnableAgentIds: string[] } {
  const { agentTemplates = {}, logger } = params

  const agentIds: string[] = []
  const spawnableAgentIds: string[] = []
  const jsonFiles = Object.keys(agentTemplates)

  for (const filePath of jsonFiles) {
    try {
      const content = agentTemplates[filePath]
      if (!content) {
        continue
      }

      // Extract the agent ID if it exists
      if (content.id && typeof content.id === 'string') {
        agentIds.push(content.id)
      }
      if (Array.isArray(content.spawnableAgents)) {
        spawnableAgentIds.push(...content.spawnableAgents)
      }
    } catch (error) {
      // Log but don't fail the collection process for other errors
      logger.debug(
        { filePath, error },
        'Failed to extract agent ID during collection phase',
      )
    }
  }

  return { agentIds, spawnableAgentIds }
}

/**
 * Validate and load dynamic agent templates from user-provided agentTemplates
 */
export function validateAgents(params: {
  agentTemplates?: Record<string, any>
  logger: Logger
}): {
  templates: Record<string, AgentTemplate>
  dynamicTemplates: Record<string, DynamicAgentTemplate>
  validationErrors: DynamicAgentValidationError[]
} {
  const { agentTemplates = {}, logger } = params

  const templates: Record<string, AgentTemplate> = {}
  const dynamicTemplates: Record<string, DynamicAgentTemplate> = {}
  const validationErrors: DynamicAgentValidationError[] = []

  const hasAgentTemplates = Object.keys(agentTemplates).length > 0

  if (!hasAgentTemplates) {
    return {
      templates,
      dynamicTemplates,
      validationErrors,
    }
  }

  const agentKeys = Object.keys(agentTemplates)

  // Load and validate each agent template
  for (const agentKey of agentKeys) {
    const content = agentTemplates[agentKey]
    try {
      if (!content) {
        continue
      }

      const validationResult = validateSingleAgent({
        template: content,
        filePath: agentKey,
      })

      if (!validationResult.success) {
        validationErrors.push({
          filePath: agentKey,
          message: validationResult.error!,
        })
        continue
      }

      if (templates[validationResult.agentTemplate!.id]) {
        const agentContext = validationResult.agentTemplate!.displayName
          ? `Agent "${validationResult.agentTemplate!.id}" (${validationResult.agentTemplate!.displayName})`
          : `Agent "${validationResult.agentTemplate!.id}"`

        validationErrors.push({
          filePath: agentKey,
          message: `${agentContext}: Duplicate agent ID`,
        })
        continue
      }
      templates[validationResult.agentTemplate!.id] =
        validationResult.agentTemplate!
      dynamicTemplates[validationResult.dynamicAgentTemplate!.id] =
        validationResult.dynamicAgentTemplate!
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      // Try to extract agent context for better error messages
      const agentContext = content?.id
        ? `Agent "${content.id}"${content.displayName ? ` (${content.displayName})` : ''}`
        : `Agent in ${agentKey}`

      validationErrors.push({
        filePath: agentKey,
        message: `${agentContext}: ${errorMessage}`,
      })

      logger.warn(
        { filePath: agentKey, error: errorMessage },
        'Failed to load dynamic agent template',
      )
    }
  }

  return {
    templates,
    dynamicTemplates,
    validationErrors,
  }
}

/**
 * Validates a single dynamic agent template and converts it to an AgentTemplate.
 * This is a plain function equivalent to the core logic of loadSingleAgent.
 *
 * @param dynamicAgentIds - Array of all available dynamic agent IDs for validation
 * @param template - The raw agent template to validate (any type)
 * @param options - Optional configuration object
 * @param options.filePath - Optional file path for error context
 * @param options.skipSubagentValidation - Skip subagent validation when loading from database
 * @returns Validation result with either the converted AgentTemplate or an error
 */
export function validateSingleAgent(params: {
  template: any
  filePath?: string
}): {
  success: boolean
  agentTemplate?: AgentTemplate
  dynamicAgentTemplate?: DynamicAgentTemplate
  error?: string
} {
  const { template, filePath = 'unknown' } = params

  try {
    // First validate against the Zod schema
    let validatedConfig: DynamicAgentTemplate
    try {
      const typedAgentDefinition = DynamicAgentDefinitionSchema.parse(template)

      // Convert handleSteps function to string if present
      let handleStepsString: string | undefined
      if (template.handleSteps) {
        handleStepsString = template.handleSteps.toString()
      }

      validatedConfig = DynamicAgentTemplateSchema.parse({
        ...typedAgentDefinition,
        systemPrompt: typedAgentDefinition.systemPrompt || '',
        instructionsPrompt: typedAgentDefinition.instructionsPrompt || '',
        stepPrompt: typedAgentDefinition.stepPrompt || '',
        handleSteps: handleStepsString,
      })
    } catch (error: any) {
      // Try to extract agent context for better error messages
      const agentContext = template.id
        ? `Agent "${template.id}"${template.displayName ? ` (${template.displayName})` : ''}`
        : filePath
          ? `Agent in ${filePath}`
          : 'Agent'

      return {
        success: false,
        error: `${agentContext}: Schema validation failed: ${error.message}`,
      }
    }

    // Convert schemas and handle validation errors
    let inputSchema: AgentTemplate['inputSchema']
    try {
      inputSchema = convertInputSchema(
        validatedConfig.inputSchema?.prompt,
        validatedConfig.inputSchema?.params,
        filePath,
      )
    } catch (error) {
      // Try to extract agent context for better error messages
      const agentContext = validatedConfig.id
        ? `Agent "${validatedConfig.id}"${validatedConfig.displayName ? ` (${validatedConfig.displayName})` : ''}`
        : filePath
          ? `Agent in ${filePath}`
          : 'Agent'
      return {
        success: false,
        error: `${agentContext}: ${
          error instanceof Error ? error.message : 'Schema conversion failed'
        }`,
      }
    }

    // Convert outputSchema if present
    let outputSchema: AgentTemplate['outputSchema']
    if (validatedConfig.outputSchema) {
      try {
        outputSchema = jsonSchemaToZod(validatedConfig.outputSchema)
      } catch (error) {
        // Try to extract agent context for better error messages
        const agentContext = validatedConfig.id
          ? `Agent "${validatedConfig.id}"${validatedConfig.displayName ? ` (${validatedConfig.displayName})` : ''}`
          : filePath
            ? `Agent in ${filePath}`
            : 'Agent'

        return {
          success: false,
          error: `${agentContext}: Failed to convert outputSchema to Zod: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }
      }
    }

    // Validate handleSteps if present
    if (validatedConfig.handleSteps) {
      if (!isValidGeneratorFunction(validatedConfig.handleSteps)) {
        // Try to extract agent context for better error messages
        const agentContext = validatedConfig.id
          ? `Agent "${validatedConfig.id}"${validatedConfig.displayName ? ` (${validatedConfig.displayName})` : ''}`
          : filePath
            ? `Agent in ${filePath}`
            : 'Agent'

        return {
          success: false,
          error: `${agentContext}: handleSteps must be a generator function: "function* (params) { ... }". Found: ${validatedConfig.handleSteps.substring(0, 50)}...`,
        }
      }
    }

    // Convert to internal AgentTemplate format
    const agentTemplate: AgentTemplate = {
      ...validatedConfig,
      systemPrompt: validatedConfig.systemPrompt ?? '',
      instructionsPrompt: validatedConfig.instructionsPrompt ?? '',
      stepPrompt: validatedConfig.stepPrompt ?? '',
      outputSchema,
      inputSchema,
    }

    return {
      success: true,
      agentTemplate,
      dynamicAgentTemplate: validatedConfig,
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'

    // Try to extract agent context for better error messages
    const agentContext = template?.id
      ? `Agent "${template.id}"${template.displayName ? ` (${template.displayName})` : ''}`
      : filePath
        ? `Agent in ${filePath}`
        : 'Agent'

    return {
      success: false,
      error: `${agentContext}: Error validating agent template: ${errorMessage}`,
    }
  }
}

/**
 * Validates if a string represents a valid generator function
 */
function isValidGeneratorFunction(code: string): boolean {
  const trimmed = code.trim()
  // Check if it's a generator function (must start with function*)
  return trimmed.startsWith('function*')
}

/**
 * Compile JSON Schema into exact, nonmutating Zod validators.
 * This is done once during loading to avoid repeated conversions.
 * Throws descriptive errors for validation failures.
 */
function convertInputSchema(
  inputPromptSchema?: Record<string, any>,
  paramsSchema?: Record<string, any>,
  filePath?: string,
): AgentTemplate['inputSchema'] {
  const result: any = {}
  const fileContext = filePath ? ` in ${filePath}` : ''

  // Handle prompt schema
  if (inputPromptSchema) {
    try {
      if (
        typeof inputPromptSchema !== 'object' ||
        Object.keys(inputPromptSchema).length === 0
      ) {
        throw new Error(
          `Invalid inputSchema.prompt${fileContext}: Schema must be a valid non-empty JSON schema object. Found: ${typeof inputPromptSchema}`,
        )
      }
      const promptZodSchema = jsonSchemaToZod(inputPromptSchema)
      if (!jsonSchemaAllowsString(inputPromptSchema)) {
        throw new Error(
          `Invalid inputSchema.prompt${fileContext}: Schema must allow string values. Please ensure your JSON schema accepts string types.`,
        )
      }

      result.prompt = promptZodSchema
    } catch (error) {
      if (error instanceof Error && error.message.includes('inputSchema')) {
        // Re-throw our custom validation errors
        throw error
      }

      // Handle unsupported or invalid JSON Schema
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      throw new Error(
        `Failed to convert inputSchema.prompt to Zod${fileContext}: ${errorMessage}. ` +
          `Please check that your inputSchema.prompt is a valid non-empty JSON schema object.`,
      )
    }
  }

  // Handle params schema
  if (paramsSchema) {
    try {
      if (
        typeof paramsSchema !== 'object' ||
        Object.keys(paramsSchema).length === 0
      ) {
        throw new Error(
          `Invalid inputSchema.params${fileContext}: Schema must be a valid non-empty JSON schema object. Found: ${typeof paramsSchema}`,
        )
      }
      const paramsZodSchema = jsonSchemaToZod(paramsSchema)
      result.params = paramsZodSchema
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      throw new Error(
        `Failed to convert inputSchema.params to Zod${fileContext}: ${errorMessage}. ` +
          `Please check that your inputSchema.params is a valid non-empty JSON schema object.`,
      )
    }
  }
  return result
}

/**
 * Detect a degraded zod-v4 "husk": an object that crossed a JSON.stringify
 * boundary carrying zod's `~standard` standard-schema interface marker but
 * none of the live internals (`_zod`, `safeParse`). `~standard` is zod-v4's
 * runtime interface marker, not a JSON-Schema keyword, so a plain
 * JSON-Schema object never carries it — keying detection on `~standard`
 * (never on `def`, which legitimate JSON Schemas may contain) keeps real
 * JSON Schema out of this path. A husk is neither a live schema nor
 * trustworthy JSON Schema, and feeding it to the AI SDK's `asSchema` routes
 * it to the zod-v3 converter, which reads `def.typeName` on undefined and
 * crashes the spawn with "undefined is not an object (evaluating
 * 'H.typeName')".
 */
export function isDegradedZodHusk(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as {
    '~standard'?: unknown
    _zod?: unknown
    safeParse?: unknown
  }
  return (
    Object.prototype.hasOwnProperty.call(record, '~standard') &&
    record._zod === undefined &&
    typeof record.safeParse !== 'function'
  )
}

/** Whether both input and output projections can be represented as JSON Schema. */
export function isRepresentableZodSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false
  }
  try {
    z.toJSONSchema(value as z.ZodType, { io: 'input' })
    z.toJSONSchema(value as z.ZodType, { io: 'output' })
    return true
  } catch {
    return false
  }
}

/** Restore JSON Schema exactly; refuse degraded Zod internals explicitly. */
export function coerceJsonSchemaMember(value: unknown): unknown {
  if (isLiveZodSchema(value)) return value
  if (isDegradedZodHusk(value)) {
    throw new Error(
      'Cannot restore degraded Zod schema: transport the original JSON Schema instead',
    )
  }
  return jsonSchemaToZod(value)
}

/**
 * Ensure every schema member of a resolved agent template is a zod schema
 * (see coerceJsonSchemaMember). Runtime template resolution applies this so
 * bundled, database, and bridged templates all reach the model surface with
 * zod inputSchema.prompt / inputSchema.params / outputSchema members — the
 * spawn tool input schema, structured output, and set-output parsing all read
 * these members. Returns the original template when no member needs coercion.
 */
export function ensureAgentTemplateZodSchemas(
  template: AgentTemplate,
): AgentTemplate {
  const inputSchema = template.inputSchema
  const prompt =
    inputSchema?.prompt !== undefined
      ? (coerceJsonSchemaMember(
          inputSchema.prompt,
        ) as AgentTemplate['inputSchema']['prompt'])
      : undefined
  const params =
    inputSchema?.params !== undefined
      ? (coerceJsonSchemaMember(
          inputSchema.params,
        ) as AgentTemplate['inputSchema']['params'])
      : undefined
  const outputSchema =
    template.outputSchema !== undefined
      ? (coerceJsonSchemaMember(
          template.outputSchema,
        ) as AgentTemplate['outputSchema'])
      : undefined
  if (
    prompt === inputSchema?.prompt &&
    params === inputSchema?.params &&
    outputSchema === template.outputSchema
  ) {
    return template
  }
  return {
    ...template,
    inputSchema: {
      ...(prompt !== undefined ? { prompt } : {}),
      ...(params !== undefined ? { params } : {}),
    },
    ...(outputSchema !== undefined ? { outputSchema } : {}),
  }
}

/**
 * Detects the AI SDK's `jsonSchema()` wrapper: `{_type: 'jsonSchema',
 * jsonSchema: <schema>, validate?: <fn>}`. `validate` is undefined in the
 * default wrapper and none of the marker members survives a JSON round trip
 * except `jsonSchema` — so over a JSON transport the envelope collapses to
 * `{jsonSchema: <schema>}`, whose literal `jsonSchema` key Ajv's strict
 * keywords reject as `unknown keyword: jsonSchema` (crashing every
 * supervised spawn whose tool set crosses the bridge). Detection requires
 * every own enumerable key to be one of the three envelope members (and
 * `_type`, when present, to be exactly `'jsonSchema'`) so ordinary data that
 * merely carries a property named `jsonSchema` is never mistaken for an
 * envelope.
 */
export function isAiSdkJsonSchemaEnvelope(
  value: unknown,
): value is {
  _type?: unknown
  jsonSchema: Record<string, unknown>
  validate?: unknown
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  // The LIVE wrapper carries `_type` (and `validate`) as own keys whose
  // values are `undefined` — only the JSON wire form collapses them away.
  // Accept the live shape too so detection fires BEFORE the walk (a plain
  // walk of the live envelope would leave `_type`/`validate` holes and
  // deliver the inner schema nested under a literal `jsonSchema` key).
  if (
    '_type' in record &&
    record._type !== 'jsonSchema' &&
    record._type !== undefined
  )
    return false
  const inner = record.jsonSchema
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return false
  for (const key of Object.keys(record)) {
    if (key !== '_type' && key !== 'jsonSchema' && key !== 'validate')
      return false
  }
  return true
}

export function isLiveZodSchema(value: unknown): value is z.ZodType {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as { _zod?: { run?: unknown }; safeParse?: unknown }
  return (
    typeof record.safeParse === 'function' &&
    typeof record._zod?.run === 'function'
  )
}

export function serializeSchemaMemberForTransport(
  value: unknown,
  io: 'input' | 'output',
): unknown {
  if (value === undefined) return value
  try {
    if (!isLiveZodSchema(value)) {
      if (isDegradedZodHusk(value))
        throw new Error('Cannot transport degraded Zod schema internals')
      jsonSchemaToZod(value)
      return value
    }
    assertZodSchemaTransportable(value as z.ZodType)
    const converted = projectZodSchema(value as z.ZodType, io)
    jsonSchemaToZod(converted)
    return converted
  } catch (error) {
    throw new Error(
      `Cannot transport ${io} schema: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

/** Serialize schema members faithfully and refuse unrepresentable behavior. */
export function serializeAgentTemplatesForTransport(
  templates: Record<string, AgentTemplate>,
): Record<string, AgentTemplate> {
  const transported: Record<string, AgentTemplate> = {}
  // Null-safe: an unset localAgentTemplates (top-level orchestrators, tests,
  // some programmatic spawns) must not crash the transport serializer — an
  // absent catalog is an empty one.
  if (templates == null) {
    return transported
  }
  for (const [id, template] of Object.entries(templates)) {
    const inputSchema = template.inputSchema
    const serializeMember = (
      value: unknown,
      io: 'input' | 'output',
      member: string,
    ) => {
      try {
        return serializeSchemaMemberForTransport(value, io)
      } catch (error) {
        throw new Error(
          `Agent "${id}" ${member}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    }
    const prompt = serializeMember(
      inputSchema?.prompt,
      'input',
      'inputSchema.prompt',
    ) as AgentTemplate['inputSchema']['prompt']
    const params = serializeMember(
      inputSchema?.params,
      'input',
      'inputSchema.params',
    ) as AgentTemplate['inputSchema']['params']
    const outputSchema = serializeMember(
      template.outputSchema,
      'output',
      'outputSchema',
    ) as AgentTemplate['outputSchema']
    const handleSteps =
      typeof template.handleSteps === 'function'
        ? template.handleSteps.toString()
        : template.handleSteps
    const changed =
      prompt !== inputSchema?.prompt ||
      params !== inputSchema?.params ||
      outputSchema !== template.outputSchema ||
      handleSteps !== template.handleSteps
    if (!changed) {
      transported[id] = template
      continue
    }
    transported[id] = {
      ...template,
      inputSchema: {
        ...(prompt !== undefined ? { prompt } : {}),
        ...(params !== undefined ? { params } : {}),
      },
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(handleSteps !== undefined ? { handleSteps } : {}),
    }
  }
  return transported
}
