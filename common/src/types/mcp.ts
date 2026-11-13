import { z } from 'zod/v4'

export const mcpConfigStdioSchema = z.strictObject({
  type: z.literal('stdio').default('stdio'),
  command: z.string(),
  args: z
    .string()
    .array()
    .default(() => []),
  env: z.record(z.string(), z.string()).default(() => ({})),
})

export const mcpConfigRemoteSchema = z.strictObject({
  type: z.enum(['http', 'sse']).default('http'),
  url: z.string(),
  params: z.record(z.string(), z.string()).default(() => ({})),
  headers: z.record(z.string(), z.string()).default(() => ({})),
})

export const mcpConfigSchema = z.union([
  mcpConfigRemoteSchema,
  mcpConfigStdioSchema,
])
export type MCPConfig = z.infer<typeof mcpConfigSchema>

/**
 * Who authored an MCP server config; decides whether `$VAR` references are
 * expanded from this process's environment ('user'/'project' = trusted local,
 * 'client' = untrusted protocol peer).
 *
 * Defined here (a Client-free module) rather than in `mcp/client.ts` so
 * trusted-loader modules (e.g. the SDK's `load-mcp-config`) can name it
 * WITHOUT pulling the `@modelcontextprotocol/sdk` `Client` type graph — and
 * its zod-v3 `objectOutputType` reference — into the SDK's public `.d.ts`
 * bundle. The full origin-registry semantics live in `common/src/mcp/client.ts`,
 * which re-exports this type.
 */
export type MCPConfigOrigin = 'user' | 'project' | 'client'

export type McpCatalogTool = {
  name: string
  description?: string
  inputSchema: unknown
  [key: string]: unknown
}

/** Discovery status belongs to a host connection generation, not a tool label. */
export type McpToolCatalog = {
  kind: 'mcp_tool_catalog'
  schemaVersion: 1
  generation: number | null
  complete: boolean
  incompleteReasons: string[]
  tools: McpCatalogTool[]
  origin?: MCPConfigOrigin
}
