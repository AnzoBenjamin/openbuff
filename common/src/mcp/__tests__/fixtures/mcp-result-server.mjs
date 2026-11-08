import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'

// Separate from the catalog fixture: test calls return the supplied wire result.
const callSchema = z.object({
  method: z.literal('tools/call'),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
})
const server = new Server(
  { name: 'openbuff-result-fixture', version: '0.0.0' },
  { capabilities: { tools: {} } },
)
server.setRequestHandler(callSchema, async (request) => {
  if (request.params.name === 'protocol_error')
    throw new McpError(ErrorCode.InvalidParams, 'fixture protocol failure')
  return request.params.arguments.result
})
await server.connect(new StdioServerTransport())
