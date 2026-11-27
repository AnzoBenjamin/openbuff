import { describe, expect, it } from 'bun:test'
import { createContextArchiveBody } from '@codebuff/common/util/context-archive-body'
import { buildContextArchiveBodyReader } from '../services/context-archive-reader'

const actor = { runId: 'run', rootRunId: 'run', agentId: 'agent' }
const body = createContextArchiveBody('A🙂€B')
const page = {
  status: 'ok' as const,
  runId: 'source',
  step: 7,
  toolName: 'read_files',
  toolCallId: 'call',
  ...body,
  startByte: 0,
  endByte: body.utf8Bytes,
  nextOffset: null,
}
const request = {
  actor,
  userInputId: 'turn',
  toolCallId: 'call',
  sourceRunId: 'source',
  maxBytes: 32,
}

describe('B13 host-bound archive body reader', () => {
  it('authenticates actors/tasks and never passes peer-selected authority to storage', async () => {
    const reads: unknown[] = []
    const reader = buildContextArchiveBodyReader({
      allowProjectArchive: true,
      registeredActor: (value) =>
        value.runId === actor.runId
          ? { actor, userInputId: 'turn' }
          : undefined,
      repository: {
        async readContextArchiveBodyPage(selector) {
          reads.push(selector)
          return page
        },
      },
    })
    expect((await reader({ ...request, userInputId: 'forged' })).status).toBe(
      'unavailable',
    )
    expect(
      (await reader({ ...request, actor: { ...actor, agentId: 'other' } }))
        .status,
    ).toBe('unavailable')
    expect(reads).toHaveLength(0)
    expect(
      (
        await reader({
          ...request,
          projectId: 'foreign',
          path: '/outside',
        } as never)
      ).status,
    ).toBe('ok')
    expect(reads).toEqual([
      {
        toolCallId: 'call',
        sourceRunId: 'source',
        expectedSha256: undefined,
        offsetBytes: 0,
        maxBytes: 32,
      },
    ])
  })
  it('withholds strict-reader and edited-branch canonical archive bytes', async () => {
    let reads = 0
    const base = {
      registeredActor: () => ({
        actor,
        userInputId: 'turn',
        strictProjectReads: true,
      }),
      repository: {
        async readContextArchiveBodyPage() {
          reads++
          return page
        },
      },
    }
    expect(
      (
        await buildContextArchiveBodyReader({
          ...base,
          allowProjectArchive: true,
        })(request)
      ).status,
    ).toBe('unavailable')
    expect(
      (
        await buildContextArchiveBodyReader({
          ...base,
          registeredActor: () => ({ actor, userInputId: 'turn' }),
          allowProjectArchive: false,
        })(request)
      ).status,
    ).toBe('missing')
    expect(reads).toBe(0)
  })
  it('rejects wrong source/value/hash/range and preserves typed expiry', async () => {
    let outcome: unknown = { ...page, runId: 'different' }
    const reader = buildContextArchiveBodyReader({
      allowProjectArchive: true,
      registeredActor: () => ({ actor, userInputId: 'turn' }),
      repository: {
        async readContextArchiveBodyPage() {
          return outcome as never
        },
      },
    })
    expect((await reader(request)).status).toBe('corrupt')
    outcome = { ...page, text: 'WRONGTEXT' }
    expect((await reader(request)).status).toBe('corrupt')
    outcome = page
    expect(
      (await reader({ ...request, expectedSha256: '0'.repeat(64) })).status,
    ).toBe('corrupt')
    outcome = { status: 'expired', reason: 'retained cutoff' }
    expect(await reader(request)).toEqual({
      status: 'expired',
      reason: 'retained cutoff',
    })
    expect((await reader({ ...request, offsetBytes: -1 })).status).toBe(
      'invalid-cursor',
    )
  })
})
