import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { appendFileSync, existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'

import { SUPERVISED_SELF_EXEC_FLAG } from '@codebuff/agent-runtime/supervision/self-exec-flag'
import { classifyRunResume, createRunJournal } from '@codebuff/agent-runtime/util/run-journal'
import { buildReadFilesResultV1, readFilesResultV1Schema } from '@codebuff/common/tools/results/filesystem'
import { agentReceiptSchema } from '@codebuff/common/types/agent-handoff'
import { getInitialSessionState } from '@codebuff/common/types/session-state'

import { OpenbuffClient } from '../../client'
import { getCustomToolDefinition } from '../../custom-tool'
import { nodeConfigReadFs } from '../../host-config'
import { getTrustedSessionClientId } from '../../run'
import { createNodeFileSystem } from '../../tools/node-filesystem'
import { sha, type ReplayProgram } from '../../services/immutable-replay-program'
import { SUPERVISED_REPLAY_TAPE } from '../../services/supervised-replay-core'
import { runSupervisedReplayableProgram, type SupervisedReplayBoundary } from '../../services/supervised-replay-worker'

import type { AgentDefinition, ToolCall } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { LaunchEvent } from '@codebuff/common/types/contracts/execution-context'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ProjectFileContext } from '@codebuff/common/util/file'
import type { OpenbuffClientOptions } from '../../run'
import type { ObservedSpawn } from './b16-supervision-sdk-compiled-entry'

export async function bounded<T>(promise: Promise<T>, evidence: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${evidence}`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function localSdkOptions(root: string, environment: Record<string, string>): OpenbuffClientOptions {
  return {
    apiKey: '', cwd: root, projectFiles: {}, knowledgeFiles: {},
    hostConfiguration: {
      environment, platform: 'linux', invocationCwd: root, projectRoot: root,
      home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'none' },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
    configReadFs: nodeConfigReadFs,
    harnessStateDir: join(root, 'harness'),
    fsSource: createNodeFileSystem(),
    repositoryIntelligence: false,
    approvalMode: 'allow-all',
    handleEvent() {},
  }
}

export function fileContext(root: string): ProjectFileContext {
  return {
    projectRoot: root, cwd: root, fileTree: [], fileTokenScores: {}, knowledgeFiles: {}, userKnowledgeFiles: {},
    agentTemplates: {}, customToolDefinitions: {}, gitChanges: { status: '', diff: '', diffCached: '', lastCommitMessages: '' },
    changesSinceLastChat: {}, shellConfigFiles: {},
    systemInfo: { platform: 'linux', shell: '', nodeVersion: '', arch: process.arch, homedir: root, cpus: 1, chromeAvailable: false },
  }
}

const probePath = 'probe.txt'
const probeContent = 'b16 keyless local gated read: first line\nb16 keyless local gated read: last line\n'

function gatedProbeRead() {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  let released = false
  const overrideTools: NonNullable<OpenbuffClientOptions['overrideTools']> = {
    read_files: async ({ filePaths, ranges }) => {
      calls++
      assert.deepEqual(filePaths, [probePath])
      assert.equal(ranges?.length ?? 0, 0)
      entered.resolve()
      // Intentionally non-cooperative: closing the bridge must not rely on
      // this fixture callback returning or acting on an AbortSignal.
      await release.promise
      return buildReadFilesResultV1([{
        selector: 'file', requestIndex: 0, path: probePath, status: 'ok',
        content: probeContent, complete: true, template: false,
      }])
    },
  }
  return {
    overrideTools, entered: entered.promise, calls: () => calls,
    blocked: () => calls === 1 && !released,
    release() { released = true; release.resolve() },
  }
}

function socketIsOpen(socket: string): boolean {
  // A path-only check cannot distinguish closing the bridge from unlinking
  // a live Unix socket. Match the exact kernel socket pathname as well.
  return readFileSync('/proc/net/unix', 'utf8').split('\n').some(line => line.endsWith(` ${socket}`))
}

function observedChild(spawns: ObservedSpawn[], offset: number, events: LaunchEvent[], agentType: string) {
  assert.equal(spawns.length - offset, 1, 'Expected one real self-exec, with no retry')
  const spawn = spawns[offset]!
  assert.deepEqual(spawn.command.slice(0, 2), [process.execPath, SUPERVISED_SELF_EXEC_FLAG])
  assert.equal(spawn.command.length, 3)
  assert.equal(spawn.detached, true)
  assert.equal(spawn.request.agentType, agentType)
  assert(spawn.request.child && spawn.request.rpcSocketPath && spawn.request.rpcBridgeNonce && spawn.cwd)
  const launches = events.filter(event => 'facts' in event && event.facts.family === 'supervised-child')
  const admitted = launches.filter(event => event.phase === 'admitted')
  const observed = launches.filter(event => event.phase === 'spawn-observed')
  assert.equal(admitted.length, 1)
  assert.equal(observed.length, 1)
  const launch = admitted[0]!
  const observation = observed[0]!
  const correlation = launch.facts.correlation
  const identity = spawn.request.executionIdentity
  assert(correlation?.kind === 'action' && identity)
  assert.equal(observation.pid, spawn.pid)
  assert.equal(observation.facts.launchId, launch.facts.launchId)
  assert.deepEqual(observation.facts.correlation, correlation)
  assert(launches.every(event => 'facts' in event && event.facts.launchId === launch.facts.launchId &&
    event.facts.branchId === 'supervised.self-exec.initial'), 'The initial launch must not retry')
  assert.equal(correlation.actionId, identity.actionId)
  assert.equal(correlation.attemptId, identity.attemptId)
  assert.equal(correlation.basisId, identity.basisId)
  return {
    spawn, launch, observation, correlation, identity,
    cwd: spawn.cwd, socket: spawn.request.rpcSocketPath, agentId: spawn.request.child.agentId,
  }
}

type ObservedChild = ReturnType<typeof observedChild>

function assertChildLive({ spawn, cwd, socket }: ObservedChild) {
  assert(existsSync(`/proc/${spawn.pid}`), 'Compiled child PID must still be live')
  assert.equal(readlinkSync(`/proc/${spawn.pid}/exe`), process.execPath)
  assert(existsSync(cwd), 'The launch sandbox must still exist')
  assert(lstatSync(socket).isSocket() && socketIsOpen(socket), 'The real Unix bridge must still be open')
}

function assertChildJoined({ spawn, cwd, socket }: ObservedChild) {
  assert(!existsSync(`/proc/${spawn.pid}`), 'Compiled child must already be reaped')
  assert(!socketIsOpen(socket) && !existsSync(socket), 'The Unix bridge must already be closed')
  assert(!existsSync(cwd), 'The launch sandbox must already be removed')
}

function originalSpawnAction(root: AgentState, { spawn, correlation, identity }: ObservedChild) {
  const actions = root.actionOutcomes?.filter(action => action.toolName === 'spawn_agents') ?? []
  assert.equal(actions.length, 1, 'Expected precisely the original spawn action')
  const action = actions[0]!
  assert.equal(action.actionId, identity.actionId)
  assert.equal(action.attemptId, identity.attemptId)
  assert.deepEqual(action.basis, identity.basis)
  assert.equal(action.runId, root.runId)
  assert.equal(identity.runId, root.runId)
  assert.equal(identity.rootRunId, root.runId)
  assert.equal(identity.agentId, root.agentId)
  assert.deepEqual(spawn.request.ancestorRunIds, [root.runId])
  // SDK authority uses the stable host session, not the request's prompt ID.
  assert.deepEqual({ ...correlation.owner }, {
    clientSessionId: getTrustedSessionClientId(),
    rootRunId: root.runId, parentRunId: root.runId, parentAgentId: root.agentId,
  })
  return action
}

const abortChild: AgentDefinition = {
  id: 'b16-parent-abort-child', displayName: 'B16 parent abort child', model: 'b16-offline',
  toolNames: ['read_files'],
  handleSteps: function* () {
    // Installed before the read latch opens: a polite TERM cannot reap this child.
    process.on('SIGTERM', () => {})
    yield { toolName: 'read_files', input: { paths: ['probe.txt'] } }
  },
}

const abortParent: AgentDefinition = {
  id: 'b16-turn-abort-parent', displayName: 'B16 turn abort parent', model: 'b16-offline',
  toolNames: ['spawn_agents'], spawnableAgents: ['b16-parent-abort-child'],
  handleSteps: function* () {
    yield { toolName: 'spawn_agents', input: { agents: [
      { agent_type: 'b16-parent-abort-child', prompt: 'Block on the local fixture probe' },
    ] } }
  },
}

export async function checkParentTurnAbort(root: string, spawns: ObservedSpawn[]) {
  const spawnOffset = spawns.length
  const events: LaunchEvent[] = []
  const read = gatedProbeRead()
  const turnAbort = new AbortController()
  const journal = createRunJournal({ path: join(root, 'parent-abort.sqlite') })
  const client = new OpenbuffClient({
    ...localSdkOptions(root, { OPENBUFF_PROCESS_SUPERVISION: '1' }),
    agentDefinitions: [abortChild], overrideTools: read.overrideTools,
    journalReader: journal, journalWriter: journal,
    recordExecution: event => events.push(event),
  })
  const running = client.run({
    agent: abortParent, prompt: 'Start one foreground child',
    signal: turnAbort.signal, runTimeoutMs: 15_000,
  })
  try {
    await bounded(Promise.race([
      read.entered,
      running.then(result => { throw new Error(`Parent settled before the child read: ${JSON.stringify(result.output)}`) }),
    ]), 'foreground compiled child read')
    const observed = observedChild(spawns, spawnOffset, events, abortChild.id)
    assertChildLive(observed)
    assert(read.blocked())
    assert.equal(turnAbort.signal.aborted, false)

    // No child controller, process kill, deadline, or read release drives this.
    const cancellationReason = 'B16 caller cancelled the parent turn'
    turnAbort.abort(new Error(cancellationReason))
    const result = await bounded(running, 'caller-aborted public SDK turn')
    assertChildJoined(observed)
    assert(read.blocked(), 'Public cancellation must settle while the fixture read remains blocked')
    assert.equal(result.runOutcome?.termination, 'cancelled', JSON.stringify(result.output))
    assert.equal(result.runOutcome.cause?.code, 'run_cancelled')
    assert.equal(result.runOutcome.cause.message, cancellationReason)
    assert.deepEqual(result.output, { type: 'error', message: cancellationReason })
    const exitCode = await bounded(observed.spawn.exited, 'foreground child exit')
    // The SDK can also return a cancelled RPC, allowing the child to exit
    // before escalation. The child-only control separately requires SIGKILL.
    const signal = observed.spawn.signal()
    assert(signal === 'SIGKILL' || (signal === null && exitCode === 0), `Unexplained child exit ${exitCode}/${signal}`)
    observedChild(spawns, spawnOffset, events, abortChild.id) // No launch or retry appeared during cancellation.

    const rootState = result.sessionState?.mainAgentState
    assert(rootState?.runId)
    const action = originalSpawnAction(rootState, observed)
    assert.equal(action.outcome, 'cancelled')
    assert.equal(action.cause?.code, 'action_cancelled')
    const rows = journal.events(rootState.runId)
    const calls = rows.filter(row => row.eventType === 'tool_call' && (row.payload as { toolName?: string }).toolName === 'spawn_agents')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.correlation, action.actionId)
    assert.deepEqual(calls[0]!.payload, {
      toolName: 'spawn_agents', attemptId: action.attemptId, basis: action.basis,
      input: { agents: [{ agent_type: abortChild.id, prompt: 'Block on the local fixture probe' }] },
    })
    assert(!rows.some(row => row.eventType === 'llm_request'))
    const terminal = rows.at(-1)
    assert(terminal?.eventType === 'step_boundary')
    assert.deepEqual(terminal.payload, {
      terminal: true, status: 'cancelled', runOutcome: result.runOutcome,
      taskAcceptance: result.taskAcceptance, actionOutcomes: rootState.actionOutcomes,
    })
    return {
      branch: observed.launch.facts.branchId, launchId: observed.launch.facts.launchId,
      correlation: observed.correlation, pid: observed.spawn.pid, exitCode, signal,
      runOutcome: result.runOutcome, action, readCalls: read.calls(), joinedBeforeReturn: true,
    }
  } finally {
    if (!turnAbort.signal.aborted) turnAbort.abort()
    read.release()
    try {
      await bounded(running, 'foreground fixture teardown')
      await bounded(Promise.all(spawns.slice(spawnOffset).map(spawn => spawn.exited)), 'foreground fixture reaping')
    } finally {
      await bounded(journal.close(), 'foreground journal close')
    }
  }
}

const detachedChild: AgentDefinition = {
  id: 'b16-detached-child', displayName: 'B16 detached child', model: 'b16-offline',
  outputMode: 'structured_output', toolNames: ['read_files', 'spawn_agents', 'set_output'],
  spawnableAgents: ['b16-unsupported-grandchild'],
  handleSteps: function* ({ agentState }) {
    const read = yield { toolName: 'read_files', input: { paths: ['probe.txt'] } }
    const detach = yield { toolName: 'spawn_agents', input: { agents: [
      { agent_type: 'b16-unsupported-grandchild', background: true, prompt: 'Must not start' },
    ] } }
    yield { toolName: 'set_output', input: {
      runId: agentState.runId, pid: process.pid, executable: process.execPath,
      bun: Bun.version, read: read.toolResult, nestedDetach: detach.toolResult,
    } }
  },
}

const unsupportedGrandchild: AgentDefinition = {
  id: 'b16-unsupported-grandchild', displayName: 'B16 unowned grandchild', model: 'b16-offline',
  toolNames: ['read_files'],
  handleSteps: function* () {
    yield { toolName: 'read_files', input: { paths: ['must-not-dispatch.txt'] } }
  },
}

const detachedBarrier = 'b16_child_entered_read'
const detachedParent: AgentDefinition = {
  id: 'b16-detached-parent', displayName: 'B16 detached parent', model: 'b16-offline',
  outputMode: 'structured_output', toolNames: ['spawn_agents', detachedBarrier, 'set_output'],
  spawnableAgents: ['b16-detached-child'],
  handleSteps: function* () {
    const launch = yield { toolName: 'spawn_agents', input: { agents: [
      { agent_type: 'b16-detached-child', background: true, prompt: 'Read the fixture probe' },
    ] } }
    const launchPart = launch.toolResult?.[0]
    const reports = launchPart?.type === 'json' ? launchPart.value : undefined
    const report = Array.isArray(reports) ? reports[0] : undefined
    const job = report && typeof report === 'object' && !Array.isArray(report) ? report.value : undefined
    if (!job || typeof job !== 'object' || !('background' in job) || job.background !== true ||
        !('jobId' in job) || typeof job.jobId !== 'string' || !job.jobId) {
      throw new Error(`Expected detached job report: ${JSON.stringify(launch.toolResult)}`)
    }
    const jobId = job.jobId
    yield { toolName: 'b16_child_entered_read', input: {} } as unknown as ToolCall
    yield { toolName: 'set_output', input: { jobId } }
  },
}

export async function checkDetachedReceipt(root: string, spawns: ObservedSpawn[]) {
  const events: LaunchEvent[] = []
  const spawnOffset = spawns.length
  const read = gatedProbeRead()
  const tapeFile = join(root, 'detached.sqlite')
  const wireFile = join(root, 'child-receipt.json')
  const journal = createRunJournal({ path: tapeFile })
  let barrierCalls = 0
  const client = new OpenbuffClient({
    ...localSdkOptions(root, { OPENBUFF_PROCESS_SUPERVISION: '1', B16_FIXTURE_WIRE_RECEIPT: wireFile }),
    agentDefinitions: [detachedChild, unsupportedGrandchild], overrideTools: read.overrideTools,
    journalReader: journal, journalWriter: journal,
    recordExecution: event => events.push(event),
    customToolDefinitions: [getCustomToolDefinition({
      toolName: detachedBarrier, description: 'Wait only for the child to enter the blocked fixture read',
      inputSchema: z.object({}).strict(),
      execute: async () => {
        barrierCalls++
        await bounded(read.entered, 'detached compiled child read')
        return []
      },
    })],
  })
  const running = client.run({ agent: detachedParent, prompt: 'Launch a detached local fixture', runTimeoutMs: 15_000 })
  let closing: Promise<void> | undefined
  try {
    const result = await bounded(running, 'parent turn return, before releasing the detached read')
    // Mirror the host close ordering: no polling, no caller abort, no child
    // release or join between the public return and the real close request.
    closing = journal.close()
    const closeState = await Promise.race([closing.then(() => 'closed'), Bun.sleep(25).then(() => 'pending')])
    assert.equal(closeState, 'pending', 'Built-in close must wait for the admitted detached child')
    assert.equal(result.runOutcome?.termination, 'completed', JSON.stringify(result.output))
    assert(result.output.type === 'structuredOutput' && result.output.value)
    const { jobId } = z.object({ jobId: z.string().min(1) }).strict().parse(result.output.value)
    const rootState = result.sessionState?.mainAgentState
    assert(rootState?.runId)
    const parentRunId = rootState.runId
    assert.equal(barrierCalls, 1)
    assert(read.blocked() && !existsSync(wireFile), 'No child reply may have been produced at parent return or close')
    const observed = observedChild(spawns, spawnOffset, events, detachedChild.id)
    assertChildLive(observed)
    const action = originalSpawnAction(rootState, observed)
    assert.equal(action.outcome, 'succeeded')
    const intent = rootState.backgroundAgentJobs?.find(job => job.jobId === jobId)
    assert.equal(intent?.status, 'running')
    assert.equal(intent.parentRunId, parentRunId)
    assert.equal(intent.agentType, detachedChild.id)

    const parentBefore = journal.events(parentRunId)
    const parentTerminal = parentBefore.at(-1)
    assert(parentTerminal?.eventType === 'step_boundary')
    assert.deepEqual(parentTerminal.payload, {
      terminal: true, status: 'completed', runOutcome: result.runOutcome,
      taskAcceptance: result.taskAcceptance, actionOutcomes: rootState.actionOutcomes,
    })
    const isJobRow = (row: (typeof parentBefore)[number]) => row.eventType === 'spawn' && row.correlation === jobId
    assert.deepEqual(parentBefore.filter(isJobRow).map(row => row.payload), [{ agentType: detachedChild.id, background: true, jobId }])
    assert(!parentBefore.some(row => row.eventType === 'llm_request' ||
      (row.eventType === 'tool_call' && (row.payload as { toolName?: string }).toolName === 'check_background_agent')))

    read.release()
    await bounded(closing, 'built-in journal close after detached child settlement')
    assertChildJoined(observed)
    assert.equal(await bounded(observed.spawn.exited, 'detached compiled child exit'), 0)
    assert.equal(observed.spawn.signal(), null)
    assert.equal(read.calls(), 1)
    observedChild(spawns, spawnOffset, events, detachedChild.id) // No additional launch during close.

    const reopened = createRunJournal({ path: tapeFile })
    try {
      const parentRows = reopened.events(parentRunId)
      assert.deepEqual(parentRows.slice(0, parentBefore.length), parentBefore, 'Original parent tape must survive close')
      const jobRows = parentRows.filter(isJobRow)
      assert.equal(jobRows.length, 2)
      const settlement = jobRows[1]!
      assert(settlement.seq > parentTerminal.seq, 'The child must settle after the original parent terminal row')
      const { childRunId, receipt } = z.object({
        backgroundSettled: z.literal(true), jobId: z.literal(jobId), agentType: z.literal(detachedChild.id),
        childRunId: z.string().min(1), receipt: agentReceiptSchema,
      }).parse(settlement.payload)
      assert.notEqual(childRunId, parentRunId)
      assert.deepEqual(receipt, agentReceiptSchema.parse(JSON.parse(readFileSync(wireFile, 'utf8'))))
      assert.equal(receipt.status, 'completed', JSON.stringify(receipt))
      assert.equal(receipt.runOutcome?.termination, 'completed')
      assert.equal(receipt.agentId, observed.agentId)
      const childOutput = z.object({
        type: z.literal('structuredOutput'),
        value: z.object({ runId: z.string(), pid: z.number(), executable: z.string(), bun: z.string(), read: z.unknown(), nestedDetach: z.unknown() }),
      }).parse(receipt.output).value
      assert.match(JSON.stringify(childOutput.nestedDetach), /Detached background agents require an independent owner/)
      assert.equal(childOutput.runId, childRunId, 'Read tape by the actual supervised child run, not a synthetic ID')
      assert.equal(childOutput.pid, observed.spawn.pid)
      assert.equal(childOutput.executable, process.execPath)
      assert.equal(childOutput.bun, Bun.version)
      const [probe] = z.array(z.object({ type: z.literal('json'), value: readFilesResultV1Schema })).length(1).parse(childOutput.read)
      assert(probe && probe.value.status === 'ok' && probe.value.results.length === 1)
      const item = probe.value.results[0]!
      assert(item.path === probePath && item.selector === 'file' && item.status === 'ok' && item.complete)
      assert.equal(item.content, probeContent)

      assert.deepEqual(new Set(reopened.runIds()), new Set([parentRunId, childRunId]))
      const childRows = reopened.events(childRunId)
      assert(!childRows.some(row => row.eventType === 'llm_request'))
      const readRows = childRows.filter(row => (row.eventType === 'tool_call' || row.eventType === 'tool_result') &&
        (row.payload as { toolName?: string }).toolName === 'read_files')
      assert.deepEqual(readRows.map(row => row.eventType), ['tool_call', 'tool_result'])
      const [call, reply] = readRows
      assert(call?.correlation && reply?.correlation === call.correlation && reply.seq > call.seq)
      const requestPayload = z.object({ attemptId: z.string().min(1), basis: z.unknown(), input: z.unknown() }).parse(call.payload)
      assert.deepEqual(requestPayload.input, { paths: [probePath] })
      const replyPayload = z.object({ attemptId: z.string(), basis: z.unknown(), outcome: z.literal('succeeded'), result: z.unknown() }).parse(reply.payload)
      assert.equal(replyPayload.attemptId, requestPayload.attemptId)
      assert.deepEqual(replyPayload.basis, requestPayload.basis)
      assert.deepEqual(replyPayload.result, childOutput.read, 'The entire tool result must survive reopen')
      const terminal = childRows.at(-1)
      assert(terminal?.eventType === 'step_boundary' && terminal.correlation === childRunId && terminal.seq > reply.seq)
      const tail = z.object({ terminal: z.literal(true), status: z.literal('completed'), runOutcome: z.unknown() }).parse(terminal.payload)
      assert.deepEqual(tail.runOutcome, receipt.runOutcome)
      return {
        branch: observed.launch.facts.branchId, launchId: observed.launch.facts.launchId, correlation: observed.correlation,
        jobId, parentRunId, childRunId, pid: observed.spawn.pid, exitCode: 0,
        receiptId: receipt.receiptId, receiptStatus: receipt.status, journaledUnderOriginalParent: true,
        parentReturnedWhileChildBlocked: true, closePendingWhileChildBlocked: true,
        parentTerminalSeq: parentTerminal.seq, settlementSeq: settlement.seq,
        childReadResultSeq: reply.seq, childTerminalSeq: terminal.seq, fullChildToolResult: replyPayload.result,
        nestedDetachRefusedBeforeStart: true,
      }
    } finally {
      await reopened.close()
    }
  } finally {
    read.release()
    try {
      await bounded(running, 'detached parent fixture teardown')
    } finally {
      await bounded(Promise.all([
        closing ?? journal.close(),
        ...spawns.slice(spawnOffset).map(spawn => spawn.exited),
      ]), 'detached fixture journal and child teardown')
    }
  }
}

const pureProgram: ReplayProgram = {
  version: 1,
  operations: [
    { id: 'clock', kind: 'clock' },
    { id: 'nonce', kind: 'random' },
    { id: 'digest', kind: 'sha256', value: [{ input: 'source' }, ':', { result: 'nonce' }] },
  ],
}

function readPureTape(tape: string, write = false) {
  const db = new Database(tape, { readonly: !write });
  try {
    if (write) db.run("UPDATE program_events SET payload = '{}' WHERE seq = 1");
    const origin = db.query('SELECT run_id, agent_id, user_input_id, claimed FROM program_runs').get() as {
      run_id: string; agent_id: string; user_input_id: string; claimed: number
    }
    const rows = db.query('SELECT seq, kind, payload FROM program_events ORDER BY seq').all() as Array<{
      seq: number; kind: string; payload: string
    }>
    return { origin, rows }
  } finally { db.close() }
}

export async function checkSupervisedReplay() {
  const directories = new Set<string>()
  const source = 'b16-resume-keyless'
  const common = { program: pureProgram, inputs: { source }, parentRunId: 'b16-parent', rootRunId: 'b16-root' }
  const captureDir = (pid: number) => {
    const directory = readlinkSync(`/proc/${pid}/cwd`)
    assert.match(directory, /\/ob-replay-[^/]+$/)
    directories.add(directory)
    return directory
  }
  try {
    let prefix: ReturnType<typeof readPureTape> | undefined
    const boundaries: SupervisedReplayBoundary[] = []
    const resumed = await runSupervisedReplayableProgram({ ...common, onBoundary(boundary) {
      boundaries.push(boundary)
      if (boundary.generation !== 'initial' || boundary.confirmedAttempts !== 2) return
      prefix = readPureTape(join(captureDir(boundary.pid), SUPERVISED_REPLAY_TAPE))
      assert.deepEqual(prefix.rows.map(row => row.kind), ['request', 'reply', 'request', 'reply'])
      process.kill(boundary.pid, 'SIGKILL')
    } })
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed))
    assert(prefix)
    const [first, second, successor] = boundaries
    assert(first && second && successor)
    assert.deepEqual(boundaries.map(({ generation, confirmedAttempts }) => [generation, confirmedAttempts]), [
      ['initial', 1], ['initial', 2], ['resume', 3],
    ])
    assert.equal(first.pid, second.pid)
    assert.notEqual(first.pid, successor.pid)
    assert(boundaries.every(({ runId, jobId, pid }) => runId === resumed.job.runId && jobId === resumed.job.jobId && !existsSync(`/proc/${pid}`)))
    assert.deepEqual(resumed.cleanup.map(proof => [proof.status, proof.finalObservation.leader]), [
      ['complete', 'exited-reaped'], ['complete', 'exited-reaped'],
    ])
    const final = readPureTape(resumed.tapePath)
    assert.deepEqual(final.origin, { run_id: resumed.job.runId, agent_id: resumed.job.agentId, user_input_id: resumed.job.userInputId, claimed: 1 })
    assert.deepEqual(final.rows.slice(0, 4), prefix.rows)
    assert.deepEqual(final.rows.slice(4).map(row => row.kind), ['request', 'reply', 'terminal'])
    assert.equal(resumed.value.retainedAttempts, 2)
    assert.equal(resumed.value.newAttempts, 1)
    assert.equal(resumed.value.outputs.clock, JSON.parse(prefix.rows[1]!.payload).reply)
    assert.equal(resumed.value.outputs.nonce, JSON.parse(prefix.rows[3]!.payload).reply)
    assert.equal(resumed.value.outputs.digest, sha(`${source}:${resumed.value.outputs.nonce}`))
    assert.deepEqual(JSON.parse(final.rows[6]!.payload), { status: 'completed', outputSha256: sha(JSON.stringify(resumed.value.outputs)) })

    const controller = new AbortController()
    const cancelledPids: number[] = []
    const cancelled = await runSupervisedReplayableProgram({ ...common, signal: controller.signal, onBoundary(boundary) {
      cancelledPids.push(boundary.pid)
      captureDir(boundary.pid)
      controller.abort()
    } })
    assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled))
    assert(cancelled.tapePath)
    assert.deepEqual(cancelled.cleanup.map(proof => proof.finalObservation.leader), ['exited-reaped'])
    assert.equal(cancelledPids.length, 1)
    assert.equal(existsSync(`/proc/${cancelledPids[0]}`), false)
    assert.deepEqual(readPureTape(cancelled.tapePath).rows.map(row => row.kind), ['request', 'reply'])

    let tamperedPath: string | undefined
    const tampered = await runSupervisedReplayableProgram({ ...common, onBoundary(boundary) {
      assert.equal(boundary.generation, 'initial')
      tamperedPath = join(captureDir(boundary.pid), SUPERVISED_REPLAY_TAPE)
      readPureTape(tamperedPath, true)
      process.kill(boundary.pid, 'SIGKILL')
    } })
    assert.equal(tampered.status, 'replay_unavailable', JSON.stringify(tampered))
    assert(tamperedPath)
    const refused = readPureTape(tamperedPath)
    assert.equal(refused.origin.claimed, 0)
    assert.deepEqual(refused.rows.map(row => row.kind), ['request', 'reply'])
    return {
      runId: resumed.job.runId, agentId: resumed.job.agentId, jobId: resumed.job.jobId,
      killedPid: first.pid, successorPid: successor.pid, retainedAttempts: 2, newAttempts: 1,
      abort: { pid: cancelledPids[0], status: cancelled.status, reapedBeforeReturn: true },
      changedPrefix: { status: tampered.status, claimed: false, suffixDispatched: false },
    }
  } finally {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  }
}

const onceTool = 'b16_fixture_once'
const genericAgent: AgentDefinition = {
  id: 'b16-generic-root', displayName: 'B16 generic replay root', model: 'b16-offline',
  toolNames: [onceTool],
  handleSteps: function* ({ agentState }) {
    yield { toolName: 'b16_fixture_once', input: { runId: agentState.runId, agentId: agentState.agentId } } as unknown as ToolCall
    yield 'STEP' // Must never reach inference in either leg of this control.
  },
}

const markerFile = 'custom-effects.log'
const readyFile = 'pending.json'
const journalFile = 'generic.sqlite'
const replayProbe = (execute: (input: { runId: string; agentId: string }) => Promise<[]>) => getCustomToolDefinition({
  toolName: onceTool, description: 'An owned local counter; no external effects',
  inputSchema: z.object({ runId: z.string().min(1), agentId: z.string().min(1) }),
  execute,
})

export async function holdUnconfirmedTool(root: string) {
  const journal = createRunJournal({ path: join(root, journalFile) })
  try {
    const client = new OpenbuffClient({
      ...localSdkOptions(root, { OPENBUFF_PROCESS_SUPERVISION: '0' }),
      journalReader: journal, journalWriter: journal,
      customToolDefinitions: [replayProbe(async ({ runId, agentId }) => {
        const pending = classifyRunResume(journal, runId)
        assert(pending.kind === 'in_flight_tool', `Production tool_call not durable before effect: ${JSON.stringify(pending)}`)
        appendFileSync(join(root, markerFile), 'once\n', { mode: 0o600, flush: true })
        const partial = join(root, `${readyFile}.tmp`)
        writeFileSync(partial, JSON.stringify({ runId, agentId, toolCallId: pending.toolCallId, pid: process.pid }),
          { flag: 'wx', mode: 0o600 })
        renameSync(partial, join(root, readyFile))
        // Real fixture-owned worker is killed by the parent after the durable
        // call and effect, before a result can be returned to the SDK.
        await new Promise<never>(() => { setInterval(() => {}, 1_000) })
        return []
      })],
    })
    const result = await client.run({ agent: genericAgent, prompt: 'Invoke the local counter once' })
    throw new Error(`Replay worker ended instead of waiting: ${JSON.stringify(result.output)}`)
  } finally {
    await journal.close()
  }
}

export async function checkGenericReplayRefusal(root: string, networkCalls: () => number) {
  const ready = join(root, readyFile)
  const effects = join(root, markerFile)
  const worker = Bun.spawn([process.execPath, '--b16-generic-replay-worker', root], {
    cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, DO_NOT_TRACK: '1' },
    stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
  })
  try {
    // Read the marker only once the writer has atomically published it.
    const cutoff = performance.now() + 7_000
    while (!existsSync(ready) && worker.exitCode === null && performance.now() < cutoff) await Bun.sleep(10)
    assert(existsSync(ready), `Worker did not reach the unconfirmed local effect (exit ${worker.exitCode})`)
    const { runId, agentId, toolCallId, pid } = JSON.parse(readFileSync(ready, 'utf8')) as {
      runId: string; agentId: string; toolCallId: string; pid: number
    }
    assert.equal(pid, worker.pid)
    assert.equal(readFileSync(effects, 'utf8'), 'once\n')
    worker.kill('SIGKILL')
    await worker.exited
    assert.equal(worker.signalCode, 'SIGKILL')
    assert.equal(existsSync(`/proc/${pid}`), false)

    // Reopen the production journal independently after real process loss.
    // The minimal host-supplied checkpoint references the observed actual run;
    // it is not a verified prefix and does not carry any child resume claim.
    const journal = createRunJournal({ path: join(root, journalFile) })
    try {
      const before = journal.events(runId)
      assert.deepEqual(classifyRunResume(journal, runId), { kind: 'in_flight_tool', toolCallId })
      assert(before.some(row => row.eventType === 'tool_call' && row.correlation === toolCallId))
      assert(!before.some(row => row.eventType === 'llm_request' || row.eventType === 'tool_result'))
      const runIds = journal.runIds()
      const checkpoint = getInitialSessionState(fileContext(root))
      Object.assign(checkpoint.mainAgentState, { runId, agentId })
      let duplicateCustomCalls = 0
      const priorNetworkCalls = networkCalls()
      const client = new OpenbuffClient({
        ...localSdkOptions(root, { OPENBUFF_PROCESS_SUPERVISION: '0' }),
        journalReader: journal, journalWriter: journal,
        customToolDefinitions: [replayProbe(async () => {
          duplicateCustomCalls++
          appendFileSync(effects, 'duplicate\n', { flush: true })
          return []
        })],
      })
      const checkpointBefore = structuredClone(checkpoint)
      const result = await client.run({ agent: genericAgent, prompt: 'Resume the interrupted root', resumeInterruptedTurn: true,
        previousRun: { output: { type: 'error', message: 'Worker stopped before tool settlement' }, sessionState: checkpoint } })
      assert.equal(result.runOutcome?.termination, 'failed')
      assert.equal(result.runOutcome.cause?.code, 'replay_unavailable')
      assert.match(result.runOutcome.cause.message, /previous tool outcome is unconfirmed/)
      assert.deepEqual(checkpoint, checkpointBefore)
      assert.deepEqual(result.sessionState, {
        ...checkpointBefore,
        mainAgentState: {
          ...checkpointBefore.mainAgentState,
          runOutcome: result.runOutcome,
          taskAcceptance: { status: 'unknown' },
          actionOutcomes: [],
        },
      })
      assert.deepEqual(journal.events(runId), before)
      assert.deepEqual(journal.runIds(), runIds)
      assert.equal(duplicateCustomCalls, 0)
      assert.equal(networkCalls(), priorNetworkCalls)
      assert.equal(readFileSync(effects, 'utf8'), 'once\n')
      return { control: 'generic root run; not child replay', runId, toolCallId, workerPid: pid, workerSignal: worker.signalCode,
        code: result.runOutcome.cause.code, reason: 'unconfirmed_tool_effect', journalUnchanged: true,
        customOperations: 1, duplicateCustomCalls, providerOperations: 0 }
    } finally {
      await journal.close()
    }
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL')
    await worker.exited
    rmSync(ready, { force: true })
  }
}
