import { randomUUID } from 'node:crypto'
import { spawn as spawnNodeProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  captureRootDeadline,
  createHostAuthority,
} from '../../../../common/src/util/execution-context'
import { classifyCapturedTargetForExecution } from '../../services/harness-enforcement'
import {
  captureNodeTarget,
  type AdmittedNodeLaunch,
} from '../../services/execution-launch'

import type {
  AbsoluteDeadline,
  AsyncDecision,
  Clock,
  ExecutionAdapterContext,
  HostAuthorityInputs,
  LaunchEvent,
  Limit,
  PolicyInput,
  PolicyProfile,
  PreparedLaunch,
  ProfileRequest,
  Result,
  Scheduler,
  SyncDecision,
  TargetDescription,
} from '../../../../common/src/types/contracts/execution-context'
import type { CodebuffSpawn } from '../../../../common/src/types/spawn'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { JobOwner } from '../../../../common/src/util/job-registry'
import type { CapturedTerminalLaunchMetadata } from '../../tools/run-terminal-command'

export function executionValue<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}

function retainControlTrace(value: unknown) {
  const directory = process.env.B19_TERMINAL_EVIDENCE_DIR
  if (!directory) return
  const ownedRuns = path.resolve(import.meta.dir, '../../../../docs/execution/body-roadmap/evidence/B19/implementation/terminal/runs')
  if (!path.resolve(directory).startsWith(`${ownedRuns}${path.sep}`)) throw new Error('B19 control trace directory is outside owned runs')
  appendFileSync(path.join(directory, 'execution-controls.jsonl'), `${JSON.stringify(value)}\n`)
}

/** Deterministic clock for admission and queue controls, not runtime evidence. */
export function createControlledExecutionClock() {
  let now = 100
  let nextId = 0
  const tasks = new Map<number, { at: number; callback: () => void }>()
  const clock: Clock = { domainId: `terminal-control-${randomUUID()}`, nowMs: () => now }
  const scheduler: Scheduler = {
    set(delay, callback) { tasks.set(++nextId, { at: now + delay, callback }); return nextId },
    clear(timer) { tasks.delete(timer as number) },
  }
  function advance(ms: number) {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('Invalid fixture clock advance')
    now += ms
    for (;;) {
      const due = [...tasks].find(([, task]) => task.at <= now)
      if (!due) return
      tasks.delete(due[0])
      due[1].callback()
    }
  }
  return { clock, scheduler, advance }
}

type ProcessReply = { stdout?: string; stderr?: string; exitCode?: number }
export type CapturedProcessCall = {
  executable: string
  argv: readonly string[]
  options: SpawnOptions
  child: ChildProcess
  signals: string[]
  closed: boolean
  finish: (exitCode?: number, signal?: string) => void
}

/** Scheduled fake Node frames retain actual adapter options; no OS PID proof. */
export function createExecutionProcessRecorder(options: {
  autoClose?: boolean
  closeOnKill?: boolean
  reply?: (executable: string, argv: readonly string[]) => ProcessReply
} = {}) {
  const calls: CapturedProcessCall[] = []
  const spawn: CodebuffSpawn = (executable, argv = [], spawnOptions = {}) => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const childState = Object.assign(new EventEmitter(), {
      pid: 42_424_001 + calls.length,
      stdout,
      stderr,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill(signal = 'SIGTERM') {
        call.signals.push(signal)
        if (call.closed) return false
        if (options.closeOnKill !== false) call.finish(undefined, signal)
        return true
      },
    })
    const call: CapturedProcessCall = {
      executable, argv, options: spawnOptions,
      child: childState as unknown as ChildProcess,
      signals: [], closed: false,
      finish(exitCode = 0, signal) {
        if (call.closed) return
        call.closed = true
        childState.exitCode = signal ? null : exitCode
        childState.signalCode = signal ?? null
        childState.emit('exit', signal ? null : exitCode, signal)
        childState.emit('close', signal ? null : exitCode, signal)
        retainControlTrace({
          kind: 'injected-node-option-control', syntheticPid: childState.pid,
          executable, argv: [...argv],
          options: {
            cwd: spawnOptions.cwd, env: spawnOptions.env, stdio: spawnOptions.stdio,
            detached: spawnOptions.detached, shell: spawnOptions.shell, windowsHide: spawnOptions.windowsHide,
          },
          resourceSignalAborted: spawnOptions.signal?.aborted ?? null,
          requestedSignals: [...call.signals],
          observedFixtureClose: true,
          doesNotCertify: ['OS process creation', 'B20 process death or cleanup'],
        })
      },
    }
    calls.push(call)
    queueMicrotask(() => {
      if (call.closed) return
      childState.emit('spawn')
      if (options.autoClose === false) return
      const reply = options.reply?.(executable, argv) ?? {}
      if (reply.stdout) stdout.emit('data', Buffer.from(reply.stdout))
      if (reply.stderr) stderr.emit('data', Buffer.from(reply.stderr))
      call.finish(reply.exitCode ?? 0)
    })
    return call.child
  }
  return { spawn, calls }
}

/** Actual Node children, with option capture distinct from synthetic frames. */
export function createRealExecutionProcessRecorder() {
  const calls: Array<Pick<CapturedProcessCall, 'executable' | 'argv' | 'options' | 'child'> & { spawnObserved: boolean }> = []
  const spawn: CodebuffSpawn = (executable, argv = [], options = {}) => {
    const child = spawnNodeProcess(executable, [...argv], options)
    const call = { executable, argv, options, child, spawnObserved: false }
    calls.push(call)
    child.once('spawn', () => { call.spawnObserved = Number.isSafeInteger(child.pid) && child.pid! > 0 })
    child.once('close', (exitCode, signal) => retainControlTrace({
      kind: 'real-node-option-control', observedPid: call.spawnObserved ? child.pid : null,
      executable, argv: [...argv],
      options: {
        cwd: options.cwd, env: options.env, stdio: options.stdio,
        detached: options.detached, shell: options.shell, windowsHide: options.windowsHide,
      },
      resourceSignalAborted: options.signal?.aborted ?? null,
      observedExitCode: exitCode, observedTerminationSignal: signal,
      doesNotCertify: ['B19 acceptance', 'B20 process death or cleanup'],
    }))
    return child
  }
  return { spawn, calls }
}

export function executionDeadlineMs(deadline: AbsoluteDeadline): number | null {
  return deadline.kind === 'finite' ? deadline.expiresAtMs : null
}

type FixtureOptions = {
  projectRoot?: string
  scratchRoot?: string
  allowedPaths?: readonly string[]
  policy?: PolicyProfile
  mode?: 'assistant' | 'user'
  owner?: JobOwner
  environment?: Readonly<Record<string, string | undefined>>
  overrides?: Readonly<Record<string, string | undefined>>
  inheritEnv?: boolean
  rootLimit?: Limit
  actionLimit?: Limit
  transferLimit?: Limit
  receiverLimit?: Limit
  signal?: AbortSignal
  spawn?: CodebuffSpawn
  clock?: Clock
  scheduler?: Scheduler
  authorize?: (input: PolicyInput) => Promise<AsyncDecision> | AsyncDecision
  authorizeSync?: (input: PolicyInput) => SyncDecision
  resolveProfile?: HostAuthorityInputs['resolveProfile']
  record?: HostAuthorityInputs['record']
}

/**
 * A real private host registry and root classifier, with explicit fixture
 * policy. Fake child events are DI controls; only real children prove runtime
 * observation. This fixture neither loads provider config nor calls a model.
 */
export function createTerminalExecutionFixture(options: FixtureOptions = {}) {
  const scratch = mkdtempSync(path.join(options.scratchRoot ?? tmpdir(), 'b19-terminal-fixture-'))
  const home = path.join(scratch, 'home')
  const xdg = path.join(scratch, 'xdg')
  mkdirSync(home)
  mkdirSync(xdg)
  const projectRoot = options.projectRoot ?? process.cwd()
  const stop = new AbortController()
  const clock: Clock = options.clock ?? {
    domainId: `terminal-fixture-${randomUUID()}`,
    nowMs: () => Math.floor(performance.now()),
  }
  const scheduler: Scheduler = options.scheduler ?? {
    set(delay, callback) {
      const timer = setTimeout(callback, delay)
      timer.unref?.()
      return timer
    },
    clear(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>) },
  }
  const profile: ProfileRequest = Object.freeze({
    policy: options.policy ?? 'full-access',
    preferredBackend: 'portable-ts',
    required: Object.freeze(['exact-env'] as const),
    allowBackendFallback: false,
  })
  const environment: Record<string, string | undefined> = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    PROJECT_VALUE: 'captured-value',
    OPENAI_API_KEY: 'fixture-canonical-sentinel',
    CUSTOM_PROVIDER_KEY: 'fixture-configured-sentinel',
    ...options.environment,
  }
  const events: LaunchEvent[] = []
  const policyInputs: PolicyInput[] = []
  const metadata = new Map<string, CapturedTerminalLaunchMetadata>()
  const remember = (input: PolicyInput) => {
    policyInputs.push(input)
    const effects = input.classification.effects
    metadata.set(input.facts.launchId, Object.freeze({
      requiresCommitSafety: effects.some(effect => effect.action === 'commit'),
      ...(effects[0] ? { harnessAction: effects[0].action, harnessTarget: effects[0].target } : {}),
      harnessEffects: effects,
      harnessParseStatus: input.classification.parseStatus,
      executionBindingVersion: 2,
      executionBindingDigest: input.bindingDigest,
    }))
  }
  const snapshotId = `terminal-snapshot-${randomUUID()}`
  const authority = createHostAuthority({
    configuration: {
      snapshotId,
      trustPolicyId: 'terminal-fixture-explicit-policy',
      rosterId: 'terminal-fixture-roster',
      canonicalCredentialNames: ['OPENAI_API_KEY'],
      configuredCredentialNames: ['CUSTOM_PROVIDER_KEY'],
    },
    childInheritanceEnvironment: environment,
    childOverrides: options.overrides ?? {},
    inheritEnv: options.inheritEnv ?? true,
    platform: process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32'
      ? process.platform : 'other',
    clock,
    scheduler,
    resolveProfile: options.resolveProfile ?? (request => ({
      requested: request,
      available: [{
        backend: 'portable-ts',
        generation: 'terminal-fixture-node',
        capabilities: ['exact-env', 'cooperative-cancellation'],
        unavailableReasons: [],
      }],
      selected: {
        backend: 'portable-ts', generation: 'terminal-fixture-node',
        policy: request.policy, cancellation: 'cooperative',
      },
      active: null,
      enforced: [{ capability: 'exact-env', status: 'enforced', evidenceId: 'fixture-exact-env-input' }],
    })),
    classifyTarget: classifyCapturedTargetForExecution,
    authorizeAsync: async input => {
      remember(input)
      return options.authorize
        ? options.authorize(input)
        : { ok: true, basis: 'explicit-policy', decisionId: `fixture-policy-${randomUUID()}` }
    },
    authorizeSync: input => {
      remember(input)
      return options.authorizeSync
        ? options.authorizeSync(input)
        : { ok: true, basis: 'explicit-sync-policy', decisionId: `fixture-sync-policy-${randomUUID()}` }
    },
    isCurrentBasis: () => true,
    record(event) { events.push(event); options.record?.(event) },
  })
  const boundary = executionValue(captureRootDeadline({ clock, limit: options.rootLimit ?? { kind: 'unbounded' } }))
  const lifetime = executionValue(authority.registerRootLifetime({ signal: stop.signal, boundary }))
  const jobOwner: JobOwner = options.owner ?? {
    clientSessionId: 'terminal-fixture-session', rootRunId: 'terminal-fixture-run',
    parentRunId: 'terminal-fixture-parent', parentAgentId: 'terminal-fixture-agent',
  }
  const registeredOwner = executionValue(authority.registerOwner({ description: { kind: 'run', owner: jobOwner }, lifetime }))
  const owner = registeredOwner.owner
  const budget = executionValue(authority.registerAction({
    owner, parent: lifetime, limit: options.actionLimit ?? { kind: 'unbounded' },
    correlation: {
      kind: 'action', owner: jobOwner, actionId: `terminal-fixture-action-${randomUUID()}`,
      attemptId: 'fixture-attempt', basisId: 'fixture-basis',
    },
  }))
  const requestAbort = new AbortController()
  const request = executionValue(authority.registerRequest({ budget, signal: requestAbort.signal }))
  const execution = executionValue(authority.bindAction({ owner, budget, request }))
  const transferBudget = options.transferLimit ? executionValue(authority.deriveBudget({
    parent: budget, memoKey: 'fixture-transfer-budget', limit: options.transferLimit,
  })) : budget
  const forwardAbort = () => requestAbort.abort(options.signal?.reason)
  if (options.signal?.aborted) forwardAbort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })
  const context: ExecutionAdapterContext = Object.freeze({
    execution, projectRoot, allowedPaths: Object.freeze([...(options.allowedPaths ?? [projectRoot])]),
    profile, mode: options.mode ?? 'assistant', signal: execution.signal, spawn: options.spawn,
  })
  const getTerminalLaunchMetadata = (launchId: string) => metadata.get(launchId)
  const receiverStops: AbortController[] = []
  function prepareTransferredLaunch(target: TargetDescription): Result<PreparedLaunch> {
    const destination = executionValue(authority.registerDestination({
      snapshotId, origin: 'host', resolved: { kind: 'executable', command: target.executable, args: target.argv, declaredEnv: {} },
    }))
    const resource = executionValue(authority.registerResource({
      owner, lifetime: transferBudget, destination, launchTemplate: target,
      reuse: 'none', restartPolicy: { kind: 'none' },
    }))
    const senderRequest = executionValue(authority.registerRequest({ budget: transferBudget, signal: requestAbort.signal }))
    const senderLease = executionValue(authority.acquireLease({ owner, resource, request: senderRequest }))
    const senderLaunch = executionValue(authority.prepareLaunch({ request: senderRequest, budget: transferBudget, resource, lease: senderLease }))
    const receiverStop = new AbortController()
    receiverStops.push(receiverStop)
    const receiverLifetime = executionValue(authority.registerRootLifetime({
      signal: receiverStop.signal,
      boundary: executionValue(captureRootDeadline({ clock, limit: options.receiverLimit ?? { kind: 'unbounded' } })),
    }))
    const receiverDescription = { ...jobOwner, parentAgentId: 'terminal-fixture-detached-receiver' }
    const receiver = executionValue(authority.registerOwner({ description: { kind: 'run', owner: receiverDescription }, lifetime: receiverLifetime }))
    const offer = executionValue(authority.offerTransfer({
      resource, sender: owner, receiver: receiver.owner, request: senderRequest,
      expectedGeneration: senderLaunch.facts().resourceGeneration,
    }))
    const accepted = executionValue(authority.acceptTransfer({ offer, receiver: receiver.receiver }))
    const transferred = executionValue(authority.commitTransfer(accepted))
    const receiverBudget = executionValue(authority.registerAction({
      owner: receiver.owner, parent: receiverLifetime, limit: { kind: 'unbounded' },
      correlation: {
        kind: 'action', owner: receiverDescription, actionId: `fixture-receive-${randomUUID()}`,
        attemptId: 'fixture-attempt', basisId: 'fixture-basis',
      },
    }))
    const receiverRequest = executionValue(authority.registerRequest({ budget: receiverBudget }))
    const receiverLease = executionValue(authority.acquireLease({ owner: receiver.owner, resource: transferred.resource, request: receiverRequest }))
    return authority.prepareLaunch({ request: receiverRequest, budget: receiverBudget, resource: transferred.resource, lease: receiverLease })
  }
  function admitBackground(command: string, cwd = projectRoot): AdmittedNodeLaunch {
    const target = executionValue(captureNodeTarget({
      executionContext: context,
      executable: '/bin/bash', argv: ['-c', command], shellCommandBytes: command,
      cwd, branchId: 'background.attached', family: 'background-job', processType: 'BACKGROUND',
      adapterOptions: { stdio: 'owned-log-fd', detached: process.platform !== 'win32', shell: false, windowsHide: false },
    }))
    const launch = executionValue(execution.prepareTarget({ target }))
    const permit = executionValue(launch.admitSync()).permit
    return Object.freeze({ launch, permit })
  }
  let disposed = false
  function dispose() {
    if (disposed) return
    disposed = true
    options.signal?.removeEventListener('abort', forwardAbort)
    stop.abort(new Error('Terminal fixture disposed'))
    for (const receiver of receiverStops) receiver.abort(new Error('Terminal receiver fixture disposed'))
    retainControlTrace({
      kind: 'execution-host-control', configurationSnapshotId: snapshotId, home,
      policyInputs, events,
      observationOrigin: 'See the corresponding test; injected events and real children are distinct controls',
      doesNotCertify: ['B19 acceptance', 'B02 registration', 'stored B18 approval consumption', 'B20 process death or cleanup'],
    })
    rmSync(scratch, { recursive: true, force: true })
  }
  return {
    context, authority, owner, registeredOwner, budget, request, lifetime,
    events, policyInputs, environment, clock, scheduler, home, xdg,
    getTerminalLaunchMetadata, prepareTransferredLaunch, admitBackground, dispose,
  }
}
