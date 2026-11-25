import { describe, expect, test } from 'bun:test'
import { captureRunOutputSchema } from '../run-output-schema'

describe('nonexecutable run-output schema capture', () => {
  test('nonenumerable toJSON cannot replace the inspected schema or execute', () => {
    let calls = 0
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    }
    Object.defineProperty(schema, 'toJSON', {
      value() {
        calls++
        return { type: 'object' }
      },
    })
    expect(() => captureRunOutputSchema(schema)).toThrow()
    expect(calls).toBe(0)
  })
  test('accessors are rejected without evaluating their returned schema', () => {
    let calls = 0
    const schema = { type: 'object' }
    Object.defineProperty(schema, 'properties', {
      enumerable: true,
      get() {
        calls++
        return { answer: { type: 'string' } }
      },
    })
    expect(() => captureRunOutputSchema(schema)).toThrow()
    expect(calls).toBe(0)
  })
  test('symbol and sparse-array data refuse instead of disappearing during capture', () => {
    const symbol = { type: 'object', [Symbol('hidden')]: { value: 'not-json' } }
    const sparse = { type: 'object', required: new Array(2) }
    for (const schema of [symbol, sparse])
      expect(() => captureRunOutputSchema(schema)).toThrow()
  })
  test('literal $ref output property names and literal annotation data are not schema references', () => {
    const schema = {
      type: 'object',
      properties: {
        $ref: { type: 'string' },
        payload: { const: { $ref: 'literal-value' } },
      },
      required: ['$ref', 'payload'],
      additionalProperties: false,
      examples: [{ $ref: 'https://never-fetch.invalid/ordinary-data' }],
    }
    const captured = captureRunOutputSchema(schema)
    expect(captured.schema).toEqual(schema)
    expect(
      captured.validator.safeParse({
        $ref: 'ordinary-field',
        payload: { $ref: 'literal-value' },
      }).success,
    ).toBe(true)
    expect(
      captured.validator.safeParse({
        $ref: 2,
        payload: { $ref: 'literal-value' },
      }).success,
    ).toBe(false)
  })

  test('plain parsed JSON retains its exact prototype-like property names and validation constraints', () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}',
    )
    const captured = captureRunOutputSchema(schema)
    expect(captured.schema).toEqual(schema)
    expect(captured.validator.safeParse({ answer: 'valid' }).success).toBe(true)
    expect(captured.validator.safeParse({ wrong: 1 }).success).toBe(false)
    expect(Object.isFrozen(captured.schema)).toBe(true)
  })
})
