import { describe, expect, it } from 'bun:test'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { createContextArchiveBody } from '@codebuff/common/util/context-archive-body'
import { archivePreCompaction } from '../context-archive'
import { prepareArchiveReferenceContext } from '../context-archive-context'

const actor = { runId: 'fresh', rootRunId: 'fresh', agentId: 'reader' }
const state = { ...getInitialAgentState(), runId: 'source' }
archivePreCompaction(
  state,
  Array.from({ length: 30 }, (_, i) => ({
    role: 'tool' as const,
    toolName: 'read_files',
    toolCallId: `call-${i}`,
    content: [
      { type: 'json' as const, value: `RESULT-${i} ` + 'x'.repeat(32768) },
    ],
  })),
  'semantic_compaction',
  0,
)

describe('B13 bounded first-request archive references', () => {
  it('checks the acting actor/task and emits copy-ready hashes, never original text', async () => {
    const requests: unknown[] = []
    const index = await prepareArchiveReferenceContext({
      state,
      actor,
      userInputId: 'next-task',
      read: async (request) => {
        requests.push(request)
        const body = Object.values(state.contextArchiveBodies!).find(
          (body) => body.sha256 === request.expectedSha256,
        )!
        return {
          status: 'ok',
          runId: 'source',
          toolName: 'read_files',
          toolCallId: request.toolCallId,
          step: 0,
          ...body,
          text: body.text.slice(0, 4),
          startByte: 0,
          endByte: 4,
          nextOffset: 4,
        }
      },
    })
    expect(requests).toHaveLength(6)
    expect(
      requests.every(
        (request) => (request as { actor: unknown }).actor === actor,
      ),
    ).toBe(true)
    expect(index).toContain('ARCHIVE_BODY')
    expect(index).toContain('6/30')
    expect(index!.length).toBeLessThan(2500)
    expect(index).not.toContain('x'.repeat(30))
    expect(index).toContain('expectedSha256')
  })
  it('does not advertise forbidden, unavailable or hash-mismatched sources', async () => {
    expect(
      await prepareArchiveReferenceContext({
        state: { ...state, contextArchiveHydration: 'in-memory-only' },
        actor,
        userInputId: 'task',
        read: async () => {
          throw new Error('must not run')
        },
      }),
    ).toBeUndefined()
    expect(
      await prepareArchiveReferenceContext({
        state,
        actor,
        userInputId: 'task',
        read: async () => ({
          status: 'unavailable',
          reason: 'strict reader denied',
        }),
      }),
    ).toBeUndefined()
    const wrong = createContextArchiveBody('WRONG')
    expect(
      await prepareArchiveReferenceContext({
        state,
        actor,
        userInputId: 'task',
        read: async (request) => ({
          status: 'ok',
          runId: 'source',
          toolName: 'read_files',
          toolCallId: request.toolCallId,
          step: 0,
          ...wrong,
          text: 'WRON',
          startByte: 0,
          endByte: 4,
          nextOffset: 4,
        }),
      }),
    ).toBeUndefined()
  })
})
