import { describe, expect, it } from 'bun:test'
import {
  createContextArchiveBody,
  isContextArchiveBodyPointer,
} from '@codebuff/common/util/context-archive-body'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import {
  normalizePersistedArchive,
  projectCommittedArchive,
} from '../persisted-context-archive'
import type { RunState } from '@openbuff/sdk'

const fixture = (): RunState => {
  const body = createContextArchiveBody('original secret output')
  return {
    output: { type: 'lastMessage', value: [] },
    sessionState: {
      fileContext: {} as never,
      mainAgentState: {
        ...getInitialAgentState(),
        runId: 'source',
        contextArchiveBodies: { [body.bodyId]: body },
        compactionArchive: [
          {
            runId: 'source',
            archivedAt: 100,
            action: 'tool_result_eviction',
            keepRecentSteps: 0,
            messages: [
              {
                role: 'tool',
                toolName: 'read_files',
                toolCallId: 'call',
                content: [{ type: 'json', value: body.text }],
              },
            ],
            provenance: [
              {
                kind: 'original',
                step: 7,
                sourceRunId: 'source',
                toolCallId: 'call',
                capturedAt: 100,
                body,
              },
            ],
          },
        ],
      },
    },
  }
}

describe('B13 persistence projection', () => {
  it('publishes references only after all corresponding archive commits are confirmed', () => {
    const state = fixture()
    projectCommittedArchive(state, {
      persisted: 1,
      skipped: 0,
      status: 'ok',
      retention: {
        schemaVersion: 1,
        status: 'ok',
        mode: 'rolling',
        logicalBytes: 1000,
        retainedSnapshots: 1,
        retainedBodies: 1,
        droppedSnapshots: 0,
        expiredSnapshots: 0,
      },
    })
    const main = state.sessionState!.mainAgentState
    expect(main.contextArchiveBodies).toBeUndefined()
    expect(main.contextArchiveStorage).toBe('references')
    expect(
      isContextArchiveBodyPointer(
        (
          main.compactionArchive![0].messages[0].content[0] as {
            value: unknown
          }
        ).value,
      ),
    ).toBe(true)
    expect(JSON.stringify(main.compactionArchive)).not.toContain(
      'original secret output',
    )
    expect(main.compactionArchive![0].provenance![0].kind).toBe('pointer')
  })
  it('failed, incomplete or unconfirmed storage keeps bounded inline originals, not dangling refs', () => {
    for (const outcome of [
      undefined,
      { persisted: 0, skipped: 1, status: 'unavailable' as const },
      { persisted: 0, skipped: 1, status: 'degraded' as const },
    ]) {
      const state = fixture()
      projectCommittedArchive(state, outcome)
      expect(state.sessionState!.mainAgentState.contextArchiveStorage).toBe(
        'inline',
      )
      expect(
        JSON.stringify(state.sessionState!.mainAgentState.contextArchiveBodies),
      ).toContain('original secret output')
    }
  })
  it('a disclosed partial retention cutoff cannot publish dangling refs or an overquota inline shadow', () => {
    const state = fixture()
    projectCommittedArchive(state, {
      persisted: 0,
      skipped: 1,
      status: 'degraded',
      retention: {
        schemaVersion: 1,
        status: 'cutoff',
        mode: 'rolling',
        logicalBytes: 100,
        retainedSnapshots: 0,
        retainedBodies: 0,
        droppedSnapshots: 1,
        expiredSnapshots: 0,
        cutoffArchivedAt: 100,
      },
    })
    const main = state.sessionState!.mainAgentState
    expect(main.compactionArchive).toEqual([])
    expect(main.contextArchiveBodies).toBeUndefined()
    expect(main.contextArchiveRetention?.status).toBe('cutoff')
  })
  it('normalizes sanitized text and all references together before sending them to storage', () => {
    const state = fixture(),
      main = state.sessionState!.mainAgentState
    const body = Object.values(main.contextArchiveBodies!)[0]
    main.contextArchiveBodies![body.bodyId] = {
      ...body,
      text: '[REDACTED] output',
    }
    normalizePersistedArchive(state)
    const rebound = Object.values(main.contextArchiveBodies!)[0]
    expect(rebound.sha256).not.toBe(body.sha256)
    expect(main.compactionArchive![0].provenance![0].body!.bodyId).toBe(
      rebound.bodyId,
    )
  })
})
