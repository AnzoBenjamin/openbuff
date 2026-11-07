import { describe, expect, test } from 'bun:test'
import { buildFileMutationResultFromReceiptV1 } from '@codebuff/common/tools/results/filesystem'

import {
  isImplementorAgent,
  getImplementorDisplayName,
} from '../implementor-helpers'

describe('implementor helpers', () => {
  test('identifies the default editor implementor', () => {
    expect(
      isImplementorAgent({ agentType: 'editor-implementor', blocks: [] }),
    ).toBe(true)
    expect(isImplementorAgent({ agentType: 'file-picker', blocks: [] })).toBe(
      false,
    )
  })

  test('formats default implementor names', () => {
    expect(getImplementorDisplayName('editor-implementor')).toBe('Implementor')
    expect(getImplementorDisplayName('editor-implementor', 1)).toBe(
      'Implementor #2',
    )
  })
})

test('canonical implementor transactions retain confirmed create/move paths and every patch history item', async () => {
  const { getFileStatsFromBlocks, buildActivityTimeline } =
    await import('../implementor-helpers')
  const mutation = buildFileMutationResultFromReceiptV1({
    kind: 'commit_receipt',
    version: 1,
    receiptId: 'receipt-implementor',
    operationId: 'op-implementor',
    callId: 'canonical',
    authorityTier: 'conditional_commit',
    status: 'failed',
    actions: [
      {
        actionId: 'create',
        index: 0,
        action: 'create',
        path: 'src/new.ts',
        status: 'committed',
        beforeHash: null,
        afterHash: 'new',
        forward: { outcome: 'applied', afterHashes: { 'src/new.ts': 'new' } },
      },
      {
        actionId: 'move',
        index: 1,
        action: 'move',
        path: 'src/old.ts',
        destinationPath: 'src/moved.ts',
        status: 'committed',
        beforeHash: 'old',
        afterHash: 'moved',
        forward: {
          outcome: 'applied',
          afterHashes: { 'src/old.ts': null, 'src/moved.ts': 'moved' },
        },
      },
      {
        actionId: 'refused',
        index: 2,
        action: 'update',
        path: 'src/failed.ts',
        status: 'failed',
        beforeHash: 'before',
        afterHash: 'before',
        forward: {
          outcome: 'not_applied',
          afterHashes: { 'src/failed.ts': 'before' },
        },
      },
    ],
    finalHashes: {
      'src/new.ts': 'new',
      'src/old.ts': null,
      'src/moved.ts': 'moved',
      'src/failed.ts': 'before',
    },
  })
  mutation.actions[0]!.patch =
    '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+new'
  mutation.actions[1]!.patch = '@@ -1 +1 @@\n-old\n+new'
  mutation.actions[2]!.patch = '-proposed\n+never committed'
  const blocks = [
    {
      type: 'tool',
      toolName: 'edit_transaction',
      toolCallId: 'canonical',
      input: {},
      outputRaw: [
        {
          type: 'json',
          value: mutation,
        },
      ],
    },
  ] as any
  const stats = getFileStatsFromBlocks(blocks)
  expect(stats.map((file) => [file.path, file.changeType])).toEqual([
    ['src/new.ts', 'A'],
    ['src/moved.ts', 'R'],
  ])
  expect(stats[1].previousPath).toBe('src/old.ts')
  expect(
    getFileStatsFromBlocks([...blocks, ...blocks])[0].stats.linesAdded,
  ).toBe(2)
  expect(buildActivityTimeline([...blocks, ...blocks])).toHaveLength(4)
})
