import { describe, expect, test } from 'bun:test'
import { getMCPToolData } from '../mcp'
import { getToolSet } from '../tools/prompts'

describe('MCP tool schemas', () => {
  test('preserves the server schema through provider tool construction', async () => {
    const inputSchema = {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string', pattern: '^src/' },
          description: 'Source file paths',
        },
      },
      required: ['paths'],
      additionalProperties: false,
    }
    const definitions = await getMCPToolData({
      toolNames: [],
      mcpServers: {
        example: { type: 'stdio', command: 'unused', args: [], env: {} },
      },
      requestMcpToolData: async () => [
        { name: 'read', description: 'Read files', inputSchema },
      ],
    })
    const tools = await getToolSet({
      toolNames: [],
      additionalToolDefinitions: async () => definitions,
      agentTools: {},
      skills: {},
    })
    expect((tools.example__read.inputSchema as any).jsonSchema).toEqual(
      inputSchema,
    )
  })
})
