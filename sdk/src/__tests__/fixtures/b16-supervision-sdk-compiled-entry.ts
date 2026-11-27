/** Standalone Linux control. Build with the repository's pinned Bun: bun build --compile <this file> --outfile <temp>/b16. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SUPERVISED_SELF_EXEC_FLAG } from '@codebuff/agent-runtime/supervision/self-exec-flag'
import { isSupervisedSpawnSelfExecMode } from '@codebuff/agent-runtime/supervision/supervised-spawn'
import { executeSubagent } from '@codebuff/agent-runtime/tools/handlers/tool/spawn-agent-utils'
import {
  acquireRenewingWorkspacePathLease,
  acquireWorkspacePathLease,
  releaseWorkspacePathLease,
} from '@codebuff/agent-runtime/util/workspace-path-leases'
import { buildReadFilesResultV1 } from '@codebuff/common/tools/results/filesystem'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'

import { loadHostConfigSnapshot, nodeConfigReadFs } from '../../host-config'
import { createHostExecutionServices } from '../../host-execution'
import { getAgentRuntimeImpl } from '../../impl/agent-runtime'
import { createNodeFileSystem } from '../../tools/node-filesystem'
import { SUPERVISED_REPLAY_FLAG } from '../../services/supervised-replay-core'
import { handleSupervisedReplayWorker } from '../../services/supervised-replay-worker'

import {
  bounded,
  checkDetachedReceipt,
  checkGenericReplayRefusal,
  checkParentTurnAbort,
  checkSupervisedReplay,
  fileContext,
  holdUnconfirmedTool,
} from './b16-supervision-sdk-compiled-controls'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'
import type { ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import type { LaunchEvent, Result } from '@codebuff/common/types/contracts/execution-context'

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.cause)
  return result.value
}

function forbidNetwork() {
  const original = globalThis.fetch
  let calls = 0
  const forbid = () => {
    calls++
    throw new Error('B16 compiled control must never use the network')
  }
  globalThis.fetch = Object.assign(async () => forbid(), { preconnect: forbid }) as typeof fetch
  return { calls: () => calls, restore: () => { globalThis.fetch = original } }
}

if (process.argv[2] === SUPERVISED_REPLAY_FLAG) {
  const network = forbidNetwork()
  const exit = await handleSupervisedReplayWorker(process.argv)
  assert.equal(network.calls(), 0)
  process.exit(exit ?? 1)
}

if (process.argv[2] === SUPERVISED_SELF_EXEC_FLAG) {
  const network = forbidNetwork()
  const { runChildEntryMain } = await import('@codebuff/agent-runtime/supervision/child-entry')
  // Translate argv exactly as the compiled CLI does. If selected, observe
  // the wire receipt without changing the bytes sent to the real supervisor.
  const argv = [process.argv[0]!, process.argv[1]!, ...process.argv.slice(3)]
  const receiptPath = process.env.B16_FIXTURE_WIRE_RECEIPT
  const exit = await runChildEntryMain(argv, receiptPath ? async line => {
    writeFileSync(receiptPath, line, { flag: 'wx', mode: 0o600 })
    await Bun.write(Bun.stdout, line)
  } : undefined)
  assert.equal(network.calls(), 0)
  process.exit(exit)
}

if (process.argv[2] === '--b16-generic-replay-worker') {
  assert(isSupervisedSpawnSelfExecMode())
  assert(process.argv[3])
  forbidNetwork()
  await holdUnconfirmedTool(process.argv[3])
  throw new Error('Generic replay worker unexpectedly finished')
}

function observeSelfExecSpawns() {
  const descriptor = Object.getOwnPropertyDescriptor(Bun, 'spawn')!
  const actualSpawn = Bun.spawn
  const spawns: Array<{
    command: string[]
    request: SupervisedSpawnRequest
    pid: number
    cwd?: string
    detached?: boolean
    exited: Promise<number>
    signal: () => unknown
  }> = []
  // Observe the actual seam without injecting a PID, output, failure, or exit.
  Object.defineProperty(Bun, 'spawn', { ...descriptor, value: (...args: unknown[]) => {
    if (!Array.isArray(args[0]) || args[0][1] !== SUPERVISED_SELF_EXEC_FLAG) {
      return Reflect.apply(actualSpawn, Bun, args)
    }
    const command = [...args[0]] as string[]
    const options = args[1] as { cwd?: string; detached?: boolean }
    const request = JSON.parse(readFileSync(command[2]!, 'utf8')) as SupervisedSpawnRequest
    const proc = Reflect.apply(actualSpawn, Bun, args)
    spawns.push({ command, request, pid: proc.pid, cwd: options.cwd, detached: options.detached,
      exited: proc.exited, signal: () => proc.signalCode })
    return proc
  } })
  return { spawns, restore: () => { Object.defineProperty(Bun, 'spawn', descriptor) } }
}

export type ObservedSpawn = ReturnType<typeof observeSelfExecSpawns>['spawns'][number]

const childTemplate: AgentTemplate = {
  id: 'b16-compiled-child',
  displayName: 'B16 compiled child',
  model: 'b16-offline',
  inputSchema: {},
  outputMode: 'last_message',
  includeMessageHistory: false,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: ['read_files'],
  spawnableAgents: [],
  spawnerPrompt: '',
  systemPrompt: '',
  instructionsPrompt: '',
  stepPrompt: '',
  // Hold a real authenticated read RPC open, and require the supervisor to
  // finish stopping this process, not merely reject the parent's promise.
  handleSteps: `function* ({ logger }) {
    process.on('SIGTERM', () => {});
    logger.info({ pid: process.pid, executable: process.execPath, bun: Bun.version }, 'b16-compiled-ready');
    yield { toolName: 'read_files', input: { paths: ['src/owned.ts'] } };
  }`,
}

async function checkChildOnlyAbort(root: string, spawns: ObservedSpawn[]) {
  const actionAbort = new AbortController()
  const childAbort = new AbortController()
  const childReady = Promise.withResolvers<{ pid: number; executable: string; bun: string }>()
  const readStarted = Promise.withResolvers<void>()
  const releaseRead = Promise.withResolvers<void>()
  const environment = { OPENBUFF_PROCESS_SUPERVISION: '1' }
  const captured = loadHostConfigSnapshot({
    inputs: {
      environment, platform: 'linux', invocationCwd: root, projectRoot: root,
      home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'none' },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
    fs: nodeConfigReadFs,
  })
  assert(captured.status === 'complete')
  const clock = { domainId: 'b16-compiled-abort', nowMs: () => performance.now() }
  const host = value(createHostExecutionServices({
    snapshot: captured.snapshot, clock,
    boundary: value(captureRootDeadline({ clock, limit: { kind: 'unbounded' } })),
    childInheritanceEnvironment: environment, inheritEnv: false,
    authorizeAsync: async () => ({ ok: true, basis: 'explicit-policy', decisionId: 'b16-compiled-allow' }),
  }))
  const parent = { ...getInitialAgentState(), agentId: 'b16-parent', runId: 'b16-parent-run' }
  const owner = { clientSessionId: 'b16-session', rootRunId: parent.runId, parentRunId: parent.runId, parentAgentId: parent.agentId }
  const scope = value(host.registerRun(owner))
  const actionInput = { agents: [{ agent_type: childTemplate.id }] }
  const basis = { inputHash: hashActionInput('spawn_agents', actionInput) }
  const origin: ToolExecutionIdentity = {
    runId: owner.parentRunId, rootRunId: owner.rootRunId, agentId: owner.parentAgentId,
    actionId: 'b16-spawn', attemptId: 'b16-attempt', basis,
    basisId: hashActionInput('openbuff.execution-b02-basis.v1', { basis, workspaceSnapshotId: null }),
  }
  const context = value(scope.action({ ...origin, signal: actionAbort.signal }))
  const registration = value(host.execution.actionRegistration(context.execution))
  assert.equal(registration.correlation.kind, 'action')
  const child = { ...getInitialAgentState(), agentId: 'b16-child-instance' }
  const requests: SupervisedSpawnRequest[] = []
  const actors: Array<{ runId: string; rootRunId: string; agentId: string }> = []
  let readCalls = 0
  let customCalls = 0
  const runtime = getAgentRuntimeImpl({
    apiKey: '',
    hostServices: host,
    supervisedExecutionForRequest: request => {
      assert.deepEqual(request.executionIdentity, origin)
      assert.deepEqual(request.ancestorRunIds, [owner.parentRunId])
      assert.equal(request.clientSessionId, owner.clientSessionId)
      requests.push(request)
      return context
    },
    registerExecutionActor: ({ actor, parentActor, executionContext, ancestorRunIds }) => {
      assert.deepEqual(parentActor, { runId: origin.runId, rootRunId: origin.rootRunId, agentId: origin.agentId })
      assert.deepEqual(ancestorRunIds, [owner.parentRunId])
      assert.equal(actor.agentId, child.agentId)
      assert.equal(actor.rootRunId, owner.rootRunId)
      value(host.registerRun({ ...owner, parentRunId: actor.runId, parentAgentId: actor.agentId }, executionContext))
      actors.push(actor)
    },
    onExecutionActionStart: () => {},
    sendAction: async () => {},
    sendSubagentChunk: () => {},
    requestToolCall: async () => { customCalls++; throw new Error('Unexpected custom tool') },
    requestMcpToolData: async () => [],
    requestFiles: async () => {
      readCalls++
      readStarted.resolve()
      await bounded(releaseRead.promise, 'test read release', 12_000)
      return buildReadFilesResultV1([])
    },
    requestOptionalFile: async () => null,
    handleStepsLogChunk: ({ data, message }) => {
      if (message === 'b16-compiled-ready') childReady.resolve(data as Awaited<typeof childReady.promise>)
    },
    fileSystem: createNodeFileSystem(),
  })
  assert.equal(runtime.processSupervision, true)
  assert.equal(typeof runtime.spawnSupervised, 'function')

  const paths = ['src/owned.ts']
  const competitor = getInitialAgentState()
  const acquireCompetingLease = () => acquireWorkspacePathLease({ state: competitor, projectRoot: root, ownerAgentId: 'competitor', paths })
  const releaseLease = acquireRenewingWorkspacePathLease({
    state: parent, projectRoot: root, ownerAgentId: child.agentId, paths,
    onHeartbeatError: error => { throw error },
  })
  assert(releaseLease)
  let procAtLeaseRelease: boolean | undefined
  const result = executeSubagent({
    ...runtime,
    signal: childAbort.signal,
    agentState: child,
    parentAgentState: parent,
    agentTemplate: childTemplate,
    localAgentTemplates: { [childTemplate.id]: childTemplate },
    fileContext: fileContext(root),
    ancestorRunIds: [],
    prompt: 'Wait for cancellation',
    spawnParams: undefined,
    repoUrl: undefined,
    repoId: undefined,
    userId: undefined,
    userInputId: 'b16-input',
    clientSessionId: owner.clientSessionId,
    executionIdentity: origin,
    fingerprintId: 'b16-compiled-fixture',
    onResponseChunk: () => {},
  }).finally(() => {
    const spawn = spawns[0]
    procAtLeaseRelease = spawn ? existsSync(`/proc/${spawn.pid}`) : undefined
    releaseLease()
  }).then(() => null, (error: unknown) => error)
  try {
    const [ready] = await bounded(Promise.race([
      Promise.all([childReady.promise, readStarted.promise]),
      result.then(error => { throw new Error(`Child settled before its read RPC: ${String(error)}`) }),
    ]), 'compiled child readiness and read RPC')
    assert.equal(spawns.length, 1)
    const spawn = spawns[0]!
    assert.equal(ready.pid, spawn.pid)
    assert.equal(ready.executable, process.execPath)
    assert.equal(ready.bun, Bun.version)
    assert.equal(spawn.detached, true)
    assert.deepEqual(spawn.command.slice(0, 2), [process.execPath, SUPERVISED_SELF_EXEC_FLAG])
    assert.equal(spawn.command.length, 3)
    assert.deepEqual(spawn.request.executionIdentity, origin)
    assert.deepEqual(spawn.request.ancestorRunIds, [owner.rootRunId])
    assert(spawn.request.rpcSocketPath && spawn.request.rpcBridgeNonce)
    assert.equal(existsSync(`/proc/${spawn.pid}`), true)
    assert.throws(acquireCompetingLease, /Workspace path lease conflict/)

    const events: readonly LaunchEvent[] = host.events
    const admitted = events.filter(event => event.phase === 'admitted' && event.facts.family === 'supervised-child')
    const observed = events.filter(event => event.phase === 'spawn-observed' && event.facts.family === 'supervised-child')
    assert.equal(admitted.length, 1)
    assert.equal(observed.length, 1)
    const launch = admitted[0]!
    const observation = observed[0]!
    assert(launch.phase === 'admitted' && observation.phase === 'spawn-observed')
    assert.equal(observation.pid, spawn.pid)
    assert.equal(launch.facts.branchId, 'supervised.self-exec.initial')
    assert.deepEqual(launch.facts.correlation, registration.correlation)
    assert.deepEqual(observation.facts.correlation, registration.correlation)
    assert.equal(launch.facts.launchId, observation.facts.launchId)
    assert.equal(requests.length, 1)
    assert.equal(actors.length, 1)
    assert.equal(readCalls, 1)

    childAbort.abort()
    const error = await bounded(result, 'child-only abort settlement')
    assert(error instanceof Error && error.name === 'AbortError', String(error))
    assert.equal(actionAbort.signal.aborted, false)
    assert.equal(procAtLeaseRelease, false)
    assert.equal(existsSync(`/proc/${spawn.pid}`), false)
    const exitCode = await bounded(spawn.exited, 'Bun subprocess exit')
    assert.equal(spawn.signal(), 'SIGKILL')
    assert(spawn.cwd && !existsSync(spawn.cwd), 'The SDK removes its launch sandbox after settlement')
    assert.equal(parent.workspacePathLeases?.[0]?.status, 'released')
    const next = acquireCompetingLease()
    assert(next)
    releaseWorkspacePathLease(competitor, next)
    assert.equal(spawns.length, 1, 'A cancelled child must not restart')
    assert.equal(customCalls, 0)
    return { branch: launch.facts.branchId, launchId: launch.facts.launchId, flag: spawn.command[1], owner,
      correlation: observation.facts.correlation, actor: actors[0], pid: spawn.pid, exitCode, signal: spawn.signal(),
      error: error.name, actionAborted: actionAbort.signal.aborted, procAtLeaseRelease, leaseReacquired: true, readCalls, customCalls }
  } finally {
    childAbort.abort()
    actionAbort.abort()
    releaseRead.resolve()
    await bounded(result, 'fixture teardown')
    await bounded(Promise.all(spawns.map(spawn => spawn.exited)), 'fixture child reaping')
  }
}

assert.equal(process.platform, 'linux')
assert(isSupervisedSpawnSelfExecMode(), 'Build this fixture with bun build --compile before running')
const temp = mkdtempSync(join(tmpdir(), 'b16-compiled-'))
const network = forbidNetwork()
const observation = observeSelfExecSpawns()
try {
  const abortRoot = join(temp, 'abort')
  const turnAbortRoot = join(temp, 'parent-turn-abort')
  const detachedRoot = join(temp, 'detached')
  const replayRoot = join(temp, 'generic-replay')
  for (const root of [abortRoot, turnAbortRoot, detachedRoot, replayRoot]) mkdirSync(root, { mode: 0o700 })
  const childOnlyAbort = await checkChildOnlyAbort(abortRoot, observation.spawns)
  const parentTurnAbort = await checkParentTurnAbort(turnAbortRoot, observation.spawns)
  const receipt = await checkDetachedReceipt(detachedRoot, observation.spawns)
  const replay = await checkGenericReplayRefusal(replayRoot, network.calls)
  const supervisedReplay = await checkSupervisedReplay()
  assert.equal(observation.spawns.length, 3)
  assert.equal(network.calls(), 0)
  console.log(JSON.stringify({
    status: 'passed', bun: Bun.version, selfExec: true, childOnlyAbort, parentTurnAbort, receipt, replay, supervisedReplay, networkCalls: network.calls(),
    unsupported: [
      'Resumption is limited to an explicit data-only recipe with a live parent and a new identical compiled Linux/Bun worker; generic interrupted turns cannot re-drive.',
      'No Windows claim, provider or MCP tasks, full CLI parity, or reaping claims for grandchildren.',
    ],
  }, null, 2))
} finally {
  observation.restore()
  network.restore()
  rmSync(temp, { recursive: true, force: true })
}
