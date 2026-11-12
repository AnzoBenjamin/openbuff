// In-process execution contracts. Authority comes from the host's private registries.
// Common remains independent of the SDK and provider configuration.
import type { JobOwner } from '../../util/job-registry'
import type { CodebuffSpawn } from '../spawn'
import type { NativeLifecycleObserver } from './native-execution'

export type Result<T> = Readonly<{ ok: true; value: T }> | Refusal
export type Refusal = Readonly<{
  ok: false
  reason: 'denied' | 'unavailable' | 'cancelled' | 'deadline-exhausted'
    | 'invalid-context' | 'stale-authority' | 'already-consumed'
  cause: string
}>

// Types do not create authority: every handle is authenticated by a PRIVATE
// per-host registry; copying/asserting/deserializing an object never registers it.
declare const brand: unique symbol
type Handle<K extends string> = Readonly<{ [brand]: K }>
export type OwnerHandle = Handle<'owner'>
export type LifetimeHandle = Handle<'lifetime'>
export type BudgetHandle = Handle<'budget'>
export type RequestHandle = Handle<'request'>
export type ResourceHandle = Handle<'resource'>
export type LeaseHandle = Handle<'lease'>
export type DestinationHandle = Handle<'destination'>
export type DelegationHandle = Handle<'delegation'>
export type TransferOffer = Handle<'transfer-offer'>
export type TransferPermit = Handle<'transfer-permit'>
export type TargetPermit = Handle<'target-permit'>
export type UsePermit = Handle<'resource-use-permit'>
export type ReceiverCapability = Handle<'receiver-capability'>

export type Limit = Readonly<{ kind: 'unbounded' }>
  | Readonly<{ kind: 'finite'; durationMs: number }>
export type AbsoluteDeadline = Readonly<{ kind: 'unbounded'; limitId: string }>
  | Readonly<{
      kind: 'finite'; limitId: string; domainId: string; expiresAtMs: number
    }>
export interface Clock {
  readonly domainId: string
  nowMs(): number
}
export type RootDeadlineSeed = Readonly<{
  deadline: AbsoluteDeadline; domainId: string; sampledAtMs: number
}>
export interface Scheduler {
  // Factory schedules <= 2^31-1 ms chunks and rechecks the absolute expiry.
  set(delayMs: number, callback: () => void): unknown
  clear(timer: unknown): void
}
export type DeadlineFacts = Readonly<{
  action: AbsoluteDeadline
  requestAdmission: AbsoluteDeadline
  resourceLifetime: AbsoluteDeadline
}>

export type Correlation = Readonly<{
  kind: 'action'
  actionId: string; attemptId: string; owner: Readonly<JobOwner>; basisId: string
}> | Readonly<{
  // Real pre-run observer: no invented B02 run/action/snapshot identity.
  kind: 'host-observation'
  observationId: string; hostContextId: string
  purpose: 'repository-bootstrap'
}> | Readonly<{
  kind: 'host-operation'
  operationId: string; hostContextId: string
  purpose: 'direct-host-operation'
}>
export type OwnerDescription = Readonly<
  { kind: 'run'; owner: Readonly<JobOwner> }
  | { kind: 'host'; hostId: string }
  | { kind: 'session'; clientSessionId: string; ownerId: string }
  | { kind: 'service'; serviceId: string; ownerId: string }
>
export type PolicyProfile = 'read-only' | 'librarian-read-only' | 'git-commit'
  | 'dependency-mutation' | 'validation-diagnosis' | 'tmux-test'
  | 'workspace-write' | 'full-access'
export type Capability = 'exact-env' | 'cooperative-cancellation'
  | 'filesystem-isolation' | 'network-isolation' | 'process-tree-containment'
  | 'memory-limit' | 'deadline-termination'
export type ProfileRequest = Readonly<{
  policy: PolicyProfile
  preferredBackend: 'portable-ts' | 'native-exec'
  required: readonly Capability[]
  optional?: readonly Capability[]
  allowBackendFallback: boolean
}>
export type BackendSelection = Readonly<{
  backend: string; generation: string; policy: PolicyProfile
  cancellation: 'cooperative' | 'os-scoped' | 'unavailable'
}>
export type ProfileFacts = Readonly<{
  requested: ProfileRequest
  available: readonly Readonly<{
    backend: string; generation: string; capabilities: readonly Capability[]
    unavailableReasons: readonly string[]
  }>[]
  // Selection is a plan; active requires an observed process/backend start.
  selected: BackendSelection | null
  active: BackendSelection | null
  enforced: readonly Readonly<{
    capability: Capability
    status: 'not-requested' | 'not-enforced' | 'unknown' | 'enforced'
    evidenceId?: string
  }>[]
}>
export type Family = 'sync-shell' | 'background-job' | 'supervised-child'
  | 'configured-hook' | 'diagnostic-build-version-scip' | 'lsp'
  | 'mcp-stdio' | 'chrome' | 'blender' | 'native-role'

export type EnvironmentFacts = Readonly<{
  format: 'openbuff.env.v1'; keyEpochId: string; keyedDigest: string
  inherited: boolean; entryCount: number; rosterId: string
  delegationIds: readonly string[]
}>
export type LaunchFacts = Readonly<{
  hostContextId: string; configurationSnapshotId: string
  launchId: string; branchId: string; family: Family; correlation: Correlation
  requestId: string; resourceId: string; resourceGeneration: string
  leaseId: string; ownerId: string; destinationId: string
  environment: EnvironmentFacts; deadlines: DeadlineFacts; profile: ProfileFacts
  executionBindingVersion: 2; executionBindingDigest: string
}>

// Exact v2 field ORDER/encoding is frozen in DESIGN.md, section Authority v2.
// Fields below contain no raw argv/env/secret values. Paths and other existing
// authority metadata stay host-private; public projection uses opaque IDs.
export type AuthorityBindingV2 = Readonly<{
  format: 'openbuff.execution.v2'
  keyEpochId: string
  commandHash: string
  executableArgvDigest: string
  effectRosterDigest: string
  parseStatus: 'complete' | 'unsupported' | 'malformed'
  hostContextId: string; configurationSnapshotId: string
  correlationDigest: string
  cwd: string; projectRoot: string; allowedPaths: readonly string[]
  profileRequestDigest: string; selectedBackendDigest: string
  environmentDigest: string; credentialRosterId: string
  destinationId: string; delegationDigest: string
  requestId: string; resourceId: string; resourceGeneration: string
  ownerId: string; leaseId: string
  processType: 'SYNC' | 'BACKGROUND'; mode: 'assistant' | 'user'
  detachTransferId: string | null
  deadlinesDigest: string
  adapterOptionsDigest: string
  launchId: string
}>
export type StoredExecutionAuthorityV2 = Readonly<{
  version: 2
  bindingFormat: 'openbuff.execution.v2'
  keyEpochId: string
  bindingDigest: string
  binding: AuthorityBindingV2
  usage: 'one-target-dispatch'
}>
// Root extends the existing ApprovalRecord with executionAuthority:
// StoredExecutionAuthorityV2. Existing executionContextHash alone is v1 history.

// Required root-owned classifier input is copied from the captured launch,
// never taken from model/wire-supplied classification or digest fields.
export type CapturedExecutable =
  | Readonly<{ kind: 'shell'; executable: string; argv: readonly string[];
      shellCommandBytes: string }>
  | Readonly<{ kind: 'argv'; executable: string; argv: readonly string[] }>
export type ClassifiedEffect = Readonly<{
  action: 'dependency-install' | 'commit' | 'migration' | 'push'
    | 'pull-request' | 'release' | 'deploy' | 'external-network'
    | 'arbitrary-code' | 'workspace-delete' | 'mcp-tool'
  target: string
  branch?: string
  pushRisks?: readonly ('force' | 'delete' | 'refspec' | 'mirror'
    | 'all-refs' | 'unknown-options' | 'dynamic-target')[]
}>
export type TargetClassification = Readonly<{
  format: 'openbuff.target-classification.v1'
  classifierVersion: string
  invocationKind: CapturedExecutable['kind']
  effects: readonly ClassifiedEffect[]
  parseStatus: 'complete' | 'unsupported' | 'malformed'
  parseReason: string | null
}>
// Common validates/copies/freezes this return and derives the command hash
// and keyed canonical classification digest BEFORE constructing PolicyInput.
// No classification digest or command hash is accepted from the callback.

export interface LaunchObserver extends NativeLifecycleObserver {
  // Private physical-lifecycle commitment. Survives an authenticated logical
  // owner transfer, but cannot address another launch or resource generation.
  cleanupCommitted(): Result<undefined>
  // Valid only for this private dispatch and captured adapter/runtime kind.
  // Registry mints observation ID; callers cannot choose launch/generation IDs.
  spawnObserved(observation: Readonly<{
    source: 'node-spawn-event' | 'bun-spawn-result' | 'spawn-sync-result'
    pid: number
  }>): Result<Readonly<{ processObservationId: string }>>
  failure(observation: Readonly<{
    source: 'node-error-event' | 'bun-spawn-error' | 'spawn-sync-error'
      | 'adapter-observation-error'
    errorCode?: string
    cause: string
  }>): Result<undefined>
}
// A facade is a registered host capability, not an accepted JSON shape.
// Methods reject wrong receiver/closed/stale-generation/illegal transitions.
// It grants no root/owner/config/resource/destination registration operations.

export type TargetDescription = Readonly<{
  executable: string; argv: readonly string[]; shellCommandBytes?: string
  cwd: string; projectRoot: string; allowedPaths: readonly string[]
  mode: 'assistant' | 'user'; processType: 'SYNC' | 'BACKGROUND'
  profile: ProfileRequest; family: Family; branchId: string
  environmentOverlay?: Readonly<Record<string, string | undefined>>
  delegation?: DelegationHandle
  // Canonical host description of stdio/platform/shell executable options.
  adapterOptions: Readonly<Record<string, string | number | boolean | null>>
  // No detach/transfer input here: commitTransfer changes the private resource
  // first; prepareLaunch then binds its committed transfer ID/generation.
}>
export type PolicyInput = Readonly<{
  target: TargetDescription; binding: AuthorityBindingV2; bindingDigest: string
  classification: TargetClassification // same frozen snapshot bound above
  facts: LaunchFacts
}>
export type AsyncDecision = Refusal | Readonly<{
  ok: true
  basis: 'explicit-policy' | 'exact-action-approval'
  decisionId: string
  // Exact approval path must atomically consume its stored v2 grant once
  // before the host converts this decision to a private target permit.
}>
export type SyncDecision = Refusal | Readonly<{
  ok: true; basis: 'explicit-sync-policy'; decisionId: string
}>
export type Admission = Result<Readonly<{
  permit: TargetPermit; decisionId: string
}>>

export type ExactLaunchInput = Readonly<{
  executable: string; argv: readonly string[]; cwd: string
  env: Readonly<Record<string, string>>
  // ONLY resource lifetime controls the process. Request signal governs
  // admission/wait and is never automatically attached to a shared process.
  resourceSignal: AbortSignal
  resourceRemainingMs: number | null
  deadlines: DeadlineFacts
  adapterOptions: TargetDescription['adapterOptions']
}>
export interface PreparedLaunch {
  facts(): LaunchFacts
  admit(): Promise<Admission>
  // No async callback invoked, waited upon, or treated optimistically here.
  // No sync policy / requires async approval / unsupported capability =>
  // unavailable, synchronously, with zero spawnSync calls.
  admitSync(): Admission
  // Checks private request/budget/resource/lease/permit/generation registries;
  // consumes permit before actual synchronous dispatch with no await gap.
  // The observer is privately bound before calling spawnNow, so synchronous
  // Bun/spawnSync paths can report their actual returned PID inside the call.
  // A thrown callback automatically records dispatch-failed, preserving any
  // already observed start, before returning the failure arm.
  dispatchNow<T>(permit: TargetPermit,
    spawnNow: (i: ExactLaunchInput, observer: LaunchObserver) => T):
    Result<Readonly<{ phase: 'dispatched'; handle: T; facts: LaunchFacts;
      observer: LaunchObserver }>>
    | Readonly<{ ok: false; reason: 'dispatch-failed'; cause: string; facts: LaunchFacts }>
}

// Narrow callable facade handed to adapters, never the root registration API.
export interface ActionExecutionPort {
  /** Registered request cancellation, including its derived absolute deadline. */
  readonly signal?: AbortSignal
  derive(p: Readonly<{ memoKey: string; limit: Limit }>): Result<ActionExecutionPort>
  // Missing destination creates a captured host-executable destination only;
  // it cannot perform MCP variable expansion or credential delegation.
  prepareTarget(p: Readonly<{
    target: TargetDescription; destination?: DestinationHandle
  }>): Result<PreparedLaunch>
  requestResource(resource: ResourceHandle): Result<Readonly<{
    prepareLaunch(): Result<PreparedLaunch>
    admitUse(operationDigest: string): Promise<Result<UsePermit>>
    useNow<T>(permit: UsePermit, use: () => T): Result<T>
    release(): Result<undefined>
  }>>
}

export type ResourceRequestPort = Extract<
  ReturnType<ActionExecutionPort['requestResource']>,
  { ok: true }
>['value']

/** Root binds this facade to one registered resource and generation. */
export interface BoundResourcePort {
  readonly key: string
  request(action: ActionExecutionPort): Result<ResourceRequestPort>
  restart(reason: 'observed-adapter-failure' | 'dead-entry-reacquire'): Result<BoundResourcePort>
}

/** Root closes this factory over a registered owner and run lifetime. */
export type BoundResourceFactory = (
  target: TargetDescription,
  destination?: DestinationHandle,
) => Result<BoundResourcePort>

/** Captured host dependencies; adapters never obtain them from tool payloads. */
export type ExecutionAdapterContext = Readonly<{
  execution: ActionExecutionPort
  projectRoot: string
  allowedPaths: readonly string[]
  profile: ProfileRequest
  mode: 'assistant' | 'user'
  /** Request wait cancellation; process lifetime uses ExactLaunchInput.resourceSignal. */
  signal?: AbortSignal
  spawn?: CodebuffSpawn
  cacheScope?: object
}>

export type LaunchEvent = Readonly<{
  phase: 'planned'; facts: LaunchFacts
}> | Readonly<{
  phase: 'admitted'; facts: LaunchFacts; decisionId: string
}> | Readonly<{
  phase: 'dispatched'; facts: LaunchFacts
}> | Readonly<{
  phase: 'native-transport-observed'; facts: LaunchFacts
  transportObservationId: string; pid: number
}> | Readonly<{
  phase: 'native-prepared'; facts: LaunchFacts
}> | Readonly<{
  phase: 'native-entry-committed'; facts: LaunchFacts
}> | Readonly<{
  phase: 'spawn-observed'; facts: LaunchFacts
  processObservationId: string; pid?: number
}> | Readonly<{
  phase: 'no-launch'; facts: LaunchFacts; refusal: Refusal
}> | Readonly<{
  phase: 'dispatch-failed'; facts: LaunchFacts
  processStart: 'not-observed' | 'observed'; cause: string
}> | Readonly<{
  phase: 'resource-reused'; facts: LaunchFacts
  processObservationId: string; originalLaunchId: string
}> | Readonly<{
  phase: 'resource-transferred'
  hostContextId: string; resourceId: string; previousGeneration: string; resourceGeneration: string
  oldOwnerId: string; newOwnerId: string; transferId: string
  correlation: Correlation | null; resourceLifetime: AbsoluteDeadline
}>

export type CapturedConfigIdentity = Readonly<{
  snapshotId: string; trustPolicyId: string
  canonicalCredentialNames: readonly string[]
  configuredCredentialNames: readonly string[]
  rosterId: string
}>
export type HostAuthorityInputs = Readonly<{
  // Already captured/strictly loaded by SDK composition; no loader defaults.
  configuration: CapturedConfigIdentity
  // Separate from the private SDK configuration/credential environment.
  childInheritanceEnvironment: Readonly<Record<string, string | undefined>>
  childOverrides: Readonly<Record<string, string | undefined>>
  inheritEnv: boolean
  platform: 'win32' | 'linux' | 'darwin' | 'other'
  clock: Clock; scheduler: Scheduler
  resolveProfile: (request: ProfileRequest, target: TargetDescription) => ProfileFacts
  classifyTarget: (captured: CapturedExecutable) => TargetClassification
  authorizeAsync: (request: PolicyInput) => Promise<AsyncDecision>
  authorizeSync?: (request: PolicyInput) => SyncDecision
  isCurrentBasis: (correlation: Correlation) => boolean
  record: (event: LaunchEvent) => void
}>

export interface HostAuthority {
  // Root host only: initial limit captured once before asynchronous setup.
  // Each registered owner/lifetime has a stable private identity/generation.
  registerRootLifetime(p: Readonly<{
    signal?: AbortSignal; boundary: RootDeadlineSeed
  }>): Result<LifetimeHandle>
  registerOwner(p: Readonly<{
    description: OwnerDescription; lifetime: LifetimeHandle
  }>): Result<Readonly<{ owner: OwnerHandle; receiver: ReceiverCapability }>>
  // Synchronous action-start registration BEFORE preflight/queued approval.
  // Re-registering the identity cannot move its initial start/expiry.
  registerAction(p: Readonly<{
    correlation: Extract<Correlation, { kind: 'action' }>
    owner: OwnerHandle; parent: LifetimeHandle | BudgetHandle; limit: Limit
  }>): Result<BudgetHandle>
  registerHostObservation(p: Readonly<{
    purpose: 'repository-bootstrap'
    owner: OwnerHandle; parent: LifetimeHandle; limit: Limit
  }>): Result<BudgetHandle>
  registerHostOperation(p: Readonly<{
    purpose: 'direct-host-operation'
    owner: OwnerHandle; parent: LifetimeHandle; limit: Limit
  }>): Result<BudgetHandle>
  // memoKey is unique within the private parent; repeated derivation reuses
  // initial expiry and cannot restart the duration. Only min(parent, local).
  deriveBudget(p: Readonly<{
    parent: BudgetHandle; memoKey: string; limit: Limit
  }>): Result<BudgetHandle>
  registerRequest(p: Readonly<{
    budget: BudgetHandle; signal?: AbortSignal
  }>): Result<RequestHandle>
  bindAction(p: Readonly<{
    request: RequestHandle; budget: BudgetHandle; owner: OwnerHandle
  }>): Result<ActionExecutionPort>
  // Root-only registry lookup. Derived adapter ports retain authenticated
  // ancestry; a copied/serialized port does not expose a registration.
  actionRegistration(port: ActionExecutionPort): Result<Readonly<{
    request: RequestHandle; budget: BudgetHandle; owner: OwnerHandle; correlation: Correlation; signal: AbortSignal
  }>>
  deadline(handle: LifetimeHandle | BudgetHandle): AbsoluteDeadline
  signal(handle: LifetimeHandle | BudgetHandle): Result<AbortSignal>
  remainingMs(handle: LifetimeHandle | BudgetHandle): Result<number | null>
  resourceGeneration(handle: ResourceHandle): Result<string>

  // Ordinary action resource lifetime is bounded by its action budget.
  // Explicit run-owned reusable resources use the registered run lifetime.
  registerResource(p: Readonly<{
    owner: OwnerHandle; lifetime: LifetimeHandle | BudgetHandle
    resourceSignal?: AbortSignal
    destination: DestinationHandle
    // Factory materializes exact env/template and computes compatibility
    // itself. No caller-supplied env digest and no plan/resource-key cycle.
    launchTemplate: TargetDescription
    reuse: 'none' | 'exact-host-scope-lifetime-owner'
    restartPolicy: Readonly<{ kind: 'none' }>
      | Readonly<{ kind: 'explicit-host-startup'; maxAttempts: number }>
  }>): Result<ResourceHandle>
  // Registered host adapter requests maintenance under the resource lifetime,
  // not an expired first caller. Preserves original correlation and records
  // the failure/restart attempt; it does not assert process-scope death.
  registerMaintenanceRequest(p: Readonly<{
    resource: ResourceHandle
    reason: 'observed-adapter-failure' | 'dead-entry-reacquire'
  }>): Result<Readonly<{ request: RequestHandle; budget: BudgetHandle }>>
  nextResourceGeneration(p: Readonly<{
    previous: ResourceHandle; request: RequestHandle; branchId?: string
  }>): Result<ResourceHandle>
  acquireLease(p: Readonly<{
    request: RequestHandle; resource: ResourceHandle; owner: OwnerHandle
  }>): Result<LeaseHandle>
  releaseLease(lease: LeaseHandle): Result<undefined>
  prepareLaunch(p: Readonly<{
    request: RequestHandle; resource: ResourceHandle; lease: LeaseHandle
    budget: BudgetHandle
  }>): Result<PreparedLaunch>
  // New request admission even on reuse; this cannot launch another process.
  admitResourceUse(p: Readonly<{
    request: RequestHandle; resource: ResourceHandle; lease: LeaseHandle
    operationDigest: string
  }>): Promise<Result<UsePermit>>
  useResourceNow<T>(permit: UsePermit, use: () => T): Result<T>
  // Observation is exported only through dispatchNow's bound facade.

  // resolved was expanded ONCE by the caller with captured host config env.
  // Destination ID is a host-keyed opaque ID, never the legacy MCP cache key.
  registerDestination(p: Readonly<{
    snapshotId: string; origin: 'user' | 'project' | 'client' | 'host'
    resolved: Readonly<{
      kind: 'executable' | 'mcp-stdio'
      command: string; args: readonly string[]
      declaredEnv: Readonly<Record<string, string>>
    }>
  }>): Result<DestinationHandle>
  registerDelegation(p: Readonly<{
    destination: DestinationHandle; snapshotId: string
    origin: 'user' | 'project' | 'host'; purpose: string
    expiresUnder: LifetimeHandle | BudgetHandle
    // Host-supplied exact captured values, never resolved again at spawn.
    values: Readonly<Record<string, string>>
    permittedOwners: readonly OwnerHandle[]
  }>): Result<DelegationHandle>
  destinationOrigin(destination: DestinationHandle): Result<'user' | 'project' | 'client' | 'host'>

  offerTransfer(p: Readonly<{
    resource: ResourceHandle; sender: OwnerHandle; receiver: OwnerHandle
    expectedGeneration: string; request: RequestHandle
  }>): Result<TransferOffer>
  acceptTransfer(p: Readonly<{
    offer: TransferOffer; receiver: ReceiverCapability
  }>): Result<TransferPermit>
  // Atomic registry update; receiver's signal attached before old binding is
  // relinquished. Effective deadline is min(existing, receiver), never wider.
  // Once dispatch begins, transfer waits for an authenticated start observation
  // and refuses after the physical adapter commits cleanup.
  commitTransfer(permit: TransferPermit): Result<Readonly<{
    transferId: string; resource: ResourceHandle
  }>>
}


// No ambient global authority/config singleton. Each factory owns its secret
// HMAC key and private registries; handles from another host scope are refused.
// Cross-process descriptions are data only. A trusted parent bridge registers
// child request handles and owns cancellation; it never accepts a wire handle
// or another process's monotonic timestamp as executable authority.
