import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { ProjectIdSchema } from '@codebuff/common/types/memory-v2'
import { MemoryV2Coordinator } from '../../../../../sdk/src/services/memory-v2/coordinator'
import { BunSQLiteMemoryRepository } from '../bun-sqlite-memory-repository'

test.each(['completed', 'failed', 'cancelled'] as const)(
  'SQLite accepts both startup and %s terminal transitions without event ID collisions',
  async (status) => {
    const root = mkdtempSync(join(tmpdir(), 'openbuff-memory-lifecycle-'))
    const opened = await BunSQLiteMemoryRepository.open({
      repositoryRoot: root,
    })
    if (opened.status !== 'ok') throw new Error(opened.error.message)
    const repository = opened.repository
    const projectId = ProjectIdSchema.parse('project:lifecycle')
    const state = getInitialAgentState()
    const warnings: unknown[] = []
    const coordinator = new MemoryV2Coordinator(
      { repository, projectId, capture: 'off', authority: 'sqlite-v2-opt-in' },
      {
        warn: (data: unknown) => {
          warnings.push(data)
        },
      },
    )
    try {
      await coordinator.prepareTurn({
        agentState: state,
        trustedUserInputId: 'input:one',
        query: 'test lifecycle',
      })
      await coordinator.finishTurn({
        agentState: state,
        output:
          status === 'completed'
            ? { type: 'structuredOutput', value: {} }
            : { type: 'error', message: status },
        signal: status === 'cancelled' ? AbortSignal.abort() : undefined,
      })
      expect(state.memoryV2?.turn.status).toBe(status)
      expect(state.memoryV2?.pendingTerminal).toBeUndefined()
      expect(warnings).toEqual([])
      const page = await repository.export({
        schemaVersion: 2,
        projectId,
        limit: 100,
      })
      if (page.outcome !== 'page') throw new Error(page.error.message)
      const transitions = page.events.filter(
        (event) => event.eventType === 'task.transitioned',
      )
      expect(transitions).toHaveLength(2)
      expect(transitions.map((event) => event.payload.toStatus)).toEqual([
        'active',
        status,
      ])
      const count = page.events.length
      await coordinator.finishTurn({
        agentState: state,
        output: { type: 'structuredOutput', value: {} },
      })
      const repeated = await repository.export({
        schemaVersion: 2,
        projectId,
        limit: 100,
      })
      expect(repeated.outcome === 'page' && repeated.events.length).toBe(count)
    } finally {
      await repository.close()
    }
  },
)

test('replays a parked terminal decision from an older CLI before starting the next turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openbuff-memory-replay-'))
  const opened = await BunSQLiteMemoryRepository.open({ repositoryRoot: root })
  if (opened.status !== 'ok') throw new Error(opened.error.message)
  const repository = opened.repository
  const projectId = ProjectIdSchema.parse('project:replay')
  const config = {
    repository,
    projectId,
    capture: 'off' as const,
    authority: 'sqlite-v2-opt-in' as const,
  }
  const state = getInitialAgentState()
  try {
    await new MemoryV2Coordinator(config).prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:old',
      query: 'old turn',
    })
    const previous = state.memoryV2!
    previous.turn.status = 'finishing'
    previous.pendingTerminal = {
      status: 'cancelled',
      endedAt: new Date().toISOString(),
      query: {
        outcome: 'failed',
        error: 'previous turn interrupted',
        retryable: true,
      },
    }
    await new MemoryV2Coordinator(config).prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:new',
      query: 'new turn',
    })
    expect(state.memoryV2?.turn.status).toBe('active')
    expect(state.memoryV2?.turn.userInputId).toBe('input:new')
    const page = await repository.export({
      schemaVersion: 2,
      projectId,
      limit: 100,
    })
    if (page.outcome !== 'page') throw new Error(page.error.message)
    const transitions = page.events.filter(
      (event) => event.eventType === 'task.transitioned',
    )
    expect(transitions.map((event) => event.payload.toStatus)).toEqual([
      'active',
      'cancelled',
      'active',
    ])
  } finally {
    await repository.close()
  }
})
