/**
 * Standalone B19 fixture, to be compiled and executed only by the root after
 * freeze. The parent uses the unchanged producer, supervisor and default Bun
 * spawn adapter. The child uses the unchanged runChildEntryMain entrypoint.
 * This is a minimal compiled consumer, not the complete Openbuff CLI bundle.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import { buildDefaultSpawnSupervised, isSupervisedSpawnSelfExecMode, resolveSupervisedChildEntryPath } from '@codebuff/agent-runtime/supervision/supervised-spawn'
import { SUPERVISED_SELF_EXEC_FLAG } from '@codebuff/agent-runtime/supervision/self-exec-flag'
import { createHostExecutionServices } from '../../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../../host-config'
import type { LaunchEvent, PolicyInput, Result } from '@codebuff/common/types/contracts/execution-context'

function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`); return result.value }
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

if (process.argv[2] === SUPERVISED_SELF_EXEC_FLAG) {
  // Same argv stripping convention as cli/src/index.tsx. The recorder is an
  // additional fixture observation; the real child entry emits the receipt.
  const recordFile = process.env.EXTERNAL_COMPILED_RECORD
  if (recordFile) writeFileSync(recordFile, JSON.stringify({ pid: process.pid, argv: process.argv, env: process.env }))
  const { runChildEntryMain } = await import('@codebuff/agent-runtime/supervision/child-entry')
  process.exit(await runChildEntryMain([process.argv[0]!, process.argv[1]!, ...process.argv.slice(3)]))
}

const args = process.argv.slice(2)
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const control = option('--control') ?? 'happy'
const retry = option('--branch') === 'retry'
const supported = ['happy', 'denied', 'unavailable', 'pre-aborted', 'deadline-zero', 'delayed-authorizer-cancellation', 'exhausted-before-later-branch']
assert(supported.includes(control), `Unknown control: ${control}`)
assert(retry || control !== 'exhausted-before-later-branch', 'Initial branch has no earlier supervised boundary')
assert(isSupervisedSpawnSelfExecMode(), 'This fixture must be a real Bun-compiled binary; source mode is not self-exec evidence')
const repo = path.resolve(option('--repo') ?? process.cwd())
const evidenceDirectory = path.join(repo, 'docs/execution/body-roadmap/evidence/B19/implementation/branch-controls-r3/external/compiled')
const root = mkdtempSync(path.join(tmpdir(), 'b19-compiled-supervision-'))
const configFile = path.join(root, 'openbuff.json'), peerFile = path.join(root, 'peer.json')
writeFileSync(configFile, JSON.stringify({ providers: {
  fixture: { type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['fixture-model'], apiKeyEnv: 'CUSTOM_PROVIDER_KEY' },
} }))
const environment = { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), PROJECT_VALUE: 'compiled-captured-public',
  OPENAI_API_KEY: 'compiled-canonical-sentinel', CUSTOM_PROVIDER_KEY: 'compiled-configured-sentinel',
  EXTERNAL_COMPILED_RECORD: peerFile, OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1' }
const captured = loadHostConfigSnapshot({ inputs: { environment, platform: 'linux', invocationCwd: root, projectRoot: root,
  home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: configFile, required: true },
  trust: { ancestorConfig: false, projectReadableRoots: false } }, fs: nodeConfigReadFs })
if (captured.status !== 'complete') throw new Error(captured.cause)
assert.equal(captured.status, 'complete')
let now = 100
const clock = { domainId: `compiled:${root}`, nowMs: () => now }
const stop = new AbortController(), cancellation = new AbortController()
const events: LaunchEvent[] = [], authorizations: PolicyInput[] = []
const targetBranch = `supervised.self-exec.${retry ? 'retry' : 'initial'}`
let entered!: () => void, release!: () => void
const authorizationEntered = new Promise<void>(resolve => { entered = resolve })
const authorizationReleased = new Promise<void>(resolve => { release = resolve })
const host = value(createHostExecutionServices({ snapshot: captured.snapshot, clock, signal: stop.signal,
  boundary: value(captureRootDeadline({ clock, limit: { kind: 'unbounded' } })), childInheritanceEnvironment: environment,
  record: event => events.push(event), authorizeAsync: async input => {
    authorizations.push(input)
    if (input.facts.branchId === targetBranch) {
      if (control === 'denied' || control === 'unavailable') return { ok: false, reason: control, cause: `compiled-${control}` }
      if (control === 'delayed-authorizer-cancellation') { entered(); await authorizationReleased }
    }
    return { ok: true, basis: 'explicit-policy', decisionId: `compiled-fixture:${input.facts.launchId}` }
  } }))
const scope = value(host.registerRun({ clientSessionId: 'compiled-session', rootRunId: 'compiled-run', parentRunId: 'compiled-run', parentAgentId: 'compiled-agent' }))
const context = value(scope.action({ actionId: 'compiled-action', attemptId: control,
  basisId: hashActionInput('compiled.fixture', { targetBranch, control }), signal: cancellation.signal,
  limit: { kind: 'finite', durationMs: 1000 } }))
const arm = () => {
  if (control === 'pre-aborted') cancellation.abort(new Error('compiled request cancelled before target'))
  if (control === 'deadline-zero' || control === 'exhausted-before-later-branch') now = 1101
}
if (!retry) arm()
const boundaryCalls: Array<{ cmd: string[]; env: Record<string, string>; cwd?: string; launchId: string; branch: string; pid?: number; failure?: string }> = []
const childExits: Promise<unknown>[] = []
const actualSpawn = Bun.spawn
const spawnDescriptor = Object.getOwnPropertyDescriptor(Bun, 'spawn')!
Object.defineProperty(Bun, 'spawn', { ...spawnDescriptor, value: (...spawnArgs: unknown[]) => {
  assert(Array.isArray(spawnArgs[0]), 'Expected default supervisor argv-array Bun boundary')
  const options = spawnArgs[1] as { env: Record<string, string>; cwd?: string }
  const facts = authorizations.at(-1)?.facts
  assert(facts, 'Actual Bun boundary lacks authorization')
  const call = { cmd: [...spawnArgs[0]], env: { ...options.env }, cwd: options.cwd, launchId: facts.launchId, branch: facts.branchId } as typeof boundaryCalls[number]
  boundaryCalls.push(call)
  if (retry && boundaryCalls.length === 1) {
    call.failure = 'fixture first-boundary spawn throw'
    throw new Error(call.failure)
  }
  // The actual default adapter receives this real Bun result and invokes its
  // own launch-bound observer. No synthetic PID or observer call is supplied.
  const child = Reflect.apply(actualSpawn, Bun, spawnArgs)
  call.pid = child.pid
  childExits.push(child.exited)
  return child
} })
const seam = buildDefaultSpawnSupervised({ openbuffApiKey: 'compiled-overlay-sentinel' }, undefined, {
  executionForRequest: () => context,
  restart: retry ? { maxAttempts: 1, backoffMs: 0 } : undefined,
  _scheduleRestart: async () => { arm() },
})
let result: unknown, failure: unknown, peer: unknown
try {
  const pending = Promise.resolve().then(() => seam({ agentType: 'fixture', prompt: 'compiled branch fixture', spawnParams: undefined }, { signal: context.signal }))
    .catch(error => error)
  if (control === 'delayed-authorizer-cancellation') {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([authorizationEntered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Compiled target authorizer was not reached')), 3000) })])
      cancellation.abort(new Error('compiled cancellation during authorization'))
    } finally { if (timer) clearTimeout(timer); release() }
  }
  result = await pending
  await Promise.allSettled(childExits)
  peer = existsSync(peerFile) ? JSON.parse(readFileSync(peerFile, 'utf8')) : undefined
  const targetCalls = boundaryCalls.filter(call => call.branch === targetBranch)
  assert.equal(targetCalls.length, control === 'happy' ? 1 : 0)
  assert.equal(boundaryCalls.length, (retry ? 1 : 0) + (control === 'happy' ? 1 : 0))
  assert.equal(events.filter(event => event.phase === 'spawn-observed').length, control === 'happy' ? 1 : 0)
  if (['happy', 'denied', 'unavailable', 'delayed-authorizer-cancellation'].includes(control))
    assert(authorizations.some(input => input.facts.branchId === targetBranch))
  for (const call of boundaryCalls) {
    assert.equal(call.cmd[0], process.execPath)
    assert.equal(call.cmd[1], SUPERVISED_SELF_EXEC_FLAG)
    assert.equal(call.env.PROJECT_VALUE, 'compiled-captured-public')
    assert.equal(call.env.OPENAI_API_KEY, undefined)
    assert.equal(call.env.CUSTOM_PROVIDER_KEY, undefined)
    assert.equal(call.env.OPENBUFF_API_KEY, undefined)
  }
  if (control === 'happy') {
    const settled = result as { outcome: string; receipt?: { status: string; errors: Array<{ code: string }> } }
    assert.equal(settled.outcome, 'ok')
    assert.equal(settled.receipt?.status, 'failed')
    assert(settled.receipt?.errors.some(error => error.code === 'unsupported-deps'))
    assert.deepEqual((peer as { env: unknown }).env, targetCalls[0]!.env)
    assert.equal((peer as { pid: number }).pid, targetCalls[0]!.pid)
  }
  for (const event of events) if (event.phase === 'no-launch') assert.equal(event.facts.profile.active, null)
} catch (error) { failure = error }
finally {
  Object.defineProperty(Bun, 'spawn', spawnDescriptor)
  stop.abort(new Error('compiled fixture complete'))
  await Promise.allSettled(childExits)
  const sources = ['sdk/src/__tests__/fixtures/external-branch-compiled-entry.ts',
    'packages/agent-runtime/src/supervision/supervised-spawn.ts', 'packages/agent-runtime/src/supervision/process-supervisor.ts',
    'packages/agent-runtime/src/supervision/child-entry.ts', 'packages/agent-runtime/src/supervision/self-exec-flag.ts',
    'sdk/src/host-execution.ts', 'sdk/src/host-config.ts', 'common/src/util/execution-context.ts']
  const evidence = { schemaVersion: 1, producer: 'sdk.supervision', matrixBranch: targetBranch, runtimeBranch: targetBranch, control,
    status: failure ? 'failed' : 'passed', evidenceKind: 'real-minimal-compiled-self-exec-default-bun-adapter',
    executable: process.execPath, executableSha256: sha256(process.execPath), bun: Bun.version,
    resolvedChildEntryPath: resolveSupervisedChildEntryPath(), actualSelfExecMode: isSupervisedSpawnSelfExecMode(),
    sourceHashes: Object.fromEntries(sources.map(file => [file, sha256(path.join(repo, file))])),
    capturedConfigurationSnapshotId: captured.snapshot.snapshotId, boundaryCalls, authorizations, events, peer, result, failure,
    limitations: ['Minimal compiled consumer, not full CLI/bundle equivalence', 'Bridge-less child returns the real unsupported-deps failed receipt',
      'Retry first boundary is a deliberate throw before a real OS spawn', 'No provider/network task, B29 equivalence, or process-tree containment claim'] }
  mkdirSync(evidenceDirectory, { recursive: true })
  const serialized = JSON.stringify(evidence, (_key, item) => item instanceof Error ? { ...item, name: item.name, message: item.message } : item, 2)
  writeFileSync(path.join(evidenceDirectory, `${targetBranch}--${control}.json`), serialized + '\n')
  console.log(serialized)
  rmSync(root, { recursive: true, force: true })
}
if (failure) process.exitCode = 1
