import Ajv from 'ajv'
import { z } from 'zod/v4'
import { endsAgentStepParam } from '../tools/constants'

export type JsonSchema = boolean | Record<string, unknown>

const retainedSchemas = new WeakMap<z.ZodType, JsonSchema>()
const draft7 = 'http://json-schema.org/draft-07/schema#'
const schemaMaps = new Set(['properties', 'patternProperties', 'definitions'])
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf'])
const schemaMembers = new Set([
  'additionalProperties',
  'additionalItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
])

function schemaError(message: string): never {
  throw new Error(`Unsupported JSON Schema: ${message}`)
}

function assertJsonValue(
  value: unknown,
  path = '#',
  ancestors = new Set<object>(),
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || !value)
    schemaError(`${path} is not JSON data`)
  if (ancestors.has(value)) schemaError(`${path} contains a JavaScript cycle`)
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    schemaError(`${path} must be a plain JSON object`)
  }
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index))
        schemaError(`${path}/${index} is a sparse array entry`)
    }
  }
  for (const [key, child] of Object.entries(value))
    assertJsonValue(child, `${path}/${key}`, ancestors)
  ancestors.delete(value)
}

function visitSchemas(
  schema: JsonSchema,
  visit: (schema: Record<string, unknown>, path: string) => void,
  path = '#',
): void {
  if (typeof schema === 'boolean') return
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    schemaError(`${path} must be an object or boolean schema`)
  visit(schema, path)
  for (const [key, value] of Object.entries(schema)) {
    if (
      schemaMaps.has(key) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      for (const [name, member] of Object.entries(value))
        visitSchemas(member as JsonSchema, visit, `${path}/${key}/${name}`)
    } else if (schemaArrays.has(key) && Array.isArray(value)) {
      value.forEach((member, index) =>
        visitSchemas(member as JsonSchema, visit, `${path}/${key}/${index}`),
      )
    } else if (key === 'items') {
      if (Array.isArray(value))
        value.forEach((member, index) =>
          visitSchemas(member as JsonSchema, visit, `${path}/items/${index}`),
        )
      else visitSchemas(value as JsonSchema, visit, `${path}/items`)
    } else if (schemaMembers.has(key)) {
      visitSchemas(value as JsonSchema, visit, `${path}/${key}`)
    } else if (key === 'dependencies' && value && typeof value === 'object') {
      for (const [name, member] of Object.entries(value)) {
        if (!Array.isArray(member))
          visitSchemas(
            member as JsonSchema,
            visit,
            `${path}/dependencies/${name}`,
          )
      }
    }
  }
}

function resolveLocalRef(root: JsonSchema, ref: string): JsonSchema {
  let value: unknown = root
  if (ref !== '#') {
    for (const segment of ref.slice(2).split('/')) {
      if (segment === '')
        schemaError(
          `empty JSON pointer tokens in ${ref} are unsupported by the validator`,
        )
      if (value && typeof value === 'object' && '$ref' in value)
        schemaError(`reference ${ref} traverses another reference scope`)
      let key: string
      try {
        key = decodeURIComponent(segment)
          .replace(/~1/g, '/')
          .replace(/~0/g, '~')
      } catch {
        return schemaError(`invalid local reference ${ref}`)
      }
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
        schemaError(`unresolved local reference ${ref}`)
      value = (value as Record<string, unknown>)[key]
    }
  }
  if (
    typeof value !== 'boolean' &&
    (!value || typeof value !== 'object' || Array.isArray(value))
  )
    schemaError(`${ref} does not reference a schema`)
  return value as JsonSchema
}

// Local document references need rebasing when this validator is nested in a
// larger Zod object. Inline acyclic references rather than publishing pointers
// that would accidentally resolve against that enclosing object's root.
function inlineLocalRefs(root: JsonSchema): JsonSchema {
  const expand = (schema: JsonSchema, refs: Set<string>): JsonSchema => {
    if (typeof schema === 'boolean') return schema
    if (typeof schema.$ref === 'string') {
      if (refs.has(schema.$ref))
        schemaError(
          `recursive local reference ${schema.$ref} cannot be embedded faithfully`,
        )
      return expand(
        resolveLocalRef(root, schema.$ref),
        new Set([...refs, schema.$ref]),
      )
    }
    const copy = structuredClone(schema)
    for (const [key, value] of Object.entries(copy)) {
      if (
        schemaMaps.has(key) &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        copy[key] = Object.fromEntries(
          Object.entries(value).map(([name, child]) => [
            name,
            expand(child as JsonSchema, refs),
          ]),
        )
      } else if (schemaArrays.has(key) && Array.isArray(value)) {
        copy[key] = value.map((child) => expand(child as JsonSchema, refs))
      } else if (key === 'items') {
        copy[key] = Array.isArray(value)
          ? value.map((child) => expand(child as JsonSchema, refs))
          : expand(value as JsonSchema, refs)
      } else if (schemaMembers.has(key)) {
        copy[key] = expand(value as JsonSchema, refs)
      } else if (key === 'dependencies' && value && typeof value === 'object') {
        copy[key] = Object.fromEntries(
          Object.entries(value).map(([name, child]) => [
            name,
            Array.isArray(child) ? child : expand(child as JsonSchema, refs),
          ]),
        )
      }
    }
    delete copy.$schema
    delete copy.$id
    return copy
  }
  return expand(root, new Set())
}

/** External input roots share a transport namespace with the step-control field. */
export function assertExternalToolInputSchema(schema: JsonSchema): void {
  const fail = (path: string): never =>
    schemaError(
      `${path} addresses reserved tool input field ${endsAgentStepParam}`,
    )
  const inspectNames = (member: JsonSchema, path: string): void => {
    if (typeof member === 'boolean') return
    if (
      member.const === endsAgentStepParam ||
      (Array.isArray(member.enum) &&
        member.enum.includes(endsAgentStepParam)) ||
      (typeof member.pattern === 'string' &&
        new RegExp(member.pattern).test(endsAgentStepParam))
    )
      fail(path)
    for (const key of schemaArrays)
      if (Array.isArray(member[key]))
        member[key].forEach((child, index) =>
          inspectNames(child as JsonSchema, `${path}/${key}/${index}`),
        )
    for (const key of ['not', 'if', 'then', 'else'])
      if (member[key] !== undefined)
        inspectNames(member[key] as JsonSchema, `${path}/${key}`)
  }
  const inspectRoot = (member: JsonSchema, path: string): void => {
    if (typeof member === 'boolean') return
    if (
      member.properties &&
      typeof member.properties === 'object' &&
      Object.hasOwn(member.properties, endsAgentStepParam)
    )
      fail(`${path}/properties/${endsAgentStepParam}`)
    if (
      Array.isArray(member.required) &&
      member.required.includes(endsAgentStepParam)
    )
      fail(`${path}/required`)
    const patterns = member.patternProperties
    if (patterns && typeof patterns === 'object')
      for (const pattern of Object.keys(patterns))
        if (new RegExp(pattern).test(endsAgentStepParam))
          fail(`${path}/patternProperties/${pattern}`)
    const dependencies = member.dependencies
    if (dependencies && typeof dependencies === 'object')
      for (const [name, dependency] of Object.entries(dependencies)) {
        if (
          name === endsAgentStepParam ||
          (Array.isArray(dependency) && dependency.includes(endsAgentStepParam))
        )
          fail(`${path}/dependencies/${name}`)
        if (!Array.isArray(dependency))
          inspectRoot(dependency as JsonSchema, `${path}/dependencies/${name}`)
      }
    for (const value of [
      member.const,
      ...(Array.isArray(member.enum) ? member.enum : []),
    ])
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.hasOwn(value, endsAgentStepParam)
      )
        fail(`${path}/const-or-enum`)
    if (member.propertyNames !== undefined)
      inspectNames(member.propertyNames as JsonSchema, `${path}/propertyNames`)
    for (const key of schemaArrays)
      if (Array.isArray(member[key]))
        member[key].forEach((child, index) =>
          inspectRoot(child as JsonSchema, `${path}/${key}/${index}`),
        )
    for (const key of ['not', 'if', 'then', 'else'])
      if (member[key] !== undefined)
        inspectRoot(member[key] as JsonSchema, `${path}/${key}`)
  }
  // Resolve only schema references; nested property values and annotations
  // are ordinary data and do not reserve their own cb_easp members.
  inspectRoot(inlineLocalRefs(schema), '#')
}

function decimalParts(value: number): { coefficient: bigint; scale: number } {
  const [mantissa, exponent = '0'] = value.toString().split('e')
  const point = mantissa.indexOf('.')
  return {
    coefficient: BigInt(mantissa.replace('.', '')),
    scale: (point < 0 ? 0 : mantissa.length - point - 1) - Number(exponent),
  }
}

/** Divisibility of parsed finite JSON numbers, without floating-point tolerance. */
function isDecimalMultiple(divisor: number, value: number): boolean {
  if (!Number.isFinite(divisor) || divisor <= 0 || !Number.isFinite(value))
    return false
  const multiple = decimalParts(value)
  const unit = decimalParts(divisor)
  const shift = unit.scale - multiple.scale
  return shift >= 0
    ? (multiple.coefficient * 10n ** BigInt(shift)) % unit.coefficient === 0n
    : multiple.coefficient % (unit.coefficient * 10n ** BigInt(-shift)) === 0n
}

/** Exact, nonmutating draft-7 validation with retained provider/transport data. */
export function jsonSchemaToZod(value: unknown): z.ZodType {
  if (
    typeof value !== 'boolean' &&
    (!value || typeof value !== 'object' || Array.isArray(value))
  )
    schemaError('expected an object or boolean schema')
  assertJsonValue(value)
  const schema = structuredClone(value) as JsonSchema
  visitSchemas(schema, (member, path) => {
    // Ajv 6 deliberately omits these map entries from generated validators.
    // Refuse them instead of silently dropping an advertised constraint.
    for (const keyword of ['properties', 'patternProperties', 'dependencies']) {
      const map = member[keyword]
      if (map && typeof map === 'object' && Object.hasOwn(map, '__proto__'))
        schemaError(
          `${path}/${keyword}/__proto__ is unsupported by the validator`,
        )
    }
    const properties = member.properties
    const additional = member.additionalProperties
    if (
      properties &&
      typeof properties === 'object' &&
      Object.hasOwn(properties, 'hasOwnProperty') &&
      Object.keys(properties).length > 8 &&
      (additional === false ||
        (additional &&
          typeof additional === 'object' &&
          Object.keys(additional).length > 0))
    ) {
      // The large-map additional-property check calls the map's shadowed
      // hasOwnProperty directly, which would otherwise throw during parsing.
      schemaError(
        `${path}/properties/hasOwnProperty is unsupported with more than eight properties and constrained additionalProperties`,
      )
    }
    if (
      member.$schema !== undefined &&
      member.$schema !== draft7 &&
      member.$schema !== draft7.slice(0, -1) &&
      member.$schema !== draft7.replace('http:', 'https:')
    ) {
      schemaError(
        `${path}/$schema declares unsupported dialect ${String(member.$schema)}; use draft-7`,
      )
    }
    if (path !== '#' && member.$id !== undefined)
      schemaError(`${path}/$id changes local reference scope`)
    if (member.$async !== undefined)
      schemaError(`${path}/$async requires asynchronous JSON Schema validation`)
    if (
      member.$ref !== undefined &&
      (typeof member.$ref !== 'string' ||
        (member.$ref !== '#' && !member.$ref.startsWith('#/')))
    ) {
      schemaError(
        `${path}/$ref must be a local JSON pointer; external references are unsupported`,
      )
    }
  })
  // Normalize the equivalent HTTPS draft-7 URI for Ajv's registered meta-schema.
  const validationSchema = structuredClone(schema)
  visitSchemas(validationSchema, (member) => {
    if (member.$schema !== undefined) member.$schema = draft7
    // An empty required array imposes no constraint. Ajv 6's unrolled property
    // checks otherwise mistake inherited prototype names for required fields.
    if (Array.isArray(member.required) && member.required.length === 0)
      delete member.required
  })
  const ajv = new Ajv({
    allErrors: true,
    strictKeywords: true,
    unknownFormats: true,
    format: 'full',
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    ownProperties: true,
    // The loop uses own-property checks instead of Ajv 6's prototype-bearing
    // required-name lookup when described properties are optional.
    loopRequired: 1,
    strictNumbers: true,
    jsonPointers: true,
    logger: false,
  })
  // Ajv 6 divides floats directly: 0.3 / 0.1 is not an integer in JS.
  // Decimal divisibility preserves both valid fractions and near-miss refusal.
  ajv.removeKeyword('multipleOf')
  ajv.addKeyword('multipleOf', {
    type: 'number',
    metaSchema: { type: 'number', exclusiveMinimum: 0 },
    validate: isDecimalMultiple,
    errors: false,
  })
  let validate: Ajv.ValidateFunction
  try {
    validate = ajv.compile(validationSchema)
  } catch (error) {
    return schemaError(error instanceof Error ? error.message : String(error))
  }
  if (validate.$async) schemaError('asynchronous validators are unsupported')
  const embedded = inlineLocalRefs(schema)
  const result = z.unknown().superRefine((data, context) => {
    if (validate(data) === true) return
    for (const error of validate.errors ?? []) {
      const property =
        (
          error.params as {
            additionalProperty?: string
            missingProperty?: string
          }
        ).additionalProperty ??
        (error.params as { missingProperty?: string }).missingProperty
      context.addIssue({
        code: 'custom',
        message: `${error.dataPath || '/'} ${error.message ?? 'failed JSON Schema validation'}${property !== undefined ? ` (${JSON.stringify(property)})` : ''}`,
      })
    }
  })
  // Zod 4.2's hook also works when this wrapper is nested in provider schemas.
  // Its emitter ignores a false hook result, so express false as the exact
  // draft-7 equivalent {not:{}}; direct projections retain literal booleans.
  result._zod.toJSONSchema = () =>
    structuredClone(
      embedded === false ? { not: {} } : embedded === true ? {} : embedded,
    )
  retainedSchemas.set(result, schema)
  return result
}

/** Provider projection; original live Zod remains authoritative for execution. */
function tupleMinimumLength(
  definition: Record<string, unknown>,
): number | undefined {
  const items = definition.items as z.ZodType[]
  const requiredTypes = new Set([
    'string',
    'number',
    'boolean',
    'object',
    'array',
    'tuple',
    'record',
    'enum',
    'literal',
    'never',
  ])
  let minimum = 0
  let lastNonOptional = -1
  for (let index = 0; index < items.length; index++) {
    const member = items[index]
    if (member._zod.optin === 'optional') continue
    lastNonOptional = index
    const memberDefinition = member._zod.def as unknown as Record<
      string,
      unknown
    >
    if (['unknown', 'any'].includes(String(memberDefinition.type))) continue
    if (
      memberDefinition.coerce ||
      !requiredTypes.has(String(memberDefinition.type))
    )
      return undefined
    minimum = index + 1
  }
  // The pinned Zod parser checks this length before validating missing slots.
  // A trailing unknown member accepts undefined, so not every slot is required.
  return definition.rest ? minimum : Math.max(minimum, lastNonOptional)
}

function projectTupleBounds(
  definition: Record<string, unknown>,
  jsonSchema: Record<string, unknown>,
): void {
  if (definition.type !== 'tuple') return
  const items = definition.items as z.ZodType[]
  const minimum = tupleMinimumLength(definition)
  if (minimum !== undefined) jsonSchema.minItems = minimum
  if (!definition.rest) {
    jsonSchema.maxItems = items.length
    jsonSchema.additionalItems = false
  }
  if (items.length === 0) {
    // Draft-7 forbids an empty positional items array.
    if (definition.rest) jsonSchema.items = jsonSchema.additionalItems
    else delete jsonSchema.items
    delete jsonSchema.additionalItems
  }
}

export function projectZodSchema(
  schema: z.ZodType,
  io: 'input' | 'output',
): JsonSchema {
  const retained = retainedSchemas.get(schema)
  // Zod attaches a non-enumerable ~standard adapter to its JSON Schema output.
  // Return plain data so an immediate restore does not mistake it for a husk.
  return structuredClone(
    retained !== undefined
      ? retained
      : z.toJSONSchema(schema, {
          io,
          target: 'draft-7',
          override: ({ zodSchema, jsonSchema }) =>
            projectTupleBounds(
              zodSchema._zod.def as unknown as Record<string, unknown>,
              jsonSchema as Record<string, unknown>,
            ),
        }),
  ) as JsonSchema
}

/** Advisory input shape for tools validated by their original live host schema. */
export function projectHostToolInputSchema(schema: z.ZodType): JsonSchema {
  if (retainedSchemas.has(schema)) return projectZodSchema(schema, 'input')
  const annotations = new Set([
    'title',
    'description',
    'default',
    'examples',
    'deprecated',
    '$comment',
    'readOnly',
    'writeOnly',
  ])
  const projected = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-7',
    override: ({ zodSchema, jsonSchema }) => {
      const definition = zodSchema._zod.def as unknown as Record<
        string,
        unknown
      >
      projectTupleBounds(definition, jsonSchema as Record<string, unknown>)
      const checks = Array.isArray(definition.checks)
        ? definition.checks.map((check) => check?._zod?.def)
        : []
      const acceptsOtherTypes =
        definition.coerce === true || definition.type === 'catch'
      const overwrites = checks.some((check) => check?.check === 'overwrite')
      if (acceptsOtherTypes || overwrites) {
        // Coercion/catch and normalization can accept values excluded by the
        // post-normalization bounds. The host remains the authority for them.
        for (const key of Object.keys(jsonSchema))
          if (!annotations.has(key) && !(key === 'type' && !acceptsOtherTypes))
            delete (jsonSchema as Record<string, unknown>)[key]
      } else if (definition.type === 'string') {
        // One Unicode code point occupies one or two UTF-16 units in Zod.
        if (typeof jsonSchema.minLength === 'number')
          jsonSchema.minLength = Math.ceil(jsonSchema.minLength / 2)
        if (
          checks.some(
            (check) => check?.pattern instanceof RegExp && check.pattern.flags,
          )
        )
          delete jsonSchema.pattern
      }
    },
  })
  return structuredClone(projected) as JsonSchema
}

/** Executable Zod behavior cannot be transferred as a JSON Schema contract. */
export function assertZodSchemaTransportable(schema: z.ZodType): void {
  const seen = new Set<object>()
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (retainedSchemas.has(value as z.ZodType)) return
    const internals = (value as { _zod?: { def?: Record<string, unknown> } })
      ._zod
    if (internals?.def) {
      const definition = internals.def
      if (
        definition.type === 'tuple' &&
        tupleMinimumLength(definition) === undefined
      ) {
        throw new Error(
          'Cannot transport unverified Zod tuple length constraints',
        )
      }
      if ((value as z.ZodType)._zod?.toJSONSchema) {
        throw new Error(
          'Cannot transport an unverified custom Zod JSON Schema projection',
        )
      }
      if (
        definition.type === 'string' &&
        Array.isArray(definition.checks) &&
        definition.checks.some((check) =>
          ['min_length', 'max_length', 'length_equals'].includes(
            check?._zod?.def?.check,
          ),
        )
      ) {
        throw new Error(
          'Cannot transport Zod string length constraints: Zod counts UTF-16 units and JSON Schema counts Unicode code points',
        )
      }
      if (definition.pattern instanceof RegExp && definition.pattern.flags) {
        throw new Error('Cannot transport Zod regex flags as JSON Schema')
      }
      if (
        ['default', 'prefault', 'catch', 'transform', 'pipe'].includes(
          String(definition.type),
        ) ||
        definition.coerce === true ||
        ['custom', 'overwrite'].includes(String(definition.check))
      ) {
        throw new Error(
          `Cannot transport executable Zod ${String(definition.type ?? definition.check)} behavior as JSON Schema`,
        )
      }
      inspect(definition)
      if (definition.type === 'lazy' && typeof definition.getter === 'function')
        inspect(definition.getter())
    } else {
      for (const child of Object.values(value)) inspect(child)
    }
  }
  inspect(schema)
}

/** Registration checks the declared shape, never an arbitrary sample string. */
export function jsonSchemaAllowsString(schema: JsonSchema): boolean {
  const shape = inlineLocalRefs(schema)
  const allows = (member: JsonSchema): boolean => {
    if (typeof member === 'boolean') return member
    if (
      member.type !== undefined &&
      member.type !== 'string' &&
      !(Array.isArray(member.type) && member.type.includes('string'))
    )
      return false
    if (
      Array.isArray(member.enum) &&
      !member.enum.some((value) => typeof value === 'string')
    )
      return false
    if ('const' in member && typeof member.const !== 'string') return false
    if (
      Array.isArray(member.allOf) &&
      !member.allOf.every((child) => allows(child as JsonSchema))
    )
      return false
    for (const key of ['anyOf', 'oneOf']) {
      if (
        Array.isArray(member[key]) &&
        !member[key].some((child) => allows(child as JsonSchema))
      )
        return false
    }
    const excluded = member.not
    if (
      excluded === true ||
      (excluded &&
        typeof excluded === 'object' &&
        (Object.keys(excluded).length === 0 ||
          (Object.keys(excluded).length === 1 &&
            (excluded as Record<string, unknown>).type === 'string')))
    )
      return false
    return true
  }
  return allows(shape)
}
