import { describe, expect, test } from 'bun:test'

import {
  toToolCallStreamChunkPayload,
  withTransportTruncation,
  type ToolCallStreamChunk,
} from '../llm'

describe('ToolCallStreamChunk contract helpers', () => {
  // Annotated (not `as const`) so the 'tool-call' literal narrows
  // contextually and the object is a real ToolCallStreamChunk.
  const basePayload: ToolCallStreamChunk = {
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'read_files',
    input: { paths: ['a.ts'] },
  }

  test('withTransportTruncation sets the stream-only marker', () => {
    const marked = withTransportTruncation(basePayload)
    expect(marked.transportTruncated).toBe(true)
  })

  test('toToolCallStreamChunkPayload strips the marker and preserves fields', () => {
    const chunk = withTransportTruncation(basePayload)
    const payload = toToolCallStreamChunkPayload(chunk)
    expect(Object.hasOwn(payload, 'transportTruncated')).toBe(false)
    expect(payload).toEqual({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'read_files',
      input: { paths: ['a.ts'] },
    })
  })

  test('toToolCallStreamChunkPayload fills in type for a history tool-call object', () => {
    const payload = toToolCallStreamChunkPayload({
      toolCallId: 'call-2',
      toolName: 'edit_transaction',
      input: { edits: [] },
    })
    expect(payload.type).toBe('tool-call')
    expect(payload.toolCallId).toBe('call-2')
    expect(Object.hasOwn(payload, 'transportTruncated')).toBe(false)
  })

  test('toToolCallStreamChunkPayload forwards fields the AI SDK adds beyond the payload pick', () => {
    // ToolCallPart may carry fields the published payload pick does not
    // declare. The copy-and-strip helper must forward them unchanged so
    // widening the chunk type never narrows the persisted tool-call shape.
    const enriched: ToolCallStreamChunk & {
      experimental_content: { type: 'text'; text: string }[]
    } = {
      ...basePayload,
      transportTruncated: true,
      experimental_content: [{ type: 'text', text: 'partial' }],
    }
    const payload = toToolCallStreamChunkPayload(enriched)
    expect(payload.type).toBe('tool-call')
    expect(payload.experimental_content).toEqual([
      { type: 'text', text: 'partial' },
    ])
    expect(Object.hasOwn(payload, 'transportTruncated')).toBe(false)
  })

  test('withTransportTruncation marks while preserving every payload field', () => {
    const chunk: ToolCallStreamChunk = {
      ...basePayload,
      providerOptions: { 'test-provider': { requestId: 'req-7' } },
    }
    const marked = withTransportTruncation(chunk)
    expect(marked).toEqual({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'read_files',
      input: { paths: ['a.ts'] },
      providerOptions: { 'test-provider': { requestId: 'req-7' } },
      transportTruncated: true,
    })
  })

  test('toToolCallStreamChunkPayload forwards providerOptions while stripping the marker', () => {
    const chunk: ToolCallStreamChunk = {
      ...basePayload,
      transportTruncated: true,
      providerOptions: { 'test-provider': { requestId: 'req-7' } },
    }
    const payload = toToolCallStreamChunkPayload(chunk)
    expect(payload.providerOptions).toEqual({
      'test-provider': { requestId: 'req-7' },
    })
    expect(Object.hasOwn(payload, 'transportTruncated')).toBe(false)
  })
})
