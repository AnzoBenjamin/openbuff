import { describe, expect, it } from 'bun:test'

import { recallContextParams } from '../tool/recall-context'

/**
 * recall_context carries two mutually-alternative retrieval modes: `query`
 * (text search over the archived transcript) and `toolCallId` (exact-ID
 * retrieval of one archived tool body — the recovery path the eviction
 * tombstone names). The input object must reject the NEITHER-present shape
 * and keep the documented query-only example valid.
 */
describe('recall_context inputSchema (query or toolCallId)', () => {
  const { inputSchema } = recallContextParams

  it('keeps the documented query-only example valid (byte-identical input)', () => {
    // Same object the tool description embeds as its example: the schema
    // change must not invalidate the documented query-only usage.
    const example = { query: 'magic-context eviction floor' }
    expect(inputSchema.safeParse(example).success).toBe(true)
  })

  it('accepts toolCallId alone (exact retrieval, no text search)', () => {
    expect(inputSchema.safeParse({ toolCallId: 'call-abc-123' }).success).toBe(
      true,
    )
  })

  it('accepts both params (the handler resolves the exact-ID path)', () => {
    expect(
      inputSchema.safeParse({
        query: 'eviction floor',
        toolCallId: 'call-abc-123',
      }).success,
    ).toBe(true)
  })

  it('rejects input with NEITHER param', () => {
    const result = inputSchema.safeParse({})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Provide query (text search) or toolCallId (exact retrieval).',
      )
    }
  })

  it('still enforces the query bounds when query is present', () => {
    expect(inputSchema.safeParse({ query: 'x' }).success).toBe(false)
    expect(inputSchema.safeParse({ query: 'x'.repeat(513) }).success).toBe(
      false,
    )
  })
})
