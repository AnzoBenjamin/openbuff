import assert from 'node:assert/strict'
import { spyOn } from 'bun:test'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { agentReceiptSchema } from '@codebuff/common/types/agent-handoff'
import { connectChildBridge } from '@codebuff/agent-runtime/supervision/child-bridge-client'
import * as supervised from '@codebuff/agent-runtime/supervision/supervised-spawn'
import * as supervisor from '@codebuff/agent-runtime/supervision/process-supervisor'
import * as runtime from '../../impl/agent-runtime'
import * as hosts from '../../host-execution'
import { OpenbuffClient } from '../../client'
import { nodeConfigReadFs } from '../../host-config'
import { createNodeFileSystem } from '../../tools/node-filesystem'
import type { AgentDefinition, ToolCall } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { LaunchEvent, PolicyInput } from '@codebuff/common/types/contracts/execution-context'
import type { SettledSubagentResult as SdkSettledSubagentResult, SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { ChildProcess } from 'node:child_process'

export const supervisionControls = ['happy', 'denied', 'unavailable', 'pre-aborted', 'literal-zero', 'delayed-cancel'] as const
export type SupervisionControl = typeof supervisionControls[number] | 'exhausted-before-admission' | 'exhausted-before-retry' | 'retry-budget-exhausted' | 'failed-child-receipt'
export type SupervisionBranch = 'initial' | 'retry'
const actualFactory = supervised.buildDefaultSpawnSupervised
const actualRuntime = runtime.getAgentRuntimeImpl
const actualHost = hosts.createHostExecutionServices
const actualSettle = supervisor.spawnSettledSubagent
const base = path.resolve(import.meta.dir, '../../../../docs/execution/body-roadmap/evidence/B19/implementation/branch-controls-r3/sdk-supervision/runs')

function captureDirectory() {
  const directory = process.env.B19_SDK_SUPERVISION_EVIDENCE_DIR
  if (!directory) return undefined
  const selected = path.resolve(directory)
  if (selected !== base && !selected.startsWith(base + path.sep)) throw new Error('SDK supervision capture escaped its owned runs directory')
  mkdirSync(base, { recursive: true })
  let ancestor = selected
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor)
  const canonicalBase = realpathSync(base), canonicalAncestor = realpathSync(ancestor)
  if (canonicalAncestor !== canonicalBase && !canonicalAncestor.startsWith(canonicalBase + path.sep))
    throw new Error('SDK supervision capture escaped through a symlink')
  return selected
}

/** Serialized by the SDK: every reference in this generator is self-contained. */
export const supervisionParent: AgentDefinition = {
  id: 'b19-supervision-parent', displayName: 'B19 SDK supervision parent', model: 'fixture/fixture-model',
  outputMode: 'structured_output', toolNames: ['spawn_agent_inline', 'set_output'], spawnableAgents: ['b19-supervision-child'],
  handleSteps: function* () {
    // Runtime canonical tools include this internal tool; the public agent
    // ToolCall union omits it. The explicit bridge changes no serialized data.
    const call: Pick<CodebuffToolCall<'spawn_agent_inline'>, 'toolName' | 'input'> = {
      toolName: 'spawn_agent_inline', input: { agent_type: 'b19-supervision-child', prompt: 'local supervision branch' },
    }
    const { toolResult } = yield call as unknown as ToolCall
    yield { toolName: 'set_output', input: { child: toolResult } }
  },
}
export const supervisionChild: AgentDefinition = {
  id: 'b19-supervision-child', displayName: 'B19 local child', model: 'fixture/fixture-model',
  outputMode: 'structured_output', toolNames: ['set_output'],
  handleSteps: function* () { yield { toolName: 'set_output', input: { fixture: 'child-programmatic-result' } } },
}

export async function runSupervisionSdkControl(branch: SupervisionBranch, control: SupervisionControl) {
  assert(branch === 'retry' || !['exhausted-before-retry', 'retry-budget-exhausted'].includes(control))
  assert(!supervised.isSupervisedSpawnSelfExecMode(), 'Source controls must run from source')
  const id = randomUUID(), root = mkdtempSync(path.join(tmpdir(), 'b19-sdk-supervision-'))
  const directory = captureDirectory()
  const artifactDir = directory ? path.join(directory, id) : undefined
  if (artifactDir) mkdirSync(artifactDir, { recursive: true })
  const configFile = path.join(root, 'openbuff.json')
  writeFileSync(configFile, JSON.stringify({ autoFileChangeHooks: false, defaultModel: 'fixture/fixture-model', providers: {
    fixture: { type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['fixture-model'], apiKeyEnv: 'CUSTOM_PROVIDER_KEY' },
  } }))
  writeFileSync(path.join(root, 'bridge-probe.txt'), 'captured SDK parent bridge\n')
  const environment = { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), LANG: 'C.UTF-8', NODE_ENV: 'test',
    PROJECT_VALUE: 'supervision-captured-public', OPENAI_API_KEY: 'supervision-canonical-sentinel',
    CUSTOM_PROVIDER_KEY: 'supervision-configured-sentinel', OPENBUFF_API_KEY: 'supervision-openbuff-sentinel',
    OPENBUFF_PROCESS_SUPERVISION: '1', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const targetBranch = `supervised.source.${branch}` as const
  const events: LaunchEvent[] = [], policies: PolicyInput[] = []
  const factoryCalls: Array<{ seed: unknown; restart: unknown; handlerKind: string; executionResolver: boolean }> = []
  const resolverCalls: Array<{ identity: unknown; ancestors: unknown; registration: unknown; snapshotId: string | undefined }> = []
  const registrations: unknown[] = [], actionStarts: unknown[] = [], runtimeCalls: unknown[] = []
  const hostSnapshots: string[] = [], pendingSeams: Promise<unknown>[] = []
  const settledResults: SdkSettledSubagentResult[] = []
  const attempts: Array<{ branch: string | undefined; requestPath: string; request: SupervisedSpawnRequest; cwd: string;
    mode: number; requestMode: number; bridgeReply?: unknown; result?: supervisor.SettledSubagentResult }> = []
  const boundaries: Array<{ cmd: string[]; env: Record<string, string>; cwd?: string; branch: string; launchId: string;
    syntheticPid?: number; failure?: string }> = []
  const helpers: Array<{ child: ChildProcess; closed: Promise<void> }> = []
  const clockTransitions: Array<{ before: number; after: number; previousBoundaries: number }> = []
  let now = 100, networkCalls = 0
  const clock = { domainId: `sdk-supervision:${id}`, nowMs: () => now }
  const stop = new AbortController()
  let release!: () => void, entered!: () => void
  const delayedEntered = new Promise<void>(resolve => { entered = resolve })
  const delayedRelease = new Promise<void>(resolve => { release = resolve })
  const restores: Array<() => void> = []
  const hostSpy = spyOn(hosts, 'createHostExecutionServices').mockImplementation(options => {
    const boundary = captureRootDeadline({ clock, limit: { kind: 'finite', durationMs: 60_000 } })
    if (!boundary.ok) throw new Error(boundary.cause)
    hostSnapshots.push(options.snapshot.snapshotId)
    return actualHost({ ...options, clock, boundary: boundary.value, authorizeAsync: async input => {
      policies.push(input)
      if (input.facts.branchId === targetBranch) {
        if (control === 'denied' || control === 'unavailable') return { ok: false, reason: control, cause: `fixture-${control}` }
        if (control === 'delayed-cancel') { entered(); await delayedRelease }
        if (control === 'exhausted-before-admission' || control === 'exhausted-before-retry') {
          await Promise.resolve()
          clockTransitions.push({ before: now, after: 60_101, previousBoundaries: boundaries.length }); now = 60_101
        }
      }
      return { ok: true, basis: 'explicit-policy', decisionId: `fixture:${input.facts.launchId}` }
    } })
  })
  restores.push(() => hostSpy.mockRestore())
  const runtimeSpy = spyOn(runtime, 'getAgentRuntimeImpl').mockImplementation(options => {
    const result = actualRuntime({ ...options,
      supervisedExecutionForRequest: options.supervisedExecutionForRequest && (request => {
        const context = options.supervisedExecutionForRequest!(request)
        resolverCalls.push({ identity: request.executionIdentity, ancestors: request.ancestorRunIds,
          registration: options.hostServices?.execution.actionRegistration(context.execution), snapshotId: options.hostServices?.provider.snapshot.snapshotId })
        return context
      }),
      registerExecutionActor: options.registerExecutionActor && (registration => {
        const result = options.registerExecutionActor!(registration)
        registrations.push({ actor: registration.actor, parentActor: registration.parentActor, ancestors: registration.ancestorRunIds })
        return result
      }),
      onExecutionActionStart: options.onExecutionActionStart && (async start => {
        const result = await options.onExecutionActionStart!(start)
        actionStarts.push({ identity: start.identity, toolName: start.toolName, input: start.input })
        return result
      }),
    })
    runtimeCalls.push({ processSupervision: result.processSupervision, hasSpawn: typeof result.spawnSupervised === 'function',
      snapshotId: options.hostServices?.provider.snapshot.snapshotId })
    return result
  })
  restores.push(() => runtimeSpy.mockRestore())
  const factorySpy = spyOn(supervised, 'buildDefaultSpawnSupervised').mockImplementation((...args) => {
    factoryCalls.push({ seed: structuredClone(args[0]), restart: structuredClone(args[2]?.restart), handlerKind: typeof args[1],
      executionResolver: typeof args[2]?.executionForRequest === 'function' })
    const seam = actualFactory(...args)
    return (...callArgs) => {
      const pending = seam(...callArgs)
      pendingSeams.push(pending)
      void pending.then(result => { settledResults.push(result) }, () => {})
      return pending
    }
  })
  restores.push(() => factorySpy.mockRestore())
  const settleSpy = spyOn(supervisor, 'spawnSettledSubagent').mockImplementation(async options => {
    const requestPath = options.args?.[0]
    assert(requestPath && options.cwd && options.execution)
    const request = JSON.parse(readFileSync(requestPath, 'utf8')) as SupervisedSpawnRequest
    const attempt: typeof attempts[number] = { branch: options.branchId, requestPath, request, cwd: options.cwd,
      mode: statSync(options.cwd).mode & 0o777, requestMode: statSync(requestPath).mode & 0o777 }
    attempts.push(attempt)
    assert(request.rpcSocketPath && request.rpcBridgeNonce, 'SDK-created parent bridge must be live before settle')
    const bridge = await connectChildBridge(request.rpcSocketPath)
    try { attempt.bridgeReply = await bridge.call('requestOptionalFile', { filePath: 'bridge-probe.txt' }) }
    finally { bridge.close() }
    if (options.branchId === targetBranch) {
      if (control === 'pre-aborted') stop.abort(new Error('Pre-aborted at target adapter entry'))
    }
    attempt.result = await actualSettle({ ...options, spawn: spawnSynthetic })
    return attempt.result
  })
  restores.push(() => settleSpy.mockRestore())
  const spawnSynthetic: supervisor.SettleSpawnSeam = request => {
    const cmd = request.cmd
    assert(cmd.some(arg => arg.endsWith('/supervision/child-entry.ts')), 'Synthetic seam is restricted to supervised source children')
    const admitted = [...policies].reverse().find(input => input.facts.family === 'supervised-child')
    assert(admitted, 'Supervisor process boundary requires actual admission')
    const boundary: typeof boundaries[number] = { cmd: [...cmd], env: { ...request.env }, cwd: request.cwd,
      launchId: admitted.facts.launchId, branch: admitted.facts.branchId }
    boundaries.push(boundary)
    if ((branch === 'retry' && boundaries.length === 1) || control === 'retry-budget-exhausted') {
      boundary.failure = 'Injected process boundary throw before OS spawn'
      throw new Error(boundary.failure)
    }
    const childRequest = attempts.at(-1)!.request
    const receipt = agentReceiptSchema.parse({ schemaVersion: 1, receiptId: `fixture-receipt-${id}`, taskId: `spawn-${childRequest.child!.agentId}`,
      role: 'specialist', agentId: childRequest.child!.agentId, status: control === 'failed-child-receipt' ? 'failed' : 'completed',
      runOutcome: control === 'failed-child-receipt' ? { termination: 'failed', cause: { code: 'fixture-child-failure', message: 'Schema-valid child failure' } } : { termination: 'completed' },
      taskAcceptance: { status: 'unknown' }, actionOutcomes: [], changedFiles: [], requirementsAddressed: [], acceptanceCriteriaAddressed: [],
      findingsAddressed: [], evidence: [], assumptions: [], unresolved: [], requestedValidation: [], artifacts: [],
      errors: control === 'failed-child-receipt' ? [{ code: 'fixture-child-failure', message: 'Schema-valid child failure', retryable: false }] : [],
      output: { fixture: 'injected-process-receipt' } })
    const stream = (content: string) => new ReadableStream<Uint8Array>({ start(controller) {
      if (content) controller.enqueue(new TextEncoder().encode(content)); controller.close()
    } })
    boundary.syntheticPid = 650_000 + boundaries.length
    const observed = request.observer?.spawnObserved({ source: 'bun-spawn-result', pid: boundary.syntheticPid })
    if (observed && !observed.ok) throw new Error(observed.cause)
    // The explicit spawn seam uses the supervisor's injected scope driver,
    // which owns these synthetic stream EOF and exit promises without OS credit.
    return { pid: boundary.syntheticPid, stdout: stream(JSON.stringify(receipt) + '\n'), stderr: stream(''), exited: Promise.resolve(0), kill() {} }
  }
  const forbid = () => { networkCalls++; throw new Error('Provider/network calls forbidden in supervision control') }
  const networkSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => forbid(), { preconnect: forbid }))
  restores.push(() => networkSpy.mockRestore())
  const spawnSource: CodebuffSpawn = (executable, argv = [], options) => {
    const child = spawn(executable, [...argv], options ?? {})
    helpers.push({ child, closed: new Promise(resolve => child.once('close', () => resolve())) })
    return child
  }
  const client = new OpenbuffClient({ cwd: root, projectFiles: {}, knowledgeFiles: {}, agentDefinitions: [supervisionChild],
    harnessStateDir: path.join(root, 'harness'), hostConfiguration: { environment, platform: 'linux', invocationCwd: root, projectRoot: root,
      home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: configFile, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false } }, configReadFs: nodeConfigReadFs, spawnSource,
    fsSource: createNodeFileSystem(), approvalMode: 'allow-all', recordExecution: event => events.push(event) })
  let result: Awaited<ReturnType<typeof client.run>> | undefined, error: unknown
  try {
    const pending = client.run({ agent: supervisionParent, prompt: 'local fixture', signal: stop.signal,
      ...(control === 'literal-zero' ? { runTimeoutMs: 0 } : {}) })
    // Attach immediately: cancellation can complete the SDK before the awaited
    // delayed policy or the still-cleaning-up supervised seam settles.
    const runResult = pending.then(value => { result = value }, caught => { error = caught })
    if (control === 'delayed-cancel') {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([delayedEntered, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Target supervision authorizer was not reached')), 5000)
        })])
        stop.abort(new Error('Cancelled while target authorization was pending'))
      } finally { if (timer) clearTimeout(timer); release() }
    }
    await runResult
  } catch (caught) { error = caught }
  finally {
    release()
    await Promise.allSettled(pendingSeams)
    stop.abort(new Error('Fixture complete'))
    for (const { child } of helpers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.allSettled(helpers.map(helper => helper.closed))
    for (const restore of restores.reverse()) restore()
  }
  const evidence = { schemaVersion: 1, producer: 'sdk.supervision', targetBranch, control, id, captureStatus: 'unasserted',
    evidenceKind: 'actual-sdk-run-factory-source-with-injected-settle-spawn',
    zeroSemantics: control === 'literal-zero' ? 'SDK scalar zero rejected before host/factory; retry is consequently unreachable' : undefined,
    hostSnapshots, runtimeCalls, factoryCalls, registrations, actionStarts, resolverCalls, attempts, boundaries,
    settledResults, clockTransitions, policies, events, result, error, networkCalls,
    removedSandboxes: attempts.map(attempt => ({ path: attempt.cwd, removed: !existsSync(attempt.cwd) })),
    limitations: ['Settle-spawn result/PID is synthetic; Bun.spawn is bypassed and scope coverage is injected', 'Clock and target authorization decision are injected into the actual host factory',
      'All factory/resolver/runtime wrappers call through; restart count/backoff and bridge remain production',
      'No provider task, complete child strategy, MCP, OS containment, or B29 equivalence claim'] }
  if (artifactDir) {
    writeFileSync(path.join(artifactDir, 'case.json'), JSON.stringify(evidence, (_key, value) => value instanceof Error
      ? { ...value, name: value.name, message: value.message, stack: value.stack } : value, 2) + '\n', { flag: 'wx' })
  }
  rmSync(root, { recursive: true, force: true })
  return { ...evidence, artifactDir }
}
