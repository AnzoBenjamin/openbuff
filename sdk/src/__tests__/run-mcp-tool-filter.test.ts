import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { OpenbuffClient } from '../client'
import * as mcpClientModule from '@codebuff/common/mcp/client'
import * as databaseModule from '../impl/database'
import { beginSdkCallback, createSdkCallbackFixture } from './sdk-callback-fixture'

import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { MCPConfig } from '@codebuff/common/types/mcp'

const browserMcpConfig: MCPConfig = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'fake-mcp-server'],
  env: {},
}

const TEST_AGENT: AgentDefinition = {
  id: 'mcp-filter-agent',
  displayName: 'MCP Filter Agent',
  model: 'openai/gpt-5-mini',
  reasoningOptions: { effort: 'minimal' },
  mcpServers: {
    browser: browserMcpConfig,
  },
  toolNames: ['browser/browser_navigate', 'browser/browser_snapshot'],
  systemPrompt: 'Test MCP filtering.',
}

describe('MCP tool filtering', () => {
  let fixture: ReturnType<typeof createSdkCallbackFixture>
  beforeEach(() => {
    fixture = createSdkCallbackFixture('mcp-filter')
  })
  afterEach(() => {
    mock.restore()
    fixture.close()
  })

  it('returns only allowlisted MCP tools when an agent restricts toolNames', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')

    mcpClientModule.markMCPConfigOrigin(browserMcpConfig, 'project')
    const catalog = {
      kind: 'mcp_tool_catalog',
      schemaVersion: 1,
      generation: 1,
      complete: true,
      incompleteReasons: [],
      tools: [
        {
          name: 'browser_navigate',
          description: 'Navigate to a page',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'browser_snapshot',
          description: 'Capture snapshot',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'browser_click',
          description: 'Click an element',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    } satisfies Awaited<ReturnType<typeof mcpClientModule.listMCPToolCatalog>>
    const listToolCatalog = mock(async () => catalog)
    const getClient = spyOn(mcpClientModule, 'getMediatedMCPClient').mockResolvedValue({
      id: 'mcp-client-id',
      generation: 1,
      listToolCatalog,
      callTool: async () => [],
      release() {},
    })

    let filteredTools: Array<{ name: string }> = []

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestMcpToolData } = params
        const callback = await beginSdkCallback(params)
        const sessionState = callback.sessionState
        const template = sessionState.fileContext.agentTemplates?.[TEST_AGENT.id]
        const mcpConfig = template?.mcpServers?.browser
        const mcpReference = template?.mcpServerReferences?.browser
        if (!mcpConfig || !mcpReference)
          throw new Error('MCP fixture requires the run-owned server binding')

        const catalog = await requestMcpToolData({
          mcpConfig,
          mcpReference,
          mcpAgentId: TEST_AGENT.id,
          mcpServerName: 'browser',
          executionActor: {
            rootRunId: callback.runId,
            runId: callback.runId,
            agentId: callback.agentId,
          },
          signal: params.signal,
          toolNames: TEST_AGENT.toolNames!.filter((toolName) =>
            toolName.startsWith('browser/'),
          ).map((toolName) => toolName.slice('browser/'.length)),
        })
        filteredTools = Array.isArray(catalog) ? catalog : catalog.tools

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new OpenbuffClient({
      ...fixture.options,
      agentDefinitions: [TEST_AGENT],
    })

    const result = await client.run({
      agent: TEST_AGENT.id,
      prompt: 'List MCP tools',
    })

    expect(result.output).toMatchObject({ type: 'lastMessage' })
    expect(getClient).toHaveBeenCalledTimes(1)
    expect(listToolCatalog).toHaveBeenCalledTimes(1)
    expect(filteredTools.map((tool: { name: string }) => tool.name)).toEqual([
      'browser_navigate',
      'browser_snapshot',
    ])
  })
})
