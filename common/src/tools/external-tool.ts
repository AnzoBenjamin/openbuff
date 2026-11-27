import { createHash } from 'node:crypto'
import { z } from 'zod/v4'

export const externalToolIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('custom'), toolName: z.string() }),
  z.object({
    kind: z.literal('mcp'),
    serverName: z.string(),
    toolName: z.string(),
    reference: z.string().optional(),
    generation: z.number().int().nonnegative().nullable().optional(),
  }),
])
export type ExternalToolIdentity = z.infer<typeof externalToolIdentitySchema>

export const externalToolPathParameterSchema = z.object({
  /** JSON pointer; '*' selects the members of an array at that position. */
  pointer: z.string(),
  access: z.enum(['read', 'write']),
})
export type ExternalToolPathParameter = z.infer<
  typeof externalToolPathParameterSchema
>

const reservedPrefix = 'openbuff_ext_'
const ordinaryName = /^[a-zA-Z0-9_-]{1,64}$/

/** Canonical identity stays in the descriptor; dispatch never splits aliases. */
export function externalToolAlias(
  identity: ExternalToolIdentity,
  forceEncoded = false,
): string {
  if (
    identity.kind === 'custom' &&
    ordinaryName.test(identity.toolName) &&
    !identity.toolName.startsWith(reservedPrefix) &&
    !['__proto__', 'constructor', 'prototype'].includes(identity.toolName) &&
    !forceEncoded
  )
    return identity.toolName
  if (identity.kind === 'mcp' && !forceEncoded) {
    const legacy = `${identity.serverName}__${identity.toolName}`
    if (
      ordinaryName.test(legacy) &&
      !identity.serverName.includes('__') &&
      !identity.toolName.includes('__') &&
      !legacy.startsWith(reservedPrefix)
    )
      return legacy
  }
  const canonical =
    identity.kind === 'custom'
      ? ['custom', identity.toolName]
      : ['mcp', identity.serverName, identity.toolName]
  return `${reservedPrefix}${identity.kind}_${createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32)}`
}

/** Check only host-declared path effects. Routes, regexes and other strings are data. */
export function selectExternalToolPaths(
  input: unknown,
  declarations: ExternalToolPathParameter[],
): Array<{
  access: 'read' | 'write'
  path: string
}> {
  const selected: Array<{ access: 'read' | 'write'; path: string }> = []
  if (declarations.length > 64)
    throw new Error('Too many declared tool path parameters.')
  for (const declaration of declarations) {
    if (declaration.access !== 'read' && declaration.access !== 'write')
      throw new Error('Invalid declared tool path access.')
    if (
      !declaration.pointer.startsWith('/') ||
      declaration.pointer.length > 1_024
    )
      throw new Error(
        'A declared tool path parameter must be a bounded JSON pointer.',
      )
    const parts = declaration.pointer
      .slice(1)
      .split('/')
      .map((part) => {
        if (/~(?![01])/.test(part))
          throw new Error('Invalid escape in declared tool path parameter.')
        return part.replace(/~1/g, '/').replace(/~0/g, '~')
      })
    if (parts.length > 16)
      throw new Error('Declared tool path parameter exceeds the depth limit.')
    let values: unknown[] = [input]
    for (const part of parts) {
      const next: unknown[] = []
      for (const value of values) {
        if (part === '*') {
          if (!Array.isArray(value))
            throw new Error('A declared tool path wildcard requires an array.')
          if (value.length + next.length > 1_000)
            throw new Error('Declared tool paths exceed the allocation limit.')
          next.push(...value)
        } else if (
          value &&
          typeof value === 'object' &&
          Object.hasOwn(value, part)
        ) {
          next.push((value as Record<string, unknown>)[part])
        }
        if (next.length > 1_000)
          throw new Error('Declared tool paths exceed the allocation limit.')
      }
      values = next
    }
    for (const value of values) {
      if (typeof value !== 'string' || value.length === 0)
        throw new Error(
          'A declared tool path parameter must contain a nonempty string.',
        )
      selected.push({ access: declaration.access, path: value })
      if (selected.length > 1_000)
        throw new Error('Too many declared tool paths.')
    }
  }
  return selected
}
