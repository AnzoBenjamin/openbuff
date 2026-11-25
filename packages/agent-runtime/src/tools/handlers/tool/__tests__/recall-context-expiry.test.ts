import { expect, test } from 'bun:test'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { DEFAULT_CONTEXT_ARCHIVE_TTL_MS } from '@codebuff/common/util/context-archive-body'
import { handleRecallContext } from '../recall-context'

test('local excerpt lookup and exact ID cannot bypass archive expiry, including current run', async () => {
  const state = {
    ...getInitialAgentState(),
    runId: 'current',
    compactionArchive: [
      {
        runId: 'current',
        archivedAt: 10,
        action: 'semantic_compaction' as const,
        keepRecentSteps: 0,
        messages: [
          {
            role: 'tool' as const,
            toolName: 'read_files',
            toolCallId: 'call',
            content: [
              { type: 'json' as const, value: 'EXPIRED_ORIGINAL_CANARY' },
            ],
          },
        ],
      },
    ],
  }
  for (const input of [
    { query: 'EXPIRED_ORIGINAL_CANARY' },
    { toolCallId: 'call' },
  ]) {
    const result = await handleRecallContext({
      previousToolCallFinished: Promise.resolve(),
      agentState: state,
      toolCall: { toolName: 'recall_context', toolCallId: 'recall', input },
      clock: { now: () => 11 + DEFAULT_CONTEXT_ARCHIVE_TTL_MS },
    })
    expect(result.output[0].value).toHaveProperty('matches', [])
    expect(JSON.stringify(result.output)).not.toContain(
      'EXPIRED_ORIGINAL_CANARY',
    )
  }
})
