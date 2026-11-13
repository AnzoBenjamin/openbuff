import { describe, expect, test } from 'bun:test'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import type { ExecutionActor, ExecutionHostOperationOrigin, ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import type { StartAgentRunFn } from '@codebuff/common/types/contracts/database'
import type { ExecutionAdapterContext, Result, TargetDescription } from '@codebuff/common/types/contracts/execution-context'
import { createHostExecutionServices, type ExecutionScope } from '../host-execution'
import { loadHostConfigSnapshot } from '../host-config'
import { getAgentRuntimeImpl, type RegisterExecutionActor } from '../impl/agent-runtime'

function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.cause); return result.value }
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const unbounded = { kind: 'unbounded' } as const
const key = (identity: ToolExecutionIdentity) => JSON.stringify([identity.runId, identity.agentId, identity.actionId, identity.attemptId])
function action(actor: ExecutionActor, actionId = 'spawn-action'): ToolExecutionIdentity {
  const basis = { inputHash: hashActionInput('spawn_agents', { agents: [{ agent_type: 'fixture-child' }] }) }
  return Object.freeze({ ...actor, actionId, attemptId: 'attempt', basis: Object.freeze(basis),
    basisId: hashActionInput('openbuff.execution-b02-basis.v1', { basis, workspaceSnapshotId: null }) })
}

function fixture() {
  let now = 100
  const clock = { domainId: 'inprocess-lifetime-fixture', nowMs: () => now }
  const captured = loadHostConfigSnapshot({ inputs: { environment: {}, platform: 'linux', invocationCwd: '/virtual/project',
    projectRoot: '/virtual/project', home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'none' },
    trust: { ancestorConfig: false, projectReadableRoots: false } }, fs: {
    readFile: () => { throw new Error('Unexpected config read') }, stat: () => { throw new Error('Unexpected stat') },
    readDirectory: () => { throw new Error('Unexpected directory read') }, realpath: path => path,
  } })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  const host = value(createHostExecutionServices({ snapshot: captured.snapshot, clock,
    boundary: value(captureRootDeadline({ clock, limit: unbounded })), childInheritanceEnvironment: {}, inheritEnv: false,
    authorizeAsync: async () => ({ ok: true, basis: 'explicit-policy', decisionId: 'fixture-allow' }),
  }))
  const registrations: Parameters<RegisterExecutionActor>[0][] = []
  const scopes = new Map<string, ExecutionScope>()
  const actions = new Map<string, { identity: ToolExecutionIdentity; context: ExecutionAdapterContext }>()
  let lookups = 0
  let operationLookups = 0
  const operations = new Map<string, ExecutionAdapterContext>()
  const runtime = getAgentRuntimeImpl({ ...TEST_AGENT_RUNTIME_IMPL, apiKey: 'fixture', hostServices: host,
    clientEnv: TEST_AGENT_RUNTIME_IMPL.clientEnv, processSupervision: false,
    executionForAction: (identity: ToolExecutionIdentity) => {
      lookups++
      const registered = actions.get(key(identity))
      if (!registered || JSON.stringify(registered.identity) !== JSON.stringify(identity)) throw new Error('Unknown original spawn action')
      return registered.context
    },
    executionForActorOperation: (actor: ExecutionActor) => {
      operationLookups++
      if (!registrations.some(record => JSON.stringify(record.actor) === JSON.stringify(actor))) throw new Error('Unknown operation actor')
      let context = operations.get(actor.runId)
      if (!context) { context = value(scopes.get(actor.runId)!.operation()); operations.set(actor.runId, context) }
      return context
    },
    registerExecutionActor: registration => {
      const actor = registration.actor
      const scope = value(host.registerRun({ clientSessionId: 'fixture-session', rootRunId: actor.rootRunId,
        parentRunId: actor.runId, parentAgentId: actor.agentId }, registration.executionContext))
      scopes.set(actor.runId, scope)
      registrations.push(registration)
    },
  } as Parameters<typeof getAgentRuntimeImpl>[0])
  const start = (agentId: string, ancestorRunIds: string[], executionIdentity?: ToolExecutionIdentity,
    executionHostOperation?: ExecutionHostOperationOrigin) => runtime.startAgentRun({
    apiKey: '', logger, agentId: executionHostOperation?.purpose === 'semantic-compaction' ? 'context-pruner' :
      executionHostOperation?.purpose === 'snapshot-consolidation' ? 'context-consolidator' : 'fixture-template',
    ancestorRunIds, agentState: { agentId }, executionIdentity, executionHostOperation,
  } as Parameters<StartAgentRunFn>[0])
  const registerAction = (identity: ToolExecutionIdentity, signal?: AbortSignal) => {
    const context = value(scopes.get(identity.runId)!.action({ ...identity, signal, limit: { kind: 'finite', durationMs: 40 } }))
    actions.set(key(identity), { identity, context })
    return context
  }
  return { host, runtime, registrations, scopes, actions, start, registerAction, setNow: (value: number) => { now = value },
    lookups: () => lookups, operationLookups: () => operationLookups }
}

describe('in-process actor spawning-action lifetime', () => {
  test('explicit infrastructure children use honest memoized host-operation authority under the parent cap', async () => {
    const f = fixture(), rootId = (await f.start('root-agent', []))!
    const cancelled = new AbortController(), origin = action(f.registrations[0].actor)
    f.registerAction(origin, cancelled.signal)
    const parentId = (await f.start('parent', [rootId], origin))!
    const parent = f.registrations[1].actor
    const first = (await f.start('pruner', [rootId, parentId], undefined, { actor: parent, purpose: 'semantic-compaction' }))!
    const second = (await f.start('consolidator', [rootId, parentId], undefined, { actor: parent, purpose: 'snapshot-consolidation' }))!
    const context = f.registrations[2].executionContext!
    expect(f.registrations[3].executionContext).toBe(context)
    expect(f.operationLookups()).toBe(1)
    expect(f.actions.size).toBe(1)
    const target: TargetDescription = { executable: '/fixture/tool', argv: [], cwd: '/virtual/project', projectRoot: '/virtual/project',
      allowedPaths: ['/virtual/project'], profile: context.profile, mode: 'assistant', processType: 'SYNC', family: 'sync-shell',
      branchId: 'host-operation.fixture', adapterOptions: { runtime: 'node' } }
    expect(value(context.execution.prepareTarget({ target })).facts().correlation.kind).toBe('host-operation')
    for (const id of [first, second]) expect(f.host.execution.deadline(f.scopes.get(id)!.lifetime)).toMatchObject({ kind: 'finite', expiresAtMs: 140 })
    cancelled.abort(new Error('original parent cancelled'))
    await expect(f.start('late-pruner', [rootId, parentId], undefined, { actor: parent, purpose: 'semantic-compaction' })).rejects.toThrow()
  })

  test('host-operation descriptions cannot select another actor or accompany a B02 identity', async () => {
    const f = fixture(), rootId = (await f.start('root-agent', []))!
    const parent = f.registrations[0].actor, origin = action(parent)
    f.registerAction(origin)
    await expect(f.start('spoof', [rootId], undefined, { actor: { ...parent, agentId: 'sibling' }, purpose: 'semantic-compaction' })).rejects.toThrow('origin')
    await expect(f.start('mixed', [rootId], origin, { actor: parent, purpose: 'semantic-compaction' })).rejects.toThrow('origin')
    await expect(f.runtime.startAgentRun({ apiKey: '', logger, agentId: 'arbitrary-template', ancestorRunIds: [rootId],
      agentState: { agentId: 'arbitrary-child' }, executionHostOperation: { actor: parent, purpose: 'semantic-compaction' },
    } as Parameters<StartAgentRunFn>[0])).rejects.toThrow('origin')
    expect(f.registrations).toHaveLength(1)
    expect(f.operationLookups()).toBe(0)
  })

  test('carries exact authenticated spawn context and reuses its finite deadline for unbounded children', async () => {
    const f = fixture(), rootId = (await f.start('root-agent', []))!
    const origin = action(f.registrations[0].actor), context = f.registerAction(origin)
    f.setNow(110)
    const first = (await f.start('first-child', [rootId], origin))!
    f.setNow(130)
    const second = (await f.start('second-child', [rootId], origin))!
    expect(f.registrations[1].executionContext).toBe(context)
    expect(f.registrations[2].executionContext).toBe(context)
    expect(f.lookups()).toBe(1)
    for (const id of [first, second]) {
      const scope = f.scopes.get(id)!
      const deadline = f.host.execution.deadline(scope.lifetime)
      expect(deadline.kind).toBe('finite')
      expect(deadline.kind === 'finite' && deadline.expiresAtMs).toBe(140)
      const child = value(scope.operation({ limit: unbounded }))
      const registered = value(f.host.execution.actionRegistration(child.execution))
      expect(f.host.execution.deadline(registered.budget)).toMatchObject({ kind: 'finite', expiresAtMs: 140 })
    }
    const nestedOrigin = action(f.registrations[1].actor, 'nested-spawn')
    const nestedContext = f.registerAction(nestedOrigin)
    const grandchild = (await f.start('grandchild', [rootId, first], nestedOrigin))!
    expect(f.registrations[3].parentActor).toBe(f.registrations[1].actor)
    expect(f.registrations[3].executionContext).toBe(nestedContext)
    expect(f.host.execution.deadline(f.scopes.get(grandchild)!.lifetime)).toMatchObject({ kind: 'finite', expiresAtMs: 140 })
  })

  test('parent cancellation reaches an existing child action and prevents later actor registration', async () => {
    const f = fixture(), rootId = (await f.start('root-agent', []))!
    const cancelled = new AbortController(), origin = action(f.registrations[0].actor)
    f.registerAction(origin, cancelled.signal)
    const childId = (await f.start('first-child', [rootId], origin))!
    const child = value(f.scopes.get(childId)!.operation())
    expect(child.execution.signal?.aborted).toBe(false)
    cancelled.abort(new Error('spawning action cancelled'))
    expect(child.execution.signal?.aborted).toBe(true)
    await expect(f.start('late-child', [rootId], origin)).rejects.toThrow()
    expect(f.registrations).toHaveLength(2)
  })

  test('expired spawn action yields zero later child target dispatches', async () => {
    const f = fixture(), rootId = (await f.start('root-agent', []))!
    const origin = action(f.registrations[0].actor)
    f.registerAction(origin)
    const childId = (await f.start('child', [rootId], origin))!
    const context = value(f.scopes.get(childId)!.operation())
    const target: TargetDescription = { executable: '/fixture/tool', argv: [], cwd: '/virtual/project', projectRoot: '/virtual/project',
      allowedPaths: ['/virtual/project'], profile: context.profile, mode: 'assistant', processType: 'SYNC', family: 'sync-shell',
      branchId: 'inprocess.fixture', adapterOptions: { runtime: 'node' } }
    const launch = value(context.execution.prepareTarget({ target }))
    f.setNow(141)
    let dispatches = 0
    const admitted = await launch.admit()
    if (admitted.ok) launch.dispatchNow(admitted.value.permit, () => { dispatches++; return {} })
    expect(admitted.ok).toBe(false)
    expect(dispatches).toBe(0)
    await expect(f.start('late-child', [rootId], origin)).rejects.toThrow()
  })

  test('refuses missing origin, unregistered ancestors, sibling actors, and changed duplicate basis', async () => {
    const f = fixture(), rootId = (await f.start('root-agent', []))!
    const origin = action(f.registrations[0].actor)
    f.registerAction(origin)
    await expect(f.start('missing-origin', [rootId])).rejects.toThrow()
    await expect(f.start('unknown-parent', [rootId, 'unknown'], origin)).rejects.toThrow()
    await expect(f.start('wrong-actor', [rootId], { ...origin, agentId: 'sibling' })).rejects.toThrow()
    const childId = (await f.start('child', [rootId], origin))!
    await expect(f.start('wrong-chain', ['wrong-root', childId], origin)).rejects.toThrow()
    await expect(f.start('changed-origin', [rootId], { ...origin, basisId: 'changed' })).rejects.toThrow()
    expect(f.registrations).toHaveLength(2)
  })

  test('a child cannot use its descriptor when the root context lookup is absent', async () => {
    const registered: Parameters<RegisterExecutionActor>[0][] = []
    const runtime = getAgentRuntimeImpl({ ...TEST_AGENT_RUNTIME_IMPL, apiKey: 'fixture', processSupervision: false,
      registerExecutionActor: registration => { registered.push(registration) } })
    const rootId = (await runtime.startAgentRun({ apiKey: '', logger, agentId: 'root-template', ancestorRunIds: [],
      agentState: { agentId: 'root-agent' } } as Parameters<StartAgentRunFn>[0]))!
    await expect(runtime.startAgentRun({ apiKey: '', logger, agentId: 'child-template', ancestorRunIds: [rootId],
      agentState: { agentId: 'child-agent' }, executionIdentity: action(registered[0].actor),
    } as Parameters<StartAgentRunFn>[0])).rejects.toThrow('context is unavailable')
    await expect(runtime.startAgentRun({ apiKey: '', logger, agentId: 'context-pruner', ancestorRunIds: [rootId],
      agentState: { agentId: 'pruner-agent' }, executionHostOperation: { actor: registered[0].actor, purpose: 'semantic-compaction' },
    } as Parameters<StartAgentRunFn>[0])).rejects.toThrow('context is unavailable')
    expect(registered).toHaveLength(1)
  })
})
