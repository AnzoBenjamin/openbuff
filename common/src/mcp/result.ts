import type { JSONObject, JSONValue } from '../types/json'
import type { ToolResultOutput } from '../types/messages/content-part'

export type McpWireToolResult = {
  content: unknown[]
  isError?: boolean
  structuredContent?: unknown
  _meta?: unknown
  [key: string]: unknown
}

/** The original MCP wire result, retained as one JSON transport part. */
export type McpToolResultEnvelope = JSONObject & {
  kind: 'mcp_tool_result'
  schemaVersion: 1
  content: JSONValue[]
  isError?: boolean
  structuredContent?: JSONValue
  _meta?: JSONValue
  /** Peer fields whose names collide with the application envelope. */
  wireReservedFields?: JSONObject
}

const reservedWireFields = [
  'kind',
  'schemaVersion',
  'wireReservedFields',
] as const

function record(value: unknown): JSONObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JSONObject)
    : undefined
}

export function isMcpToolResultEnvelope(
  value: unknown,
): value is McpToolResultEnvelope {
  const item = record(value)
  return (
    item?.kind === 'mcp_tool_result' &&
    item.schemaVersion === 1 &&
    Array.isArray(item.content)
  )
}

export function mcpToolResult(result: McpWireToolResult): ToolResultOutput[] {
  // MCP responses are JSON-RPC values. Clone through JSON so optional undefined
  // properties cannot escape the shared JSON output contract.
  const wire = JSON.parse(JSON.stringify(result)) as JSONObject
  const collisions = Object.fromEntries(
    reservedWireFields
      .filter((key) => Object.hasOwn(wire, key))
      .map((key) => [key, wire[key]]),
  )
  return [
    {
      type: 'json',
      value: {
        ...wire,
        kind: 'mcp_tool_result',
        schemaVersion: 1,
        ...(Object.keys(collisions).length
          ? { wireReservedFields: collisions }
          : {}),
      },
    },
  ]
}

/** Recover the exact peer result, including all envelope-name collisions. */
export function getMcpWireResult(
  result: McpToolResultEnvelope,
): McpWireToolResult {
  const {
    kind: _kind,
    schemaVersion: _version,
    wireReservedFields,
    ...wire
  } = result
  for (const key of reservedWireFields)
    if (wireReservedFields && Object.hasOwn(wireReservedFields, key))
      wire[key] = wireReservedFields[key]
  return wire as McpWireToolResult
}

function omitBytes(item: JSONObject, key: string): JSONObject {
  const bytes = item[key]
  if (typeof bytes !== 'string') return item
  const { [key]: _bytes, ...metadata } = item
  return {
    ...metadata,
    openbuffOmission: {
      reason: 'media_bytes_omitted',
      encoding: 'base64',
      length: bytes.length,
    },
  }
}

/** Retain content order, identity and status without serializing binary bytes. */
export function projectMcpToolResultForDisplay(
  result: McpToolResultEnvelope,
): McpToolResultEnvelope {
  return {
    ...result,
    content: result.content.map((content) => {
      const item = record(content)
      if (!item) return content
      if (item.type === 'image' || item.type === 'audio')
        return omitBytes(item, 'data')
      if (item.type === 'resource') {
        const resource = record(item.resource)
        if (resource) return { ...item, resource: omitBytes(resource, 'blob') }
      }
      return content
    }),
  }
}

/** Provider JSON describes media; the actual bytes occur only in file parts. */
export function projectMcpToolResultForProvider(
  result: McpToolResultEnvelope,
): ToolResultOutput[] {
  const media: ToolResultOutput[] = []
  for (const content of result.content) {
    const item = record(content)
    if (!item) continue
    if (
      (item.type === 'image' || item.type === 'audio') &&
      typeof item.data === 'string' &&
      typeof item.mimeType === 'string'
    ) {
      media.push({ type: 'media', data: item.data, mediaType: item.mimeType })
    } else if (item.type === 'resource') {
      const resource = record(item.resource)
      if (resource && typeof resource.blob === 'string') {
        media.push({
          type: 'media',
          data: resource.blob,
          mediaType:
            typeof resource.mimeType === 'string'
              ? resource.mimeType
              : 'application/octet-stream',
        })
      }
    }
  }
  return [
    { type: 'json', value: projectMcpToolResultForDisplay(result) },
    ...media,
  ]
}
