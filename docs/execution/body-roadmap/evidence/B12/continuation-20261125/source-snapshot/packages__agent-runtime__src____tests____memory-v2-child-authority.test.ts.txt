import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  createTestAgentRuntimeParams,
  mockFileContext,
} from '@codebuff/common/testing/fixtures/agent-runtime'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import {
  MemoryTurnContextV2Schema,
  type MemoryAuthorityMode,
} from '@codebuff/common/types/memory-v2'
import { promptSuccess } from '@codebuff/common/util/error'
import type { AgentRuntimeDeps } from '@codebuff/common/types/contracts/agent-runtime'
import type { RepositoryContextPacket } from '@codebuff/common/types/contracts/repository-intelligence'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { commitTaskMemory } from '../util/task-memory'
import type { AgentTemplate } from '../templates/types'

const sentinel = 'V1_CHILD_SHADOW_MUST_NOT_REACH_PROVIDER'
const userInputId = 'root-input-memory-childactual-child'
const actor = {
  runId: 'child-run',
  rootRunId: 'root-run',
  agentId: 'actual-child',
}
function knowledge(inputId = userInputId, title?: string) {
  return MemoryTurnContextV2Schema.parse({
    schemaVersion: 2,
    userInputId: inputId,
    queryId: 'query:child',
    result: {
      schemaVersion: 2,
      queryId: 'query:child',
      projectId: 'project:child',
      generatedAt: '2026-11-01T00:00:00.000Z',
      matchedTasks: title
        ? [
            {
              taskId: 'task:prior',
              title,
              status: 'completed',
              summary: title,
              score: 0.8,
              reasons: [
                {
                  code: 'task-match',
                  contribution: 0.8,
                  detail: 'Fixture task context',
                },
              ],
            },
          ]
        : [],
      verifiedKnowledge: [],
      reusableDiscovery: [],
      rereadRequired: [],
      historicalContext: [],
      degradation: { state: 'none' },
      rankingReasons: [],
    },
  })
}
function packet(context: unknown = knowledge()): RepositoryContextPacket {
  return {
    schemaVersion: 1,
    projectId: 'project:child',
    actor,
    agentType: 'memory-child',
    userInputId,
    queryHash: 'fixture-query',
    generatedAt: 1,
    freshness: 'degraded',
    briefing: 'Exact source tools remain available.',
    knowledge: context as RepositoryContextPacket['knowledge'],
    playbooks: [],
    applicability: {},
    reasons: [],
    metrics: { indexedCandidates: 0, rememberedFacts: 0, reused: false },
  }
}
function fixture(mode?: MemoryAuthorityMode) {
  const runtime = createTestAgentRuntimeParams()
  const state = {
    ...getInitialAgentState(),
    agentId: actor.agentId,
    agentType: 'memory-child',
    parentId: 'parent-agent',
    ancestorRunIds: ['root-run'],
    stepsRemaining: 2,
    taskMemory: commitTaskMemory({
      draft: {
        schemaVersion: 1,
        goal: 'Child task',
        requirements: [],
        decisions: [sentinel],
        filesInspected: [],
        editsMade: [],
        validationResults: [],
        reviewReceipts: [],
        blockers: [],
        nextActions: [],
        historicalSummary: '',
        evidence: [],
      },
      expectedRevision: -1,
    }),
  }
  const order: string[] = []
  let observed: Message[] = []
  let before:
    | {
        authority: typeof state.memoryAuthority
        context: typeof state.memoryV2Context
      }
    | undefined
  const template: AgentTemplate = {
    id: 'memory-child',
    displayName: 'Child',
    model: 'fixture/model',
    inputSchema: {},
    outputMode: 'last_message',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: [],
    spawnableAgents: [],
    systemPrompt: 'Use current task context.',
    instructionsPrompt: '',
    stepPrompt: '',
    handleSteps: function* ({ agentState }) {
      order.push('programmatic')
      before = {
        authority: agentState.memoryAuthority,
        context: agentState.memoryV2Context,
      }
      yield 'STEP'
    },
  }
  const params: Parameters<typeof loopAgentSteps>[0] = {
    ...runtime,
    agentTemplate: template,
    localAgentTemplates: { 'memory-child': template },
    agentState: state,
    agentType: 'memory-child',
    fileContext: mockFileContext,
    userId: undefined,
    userInputId,
    prompt: 'Child task',
    spawnParams: {
      memoryAuthority: { active: 'json-v1' },
      memoryV2: { authority: 'json-v1' },
    },
    clientSessionId: 'fixture',
    fingerprintId: 'fixture',
    repoId: undefined,
    repoUrl: undefined,
    ancestorRunIds: ['root-run'],
    signal: new AbortController().signal,
    startAgentRun: async () => {
      order.push('registered')
      return actor.runId
    },
    ...(mode
      ? {
          resolveMemoryAuthority: async (request) => {
            order.push('selection')
            expect(request).toEqual({ actor, userInputId })
            return mode
          },
        }
      : {}),
    promptAiSdkStream: async function* (request) {
      order.push('model')
      observed = request.messages
      yield { type: 'text', text: 'done' }
      return promptSuccess('fixture-response')
    },
  }
  return {
    params,
    state,
    order,
    observed: () => observed,
    before: () => before,
  }
}
afterEach(() => {
  clearAgentGeneratorCache()
  mock.restore()
})

describe('host-selected child memory authority before execution', () => {
  for (const retrieval of [
    'disabled',
    'missing',
    'throws',
    'invalid',
    'empty',
  ] as const)
    test(`${retrieval} cannot reactivate inherited V1 or restored V2 content`, async () => {
      const f = fixture('sqlite-v2-opt-in')
      f.state.memoryV2Context = knowledge(userInputId, 'RESTORED_UNTRUSTED_V2')
      f.state.memoryAuthority = {
        schemaVersion: 1,
        userInputId,
        requested: 'json-v1',
        active: 'json-v1',
        fallbackOccurred: true,
        v1CompatibilityShadowAvailable: true,
        v1Import: { status: 'not-required' },
      }
      if (retrieval !== 'disabled')
        f.params.prepareRepositoryContext = async () => {
          f.order.push('retrieval')
          if (retrieval === 'throws')
            throw new Error('Owned unavailable backend')
          if (retrieval === 'missing')
            return { ...packet(), knowledge: undefined }
          if (retrieval === 'invalid')
            return packet({
              schemaVersion: 2,
              verifiedKnowledge: ['UNVERIFIED_RANDOM_DATA'],
            })
          return packet()
        }
      const result = await loopAgentSteps(f.params)
      expect(result.output.type).not.toBe('error')
      expect(f.order.indexOf('selection')).toBeGreaterThan(
        f.order.indexOf('registered'),
      )
      expect(f.order.indexOf('selection')).toBeLessThan(
        f.order.indexOf('programmatic'),
      )
      expect(f.before()?.authority).toMatchObject({
        schemaVersion: 1,
        userInputId,
        requested: 'sqlite-v2-opt-in',
        active: 'sqlite-v2-opt-in',
        fallbackOccurred: false,
        v1CompatibilityShadowAvailable: true,
      })
      const text = JSON.stringify(f.observed())
      expect(text).not.toContain(sentinel)
      expect(text).not.toContain('TASK_MEMORY_CONTEXT')
      expect(text).not.toContain('RESTORED_UNTRUSTED_V2')
      expect(text).not.toContain('UNVERIFIED_RANDOM_DATA')
      expect(text.includes('MEMORY_V2_CONTEXT')).toBe(retrieval === 'empty')
      expect(f.before()?.context).toEqual(
        retrieval === 'empty' ? knowledge() : undefined,
      )
    })

  test('only a schema-valid correlated host knowledge packet supplies V2 content', async () => {
    const f = fixture('sqlite-v2-opt-in')
    f.params.prepareRepositoryContext = async (request) => {
      expect(request.actor).toEqual(actor)
      expect(request.userInputId).toBe(userInputId)
      return packet(knowledge(userInputId, 'CURRENT_HOST_KNOWLEDGE'))
    }
    await loopAgentSteps(f.params)
    expect(JSON.stringify(f.observed())).toContain('CURRENT_HOST_KNOWLEDGE')
    expect(JSON.stringify(f.observed())).not.toContain(sentinel)
    expect(f.before()?.context?.result.verifiedKnowledge).toEqual([])
  })

  for (const substitution of [
    'actor',
    'task',
    'knowledge-task',
    'schema',
  ] as const)
    test(`rejects ${substitution} substitution without changing source selection`, async () => {
      const f = fixture('sqlite-v2-opt-in')
      const candidate = packet(knowledge(userInputId, 'SUBSTITUTED_KNOWLEDGE'))
      if (substitution === 'actor')
        candidate.actor = { ...actor, agentId: 'peer-child' }
      if (substitution === 'task')
        candidate.userInputId = 'root-input-peer-child'
      if (substitution === 'knowledge-task')
        candidate.knowledge = knowledge(
          'root-input-peer-child',
          'SUBSTITUTED_KNOWLEDGE',
        )
      if (substitution === 'schema')
        candidate.knowledge = {
          ...candidate.knowledge!,
          result: { ...candidate.knowledge!.result, unexpected: true },
        } as never
      f.params.prepareRepositoryContext = async () => candidate
      await loopAgentSteps(f.params)
      expect(f.before()?.authority?.active).toBe('sqlite-v2-opt-in')
      expect(f.before()?.context).toBeUndefined()
      expect(JSON.stringify(f.observed())).not.toContain(
        'SUBSTITUTED_KNOWLEDGE',
      )
      expect(JSON.stringify(f.observed())).not.toContain('TASK_MEMORY_CONTEXT')
    })

  for (const mode of ['json-v1', 'shadow-v2'] as const)
    test(`${mode} overrides restored/template authority and does not promote supplied knowledge`, async () => {
      const f = fixture(mode)
      f.state.memoryAuthority = {
        schemaVersion: 1,
        userInputId,
        requested: 'sqlite-v2-opt-in',
        active: 'sqlite-v2-opt-in',
        fallbackOccurred: false,
        v1CompatibilityShadowAvailable: true,
        v1Import: { status: 'not-required' },
      }
      f.state.memoryV2Context = knowledge(userInputId, 'RESTORED_V2')
      f.params.prepareRepositoryContext = async () =>
        packet(knowledge(userInputId, 'HOST_V2_NOT_SELECTED'))
      await loopAgentSteps(f.params)
      expect(f.before()?.authority).toMatchObject({
        requested: mode,
        active: 'json-v1',
        userInputId,
      })
      expect(f.before()?.context).toBeUndefined()
      expect(JSON.stringify(f.observed())).toContain(sentinel)
      expect(JSON.stringify(f.observed())).toContain('TASK_MEMORY_CONTEXT')
      expect(JSON.stringify(f.observed())).not.toContain('MEMORY_V2_CONTEXT')
    })

  for (const mode of ['sqlite-v2-opt-in', 'json-v1'] as const)
    test(`a live generator cannot override captured ${mode} source selection`, async () => {
      const f = fixture(mode)
      const template = f.params.agentTemplate!
      template.handleSteps = function* ({ agentState }) {
        agentState.memoryAuthority = {
          schemaVersion: 1,
          userInputId,
          requested:
            mode === 'sqlite-v2-opt-in' ? 'json-v1' : 'sqlite-v2-opt-in',
          active: mode === 'sqlite-v2-opt-in' ? 'json-v1' : 'sqlite-v2-opt-in',
          fallbackOccurred: false,
          v1CompatibilityShadowAvailable: true,
          v1Import: { status: 'not-required' },
        }
        yield 'STEP'
      }
      await loopAgentSteps(f.params)
      const text = JSON.stringify(f.observed())
      expect(text.includes(sentinel)).toBe(mode === 'json-v1')
      expect(text.includes('TASK_MEMORY_CONTEXT')).toBe(mode === 'json-v1')
      expect(text).not.toContain('MEMORY_V2_CONTEXT')
    })

  test('an absent host resolver retains standalone legacy V1 behavior', async () => {
    const f = fixture()
    await loopAgentSteps(f.params)
    expect(f.before()?.authority).toBeUndefined()
    expect(JSON.stringify(f.observed())).toContain(sentinel)
  })

  test('an unresolved host selection cannot silently execute using restored or legacy authority', async () => {
    for (const resolve of [
      async () => {
        throw new Error('Unregistered actor/task')
      },
      async () => 'peer-selected-mode',
    ]) {
      const f = fixture()
      f.params.resolveMemoryAuthority =
        resolve as AgentRuntimeDeps['resolveMemoryAuthority']
      await expect(loopAgentSteps(f.params)).rejects.toThrow()
      expect(f.order).toEqual(['registered'])
      expect(f.before()).toBeUndefined()
      expect(f.observed()).toEqual([])
    }
  })
})
