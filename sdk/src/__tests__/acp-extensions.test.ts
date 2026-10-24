import { describe, expect, test } from 'bun:test'

import {
  ACP_EXTENSION_METHODS,
  acpExtensionSchemas,
  compileAcpExtensionJsonSchemas,
} from '../services/acp/extensions'

describe('acp extension contracts', () => {
  test('declares exactly the three namespaced Openbuff methods in order', () => {
    expect(ACP_EXTENSION_METHODS).toEqual([
      'openbuff/getReceipts',
      'openbuff/askUser',
      'openbuff/gateState',
    ])
  })

  test('getReceipts params and result validate against the receipt shape', () => {
    const { params, result } = acpExtensionSchemas['openbuff/getReceipts']

    expect(params.safeParse({ sessionId: 's-1', limit: 5 }).success).toBe(true)
    expect(params.safeParse({ sessionId: 's-1' }).success).toBe(true)
    expect(params.safeParse({}).success).toBe(false)
    expect(params.safeParse({ sessionId: 42 }).success).toBe(false)

    // Results mirror the editor agent's mutationReceipts receipt shape.
    expect(
      result.safeParse({
        receipts: [
          {
            operationId: 'op-1',
            receiptId: 'r-1',
            paths: ['/a.ts'],
            actionIds: ['act-1'],
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      result.safeParse({ receipts: [{ operationId: 'op-1' }] }).success,
    ).toBe(false)
    expect(result.safeParse({}).success).toBe(false)
  })

  test('askUser params and result validate', () => {
    const { params, result } = acpExtensionSchemas['openbuff/askUser']

    expect(
      params.safeParse({
        sessionId: 's-1',
        question: 'Go?',
        choices: ['y', 'n'],
      }).success,
    ).toBe(true)
    expect(
      params.safeParse({ sessionId: 's-1', question: 'Go?' }).success,
    ).toBe(false)
    expect(params.safeParse({ sessionId: 's-1' }).success).toBe(false)

    expect(result.safeParse({ answer: 'y' }).success).toBe(true)
    expect(result.safeParse({}).success).toBe(false)
    expect(result.safeParse({ answer: 7 }).success).toBe(false)
  })

  test('gateState params and result validate, currentTask nullable', () => {
    const { params, result } = acpExtensionSchemas['openbuff/gateState']

    expect(params.safeParse({ sessionId: 's-1' }).success).toBe(true)
    expect(params.safeParse({}).success).toBe(false)

    expect(
      result.safeParse({ phase: 'gated', currentTask: null }).success,
    ).toBe(true)
    expect(
      result.safeParse({ phase: 'gated', currentTask: 'task-1' }).success,
    ).toBe(true)
    expect(result.safeParse({ phase: 'gated' }).success).toBe(false)
    expect(
      result.safeParse({ phase: 'gated', currentTask: 3 }).success,
    ).toBe(false)
  })

  test('compileAcpExtensionJsonSchemas emits params/result JSON schemas in method order, deterministically', () => {
    const first = compileAcpExtensionJsonSchemas()
    const second = compileAcpExtensionJsonSchemas()

    expect(Object.keys(first)).toEqual([...ACP_EXTENSION_METHODS])

    // Deterministic serialization: byte-stable across calls with no
    // Date/Map/exotic-type leakage.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(JSON.parse(JSON.stringify(first))).toEqual(first)

    const gate = first['openbuff/gateState'] as {
      params: { type: string; required: string[] }
      result: { type: string; required: string[] }
    }
    expect(gate.params.type).toBe('object')
    expect(gate.params.required).toEqual(['sessionId'])
    expect(gate.result.type).toBe('object')
    // currentTask is nullable but still required in the result shape.
    expect(gate.result.required).toEqual(['phase', 'currentTask'])

    // Optional `limit` must not appear in required.
    const receipts = first['openbuff/getReceipts'] as {
      params: { required: string[]; properties: Record<string, unknown> }
    }
    expect(receipts.params.required).toEqual(['sessionId'])
    expect(receipts.params.properties).toHaveProperty('limit')

    const askUser = first['openbuff/askUser'] as {
      params: { required: string[] }
    }
    expect(askUser.params.required).toEqual([
      'sessionId',
      'question',
      'choices',
    ])
  })
})
