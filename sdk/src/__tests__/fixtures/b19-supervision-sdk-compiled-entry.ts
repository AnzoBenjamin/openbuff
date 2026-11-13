/** Standalone fixture: compile unchanged production sources, never bun:test. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import { agentReceiptSchema } from '@codebuff/common/types/agent-handoff'
import { SUPERVISED_SELF_EXEC_FLAG } from '@codebuff/agent-runtime/supervision/self-exec-flag'
import { isSupervisedSpawnSelfExecMode, resolveSupervisedChildEntryPath } from '@codebuff/agent-runtime/supervision/supervised-spawn'
import { connectChildBridge } from '@codebuff/agent-runtime/supervision/child-bridge-client'
import { getAgentRuntimeImpl } from '../../impl/agent-runtime'
import { createHostExecutionServices } from '../../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../../host-config'
import { executionLimitMs } from '../../services/execution-launch'
import { createNodeFileSystem } from '../../tools/node-filesystem'
import type { AgentDefinition, ToolCall } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'
import type { LaunchEvent, PolicyInput, Result } from '@codebuff/common/types/contracts/execution-context'
import type { SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'
import type { SpawnSupervisedFn } from '@codebuff/agent-runtime/supervision/supervised-spawn'
import type { HostConfigurationInputs } from '../../host-config'

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
function value<T>(result: Result<T>): T { if (!result.ok) throw Object.assign(new Error(result.cause), { refusal: result }); return result.value }

if (process.argv[2] === SUPERVISED_SELF_EXEC_FLAG) {
  const recordFile = process.env.B19_SDK_COMPILED_PEER
  assert(recordFile, 'Self-exec child must receive its captured record destination')
  const request = JSON.parse(readFileSync(process.argv[3]!, 'utf8')) as SupervisedSpawnRequest
  assert(request.rpcSocketPath && request.rpcBridgeNonce, 'Actual SDK factory must supply its live parent bridge')
  const bridge = await connectChildBridge(request.rpcSocketPath)
  let bridgeReply: unknown
  try { bridgeReply = await bridge.call('requestOptionalFile', { filePath: 'bridge-probe.txt' }) }
  finally { bridge.close() }
  const observation = { pid: process.pid, argv: process.argv, env: process.env, request, bridgeReply, receipt: undefined as unknown }
  writeFileSync(recordFile, JSON.stringify(observation))
  const { runChildEntryMain } = await import('@codebuff/agent-runtime/supervision/child-entry')
  const exitCode = await runChildEntryMain([process.argv[0]!, process.argv[1]!, ...process.argv.slice(3)], async line => {
    observation.receipt = agentReceiptSchema.parse(JSON.parse(line))
    writeFileSync(recordFile, JSON.stringify(observation))
    await Bun.write(Bun.stdout, line)
  })
  process.exit(exitCode)
}

const args = process.argv.slice(2)
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const branch = option('--branch') ?? 'initial', control = option('--control') ?? 'happy', mode = option('--mode') ?? 'factory'
assert(['initial', 'retry'].includes(branch))
assert(['factory', 'sdk-run'].includes(mode))
assert(mode !== 'sdk-run' || control === 'happy', 'Whole SDK compiled controls select happy initial/retry')
assert(['happy', 'denied', 'unavailable', 'pre-aborted', 'literal-zero', 'delayed-cancel', 'exhausted-before-admission',
  'exhausted-before-retry', 'retry-budget-exhausted'].includes(control))
assert(branch === 'retry' || !['exhausted-before-retry', 'retry-budget-exhausted'].includes(control))
assert(isSupervisedSpawnSelfExecMode(), 'A genuine Bun-compiled binary is required')
const repo = path.resolve(option('--repo') ?? process.cwd())
const evidenceBase = path.join(repo, 'docs/execution/body-roadmap/evidence/B19/implementation/branch-controls-r3/sdk-supervision/compiled')
mkdirSync(evidenceBase, { recursive: true })
const evidenceDirectory = path.resolve(process.env.B19_SDK_SUPERVISION_COMPILED_EVIDENCE_DIR ?? evidenceBase)
assert(evidenceDirectory === evidenceBase || evidenceDirectory.startsWith(evidenceBase + path.sep), 'Compiled capture escaped its owned directory')
let evidenceAncestor = evidenceDirectory
while (!existsSync(evidenceAncestor)) evidenceAncestor = path.dirname(evidenceAncestor)
const canonicalBase = realpathSync(evidenceBase), canonicalAncestor = realpathSync(evidenceAncestor)
assert(canonicalAncestor === canonicalBase || canonicalAncestor.startsWith(canonicalBase + path.sep), 'Compiled capture escaped through a symlink')
mkdirSync(evidenceDirectory, { recursive: true })
const id = randomUUID(), root = mkdtempSync(path.join(tmpdir(), 'b19-sdk-compiled-supervision-'))
const peerFile = path.join(root, 'peer.json'), configFile = path.join(root, 'openbuff.json')
writeFileSync(path.join(root, 'bridge-probe.txt'), 'captured SDK parent bridge\n')
writeFileSync(configFile, JSON.stringify({ autoFileChangeHooks: false, defaultModel: 'fixture/fixture-model', providers: {
  fixture: { type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['fixture-model'], apiKeyEnv: 'CUSTOM_PROVIDER_KEY' },
} }))
const environment = { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), NODE_ENV: 'test', LANG: 'C.UTF-8',
  PROJECT_VALUE: 'supervision-compiled-captured-public', OPENAI_API_KEY: 'compiled-canonical-sentinel', CUSTOM_PROVIDER_KEY: 'compiled-configured-sentinel',
  OPENBUFF_API_KEY: 'compiled-openbuff-sentinel', OPENBUFF_PROCESS_SUPERVISION: '1', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1',
  B19_SDK_COMPILED_PEER: peerFile, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const inputs: HostConfigurationInputs = { environment, platform: 'linux' as const, invocationCwd: root, projectRoot: root, home: { kind: 'none' as const },
  globals: { kind: 'disabled' as const }, selection: { kind: 'explicit' as const, path: configFile, required: true },
  trust: { ancestorConfig: false, projectReadableRoots: false } }
const captured = loadHostConfigSnapshot({ inputs, fs: nodeConfigReadFs })
assert(captured.status === 'complete', 'Captured compiled configuration must load')
const targetBranch = `supervised.self-exec.${branch}`
const stop = new AbortController()
const events: LaunchEvent[] = [], policies: PolicyInput[] = [], resolverCalls: unknown[] = [], registrations: unknown[] = []
const preparedAttempts: Array<{ branch: string; requestPath: string; request: SupervisedSpawnRequest; cwd: string;
  mode: number; requestMode: number }> = []
const clockTransitions: unknown[] = [], childExits: Promise<unknown>[] = []
const boundaries: Array<{ cmd: string[]; env: Record<string, string>; cwd?: string; branch: string; launchId: string;
  request: SupervisedSpawnRequest; pid?: number; failure?: string }> = []
let now = 100, networkCalls = 0, factoryConstructed = false, assertionsCompleted = false, result: unknown, failure: unknown, peer: unknown
let entered!: () => void, release!: () => void
const delayedEntered = new Promise<void>(resolve => { entered = resolve })
const delayedRelease = new Promise<void>(resolve => { release = resolve })
const clock = { domainId: `compiled-sdk:${id}`, nowMs: () => now }
const spawnDescriptor = Object.getOwnPropertyDescriptor(Bun, 'spawn')!, actualSpawn = Bun.spawn
Object.defineProperty(Bun, 'spawn', { ...spawnDescriptor, value: (...spawnArgs: unknown[]) => {
  if (!Array.isArray(spawnArgs[0]) || spawnArgs[0][1] !== SUPERVISED_SELF_EXEC_FLAG) return Reflect.apply(actualSpawn, Bun, spawnArgs)
  const cmd = spawnArgs[0] as string[], options = spawnArgs[1] as { env: Record<string, string>; cwd?: string }
  const admitted = [...events].reverse().find(event => 'facts' in event && event.facts.family === 'supervised-child' && event.phase === 'admitted')
  assert(admitted && 'facts' in admitted, 'Real Bun boundary requires an authorized supervision launch')
  const boundary: typeof boundaries[number] = { cmd: [...cmd], env: { ...options.env }, cwd: options.cwd,
    branch: admitted.facts.branchId, launchId: admitted.facts.launchId, request: JSON.parse(readFileSync(cmd[2]!, 'utf8')) }
  boundaries.push(boundary)
  if ((branch === 'retry' && boundaries.length === 1) || control === 'retry-budget-exhausted') {
    if (control === 'pre-aborted') stop.abort(new Error('Abort after initial failed boundary, before retry'))
    boundary.failure = 'Injected first-boundary transport throw before an OS spawn'
    throw new Error(boundary.failure)
  }
  const child = Reflect.apply(actualSpawn, Bun, spawnArgs)
  boundary.pid = child.pid
  childExits.push(child.exited)
  return child
} })
const actualFetch = globalThis.fetch
const forbid = () => { networkCalls++; throw new Error('Provider/network task forbidden in compiled supervision fixture') }
globalThis.fetch = Object.assign(async () => forbid(), { preconnect: forbid }) as typeof fetch
let zeroSelection: ReturnType<typeof executionLimitMs> | undefined
try {
  if (mode === 'sdk-run') {
    const { OpenbuffClient } = await import('../../client')
    const child: AgentDefinition = { id: 'b19-compiled-child', displayName: 'Compiled child', model: 'fixture/fixture-model',
      outputMode: 'structured_output', toolNames: ['set_output'], handleSteps: function* () {
        yield { toolName: 'set_output', input: { child: 'compiled-local-result' } }
      } }
    const parent: AgentDefinition = { id: 'b19-compiled-parent', displayName: 'Compiled parent', model: 'fixture/fixture-model',
      outputMode: 'structured_output', toolNames: ['spawn_agent_inline', 'set_output'], spawnableAgents: ['b19-compiled-child'],
      handleSteps: function* () {
        // Canonical runtime input remains checked even though the public agent
        // ToolCall union omits this internal tool. Type annotations erase.
        const call: Pick<CodebuffToolCall<'spawn_agent_inline'>, 'toolName' | 'input'> = {
          toolName: 'spawn_agent_inline', input: { agent_type: 'b19-compiled-child', prompt: 'local only' },
        }
        const { toolResult } = yield call as unknown as ToolCall
        yield { toolName: 'set_output', input: { child: toolResult } }
      } }
    const client = new OpenbuffClient({ cwd: root, projectFiles: {}, knowledgeFiles: {}, agentDefinitions: [child],
      hostConfiguration: inputs, configReadFs: nodeConfigReadFs, harnessStateDir: path.join(root, 'harness'),
      fsSource: createNodeFileSystem(), approvalMode: 'allow-all', recordExecution: event => events.push(event) })
    result = await client.run({ agent: parent, prompt: 'local only', signal: stop.signal, runTimeoutMs: 15_000 })
    factoryConstructed = boundaries.length > 0
  } else {
    // This composition deliberately selects the normative SDK factory without
    // claiming run.ts registration. Every handle is minted by the real host;
    // the fixture-owned origin resolver validates the exact registered action.
    const host = value(createHostExecutionServices({ snapshot: captured.snapshot, clock, signal: stop.signal,
      boundary: value(captureRootDeadline({ clock, limit: { kind: 'finite', durationMs: 60_000 } })),
      childInheritanceEnvironment: environment, record: event => events.push(event), authorizeAsync: async input => {
        policies.push(input)
        const requestPath = input.target.argv.at(-1)!
        preparedAttempts.push({ branch: input.facts.branchId, requestPath,
          request: JSON.parse(readFileSync(requestPath, 'utf8')), cwd: input.target.cwd,
          mode: statSync(input.target.cwd).mode & 0o777, requestMode: statSync(requestPath).mode & 0o777 })
        if (input.facts.branchId === targetBranch) {
          if (control === 'denied' || control === 'unavailable') return { ok: false, reason: control, cause: `compiled-${control}` }
          if (control === 'delayed-cancel') { entered(); await delayedRelease }
          if (control === 'exhausted-before-admission' || control === 'exhausted-before-retry') {
            await Promise.resolve(); clockTransitions.push({ before: now, after: 60_101, previousBoundaries: boundaries.length }); now = 60_101
          }
        }
        return { ok: true, basis: 'explicit-policy', decisionId: `compiled:${input.facts.launchId}` }
      } }))
    const actor = { runId: `root-${id}`, rootRunId: `root-${id}`, agentId: 'compiled-parent' }
    const scope = value(host.registerRun({ clientSessionId: id, rootRunId: actor.rootRunId, parentRunId: actor.runId, parentAgentId: actor.agentId }))
    const actionInput = { agent_type: 'b19-intentionally-absent-template', prompt: 'compiled factory launch only' }
    const basis = { inputHash: hashActionInput('spawn_agent_inline', actionInput) }
    const identity: ToolExecutionIdentity = { ...actor, actionId: `spawn-${id}`, attemptId: `attempt-${id}`, basis,
      basisId: hashActionInput('openbuff.execution-b02-basis.v1', { basis, workspaceSnapshotId: null }) }
    const context = value(scope.action({ actionId: identity.actionId, attemptId: identity.attemptId, basisId: identity.basisId }))
    const registration = value(host.execution.actionRegistration(context.execution))
    assert(registration.correlation.kind === 'action')
    assert.equal(registration.correlation.actionId, identity.actionId)
    const request: SupervisedSpawnRequest = { agentType: actionInput.agent_type, prompt: actionInput.prompt, spawnParams: undefined,
      child: { agentId: `child-${id}` }, executionIdentity: identity, ancestorRunIds: [actor.runId], localAgentTemplates: {} }
    const runtime = getAgentRuntimeImpl({ apiKey: 'fixture-parent-key', hostServices: host,
      supervisedExecutionForRequest: candidate => {
        assert.deepEqual(candidate.executionIdentity, identity); assert.deepEqual(candidate.ancestorRunIds, [actor.runId])
        assert.equal(candidate.executionHostOperation, undefined)
        const authenticated = value(host.execution.actionRegistration(context.execution))
        assert.deepEqual(authenticated.correlation, registration.correlation)
        resolverCalls.push({ identity: candidate.executionIdentity, ancestors: candidate.ancestorRunIds,
          correlation: authenticated.correlation, snapshotId: host.provider.snapshot.snapshotId })
        return context
      },
      registerExecutionActor: registration => {
        const child = registration.actor
        value(host.registerRun({ clientSessionId: id, rootRunId: child.rootRunId, parentRunId: child.runId,
          parentAgentId: child.agentId }, registration.executionContext))
        registrations.push({ actor: child, parentActor: registration.parentActor })
      },
      onExecutionActionStart: () => { throw new Error('Factory-only fixture intentionally supplies no child tool-action authority') },
      handleStepsLogChunk: () => {}, sendAction: () => {}, sendSubagentChunk: () => {},
      requestToolCall: async () => { throw new Error('Factory-only child may not dispatch tools') }, requestMcpToolData: async () => [],
      requestFiles: async () => { throw new Error('Factory-only child may not request general files') },
      requestOptionalFile: async ({ filePath }) => { assert.equal(filePath, 'bridge-probe.txt'); return readFileSync(path.join(root, filePath), 'utf8') },
      fileSystem: createNodeFileSystem(),
    })
    factoryConstructed = runtime.processSupervision === true && typeof runtime.spawnSupervised === 'function'
    assert(factoryConstructed, 'Actual getAgentRuntimeImpl must construct supervision from its captured environment')
    zeroSelection = control === 'literal-zero' ? executionLimitMs(0) : undefined
    if (zeroSelection) {
      assert(!zeroSelection.ok && zeroSelection.reason === 'deadline-exhausted')
      result = zeroSelection
    } else {
      if (branch === 'initial' && control === 'pre-aborted') stop.abort(new Error('Abort before first constructed SDK seam call'))
      // AgentRuntimeDeps exposes the one-argument minimum; the actual SDK
      // factory constructed above implements the documented per-call options.
      const pending = Promise.resolve().then(() => (runtime.spawnSupervised as SpawnSupervisedFn)(request, { signal: stop.signal }))
        .then(value => { result = value }, error => { result = error })
      if (control === 'delayed-cancel') {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([delayedEntered, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Compiled target authorizer was not reached')), 5000)
          })])
          stop.abort(new Error('Cancelled during compiled target authorization'))
        } finally { if (timer) clearTimeout(timer); release() }
      }
      await pending
    }
  }
  await Promise.allSettled(childExits)
  peer = existsSync(peerFile) ? JSON.parse(readFileSync(peerFile, 'utf8')) : undefined
  const target = boundaries.filter(boundary => boundary.branch === targetBranch)
  const expected = control === 'literal-zero' ? 0 : control === 'retry-budget-exhausted' ? 4 : (branch === 'retry' ? 1 : 0) + (control === 'happy' ? 1 : 0)
  assert.equal(boundaries.length, expected)
  assert.equal(target.length, control === 'retry-budget-exhausted' ? 3 : control === 'happy' ? 1 : 0)
  assert.equal(networkCalls, 0)
  assert(factoryConstructed)
  for (const boundary of boundaries) {
    assert.equal(boundary.cmd[0], process.execPath); assert.equal(boundary.cmd[1], SUPERVISED_SELF_EXEC_FLAG)
    assert.equal(boundary.env.PROJECT_VALUE, 'supervision-compiled-captured-public')
    for (const key of ['OPENAI_API_KEY', 'CUSTOM_PROVIDER_KEY', 'OPENBUFF_API_KEY']) assert.equal(boundary.env[key], undefined)
    assert(boundary.request.rpcSocketPath && boundary.request.rpcBridgeNonce)
    assert.deepEqual(boundary.request.executionIdentity, boundaries[0]!.request.executionIdentity)
  }
  assert.equal(new Set(boundaries.map(boundary => boundary.launchId)).size, boundaries.length)
  assert.equal(new Set(boundaries.map(boundary => boundary.cwd)).size, boundaries.length)
  for (const attempt of preparedAttempts) {
    assert.equal(attempt.mode, 0o700); assert.equal(attempt.requestMode, 0o600)
    assert(attempt.request.rpcSocketPath && attempt.request.rpcBridgeNonce)
    assert.deepEqual(attempt.request.executionIdentity, preparedAttempts[0]!.request.executionIdentity)
  }
  assert.equal(new Set(preparedAttempts.map(attempt => attempt.cwd)).size, preparedAttempts.length)
  for (const policy of policies) {
    assert.deepEqual(policy.facts.correlation, policies[0]!.facts.correlation)
    assert.deepEqual(policy.facts.deadlines.action, policies[0]!.facts.deadlines.action)
    for (const deadline of Object.values(policy.facts.deadlines)) {
      assert.equal(deadline.kind, 'finite')
      if (deadline.kind === 'finite') assert.equal(deadline.expiresAtMs, 60_100)
    }
  }
  for (const event of events) if (event.phase === 'no-launch') assert.equal(event.facts.profile.active, null)
  const observations = events.filter(event => event.phase === 'spawn-observed' && 'facts' in event && event.facts.family === 'supervised-child')
  assert.equal(observations.length, control === 'happy' ? 1 : 0)
  if (control === 'happy') {
    assert(peer && typeof peer === 'object')
    const child = peer as { pid: number; env: unknown; bridgeReply: unknown; receipt: unknown }
    assert.equal(child.pid, target[0]!.pid); assert.deepEqual(child.env, target[0]!.env)
    assert(String(child.bridgeReply).includes('captured SDK parent bridge'))
    const receipt = agentReceiptSchema.parse(child.receipt)
    if (mode === 'factory') {
      assert.equal(receipt.status, 'failed')
      assert.equal((result as { outcome: string }).outcome, 'ok')
      assert.equal((result as { receipt: { receiptId: string } }).receipt.receiptId, receipt.receiptId)
    }
  }
  if (control.startsWith('exhausted')) {
    assert.equal(clockTransitions.length, 1)
    assert.equal((result as { executionRefusal?: { reason: string } }).executionRefusal?.reason, 'deadline-exhausted')
  }
  if (control === 'denied' || control === 'unavailable')
    assert.equal((result as { executionRefusal?: { reason: string } }).executionRefusal?.reason, control)
  if (control === 'delayed-cancel')
    assert.equal((result as { executionRefusal?: { reason: string } }).executionRefusal?.reason, 'cancelled')
  if (control === 'pre-aborted' && branch === 'initial') {
    assert.equal((result as { refusal?: { reason: string } }).refusal?.reason, 'cancelled')
    assert.equal(resolverCalls.length, 0)
    assert.equal(registrations.length, 0)
    assert.equal(policies.length, 0)
    assert.equal(events.length, 0)
    assert.equal(preparedAttempts.length, 0)
  }
  if (control === 'retry-budget-exhausted' || (control === 'pre-aborted' && branch === 'retry'))
    assert.equal((result as { crashReason?: string }).crashReason, 'spawn_failed')
  if (mode === 'factory' && control !== 'literal-zero' && !(control === 'pre-aborted' && branch === 'initial'))
    assert(resolverCalls.length > 0)
  assertionsCompleted = true
} catch (error) { failure = error }
finally {
  release(); stop.abort(new Error('Compiled fixture complete'))
  await Promise.allSettled(childExits)
  Object.defineProperty(Bun, 'spawn', spawnDescriptor); globalThis.fetch = actualFetch
  const sources = ['sdk/src/__tests__/fixtures/b19-supervision-sdk-compiled-entry.ts', 'sdk/src/client.ts', 'sdk/src/run.ts',
    'sdk/src/impl/agent-runtime.ts', 'sdk/src/host-execution.ts', 'sdk/src/host-config.ts',
    'packages/agent-runtime/src/supervision/supervised-spawn.ts', 'packages/agent-runtime/src/supervision/process-supervisor.ts',
    'packages/agent-runtime/src/supervision/parent-bridge-server.ts', 'packages/agent-runtime/src/supervision/child-entry.ts']
  const evidence = { schemaVersion: 1, producer: 'sdk.supervision', targetBranch, control, mode, status: assertionsCompleted ? 'passed' : 'failed', assertionsCompleted,
    executable: process.execPath, executableSha256: sha256(process.execPath), bun: Bun.version,
    sourceHashes: Object.fromEntries(sources.map(file => [file, sha256(path.join(repo, file))])),
    sourceChildPath: resolveSupervisedChildEntryPath(), actualSelfExecMode: isSupervisedSpawnSelfExecMode(), factoryConstructed,
    capturedSnapshotId: captured.snapshot.snapshotId, resolverCalls, registrations, policies, events, boundaries, preparedAttempts,
    clockTransitions, zeroSelection, networkCalls, result, peer, failure,
    removedSandboxes: [...new Set([...boundaries.map(boundary => boundary.cwd), ...preparedAttempts.map(attempt => attempt.cwd)])]
      .map(cwd => ({ path: cwd, removed: !!cwd && !existsSync(cwd) })),
    limitations: ['Factory mode starts at actual getAgentRuntimeImpl with authentic host handles and a fixture-owned exact origin resolver; it does not claim run.ts registration',
      'SDK-run mode additionally preserves actual run.ts action registration and origin resolution',
      'Factory mode deliberately omits the child template; real child entry may return a schema-valid failed receipt with transport outcome ok',
      'First retry boundary throws before OS spawn; successful boundaries and observed PIDs are real',
      'Literal-zero uses the actual SDK scalar adapter after factory setup; it never invokes a launch or reaches a retry',
      'Pre-abort occurs before initial seam binding or after first failed boundary, so later attempt can be suppressed by production restart cancellation',
      'No complete child strategy, MCP, provider task, full CLI bundle, process containment, or B29 equivalence claim'] }
  const serialized = JSON.stringify(evidence, (_key, item) => item instanceof Error ? { ...item, name: item.name, message: item.message, stack: item.stack } : item, 2)
  writeFileSync(path.join(evidenceDirectory, `${mode}--${targetBranch}--${control}--${id}.json`), serialized + '\n', { flag: 'wx' })
  console.log(serialized)
  rmSync(root, { recursive: true, force: true })
}
if (failure) process.exitCode = 1
