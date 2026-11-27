import { describe, expect, test } from 'bun:test'

import {
  captureRootDeadline,
  createHostAuthority,
  executionBindingTuple,
} from '../execution-context'

import type {
  Admission,
  Capability,
  Clock,
  HostAuthorityInputs,
  LaunchEvent,
  Limit,
  PolicyInput,
  ProfileFacts,
  ProfileRequest,
  Result,
  Scheduler,
  TargetDescription,
} from '../../types/contracts/execution-context'
import type {
  NativeLaunchObserver,
  NativePlanIdentity,
  NativePreparedObservation,
  NativeTargetEntryObservation,
  NativeTransportObservation,
} from '../../types/contracts/native-execution'

// All PIDs, paths and OS scope facts here are DI descriptions, not OS evidence.
const artifactSha256 = 'a'.repeat(64)
const identity: NativePlanIdentity = {
  artifactSha256,
  planDigest: 'b'.repeat(64),
  nonce: 'fixture-entry-nonce',
}
const transport: NativeTransportObservation = {
  ...identity,
  source: 'native-monitor-spawn',
  pid: 41001,
}
const required: readonly Capability[] = [
  'exact-env',
  'filesystem-isolation',
  'deadline-termination',
]
type RequestedProfile = ProfileRequest & { optional?: readonly Capability[] }
const profile: RequestedProfile = {
  policy: 'workspace-write',
  preferredBackend: 'native-exec',
  required,
  allowBackendFallback: false,
}
const ready: NativePreparedObservation = {
  ...identity,
  source: 'native-adapter-ready',
  scopeId: 'fixture-pid-namespace',
  enforced: required.map((capability) => ({
    capability,
    status: 'enforced',
    evidenceId: `fixture:${capability}`,
  })),
}
const entered: NativeTargetEntryObservation = {
  ...identity,
  source: 'native-adapter-exec-status',
  scopeId: ready.scopeId,
  pid: 41002,
}
const unbounded = { kind: 'unbounded' } as const
const ownerDescription = {
  clientSessionId: 'native-fixture-client',
  rootRunId: 'native-fixture-run',
  parentRunId: 'native-fixture-run',
  parentAgentId: 'native-fixture-strategy',
}
function value<T>(
  result: Result<T> | { ok: false; reason: string; cause: string },
): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}
const permit = (result: Admission) => value(result).permit

function harness() {
  let now = 100,
    timerId = 0,
    actionId = 0
  let currentBasis = true,
    generation = 'fixture-native-generation-1',
    pinnedArtifact = artifactSha256
  let basisHook: (() => void) | undefined
  const tasks = new Map<number, { at: number; callback: () => void }>()
  const clock: Clock = {
    domainId: 'fixture-native-monotonic',
    nowMs: () => now,
  }
  const scheduler: Scheduler = {
    set(delay, callback) {
      tasks.set(++timerId, { at: now + delay, callback })
      return timerId
    },
    clear(timer) {
      tasks.delete(timer as number)
    },
  }
  const ownerStop = new AbortController(),
    events: LaunchEvent[] = [],
    approvals: PolicyInput[] = []
  const resolverTargets: (TargetDescription | undefined)[] = []
  const inputs: HostAuthorityInputs = {
    configuration: {
      snapshotId: 'fixture-native-config',
      trustPolicyId: 'fixture-native-policy',
      rosterId: 'fixture-native-credentials',
      canonicalCredentialNames: ['OPENAI_API_KEY'],
      configuredCredentialNames: [],
    },
    childInheritanceEnvironment: {
      PATH: '/fixture/toolchain',
      VALUE: 'inherited',
      OPENAI_API_KEY: 'fixture-private-secret',
    },
    childOverrides: {},
    inheritEnv: true,
    platform: 'linux',
    clock,
    scheduler,
    resolveProfile(request, captured?: TargetDescription): ProfileFacts {
      resolverTargets.push(captured)
      const native =
        captured?.adapterOptions.runtime === 'node' &&
        captured.adapterOptions.nativeAdapter === 'openbuff.exec.v1' &&
        captured.adapterOptions.nativeArtifactSha256 === pinnedArtifact
      const nativeCapabilities: readonly Capability[] = [
        ...required,
        'process-tree-containment',
      ]
      const requested = request as RequestedProfile
      return {
        requested: request,
        available: [
          {
            backend: 'native-exec',
            generation,
            capabilities: native ? nativeCapabilities : [],
            unavailableReasons: native
              ? []
              : [
                  'Fixture requires the captured trusted native adapter and artifact',
                ],
          },
        ],
        selected: native
          ? {
              backend: 'native-exec',
              generation,
              policy: request.policy,
              cancellation: 'cooperative',
            }
          : null,
        active: null,
        enforced: [...request.required, ...(requested.optional ?? [])].map(
          (capability) => ({ capability, status: 'not-enforced' }),
        ),
      }
    },
    classifyTarget: (captured) => ({
      format: 'openbuff.target-classification.v1',
      classifierVersion: 'fixture-native-classifier',
      invocationKind: captured.kind,
      effects: [],
      parseStatus: 'complete',
      parseReason: null,
    }),
    authorizeAsync: async (input) => {
      approvals.push(input)
      return {
        ok: true,
        basis: 'explicit-policy',
        decisionId: 'fixture-allow',
      }
    },
    authorizeSync: (input) => {
      approvals.push(input)
      return {
        ok: true,
        basis: 'explicit-sync-policy',
        decisionId: 'fixture-sync-allow',
      }
    },
    isCurrentBasis() {
      basisHook?.()
      return currentBasis
    },
    record(event) {
      events.push(event)
    },
  }
  const authority = createHostAuthority(inputs)
  const lifetime = value(
    authority.registerRootLifetime({
      signal: ownerStop.signal,
      boundary: value(captureRootDeadline({ clock, limit: unbounded })),
    }),
  )
  const owner = value(
    authority.registerOwner({
      description: { kind: 'run', owner: ownerDescription },
      lifetime,
    }),
  ).owner
  function action(
    limit: Limit = { kind: 'finite', durationMs: 250 },
    signal?: AbortSignal,
  ) {
    const budget = value(
      authority.registerAction({
        owner,
        parent: lifetime,
        limit,
        correlation: {
          kind: 'action',
          owner: ownerDescription,
          actionId: `native-action-${++actionId}`,
          attemptId: 'fixture-attempt',
          basisId: 'fixture-original-basis',
        },
      }),
    )
    const request = value(authority.registerRequest({ budget, signal }))
    return {
      budget,
      request,
      execution: value(authority.bindAction({ owner, budget, request })),
    }
  }
  function target(extra: Partial<TargetDescription> = {}): TargetDescription {
    return {
      executable: '/fixture/runtime/node',
      argv: ['target.mjs', 'literal argument'],
      cwd: '/fixture/project',
      projectRoot: '/fixture/project',
      allowedPaths: ['/fixture/project'],
      mode: 'assistant',
      processType: 'SYNC',
      family: 'sync-shell',
      branchId: 'fixture-native-target',
      profile,
      environmentOverlay: { VALUE: 'captured' },
      adapterOptions: {
        runtime: 'node',
        stdio: 'pipe',
        nativeAdapter: 'openbuff.exec.v1',
        nativeArtifactSha256: artifactSha256,
      },
      ...extra,
    }
  }
  function prepare(
    options: {
      target?: TargetDescription
      runLifetime?: boolean
      limit?: Limit
      requestSignal?: AbortSignal
    } = {},
  ) {
    const registration = action(options.limit, options.requestSignal),
      selectedTarget = options.target ?? target()
    const resourceStop = new AbortController()
    const destination = value(
      authority.registerDestination({
        snapshotId: 'fixture-native-config',
        origin: 'host',
        resolved: {
          kind: 'executable',
          command: selectedTarget.executable,
          args: selectedTarget.argv,
          declaredEnv: {},
        },
      }),
    )
    const resource = value(
      authority.registerResource({
        owner,
        destination,
        lifetime: options.runLifetime ? lifetime : registration.budget,
        resourceSignal: resourceStop.signal,
        launchTemplate: selectedTarget,
        reuse: 'exact-host-scope-lifetime-owner',
        restartPolicy: { kind: 'explicit-host-startup', maxAttempts: 2 },
      }),
    )
    const lease = value(
      authority.acquireLease({
        owner,
        request: registration.request,
        resource,
      }),
    )
    const launch = value(
      authority.prepareLaunch({
        resource,
        lease,
        request: registration.request,
        budget: registration.budget,
      }),
    )
    return { ...registration, resource, resourceStop, lease, launch }
  }
  async function dispatched(options: Parameters<typeof prepare>[0] = {}) {
    const context = prepare(options)
    const result = value(
      context.launch.dispatchNow(
        permit(await context.launch.admit()),
        (exact, observer) => ({ exact, observer }),
      ),
    )
    return {
      ...context,
      exact: result.handle.exact,
      observer: result.observer as NativeLaunchObserver,
    }
  }
  function advance(ms: number) {
    now += ms
    for (;;) {
      const due = [...tasks].find(([, task]) => task.at <= now)
      if (!due) break
      tasks.delete(due[0])
      due[1].callback()
    }
  }
  return {
    authority,
    owner,
    lifetime,
    ownerStop,
    action,
    target,
    prepare,
    dispatched,
    advance,
    events,
    approvals,
    resolverTargets,
    staleBasis: () => {
      currentBasis = false
    },
    changeGeneration: () => {
      generation = 'fixture-native-generation-2'
    },
    changeArtifactGeneration: () => {
      pinnedArtifact = 'c'.repeat(64)
    },
    onBasisCheck: (hook: () => void) => {
      basisHook = hook
    },
  }
}
type Harness = ReturnType<typeof harness>
type Context = Awaited<ReturnType<Harness['dispatched']>>
function observeReady(context: Context, observation = ready) {
  value(context.observer.nativeTransportObserved(transport))
  return context.observer.nativePrepared(observation)
}
function committed(context: Context) {
  value(observeReady(context))
  return value(context.observer.commitNativeTargetEntry(identity))
}
const startEvents = (h: Harness) =>
  h.events.filter((event) => event.phase === 'spawn-observed')

describe('native execution host authority (DI, no native OS coverage)', () => {
  test('exact target is admitted once; only matching committed exec status activates the native profile', async () => {
    const h = harness(),
      context = await h.dispatched()
    expect(h.approvals[0].target.executable).toBe('/fixture/runtime/node')
    expect(h.approvals[0].target.argv).toEqual([
      'target.mjs',
      'literal argument',
    ])
    expect(context.exact.cwd).toBe('/fixture/project')
    expect(context.exact.env).toEqual({
      PATH: '/fixture/toolchain',
      VALUE: 'captured',
    })
    expect(context.launch.facts().profile.active).toBeNull()
    expect(value(observeReady(context))).toBeUndefined()
    expect(context.launch.facts().profile.active).toBeNull()
    h.advance(75)
    const commit = value(context.observer.commitNativeTargetEntry(identity))
    expect(commit).toMatchObject({ ...identity, resourceRemainingMs: 175 })
    expect(commit.facts.profile.active).toBeNull()
    expect(context.launch.facts().profile.active).toBeNull()
    const entry = value(context.observer.nativeTargetEntered(entered))
    expect(entry.processObservationId.length).toBeGreaterThan(0)
    expect(context.launch.facts().profile.active?.backend).toBe('native-exec')
    expect(context.launch.facts().profile.enforced).toEqual(ready.enforced)
    expect(startEvents(h)).toHaveLength(1)
    expect(startEvents(h)[0]).toMatchObject({
      pid: entered.pid,
      processObservationId: entry.processObservationId,
    })
    expect(context.observer.nativeTargetEntered(entered).ok).toBe(false)
    expect(h.approvals).toHaveLength(1)
    expect(JSON.stringify(h.events)).not.toContain('fixture-private-secret')
  })

  test.each([
    'nativeTransportObserved',
    'nativePrepared',
    'commitNativeTargetEntry',
    'nativeTargetEntered',
  ] as const)(
    '%s authenticates its private facade receiver',
    async (method) => {
      const h = harness(),
        context = await h.dispatched()
      if (method !== 'nativeTransportObserved')
        value(context.observer.nativeTransportObserved(transport))
      if (
        method === 'commitNativeTargetEntry' ||
        method === 'nativeTargetEntered'
      )
        value(context.observer.nativePrepared(ready))
      if (method === 'nativeTargetEntered')
        value(context.observer.commitNativeTargetEntry(identity))
      const payload =
        method === 'nativeTransportObserved'
          ? transport
          : method === 'nativePrepared'
            ? ready
            : method === 'commitNativeTargetEntry'
              ? identity
              : entered
      const invoke = (receiver: unknown) =>
        Reflect.apply(context.observer[method], receiver, [
          payload,
        ]) as Result<unknown>
      expect(invoke({ ...context.observer }).ok).toBe(false)
      expect(invoke({}).ok).toBe(false)
      const foreign = await h.dispatched()
      expect(invoke(foreign.observer).ok).toBe(false)
      expect(context.launch.facts().profile.active).toBeNull()
      expect(invoke(context.observer).ok).toBe(true)
    },
  )

  test.each([
    'ready-before-monitor',
    'commit-before-ready',
    'entry-before-commit',
  ] as const)('%s cannot cross the target entry gate', async (phase) => {
    const h = harness(),
      context = await h.dispatched()
    if (phase !== 'ready-before-monitor')
      value(context.observer.nativeTransportObserved(transport))
    if (phase === 'entry-before-commit')
      value(context.observer.nativePrepared(ready))
    const result =
      phase === 'ready-before-monitor'
        ? context.observer.nativePrepared(ready)
        : phase === 'commit-before-ready'
          ? context.observer.commitNativeTargetEntry(identity)
          : context.observer.nativeTargetEntered(entered)
    expect(result.ok).toBe(false)
    expect(context.launch.facts().profile.active).toBeNull()
    expect(startEvents(h)).toHaveLength(0)
  })

  test.each(['monitor', 'ready', 'committed'] as const)(
    'native %s before target entry cannot activate, reuse or transfer a run-owned target',
    async (phase) => {
      const h = harness(),
        context = h.prepare({ runLifetime: true, limit: unbounded })
      const receiver = value(
        h.authority.registerOwner({
          lifetime: h.lifetime,
          description: {
            kind: 'run',
            owner: { ...ownerDescription, parentAgentId: 'fixture-receiver' },
          },
        }),
      )
      const offer = value(
        h.authority.offerTransfer({
          resource: context.resource,
          sender: h.owner,
          receiver: receiver.owner,
          request: context.request,
          expectedGeneration: context.launch.facts().resourceGeneration,
        }),
      )
      const accepted = value(
        h.authority.acceptTransfer({ offer, receiver: receiver.receiver }),
      )
      const dispatched = value(
        context.launch.dispatchNow(
          permit(await context.launch.admit()),
          () => 'monitor',
        ),
      )
      const observer = dispatched.observer as NativeLaunchObserver
      value(observer.nativeTransportObserved(transport))
      if (phase !== 'monitor') value(observer.nativePrepared(ready))
      if (phase === 'committed')
        value(observer.commitNativeTargetEntry(identity))
      expect(context.launch.facts().profile.active).toBeNull()
      expect(startEvents(h)).toHaveLength(0)
      expect(h.authority.commitTransfer(accepted).ok).toBe(false)
      const later = h.action(unbounded),
        lease = value(
          h.authority.acquireLease({
            owner: h.owner,
            request: later.request,
            resource: context.resource,
          }),
        )
      expect(
        (
          await h.authority.admitResourceUse({
            request: later.request,
            resource: context.resource,
            lease,
            operationDigest: 'fixture-operation',
          })
        ).ok,
      ).toBe(false)
      expect(
        h.events.filter((event) => event.phase === 'resource-reused'),
      ).toHaveLength(0)
    },
  )

  test('ordinary portable spawn observation refuses a native-backed target', async () => {
    const h = harness(),
      context = await h.dispatched()
    expect(
      context.observer.spawnObserved({
        source: 'node-spawn-event',
        pid: transport.pid,
      }).ok,
    ).toBe(false)
    expect(context.launch.facts().profile.active).toBeNull()
    expect(startEvents(h)).toHaveLength(0)
  })

  test.each([
    ['wrong-artifact', { artifactSha256: 'c'.repeat(64) }],
    ['zero-pid', { pid: 0 }],
    ['fractional-pid', { pid: 1.5 }],
    ['wrong-source', { source: 'node-spawn-event' }],
  ] as const)(
    'invalid monitor %s never activates the target',
    async (_label, change) => {
      const h = harness(),
        context = await h.dispatched()
      expect(
        context.observer.nativeTransportObserved({
          ...transport,
          ...change,
        } as NativeTransportObservation).ok,
      ).toBe(false)
      expect(context.observer.commitNativeTargetEntry(identity).ok).toBe(false)
      expect(context.launch.facts().profile.active).toBeNull()
    },
  )

  test.each([
    ['artifact', { artifactSha256: 'c'.repeat(64) }],
    ['plan', { planDigest: 'd'.repeat(64) }],
    ['nonce', { nonce: 'different-plan-nonce' }],
    ['empty-scope', { scopeId: '' }],
  ] as const)(
    'prepared %s must match the private monitor plan',
    async (_label, change) => {
      const h = harness(),
        context = await h.dispatched()
      value(context.observer.nativeTransportObserved(transport))
      expect(context.observer.nativePrepared({ ...ready, ...change }).ok).toBe(
        false,
      )
      expect(context.observer.commitNativeTargetEntry(identity).ok).toBe(false)
      expect(context.launch.facts().profile.active).toBeNull()
    },
  )

  test.each([
    'missing',
    'not-enforced',
    'unknown',
    'missing-evidence',
    'duplicate',
  ] as const)(
    'prepared required enforcement %s refuses entry',
    async (mode) => {
      const h = harness(),
        context = await h.dispatched()
      let enforced = [...ready.enforced]
      if (mode === 'missing')
        enforced = enforced.filter(
          (item) => item.capability !== 'filesystem-isolation',
        )
      if (mode === 'not-enforced' || mode === 'unknown')
        enforced = enforced.map((item) =>
          item.capability === 'filesystem-isolation'
            ? { capability: item.capability, status: mode }
            : item,
        )
      if (mode === 'missing-evidence')
        enforced = enforced.map((item) => ({
          capability: item.capability,
          status: item.status,
        }))
      if (mode === 'duplicate') enforced.push(enforced[0])
      expect(observeReady(context, { ...ready, enforced }).ok).toBe(false)
      expect(context.observer.commitNativeTargetEntry(identity).ok).toBe(false)
      expect(context.launch.facts().profile.active).toBeNull()
    },
  )

  test.each(['artifact', 'plan', 'nonce'] as const)(
    'entry commit rejects a different %s',
    async (field) => {
      const h = harness(),
        context = await h.dispatched()
      value(observeReady(context))
      const wrong = {
        ...identity,
        [field === 'artifact'
          ? 'artifactSha256'
          : field === 'plan'
            ? 'planDigest'
            : 'nonce']: 'e'.repeat(64),
      }
      expect(context.observer.commitNativeTargetEntry(wrong).ok).toBe(false)
      expect(context.launch.facts().profile.active).toBeNull()
    },
  )

  test('the entry commit is single use and preserves the original remaining budget', async () => {
    const h = harness(),
      context = await h.dispatched()
    value(observeReady(context))
    h.advance(100)
    const commit = value(context.observer.commitNativeTargetEntry(identity))
    expect(commit.resourceRemainingMs).toBe(150)
    h.advance(10)
    expect(context.observer.commitNativeTargetEntry(identity).ok).toBe(false)
    expect(value(h.authority.remainingMs(context.budget))).toBe(140)
    expect(context.launch.facts().profile.active).toBeNull()
  })

  test.each([
    'basis',
    'profile-generation',
    'artifact-generation',
    'lease',
    'resource-signal',
    'request-signal',
    'owner',
    'deadline',
    'cleanup',
  ] as const)(
    'entry commit rechecks original %s after prepared',
    async (change) => {
      const h = harness(),
        requestStop = new AbortController(),
        context = await h.dispatched({ requestSignal: requestStop.signal })
      value(observeReady(context))
      if (change === 'basis') h.staleBasis()
      if (change === 'profile-generation') h.changeGeneration()
      if (change === 'artifact-generation') h.changeArtifactGeneration()
      if (change === 'lease') value(h.authority.releaseLease(context.lease))
      if (change === 'resource-signal') context.resourceStop.abort()
      if (change === 'request-signal') requestStop.abort()
      if (change === 'owner') h.ownerStop.abort()
      if (change === 'deadline') h.advance(250)
      if (change === 'cleanup') value(context.observer.cleanupCommitted())
      expect(context.observer.commitNativeTargetEntry(identity).ok).toBe(false)
      expect(context.launch.facts().profile.active).toBeNull()
      expect(startEvents(h)).toHaveLength(0)
    },
  )

  test('basis callback cancellation cannot slip through the native commit check', async () => {
    const h = harness(),
      context = await h.dispatched()
    value(observeReady(context))
    h.onBasisCheck(() => context.resourceStop.abort())
    expect(context.observer.commitNativeTargetEntry(identity).ok).toBe(false)
    expect(context.launch.facts().profile.active).toBeNull()
  })

  test('old native observer cannot enter or prepare a replaced resource generation', async () => {
    const h = harness(),
      context = await h.dispatched({ runLifetime: true, limit: unbounded })
    committed(context)
    value(
      context.observer.failure({
        source: 'adapter-observation-error',
        cause: 'fixture monitor setup failure',
      }),
    )
    const maintenance = value(
      h.authority.registerMaintenanceRequest({
        resource: context.resource,
        reason: 'observed-adapter-failure',
      }),
    )
    const next = value(
      h.authority.nextResourceGeneration({
        previous: context.resource,
        request: maintenance.request,
      }),
    )
    expect(value(h.authority.resourceGeneration(next))).not.toBe(
      context.launch.facts().resourceGeneration,
    )
    expect(context.observer.nativeTransportObserved(transport).ok).toBe(false)
    expect(context.observer.nativePrepared(ready).ok).toBe(false)
    expect(context.observer.commitNativeTargetEntry(identity).ok).toBe(false)
    expect(context.observer.nativeTargetEntered(entered).ok).toBe(false)
    expect(context.launch.facts().profile.active).toBeNull()
  })

  test.each([
    ['scope', { scopeId: 'unrelated-namespace' }],
    ['nonce', { nonce: 'other-nonce' }],
    ['plan', { planDigest: 'f'.repeat(64) }],
    ['artifact', { artifactSha256: 'c'.repeat(64) }],
    ['pid', { pid: 0 }],
    ['source', { source: 'native-adapter-ready' }],
  ] as const)(
    'target entry %s cannot activate a different committed job',
    async (_label, change) => {
      const h = harness(),
        context = await h.dispatched()
      committed(context)
      expect(
        context.observer.nativeTargetEntered({
          ...entered,
          ...change,
        } as NativeTargetEntryObservation).ok,
      ).toBe(false)
      expect(context.launch.facts().profile.active).toBeNull()
      expect(startEvents(h)).toHaveLength(0)
    },
  )

  test.each([
    'basis',
    'profile-generation',
    'lease',
    'request-signal',
    'deadline',
    'cleanup',
  ] as const)(
    'stale %s after commit retains a real entry observation while refusing success and reuse',
    async (change) => {
      const h = harness(),
        stop = new AbortController(),
        context = await h.dispatched({ requestSignal: stop.signal })
      committed(context)
      if (change === 'basis') h.staleBasis()
      if (change === 'profile-generation') h.changeGeneration()
      if (change === 'lease') value(h.authority.releaseLease(context.lease))
      if (change === 'request-signal') stop.abort()
      if (change === 'deadline') h.advance(250)
      if (change === 'cleanup') value(context.observer.cleanupCommitted())
      expect(context.observer.nativeTargetEntered(entered).ok).toBe(false)
      expect(context.launch.facts().profile.active?.backend).toBe('native-exec')
      expect(startEvents(h)).toHaveLength(1)
      expect(startEvents(h)[0]).toMatchObject({ pid: entered.pid })
      expect(
        h.events.filter((event) => event.phase === 'dispatch-failed'),
      ).toContainEqual(expect.objectContaining({ processStart: 'observed' }))
      const next = h.action(unbounded)
      const lease = h.authority.acquireLease({
        owner: h.owner,
        request: next.request,
        resource: context.resource,
      })
      if (lease.ok)
        expect(
          (
            await h.authority.admitResourceUse({
              request: next.request,
              resource: context.resource,
              lease: lease.value,
              operationDigest: 'no-reuse-after-stale-entry',
            })
          ).ok,
        ).toBe(false)
      expect(
        h.events.filter((event) => event.phase === 'resource-reused'),
      ).toHaveLength(0)
    },
  )

  test('target-aware profile resolution sees a frozen original target and artifact pin', async () => {
    const h = harness(),
      args = ['target.mjs'],
      options = {
        runtime: 'node',
        nativeAdapter: 'openbuff.exec.v1',
        nativeArtifactSha256: artifactSha256,
      }
    const context = h.prepare({
      target: h.target({ argv: args, adapterOptions: options }),
    })
    args.push('late')
    options.nativeArtifactSha256 = 'c'.repeat(64)
    expect((await context.launch.admit()).ok).toBe(true)
    expect(h.resolverTargets.length).toBeGreaterThan(0)
    for (const captured of h.resolverTargets) {
      expect(captured?.argv).toEqual(['target.mjs'])
      expect(captured?.adapterOptions.nativeArtifactSha256).toBe(artifactSha256)
      expect(Object.isFrozen(captured)).toBe(true)
      expect(Object.isFrozen(captured?.adapterOptions)).toBe(true)
    }
  })

  test.each([
    [
      'marker',
      {
        runtime: 'node',
        nativeAdapter: 'wrong-adapter',
        nativeArtifactSha256: artifactSha256,
      },
    ],
    [
      'artifact',
      {
        runtime: 'node',
        nativeAdapter: 'openbuff.exec.v1',
        nativeArtifactSha256: 'c'.repeat(64),
      },
    ],
    [
      'runtime',
      {
        runtime: 'bun',
        nativeAdapter: 'openbuff.exec.v1',
        nativeArtifactSha256: artifactSha256,
      },
    ],
  ] as const)(
    'profile cannot select native without the captured %s',
    async (_label, options) => {
      const h = harness(),
        context = h.prepare({ target: h.target({ adapterOptions: options }) })
      expect(context.launch.facts().profile.selected).toBeNull()
      expect((await context.launch.admit()).ok).toBe(false)
      expect(context.launch.facts().profile.active).toBeNull()
    },
  )

  test.each([
    ['unknown-optional', { optional: ['invented-isolation'] }],
    ['duplicate-optional', { optional: ['memory-limit', 'memory-limit'] }],
    ['overlap', { optional: ['exact-env'] }],
    ['non-list', { optional: 'memory-limit' }],
    ['duplicate-required', { required: ['exact-env', 'exact-env'] }],
  ] as const)(
    'invalid profile %s refuses before admission',
    (_label, change) => {
      const h = harness(),
        invalid = { ...profile, ...change } as unknown as RequestedProfile
      const prepared = h
        .action()
        .execution.prepareTarget({ target: h.target({ profile: invalid }) })
      expect(prepared.ok).toBe(false)
      expect(h.approvals).toHaveLength(0)
    },
  )

  test('known optional capabilities are copied/frozen and unavailable optional memory stays truthful after entry', async () => {
    const h = harness(),
      optional: Capability[] = ['memory-limit']
    const context = await h.dispatched({
      target: h.target({
        profile: { ...profile, optional } as RequestedProfile,
      }),
    })
    optional.push('network-isolation')
    const facts = context.launch.facts()
    expect((facts.profile.requested as RequestedProfile).optional).toEqual([
      'memory-limit',
    ])
    expect(
      Object.isFrozen((facts.profile.requested as RequestedProfile).optional),
    ).toBe(true)
    value(
      observeReady(context, {
        ...ready,
        enforced: [
          ...ready.enforced,
          { capability: 'memory-limit', status: 'not-enforced' },
        ],
      }),
    )
    value(context.observer.commitNativeTargetEntry(identity))
    value(context.observer.nativeTargetEntered(entered))
    expect(context.launch.facts().profile.active?.backend).toBe('native-exec')
    expect(context.launch.facts().profile.enforced).toContainEqual({
      capability: 'memory-limit',
      status: 'not-enforced',
    })
    expect(
      context.launch.facts().profile.available[0].capabilities,
    ).not.toContain('memory-limit')
    expect(
      (context.launch.facts().profile.requested as RequestedProfile).optional,
    ).toEqual(['memory-limit'])
  })

  test('optional roster affects its profile subdigest while the outer authority tuple remains 29 fields', async () => {
    const h = harness()
    for (const requested of [
      profile,
      { ...profile },
      { ...profile, optional: [] } as RequestedProfile,
      { ...profile, optional: ['memory-limit'] } as RequestedProfile,
    ]) {
      const context = h.prepare({ target: h.target({ profile: requested }) })
      value(await context.launch.admit())
    }
    const bindings = h.approvals.map((input) => input.binding)
    expect(bindings[0].profileRequestDigest).toBe(
      bindings[1].profileRequestDigest,
    )
    expect(bindings[2].profileRequestDigest).not.toBe(
      bindings[0].profileRequestDigest,
    )
    expect(bindings[3].profileRequestDigest).not.toBe(
      bindings[2].profileRequestDigest,
    )
    for (const binding of bindings)
      expect(executionBindingTuple(binding)).toHaveLength(29)
  })
})
