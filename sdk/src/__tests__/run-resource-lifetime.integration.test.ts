import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { markMCPConfigOrigin } from '@codebuff/common/mcp/client'
import { OpenbuffClient } from '../client'
import { nodeConfigReadFs } from '../host-config'
import { createNodeFileSystem } from '../tools/node-filesystem'

import type { ChildProcess } from 'node:child_process'
import type { AgentDefinition, ToolCall } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { LaunchEvent } from '@codebuff/common/types/contracts/execution-context'
import type { MCPConfig } from '@codebuff/common/types/mcp'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { OpenbuffClientOptions } from '../run'
import type { RunState } from '../run-state'

type PeerEvent = { event: string; at: number; pid?: number; method?: string; signal?: string; code?: number | null }
type OwnedChild = { child: ChildProcess; peer: boolean; closed: boolean; close: Promise<void> }
type LifetimeFixture = {
  name: string; root: string; peerFile: string; peerLog: string
  record: (event: Omit<PeerEvent, 'at'>) => void
  stop: AbortController; children: OwnedChild[]; execution: LaunchEvent[]
  peerEvents: () => PeerEvent[]; parentEvents: () => PeerEvent[]
  run: (calls: unknown[], extra?: OpenbuffClientOptions) => Promise<RunState>
}
const fixtures: LifetimeFixture[] = []
let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>
let networkAttempts = 0
beforeEach(() => {
  networkAttempts = 0
  const forbidden = () => { networkAttempts++; throw new Error('Network forbidden in resource lifetime integration') }
  network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => forbidden(), { preconnect: forbidden }))
})
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.record({ event: 'test-teardown-started' })
    f.stop.abort(new Error('Fixture teardown, after lifecycle observation'))
    await waitUntil(() => f.children.every(entry => entry.closed), 500)
    for (const { child, closed } of f.children) if (!closed) child.kill('SIGKILL')
    await Promise.all(f.children.map(entry => entry.close))
    console.log('B19_RESOURCE_TEARDOWN', JSON.stringify({ name: f.name, parent: f.parentEvents(), peer: f.peerEvents() }))
    fs.rmSync(f.root, { recursive: true, force: true })
  }
  const calls = network.mock.calls.length
  network.mockRestore()
  expect(calls).toBe(0)
  expect(networkAttempts).toBe(0)
})

const program: AgentDefinition = {
  id: 'b19-resource-lifetime', displayName: 'Resource lifetime fixture', model: 'fixture-model',
  toolNames: ['peer/record', 'run_terminal_command', 'set_output'], outputMode: 'structured_output',
  handleSteps: function* ({ prompt }) {
    const results = []
    for (const call of JSON.parse(prompt ?? '[]')) {
      const { toolResult } = yield call as ToolCall
      results.push(toolResult)
    }
    yield { toolName: 'set_output', input: { results } }
  },
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitUntil(predicate: () => boolean, graceMs: number): Promise<boolean> {
  const until = performance.now() + graceMs
  while (!predicate() && performance.now() < until) await delay(10)
  return predicate()
}
function readEvents(file: string): PeerEvent[] {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
function fixture(name: string): LifetimeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-resource-lifetime-'))
  const peerFile = path.join(root, 'peer.cjs'), peerLog = path.join(root, 'peer.jsonl'), parentLog = path.join(root, 'parent.jsonl')
  fs.copyFileSync(path.join(import.meta.dir, 'fixtures/b19-resource-peer.cjs'), peerFile)
  const configFile = path.join(root, 'openbuff.json')
  fs.writeFileSync(configFile, JSON.stringify({ autoFileChangeHooks: false, providers: {
    fixture: { type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['fixture-model'], apiKeyEnv: 'CUSTOM_PROVIDER_KEY' },
  } }))
  const environment = { PATH: '/usr/bin:/bin', OPENBUFF_PROCESS_SUPERVISION: '0', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1' }
  const stop = new AbortController(), children: OwnedChild[] = [], execution: LaunchEvent[] = []
  const record = (event: Omit<PeerEvent, 'at'>) => fs.appendFileSync(parentLog, JSON.stringify({ at: Date.now(), ...event }) + '\n')
  const launch: CodebuffSpawn = (command, argv, options) => {
    const child = spawn(command, [...argv ?? []], options ?? {})
    const entry: OwnedChild = { child, peer: argv?.some(arg => arg.includes(peerFile)) ?? false, closed: false, close: Promise.resolve() }
    entry.close = new Promise(resolve => child.once('close', (code, signal) => {
      entry.closed = true
      if (entry.peer) record({ event: 'child-close', pid: child.pid, code, signal: signal ?? undefined })
      resolve()
    }))
    if (entry.peer) {
      child.once('spawn', () => record({ event: 'child-spawn', pid: child.pid }))
      child.once('error', () => record({ event: 'child-error', pid: child.pid }))
    }
    children.push(entry)
    return child
  }
  const options: OpenbuffClientOptions = {
    cwd: root, projectFiles: {}, knowledgeFiles: {}, harnessStateDir: path.join(root, 'harness'),
    hostConfiguration: { environment, platform: 'linux', invocationCwd: root, projectRoot: root,
      home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: configFile, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false } },
    configReadFs: nodeConfigReadFs, spawnSource: launch, fsSource: createNodeFileSystem(), approvalMode: 'allow-all',
    recordExecution: event => { execution.push(event) },
  }
  const client = new OpenbuffClient(options)
  const result = { name, root, peerFile, peerLog, record, stop, children, execution,
    peerEvents: () => readEvents(peerLog), parentEvents: () => readEvents(parentLog),
    run: (calls: unknown[], extra: OpenbuffClientOptions = {}) => client.run({ agent: program, prompt: JSON.stringify(calls), ...extra, signal: stop.signal }),
  }
  fixtures.push(result)
  return result
}

describe('B19 actual SDK run resource lifetime', () => {
  test('normal completion closes its real reusable MCP child', async () => {
    const f = fixture('normal-mcp')
    const config: MCPConfig = { type: 'stdio', command: '/usr/bin/node', args: [f.peerFile, 'mcp', f.peerLog], env: {} }
    markMCPConfigOrigin(config, 'project')
    const result = await f.run([{ toolName: 'peer__record', input: {} }, { toolName: 'peer__record', input: {} }], { mcpServers: { peer: config } })
    f.record({ event: 'run-returned' })
    const peers = f.children.filter(entry => entry.peer)
    const closed = await waitUntil(() => peers.length > 0 && peers.every(entry => entry.closed), 1000)
    const peerEvents = f.peerEvents(), parentEvents = f.parentEvents()
    console.log('B19_RESOURCE_OBSERVATION', JSON.stringify({ name: f.name, output: result.output,
      termination: result.runOutcome?.termination, externallyAborted: f.stop.signal.aborted, closed,
      children: peers.map(entry => ({ pid: entry.child.pid, closed: entry.closed, exitCode: entry.child.exitCode, signalCode: entry.child.signalCode })),
      parent: parentEvents, peer: peerEvents, execution: f.execution, actions: result.actionOutcomes }))
    expect(result.output.type).toBe('structuredOutput')
    expect(result.runOutcome?.termination).toBe('completed')
    expect(f.stop.signal.aborted).toBe(false)
    expect(peers).toHaveLength(1)
    expect(peerEvents.filter(event => event.method === 'initialize')).toHaveLength(1)
    expect(peerEvents.some(event => event.method === 'tools/list')).toBe(true)
    expect(peerEvents.filter(event => event.method === 'tools/call')).toHaveLength(2)
    const start = f.execution.find(event => event.phase === 'spawn-observed' && event.facts.family === 'mcp-stdio')
    if (start?.phase !== 'spawn-observed') throw new Error('Missing observed MCP spawn')
    const reused = f.execution.filter(event => event.phase === 'resource-reused' && event.facts.family === 'mcp-stdio')
    expect(reused.filter(event => event.phase === 'resource-reused' && event.facts.correlation.kind === 'action')).toHaveLength(2)
    for (const event of reused) {
      if (event.phase !== 'resource-reused') continue
      expect(event.facts.resourceId).toBe(start.facts.resourceId)
      expect(event.processObservationId).toBe(start.processObservationId)
      if (event.facts.correlation.kind !== 'action') continue
      const correlation = event.facts.correlation
      expect(result.actionOutcomes?.some(action => action.actionId === correlation.actionId && action.attemptId === correlation.attemptId)).toBe(true)
    }
    expect(parentEvents.some(event => event.event === 'test-teardown-started')).toBe(false)
    expect(closed).toBe(true)
    expect(peerEvents.some(event => event.event === 'exit')).toBe(true)
    expect(parentEvents.some(event => event.event === 'child-close' && event.pid === peers[0].child.pid)).toBe(true)
  }, 20_000)

  test('normal completion preserves a transferred detached child until its finite cap', async () => {
    const f = fixture('normal-detached')
    const result = await f.run([{ toolName: 'run_terminal_command', input: {
      command: `exec /usr/bin/node '${f.peerFile}' background '${f.peerLog}'`, process_type: 'BACKGROUND', detach: true, timeout_seconds: 1.5,
    } }])
    f.record({ event: 'run-returned' })
    expect(result.output.type).toBe('structuredOutput')
    expect(result.runOutcome?.termination).toBe('completed')
    expect(await waitUntil(() => f.peerEvents().some(event => event.event === 'start'), 1000)).toBe(true)
    const peers = f.children.filter(entry => entry.peer)
    expect(peers).toHaveLength(1)
    const initialHeartbeats = f.peerEvents().filter(event => event.event === 'heartbeat').length
    await delay(120)
    expect(f.peerEvents().filter(event => event.event === 'heartbeat').length).toBeGreaterThan(initialHeartbeats)
    expect(peers[0].closed).toBe(false)
    expect(f.stop.signal.aborted).toBe(false)
    const transfer = f.execution.find(event => event.phase === 'resource-transferred')
    const start = f.execution.find(event => event.phase === 'spawn-observed' && event.facts.branchId === 'background.transferred')
    if (transfer?.phase !== 'resource-transferred' || start?.phase !== 'spawn-observed') throw new Error('Missing actual detached transfer evidence')
    expect(start.facts.ownerId).toBe(transfer.newOwnerId)
    expect(transfer.newOwnerId).not.toBe(transfer.oldOwnerId)
    expect(start.facts.deadlines.resourceLifetime).toEqual(transfer.resourceLifetime)
    expect(transfer.resourceLifetime.kind).toBe('finite')
    expect(await waitUntil(() => peers[0].closed, 3000)).toBe(true)
    const peerEvents = f.peerEvents(), parentEvents = f.parentEvents()
    console.log('B19_RESOURCE_OBSERVATION', JSON.stringify({ name: f.name, termination: result.runOutcome?.termination,
      externallyAborted: f.stop.signal.aborted, parent: parentEvents, peer: peerEvents, execution: f.execution }))
    // The deadline adapter uses SIGKILL, which cannot run a peer exit hook.
    // The actual child close event, before test teardown, proves termination.
    expect(parentEvents.some(event => event.event === 'child-close' && event.pid === peers[0].child.pid)).toBe(true)
    expect(peers[0].child.exitCode !== null || peers[0].child.signalCode !== null).toBe(true)
    expect(parentEvents.some(event => event.event === 'test-teardown-started')).toBe(false)
  }, 20_000)
})
