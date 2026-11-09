import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import { captureRootDeadline, createHostAuthority, executionBindingTuple } from '@codebuff/common/util/execution-context'
import { classifyCapturedTargetForExecution, classifyHarnessArgv, classifyTerminalHarnessAction, HarnessApprovalService, isStoredExecutionAuthorityV2 } from '../services/harness-enforcement'
import { LocalHarnessStore } from '../services/local-harness-store'
import { createHostExecutionServices } from '../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import type { HostExecutionOptions } from '../host-execution'
import type { HostAuthorityInputs, PolicyInput, Result, StoredExecutionAuthorityV2, TargetDescription } from '@codebuff/common/types/contracts/execution-context'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const scope = { repositoryId: 'fixture-repository', workspaceId: 'fixture-workspace', runId: 'fixture-run', snapshotId: 'fixture-snapshot' }
const bindingFields = ['format', 'keyEpochId', 'commandHash', 'executableArgvDigest', 'effectRosterDigest', 'parseStatus', 'hostContextId', 'configurationSnapshotId', 'correlationDigest', 'cwd', 'projectRoot', 'allowedPaths', 'profileRequestDigest', 'selectedBackendDigest', 'environmentDigest', 'credentialRosterId', 'destinationId', 'delegationDigest', 'requestId', 'resourceId', 'resourceGeneration', 'ownerId', 'leaseId', 'processType', 'mode', 'detachTransferId', 'deadlinesDigest', 'adapterOptionsDigest', 'launchId'] as const
const envelopeFields = ['version', 'bindingFormat', 'keyEpochId', 'bindingDigest', 'binding', 'usage'] as const
function value<T>(result: Result<T> | { ok: false; reason: string; cause: string }): T { if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`); return result.value }
function temporaryRoot() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-execution-approval-')); roots.push(root); return root }
function stored(input: PolicyInput): StoredExecutionAuthorityV2 {
  return { version: 2, bindingFormat: 'openbuff.execution.v2', keyEpochId: input.binding.keyEpochId,
    bindingDigest: input.bindingDigest, binding: input.binding, usage: 'one-target-dispatch' }
}

/** Real registry/binding producer with deterministic clocks and explicit policy. */
function core(authorize?: HostAuthorityInputs['authorizeAsync']) {
  const policyInputs: PolicyInput[] = []
  const events: unknown[] = []
  const clock = { domainId: 'approval-test-clock', nowMs: () => 10 }
  const authority = createHostAuthority({
    configuration: { snapshotId: scope.snapshotId, trustPolicyId: 'fixture-trust', rosterId: 'fixture-roster', canonicalCredentialNames: ['OPENAI_API_KEY'], configuredCredentialNames: [] },
    childInheritanceEnvironment: { PATH: '/usr/bin:/bin', FIXTURE_PUBLIC: 'one', OPENAI_API_KEY: 'fixture-secret' }, childOverrides: {}, inheritEnv: true,
    platform: 'linux', clock, scheduler: { set: () => 0, clear: () => {} },
    resolveProfile: requested => ({ requested, available: [{ backend: 'portable-ts', generation: 'test-1', capabilities: ['exact-env'], unavailableReasons: [] }],
      selected: { backend: 'portable-ts', generation: 'test-1', policy: requested.policy, cancellation: 'cooperative' }, active: null,
      enforced: [{ capability: 'exact-env', status: 'enforced', evidenceId: 'fixture-env' }] }),
    classifyTarget: classifyCapturedTargetForExecution,
    authorizeAsync: async input => { policyInputs.push(input); return authorize ? authorize(input) : { ok: true, basis: 'explicit-policy', decisionId: 'fixture-allow' } },
    authorizeSync: () => ({ ok: false, reason: 'unavailable', cause: 'No synchronous policy in this fixture' }),
    isCurrentBasis: () => true, record: event => events.push(event),
  })
  const lifetime = value(authority.registerRootLifetime({ boundary: value(captureRootDeadline({ clock, limit: { kind: 'unbounded' } })) }))
  const jobOwner = { clientSessionId: 'client', rootRunId: 'run', parentRunId: 'run', parentAgentId: 'agent' }
  const owner = value(authority.registerOwner({ description: { kind: 'run', owner: jobOwner }, lifetime })).owner
  let action = 0
  function prepare(extra: Partial<TargetDescription> = {}) {
    const budget = value(authority.registerAction({ owner, parent: lifetime, limit: { kind: 'finite', durationMs: 1000 },
      correlation: { kind: 'action', actionId: `action-${++action}`, attemptId: 'attempt', basisId: 'basis', owner: jobOwner } }))
    const request = value(authority.registerRequest({ budget }))
    const execution = value(authority.bindAction({ owner, budget, request }))
    return value(execution.prepareTarget({ target: { executable: '/usr/bin/git', argv: ['commit', '-m', 'fixture message'],
      cwd: '/virtual/project', projectRoot: '/virtual/project', allowedPaths: ['/virtual/project'],
      profile: { policy: 'git-commit', preferredBackend: 'portable-ts', required: ['exact-env'], allowBackendFallback: false },
      mode: 'assistant', processType: 'SYNC', family: 'diagnostic-build-version-scip', branchId: 'approval.fixture',
      adapterOptions: { runtime: 'node', stdio: 'pipe' }, ...extra } }))
  }
  return { prepare, policyInputs, events }
}

async function authentic() { const h = core(); const launch = h.prepare(); value(await launch.admit()); return stored(h.policyInputs[0]) }
function approval(authority: StoredExecutionAuthorityV2) {
  const store = new LocalHarnessStore(temporaryRoot())
  const service = new HarnessApprovalService(store)
  const base = { action: 'commit', target: 'fixture-target', commandHash: authority.binding.commandHash, executionAuthority: authority }
  const grant = service.grant(scope, base)
  const request = { ...scope, ...base, approvalId: grant.id }
  return { store, service, grant, request }
}

describe('B19 exact argv approval classification', () => {
  test.each([
    [['commit', '-m', 'a  b'], ['commit', '-m', 'a b']],
    [['commit', '-m', 'a b'], ['commit', '-m', 'a', 'b']],
    [['commit', '-m', '"quoted"'], ['commit', '-m', 'quoted']],
    [['commit', '-m', '$(touch never)'], ['commit', '-m', 'touch never']],
    [['commit', '-m', 'semi;colon'], ['commit', '-m', 'semi', ';', 'colon']],
  ])('retains exact argument boundaries and bytes in command hashes', (first, second) => {
    const a = classifyHarnessArgv({ executable: 'git', argv: first })!
    const b = classifyHarnessArgv({ executable: 'git', argv: second })!
    expect(a.commandHash).not.toBe(b.commandHash)
    expect(a.effects?.map(effect => effect.action)).toEqual(['commit'])
    expect(b.effects?.map(effect => effect.action)).toEqual(['commit'])
  })

  test('literal argv metacharacters never become shell effects', () => {
    const result = classifyHarnessArgv({ executable: 'git', argv: ['commit', '-m', 'ok; npm publish && rm -rf /anything'] })!
    expect(result.parseStatus).toBe('complete')
    expect(result.effects?.map(effect => effect.action)).toEqual(['commit'])
  })

  test.each(['echo ordinary', 'git status', 'printf "%s" literal'])('ordinary explicit shell -c payload has no fabricated effects: %s', command => {
    const classified = classifyCapturedTargetForExecution({ kind: 'argv', executable: '/bin/sh', argv: ['-c', command] })
    expect(classified.effects).toEqual([])
    expect(classified.parseStatus).toBe('complete')
  })

  test('shell -c preserves the full parsed effect target and ordering', () => {
    const command = 'git push origin feature; npm publish; rm -rf build'
    const shell = classifyTerminalHarnessAction(command)!
    const token = classifyHarnessArgv({ executable: '/bin/sh', argv: ['-c', command] })!
    expect(shell.effects?.map(effect => effect.action)).toEqual(['push', 'release', 'workspace-delete'])
    expect(token.effects).toEqual(shell.effects)
    expect(token.effects?.[0].target).toBe('origin/feature')
    expect(token.commandHash).not.toBe(shell.commandHash)
  })

  test.each([
    ['env', ['X=1', 'git', 'status']], ['sudo', ['git', 'status']], ['timeout', ['3', 'git', 'status']],
    ['bash', ['-lc', 'git status']], ['bash', ['--rcfile', '/tmp/fixture', '-c', 'git status']],
    ['sh', ['--', '-c', 'git status']], ['node', ['fixture-script.js']], ['pwsh', ['-Command', 'git status']],
  ] as const)('unsupported wrapper/startup semantics stay explicit: %s', (executable, argv) => {
    const result = classifyHarnessArgv({ executable, argv })!
    expect(result.parseStatus).toBe('unsupported')
    expect(result.effects?.map(effect => effect.action)).toEqual(['arbitrary-code'])
  })
})

describe('B19 stored execution authority v2', () => {
  test('real core produces the exact six-envelope and 29-binding member contract', async () => {
    const authority = await authentic()
    expect(Object.keys(authority).sort()).toEqual([...envelopeFields].sort())
    expect(Object.keys(authority.binding).sort()).toEqual([...bindingFields].sort())
    expect(executionBindingTuple(authority.binding)).toHaveLength(29)
    expect(isStoredExecutionAuthorityV2(authority)).toBe(true)
  })

  test.each([...envelopeFields])('rejects a missing or wrongly typed envelope member: %s', async field => {
    const authority = await authentic()
    const missing = { ...authority } as Record<string, unknown>; delete missing[field]
    expect(isStoredExecutionAuthorityV2(missing)).toBe(false)
    expect(isStoredExecutionAuthorityV2({ ...authority, [field]: null })).toBe(false)
  })

  test.each([...bindingFields])('rejects missing and wrongly typed binding member: %s', async field => {
    const authority = await authentic()
    const missing = { ...authority.binding } as Record<string, unknown>; delete missing[field]
    expect(isStoredExecutionAuthorityV2({ ...authority, binding: missing })).toBe(false)
    expect(isStoredExecutionAuthorityV2({ ...authority, binding: { ...authority.binding, [field]: field === 'detachTransferId' ? 5 : null } })).toBe(false)
  })

  test('rejects extra fields, v1 history, non-absolute paths and malformed digests', async () => {
    const authority = await authentic()
    expect(isStoredExecutionAuthorityV2({ ...authority, extra: true })).toBe(false)
    expect(isStoredExecutionAuthorityV2({ ...authority, binding: { ...authority.binding, extra: true } })).toBe(false)
    expect(isStoredExecutionAuthorityV2({ ...authority, version: 1 })).toBe(false)
    expect(isStoredExecutionAuthorityV2({ version: 1, executionContextHash: 'legacy' })).toBe(false)
    for (const field of ['cwd', 'projectRoot'] as const) expect(isStoredExecutionAuthorityV2({ ...authority, binding: { ...authority.binding, [field]: 'relative' } })).toBe(false)
    expect(isStoredExecutionAuthorityV2({ ...authority, binding: { ...authority.binding, allowedPaths: ['relative'] } })).toBe(false)
    for (const field of ['environmentDigest', 'profileRequestDigest', 'deadlinesDigest', 'correlationDigest', 'commandHash'] as const)
      expect(isStoredExecutionAuthorityV2({ ...authority, binding: { ...authority.binding, [field]: 'invalid-digest' } })).toBe(false)
  })

  test.each(['keyEpochId', 'bindingDigest', 'environmentDigest', 'profileRequestDigest', 'selectedBackendDigest', 'deadlinesDigest', 'correlationDigest', 'resourceGeneration', 'cwd', 'allowedPaths'] as const)(
    'altered %s cannot consume the stored exact grant', async field => {
      const authority = await authentic()
      const fixture = approval(authority)
      const changed = structuredClone(authority) as unknown as Record<string, unknown>
      const binding = changed.binding as Record<string, unknown>
      if (field === 'keyEpochId') { changed.keyEpochId = 'different-epoch'; binding.keyEpochId = 'different-epoch' }
      else if (field === 'bindingDigest') changed.bindingDigest = 'a'.repeat(64)
      else binding[field] = field === 'allowedPaths' ? ['/different'] : field === 'cwd' ? '/different' : field.endsWith('Digest') ? 'a'.repeat(64) : 'different-generation'
      expect(() => fixture.service.consume({ ...fixture.request, executionAuthority: changed as unknown as StoredExecutionAuthorityV2 })).toThrow('execution authority v2')
      expect(fixture.store.read(scope.repositoryId, 'approvals', fixture.grant.id)?.consumedAt).toBeUndefined()
      expect(fixture.service.consume(fixture.request).consumedAt).toBeDefined()
    },
  )

  test('v1 approvals cannot be consumed by v2 and v2 cannot fall back to a v1 request', async () => {
    const authority = await authentic()
    const fixture = approval(authority)
    const { executionAuthority: _removed, ...legacyRequest } = fixture.request
    expect(() => fixture.service.consume(legacyRequest)).toThrow('execution authority v2')
    const legacy = fixture.service.grant(scope, { action: 'commit', target: 'fixture-target', commandHash: authority.binding.commandHash, executionContextHash: 'legacy-context' })
    expect(() => fixture.service.consume({ ...fixture.request, approvalId: legacy.id, executionContextHash: 'legacy-context' })).toThrow('execution authority v2')
  })

  test('the approval is consumed once before actual ENOENT and is never renewed by dispatch failure', async () => {
    const store = new LocalHarnessStore(temporaryRoot())
    const service = new HarnessApprovalService(store)
    let grant: ReturnType<typeof service.grant> | undefined
    let request: Parameters<typeof service.consume>[0] | undefined
    const h = core(async input => {
      const authority = stored(input)
      grant = service.grant(scope, { action: 'arbitrary-code', target: 'missing-fixture', commandHash: input.binding.commandHash, executionAuthority: authority })
      request = { ...scope, approvalId: grant.id, action: grant.action, target: grant.target, commandHash: grant.commandHash, executionAuthority: authority }
      service.consume(request)
      return { ok: true, basis: 'exact-action-approval', decisionId: grant.id }
    })
    const launch = h.prepare({ executable: '/openbuff-fixture-executable-does-not-exist', argv: [], cwd: process.cwd(), projectRoot: process.cwd(), allowedPaths: [process.cwd()] })
    const admission = value(await launch.admit())
    expect(store.read(scope.repositoryId, 'approvals', grant!.id)?.consumedAt).toBeDefined()
    const dispatched = value(launch.dispatchNow(admission.permit, (input, observer) => {
      const child = spawn(input.executable, input.argv, { cwd: input.cwd, env: input.env })
      const done = new Promise<void>(resolve => {
        child.on('spawn', () => { observer.spawnObserved({ source: 'node-spawn-event', pid: child.pid! }) })
        child.on('error', (error: NodeJS.ErrnoException) => { observer.failure({ source: 'node-error-event', errorCode: error.code, cause: error.message }); resolve() })
      })
      return { child, done }
    }))
    await dispatched.handle.done
    expect(h.policyInputs).toHaveLength(1)
    expect(h.events.some(event => (event as { phase: string }).phase === 'spawn-observed')).toBe(false)
    expect(launch.dispatchNow(admission.permit, () => { throw new Error('must not launch twice') }).ok).toBe(false)
    expect((await launch.admit()).ok).toBe(false)
    expect(() => service.consume(request!)).toThrow('already consumed')
    expect(h.policyInputs).toHaveLength(1)
  })

  test('independent processes contend for the stored v2 grant and exactly one consumes it', async () => {
    const authority = await authentic()
    const fixture = approval(authority)
    const root = fixture.store.rootDir
    const requestPath = path.join(root, 'request.json')
    fs.writeFileSync(requestPath, JSON.stringify(fixture.request))
    const scriptPath = path.join(root, 'consume.ts')
    fs.writeFileSync(scriptPath, `import fs from 'node:fs';
import { HarnessApprovalService } from ${JSON.stringify(path.resolve(import.meta.dir, '../services/harness-enforcement.ts'))};
import { LocalHarnessStore } from ${JSON.stringify(path.resolve(import.meta.dir, '../services/local-harness-store.ts'))};
const [root, id] = process.argv.slice(2);
fs.writeFileSync(root + '/ready-' + id, 'ready');
const until = Date.now() + 5000;
while (!fs.existsSync(root + '/start')) { if (Date.now() > until) throw new Error('barrier timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
let result;
try { const record = new HarnessApprovalService(new LocalHarnessStore(root)).consume(JSON.parse(fs.readFileSync(root + '/request.json', 'utf8'))); result = { ok: true, revision: record.revision }; }
catch (error) { result = { ok: false, error: String(error) }; }
fs.writeFileSync(root + '/result-' + id + '.json', JSON.stringify(result));
`)
    const children = ['a', 'b'].map(id => spawn(process.execPath, ['--no-env-file', scriptPath, root, id], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe'] }))
    const exits = children.map(child => new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }))
    try {
      const deadline = Date.now() + 5000
      while (!['a', 'b'].every(id => fs.existsSync(path.join(root, `ready-${id}`)))) {
        if (Date.now() > deadline) throw new Error('Consumers did not reach the barrier')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      fs.writeFileSync(path.join(root, 'start'), 'go')
      expect(await Promise.all(exits)).toEqual([0, 0])
      const outcomes = ['a', 'b'].map(id => JSON.parse(fs.readFileSync(path.join(root, `result-${id}.json`), 'utf8')))
      expect(outcomes.filter(result => result.ok)).toEqual([{ ok: true, revision: 1 }])
      expect(outcomes.find(result => !result.ok)?.error).toContain('already consumed')
      expect(fixture.store.read(scope.repositoryId, 'approvals', fixture.grant.id)?.revision).toBe(1)
    } finally { for (const child of children) child.kill() }
  }, 15_000)
})

function hostFlow(options: Partial<Pick<HostExecutionOptions, 'requestApproval' | 'resolveApprovalContext' | 'approvalMode'>> = {}) {
  const root = temporaryRoot()
  const store = new LocalHarnessStore(path.join(root, 'store'))
  const service = new HarnessApprovalService(store)
  const snapshot = loadHostConfigSnapshot({ inputs: { environment: {}, platform: 'linux', invocationCwd: root, projectRoot: root,
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'none' }, trust: { ancestorConfig: false, projectReadableRoots: false } }, fs: nodeConfigReadFs })
  if (snapshot.status !== 'complete') throw new Error(snapshot.cause)
  let now = 10
  const clock = { domainId: 'host-approval-clock', nowMs: () => now }
  const host = value(createHostExecutionServices({ snapshot: snapshot.snapshot, clock,
    boundary: value(captureRootDeadline({ clock, limit: { kind: 'unbounded' } })), childInheritanceEnvironment: {}, approvalMode: 'strict',
    resolveApprovalContext: async () => ({ service, ...scope, receiptIds: [], isCurrent: () => true }), ...options }))
  const execution = value(host.directOperation()).executionContext
  const launch = (extra: Partial<TargetDescription> = {}) => value(execution.execution.prepareTarget({ target: {
    executable: 'git', argv: ['commit', '-m', 'approved exact bytes'], cwd: root, projectRoot: root, allowedPaths: [root],
    profile: execution.profile, mode: 'assistant', processType: 'SYNC', family: 'sync-shell', branchId: 'terminal.sync',
    adapterOptions: { runtime: 'node', stdio: 'pipe' }, ...extra,
  } }))
  return { host, store, service, launch, root, snapshotId: snapshot.snapshot.snapshotId, setTime: (time: number) => { now = time } }
}

describe('B19 host exact approval flow', () => {
  test('repeated run registration preserves action identity and its original deadline', () => {
    const fixture = hostFlow()
    const owner = { clientSessionId: 'memo-client', rootRunId: 'memo-run', parentRunId: 'memo-run', parentAgentId: 'memo-agent' }
    const first = value(fixture.host.registerRun(owner))
    const action = { actionId: 'same-action', attemptId: 'same-attempt', basisId: 'same-basis' }
    const initial = value(first.action({ ...action, limit: { kind: 'finite', durationMs: 100 } }))
    const target: TargetDescription = { executable: 'git', argv: ['status'], cwd: fixture.root, projectRoot: fixture.root,
      allowedPaths: [fixture.root], profile: initial.profile, mode: 'assistant', processType: 'SYNC', family: 'sync-shell',
      branchId: 'terminal.sync', adapterOptions: { runtime: 'node', stdio: 'pipe' } }
    const before = value(initial.execution.prepareTarget({ target })).facts()
    expect(before.deadlines.action).toMatchObject({ kind: 'finite', expiresAtMs: 110 })
    fixture.setTime(60)
    const repeated = value(fixture.host.registerRun({ ...owner }))
    expect(repeated).toBe(first)
    const resumed = value(repeated.action({ ...action, limit: { kind: 'finite', durationMs: 1000 } }))
    const after = value(resumed.execution.prepareTarget({ target })).facts()
    expect(after.ownerId).toBe(before.ownerId)
    expect(after.correlation).toEqual(before.correlation)
    expect(after.deadlines.action).toEqual(before.deadlines.action)
    expect(repeated.action({ ...action, basisId: 'different-basis' }).ok).toBe(false)
    fixture.setTime(110)
    expect(repeated.action({ ...action, limit: { kind: 'unbounded' } })).toMatchObject({ ok: false, reason: 'deadline-exhausted' })
  })

  test.each([...(['host', 'user', 'project', 'client'] as const)])('MCP startup uses captured %s origin', async origin => {
    let callbacks = 0
    const fixture = hostFlow({ resolveApprovalContext: undefined, requestApproval: async () => { callbacks++; return true } })
    const operation = value(fixture.host.directOperation())
    const target: TargetDescription = { executable: '/fixture/mcp-server', argv: ['--stdio'], cwd: fixture.root,
      projectRoot: fixture.root, allowedPaths: [fixture.root], profile: operation.executionContext.profile, mode: 'assistant',
      processType: 'BACKGROUND', family: 'mcp-stdio', branchId: 'mcp.cold-start', adapterOptions: { runtime: 'node', stdio: 'pipe' } }
    const destination = value(fixture.host.execution.registerDestination({ snapshotId: fixture.snapshotId, origin,
      resolved: { kind: 'mcp-stdio', command: target.executable, args: target.argv, declaredEnv: {} } }))
    const resource = value(operation.resources(target, destination))
    const request = value(resource.request(operation.executionContext.execution))
    const prepared = value(request.prepareLaunch())
    const admitted = await prepared.admit()
    if (origin === 'client') expect(admitted).toMatchObject({ ok: false, reason: 'unavailable' })
    else expect(admitted.ok).toBe(true)
    expect(callbacks).toBe(0)
    expect(fixture.store.list(scope.repositoryId, 'approvals')).toEqual([])
    expect(fixture.host.events.filter(event => event.phase === 'dispatched')).toEqual([])
  })

  test('trusted MCP startup still requires approval for a classified high-impact effect', async () => {
    const fixture = hostFlow({ resolveApprovalContext: undefined })
    const operation = value(fixture.host.directOperation())
    const target: TargetDescription = { executable: 'npm', argv: ['publish'], cwd: fixture.root,
      projectRoot: fixture.root, allowedPaths: [fixture.root], profile: operation.executionContext.profile, mode: 'assistant',
      processType: 'BACKGROUND', family: 'mcp-stdio', branchId: 'mcp.cold-start', adapterOptions: { runtime: 'node', stdio: 'pipe' } }
    const resource = value(operation.resources(target))
    const prepared = value(value(resource.request(operation.executionContext.execution)).prepareLaunch())
    expect(await prepared.admit()).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  test('derived initiating action keeps its deadline when starting a trusted resource', async () => {
    const fixture = hostFlow({ resolveApprovalContext: undefined })
    const operation = value(fixture.host.directOperation({ limit: { kind: 'finite', durationMs: 1000 } }))
    const derived = value(operation.executionContext.execution.derive({ memoKey: 'mcp-request', limit: { kind: 'finite', durationMs: 100 } }))
    fixture.setTime(60)
    const target: TargetDescription = { executable: '/fixture/mcp-server', argv: ['--stdio'], cwd: fixture.root,
      projectRoot: fixture.root, allowedPaths: [fixture.root], profile: operation.executionContext.profile, mode: 'assistant',
      processType: 'BACKGROUND', family: 'mcp-stdio', branchId: 'mcp.cold-start', adapterOptions: { runtime: 'node', stdio: 'pipe' } }
    const resource = value(operation.resources(target))
    const prepared = value(value(resource.request(derived)).prepareLaunch())
    expect(prepared.facts().deadlines.action).toMatchObject({ kind: 'finite', expiresAtMs: 1010 })
    expect(prepared.facts().deadlines.requestAdmission).toMatchObject({ kind: 'finite', expiresAtMs: 110 })
    expect((await prepared.admit()).ok).toBe(true)
  })

  test('real background receiver port commits transfer before preparation and survives sender cancellation', async () => {
    const fixture = hostFlow({ approvalMode: 'allow-all' }), foreign = hostFlow(), senderStop = new AbortController()
    const context = value(fixture.host.directOperation({ signal: senderStop.signal, limit: { kind: 'finite', durationMs: 100 } })).executionContext
    const target: TargetDescription = { executable: 'git', argv: ['status'], cwd: fixture.root, projectRoot: fixture.root,
      allowedPaths: [fixture.root], profile: context.profile, mode: 'assistant', processType: 'BACKGROUND', family: 'background-job',
      branchId: 'background.transferred', adapterOptions: { runtime: 'node', stdio: 'pipe' } }
    const receiver = value(fixture.host.createBackgroundReceiver('receiver-fixture-session'))
    expect(({ ...receiver }).prepareLaunch(context, target)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(receiver.prepareLaunch(value(foreign.host.directOperation()).executionContext, target).ok).toBe(false)
    const prepared = value(receiver.prepareLaunch(context, target))
    const phases = fixture.host.events.map(event => event.phase)
    expect(phases.indexOf('resource-transferred')).toBeLessThan(phases.indexOf('planned'))
    expect(prepared.facts().deadlines.action).toMatchObject({ kind: 'finite', expiresAtMs: 110 })
    expect(prepared.facts().deadlines.resourceLifetime).toMatchObject({ kind: 'finite', expiresAtMs: 110 })
    const exact = value(prepared.dispatchNow(value(await prepared.admit()).permit, input => input)).handle
    senderStop.abort(new Error('sender request ended'))
    expect(exact.resourceSignal.aborted).toBe(false)
    expect(fixture.host.events.some(event => event.phase === 'spawn-observed')).toBe(false)
    fixture.setTime(110)
    expect(receiver.prepareLaunch(context, target).ok).toBe(false)
  })

  test('sender cancellation before transferred launch admission prevents dispatch', async () => {
    const fixture = hostFlow({ approvalMode: 'allow-all' }), senderStop = new AbortController()
    const context = value(fixture.host.directOperation({ signal: senderStop.signal, limit: { kind: 'finite', durationMs: 100 } })).executionContext
    const target: TargetDescription = { executable: 'git', argv: ['status'], cwd: fixture.root, projectRoot: fixture.root,
      allowedPaths: [fixture.root], profile: context.profile, mode: 'assistant', processType: 'BACKGROUND', family: 'background-job',
      branchId: 'background.transferred', adapterOptions: { runtime: 'node', stdio: 'pipe' } }
    const receiver = value(fixture.host.createBackgroundReceiver('receiver-fixture-session'))
    const prepared = value(receiver.prepareLaunch(context, target))
    senderStop.abort(new Error('sender request ended before admission'))
    expect(await prepared.admit()).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(fixture.host.events.some(event => event.phase === 'resource-transferred')).toBe(true)
    expect(fixture.host.events.some(event => event.phase === 'dispatched' || event.phase === 'spawn-observed')).toBe(false)
  })

  test('a positive callback without current approval context never issues authority', async () => {
    let callbacks = 0
    const fixture = hostFlow({ resolveApprovalContext: undefined, requestApproval: async () => { callbacks++; return true } })
    expect(await fixture.launch().admit()).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(callbacks).toBe(0)
    expect(fixture.store.list(scope.repositoryId, 'approvals')).toEqual([])
  })

  test('accepted callback stores and consumes exact v2 before admitting, with receipt metadata', async () => {
    let requested: StoredExecutionAuthorityV2 | undefined
    const fixture = hostFlow({ requestApproval: async request => { requested = request.executionAuthority; return true } })
    const launch = fixture.launch()
    const admitted = value(await launch.admit())
    const records = fixture.store.list(scope.repositoryId, 'approvals')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ id: admitted.decisionId, revision: 1, executionAuthority: requested })
    expect(records[0].consumedAt).toBeDefined()
    expect(isStoredExecutionAuthorityV2(requested)).toBe(true)
    expect(fixture.host.getTerminalLaunchMetadata(launch.facts().launchId)).toMatchObject({ approvalReceiptId: admitted.decisionId,
      executionBindingVersion: 2, executionBindingDigest: requested!.bindingDigest })
  })

  test('an existing exact v2 receipt is consumed without prompting again', async () => {
    const store = new LocalHarnessStore(temporaryRoot())
    const service = new HarnessApprovalService(store)
    let receiptId: string | undefined
    let callbacks = 0
    const fixture = hostFlow({ requestApproval: async () => { callbacks++; return false }, resolveApprovalContext: async input => {
      const first = input.classification.effects[0]
      const grant = service.grant(scope, { action: first.action, target: first.target, commandHash: input.binding.commandHash, executionAuthority: stored(input) })
      receiptId = grant.id
      return { service, ...scope, receiptIds: [grant.id], isCurrent: () => true }
    } })
    expect(value(await fixture.launch().admit()).decisionId).toBe(receiptId!)
    expect(callbacks).toBe(0)
    expect(store.read(scope.repositoryId, 'approvals', receiptId!)?.consumedAt).toBeDefined()
  })

  test('workspace change while awaiting approval refuses and writes no grant', async () => {
    let current = true
    const store = new LocalHarnessStore(temporaryRoot())
    const service = new HarnessApprovalService(store)
    const fixture = hostFlow({ resolveApprovalContext: async () => ({ service, ...scope, receiptIds: [], isCurrent: () => current }),
      requestApproval: async () => { current = false; return true } })
    expect(await fixture.launch().admit()).toMatchObject({ ok: false, reason: 'stale-authority' })
    expect(store.list(scope.repositoryId, 'approvals')).toEqual([])
  })

  test('full shell effect roster reaches approval when a later effect requires it', async () => {
    let effects: readonly { action: string; target: string }[] | undefined
    const command = 'git commit -m fixture; npm publish'
    const fixture = hostFlow({ approvalMode: 'balanced', requestApproval: async request => { effects = request.effects; return true } })
    const launch = fixture.launch({ executable: '/bin/sh', argv: ['-c', command], shellCommandBytes: command })
    expect((await launch.admit()).ok).toBe(true)
    expect(effects).toEqual(classifyTerminalHarnessAction(command)!.effects!)
    expect(effects?.map(effect => effect.action)).toEqual(['commit', 'release'])
    expect(fixture.store.list(scope.repositoryId, 'approvals')).toHaveLength(1)
  })
})
