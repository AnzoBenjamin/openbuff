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
