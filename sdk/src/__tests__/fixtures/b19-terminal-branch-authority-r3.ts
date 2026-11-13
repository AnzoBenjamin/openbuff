import { spyOn } from 'bun:test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as commonExecution from '@codebuff/common/util/execution-context'
import * as sdkHostExecution from '../../host-execution'
import { OpenbuffClient } from '../../client'
import { CREDENTIAL_ENV_KEYS } from '../../credential-env-keys'
import { nodeConfigReadFs } from '../../host-config'
import { classifyCapturedTargetForExecution } from '../../services/harness-enforcement'
import { createNodeFileSystem } from '../../tools/node-filesystem'
import { WorkspaceJournalService } from '../../services/workspace-journal'
import { WorkspaceMutationBroker } from '../../services/workspace-mutation-broker'
import { createBranchProcessRecorderR3 } from './b19-terminal-branch-process-r3'

import type {
  AbsoluteDeadline, Clock, ExecutionAdapterContext, HostAuthority,
  HostAuthorityInputs, LaunchEvent, LaunchFacts, Limit, PolicyInput, PreparedLaunch,
  ProfileRequest, Refusal, Result, Scheduler, TargetDescription,
} from '@codebuff/common/types/contracts/execution-context'
import type { AgentDefinition, ToolCall } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { ExecutionScope, RunHostServices } from '../../host-execution'
import type { HostConfigurationInputs } from '../../host-config'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { OpenbuffClientOptions } from '../../run'
import type { CapturedTerminalLaunchMetadata } from '../../tools/run-terminal-command'

export const branchControlStatesR3 = [
  'happy', 'denied', 'unavailable', 'pre-aborted', 'deadline-zero',
  'delayed-authorizer-cancellation', 'exhausted-before-later-branch',
] as const
export type BranchControlStateR3 = typeof branchControlStatesR3[number]

export type TerminalBranchCaseR3 = Readonly<{
  id: string
  branchId: string
  producerId: string
  route: 'sdk-run' | 'direct-consumer' | 'supplemental-direct-adapter'
  scenario: string
  phase?: string
  mode?: 'assistant' | 'user'
  worktree?: 'changed' | 'clean'
  origin?: 'action' | 'host-operation' | 'host-observation'
  sourceFile?: string
  hookTimeout?: number
  sdkActionTool?: string
  targetOccurrence?: number
  supportsEarlierBranchExhaustion?: boolean
  keepTargetOpen?: boolean
  rootUnbounded?: boolean
  note?: string
}>

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}
const unbounded: Limit = { kind: 'unbounded' }
const finiteRoot: Limit = { kind: 'finite', durationMs: 60_000 }

/** One private monotonic domain; advancing it never rewrites any deadline. */
function controlledClock(base: Clock) {
  let offset = 0
  let timerId = 0
  const tasks = new Map<number, { expiresAt: number; callback(): void }>()
  const clock: Clock = { domainId: base.domainId, nowMs: () => base.nowMs() + offset }
  const scheduler: Scheduler = {
    set(delay, callback) {
      const id = ++timerId
      tasks.set(id, { expiresAt: clock.nowMs() + delay, callback })
      return id
    },
    clear(timer) { tasks.delete(timer as number) },
  }
  function advance(ms: number) {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('Invalid control-clock advance')
    offset += ms
    for (;;) {
      const due = [...tasks].find(([, task]) => task.expiresAt <= clock.nowMs())
      if (!due) break
      tasks.delete(due[0])
      due[1].callback()
    }
  }
  return { clock, scheduler, advance, pendingTimers: () => tasks.size }
}

function retainedResult(result: unknown): unknown {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result
  const record = result as Record<string, unknown>
  if ('sessionState' in record && 'output' in record) {
    const state = record.sessionState as { mainAgentState?: { agentId?: string; runId?: string; workspaceState?: unknown } } | undefined
    return {
      output: record.output, runOutcome: record.runOutcome, actionOutcomes: record.actionOutcomes,
      sessionActor: state?.mainAgentState && { agentId: state.mainAgentState.agentId, runId: state.mainAgentState.runId,
        workspaceState: state.mainAgentState.workspaceState },
    }
  }
  if ('result' in record) return { ...record, result: retainedResult(record.result) }
  return result
}

export function createTerminalBranchFixtureR3(testCase: TerminalBranchCaseR3, state: BranchControlStateR3, inherited = true) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'b19-terminal-r3-'))
  const root = path.join(scratch, 'project')
  const home = path.join(scratch, 'empty-home')
  const xdg = path.join(scratch, 'empty-xdg')
  const processTmp = path.join(scratch, 'process-tmp')
  const stateDir = path.join(scratch, 'harness')
  for (const directory of [root, home, xdg, processTmp, stateDir, path.join(root, '.git')]) fs.mkdirSync(directory, { recursive: true })
  const sourceFile = testCase.sourceFile ?? 'tracked.ts'
  const diagnostic = testCase.branchId.startsWith('diagnostic.')
  const mutationContent = sourceFile.endsWith('.py') ? 'r3_diagnostic = 1\n'
    : sourceFile.endsWith('.rs') ? 'pub fn r3_diagnostic() -> u32 { 1 }\n'
    : sourceFile.endsWith('.go') ? 'package fixture\n\nconst R3Diagnostic = 1\n'
    : 'export const r3Diagnostic = 1;\n'
  fs.mkdirSync(path.dirname(path.join(root, sourceFile)), { recursive: true })
  fs.writeFileSync(path.join(root, 'tracked.ts'), 'export const tracked = 1\n')
  if (!testCase.branchId.endsWith('.baseline') && !testCase.branchId.endsWith('.after'))
    fs.writeFileSync(path.join(root, sourceFile), diagnostic ? mutationContent : sourceFile.endsWith('.php') ? '<?php echo 1;\n' : 'fixture source\n')
  if (testCase.branchId.includes('inferred-opt-in.per-file')) fs.writeFileSync(path.join(root, 'composer.json'), '{"name":"fixture/r3"}')
  else if (testCase.branchId.includes('inferred-opt-in.project'))
    fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"lint":"printf r3-inferred-hook"}}')

  const inferred = testCase.branchId.includes('inferred-opt-in')
  const hook = { name: 'r3-configured-hook', command: 'printf r3-configured-hook',
    runPerFile: testCase.branchId.endsWith('per-file'),
    ...(testCase.hookTimeout !== undefined ? { timeoutSeconds: testCase.hookTimeout } : {}) }
  const fileChangeHooks = inferred ? [] : diagnostic || testCase.branchId.startsWith('hook.') ? [hook] : []
  const configFile = path.join(scratch, 'captured-host.json')
  fs.writeFileSync(configFile, JSON.stringify({ autoFileChangeHooks: inferred, fileChangeHooks, providers: {
    fixture: { type: 'openai-compatible', baseURL: 'https://r3-fixture.invalid/v1', models: ['r3-fixture-model'], apiKeyEnv: 'R3_PROVIDER_KEY' },
  } }))
  const environment: Record<string, string | undefined> = {
    PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    PROJECT_VALUE: 'r3-captured-public', DELETE_ME: 'r3-delete',
    OPENAI_API_KEY: 'r3-canonical-sentinel', R3_PROVIDER_KEY: 'r3-configured-sentinel',
    OPENBUFF_PROCESS_SUPERVISION: '0', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1',
    ...(diagnostic ? { OPENBUFF_DIAGNOSTIC_PREFLIGHT: '1' } : {}),
  }
  const childOverrides: Record<string, string | undefined> = {
    PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: xdg,
    PROJECT_VALUE: 'r3-explicit-public', DELETE_ME: undefined,
    OPENAI_API_KEY: 'r3-canonical-reinjection', R3_PROVIDER_KEY: 'r3-configured-reinjection',
  }
  const credentialNames = new Set([...CREDENTIAL_ENV_KEYS, 'R3_PROVIDER_KEY'])
  const expectedEnvironment: Record<string, string> = {}
  for (const [key, entry] of Object.entries({ ...(inherited ? environment : {}), ...childOverrides }))
    if (entry !== undefined && !credentialNames.has(key)) expectedEnvironment[key] = entry
  // runGitForSafety captures this public overlay for each selected safety branch.
  if (testCase.branchId.startsWith('terminal.safety.')) expectedEnvironment.GIT_OPTIONAL_LOCKS = '0'
  const hostConfiguration: HostConfigurationInputs = {
    environment, platform: 'linux', invocationCwd: root, projectRoot: root,
    home: { kind: 'none' }, globals: { kind: 'disabled' },
    selection: { kind: 'explicit', path: configFile, required: true },
    trust: { ancestorConfig: false, projectReadableRoots: false },
  }
  const stop = new AbortController()
  const requestStop = new AbortController()
  const events: LaunchEvent[] = []
  const callbacks: PrintModeEvent[] = []
  const sdkDiagnosticLogs: Array<{ level: 'warn' | 'error'; arguments: string[] }> = []
  let sdkDiagnosticLogsDropped = 0
  function logArgument(argument: unknown): string {
    try {
      const seen = new WeakSet<object>()
      return (JSON.stringify(argument, (_key, entry: unknown) => {
        if (entry instanceof Error) return { name: entry.name, message: entry.message, stack: entry.stack,
          ...('issues' in entry ? { issues: entry.issues } : {}) }
        if (entry && typeof entry === 'object') {
          if (seen.has(entry)) return '[circular]'
          seen.add(entry)
        }
        return entry
      }) ?? String(argument)).slice(0, 8192)
    } catch { return '[unserializable logger argument]' }
  }
  function retainDiagnosticLog(level: 'warn' | 'error', args: unknown[]) {
    if (sdkDiagnosticLogs.length >= 100) { sdkDiagnosticLogsDropped++; return }
    sdkDiagnosticLogs.push({ level, arguments: args.slice(0, 8).map(logArgument) })
  }
  const logger: Logger = {
    debug() {}, info() {},
    warn(...args: unknown[]) { retainDiagnosticLog('warn', args) },
    error(...args: unknown[]) { retainDiagnosticLog('error', args) },
  }
  const policyInputs: PolicyInput[] = []
  const policyObservedAtMs = new Map<string, number>()
  const contexts: Array<{
    label: string; context: ExecutionAdapterContext; authority: HostAuthority
    initialCorrelation: PolicyInput['facts']['correlation']; initialDeadline: AbsoluteDeadline
    remainingAtRegistration: Result<number | null>
  }> = []
  const hosts: RunHostServices[] = []
  const authorityInstances: HostAuthority[] = []
  const metadata = new Map<string, CapturedTerminalLaunchMetadata>()
  const configReads: string[] = []
  const consumerEntries: Array<{
    producerId: string; firstPolicyInput: number; afterPolicyInput?: number
    registeredCorrelation?: PolicyInput['facts']['correlation']; authenticContextRegistered: boolean
  }> = []
  const profile: ProfileRequest = Object.freeze({
    policy: testCase.branchId === 'terminal.safety.check' || testCase.branchId === 'terminal.safety.diff' ? 'git-commit' : 'full-access',
    preferredBackend: 'portable-ts', required: Object.freeze(['exact-env'] as const), allowBackendFallback: false,
  })
  const clocks: ReturnType<typeof controlledClock>[] = []
  const processRecorder = createBranchProcessRecorderR3({
    keepOpenBranch: testCase.keepTargetOpen ? testCase.branchId : undefined,
    reply(executable, argv) {
    if (executable === 'git') {
      // Only fixture reply selection strips guards; the recorder retains the dispatched vector.
      if (argv[0] === '--no-pager') argv = argv.slice(5)
      if (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') return { stdout: `${root}\n` }
      if (argv[0] === 'rev-parse' && argv[1] === '--git-common-dir') return { stdout: '.git\n' }
      if (argv[0] === 'rev-parse' && argv[1] === '--abbrev-ref') return { stdout: argv.includes('@{upstream}') ? 'origin/main\n' : 'r3-work\n' }
      if (argv[0] === 'branch' && argv[1] === '--show-current') return { stdout: 'r3-work\n' }
      if (argv[0] === 'rev-parse' && argv[1] === 'HEAD') return { stdout: `${'a'.repeat(40)}\n` }
      if (argv[0] === 'rev-parse' && argv[1]?.includes('HEAD~1')) return { stdout: `${'b'.repeat(40)}\n` }
      if (argv[0] === 'rev-parse' && argv[1] === '--verify') return { stdout: `${'b'.repeat(40)}\n` }
      if (argv[0] === 'merge-base') return { stdout: `${'b'.repeat(40)}\n` }
      if (argv[0] === 'symbolic-ref') return testCase.branchId === 'bundle.security-parent'
        ? { exitCode: 1, stderr: 'r3 fixture has no default remote reference' } : { stdout: 'origin/main\n' }
      if (argv[0] === 'status') {
        if (argv.includes('-z')) return { stdout: testCase.worktree === 'clean' ? '' : ' M tracked.ts\0' }
        if (argv.includes('--porcelain')) return { stdout: '' }
        return { stdout: '## r3-work\n' }
      }
      if (argv[0] === 'diff' && argv.includes('HEAD~1')) return { stdout: 'diff --git a/tracked.ts b/tracked.ts\n--- a/tracked.ts\n+++ b/tracked.ts\n@@ -1 +1 @@\n-export const tracked = 0\n+export const tracked = 1\n' }
      return { stdout: '' }
    }
    if (executable === 'eslint' || executable === 'ruff') return { stdout: '[]' }
    if (executable === 'pyright') return { stdout: '{"generalDiagnostics":[]}' }
    if (executable === 'cargo') return { stdout: '{"reason":"build-finished","success":true}\n' }
    if (executable === 'semgrep') return { stdout: argv.includes('--version') ? '1.0.0-r3' : '{"results":[],"errors":[],"version":"1.0.0-r3"}' }
    return { stdout: '' }
  } })
  let armed = true
  let targetPolicies = 0
  let earlierDispatchCountAtControl: number | undefined
  let controlInput: PolicyInput | undefined
  let entered!: () => void
  let openGate!: () => void
  let policyReleased = false
  let selectedPolicyCompleted = false
  let finishSelectedPolicy!: () => void
  const release = () => { policyReleased = true; openGate() }
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { openGate = resolve })
  const policyFinished = new Promise<void>(resolve => { finishSelectedPolicy = resolve })
  const matches = (input: PolicyInput) => input.facts.branchId === testCase.branchId &&
    (!testCase.phase || input.target.adapterOptions.phase === testCase.phase) &&
    (!testCase.origin || input.facts.correlation.kind === testCase.origin)
  function remember(input: PolicyInput, observedAtMs: number) {
    policyInputs.push(input)
    policyObservedAtMs.set(input.facts.launchId, observedAtMs)
    metadata.set(input.facts.launchId, {
      requiresCommitSafety: input.classification.effects.some(effect => effect.action === 'commit'),
      harnessEffects: input.classification.effects, harnessParseStatus: input.classification.parseStatus,
      executionBindingVersion: 2, executionBindingDigest: input.bindingDigest,
    })
  }
  function record(event: LaunchEvent) {
    events.push(event)
    if (event.phase === 'dispatched') processRecorder.bindDispatch(event.facts)
  }
  function control(input: PolicyInput): Refusal | undefined {
    if (!armed || !matches(input)) return undefined
    targetPolicies++
    if (targetPolicies !== (testCase.targetOccurrence ?? 1)) return undefined
    controlInput = input
    earlierDispatchCountAtControl = processRecorder.calls.length
    if (state === 'denied' || state === 'unavailable') return { ok: false, reason: state, cause: `R3 ${state} control at ${testCase.id}` }
    return undefined
  }
  const isSelectedControl = (input: PolicyInput) => armed && controlInput === input
  function wrapInputs(inputs: HostAuthorityInputs): HostAuthorityInputs {
    const clock = controlledClock(inputs.clock)
    clocks.push(clock)
    return { ...inputs, clock: clock.clock, scheduler: clock.scheduler,
      authorizeAsync: async input => {
        remember(input, clock.clock.nowMs())
        const refusal = control(input)
        if (refusal) return refusal
        if (isSelectedControl(input) && state === 'delayed-authorizer-cancellation') {
          entered()
          await gate
        }
        if (isSelectedControl(input) && state === 'exhausted-before-later-branch') {
          // Let already-started sibling helpers reach their own dispatch first.
          for (let turn = 0; processRecorder.calls.length === 0 && turn < 16; turn++) await Promise.resolve()
          earlierDispatchCountAtControl = processRecorder.calls.length
          clock.advance(120_000)
        }
        if (isSelectedControl(input) && state === 'delayed-authorizer-cancellation') {
          try { return await inputs.authorizeAsync(input) }
          finally { selectedPolicyCompleted = true; finishSelectedPolicy() }
        }
        return inputs.authorizeAsync(input)
      },
      authorizeSync: input => {
        remember(input, clock.clock.nowMs())
        const refusal = control(input)
        if (refusal) return refusal
        return inputs.authorizeSync?.(input) ?? { ok: false, reason: 'unavailable', cause: 'R3 sync policy unavailable' }
      },
      record: event => { record(event); inputs.record(event) },
    }
  }
  function captureContext(authority: HostAuthority, label: string, context: ExecutionAdapterContext) {
    const registration = value(authority.actionRegistration(context.execution))
    contexts.push({ label, context, authority, initialCorrelation: registration.correlation,
      initialDeadline: authority.deadline(registration.budget), remainingAtRegistration: authority.remainingMs(registration.budget) })
    return context
  }
  function observeScope(authority: HostAuthority, scope: ExecutionScope): ExecutionScope {
    return Object.freeze({ ...scope,
      action(input: Parameters<ExecutionScope['action']>[0]) {
        const result = scope.action(input)
        if (result.ok) captureContext(authority, `sdk-action:${input.actionId}`, result.value)
        return result
      },
      operation(input?: Parameters<ExecutionScope['operation']>[0]) {
        const result = scope.operation(input)
        if (result.ok) captureContext(authority, 'sdk-host-operation', result.value)
        return result
      },
    })
  }
  const restorers: Array<() => void> = []
  let networkAttempts = 0
  let directContext: ExecutionAdapterContext | undefined
  let directRefusal: Refusal | undefined
  let directAuthority: HostAuthority | undefined
  let directBudget: Parameters<HostAuthority['registerRequest']>[0]['budget'] | undefined
  let directOwner: Parameters<HostAuthority['registerAction']>[0]['owner'] | undefined
  let snapshotId: string | undefined
  let receiverLifetime: Parameters<HostAuthority['registerOwner']>[0]['lifetime'] | undefined
  let receiverRegistration: Extract<ReturnType<HostAuthority['registerOwner']>, { ok: true }>['value'] | undefined

  function initialize() {
    const forbidNetwork = () => { networkAttempts++; throw new Error('Network forbidden in B19 R3 terminal controls') }
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => forbidNetwork(), { preconnect: forbidNetwork }))
    restorers.push(() => fetchSpy.mockRestore())
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = processTmp
    restorers.push(() => {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
    })
    if (testCase.route === 'sdk-run') {
      const createAuthority = commonExecution.createHostAuthority
      const commonSpy = spyOn(commonExecution, 'createHostAuthority').mockImplementation(inputs => {
        const authority = createAuthority(wrapInputs(inputs))
        authorityInstances.push(authority)
        return authority
      })
      restorers.push(() => commonSpy.mockRestore())
      const createHost = sdkHostExecution.createHostExecutionServices
      const sdkSpy = spyOn(sdkHostExecution, 'createHostExecutionServices').mockImplementation((options): Result<RunHostServices> => {
        const result = createHost(options)
        if (!result.ok) return result
        const host = result.value
        hosts.push(host)
        captureContext(host.execution, 'sdk-bootstrap', host.bootstrap)
        return { ok: true, value: Object.freeze({ ...host, get events() { return host.events }, registerRun(
          owner: Parameters<RunHostServices['registerRun']>[0], parent?: Parameters<RunHostServices['registerRun']>[1],
        ): Result<ExecutionScope> {
          const registered = host.registerRun(owner, parent)
          return registered.ok ? { ok: true, value: observeScope(host.execution, registered.value) } : registered
        } }) }
      })
      restorers.push(() => sdkSpy.mockRestore())
      if (testCase.producerId === 'sdk.broker-bootstrap' || testCase.producerId === 'sdk.journal-bootstrap') {
        const entry = (producerId: string, context?: ExecutionAdapterContext) => {
          const registration = context && hosts[0]?.execution.actionRegistration(context.execution)
          const captured = { producerId, firstPolicyInput: policyInputs.length,
            authenticContextRegistered: registration?.ok === true,
            ...(registration?.ok ? { registeredCorrelation: registration.value.correlation } : {}),
            afterPolicyInput: undefined as number | undefined }
          consumerEntries.push(captured)
          return captured
        }
        const createJournal = WorkspaceJournalService.create
        const journalSpy = spyOn(WorkspaceJournalService, 'create').mockImplementation(async params => {
          const captured = entry('sdk.journal-bootstrap', params.executionContext)
          try { return await createJournal.call(WorkspaceJournalService, params) }
          finally { captured.afterPolicyInput = policyInputs.length }
        })
        restorers.push(() => journalSpy.mockRestore())
        const createBroker = WorkspaceMutationBroker.create
        const brokerSpy = spyOn(WorkspaceMutationBroker, 'create').mockImplementation(async options => {
          const captured = entry('sdk.broker-bootstrap', options.executionContext)
          try { return await createBroker.call(WorkspaceMutationBroker, options) }
          finally { captured.afterPolicyInput = policyInputs.length }
        })
        restorers.push(() => brokerSpy.mockRestore())
      }
      return
    }
    const base: Clock = { domainId: `r3-direct:${randomUUID()}`, nowMs: () => 100 }
    snapshotId = `r3-direct-snapshot:${randomUUID()}`
    const inputs: HostAuthorityInputs = {
      configuration: { snapshotId, trustPolicyId: 'r3-explicit-fixture-policy', rosterId: 'r3-captured-roster',
        canonicalCredentialNames: CREDENTIAL_ENV_KEYS, configuredCredentialNames: ['R3_PROVIDER_KEY'] },
      childInheritanceEnvironment: environment, childOverrides, inheritEnv: inherited, platform: 'linux',
      clock: base, scheduler: { set() { throw new Error('Control scheduler must replace direct scheduler') }, clear() {} },
      resolveProfile: sdkHostExecution.resolvePortableProfile, classifyTarget: classifyCapturedTargetForExecution,
      authorizeAsync: async () => ({ ok: true, basis: 'explicit-policy', decisionId: `r3-direct-policy:${randomUUID()}` }),
      authorizeSync: () => ({ ok: true, basis: 'explicit-sync-policy', decisionId: `r3-direct-sync:${randomUUID()}` }),
      isCurrentBasis: () => true, record() {},
    }
    const controlled = wrapInputs(inputs)
    const authority = commonExecution.createHostAuthority(controlled)
    directAuthority = authority
    authorityInstances.push(authority)
    const boundary = value(commonExecution.captureRootDeadline({ clock: controlled.clock,
      limit: state === 'deadline-zero' ? { kind: 'finite', durationMs: 1 } : testCase.rootUnbounded ? unbounded : finiteRoot }))
    const lifetime = authority.registerRootLifetime({ boundary, signal: stop.signal })
    if (!lifetime.ok) { directRefusal = lifetime; return }
    const registration = value(authority.registerOwner({ description: { kind: 'host', hostId: `r3-direct:${randomUUID()}` }, lifetime: lifetime.value }))
    directOwner = registration.owner
    directBudget = value(authority.registerHostOperation({ owner: directOwner, parent: lifetime.value,
      purpose: 'direct-host-operation', limit: unbounded }))
    const request = value(authority.registerRequest({ budget: directBudget, signal: requestStop.signal }))
    const execution = value(authority.bindAction({ owner: directOwner, budget: directBudget, request }))
    directContext = captureContext(authority, 'registered-direct-host-operation', Object.freeze({ execution, projectRoot: root,
      allowedPaths: Object.freeze([root]), profile, mode: testCase.mode ?? 'assistant', signal: execution.signal, spawn: processRecorder.spawn }))
    // Expire the authentic positive deadline at exact zero remaining before entry.
    if (state === 'deadline-zero') clocks[0].advance(1)
    if (state === 'pre-aborted') requestStop.abort(new Error('R3 request pre-aborted before direct consumer entry'))
  }

  function prepareTransferredLaunch(target: TargetDescription): Result<PreparedLaunch> {
    if (!directAuthority || !directOwner || !directBudget || !snapshotId) return { ok: false, reason: 'unavailable', cause: 'R3 direct authority unavailable' }
    const authority = directAuthority
    const destination = value(authority.registerDestination({ snapshotId, origin: 'host',
      resolved: { kind: 'executable', command: target.executable, args: target.argv, declaredEnv: {} } }))
    const resource = value(authority.registerResource({ owner: directOwner, lifetime: directBudget, resourceSignal: directContext?.signal,
      destination, launchTemplate: target, reuse: 'none', restartPolicy: { kind: 'none' } }))
    const request = value(authority.registerRequest({ budget: directBudget, signal: requestStop.signal }))
    const lease = value(authority.acquireLease({ owner: directOwner, resource, request }))
    if (!receiverRegistration || !receiverLifetime) {
      receiverLifetime = value(authority.registerRootLifetime({ boundary: value(commonExecution.captureRootDeadline({ clock: clocks[0].clock, limit: unbounded })) }))
      receiverRegistration = value(authority.registerOwner({ description: { kind: 'session', clientSessionId: 'r3-direct-session', ownerId: `r3-receiver:${randomUUID()}` }, lifetime: receiverLifetime }))
    }
    const offer = value(authority.offerTransfer({ resource, sender: directOwner, receiver: receiverRegistration.owner, request,
      expectedGeneration: value(authority.resourceGeneration(resource)) }))
    const accepted = value(authority.acceptTransfer({ offer, receiver: receiverRegistration.receiver }))
    const transferred = value(authority.commitTransfer(accepted))
    authority.releaseLease(lease)
    const budget = value(authority.registerHostOperation({ owner: receiverRegistration.owner, parent: receiverLifetime,
      purpose: 'direct-host-operation', limit: unbounded }))
    // Sender cancellation governs this admission wait/lease. Transfer already
    // gave the resource an independent receiving lifetime.
    const receiverRequest = value(authority.registerRequest({ budget, signal: directContext?.signal }))
    const receivingLease = value(authority.acquireLease({ owner: receiverRegistration.owner, resource: transferred.resource, request: receiverRequest }))
    return authority.prepareLaunch({ resource: transferred.resource, request: receiverRequest, budget, lease: receivingLease })
  }

  async function runSdk(program: AgentDefinition) {
    if (state === 'pre-aborted') stop.abort(new Error('R3 SDK root signal pre-aborted before run entry'))
    const options: OpenbuffClientOptions = {
      cwd: root, hostConfiguration,
      configReadFs: { ...nodeConfigReadFs, readFile(file) { configReads.push(file); return nodeConfigReadFs.readFile(file) } },
      projectFiles: {}, knowledgeFiles: {}, harnessStateDir: stateDir,
      ...(testCase.producerId === 'sdk.broker-bootstrap' ? {} : { fsSource: createNodeFileSystem() }),
      spawnSource: processRecorder.spawn, env: childOverrides, inheritEnv: inherited,
      executionProfile: profile, approvalMode: 'allow-all', logger,
      runTimeoutMs: state === 'deadline-zero' ? 0 : testCase.rootUnbounded ? undefined : 60_000,
      recordExecution: () => { /* The genuine common recorder already retained this exact event. */ },
      handleEvent: event => { callbacks.push(event) },
    }
    const client = new OpenbuffClient(options)
    return client.run({ agent: program, prompt: JSON.stringify({ testCase, sourceFile, mutationContent }), signal: stop.signal })
  }
  function privateRegistrations() {
    return contexts.map(({ label, context, authority, initialCorrelation, initialDeadline, remainingAtRegistration }) => {
      const registration = authority.actionRegistration(context.execution)
      if (!registration.ok) return { label, initialCorrelation, initialDeadline, remainingAtRegistration, currentLookupRefusal: registration,
        requestSignalPresent: context.signal !== undefined, requestSignalAborted: context.signal?.aborted }
      return {
        label, initialCorrelation, initialDeadline, remainingAtRegistration, correlation: registration.value.correlation,
        deadline: authority.deadline(registration.value.budget),
        remaining: authority.remainingMs(registration.value.budget),
        requestSignalPresent: context.signal !== undefined,
        requestSignalAborted: context.signal?.aborted,
        registeredSignalSameAsContext: registration.value.signal === context.signal,
      }
    })
  }
  function persist(result: unknown, outcome: 'passed' | 'failed', error?: unknown,
    observationOrigin = 'actual-consumer-with-authentic-authority-and-injected-node-frames') {
    const directory = process.env.B19_TERMINAL_BRANCH_R3_EVIDENCE_DIR
    if (!directory) return
    const ownedRuns = path.resolve(import.meta.dir, '../../../../docs/execution/body-roadmap/evidence/B19/implementation/branch-controls-r3/terminal/runs')
    const resolved = path.resolve(directory)
    if (!resolved.startsWith(`${ownedRuns}${path.sep}`)) throw new Error('R3 capture directory is outside the owned terminal runs')
    fs.mkdirSync(resolved, { recursive: true })
    fs.appendFileSync(path.join(resolved, 'branch-control-captures.jsonl'), `${JSON.stringify({
      fixtureCase: testCase, state, inherited, outcome,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
      capturedHostConfiguration: { selection: hostConfiguration.selection, projectRoot: root },
      configReads, consumerEntries, expectedEnvironment, controlInput,
      earlierDispatchCountAtControl, privateRegistrations: privateRegistrations(),
      policyInputs, policyObservedAtMs: Object.fromEntries(policyObservedAtMs), events,
      sdkDiagnosticLogs, sdkDiagnosticLogsDropped,
      sdkDiagnosticLogBounds: { entries: 100, argumentsPerEntry: 8, charactersPerArgument: 8192 },
      sdkToolCallbacks: callbacks.filter(event => event.type === 'tool_result'),
      adapterCalls: processRecorder.snapshot().map(call => {
        const input = policyInputs.find(candidate => candidate.facts.launchId === call.launchId)
        const request = input && contexts.find(context => JSON.stringify(context.initialCorrelation) === JSON.stringify(input.facts.correlation))
        const actualCall = processRecorder.calls.find(candidate => candidate.launchId === call.launchId)
        return { ...call, originatingRequestSignalPresent: request?.context.signal !== undefined,
          originatingRequestSignalAbortedAtCapture: request?.context.signal?.aborted,
          resourceSignalEqualsOriginatingRequestSignal: actualCall?.resourceSignal && request?.context.signal
            ? actualCall.resourceSignal === request.context.signal : null }
      }),
      result: retainedResult(result),
      sdkHostCreationCount: hosts.length, authenticAuthorityCreationCount: authorityInstances.length,
      networkAttempts, directRegistrationRefusal: directRefusal, policyReleased, selectedPolicyCompleted,
      observationOrigin,
      doesNotCertify: ['OS process creation', 'B02 authority for direct fixture IDs', 'B18 stored approval consumption', 'B20 cleanup', 'B19 acceptance'],
    })}\n`)
  }
  let disposed = false
  function dispose() {
    if (disposed) return
    disposed = true
    release()
    stop.abort(new Error('R3 owned fixture disposed'))
    requestStop.abort(new Error('R3 owned direct request disposed'))
    processRecorder.close()
    for (const restore of restorers.reverse()) restore()
    fs.rmSync(scratch, { recursive: true, force: true })
    if (networkAttempts !== 0) throw new Error(`R3 fixture attempted ${networkAttempts} network calls`)
  }
  try { initialize() }
  catch (error) {
    const secondaryErrors: unknown[] = []
    try {
      persist({ initializationFailed: true, consumerInvoked: false }, 'failed', error,
        'fixture-initialization-failure-before-consumer-entry')
    } catch (captureError) { secondaryErrors.push(captureError) }
    try { dispose() } catch (disposeError) { secondaryErrors.push(disposeError) }
    if (secondaryErrors.length !== 0) {
      throw new AggregateError([error, ...secondaryErrors],
        'R3 fixture initialization failed; capture or cleanup also failed', { cause: error })
    }
    throw error
  }
  return {
    testCase, state, root, sourceFile, environment, childOverrides, expectedEnvironment, hostConfiguration,
    configReads, consumerEntries, profile, stop, requestStop, processRecorder, events, callbacks, policyInputs, policyObservedAtMs, contexts, hosts,
    capturedHookConfiguration: { autoFileChangeHooks: inferred, fileChangeHooks },
    get context() { return directContext }, get registrationRefusal() { return directRefusal },
    get controlInput() { return controlInput }, get earlierDispatchCountAtControl() { return earlierDispatchCountAtControl },
    get policyReleased() { return policyReleased },
    getTerminalLaunchMetadata: (launchId: string) => metadata.get(launchId),
    prepareTransferredLaunch, runSdk, ready, release, policyFinished,
    arm() { armed = true; targetPolicies = 0; controlInput = undefined },
    disarm() { armed = false },
    exhaust() { for (const clock of clocks) clock.advance(120_000) },
    privateRegistrations, persist, dispose,
    matches,
    networkAttempts: () => networkAttempts,
  }
}

export type TerminalBranchFixtureR3 = ReturnType<typeof createTerminalBranchFixtureR3>

/** A self-contained trusted generator uses real SDK dispatch and never calls an LLM. */
export function branchProgramR3(handleSteps: NonNullable<AgentDefinition['handleSteps']>): AgentDefinition {
  return {
    id: 'b19-r3-terminal-branch-program', displayName: 'B19 R3 local branch consumer', model: 'r3-fixture-model',
    toolNames: ['run_terminal_command', 'run_file_change_hooks', 'git_status', 'inspect_workspace', 'get_change_review_bundle',
      'run_targeted_validation', 'write_file', 'read_files', 'set_output'],
    outputMode: 'structured_output', handleSteps,
  }
}

export function branchCallR3(toolName: string, input: unknown): ToolCall {
  return { toolName, input } as ToolCall
}

export function deadlineMsR3(deadline: AbsoluteDeadline) {
  return deadline.kind === 'finite' ? deadline.expiresAtMs : null
}
