import {
  buildFileMutationResultFromReceiptV1,
  commitReceiptV1Schema,
} from '../../tools/results/filesystem'
import { getContentHash, getExactContentHash } from '../../util/content-hash'

/** Schema-valid authority fixture; product acceptance uses real mutation adapters. */
export function committedMutationFixture(
  files: Array<{ path: string; content: string }>,
) {
  const actions = files.map((file, index) => {
    const afterHash = getExactContentHash(file.content)
    return {
      actionId: `fixture-action-${index}`,
      index,
      action: 'update' as const,
      path: file.path,
      status: 'committed' as const,
      beforeHash: getExactContentHash('before'),
      afterHash,
      forward: {
        outcome: 'applied' as const,
        afterHashes: { [file.path]: afterHash },
      },
    }
  })
  const receipt = commitReceiptV1Schema.parse({
    kind: 'commit_receipt',
    version: 1,
    receiptId: 'fixture-receipt',
    operationId: 'fixture-operation',
    callId: 'fixture-call',
    authorityTier: 'conditional_commit',
    status: 'committed',
    actions,
    finalHashes: Object.fromEntries(
      actions.map((action) => [action.path, action.afterHash]),
    ),
  })
  return buildFileMutationResultFromReceiptV1(
    receipt,
    [],
    [],
    new Map(files.map((file, index) => [index, file.content])),
    new Map(
      files.map((file, index) => [
        index,
        {
          startLine: 1,
          endLine: file.content.replaceAll('\r\n', '\n').split('\n').length,
          contentHash: getContentHash(file.content),
          readCapability: 'cap.v3.fixture-only',
        },
      ]),
    ),
  )
}
