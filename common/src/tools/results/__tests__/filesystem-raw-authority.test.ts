import { describe, expect, test } from 'bun:test'

import { captureTextDocument, getRawReadBasis } from '../../../util/byte-text'
import {
  encodeReadCapabilityToken,
  getExactContentHash,
} from '../../../util/content-hash'
import {
  buildFileMutationResultFromReceiptV1,
  commitReceiptV1Schema,
  fileMutationResultV1Schema,
  reconcileFileMutationResultV1,
} from '../filesystem'

const issuer = { projectId: '/project', path: 'a.ts', runId: 'run-1' }

function authority(
  source = '\uFEFFa😀e\u0301\r\nb\n',
  afterContent = source,
  version: 'v3' | 'v4' = 'v4',
  scope: 'whole' | 'lines' = 'whole',
) {
  const document = captureTextDocument(source)
  const rawBasis = getRawReadBasis(
    document,
    1,
    document.maxCapabilityLine,
    scope,
  )
  const token = encodeReadCapabilityToken({
    startLine: 1,
    endLine: document.maxCapabilityLine,
    hash: document.observationHash,
    scope: issuer,
    ...(version === 'v4' ? { rawBasis } : {}),
  })
  const afterHash = getExactContentHash(afterContent)
  const receipt = commitReceiptV1Schema.parse({
    kind: 'commit_receipt',
    version: 1,
    receiptId: 'receipt-1',
    operationId: 'operation-1',
    callId: 'call-1',
    authorityTier: 'conditional_commit',
    status: 'committed',
    workspaceRevision: 1,
    workspaceSnapshotId: 'snapshot-1',
    actions: [
      {
        actionId: 'action-1',
        index: 0,
        action: 'update',
        path: 'a.ts',
        status: 'committed',
        beforeHash: getExactContentHash('before'),
        afterHash,
      },
    ],
    finalHashes: { 'a.ts': afterHash },
  })
  const capability = {
    kind: 'whole_file' as const,
    version: 1 as const,
    token,
    snapshot: {
      kind: 'file_snapshot' as const,
      version: 1 as const,
      canonicalPath: '/project/a.ts',
      contentHash: afterHash,
      sizeBytes: Buffer.byteLength(afterContent),
      encoding: 'utf8' as const,
      readGeneration: 1,
    },
  }
  const anchor = {
    startLine: 1,
    endLine: document.maxCapabilityLine,
    contentHash: document.observationHash,
    readCapability: token,
    ...(version === 'v4' ? { rawBasis } : {}),
  }
  const handlerResult = buildFileMutationResultFromReceiptV1(
    receipt,
    [],
    [capability],
    new Map([[0, afterContent]]),
    new Map([[0, anchor]]),
  )
  return { receipt, handlerResult, capability, anchor }
}

function reconcile(value: ReturnType<typeof authority>) {
  expect(
    fileMutationResultV1Schema.safeParse(value.handlerResult).success,
  ).toBe(true)
  return reconcileFileMutationResultV1({
    lifecycle: {
      kind: 'tool_lifecycle',
      version: 1,
      callId: 'call-1',
      sequence: 1,
      state: 'succeeded',
    },
    operationId: 'operation-1',
    receipt: value.receipt,
    handlerResult: value.handlerResult,
    capabilityScope: { projectId: issuer.projectId, runId: issuer.runId },
  }).mutation
}

describe('confirmed raw after-state authority', () => {
  test('preserves a genuine complete BOM, mixed-EOL and paired-Unicode v4 authority', () => {
    const value = authority()
    const mutation = reconcile(value)
    expect(mutation.outcome).toBe('applied')
    expect(mutation.actions[0]?.afterContent).toBe(
      value.handlerResult.actions[0]?.afterContent,
    )
    expect(mutation.actions[0]?.editAnchor).toEqual(value.anchor)
    expect(mutation.freshCapabilities).toEqual([value.capability])
  })

  for (const [name, build] of [
    ['authenticated legacy token', () => authority('a\n', 'a\n', 'v3')],
    ['full-looking lines basis', () => authority('a\n', 'a\n', 'v4', 'lines')],
    [
      'raw-only BOM and EOL mismatch',
      () => authority('a\nb\n', '\uFEFFa\r\nb\n'),
    ],
    ['lossy high surrogate content', () => authority('\uFFFD\n', '\uD800\n')],
    ['lossy low surrogate content', () => authority('\uFFFD\n', '\uDC00\n')],
    [
      'unsigned anchor provenance',
      () => {
        const value = authority()
        value.handlerResult.actions[0]!.editAnchor!.rawBasis!.view =
          'adapter_bytes'
        return value
      },
    ],
    [
      'missing anchor raw basis',
      () => {
        const value = authority()
        delete value.handlerResult.actions[0]!.editAnchor!.rawBasis
        return value
      },
    ],
  ] as const) {
    test(`retains committed effect truth but rejects ${name} as fresh authority`, () => {
      const value = build()
      const mutation = reconcile(value)
      expect(mutation.outcome).toBe('applied')
      expect(mutation.actions[0]?.afterHash).toBe(
        value.receipt.actions[0]?.afterHash,
      )
      expect(mutation.actions[0]?.afterContent).toBeUndefined()
      expect(mutation.actions[0]?.editAnchor).toBeUndefined()
      expect(mutation.freshCapabilities).toEqual([])
    })
  }
})
