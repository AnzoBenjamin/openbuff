import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import type { NativeToolObservation, SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'
import type { ExecutionActor, OnExecutionActionStart, ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import { jsonToolResult } from '@codebuff/common/util/messages'
import { buildBridgedChildDeps, connectChildBridge } from '@codebuff/agent-runtime/supervision/child-bridge-client'
import { buildSupervisedBridgeHandlers, startParentBridgeServer } from '@codebuff/agent-runtime/supervision/parent-bridge-server'
import { buildDefaultSpawnSupervised, isSupervisedSpawnSupported } from '@codebuff/agent-runtime/supervision/supervised-spawn'
import { createSupervisedExecutionScope } from '../impl/agent-runtime'

const logger = { debug() {}, info() {}, warn() {}, error() {} }
const parent = Object.freeze({ runId: 'root-run', rootRunId: 'root-run', agentId: 'root-agent' })
const input = { text: 'Use SQLite because decisions must survive process restarts', kind: 'decision' as const, evidenceSelectors: ['src/storage.ts'] }
function identity(actor: ExecutionActor, toolName: string, value: unknown, actionId = 'call'): ToolExecutionIdentity {
  const basis = Object.freeze({ inputHash: hashActionInput(toolName, value), workspaceRevision: 1 })
  return Object.freeze({ ...actor, actionId, attemptId: 'attempt', basis,
    basisId: hashActionInput('openbuff.execution-b02-basis.v1', { basis, workspaceSnapshotId: null }) })
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function bounded<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('observer bridge did not settle')), ms)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
function fixture(onObserve?: (value: NativeToolObservation) => void | Promise<void>) {
  const controller = new AbortController(), captures: NativeToolObservation[] = []
  const starts: Parameters<OnExecutionActionStart>[0][] = []
  const executionContext = { execution: { signal: controller.signal }, signal: controller.signal } as ExecutionAdapterContext
  const request: SupervisedSpawnRequest = {
    agentType: 'fixture-child', prompt: 'Remember the storage decision', spawnParams: undefined,
    child: { agentId: 'actual-child' }, userInputId: 'root-input-child-actual-child', ancestorRunIds: ['root-run'],
    executionIdentity: identity(parent, 'spawn_agents', { agents: [] }, 'spawn'),
  }
  let runIds = 0
  const scope = createSupervisedExecutionScope({
    request, executionContext, registerExecutionActor: () => {},
    onExecutionActionStart: start => { starts.push(start) },
    onNativeToolObservation: async value => { captures.push(value); await onObserve?.(value) },
    startAgentRun: async () => `issued-${++runIds}`, requestToolCall: async () => ({ output: [] }), requestMcpToolData: async () => [],
  })
  const start = async (rawInput: unknown = input) => {
    const runId = (await scope.startAgentRun({ apiKey: '', logger, agentId: request.agentType,
      ancestorRunIds: ['root-run'], agentState: { agentId: 'actual-child' } } as never))!
    const actor = Object.freeze({ runId, rootRunId: 'root-run', agentId: 'actual-child' })
    const executionIdentity = identity(actor, 'record_decision', rawInput)
    await scope.onExecutionActionStart({ identity: executionIdentity, toolName: 'record_decision', input: rawInput, signal: controller.signal })
    const observation: NativeToolObservation = { actor, executionIdentity, toolName: 'record_decision', callId: 'call',
      userInputId: request.userInputId!, input: structuredClone(input),
      output: jsonToolResult({ ...input, message: 'Recorded decision', evidenceCount: 1 }), signal: new AbortController().signal }
    return observation
  }
  return { request, scope, start, controller, captures, starts }
}
async function bridgeFor(scope: ReturnType<typeof fixture>['scope']) {
  const dir = mkdtempSync(join(tmpdir(), 'native-observer-bridge-'))
  const table = buildSupervisedBridgeHandlers({ ...TEST_AGENT_RUNTIME_IMPL, ...scope, apiKey: 'fixture', logger })
  const server = startParentBridgeServer(table, join(dir, 'rpc.sock'))
  try {
    await server.ready
    const client = await connectChildBridge(join(dir, 'rpc.sock'))
    return { child: buildBridgedChildDeps(client, { bridgeNonce: table.bridgeNonce }), close: async () => {
      client.close(); await server.close(); rmSync(dir, { recursive: true, force: true })
    } }
  } catch (error) { await server.close(); rmSync(dir, { recursive: true, force: true }); throw error }
}

describe('supervised completed native observation transport', () => {
  test('the real socket RPC awaits the host observer, with the authenticated actor signal', async () => {
    const observing = deferred(), release = deferred()
    const f = fixture(async () => { observing.resolve(); await release.promise })
    const observation = await f.start(), bridge = await bridgeFor(f.scope)
    try {
      let acknowledged = false
      const pending = Promise.resolve(bridge.child.onNativeToolObservation(observation)).then(() => { acknowledged = true })
      await bounded(observing.promise)
      expect(acknowledged).toBe(false)
      expect(f.captures).toHaveLength(1)
      expect(f.captures[0].actor).toEqual(observation.actor)
      expect(f.captures[0].executionIdentity).toEqual(observation.executionIdentity)
      expect(f.captures[0].signal).toBe(f.controller.signal)
      expect(f.captures[0].signal).toBe(f.starts[0].signal)
      expect(f.captures[0].output).toEqual(observation.output)
      release.resolve()
      await bounded(pending)
      expect(acknowledged).toBe(true)
    } finally { release.resolve(); await bridge.close() }
  })

  test('validated input hash correlation tolerates native defaults/trim without changing the original action basis', async () => {
    const rawInput = { text: '  ' + input.text + '  ', evidenceSelectors: 'src/storage.ts' }
    const f = fixture(), observation = await f.start(rawInput), bridge = await bridgeFor(f.scope)
    try {
      await bounded(Promise.resolve(bridge.child.onNativeToolObservation(observation)))
      expect(f.captures).toHaveLength(1)
      expect(f.captures[0].input).toEqual(input)
      expect(f.captures[0].executionIdentity.basis.inputHash).toBe(hashActionInput('record_decision', rawInput))
      expect(f.captures[0].executionIdentity.basis.inputHash).not.toBe(hashActionInput('record_decision', input))
    } finally { await bridge.close() }
  })

  test('cancelled metadata retains the authenticated cancelled host signal while subsequent dispatch stays refused', async () => {
    const f = fixture(), observation = await f.start(), bridge = await bridgeFor(f.scope)
    f.controller.abort(new Error('host cancelled'))
    try {
      await bounded(Promise.resolve(bridge.child.onNativeToolObservation(observation)))
      expect(f.captures).toHaveLength(1)
      expect(f.captures[0].signal).toBe(f.controller.signal)
      expect(f.captures[0].signal.aborted).toBe(true)
      await expect(bridge.child.requestToolCall({ userInputId: observation.userInputId, callId: observation.callId,
        toolName: 'record_decision', input, executionIdentity: observation.executionIdentity,
        executionRequestHash: hashActionInput('record_decision', input), signal: new AbortController().signal })).rejects.toThrow('host cancelled')
    } finally { await bridge.close() }
  })

  test('sibling/root, actor/action, call, input and task substitution are refused even after cancellation', async () => {
    const f = fixture(), observation = await f.start(), bridge = await bridgeFor(f.scope)
    f.controller.abort()
    try {
      for (const changed of [
        { actor: parent }, { actor: { ...observation.actor, runId: 'sibling-run' } },
        { executionIdentity: { ...observation.executionIdentity, agentId: 'root-agent' } },
        { executionIdentity: { ...observation.executionIdentity, attemptId: 'unknown-attempt' } },
        { executionIdentity: { ...observation.executionIdentity, basisId: 'changed-basis' } },
        { callId: 'substituted-call' }, { userInputId: 'root-input-other-child' },
        { input: { ...input, text: 'Substituted claim because the peer chose another input' } },
        { toolName: 'read_files' },
      ]) {
        await expect(Promise.resolve(bridge.child.onNativeToolObservation({ ...observation, ...changed } as NativeToolObservation))).rejects.toThrow()
      }
      expect(f.captures).toHaveLength(0)
    } finally { await bridge.close() }
  })

  test('a missing parent hook is an explicit awaited RPC refusal, not a silent successful notification', async () => {
    const f = fixture(), observation = await f.start()
    const table = buildSupervisedBridgeHandlers({ ...TEST_AGENT_RUNTIME_IMPL, apiKey: 'fixture', logger })
    const child = buildBridgedChildDeps({
      call: async (method, params) => table[method]!(params as never),
      notify: () => { throw new Error('metadata must not use notify') }, close() {}, onClose() {},
    }, { bridgeNonce: table.bridgeNonce })
    await expect(Promise.resolve(child.onNativeToolObservation(observation))).rejects.toThrow('unavailable')
  })

  test('a timed-out awaited host hook releases RPC occupancy and observes its late rejection', async () => {
    let reject!: (error: Error) => void, calls = 0
    const pending = new Promise<void>((_, fail) => { reject = fail })
    const f = fixture(() => ++calls === 1 ? pending : undefined)
    const observation = await f.start(), bridge = await bridgeFor(f.scope)
    try {
      await expect(bounded(Promise.resolve(bridge.child.onNativeToolObservation(observation)))).rejects.toThrow('unconfirmed')
      reject(new Error('late host observer rejection'))
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      await bounded(Promise.resolve(bridge.child.onNativeToolObservation(observation)))
      expect(f.captures).toHaveLength(2)
      expect(f.controller.signal.aborted).toBe(false)
    } finally { reject(new Error('fixture cleanup')); await bridge.close() }
  }, 5_000)

  test.skipIf(process.platform !== 'linux' || !isSupervisedSpawnSupported())(
    'a real supervised child local handler notifies the authenticated parent before its native UI result',
    async () => {
      const f = fixture(), sequence: string[] = []
      const scope = { ...f.scope, onNativeToolObservation: async (observation: NativeToolObservation) => {
        sequence.push('observation')
        await f.scope.onNativeToolObservation!(observation)
      } }
      const deps = { ...TEST_AGENT_RUNTIME_IMPL, ...scope, apiKey: 'fixture', logger,
        promptAiSdk: async () => ({ aborted: false as const, value: 'done' }),
        promptAiSdkStream: async function* () {
          yield { type: 'tool-call' as const, toolCallId: 'real-child-record', toolName: 'record_decision', input }
          yield { type: 'tool-call' as const, toolCallId: 'finish', toolName: 'end_turn', input: {} }
          return { aborted: false as const, value: 'done' }
        },
        sendAction: (value: unknown) => {
          if (JSON.stringify(value).includes('"type":"tool_result"') && JSON.stringify(value).includes('record_decision')) sequence.push('ui-result')
        },
        sendSubagentChunk() {}, handleStepsLogChunk() {},
      }
      const seam = buildDefaultSpawnSupervised({}, buildSupervisedBridgeHandlers(deps))
      const result = await bounded(seam({ ...f.request, timeoutMs: 15_000,
        fileContext: { projectRoot: '/virtual/project', fileTreeSource: 'virtual', fileTree: [], fileTokenScores: {}, knowledgeFiles: {}, customToolDefinitions: {}, tokenCallers: {} },
        localAgentTemplates: { 'fixture-child': { id: 'fixture-child', displayName: 'Observer child', model: 'fixture/model',
          mcpServers: {}, toolNames: ['record_decision', 'end_turn'], programmaticToolNames: [], spawnableAgents: [],
          systemPrompt: 'Fixture', instructionsPrompt: '', stepPrompt: '', inputSchema: {},
          includeMessageHistory: false, inheritParentSystemPrompt: false, outputMode: 'last_message' } },
      }), 20_000)
      expect(result.outcome).toBe('ok')
      expect(result.receipt).toMatchObject({ status: 'completed' })
      expect(f.captures).toHaveLength(1)
      expect(f.captures[0].callId).toBe('real-child-record')
      expect(f.captures[0].actor).toEqual({ runId: 'issued-1', rootRunId: 'root-run', agentId: 'actual-child' })
      expect(f.captures[0].signal).toBe(f.controller.signal)
      expect(sequence).toEqual(['observation', 'ui-result'])
    }, 25_000,
  )
})
