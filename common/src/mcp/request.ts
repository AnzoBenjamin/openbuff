import type { ZodType, ZodTypeDef } from 'zod/v3'
import type { McpToolCatalog } from '../types/mcp'
import type { ToolResultOutput } from '../types/messages/content-part'

/** Host request facade without the concrete vendor Client declaration graph. */
export type McpToolCallParams = {
  name: string
  arguments?: Record<string, unknown>
  _meta?: { progressToken?: string | number; [key: string]: unknown }
  [key: string]: unknown
}

export type McpRequestOptions = {
  signal?: AbortSignal
  timeout?: number
  resetTimeoutOnProgress?: boolean
  maxTotalTimeout?: number
  onprogress?: (progress: { progress: number; total?: number; message?: string; [key: string]: unknown }) => void
  relatedRequestId?: string | number
  resumptionToken?: string
  onresumptiontoken?: (token: string) => void
}

// Runtime defaults still use the vendor wire schema. Both current and legacy
// result schemas have this object envelope; their validation stays in Client.
export type McpToolCallResponse = {
  isError?: boolean
  structuredContent?: unknown
  [key: string]: unknown
}
export type McpToolCallArguments = [
  params: McpToolCallParams,
  resultSchema?: ZodType<McpToolCallResponse, ZodTypeDef, unknown>,
  options?: McpRequestOptions,
]

export type McpToolCatalogOptions = {
  signal?: AbortSignal
  maxPages?: number
  maxTools?: number
  timeoutMs?: number
}

export type MediatedMcpRequest = Readonly<{
  id: string
  generation: number | undefined
  listToolCatalog(options?: McpToolCatalogOptions): Promise<McpToolCatalog>
  callTool(...args: McpToolCallArguments): Promise<ToolResultOutput[]>
  release(): void
}>
