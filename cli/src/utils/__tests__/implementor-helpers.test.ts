import { describe, expect, test } from 'bun:test'

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
  const blocks = [
    {
      type: 'tool',
      toolName: 'edit_transaction',
      toolCallId: 'canonical',
      input: {},
      outputRaw: [
        {
          type: 'json',
          value: {
            kind: 'file_mutation_result',
            outcome: 'partial',
            actions: [
              {
                action: 'create',
                path: 'src/new.ts',
                outcome: 'applied',
                patch: '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+new',
              },
              {
                action: 'move',
                path: 'src/old.ts',
                destinationPath: 'src/moved.ts',
                outcome: 'applied',
                patch: '@@ -1 +1 @@\n-old\n+new',
              },
              {
                action: 'update',
                path: 'src/failed.ts',
                outcome: 'not_applied',
                patch: '-proposed\n+never committed',
              },
            ],
          },
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
