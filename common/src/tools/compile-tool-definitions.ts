import z from 'zod/v4'

import { publishedTools } from './constants'
import { toolParams } from './list'
import type { $ToolParams } from './constants'

/**
 * Resolves the wire-facing parameter schema for a tool exactly as
 * compileToolDefinitions does: `providerInputSchema` when declared, else
 * `inputSchema`.
 */
export function resolveToolParameterSchema(toolDef: unknown): z.ZodType {
  const typedToolDef = toolDef as $ToolParams
  return (typedToolDef.providerInputSchema ??
    typedToolDef.inputSchema) as z.ZodType
}

/**
 * Compiles the JSON Schema artifact for every published tool, keyed by tool
 * name in `publishedTools` iteration order. Schema resolution is shared with
 * compileToolDefinitions so the TypeScript type mirror and the JSON artifact
 * cannot drift.
 */
export function compileToolJsonSchemas(): Record<string, unknown> {
  const artifacts: Record<string, unknown> = {}
  for (const toolName of publishedTools) {
    const parameterSchema = resolveToolParameterSchema(toolParams[toolName])
    artifacts[toolName] = z.toJSONSchema(parameterSchema, { io: 'input' })
  }
  return artifacts
}

/**
 * Compiles all tool definitions into a single TypeScript definition file content.
 * This generates type definitions for all available tools and their parameters.
 */
export function compileToolDefinitions(): string {
  const toolEntries = publishedTools.map(
    (toolName) => [toolName, toolParams[toolName]] as const,
  )

  const toolInterfaces = toolEntries
    .map(([toolName, toolDef]) => {
      const parameterSchema = resolveToolParameterSchema(toolDef)

      // Convert Zod schema to TypeScript interface using JSON schema.
      // Conversion failures must fail the build: a silent
      // '{ [key: string]: any }' fallback would publish an untyped tool
      // surface to providers.
      const jsonSchema = z.toJSONSchema(parameterSchema, { io: 'input' })
      const typeDefinition = jsonSchemaToTypeScript(jsonSchema, toolName)

      const typeName = `${toPascalCase(toolName)}Params`
      const declaration = canEmitInterface(jsonSchema)
        ? `export interface ${typeName} ${typeDefinition}`
        : `export type ${typeName} = ${typeDefinition}`

      return `/**
 * ${parameterSchema.description || `Parameters for ${toolName} tool`}
 */
${declaration}`
    })
    .join('\n\n')

  const toolUnion = toolEntries.map(([toolName]) => `'${toolName}'`).join(' | ')

  const toolParamsMap = toolEntries
    .map(([toolName]) => `  '${toolName}': ${toPascalCase(toolName)}Params`)
    .join('\n')

  return `/**
 * Union type of all available tool names
 */
export type ToolName = ${toolUnion}

/**
 * Map of tool names to their parameter types
 */
export interface ToolParamsMap {
${toolParamsMap}
}

${toolInterfaces}

/**
 * Get parameters type for a specific tool
 */
export type GetToolParams<T extends ToolName> = ToolParamsMap[T]
`
}

/**
 * Converts kebab-case to PascalCase
 * e.g., 'write-file' -> 'WriteFile'
 */
function toPascalCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
}

/**
 * Object-level composite keywords the TS mapper cannot faithfully express.
 * Silently dropping them would publish a type mirror that under-constrains
 * the wire contract, so their presence must throw (honest contract freeze).
 */
const unhandledObjectCompositeKeys = [
  'allOf',
  'patternProperties',
  '$defs',
  'prefixItems',
] as const

/**
 * Throws when an object schema carries composite keywords the mapper does not
 * handle. The message names the tool/field context and the offending keys so
 * the failing tool is immediately identifiable.
 */
function assertNoUnhandledObjectCompositeKeys(
  schema: any,
  context: string,
): void {
  if (schema?.type !== 'object') return
  const unhandled = unhandledObjectCompositeKeys.filter(
    (key) => schema[key] !== undefined,
  )
  if (unhandled.length === 0) return
  throw new Error(
    `Unsupported JSON Schema shape for TS mapping at ${context}: unhandled object-level key(s) ${unhandled.join(', ')}; inline the composite definition or extend the mapper: ${JSON.stringify(schema).slice(0, 200)}`,
  )
}

/**
 * Converts JSON Schema to TypeScript interface definition. `context` is the
 * tool/field path embedded in throw messages. Exported for the X-1
 * golden-vector suite, which pins the throw-on-unhandled-shape contract.
 */
export function jsonSchemaToTypeScript(
  schema: any,
  context = 'schema',
): string {
  if (schema.type === 'object') {
    assertNoUnhandledObjectCompositeKeys(schema, context)
  }
  if (schema.type === 'object' && schema.properties) {
    const properties = Object.entries(schema.properties).map(
      ([key, prop]: [string, any]) => {
        const isOptional = !schema.required?.includes(key)
        const propType = getTypeFromJsonSchema(prop, `${context}.${key}`)
        const comment = prop.description ? `  /** ${prop.description} */\n` : ''
        return `${comment}  "${key}"${isOptional ? '?' : ''}: ${propType}`
      },
    )
    const additionalProperties = getAdditionalPropertiesType(
      schema,
      `${context}[key: string]`,
    )
    if (additionalProperties) {
      properties.push(`  [key: string]: ${additionalProperties}`)
    }
    if (properties.length === 0 && schema.additionalProperties === false) {
      // Strict empty object: no declared properties and no index signature
      // allowed. Map to the precise empty record instead of the loose
      // shape the old falsy handling produced.
      return 'Record<string, never>'
    }
    return `{\n${properties.join('\n')}\n}`
  }
  return getTypeFromJsonSchema(schema, context)
}

function getAdditionalPropertiesType(
  schema: any,
  context: string,
): string | null {
  if (
    !('additionalProperties' in schema) ||
    schema.additionalProperties === false
  ) {
    return null
  }
  if (schema.additionalProperties === true) {
    return 'any'
  }
  return getTypeFromJsonSchema(schema.additionalProperties, context)
}

function canEmitInterface(schema: any): boolean {
  return (
    schema.type === 'object' &&
    !!schema.properties &&
    !schema.anyOf &&
    !schema.oneOf
  )
}

/**
 * Gets TypeScript type from JSON Schema property
 */
function getTypeFromJsonSchema(prop: any, context: string): string {
  if (prop.const !== undefined) {
    return JSON.stringify(prop.const)
  }

  if (prop.type === 'string') {
    if (prop.enum) {
      return prop.enum.map((v: string) => JSON.stringify(v)).join(' | ')
    }
    return 'string'
  }
  if (prop.type === 'number' || prop.type === 'integer') return 'number'
  if (prop.type === 'boolean') return 'boolean'
  if (prop.type === 'null') return 'null'
  if (prop.type === 'array') {
    if (prop.prefixItems) {
      // Tuple: fixed positional items plus an optional trailing rest schema.
      const itemTypes = prop.prefixItems.map((item: any, index: number) =>
        getTypeFromJsonSchema(item, `${context}[${index}]`),
      )
      if (prop.items) {
        itemTypes.push(
          `...(${getTypeFromJsonSchema(prop.items, `${context}[]`)})[]`,
        )
      }
      return `[${itemTypes.join(', ')}]`
    }
    const itemType = prop.items
      ? getTypeFromJsonSchema(prop.items, `${context}[]`)
      : 'any'
    const needsParentheses =
      prop.items?.anyOf || prop.items?.oneOf || itemType.includes(' | ')
    return `${needsParentheses ? `(${itemType})` : itemType}[]`
  }
  if (prop.type === 'object') {
    assertNoUnhandledObjectCompositeKeys(prop, context)
    if (prop.properties) {
      return jsonSchemaToTypeScript(prop, context)
    }
    if (prop.additionalProperties === false) {
      // Strict empty object: no declared properties and no index signature
      // allowed. Map to the precise empty record — never the loose
      // Record<string, any> the old falsy check fell into.
      return 'Record<string, never>'
    }
    if (prop.additionalProperties === true) {
      // Any key with any value: the same 'any' index-signature policy the
      // object-level branch applies via getAdditionalPropertiesType.
      return 'Record<string, any>'
    }
    if (prop.additionalProperties) {
      const valueType = getTypeFromJsonSchema(
        prop.additionalProperties,
        `${context}[key: string]`,
      )
      return `Record<string, ${valueType}>`
    }
    return 'Record<string, any>'
  }
  if (prop.anyOf || prop.oneOf) {
    const schemas = prop.anyOf || prop.oneOf
    return schemas
      .map((s: any, index: number) =>
        getTypeFromJsonSchema(s, `${context}|${index}`),
      )
      .join(' | ')
  }
  if (prop.allOf) {
    return prop.allOf
      .map((s: any, index: number) =>
        getTypeFromJsonSchema(s, `${context}&${index}`),
      )
      .join(' & ')
  }
  if (prop.$ref !== undefined) {
    throw new Error(
      `Unsupported JSON Schema shape for TS mapping at ${context}: $ref ${JSON.stringify(prop.$ref)}. Inline the referenced definition or extend the mapper: ${JSON.stringify(prop).slice(0, 200)}`,
    )
  }
  if (isEmptyJsonSchema(prop)) {
    // The empty JSON Schema {} is what zod emits for z.any()/z.unknown():
    // the idiomatic "anything" shape, mapped explicitly — never as a silent
    // fallback for unrecognized shapes.
    return 'any'
  }
  throw new Error(
    `Unsupported JSON Schema shape for TS mapping at ${context}: ${JSON.stringify(prop).slice(0, 200)}`,
  )
}

/**
 * True for the JSON Schema `{}` "anything" shape zod emits for
 * z.any()/z.unknown(). Every other unrecognized shape must throw.
 */
function isEmptyJsonSchema(prop: any): boolean {
  return (
    prop !== null &&
    typeof prop === 'object' &&
    Object.keys(prop).length === 0
  )
}
