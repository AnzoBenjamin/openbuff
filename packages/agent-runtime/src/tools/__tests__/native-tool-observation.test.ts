import { describe, expect, spyOn, test } from 'bun:test'
import { TEST_AGENT_RUNTIME_IMPL, mockFileContext } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import type { NativeToolObservation } from '@codebuff/common/types/contracts/agent-runtime'
import type { OnExecutionActionStart } from '@codebuff/common/types/contracts/client'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import { jsonToolResult } from '@codebuff/common/util/messages'
import { codebuffToolHandlers } from '../handlers/list'
import { getFileProcessingValues } from '../handlers/tool/write-file'
import { executeCustomToolCall, executeToolCall, type ExecuteToolCallParams } from '../tool-executor'

const input = {
  text: 'Use SQLite because decisions must survive process restarts',
  kind: 'decision' as const,
  evidenceSelectors: ['src/storage.ts'],
}
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }
const successfulOutput = () => jsonToolResult({
  ...input, message: 'Recorded decision with 1 evidence path(s).', evidenceCount: 1,
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(overrides: Partial<ExecuteToolCallParams<'record_decision'>> = {}) {
  const chunks: unknown[] = [], costs: number[] = []
  const agentState = getInitialAgentState()
  agentState.agentId = 'actual-child'
  agentState.runId = 'child-run'
  const params: ExecuteToolCallParams<'record_decision'> = {
    ...TEST_AGENT_RUNTIME_IMPL,
    toolName: 'record_decision', input: structuredClone(input),
    agentContext: {}, agentState, agentStepId: 'step', ancestorRunIds: ['root-run'],
    agentTemplate: { id: 'fixture', displayName: 'Fixture', inputSchema: {}, includeMessageHistory: false,
      inheritParentSystemPrompt: false, outputMode: 'last_message', toolNames: ['record_decision'], programmaticToolNames: [],
      spawnableAgents: [], mcpServers: {}, instructionsPrompt: '', systemPrompt: '', stepPrompt: '' },
    clientSessionId: 'session', fileContext: { ...mockFileContext, projectRoot: '/virtual/project', fileTreeSource: 'virtual',
      fileTree: [], fileTokenScores: {}, knowledgeFiles: {}, customToolDefinitions: {}, tokenCallers: {} },
    fileProcessingState: getFileProcessingValues({}), fingerprintId: 'fingerprint', fullResponse: '',
    localAgentTemplates: {}, previousToolCallFinished: Promise.resolve(), prompt: undefined,
    repoId: undefined, repoUrl: undefined, runId: 'child-run', signal: new AbortController().signal,
    system: '', tools: {}, toolCallId: 'actual-call', toolCalls: [], toolCallsToAddToMessageHistory: [],
    toolResults: [], toolResultsToAddToMessageHistory: [], userId: undefined, userInputId: 'captured-input',
    clock: { now: () => 100 }, logger,
    requestToolCall: async () => { throw new Error('local record must not request SDK dispatch') },
    onCostCalculated: async cost => { costs.push(cost) }, onResponseChunk: chunk => { chunks.push(chunk) },
    ...overrides,
  }
  return { params, chunks, costs }
}

describe('runtime-local completed native observation', () => {
  test('the real local handler is observed once, awaited before UI, with the minted actor and call', async () => {
    const started = deferred(), release = deferred()
    const observations: NativeToolObservation[] = []
    let registration!: Parameters<OnExecutionActionStart>[0]
    const f = fixture({
      onExecutionActionStart: value => { registration = value },
      onNativeToolObservation: async observation => {
        observations.push(observation)
        expect(f.params.agentState.taskMemory?.decisions).toEqual(['[decision] ' + input.text])
        started.resolve()
        await release.promise
      },
    })
    const running = executeToolCall(f.params)
    await started.promise
    expect(f.chunks.some(chunk => (chunk as { type?: string }).type === 'tool_result')).toBe(false)
    expect(observations).toHaveLength(1)
    expect(observations[0].actor).toEqual({ runId: 'child-run', rootRunId: 'root-run', agentId: 'actual-child' })
    expect(observations[0].executionIdentity).toBe(registration.identity)
    expect(observations[0].executionIdentity.actionId).toBe('actual-call')
    expect(observations[0].executionIdentity.basis.inputHash).toBe(hashActionInput('record_decision', input))
    expect(observations[0].callId).toBe('actual-call')
    expect(observations[0].userInputId).toBe('captured-input')
    expect(observations[0].toolName).toBe('record_decision')
    expect(observations[0].signal).toBe(f.params.signal)
    expect(observations[0].input).toEqual(input)
    release.resolve()
    await running
    expect(f.params.toolResults[0].content).toEqual(observations[0].output)
    expect(f.params.agentState.actionOutcomes?.[0]?.outcome).toBe('succeeded')
  })

  test('captures userInputId and ownership before the first workspace await; observer snapshots cannot mutate the result', async () => {
    const gate = deferred(), syncing = deferred()
    let observation!: NativeToolObservation
    const f = fixture({
      input: { ...input, text: '  ' + input.text + '  ', kind: undefined },
      synchronizeWorkspace: async () => { syncing.resolve(); await gate.promise; return undefined },
      onNativeToolObservation: value => {
        observation = value
        ;(value.input as { text: string }).text = 'observer changed input'
        ;(value.output[0].value as { text: string }).text = 'observer changed output'
      },
    })
    const running = executeToolCall(f.params)
    await syncing.promise
    f.params.userInputId = 'wrong-later-input'
    f.params.agentState.agentId = 'wrong-later-agent'
    gate.resolve()
    await running
    expect(observation.userInputId).toBe('captured-input')
    expect(observation.actor.agentId).toBe('actual-child')
    expect(observation.executionIdentity.agentId).toBe('actual-child')
    expect((f.params.toolCalls[0].input as { text: string }).text).toBe(input.text)
    expect(f.params.toolResults[0].content[0]).toMatchObject({ type: 'json', value: { text: input.text } })
    expect(f.params.agentState.taskMemory?.decisions).toEqual(['[decision] ' + input.text])
  })

  test('model input and inherited identities cannot replace the runtime-minted owner', async () => {
    let observation!: NativeToolObservation, registered!: Parameters<OnExecutionActionStart>[0]
    const foreign = { runId: 'sibling', rootRunId: 'foreign-root', agentId: 'foreign-agent', actionId: 'foreign-call', attemptId: 'foreign-attempt',
      basis: { inputHash: 'foreign-hash' }, basisId: 'foreign-basis' }
    const f = fixture({ input: { ...input, actor: foreign, executionIdentity: foreign, userInputId: 'foreign-input' }, executionIdentity: foreign,
      onExecutionActionStart: value => { registered = value }, onNativeToolObservation: value => { observation = value } })
    await executeToolCall(f.params)
    expect(observation.actor).toEqual({ runId: 'child-run', rootRunId: 'root-run', agentId: 'actual-child' })
    expect(observation.executionIdentity).toBe(registered.identity)
    expect(observation.executionIdentity.actionId).toBe('actual-call')
    expect(observation.userInputId).toBe('captured-input')
    expect(observation.input).toEqual(input)
  })

  for (const observer of [undefined, () => { throw new Error('observer threw') }, () => Promise.reject(new Error('observer rejected'))]) {
    test(`absent/throwing/rejecting observer preserves the actual result (${String(observer)})`, async () => {
      const f = fixture({ onNativeToolObservation: observer })
      await executeToolCall(f.params)
      expect(f.params.toolResults[0].content).toEqual(successfulOutput())
      expect(f.params.toolResultsToAddToMessageHistory[0]).toBe(f.params.toolResults[0])
      expect(f.params.agentState.taskMemory?.decisions).toHaveLength(1)
      expect(f.params.agentState.actionOutcomes?.[0]).toMatchObject({ outcome: 'succeeded', effect: { status: 'unobserved', confirmedPaths: [] } })
      expect(f.costs).toEqual([])
      await Promise.resolve()
    })
  }

  test('a timed-out metadata observer cannot hang productive work or leak a late rejection', async () => {
    let reject!: (error: Error) => void
    const warnings: unknown[] = []
    const f = fixture({
      logger: { ...logger, warn: (...args) => { warnings.push(args) } },
      onNativeToolObservation: () => new Promise<void>((_, fail) => { reject = fail }),
    })
    const before = Date.now()
    await executeToolCall(f.params)
    expect(Date.now() - before).toBeLessThan(3_000)
    expect(f.params.toolResults[0].content).toEqual(successfulOutput())
    expect(warnings).toHaveLength(1)
    expect(JSON.stringify(warnings)).toContain('unconfirmed')
    reject(new Error('late observer rejection'))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(f.params.agentState.actionOutcomes?.[0]?.outcome).toBe('succeeded')
  }, 5_000)

  for (const badInput of [
    { ...input, text: '' },
    { ...input, text: 'A decision without its rationale' },
    { ...input, evidenceSelectors: ['.openbuff/private.json'] },
  ]) {
    test(`invalid/failed local record is never observed (${JSON.stringify(badInput)})`, async () => {
      let calls = 0
      const f = fixture({ input: badInput, onNativeToolObservation: () => { calls++ } })
      await executeToolCall(f.params)
      expect(calls).toBe(0)
      expect(f.params.agentState.taskMemory?.decisions ?? []).toEqual([])
    })
  }

  test('malformed, recovered handler failures and delegated native outputs are excluded', async () => {
    for (const mode of ['malformed', 'failed', 'throw', 'delegated'] as const) {
      let observed = 0, delegated = 0
      // The handler registry is the legacy seam; the positive cases above use the real handler.
      const handler = spyOn(codebuffToolHandlers, 'record_decision').mockImplementation(async p => {
        if (mode === 'throw') throw new Error('handler failed')
        if (mode === 'failed') return { output: jsonToolResult({ ...input, message: 'Incomplete record', evidenceCount: 1, errorMessage: 'failed record' }), creditsUsed: 7 }
        if (mode === 'delegated') {
          const requestClientToolCall = (p as unknown as { requestClientToolCall: (call: unknown) => Promise<ReturnType<typeof successfulOutput>> }).requestClientToolCall
          const output = await requestClientToolCall({
            toolName: 'record_decision', toolCallId: 'actual-call', input,
          })
          return { output, creditsUsed: 7 }
        }
        return { output: jsonToolResult({ message: 'malformed success' }) as never, creditsUsed: 7 }
      })
      try {
        const f = fixture({ onNativeToolObservation: () => { observed++ },
          requestToolCall: async () => { delegated++; return { output: successfulOutput() } } })
        await executeToolCall(f.params)
        expect(observed).toBe(0)
        expect(delegated).toBe(mode === 'delegated' ? 1 : 0)
        expect(f.params.toolResults).toHaveLength(1)
        expect(f.costs).toEqual(mode === 'throw' ? [] : [7])
      } finally { handler.mockRestore() }
    }
  })

  test('observer failures preserve native credits and cannot alter mutation authority', async () => {
    const handler = spyOn(codebuffToolHandlers, 'record_decision').mockImplementation(async () => ({ output: successfulOutput(), creditsUsed: 7 }))
    try {
      for (const onNativeToolObservation of [() => { throw new Error('observer failed') }, () => Promise.reject(new Error('observer failed'))]) {
        const f = fixture({ onNativeToolObservation })
        await executeToolCall(f.params)
        expect(f.costs).toEqual([7])
        expect(f.params.toolResults[0].content).toEqual(successfulOutput())
        expect(f.params.agentState.actionOutcomes?.[0]?.effect).toEqual({ status: 'unobserved', receiptIds: [], confirmedPaths: [] })
      }
    } finally { handler.mockRestore() }
  })

  test('settled observers clear the metadata timer and leave no abort-listener imbalance', async () => {
    const controller = new AbortController()
    const scheduled = spyOn(globalThis, 'setTimeout'), cleared = spyOn(globalThis, 'clearTimeout')
    const added = spyOn(controller.signal, 'addEventListener'), removed = spyOn(controller.signal, 'removeEventListener')
    try {
      const f = fixture({ signal: controller.signal, onNativeToolObservation: async () => {} })
      await executeToolCall(f.params)
      const index = scheduled.mock.calls.findIndex(([, ms]) => ms === 2_000)
      expect(index).toBeGreaterThanOrEqual(0)
      const timer = scheduled.mock.results[index].value
      expect(cleared.mock.calls.some(([id]) => id === timer)).toBe(true)
      expect(added.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(removed.mock.calls.filter(([event]) => event === 'abort').length)
    } finally { scheduled.mockRestore(); cleared.mockRestore(); added.mockRestore(); removed.mockRestore() }
  })

  test('an external custom tool named record_decision does not use the local observation seam', async () => {
    let calls = 0
    const f = fixture({ fromHandleSteps: true, onNativeToolObservation: () => { calls++ },
      requestToolCall: async () => ({ output: successfulOutput() }) })
    f.params.fileContext.customToolDefinitions = { record_decision: {
      description: 'External fixture', inputSchema: { type: 'object' },
      identity: { kind: 'custom', toolName: 'record_decision' },
    } }
    await executeCustomToolCall(f.params)
    expect(calls).toBe(0)
    expect(f.params.toolResults[0].content).toEqual(successfulOutput())
    expect(f.params.agentState.taskMemory?.decisions ?? []).toEqual([])
  })

  test('cancellation after the local effect keeps its result and observer, but stops the next dispatch', async () => {
    const controller = new AbortController(), observations: NativeToolObservation[] = []
    const f = fixture({ signal: controller.signal,
      logger: { ...logger, debug: (_, message) => { if (message === 'Recorded decision') controller.abort(new Error('caller cancelled')) } },
      onNativeToolObservation: value => { observations.push(value) } })
    await expect(executeToolCall(f.params)).rejects.toThrow('caller cancelled')
    expect(observations).toHaveLength(1)
    expect(observations[0].signal).toBe(controller.signal)
    expect(observations[0].signal.aborted).toBe(true)
    expect(f.params.toolResults[0].content).toEqual(successfulOutput())
    expect(f.params.agentState.actionOutcomes?.[0]?.outcome).toBe('succeeded')
    expect(f.params.agentState.taskMemory?.decisions).toHaveLength(1)
    await expect(executeToolCall({ ...f.params, toolCallId: 'next-call' })).rejects.toThrow('caller cancelled')
    expect(observations).toHaveLength(1)
    expect(f.params.toolResults).toHaveLength(1)
  })

  test('cancellation while observing preserves completed bookkeeping without replacing the signal', async () => {
    const controller = new AbortController()
    const f = fixture({ signal: controller.signal, onNativeToolObservation: async observation => {
      expect(observation.signal).toBe(controller.signal)
      controller.abort(new Error('cancelled during metadata'))
      await Promise.resolve()
    } })
    await expect(executeToolCall(f.params)).rejects.toThrow('cancelled during metadata')
    expect(f.params.toolResults[0].content).toEqual(successfulOutput())
    expect(f.params.agentState.actionOutcomes?.[0]?.outcome).toBe('succeeded')
  })

  test('pre-dispatch cancellation still records no local effect or observation', async () => {
    const controller = new AbortController()
    let calls = 0
    const f = fixture({ signal: controller.signal,
      synchronizeWorkspace: async () => { controller.abort(new Error('cancelled before dispatch')); return undefined },
      onNativeToolObservation: () => { calls++ } })
    await expect(executeToolCall(f.params)).rejects.toThrow('cancelled before dispatch')
    expect(calls).toBe(0)
    expect(f.params.toolResults).toHaveLength(0)
    expect(f.params.agentState.taskMemory?.decisions ?? []).toEqual([])
  })
})
