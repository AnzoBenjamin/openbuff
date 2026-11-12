import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { captureRootDeadline, createHostAuthority } from '@codebuff/common/util/execution-context'
import { CREDENTIAL_ENV_KEYS } from './credential-env-keys'
import { captureAmbientHostInputs, createProviderHostContext, loadHostConfigSnapshot, nodeConfigReadFs } from './host-config'
import { classifyCapturedTargetForExecution, evaluateHarnessActionPolicy } from './services/harness-enforcement'
import { createNativeHostRegistry, registerPreparedNativeLaunch } from './services/native-host-execution'
import type { NativeHostExecution } from './services/native-host-execution'

import type {
  ActionExecutionPort, AsyncDecision, BoundResourceFactory, BoundResourcePort, BudgetHandle, Clock, Correlation,
  DestinationHandle, ExecutionAdapterContext, HostAuthority, LaunchEvent, LifetimeHandle, Limit, OwnerHandle,
  PolicyInput, PreparedLaunch, ProfileFacts, ProfileRequest, Refusal, RequestHandle, ResourceHandle, ResourceRequestPort,
  Result, RootDeadlineSeed, SyncDecision, TargetDescription,
} from '@codebuff/common/types/contracts/execution-context'
import type { JobOwner } from '@codebuff/common/util/job-registry'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { ConfigReadFs } from './provider-config'
import type { CapturedCredentialPort, HostConfigurationInputs, HostConfigSnapshot, ProviderHostContext } from './host-config'
import type { HarnessApprovalMode, HarnessApprovalRequest, HarnessApprovalService } from './services/harness-enforcement'
import type { CapturedTerminalLaunchMetadata } from './tools/run-terminal-command'
import type { LspResourceFacade, LspResourceFactory } from './services/lsp-multiplexer'
import type { LlmHostDeps } from './impl/llm'

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const unavailable = (cause: string): Refusal => ({ ok: false, reason: 'unavailable', cause })
const unbounded = { kind: 'unbounded' } as const
export const executionClock: Clock = Object.freeze({ domainId: `sdk-monotonic:${randomUUID()}`, nowMs: () => performance.now() })

export const defaultExecutionProfile: ProfileRequest = Object.freeze({ policy: 'workspace-write', preferredBackend: 'portable-ts',
  required: Object.freeze(['exact-env'] as const), allowBackendFallback: false })

/** Portable adapter capabilities only. OS enforcement belongs to B21. */
export function resolvePortableProfile(request: ProfileRequest): ProfileFacts {
  const available = [{ backend: 'portable-ts', generation: 'portable-ts-execution-v1',
    capabilities: ['exact-env', 'cooperative-cancellation'] as const, unavailableReasons: [] }]
  const canSelect = (request.preferredBackend === 'portable-ts' || request.allowBackendFallback) &&
    request.required.every(capability => available[0].capabilities.includes(capability as 'exact-env' | 'cooperative-cancellation'))
  return { requested: request, available, selected: canSelect ? { backend: 'portable-ts', generation: available[0].generation,
    policy: request.policy, cancellation: 'cooperative' } : null, active: null,
    enforced: [...request.required, ...(request.optional ?? [])].map(capability => ({ capability, status: capability === 'exact-env' ? 'enforced' : 'not-enforced',
      ...(capability === 'exact-env' ? { evidenceId: 'captured-exact-environment' } : {}) })) }
}

export type ExecutionScope = Readonly<{
  owner: OwnerHandle
  lifetime: LifetimeHandle
  resources: BoundResourceFactory
  lspResources: LspResourceFactory
  operation(p?: Readonly<{ limit?: Limit; signal?: AbortSignal; profile?: ProfileRequest; mode?: 'assistant' | 'user' }>): Result<ExecutionAdapterContext>
  action(p: Readonly<{ actionId: string; attemptId: string; basisId: string; limit?: Limit; signal?: AbortSignal;
    profile?: ProfileRequest; mode?: 'assistant' | 'user' }>): Result<ExecutionAdapterContext>
}>

export type RunHostServices = Readonly<{
  profile: ProfileRequest
  approvalMode: HarnessApprovalMode
  provider: ProviderHostContext
  llm: LlmHostDeps
  execution: HostAuthority
  readPolicy: HostConfigSnapshot['readPolicy']
  rootLifetime: LifetimeHandle
  rootSignal: AbortSignal
  bootstrap: ExecutionAdapterContext
  directScope: ExecutionScope
  events: readonly LaunchEvent[]
  terminalShell?: Readonly<{ executable: string; args: readonly string[] }>
  registerRun(owner: JobOwner, parent?: ExecutionAdapterContext): Result<ExecutionScope>
  createBackgroundReceiver(clientSessionId: string): Result<Readonly<{
    prepareLaunch(context: ExecutionAdapterContext, target: TargetDescription): Result<PreparedLaunch>
  }>>
  directOperation(p?: Readonly<{ limit?: Limit; signal?: AbortSignal; profile?: ProfileRequest; mode?: 'assistant' | 'user' }>):
    Result<Readonly<{ executionContext: ExecutionAdapterContext; resources: BoundResourceFactory; lspResources: LspResourceFactory }>>
  getTerminalLaunchMetadata(launchId: string): CapturedTerminalLaunchMetadata | undefined
}>

export type HostExecutionOptions = Readonly<{
  snapshot: HostConfigSnapshot
  boundary: RootDeadlineSeed
  clock?: Clock
  childInheritanceEnvironment: Readonly<Record<string, string | undefined>>
  env?: Readonly<Record<string, string | undefined>>
  inheritEnv?: boolean
  signal?: AbortSignal
  profile?: ProfileRequest
  spawn?: CodebuffSpawn
  nativeExecution?: NativeHostExecution
  credentials?: CapturedCredentialPort
  record?: (event: LaunchEvent) => void
  authorizeAsync?: (input: PolicyInput) => Promise<AsyncDecision>
  authorizeSync?: (input: PolicyInput) => SyncDecision
  isCurrentBasis?: (correlation: Correlation) => boolean
  approvalMode?: HarnessApprovalMode
  requestApproval?: (request: HarnessApprovalRequest) => Promise<boolean>
  resolveApprovalContext?: (input: PolicyInput) => Promise<Readonly<{
    service: HarnessApprovalService
    repositoryId: string; workspaceId: string; runId: string; snapshotId: string
    receiptIds: readonly string[]
    branch?: string; defaultBranch?: string
    isCurrent(): boolean
  }> | undefined>
}>

export function createHostExecutionServices(options: HostExecutionOptions): Result<RunHostServices> {
  try {
    const snapshot = options.snapshot
    const approvalMode = options.approvalMode ?? snapshot.loaded.config.approvalMode ?? 'balanced'
    const provider = createProviderHostContext(snapshot, options.credentials)
    const clock = options.clock ?? executionClock
    const nativeRegistry = createNativeHostRegistry(options.nativeExecution, clock, options.spawn,
      Object.freeze({ ...(options.inheritEnv === false ? {} : options.childInheritanceEnvironment), ...options.env }))
    const selectedProfile = options.profile ?? (snapshot.sandboxPolicy.mode === 'unrestricted'
      ? { ...defaultExecutionProfile, policy: 'full-access' as const }
      : defaultExecutionProfile)
    const profile = Object.freeze({ ...selectedProfile, required: Object.freeze([...selectedProfile.required]),
      ...(selectedProfile.optional ? { optional: Object.freeze([...selectedProfile.optional]) } : {}) })
    const events: LaunchEvent[] = []
    const metadata = new Map<string, CapturedTerminalLaunchMetadata>()
    const runScopes = new Map<string, ExecutionScope>()
    const runParentPorts = new Map<string, ActionExecutionPort | undefined>()
    const registeredStartupResources = new Set<string>()
    const cacheScope = Object.freeze({})
    const bootstrapRefusal = (input: PolicyInput): Refusal | undefined => {
      if (input.facts.correlation.kind !== 'host-observation') return undefined
      const { target } = input
      const identityQuery = target.argv.length === 2 && target.argv[0] === 'rev-parse' &&
        (target.argv[1] === '--show-toplevel' || target.argv[1] === '--git-common-dir')
      if (input.facts.correlation.purpose !== 'repository-bootstrap' || target.executable !== 'git' || !identityQuery ||
        ![snapshot.inputs.invocationCwd, snapshot.inputs.projectRoot].includes(target.cwd) ||
        target.projectRoot !== snapshot.inputs.projectRoot ||
        target.allowedPaths.length !== 1 + snapshot.sandboxPolicy.allowPaths.length ||
        target.allowedPaths.some((root, index) => root !== [snapshot.inputs.projectRoot, ...snapshot.sandboxPolicy.allowPaths][index]) ||
        target.processType !== 'SYNC' ||
        target.shellCommandBytes !== undefined || target.adapterOptions.shell !== false ||
        target.environmentOverlay !== undefined || target.delegation !== undefined)
        return { ok: false, reason: 'denied', cause: 'Repository bootstrap permits only captured Git identity queries' }
      return undefined
    }
    const defaultPolicy = (input: PolicyInput, approved: boolean, context?: { branch?: string; defaultBranch?: string }) => {
      const effects = input.classification.effects
      const first = effects[0]
      if (input.target.mode === 'user') return { allowed: true as const, approvalRequired: false as const }
      if (registeredStartupResources.has(input.facts.resourceId) && input.classification.parseStatus !== 'malformed' &&
        effects.every(effect => effect.action === 'arbitrary-code'))
        return { allowed: true as const, approvalRequired: false as const }
      // A routine interpreter command is still an untrusted server startup
      // when it comes from a client MCP declaration. Tool approval does not
      // grant permission to start that process.
      if (input.facts.family === 'mcp-stdio' && !first && input.classification.parseStatus === 'complete')
        return evaluateHarnessActionPolicy({ action: 'arbitrary-code', target: '',
          approvalMode, hasMatchingApproval: approved })
      if (!first && input.classification.parseStatus === 'complete') return { allowed: true as const, approvalRequired: false as const }
      return evaluateHarnessActionPolicy({ action: first?.action ?? 'arbitrary-code', target: first?.target ?? '',
        effects: effects.map(effect => ({ ...effect, pushRisks: effect.pushRisks ? [...effect.pushRisks] : undefined })),
        parseStatus: input.classification.parseStatus, parseReason: input.classification.parseReason ?? undefined,
        approvalMode, hasMatchingApproval: approved, ...context })
    }
    const captureMetadata = (input: PolicyInput, approvalReceiptId?: string) => {
      const first = input.classification.effects[0]
      metadata.set(input.facts.launchId, Object.freeze({
        requiresCommitSafety: input.classification.effects.some(effect => effect.action === 'commit'),
        ...(approvalReceiptId ? { approvalReceiptId } : {}),
        harnessAction: first?.action, harnessTarget: first?.target, harnessEffects: input.classification.effects,
        harnessParseStatus: input.classification.parseStatus, executionBindingVersion: 2, executionBindingDigest: input.bindingDigest,
      }))
    }
    const authorizeAsync = async (input: PolicyInput): Promise<AsyncDecision> => {
      const refusal = bootstrapRefusal(input)
      if (refusal) return refusal
      captureMetadata(input)
      if (options.authorizeAsync) {
        const result = await options.authorizeAsync(input)
        if (result.ok && result.basis === 'exact-action-approval') captureMetadata(input, result.decisionId)
        return result
      }
      const context = input.classification.effects.some(effect => effect.action === 'push')
        ? await options.resolveApprovalContext?.(input) : undefined
      const decision = defaultPolicy(input, false, context)
      if (decision.allowed) return { ok: true, basis: 'explicit-policy', decisionId: randomUUID() }
      if (!decision.approvalRequired) return { ok: false, reason: 'denied', cause: decision.reason }
      const authority = context ?? await options.resolveApprovalContext?.(input)
      if (!authority || !authority.isCurrent()) return unavailable('Exact approval requires current repository, workspace, run and snapshot authority')
      const first = input.classification.effects[0]
      const scope = { repositoryId: authority.repositoryId, workspaceId: authority.workspaceId,
        runId: authority.runId, snapshotId: authority.snapshotId }
      const requested = { action: first?.action ?? 'arbitrary-code', target: first?.target ?? '',
        commandHash: input.binding.commandHash,
        executionAuthority: { version: 2 as const, bindingFormat: 'openbuff.execution.v2' as const, keyEpochId: input.binding.keyEpochId,
          bindingDigest: input.bindingDigest, binding: input.binding, usage: 'one-target-dispatch' as const } }
      for (const approvalId of authority.receiptIds) {
        try {
          const receipt = authority.service.consume({ ...scope, ...requested, approvalId })
          if (!authority.isCurrent()) return { ok: false, reason: 'stale-authority', cause: 'Workspace changed during approval consumption' }
          captureMetadata(input, receipt.id)
          return { ok: true, basis: 'exact-action-approval', decisionId: receipt.id }
        } catch { /* A v1, stale or already consumed record never authorizes this target. */ }
      }
      if (!options.requestApproval) return unavailable(decision.reason)
      const approved = await options.requestApproval({ ...requested,
        ...(input.target.shellCommandBytes !== undefined ? { rawCommand: input.target.shellCommandBytes } : {}),
        effects: input.classification.effects.map(effect => ({ ...effect, pushRisks: effect.pushRisks ? [...effect.pushRisks] : undefined })),
        parseStatus: input.classification.parseStatus, parseReason: input.classification.parseReason ?? undefined,
        reason: decision.reason, risk: 'high' })
      if (!approved) return { ok: false, reason: 'denied', cause: 'The user declined this operation.' }
      if (!authority.isCurrent()) return { ok: false, reason: 'stale-authority', cause: 'Workspace changed while awaiting approval' }
      const grant = authority.service.grant(scope, requested)
      const receipt = authority.service.consume({ ...scope, ...requested, approvalId: grant.id })
      captureMetadata(input, receipt.id)
      return { ok: true, basis: 'exact-action-approval', decisionId: receipt.id }
    }
    const authorizeSync = (input: PolicyInput): SyncDecision => {
      const refusal = bootstrapRefusal(input)
      if (refusal) return refusal
      captureMetadata(input)
      if (options.authorizeSync) return options.authorizeSync(input)
      const decision = defaultPolicy(input, false)
      return decision.allowed ? { ok: true, basis: 'explicit-sync-policy', decisionId: randomUUID() } :
        { ok: false, reason: decision.approvalRequired ? 'unavailable' : 'denied', cause: decision.reason }
    }
    const execution = createHostAuthority({ configuration: { snapshotId: snapshot.snapshotId,
      trustPolicyId: snapshot.sourceBytesIdentity, canonicalCredentialNames: CREDENTIAL_ENV_KEYS,
      configuredCredentialNames: snapshot.credentialNames, rosterId: `roster:${snapshot.snapshotId}` },
      childInheritanceEnvironment: options.childInheritanceEnvironment, childOverrides: options.env ?? {}, inheritEnv: options.inheritEnv ?? true,
      platform: ['linux', 'darwin', 'win32'].includes(snapshot.inputs.platform) ? snapshot.inputs.platform as 'linux' | 'darwin' | 'win32' : 'other',
      clock, scheduler: { set: (delay, callback) => { const timer = setTimeout(callback, delay); timer.unref?.(); return timer },
        clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) },
      resolveProfile: (request, target) => nativeRegistry.resolve(request, target, resolvePortableProfile(request)),
      classifyTarget: classifyCapturedTargetForExecution, authorizeAsync, authorizeSync,
      isCurrentBasis: options.isCurrentBasis ?? (() => true), record: event => { events.push(event); options.record?.(event) } })
    const root = execution.registerRootLifetime({ boundary: options.boundary, signal: options.signal })
    if (!root.ok) return root
    const rootLifetime = root.value
    const hostOwner = execution.registerOwner({ description: { kind: 'host', hostId: randomUUID() }, lifetime: rootLifetime })
    if (!hostOwner.ok) return hostOwner

    function contextFor(owner: OwnerHandle, budget: BudgetHandle, signal?: AbortSignal, requestedProfile = profile,
      mode: 'assistant' | 'user' = 'assistant'): Result<ExecutionAdapterContext> {
      const request = execution.registerRequest({ budget, signal })
      if (!request.ok) return request
      const bound = execution.bindAction({ owner, budget, request: request.value })
      if (!bound.ok) return bound
      nativeRegistry.bind(bound.value)
      return ok(Object.freeze({ execution: bound.value, projectRoot: snapshot.inputs.projectRoot,
        allowedPaths: Object.freeze([snapshot.inputs.projectRoot, ...snapshot.sandboxPolicy.allowPaths]), profile: requestedProfile, mode, signal: bound.value.signal,
        spawn: options.spawn, cacheScope }))
    }

    function resourceFactories(owner: OwnerHandle, lifetime: LifetimeHandle = rootLifetime) {
      type Holder = { resource: ResourceHandle; key: string; target: TargetDescription; trustedStartup: boolean; startup?: ResourceRequestPort }
      const resourceHolders = new WeakMap<object, Holder>()
      function startupPort(source: ResourceRequestPort, holder: Holder): ResourceRequestPort {
        return Object.freeze({ ...source, prepareLaunch() {
          const launch = source.prepareLaunch()
          if (launch.ok && holder.trustedStartup && ['lsp', 'mcp-stdio', 'chrome'].includes(holder.target.family))
            registeredStartupResources.add(launch.value.facts().resourceId)
          return launch
        } })
      }
      const defaultDestination = (target: TargetDescription) => execution.registerDestination({ snapshotId: snapshot.snapshotId, origin: 'host',
        resolved: { kind: 'executable', command: target.executable, args: target.argv, declaredEnv: {} } })
      function register(target: TargetDescription, destination?: DestinationHandle): Result<Holder> {
        const resolved = destination ? ok(destination) : defaultDestination(target)
        if (!resolved.ok) return resolved
        const origin = execution.destinationOrigin(resolved.value)
        if (!origin.ok) return origin
        const resource = execution.registerResource({ owner, lifetime, destination: resolved.value, launchTemplate: target,
          reuse: 'exact-host-scope-lifetime-owner', restartPolicy: { kind: 'explicit-host-startup', maxAttempts: 2 } })
        if (!resource.ok) return resource
        let holder = resourceHolders.get(resource.value)
        if (!holder) { holder = { resource: resource.value, target, trustedStartup: origin.value !== 'client', key: randomUUID() }; resourceHolders.set(resource.value, holder) }
        return ok(holder)
      }
      function startup(holder: Holder, action: ActionExecutionPort): Result<ResourceRequestPort> {
        if (holder.startup) return ok(holder.startup)
        const initial = execution.actionRegistration(action)
        if (!initial.ok) return initial
        // Handles returned by registry lookup are fresh facades; membership is
        // authenticated by bindAction rather than reference comparison here.
        const belongs = execution.bindAction({ ...initial.value, owner })
        if (!belongs.ok) return belongs
        const budget = execution.deriveBudget({ parent: initial.value.budget, memoKey: `resource-startup:${holder.key}`, limit: { kind: 'finite', durationMs: 15_000 } })
        if (!budget.ok) return budget
        // Waiting request cancellation releases its lease, not this bounded startup request.
        const context = contextFor(owner, budget.value)
        if (!context.ok) return context
        const requested = context.value.execution.requestResource(holder.resource)
        if (!requested.ok) return requested
        holder.startup = startupPort(requested.value, holder)
        return ok(holder.startup)
      }
      function next(holder: Holder, reason: 'observed-adapter-failure' | 'dead-entry-reacquire'): Result<Holder> {
        const maintenance = execution.registerMaintenanceRequest({ resource: holder.resource, reason })
        if (!maintenance.ok) return maintenance
        const branchId = holder.target.family === 'lsp'
          ? reason === 'observed-adapter-failure' ? 'lsp.crash-restart' : 'lsp.dead-entry-reacquire'
          : holder.target.branchId
        const resource = execution.nextResourceGeneration({ previous: holder.resource, request: maintenance.value.request, branchId })
        if (!resource.ok) return resource
        const budget = execution.deriveBudget({ parent: maintenance.value.budget, memoKey: 'startup', limit: { kind: 'finite', durationMs: 15_000 } })
        if (!budget.ok) return budget
        const context = contextFor(owner, budget.value)
        if (!context.ok) return context
        const requested = context.value.execution.requestResource(resource.value)
        if (!requested.ok) return requested
        const replacement: Holder = { resource: resource.value, target: Object.freeze({ ...holder.target, branchId }), trustedStartup: holder.trustedStartup, key: randomUUID() }
        replacement.startup = startupPort(requested.value, replacement)
        return ok(replacement)
      }
      function bound(holder: Holder): BoundResourcePort {
        const port: BoundResourcePort = Object.freeze({ key: holder.key,
          request(action: ActionExecutionPort) {
            if (this !== port) return unavailable('Invalid bound resource receiver')
            const requested = action.requestResource(holder.resource)
            if (!requested.ok) return requested
            return ok(Object.freeze({ ...requested.value, prepareLaunch: () => {
              const source = startup(holder, action)
              return source.ok ? source.value.prepareLaunch() : source
            } }))
          },
          restart(reason: 'observed-adapter-failure' | 'dead-entry-reacquire') {
            if (this !== port) return unavailable('Invalid bound resource receiver')
            const replacement = next(holder, reason)
            return replacement.ok ? ok(bound(replacement.value)) : replacement
          },
        })
        return port
      }
      const resources: BoundResourceFactory = (target, destination) => { const holder = register(target, destination); return holder.ok ? ok(bound(holder.value)) : holder }
      const lspResources: LspResourceFactory = (spec, request) => {
        const target: TargetDescription = { executable: spec.argv[0], argv: spec.argv.slice(1), cwd: spec.cwd,
          projectRoot: snapshot.inputs.projectRoot, allowedPaths: [snapshot.inputs.projectRoot], profile, mode: 'assistant',
          processType: 'BACKGROUND', family: 'lsp', branchId: 'lsp.cold-start', adapterOptions: { runtime: 'node', stdio: 'pipe' } }
        const registered = register(target)
        if (!registered.ok) return registered
        function facade(holder: Holder): LspResourceFacade {
          const result: LspResourceFacade = {
            async admitSpawn(actual) {
              if (this !== result || actual.cwd !== spec.cwd || JSON.stringify(actual.argv) !== JSON.stringify(spec.argv))
                return unavailable('LSP startup executable differs from its captured resource')
              const source = startup(holder, request.execution)
              if (!source.ok) return source
              const launch = source.value.prepareLaunch()
              if (!launch.ok) return launch
              const admitted = await launch.value.admit()
              return admitted.ok ? ok({ launch: launch.value, permit: admitted.value.permit }) : admitted
            },
            nextGeneration(reason) {
              if (this !== result) return unavailable('Invalid LSP resource receiver')
              const replacement = next(holder, reason)
              return replacement.ok ? ok(facade(replacement.value)) : replacement
            },
            request(action) { return this === result ? action.requestResource(holder.resource) : unavailable('Invalid LSP resource receiver') },
          }
          return Object.freeze(result)
        }
        return ok(facade(registered.value))
      }
      return { resources, lspResources }
    }
    const hostFactories = resourceFactories(hostOwner.value.owner)
    const bootstrapBudget = execution.registerHostObservation({ owner: hostOwner.value.owner, parent: rootLifetime,
      purpose: 'repository-bootstrap', limit: { kind: 'finite', durationMs: 15_000 } })
    if (!bootstrapBudget.ok) return bootstrapBudget
    // Repository bootstrap (git identity, journal, broker) has no native adapter
    // selection. Only a run that selected an installed native backend moves it to
    // the portable default; every other run keeps its own profile, so the
    // default path and an unavailable required backend behave as before B21.
    const bootstrapProfile = profile.preferredBackend === 'native-exec' && options.nativeExecution
      ? defaultExecutionProfile : profile
    const bootstrap = contextFor(hostOwner.value.owner, bootstrapBudget.value, undefined, bootstrapProfile)
    if (!bootstrap.ok) return bootstrap
    const directScope: ExecutionScope = Object.freeze({ owner: hostOwner.value.owner, lifetime: rootLifetime, ...hostFactories,
      operation(p = {}) {
        const budget = execution.registerHostOperation({ owner: hostOwner.value.owner, parent: rootLifetime,
          purpose: 'direct-host-operation', limit: p.limit ?? unbounded })
        return budget.ok ? contextFor(hostOwner.value.owner, budget.value, p.signal, p.profile ?? profile, p.mode) : budget
      },
      action() { return unavailable('A direct host operation does not have B02 action authority') },
    })
    const services: RunHostServices = Object.freeze({ profile, approvalMode, provider, llm: Object.freeze({ providerContext: provider }), execution,
      readPolicy: snapshot.readPolicy, rootLifetime, rootSignal: (() => {
        const signal = execution.signal(rootLifetime)
        if (!signal.ok) throw new Error(signal.cause)
        return signal.value
      })(), bootstrap: bootstrap.value, directScope,
      get events() { return Object.freeze([...events]) },
      terminalShell: snapshot.inputs.platform === 'win32'
        ? snapshot.inputs.environment.OPENBUFF_GIT_BASH_PATH ?? snapshot.inputs.environment.CODEBUFF_GIT_BASH_PATH
          ? Object.freeze({ executable: (snapshot.inputs.environment.OPENBUFF_GIT_BASH_PATH ?? snapshot.inputs.environment.CODEBUFF_GIT_BASH_PATH)!, args: Object.freeze(['-c']) })
          : undefined
        : Object.freeze({ executable: 'bash', args: Object.freeze(['-c']) }),
      registerRun(jobOwner, parent) {
        const capturedOwner = Object.freeze({ clientSessionId: jobOwner.clientSessionId, rootRunId: jobOwner.rootRunId,
          parentRunId: jobOwner.parentRunId, parentAgentId: jobOwner.parentAgentId })
        const key = JSON.stringify([capturedOwner.clientSessionId, capturedOwner.rootRunId, capturedOwner.parentRunId, capturedOwner.parentAgentId])
        const parentRegistration = parent ? execution.actionRegistration(parent.execution) : undefined
        if (parentRegistration && !parentRegistration.ok) return parentRegistration
        const parentDeadline = parentRegistration?.ok ? execution.deadline(parentRegistration.value.budget) : undefined
        const additionalParentSignal = parent?.signal
        const parentSignal = parentRegistration?.ok ? additionalParentSignal
          ? AbortSignal.any([parentRegistration.value.signal, additionalParentSignal]) : parentRegistration.value.signal : undefined
        const existing = runScopes.get(key)
        if (existing) return runParentPorts.get(key) === parent?.execution ? ok(existing) :
          { ok: false, reason: 'stale-authority', cause: 'Run owner was registered under another parent action' }
        const boundedLifetime = parentDeadline ? execution.registerRootLifetime({
          boundary: { deadline: parentDeadline, domainId: clock.domainId, sampledAtMs: clock.nowMs() },
          signal: parentSignal,
        }) : ok(rootLifetime)
        if (!boundedLifetime.ok) return boundedLifetime
        const runLifetime = boundedLifetime.value
        const owner = execution.registerOwner({ description: { kind: 'run', owner: capturedOwner }, lifetime: runLifetime })
        if (!owner.ok) return owner
        const factories = resourceFactories(owner.value.owner, runLifetime)
        const scope: ExecutionScope = Object.freeze({ owner: owner.value.owner, lifetime: runLifetime, ...factories,
          operation(p = {}) {
            const budget = execution.registerHostOperation({ owner: owner.value.owner, parent: runLifetime,
              purpose: 'direct-host-operation', limit: p.limit ?? unbounded })
            return budget.ok ? contextFor(owner.value.owner, budget.value, p.signal, p.profile ?? profile, p.mode) : budget
          },
          action(p) {
            const budget = execution.registerAction({ correlation: { kind: 'action', actionId: p.actionId, attemptId: p.attemptId,
              basisId: p.basisId, owner: capturedOwner }, owner: owner.value.owner, parent: runLifetime, limit: p.limit ?? unbounded })
            return budget.ok ? contextFor(owner.value.owner, budget.value, p.signal, p.profile ?? profile, p.mode) : budget
          } })
        runScopes.set(key, scope)
        runParentPorts.set(key, parent?.execution)
        return ok(scope)
      },
      createBackgroundReceiver(clientSessionId) {
        const boundary = captureRootDeadline({ clock, limit: unbounded })
        if (!boundary.ok) return boundary
        const lifetime = execution.registerRootLifetime({ boundary: boundary.value })
        if (!lifetime.ok) return lifetime
        const receiver = execution.registerOwner({ lifetime: lifetime.value,
          description: { kind: 'session', clientSessionId, ownerId: `background-job-registry:${clientSessionId}` } })
        if (!receiver.ok) return receiver
        const port = Object.freeze({ prepareLaunch(context: ExecutionAdapterContext, target: TargetDescription): Result<PreparedLaunch> {
          if (this !== port) return unavailable('Invalid background receiver capability')
          const sender = execution.actionRegistration(context.execution)
          if (!sender.ok) return sender
          const destination = execution.registerDestination({ snapshotId: snapshot.snapshotId, origin: 'host',
            resolved: { kind: 'executable', command: target.executable, args: target.argv, declaredEnv: {} } })
          if (!destination.ok) return destination
          const resource = execution.registerResource({ owner: sender.value.owner, lifetime: sender.value.budget, destination: destination.value,
            resourceSignal: context.signal, launchTemplate: target, reuse: 'none', restartPolicy: { kind: 'none' } })
          if (!resource.ok) return resource
          const generation = execution.resourceGeneration(resource.value)
          if (!generation.ok) return generation
          const lease = execution.acquireLease({ ...sender.value, resource: resource.value })
          if (!lease.ok) return lease
          const offer = execution.offerTransfer({ resource: resource.value, sender: sender.value.owner, receiver: receiver.value.owner,
            expectedGeneration: generation.value, request: sender.value.request })
          if (!offer.ok) { execution.releaseLease(lease.value); return offer }
          const accepted = execution.acceptTransfer({ offer: offer.value, receiver: receiver.value.receiver })
          if (!accepted.ok) { execution.releaseLease(lease.value); return accepted }
          const transferred = execution.commitTransfer(accepted.value)
          if (!transferred.ok) { execution.releaseLease(lease.value); return transferred }
          const budget = execution.registerHostOperation({ owner: receiver.value.owner, parent: lifetime.value,
            purpose: 'direct-host-operation', limit: unbounded })
          if (!budget.ok) return budget
          // Transfer gives the resource its independent receiver lifetime,
          // while the caller can still cancel this pending launch request.
          const request = execution.registerRequest({ budget: budget.value, signal: context.signal })
          if (!request.ok) return request
          const receivingLease = execution.acquireLease({ owner: receiver.value.owner, resource: transferred.value.resource, request: request.value })
          if (!receivingLease.ok) return receivingLease
          const prepared = execution.prepareLaunch({ resource: transferred.value.resource, request: request.value,
            budget: budget.value, lease: receivingLease.value })
          if (prepared.ok) registerPreparedNativeLaunch(context.execution, target, prepared.value)
          return prepared
        } })
        return ok(port)
      },
      directOperation(p = {}) {
        const budget = execution.registerHostOperation({ owner: hostOwner.value.owner, parent: rootLifetime,
          purpose: 'direct-host-operation', limit: p.limit ?? unbounded })
        if (!budget.ok) return budget
        const context = contextFor(hostOwner.value.owner, budget.value, p.signal, p.profile ?? profile, p.mode)
        return context.ok ? ok({ executionContext: context.value, ...hostFactories }) : context
      },
      getTerminalLaunchMetadata: launchId => metadata.get(launchId),
    })
    return ok(services)
  } catch (error) { return unavailable(error instanceof Error ? error.message : 'Execution host unavailable') }
}

/** Outer host operation entrypoint, including evaluators and explicit CLI commands. */
export function createDirectHostExecution(options: Readonly<{
  cwd: string; projectRoot?: string; hostConfiguration?: HostConfigurationInputs; configReadFs?: ConfigReadFs;
  credentials?: CapturedCredentialPort; env?: Readonly<Record<string, string | undefined>>; inheritEnv?: boolean;
  signal?: AbortSignal; limit?: Limit; profile?: ProfileRequest; spawn?: CodebuffSpawn;
  nativeExecution?: NativeHostExecution;
  record?: (event: LaunchEvent) => void; approvalMode?: HarnessApprovalMode; requestApproval?: (request: HarnessApprovalRequest) => Promise<boolean>
}>): Result<Readonly<{ hostServices: RunHostServices; executionContext: ExecutionAdapterContext; resources: BoundResourceFactory; lspResources: LspResourceFactory }>> {
  options = Object.freeze({ ...options, env: options.env && Object.freeze({ ...options.env }),
    profile: options.profile && Object.freeze({ ...options.profile, required: Object.freeze([...options.profile.required]),
      ...(options.profile.optional ? { optional: Object.freeze([...options.profile.optional]) } : {}) }) })
  const clock = options.nativeExecution?.clock ?? executionClock
  const boundary = captureRootDeadline({ clock, limit: options.limit ?? unbounded })
  if (!boundary.ok) return boundary
  const inputs = options.hostConfiguration ?? captureAmbientHostInputs({ cwd: path.resolve(options.cwd), projectRoot: path.resolve(options.projectRoot ?? options.cwd) })
  const childInheritanceEnvironment = Object.freeze({ ...inputs.environment })
  const captured = loadHostConfigSnapshot({ inputs, fs: options.configReadFs ?? nodeConfigReadFs })
  if (captured.status !== 'complete') return unavailable(captured.cause)
  const services = createHostExecutionServices({ ...options, clock, snapshot: captured.snapshot, boundary: boundary.value,
    childInheritanceEnvironment })
  if (!services.ok) return services
  const direct = services.value.directOperation({ signal: options.signal })
  return direct.ok ? ok({ hostServices: services.value, ...direct.value }) : direct
}
