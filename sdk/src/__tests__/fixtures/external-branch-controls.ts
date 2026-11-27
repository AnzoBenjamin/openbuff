import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { WebSocketServer } from 'ws'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { registerInjectedNodeScopeDriver } from '@codebuff/common/util/node-process-scope'
import { processScopeClock } from '@codebuff/common/util/owned-process-scope'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import { markMCPConfigOrigin } from '@codebuff/common/mcp/client'
import { createHostExecutionServices } from '../../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../../host-config'
import { createRunMcpExecution } from '../../services/run-mcp-execution'
import { createNodeFileSystem } from '../../tools/node-filesystem'
import { inspect3dAsset, render3dPreview, edit3dAsset } from '../../tools/3d-assets'
import { browserLogs } from '../../tools/browser-logs'
import { hashFileContent } from '../../tools/filesystem-authority'
import { buildDefaultSpawnSupervised } from '@codebuff/agent-runtime/supervision/supervised-spawn'
import { spawnSettledSubagent } from '@codebuff/agent-runtime/supervision/process-supervisor'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'
import type { LaunchFacts, PolicyInput, Result } from '@codebuff/common/types/contracts/execution-context'
import type { ScopeStreams } from '@codebuff/common/types/contracts/process-scope'

export type Control = 'happy' | 'denied' | 'unavailable' | 'pre-aborted' | 'deadline-zero' | 'delayed-authorizer-cancellation' | 'exhausted-before-later-branch'
export const BASE_CONTROLS: readonly Control[] = ['happy', 'denied', 'unavailable', 'pre-aborted', 'deadline-zero', 'delayed-authorizer-cancellation']
export const BLENDER_BRANCHES = ['blender.inspect-blend', 'blender.inspect-import', 'blender.preview', 'blender.edit', 'blender.validate'] as const
export const CHROME_BRANCHES = ['chrome.probe', 'chrome.pipe', 'chrome.port-fallback'] as const
export type BoundaryCall = { branch: string; launchId: string; executable: string; argv: readonly string[]; cwd: string | undefined; env: Record<string, string | undefined>; signal: AbortSignal | undefined; observerMethods?: string[] }
type ChromePeerEvent = { sequence: number; stage: string; branch?: string; method?: string; peer?: number }
export function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`); return result.value }

/** Real host authority; injected children report explicitly synthetic runtime observations. */
export function controlFixture(targetBranch: string, control: Control, laterBranch = false,
  cancellationScope: 'request' | 'root-resource-lifetime' = 'request') {
  const root = mkdtempSync(path.join(tmpdir(), 'b19-external-branch-'))
  writeFileSync(path.join(root, 'openbuff.json'), JSON.stringify({ providers: { fixture: {
    type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['fixture'], apiKeyEnv: 'CUSTOM_PROVIDER_KEY',
  } } }))
  writeFileSync(path.join(root, 'scene.blend'), 'fixture')
  writeFileSync(path.join(root, 'scene.fbx'), 'fixture')
  const environment = { PATH: '/usr/bin:/bin', HOME: '/captured/home', PROJECT_VALUE: 'branch-ordinary',
    OPENAI_API_KEY: 'canonical-branch-sentinel', CUSTOM_PROVIDER_KEY: 'configured-branch-sentinel' }
  const captured = loadHostConfigSnapshot({ inputs: { environment, platform: 'linux', invocationCwd: root, projectRoot: root,
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: 'openbuff.json', required: true },
    trust: { ancestorConfig: false, projectReadableRoots: false } }, fs: nodeConfigReadFs })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  let now = 100
  const clock = { domainId: `external-branch:${root}`, nowMs: () => now }
  const cancellation = new AbortController(), stop = new AbortController()
  const authorizations: LaunchFacts[] = [], policyInputs: PolicyInput[] = [], calls: BoundaryCall[] = [], consumerResults: unknown[] = []
  const chromePeerEvents: ChromePeerEvent[] = []
  let entered!: () => void, release!: () => void
  const authorizationEntered = new Promise<void>(resolve => { entered = resolve })
  const authorizationReleased = new Promise<void>(resolve => { release = resolve })
  const host = value(createHostExecutionServices({ snapshot: captured.snapshot, clock, signal: stop.signal,
    boundary: value(captureRootDeadline({ clock, limit: { kind: 'unbounded' } })), childInheritanceEnvironment: environment,
    authorizeAsync: async input => {
      authorizations.push(input.facts)
      policyInputs.push(input)
      if (input.facts.branchId === targetBranch) {
        if (control === 'denied' || control === 'unavailable') return { ok: false, reason: control, cause: `${control}:${targetBranch}` }
        if (control === 'delayed-authorizer-cancellation') { entered(); await authorizationReleased }
      }
      return { ok: true, basis: 'explicit-policy', decisionId: `branch-fixture:${input.facts.launchId}` }
    },
  }))
  const scope = value(host.registerRun({ clientSessionId: 'branch-session', rootRunId: 'branch-run', parentRunId: 'branch-run', parentAgentId: 'branch-agent' }))
  const context = value(scope.action({ actionId: `action:${targetBranch}`, attemptId: `attempt:${control}`,
    basisId: hashActionInput('external.branch.fixture', { targetBranch, control }), signal: cancellation.signal,
    limit: { kind: 'finite', durationMs: 1000 } }))
  const armBeforeTarget = () => {
    if (control === 'pre-aborted') cancellation.abort(new Error(`pre-aborted:${targetBranch}`))
    if (control === 'deadline-zero' || control === 'exhausted-before-later-branch') now = 1101
  }
  if (!laterBranch) armBeforeTarget()
  const afterEarlierBoundary = () => { if (laterBranch) armBeforeTarget() }
  const record: CodebuffSpawn = (executable, argv, options) => {
    recordSynthetic(executable, argv, options)
    return nodeSpawn(executable, [...argv ?? []], options ?? {})
  }
  const recordSynthetic = (executable: string, argv: readonly string[] | undefined, options: SpawnOptions | undefined) => {
    const facts = authorizations.at(-1)
    if (!facts) throw new Error('Actual boundary entered without genuine authorizer facts')
    calls.push({ branch: facts.branchId, launchId: facts.launchId, executable, argv: [...argv ?? []], cwd: options?.cwd?.toString(), env: { ...options?.env }, signal: options?.signal })
  }
  const drive = async <T>(operation: () => Promise<T>): Promise<T | Error> => {
    const pending = Promise.resolve().then(operation).catch(error => error instanceof Error ? error : new Error(String(error)))
    if (control === 'delayed-authorizer-cancellation') {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([authorizationEntered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Target authorizer was not reached: ${targetBranch}`)), 3000) })])
        const controller = cancellationScope === 'root-resource-lifetime' ? stop : cancellation
        controller.abort(new Error(`cancelled-during-authorization:${targetBranch}`))
      } finally { if (timer) clearTimeout(timer); release() }
    }
    const result = await pending
    consumerResults.push(result)
    return result
  }
  return { root, targetBranch, control, environment, snapshot: captured.snapshot, host, scope, context, cancellation, stop, cancellationScope, calls, authorizations, policyInputs, consumerResults, chromePeerEvents, record, recordSynthetic,
    afterEarlierBoundary, drive, expire: () => { now = 1101 },
    close: () => { stop.abort(new Error('branch fixture closed')); rmSync(root, { recursive: true, force: true }) } }
}
export type BranchFixture = ReturnType<typeof controlFixture>

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4e0AAAAASUVORK5CYII=', 'base64')
function nodeChild() {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { pid: 31919, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), stdio: [], exitCode: null, signalCode: null,
    kill: () => { Object.assign(child, { exitCode: 0 }); child.emit('exit', 0); child.emit('close', 0); return true } })
  return child
}

/** Only the injected actual Node boundary is replaced; public 3D consumers run. */
export async function runBlenderBranch(f: BranchFixture, branch: typeof BLENDER_BRANCHES[number]) {
  const spawn: CodebuffSpawn = (command, argv, options) => {
    f.recordSynthetic(command, argv, options)
    const actualBranch = f.calls.at(-1)!.branch, child = nodeChild()
    queueMicrotask(() => {
      child.emit('spawn')
      if (options?.env?.OPENBUFF_3D_OUTPUT_DIR) {
        for (const view of String(options.env.OPENBUFF_3D_VIEWS).split(','))
          writeFileSync(path.join(options.env.OPENBUFF_3D_OUTPUT_DIR, `${view}-${options.env.OPENBUFF_3D_MODE}.png`), PNG)
      }
      child.stdout?.emit('data', Buffer.from('OPENBUFF_3D_JSON:{"changed":[],"objects":[]}\n'))
      if (branch === 'blender.validate' && actualBranch === 'blender.edit') f.afterEarlierBoundary()
      child.emit('close', 0)
    })
    return child
  }
  const execution = { ...f.context, spawn }
  const fs = Object.assign(createNodeFileSystem(), { mutationAuthority: 'cooperative_cas' as const,
    conditionalCommit: async () => ({ applied: false as const, actualHash: null }) })
  return f.drive(() => branch === 'blender.inspect-blend' || branch === 'blender.inspect-import'
    ? inspect3dAsset({ path: branch.endsWith('import') ? 'scene.fbx' : 'scene.blend', cwd: f.root, fs, execution })
    : branch === 'blender.preview'
      ? render3dPreview({ path: 'scene.blend', cwd: f.root, fs, execution, views: ['front'], mode: 'clay', width: 128, height: 128 })
      : edit3dAsset({ path: 'scene.blend', cwd: f.root, fs, execution, sourceHash: hashFileContent(Buffer.from('fixture')),
          operations: [{ type: 'rename_object', object: 'Cube', new_name: 'Hero' }], operationId: 'branch-controls' }))
}

function cdpReply(message: { id?: number; method?: string }, probeSupported = true) {
  const result = message.method === 'Target.getTargets' ? { targetInfos: probeSupported ? [{ targetId: 'page', type: 'page', url: 'about:blank' }] : [] }
    : message.method === 'Target.attachToTarget' ? { sessionId: 'attached' }
      : message.method === 'Runtime.evaluate' ? { result: { value: { title: 'branch-fixture', text: 'branch-fixture', elements: [] } } } : {}
  return { id: message.id, result }
}

/** Port happy cases use a local websocket peer, never an actual Chrome process. */
export async function runChromeBranch(f: BranchFixture, branch: typeof CHROME_BRANCHES[number]) {
  let server: WebSocketServer | undefined
  let endpoint = ''
  const peerClosures: Promise<void>[] = []
  const trace = (stage: string, detail: Omit<ChromePeerEvent, 'sequence' | 'stage'> = {}) => {
    if (branch !== 'chrome.port-fallback' || f.control !== 'happy' || f.chromePeerEvents.length >= 128) return
    const event = { sequence: f.chromePeerEvents.length, stage, ...detail }
    f.chromePeerEvents.push(event)
    // The runner can time out before writeEvidence's finally is reached.
    console.log('B19_EXTERNAL_CHROME_PEER ' + JSON.stringify({ caseId: `sdk.chrome--${branch}--${f.control}`, ...event }))
  }
  if (branch === 'chrome.port-fallback' && f.control === 'happy') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    trace('server-listening-wait')
    await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) })
    trace('server-listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No websocket fixture port')
    endpoint = `ws://127.0.0.1:${address.port}/devtools/browser/fixture`
    server.on('connection', socket => {
      const peer = peerClosures.length
      trace('peer-connected', { peer })
      // Subscribe at connection time so cleanup also observes peers that
      // finish closing during the authenticated browser stop action.
      peerClosures.push(new Promise<void>(resolve => socket.once('close', () => {
        trace('peer-closed', { peer }); resolve()
      })))
      socket.on('message', data => {
        const message = JSON.parse(data.toString())
        trace('cdp-request', { branch: 'chrome.port-fallback', method: message.method, peer })
        socket.send(JSON.stringify(cdpReply(message)))
      })
    })
  }
  const spawn: CodebuffSpawn = (command, argv, options) => {
    f.recordSynthetic(command, argv, options)
    const actualBranch = f.calls.at(-1)!.branch, child = nodeChild()
    trace('child-created', { branch: actualBranch })
    if (actualBranch !== 'chrome.port-fallback') {
      const readable = new PassThrough()
      let buffered = ''
      const writable = new Writable({ write(chunk, _encoding, done) {
        buffered += chunk.toString()
        let delimiter: number
        while ((delimiter = buffered.indexOf('\0')) >= 0) {
          const data = buffered.slice(0, delimiter); buffered = buffered.slice(delimiter + 1)
          if (!data) continue
          const message = JSON.parse(data)
          trace('cdp-request', { branch: actualBranch, method: message.method })
          const result = cdpReply(message, !(branch === 'chrome.port-fallback' && actualBranch === 'chrome.probe'))
          queueMicrotask(() => readable.write(JSON.stringify(result) + '\0'))
        }
        done()
      } })
      Object.assign(child, { stdio: [null, null, null, writable, readable] })
    }
    const kill = child.kill.bind(child)
    child.kill = (...args) => { if (actualBranch === 'chrome.probe') f.afterEarlierBoundary(); return kill(...args) }
    queueMicrotask(() => {
      trace('child-spawn', { branch: actualBranch })
      child.emit('spawn')
      // Buffer the endpoint until the real port consumer attaches its reader.
      // A bare data event can be lost between observed spawn and that await.
      if (actualBranch === 'chrome.port-fallback')
        setImmediate(() => {
          const stderr = child.stderr as PassThrough
          trace('endpoint-write', { branch: actualBranch })
          stderr.write(`DevTools listening on ${endpoint}\n`)
        })
    })
    return child
  }
  const execution = { ...f.context, resources: f.scope.resources, executablePath: path.join(f.root, 'chrome-fixture'), sandboxArgs: [], spawn }
  const sessionKey = `branch:${f.root}`
  try {
    trace('snapshot-wait')
    const result = await f.drive(() => browserLogs({ type: 'snapshot' }, sessionKey, execution))
    trace('snapshot-settled')
    return result
  }
  finally {
    // Cleanup uses a new authenticated request under the same actor lifetime.
    const cleanup = f.scope.operation()
    if (cleanup.ok) {
      trace('browser-stop-wait')
      await browserLogs({ type: 'stop' }, sessionKey, { ...execution, ...cleanup.value })
      trace('browser-stop-settled')
    } else trace('browser-stop-unavailable')
    if (server) {
      // Match the SDK fixture: let the initiated WebSocket close drain for
      // two event-loop turns before terminating any remaining peers.
      trace('peer-drain-1-wait')
      await new Promise<void>(resolve => setImmediate(resolve))
      trace('peer-drain-1-settled')
      trace('peer-drain-2-wait')
      await new Promise<void>(resolve => setImmediate(resolve))
      trace('peer-drain-2-settled')
      trace('peers-close-wait')
      for (const client of server.clients) client.terminate()
      // Browser stop initiates WebSocket close; wait for actual owned peer
      // close events before asking the server to finish its own shutdown.
      await Promise.all(peerClosures)
      trace('peers-closed')
      trace('server-close-wait')
      await new Promise<void>(resolve => server!.close(() => resolve()))
      trace('server-closed')
    }
  }
}

const OK_RECEIPT: AgentReceipt = {
  schemaVersion: 1, receiptId: 'branch-receipt', taskId: 'branch-task', role: 'specialist', agentId: 'branch-child',
  status: 'completed', outcome: 'ok', changedFiles: [], requirementsAddressed: [], acceptanceCriteriaAddressed: [],
  findingsAddressed: [], evidence: [], assumptions: [], unresolved: [], requestedValidation: [], artifacts: [], errors: [],
}

/** Real default source-mode producer and settle consumer; synthetic Bun boundary only. */
export async function runSupervisedBranch(f: BranchFixture, retry: boolean) {
  let attempts = 0
  const seam = buildDefaultSpawnSupervised({ openbuffApiKey: 'overlay-credential', passthroughEnv: { LANG: 'C.UTF-8' } }, undefined, {
    executionForRequest: () => f.context,
    restart: retry ? { maxAttempts: 1, backoffMs: 0 } : undefined,
    _scheduleRestart: async () => { f.afterEarlierBoundary() },
    _spawnSettledSubagent: params => spawnSettledSubagent({ ...params, spawn: request => {
      const branch = params.branchId ?? ''
      const facts = f.authorizations.at(-1)
      if (!facts || facts.branchId !== branch) throw new Error('Supervised boundary lacks matching authorization')
      f.calls.push({ branch, launchId: facts.launchId, executable: request.cmd[0], argv: request.cmd.slice(1), cwd: request.cwd, env: { ...request.env },
        signal: undefined, observerMethods: Object.keys(request.observer ?? {}).sort() })
      if (retry && attempts++ === 0) throw new Error('fixture first-boundary spawn failure')
      const observed = request.observer?.spawnObserved({ source: 'bun-spawn-result', pid: 41919 })
      if (observed && !observed.ok) throw new Error(observed.cause)
      return { stdout: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(JSON.stringify(OK_RECEIPT) + '\n')); controller.close() } }),
        stderr: new ReadableStream({ start(controller) { controller.close() } }), exited: Promise.resolve(0), kill() {} }
    } }),
  })
  return f.drive(() => seam({ agentType: 'fixture', prompt: 'fixture', spawnParams: undefined }, { signal: f.context.execution.signal }))
}

function syntheticMcpChild() {
  const child = nodeChild()
  const stdin = new Writable({ write(chunk, _encoding, done) {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      const message = JSON.parse(line)
      if (message.id === undefined) continue
      const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'branch-mcp', version: '1' } }
        : message.method === 'tools/list' ? { tools: [{ name: 'record', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'branch-mcp-reply' }] }
      queueMicrotask(() => child.stdout?.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')))
    }
    done()
  } })
  Object.assign(child, { stdin })
  let reaped = false, closed = false
  let resolveExit!: (value: 'exited-reaped') => void
  let resolveStreams!: (value: ScopeStreams) => void
  const leaderExited = new Promise<'exited-reaped'>(resolve => { resolveExit = resolve })
  const streamsFinished = new Promise<ScopeStreams>(resolve => { resolveStreams = resolve })
  const streams = (): ScopeStreams => ({
    stdin: closed || child.stdin?.writableEnded ? 'closed' : 'open',
    stdout: child.stdout?.readableEnded ? 'drained' : closed ? 'closed-incomplete' : 'open',
    stderr: child.stderr?.readableEnded ? 'drained' : closed ? 'closed-incomplete' : 'open',
  })
  child.once('exit', () => { reaped = true; resolveExit('exited-reaped') })
  child.once('close', () => {
    reaped = true; closed = true; resolveExit('exited-reaped')
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy()
    resolveStreams(streams())
  })
  // Synthetic protocol lifecycle only. Closed pipes without EOF stay incomplete;
  // the trusted registration fixes the tier to injected and grants no OS proof.
  registerInjectedNodeScopeDriver(child, {
    leaderExited, streamsFinished,
    async observe() { return {
      sampledAtMs: processScopeClock.nowMs(), clockDomainId: processScopeClock.domainId,
      leader: reaped ? 'exited-reaped' : 'running', scopePresence: closed ? 'absent' : 'living',
      members: [], membershipComplete: true, identity: 'verified', streams: streams(),
    } },
    async signal(signal) {
      const atMs = processScopeClock.nowMs()
      if (closed) return { signal, atMs, targetTier: 'injected', result: 'already-absent' }
      return { signal, atMs, targetTier: 'injected', result: child.kill(signal) ? 'delivered' : 'unknown' }
    },
    closeInput() { child.stdin?.end() },
    abandonStreams() { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy() },
  })
  queueMicrotask(() => child.emit('spawn'))
  return child
}

function mcpConnection(f: BranchFixture, realPeer: boolean) {
  const nodeExecutable = Bun.which('node')
  if (!nodeExecutable) throw new Error('The real external branch MCP fixture requires Node on PATH')
  const exits: Promise<unknown>[] = []
  const spawn: CodebuffSpawn = realPeer ? (command, argv, options) => {
    const child = f.record(command, argv, options)
    exits.push(new Promise(resolve => child.once('close', resolve)))
    return child
  } : (command, argv, options) => { f.recordSynthetic(command, argv, options); return syntheticMcpChild() }
  const mcp = createRunMcpExecution({ snapshot: f.snapshot, authority: f.host.execution, rootLifetime: f.host.rootLifetime, spawn })
  const config = { type: 'stdio' as const, command: nodeExecutable, args: [path.join(import.meta.dir, 'external-branch-mcp-server.cjs')],
    env: { EXTERNAL_RECORD_FILE: path.join(f.root, 'peer.json'), PROJECT_VALUE: '$PROJECT_VALUE' } }
  markMCPConfigOrigin(config, 'project')
  const captured = mcp.capture(config)
  return { mcp, config, captured, close: async () => { await mcp.dispose(); await Promise.allSettled(exits) } }
}

/** Both MCP intents traverse the actual run-owned destination/resource service. */
export async function runMcpBranch(f: BranchFixture, intent: 'discovery' | 'call', realPeer = false) {
  const connection = mcpConnection(f, realPeer)
  const { mcp, config, captured } = connection
  if (realPeer) {
    // Mutate caller-owned inputs after capture. Production must use stored bytes.
    config.args.push('caller-mutated-after-capture')
    config.env.PROJECT_VALUE = 'config-mutated-after-capture'
    f.environment.PROJECT_VALUE = 'source-mutated-after-capture'
  }
  try {
    const result = await f.drive(async () => {
      const access = await mcp.request(config, f.scope, f.context)
      if (f.targetBranch === 'mcp.reuse') f.afterEarlierBoundary()
      try { return intent === 'discovery' ? await access.listToolCatalog() : await access.callTool({ name: 'record', arguments: {} }) }
      finally { access.release() }
    })
    const peer = realPeer && f.calls.length ? JSON.parse(readFileSync(path.join(f.root, 'peer.json'), 'utf8')) : undefined
    return { result, peer, capturedDestination: captured.resolved, sameCaptureAfterMutation: mcp.capture(config) === captured }
  } finally { await connection.close() }
}

/** A cancelled request cannot become the lifetime owner of a second lease. */
export async function runMcpRequestIsolation(f: BranchFixture, intent: 'discovery' | 'call') {
  const connection = mcpConnection(f, false)
  const { mcp, config } = connection
  const other = value(f.scope.operation())
  try {
    const first = await mcp.request(config, f.scope, f.context)
    const second = await mcp.request(config, f.scope, other)
    try {
      f.cancellation.abort(new Error('Only request A is cancelled'))
      const cancelledResult = await first.callTool({ name: 'record', arguments: {} }).then(() => 'unexpected-success', error => String(error))
      const result = intent === 'discovery' ? await second.listToolCatalog() : await second.callTool({ name: 'record', arguments: {} })
      return { firstId: first.id, secondId: second.id, cancelledResult, result,
        requesterAborted: f.context.signal?.aborted,
        actualResourceSignalAborted: f.calls[0]?.signal?.aborted,
        distinctRequestAndResourceSignals: f.calls[0]?.signal !== f.context.signal }
    } finally { first.release(); second.release() }
  } finally { await connection.close() }
}

/** Waiter A cancels during genuine startup authorization; waiter B remains. */
export async function runMcpStartupWaiterIsolation(f: BranchFixture, intent: 'discovery' | 'call') {
  const connection = mcpConnection(f, false)
  const { mcp, config } = connection
  const other = value(f.scope.operation())
  try {
    const firstRequest = mcp.request(config, f.scope, f.context)
    const secondPending = mcp.request(config, f.scope, other)
    const firstPending = f.drive(() => firstRequest)
    const [first, second] = await Promise.all([firstPending, secondPending])
    try {
      const result = intent === 'discovery' ? await second.listToolCatalog() : await second.callTool({ name: 'record', arguments: {} })
      return { firstRefused: first instanceof Error, result,
        requesterAborted: f.context.signal?.aborted, resourceAborted: f.calls[0]?.signal?.aborted }
    } finally {
      if (!(first instanceof Error)) first.release()
      second.release()
    }
  } finally { await connection.close() }
}
