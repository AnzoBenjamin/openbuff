import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenbuffClient } from '../client'
import { createSupervisedExecutionScope } from '../impl/agent-runtime'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { startFakeLlmServer, silentLogger, type FakeLlmServer } from './fixtures/fake-llm-server'
import { commitTaskMemory } from '@codebuff/agent-runtime/util/task-memory'
import { MemoryQueryOutcomeSchema, ProjectIdSchema, type MemoryEventEnvelope } from '@codebuff/common/types/memory-v2'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import { buildBridgedChildDeps, connectChildBridge } from '@codebuff/agent-runtime/supervision/child-bridge-client'
import { buildSupervisedBridgeHandlers, startParentBridgeServer } from '@codebuff/agent-runtime/supervision/parent-bridge-server'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { ExecutionActor, ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'
import type { AgentState as RuntimeAgentState, MemoryAuthorityStateV2 } from '@codebuff/common/types/session-state'
import type { MemoryRepositoryV2, MemoryV2ClientConfig } from '../services/memory-v2/types'

const projectId = ProjectIdSchema.parse('project:b12-child-authority')
const sentinel = 'V1_INHERITED_CHILD_AUTHORITY_CANARY'
const home = process.env.HOME
let root: string, config: string, server: FakeLlmServer
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'b12-child-authority-')))
  server = startFakeLlmServer()
  config = path.join(root, 'config.json')
  fs.writeFileSync(config, JSON.stringify({
    defaultModel: 'fixture/model', indexing: { enabled: false },
    providers: { fixture: { type: 'openai-compatible', baseURL: `${server.baseURL}/v1`, models: ['model'] } },
  }))
})
afterEach(() => {
  server.stop()
  fs.rmSync(root, { recursive: true, force: true })
  expect(process.env.HOME).toBe(home)
})
const seed: AgentDefinition = {
  id: 'authority-seed', displayName: 'Seed', toolNames: [],
  handleSteps: function* () { yield { type: 'STEP_TEXT', text: 'Seed state.' } },
}
// This generator crosses the real supervised transport: no module closures.
const child: AgentDefinition = {
  id: 'authority-child', displayName: 'Child', toolNames: ['set_output'], outputMode: 'structured_output',
  systemPrompt: 'Answer the child task using available context.',
  handleSteps: function* ({ agentState }) {
    const state = agentState as unknown as RuntimeAgentState
    const before = {
      stage: 'memory-authority-before-first-step',
      actor: { runId: state.runId, rootRunId: state.ancestorRunIds[0], agentId: state.agentId },
      authority: state.memoryAuthority ?? null,
      knowledgeInputId: state.memoryV2Context?.userInputId ?? null,
      verifiedCount: state.memoryV2Context?.result.verifiedKnowledge.length ?? 0,
      hasV1Shadow: state.taskMemory !== undefined,
    }
    yield 'STEP'
    yield { toolName: 'set_output', input: { before } }
  },
}
const parent: AgentDefinition = {
  id: 'authority-parent', displayName: 'Parent', toolNames: ['spawn_agents', 'set_output'],
  spawnableAgents: [child.id], outputMode: 'structured_output',
  handleSteps: function* () {
    const child = yield { toolName: 'spawn_agents', input: { agents: [{
      agent_type: 'authority-child', prompt: 'A child task unrelated to the parent shadow.',
      params: { memoryAuthority: { active: 'json-v1' }, memoryV2: { authority: 'json-v1' } },
    }] } }
    yield { toolName: 'set_output', input: { child: child.toolResult } }
  },
}
function client(supervised = false, intelligence = false, memoryV2?: MemoryV2ClientConfig, history: 'full' | 'pinned' = 'full') {
  return new OpenbuffClient({
    cwd: root, projectFiles: {}, knowledgeFiles: {}, userKnowledgeFiles: {}, memoryV2,
    repositoryIntelligence: intelligence ? { async query() { return { freshness: 'current', candidates: [] } } } : false,
    agentDefinitions: [seed, parent, { ...child, messageHistoryMode: history, includeMessageHistory: true }],
    harnessStateDir: path.join(root, 'harness'), runTimeoutMs: 15_000, logger: silentLogger, handleEvent() {},
    hostConfiguration: {
      environment: { PATH: '/usr/bin:/bin', OPENBUFF_PROCESS_SUPERVISION: supervised ? '1' : '0', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1' },
      platform: process.platform, invocationCwd: root, projectRoot: root, home: { kind: 'none' }, globals: { kind: 'disabled' },
      selection: { kind: 'explicit', path: config, required: true }, trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  })
}
function repository(mode: 'throws' | 'invalid' | 'empty') {
  const queries: Parameters<MemoryRepositoryV2['query']>[0][] = []
  const events: MemoryEventEnvelope[] = []
  let sequence = 0
  const port: MemoryRepositoryV2 = {
    append: async request => {
      const entries = request.events.map(event => {
        const previous = events.find(value => value.eventId === event.eventId)
        if (previous) return { eventId: event.eventId, sequence: previous.sequence, duplicate: true }
        events.push({ ...event, sequence: ++sequence })
        return { eventId: event.eventId, sequence, duplicate: false }
      })
      return { outcome: 'appended', entries, lastEventId: events.at(-1)!.eventId }
    },
    query: async request => {
      queries.push(request)
      if (mode === 'throws') throw new Error('Owned unavailable backend')
      if (mode === 'invalid') return { malformed: true, verifiedKnowledge: ['RANDOM_DATA_NOT_VERIFIED'] } as never
      return MemoryQueryOutcomeSchema.parse({ outcome: 'result', result: {
        schemaVersion: 2, queryId: request.queryId, projectId, generatedAt: '2026-11-01T00:00:00.000Z',
        matchedTasks: [], verifiedKnowledge: [], reusableDiscovery: [], rereadRequired: [], historicalContext: [],
        degradation: { state: 'none' }, rankingReasons: [],
      } })
    },
    export: async request => {
      const start = request.afterEventId ? events.findIndex(event => event.eventId === request.afterEventId) + 1 : 0
      const page = events.slice(start, start + request.limit)
      return { outcome: 'page', events: page, nextAfterEventId: start + page.length < events.length ? page.at(-1)!.eventId : null,
        ...(events.length ? { rawTailEventId: events.at(-1)!.eventId } : {}) }
    },
    verify: async () => { throw new Error('Fixture cannot verify knowledge') },
    rebuild: async () => { throw new Error('Unused') }, health: async () => { throw new Error('Unused') },
  }
  return { port, queries }
}
async function previousRun() {
  const previous = await client().run({ agent: seed.id, prompt: 'Prepare parent state.' })
  previous.sessionState!.mainAgentState.taskMemory = commitTaskMemory({ draft: {
    schemaVersion: 1, goal: 'Prior parent task', requirements: [], decisions: [sentinel], filesInspected: [], editsMade: [],
    validationResults: [], reviewReceipts: [], blockers: [], nextActions: [], historicalSummary: '', evidence: [],
  }, expectedRevision: -1 })
  return previous
}
type Before = {
  stage: string; actor: ExecutionActor; authority: MemoryAuthorityStateV2 | null;
  knowledgeInputId: string | null; verifiedCount: number; hasV1Shadow: boolean;
}
function beforeFirstStep(value: unknown): Before | undefined {
  if (typeof value === 'string') { try { return beforeFirstStep(JSON.parse(value)) } catch { return undefined } }
  if (!value || typeof value !== 'object') return undefined
  if ((value as Before).stage === 'memory-authority-before-first-step') return value as Before
  for (const child of Object.values(value)) { const result = beforeFirstStep(child); if (result) return result }
  return undefined
}

describe('B12 real SDK child memory source selection', () => {
  for (const supervised of [false, true])
    for (const history of ['full', 'pinned'] as const)
      for (const intelligence of [false, true])
        for (const backend of ['unavailable', 'throws', 'invalid', 'empty'] as const)
          test(`${history}, supervised=${supervised}, repositoryIntelligence=${intelligence}, V2 ${backend}`, async () => {
            const previous = await previousRun()
            const storage = backend === 'unavailable' ? undefined : repository(backend)
            const result = await client(supervised, intelligence, {
              repository: storage?.port, projectId, authority: 'sqlite-v2-opt-in', capture: 'off',
            }, history).run({ agent: parent.id, prompt: 'Run the child.', previousRun: previous })
            expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe('completed')
            expect(server.requests).toHaveLength(1)
            const text = JSON.stringify(server.requests[0].body.messages)
            expect(text).not.toContain(sentinel)
            expect(text).not.toContain('TASK_MEMORY_CONTEXT')
            expect(text).not.toContain('<task_memory>')
            expect(text).not.toContain('RANDOM_DATA_NOT_VERIFIED')
            const before = beforeFirstStep(result.output)
            expect(before, JSON.stringify(result.output)).toBeDefined()
            expect(before!.hasV1Shadow).toBe(true)
            const rootAuthority = result.sessionState!.mainAgentState.memoryAuthority!
            const expectedInputId = `${rootAuthority.userInputId}-authority-child${before!.actor.agentId}`.slice(0, 128)
            expect(before!.actor.rootRunId).toBe(result.sessionState!.mainAgentState.runId!)
            expect(before!.actor.runId).not.toBe(before!.actor.rootRunId)
            expect(before!.authority).toMatchObject({
              requested: 'sqlite-v2-opt-in', active: 'sqlite-v2-opt-in', fallbackOccurred: false,
              userInputId: expectedInputId, v1CompatibilityShadowAvailable: true,
            })
            expect(before!.authority!.userInputId).not.toBe(rootAuthority.userInputId)
            expect(before!.verifiedCount).toBe(0)
            const hasKnowledge = intelligence && backend === 'empty'
            expect(before!.knowledgeInputId).toBe(hasKnowledge ? expectedInputId : null)
            expect(text.includes('Memory V2 retrieval context')).toBe(hasKnowledge)
            if (storage) expect(storage.queries.length).toBeGreaterThan(0)
          }, 20_000)

  for (const supervised of [false, true])
    for (const selection of ['json-v1', 'shadow-v2', 'default-config', 'legacy-shadow', 'no-config', 'invalid-authority'] as const)
      test(`ordinary V1 child control: ${selection}, supervised=${supervised}`, async () => {
        const previous = await previousRun()
        const memory: MemoryV2ClientConfig | undefined = selection === 'no-config' ? undefined : {
          repository: repository('empty').port, projectId, capture: 'off',
          ...(selection === 'legacy-shadow' ? { mode: 'shadow' as const } :
            selection === 'default-config' ? {} : { authority: selection === 'invalid-authority' ? 'peer-selected' as never : selection }),
        }
        const result = await client(supervised, false, memory).run({ agent: parent.id, prompt: 'Run the V1 child.', previousRun: previous })
        expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe('completed')
        expect(server.requests).toHaveLength(1)
        const text = JSON.stringify(server.requests[0].body.messages)
        expect(text).toContain(sentinel)
        expect(text).toContain('<task_memory>')
        expect(text).not.toContain('Memory V2 retrieval context')
        const before = beforeFirstStep(result.output)!
        expect(before.hasV1Shadow).toBe(true)
        expect(before.knowledgeInputId).toBeNull()
        if (selection === 'no-config') expect(before.authority).toBeNull()
        else expect(before.authority).toMatchObject({
          requested: ['default-config', 'legacy-shadow'].includes(selection) ? 'shadow-v2' : selection === 'invalid-authority' ? 'json-v1' : selection,
          active: 'json-v1', fallbackOccurred: false,
        })
      }, 20_000)

  test('legacy inject selection is captured before setup awaits and cannot be changed by the caller', async () => {
    const previous = await previousRun()
    const memory: MemoryV2ClientConfig = { projectId, mode: 'inject', capture: 'off' }
    let entered!: () => void, release!: () => void
    const setupStarted = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const pending = client(false, false, memory).run({ agent: parent.id, prompt: 'Run captured child.', previousRun: previous,
      fsSource: () => { entered(); return gate.then(() => createNodeFileSystem()) } })
    await setupStarted
    memory.mode = 'shadow'
    release()
    const result = await pending
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe('completed')
    expect(beforeFirstStep(result.output)?.authority?.active).toBe('sqlite-v2-opt-in')
    expect(JSON.stringify(server.requests[0]?.body.messages)).not.toContain(sentinel)
  })
})

function spawningIdentity(actor: ExecutionActor): ToolExecutionIdentity {
  const basis = { inputHash: hashActionInput('spawn_agents', { agents: [] }) }
  return { ...actor, actionId: 'spawn', attemptId: 'attempt', basis,
    basisId: hashActionInput('openbuff.execution-b02-basis.v1', { basis, workspaceSnapshotId: null }) }
}
describe('authenticated parent-mediated child memory selection', () => {
  test('real socket resolution binds the full registered task and rejects parent/peer/task substitution', async () => {
    const parentActor = { runId: 'root-run', rootRunId: 'root-run', agentId: 'root-agent' }
    const inputId = 'root-input-' + 'x'.repeat(130) + '-authority-childactual-child'
    const calls: Array<{ actor: ExecutionActor; userInputId: string }> = []
    const controller = new AbortController()
    const context = { execution: { signal: controller.signal }, signal: controller.signal } as ExecutionAdapterContext
    const scope = createSupervisedExecutionScope({
      request: { agentType: 'authority-child', prompt: '', spawnParams: undefined, child: { agentId: 'actual-child' },
        userInputId: inputId, ancestorRunIds: ['root-run'], executionIdentity: spawningIdentity(parentActor) },
      executionContext: context, registerExecutionActor() {}, onExecutionActionStart() {},
      resolveMemoryAuthority: request => { calls.push(request); return 'sqlite-v2-opt-in' },
      startAgentRun: async () => 'issued-child-run', requestToolCall: async () => ({ output: [] }), requestMcpToolData: async () => [],
    })
    const table = buildSupervisedBridgeHandlers({ ...TEST_AGENT_RUNTIME_IMPL, ...scope, apiKey: 'fixture', logger: silentLogger })
    const socket = path.join(root, 'rpc.sock')
    const bridge = startParentBridgeServer(table, socket)
    await bridge.ready
    const connection = await connectChildBridge(socket)
    const childDeps = buildBridgedChildDeps(connection, { bridgeNonce: table.bridgeNonce })
    try {
      const runId = (await childDeps.startAgentRun({ apiKey: '', logger: silentLogger, agentId: 'authority-child',
        ancestorRunIds: ['root-run'], userInputId: inputId, agentState: { agentId: 'actual-child' } } as never))!
      const actor = { runId, rootRunId: 'root-run', agentId: 'actual-child' }
      // A peer is valid in the same host but belongs to another private bridge scope.
      const peerInputId = inputId + '-peer'
      const peerScope = createSupervisedExecutionScope({
        request: { agentType: 'authority-child', prompt: '', spawnParams: undefined, child: { agentId: 'peer-agent' },
          userInputId: peerInputId, ancestorRunIds: ['root-run'], executionIdentity: spawningIdentity(parentActor) },
        executionContext: context, registerExecutionActor() {}, onExecutionActionStart() {},
        resolveMemoryAuthority: request => { calls.push(request); return 'sqlite-v2-opt-in' },
        startAgentRun: async () => 'issued-peer-run', requestToolCall: async () => ({ output: [] }), requestMcpToolData: async () => [],
      })
      const peerRunId = (await peerScope.startAgentRun({ apiKey: '', logger: silentLogger, agentId: 'authority-child',
        ancestorRunIds: ['root-run'], userInputId: peerInputId, agentState: { agentId: 'peer-agent' } } as never))!
      const peerActor = { runId: peerRunId, rootRunId: 'root-run', agentId: 'peer-agent' }
      expect(await peerScope.resolveMemoryAuthority!({ actor: peerActor, userInputId: peerInputId })).toBe('sqlite-v2-opt-in')
      calls.length = 0
      expect(await childDeps.resolveMemoryAuthority({ actor, userInputId: inputId })).toBe('sqlite-v2-opt-in')
      expect(calls).toEqual([{ actor, userInputId: inputId }])
      for (const candidate of [
        { actor: parentActor, userInputId: inputId },
        { actor: peerActor, userInputId: peerInputId },
        { actor: { ...actor, runId: 'peer-run' }, userInputId: inputId },
        { actor: { ...actor, agentId: 'peer-agent' }, userInputId: inputId },
        { actor: { ...actor, rootRunId: 'other-root' }, userInputId: inputId },
        { actor, userInputId: 'root-input' }, { actor, userInputId: inputId.slice(0, 128) },
        { actor, userInputId: inputId + '-substituted' },
      ]) await expect(childDeps.resolveMemoryAuthority(candidate)).rejects.toThrow()
      expect(calls).toHaveLength(1)
    } finally { connection.close(); await bridge.close() }
  })
})
