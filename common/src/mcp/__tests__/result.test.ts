import { expect, test } from 'bun:test'
import { convertCbToModelMessages } from '../../util/messages'
import { classifyActionOutput } from '../../util/action-outcomes'
import {
  getMcpWireResult,
  mcpToolResult,
  projectMcpToolResultForDisplay,
} from '../result'
import type { McpToolResultEnvelope } from '../result'

test('allowed peer extension fields survive every reserved envelope-name collision', () => {
  const wire = {
    content: [],
    isError: true,
    kind: 'vendor-result',
    schemaVersion: 42,
    wireReservedFields: {
      kind: 'another peer value',
      detail: 'original metadata',
    },
    structuredContent: { reason: 'original failure' },
  }
  const output = mcpToolResult(wire)
  const envelope =
    output[0].type === 'json'
      ? (output[0].value as McpToolResultEnvelope)
      : undefined
  expect(envelope).toMatchObject({
    kind: 'mcp_tool_result',
    schemaVersion: 1,
    wireReservedFields: {
      kind: 'vendor-result',
      schemaVersion: 42,
      wireReservedFields: wire.wireReservedFields,
    },
  })
  expect(getMcpWireResult(JSON.parse(JSON.stringify(envelope)))).toEqual(wire)
  expect(classifyActionOutput('peer/read', output).outcome).toBe('failed')
  const displayed = projectMcpToolResultForDisplay(envelope!)
  expect(getMcpWireResult(displayed)).toEqual(wire)
})

test('provider receives structured/text/resource detail and binary parts without duplicate base64 JSON', () => {
  const wire = {
    isError: true,
    content: [
      { type: 'text', text: 'peer failure detail' },
      {
        type: 'image',
        data: 'aW1hZ2U=',
        mimeType: 'image/png',
        annotations: { audience: ['assistant'] },
      },
      { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
      {
        type: 'resource',
        resource: {
          uri: 'file:///text',
          text: 'resource body',
          mimeType: 'text/plain',
        },
      },
      {
        type: 'resource',
        resource: {
          uri: 'file:///blob',
          blob: 'YmxvYg==',
          mimeType: 'application/octet-stream',
        },
      },
      {
        type: 'resource_link',
        uri: 'file:///link',
        name: 'link',
        description: 'link description',
      },
    ],
    structuredContent: { detail: 'structured reason' },
    _meta: { generation: 3 },
  }
  const output = mcpToolResult(wire)
  const model = convertCbToModelMessages({
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolName: 'peer/read',
            toolCallId: 'call',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        toolName: 'peer/read',
        toolCallId: 'call',
        content: output,
      },
    ],
    includeCacheControl: false,
  })
  const tools = model.filter((message) => message.role === 'tool')
  const toolJson = JSON.stringify(tools)
  expect(toolJson).toContain('structured reason')
  expect(toolJson).toContain('peer failure detail')
  expect(toolJson).toContain('resource body')
  expect(toolJson).toContain('file:///blob')
  expect(toolJson).toContain('link description')
  expect(toolJson).toContain('media_bytes_omitted')
  for (const bytes of ['aW1hZ2U=', 'YXVkaW8=', 'YmxvYg=='])
    expect(toolJson).not.toContain(bytes)
  const files = model.flatMap((message) =>
    message.role === 'user' && Array.isArray(message.content)
      ? message.content
      : [],
  )
  expect(files).toEqual([
    { type: 'file', data: 'aW1hZ2U=', mediaType: 'image/png' },
    { type: 'file', data: 'YXVkaW8=', mediaType: 'audio/wav' },
    { type: 'file', data: 'YmxvYg==', mediaType: 'application/octet-stream' },
  ])
  expect(output).toEqual([
    {
      type: 'json',
      value: { ...wire, kind: 'mcp_tool_result', schemaVersion: 1 },
    },
  ])
})

test('MCP authoritative errors include empty failures; nested/extension data does not imply failure', () => {
  for (const content of [
    [],
    [{ type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' }],
  ]) {
    const output = mcpToolResult({ content, isError: true })
    expect(classifyActionOutput('peer/read', output).outcome).toBe('failed')
    expect(classifyActionOutput('peer/read', output).cause?.code).toBe(
      'mcp_tool_error',
    )
  }
  const successful = mcpToolResult({
    content: [],
    isError: false,
    structuredContent: {
      errorMessage: 'payload data',
      isError: true,
      status: 'failed',
    },
    errorMessage: 'outer extension data',
    status: 'error',
  })
  expect(classifyActionOutput('peer/read', successful).outcome).toBe(
    'succeeded',
  )
  const model = convertCbToModelMessages({
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolName: 'peer/read',
            toolCallId: 'empty',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        toolName: 'peer/read',
        toolCallId: 'empty',
        content: successful,
      },
    ],
    includeCacheControl: false,
  })
  expect(JSON.stringify(model)).toContain('payload data')
})

test('display omission retains content order, media MIME, resource URI and metadata', () => {
  const output = mcpToolResult({
    content: [
      {
        type: 'image',
        data: 'aW1hZ2U=',
        mimeType: 'image/png',
        _meta: { label: 'kept' },
      },
      {
        type: 'resource',
        resource: {
          uri: 'file:///blob',
          blob: 'YmxvYg==',
          mimeType: 'application/octet-stream',
          _meta: { label: 'resource' },
        },
      },
    ],
    isError: true,
  })
  const value = (output[0] as { type: 'json'; value: McpToolResultEnvelope })
    .value
  const display = projectMcpToolResultForDisplay(value)
  expect(display.content).toEqual([
    {
      type: 'image',
      mimeType: 'image/png',
      _meta: { label: 'kept' },
      openbuffOmission: {
        reason: 'media_bytes_omitted',
        encoding: 'base64',
        length: 8,
      },
    },
    {
      type: 'resource',
      resource: {
        uri: 'file:///blob',
        mimeType: 'application/octet-stream',
        _meta: { label: 'resource' },
        openbuffOmission: {
          reason: 'media_bytes_omitted',
          encoding: 'base64',
          length: 8,
        },
      },
    },
  ])
  expect(display.isError).toBe(true)
})
