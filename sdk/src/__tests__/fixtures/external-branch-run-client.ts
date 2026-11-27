import { spyOn } from 'bun:test'
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { z } from 'zod/v4'
import { markMCPConfigOrigin } from '@codebuff/common/mcp/client'
import { OpenbuffClient } from '../../client'
import { getCustomToolDefinition } from '../../custom-tool'
import * as hostModule from '../../host-execution'
import * as mcpModule from '../../services/run-mcp-execution'
import { nodeConfigReadFs } from '../../host-config'
import { createNodeFileSystem } from '../../tools/node-filesystem'
import type { ChildProcess } from 'node:child_process'
import type { AgentDefinition, ToolCall } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { LaunchEvent, PolicyInput } from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { Control } from './external-branch-controls'

export type RunMcpEdge = 'discovery-start' | 'discovery-reuse' | 'call-start' | 'call-reuse'

/** Run creates the host, scopes, MCP service, action registrations and callbacks. */
export async function runClientMcpControl(edge: RunMcpEdge, control: Control) {
  const root = mkdtempSync(path.join(tmpdir(), 'b19-run-mcp-branch-'))
  const configFile = path.join(root, 'openbuff.json')
  writeFileSync(configFile, JSON.stringify({ autoFileChangeHooks: false, providers: {
    fixture: { type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['fixture-model'], apiKeyEnv: 'CUSTOM_PROVIDER_KEY' },
  } }))
  const environment = { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), PROJECT_VALUE: 'run-captured-public',
    OPENAI_API_KEY: 'run-canonical-sentinel', CUSTOM_PROVIDER_KEY: 'run-configured-sentinel',
    OPENBUFF_PROCESS_SUPERVISION: '0', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1' }
  const stop = new AbortController()
  const events: LaunchEvent[] = [], authorizations: PolicyInput[] = [], targetAuthorizations: PolicyInput[] = []
  const hosts: hostModule.RunHostServices[] = []
  const hostSnapshotIds: string[] = []
  const serviceRequests: Array<{ snapshotId: string; correlation: unknown; requestId?: string; signalAborted: boolean | undefined }> = []
  const serviceSnapshots: string[] = []
  const boundaryCalls: Array<{ family: string; launchId?: string; branch?: string; executable: string; argv: readonly string[];
    cwd: string | undefined; env: NodeJS.ProcessEnv; resourceSignalPresent: boolean; signalEqualsRunRequest: boolean }> = []
  const peerMessages: Array<{ method: string; name?: string; peer: number }> = []
  const checkpoints: Array<{ edge: RunMcpEdge; control: Control; peers: number; closedDiscoveryPeer: boolean;
    rootAbortedBefore: boolean; rootAbortedAfter: boolean }> = []
  const peers: ChildProcess[] = [], helpers: ChildProcess[] = [], helperExits: Promise<unknown>[] = []
  let startsAuthorized = 0, networkAttempts = 0, generatorEntered = false, originalExpiry: number | undefined
  let entered!: () => void, release!: () => void
  const authorizationEntered = new Promise<void>(resolve => { entered = resolve })
  const authorizationReleased = new Promise<void>(resolve => { release = resolve })
  const createHost = hostModule.createHostExecutionServices
  const createMcp = mcpModule.createRunMcpExecution
  const isTarget = (input: PolicyInput) => {
    if (input.facts.family !== 'mcp-stdio') return false
    if (input.facts.branchId === 'mcp.initial-connect') startsAuthorized++
    if (edge.endsWith('start')) return input.facts.branchId === 'mcp.initial-connect' && startsAuthorized >= (edge === 'call-start' ? 2 : 1)
    return input.facts.branchId === 'mcp.reuse' &&
      (edge === 'call-reuse' ? input.facts.correlation.kind === 'action' : input.facts.correlation.kind === 'host-operation')
  }
  const hostSpy = spyOn(hostModule, 'createHostExecutionServices').mockImplementation(options => {
    if (options.boundary.deadline.kind === 'finite') originalExpiry = options.boundary.deadline.expiresAtMs
    // The only policy change is the target control. All authority creation,
    // exact classification, basis checks, scopes and run lifetime stay real.
    const result = createHost({ ...options, authorizeAsync: async input => {
      authorizations.push(input)
      if (isTarget(input)) {
        targetAuthorizations.push(input)
        if (control === 'denied' || control === 'unavailable') return { ok: false, reason: control, cause: `run-${edge}-${control}` }
        if (control === 'delayed-authorizer-cancellation') { entered(); await authorizationReleased }
      }
      return { ok: true, basis: 'explicit-policy', decisionId: `run-branch-policy:${input.facts.launchId}` }
    } })
    if (result.ok) { hosts.push(result.value); hostSnapshotIds.push(options.snapshot.snapshotId) }
    return result
  })
  const serviceSpy = spyOn(mcpModule, 'createRunMcpExecution').mockImplementation(options => {
    serviceSnapshots.push(options.snapshot.snapshotId)
    const service = createMcp(options)
    return Object.freeze({ ...service, request: async (...args: Parameters<typeof service.request>) => {
      const registration = options.authority.actionRegistration(args[2].execution)
      serviceRequests.push({ snapshotId: options.snapshot.snapshotId, correlation: registration.ok ? registration.value.correlation : registration,
        signalAborted: args[2].signal?.aborted })
      return service.request(...args)
    } })
  })
  const forbid = () => { networkAttempts++; throw new Error('Provider/network calls forbidden in actual SDK MCP branch controls') }
  const networkSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => forbid(), { preconnect: forbid }))

  function armBeforeLaterEdge() {
    if (control === 'pre-aborted') stop.abort(new Error(`run-${edge}-pre-aborted`))
    if (control === 'deadline-zero' || control === 'exhausted-before-later-branch') {
      if (originalExpiry === undefined) throw new Error('Missing real run deadline')
      // Deliberately spend the captured finite root budget. No replacement
      // clock or newly registered authority is introduced by this fixture.
      while (performance.now() <= originalExpiry + 1) { /* bounded by runTimeoutMs */ }
    }
  }

  function peerChild(): ChildProcess {
    const peer = peers.length
    const child = new EventEmitter() as ChildProcess
    const stdout = new PassThrough(), stderr = new PassThrough()
    let buffered = ''
    const stdin = new Writable({ write(chunk, _encoding, done) {
      buffered += chunk.toString()
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1)
        if (!line) continue
        const message = JSON.parse(line)
        peerMessages.push({ method: message.method, name: message.params?.name, peer })
        if (message.id === undefined) continue
        const result = message.method === 'initialize'
          ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'run-branch-peer', version: '1' } }
          : message.method === 'tools/list' ? { tools: [{ name: 'record', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'run-branch-peer-result' }] }
        queueMicrotask(() => {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
          if (edge === 'discovery-reuse' && message.method === 'initialize') armBeforeLaterEdge()
        })
      }
      done()
    } })
    Object.assign(child, { pid: 51919 + peer, stdout, stderr, stdin, stdio: [stdin, stdout, stderr], exitCode: null, signalCode: null,
      kill: () => {
        if (child.exitCode !== null) return true
        Object.assign(child, { exitCode: 0 }); child.emit('exit', 0); child.emit('close', 0); return true
      } })
    peers.push(child)
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
  const spawn: CodebuffSpawn = (executable, argv, options) => {
    const isPeer = executable === '/fixture/run-mcp-peer'
    const admitted = [...authorizations].reverse().find(input => input.target.executable === executable)
    boundaryCalls.push({ family: isPeer ? 'mcp-stdio' : 'fixture-helper', launchId: admitted?.facts.launchId,
      branch: admitted?.facts.branchId, executable, argv: [...argv ?? []], cwd: options?.cwd?.toString(), env: { ...options?.env },
      resourceSignalPresent: !!options?.signal, signalEqualsRunRequest: options?.signal === stop.signal })
    if (isPeer) return peerChild()
    const child = nodeSpawn(executable, [...argv ?? []], options ?? {})
    helpers.push(child); helperExits.push(new Promise(resolve => child.once('close', resolve)))
    return child
  }
  const mcpConfig = { type: 'stdio' as const, command: '/fixture/run-mcp-peer', args: [], env: { PROJECT_VALUE: '$PROJECT_VALUE' } }
  markMCPConfigOrigin(mcpConfig, 'project')
  const checkpoint = getCustomToolDefinition({ toolName: 'b19_external_checkpoint',
    description: 'Coordinate the local external-branch fixture', inputSchema: z.object({}),
    execute: async () => {
      // Host custom execute callbacks retain their closure. Agent generators
      // are serialized, so all fixture state changes belong here.
      generatorEntered = true
      const before = stop.signal.aborted
      const closedDiscoveryPeer = edge === 'call-start' && peers[0] !== undefined
      if (closedDiscoveryPeer) peers[0]!.kill()
      if (edge.startsWith('call')) armBeforeLaterEdge()
      checkpoints.push({ edge, control, peers: peers.length, closedDiscoveryPeer,
        rootAbortedBefore: before, rootAbortedAfter: stop.signal.aborted })
      return [{ type: 'json', value: { checkpoint: 'generator-entered' } }]
    } })
  const program: AgentDefinition = {
    id: 'b19-external-run-branch', displayName: 'B19 actual run MCP branch', model: 'fixture-model',
    toolNames: ['peer/record', 'b19_external_checkpoint', 'set_output'], outputMode: 'structured_output',
    handleSteps: function* ({ prompt }) {
      // validateSingleAgent serializes this function. Everything referenced
      // here is local, a standard global, or an explicit context parameter.
      const scenario = JSON.parse(prompt ?? '{}')
      const results = []
      // The published ToolCall union enumerates built-ins. These two exact
      // external aliases are supplied by this host's custom-tool/MCP config;
      // the real runtime still validates their descriptor, schema and authority.
      const externalCall = (toolName: 'b19_external_checkpoint' | 'peer__record'): ToolCall =>
        ({ toolName, input: {} } as unknown as ToolCall)
      yield externalCall('b19_external_checkpoint')
      if (scenario.edge.startsWith('call')) {
        const count = scenario.control === 'happy' && scenario.edge === 'call-reuse' ? 2 : 1
        for (let index = 0; index < count; index++) {
          const { toolResult } = yield externalCall('peer__record')
          results.push(toolResult)
        }
      }
      yield { toolName: 'set_output', input: { results } }
    },
  }
  const client = new OpenbuffClient({ cwd: root, projectFiles: {}, knowledgeFiles: {}, harnessStateDir: path.join(root, 'harness'),
    hostConfiguration: { environment, platform: 'linux', invocationCwd: root, projectRoot: root,
      home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: configFile, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false } },
    configReadFs: nodeConfigReadFs, spawnSource: spawn, fsSource: createNodeFileSystem(), approvalMode: 'allow-all',
    recordExecution: event => events.push(event), mcpServers: { peer: mcpConfig }, customToolDefinitions: [checkpoint] })
  let result: Awaited<ReturnType<typeof client.run>> | undefined, error: unknown
  try {
    if (edge === 'discovery-start' && control === 'pre-aborted') stop.abort(new Error('run discovery pre-aborted'))
    const pending = client.run({ agent: program, prompt: JSON.stringify({ edge, control }), signal: stop.signal,
      runTimeoutMs: edge === 'discovery-start' && control === 'deadline-zero' ? 0 : 2000 })
    if (control === 'delayed-authorizer-cancellation') {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([authorizationEntered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Actual run target authorizer not reached: ${edge}`)), 3000) })])
        stop.abort(new Error(`run-${edge}-cancelled-during-authorization`))
      } finally { if (timer) clearTimeout(timer); release() }
    }
    result = await pending
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
  } catch (caught) { error = caught }
  finally {
    stop.abort(new Error('Actual run fixture complete'))
    for (const child of peers) child.kill()
    for (const child of helpers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.allSettled(helperExits)
    networkSpy.mockRestore(); serviceSpy.mockRestore(); hostSpy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
  return { edge, control, result, error, generatorEntered, originalExpiry, networkAttempts,
    hostCount: hosts.length, hostSnapshotIds,
    serviceSnapshots, serviceRequests, boundaryCalls, peerMessages, checkpoints, events, authorizations, targetAuthorizations }
}
