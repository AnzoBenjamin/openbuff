import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { callMCPTool, closeMCPClient, listMCPToolCatalog, markMCPConfigOrigin } from '@codebuff/common/mcp/client'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { createHostExecutionServices } from '../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { createRunMcpExecution } from '../services/run-mcp-execution'

import type { ChildProcess } from 'node:child_process'
import type { MCPConfig, MCPConfigOrigin } from '@codebuff/common/types/mcp'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { Result } from '@codebuff/common/types/contracts/execution-context'
import type { MediatedMcpRequest } from '@codebuff/common/mcp/client'

const roots: string[] = []
const stops: AbortController[] = []
const clients = new Set<string>()
const childExits: Promise<unknown>[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) stop.abort(new Error('MCP test owner closed'))
  await Promise.allSettled([...clients].map(id => closeMCPClient(id)))
  clients.clear()
  await Promise.allSettled(childExits.splice(0))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`); return result.value }

const resolvedNodeExecutable = Bun.which('node')
if (!resolvedNodeExecutable) throw new Error('The real run MCP execution fixture requires Node on PATH')
// Bind the narrowed value so the string (not string | null) flows into the
// config factory below; the guard's narrowing does not cross the closure.
const nodeExecutable: string = resolvedNodeExecutable

// A real Node JSON-RPC stdio peer through the Node adapter. Execute outside the
// sandbox: recorded probes isolate the sandbox's child-pipe failure. Env and
// requests are recorded on disk independently of the protocol output.
const server = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const directory = process.argv[2];
const record = (event) => fs.appendFileSync(directory + '/events.jsonl', JSON.stringify({pid:process.pid,...event})+'\n');
record({event:'start', env:process.env});
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
readline.createInterface({input:process.stdin}).on('line', async line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  record({event:'request',method:message.method,name:message.params?.name});
  let result;
  if (message.method === 'initialize') result = {protocolVersion:message.params.protocolVersion,capabilities:{tools:{listChanged:true}},serverInfo:{name:'b19-run-mcp',version:'1'}};
  else if (message.method === 'tools/list') result = {tools:['record','wait','change','exit'].map(name=>({name,inputSchema:{type:'object'}}))};
  else {
    const name = message.params.name;
    if (name === 'exit') { process.exit(0); return; }
    if (name === 'wait') await new Promise(resolve => setTimeout(resolve, 250));
    if (name === 'change') send({jsonrpc:'2.0',method:'notifications/tools/list_changed'});
    result = {content:[{type:'text',text:JSON.stringify({pid:process.pid,name})}],structuredContent:{pid:process.pid,name}};
  }
  send({jsonrpc:'2.0',id:message.id,result});
});`

function fixture(existingRoot?: string, environment: Record<string, string | undefined> = {}) {
  const root = existingRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-run-mcp-'))
  if (!existingRoot) {
    roots.push(root)
    fs.writeFileSync(path.join(root, 'server.cjs'), server)
    fs.writeFileSync(path.join(root, 'openbuff.json'), JSON.stringify({ providers: {
      fixture: { type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['fixture-model'], apiKeyEnv: 'CUSTOM_PROVIDER_KEY' },
    } }))
  }
  const sourceEnvironment = { PATH: '/usr/bin:/bin', PROJECT_VALUE: 'captured-public', OPENAI_API_KEY: 'canonical-fixture-secret',
    CUSTOM_PROVIDER_KEY: 'configured-fixture-secret', OPENBUFF_ALLOWED_LOOPBACK_MCP: '127.0.0.1:4567', ...environment }
  const captured = loadHostConfigSnapshot({ inputs: { environment: sourceEnvironment, platform: 'linux', invocationCwd: root, projectRoot: root,
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: 'openbuff.json', required: true },
    trust: { ancestorConfig: false, projectReadableRoots: false } }, fs: nodeConfigReadFs })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  const stop = new AbortController(); stops.push(stop)
  const clock = { domainId: `run-mcp:${root}`, nowMs: () => performance.now() }
  const children: ChildProcess[] = []
  const launches: Array<{ command: string; argv: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = []
  const launch: CodebuffSpawn = (command, argv, options) => {
    launches.push({ command, argv: [...argv ?? []], env: options?.env })
    const child = spawn(command, [...argv ?? []], options ?? {})
    children.push(child)
    childExits.push(new Promise(resolve => child.once('close', resolve)))
    return child
  }
  const host = value(createHostExecutionServices({ snapshot: captured.snapshot, clock, signal: stop.signal,
    boundary: value(captureRootDeadline({ clock, limit: { kind: 'unbounded' } })), childInheritanceEnvironment: sourceEnvironment,
    // Explicit host policy makes this fixture about mediation and origin/env,
    // including untrusted client configs; separate approval tests gate startup.
    authorizeAsync: async () => ({ ok: true, basis: 'explicit-policy', decisionId: 'run-mcp-fixture-policy' }) }))
  const mcp = createRunMcpExecution({ snapshot: captured.snapshot, authority: host.execution, rootLifetime: host.rootLifetime, spawn: launch })
  const scope = (id = 'one') => value(host.registerRun({ clientSessionId: 'session', rootRunId: `run-${id}`, parentRunId: `run-${id}`, parentAgentId: `agent-${id}` }))
  const config = (origin: MCPConfigOrigin = 'project', env: Record<string, string> = {}): MCPConfig => {
    const result: MCPConfig = { type: 'stdio', command: nodeExecutable, args: [path.join(root, 'server.cjs'), root], env }
    markMCPConfigOrigin(result, origin)
    return result
  }
  const events = () => fs.existsSync(path.join(root, 'events.jsonl'))
    ? fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const remember = (access: MediatedMcpRequest) => { clients.add(access.id); return access }
  return { root, stop, sourceEnvironment, host, mcp, scope, config, events, remember, children, launches }
}

describe('B19 run-owned MCP execution', () => {
  test('remote capture retains original headers, URL and loopback without opening a connection', () => {
    const f = fixture()
    const config: MCPConfig = { type: 'http', url: 'http://127.0.0.1:4567/mcp', params: { source: 'captured' },
      headers: { Authorization: '$CUSTOM_PROVIDER_KEY' } }
    markMCPConfigOrigin(config, 'user')
    const captured = f.mcp.capture(config)
    config.url = 'http://127.0.0.1:9999/retargeted'
    config.headers.Authorization = 'late-header'
    config.params.source = 'late-param'
    f.sourceEnvironment.CUSTOM_PROVIDER_KEY = 'late-credential'
    expect(f.mcp.capture(config)).toBe(captured)
    expect(captured.resolved).toEqual({ type: 'http', url: 'http://127.0.0.1:4567/mcp', params: { source: 'captured' },
      headers: { Authorization: 'configured-fixture-secret' } })
    expect(captured.allowedLoopbackMcp).toEqual(['127.0.0.1:4567'])
    expect(f.launches).toEqual([])
  })

  test('captures config, expansion environment and loopback once before later caller/global mutation', async () => {
    const f = fixture(), scope = f.scope()
    const config = f.config('project', { PROJECT_VALUE: '$PROJECT_VALUE' })
    const captured = f.mcp.capture(config)
    const old = process.env.PROJECT_VALUE
    try {
      process.env.PROJECT_VALUE = 'ambient-after-capture'
      f.sourceEnvironment.PROJECT_VALUE = 'caller-after-capture'
      f.sourceEnvironment.OPENBUFF_ALLOWED_LOOPBACK_MCP = '127.0.0.1:9999'
      if (config.type !== 'stdio') throw new Error('Expected stdio')
      config.env.PROJECT_VALUE = 'config-after-capture'
      config.args.push('after-capture')
      expect(f.mcp.capture(config)).toBe(captured)
      expect(captured.allowedLoopbackMcp).toEqual(['127.0.0.1:4567'])
      const access = f.remember(await f.mcp.request(config, scope, value(scope.operation())))
      await access.callTool({ name: 'record', arguments: {} })
      expect(f.events().find(event => event.event === 'start').env.PROJECT_VALUE).toBe('captured-public')
      expect(f.launches[0].argv).toEqual([path.join(f.root, 'server.cjs'), f.root])
      access.release()
    } finally { if (old === undefined) delete process.env.PROJECT_VALUE; else process.env.PROJECT_VALUE = old }
  })

  test.each([...(['project', 'user', 'client'] as const)])('only explicitly declared trusted %s credentials reach a child', async origin => {
    const f = fixture(), scope = f.scope()
    const config = f.config(origin, { PROJECT_VALUE: '$PROJECT_VALUE', CUSTOM_PROVIDER_KEY: '$CUSTOM_PROVIDER_KEY' })
    const access = f.remember(await f.mcp.request(config, scope, value(scope.operation())))
    await access.callTool({ name: 'record', arguments: {} })
    const observed = f.events().find(event => event.event === 'start').env
    expect(observed.OPENAI_API_KEY).toBeUndefined()
    expect(observed.CUSTOM_PROVIDER_KEY).toBe(origin === 'client' ? undefined : 'configured-fixture-secret')
    expect(observed.PROJECT_VALUE).toBe(origin === 'client' ? '$PROJECT_VALUE' : 'captured-public')
    expect(JSON.stringify(f.host.events)).not.toContain('configured-fixture-secret')
    expect(f.host.provider.credentialEnvironment.CUSTOM_PROVIDER_KEY).toBe('configured-fixture-secret')
    access.release()
  })

  test('undeclared canonical and configured credentials are absent from the real child', async () => {
    const f = fixture(), scope = f.scope()
    const access = f.remember(await f.mcp.request(f.config(), scope, value(scope.operation())))
    await access.callTool({ name: 'record', arguments: {} })
    const env = f.events().find(event => event.event === 'start').env
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CUSTOM_PROVIDER_KEY).toBeUndefined()
    access.release()
  })

  test('run owners, host epochs, modes and profiles never share a child', async () => {
    const f = fixture(), config = f.config(), one = f.scope('one'), two = f.scope('two')
    const a = f.remember(await f.mcp.request(config, one, value(one.operation())))
    const reused = f.remember(await f.mcp.request(config, one, value(one.operation())))
    expect(reused.id).toBe(a.id)
    const otherOwner = f.remember(await f.mcp.request(config, two, value(two.operation())))
    const otherMode = f.remember(await f.mcp.request(config, one, value(one.operation({ mode: 'user' }))))
    const otherProfile = f.remember(await f.mcp.request(config, one, value(one.operation({ profile: { ...f.host.bootstrap.profile, policy: 'full-access' } }))))
    const next = fixture(f.root, { PROJECT_VALUE: 'new-epoch' }), nextScope = next.scope('one')
    const otherEpoch = next.remember(await next.mcp.request(config, nextScope, value(nextScope.operation())))
    expect(new Set([a.id, otherOwner.id, otherMode.id, otherProfile.id, otherEpoch.id]).size).toBe(5)
    expect(f.launches).toHaveLength(4)
    expect(next.launches).toHaveLength(1)
    for (const access of [a, reused, otherOwner, otherMode, otherProfile, otherEpoch]) access.release()
  }, 15_000)

  test('one concurrent request can cancel while the shared child serves its other owner lease', async () => {
    const f = fixture(), scope = f.scope(), config = f.config(), waiting = new AbortController()
    const [first, second] = await Promise.all([
      f.mcp.request(config, scope, value(scope.operation({ signal: waiting.signal }))),
      f.mcp.request(config, scope, value(scope.operation())),
    ])
    f.remember(first); f.remember(second)
    expect(first.id).toBe(second.id)
    const pending = first.callTool({ name: 'wait', arguments: {} }).then(() => ({ ok: true }), error => ({ ok: false, error }))
    waiting.abort(new Error('only this MCP waiter cancelled'))
    expect((await pending).ok).toBe(false)
    first.release()
    expect((await second.listToolCatalog()).complete).toBe(true)
    await second.callTool({ name: 'record', arguments: {} })
    expect(f.launches).toHaveLength(1)
    expect(f.children[0].exitCode).toBeNull()
    f.stop.abort(new Error('run owner ended'))
    await new Promise(resolve => f.children[0].once('close', resolve))
    expect((await second.callTool({ name: 'record', arguments: {} }).then(() => true, () => false))).toBe(false)
    second.release()
  }, 10_000)

  test('catalog/call require the current lease and an exited child obtains a fresh admitted generation', async () => {
    const f = fixture(), scope = f.scope(), config = f.config()
    const first = f.remember(await f.mcp.request(config, scope, value(scope.operation())))
    const catalog = await first.listToolCatalog()
    expect(catalog.complete).toBe(true)
    expect(catalog.generation).toBe(first.generation!)
    expect(() => listMCPToolCatalog(first.id)).toThrow('current request lease')
    expect(() => callMCPTool(first.id, { name: 'record', arguments: {} })).toThrow('current request lease')
    const initialGeneration = first.generation!
    await first.callTool({ name: 'change', arguments: {} })
    expect(first.generation!).toBeGreaterThan(initialGeneration)
    expect((await first.listToolCatalog()).generation).toBe(first.generation!)
    await first.callTool({ name: 'exit', arguments: {} }).then(() => { throw new Error('Exit must fail its pending call') }, () => {})
    first.release()
    const second = f.remember(await f.mcp.request(config, scope, value(scope.operation())))
    expect(second.id).not.toBe(first.id)
    expect((await second.listToolCatalog()).complete).toBe(true)
    const starts = f.host.events.filter(event => event.phase === 'spawn-observed')
    expect(starts).toHaveLength(2)
    expect(starts[1].facts.resourceGeneration).not.toBe(starts[0].facts.resourceGeneration)
    expect(f.host.events.some(event => event.phase === 'resource-reused')).toBe(true)
    second.release()
  }, 10_000)

  test('actual ENOENT records dispatch failure without inventing a process start', async () => {
    const f = fixture(), scope = f.scope()
    const config = f.config()
    if (config.type !== 'stdio') throw new Error('Expected stdio')
    config.command = path.join(f.root, 'missing-executable')
    const result = await f.mcp.request(config, scope, value(scope.operation())).then(() => true, error => error)
    expect(result).toBeInstanceOf(Error)
    expect(f.launches).toHaveLength(1)
    expect(f.host.events.some(event => event.phase === 'dispatched')).toBe(true)
    expect(f.host.events.some(event => event.phase === 'dispatch-failed')).toBe(true)
    expect(f.host.events.some(event => event.phase === 'spawn-observed')).toBe(false)
    expect(f.events()).toEqual([])
  })
})
