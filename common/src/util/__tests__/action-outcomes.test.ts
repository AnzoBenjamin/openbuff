import { expect, test } from 'bun:test'
import { committedMutationFixture } from '../../testing/fixtures/file-mutation'
import { classifyActionOutput, hashActionInput } from '../action-outcomes'

test('unbacked application cannot confirm an action or an effect', () => {
  const { authorityReceipt: _receipt, ...unbacked } = committedMutationFixture([
    { path: 'a.ts', content: 'after' },
  ])
  const result = classifyActionOutput('write_file', [
    { type: 'json', value: unbacked },
  ])
  expect(result.outcome).toBe('uncertain')
  expect(result.effect.status).not.toBe('confirmed')
  expect(result.effect.confirmedPaths).toEqual([])
})

test('canonical observed mutation confirms exact paths and forward evidence', () => {
  const mutation = committedMutationFixture([
    { path: 'a.ts', content: 'after' },
  ])
  const result = classifyActionOutput('write_file', [
    { type: 'json', value: mutation },
  ])
  expect(result.outcome).toBe('succeeded')
  expect(result.effect).toMatchObject({
    status: 'confirmed',
    confirmedPaths: ['a.ts'],
    receiptIds: ['fixture-receipt'],
    forward: [{ outcome: 'applied' }],
  })
})

test('input identity is stable across key order and distinguishes values', () => {
  expect(hashActionInput('custom', { b: 1, a: 2 })).toBe(
    hashActionInput('custom', { a: 2, b: 1 }),
  )
  expect(hashActionInput('custom', { a: 2 })).not.toBe(
    hashActionInput('custom', { a: 1 }),
  )
  const circular: Record<string, unknown> = {}
  circular.self = circular
  expect(() => hashActionInput('custom', circular)).not.toThrow()
})

test('a failed multipart result retains its confirmed mutation in either order', () => {
  const mutation = {
    type: 'json',
    value: committedMutationFixture([{ path: 'a.ts', content: 'after' }]),
  }
  const failure = {
    type: 'json',
    value: { exitCode: 1, stdout: 'post-edit validation failed' },
  }
  for (const parts of [
    [mutation, failure],
    [failure, mutation],
  ]) {
    const result = classifyActionOutput('custom_edit_and_check', parts)
    expect(result.outcome).toBe('failed')
    expect(result.cause?.code).toBe('nonzero_exit')
    expect(result.effect).toMatchObject({
      status: 'confirmed',
      confirmedPaths: ['a.ts'],
      receiptIds: ['fixture-receipt'],
    })
  }
})

test('all confirmed mutations in a multipart result retain their paths', () => {
  const result = classifyActionOutput(
    'custom_edit',
    ['a.ts', 'b.ts'].map((path) => ({
      type: 'json',
      value: committedMutationFixture([{ path, content: 'after' }]),
    })),
  )
  expect(result.outcome).toBe('succeeded')
  expect(result.effect.confirmedPaths).toEqual(['a.ts', 'b.ts'])
  expect(result.effect.forward).toHaveLength(2)
})
