import { AsyncLocalStorage } from 'node:async_hooks'
import * as childProcess from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as commonExecution from '@codebuff/common/util/execution-context'
import { spyOn } from 'bun:test'
import { z } from 'zod/v4'

import { OpenbuffClient } from '../../client'
import { getCustomToolDefinition } from '../../custom-tool'
import {
  getCapturedProviderConfig,
  loadHostConfigSnapshot,
  nodeConfigReadFs,
} from '../../host-config'
import * as hostModule from '../../host-execution'
import * as runtimeModule from '../../impl/agent-runtime'
import * as modelModule from '../../impl/model-provider'
import * as providerModule from '../../provider-config'
import { HarnessApprovalService } from '../../services/harness-enforcement'
import { LocalHarnessStore } from '../../services/local-harness-store'
import { runToolchainNode } from '../../services/toolchain-execution'
import { createNodeFileSystem } from '../../tools/node-filesystem'

import type { ConfigReadFs } from '../../provider-config'
import type { ApprovalRecord } from '../../services/harness-enforcement'
import type {
  AgentDefinition,
  ToolCall,
} from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type {
  AsyncDecision,
  ExecutionAdapterContext,
  HostAuthorityInputs,
  LaunchEvent,
  PolicyInput,
  PreparedLaunch,
  ProfileRequest,
  Result,
  StoredExecutionAuthorityV2,
  TargetDescription,
  TargetPermit,
} from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

export const ORACLE_PROFILE: ProfileRequest = {
  policy: 'full-access',
  preferredBackend: 'portable-ts',
  required: ['exact-env'],
  allowBackendFallback: false,
}
export function value<T>(
  result: Result<T> | { ok: false; reason: string; cause: string },
): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}
export function temporaryRoot() {
  return mkdtempSync(path.join(tmpdir(), 'b19-launch-oracle-'))
}

/** Actual SDK host policy; omission removes only the core asynchronous authorizer. */
export function oracleHost(
  root: string,
  options: Partial<hostModule.HostExecutionOptions> = {},
  missingAuthorizer = false,
) {
  const home = path.join(root, 'empty-home'),
    xdg = path.join(root, 'empty-xdg')
  mkdirSync(home, { recursive: true })
  mkdirSync(xdg, { recursive: true })
  const captured = loadHostConfigSnapshot({
    inputs: {
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        PROJECT_VALUE: 'oracle-public',
        OPENAI_API_KEY: 'oracle-secret',
      },
      platform: 'linux',
      invocationCwd: root,
      projectRoot: root,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'none' },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
    fs: nodeConfigReadFs,
  })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  const stop = new AbortController(),
    clock = { domainId: `oracle:${root}`, nowMs: () => 100 }
  const events: LaunchEvent[] = []
  const policyInputs: PolicyInput[] = []
  const policyDecisions: AsyncDecision[] = []
  const original = commonExecution.createHostAuthority
  const capture = spyOn(
    commonExecution,
    'createHostAuthority',
  ).mockImplementation((inputs) => {
    const authorize = inputs.authorizeAsync
    return original({
      ...inputs,
      authorizeAsync: missingAuthorizer
        ? (undefined as unknown as HostAuthorityInputs['authorizeAsync'])
        : async (input) => {
            policyInputs.push(input)
            const decision = await authorize(input)
            policyDecisions.push(decision)
            return decision
          },
    })
  })
  let created: Result<hostModule.RunHostServices>
  try {
    created = hostModule.createHostExecutionServices({
      snapshot: captured.snapshot,
      clock,
      boundary: value(
        commonExecution.captureRootDeadline({
          clock,
          limit: { kind: 'unbounded' },
        }),
      ),
      childInheritanceEnvironment: captured.snapshot.inputs.environment,
      profile: ORACLE_PROFILE,
      approvalMode: 'allow-all',
      signal: stop.signal,
      record: (event) => events.push(event),
      ...options,
    })
  } finally {
    capture.mockRestore()
  }
  const shared = {
    snapshot: captured.snapshot,
    events,
    policyInputs,
    policyDecisions,
    stop,
    close: () => stop.abort(new Error('Oracle host closed')),
  }
  if (!created.ok) return { ...shared, ...created }
  const host = created.value
  const context = value(host.directOperation()).executionContext
  return { ...shared, ok: true as const, value: { host, context } }
}
export function target(
  root: string,
  extra: Partial<TargetDescription> = {},
): TargetDescription {
  return {
    executable: 'git',
    argv: ['status', '--short'],
    cwd: root,
    projectRoot: root,
    allowedPaths: [root],
    profile: ORACLE_PROFILE,
    mode: 'assistant',
    processType: 'SYNC',
    family: 'sync-shell',
    branchId: 'terminal.sync',
    adapterOptions: { runtime: 'node', shell: false, stdio: 'pipe' },
    ...extra,
  }
}

/** Real OS child evidence; omitting registry start observation is an explicit uncertainty control. */
export function dispatchOracleChild(
  launch: PreparedLaunch,
  permit: TargetPermit,
  observeStart = true,
) {
  return value(
    launch.dispatchNow(permit, (input, observer) => {
      const child = childProcess.spawn(input.executable, input.argv, {
        cwd: input.cwd,
        env: input.env,
        signal: input.resourceSignal,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '',
        stderr = '',
        errorCode: string | undefined
      child.stdout!.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr!.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.once('spawn', () => {
        if (observeStart)
          value(
            observer.spawnObserved({
              source: 'node-spawn-event',
              pid: child.pid!,
            }),
          )
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        errorCode = error.code
        value(
          observer.failure({
            source: 'node-error-event',
            errorCode: error.code,
            cause: error.message,
          }),
        )
      })
      const closed = new Promise<{
        exitCode: number | null
        signal: NodeJS.Signals | null
        stdout: string
        stderr: string
        errorCode: string | undefined
        pid: number | undefined
        environment: NodeJS.ProcessEnv
      }>((resolve) => {
        child.once('close', (exitCode, signal) =>
          resolve({
            exitCode,
            signal,
            stdout,
            stderr,
            errorCode,
            pid: child.pid,
            environment: { ...input.env },
          }),
        )
      })
      return { child, closed }
    }),
  ).handle
}

export const RETRY_OUTCOMES = [
  'ENOENT',
  'failing-child',
  'unobserved-child',
] as const

/** Fresh fixture user decisions create exact grants; the real host consumes each chosen B18 grant. */
export async function runFreshHighImpactRetries(
  outcome: (typeof RETRY_OUTCOMES)[number],
) {
  const root = temporaryRoot()
  const store = new LocalHarnessStore(path.join(root, 'store'))
  const service = new HarnessApprovalService(store)
  const scope = {
    repositoryId: 'oracle-repository',
    workspaceId: 'oracle-workspace',
    runId: 'oracle-run',
    snapshotId: 'oracle-snapshot',
  }
  const decisions: Array<{
    bindingDigest: string
    grantId: string
    decision: 'explicit-user-allow'
  }> = []
  const grants: ApprovalRecord[] = [],
    preflights: Array<{
      grantId: string
      before: object
      after: object
      launchId: string
      result: object
    }> = []
  const requests: PolicyInput[] = []
  let approveFreshBinding = true,
    declinedPrompts = 0,
    oldBindingGrant: ApprovalRecord | undefined
  let context: ExecutionAdapterContext
  const fixture = oracleHost(root, {
    approvalMode: 'strict',
    resolveApprovalContext: async (input) => {
      requests.push(input)
      if (approveFreshBinding) {
        const requested = approvalRequest(input)
        const grant = service.grant(scope, requested)
        grants.push(grant)
        decisions.push({
          bindingDigest: input.bindingDigest,
          grantId: grant.id,
          decision: 'explicit-user-allow',
        })
        oldBindingGrant ??= service.grant(scope, requested)
        const before = store.read(scope.repositoryId, 'approvals', grant.id)!
        const result = await runToolchainNode({
          context,
          branchId: `version.git.preflight-${grants.length}`,
          argv: ['/usr/bin/git', '--version'],
          cwd: root,
          timeoutMs: 2000,
          maxBufferBytes: 1024,
        })
        const after = store.read(scope.repositoryId, 'approvals', grant.id)!
        const preflight = fixture.events.findLast(
          (event): event is Extract<LaunchEvent, { phase: 'spawn-observed' }> =>
            event.phase === 'spawn-observed' &&
            event.facts.branchId.startsWith('version.git.preflight-'),
        )
        if (!preflight) throw new Error('The real Git preflight did not start')
        preflights.push({
          grantId: grant.id,
          before,
          after,
          launchId: preflight.facts.launchId,
          result,
        })
      }
      return {
        service,
        ...scope,
        receiptIds: [
          ...grants.map((grant) => grant.id),
          ...(oldBindingGrant ? [oldBindingGrant.id] : []),
        ],
        isCurrent: () => true,
      }
    },
    requestApproval: async () => {
      declinedPrompts++
      return false
    },
  })
  scope.snapshotId = fixture.snapshot.snapshotId
  const { host } = value(fixture)
  const owner = {
    clientSessionId: 'oracle-client',
    rootRunId: scope.runId,
    parentRunId: scope.runId,
    parentAgentId: 'oracle-agent',
  }
  const run = value(host.registerRun(owner))
  const selected = target(root, {
    executable:
      outcome === 'ENOENT' ? path.join(root, 'missing', 'git') : '/usr/bin/git',
    argv: ['commit', '-m', 'b19 exact retry message'],
  })
  const attempts: Array<{
    facts: ReturnType<PreparedLaunch['facts']>
    admission: object
    child?: Awaited<ReturnType<typeof dispatchOracleChild>['closed']>
  }> = []
  try {
    async function attempt(number: number, dispatch: boolean) {
      context = value(
        run.action({
          actionId: 'oracle-commit',
          attemptId: `attempt-${number}`,
          basisId: 'unchanged-workspace',
          limit: { kind: 'finite', durationMs: 5000 },
        }),
      )
      const launch = value(
        context.execution.prepareTarget({ target: selected }),
      )
      const admitted = await launch.admit()
      let child:
        | Awaited<ReturnType<typeof dispatchOracleChild>['closed']>
        | undefined
      if (dispatch)
        child = await dispatchOracleChild(
          launch,
          value(admitted).permit,
          outcome !== 'unobserved-child',
        ).closed
      attempts.push({ facts: launch.facts(), admission: admitted, child })
      return { launch, admitted }
    }
    const first = await attempt(1, true)
    const firstPermit = value(first.admitted).permit
    const oldAdmission = await first.launch.admit()
    let repeatedDispatchCount = 0
    const oldDispatch = first.launch.dispatchNow(firstPermit, () => {
      repeatedDispatchCount++
    })
    let oldGrantError = ''
    try {
      service.consume({
        ...scope,
        ...approvalRequest(requests[0]),
        approvalId: grants[0].id,
      })
    } catch (error) {
      oldGrantError = (error as Error).message
    }
    approveFreshBinding = false
    await attempt(2, false)
    let oldBindingError = ''
    try {
      service.consume({
        ...scope,
        ...approvalRequest(requests[1]),
        approvalId: oldBindingGrant!.id,
      })
    } catch (error) {
      oldBindingError = (error as Error).message
    }
    approveFreshBinding = true
    await attempt(3, true)
    return {
      outcome,
      selected,
      decisions,
      attempts,
      preflights,
      requests,
      grants: grants.map((grant) =>
        store.read(scope.repositoryId, 'approvals', grant.id),
      ),
      oldBindingGrant: store.read(
        scope.repositoryId,
        'approvals',
        oldBindingGrant!.id,
      ),
      declinedPrompts,
      oldAdmission,
      oldDispatch,
      oldGrantError,
      oldBindingError,
      repeatedDispatchCount,
      events: fixture.events,
      policyDecisions: fixture.policyDecisions,
      limits:
        outcome === 'unobserved-child'
          ? [
              'Real OS child exits, but this deliberate adapter control omits registry start observation.',
            ]
          : [],
    }
  } finally {
    fixture.close()
    rmSync(root, { recursive: true, force: true })
  }
}

function approvalRequest(input: PolicyInput) {
  const first = input.classification.effects[0]
  if (!first || first.action !== 'commit')
    throw new Error('Retry target must be classified as a high-impact commit')
  const executionAuthority: StoredExecutionAuthorityV2 = {
    version: 2,
    bindingFormat: 'openbuff.execution.v2',
    keyEpochId: input.binding.keyEpochId,
    bindingDigest: input.bindingDigest,
    binding: input.binding,
    usage: 'one-target-dispatch',
  }
  return {
    action: first.action,
    target: first.target,
    commandHash: input.binding.commandHash,
    executionAuthority,
  }
}

/** Two genuine serialized SDK strategies remain active while captured consumers run. */
export async function runConcurrentSdkScopes() {
  const directory = temporaryRoot(),
    labels = ['a', 'b'] as const
  const local = new AsyncLocalStorage<string>(),
    restorers: Array<() => void> = []
  const oldAmbient = process.env.OPENBUFF_PROVIDER_CONFIG
  const poison = path.join(directory, 'ambient-poison.json')
  writeFileSync(
    poison,
    JSON.stringify({
      defaultModel: 'ambient/poison',
      providers: {
        ambient: {
          type: 'openai-compatible',
          baseURL: 'https://ambient.invalid',
          models: ['poison'],
        },
      },
    }),
  )
  const hosts = new Map<string, hostModule.RunHostServices>()
  const runtimes = new Map<
    hostModule.RunHostServices,
    ReturnType<typeof runtimeModule.getAgentRuntimeImpl>
  >()
  const active = new Set<string>(),
    overlap: string[][] = []
  const children: childProcess.ChildProcess[] = [],
    closes: Promise<unknown>[] = []
  const running: Promise<void>[] = []
  let networkAttempts = 0,
    unattributedAmbientReads = 0,
    release!: () => void
  const bothEntered = new Promise<void>((resolve) => {
    release = resolve
  })
  const scopes = labels.map((label, index) => {
    const root = path.join(directory, label)
    const configFile = path.join(root, 'openbuff.json')
    const windowTokens = 32000 + index * 16000
    // Owned source configuration files are the only permitted config reads.
    mkdirSync(root, { recursive: true })
    writeFileSync(
      configFile,
      JSON.stringify({
        autoFileChangeHooks: false,
        defaultModel: `provider-${label}/selected`,
        providers: {
          [`provider-${label}`]: {
            type: 'openai-compatible',
            baseURL: `https://scope-${label}.invalid/v1`,
            apiKeyEnv: 'CUSTOM_PROVIDER_KEY',
            models: ['selected'],
            modelCapabilities: { selected: { context: { windowTokens } } },
          },
        },
      }),
    )
    const environment = {
      PATH: '/usr/bin:/bin',
      PROJECT_VALUE: `captured-${label}`,
      CUSTOM_PROVIDER_KEY: `scope-${label}-secret`,
      HOME: path.join(root, 'empty-home'),
      XDG_CONFIG_HOME: path.join(root, 'empty-xdg'),
      OPENBUFF_PROCESS_SUPERVISION: '0',
      OPENBUFF_TELEMETRY: '0',
      DO_NOT_TRACK: '1',
    }
    mkdirSync(environment.HOME)
    mkdirSync(environment.XDG_CONFIG_HOME)
    return {
      label,
      root,
      configFile,
      windowTokens,
      environment,
      explicitConfigReads: [] as string[],
      ambientConfigReads: [] as string[],
      entries: [] as object[],
      events: [] as LaunchEvent[],
      boundaries: [] as object[],
      result: undefined as
        | Awaited<ReturnType<OpenbuffClient['run']>>
        | undefined,
    }
  })
  function countAmbient(reason: string): never {
    const scope = scopes.find((scope) => scope.label === local.getStore())
    if (scope) scope.ambientConfigReads.push(reason)
    else unattributedAmbientReads++
    throw new Error(`Ambient config read forbidden: ${reason}`)
  }
  try {
    const createHost = hostModule.createHostExecutionServices
    const hostSpy = spyOn(
      hostModule,
      'createHostExecutionServices',
    ).mockImplementation((options) => {
      const result = createHost(options)
      if (result.ok)
        hosts.set(options.snapshot.inputs.projectRoot, result.value)
      return result
    })
    restorers.push(() => hostSpy.mockRestore())
    const createRuntime = runtimeModule.getAgentRuntimeImpl
    const runtimeSpy = spyOn(
      runtimeModule,
      'getAgentRuntimeImpl',
    ).mockImplementation((options) => {
      const runtime = createRuntime(options)
      if (options.hostServices) runtimes.set(options.hostServices, runtime)
      return runtime
    })
    restorers.push(() => runtimeSpy.mockRestore())
    const ambientSpy = spyOn(
      providerModule,
      'loadProviderConfigSync',
    ).mockImplementation(() => countAmbient('loadProviderConfigSync'))
    restorers.push(() => ambientSpy.mockRestore())
    const forbid = () => {
      networkAttempts++
      throw new Error(
        'Network/provider calls forbidden in concurrent SDK scopes',
      )
    }
    const networkSpy = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(async () => forbid(), { preconnect: forbid }),
    )
    restorers.push(() => networkSpy.mockRestore())
    process.env.OPENBUFF_PROVIDER_CONFIG = poison
    running.push(
      ...scopes.map((scope) =>
        local.run(scope.label, async () => {
          const reader: ConfigReadFs = {
            ...nodeConfigReadFs,
            readFile(file) {
              if (file !== scope.configFile) {
                scope.ambientConfigReads.push(file)
                throw new Error('Scope attempted an unowned config read')
              }
              scope.explicitConfigReads.push(file)
              return nodeConfigReadFs.readFile(file)
            },
          }
          const spawn: CodebuffSpawn = (command, argv, options) => {
            scope.boundaries.push({
              command,
              argv: [...(argv ?? [])],
              cwd: options?.cwd,
              env: { ...options?.env },
              signalPresent: !!options?.signal,
            })
            const child = childProcess.spawn(
              command,
              [...(argv ?? [])],
              options ?? {},
            )
            children.push(child)
            closes.push(new Promise((resolve) => child.once('close', resolve)))
            return child
          }
          const probe = getCustomToolDefinition({
            toolName: 'b19_oracle_scope_probe',
            description:
              'Exercise captured scope consumers while both public SDK runs remain active',
            inputSchema: z.object({}),
            execute: async () => {
              active.add(scope.label)
              if (active.size === 2) {
                overlap.push([...active].sort())
                release()
              }
              await bothEntered
              const asynchronousScope = local.getStore()
              if (asynchronousScope !== scope.label)
                throw new Error('SDK lost its asynchronous scope identity')
              const host = hosts.get(scope.root)
              if (!host) throw new Error('SDK host was not captured')
              const runtime = runtimes.get(host)
              if (!runtime) throw new Error('SDK runtime was not captured')
              scope.environment.PROJECT_VALUE = `mutated-${scope.label}`
              writeFileSync(
                scope.configFile,
                JSON.stringify({
                  defaultModel: 'ambient/poison',
                  providers: {},
                }),
              )
              const loaded = getCapturedProviderConfig(host.provider.snapshot)
              if (!runtime.resolveModelContextWindow)
                throw new Error(
                  'SDK runtime has no captured context-window resolver',
                )
              const resolved = runtime.resolveModelContextWindow({
                agentId: `b19-oracle-${scope.label}`,
              })
              const route = await modelModule.getModelForRequest({
                apiKey: '',
                model: `provider-${scope.label}/selected`,
                preferModelParam: true,
                providerContext: host.provider,
              })
              const capturedDefaultModel = loaded.config.defaultModel,
                provider = (route.model as { provider?: string }).provider,
                capturedEnvironment =
                  host.provider.snapshot.inputs.environment.PROJECT_VALUE
              if (
                capturedDefaultModel === undefined ||
                resolved === undefined ||
                provider === undefined ||
                capturedEnvironment === undefined
              )
                throw new Error(
                  'An actual SDK captured consumer returned incomplete scope evidence',
                )
              const observed = {
                label: scope.label,
                asynchronousScope,
                activeScopes: [...active].sort(),
                snapshotId: host.provider.snapshot.snapshotId,
                snapshotSources: loaded.sourceFilePaths,
                capturedDefaultModel,
                resolvedWindow: resolved,
                effectiveModel: route.effectiveModel,
                provider,
                capturedEnvironment,
              }
              scope.entries.push(observed)
              return [{ type: 'json', value: observed }]
            },
          })
          const command = `exec ${quote(process.execPath)} --no-env-file -e ${quote('process.stdout.write(process.env.PROJECT_VALUE)')}`
          const program: AgentDefinition = {
            id: `b19-oracle-${scope.label}`,
            displayName: 'Concurrent actual SDK scope',
            model: `provider-${scope.label}/selected`,
            toolNames: [
              'b19_oracle_scope_probe',
              'run_terminal_command',
              'set_output',
            ],
            outputMode: 'structured_output',
            handleSteps: function* ({ prompt }) {
              const { toolResult: probe } = yield {
                toolName: 'b19_oracle_scope_probe',
                input: {},
              } as unknown as ToolCall
              const { toolResult: terminal } = yield {
                toolName: 'run_terminal_command',
                input: { command: prompt!, process_type: 'SYNC' },
              }
              yield { toolName: 'set_output', input: { probe, terminal } }
            },
          }
          const client = new OpenbuffClient({
            cwd: scope.root,
            projectFiles: {},
            knowledgeFiles: {},
            harnessStateDir: path.join(scope.root, 'harness'),
            hostConfiguration: {
              environment: scope.environment,
              platform: 'linux',
              invocationCwd: scope.root,
              projectRoot: scope.root,
              home: { kind: 'none' },
              globals: { kind: 'disabled' },
              selection: {
                kind: 'explicit',
                path: scope.configFile,
                required: true,
              },
              trust: { ancestorConfig: false, projectReadableRoots: false },
            },
            configReadFs: reader,
            spawnSource: spawn,
            fsSource: createNodeFileSystem(),
            approvalMode: 'allow-all',
            executionProfile: ORACLE_PROFILE,
            customToolDefinitions: [probe],
            recordExecution: (event) => scope.events.push(event),
          })
          try {
            scope.result = await client.run({
              agent: program,
              prompt: command,
              runTimeoutMs: 10000,
            })
          } finally {
            active.delete(scope.label)
          }
        }),
      ),
    )
    await Promise.all(running)
    return {
      scopes,
      overlap,
      networkAttempts,
      unattributedAmbientReads,
      ambientConfigReadCounters: Object.fromEntries(
        scopes.map((scope) => [scope.label, scope.ambientConfigReads.length]),
      ),
      poison,
      ambientPoisonBytes: readFileSync(poison, 'utf8'),
    }
  } finally {
    release()
    await Promise.allSettled(running)
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL')
    await Promise.allSettled(closes)
    for (const restore of restorers.reverse()) restore()
    if (oldAmbient === undefined) delete process.env.OPENBUFF_PROVIDER_CONFIG
    else process.env.OPENBUFF_PROVIDER_CONFIG = oldAmbient
    rmSync(directory, { recursive: true, force: true })
  }
}
function quote(text: string) {
  return "'" + text.replaceAll("'", "'\\''") + "'"
}
