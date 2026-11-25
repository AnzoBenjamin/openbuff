import { describe, expect, test } from 'bun:test'

import { executeCustomToolCall } from '../tools/tool-executor'
import { getFileProcessingValues } from '../tools/handlers/tool/write-file'
import { getMCPToolData } from '../mcp'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { CustomToolDefinitions } from '@codebuff/common/util/file'

async function dispatch(options: {
  planOnly: boolean
  fromHandleSteps?: boolean
  mcp?: boolean
  nativeAlias?: boolean
}) {
  const alias = options.nativeAlias
    ? 'read_files'
    : options.mcp
      ? 'fixture__write'
      : 'custom_write'
  const definition = {
    inputSchema: { type: 'object', properties: {} },
    endsAgentStep: false,
    identity: options.mcp
      ? {
          kind: 'mcp' as const,
          serverName: 'fixture',
          toolName: 'write',
          generation: 1,
        }
      : { kind: 'custom' as const, toolName: alias },
  }
  const chunks: Array<Record<string, unknown>> = []
  const forwarded: unknown[] = []
  const toolResults: unknown[] = []
  let discoveries = 0
  const agentTemplate = {
    id: 'external-plan-fixture',
    displayName: 'External plan fixture',
    toolNames: [alias],
    programmaticToolNames: [],
    spawnableAgents: [],
    mcpServers: options.mcp
      ? { fixture: { type: 'stdio', command: 'unused', args: [], env: {} } }
      : {},
    programmaticConfig: { planOnly: options.planOnly },
  } as unknown as AgentTemplate
  await executeCustomToolCall({
    toolName: alias,
    toolCallId: 'external-call',
    input: {},
    fromHandleSteps: options.fromHandleSteps,
    agentTemplate,
    agentState: {
      agentId: 'fixture-agent',
      runId: 'fixture-run',
      ancestorRunIds: [],
    },
    runId: 'fixture-run',
    ancestorRunIds: [],
    clientSessionId: 'fixture-session',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fileContext: {
      projectRoot: '/fixture',
      customToolDefinitions: options.mcp ? {} : { [alias]: definition },
    },
    fileProcessingState: getFileProcessingValues({}),
    signal: new AbortController().signal,
    previousToolCallFinished: Promise.resolve(),
    toolCalls: [],
    toolCallsToAddToMessageHistory: [],
    toolResults,
    toolResultsToAddToMessageHistory: [],
    onResponseChunk: (chunk: unknown) => {
      chunks.push(chunk as Record<string, unknown>)
    },
    requestToolCall: async (input: unknown) => {
      forwarded.push(input)
      return { output: [{ type: 'json', value: { applied: true } }] }
    },
    requestMcpToolData: async () => {
      discoveries++
      return [
        {
          name: 'write',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        },
      ]
    },
  } as any)
  return { chunks, forwarded, discoveries, toolResults }
}

describe('plan-lineage external tools fail closed', () => {
  for (const mcp of [false, true]) {
    for (const fromHandleSteps of [false, true]) {
      test(`${mcp ? 'MCP' : 'custom'} fromHandleSteps=${fromHandleSteps} is refused before discovery or dispatch`, async () => {
        const result = await dispatch({ planOnly: true, mcp, fromHandleSteps })
        expect(result.forwarded).toEqual([])
        expect(result.discoveries).toBe(0)
        expect(result.chunks).toHaveLength(1)
        expect(result.chunks[0]).toMatchObject({
          type: 'error',
          errorCode: 'plan_mode_read_only',
        })
        expect(result.chunks.some((chunk) => chunk.type === 'tool_call')).toBe(
          false,
        )
        if (fromHandleSteps)
          expect(result.toolResults).toMatchObject([
            {
              content: [
                { type: 'json', value: { errorCode: 'plan_mode_read_only' } },
              ],
            },
          ])
      })
    }
  }

  test('a custom tool named like a native read tool is not a read-only capability', async () => {
    const result = await dispatch({ planOnly: true, nativeAlias: true })
    expect(result.forwarded).toEqual([])
    expect(result.chunks[0]?.errorCode).toBe('plan_mode_read_only')
  })

  test.each([false, true])(
    'execute-mode external dispatch remains available (MCP=%s)',
    async (mcp) => {
      const result = await dispatch({ planOnly: false, mcp })
      expect(result.forwarded).toHaveLength(1)
      expect(result.chunks.some((chunk) => chunk.type === 'tool_call')).toBe(
        true,
      )
      expect(result.chunks.some((chunk) => chunk.errorCode !== undefined)).toBe(
        false,
      )
    },
  )

  test('plan-only discovery withholds custom and MCP schemas without launching a server', async () => {
    let discoveries = 0
    const definitions: CustomToolDefinitions = {
      custom_write: {
        inputSchema: { type: 'object' },
        endsAgentStep: false,
        identity: { kind: 'custom', toolName: 'custom_write' },
      },
    }
    const result = await getMCPToolData({
      toolNames: ['custom_write'],
      mcpServers: {
        fixture: { type: 'stdio', command: 'unused', args: [], env: {} },
      },
      writeTo: definitions,
      planOnly: true,
      requestMcpToolData: async () => {
        discoveries++
        return []
      },
    })
    expect(result).toEqual({})
    expect(definitions.custom_write).toBeDefined()
    expect(discoveries).toBe(0)
  })
})
