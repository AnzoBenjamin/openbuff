import { describe, expect, test } from 'bun:test'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'
import type { ExecutionActor, OnExecutionActionStart, RequestToolCallFn, ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import type { StartAgentRunFn } from '@codebuff/common/types/contracts/database'
import { createSupervisedExecutionScope, getAgentRuntimeImpl, type RegisterExecutionActor } from '../impl/agent-runtime'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { buildBridgedChildDeps } from '@codebuff/agent-runtime/supervision/child-bridge-client'
import { buildSupervisedBridgeHandlers } from '@codebuff/agent-runtime/supervision/parent-bridge-server'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { createHostExecutionServices, type ExecutionScope } from '../host-execution'
import { loadHostConfigSnapshot } from '../host-config'
import type { Result, TargetDescription } from '@codebuff/common/types/contracts/execution-context'

const actor = { runId: 'parent-run', rootRunId: 'root-run', agentId: 'parent-agent' }
const logger = { debug() {}, info() {}, warn() {}, error() {} }
function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.cause); return result.value }
function identity(owner: ExecutionActor, input: unknown, actionId = 'action'): ToolExecutionIdentity {
  const basis = { inputHash: hashActionInput('run_terminal_command', input), workspaceRevision: 4 }
  return { ...owner, actionId, attemptId: 'attempt', basis,
    basisId: hashActionInput('openbuff.execution-b02-basis.v1', { basis, workspaceSnapshotId: null }) }
}
function fixture(onStart?: OnExecutionActionStart, hostOperation = false) {
  const controller = new AbortController()
  const executionContext = { execution: { signal: controller.signal }, signal: controller.signal } as ExecutionAdapterContext
  const registrations: Parameters<RegisterExecutionActor>[0][] = []
  const starts: Parameters<OnExecutionActionStart>[0][] = []
  const requests: Parameters<RequestToolCallFn>[0][] = []
  let ids = 0
  const scope = createSupervisedExecutionScope({
    request: { agentType: hostOperation ? 'context-consolidator' : 'fixture', prompt: '', spawnParams: undefined, child: { agentId: 'child-agent' },
      ancestorRunIds: ['root-run', 'parent-run'], ...(hostOperation ? {
        executionHostOperation: { actor, purpose: 'snapshot-consolidation' as const },
      } : { executionIdentity: identity(actor, { agents: [] }, 'spawn') }) },
    executionContext, registerExecutionActor: value => { registrations.push(value) },
    executionForAction: () => executionContext,
    executionForActorOperation: () => executionContext,
    onExecutionActionStart: async start => { starts.push(start); await onStart?.(start) },
    startAgentRun: async () => `issued-${++ids}`,
    requestToolCall: async request => { requests.push(request); return { output: [] } },
    requestMcpToolData: async () => [],
  })
  const startRun = (agentId = 'child-agent', ancestorRunIds = ['root-run', 'parent-run']) => scope.startAgentRun({
    apiKey: '', agentId: hostOperation ? 'context-consolidator' : 'fixture', ancestorRunIds, logger, agentState: { agentId },
  } as Parameters<StartAgentRunFn>[0])
  return { scope, controller, executionContext, registrations, starts, requests, startRun }
}

function authorityFixture(withLookups = true) {
  let now = 100, issued = 0
  const clock = { domainId: 'supervised-descendant-fixture', nowMs: () => now }
  const captured = loadHostConfigSnapshot({ inputs: { environment: {}, platform: 'linux', invocationCwd: '/virtual/project',
    projectRoot: '/virtual/project', home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'none' },
    trust: { ancestorConfig: false, projectReadableRoots: false } }, fs: {
    readFile: () => { throw new Error('Unexpected read') }, stat: () => { throw new Error('Unexpected stat') },
    readDirectory: () => { throw new Error('Unexpected directory read') }, realpath: path => path,
  } })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  const host = value(createHostExecutionServices({ snapshot: captured.snapshot, clock,
    boundary: value(captureRootDeadline({ clock, limit: { kind: 'unbounded' } })),
    childInheritanceEnvironment: {}, inheritEnv: false,
    authorizeAsync: async () => ({ ok: true, basis: 'explicit-policy', decisionId: 'fixture-allow' }),
  }))
  const parent = { runId: 'root', rootRunId: 'root', agentId: 'root-agent' }
  const rootScope = value(host.registerRun({ clientSessionId: 'fixture', rootRunId: 'root', parentRunId: 'root', parentAgentId: parent.agentId }))
  const outerIdentity = identity(parent, {}, 'outer-spawn')
  const outer = value(rootScope.action({ ...outerIdentity, limit: { kind: 'finite', durationMs: 100 } }))
  const registrations: Parameters<RegisterExecutionActor>[0][] = []
  const scopes = new Map<string, ExecutionScope>()
  const actions = new Map<string, { identity: ToolExecutionIdentity; context: ExecutionAdapterContext }>()
  const operations = new Map<string, ExecutionAdapterContext>()
  const requestCancellation = new AbortController()
  const scope = createSupervisedExecutionScope({
    request: { agentType: 'fixture', prompt: '', spawnParams: undefined, child: { agentId: 'child-agent' },
      ancestorRunIds: ['root'], executionIdentity: outerIdentity }, executionContext: outer,
    registerExecutionActor: registration => {
      const actor = registration.actor
      scopes.set(actor.runId, value(host.registerRun({ clientSessionId: 'fixture', rootRunId: actor.rootRunId,
        parentRunId: actor.runId, parentAgentId: actor.agentId }, registration.executionContext)))
      registrations.push(registration)
    },
    onExecutionActionStart: start => {
      const context = value(scopes.get(start.identity.runId)!.action({ ...start.identity,
        signal: requestCancellation.signal, limit: { kind: 'finite', durationMs: 20 } }))
      actions.set(start.identity.actionId, { identity: start.identity, context })
    },
    ...(withLookups ? {
      executionForAction: (candidate: ToolExecutionIdentity) => {
        const registered = actions.get(candidate.actionId)
        if (!registered || JSON.stringify(registered.identity) !== JSON.stringify(candidate)) throw new Error('Unknown original action')
        return registered.context
      },
      executionForActorOperation: (candidate: ExecutionActor) => {
        if (!registrations.some(entry => JSON.stringify(entry.actor) === JSON.stringify(candidate))) throw new Error('Unknown actor')
        let context = operations.get(candidate.runId)
        if (!context) { context = value(scopes.get(candidate.runId)!.operation()); operations.set(candidate.runId, context) }
        return context
      },
    } : {}),
    startAgentRun: async () => `issued-${++issued}`,
    requestToolCall: async () => ({ output: [] }), requestMcpToolData: async () => [],
  })
  const startInitial = () => scope.startAgentRun({ apiKey: '', logger, agentId: 'fixture', ancestorRunIds: ['root'],
    agentState: { agentId: 'child-agent' } } as Parameters<StartAgentRunFn>[0])
  const registerAction = async (actor: ExecutionActor, actionId = 'nested-spawn') => {
    const original = identity(actor, {}, actionId)
    await scope.onExecutionActionStart({ identity: original, toolName: 'run_terminal_command', input: {}, signal: outer.execution.signal! })
    return original
  }
  const startChild = (parentId: string, id: ToolExecutionIdentity, agentId = 'grandchild') => scope.startAgentRun({
    apiKey: '', logger, agentId: 'fixture', ancestorRunIds: ['root', parentId], executionIdentity: id,
    agentState: { agentId },
  } as Parameters<StartAgentRunFn>[0])
  return { host, scopes, scope, outer, registrations, actions, operations, requestCancellation, startInitial, registerAction, startChild,
    issued: () => issued, setNow: (time: number) => { now = time } }
}

describe('supervised descendant authority with real host registries', () => {
  test('ordinary descendants retain the tighter original action deadline and request cancellation', async () => {
    const f = authorityFixture(), childId = (await f.startInitial())!
    const id = await f.registerAction(f.registrations[0].actor)
    const grandchild = (await f.startChild(childId, id))!
    const context = f.actions.get(id.actionId)!.context
    expect(f.registrations[1].executionContext).toBe(context)
    expect(f.registrations[1].executionContext).not.toBe(f.outer)
    expect(f.host.execution.deadline(f.scopes.get(grandchild)!.lifetime)).toMatchObject({ kind: 'finite', expiresAtMs: 120 })
    const childOperation = value(f.scopes.get(grandchild)!.operation({ limit: { kind: 'unbounded' } }))
    f.requestCancellation.abort(new Error('nested original action cancelled'))
    expect(f.outer.execution.signal?.aborted).toBe(false)
    expect(childOperation.execution.signal?.aborted).toBe(true)
    await expect(f.startChild(childId, id, 'late-child')).rejects.toThrow('cancelled')
    expect(f.issued()).toBe(2)
  })

  test('infrastructure descendants inherit their authenticated actor-operation cap and exhausted actions dispatch nothing', async () => {
    const f = authorityFixture(), childId = (await f.startInitial())!
    const id = await f.registerAction(f.registrations[0].actor)
    const grandchild = (await f.startChild(childId, id))!, parent = f.registrations[1].actor
    const spawnPruner = (agentId: string) => f.scope.startAgentRun({ apiKey: '', logger, agentId: 'context-pruner',
      ancestorRunIds: ['root', childId, grandchild], agentState: { agentId },
      executionHostOperation: { actor: parent, purpose: 'semantic-compaction' },
    } as Parameters<StartAgentRunFn>[0])
    const pruner = (await spawnPruner('pruner'))!
    await spawnPruner('second-pruner')
    const context = f.operations.get(grandchild)!
    expect(f.registrations[2].executionContext).toBe(context)
    expect(f.registrations[3].executionContext).toBe(context)
    expect(f.actions.size).toBe(1)
    expect(f.host.execution.deadline(f.scopes.get(pruner)!.lifetime)).toMatchObject({ kind: 'finite', expiresAtMs: 120 })
    const target: TargetDescription = { executable: '/fixture/tool', argv: [], cwd: '/virtual/project', projectRoot: '/virtual/project',
      allowedPaths: ['/virtual/project'], profile: context.profile, mode: 'assistant', processType: 'SYNC', family: 'sync-shell',
      branchId: 'supervised.operation.fixture', adapterOptions: { runtime: 'node' } }
    const launch = value(context.execution.prepareTarget({ target }))
    expect(launch.facts().correlation.kind).toBe('host-operation')
    f.setNow(121)
    let launches = 0
    const permit = await launch.admit()
    if (permit.ok) launch.dispatchNow(permit.value.permit, () => { launches++; return {} })
    expect(permit.ok).toBe(false)
    expect(launches).toBe(0)
    await expect(spawnPruner('late-pruner')).rejects.toThrow()
    expect(f.registrations).toHaveLength(4)
  })

  test('descriptive descendants cannot fall back to outer authority when authenticated lookups are absent', async () => {
    const f = authorityFixture(false), childId = (await f.startInitial())!
    const id = await f.registerAction(f.registrations[0].actor)
    await expect(f.startChild(childId, id)).rejects.toThrow('context is unavailable')
    await expect(f.scope.startAgentRun({ apiKey: '', logger, agentId: 'context-pruner', ancestorRunIds: ['root', childId],
      agentState: { agentId: 'pruner' }, executionHostOperation: { actor: f.registrations[0].actor, purpose: 'semantic-compaction' },
    } as Parameters<StartAgentRunFn>[0])).rejects.toThrow('context is unavailable')
    expect(f.issued()).toBe(1)
  })
})

describe('parent-scoped supervised execution identity', () => {
  test('initial supervised host-operation child uses the captured actor and context without a fabricated B02 attempt', async () => {
    const f = fixture(undefined, true)
    const runId = await f.startRun()
    expect(runId).toBe('issued-1')
    expect(f.registrations[0].parentActor).toEqual(actor)
    expect(f.registrations[0].executionContext).toBe(f.executionContext)
    expect(f.starts).toHaveLength(0)
  })

  test('local runtime registers actual actor IDs and registered parent ancestry', async () => {
    const registrations: Parameters<RegisterExecutionActor>[0][] = []
    const signal = new AbortController().signal
    const context = { execution: { signal }, signal } as ExecutionAdapterContext
    const runtime = getAgentRuntimeImpl({ ...TEST_AGENT_RUNTIME_IMPL, apiKey: 'fixture', processSupervision: false,
      executionForAction: () => context,
      registerExecutionActor: value => { registrations.push(value) } })
    const rootId = (await runtime.startAgentRun({ apiKey: '', logger, agentId: 'template', ancestorRunIds: [],
      agentState: { agentId: 'actual-root' } } as Parameters<StartAgentRunFn>[0]))!
    await runtime.startAgentRun({ apiKey: '', logger, agentId: 'child-template', ancestorRunIds: [rootId],
      agentState: { agentId: 'actual-child' }, executionIdentity: identity(registrations[0].actor, { agents: [] }, 'spawn'),
    } as Parameters<StartAgentRunFn>[0])
    expect(registrations[0].actor.agentId).toBe('actual-root')
    expect(registrations[1].actor.agentId).toBe('actual-child')
    expect(registrations[1].parentActor).toBe(registrations[0].actor)
    expect(registrations[1].actor.rootRunId).toBe(rootId)
    expect(registrations[1].executionContext).toBe(context)
  })

  test('child awaits the existing nonce-preserving bridge round trip before using registered action', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const f = fixture(() => gate), wire: string[] = []
    const bridgeNonce = 'fixture-bridge-nonce'
    const handlers = buildSupervisedBridgeHandlers({ ...TEST_AGENT_RUNTIME_IMPL, ...f.scope, apiKey: 'fixture', logger }, { bridgeNonce })
    const child = buildBridgedChildDeps({
      call: async (method, value) => {
        const encoded = JSON.stringify(value)
        wire.push(encoded)
        const handler = handlers[method]
        if (!handler) throw new Error('Missing bridge handler')
        return handler(JSON.parse(encoded) as never)
      }, notify() {}, close() {}, onClose() {},
    }, { bridgeNonce })
    const runId = (await child.startAgentRun({ apiKey: '', agentId: 'fixture', ancestorRunIds: ['root-run', 'parent-run'], logger,
      agentState: { agentId: 'child-agent' } } as Parameters<StartAgentRunFn>[0]))!
    const input = { command: 'printf fixture' }
    const id = identity({ runId, rootRunId: 'root-run', agentId: 'child-agent' }, input)
    let acknowledged = false
    const started = Promise.resolve(child.onExecutionActionStart({ identity: id, toolName: 'run_terminal_command', input,
      signal: new AbortController().signal })).then(() => { acknowledged = true })
    await Promise.resolve()
    expect(acknowledged).toBe(false)
    expect(f.starts).toHaveLength(1)
    expect(f.starts[0].signal).toBe(f.controller.signal)
    release()
    await started
    await child.requestToolCall({ userInputId: 'input', toolName: 'run_terminal_command', input, executionIdentity: id,
      executionRequestHash: hashActionInput('run_terminal_command', input), signal: new AbortController().signal })
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].signal).toBe(f.controller.signal)
    expect(wire.join('\n')).toContain(bridgeNonce)
    expect(wire.join('\n')).not.toContain('executionContext')
    expect(wire.join('\n')).not.toContain('execution-b02-basis.v1')
  })

  test('host-issued run registration carries exact parent context and accepts registered descendants only', async () => {
    const f = fixture(), runId = (await f.startRun())!
    expect(f.registrations[0].actor).toEqual({ runId, rootRunId: 'root-run', agentId: 'child-agent' })
    expect(f.registrations[0].executionContext).toBe(f.executionContext)
    expect(f.registrations[0].parentActor).toEqual(actor)
    const originalInput = { agents: [] }
    const spawnIdentity = identity(f.registrations[0].actor, originalInput, 'nested-spawn')
    await f.scope.onExecutionActionStart({ identity: spawnIdentity, toolName: 'run_terminal_command', input: originalInput, signal: f.controller.signal })
    const nested = await f.scope.startAgentRun({ apiKey: '', agentId: 'fixture', ancestorRunIds: ['root-run', 'parent-run', runId], logger,
      agentState: { agentId: 'grandchild-agent' }, executionIdentity: spawnIdentity } as Parameters<StartAgentRunFn>[0])
    expect(nested).toBe('issued-2')
    expect(f.registrations[1].parentActor).toEqual(f.registrations[0].actor)
    await expect(f.startRun('spoof', ['root-run', 'sibling-run'])).rejects.toThrow('ancestry')
    await expect(f.startRun('parent-agent', ['root-run', 'parent-run', runId])).rejects.toThrow('ancestry')
  })

  test('supervised infrastructure descendants retain the original scoped context and reject descriptive spoofing', async () => {
    const f = fixture(), runId = (await f.startRun())!, parent = f.registrations[0].actor
    const input = { apiKey: '', agentId: 'context-pruner', ancestorRunIds: ['root-run', 'parent-run', runId], logger,
      agentState: { agentId: 'pruner-child' }, executionHostOperation: { actor: parent, purpose: 'semantic-compaction' } }
    await f.scope.startAgentRun(input as Parameters<StartAgentRunFn>[0])
    expect(f.registrations[1].executionContext).toBe(f.executionContext)
    expect(f.starts).toHaveLength(0)
    await expect(f.scope.startAgentRun({ ...input, agentState: { agentId: 'spoof' },
      executionHostOperation: { actor, purpose: 'semantic-compaction' } } as Parameters<StartAgentRunFn>[0])).rejects.toThrow('origin')
    await expect(f.startRun('missing-origin', ['root-run', 'parent-run', runId])).rejects.toThrow('spawning action')
  })

  test('requires acknowledged action and validates original and forwarded inputs separately', async () => {
    const f = fixture(), runId = (await f.startRun())!
    const input = { command: 'printf fixture' }, forwarded = { ...input, mode: 'assistant' }
    const id = identity({ runId, rootRunId: 'root-run', agentId: 'child-agent' }, input)
    const request = { userInputId: 'input', toolName: 'run_terminal_command', input: forwarded, executionIdentity: id,
      executionRequestHash: hashActionInput('run_terminal_command', forwarded) }
    expect(() => f.scope.requestToolCall(request)).toThrow('registered action')
    await f.scope.onExecutionActionStart({ identity: id, toolName: 'run_terminal_command', input, signal: new AbortController().signal })
    await f.scope.requestToolCall(request)
    expect(f.starts[0].signal).toBe(f.controller.signal)
    expect(f.requests[0].signal).toBe(f.controller.signal)
    expect(f.requests[0].executionIdentity?.basis.inputHash).not.toBe(request.executionRequestHash)
    expect(() => f.scope.requestToolCall({ ...request, input: { command: 'different' } })).toThrow('forwarded input')
    await expect(f.scope.onExecutionActionStart({ identity: { ...id, actionId: 'changed', basis: { inputHash: 'forged' } },
      toolName: 'run_terminal_command', input, signal: f.controller.signal })).rejects.toThrow('basis')
  })

  test('rejects sibling/root actor descriptors and parent cancellation for tools and MCP', async () => {
    const f = fixture(), runId = (await f.startRun())!
    const input = { command: 'printf fixture' }
    const good = identity({ runId, rootRunId: 'root-run', agentId: 'child-agent' }, input)
    for (const spoof of [actor, { ...good, runId: 'sibling-run' }, { ...good, agentId: 'root-agent' }]) {
      await expect(f.scope.onExecutionActionStart({ identity: { ...good, ...spoof }, toolName: 'run_terminal_command', input,
        signal: f.controller.signal })).rejects.toThrow('Unregistered')
      expect(() => f.scope.requestMcpToolData({ mcpConfig: { type: 'stdio', command: 'fixture', args: [], env: {} }, toolNames: null,
        executionActor: spoof })).toThrow('Unregistered')
    }
    f.controller.abort(new Error('parent deadline'))
    await expect(f.scope.onExecutionActionStart({ identity: good, toolName: 'run_terminal_command', input,
      signal: new AbortController().signal })).rejects.toThrow('parent deadline')
    expect(f.requests).toHaveLength(0)
  })
})
