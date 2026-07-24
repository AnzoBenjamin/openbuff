import { describe, expect, it } from 'bun:test'

import { containsStructuralAuditReceipt } from '../audit-receipt'

describe('containsStructuralAuditReceipt', () => {
  it('returns true when a nested structuralReceipt.snapshot_id matches the expected id', () => {
    const value = {
      messageHistory: [
        { role: 'user', content: 'noise' },
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'more noise' },
            {
              type: 'json',
              value: {
                structuralReceipt: { snapshot_id: 'snapshot-1' },
              },
            },
          ],
        },
      ],
    }

    expect(containsStructuralAuditReceipt(value, 'snapshot-1')).toBe(true)
  })

  it('returns true for any structuralReceipt with a string snapshot_id when expected id is undefined or empty', () => {
    const value = [
      { structuralReceipt: { snapshot_id: 'whatever' } },
    ]

    expect(containsStructuralAuditReceipt(value)).toBe(true)
    expect(containsStructuralAuditReceipt(value, '')).toBe(true)
  })

  it('returns false when the expected id does not match any present receipt', () => {
    const value = {
      nested: {
        deep: { structuralReceipt: { snapshot_id: 'snapshot-1' } },
      },
    }

    expect(containsStructuralAuditReceipt(value, 'snapshot-2')).toBe(false)
  })

  it('returns false when there is no structuralReceipt anywhere', () => {
    expect(
      containsStructuralAuditReceipt({ foo: { bar: [{ baz: 1 }] } }, 'snapshot-1'),
    ).toBe(false)
  })

  it('terminates and returns false for a cyclic object graph without a receipt', () => {
    const value: Record<string, unknown> = { nested: {} }
    value.self = value
    ;(value.nested as Record<string, unknown>).parent = value

    expect(containsStructuralAuditReceipt(value, 'snapshot-1')).toBe(false)
  })

  it('returns true for a receipt nested deeper than the old depth limit', () => {
    let value: Record<string, unknown> = {
      structuralReceipt: { snapshot_id: 'snapshot-deep' },
    }
    for (let depth = 0; depth < 13; depth += 1) {
      value = { nested: value }
    }

    expect(containsStructuralAuditReceipt(value, 'snapshot-deep')).toBe(true)
  })

  it('returns false for non-object inputs', () => {
    expect(containsStructuralAuditReceipt(null, 'snapshot-1')).toBe(false)
    expect(containsStructuralAuditReceipt('snapshot-1', 'snapshot-1')).toBe(false)
    expect(containsStructuralAuditReceipt(42, 'snapshot-1')).toBe(false)
    expect(containsStructuralAuditReceipt(undefined, 'snapshot-1')).toBe(false)
  })

  it('finds a receipt via a shorter path even after the shared node was first reached deeper', () => {
    // Shared node holds the receipt a few levels below it.
    const shared: Record<string, unknown> = {
      level1: { level2: { structuralReceipt: { snapshot_id: 'deep-shared' } } },
    }

    // Build a deep wrapper chain (well over MAX_TRAVERSAL_DEPTH = 32 levels)
    // whose innermost node points at `shared`. From this side the receipt sits
    // beyond the depth budget, so this path alone cannot reach it.
    let deepChain: Record<string, unknown> = { shared }
    for (let depth = 0; depth < 40; depth += 1) {
      deepChain = { nested: deepChain }
    }

    // Deep chain is the FIRST key so Object.values visits it first, recording
    // `shared` at a deep depth; the short path is a LATER key that re-reaches
    // `shared` with a much shallower depth and enough budget to find it.
    const root: Record<string, unknown> = {
      deep: deepChain,
      short: shared,
    }

    expect(containsStructuralAuditReceipt(root, 'deep-shared')).toBe(true)
  })

  it('returns false when structuralReceipt exists but snapshot_id is missing or non-string', () => {
    expect(
      containsStructuralAuditReceipt({ structuralReceipt: {} }),
    ).toBe(false)
    expect(
      containsStructuralAuditReceipt({
        structuralReceipt: { snapshot_id: 123 },
      }),
    ).toBe(false)
    expect(
      containsStructuralAuditReceipt(
        { structuralReceipt: { snapshot_id: 123 } },
        'snapshot-1',
      ),
    ).toBe(false)
  })
})
