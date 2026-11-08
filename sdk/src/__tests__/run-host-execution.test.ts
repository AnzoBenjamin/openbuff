import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { OpenbuffClient } from '../client'
import * as hostExecution from '../host-execution'
import { nodeConfigReadFs } from '../host-config'
import { createNodeFileSystem } from '../tools/node-filesystem'

import type { ChildProcess } from 'node:child_process'
import type { AgentDefinition, ToolCall } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { LaunchEvent } from '@codebuff/common/types/contracts/execution-context'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { ConfigReadFs } from '../provider-config'
import type { HostConfigurationInputs } from '../host-config'
import type { OpenbuffClientOptions } from '../run'
import type { RunState } from '../run-state'

const roots: string[] = []
const children: ChildProcess[] = []
const childExits: Promise<unknown>[] = []
let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>
let hostSpy: ReturnType<typeof spyOn<typeof hostExecution, 'createHostExecutionServices'>>
let actualHosts: hostExecution.RunHostServices[] = []
let networkAttempts = 0
const createHost = hostExecution.createHostExecutionServices
beforeEach(() => {
  actualHosts = []
  networkAttempts = 0
  const forbidNetwork = () => { networkAttempts++; throw new Error('Network is forbidden in run execution fixtures') }
  network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => forbidNetwork(), { preconnect: forbidNetwork }))
  // Observe the actual run-created provider context without replacing its logic.
  hostSpy = spyOn(hostExecution, 'createHostExecutionServices').mockImplementation(options => {
    const result = createHost(options)
    if (result.ok) actualHosts.push(result.value)
    return result
  })
})
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await Promise.allSettled(childExits.splice(0))
  hostSpy.mockRestore()
  const networkCalls = network.mock.calls.length
  network.mockRestore()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  expect(networkCalls).toBe(0)
  expect(networkAttempts).toBe(0)
})

const program: AgentDefinition = {
  id: 'b19-programmatic-host', displayName: 'Local execution fixture', model: 'fixture-model',
  toolNames: ['run_terminal_command', 'run_file_change_hooks', 'set_output'], outputMode: 'structured_output',
  handleSteps: function* ({ prompt, agentState }) {
    const results = []
    for (const call of JSON.parse(prompt ?? '[]')) {
      const { toolResult } = yield call as ToolCall
      results.push(toolResult)
    }
    yield { toolName: 'set_output', input: { results, actor: { agentId: agentState.agentId, runId: agentState.runId } } }
  },
}

function fixture(configuration: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-run-host-')); roots.push(root)
  const configFile = path.join(root, 'openbuff.json')
  fs.writeFileSync(configFile, JSON.stringify({ autoFileChangeHooks: false, providers: {
    fixture: { type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['fixture-model'], apiKeyEnv: 'CUSTOM_PROVIDER_KEY' },
  }, ...configuration }))
  const environment: Record<string, string | undefined> = { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'),
    PROJECT_VALUE: 'host-public', DELETE_ME: 'host-delete', OPENAI_API_KEY: 'host-canonical-secret', CUSTOM_PROVIDER_KEY: 'host-configured-secret',
    OPENBUFF_PROCESS_SUPERVISION: '0', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1' }
  const hostConfiguration: HostConfigurationInputs = { environment, platform: 'linux', invocationCwd: root, projectRoot: root,
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: configFile, required: true },
    trust: { ancestorConfig: false, projectReadableRoots: false } }
  const configReads: string[] = []
  const configReadFs: ConfigReadFs = {
    readFile: file => { configReads.push(file); return nodeConfigReadFs.readFile(file) },
    stat: file => nodeConfigReadFs.stat(file), readDirectory: file => nodeConfigReadFs.readDirectory(file), realpath: file => nodeConfigReadFs.realpath(file),
  }
  const launches: Array<{ command: string; argv: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = []
  const spawned: ChildProcess[] = []
  const launch: CodebuffSpawn = (command, argv, options) => {
    launches.push({ command, argv: [...argv ?? []], env: options?.env })
    const child = spawn(command, [...argv ?? []], options ?? {})
    spawned.push(child)
    children.push(child)
    childExits.push(new Promise(resolve => child.once('close', resolve)))
    return child
  }
  const events: LaunchEvent[] = [], callbacks: PrintModeEvent[] = []
  const defaults: OpenbuffClientOptions = { cwd: root, projectFiles: {}, knowledgeFiles: {}, harnessStateDir: path.join(root, 'harness'),
    hostConfiguration, configReadFs, spawnSource: launch, fsSource: createNodeFileSystem(), approvalMode: 'allow-all',
    recordExecution: event => { events.push(event) }, handleEvent: event => { callbacks.push(event) } }
  const client = new OpenbuffClient(defaults)
  const run = (calls: unknown[], options: OpenbuffClientOptions = {}, signal?: AbortSignal) =>
    client.run({ agent: program, prompt: JSON.stringify(calls), ...options, signal })
  const terminal = (command: string, extra: Record<string, unknown> = {}) => ({ toolName: 'run_terminal_command', input: { command, process_type: 'SYNC', ...extra } })
  return { root, configFile, environment, hostConfiguration, configReadFs, configReads, launches, launch, spawned, events, callbacks, run, terminal }
}

function terminalStarts(events: LaunchEvent[]) {
  return events.filter((event): event is Extract<LaunchEvent, { phase: 'spawn-observed' }> =>
    event.phase === 'spawn-observed' && event.facts.family === 'sync-shell' && event.facts.branchId === 'terminal.sync')
}

function assertStructuredOutput(result: RunState) {
  if (result.output.type !== 'structuredOutput') throw new Error(`Expected programmatic output: ${JSON.stringify(result.output)}`)
  expect(result.output.type).toBe('structuredOutput')
}

describe('B19 actual programmatic run host wiring', () => {
  test('terminal callbacks retain actual B02 action/attempt/run identities and unbounded default/-1', async () => {
    const f = fixture()
    const result = await f.run([f.terminal('printf first'), f.terminal('printf second', { timeout_seconds: -1 })])
    assertStructuredOutput(result)
    expect(result.runOutcome?.termination).toBe('completed')
    const starts = terminalStarts(f.events)
    expect(starts).toHaveLength(2)
    const actions = result.actionOutcomes!.filter(action => action.toolName === 'run_terminal_command')
    expect(actions).toHaveLength(2)
    for (const start of starts) {
      const correlation = start.facts.correlation
      if (correlation.kind !== 'action') throw new Error('Tool launch lost B02 action correlation')
      const action = actions.find(action => action.actionId === correlation.actionId)!
      expect(action).toBeDefined()
      expect(action.attemptId).toBe(correlation.attemptId)
      expect(action.runId).toBe(result.sessionState!.mainAgentState.runId!)
      expect(correlation.owner.parentRunId).toBe(action.runId)
      expect(correlation.owner.rootRunId).toBe(action.runId)
      expect(correlation.owner.parentAgentId).toBe(result.sessionState!.mainAgentState.agentId)
      expect(start.facts.deadlines.requestAdmission.kind).toBe('unbounded')
      const callback = f.callbacks.find(event => event.type === 'tool_result' && event.actionOutcome?.actionId === action.actionId)
      expect(callback).toMatchObject({ type: 'tool_result', actionOutcome: action })
    }
    expect(new Set(starts.map(start => start.facts.correlation.kind === 'action' && start.facts.correlation.actionId)).size).toBe(2)
    expect(f.configReads.every(file => file === f.configFile)).toBe(true)
  }, 15_000)

  test('configured hooks default to 300 seconds, honor -1, and do not infer repository scripts', async () => {
    const f = fixture({ fileChangeHooks: [
      { name: 'default-cap', command: 'printf default-hook' },
      { name: 'unbounded', command: 'printf unbounded-hook', timeoutSeconds: -1 },
    ] })
    const forbidden = path.join(f.root, 'inferred-must-not-run')
    fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { test: `touch ${forbidden}`, lint: `touch ${forbidden}` } }))
    const before = hostExecution.executionClock.nowMs()
    const result = await f.run([{ toolName: 'run_file_change_hooks', input: { files: ['src/example.ts'] } }])
    const after = hostExecution.executionClock.nowMs()
    expect(result.output.type).toBe('structuredOutput')
    const hooks = f.events.filter((event): event is Extract<LaunchEvent, { phase: 'spawn-observed' }> =>
      event.phase === 'spawn-observed' && event.facts.family === 'configured-hook')
    expect(hooks).toHaveLength(2)
    expect(hooks.every(event => event.facts.branchId === 'hook.configured.project')).toBe(true)
    const bounded = hooks.find(event => event.facts.deadlines.requestAdmission.kind === 'finite')!
    const deadline = bounded.facts.deadlines.requestAdmission
    if (deadline.kind !== 'finite') throw new Error('Default hook deadline must be finite')
    expect(deadline.expiresAtMs).toBeGreaterThanOrEqual(before + 300_000)
    expect(deadline.expiresAtMs).toBeLessThanOrEqual(after + 300_000)
    expect(hooks.filter(event => event.facts.deadlines.requestAdmission.kind === 'unbounded')).toHaveLength(1)
    expect(fs.existsSync(forbidden)).toBe(false)
    expect(f.launches.some(launch => /^(npm|pnpm|bun)$/.test(launch.command))).toBe(false)
  }, 15_000)

  test.each(['journal', 'broker'])('an unavailable backend at %s bootstrap refuses before process dispatch', async bootstrap => {
    const f = fixture()
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-run-bootstrap-state-')); roots.push(stateDir)
    const result = await f.run([f.terminal('printf must-not-run')], { harnessStateDir: stateDir,
      ...(bootstrap === 'broker' ? { fsSource: undefined } : {}), executionProfile: {
      policy: 'full-access', preferredBackend: 'native-exec', required: ['exact-env'], allowBackendFallback: false,
    } })
    expect(f.launches).toEqual([])
    expect(f.events.some(event => event.phase === 'dispatched')).toBe(false)
    expect(JSON.stringify(result)).toMatch(/unavailable|required|backend/i)
  }, 15_000)

  test('the root deadline starts before a blocking configuration read', async () => {
    const f = fixture()
    let blocked = false
    const reader: ConfigReadFs = { ...f.configReadFs, readFile(file) {
      if (!blocked) {
        blocked = true
        const until = performance.now() + 40
        while (performance.now() < until) { /* deliberately block synchronous setup */ }
      }
      return f.configReadFs.readFile(file)
    } }
    const result = await f.run([f.terminal('printf must-not-run')], { runTimeoutMs: 10, configReadFs: reader })
    expect(blocked).toBe(true)
    expect(result.runOutcome?.termination).toBe('deadline_exhausted')
    expect(f.launches).toEqual([])
    expect(f.events.some(event => event.phase === 'dispatched')).toBe(false)
  })

  test('a pending asynchronous spawn setup cannot renew the root deadline', async () => {
    const f = fixture()
    let release!: (launch: CodebuffSpawn) => void
    const pending = new Promise<CodebuffSpawn>(resolve => { release = resolve })
    const result = await f.run([f.terminal('printf must-not-run')], { runTimeoutMs: 20, spawnSource: pending })
    release(f.launch)
    expect(result.runOutcome?.termination).toBe('deadline_exhausted')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.launches).toEqual([])
  })

  test('same-text caller cancellation during asynchronous setup remains cancelled', async () => {
    const f = fixture(), stop = new AbortController()
    let release!: (launch: CodebuffSpawn) => void
    const spawnSource = new Promise<CodebuffSpawn>(resolve => { release = resolve })
    const pending = f.run([f.terminal('printf must-not-run')], { runTimeoutMs: 5_000, spawnSource }, stop.signal)
    await new Promise<void>(resolve => setImmediate(resolve))
    stop.abort(new Error('Execution deadline exhausted'))
    const result = await pending
    release(f.launch)
    expect(result.runOutcome).toMatchObject({ termination: 'cancelled', cause: { code: 'run_cancelled' } })
    expect(f.launches).toEqual([])
  })

  test('same-text caller cancellation during an actual SDK terminal action remains cancelled', async () => {
    const f = fixture(), stop = new AbortController()
    let started!: () => void
    const start = new Promise<void>(resolve => { started = resolve })
    const pending = f.run([f.terminal('/usr/bin/sleep 30')], {
      runTimeoutMs: 5_000,
      recordExecution(event) {
        f.events.push(event)
        if (event.phase === 'spawn-observed' && event.facts.branchId === 'terminal.sync') started()
      },
    }, stop.signal)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([start, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SDK terminal did not start within 1s')), 1_000)
      })])
      stop.abort(new Error('Execution deadline exhausted'))
      const result = await pending
      expect(result.runOutcome).toMatchObject({ termination: 'cancelled', cause: { code: 'run_cancelled' } })
      expect(result.sessionState).toBeDefined()
      expect(terminalStarts(f.events)).toHaveLength(1)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      stop.abort(new Error('Fixture cleanup'))
      await pending
    }
  })

  test.each([false, true])('child inheritance=%s preserves deletion and keeps provider credentials separate', async inheritEnv => {
    const f = fixture(), recorder = path.join(f.root, 'recorder.cjs'), observed = path.join(f.root, 'observed.json')
    fs.writeFileSync(recorder, 'require("node:fs").writeFileSync(process.argv[2],JSON.stringify(process.env))')
    const env = { PROJECT_VALUE: 'child-public', DELETE_ME: undefined, OPENAI_API_KEY: 'child-reinsert', CUSTOM_PROVIDER_KEY: 'child-reinsert-custom' }
    const result = await f.run([f.terminal(`/usr/bin/node '${recorder}' '${observed}'`)], { inheritEnv, env })
    expect(result.output.type).toBe('structuredOutput')
    const recorded = JSON.parse(fs.readFileSync(observed, 'utf8'))
    expect(recorded.PROJECT_VALUE).toBe('child-public')
    expect(recorded.DELETE_ME).toBeUndefined()
    expect(recorded.OPENAI_API_KEY).toBeUndefined()
    expect(recorded.CUSTOM_PROVIDER_KEY).toBeUndefined()
    expect(recorded.HOME).toBe(inheritEnv ? f.environment.HOME : undefined)
    expect(actualHosts).toHaveLength(1)
    expect(actualHosts[0].provider.credentialEnvironment.OPENAI_API_KEY).toBe('host-canonical-secret')
    expect(actualHosts[0].provider.credentialEnvironment.CUSTOM_PROVIDER_KEY).toBe('host-configured-secret')
    expect(actualHosts[0].provider.credentialEnvironment.PROJECT_VALUE).toBe('host-public')
    expect(JSON.stringify(f.events)).not.toContain('host-canonical-secret')
  }, 15_000)

  test('configuration and child env stay captured while asynchronous setup waits', async () => {
    const f = fixture(), recorder = path.join(f.root, 'recorder.cjs'), observed = path.join(f.root, 'observed.json')
    fs.writeFileSync(recorder, 'require("node:fs").writeFileSync(process.argv[2],JSON.stringify(process.env))')
    let release!: (launch: CodebuffSpawn) => void
    const ready = new Promise<CodebuffSpawn>(resolve => { release = resolve })
    const env = { PROJECT_VALUE: 'first-child' }
    const pending = f.run([f.terminal(`/usr/bin/node '${recorder}' '${observed}'`)], { spawnSource: ready, env })
    f.environment.PROJECT_VALUE = 'late-host'
    f.environment.OPENAI_API_KEY = 'late-host-secret'
    env.PROJECT_VALUE = 'late-child'
    release(f.launch)
    const result = await pending
    expect(result.output.type).toBe('structuredOutput')
    expect(JSON.parse(fs.readFileSync(observed, 'utf8')).PROJECT_VALUE).toBe('first-child')
    expect(actualHosts[0].provider.credentialEnvironment.PROJECT_VALUE).toBe('host-public')
    expect(actualHosts[0].provider.credentialEnvironment.OPENAI_API_KEY).toBe('host-canonical-secret')
  }, 15_000)

  test('synchronous config readers cannot change the already captured child env or execution profile', async () => {
    const f = fixture(), recorder = path.join(f.root, 'recorder.cjs'), observed = path.join(f.root, 'observed.json')
    fs.writeFileSync(recorder, 'require("node:fs").writeFileSync(process.argv[2],JSON.stringify(process.env))')
    const env = { PROJECT_VALUE: 'before-config-read' }
    const profile: NonNullable<OpenbuffClientOptions['executionProfile']> = { policy: 'full-access', preferredBackend: 'portable-ts',
      required: ['exact-env'], allowBackendFallback: false }
    const callerProfile = { ...profile }
    const reader: ConfigReadFs = { ...f.configReadFs, readFile(file) {
      env.PROJECT_VALUE = 'during-config-read'
      callerProfile.preferredBackend = 'native-exec'
      f.environment.OPENAI_API_KEY = 'during-config-secret'
      return f.configReadFs.readFile(file)
    } }
    const result = await f.run([f.terminal(`/usr/bin/node '${recorder}' '${observed}'`)], { env, executionProfile: callerProfile, configReadFs: reader })
    expect(result.output.type).toBe('structuredOutput')
    expect(JSON.parse(fs.readFileSync(observed, 'utf8')).PROJECT_VALUE).toBe('before-config-read')
    expect(terminalStarts(f.events)[0].facts.profile.selected?.backend).toBe('portable-ts')
    expect(actualHosts[0].provider.credentialEnvironment.OPENAI_API_KEY).toBe('host-canonical-secret')
  }, 15_000)

  test('detached real child survives sender cancellation but stops at the transferred finite cap', async () => {
    const f = fixture(), stop = new AbortController(), recorder = path.join(f.root, 'background.cjs'), observed = path.join(f.root, 'ticks')
    fs.writeFileSync(recorder, 'const fs=require("node:fs");const p=process.argv[2];fs.appendFileSync(p,"start\\n");setInterval(()=>fs.appendFileSync(p,"tick\\n"),30)')
    const command = `exec /usr/bin/node '${recorder}' '${observed}'`
    const result = await f.run([f.terminal(command, { process_type: 'BACKGROUND', detach: true, timeout_seconds: 1.5 })], {}, stop.signal)
    expect(result.output.type).toBe('structuredOutput')
    const launchIndex = f.launches.findIndex(launch => launch.argv.some(arg => arg.includes(recorder)))
    expect(launchIndex).toBeGreaterThanOrEqual(0)
    const child = f.spawned[launchIndex]
    const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('close', resolve))
    const until = performance.now() + 1000
    while (!fs.existsSync(observed)) {
      if (performance.now() > until) throw new Error('Detached recorder never started')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const before = fs.readFileSync(observed, 'utf8').length
    stop.abort(new Error('sender run cancelled after detach'))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(fs.readFileSync(observed, 'utf8').length).toBeGreaterThan(before)
    const transferred = f.events.find(event => event.phase === 'resource-transferred')!
    const started = f.events.find(event => event.phase === 'spawn-observed' && event.facts.branchId === 'background.transferred')!
    expect(transferred?.phase).toBe('resource-transferred')
    if (transferred.phase !== 'resource-transferred' || started.phase !== 'spawn-observed') throw new Error('Missing detached transfer/start evidence')
    expect(started.facts.ownerId).toBe(transferred.newOwnerId)
    expect(started.facts.ownerId).not.toBe(transferred.oldOwnerId)
    expect(started.facts.deadlines.resourceLifetime).toEqual(transferred.resourceLifetime)
    expect(transferred.resourceLifetime.kind).toBe('finite')
    await closed
    expect(child.signalCode).not.toBeNull()
  }, 10_000)
})
