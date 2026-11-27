import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { captureRootDeadline, createHostAuthority, executionBindingTuple, isExecutionDeadlineSignal } from '../execution-context'

import type {
  ActionExecutionPort, Admission, BudgetHandle, Clock, HostAuthorityInputs, LaunchEvent,
  LifetimeHandle, PolicyInput, ProfileRequest, RequestHandle,
  ResourceHandle, Result, Scheduler, TargetClassification, TargetDescription,
} from '../../types/contracts/execution-context'

const unbounded = { kind: 'unbounded' } as const
const jobOwner = { clientSessionId: 'client', rootRunId: 'run', parentRunId: 'run', parentAgentId: 'strategy' }
const profile: ProfileRequest = { policy: 'full-access', preferredBackend: 'portable-ts', required: ['exact-env'], allowBackendFallback: false }

function value<T>(result: Result<T> | { ok: false; reason: string; cause: string }): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}

function permit(admission: Admission) { return value(admission).permit }

function harness(overrides: Partial<HostAuthorityInputs> = {}) {
  let now = 100
  let backendGeneration = 'portable-1'
  let currentBasis = true
  const tasks = new Map<number, { at: number; callback: () => void }>()
  let taskId = 0
  const clock: Clock = { domainId: 'clock-1', nowMs: () => now }
  const scheduler: Scheduler = {
    set: (delay, callback) => { tasks.set(++taskId, { at: now + delay, callback }); return taskId },
    clear: timer => { tasks.delete(timer as number) },
  }
  const events: LaunchEvent[] = []
  const policyInputs: PolicyInput[] = []
  const environment: Record<string, string | undefined> = { PATH: '/usr/bin', HOME: '/owned/home',
    OPENAI_API_KEY: 'canonical-secret', CUSTOM_PROVIDER_KEY: 'configured-secret', PROJECT_VALUE: 'allowed', DELETE_ME: 'before' }
  const inputs: HostAuthorityInputs = {
    configuration: { snapshotId: 'snapshot-1', trustPolicyId: 'trust-1', rosterId: 'roster-1',
      canonicalCredentialNames: ['OPENAI_API_KEY'], configuredCredentialNames: ['CUSTOM_PROVIDER_KEY'] },
    childInheritanceEnvironment: environment, childOverrides: { DELETE_ME: undefined }, inheritEnv: true,
    platform: 'linux', clock, scheduler,
    resolveProfile: request => ({ requested: request, available: [{ backend: 'portable-ts', generation: backendGeneration,
      capabilities: ['exact-env', 'cooperative-cancellation'], unavailableReasons: [] }],
      selected: { backend: 'portable-ts', generation: backendGeneration, policy: request.policy, cancellation: 'cooperative' },
      active: null, enforced: [{ capability: 'exact-env', status: 'enforced', evidenceId: 'exact-env-input' }] }),
    classifyTarget: captured => ({ format: 'openbuff.target-classification.v1', classifierVersion: 'test-exact-1',
      invocationKind: captured.kind, effects: [], parseStatus: 'complete', parseReason: null }),
    authorizeAsync: async input => { policyInputs.push(input); return { ok: true, basis: 'explicit-policy', decisionId: 'allow' } },
    authorizeSync: input => { policyInputs.push(input); return { ok: true, basis: 'explicit-sync-policy', decisionId: 'sync-allow' } },
    isCurrentBasis: () => currentBasis, record: event => { events.push(event) }, ...overrides,
  }
  const authority = createHostAuthority(inputs)
  const lifetime = value(authority.registerRootLifetime({ boundary: value(captureRootDeadline({ clock, limit: unbounded })) }))
  const owner = value(authority.registerOwner({ description: { kind: 'run', owner: jobOwner }, lifetime })).owner
  let actionId = 0
  function action(limit = unbounded as Parameters<typeof authority.registerAction>[0]['limit'], signal?: AbortSignal) {
    const budget = value(authority.registerAction({ owner, parent: lifetime, limit,
      correlation: { kind: 'action', actionId: `action-${++actionId}`, attemptId: 'attempt-1', basisId: 'basis-1', owner: jobOwner } }))
    const request = value(authority.registerRequest({ budget, signal }))
    return { budget, request, execution: value(authority.bindAction({ owner, budget, request })) }
  }
  function target(extra: Partial<TargetDescription> = {}): TargetDescription {
    return { executable: '/usr/bin/node', argv: ['--version'], cwd: '/owned/project', projectRoot: '/owned/project',
      allowedPaths: ['/owned/project'], profile, mode: 'assistant', processType: 'SYNC', family: 'diagnostic-build-version-scip',
      branchId: 'test.node-version', adapterOptions: { runtime: 'node', stdio: 'pipe' }, ...extra }
  }
  function resource(template: TargetDescription = target(), selectedLifetime: LifetimeHandle | BudgetHandle = lifetime) {
    const destination = value(authority.registerDestination({ snapshotId: 'snapshot-1', origin: 'host',
      resolved: { kind: 'executable', command: template.executable, args: template.argv, declaredEnv: {} } }))
    return value(authority.registerResource({ owner, lifetime: selectedLifetime, destination, launchTemplate: template,
      reuse: 'exact-host-scope-lifetime-owner', restartPolicy: { kind: 'explicit-host-startup', maxAttempts: 2 } }))
  }
  function prepare(resource: ResourceHandle, budget: BudgetHandle, request: RequestHandle) {
    const lease = value(authority.acquireLease({ owner, request, resource }))
    return { lease, launch: value(authority.prepareLaunch({ request, budget, resource, lease })) }
  }
  function advance(ms: number) {
    now += ms
    for (;;) {
      const due = [...tasks].find(([, task]) => task.at <= now)
      if (!due) break
      tasks.delete(due[0]); due[1].callback()
    }
  }
  return { authority, clock, inputs, owner, lifetime, environment, events, policyInputs, tasks,
    action, target, resource, prepare, advance, setTime: (time: number) => { now = time },
    changeBackend: () => { backendGeneration = 'portable-2' }, changeBasis: () => { currentBasis = false } }
}

describe('authenticated execution authority', () => {
  test('deadline provenance requires a registered signal from the expiring authority', () => {
    const h = harness(), expired = h.action({ kind: 'finite', durationMs: 25 })
    const derived = value(expired.execution.derive({ memoKey: 'provenance-child', limit: unbounded }))
    const signal = expired.execution.signal!
    expect(isExecutionDeadlineSignal(signal)).toBe(false)
    h.advance(25)
    expect(isExecutionDeadlineSignal(signal)).toBe(true)
    expect(isExecutionDeadlineSignal(derived.signal!)).toBe(true)
    expect(isExecutionDeadlineSignal(value(h.authority.signal(expired.budget)))).toBe(true)
    expect(isExecutionDeadlineSignal(AbortSignal.abort(signal.reason))).toBe(false)
    expect(isExecutionDeadlineSignal(AbortSignal.abort(new Error('Execution deadline exhausted')))).toBe(false)

    const other = harness(), caller = new AbortController(), cancelled = other.action(unbounded, caller.signal)
    caller.abort(signal.reason)
    expect(isExecutionDeadlineSignal(cancelled.execution.signal!)).toBe(false)
    expect(other.authority.actionRegistration(cancelled.execution)).toMatchObject({ ok: false, reason: 'cancelled' })
  })

  test('root registration authenticates derived correlation and the actual request cancellation signal', () => {
    const h = harness(), stop = new AbortController(), action = h.action(unbounded, stop.signal)
    const derived = value(action.execution.derive({ memoKey: 'registered-child', limit: unbounded }))
    const registration = value(h.authority.actionRegistration(derived))
    expect(registration.correlation).toMatchObject({ kind: 'action', actionId: 'action-1', attemptId: 'attempt-1', basisId: 'basis-1', owner: jobOwner })
    expect(registration.owner).toEqual(h.owner)
    expect(registration.signal.aborted).toBe(false)
    expect(h.authority.actionRegistration({ ...derived })).toMatchObject({ ok: false, reason: 'stale-authority' })
    expect(h.authority.actionRegistration(JSON.parse(JSON.stringify(derived)))).toMatchObject({ ok: false, reason: 'stale-authority' })
    stop.abort(new Error('Request stopped'))
    expect(registration.signal.aborted).toBe(true)
    expect(value(h.authority.signal(action.budget)).aborted).toBe(false)
    expect(h.authority.actionRegistration(derived)).toMatchObject({ ok: false, reason: 'cancelled' })
  })

  test('run-owned internal operations carry honest host-operation correlation without B02 IDs', () => {
    const h = harness()
    const budget = value(h.authority.registerHostOperation({ owner: h.owner, parent: h.lifetime, purpose: 'direct-host-operation', limit: unbounded }))
    const request = value(h.authority.registerRequest({ budget }))
    const execution = value(h.authority.bindAction({ owner: h.owner, budget, request }))
    const registration = value(h.authority.actionRegistration(execution))
    expect(registration.correlation).toMatchObject({ kind: 'host-operation', purpose: 'direct-host-operation' })
    expect('actionId' in registration.correlation).toBe(false)
    expect('basisId' in registration.correlation).toBe(false)
    expect(h.authority.deadline(registration.budget).kind).toBe('unbounded')
  })

  test('captures, scrubs and dispatches the exact child environment', async () => {
    const h = harness()
    const overrides: Record<string, string | undefined> = { PROJECT_VALUE: 'overlay', OPENAI_API_KEY: 'reinsert-attempt', NEW_VALUE: 'new' }
    const argv = ['-e', 'process.exit(0)']
    const launch = value(h.action().execution.prepareTarget({ target: h.target({ argv, environmentOverlay: overrides }) }))
    argv.push('late'); overrides.PROJECT_VALUE = 'late'; h.environment.PROJECT_VALUE = 'late'
    const result = launch.dispatchNow(permit(await launch.admit()), exact => exact)
    const exact = value(result).handle
    expect(exact.argv).toEqual(['-e', 'process.exit(0)'])
    expect(exact.env).toEqual({ PATH: '/usr/bin', HOME: '/owned/home', PROJECT_VALUE: 'overlay', NEW_VALUE: 'new' })
    expect(Object.isFrozen(exact.env)).toBe(true)
    expect(launch.facts().profile.active).toBeNull()
    expect(JSON.stringify(h.events)).not.toContain('canonical-secret')
    expect(JSON.stringify(h.events)).not.toContain('configured-secret')
    expect(JSON.stringify(h.events)).not.toContain('PROJECT_VALUE')
  })

  test('replacement environment has no implicit HOME, PATH or credentials', async () => {
    const h = harness({ inheritEnv: false, childOverrides: {} })
    const launch = value(h.action().execution.prepareTarget({ target: h.target() }))
    const exact = value(launch.dispatchNow(permit(await launch.admit()), input => input)).handle
    expect(exact.env).toEqual({})
  })

  test('rejects Windows key collisions; credential names are case-insensitive there', async () => {
    const h = harness({ platform: 'win32', childInheritanceEnvironment: { Path: 'a', PATH: 'b' } })
    expect(h.action().execution.prepareTarget({ target: h.target() }).ok).toBe(false)
    const scoped = harness({ platform: 'win32', childInheritanceEnvironment: { openai_api_key: 'secret', Project: 'keep' } })
    const launch = value(scoped.action().execution.prepareTarget({ target: scoped.target() }))
    const exact = value(launch.dispatchNow(permit(await launch.admit()), input => input)).handle
    expect(exact.env).toEqual({ Project: 'keep' })
  })

  test.each([
    ['thenable', Promise.resolve({})], ['wrong kind', { format: 'openbuff.target-classification.v1', classifierVersion: 'x', invocationKind: 'shell', effects: [], parseStatus: 'complete', parseReason: null }],
    ['unknown effect', { format: 'openbuff.target-classification.v1', classifierVersion: 'x', invocationKind: 'argv', effects: [{ action: 'delete-everything', target: '' }], parseStatus: 'complete', parseReason: null }],
    ['missing reason', { format: 'openbuff.target-classification.v1', classifierVersion: 'x', invocationKind: 'argv', effects: [], parseStatus: 'unsupported', parseReason: null }],
  ])('invalid classifier %s never admits or dispatches', (_label, classified) => {
    let approvalCount = 0
    const h = harness({ classifyTarget: () => classified as TargetClassification,
      authorizeAsync: async () => { approvalCount++; return { ok: true, basis: 'explicit-policy', decisionId: 'bad' } } })
    const prepared = h.action().execution.prepareTarget({ target: h.target() })
    expect(prepared.ok).toBe(false); expect(approvalCount).toBe(0)
  })

  test('classification precedes binding and remains frozen through approval', async () => {
    const effects = [{ action: 'commit' as const, target: 'one', branch: '', pushRisks: [] }]
    let captured: unknown
    const h = harness({ classifyTarget: input => { captured = input; return { format: 'openbuff.target-classification.v1',
      classifierVersion: 'exact', invocationKind: input.kind, effects, parseStatus: 'complete', parseReason: null } } })
    const launch = value(h.action().execution.prepareTarget({ target: h.target({ shellCommandBytes: "git commit -m 'one two'" }) }))
    effects[0].target = 'late'
    await launch.admit()
    expect(Object.isFrozen(captured)).toBe(true)
    expect(h.policyInputs[0].classification.effects[0].target).toBe('one')
    expect(Object.isFrozen(h.policyInputs[0].classification.effects)).toBe(true)
    const binding = h.policyInputs[0].binding
    expect(executionBindingTuple(binding)).toHaveLength(29)
    const reversed = Object.fromEntries(Object.entries(binding).reverse()) as typeof binding
    expect(executionBindingTuple(reversed)).toEqual(executionBindingTuple(binding))
  })

  test('copied, foreign, wrong-target and already-used permits cannot dispatch', async () => {
    const h = harness(), other = harness()
    const launch = value(h.action().execution.prepareTarget({ target: h.target() }))
    const targetPermit = permit(await launch.admit())
    let calls = 0
    const dispatch = () => { calls++; return 'child' }
    expect(launch.dispatchNow({ ...targetPermit }, dispatch).ok).toBe(false)
    const second = value(h.action().execution.prepareTarget({ target: h.target() }))
    expect(second.dispatchNow(targetPermit, dispatch).ok).toBe(false)
    const foreign = value(other.action().execution.prepareTarget({ target: other.target() }))
    expect(foreign.dispatchNow(targetPermit, dispatch).ok).toBe(false)
    expect(launch.dispatchNow(targetPermit, dispatch).ok).toBe(true)
    expect(launch.dispatchNow(targetPermit, dispatch).ok).toBe(false)
    expect(calls).toBe(1)
  })

  test('copied action and launch receivers are rejected', async () => {
    const h = harness(), action = h.action()
    const copied: ActionExecutionPort = { ...action.execution }
    expect(copied.prepareTarget({ target: h.target() }).ok).toBe(false)
    expect(copied.derive({ memoKey: 'x', limit: unbounded }).ok).toBe(false)
    const launch = value(action.execution.prepareTarget({ target: h.target() }))
    expect((await ({ ...launch }).admit()).ok).toBe(false)
  })

  test('sync absence and async thenable never optimistically invoke async policy', () => {
    let asyncCalls = 0
    const h = harness({ authorizeSync: undefined, authorizeAsync: async () => { asyncCalls++; return { ok: true, basis: 'explicit-policy', decisionId: 'a' } } })
    const launch = value(h.action().execution.prepareTarget({ target: h.target({ adapterOptions: { runtime: 'spawn-sync' } }) }))
    expect(launch.admitSync().ok).toBe(false); expect(asyncCalls).toBe(0)
    const invalid = harness({ authorizeSync: (() => Promise.resolve({ ok: true })) as unknown as NonNullable<HostAuthorityInputs['authorizeSync']> })
    expect(value(invalid.action().execution.prepareTarget({ target: invalid.target() })).admitSync().ok).toBe(false)
  })

  test('sync supported policy is consumed once and reports runtime PID before narrowing', () => {
    const h = harness()
    const launch = value(h.action().execution.prepareTarget({ target: h.target({ adapterOptions: { runtime: 'spawn-sync' } }) }))
    const result = value(launch.dispatchNow(permit(launch.admitSync()), (_input, observer) => {
      value(observer.spawnObserved({ source: 'spawn-sync-result', pid: 27 }))
      value(observer.failure({ source: 'spawn-sync-error', errorCode: 'ETIMEDOUT', cause: 'timeout after start' }))
      return { status: null }
    }))
    expect(result.facts.profile.active?.policy).toBe('full-access')
    const failure = h.events.findLast(event => event.phase === 'dispatch-failed')
    expect(failure?.phase === 'dispatch-failed' && failure.processStart).toBe('observed')
  })

  test('cancelled delayed admission settles without waiting for the policy and never spawns', async () => {
    let resolvePolicy!: (input: Awaited<ReturnType<HostAuthorityInputs['authorizeAsync']>>) => void
    const h = harness({ authorizeAsync: () => new Promise(resolve => { resolvePolicy = resolve }) })
    const controller = new AbortController()
    const launch = value(h.action(unbounded, controller.signal).execution.prepareTarget({ target: h.target() }))
    const pending = launch.admit()
    controller.abort()
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('cancelled')
    resolvePolicy({ ok: true, basis: 'explicit-policy', decisionId: 'late' })
    await Promise.resolve()
    expect(h.events.some(event => event.phase === 'admitted' || event.phase === 'dispatched')).toBe(false)
  })

  test('delayed approval consumes absolute budget; retries cannot restart it', async () => {
    let resolvePolicy!: (input: Awaited<ReturnType<HostAuthorityInputs['authorizeAsync']>>) => void
    const h = harness({ authorizeAsync: () => new Promise(resolve => { resolvePolicy = resolve }) })
    const action = h.action({ kind: 'finite', durationMs: 50 })
    const child = value(h.authority.deriveBudget({ parent: action.budget, memoKey: 'retry', limit: { kind: 'finite', durationMs: 40 } }))
    h.advance(20)
    const repeated = value(h.authority.deriveBudget({ parent: action.budget, memoKey: 'retry', limit: unbounded }))
    expect(h.authority.deadline(repeated)).toEqual(h.authority.deadline(child))
    expect(value(h.authority.remainingMs(repeated))).toBe(20)
    const launch = value(action.execution.prepareTarget({ target: h.target() }))
    const pending = launch.admit()
    h.advance(31)
    const admission = await pending
    expect(admission.ok).toBe(false)
    if (!admission.ok) expect(admission.reason).toBe('deadline-exhausted')
    resolvePolicy({ ok: true, basis: 'explicit-policy', decisionId: 'late' })
  })

  test('registered request signals carry derived deadlines into waits', () => {
    const h = harness(), action = h.action({ kind: 'finite', durationMs: 100 })
    const derived = value(action.execution.derive({ memoKey: 'bounded-wait', limit: { kind: 'finite', durationMs: 20 } }))
    expect(derived.signal?.aborted).toBe(false)
    h.advance(21)
    expect(derived.signal?.aborted).toBe(true)
    expect(action.execution.signal?.aborted).toBe(false)
    expect(derived.signal?.reason.message).toBe('Execution deadline exhausted')
  })

  test('one-shot action cancellation reaches its process lifetime after dispatch', async () => {
    const h = harness(), controller = new AbortController(), action = h.action(unbounded, controller.signal)
    const launch = value(action.execution.prepareTarget({ target: h.target() }))
    const exact = value(launch.dispatchNow(permit(await launch.admit()), input => input)).handle
    expect(exact.resourceSignal.aborted).toBe(false)
    controller.abort(new Error('action cancelled'))
    expect(exact.resourceSignal.aborted).toBe(true)
  })

  test('expiry during the final basis check prevents dispatch without relying on timers', async () => {
    let dispatching = false
    const h = harness({ isCurrentBasis: () => {
      if (dispatching) h.setTime(111)
      return true
    } })
    const launch = value(h.action({ kind: 'finite', durationMs: 10 }).execution.prepareTarget({ target: h.target() }))
    const targetPermit = permit(await launch.admit())
    dispatching = true
    let calls = 0
    expect(launch.dispatchNow(targetPermit, () => { calls++; return 'child' }))
      .toMatchObject({ ok: false, reason: 'deadline-exhausted' })
    expect(calls).toBe(0)
    expect(h.events.some(event => event.phase === 'dispatched')).toBe(false)
  })

  for (const interruption of ['cancel', 'expire'] as const) {
    test(`${interruption} during dispatch recording prevents the spawn callback`, async () => {
      const controller = new AbortController()
      const events: LaunchEvent[] = []
      const h = harness({ record: event => {
        events.push(event)
        if (event.phase !== 'dispatched') return
        if (interruption === 'cancel') controller.abort(new Error('cancel before spawn'))
        else h.setTime(111)
      } })
      const launch = value(h.action({ kind: 'finite', durationMs: 10 }, controller.signal)
        .execution.prepareTarget({ target: h.target() }))
      const targetPermit = permit(await launch.admit())
      let calls = 0
      expect(launch.dispatchNow(targetPermit, () => { calls++; return 'child' }))
        .toMatchObject({ ok: false, reason: interruption === 'cancel' ? 'cancelled' : 'deadline-exhausted' })
      expect(calls).toBe(0)
      expect(events.findLast(event => event.phase === 'dispatch-failed'))
        .toMatchObject({ processStart: 'not-observed', facts: { profile: { active: null } } })
      expect(launch.dispatchNow(targetPermit, () => { calls++; return 'late child' }).ok).toBe(false)
      expect(calls).toBe(0)
    })
  }

  test('dispatch samples the remaining deadline after recording', async () => {
    let recorded = false
    const h = harness({ clock: { domainId: 'clock-1', nowMs: () => recorded ? 105 : 100 },
      record: event => { if (event.phase === 'dispatched') recorded = true } })
    const launch = value(h.action({ kind: 'finite', durationMs: 10 }).execution.prepareTarget({ target: h.target() }))
    const result = value(launch.dispatchNow(permit(await launch.admit()), input => input.resourceRemainingMs))
    expect(result.handle).toBe(5)
  })

  test('the final sampled deadline cannot authorize a dispatch at expiry', async () => {
    let recorded = false
    const h = harness({ clock: { domainId: 'clock-1', nowMs: () => recorded ? 110 : 100 },
      record: event => { if (event.phase === 'dispatched') recorded = true } })
    const launch = value(h.action({ kind: 'finite', durationMs: 10 }).execution.prepareTarget({ target: h.target() }))
    let calls = 0
    expect(launch.dispatchNow(permit(await launch.admit()), () => { calls++; return 'child' }))
      .toMatchObject({ ok: false, reason: 'deadline-exhausted' })
    expect(calls).toBe(0)
  })

  test('basis callbacks cannot dispatch the same permit twice', async () => {
    let reenter = () => {}
    const h = harness({ isCurrentBasis: () => { reenter(); return true } })
    const launch = value(h.action().execution.prepareTarget({ target: h.target() }))
    const targetPermit = permit(await launch.admit())
    let nested: ReturnType<typeof launch.dispatchNow> | undefined, calls = 0
    const spawn = () => { calls++; return 'child' }
    reenter = () => {
      reenter = () => {}
      nested = launch.dispatchNow(targetPermit, spawn)
    }
    expect(launch.dispatchNow(targetPermit, spawn).ok).toBe(true)
    expect(nested).toMatchObject({ ok: false, reason: 'already-consumed' })
    expect(calls).toBe(1)
  })

  test('root configuration time counts and large deadlines are chunked', () => {
    const h = harness()
    const boundary = value(captureRootDeadline({ clock: h.clock, limit: { kind: 'finite', durationMs: 10 } }))
    h.advance(11)
    expect(h.authority.registerRootLifetime({ boundary }).ok).toBe(false)
    const big = value(captureRootDeadline({ clock: h.clock, limit: { kind: 'finite', durationMs: 2_147_483_649 } }))
    value(h.authority.registerRootLifetime({ boundary: big }))
    expect([...h.tasks.values()].every(task => task.at - h.clock.nowMs() <= 2_147_483_647)).toBe(true)
  })

  test('invalid clocks/durations and stale backend or action basis refuse', async () => {
    const h = harness()
    expect(captureRootDeadline({ clock: h.clock, limit: { kind: 'finite', durationMs: 0 } }).ok).toBe(false)
    expect(captureRootDeadline({ clock: h.clock, limit: { kind: 'finite', durationMs: NaN } }).ok).toBe(false)
    const launch = value(h.action().execution.prepareTarget({ target: h.target() }))
    const targetPermit = permit(await launch.admit())
    h.changeBackend()
    expect(launch.dispatchNow(targetPermit, () => 'child').ok).toBe(false)
    const basis = harness()
    const planned = value(basis.action().execution.prepareTarget({ target: basis.target() }))
    basis.changeBasis()
    expect((await planned.admit()).ok).toBe(false)
    h.setTime(50)
    expect(h.authority.remainingMs(h.lifetime).ok).toBe(false)
  })

  test('dispatch alone never implies observed start; invalid/duplicate/stale observations refuse', async () => {
    const h = harness(), action = h.action(), resource = h.resource()
    const { launch } = h.prepare(resource, action.budget, action.request)
    const dispatched = value(launch.dispatchNow(permit(await launch.admit()), () => 'raw-child'))
    expect(dispatched.facts.profile.active).toBeNull()
    expect(dispatched.observer.spawnObserved({ source: 'node-spawn-event', pid: 0 }).ok).toBe(false)
    expect(dispatched.observer.spawnObserved({ source: 'bun-spawn-result', pid: 10 }).ok).toBe(false)
    value(dispatched.observer.spawnObserved({ source: 'node-spawn-event', pid: 10 }))
    expect(launch.facts().profile.active?.policy).toBe('full-access')
    expect(dispatched.observer.spawnObserved({ source: 'node-spawn-event', pid: 10 }).ok).toBe(false)
    value(dispatched.observer.failure({ source: 'node-error-event', errorCode: 'EPIPE', cause: 'actual adapter error' }))
    const maintenance = value(h.authority.registerMaintenanceRequest({ resource, reason: 'observed-adapter-failure' }))
    value(h.authority.nextResourceGeneration({ previous: resource, request: maintenance.request }))
    expect(dispatched.observer.failure({ source: 'node-error-event', cause: 'old callback' }).ok).toBe(false)
  })

  test('throws before and after a real observation preserve the start distinction', async () => {
    const h = harness()
    for (const observed of [false, true]) {
      const launch = value(h.action().execution.prepareTarget({ target: h.target({ adapterOptions: { runtime: 'bun' } }) }))
      const dispatched = launch.dispatchNow(permit(await launch.admit()), (_input, observer) => {
        if (observed) value(observer.spawnObserved({ source: 'bun-spawn-result', pid: 22 }))
        throw new Error('actual spawn adapter failure')
      })
      expect(dispatched.ok).toBe(false)
      const failure = h.events.findLast(event => event.phase === 'dispatch-failed')
      expect(failure?.phase === 'dispatch-failed' && failure.processStart).toBe(observed ? 'observed' : 'not-observed')
    }
  })

  test('ENOENT is a dispatched failure with no fabricated start and no implicit new approval', async () => {
    const h = harness()
    const launch = value(h.action().execution.prepareTarget({ target: h.target() }))
    const dispatched = value(launch.dispatchNow(permit(await launch.admit()), (_input, observer) => {
      value(observer.failure({ source: 'node-error-event', errorCode: 'ENOENT', cause: 'not found' })); return 'handle'
    }))
    expect(dispatched.facts.profile.active).toBeNull()
    expect(dispatched.observer.spawnObserved({ source: 'node-spawn-event', pid: 25 }).ok).toBe(false)
    expect((await launch.admit()).ok).toBe(false)
    expect(h.events.filter(event => event.phase === 'admitted')).toHaveLength(1)
  })

  test('request cancellation releases only its lease; another request can reuse an observed run resource', async () => {
    const h = harness(), controller = new AbortController(), first = h.action({ kind: 'finite', durationMs: 10 }, controller.signal)
    const resource = h.resource(), { launch } = h.prepare(resource, first.budget, first.request)
    const started = value(launch.dispatchNow(permit(await launch.admit()), (exact, observer) => {
      value(observer.spawnObserved({ source: 'node-spawn-event', pid: 50 })); return exact
    }))
    controller.abort(); h.advance(11)
    expect(started.handle.resourceSignal.aborted).toBe(false)
    const second = h.action(), requested = value(second.execution.requestResource(resource))
    const use = value(await requested.admitUse('op-A'))
    expect(value(requested.useNow(use, () => 'response'))).toBe('response')
    expect(requested.useNow(use, () => 'again').ok).toBe(false)
    expect(h.events.filter(event => event.phase === 'spawn-observed')).toHaveLength(1)
    const reuse = h.events.findLast(event => event.phase === 'resource-reused')
    expect(reuse?.phase === 'resource-reused' && reuse.originalLaunchId).toBe(launch.facts().launchId)
    expect(h.policyInputs.at(-1)?.target.adapterOptions.resourceUseOperationDigest).toBe('op-A')
  })

  for (const interruption of ['basis-expiry', 'recorder-cancel'] as const) {
    test(`resource use refuses ${interruption} before the operation callback`, async () => {
      let using = false
      const controller = new AbortController()
      const h = harness({
        isCurrentBasis: () => {
          if (using && interruption === 'basis-expiry') h.setTime(111)
          return true
        },
        record: event => {
          if (event.phase === 'resource-reused' && interruption === 'recorder-cancel') controller.abort()
        },
      })
      const first = h.action(), resource = h.resource()
      const { launch } = h.prepare(resource, first.budget, first.request)
      value(launch.dispatchNow(permit(await launch.admit()), (_exact, observer) => {
        value(observer.spawnObserved({ source: 'node-spawn-event', pid: 50 }))
        return 'child'
      }))
      const second = h.action({ kind: 'finite', durationMs: 10 }, controller.signal)
      const request = value(second.execution.requestResource(resource))
      const use = value(await request.admitUse('interrupted-operation'))
      using = true
      let calls = 0
      expect(request.useNow(use, () => { calls++; return 'response' }))
        .toMatchObject({ ok: false, reason: interruption === 'basis-expiry' ? 'deadline-exhausted' : 'cancelled' })
      expect(calls).toBe(0)
      const third = value(h.action().execution.requestResource(resource))
      using = false
      const freshUse = value(await third.admitUse('fresh-operation'))
      expect(value(third.useNow(freshUse, () => 'fresh response'))).toBe('fresh response')
    })
  }

  test('basis callbacks cannot reuse the same operation permit twice', async () => {
    let reenter = () => {}
    const h = harness({ isCurrentBasis: () => { reenter(); return true } })
    const first = h.action(), resource = h.resource()
    const { launch } = h.prepare(resource, first.budget, first.request)
    value(launch.dispatchNow(permit(await launch.admit()), (_exact, observer) => {
      value(observer.spawnObserved({ source: 'node-spawn-event', pid: 50 }))
      return 'child'
    }))
    const request = value(h.action().execution.requestResource(resource))
    const use = value(await request.admitUse('one-operation'))
    let nested: ReturnType<typeof request.useNow> | undefined, calls = 0
    const operation = () => { calls++; return 'response' }
    reenter = () => {
      reenter = () => {}
      nested = request.useNow(use, operation)
    }
    expect(value(request.useNow(use, operation))).toBe('response')
    expect(nested).toMatchObject({ ok: false, reason: 'already-consumed' })
    expect(calls).toBe(1)
  })

  test('reuse binds every operation and rechecks basis before use', async () => {
    const h = harness(), first = h.action(), resource = h.resource(), { launch } = h.prepare(resource, first.budget, first.request)
    value(launch.dispatchNow(permit(await launch.admit()), (_exact, observer) => { value(observer.spawnObserved({ source: 'node-spawn-event', pid: 50 })); return 'child' }))
    const second = h.action(), request = value(second.execution.requestResource(resource))
    value(await request.admitUse('op-A'))
    const permitB = value(await request.admitUse('op-B'))
    expect(h.policyInputs.at(-2)?.binding.adapterOptionsDigest).not.toBe(h.policyInputs.at(-1)?.binding.adapterOptionsDigest)
    h.changeBasis()
    expect(request.useNow(permitB, () => 'response').ok).toBe(false)
  })

  test.each([
    ['mode', { mode: 'user' }],
    ['process type', { processType: 'BACKGROUND' }],
    ['family', { family: 'lsp' }],
    ['shell bytes', { shellCommandBytes: 'node --version; printf second' }],
  ] as const)('resource reuse requires the same %s with owner, environment and argv unchanged', (_label, difference) => {
    const h = harness(), first = h.action(), target = h.target()
    const original = h.resource(target)
    expect(h.resource(target)).toBe(original)
    const changed = h.resource({ ...target, ...difference })
    const originalLaunch = h.prepare(original, first.budget, first.request).launch
    const changedLaunch = h.prepare(changed, first.budget, first.request).launch
    expect(changedLaunch.facts().resourceId).not.toBe(originalLaunch.facts().resourceId)
    expect(changedLaunch.facts().ownerId).toBe(originalLaunch.facts().ownerId)
    expect(changedLaunch.facts().environment.keyedDigest).toBe(originalLaunch.facts().environment.keyedDigest)
    expect(changedLaunch.facts().destinationId).toBe(originalLaunch.facts().destinationId)
  })

  test('resource reuse requires the same restart policy', () => {
    const h = harness(), action = h.action(), target = h.target()
    const destination = value(h.authority.registerDestination({ snapshotId: 'snapshot-1', origin: 'host',
      resolved: { kind: 'executable', command: target.executable, args: target.argv, declaredEnv: {} } }))
    const register = (restartPolicy: Parameters<typeof h.authority.registerResource>[0]['restartPolicy']) =>
      value(h.authority.registerResource({ owner: h.owner, lifetime: h.lifetime, destination, launchTemplate: target,
        reuse: 'exact-host-scope-lifetime-owner', restartPolicy }))
    const original = register({ kind: 'explicit-host-startup', maxAttempts: 2 })
    expect(register({ kind: 'explicit-host-startup', maxAttempts: 2 })).toBe(original)
    const originalId = h.prepare(original, action.budget, action.request).launch.facts().resourceId
    for (const changed of [register({ kind: 'none' }), register({ kind: 'explicit-host-startup', maxAttempts: 1 })])
      expect(h.prepare(changed, action.budget, action.request).launch.facts().resourceId).not.toBe(originalId)
  })

  test('maintenance after the first request deadline uses retained lifetime and invalidates old launch', async () => {
    const h = harness(), first = h.action({ kind: 'finite', durationMs: 10 }), resource = h.resource()
    const { launch } = h.prepare(resource, first.budget, first.request)
    const started = value(launch.dispatchNow(permit(await launch.admit()), (_exact, observer) => { value(observer.spawnObserved({ source: 'node-spawn-event', pid: 50 })); return 'child' }))
    value(started.observer.failure({ source: 'node-error-event', cause: 'crash' }))
    h.advance(11)
    const wrong = h.action()
    expect(h.authority.nextResourceGeneration({ previous: resource, request: wrong.request }).ok).toBe(false)
    const maintenance = value(h.authority.registerMaintenanceRequest({ resource, reason: 'observed-adapter-failure' }))
    const next = value(h.authority.nextResourceGeneration({ previous: resource, request: maintenance.request, branchId: 'lsp.crash-restart' }))
    const prepared = h.prepare(next, maintenance.budget, maintenance.request)
    const admitted = await prepared.launch.admit()
    expect(admitted.ok).toBe(true)
    expect(prepared.launch.facts().correlation).toEqual(launch.facts().correlation)
    expect(prepared.launch.facts().branchId).toBe('lsp.crash-restart')
    expect(launch.facts().branchId).toBe('test.node-version')
    expect(prepared.launch.facts().deadlines.action.kind).toBe('unbounded')
  })

  test('delegation is authentic, owner/destination-scoped and expiry-bounded', async () => {
    const h = harness(), action = h.action(), target = h.target()
    const destination = value(h.authority.registerDestination({ snapshotId: 'snapshot-1', origin: 'user',
      resolved: { kind: 'mcp-stdio', command: target.executable, args: target.argv, declaredEnv: { CUSTOM_PROVIDER_KEY: 'delegated' } } }))
    const delegation = value(h.authority.registerDelegation({ destination, snapshotId: 'snapshot-1', origin: 'user',
      purpose: 'explicit-local-mcp', values: { CUSTOM_PROVIDER_KEY: 'delegated' }, permittedOwners: [h.owner], expiresUnder: h.lifetime }))
    expect(action.execution.prepareTarget({ destination, target: { ...target, delegation: { ...delegation } } }).ok).toBe(false)
    const launch = value(action.execution.prepareTarget({ destination, target: { ...target, delegation } }))
    const exact = value(launch.dispatchNow(permit(await launch.admit()), input => input)).handle
    expect(exact.env.CUSTOM_PROVIDER_KEY).toBe('delegated')
    expect(exact.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('delegation cannot relabel the origin of an authentic destination', () => {
    const h = harness(), target = h.target()
    const destination = value(h.authority.registerDestination({ snapshotId: 'snapshot-1', origin: 'project',
      resolved: { kind: 'mcp-stdio', command: target.executable, args: target.argv, declaredEnv: { CUSTOM_PROVIDER_KEY: 'delegated' } } }))
    const registration = { destination, snapshotId: 'snapshot-1', purpose: 'explicit-local-mcp',
      values: { CUSTOM_PROVIDER_KEY: 'delegated' }, permittedOwners: [h.owner], expiresUnder: h.lifetime }
    for (const origin of ['user', 'host'] as const)
      expect(h.authority.registerDelegation({ ...registration, origin })).toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(h.authority.registerDelegation({ ...registration, origin: 'project' }).ok).toBe(true)
  })

  test.each(['offer', 'accept', 'commit'] as const)('cleanup commitment fences authenticated transfer at %s', async stage => {
    const h = harness(), first = h.action(), resource = h.resource(h.target(), first.budget)
    const { launch } = h.prepare(resource, first.budget, first.request)
    const receiver = value(h.authority.registerOwner({ description: { kind: 'run', owner: { ...jobOwner, parentAgentId: 'receiver' } }, lifetime: h.lifetime }))
    const offerTransfer = () => h.authority.offerTransfer({ resource, sender: h.owner, receiver: receiver.owner,
      expectedGeneration: value(h.authority.resourceGeneration(resource)), request: first.request })
    const offer = stage !== 'offer' ? value(offerTransfer()) : undefined
    const accepted = stage === 'commit' ? value(h.authority.acceptTransfer({ offer: offer!, receiver: receiver.receiver })) : undefined
    const dispatched = value(launch.dispatchNow(permit(await launch.admit()), (_input, observer) => {
      value(observer.spawnObserved({ source: 'node-spawn-event', pid: 50 }))
    }))
    expect(dispatched.observer.cleanupCommitted.call({ ...dispatched.observer })).toMatchObject({ ok: false, reason: 'stale-authority' })
    value(dispatched.observer.cleanupCommitted())
    const refused = stage === 'offer' ? offerTransfer() : stage === 'accept'
      ? h.authority.acceptTransfer({ offer: offer!, receiver: receiver.receiver }) : h.authority.commitTransfer(accepted!)
    expect(refused).toMatchObject({ ok: false, reason: 'stale-authority', cause: 'Physical resource cleanup is committed' })
    expect(h.events.filter(event => event.phase === 'resource-transferred')).toHaveLength(0)
  })

  test('dispatch without an observed start cannot transfer even with a previously accepted permit', async () => {
    const h = harness(), first = h.action(), resource = h.resource(h.target(), first.budget)
    const { launch } = h.prepare(resource, first.budget, first.request)
    const receiver = value(h.authority.registerOwner({ description: { kind: 'run', owner: { ...jobOwner, parentAgentId: 'receiver' } }, lifetime: h.lifetime }))
    const offered = value(h.authority.offerTransfer({ resource, sender: h.owner, receiver: receiver.owner,
      expectedGeneration: launch.facts().resourceGeneration, request: first.request }))
    const accepted = value(h.authority.acceptTransfer({ offer: offered, receiver: receiver.receiver }))
    const dispatched = value(launch.dispatchNow(permit(await launch.admit()), () => undefined))
    expect(h.authority.commitTransfer(accepted)).toMatchObject({ ok: false, reason: 'stale-authority' })
    value(dispatched.observer.spawnObserved({ source: 'node-spawn-event', pid: 51 }))
    value(h.authority.commitTransfer(accepted))
    value(dispatched.observer.cleanupCommitted())
    const second = value(h.authority.registerOwner({ description: { kind: 'run', owner: { ...jobOwner, parentAgentId: 'second' } }, lifetime: h.lifetime }))
    const budget = value(h.authority.registerAction({ owner: receiver.owner, parent: h.lifetime, limit: unbounded,
      correlation: { kind: 'action', owner: { ...jobOwner, parentAgentId: 'receiver' }, actionId: 'receive', attemptId: '1', basisId: 'b' } }))
    const request = value(h.authority.registerRequest({ budget }))
    value(h.authority.acquireLease({ request, resource, owner: receiver.owner }))
    expect(h.authority.offerTransfer({ resource, sender: receiver.owner, receiver: second.owner,
      expectedGeneration: value(h.authority.resourceGeneration(resource)), request })).toMatchObject({ ok: false, cause: 'Physical resource cleanup is committed' })
  })

  test('transfer requires receiver capability and cannot extend the original deadline', async () => {
    const h = harness(), first = h.action({ kind: 'finite', durationMs: 100 }), resource = h.resource(h.target(), first.budget)
    const { launch } = h.prepare(resource, first.budget, first.request)
    const beforeTransfer = launch.facts()
    const receiver = value(h.authority.registerOwner({ description: { kind: 'run', owner: { ...jobOwner, parentAgentId: 'receiver' } }, lifetime: h.lifetime }))
    const offer = value(h.authority.offerTransfer({ resource, sender: h.owner, receiver: receiver.owner,
      expectedGeneration: launch.facts().resourceGeneration, request: first.request }))
    expect(h.authority.acceptTransfer({ offer, receiver: { ...receiver.receiver } }).ok).toBe(false)
    const transfer = value(h.authority.acceptTransfer({ offer, receiver: receiver.receiver }))
    const committed = value(h.authority.commitTransfer(transfer))
    expect(committed.transferId).toBeTruthy()
    expect(h.authority.commitTransfer(transfer).ok).toBe(false)
    expect((await launch.admit()).ok).toBe(false)
    const newBudget = value(h.authority.registerAction({ owner: receiver.owner, parent: h.lifetime, limit: unbounded,
      correlation: { kind: 'action', owner: { ...jobOwner, parentAgentId: 'receiver' }, actionId: 'receive', attemptId: '1', basisId: 'b' } }))
    const newRequest = value(h.authority.registerRequest({ budget: newBudget }))
    const lease = value(h.authority.acquireLease({ request: newRequest, resource: committed.resource, owner: receiver.owner }))
    const received = value(h.authority.prepareLaunch({ request: newRequest, resource: committed.resource, lease, budget: newBudget }))
    const receivedLifetime = received.facts().deadlines.resourceLifetime
    expect(receivedLifetime.kind === 'finite' && receivedLifetime.expiresAtMs).toBe(200)
    expect(launch.facts()).toEqual(beforeTransfer)
    expect(h.events.filter(event => event.phase === 'resource-transferred')).toHaveLength(1)
  })

  test('transfer removes the sender resource signal but preserves the original absolute cap', async () => {
    const h = harness(), senderSignal = new AbortController(), first = h.action({ kind: 'finite', durationMs: 100 })
    const target = h.target()
    const destination = value(h.authority.registerDestination({ snapshotId: 'snapshot-1', origin: 'host',
      resolved: { kind: 'executable', command: target.executable, args: target.argv, declaredEnv: {} } }))
    const resource = value(h.authority.registerResource({ owner: h.owner, lifetime: first.budget,
      resourceSignal: senderSignal.signal, destination, launchTemplate: target, reuse: 'none', restartPolicy: { kind: 'none' } }))
    const { launch } = h.prepare(resource, first.budget, first.request)
    const receiverOwner = { ...jobOwner, parentAgentId: 'signal-receiver' }
    const receiver = value(h.authority.registerOwner({ description: { kind: 'run', owner: receiverOwner }, lifetime: h.lifetime }))
    const offer = value(h.authority.offerTransfer({ resource, sender: h.owner, receiver: receiver.owner,
      expectedGeneration: launch.facts().resourceGeneration, request: first.request }))
    const transfer = value(h.authority.acceptTransfer({ offer, receiver: receiver.receiver }))
    const committed = value(h.authority.commitTransfer(transfer))
    senderSignal.abort()
    const budget = value(h.authority.registerAction({ owner: receiver.owner, parent: h.lifetime, limit: unbounded,
      correlation: { kind: 'action', owner: receiverOwner, actionId: 'receive-signal', attemptId: '1', basisId: 'b' } }))
    const request = value(h.authority.registerRequest({ budget }))
    const lease = value(h.authority.acquireLease({ request, resource: committed.resource, owner: receiver.owner }))
    const received = value(h.authority.prepareLaunch({ request, resource: committed.resource, lease, budget }))
    expect(received.facts().deadlines.resourceLifetime).toMatchObject({ kind: 'finite', expiresAtMs: 200 })
    const exact = value(received.dispatchNow(permit(await received.admit()), input => input)).handle
    expect(exact.resourceSignal.aborted).toBe(false)
    h.advance(99)
    expect(exact.resourceSignal.aborted).toBe(false)
    h.advance(1)
    expect(exact.resourceSignal.aborted).toBe(true)
    expect(h.authority.acquireLease({ request, resource: committed.resource, owner: receiver.owner }).ok).toBe(false)
    expect(h.events.filter(event => event.phase === 'spawn-observed')).toEqual([])
  })

  test.each([false, true])('first-unprepared transfer preserves sender correlation/cap and receiver cancellation=%s', async cancelReceiver => {
    const h = harness(), sender = h.action({ kind: 'finite', durationMs: 100 }), resource = h.resource(h.target(), sender.budget)
    const generation = value(h.authority.resourceGeneration(resource))
    expect(h.authority.resourceGeneration({ ...resource }).ok).toBe(false)
    value(h.authority.acquireLease({ owner: h.owner, request: sender.request, resource }))
    const receiverStop = new AbortController()
    const receiverLifetime = value(h.authority.registerRootLifetime({ signal: receiverStop.signal,
      boundary: value(captureRootDeadline({ clock: h.clock, limit: unbounded })) }))
    const receiverOwner = { ...jobOwner, parentAgentId: 'unprepared-receiver' }
    const receiver = value(h.authority.registerOwner({ description: { kind: 'run', owner: receiverOwner }, lifetime: receiverLifetime }))
    const offer = value(h.authority.offerTransfer({ resource, sender: h.owner, receiver: receiver.owner,
      expectedGeneration: generation, request: sender.request }))
    const transferred = value(h.authority.commitTransfer(value(h.authority.acceptTransfer({ offer, receiver: receiver.receiver }))))
    expect(h.events.filter(event => event.phase === 'planned')).toEqual([])
    const budget = value(h.authority.registerAction({ owner: receiver.owner, parent: receiverLifetime, limit: unbounded,
      correlation: { kind: 'action', owner: receiverOwner, actionId: 'receiver-action', attemptId: 'receiver-attempt', basisId: 'receiver-basis' } }))
    const request = value(h.authority.registerRequest({ budget }))
    const lease = value(h.authority.acquireLease({ owner: receiver.owner, request, resource: transferred.resource }))
    const launch = value(h.authority.prepareLaunch({ budget, request, lease, resource: transferred.resource }))
    expect(launch.facts().correlation).toEqual({ kind: 'action', actionId: 'action-1', attemptId: 'attempt-1', basisId: 'basis-1', owner: jobOwner })
    expect(launch.facts().deadlines.action).toMatchObject({ kind: 'finite', expiresAtMs: 200 })
    expect(launch.facts().deadlines.resourceLifetime).toMatchObject({ kind: 'finite', expiresAtMs: 200 })
    const exact = value(launch.dispatchNow(permit(await launch.admit()), input => input)).handle
    expect(h.policyInputs.at(-1)?.binding.detachTransferId).toBe(transferred.transferId)
    expect(exact.resourceSignal.aborted).toBe(false)
    if (cancelReceiver) receiverStop.abort(new Error('receiver cancelled'))
    else h.advance(100)
    expect(exact.resourceSignal.aborted).toBe(true)
    expect(h.authority.acquireLease({ owner: receiver.owner, request, resource: transferred.resource }).ok).toBe(false)
    expect(h.events.filter(event => event.phase === 'spawn-observed')).toEqual([])
  })

  test.each([false, true])('transferred admission preserves authority deadline origin=%s', async expired => {
    const h = harness(), caller = new AbortController(), sender = h.action({ kind: 'finite', durationMs: 100 })
    const resource = h.resource(h.target(), sender.budget)
    value(h.authority.acquireLease({ owner: h.owner, request: sender.request, resource }))
    const receiverOwner = { ...jobOwner, parentAgentId: 'admission-receiver' }
    const receiver = value(h.authority.registerOwner({ description: { kind: 'run', owner: receiverOwner }, lifetime: h.lifetime }))
    const offer = value(h.authority.offerTransfer({ resource, sender: h.owner, receiver: receiver.owner,
      expectedGeneration: value(h.authority.resourceGeneration(resource)), request: sender.request }))
    const transferred = value(h.authority.commitTransfer(value(h.authority.acceptTransfer({ offer, receiver: receiver.receiver }))))
    const budget = value(h.authority.registerAction({ owner: receiver.owner, parent: h.lifetime, limit: unbounded,
      correlation: { kind: 'action', owner: receiverOwner, actionId: 'admission', attemptId: '1', basisId: 'b' } }))
    const request = value(h.authority.registerRequest({ budget,
      signal: AbortSignal.any([sender.execution.signal!, caller.signal]) }))
    const lease = value(h.authority.acquireLease({ request, resource: transferred.resource, owner: receiver.owner }))
    const launch = value(h.authority.prepareLaunch({ request, resource: transferred.resource, lease, budget }))
    expect(h.authority.deadline(budget).kind).toBe('unbounded')
    expect(launch.facts().deadlines.resourceLifetime).toMatchObject({ kind: 'finite', expiresAtMs: 200 })

    if (expired) h.advance(100)
    else caller.abort(new Error('Execution deadline exhausted'))

    expect(await launch.admit()).toMatchObject({ ok: false, reason: expired ? 'deadline-exhausted' : 'cancelled' })
    expect(h.events.filter(event => event.phase === 'dispatched')).toEqual([])
  })

  test('recorder failure prevents dispatch even after a successful policy', async () => {
    const h = harness({ record: () => { throw new Error('disk unavailable') } })
    const launch = value(h.action().execution.prepareTarget({ target: h.target() }))
    expect((await launch.admit()).ok).toBe(false)
  })

  test('actual Node child receives exact replacement env and supplies actual spawn observation', async () => {
    const nodeExecutable = Bun.which('node')
    if (!nodeExecutable) throw new Error('The real process fixture requires Node on PATH')
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-b19-child-env-'))
    const recorder = path.join(owned, 'observed-env.json')
    const h = harness({ inheritEnv: false, childOverrides: { PROJECT_VALUE: 'allowed-real', OPENAI_API_KEY: 'sentinel' } })
    const launch = value(h.action({ kind: 'finite', durationMs: 5_000 }).execution.prepareTarget({ target: h.target({
      executable: nodeExecutable,
      cwd: owned,
      argv: ['-e', 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({value:process.env.PROJECT_VALUE,credential:process.env.OPENAI_API_KEY??null,home:process.env.HOME??null}))', recorder],
    }) }))
    const started = value(launch.dispatchNow(permit(await launch.admit()), (exact, observer) => {
      const child = spawn(exact.executable, [...exact.argv], { cwd: exact.cwd, env: exact.env, signal: exact.resourceSignal, stdio: ['ignore', 'pipe', 'pipe'] })
      child.once('spawn', () => { value(observer.spawnObserved({ source: 'node-spawn-event', pid: child.pid! })) })
      child.on('error', error => { observer.failure({ source: 'node-error-event', cause: error.message }) })
      return child
    }))
    try {
      await new Promise<void>((resolve, reject) => { started.handle.once('close', code => code === 0 ? resolve() : reject(new Error(`child exit ${code}`))); started.handle.once('error', reject) })
      expect(JSON.parse(fs.readFileSync(recorder, 'utf8'))).toEqual({ value: 'allowed-real', credential: null, home: null })
      expect(h.events.filter(event => event.phase === 'spawn-observed')).toHaveLength(1)
      expect(launch.facts().profile.active?.policy).toBe('full-access')
    } finally { fs.rmSync(owned, { recursive: true, force: true }) }
  })
})
