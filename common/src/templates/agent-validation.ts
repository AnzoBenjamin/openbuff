import { convertJsonSchemaToZod } from 'zod-from-json-schema'
import { z } from 'zod/v4'

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
        outputSchema = convertJsonSchemaToZod(validatedConfig.outputSchema)
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
 * Convert JSON schema to Zod schema format using json-schema-to-zod.
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
      const promptZodSchema = convertJsonSchemaToZod(inputPromptSchema)
      // Validate that the schema results in string or undefined
      const testResult = promptZodSchema.safeParse('test')
      const testUndefined = promptZodSchema.safeParse(undefined)

      if (!testResult.success && !testUndefined.success) {
        const errorDetails =
          testResult.error?.issues?.[0]?.message || 'validation failed'
        throw new Error(
          `Invalid inputSchema.prompt${fileContext}: Schema must allow string or undefined values. ` +
            `Current schema validation error: ${errorDetails}. ` +
            `Please ensure your JSON schema accepts string types.`,
        )
      }

      result.prompt = promptZodSchema
    } catch (error) {
      if (error instanceof Error && error.message.includes('inputSchema')) {
        // Re-throw our custom validation errors
        throw error
      }

      // Handle json-schema-to-zod conversion errors
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
      const paramsZodSchema = convertJsonSchemaToZod(paramsSchema)
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

/**
 * Whether a converted zod schema is REPRESENTABLE in JSON Schema — the
 * empirical proxy for asSchema compatibility: the AI SDK's `asSchema` (used
 * for every bridged tool inputSchema) throws exactly when `z.toJSONSchema`
 * throws. Converted DEGENERATE shapes fail this probe: for `{ type:
 * 'object' }` with no properties — and for real degraded husks, whose wire
 * form is zod's serialized INTERNALS (def/shape), not JSON Schema —
 * convertJsonSchemaToZod wraps its output in a base union containing a
 * z.custom(...) branch, which zod-v4's JSON-Schema generator rejects with
 * "Custom types cannot be represented in JSON Schema".
 */
export function isRepresentableZodSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false
  }
  try {
    z.toJSONSchema(value as z.ZodType, { io: 'input' })
    return true
  } catch {
    return false
  }
}

/**
 * Native zod fallback for degenerate/unrepresentable JSON-Schema inputs,
 * selected by the source JSON-Schema `type` field when it is a string (a
 * husk's `type` is a heuristic at best, so missing/undefined degrades to a
 * loose object). Native zod schemas are representable under BOTH io modes
 * of z.toJSONSchema (z.any(), z.object({}).loose(), z.string(), z.number(),
 * z.boolean(), z.array(z.any()), ...), so a fallback built here can never
 * reproduce the "Custom types cannot be represented in JSON Schema" crash —
 * which a converted `{ type: 'object' }` WOULD: that conversion itself
 * carries the poisoned z.custom base-union branch, so it must never be the
 * fallback either.
 */
export function buildNativeFallbackSchema(jsonSchemaType: unknown): z.ZodType {
  switch (jsonSchemaType) {
    case 'string':
      return z.string()
    case 'number':
    case 'integer':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'array':
      return z.array(z.any())
    default:
      return z.object({}).loose()
  }
}

/**
 * Coerce a single agent-template schema member into a zod schema.
 *
 * Templates that cross a JSON serialization boundary — bundled agents built
 * by cli/scripts/prebuild-agents.ts (JSON.stringify) and templates bridged
 * parent→child through the supervision bridge — lose their zod prototype and
 * arrive as plain JSON-Schema objects. Feeding such an object to the AI SDK's
 * `asSchema` routes it to the zod-v3 converter, which reads
 * `schema._def.typeName` on undefined and crashes the run. Values that are
 * already zod (v4 `_zod` marker, or a `safeParse` function) are returned
 * unchanged so zod members are never double-converted. Degraded zod-v4 husks
 * (see isDegradedZodHusk) are neither live zod nor trustworthy JSON Schema:
 * they are re-converted from their own shape when possible.
 *
 * Representability guarantee: for any object input the returned value is a
 * live zod schema whose `z.toJSONSchema(result, { io: 'input' })` does NOT
 * throw. Every convertJsonSchemaToZod result is probed for representability
 * (asSchema throws exactly when z.toJSONSchema throws) and an unrepresentable
 * conversion degrades to the type-faithful NATIVE fallback
 * (buildNativeFallbackSchema) — never to another poisoned conversion — so a
 * coerced member can never crash the spawn with "Custom types cannot be
 * represented in JSON Schema".
 */
export function coerceJsonSchemaMember(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }
  const record = value as {
    _zod?: unknown
    safeParse?: unknown
    type?: unknown
  }
  if (record._zod !== undefined || typeof record.safeParse === 'function') {
    return value
  }
  if (isDegradedZodHusk(value)) {
    let converted: unknown
    try {
      converted = convertJsonSchemaToZod(value as Record<string, unknown>)
    } catch {
      // The husk shape is not valid JSON Schema — fall through to the
      // type-faithful native fallback below.
    }
    if (
      converted &&
      typeof converted === 'object' &&
      isRepresentableZodSchema(converted)
    ) {
      return converted
    }
    return buildNativeFallbackSchema(record.type)
  }
  let converted: unknown
  try {
    converted = convertJsonSchemaToZod(value as Record<string, unknown>)
  } catch {
    // A plain non-husk object that is not valid JSON Schema makes
    // convertJsonSchemaToZod throw. Degrade to the type-faithful native
    // fallback instead of propagating and crashing the spawn — mirroring the
    // husk branch above and honoring this function's representability
    // guarantee for any object input.
    return buildNativeFallbackSchema(record.type)
  }
  if (
    converted &&
    typeof converted === 'object' &&
    isRepresentableZodSchema(converted)
  ) {
    return converted
  }
  return buildNativeFallbackSchema(record.type)
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
      ? (coerceJsonSchemaMember(template.outputSchema) as AgentTemplate['outputSchema'])
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

function isLiveZodSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as { _zod?: unknown; safeParse?: unknown }
  return record._zod !== undefined || typeof record.safeParse === 'function'
}

export function serializeSchemaMemberForTransport(
  value: unknown,
  io: 'input' | 'output',
): unknown {
  if (!isLiveZodSchema(value)) {
    return value
  }
  try {
    // unrepresentable: 'any' — convertJsonSchemaToZod builds a base union
    // containing a z.custom(...) object-branch for type-less members under
    // anyOf (e.g. the bundled code-reviewer outputSchema's
    // findings.items.anyOf), and zod-v4's JSON-Schema generator throws on
    // custom types by default ("Custom types cannot be represented in JSON
    // Schema"). 'any' emits `{}` for exactly those degenerate branches while
    // preserving every representable part of the schema (properties,
    // required, anyOf/allOf structure), so the transported member keeps its
    // validation strictness instead of collapsing to a permissive husk. The
    // degenerate `{}` branch sits under the parent's allOf object branch, so
    // objectness is still enforced by the surrounding structure.
    return z.toJSONSchema(value as z.ZodType, {
      io,
      unrepresentable: 'any',
    })
  } catch {
    // Last-resort guard for schemas even 'any' cannot express. Returning the
    // live zod member is NOT safe: this request crosses the JSON.stringify
    // spawn boundary and zod internals are not own-enumerable, so stringify
    // degrades the live schema into a husk that crashes asSchema in the
    // child. A permissive JSON-Schema fallback keeps the spawn alive — the
    // child re-coerces it through coerceJsonSchemaMember into a valid, live
    // zod schema — at the cost of losing member-specific validation
    // strictness. A working agent beats a crashed one.
    return { type: 'object' }
  }
}

/**
 * Serialize agent templates into the round-trip-safe form the supervised
 * spawn request file needs. That file is a JSON boundary: JSON.stringify
 * silently degrades live zod schemas into degenerate husks (their internals
 * are not own-enumerable) and silently drops function-valued members such as
 * handleSteps. The child re-coerces plain JSON-Schema members back to zod
 * (ensureAgentTemplateZodSchemas via coerceJsonSchemaMember) and materializes
 * string handleSteps via new Function for trusted executionSources, so the
 * transport form is JSON-Schema objects plus string handleSteps. Live zod
 * members serialize through z.toJSONSchema with `unrepresentable: 'any'` so
 * pipeline-produced schemas (including the z.custom base-union branches
 * convertJsonSchemaToZod emits) keep their full structure; schemas even that
 * cannot express fall back to a permissive `{ type: 'object' }` — leaving
 * the live zod member in place would let JSON.stringify degrade it into a
 * husk that crashes the child's asSchema. Templates that need no conversion
 * are returned by reference so large bundled catalogs stay identity-stable.
 */
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
    const prompt = serializeSchemaMemberForTransport(
      inputSchema?.prompt,
      'input',
    ) as AgentTemplate['inputSchema']['prompt']
    const params = serializeSchemaMemberForTransport(
      inputSchema?.params,
      'input',
    ) as AgentTemplate['inputSchema']['params']
    const outputSchema = serializeSchemaMemberForTransport(
      template.outputSchema,
      'output',
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
