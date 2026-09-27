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
      const typeDefinition = jsonSchemaToTypeScript(jsonSchema)

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
 * Converts JSON Schema to TypeScript interface definition. Exported for the
 * X-1 golden-vector suite, which pins the throw-on-unhandled-shape contract.
 */
export function jsonSchemaToTypeScript(schema: any): string {
  if (schema.type === 'object' && schema.properties) {
    const properties = Object.entries(schema.properties).map(
      ([key, prop]: [string, any]) => {
        const isOptional = !schema.required?.includes(key)
        const propType = getTypeFromJsonSchema(prop)
        const comment = prop.description ? `  /** ${prop.description} */\n` : ''
        return `${comment}  "${key}"${isOptional ? '?' : ''}: ${propType}`
      },
    )
    const additionalProperties = getAdditionalPropertiesType(schema)
    if (additionalProperties) {
      properties.push(`  [key: string]: ${additionalProperties}`)
    }
    return `{\n${properties.join('\n')}\n}`
  }
  return getTypeFromJsonSchema(schema)
}

function getAdditionalPropertiesType(schema: any): string | null {
  if (
    !('additionalProperties' in schema) ||
    schema.additionalProperties === false
  ) {
    return null
  }
  if (schema.additionalProperties === true) {
    return 'any'
  }
  return getTypeFromJsonSchema(schema.additionalProperties)
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
function getTypeFromJsonSchema(prop: any): string {
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
      const itemTypes = prop.prefixItems.map((item: any) =>
        getTypeFromJsonSchema(item),
      )
      if (prop.items) {
        itemTypes.push(`...(${getTypeFromJsonSchema(prop.items)})[]`)
      }
      return `[${itemTypes.join(', ')}]`
    }
    const itemType = prop.items ? getTypeFromJsonSchema(prop.items) : 'any'
    const needsParentheses =
      prop.items?.anyOf || prop.items?.oneOf || itemType.includes(' | ')
    return `${needsParentheses ? `(${itemType})` : itemType}[]`
  }
  if (prop.type === 'object') {
    if (prop.properties) {
      return jsonSchemaToTypeScript(prop)
    }
    if (prop.additionalProperties) {
      const valueType = getTypeFromJsonSchema(prop.additionalProperties)
      return `Record<string, ${valueType}>`
    }
    return 'Record<string, any>'
  }
  if (prop.anyOf || prop.oneOf) {
    const schemas = prop.anyOf || prop.oneOf
    return schemas.map((s: any) => getTypeFromJsonSchema(s)).join(' | ')
  }
  if (prop.allOf) {
    return prop.allOf.map((s: any) => getTypeFromJsonSchema(s)).join(' & ')
  }
  if (prop.$ref !== undefined) {
    throw new Error(
      `Unsupported JSON Schema shape for TS mapping: $ref ${JSON.stringify(prop.$ref)}. Inline the referenced definition or extend the mapper: ${JSON.stringify(prop).slice(0, 200)}`,
    )
  }
  if (isEmptyJsonSchema(prop)) {
    // The empty JSON Schema {} is what zod emits for z.any()/z.unknown():
    // the idiomatic "anything" shape, mapped explicitly — never as a silent
    // fallback for unrecognized shapes.
    return 'any'
  }
  throw new Error(
    `Unsupported JSON Schema shape for TS mapping: ${JSON.stringify(prop).slice(0, 200)}`,
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
