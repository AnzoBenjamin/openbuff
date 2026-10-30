/**
 * Fixture: a minimal MCP server served over stdio, used by client.test.ts to
 * exercise the real connect -> runningClients -> listMCPTools path of
 * common/src/mcp/client.ts without any network. It answers initialize and
 * tools/list, rejecting any paged cursor (so tests can pin the rejection
 * path), and exits when its stdin closes (when the test process exits).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'openbuff-test-fixture', version: '0.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  // `params` may be absent on some tools/list requests (no cursor); guard
  // so the success path never crashes on a missing params object.
  if (request.params?.cursor) {
    throw new Error('fixture: cursor rejections are intentional')
  }
  return {
    tools: [
      {
        name: 'fixture_tool',
        description: 'A fixture tool.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }
})

await server.connect(new StdioServerTransport())
