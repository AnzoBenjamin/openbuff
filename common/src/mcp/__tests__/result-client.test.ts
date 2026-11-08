import { expect, test } from 'bun:test'
import { join } from 'node:path'

import { callMCPTool, getMCPClient, markMCPConfigOrigin } from '../client'
import { getMcpWireResult, isMcpToolResultEnvelope } from '../result'

test('real MCP tools/call retains empty, structured, resource and media outcomes', async () => {
  const config = {
    type: 'stdio' as const,
    command: process.execPath,
    args: [join(import.meta.dir, 'fixtures', 'mcp-result-server.mjs')],
    env: {},
  }
  markMCPConfigOrigin(config, 'project')
  const clientId = await getMCPClient(config)
  const richContent = [
    { type: 'text', text: 'detail', annotations: { audience: ['user'] } },
    {
      type: 'image',
      data: 'aW1hZ2U=',
      mimeType: 'image/png',
      _meta: { label: 'image' },
    },
    { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
    {
      type: 'resource',
      resource: {
        uri: 'file:///note.txt',
        text: 'plain resource text',
        mimeType: 'text/plain',
      },
    },
    {
      type: 'resource',
      resource: {
        uri: 'file:///data.bin',
        blob: 'YmxvYg==',
        mimeType: 'application/octet-stream',
      },
    },
    {
      type: 'resource_link',
      uri: 'file:///linked.txt',
      name: 'linked',
      title: 'Linked note',
      description: 'Retain link metadata',
      mimeType: 'text/plain',
    },
  ]
  const results = [
    {
      content: [],
      isError: true,
      kind: 'vendor-result',
      schemaVersion: 42,
      wireReservedFields: { detail: 'peer extension data' },
    },
    { content: [], isError: true },
    {
      content: [],
      structuredContent: {
        count: 7,
        nested: { isError: true, errorMessage: 'data' },
      },
    },
    { content: [], isError: true, structuredContent: { reason: 'refused' } },
    {
      content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
      isError: true,
    },
    {
      content: richContent,
      isError: false,
      structuredContent: { count: 6 },
      _meta: { receipt: 'peer-metadata' },
    },
    {
      content: richContent,
      isError: true,
      structuredContent: { reason: 'partial failure' },
      _meta: { receipt: 'error-metadata' },
    },
  ]
  for (const result of results) {
    const output = await callMCPTool(clientId, {
      name: 'echo_result',
      arguments: { result },
    })
    const restored = JSON.parse(JSON.stringify(output))
    expect(restored).toEqual(output)
    expect(isMcpToolResultEnvelope(restored[0].value)).toBe(true)
    expect(getMcpWireResult(restored[0].value)).toEqual(result)
    expect(restored[0].value).toMatchObject({
      kind: 'mcp_tool_result',
      schemaVersion: 1,
    })
  }
  await expect(
    callMCPTool(clientId, { name: 'protocol_error' }),
  ).rejects.toThrow('fixture protocol failure')
}, 15_000)
