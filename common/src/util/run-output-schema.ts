import { assertInlineJsonSchema, jsonSchemaToZod } from './json-schema'

export const MAX_RUN_OUTPUT_SCHEMA_BYTES = 64 * 1024

/** Descriptor-only JSON capture: caller getters and serialization hooks are never evaluated. */
export function captureRunOutputSchema(value: unknown) {
  const ancestors = new Set<object>()
  let nodes = 0,
    bytes = 0
  const charge = (count: number) => {
    bytes += count
    if (bytes > MAX_RUN_OUTPUT_SCHEMA_BYTES)
      throw new Error('Run output schema exceeds the 64 KiB byte limit.')
  }
  const copy = (node: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 32)
      throw new Error('Run output schema exceeds its structural limit.')
    if (
      node === null ||
      typeof node === 'boolean' ||
      (typeof node === 'number' && Number.isFinite(node))
    ) {
      charge(String(node).length)
      return node
    }
    if (typeof node === 'string') {
      if (node.length > MAX_RUN_OUTPUT_SCHEMA_BYTES)
        throw new Error('Run output schema exceeds the 64 KiB byte limit.')
      charge(Buffer.byteLength(JSON.stringify(node), 'utf8'))
      return node
    }
    if (!node || typeof node !== 'object' || ancestors.has(node))
      throw new Error('Run output schema must be acyclic JSON data.')
    const array = Array.isArray(node)
    if (
      !array &&
      Object.getPrototypeOf(node) !== Object.prototype &&
      Object.getPrototypeOf(node) !== null
    )
      throw new Error('Run output schema must contain only plain JSON data.')
    ancestors.add(node)
    const descriptors = Object.getOwnPropertyDescriptors(node)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => typeof key !== 'string'))
      throw new Error('Run output schema cannot contain symbol properties.')
    const target: unknown[] | Record<string, unknown> = array
      ? []
      : Object.create(null)
    const length = array ? (descriptors.length?.value as number) : undefined
    let entries = 0
    charge(2)
    for (const key of keys as string[]) {
      if (array && key === 'length') continue
      const descriptor = descriptors[key]!
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        throw new Error(
          'Run output schema cannot contain accessors or hidden properties.',
        )
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length!))
        throw new Error(
          'Run output schema arrays must contain only indexed JSON values.',
        )
      if (entries++) charge(1)
      if (!array) charge(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1)
      const entry = copy(descriptor.value, depth + 1)
      if (array) (target as unknown[]).push(entry)
      else (target as Record<string, unknown>)[key] = entry
    }
    if (array && entries !== length)
      throw new Error('Run output schema arrays cannot be sparse.')
    ancestors.delete(node)
    return target
  }
  const snapshot = copy(value, 0)
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    (snapshot as { type?: unknown }).type !== 'object'
  )
    throw new Error('Run output schema must have type: "object".')
  // Serialize only the checked copy, whose members have no executable hooks.
  const schema = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>
  assertInlineJsonSchema(schema)
  const validator = jsonSchemaToZod(schema)
  const freeze = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    for (const child of Object.values(node)) freeze(child)
    Object.freeze(node)
  }
  freeze(schema)
  return { schema, validator }
}
