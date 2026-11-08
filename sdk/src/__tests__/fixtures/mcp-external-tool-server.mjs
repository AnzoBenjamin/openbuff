import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod/v4'

const names = JSON.parse(
  process.argv[2] ?? process.env.OPENBUFF_MCP_FIXTURE_TOOLS ?? '["echo"]',
)
const server = new Server(
  { name: 'openbuff-external-tool-fixture', version: '0.0.0' },
  { capabilities: { tools: {} } },
)
server.setRequestHandler(
  z.object({ method: z.literal('tools/list'), params: z.unknown().optional() }),
  async () => ({
    tools: names.map((name) => ({
      name,
      description: `Echo ${name}`,
      inputSchema: { type: 'object', additionalProperties: true },
    })),
  }),
)
server.setRequestHandler(
  z.object({
    method: z.literal('tools/call'),
    params: z.object({
      name: z.string(),
      arguments: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  async ({ params }) => {
    if (!names.includes(params.name)) throw new Error('Unknown canonical name')
    const value = {
      canonicalName: params.name,
      arguments: params.arguments ?? {},
      fixtureEnv: process.env.OPENBUFF_MCP_FIXTURE_VALUE ?? null,
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
    }
  },
)
await server.connect(new StdioServerTransport())
