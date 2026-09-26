import { createHash } from 'crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import type { MCPConfig } from '../types/mcp'
import type { ToolResultOutput } from '../types/messages/content-part'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  BlobResourceContents,
  CallToolResult,
  TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js'

const runningClients: Record<string, Client> = {}
const listToolsCache: Record<
  string,
  ReturnType<typeof Client.prototype.listTools>
> = {}

/**
 * Substitutes environment variable references ($VAR_NAME) in a string with their values.
 * Supports both simple replacement ("$VAR_NAME") and interpolation ("Bearer $VAR_NAME").
 */
function substituteEnvInValue(value: string): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, varName) => {
    const envValue = process.env[varName]
    if (envValue === undefined) {
      // Return original if env var not found
      return match
    }
    return envValue
  })
}

/**
 * Substitutes environment variable references in all values of a record.
 */
function substituteEnvInRecord(
  record: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = substituteEnvInValue(value)
  }
  return result
}

/**
 * Who authored an MCP server config. This decides whether `$VAR` references
 * are expanded from this process's environment.
 *
 * - `'user'` / `'project'`: written by the local user (home or project
 *   `mcp.json`, `openbuff.json`, local agent definitions). `$VAR` references
 *   in stdio `env` and remote `headers` are substituted from `process.env`, as
 *   before.
 * - `'client'`: supplied by a protocol peer, e.g. an ACP editor sending
 *   `session/new { mcpServers }`. Its values are used LITERALLY. Expanding them
 *   would let an untrusted peer read BYOK/OAuth secrets out of this process
 *   (e.g. an http server whose header is `Authorization: $OPENROUTER_API_KEY`
 *   pointing at an attacker URL).
 *
 * Origin is always supplied by the caller, never read from config content, so
 * an untrusted config cannot claim a trusted origin.
 */
export type MCPConfigOrigin = 'user' | 'project' | 'client'

const DEFAULT_MCP_CONFIG_ORIGIN: MCPConfigOrigin = 'project'

function originAllowsEnvSubstitution(origin: MCPConfigOrigin): boolean {
  return origin === 'user' || origin === 'project'
}

export type ResolvedMCPConfigValues =
  | {
      type: 'stdio'
      command: string
      args: string[]
      env: Record<string, string>
    }
  | {
      type: 'http' | 'sse'
      url: string
      params: Record<string, string>
      headers: Record<string, string>
    }

/**
 * Returns the effective values used to connect to an MCP server. `$VAR`
 * substitution applies only to trusted origins (see {@link MCPConfigOrigin}).
 */
export function resolveMCPConfigValues(
  config: MCPConfig,
  origin: MCPConfigOrigin,
): ResolvedMCPConfigValues {
  const substitute = originAllowsEnvSubstitution(origin)
  if (config.type === 'stdio') {
    return {
      type: 'stdio',
      command: config.command,
      args: [...config.args],
      env: substitute ? substituteEnvInRecord(config.env) : { ...config.env },
    }
  }
  if (config.type === 'http' || config.type === 'sse') {
    return {
      type: config.type,
      url: config.url,
      params: { ...config.params },
      headers: substitute
        ? substituteEnvInRecord(config.headers)
        : { ...config.headers },
    }
  }
  config.type satisfies never
  throw new Error(`Internal error: invalid MCP config type ${config.type}`)
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hashRecordValues(
  record: Record<string, string>,
): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    // Header/env names are normalized first; later duplicates deterministically win.
    normalized[key.toLowerCase()] = stableHash(value)
  }

  return Object.fromEntries(
    Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)),
  )
}

export function getMCPClientCacheKey(
  config: MCPConfig,
  options?: { origin?: MCPConfigOrigin },
): string {
  const origin = options?.origin ?? DEFAULT_MCP_CONFIG_ORIGIN
  const resolved = resolveMCPConfigValues(config, origin)
  // Origin is part of the identity so a client-origin connection never
  // reuses a running client created for a trusted origin (or vice versa).
  if (resolved.type === 'stdio') {
    return JSON.stringify({
      origin,
      command: resolved.command,
      args: resolved.args,
      env: hashRecordValues(resolved.env),
    })
  }
  return JSON.stringify({
    origin,
    type: resolved.type,
    url: resolved.url,
    params: resolved.params,
    headers: hashRecordValues(resolved.headers),
  })
}

export async function getMCPClient(
  config: MCPConfig,
  options?: { origin?: MCPConfigOrigin },
): Promise<string> {
  const origin = options?.origin ?? DEFAULT_MCP_CONFIG_ORIGIN
  let key = getMCPClientCacheKey(config, { origin })
  if (key in runningClients) {
    return key
  }

  const resolved = resolveMCPConfigValues(config, origin)
  let transport: Transport
  if (resolved.type === 'stdio') {
    transport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      stderr: 'ignore',
    })
  } else {
    const url = new URL(resolved.url)
    for (const [key, value] of Object.entries(resolved.params)) {
      url.searchParams.set(key, value)
    }
    const headers = resolved.headers
    if (resolved.type === 'http') {
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers,
        },
      })
    } else if (resolved.type === 'sse') {
      transport = new SSEClientTransport(url, {
        requestInit: {
          headers,
        },
      })
    } else {
      resolved.type satisfies never
      throw new Error(
        `Internal error: invalid MCP config type ${resolved.type}`,
      )
    }
  }

  const client = new Client({
    name: 'openbuff',
    version: '1.0.0',
  })

  await client.connect(transport)
  runningClients[key] = client

  return key
}

export function listMCPTools(
  clientId: string,
  ...args: Parameters<typeof Client.prototype.listTools>
): ReturnType<typeof Client.prototype.listTools> {
  const client = runningClients[clientId]
  if (!client) {
    throw new Error(`listTools: client not found with id: ${clientId}`)
  }
  if (!listToolsCache[clientId]) {
    listToolsCache[clientId] = client.listTools(...args)
  }
  return listToolsCache[clientId]
}

function getResourceData(
  resource: TextResourceContents | BlobResourceContents,
): string {
  if ('text' in resource) return resource.text as string
  if ('blob' in resource) return resource.blob as string
  return ''
}

export async function callMCPTool(
  clientId: string,
  ...args: Parameters<typeof Client.prototype.callTool>
): Promise<ToolResultOutput[]> {
  const client = runningClients[clientId]
  if (!client) {
    throw new Error(`callTool: client not found with id: ${clientId}`)
  }
  const callResult = await client.callTool(...args)
  const result = callResult as CallToolResult
  const content = result.content

  return content.map((c: (typeof content)[number]) => {
    if (c.type === 'text') {
      return {
        type: 'json',
        value: c.text,
      } satisfies ToolResultOutput
    }
    if (c.type === 'audio') {
      return {
        type: 'media',
        data: c.data,
        mediaType: c.mimeType,
      } satisfies ToolResultOutput
    }
    if (c.type === 'image') {
      return {
        type: 'media',
        data: c.data,
        mediaType: c.mimeType,
      } satisfies ToolResultOutput
    }
    if (c.type === 'resource') {
      return {
        type: 'media',
        data: getResourceData(c.resource),
        mediaType: c.resource.mimeType ?? 'text/plain',
      } satisfies ToolResultOutput
    }
    const fallbackValue =
      'uri' in c && typeof (c as { uri: unknown }).uri === 'string'
        ? (c as { uri: string }).uri
        : JSON.stringify(c)
    return {
      type: 'json',
      value: fallbackValue,
    } satisfies ToolResultOutput
  })
}
