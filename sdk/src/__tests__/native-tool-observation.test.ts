import { describe, expect, test } from 'bun:test'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import type { NativeToolObservation } from '@codebuff/common/types/contracts/agent-runtime'
import type { ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { MemoryQueryOutcomeSchema, ProjectIdSchema, type MemoryEventDraft } from '@codebuff/common/types/memory-v2'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import { jsonToolResult } from '@codebuff/common/util/messages'
import { getAgentRuntimeImpl } from '../impl/agent-runtime'
import { buildNativeToolObservationReporter } from '../run'
import { MemoryV2Coordinator } from '../services/memory-v2/coordinator'
import type { MemoryRepositoryV2 } from '../services/memory-v2/types'

const actor = Object.freeze({ runId: 'child-run', rootRunId: 'root-run', agentId: 'actual-child' })
const input = { text: 'Use SQLite because decisions must survive process restarts', kind: 'decision' as const, evidenceSelectors: ['src/storage.ts'] }
const output = () => jsonToolResult({ ...input, message: 'Recorded decision', evidenceCount: 1 })
function identity(): ToolExecutionIdentity {
  const basis = { inputHash: hashActionInput('record_decision', input), workspaceRevision: 3 }
  return Object.freeze({ ...actor, actionId: 'call', attemptId: 'attempt', basis,
    basisId: hashActionInput('openbuff.execution-b02-basis.v1', { basis, workspaceSnapshotId: 'snapshot' }), workspaceSnapshotId: 'snapshot' })
}
function fixture() {
  const signal = new AbortController().signal, executionIdentity = identity()
  const captures: Parameters<MemoryV2Coordinator['recordToolObservation']>[0][] = []
  const warnings: unknown[] = []
  const registration = { actor, userInputId: 'root-input-child-actual-child' }
  const start = { identity: executionIdentity, toolName: 'record_decision', nativeObservation: { inputHash: hashActionInput('record_decision', input), signal } }
  const params: Parameters<typeof buildNativeToolObservationReporter>[0] = {
    coordinator: { recordToolObservation: async value => { captures.push(value) } },
    registeredActor: () => registration, registeredAction: () => start,
    workspaceState: () => undefined,
    logger: { warn: (...args: unknown[]) => { warnings.push(args) } },
  }
  const observation: NativeToolObservation = { actor, executionIdentity, callId: 'call', userInputId: registration.userInputId,
    toolName: 'record_decision', input: structuredClone(input), output: output(), signal }
  return { params, observation, registration, start, captures, warnings }
}

describe('host-owned native observation wiring and correlation', () => {
  test('getAgentRuntimeImpl conditionally carries the same optional callback', () => {
    const params = { ...TEST_AGENT_RUNTIME_IMPL, processSupervision: false }
    expect('onNativeToolObservation' in getAgentRuntimeImpl(params)).toBe(false)
    const onNativeToolObservation = () => {}
    const deps = getAgentRuntimeImpl({ ...params, onNativeToolObservation })
    expect(deps.onNativeToolObservation).toBe(onNativeToolObservation)
  })

  test('no Memory V2 configuration installs no observer; unavailable repository still installs coordinator degradation', () => {
    const f = fixture()
    expect(buildNativeToolObservationReporter({ ...f.params, coordinator: undefined })).toBeUndefined()
    const coordinator = new MemoryV2Coordinator({ projectId: ProjectIdSchema.parse('project:unavailable'), capture: 'safe', authority: 'sqlite-v2-opt-in' })
    expect(typeof buildNativeToolObservationReporter({ ...f.params, coordinator })).toBe('function')
  })

  test('forwards a valid correlated completion exactly once as native, never as MCP or canonical verification', async () => {
    const f = fixture(), report = buildNativeToolObservationReporter(f.params)!
    await report(f.observation)
    await report(structuredClone({ ...f.observation, signal: undefined }) as never)
    await report(f.observation)
    expect(f.captures).toHaveLength(1)
    expect(f.captures[0]).toEqual({
      toolName: 'record_decision', callId: 'call', userInputId: f.registration.userInputId,
      input, output: output(), workspaceState: undefined, native: true, mcp: false, completed: true,
    })
    expect(JSON.stringify(f.captures)).not.toContain('verifiedAt')
  })

  test('completed metadata can correlate an already-cancelled actual signal without execution reauthorization', async () => {
    const f = fixture(), controller = new AbortController()
    f.start.nativeObservation.signal = controller.signal
    const observation = { ...f.observation, signal: controller.signal }
    controller.abort(new Error('caller cancelled'))
    await buildNativeToolObservationReporter(f.params)!(observation)
    expect(f.captures).toHaveLength(1)
    expect(observation.signal.aborted).toBe(true)
  })

  for (const substitution of [
    { actor: { ...actor, runId: 'sibling-run' } },
    { actor: { ...actor, agentId: 'root-agent' } },
    { executionIdentity: { ...identity(), runId: 'sibling-run' } },
    { executionIdentity: { ...identity(), rootRunId: 'foreign-root' } },
    { executionIdentity: { ...identity(), attemptId: 'other-attempt' } },
    { executionIdentity: { ...identity(), basisId: 'forged-basis' } },
    { executionIdentity: { ...identity(), workspaceSnapshotId: 'other-snapshot' } },
    { executionIdentity: { ...identity(), basis: { ...identity().basis, workspaceRevision: 4 } } },
    { executionIdentity: { ...identity(), basis: { ...identity().basis, inputHash: 'forged-hash' } } },
    { callId: 'other-call' }, { userInputId: 'sibling-input' }, { toolName: 'read_files' },
    { input: { ...input, text: 'A substituted claim because it is not the registered input' } },
    { signal: new AbortController().signal },
    { output: jsonToolResult({ ...input, evidenceCount: 'invalid' }) },
    { output: jsonToolResult({ errorMessage: 'local record failed' }) },
    { output: jsonToolResult({ ...input, message: 'Incomplete record', evidenceCount: 1, errorMessage: 'failed record' }) },
  ]) {
    test(`rejects completion substitution ${JSON.stringify(substitution)}`, async () => {
      const f = fixture()
      await buildNativeToolObservationReporter(f.params)!({ ...f.observation, ...substitution } as NativeToolObservation)
      expect(f.captures).toHaveLength(0)
      expect(f.warnings).toHaveLength(1)
    })
  }

  test('requires private actor/action registration and a record_decision start, not just a plausible descriptor', async () => {
    for (const change of [
      { registeredActor: () => undefined },
      { registeredAction: () => undefined },
      { registeredAction: () => ({ ...fixture().start, toolName: 'run_terminal_command' }) },
      { registeredAction: () => ({ ...fixture().start, nativeObservation: undefined }) },
      { registeredActor: () => ({ actor, userInputId: undefined }) },
    ]) {
      const f = fixture()
      await buildNativeToolObservationReporter({ ...f.params, ...change })!(f.observation)
      expect(f.captures).toHaveLength(0)
    }
  })

  test('handler verifiedAt claims are stripped, not forwarded as canonical verification', async () => {
    const f = fixture()
    await buildNativeToolObservationReporter(f.params)!({ ...f.observation,
      output: jsonToolResult({ ...input, message: 'Recorded decision', evidenceCount: 1, verifiedAt: 100 }) })
    expect(f.captures).toHaveLength(1)
    expect(JSON.stringify(f.captures)).not.toContain('verifiedAt')
  })

  test('an unavailable repository keeps honest coordinator degradation while the observer remains installed', async () => {
    const f = fixture(), state = getInitialAgentState()
    const coordinator = new MemoryV2Coordinator({ projectId: ProjectIdSchema.parse('project:unavailable'), authority: 'sqlite-v2-opt-in', capture: 'safe' })
    await coordinator.prepareTurn({ agentState: state, trustedUserInputId: 'root-input', query: 'remember' })
    const report = buildNativeToolObservationReporter({ ...f.params, coordinator })!
    await report(f.observation)
    expect(state.memoryAuthority).toMatchObject({ active: 'sqlite-v2-opt-in', reason: 'backend-unavailable' })
    expect(state.memoryV2Context).toBeUndefined()
  })

  test('isolates coordinator failures and keeps capture input/output separate from runtime result objects', async () => {
    const f = fixture()
    f.params.coordinator = { recordToolObservation: async captured => {
      ;(captured.input as { text: string }).text = 'changed by coordinator'
      throw new Error('capture failed')
    } }
    await buildNativeToolObservationReporter(f.params)!(f.observation)
    expect(f.observation.input.text).toBe(input.text)
    expect(f.observation.output).toEqual(output())
    expect(f.warnings).toHaveLength(1)
  })
})

const projectId = ProjectIdSchema.parse('project:completed-observer')
const at = '2026-11-01T00:00:00.000Z'
function repositoryFixture() {
  const events: MemoryEventDraft[] = []
  let holdDedup: Promise<void> | undefined
  const repository: MemoryRepositoryV2 = {
    append: async request => {
      events.push(...request.events)
      return { outcome: 'appended', entries: request.events.map((event, index) => ({ eventId: event.eventId, sequence: events.length + index, duplicate: false })), lastEventId: request.events.at(-1)!.eventId }
    },
    query: async request => MemoryQueryOutcomeSchema.parse({ outcome: 'result', result: {
      schemaVersion: 2, queryId: request.queryId, projectId, generatedAt: at,
      matchedTasks: [], verifiedKnowledge: [], reusableDiscovery: [], rereadRequired: [], historicalContext: [],
      degradation: { state: 'none' }, rankingReasons: [],
    } }),
    export: async () => ({ outcome: 'page', events: [], nextAfterEventId: null }),
    getClaimDedup: async () => { await holdDedup; return { status: 'ok', entries: [] } },
    verify: async () => { throw new Error('explicit knowledge must remain unverified') },
    rebuild: async () => { throw new Error('not used') }, health: async () => { throw new Error('not used') },
  }
  const coordinator = new MemoryV2Coordinator({ repository, projectId, authority: 'sqlite-v2-opt-in', capture: 'safe' }, undefined, () => at)
  const state = getInitialAgentState()
  const capture = () => coordinator.recordToolObservation({ toolName: 'record_decision', callId: 'call', userInputId: 'input', input, output: output(), native: true, mcp: false, completed: true })
  return { coordinator, state, events, capture, hold: (promise?: Promise<void>) => { holdDedup = promise } }
}

describe('completed-observation coordinator bookkeeping', () => {
  test('an active prepared turn accepts completed native metadata after cancellation without verification', async () => {
    const f = repositoryFixture(), controller = new AbortController()
    await f.coordinator.prepareTurn({ agentState: f.state, trustedUserInputId: 'input', query: 'remember', signal: controller.signal })
    controller.abort()
    await f.capture()
    const observations = f.events.filter(event => event.eventType === 'observation.recorded')
    expect(observations).toHaveLength(1)
    expect(observations[0].eventType === 'observation.recorded' && observations[0].payload.observation.summary).toBe(input.text)
    expect(f.events.some(event => event.eventType === 'evidence.verified')).toBe(false)
  })

  test('ordinary cancellation-sensitive captures are unchanged', async () => {
    const f = repositoryFixture(), controller = new AbortController()
    await f.coordinator.prepareTurn({ agentState: f.state, trustedUserInputId: 'input', query: 'remember', signal: controller.signal })
    controller.abort()
    await f.coordinator.recordToolObservation({ toolName: 'record_decision', callId: 'ordinary', userInputId: 'input', input, output: output(), native: true })
    expect(f.events.filter(event => event.eventType === 'observation.recorded')).toHaveLength(0)
  })

  test('a replaced preparation generation cannot append a late completed observation into the next turn', async () => {
    const f = repositoryFixture()
    await f.coordinator.prepareTurn({ agentState: f.state, trustedUserInputId: 'input', query: 'remember' })
    let release!: () => void
    f.hold(new Promise<void>(resolve => { release = resolve }))
    const pending = f.capture()
    await Promise.resolve()
    f.hold()
    await f.coordinator.prepareTurn({ agentState: f.state, trustedUserInputId: 'next-input', query: 'next' })
    release()
    await pending
    expect(f.events.filter(event => event.eventType === 'observation.recorded')).toHaveLength(0)
  })

  test('a finished turn still rejects late completed metadata', async () => {
    const f = repositoryFixture()
    await f.coordinator.prepareTurn({ agentState: f.state, trustedUserInputId: 'input', query: 'remember' })
    await f.coordinator.finishTurn({ agentState: f.state, output: { type: 'structuredOutput', value: {} } })
    await f.capture()
    expect(f.events.filter(event => event.eventType === 'observation.recorded')).toHaveLength(0)
  })
})
