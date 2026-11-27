import { describe, expect, test } from 'bun:test'

import {
  captureRootDeadline,
  createHostAuthority,
  readOnlyPlanExecutionProfile,
} from '../execution-context'
import type {
  ActionExecutionPort,
  HostAuthorityInputs,
  ProfileRequest,
  Result,
  TargetDescription,
} from '../../types/contracts/execution-context'

const unbounded = { kind: 'unbounded' } as const
const full: ProfileRequest = {
  policy: 'full-access',
  preferredBackend: 'portable-ts',
  required: ['exact-env'],
  allowBackendFallback: false,
}
const readOnly: ProfileRequest = {
  policy: 'read-only',
  preferredBackend: 'native-exec',
  required: [
    'exact-env',
    'filesystem-isolation',
    'network-isolation',
    'process-tree-containment',
  ],
  allowBackendFallback: false,
}
const ownerDescription = {
  clientSessionId: 'bounds-client',
  rootRunId: 'bounds-root',
  parentRunId: 'bounds-root',
  parentAgentId: 'bounds-agent',
}
const bounds = {
  projectRoot: '/owned/project',
  allowedPaths: ['/owned/project'],
  profile: readOnly,
  mode: 'assistant' as const,
}

function value<T>(
  result: Result<T> | { ok: false; reason: string; cause: string },
): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}

/** These are host-registry controls, not evidence of an operating-system sandbox. */
function fixture() {
  let now = 100,
    policies = 0
  const clock = { domainId: 'target-bounds-clock', nowMs: () => now }
  const inputs: HostAuthorityInputs = {
    configuration: {
      snapshotId: 'bounds-config',
      trustPolicyId: 'bounds-trust',
      rosterId: 'bounds-roster',
      canonicalCredentialNames: [],
      configuredCredentialNames: [],
    },
    childInheritanceEnvironment: {},
    childOverrides: {},
    inheritEnv: false,
    platform: 'linux',
    clock,
    scheduler: { set: () => undefined, clear() {} },
    resolveProfile: (request) => ({
      requested: request,
      active: null,
      available: [
        {
          backend: request.preferredBackend,
          generation: 'bounds-backend',
          capabilities: [
            'exact-env',
            'filesystem-isolation',
            'network-isolation',
            'process-tree-containment',
          ],
          unavailableReasons: [],
        },
      ],
      selected: {
        backend: request.preferredBackend,
        generation: 'bounds-backend',
        policy: request.policy,
        cancellation:
          request.preferredBackend === 'native-exec'
            ? 'os-scoped'
            : 'cooperative',
      },
      enforced: request.required.map((capability) => ({
        capability,
        status: 'unknown' as const,
      })),
    }),
    classifyTarget: (captured) => ({
      format: 'openbuff.target-classification.v1',
      classifierVersion: 'bounds-test',
      invocationKind: captured.kind,
      effects: [],
      parseStatus: 'complete',
      parseReason: null,
    }),
    authorizeAsync: async () => {
      policies++
      return { ok: true, basis: 'explicit-policy', decisionId: 'bounds-allow' }
    },
    authorizeSync: () => {
      policies++
      return {
        ok: true,
        basis: 'explicit-sync-policy',
        decisionId: 'bounds-allow',
      }
    },
    isCurrentBasis: () => true,
    record() {},
  }
  const authority = createHostAuthority(inputs)
  const lifetime = value(
    authority.registerRootLifetime({
      boundary: value(captureRootDeadline({ clock, limit: unbounded })),
    }),
  )
  const owner = value(
    authority.registerOwner({
      description: { kind: 'run', owner: ownerDescription },
      lifetime,
    }),
  ).owner
  let id = 0
  function action(selectedBounds = bounds, signal?: AbortSignal) {
    const budget = value(
      authority.registerAction({
        owner,
        parent: lifetime,
        limit: { kind: 'finite', durationMs: 50 },
        correlation: {
          kind: 'action',
          actionId: `bounds-${++id}`,
          attemptId: 'attempt',
          basisId: 'basis',
          owner: ownerDescription,
        },
      }),
    )
    const request = value(authority.registerRequest({ budget, signal }))
    const execution = value(
      authority.bindAction({ owner, budget, request, bounds: selectedBounds }),
    )
    return { execution, budget, request }
  }
  function target(extra: Partial<TargetDescription> = {}): TargetDescription {
    return {
      executable: '/usr/bin/fixture',
      argv: ['--version'],
      cwd: bounds.projectRoot,
      projectRoot: bounds.projectRoot,
      allowedPaths: [...bounds.allowedPaths],
      profile: readOnly,
      mode: 'assistant',
      processType: 'SYNC',
      family: 'sync-shell',
      branchId: 'bounds.control',
      adapterOptions: {
        runtime: 'node',
        nativeAdapter: 'openbuff.exec.v1',
        nativeArtifactSha256: 'a'.repeat(64),
      },
      ...extra,
    }
  }
  function resource(template: TargetDescription) {
    const destination = value(
      authority.registerDestination({
        snapshotId: 'bounds-config',
        origin: 'host',
        resolved: {
          kind: 'executable',
          command: template.executable,
          args: template.argv,
          declaredEnv: {},
        },
      }),
    )
    return value(
      authority.registerResource({
        owner,
        lifetime,
        destination,
        launchTemplate: template,
        reuse: 'exact-host-scope-lifetime-owner',
        restartPolicy: { kind: 'explicit-host-startup', maxAttempts: 2 },
      }),
    )
  }
  return {
    authority,
    owner,
    lifetime,
    action,
    target,
    resource,
    policies: () => policies,
    setNow: (next: number) => {
      now = next
    },
  }
}

describe('authenticated execution target bounds', () => {
  test('plan attenuation retains required host capabilities and promotes optional isolation', () => {
    const parent: ProfileRequest = {
      ...full,
      required: ['exact-env', 'memory-limit'],
      optional: ['network-isolation', 'cooperative-cancellation'],
    }
    const original = JSON.stringify(parent)
    const narrowed = readOnlyPlanExecutionProfile(parent)
    expect(narrowed).toEqual({
      policy: 'read-only',
      preferredBackend: 'native-exec',
      allowBackendFallback: false,
      required: [
        'exact-env',
        'memory-limit',
        'filesystem-isolation',
        'network-isolation',
        'process-tree-containment',
      ],
      optional: ['cooperative-cancellation'],
    })
    expect(Object.isFrozen(narrowed)).toBe(true)
    expect(Object.isFrozen(narrowed.required)).toBe(true)
    expect(Object.isFrozen(narrowed.optional)).toBe(true)
    expect(JSON.stringify(parent)).toBe(original)
  })

  const changes: Array<[string, Partial<TargetDescription>]> = [
    ['policy/backend widening', { profile: full }],
    [
      'required capability removal',
      { profile: { ...readOnly, required: ['exact-env'] } },
    ],
    [
      'fallback enablement',
      { profile: { ...readOnly, allowBackendFallback: true } },
    ],
    [
      'required-to-optional downgrade',
      {
        profile: {
          ...readOnly,
          required: ['exact-env'],
          optional: [
            'filesystem-isolation',
            'network-isolation',
            'process-tree-containment',
          ],
        },
      },
    ],
    ['user-mode bypass', { mode: 'user' }],
    ['project replacement', { projectRoot: '/outside/project' }],
    ['allowlist widening', { allowedPaths: ['/owned/project', '/outside'] }],
  ]
  for (const [label, change] of changes) {
    test(`refuses ${label} before classification approval or target dispatch`, async () => {
      const f = fixture(),
        execution = f.action().execution
      const prepared = execution.prepareTarget({ target: f.target(change) })
      expect(prepared).toMatchObject({ ok: false, reason: 'invalid-context' })
      expect(f.policies()).toBe(0)
    })
  }

  test('matching copied descriptions retain the registered read-only profile', async () => {
    const f = fixture(),
      execution = f.action().execution
    const launch = value(
      execution.prepareTarget({
        target: f.target({
          profile: { ...readOnly, required: [...readOnly.required] },
        }),
      }),
    )
    expect(launch.facts().profile.requested).toEqual(readOnly)
    expect((await launch.admit()).ok).toBe(true)
    expect(launch.facts().profile.active).toBeNull()
    expect(
      launch
        .facts()
        .profile.enforced.every((item) => item.status === 'unknown'),
    ).toBe(true)
  })

  test('budget derivation cannot discard the bound profile or renew its deadline', () => {
    const f = fixture(),
      original = f.action()
    const child = value(
      original.execution.derive({ memoKey: 'plan-child', limit: unbounded }),
    )
    const grandchild = value(
      child.derive({ memoKey: 'plan-grandchild', limit: unbounded }),
    )
    for (const execution of [child, grandchild]) {
      expect(
        execution.prepareTarget({ target: f.target({ profile: full }) }),
      ).toMatchObject({ ok: false, reason: 'invalid-context' })
      const registered = value(f.authority.actionRegistration(execution))
      expect(f.authority.deadline(registered.budget)).toMatchObject({
        kind: 'finite',
        expiresAtMs: 150,
      })
    }
    f.setNow(150)
    expect(grandchild.prepareTarget({ target: f.target() })).toMatchObject({
      ok: false,
      reason: 'deadline-exhausted',
    })
  })

  test('re-binding the same request cannot omit or replace its authenticated bounds', () => {
    const f = fixture(),
      original = f.action()
    const registration = value(
      f.authority.actionRegistration(original.execution),
    )
    const rebound = value(
      f.authority.bindAction({
        owner: registration.owner,
        budget: registration.budget,
        request: registration.request,
      }),
    )
    expect(
      rebound.prepareTarget({ target: f.target({ profile: full }) }),
    ).toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(
      f.authority.bindAction({
        ...registration,
        bounds: { ...bounds, profile: full },
      }),
    ).toMatchObject({ ok: false, reason: 'invalid-context' })
  })

  test('bound resources cannot be borrowed through a broader reusable process', () => {
    const f = fixture(),
      action = f.action(),
      broader = f.resource(f.target({ profile: full }))
    expect(action.execution.requestResource(broader)).toMatchObject({
      ok: false,
      reason: 'invalid-context',
    })
    expect(
      f.authority.acquireLease({
        request: action.request,
        resource: broader,
        owner: f.owner,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(f.policies()).toBe(0)
    const matching = f.resource(f.target())
    expect(action.execution.requestResource(matching).ok).toBe(true)
  })

  test('a resource facade cannot substitute a broader request or sibling lease use permit', async () => {
    const f = fixture(),
      broadBounds = { ...bounds, profile: full }
    const broader = f.action(broadBounds)
    const running = f.resource(f.target({ profile: full }))
    const broadFacade = value(broader.execution.requestResource(running))
    const launch = value(broadFacade.prepareLaunch())
    const admission = value(await launch.admit())
    value(
      launch.dispatchNow(admission.permit, (_input, observer) => {
        value(observer.spawnObserved({ source: 'node-spawn-event', pid: 123 }))
      }),
    )
    const permit = value(await broadFacade.admitUse('broader-operation'))
    const narrowFacade = value(
      f.action().execution.requestResource(f.resource(f.target())),
    )
    const siblingFacade = value(
      f.action(broadBounds).execution.requestResource(running),
    )
    let calls = 0
    for (const facade of [narrowFacade, siblingFacade])
      expect(
        facade.useNow(permit, () => {
          calls++
          return 'must not run'
        }),
      ).toMatchObject({ ok: false, reason: 'stale-authority' })
    expect(calls).toBe(0)
    expect(value(broadFacade.useNow(permit, () => 'original request'))).toBe(
      'original request',
    )
  })

  test('input copies are frozen privately and caller cancellation still reaches descendants', () => {
    const f = fixture(),
      controller = new AbortController()
    const mutable = {
      ...bounds,
      allowedPaths: [...bounds.allowedPaths],
      profile: { ...readOnly, required: [...readOnly.required] },
    }
    const original = f.action(mutable, controller.signal)
    mutable.profile.policy = 'full-access'
    mutable.allowedPaths.push('/outside')
    const child = value(
      original.execution.derive({ memoKey: 'cancel-plan', limit: unbounded }),
    )
    expect(
      child.prepareTarget({
        target: f.target({ allowedPaths: mutable.allowedPaths }),
      }),
    ).toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(child.prepareTarget({ target: f.target() }).ok).toBe(true)
    controller.abort(new Error('stop bounded plan request'))
    expect(child.signal?.aborted).toBe(true)
    expect(child.prepareTarget({ target: f.target() })).toMatchObject({
      ok: false,
      reason: 'cancelled',
    })
    expect(
      ({ ...child } as ActionExecutionPort).prepareTarget({
        target: f.target(),
      }).ok,
    ).toBe(false)
  })
})
