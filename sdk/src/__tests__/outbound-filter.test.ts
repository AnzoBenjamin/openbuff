import { describe, expect, test } from 'bun:test'

import { sanitizeOutbound } from '../serve/outbound-filter'

describe('sanitizeOutbound', () => {
  test.each(['v3', 'v4'])('redacts a cap.%s capability token', (version) => {
    const token = `cap.${version}.1.2.ABCdef-._token`
    const out = sanitizeOutbound(`here is ${token} and more`)
    expect(out).not.toContain(`cap.${version}.`)
    expect(out).toBe('here is [REDACTED_CAPABILITY] and more')
  })

  test('redacts both capability versions inside JSON text', () => {
    const text = JSON.stringify({
      editAnchor: { readCapability: 'cap.v4.payload.signature' },
      message: 'Previous read: cap.v3.1.2.legacy-signature',
    })
    expect(JSON.parse(sanitizeOutbound(text))).toEqual({
      editAnchor: { readCapability: '[REDACTED_CAPABILITY]' },
      message: 'Previous read: [REDACTED_CAPABILITY]',
    })
  })

  test('redacts sk-or-v1 / sk-ant / sk-<20+> provider secrets', () => {
    expect(
      sanitizeOutbound('sk-or-v1-0123456789abcdef0123456789abcdef'),
    ).toBe('[REDACTED_SECRET]')
    expect(sanitizeOutbound('sk-ant-api03-abcdefghijklmnop')).toBe(
      '[REDACTED_SECRET]',
    )
    expect(sanitizeOutbound('sk-abcdefghijklmnopqrstuvwx')).toBe(
      '[REDACTED_SECRET]',
    )
  })

  test('redacts an env-pair value while keeping the KEY= prefix', () => {
    expect(
      sanitizeOutbound('OPENROUTER_API_KEY=sk-or-v1-secretsecretsecret'),
    ).toBe('OPENROUTER_API_KEY=[REDACTED_SECRET]')
    expect(sanitizeOutbound('ANTHROPIC_API_KEY=opaquevalue123')).toBe(
      'ANTHROPIC_API_KEY=[REDACTED_SECRET]',
    )
  })

  test('returns clean text unchanged', () => {
    const clean = 'The quick brown fox wrote some ordinary code.'
    expect(sanitizeOutbound(clean)).toBe(clean)
  })

  test('empty string is safe', () => {
    expect(sanitizeOutbound('')).toBe('')
  })
})
