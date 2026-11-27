import { describe, expect, test } from 'bun:test'
import { committedMutationFixture } from '@codebuff/common/testing/fixtures/file-mutation'
import {
  buildFileMutationResultFromReceiptV1,
  getConfirmedAppliedActionsV1,
} from '@codebuff/common/tools/results/filesystem'
import { getExactContentHash } from '@codebuff/common/util/content-hash'
import { recordToolEvidenceInTaskMemory } from '../task-memory'

const output = (value: unknown) => [{ type: 'json', value }]
const derive = (value: unknown, callId = 'authority-regression') =>
  recordToolEvidenceInTaskMemory({
    toolName: 'edit_transaction',
    callId,
    output: output(value),
    now: 1_000,
  })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function committed(files: Array<{ path: string; content: string }>) {
  const mutation = committedMutationFixture(files)
  mutation.authorityReceipt!.callId = 'authority-regression'
  return mutation
}

function failedRollback(outcome: 'applied' | 'not_applied' | 'unconfirmed') {
  const afterHash = getExactContentHash(
    outcome === 'applied' ? 'owned-after\n' : 'foreign-partial\n',
  )
  return buildFileMutationResultFromReceiptV1({
    kind: 'commit_receipt',
    version: 1,
    receiptId: 'rollback-receipt',
    operationId: 'rollback-operation',
    callId: 'authority-regression',
    authorityTier: 'conditional_commit',
    status: 'rollback_incomplete',
    actions: [
      {
        actionId: 'rollback-action',
        index: 0,
        action: 'update',
        path: 'a.txt',
        status: 'rollback_failed',
        beforeHash: getExactContentHash('before\n'),
        afterHash,
        forward: { outcome, afterHashes: { 'a.txt': afterHash } },
        error: {
          code: 'rollback_incomplete',
          message: 'Injected failed rollback',
          retryable: false,
        },
      },
    ],
    finalHashes: { 'a.txt': afterHash },
  })
}

describe('task memory mutation receipt authority', () => {
  test('records a complete backed edit with the exact stored freshness hash', () => {
    const mutation = committed([{ path: 'a.txt', content: 'after\r\n' }])
    const memory = derive(mutation)!
    expect(memory.editsMade).toEqual(['a.txt'])
    expect(memory.evidence.filter((row) => row.kind === 'edit')).toMatchObject([
      {
        path: 'a.txt',
        freshnessHash: getExactContentHash('after\r\n').slice('sha256:'.length),
      },
    ])
  })

  test('refuses an applied label without receipt backing', () => {
    const { authorityReceipt: _receipt, ...unbacked } = committed([
      { path: 'a.txt', content: 'after\n' },
    ])
    expect(getConfirmedAppliedActionsV1(unbacked)).toEqual([])
    expect(derive(unbacked)).toBeUndefined()
  })

  test('refuses spliced identity, mismatched final bytes and unconfirmed backing', () => {
    const backed = committed([{ path: 'a.txt', content: 'after\n' }])
    const wrongIdentity = clone(backed)
    wrongIdentity.authorityReceipt!.operationId = 'foreign-operation'
    const wrongFinal = clone(backed)
    wrongFinal.authorityReceipt!.finalHashes['a.txt'] =
      getExactContentHash('foreign\n')
    const wrongForward = clone(backed)
    wrongForward.authorityReceipt!.actions[0].forward!.outcome = 'unconfirmed'
    for (const malformed of [wrongIdentity, wrongFinal, wrongForward]) {
      expect(getConfirmedAppliedActionsV1(malformed)).toEqual([])
      expect(derive(malformed)).toBeUndefined()
    }
  })

  test('failed rollback does not promote refused or uncertain forward bytes', () => {
    for (const outcome of ['not_applied', 'unconfirmed'] as const) {
      const mutation = failedRollback(outcome)
      expect(mutation.actions[0].forward!.outcome).toBe(outcome)
      expect(getConfirmedAppliedActionsV1(mutation)).toEqual([])
      expect(derive(mutation)).toBeUndefined()
    }
  })

  test('successful rollback suppresses the original applied forward evidence', () => {
    const receipt = committed([
      { path: 'a.txt', content: 'after\n' },
    ]).authorityReceipt!
    receipt.status = 'rolled_back'
    receipt.actions[0].status = 'rolled_back'
    receipt.actions[0].afterHash = receipt.actions[0].beforeHash
    receipt.finalHashes['a.txt'] = receipt.actions[0].beforeHash
    const mutation = buildFileMutationResultFromReceiptV1(receipt)
    expect(mutation.actions[0].forward!.outcome).toBe('applied')
    expect(mutation.outcome).toBe('rolled_back')
    expect(getConfirmedAppliedActionsV1(mutation)).toEqual([])
    expect(derive(mutation)).toBeUndefined()
  })

  test('failed rollback retains proven surviving forward work', () => {
    const mutation = failedRollback('applied')
    expect(
      getConfirmedAppliedActionsV1(mutation).map((row) => row.path),
    ).toEqual(['a.txt'])
    expect(derive(mutation)!.editsMade).toEqual(['a.txt'])
  })

  test('refuses a valid receipt replayed under another tool call', () => {
    for (const mutation of [
      committed([{ path: 'a.txt', content: 'after\n' }]),
      failedRollback('applied'),
    ]) {
      expect(getConfirmedAppliedActionsV1(mutation)).toHaveLength(1)
      expect(derive(mutation, 'foreign-call')).toBeUndefined()
      expect(derive(mutation)!.editsMade).toEqual(['a.txt'])
    }
  })

  test('partial transaction retains the survivor and excludes its unknown sibling', () => {
    const survivor = failedRollback('applied').authorityReceipt!
    const unknown = failedRollback('unconfirmed').authorityReceipt!.actions[0]
    const afterHash = unknown.afterHash
    const mutation = buildFileMutationResultFromReceiptV1({
      ...survivor,
      actions: [
        survivor.actions[0],
        {
          ...unknown,
          actionId: 'unknown-action',
          index: 1,
          path: 'b.txt',
          forward: {
            outcome: 'unconfirmed',
            afterHashes: { 'b.txt': afterHash },
          },
        },
      ],
      finalHashes: { ...survivor.finalHashes, 'b.txt': afterHash },
    })
    expect(mutation.actions.map((row) => row.forward!.outcome)).toEqual([
      'applied',
      'unconfirmed',
    ])
    expect(
      getConfirmedAppliedActionsV1(mutation).map((row) => row.path),
    ).toEqual(['a.txt'])
    const memory = derive(mutation)!
    expect(memory.editsMade).toEqual(['a.txt'])
    expect(
      memory.evidence
        .filter((row) => row.kind === 'edit')
        .map((row) => row.path),
    ).toEqual(['a.txt'])
  })
})
