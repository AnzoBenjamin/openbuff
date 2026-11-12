import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import { captureRootDeadline, createHostAuthority, executionBindingTuple } from '../execution-context'

import type {
  AuthorityBindingV2, CapturedExecutable, Clock, DestinationHandle,
  HostAuthorityInputs, LaunchEvent, Limit, PolicyInput, ProfileRequest,
  Result, RootDeadlineSeed, Scheduler, TargetDescription,
} from '../../types/contracts/execution-context'

const unbounded = { kind: 'unbounded' } as const
const profile: ProfileRequest = {
  policy: 'full-access', preferredBackend: 'portable-ts', required: ['exact-env'], allowBackendFallback: false,
}
const snapshotId = 'b19-oracle-snapshot'
const secretName = 'CUSTOM_PROVIDER_KEY'
const secretValue = 'b19-oracle-delegated-secret'

function value<T>(result: Result<T> | Readonly<{ ok: false; reason: 'dispatch-failed'; cause: string }>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}

function target(changes: Partial<TargetDescription> = {}): TargetDescription {
  return {
    executable: '/usr/bin/node', argv: ['--version'], cwd: '/owned/project', projectRoot: '/owned/project',
    allowedPaths: ['/owned/project'], profile, mode: 'assistant', processType: 'SYNC',
    family: 'diagnostic-build-version-scip', branchId: 'b19.core-oracle', adapterOptions: { runtime: 'node', stdio: 'pipe' },
    ...changes,
  }
}

function harness(overrides: Partial<Pick<HostAuthorityInputs,
  'childInheritanceEnvironment' | 'childOverrides' | 'inheritEnv' | 'classifyTarget' | 'authorizeAsync'>> = {}) {
  let now = 100
  let timerId = 0
  let actionId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: Clock = { domainId: 'b19-oracle-clock', nowMs: () => now }
  const scheduler: Scheduler = {
    set: (delay, callback) => { timers.set(++timerId, { at: now + delay, callback }); return timerId },
    clear: timer => { timers.delete(timer as number) },
  }
  const events: LaunchEvent[] = []
  const policyInputs: PolicyInput[] = []
  const classifications: CapturedExecutable[] = []
  const authority = createHostAuthority({
    configuration: { snapshotId, rosterId: 'b19-oracle-roster', trustPolicyId: 'b19-oracle-trust',
      canonicalCredentialNames: ['OPENAI_API_KEY'], configuredCredentialNames: [secretName] },
    childInheritanceEnvironment: { PATH: '/usr/bin', PROJECT_VALUE: 'allowed-project-value',
      OPENAI_API_KEY: 'b19-oracle-canonical-secret', [secretName]: 'b19-oracle-configured-secret' },
    childOverrides: {}, inheritEnv: true, platform: 'linux', clock, scheduler,
    resolveProfile: request => ({ requested: request,
      available: [{ backend: 'portable-ts', generation: 'b19-oracle-backend',
        capabilities: ['exact-env', 'cooperative-cancellation'], unavailableReasons: [] }],
      selected: { backend: 'portable-ts', generation: 'b19-oracle-backend', policy: request.policy, cancellation: 'cooperative' },
      active: null, enforced: [{ capability: 'exact-env', status: 'enforced', evidenceId: 'injected-exact-env-boundary' }] }),
    classifyTarget: captured => {
      classifications.push(captured)
      return { format: 'openbuff.target-classification.v1', classifierVersion: 'b19-oracle-classifier',
        invocationKind: captured.kind, effects: [], parseStatus: 'complete', parseReason: null }
    },
    authorizeAsync: async input => {
      policyInputs.push(input)
      return { ok: true, basis: 'explicit-policy', decisionId: `b19-decision-${policyInputs.length}` }
    },
    isCurrentBasis: () => true, record: event => { events.push(event) }, ...overrides,
  })

  function scope(name = 'sender', limit: Limit = unbounded) {
    const lifetime = value(authority.registerRootLifetime({ boundary: value(captureRootDeadline({ clock, limit })) }))
    const jobOwner = { clientSessionId: 'b19-client', rootRunId: 'b19-run', parentRunId: 'b19-run', parentAgentId: name }
    return { ...value(authority.registerOwner({ description: { kind: 'run', owner: jobOwner }, lifetime })), lifetime, jobOwner }
  }

  function action(ownerScope: ReturnType<typeof scope>, limit: Limit = unbounded) {
    const budget = value(authority.registerAction({ owner: ownerScope.owner, parent: ownerScope.lifetime, limit,
      correlation: { kind: 'action', actionId: `b19-action-${++actionId}`, attemptId: 'b19-attempt', basisId: 'b19-basis', owner: ownerScope.jobOwner } }))
    const request = value(authority.registerRequest({ budget }))
    return { budget, request, execution: value(authority.bindAction({ owner: ownerScope.owner, budget, request })) }
  }

  function destination(origin: 'user' | 'project' = 'user', declaredEnv: Record<string, string> = {}) {
    const template = target()
    return value(authority.registerDestination({ snapshotId, origin,
      resolved: { kind: 'mcp-stdio', command: template.executable, args: template.argv, declaredEnv } }))
  }

  function resource(ownerScope: ReturnType<typeof scope>, template: TargetDescription, destinationHandle: DestinationHandle) {
    return value(authority.registerResource({ owner: ownerScope.owner, lifetime: ownerScope.lifetime,
      destination: destinationHandle, launchTemplate: template,
      reuse: 'exact-host-scope-lifetime-owner', restartPolicy: { kind: 'none' } }))
  }

  function advance(ms: number) {
    now += ms
    for (;;) {
      const due = [...timers].find(([, timer]) => timer.at <= now)
      if (!due) break
      timers.delete(due[0]); due[1].callback()
    }
  }

  return { authority, clock, events, policyInputs, classifications, scope, action, destination, resource, advance,
    setTime: (time: number) => { now = time } }
}

describe('B19 core execution oracles', () => {
  test.each([
    ['key-only', { ORACLE_ALPHA: 'same-value' }, { ORACLE_BETA: 'same-value' }],
    ['value-only', { ORACLE_ALPHA: 'first-value' }, { ORACLE_ALPHA: 'second-value' }],
  ])('B19 oracle env digest changes for a %s mutation within one host epoch', (mutation, before, after) => {
    const h = harness({ inheritEnv: false }), owner = h.scope(), execution = h.action(owner).execution
    const first = value(execution.prepareTarget({ target: target({ environmentOverlay: before }) })).facts()
    const second = value(execution.prepareTarget({ target: target({ environmentOverlay: after }) })).facts()
    const repeated = value(execution.prepareTarget({ target: target({ environmentOverlay: before }) })).facts()
    expect(first.environment.keyEpochId).toBe(second.environment.keyEpochId)
    expect(first.hostContextId).toBe(second.hostContextId)
    expect(first.environment.entryCount).toBe(1)
    expect(second.environment.entryCount).toBe(1)
    expect(second.environment.keyedDigest).not.toBe(first.environment.keyedDigest)
    expect(repeated.environment.keyedDigest).toBe(first.environment.keyedDigest)
    expect(mutation === 'key-only' ? Object.values(before) : Object.keys(before))
      .toEqual(mutation === 'key-only' ? Object.values(after) : Object.keys(after))
  })

  test('B19 oracle public facts exclude raw env keys values host key material and plain secret hashes', async () => {
    const h = harness(), owner = h.scope(), destination = h.destination('user', { [secretName]: secretValue })
    const delegation = value(h.authority.registerDelegation({ destination, snapshotId, origin: 'user', purpose: 'b19-privacy',
      expiresUnder: owner.lifetime, values: { [secretName]: secretValue }, permittedOwners: [owner.owner] }))
    const launch = value(h.action(owner).execution.prepareTarget({ destination, target: target({ delegation }) }))
    const admission = value(await launch.admit())
    const exact = value(launch.dispatchNow(admission.permit, input => input)).handle
    expect(exact.env).toEqual({ PATH: '/usr/bin', PROJECT_VALUE: 'allowed-project-value', [secretName]: secretValue })
    const facts = launch.facts()
    expect(Object.keys(facts).sort()).toEqual([
      'branchId', 'configurationSnapshotId', 'correlation', 'deadlines', 'destinationId', 'environment',
      'executionBindingDigest', 'executionBindingVersion', 'family', 'hostContextId', 'launchId', 'leaseId',
      'ownerId', 'profile', 'requestId', 'resourceGeneration', 'resourceId',
    ].sort())
    expect(Object.keys(facts.environment).sort()).toEqual([
      'delegationIds', 'entryCount', 'format', 'inherited', 'keyEpochId', 'keyedDigest', 'rosterId',
    ].sort())
    const publicBytes = JSON.stringify({ facts, events: h.events })
    const privateValues = ['b19-oracle-canonical-secret', 'b19-oracle-configured-secret', ...Object.values(exact.env)]
    for (const privateValue of privateValues) {
      expect(publicBytes).not.toContain(privateValue)
      expect(publicBytes).not.toContain(createHash('sha256').update(privateValue).digest('hex'))
    }
    for (const key of ['OPENAI_API_KEY', secretName, 'PROJECT_VALUE', 'PATH', 'keyMaterial', 'hmacKey', 'hostKey', 'secretKey'])
      expect(publicBytes).not.toContain(`"${key}"`)
    const unkeyedEnvironmentDigest = createHash('sha256').update(JSON.stringify([
      'openbuff.env.v1', 'case-sensitive', Object.entries(exact.env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    ])).digest('hex')
    expect(facts.environment.keyedDigest).not.toBe(unkeyedEnvironmentDigest)
    expect(publicBytes).not.toContain(unkeyedEnvironmentDigest)
    expect(JSON.stringify(h.authority)).toBe('{}')
    expect(facts.destinationId).toMatch(/^dest:[a-f0-9]{64}$/)
  })

  test('B19 oracle equal environments have different digests across actual host epochs', async () => {
    const firstHost = harness(), secondHost = harness()
    const first = value(firstHost.action(firstHost.scope()).execution.prepareTarget({ target: target() }))
    const second = value(secondHost.action(secondHost.scope()).execution.prepareTarget({ target: target() }))
    const firstInput = value(first.dispatchNow(value(await first.admit()).permit, input => input)).handle
    const secondInput = value(second.dispatchNow(value(await second.admit()).permit, input => input)).handle
    expect(firstInput.env).toEqual(secondInput.env)
    expect(first.facts().environment.entryCount).toBe(second.facts().environment.entryCount)
    expect(first.facts().hostContextId).not.toBe(second.facts().hostContextId)
    expect(first.facts().environment.keyEpochId).not.toBe(second.facts().environment.keyEpochId)
    expect(first.facts().environment.keyedDigest).not.toBe(second.facts().environment.keyedDigest)
  })

  test('B19 oracle an authentic expired delegation refuses a fresh live request', async () => {
    const h = harness(), owner = h.scope(), destination = h.destination()
    const expiresUnder = h.action(owner, { kind: 'finite', durationMs: 10 }).budget
    const delegation = value(h.authority.registerDelegation({ destination, snapshotId, origin: 'user', purpose: 'b19-expiry',
      expiresUnder, values: { [secretName]: secretValue }, permittedOwners: [owner.owner] }))
    const template = target({ delegation })
    const before = value(h.action(owner, { kind: 'finite', durationMs: 5 }).execution.prepareTarget({ destination, target: template }))
    expect(value(before.dispatchNow(value(await before.admit()).permit, input => input)).handle.env[secretName]).toBe(secretValue)
    h.advance(10)
    const fresh = h.action(owner, { kind: 'finite', durationMs: 5 })
    expect(fresh.execution.signal?.aborted).toBe(false)
    expect(fresh.execution.prepareTarget({ destination, target: template })).toMatchObject({ ok: false, reason: 'deadline-exhausted' })
    expect(h.policyInputs).toHaveLength(1)
    expect(h.events.filter(event => event.phase === 'dispatched')).toHaveLength(1)
    expect(h.events.filter(event => event.phase === 'planned')).toHaveLength(1)
  })

  test.each(['wrong-origin', 'wrong-destination', 'non-owner'] as const)(
    'B19 oracle an authentic delegation refuses a %s request before dispatch', mismatch => {
      const h = harness(), owner = h.scope(), otherOwner = h.scope('excluded'), destination = h.destination()
      const delegation = value(h.authority.registerDelegation({ destination, snapshotId, origin: 'user', purpose: 'b19-scope',
        expiresUnder: owner.lifetime, values: { [secretName]: secretValue }, permittedOwners: [owner.owner] }))
      const requestedDestination = mismatch === 'wrong-origin' ? h.destination('project') :
        mismatch === 'wrong-destination' ? h.destination('user', { DESTINATION_MARKER: 'another-destination' }) : destination
      expect(value(h.authority.destinationOrigin(requestedDestination))).toBe(mismatch === 'wrong-origin' ? 'project' : 'user')
      const action = h.action(mismatch === 'non-owner' ? otherOwner : owner)
      expect(action.execution.prepareTarget({ destination: requestedDestination, target: target({ delegation }) }))
        .toMatchObject({ ok: false, reason: 'stale-authority' })
      expect(h.policyInputs).toEqual([])
      expect(h.classifications).toEqual([])
      expect(h.events).toEqual([])
    },
  )

  test.each([['included', true], ['excluded', false]] as const)(
    'B19 oracle delegated transfer receiver %s in captured owner set', async (_membership, permitted) => {
      const h = harness(), sender = h.scope(), included = h.scope('included-receiver'), excluded = h.scope('excluded-receiver')
      const destination = h.destination()
      const delegation = value(h.authority.registerDelegation({ destination, snapshotId, origin: 'user', purpose: 'b19-transfer',
        expiresUnder: sender.lifetime, values: { [secretName]: secretValue }, permittedOwners: [sender.owner, included.owner] }))
      const resource = h.resource(sender, target({ delegation }), destination)
      const request = h.action(sender)
      value(h.authority.acquireLease({ request: request.request, resource, owner: sender.owner }))
      const previousGeneration = value(h.authority.resourceGeneration(resource))
      const receiver = permitted ? included : excluded
      const offered = h.authority.offerTransfer({ resource, sender: sender.owner, receiver: receiver.owner,
        expectedGeneration: previousGeneration, request: request.request })
      if (!permitted) {
        expect(offered).toMatchObject({ ok: false, reason: 'denied' })
        expect(value(h.authority.resourceGeneration(resource))).toBe(previousGeneration)
        expect(h.events).toEqual([])
        expect(h.policyInputs).toEqual([])
        return
      }
      const accepted = value(h.authority.acceptTransfer({ offer: value(offered), receiver: receiver.receiver }))
      const committed = value(h.authority.commitTransfer(accepted))
      expect(value(h.authority.resourceGeneration(committed.resource))).not.toBe(previousGeneration)
      const received = value(value(h.action(receiver).execution.requestResource(committed.resource)).prepareLaunch())
      const exact = value(received.dispatchNow(value(await received.admit()).permit, input => input)).handle
      expect(exact.env[secretName]).toBe(secretValue)
      expect(exact.env.OPENAI_API_KEY).toBeUndefined()
      expect(h.policyInputs[0].binding.detachTransferId).toBe(committed.transferId)
      expect(h.events.filter(event => event.phase === 'resource-transferred')).toHaveLength(1)
      expect(h.events.filter(event => event.phase === 'dispatched')).toHaveLength(1)
    },
  )

  test('B19 oracle cross-domain root seeds and nested deadline domains refuse', () => {
    const h = harness()
    const foreign = value(captureRootDeadline({ clock: { domainId: 'foreign-clock', nowMs: () => 100 },
      limit: { kind: 'finite', durationMs: 50 } }))
    expect(captureRootDeadline({ clock: h.clock, limit: unbounded, existingParent: foreign }))
      .toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(h.authority.registerRootLifetime({ boundary: foreign })).toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(h.authority.registerRootLifetime({ boundary: { ...foreign, domainId: h.clock.domainId } }))
      .toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(h.events).toEqual([])
  })

  test.each([['NaN', NaN], ['positive-infinity', Infinity], ['negative-infinity', -Infinity]] as const)(
    'B19 oracle nonfinite clock sample %s refuses and poisons its host', (_label, sample) => {
      const h = harness(), boundary = value(captureRootDeadline({ clock: h.clock, limit: unbounded }))
      h.setTime(sample)
      expect(captureRootDeadline({ clock: h.clock, limit: unbounded })).toMatchObject({ ok: false, reason: 'invalid-context' })
      expect(h.authority.registerRootLifetime({ boundary })).toMatchObject({ ok: false, reason: 'invalid-context' })
      h.setTime(100)
      expect(h.authority.registerRootLifetime({ boundary })).toMatchObject({ ok: false, reason: 'invalid-context' })
      expect(h.events).toEqual([])
    },
  )

  test.each([
    ['zero', 0], ['negative', -1], ['NaN', NaN], ['positive-infinity', Infinity],
    ['negative-infinity', -Infinity], ['fractional', 1.5], ['unsafe-integer', Number.MAX_SAFE_INTEGER + 1],
  ] as const)(
    'B19 oracle invalid finite duration %s refuses root and derived budgets', (_label, durationMs) => {
      const h = harness(), owner = h.scope(), parent = h.action(owner).budget
      const limit = { kind: 'finite' as const, durationMs }
      expect(captureRootDeadline({ clock: h.clock, limit })).toMatchObject({ ok: false, reason: 'invalid-context' })
      expect(h.authority.deriveBudget({ parent, memoKey: 'invalid-duration', limit }))
        .toMatchObject({ ok: false, reason: 'invalid-context' })
      expect(h.events).toEqual([])
    },
  )

  test('B19 oracle duration addition and supplied expiry overflow refuse', () => {
    const h = harness()
    h.setTime(Number.MAX_SAFE_INTEGER - 3)
    const limit = { kind: 'finite', durationMs: 4 } as const
    expect(captureRootDeadline({ clock: h.clock, limit })).toMatchObject({ ok: false, reason: 'invalid-context' })
    const owner = h.scope(), parent = h.action(owner).budget
    expect(h.authority.deriveBudget({ parent, memoKey: 'overflowed-expiry', limit }))
      .toMatchObject({ ok: false, reason: 'invalid-context' })
    const overflowed: RootDeadlineSeed = { domainId: h.clock.domainId, sampledAtMs: h.clock.nowMs(),
      deadline: { kind: 'finite', limitId: 'overflowed-boundary', domainId: h.clock.domainId, expiresAtMs: Number.MAX_SAFE_INTEGER + 1 } }
    expect(h.authority.registerRootLifetime({ boundary: overflowed })).toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(captureRootDeadline({ clock: h.clock, limit: unbounded, existingParent: overflowed }))
      .toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(h.events).toEqual([])
  })

  test('B19 oracle a clock backward from its seed refuses before first root registration', () => {
    const h = harness(), boundary = value(captureRootDeadline({ clock: h.clock, limit: { kind: 'finite', durationMs: 50 } }))
    h.setTime(99)
    expect(h.authority.registerRootLifetime({ boundary })).toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(captureRootDeadline({ clock: h.clock, limit: unbounded, existingParent: boundary }))
      .toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(h.events).toEqual([])
  })

  test('B19 oracle same-host environment-only resource changes never reuse the observed resource', async () => {
    const h = harness(), owner = h.scope(), destination = h.destination()
    const firstTarget = target({ environmentOverlay: { ORACLE_VALUE: 'first' } })
    const firstResource = h.resource(owner, firstTarget, destination)
    const first = value(value(h.action(owner).execution.requestResource(firstResource)).prepareLaunch())
    const firstInput = value(first.dispatchNow(value(await first.admit()).permit, (input, observer) => {
      value(observer.spawnObserved({ source: 'node-spawn-event', pid: 101 }))
      return input
    })).handle
    expect(h.resource(owner, firstTarget, destination)).toBe(firstResource)
    const secondResource = h.resource(owner, { ...firstTarget, environmentOverlay: { ORACLE_VALUE: 'second' } }, destination)
    expect(secondResource).not.toBe(firstResource)
    const second = value(value(h.action(owner).execution.requestResource(secondResource)).prepareLaunch())
    const secondInput = value(second.dispatchNow(value(await second.admit()).permit, input => input)).handle
    expect(firstInput.env).toEqual({ PATH: '/usr/bin', PROJECT_VALUE: 'allowed-project-value', ORACLE_VALUE: 'first' })
    expect(secondInput.env).toEqual({ ...firstInput.env, ORACLE_VALUE: 'second' })
    expect(second.facts().resourceId).not.toBe(first.facts().resourceId)
    expect(second.facts().resourceGeneration).not.toBe(first.facts().resourceGeneration)
    expect(second.facts().environment.keyEpochId).toBe(first.facts().environment.keyEpochId)
    expect(second.facts().environment.keyedDigest).not.toBe(first.facts().environment.keyedDigest)
    expect(h.events.filter(event => event.phase === 'resource-reused')).toEqual([])
    expect(h.events.filter(event => event.phase === 'dispatched')).toHaveLength(2)
  })

  test('B19 oracle same-host delegation-only resource changes never reuse despite equal final env', async () => {
    const h = harness(), owner = h.scope(), destination = h.destination()
    const registration = { destination, snapshotId, origin: 'user' as const, purpose: 'b19-delegation-identity',
      expiresUnder: owner.lifetime, values: { [secretName]: secretValue }, permittedOwners: [owner.owner] }
    const firstDelegation = value(h.authority.registerDelegation(registration))
    const secondDelegation = value(h.authority.registerDelegation(registration))
    const firstTarget = target({ delegation: firstDelegation })
    const firstResource = h.resource(owner, firstTarget, destination)
    const first = value(value(h.action(owner).execution.requestResource(firstResource)).prepareLaunch())
    const firstInput = value(first.dispatchNow(value(await first.admit()).permit, (input, observer) => {
      value(observer.spawnObserved({ source: 'node-spawn-event', pid: 102 }))
      return input
    })).handle
    expect(h.resource(owner, firstTarget, destination)).toBe(firstResource)
    const secondResource = h.resource(owner, { ...firstTarget, delegation: secondDelegation }, destination)
    expect(secondResource).not.toBe(firstResource)
    const second = value(value(h.action(owner).execution.requestResource(secondResource)).prepareLaunch())
    const secondInput = value(second.dispatchNow(value(await second.admit()).permit, input => input)).handle
    expect(secondInput.env).toEqual(firstInput.env)
    expect(second.facts().environment.keyedDigest).toBe(first.facts().environment.keyedDigest)
    expect(second.facts().environment.keyEpochId).toBe(first.facts().environment.keyEpochId)
    expect(second.facts().resourceId).not.toBe(first.facts().resourceId)
    expect(second.facts().resourceGeneration).not.toBe(first.facts().resourceGeneration)
    expect(second.facts().environment.delegationIds).not.toEqual(first.facts().environment.delegationIds)
    expect(h.policyInputs[1].binding.delegationDigest).not.toBe(h.policyInputs[0].binding.delegationDigest)
    expect(h.events.filter(event => event.phase === 'resource-reused')).toEqual([])
    expect(h.events.filter(event => event.phase === 'dispatched')).toHaveLength(2)
  })

  test('B19 oracle an explicit intended env change requires a fresh binding and decision', async () => {
    const h = harness(), execution = h.action(h.scope()).execution
    const first = value(execution.prepareTarget({ target: target({ environmentOverlay: { ORACLE_INTENT: 'first' } }) }))
    const firstAdmission = value(await first.admit())
    const firstBinding = h.policyInputs[0].binding
    const second = value(execution.prepareTarget({ target: target({ environmentOverlay: { ORACLE_INTENT: 'second' } }) }))
    let dispatchCount = 0
    expect(second.dispatchNow(firstAdmission.permit, () => { dispatchCount++; return undefined }))
      .toMatchObject({ ok: false, reason: 'stale-authority' })
    expect(h.policyInputs).toHaveLength(1)
    const secondAdmission = value(await second.admit())
    expect(h.policyInputs).toHaveLength(2)
    expect(secondAdmission.decisionId).not.toBe(firstAdmission.decisionId)
    expect(secondAdmission.permit).not.toBe(firstAdmission.permit)
    expect(h.policyInputs[1].binding.requestId).toBe(firstBinding.requestId)
    expect(h.policyInputs[1].binding.environmentDigest).not.toBe(firstBinding.environmentDigest)
    expect(h.policyInputs[1].bindingDigest).not.toBe(h.policyInputs[0].bindingDigest)
    const before = value(first.dispatchNow(firstAdmission.permit, input => { dispatchCount++; return input })).handle
    const after = value(second.dispatchNow(secondAdmission.permit, input => { dispatchCount++; return input })).handle
    expect(before.env.ORACLE_INTENT).toBe('first')
    expect(after.env.ORACLE_INTENT).toBe('second')
    expect(h.policyInputs[0].binding).toBe(firstBinding)
    expect(dispatchCount).toBe(2)
  })

  test('B19 oracle unsupported required classification refuses with zero dispatch while explicit full-access permits', async () => {
    const policyInputs: PolicyInput[] = []
    const h = harness({ classifyTarget: captured => ({ format: 'openbuff.target-classification.v1',
      classifierVersion: 'b19-unsupported-classifier', invocationKind: captured.kind,
      parseStatus: 'unsupported', parseReason: 'classifier cannot safely parse this exact target', effects: [] }),
    authorizeAsync: async input => {
      policyInputs.push(input)
      return input.target.profile.policy === 'full-access'
        ? { ok: true, basis: 'explicit-policy', decisionId: 'b19-explicit-full-access' }
        : { ok: false, reason: 'unavailable', cause: 'This registered policy requires complete classification' }
    } })
    const execution = h.action(h.scope()).execution
    const required = value(execution.prepareTarget({ target: target({ profile: { ...profile, policy: 'read-only' } }) }))
    const refused = await required.admit()
    let requiredDispatches = 0
    if (refused.ok) required.dispatchNow(refused.value.permit, () => { requiredDispatches++; return undefined })
    expect(refused).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(requiredDispatches).toBe(0)
    expect(policyInputs[0].classification).toMatchObject({ parseStatus: 'unsupported', effects: [] })
    expect(policyInputs[0].binding.parseStatus).toBe('unsupported')
    expect(h.events.filter(event => event.phase === 'dispatched')).toEqual([])
    expect(h.events.find(event => event.phase === 'no-launch')).toMatchObject({ facts: { profile: { active: null } } })
    const explicit = value(execution.prepareTarget({ target: target() }))
    const admitted = value(await explicit.admit())
    let explicitDispatches = 0
    expect(explicit.dispatchNow(admitted.permit, () => { explicitDispatches++; return 'allowed' }).ok).toBe(true)
    expect(admitted.decisionId).toBe('b19-explicit-full-access')
    expect(explicitDispatches).toBe(1)
    expect(policyInputs[1].classification.parseStatus).toBe('unsupported')
    expect(policyInputs[1].target.profile.policy).toBe('full-access')
  })

  test.each(['commandHash', 'bindingDigest', 'environmentDigest', 'effectRosterDigest', 'executableArgvDigest'])(
    'B19 oracle caller injected %s refuses prepareTarget before classification or policy', field => {
      const h = harness(), execution = h.action(h.scope()).execution
      const injected = { ...target(), [field]: 'caller-supplied-authority' } as TargetDescription
      expect(execution.prepareTarget({ target: injected })).toMatchObject({ ok: false, reason: 'invalid-context' })
      expect(h.classifications).toEqual([])
      expect(h.policyInputs).toEqual([])
      expect(h.events).toEqual([])
    },
  )

  test('B19 oracle independent 29-member v2 golden tuple preserves order null and empty values', () => {
    // Values/order transcribed from DESIGN section 6, independently of the tuple implementation.
    const binding: AuthorityBindingV2 = {
      launchId: 'launch-29', adapterOptionsDigest: 'adapter-28', deadlinesDigest: 'deadlines-27', detachTransferId: null,
      mode: 'user', processType: 'BACKGROUND', leaseId: 'lease-23', ownerId: 'owner-22', resourceGeneration: 'generation-21',
      resourceId: 'resource-20', requestId: 'request-19', delegationDigest: 'delegation-18', destinationId: 'destination-17',
      credentialRosterId: 'roster-16', environmentDigest: 'env-15', selectedBackendDigest: 'backend-14',
      profileRequestDigest: 'profile-13', allowedPaths: [], projectRoot: '/project-11', cwd: '',
      correlationDigest: 'correlation-9', configurationSnapshotId: 'snapshot-8', hostContextId: 'host-7',
      parseStatus: 'complete', effectRosterDigest: 'effects-5', executableArgvDigest: 'argv-4', commandHash: 'command-3',
      keyEpochId: 'epoch-2', format: 'openbuff.execution.v2',
    }
    const expected = [
      'openbuff.execution.v2', 'epoch-2', 'command-3', 'argv-4', 'effects-5', 'complete', 'host-7', 'snapshot-8',
      'correlation-9', '', '/project-11', [], 'profile-13', 'backend-14', 'env-15', 'roster-16', 'destination-17',
      'delegation-18', 'request-19', 'resource-20', 'generation-21', 'owner-22', 'lease-23', 'BACKGROUND', 'user',
      null, 'deadlines-27', 'adapter-28', 'launch-29',
    ]
    expect(expected).toHaveLength(29)
    expect(executionBindingTuple(binding)).toEqual(expected)
    expect(JSON.stringify(executionBindingTuple(binding))).toBe(
      '["openbuff.execution.v2","epoch-2","command-3","argv-4","effects-5","complete","host-7","snapshot-8","correlation-9","","/project-11",[],"profile-13","backend-14","env-15","roster-16","destination-17","delegation-18","request-19","resource-20","generation-21","owner-22","lease-23","BACKGROUND","user",null,"deadlines-27","adapter-28","launch-29"]',
    )
    const emptyTransfer = executionBindingTuple({ ...binding, detachTransferId: '' })
    expect(emptyTransfer[25]).toBe('')
    expect(JSON.stringify(emptyTransfer)).not.toBe(JSON.stringify(expected))
    const emptyPath = executionBindingTuple({ ...binding, allowedPaths: [''] })
    expect(emptyPath[11]).toEqual([''])
    expect(JSON.stringify(emptyPath)).not.toBe(JSON.stringify(expected))
  })
})
