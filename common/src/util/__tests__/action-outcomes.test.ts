import { expect, test } from 'bun:test'
import { committedMutationFixture } from '../../testing/fixtures/file-mutation'
import { buildFileMutationResultFromReceiptV1 } from '../../tools/results/filesystem'
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

test('lost commit acknowledgement is uncertain but retains confirmed effect paths', () => {
  const { authorityReceipt: receipt } = committedMutationFixture([
    { path: 'a.ts', content: 'after' },
    { path: 'b.ts', content: 'after' },
  ])
  const mutation = buildFileMutationResultFromReceiptV1({
    ...receipt!,
    transactionId: 'tx-1',
    status: 'acknowledgement_pending',
    actions: receipt!.actions.map((action) => ({
      ...action, status: 'forward_verified',
    })),
  })
  const value = JSON.parse(JSON.stringify(mutation))
  expect(classifyActionOutput('edit_transaction', [{ type: 'json', value }]))
    .toMatchObject({
      outcome: 'uncertain',
      cause: { code: 'recovery_required' },
      effect: {
        status: 'partial',
        confirmedPaths: ['a.ts', 'b.ts'],
        receiptIds: [receipt!.receiptId],
        forward: receipt!.actions.map((action) => ({
          actionId: action.actionId, ...action.forward,
        })),
      },
    })
  delete value.authorityReceipt
  expect(classifyActionOutput('edit_transaction', [{ type: 'json', value }]))
    .toMatchObject({
      outcome: 'uncertain',
      effect: { status: 'unobserved', confirmedPaths: [] },
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
