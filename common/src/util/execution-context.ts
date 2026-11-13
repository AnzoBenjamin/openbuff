import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'

import type {
  AbsoluteDeadline, ActionExecutionPort, Admission, AuthorityBindingV2,
  BudgetHandle, Capability, CapturedExecutable, Clock, Correlation,
  DeadlineFacts, DelegationHandle, DestinationHandle, ExactLaunchInput,
  HostAuthority, HostAuthorityInputs, LaunchEvent, LaunchFacts, LaunchObserver,
  LeaseHandle, LifetimeHandle, Limit, OwnerHandle, PolicyInput, PreparedLaunch,
  ProfileFacts, ReceiverCapability, Refusal, RequestHandle, ResourceHandle,
  Result, RootDeadlineSeed, TargetClassification, TargetDescription, TargetPermit,
  TransferOffer, TransferPermit, UsePermit,
} from '../types/contracts/execution-context'
import type { NativePlanIdentity, NativePreparedObservation } from '../types/contracts/native-execution'

const MAX_TIMER_MS = 2_147_483_647
const policies = new Set(['read-only', 'librarian-read-only', 'git-commit',
  'dependency-mutation', 'validation-diagnosis', 'tmux-test', 'workspace-write', 'full-access'])
const capabilities = new Set(['exact-env', 'cooperative-cancellation', 'filesystem-isolation',
  'network-isolation', 'process-tree-containment', 'memory-limit', 'deadline-termination'])
const actions = new Set(['dependency-install', 'commit', 'migration', 'push', 'pull-request',
  'release', 'deploy', 'external-network', 'arbitrary-code', 'workspace-delete', 'mcp-tool'])
const risks = new Set(['force', 'delete', 'refspec', 'mirror', 'all-refs', 'unknown-options', 'dynamic-target'])
const families = new Set(['sync-shell', 'background-job', 'supervised-child', 'configured-hook',
  'diagnostic-build-version-scip', 'lsp', 'mcp-stdio', 'chrome', 'blender', 'native-role'])

const deadlineSignals = new WeakMap<AbortSignal, WeakSet<Error>>()

/** Only registered host signals carrying their own authority's expiry reason qualify. */
export function isExecutionDeadlineSignal(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof Error &&
    deadlineSignals.get(signal)?.has(signal.reason) === true
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const refuse = (reason: Refusal['reason'], cause: string): Refusal => ({ ok: false, reason, cause })
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const thenable = (value: unknown): boolean =>
  value !== null && (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { then?: unknown }).then === 'function'

/** The reviewed v2 order is independent of object insertion order. */
export function executionBindingTuple(binding: AuthorityBindingV2): readonly unknown[] {
  return [binding.format, binding.keyEpochId, binding.commandHash, binding.executableArgvDigest,
    binding.effectRosterDigest, binding.parseStatus, binding.hostContextId, binding.configurationSnapshotId,
    binding.correlationDigest, binding.cwd, binding.projectRoot, binding.allowedPaths,
    binding.profileRequestDigest, binding.selectedBackendDigest, binding.environmentDigest,
    binding.credentialRosterId, binding.destinationId, binding.delegationDigest, binding.requestId,
    binding.resourceId, binding.resourceGeneration, binding.ownerId, binding.leaseId,
    binding.processType, binding.mode, binding.detachTransferId, binding.deadlinesDigest,
    binding.adapterOptionsDigest, binding.launchId]
}

function copy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(copy)) as T
  if (plain(value)) {
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, entry] of Object.entries(value)) result[key] = copy(entry)
    return Object.freeze(result) as T
  }
  return value
}

function validLimit(limit: Limit): boolean {
  return plain(limit) && (limit.kind === 'unbounded' ||
    (limit.kind === 'finite' && Number.isSafeInteger(limit.durationMs) && limit.durationMs > 0))
}

function validNow(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}

function validDeadline(value: AbsoluteDeadline, domain: string): boolean {
  return plain(value) && nonempty(value.limitId) && (value.kind === 'unbounded' ||
    (value.kind === 'finite' && value.domainId === domain && validNow(value.expiresAtMs)))
}

function expires(deadline: AbsoluteDeadline): number {
  return deadline.kind === 'finite' ? deadline.expiresAtMs : Infinity
}

function deadlineTuple(deadline: AbsoluteDeadline): unknown[] {
  return deadline.kind === 'finite'
    ? ['finite', deadline.limitId, deadline.domainId, deadline.expiresAtMs]
    : ['unbounded', deadline.limitId]
}

function boundedDeadline(clock: Clock, now: number, limit: Limit,
  parent?: AbsoluteDeadline): Result<AbsoluteDeadline> {
  if (!validLimit(limit) || !validNow(now) || !nonempty(clock.domainId))
    return refuse('invalid-context', 'Invalid clock or duration')
  const localExpiry = limit.kind === 'finite' ? now + limit.durationMs : Infinity
  if (localExpiry !== Infinity && !validNow(localExpiry))
    return refuse('invalid-context', 'Deadline arithmetic exceeds the clock range')
  if (parent && !validDeadline(parent, clock.domainId))
    return refuse('invalid-context', 'Parent deadline belongs to another clock domain')
  const expiry = Math.min(localExpiry, parent ? expires(parent) : Infinity)
  const limitId = randomUUID()
  return ok(Object.freeze(expiry === Infinity
    ? { kind: 'unbounded' as const, limitId }
    : { kind: 'finite' as const, limitId, domainId: clock.domainId, expiresAtMs: expiry }))
}

/** Capture the selected root limit before synchronous configuration loading. */
export function captureRootDeadline(p: Readonly<{
  clock: Clock; limit: Limit; existingParent?: RootDeadlineSeed
}>): Result<RootDeadlineSeed> {
  try {
    const now = p.clock.nowMs()
    if (!nonempty(p.clock.domainId) || !validNow(now))
      return refuse('invalid-context', 'Invalid root clock')
    if (p.existingParent && (p.existingParent.domainId !== p.clock.domainId ||
      !validNow(p.existingParent.sampledAtMs) || p.existingParent.sampledAtMs > now))
      return refuse('invalid-context', 'Invalid parent clock sample')
    const deadline = boundedDeadline(p.clock, now, p.limit, p.existingParent?.deadline)
    return deadline.ok ? ok(Object.freeze({ deadline: deadline.value,
      domainId: p.clock.domainId, sampledAtMs: now })) : deadline
  } catch {
    return refuse('invalid-context', 'Root clock failed')
  }
}

type Limiter = {
  id: string; deadline: AbsoluteDeadline; controller: AbortController
  timer?: unknown; timerArmed: boolean; parent?: Limiter
}
type Owner = { id: string; description: Parameters<HostAuthority['registerOwner']>[0]['description'];
  lifetime: Limiter; receiver: ReceiverCapability }
type Budget = Limiter & { owner: Owner; correlation: Correlation; root: Budget;
  children: Map<string, Budget>; registrationKey?: string }
type Request = { id: string; budget: Budget; controller: AbortController; maintenanceResource?: Resource }
type Destination = { id: string; snapshotId: string; origin: string;
  resolved: Parameters<HostAuthority['registerDestination']>[0]['resolved'] }
type Delegation = { id: string; destination: Destination; snapshotId: string; origin: string;
  purpose: string; lifetime: Limiter; values: Readonly<Record<string, string>>; owners: Set<Owner> }
type Resource = {
  id: string; generation: string; generationNumber: number; owner: Owner; lifetime: Limiter
  destination: Destination; target: TargetDescription; env: Readonly<Record<string, string>>
  delegation?: Delegation; profile: ProfileFacts; compatibility: string
  reuse: 'none' | 'exact-host-scope-lifetime-owner'
  restartPolicy: Parameters<HostAuthority['registerResource']>[0]['restartPolicy']
  restartAttempts: number; correlation?: Correlation; originalBudget?: Budget
  transferId: string | null; current: boolean; controller: AbortController; stopCommitted: boolean
  unlinkOwner?: () => void; unlinkExtraSignal?: () => void; extraSignal?: AbortSignal; leases: Set<Lease>
  observed?: { id: string; launch: Launch }; launch?: Launch
}
type Lease = { id: string; request: Request; resource: Resource; owner: Owner;
  generation: string; released: boolean; unlink?: () => void }
type Launch = {
  id: string; request: Request; budget: Budget; resource: Resource; lease: Lease
  correlation: Correlation
  generation: string; binding: AuthorityBindingV2; bindingDigest: string
  classification: TargetClassification; capturedDeadlines: DeadlineFacts
  stage: 'planned' | 'admitting' | 'admitted' | 'dispatched' | 'failed'
  permit?: TargetPermit; consumed: boolean; observed: boolean; failedBeforeStart: boolean
  nativeTransport?: NativePlanIdentity & { pid: number }
  nativeReady?: NativePreparedObservation
  nativeEntryCommitted?: boolean
}
type Permit = { launch: Launch; consumed: boolean }
type Use = { request: Request; resource: Resource; lease: Lease; generation: string;
  operationDigest: string; launch: Launch; consumed: boolean }
type Offer = { resource: Resource; sender: Owner; receiver: Owner; generation: string;
  request: Request; consumed: boolean }
type Transfer = { offer: Offer; consumed: boolean }

export function createHostAuthority(inputs: HostAuthorityInputs): HostAuthority {
  if (!plain(inputs.configuration) || !nonempty(inputs.configuration.snapshotId) ||
    !nonempty(inputs.configuration.rosterId) || !nonempty(inputs.configuration.trustPolicyId) ||
    !Array.isArray(inputs.configuration.canonicalCredentialNames) ||
    !Array.isArray(inputs.configuration.configuredCredentialNames) ||
    typeof inputs.classifyTarget !== 'function' || typeof inputs.authorizeAsync !== 'function' ||
    typeof inputs.resolveProfile !== 'function' || typeof inputs.isCurrentBasis !== 'function' ||
    typeof inputs.record !== 'function' || !nonempty(inputs.clock.domainId) ||
    typeof inputs.scheduler.set !== 'function' || typeof inputs.scheduler.clear !== 'function')
    throw new Error('Invalid execution host inputs')
  const configuration = copy(inputs.configuration)
  const inheritance = copy(inputs.childInheritanceEnvironment)
  const overrides = copy(inputs.childOverrides)
  const platform = inputs.platform
  const inheritEnv = inputs.inheritEnv
  const clockDomain = inputs.clock.domainId
  const key = randomBytes(32)
  const keyEpochId = randomUUID()
  const hostContextId = randomUUID()
  const keyed = (tuple: unknown[]): string => createHmac('sha256', key).update(JSON.stringify(tuple)).digest('hex')
  const credentialKey = (name: string): string => platform === 'win32' ? name.toUpperCase() : name
  const credentialNames = new Set([...configuration.canonicalCredentialNames,
    ...configuration.configuredCredentialNames].map(name => {
      if (!nonempty(name) || /[=\0]/.test(name)) throw new Error('Invalid credential name')
      return credentialKey(name)
    }))
  const lifetimes = new WeakMap<object, Limiter>()
  const owners = new WeakMap<object, Owner>()
  const receivers = new WeakMap<object, Owner>()
  const budgets = new WeakMap<object, Budget>()
  const requests = new WeakMap<object, Request>()
  const destinations = new WeakMap<object, Destination>()
  const delegations = new WeakMap<object, Delegation>()
  const resources = new WeakMap<object, Resource>()
  const leases = new WeakMap<object, Lease>()
  const permits = new WeakMap<object, Permit>()
  const uses = new WeakMap<object, Use>()
  const offers = new WeakMap<object, Offer>()
  const transfers = new WeakMap<object, Transfer>()
  const actionPorts = new WeakMap<object, { request: Request; budget: Budget; owner: Owner }>()
  const prepared = new WeakMap<object, Launch>()
  const observers = new WeakMap<object, Launch>()
  const registeredActions = new Map<string, BudgetHandle>()
  const reusedResources = new Map<string, ResourceHandle>()
  let lastNow = -Infinity
  let poisoned = false
  const deadlineAbortReasons = new WeakSet<Error>()

  function registeredController(): AbortController {
    const controller = new AbortController()
    deadlineSignals.set(controller.signal, deadlineAbortReasons)
    return controller
  }

  function handle<T extends object, V>(map: WeakMap<object, V>, state: V): T {
    const value = Object.freeze(Object.create(null)) as T
    map.set(value, state)
    return value
  }

  function get<T>(map: WeakMap<object, T>, value: unknown): T | undefined {
    return value !== null && typeof value === 'object' ? map.get(value) : undefined
  }

  function sample(): Result<number> {
    try {
      const now = inputs.clock.nowMs()
      if (poisoned || inputs.clock.domainId !== clockDomain || !validNow(now) || now < lastNow) {
        poisoned = true
        return refuse('invalid-context', 'Host clock is invalid or moved backwards')
      }
      lastNow = now
      return ok(now)
    } catch {
      poisoned = true
      return refuse('invalid-context', 'Host clock failed')
    }
  }

  function link(signal: AbortSignal | undefined, controller: AbortController): () => void {
    if (!signal) return () => {}
    const abort = () => controller.abort(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    return () => signal.removeEventListener('abort', abort)
  }

  function arm(limiter: Limiter): void {
    const tick = () => {
      limiter.timerArmed = false
      if (limiter.controller.signal.aborted || limiter.deadline.kind === 'unbounded') return
      const now = sample()
      if (!now.ok) return
      const remaining = limiter.deadline.expiresAtMs - now.value
      if (remaining <= 0) {
        const reason = new Error('Execution deadline exhausted')
        deadlineAbortReasons.add(reason)
        limiter.controller.abort(reason)
        return
      }
      limiter.timer = inputs.scheduler.set(Math.min(Math.ceil(remaining), MAX_TIMER_MS), tick)
      limiter.timerArmed = true
    }
    limiter.controller.signal.addEventListener('abort', () => {
      if (limiter.timerArmed) inputs.scheduler.clear(limiter.timer)
      limiter.timerArmed = false
    }, { once: true })
    tick()
  }

  function limiter(deadline: AbsoluteDeadline, parent?: Limiter, signal?: AbortSignal): Limiter {
    const state: Limiter = { id: deadline.limitId, deadline, controller: registeredController(),
      timerArmed: false, parent }
    link(parent?.controller.signal, state.controller)
    link(signal, state.controller)
    arm(state)
    return state
  }

  function signalRefusal(signal: AbortSignal, cancelledCause: string): Refusal | undefined {
    if (!signal.aborted) return undefined
    // Linked requests retain the exact authority-created reason even when
    // their receiving owner has an independent, unbounded lifetime.
    return isExecutionDeadlineSignal(signal)
      ? refuse('deadline-exhausted', 'Execution deadline exhausted')
      : refuse('cancelled', cancelledCause)
  }

  function checkLimiter(state: Limiter, sampledNow?: number): Refusal | undefined {
    const now = sampledNow === undefined ? sample() : ok(sampledNow)
    if (!now.ok) return now
    if (expires(state.deadline) <= now.value) return refuse('deadline-exhausted', 'Execution deadline exhausted')
    return signalRefusal(state.controller.signal, 'Execution lifetime cancelled')
  }

  function getLimiter(value: unknown): Limiter | undefined {
    return get(lifetimes, value) ?? get(budgets, value)
  }

  function correlationTuple(correlation: Correlation): unknown[] {
    const p = correlation as Correlation & { actionId?: string; attemptId?: string; owner?: {
      clientSessionId: string; rootRunId: string; parentRunId: string; parentAgentId: string
    }; basisId?: string; observationId?: string; operationId?: string; hostContextId?: string; purpose?: string }
    return ['openbuff.correlation.v1', p.kind, p.actionId ?? null, p.attemptId ?? null,
      p.owner ? [p.owner.clientSessionId, p.owner.rootRunId, p.owner.parentRunId, p.owner.parentAgentId] : null,
      p.basisId ?? null, p.observationId ?? null, p.operationId ?? null, p.hostContextId ?? null, p.purpose ?? null]
  }

  function validCorrelation(p: Correlation, owner: Owner): boolean {
    if (!plain(p)) return false
    if (p.kind === 'action') {
      if (owner.description.kind !== 'run' || !nonempty(p.actionId) || !nonempty(p.attemptId) ||
        !nonempty(p.basisId) || !plain(p.owner)) return false
      const registeredOwner = owner.description.owner
      return ['clientSessionId', 'rootRunId', 'parentRunId', 'parentAgentId'].every(name =>
        nonempty(p.owner[name as keyof typeof p.owner]) &&
        p.owner[name as keyof typeof p.owner] === registeredOwner[name as keyof typeof p.owner])
    }
    return p.hostContextId === hostContextId && owner.description.kind === 'host' &&
      ((p.kind === 'host-observation' && p.purpose === 'repository-bootstrap' && nonempty(p.observationId)) ||
       (p.kind === 'host-operation' && p.purpose === 'direct-host-operation' && nonempty(p.operationId)))
  }

  function registerBudget(owner: Owner, parent: Limiter, correlation: Correlation, limit: Limit): Result<BudgetHandle> {
    const refusal = checkLimiter(parent) ?? checkLimiter(owner.lifetime)
    if (refusal) return refusal
    const now = sample()
    if (!now.ok) return now
    const deadline = boundedDeadline(inputs.clock, now.value, limit, parent.deadline)
    if (!deadline.ok) return deadline
    const base = limiter(deadline.value, parent)
    const budget = Object.assign(base, { owner, correlation: copy(correlation), children: new Map<string, Budget>() }) as Budget
    budget.root = budget
    return ok(handle<BudgetHandle, Budget>(budgets, budget))
  }

  function validTarget(target: TargetDescription): boolean {
    if (!plain(target) || !nonempty(target.executable) || /\0/.test(target.executable) ||
      !Array.isArray(target.argv) || target.argv.some(arg => typeof arg !== 'string' || /\0/.test(arg)) ||
      !nonempty(target.cwd) || !nonempty(target.projectRoot) || !Array.isArray(target.allowedPaths) ||
      target.allowedPaths.some(p => !nonempty(p) || /\0/.test(p)) || /\0/.test(target.cwd + target.projectRoot) ||
      !['assistant', 'user'].includes(target.mode) || !['SYNC', 'BACKGROUND'].includes(target.processType) ||
      !families.has(target.family) || !nonempty(target.branchId) || !plain(target.profile) ||
      !policies.has(target.profile.policy) || !['portable-ts', 'native-exec'].includes(target.profile.preferredBackend) ||
      Object.keys(target.profile).some(key => !['policy', 'preferredBackend', 'required', 'optional', 'allowBackendFallback'].includes(key)) ||
      !Array.isArray(target.profile.required) || target.profile.required.some(value => !capabilities.has(value)) ||
      new Set(target.profile.required).size !== target.profile.required.length ||
      (target.profile.optional !== undefined && (!Array.isArray(target.profile.optional) ||
        target.profile.optional.some(value => !capabilities.has(value) || target.profile.required.includes(value)) ||
        new Set(target.profile.optional).size !== target.profile.optional.length)) ||
      typeof target.profile.allowBackendFallback !== 'boolean' || !plain(target.adapterOptions) ||
      !['node', 'bun', 'spawn-sync'].includes(String(target.adapterOptions.runtime))) return false
    if (target.shellCommandBytes !== undefined && (typeof target.shellCommandBytes !== 'string' || /\0/.test(target.shellCommandBytes))) return false
    if (Object.keys(target).some(key => !['executable', 'argv', 'shellCommandBytes', 'cwd', 'projectRoot', 'allowedPaths',
      'mode', 'processType', 'profile', 'family', 'branchId', 'environmentOverlay', 'delegation', 'adapterOptions'].includes(key))) return false
    return Object.values(target.adapterOptions).every(value => value === null || typeof value === 'string' ||
      typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
  }

  function captureClassification(target: TargetDescription): Result<TargetClassification> {
    const captured: CapturedExecutable = copy(target.shellCommandBytes === undefined
      ? { kind: 'argv', executable: target.executable, argv: target.argv }
      : { kind: 'shell', executable: target.executable, argv: target.argv, shellCommandBytes: target.shellCommandBytes })
    try {
      const value = inputs.classifyTarget(captured)
      if (thenable(value) || !plain(value) || value.format !== 'openbuff.target-classification.v1' ||
        !nonempty(value.classifierVersion) || value.invocationKind !== captured.kind ||
        !['complete', 'unsupported', 'malformed'].includes(value.parseStatus) ||
        !Array.isArray(value.effects) || (value.parseStatus === 'complete' ? value.parseReason !== null : !nonempty(value.parseReason)) ||
        value.effects.some(effect => !plain(effect) || typeof effect.action !== 'string' || !actions.has(effect.action) || typeof effect.target !== 'string' ||
          (effect.branch !== undefined && typeof effect.branch !== 'string') ||
          (effect.pushRisks !== undefined && (!Array.isArray(effect.pushRisks) || effect.pushRisks.some(risk => !risks.has(risk))))))
        return refuse('invalid-context', 'Classifier returned an invalid exact-target snapshot')
      return ok(copy(value))
    } catch {
      return refuse('unavailable', 'Exact target classification unavailable')
    }
  }

  function captureProfile(target: TargetDescription): Result<ProfileFacts> {
    try {
      const profile = inputs.resolveProfile(copy(target.profile), copy(target))
      if (thenable(profile) || !plain(profile) || !Array.isArray(profile.available) || !Array.isArray(profile.enforced) ||
        JSON.stringify(profile.requested) !== JSON.stringify(target.profile) || profile.active !== null ||
        profile.available.some(backend => !nonempty(backend.backend) || !nonempty(backend.generation) ||
          !Array.isArray(backend.capabilities) || backend.capabilities.some((c: unknown) => typeof c !== 'string' || !capabilities.has(c)) || !Array.isArray(backend.unavailableReasons)) ||
        profile.enforced.some(item => !capabilities.has(item.capability) || !['not-requested', 'not-enforced', 'unknown', 'enforced'].includes(item.status) ||
          (item.status === 'enforced' && !nonempty(item.evidenceId))))
        return refuse('invalid-context', 'Invalid profile capability resolution')
      if (profile.selected !== null) {
        const selected = profile.selected
        const backend = profile.available.find(value => value.backend === selected.backend && value.generation === selected.generation)
        if (!backend || selected.policy !== target.profile.policy || !['cooperative', 'os-scoped', 'unavailable'].includes(selected.cancellation) ||
          target.profile.required.some(capability => !backend.capabilities.includes(capability)))
          return refuse('invalid-context', 'Selected backend cannot satisfy the captured profile')
        if (selected.backend === 'native-exec' && (target.adapterOptions.runtime !== 'node' ||
          target.adapterOptions.nativeAdapter !== 'openbuff.exec.v1' ||
          typeof target.adapterOptions.nativeArtifactSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(target.adapterOptions.nativeArtifactSha256)))
          return refuse('invalid-context', 'Native selection requires a captured native adapter and artifact')
        if (!target.profile.allowBackendFallback && selected.backend !== target.profile.preferredBackend)
          return refuse('invalid-context', 'Backend fallback was not selected')
      }
      return ok(copy(profile))
    } catch {
      return refuse('unavailable', 'Requested execution profile unavailable')
    }
  }

  function mergeEnvironment(target: TargetDescription, destination: Destination, owner: Owner,
    lifetime: Limiter): Result<{ env: Readonly<Record<string, string>>; delegation?: Delegation }> {
    const result: Record<string, string> = Object.create(null)
    const originalCase = new Map<string, string>()
    const merge = (map: Readonly<Record<string, string | undefined>> | undefined): boolean => {
      if (map === undefined) return true
      if (!plain(map)) return false
      for (const [name, value] of Object.entries(map)) {
        if (!nonempty(name) || /[=\0]/.test(name) || (value !== undefined && (typeof value !== 'string' || /\0/.test(value)))) return false
        const normalized = credentialKey(name)
        const earlier = originalCase.get(normalized)
        if (platform === 'win32' && earlier !== undefined && earlier !== name) return false
        originalCase.set(normalized, name)
        if (value === undefined) delete result[name]
        else result[name] = value
      }
      return true
    }
    if ((inheritEnv && !merge(inheritance)) || !merge(overrides) || !merge(target.environmentOverlay))
      return refuse('invalid-context', 'Invalid exact child environment')
    for (const name of Object.keys(result)) if (credentialNames.has(credentialKey(name))) delete result[name]
    const delegation = target.delegation === undefined ? undefined : get(delegations, target.delegation)
    if (target.delegation !== undefined && (!delegation || delegation.destination !== destination ||
      delegation.snapshotId !== configuration.snapshotId || !delegation.owners.has(owner)))
      return refuse('stale-authority', 'Credential delegation does not match the destination and owner')
    if (delegation) {
      const failure = checkLimiter(delegation.lifetime)
      if (failure) return failure
      if (expires(lifetime.deadline) > expires(delegation.lifetime.deadline))
        return refuse('invalid-context', 'Resource outlives its credential delegation')
      if (!merge(delegation.values)) return refuse('invalid-context', 'Invalid credential delegation environment')
    }
    return ok({ env: Object.freeze(result), delegation })
  }

  function checkRequest(request: Request, sampledNow?: number): Refusal | undefined {
    return checkLimiter(request.budget, sampledNow) ?? checkLimiter(request.budget.owner.lifetime, sampledNow) ??
      signalRefusal(request.controller.signal, 'Execution request cancelled')
  }

  function checkResource(resource: Resource, sampledNow?: number): Refusal | undefined {
    if (!resource.current) return refuse('stale-authority', 'Resource generation is stale')
    return checkLimiter(resource.lifetime, sampledNow) ?? checkLimiter(resource.owner.lifetime, sampledNow) ??
      signalRefusal(resource.controller.signal, 'Execution resource cancelled') ??
      (resource.delegation ? checkLimiter(resource.delegation.lifetime, sampledNow) : undefined)
  }

  function checkTransferLifecycle(resource: Resource): Refusal | undefined {
    if (resource.stopCommitted) return refuse('stale-authority', 'Physical resource cleanup is committed')
    if (resource.launch?.consumed && !resource.observed)
      return refuse('stale-authority', 'Dispatched resource start is not yet observed')
    return undefined
  }

  function checkLease(lease: Lease, sampledNow?: number): Refusal | undefined {
    const requestFailure = checkRequest(lease.request, sampledNow)
    if (requestFailure) return requestFailure
    if (lease.released || lease.generation !== lease.resource.generation || lease.owner !== lease.resource.owner)
      return refuse('stale-authority', 'Request lease is released or stale')
    return checkResource(lease.resource, sampledNow)
  }

  function checkLaunchState(launch: Launch, sampledNow?: number): Refusal | undefined {
    const now = sampledNow === undefined ? sample() : ok(sampledNow)
    if (!now.ok) return now
    if (launch.resource.generation !== launch.generation || launch.resource.launch !== launch)
      return refuse('stale-authority', 'Prepared launch generation is stale')
    return checkLease(launch.lease, now.value) ?? checkLimiter(launch.budget, now.value)
  }

  function checkLaunch(launch: Launch): Refusal | undefined {
    // Host callbacks can cancel a request or consume its remaining time.
    return checkLaunchState(launch) ?? checkBasisAndProfile(launch) ?? checkLaunchState(launch)
  }

  function checkBasisAndProfile(launch: Launch): Refusal | undefined {
    try {
      if (!inputs.isCurrentBasis(launch.correlation)) return refuse('stale-authority', 'Action basis changed')
      const current = captureProfile(launch.resource.target)
      if (!current.ok) return current
      if (JSON.stringify(current.value.selected) !== JSON.stringify(launch.resource.profile.selected))
        return refuse('stale-authority', 'Selected backend generation changed')
    } catch {
      return refuse('unavailable', 'Action basis unavailable')
    }
    if (!launch.resource.profile.selected) return refuse('unavailable', 'Required execution backend unavailable')
    return undefined
  }

  function checkUseState(launch: Launch): Refusal | undefined {
    const now = sample()
    if (!now.ok) return now
    if (!launch.resource.observed || launch.resource.observed.launch.stage === 'failed')
      return refuse('stale-authority', 'Resource no longer has a usable process observation')
    return checkLease(launch.lease, now.value)
  }

  function checkUse(launch: Launch): Refusal | undefined {
    return checkUseState(launch) ?? checkBasisAndProfile(launch) ?? checkUseState(launch)
  }

  async function awaitDecision(launch: Launch): Promise<unknown> {
    const requestSignal = launch.request.controller.signal
    const resourceSignal = launch.resource.controller.signal
    if (requestSignal.aborted || resourceSignal.aborted)
      return checkRequest(launch.request) ?? checkResource(launch.resource) ??
        refuse('cancelled', 'Execution admission cancelled')
    return new Promise(resolve => {
      let settled = false
      const finish = (value: unknown) => {
        if (settled) return
        settled = true
        requestSignal.removeEventListener('abort', abort)
        resourceSignal.removeEventListener('abort', abort)
        resolve(value)
      }
      const abort = () => finish(checkRequest(launch.request) ?? checkResource(launch.resource) ??
        refuse('cancelled', 'Execution admission cancelled'))
      requestSignal.addEventListener('abort', abort, { once: true })
      resourceSignal.addEventListener('abort', abort, { once: true })
      try {
        Promise.resolve(inputs.authorizeAsync(policyInput(launch))).then(finish,
          () => finish(refuse('unavailable', 'Execution authorizer unavailable')))
      } catch {
        finish(refuse('unavailable', 'Execution authorizer unavailable'))
      }
    })
  }

  function deadlineFacts(launch: Launch): DeadlineFacts {
    return launch.capturedDeadlines
  }

  function bindingFor(launch: Omit<Launch, 'binding' | 'bindingDigest'>): AuthorityBindingV2 {
    const resource = launch.resource, target = resource.target, c = launch.classification
    const selected = resource.profile.selected
    const environmentPairs = Object.entries(resource.env).map(([name, value]) => [credentialKey(name), value]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    const delegation = resource.delegation
    const facts = launch.capturedDeadlines
    return copy({
      format: 'openbuff.execution.v2', keyEpochId,
      commandHash: createHash('sha256').update(target.shellCommandBytes === undefined
        ? JSON.stringify(['openbuff.argv-command.v1', target.executable, target.argv]) : target.shellCommandBytes).digest('hex'),
      executableArgvDigest: keyed(['openbuff.executable.v1', c.invocationKind, target.executable, target.argv, target.shellCommandBytes ?? null]),
      effectRosterDigest: keyed(['openbuff.classification.v1', c.invocationKind, c.classifierVersion, c.parseStatus, c.parseReason,
        c.effects.map(effect => [effect.action, effect.target, effect.branch ?? null, effect.pushRisks ?? null])]),
      parseStatus: c.parseStatus, hostContextId, configurationSnapshotId: configuration.snapshotId,
      correlationDigest: keyed(correlationTuple(launch.correlation)), cwd: target.cwd,
      projectRoot: target.projectRoot, allowedPaths: target.allowedPaths,
      profileRequestDigest: keyed(target.profile.optional === undefined
        ? ['openbuff.profile-request.v1', target.profile.policy, target.profile.preferredBackend,
          target.profile.required, target.profile.allowBackendFallback]
        : ['openbuff.profile-request.v2', target.profile.policy, target.profile.preferredBackend,
          target.profile.required, target.profile.optional, target.profile.allowBackendFallback]),
      selectedBackendDigest: keyed(selected ? ['openbuff.backend.v1', selected.backend, selected.generation, selected.policy, selected.cancellation]
        : ['openbuff.backend.v1', null]),
      environmentDigest: keyed(['openbuff.env.v1', platform === 'win32' ? 'case-insensitive' : 'case-sensitive', environmentPairs]),
      credentialRosterId: configuration.rosterId, destinationId: resource.destination.id,
      delegationDigest: keyed(['openbuff.delegations.v1', delegation ? [[delegation.id, delegation.destination.id,
        delegation.snapshotId, delegation.origin, delegation.purpose, deadlineTuple(delegation.lifetime.deadline),
        Object.keys(delegation.values).sort(), [...delegation.owners].map(owner => owner.id).sort()]] : []]),
      requestId: launch.request.id, resourceId: resource.id, resourceGeneration: resource.generation,
      ownerId: resource.owner.id, leaseId: launch.lease.id, processType: target.processType, mode: target.mode,
      detachTransferId: resource.transferId,
      deadlinesDigest: keyed(['openbuff.deadlines.v1', deadlineTuple(facts.action), deadlineTuple(facts.requestAdmission), deadlineTuple(facts.resourceLifetime)]),
      adapterOptionsDigest: keyed(['openbuff.adapter-options.v1', Object.entries(target.adapterOptions).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([name, value]) => [name, value === null ? 'null' : typeof value, value])]), launchId: launch.id,
    })
  }

  function facts(launch: Launch): LaunchFacts {
    const resource = launch.resource
    return copy({ hostContextId, configurationSnapshotId: configuration.snapshotId, launchId: launch.id,
      branchId: resource.target.branchId, family: resource.target.family, correlation: launch.correlation,
      requestId: launch.request.id, resourceId: resource.id, resourceGeneration: launch.generation,
      leaseId: launch.lease.id, ownerId: launch.binding.ownerId, destinationId: launch.binding.destinationId,
      environment: { format: 'openbuff.env.v1', keyEpochId, keyedDigest: launch.binding.environmentDigest,
        inherited: inheritEnv, entryCount: Object.keys(resource.env).length, rosterId: configuration.rosterId,
        delegationIds: resource.delegation ? [resource.delegation.id] : [] },
      deadlines: deadlineFacts(launch), profile: { ...resource.profile,
        ...(launch.observed && launch.nativeReady ? { enforced: launch.nativeReady.enforced } : {}),
        active: launch.observed ? resource.profile.selected : null },
      executionBindingVersion: 2, executionBindingDigest: launch.bindingDigest })
  }

  function emit(event: LaunchEvent): void {
    try { inputs.record(copy(event)) }
    catch { poisoned = true }
  }

  function policyInput(launch: Launch): PolicyInput {
    return Object.freeze({ target: launch.resource.target, binding: launch.binding, bindingDigest: launch.bindingDigest,
      classification: launch.classification, facts: facts(launch) })
  }

  function noLaunch(launch: Launch, refusal: Refusal): Refusal {
    emit({ phase: 'no-launch', facts: facts(launch), refusal })
    return refusal
  }

  function issue(launch: Launch, decision: unknown, synchronous: boolean): Admission {
    if (thenable(decision) || !plain(decision) || typeof decision.ok !== 'boolean')
      return noLaunch(launch, refuse('unavailable', 'Execution policy returned no usable decision'))
    if (!decision.ok) {
      if (!['denied', 'unavailable', 'cancelled', 'deadline-exhausted', 'invalid-context', 'stale-authority', 'already-consumed'].includes(String(decision.reason)) ||
        typeof decision.cause !== 'string') return noLaunch(launch, refuse('unavailable', 'Invalid execution refusal'))
      return noLaunch(launch, copy(decision) as Refusal)
    }
    if (!nonempty(decision.decisionId) || !(synchronous ? decision.basis === 'explicit-sync-policy' :
      ['explicit-policy', 'exact-action-approval'].includes(String(decision.basis))))
      return noLaunch(launch, refuse('unavailable', 'Execution policy did not supply explicit authority'))
    const failure = checkLaunch(launch)
    if (failure) return noLaunch(launch, failure)
    const permit = handle<TargetPermit, Permit>(permits, { launch, consumed: false })
    launch.stage = 'admitted'
    launch.permit = permit
    emit({ phase: 'admitted', facts: facts(launch), decisionId: decision.decisionId })
    return ok({ permit, decisionId: decision.decisionId })
  }

  function failDispatch(launch: Launch, cause: string): void {
    launch.stage = 'failed'
    launch.failedBeforeStart = !launch.observed
    emit({ phase: 'dispatch-failed', facts: facts(launch), processStart: launch.observed ? 'observed' : 'not-observed', cause })
  }

  function nativeIdentity(value: unknown): value is NativePlanIdentity {
    return plain(value) && typeof value.planDigest === 'string' && /^[a-f0-9]{64}$/.test(value.planDigest) &&
      typeof value.artifactSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.artifactSha256) &&
      nonempty(value.nonce) && value.nonce.length <= 256 && !value.nonce.includes('\0')
  }

  function sameNativeIdentity(left: NativePlanIdentity, right: NativePlanIdentity): boolean {
    return left.planDigest === right.planDigest && left.nonce === right.nonce &&
      left.artifactSha256 === right.artifactSha256
  }

  function nativeLaunchFailure(launch: Launch): Refusal | undefined {
    if (launch.resource.profile.selected?.backend !== 'native-exec' ||
      launch.resource.target.adapterOptions.runtime !== 'node' ||
      launch.resource.target.adapterOptions.nativeAdapter !== 'openbuff.exec.v1')
      return refuse('invalid-context', 'Native observer requires a captured native dispatch')
    if (!launch.consumed || launch.stage !== 'dispatched' || launch.observed || launch.failedBeforeStart)
      return refuse('stale-authority', 'Native setup observation is out of order')
    if (launch.resource.stopCommitted)
      return refuse('stale-authority', 'Physical resource cleanup is committed')
    return checkLaunch(launch)
  }

  function observerFor(launch: Launch): LaunchObserver {
    const observer: LaunchObserver = {
      nativeTransportObserved(observation) {
        if (get(observers, this) !== launch) return refuse('stale-authority', 'Invalid native observer receiver')
        const failure = nativeLaunchFailure(launch)
        if (failure) return failure
        if (launch.nativeTransport || !nativeIdentity(observation) || observation.source !== 'native-monitor-spawn' ||
          !Number.isSafeInteger(observation.pid) || observation.pid <= 0 ||
          observation.artifactSha256 !== launch.resource.target.adapterOptions.nativeArtifactSha256)
          return refuse('invalid-context', 'Invalid or repeated native transport identity')
        launch.nativeTransport = copy({ planDigest: observation.planDigest, nonce: observation.nonce,
          artifactSha256: observation.artifactSha256, pid: observation.pid })
        emit({ phase: 'native-transport-observed', facts: facts(launch),
          transportObservationId: randomUUID(), pid: observation.pid })
        return ok(undefined)
      },
      nativePrepared(observation) {
        if (get(observers, this) !== launch) return refuse('stale-authority', 'Invalid native observer receiver')
        const failure = nativeLaunchFailure(launch)
        if (failure) return failure
        if (!launch.nativeTransport || launch.nativeReady || launch.nativeEntryCommitted ||
          !nativeIdentity(observation) || observation.source !== 'native-adapter-ready' ||
          !sameNativeIdentity(observation, launch.nativeTransport) || !nonempty(observation.scopeId) ||
          observation.scopeId.length > 256 || observation.scopeId.includes('\0') || !Array.isArray(observation.enforced))
          return refuse('invalid-context', 'Invalid native prepared identity or order')
        const selected = launch.resource.profile.selected!
        const backend = launch.resource.profile.available.find(value => value.backend === selected.backend &&
          value.generation === selected.generation)!
        const seen = new Set<string>()
        for (const mechanism of observation.enforced) {
          if (!plain(mechanism) || typeof mechanism.capability !== 'string' ||
            !capabilities.has(mechanism.capability) || seen.has(mechanism.capability) ||
            typeof mechanism.status !== 'string' ||
            !['not-requested', 'not-enforced', 'unknown', 'enforced'].includes(mechanism.status) ||
            (mechanism.status === 'enforced' && (!nonempty(mechanism.evidenceId) ||
              !backend.capabilities.includes(mechanism.capability as Capability))))
            return refuse('invalid-context', 'Invalid native mechanism observation')
          seen.add(mechanism.capability)
        }
        const enforced = (capability: string) => observation.enforced.some(value =>
          value.capability === capability && value.status === 'enforced')
        if (launch.resource.target.profile.required.some(capability => !enforced(capability)) ||
          (selected.cancellation === 'os-scoped' && !enforced('process-tree-containment')))
          return refuse('unavailable', 'Native setup did not enforce the selected required capabilities')
        launch.nativeReady = copy(observation)
        emit({ phase: 'native-prepared', facts: facts(launch) })
        return ok(undefined)
      },
      commitNativeTargetEntry(identity) {
        if (get(observers, this) !== launch) return refuse('stale-authority', 'Invalid native observer receiver')
        const failure = nativeLaunchFailure(launch)
        if (failure) return failure
        if (!launch.nativeReady || launch.nativeEntryCommitted || !nativeIdentity(identity) ||
          !sameNativeIdentity(identity, launch.nativeReady))
          return refuse('stale-authority', 'Native entry requires one matching prepared identity')
        const now = sample()
        if (!now.ok) return now
        const interrupted = checkLaunchState(launch, now.value)
        if (interrupted || launch.resource.stopCommitted)
          return interrupted ?? refuse('stale-authority', 'Physical resource cleanup is committed')
        launch.nativeEntryCommitted = true
        emit({ phase: 'native-entry-committed', facts: facts(launch) })
        // An event callback can cancel, consume time or invalidate the basis.
        const afterRecord = checkLaunch(launch)
        if (afterRecord || launch.resource.stopCommitted) {
          const refusal = afterRecord ?? refuse('stale-authority', 'Physical resource cleanup is committed')
          failDispatch(launch, refusal.cause)
          return refusal
        }
        const committedAt = sample()
        if (!committedAt.ok) { failDispatch(launch, committedAt.cause); return committedAt }
        const lastCheck = checkLaunchState(launch, committedAt.value)
        if (lastCheck) { failDispatch(launch, lastCheck.cause); return lastCheck }
        return ok(copy({ planDigest: identity.planDigest, nonce: identity.nonce,
          artifactSha256: identity.artifactSha256,
          resourceRemainingMs: launch.resource.lifetime.deadline.kind === 'finite'
            ? launch.resource.lifetime.deadline.expiresAtMs - committedAt.value : null,
          facts: facts(launch) }))
      },
      nativeTargetEntered(observation) {
        if (get(observers, this) !== launch) return refuse('stale-authority', 'Invalid native observer receiver')
        if (!launch.nativeEntryCommitted || !launch.nativeReady || launch.observed || launch.stage !== 'dispatched' ||
          !launch.resource.current || launch.resource.generation !== launch.generation || launch.resource.launch !== launch)
          return refuse('stale-authority', 'Native target observation is out of order or stale')
        if (!nativeIdentity(observation) || observation.source !== 'native-adapter-exec-status' ||
          !sameNativeIdentity(observation, launch.nativeReady) || observation.scopeId !== launch.nativeReady.scopeId ||
          !Number.isSafeInteger(observation.pid) || observation.pid <= 0)
          return refuse('invalid-context', 'Invalid native target entry identity')
        // Entry is a physical observation. Cancellation after the commit cannot
        // erase a real start, but it still prevents success and resource reuse.
        launch.observed = true
        const processObservationId = randomUUID()
        launch.resource.observed = { id: processObservationId, launch }
        emit({ phase: 'spawn-observed', facts: facts(launch), processObservationId, pid: observation.pid })
        const failure = checkLaunch(launch) ?? (launch.resource.stopCommitted
          ? refuse('stale-authority', 'Physical resource cleanup is committed') : undefined)
        if (failure) { failDispatch(launch, failure.cause); return failure }
        return ok({ processObservationId })
      },
      cleanupCommitted() {
        if (get(observers, this) !== launch || !launch.consumed || !launch.resource.current ||
          (launch.resource.launch !== launch && launch.resource.observed?.launch !== launch))
          return refuse('stale-authority', 'Invalid physical cleanup observer')
        launch.resource.stopCommitted = true
        return ok(undefined)
      },
      spawnObserved(observation) {
        if (get(observers, this) !== launch) return refuse('stale-authority', 'Invalid observer receiver')
        if (!launch.resource.current || launch.resource.generation !== launch.generation || launch.resource.launch !== launch)
          return refuse('stale-authority', 'Observer resource generation is stale')
        if (launch.stage !== 'dispatched' || launch.observed || launch.failedBeforeStart)
          return refuse('stale-authority', 'Process start observation is out of order')
        if (launch.resource.profile.selected?.backend === 'native-exec')
          return refuse('invalid-context', 'Native target entry requires its authenticated native observer')
        const expected = launch.resource.target.adapterOptions.runtime === 'node' ? 'node-spawn-event' :
          launch.resource.target.adapterOptions.runtime === 'bun' ? 'bun-spawn-result' : 'spawn-sync-result'
        if (observation.source !== expected || !Number.isSafeInteger(observation.pid) || observation.pid <= 0)
          return refuse('invalid-context', 'Invalid runtime process observation')
        launch.observed = true
        const processObservationId = randomUUID()
        launch.resource.observed = { id: processObservationId, launch }
        emit({ phase: 'spawn-observed', facts: facts(launch), processObservationId, pid: observation.pid })
        return ok({ processObservationId })
      },
      failure(observation) {
        if (get(observers, this) !== launch || !launch.resource.current || launch.resource.generation !== launch.generation ||
          launch.resource.launch !== launch || (launch.stage !== 'dispatched' && !(launch.stage === 'failed' && launch.observed)))
          return refuse('stale-authority', 'Invalid or stale failure observer')
        const expected = launch.resource.target.adapterOptions.runtime === 'node' ? 'node-error-event' :
          launch.resource.target.adapterOptions.runtime === 'bun' ? 'bun-spawn-error' : 'spawn-sync-error'
        if ((observation.source !== expected && observation.source !== 'adapter-observation-error') ||
          typeof observation.cause !== 'string' || (observation.errorCode !== undefined && typeof observation.errorCode !== 'string'))
          return refuse('invalid-context', 'Invalid runtime failure observation')
        failDispatch(launch, observation.cause)
        return ok(undefined)
      },
    }
    observers.set(observer, launch)
    return Object.freeze(observer)
  }

  function preparedFor(launch: Launch): PreparedLaunch {
    const result: PreparedLaunch = {
      facts() {
        if (get(prepared, this) !== launch) throw new Error('Invalid prepared launch receiver')
        return facts(launch)
      },
      async admit() {
        if (get(prepared, this) !== launch) return refuse('stale-authority', 'Invalid prepared launch receiver')
        if (launch.stage !== 'planned') return refuse('already-consumed', 'Launch admission already requested')
        const failure = checkLaunch(launch)
        if (failure) return noLaunch(launch, failure)
        launch.stage = 'admitting'
        try {
          const decision = await awaitDecision(launch)
          return issue(launch, decision, false)
        } catch {
          return noLaunch(launch, refuse('unavailable', 'Execution authorizer unavailable'))
        } finally {
          if (launch.stage === 'admitting') launch.stage = 'failed'
        }
      },
      admitSync() {
        if (get(prepared, this) !== launch) return refuse('stale-authority', 'Invalid prepared launch receiver')
        if (launch.stage !== 'planned') return refuse('already-consumed', 'Launch admission already requested')
        const failure = checkLaunch(launch)
        if (failure) return noLaunch(launch, failure)
        if (!inputs.authorizeSync) return noLaunch(launch, refuse('unavailable', 'Synchronous execution policy unavailable'))
        if (launch.resource.target.profile.required.includes('cooperative-cancellation') &&
          launch.resource.target.adapterOptions.runtime === 'spawn-sync')
          return noLaunch(launch, refuse('unavailable', 'Synchronous runtime cannot provide cooperative cancellation'))
        launch.stage = 'admitting'
        try { return issue(launch, inputs.authorizeSync(policyInput(launch)), true) }
        catch { return noLaunch(launch, refuse('unavailable', 'Synchronous authorizer unavailable')) }
        finally { if (launch.stage === 'admitting') launch.stage = 'failed' }
      },
      dispatchNow(permit, spawnNow) {
        if (get(prepared, this) !== launch) return refuse('stale-authority', 'Invalid prepared launch receiver')
        const authority = get(permits, permit)
        if (!authority || authority.launch !== launch || launch.permit !== permit)
          return noLaunch(launch, refuse('stale-authority', 'Invalid target permit'))
        if (authority.consumed || launch.consumed || launch.stage !== 'admitted')
          return refuse('already-consumed', 'Target dispatch authority was already consumed')
        // Reserve before invoking host callbacks, which may reenter dispatch.
        authority.consumed = true
        launch.consumed = true
        const failure = checkLaunch(launch)
        if (failure) return noLaunch(launch, failure)
        launch.stage = 'dispatched'
        emit({ phase: 'dispatched', facts: facts(launch) })
        const now = sample()
        if (!now.ok) {
          failDispatch(launch, now.cause)
          return now
        }
        const interrupted = checkLaunchState(launch, now.value)
        if (interrupted) {
          failDispatch(launch, interrupted.cause)
          return interrupted
        }
        const resource = launch.resource
        const remaining = resource.lifetime.deadline.kind === 'finite'
          ? resource.lifetime.deadline.expiresAtMs - now.value : null
        const exact: ExactLaunchInput = Object.freeze({ executable: resource.target.executable,
          argv: resource.target.argv, cwd: resource.target.cwd, env: resource.env,
          resourceSignal: resource.controller.signal, resourceRemainingMs: remaining,
          deadlines: deadlineFacts(launch), adapterOptions: resource.target.adapterOptions })
        const observer = observerFor(launch)
        try {
          if (poisoned) throw new Error('Execution event recorder unavailable')
          const child = spawnNow(exact, observer)
          if (thenable(child)) throw new Error('Dispatch callback must return synchronously')
          return ok({ phase: 'dispatched' as const, handle: child, facts: facts(launch), observer })
        } catch (error) {
          const cause = error instanceof Error ? error.message : 'Execution dispatch failed'
          failDispatch(launch, cause)
          return { ok: false, reason: 'dispatch-failed', cause, facts: facts(launch) }
        }
      },
    }
    prepared.set(result, launch)
    return Object.freeze(result)
  }

  function boundPort(request: Request, budget: Budget, owner: Owner): ActionExecutionPort {
    const port: ActionExecutionPort = {
      get signal() {
        if (get(actionPorts, this)?.request !== request) throw new Error('Invalid action port receiver')
        return request.controller.signal
      },
      derive(p) {
        const receiver = get(actionPorts, this)
        if (receiver?.request !== request || receiver.budget !== budget || receiver.owner !== owner)
          return refuse('stale-authority', 'Invalid action port receiver')
        const failure = checkRequest(request)
        if (failure) return failure
        const parentHandle = handle<BudgetHandle, Budget>(budgets, budget)
        const child = authority.deriveBudget({ parent: parentHandle, memoKey: p.memoKey, limit: p.limit })
        if (!child.ok) return child
        const derived = get(budgets, child.value)!
        const requestHandle = authority.registerRequest({ budget: child.value, signal: request.controller.signal })
        if (!requestHandle.ok) return requestHandle
        return ok(boundPort(get(requests, requestHandle.value)!, derived, owner))
      },
      prepareTarget(p) {
        if (get(actionPorts, this)?.request !== request) return refuse('stale-authority', 'Invalid action port receiver')
        const failure = checkRequest(request)
        if (failure) return failure
        const ownerHandle = handle<OwnerHandle, Owner>(owners, owner)
        const budgetHandle = handle<BudgetHandle, Budget>(budgets, budget)
        let destination = p.destination
        if (!destination) {
          const created = authority.registerDestination({ snapshotId: configuration.snapshotId, origin: 'host',
            resolved: { kind: 'executable', command: p.target.executable, args: p.target.argv, declaredEnv: {} } })
          if (!created.ok) return created
          destination = created.value
        }
        const resource = authority.registerResource({ owner: ownerHandle, lifetime: budgetHandle,
          destination, launchTemplate: p.target, resourceSignal: request.controller.signal,
          reuse: 'none', restartPolicy: { kind: 'none' } })
        if (!resource.ok) return resource
        const requested = this.requestResource(resource.value)
        return requested.ok ? requested.value.prepareLaunch() : requested
      },
      requestResource(resourceHandle) {
        if (get(actionPorts, this)?.request !== request) return refuse('stale-authority', 'Invalid action port receiver')
        const requestHandle = handle<RequestHandle, Request>(requests, request)
        const ownerHandle = handle<OwnerHandle, Owner>(owners, owner)
        const budgetHandle = handle<BudgetHandle, Budget>(budgets, budget)
        const lease = authority.acquireLease({ request: requestHandle, resource: resourceHandle, owner: ownerHandle })
        if (!lease.ok) return lease
        return ok(Object.freeze({
          prepareLaunch: () => authority.prepareLaunch({ request: requestHandle, resource: resourceHandle, lease: lease.value, budget: budgetHandle }),
          admitUse: (operationDigest: string) => authority.admitResourceUse({ request: requestHandle, resource: resourceHandle, lease: lease.value, operationDigest }),
          useNow: <T>(permit: UsePermit, use: () => T) => authority.useResourceNow(permit, use),
          release: () => authority.releaseLease(lease.value),
        }))
      },
    }
    actionPorts.set(port, { request, budget, owner })
    return Object.freeze(port)
  }

  const authority: HostAuthority = {
    registerRootLifetime(p) {
      const now = sample()
      if (!now.ok) return now
      if (!plain(p.boundary) || p.boundary.domainId !== clockDomain || !validNow(p.boundary.sampledAtMs) ||
        p.boundary.sampledAtMs > now.value || !validDeadline(p.boundary.deadline, clockDomain))
        return refuse('invalid-context', 'Invalid root deadline boundary')
      if (expires(p.boundary.deadline) <= now.value) return refuse('deadline-exhausted', 'Root setup exhausted the selected deadline')
      return ok(handle<LifetimeHandle, Limiter>(lifetimes, limiter(copy(p.boundary.deadline), undefined, p.signal)))
    },
    registerOwner(p) {
      const lifetime = get(lifetimes, p.lifetime)
      if (!lifetime || !plain(p.description)) return refuse('stale-authority', 'Invalid registered owner lifetime')
      const failure = checkLimiter(lifetime)
      if (failure) return failure
      const fields = p.description.kind === 'run' ? ['clientSessionId', 'rootRunId', 'parentRunId', 'parentAgentId']
        .map(name => p.description.kind === 'run' ? p.description.owner?.[name as keyof typeof p.description.owner] : undefined) :
        p.description.kind === 'host' ? [p.description.hostId] :
        p.description.kind === 'session' ? [p.description.clientSessionId, p.description.ownerId] :
        p.description.kind === 'service' ? [p.description.serviceId, p.description.ownerId] : []
      if (fields.length === 0 || fields.some(value => !nonempty(value))) return refuse('invalid-context', 'Invalid owner description')
      const owner = { id: randomUUID(), description: copy(p.description), lifetime } as Owner
      const receiver = handle<ReceiverCapability, Owner>(receivers, owner)
      owner.receiver = receiver
      return ok({ owner: handle<OwnerHandle, Owner>(owners, owner), receiver })
    },
    registerAction(p) {
      const owner = get(owners, p.owner), parent = getLimiter(p.parent)
      if (!owner || !parent || !validCorrelation(p.correlation, owner)) return refuse('stale-authority', 'Invalid action registration')
      if (parent !== owner.lifetime && (get(budgets, p.parent)?.owner !== owner))
        return refuse('stale-authority', 'Action parent belongs to another owner')
      const registrationKey = keyed(['openbuff.action-registration.v1', owner.id, p.correlation.actionId, p.correlation.attemptId])
      const existing = registeredActions.get(registrationKey)
      if (existing) {
        const budget = get(budgets, existing)!
        if (JSON.stringify(budget.correlation) !== JSON.stringify(p.correlation)) return refuse('stale-authority', 'Action identity was reused with a different basis')
        return ok(existing)
      }
      const budget = registerBudget(owner, parent, p.correlation, p.limit)
      if (budget.ok) registeredActions.set(registrationKey, budget.value)
      return budget
    },
    registerHostObservation(p) {
      const owner = get(owners, p.owner), parent = get(lifetimes, p.parent)
      if (!owner || !parent || owner.lifetime !== parent || owner.description.kind !== 'host' || p.purpose !== 'repository-bootstrap')
        return refuse('stale-authority', 'Invalid repository bootstrap context')
      return registerBudget(owner, parent, { kind: 'host-observation', observationId: randomUUID(), hostContextId, purpose: p.purpose }, p.limit)
    },
    registerHostOperation(p) {
      const owner = get(owners, p.owner), parent = get(lifetimes, p.parent)
      if (!owner || !parent || owner.lifetime !== parent || !['host', 'run', 'session', 'service'].includes(owner.description.kind) || p.purpose !== 'direct-host-operation')
        return refuse('stale-authority', 'Invalid direct host operation context')
      return registerBudget(owner, parent, { kind: 'host-operation', operationId: randomUUID(), hostContextId, purpose: p.purpose }, p.limit)
    },
    deriveBudget(p) {
      const parent = get(budgets, p.parent)
      if (!parent || !nonempty(p.memoKey) || !validLimit(p.limit)) return refuse('invalid-context', 'Invalid derived budget')
      const failure = checkLimiter(parent)
      if (failure) return failure
      const existing = parent.children.get(p.memoKey)
      if (existing) return ok(handle<BudgetHandle, Budget>(budgets, existing))
      const created = registerBudget(parent.owner, parent, parent.correlation, p.limit)
      if (!created.ok) return created
      const budget = get(budgets, created.value)!
      budget.root = parent.root
      parent.children.set(p.memoKey, budget)
      return created
    },
    registerRequest(p) {
      const budget = get(budgets, p.budget)
      if (!budget) return refuse('stale-authority', 'Unknown action budget')
      const failure = checkLimiter(budget)
      if (failure) return failure
      const request: Request = { id: randomUUID(), budget, controller: registeredController() }
      link(budget.controller.signal, request.controller)
      link(p.signal, request.controller)
      const cancelled = signalRefusal(request.controller.signal, 'Request was cancelled before registration')
      if (cancelled) return cancelled
      return ok(handle<RequestHandle, Request>(requests, request))
    },
    bindAction(p) {
      const request = get(requests, p.request), budget = get(budgets, p.budget), owner = get(owners, p.owner)
      if (!request || !budget || !owner || request.budget !== budget || budget.owner !== owner)
        return refuse('stale-authority', 'Action context registration does not match')
      const failure = checkRequest(request)
      return failure ?? ok(boundPort(request, budget, owner))
    },
    actionRegistration(port) {
      const registration = get(actionPorts, port)
      if (!registration) return refuse('stale-authority', 'Unknown action execution port')
      const failure = checkRequest(registration.request)
      if (failure) return failure
      return ok(Object.freeze({
        request: handle<RequestHandle, Request>(requests, registration.request),
        budget: handle<BudgetHandle, Budget>(budgets, registration.budget),
        owner: handle<OwnerHandle, Owner>(owners, registration.owner),
        correlation: registration.budget.correlation,
        signal: registration.request.controller.signal,
      }))
    },
    deadline(value) {
      const state = getLimiter(value)
      if (!state) throw new Error('Unknown execution lifetime')
      return state.deadline
    },
    remainingMs(value) {
      const state = getLimiter(value)
      if (!state) return refuse('stale-authority', 'Unknown execution lifetime')
      const failure = checkLimiter(state)
      if (failure) return failure
      const now = sample()
      return now.ok ? ok(state.deadline.kind === 'finite' ? Math.max(0, state.deadline.expiresAtMs - now.value) : null) : now
    },
    signal(value) {
      const lifetime = getLimiter(value)
      return lifetime ? ok(lifetime.controller.signal) : refuse('stale-authority', 'Unknown execution lifetime')
    },
    resourceGeneration(value) {
      const resource = get(resources, value)
      if (!resource) return refuse('stale-authority', 'Unknown execution resource')
      const failure = checkResource(resource)
      return failure ?? ok(resource.generation)
    },
    registerResource(p) {
      const owner = get(owners, p.owner), lifetime = getLimiter(p.lifetime), destination = get(destinations, p.destination)
      if (!owner || !lifetime || !destination) return refuse('stale-authority', 'Unknown resource owner, lifetime or destination')
      if (lifetime !== owner.lifetime && get(budgets, p.lifetime)?.owner !== owner)
        return refuse('stale-authority', 'Resource lifetime belongs to another owner')
      const failure = checkLimiter(lifetime) ?? checkLimiter(owner.lifetime)
      if (failure) return failure
      if (!validTarget(p.launchTemplate) || !['none', 'exact-host-scope-lifetime-owner'].includes(p.reuse) ||
        !plain(p.restartPolicy) || (p.restartPolicy.kind !== 'none' &&
          (p.restartPolicy.kind !== 'explicit-host-startup' || !Number.isSafeInteger(p.restartPolicy.maxAttempts) || p.restartPolicy.maxAttempts < 1)))
        return refuse('invalid-context', 'Invalid captured resource template')
      const target = copy({ ...p.launchTemplate, delegation: p.launchTemplate.delegation })
      // Opaque handles must retain reference identity while data is copied.
      const capturedTarget = Object.freeze({ ...target, ...(p.launchTemplate.delegation ? { delegation: p.launchTemplate.delegation } : {}) })
      if (destination.resolved.command !== capturedTarget.executable || JSON.stringify(destination.resolved.args) !== JSON.stringify(capturedTarget.argv))
        return refuse('invalid-context', 'Resolved destination does not match the exact executable')
      const profile = captureProfile(capturedTarget)
      if (!profile.ok) return profile
      const environment = mergeEnvironment(capturedTarget, destination, owner, lifetime)
      if (!environment.ok) return environment
      const compatibility = keyed(['openbuff.resource-compatibility.v1', hostContextId, configuration.snapshotId,
        owner.id, lifetime.id, destination.id, capturedTarget.executable, capturedTarget.argv, capturedTarget.cwd,
        capturedTarget.projectRoot, capturedTarget.allowedPaths, capturedTarget.profile, profile.value.selected,
        capturedTarget.shellCommandBytes ?? null, capturedTarget.mode, capturedTarget.processType, capturedTarget.family,
        capturedTarget.branchId, environment.value.env, environment.value.delegation?.id ?? null,
        capturedTarget.adapterOptions, p.restartPolicy, configuration.trustPolicyId])
      if (p.reuse === 'exact-host-scope-lifetime-owner') {
        const existing = reusedResources.get(compatibility)
        const state = existing && get(resources, existing)
        if (state?.current && !state.stopCommitted && !state.controller.signal.aborted) return ok(existing!)
      }
      const resource: Resource = { id: randomUUID(), generation: randomUUID(), generationNumber: 0, owner, lifetime, destination,
        target: capturedTarget, env: environment.value.env, delegation: environment.value.delegation, profile: profile.value,
        compatibility, reuse: p.reuse, restartPolicy: copy(p.restartPolicy), restartAttempts: 0,
        transferId: null, current: true, stopCommitted: false, controller: registeredController(), extraSignal: p.resourceSignal, leases: new Set() }
      resource.unlinkOwner = link(lifetime.controller.signal, resource.controller)
      resource.unlinkExtraSignal = link(p.resourceSignal, resource.controller)
      const result = handle<ResourceHandle, Resource>(resources, resource)
      if (p.reuse === 'exact-host-scope-lifetime-owner') reusedResources.set(compatibility, result)
      return ok(result)
    },
    registerMaintenanceRequest(p) {
      const resource = get(resources, p.resource)
      if (!resource || !resource.current || !resource.correlation || !resource.originalBudget ||
        resource.restartPolicy.kind !== 'explicit-host-startup' || resource.restartAttempts >= resource.restartPolicy.maxAttempts ||
        !['observed-adapter-failure', 'dead-entry-reacquire'].includes(p.reason))
        return refuse('stale-authority', 'Resource maintenance is not registered')
      const failure = checkResource(resource)
      if (failure) return failure
      const created = registerBudget(resource.owner, resource.lifetime, resource.correlation, { kind: 'unbounded' })
      if (!created.ok) return created
      const request = authority.registerRequest({ budget: created.value })
      if (!request.ok) return request
      get(requests, request.value)!.maintenanceResource = resource
      return ok({ budget: created.value, request: request.value })
    },
    nextResourceGeneration(p) {
      const previous = get(resources, p.previous), request = get(requests, p.request)
      if (!previous || !request || !previous.current || request.budget.owner !== previous.owner ||
        previous.restartPolicy.kind !== 'explicit-host-startup' || previous.restartAttempts >= previous.restartPolicy.maxAttempts ||
        request.budget.parent !== previous.lifetime || request.maintenanceResource !== previous)
        return refuse('stale-authority', 'Invalid resource restart request')
      if (p.branchId !== undefined && !nonempty(p.branchId)) return refuse('invalid-context', 'Invalid restart branch identity')
      const failure = checkRequest(request) ?? checkResource(previous)
      if (failure) return failure
      previous.current = false
      const resource: Resource = { ...previous, generation: randomUUID(), generationNumber: previous.generationNumber + 1,
        target: p.branchId === undefined ? previous.target : Object.freeze({ ...previous.target, branchId: p.branchId }),
        restartAttempts: previous.restartAttempts + 1, current: true, stopCommitted: false, controller: registeredController(), leases: new Set(),
        observed: undefined, launch: undefined }
      resource.unlinkOwner = link(resource.lifetime.controller.signal, resource.controller)
      resource.unlinkExtraSignal = link(resource.extraSignal, resource.controller)
      const result = handle<ResourceHandle, Resource>(resources, resource)
      if (resource.reuse === 'exact-host-scope-lifetime-owner') reusedResources.set(resource.compatibility, result)
      return ok(result)
    },
    acquireLease(p) {
      const request = get(requests, p.request), resource = get(resources, p.resource), owner = get(owners, p.owner)
      if (!request || !resource || !owner || resource.owner !== owner || request.budget.owner !== owner)
        return refuse('stale-authority', 'Request and resource ownership do not match')
      const failure = checkRequest(request) ?? checkResource(resource)
      if (failure) return failure
      const lease: Lease = { id: randomUUID(), request, resource, owner, generation: resource.generation, released: false }
      resource.leases.add(lease)
      const abort = () => { lease.released = true; resource.leases.delete(lease) }
      request.controller.signal.addEventListener('abort', abort, { once: true })
      lease.unlink = () => request.controller.signal.removeEventListener('abort', abort)
      return ok(handle<LeaseHandle, Lease>(leases, lease))
    },
    releaseLease(value) {
      const lease = get(leases, value)
      if (!lease) return refuse('stale-authority', 'Unknown request lease')
      if (lease.released) return refuse('already-consumed', 'Request lease already released')
      lease.released = true
      lease.unlink?.()
      lease.resource.leases.delete(lease)
      return ok(undefined)
    },
    prepareLaunch(p) {
      const request = get(requests, p.request), resource = get(resources, p.resource), lease = get(leases, p.lease), budget = get(budgets, p.budget)
      if (!request || !resource || !lease || !budget || lease.request !== request || lease.resource !== resource ||
        request.budget !== budget || budget.owner !== resource.owner)
        return refuse('stale-authority', 'Launch request, resource and lease do not match')
      const failure = checkLease(lease)
      if (failure) return failure
      if (resource.observed) return refuse('already-consumed', 'Observed resource requires use admission')
      if (resource.launch) return refuse('already-consumed', 'Resource already has a prepared launch')
      const classification = captureClassification(resource.target)
      if (!classification.ok) return classification
      const originBudget = resource.transferId ? resource.originalBudget ?? budget : budget
      const initial = { id: randomUUID(), request, resource, lease, budget, generation: resource.generation,
        correlation: resource.transferId ? resource.correlation ?? budget.correlation : budget.correlation,
        classification: classification.value, capturedDeadlines: copy({ action: originBudget.root.deadline,
          requestAdmission: request.budget.deadline, resourceLifetime: resource.lifetime.deadline }),
        stage: 'planned' as const, consumed: false, observed: false, failedBeforeStart: false }
      const binding = bindingFor(initial)
      const bindingDigest = keyed([...executionBindingTuple(binding)])
      const launch: Launch = { ...initial, binding, bindingDigest }
      resource.launch = launch
      resource.correlation ??= budget.correlation
      resource.originalBudget ??= budget
      emit({ phase: 'planned', facts: facts(launch) })
      return ok(preparedFor(launch))
    },
    async admitResourceUse(p) {
      const request = get(requests, p.request), resource = get(resources, p.resource), lease = get(leases, p.lease)
      if (!request || !resource || !lease || lease.request !== request || lease.resource !== resource ||
        !resource.observed || !nonempty(p.operationDigest)) return refuse('stale-authority', 'Unknown or unobserved resource use')
      const failure = checkLease(lease)
      if (failure) return failure
      const original = resource.observed.launch
      // Bind the operation in the existing adapter-options subdigest while
      // preserving the reviewed 29-member authority tuple.
      const useResource: Resource = { ...resource, target: Object.freeze({ ...resource.target,
        branchId: resource.target.family === 'lsp' ? 'lsp.reuse' : resource.target.family === 'mcp-stdio' ? 'mcp.reuse' : resource.target.branchId,
        adapterOptions: Object.freeze({ ...resource.target.adapterOptions, resourceUseOperationDigest: p.operationDigest }) }) }
      const useLaunch: Launch = { ...original, id: randomUUID(), resource: useResource, request, budget: request.budget, lease,
        correlation: request.budget.correlation,
        generation: resource.generation, capturedDeadlines: copy({ action: request.budget.root.deadline,
          requestAdmission: request.budget.deadline, resourceLifetime: resource.lifetime.deadline }),
        stage: 'planned', consumed: false }
      useLaunch.binding = bindingFor(useLaunch)
      useLaunch.bindingDigest = keyed([...executionBindingTuple(useLaunch.binding)])
      const contextFailure = checkUse(useLaunch)
      if (contextFailure) return contextFailure
      try {
        const decision = await awaitDecision(useLaunch) as Awaited<ReturnType<HostAuthorityInputs['authorizeAsync']>>
        if (!plain(decision) || decision.ok !== true || !nonempty(decision.decisionId) ||
          !['explicit-policy', 'exact-action-approval'].includes(decision.basis))
          return decision?.ok === false ? decision : refuse('unavailable', 'Resource use policy unavailable')
        const current = checkUse(useLaunch)
        if (current) return current
        return ok(handle<UsePermit, Use>(uses, { request, resource, lease, generation: resource.generation,
          operationDigest: p.operationDigest, launch: useLaunch, consumed: false }))
      } catch {
        return refuse('unavailable', 'Resource use authorizer unavailable')
      }
    },
    useResourceNow(permit, use) {
      const value = get(uses, permit)
      if (!value) return refuse('stale-authority', 'Unknown resource use permit')
      if (value.consumed) return refuse('already-consumed', 'Resource use permit already consumed')
      if (value.generation !== value.resource.generation || !value.resource.observed)
        return refuse('stale-authority', 'Resource use generation is stale')
      value.consumed = true
      const failure = checkUse(value.launch)
      if (failure) return failure
      emit({ phase: 'resource-reused', facts: facts(value.launch),
        processObservationId: value.resource.observed.id, originalLaunchId: value.resource.observed.launch.id })
      if (poisoned) return refuse('unavailable', 'Execution event recorder unavailable')
      const interrupted = checkUseState(value.launch)
      if (interrupted) return interrupted
      try { return ok(use()) }
      catch (error) { return refuse('unavailable', error instanceof Error ? error.message : 'Resource operation failed') }
    },
    registerDestination(p) {
      if (p.snapshotId !== configuration.snapshotId || !['user', 'project', 'client', 'host'].includes(p.origin) ||
        !plain(p.resolved) || !['executable', 'mcp-stdio'].includes(p.resolved.kind) || !nonempty(p.resolved.command) ||
        /\0/.test(p.resolved.command) || !Array.isArray(p.resolved.args) || p.resolved.args.some(arg => typeof arg !== 'string' || /\0/.test(arg)) ||
        !plain(p.resolved.declaredEnv) || Object.entries(p.resolved.declaredEnv).some(([name, value]) =>
          !nonempty(name) || /[=\0]/.test(name) || typeof value !== 'string' || /\0/.test(value)))
        return refuse('invalid-context', 'Invalid captured destination')
      const resolved = copy(p.resolved)
      const destination: Destination = { id: 'dest:' + keyed(['openbuff.destination.v1', p.snapshotId, p.origin,
        resolved.kind, resolved.command, resolved.args, Object.entries(resolved.declaredEnv).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]),
        snapshotId: p.snapshotId, origin: p.origin, resolved }
      return ok(handle<DestinationHandle, Destination>(destinations, destination))
    },
    destinationOrigin(value) {
      const destination = get(destinations, value)
      return destination ? ok(destination.origin as 'user' | 'project' | 'client' | 'host') : refuse('stale-authority', 'Unknown captured destination')
    },
    registerDelegation(p) {
      const destination = get(destinations, p.destination), lifetime = getLimiter(p.expiresUnder)
      const permittedOwners = Array.isArray(p.permittedOwners) ? p.permittedOwners.map(owner => get(owners, owner)) : []
      if (!destination || !lifetime || p.snapshotId !== configuration.snapshotId || destination.snapshotId !== p.snapshotId ||
        !['user', 'project', 'host'].includes(p.origin) || destination.origin !== p.origin ||
        !nonempty(p.purpose) || permittedOwners.length === 0 || permittedOwners.some(owner => !owner) ||
        !plain(p.values) || Object.entries(p.values).some(([name, value]) => !nonempty(name) || /[=\0]/.test(name) || typeof value !== 'string' || /\0/.test(value)))
        return refuse('invalid-context', 'Invalid credential delegation registration')
      const failure = checkLimiter(lifetime)
      if (failure) return failure
      return ok(handle<DelegationHandle, Delegation>(delegations, { id: randomUUID(), destination,
        snapshotId: p.snapshotId, origin: p.origin, purpose: p.purpose, lifetime, values: copy(p.values), owners: new Set(permittedOwners as Owner[]) }))
    },
    offerTransfer(p) {
      const resource = get(resources, p.resource), sender = get(owners, p.sender), receiver = get(owners, p.receiver), request = get(requests, p.request)
      if (!resource || !sender || !receiver || !request || resource.owner !== sender || request.budget.owner !== sender ||
        p.expectedGeneration !== resource.generation || ![...resource.leases].some(lease => lease.request === request && !lease.released))
        return refuse('stale-authority', 'Transfer owner, generation or sender lease does not match')
      const failure = checkRequest(request) ?? checkResource(resource) ?? checkLimiter(receiver.lifetime)
      if (failure) return failure
      const transferFailure = checkTransferLifecycle(resource)
      if (transferFailure) return transferFailure
      if (resource.delegation && !resource.delegation.owners.has(receiver)) return refuse('denied', 'Receiver has no captured credential delegation')
      return ok(handle<TransferOffer, Offer>(offers, { resource, sender, receiver, request, generation: resource.generation, consumed: false }))
    },
    acceptTransfer(p) {
      const offer = get(offers, p.offer), receiver = get(receivers, p.receiver)
      if (!offer || !receiver || offer.receiver !== receiver || offer.consumed) return refuse('stale-authority', 'Transfer receiver capability does not match')
      const failure = checkRequest(offer.request) ?? checkResource(offer.resource) ?? checkLimiter(receiver.lifetime)
      if (failure) return failure
      const transferFailure = checkTransferLifecycle(offer.resource)
      if (transferFailure) return transferFailure
      offer.consumed = true
      return ok(handle<TransferPermit, Transfer>(transfers, { offer, consumed: false }))
    },
    commitTransfer(permit) {
      const value = get(transfers, permit)
      if (!value || value.consumed) return refuse('already-consumed', 'Transfer permit is unknown or consumed')
      const { resource, sender, receiver, request, generation } = value.offer
      if (resource.owner !== sender || resource.generation !== generation || !resource.current)
        return refuse('stale-authority', 'Transfer resource changed')
      const failure = checkRequest(request) ?? checkResource(resource) ?? checkLimiter(receiver.lifetime)
      if (failure) return failure
      const transferFailure = checkTransferLifecycle(resource)
      if (transferFailure) return transferFailure
      const now = sample()
      if (!now.ok) return now
      const deadline = boundedDeadline(inputs.clock, now.value, { kind: 'unbounded' },
        expires(resource.lifetime.deadline) <= expires(receiver.lifetime.deadline) ? resource.lifetime.deadline : receiver.lifetime.deadline)
      if (!deadline.ok) return deadline
      const newLifetime = limiter(deadline.value, receiver.lifetime)
      const unlink = link(newLifetime.controller.signal, resource.controller)
      resource.correlation ??= request.budget.correlation
      resource.originalBudget ??= request.budget
      resource.unlinkOwner?.()
      resource.unlinkOwner = unlink
      resource.unlinkExtraSignal?.()
      resource.unlinkExtraSignal = undefined
      resource.extraSignal = undefined
      for (const lease of resource.leases) { lease.released = true; lease.unlink?.() }
      resource.leases.clear()
      value.consumed = true
      resource.owner = receiver
      resource.lifetime = newLifetime
      resource.generation = randomUUID()
      resource.generationNumber++
      resource.transferId = randomUUID()
      if (!resource.observed) resource.launch = undefined
      emit({ phase: 'resource-transferred', hostContextId, resourceId: resource.id,
        previousGeneration: generation, resourceGeneration: resource.generation,
        oldOwnerId: sender.id, newOwnerId: receiver.id, transferId: resource.transferId,
        correlation: resource.correlation ?? null, resourceLifetime: newLifetime.deadline })
      return ok({ transferId: resource.transferId, resource: handle<ResourceHandle, Resource>(resources, resource) })
    },
  }
  return Object.freeze(authority)
}
