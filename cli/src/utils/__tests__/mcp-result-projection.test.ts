import { expect, test } from 'bun:test'
import {
  mcpToolResult,
  projectMcpToolResultForDisplay,
} from '@codebuff/common/mcp/result'
import type { McpToolResultEnvelope } from '@codebuff/common/mcp/result'
import { runPersistenceCodec } from '../persistence-codec'
import {
  hasMultipartError,
  getStructuredErrorMessages,
} from '../tool-result-normalizer'
import {
  sanitizeForChatPersistence,
  sanitizeForDebugLog,
} from '../payload-sanitizer'
import { updateToolBlockWithOutput } from '../message-block-helpers'
import { outcomeForTool } from '../output-outcome'
import type { ToolContentBlock } from '../../types/chat'

const peerName = 'peer/read' as ToolContentBlock['toolName']

test('standalone persistence workers apply the same MCP byte omission as the canonical projection', async () => {
  const output = mcpToolResult({
    isError: true,
    _meta: { generation: 4 },
    content: [
      {
        type: 'image',
        data: 'aW1hZ2U=',
        mimeType: 'image/png',
        annotations: { audience: ['user'] },
      },
      { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
      {
        type: 'resource',
        resource: {
          uri: 'file:///blob',
          blob: 'YmxvYg==',
          mimeType: 'application/octet-stream',
        },
      },
      {
        type: 'resource',
        resource: { uri: 'file:///text', text: 'retained text' },
      },
    ],
  })
  const envelope = (output[0] as { type: 'json'; value: McpToolResultEnvelope })
    .value
  const expected = [
    { type: 'json' as const, value: projectMcpToolResultForDisplay(envelope) },
  ]
  expect(
    await runPersistenceCodec<typeof expected>('parse', JSON.stringify(output)),
  ).toEqual(expected)
  const serialized = await runPersistenceCodec<{ messages: string }>(
    'serialize',
    { runState: {}, messages: output },
  )
  expect(JSON.parse(serialized.messages)).toEqual(expected)
  expect(sanitizeForChatPersistence(output)).toEqual(expected)
})

test('CLI recognizes authoritative empty/media-only MCP failures and ignores nested error data', () => {
  for (const content of [
    [],
    [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
  ]) {
    const output = mcpToolResult({ content, isError: true })
    expect(hasMultipartError(output)).toBe(true)
    expect(getStructuredErrorMessages(output)).toEqual([
      'The MCP tool reported an error result.',
    ])
    expect(
      outcomeForTool({
        toolName: peerName,
        outputRaw: output,
        lifecycle: 'succeeded',
      }).label,
    ).toBe('failed')
  }
  const success = mcpToolResult({
    content: [],
    isError: false,
    structuredContent: { errorMessage: 'nested data', isError: true },
    errorMessage: 'outer extension data',
    status: 'error',
  })
  expect(hasMultipartError(success)).toBe(false)
  expect(getStructuredErrorMessages(success)).toEqual([])
  expect(
    outcomeForTool({
      toolName: peerName,
      outputRaw: success,
      lifecycle: 'succeeded',
    }).tone,
  ).toBe('neutral')
})

test('CLI retains MCP content/status metadata while omitting bytes from cards, persistence and debug logs', () => {
  const output = mcpToolResult({
    isError: true,
    structuredContent: { count: 3 },
    _meta: { label: 'peer' },
    content: [
      { type: 'text', text: 'failure text' },
      {
        type: 'image',
        data: 'aW1hZ2U=',
        mimeType: 'image/png',
        annotations: { audience: ['user'] },
      },
      { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
      {
        type: 'resource',
        resource: {
          uri: 'file:///blob',
          blob: 'YmxvYg==',
          mimeType: 'application/octet-stream',
        },
      },
      {
        type: 'resource',
        resource: { uri: 'file:///text', text: 'retained resource text' },
      },
    ],
  })
  const block = {
    type: 'tool',
    toolCallId: 'call',
    toolName: peerName,
    input: {},
  } as ToolContentBlock
  const updated = updateToolBlockWithOutput([block], {
    toolCallId: 'call',
    toolOutput: output,
  })[0] as ToolContentBlock
  for (const projected of [
    updated.outputRaw,
    sanitizeForChatPersistence(output),
    sanitizeForDebugLog(output),
  ]) {
    const text = JSON.stringify(projected)
    for (const bytes of ['aW1hZ2U=', 'YXVkaW8=', 'YmxvYg=='])
      expect(text).not.toContain(bytes)
    expect(text).toContain('media_bytes_omitted')
    expect(text).toContain('image/png')
    expect(text).toContain('audio/wav')
    expect(text).toContain('file:///blob')
    expect(text).toContain('retained resource text')
    expect(text).toContain('failure text')
    expect(hasMultipartError(projected)).toBe(true)
  }
  expect(JSON.stringify(output)).toContain('aW1hZ2U=')
})
