import { randomUUID } from 'node:crypto'
import {
  captureRootDeadline,
  createHostAuthority,
} from '../../util/execution-context'
import type {
  BoundResourceFactory,
  BoundResourcePort,
  ExecutionAdapterContext,
  HostAuthorityInputs,
  LaunchEvent,
  ProfileRequest,
  ResourceHandle,
  Result,
  Limit,
} from '../../types/contracts/execution-context'

export function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}

/** Real private authority; the policy/classifier are explicit fixture stubs. */
export function executionFixture(
  overrides: Partial<HostAuthorityInputs> = {},
  rootLimit: Limit = { kind: 'unbounded' },
) {
  const events: LaunchEvent[] = []
  const stop = new AbortController()
  const clock = overrides.clock ?? {
    domainId: 'external-adapter-fixture',
    nowMs: () => Math.floor(performance.now()),
  }
  const profile: ProfileRequest = {
    policy: 'full-access',
    preferredBackend: 'portable-ts',
    required: ['exact-env'],
    allowBackendFallback: false,
  }
  const authority = createHostAuthority({
    configuration: {
      snapshotId: 'fixture-snapshot',
      trustPolicyId: 'fixture-trust',
      rosterId: 'fixture-roster',
      canonicalCredentialNames: ['OPENAI_API_KEY'],
      configuredCredentialNames: ['CUSTOM_PROVIDER_KEY'],
    },
    childInheritanceEnvironment: {
      PATH: '/usr/bin:/bin',
      PROJECT_VALUE: 'ordinary',
      OPENAI_API_KEY: 'canonical-sentinel',
      CUSTOM_PROVIDER_KEY: 'configured-sentinel',
    },
    childOverrides: {},
    inheritEnv: true,
    platform: 'linux',
    clock,
    scheduler: {
      set: (delay, callback) => setTimeout(callback, delay),
      clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    },
    resolveProfile: (request) => ({
      requested: request,
      available: [
        {
          backend: 'portable-ts',
          generation: 'fixture-node',
          capabilities: ['exact-env', 'cooperative-cancellation'],
          unavailableReasons: [],
        },
      ],
      selected: {
        backend: 'portable-ts',
        generation: 'fixture-node',
        policy: request.policy,
        cancellation: 'cooperative',
      },
      active: null,
      enforced: [],
    }),
    classifyTarget: (captured) => ({
      format: 'openbuff.target-classification.v1',
      classifierVersion: 'fixture-allow-policy',
      invocationKind: captured.kind,
      effects: [],
      parseStatus: 'complete',
      parseReason: null,
    }),
    authorizeAsync: async () => ({
      ok: true,
      basis: 'explicit-policy',
      decisionId: randomUUID(),
    }),
    authorizeSync: () => ({
      ok: true,
      basis: 'explicit-sync-policy',
      decisionId: randomUUID(),
    }),
    isCurrentBasis: () => true,
    record: (event) => events.push(event),
    ...overrides,
  })
  const lifetime = value(
    authority.registerRootLifetime({
      signal: stop.signal,
      boundary: value(captureRootDeadline({ clock, limit: rootLimit })),
    }),
  )
  const owner = value(
    authority.registerOwner({
      description: { kind: 'host', hostId: 'external-adapter-fixture' },
      lifetime,
    }),
  ).owner
  const cacheScope = {}
  const context = (signal?: AbortSignal): ExecutionAdapterContext => {
    const budget = value(
      authority.registerHostOperation({
        owner,
        parent: lifetime,
        purpose: 'direct-host-operation',
        limit: { kind: 'unbounded' },
      }),
    )
    const request = value(authority.registerRequest({ budget, signal }))
    return {
      execution: value(authority.bindAction({ owner, budget, request })),
      projectRoot: process.cwd(),
      allowedPaths: [process.cwd()],
      profile,
      mode: 'assistant',
      cacheScope,
      signal,
    }
  }
  const ports = new Map<ResourceHandle, BoundResourcePort>()
  const bound = (handle: ResourceHandle): BoundResourcePort => {
    const existing = ports.get(handle)
    if (existing) return existing
    const port: BoundResourcePort = {
      key: randomUUID(),
      request: (action) => action.requestResource(handle),
      restart: (reason) => {
        const maintenance = authority.registerMaintenanceRequest({
          resource: handle,
          reason,
        })
        if (!maintenance.ok) return maintenance
        const next = authority.nextResourceGeneration({
          previous: handle,
          request: maintenance.value.request,
        })
        return next.ok ? { ok: true, value: bound(next.value) } : next
      },
    }
    ports.set(handle, port)
    return port
  }
  const resources: BoundResourceFactory = (target) => {
    const destination = authority.registerDestination({
      snapshotId: 'fixture-snapshot',
      origin: 'host',
      resolved: {
        kind: target.family === 'mcp-stdio' ? 'mcp-stdio' : 'executable',
        command: target.executable,
        args: target.argv,
        declaredEnv: {},
      },
    })
    if (!destination.ok) return destination
    const registered = authority.registerResource({
      owner,
      lifetime,
      destination: destination.value,
      launchTemplate: target,
      reuse: 'exact-host-scope-lifetime-owner',
      restartPolicy: { kind: 'explicit-host-startup', maxAttempts: 2 },
    })
    if (!registered.ok) return registered
    return { ok: true, value: bound(registered.value) }
  }
  return { authority, context, resources, events, close: () => stop.abort() }
}
