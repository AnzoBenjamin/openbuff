import * as childProcess from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spyOn } from 'bun:test'

import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { createHostExecutionServices } from '../../host-execution'
import type { HostExecutionOptions } from '../../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../../host-config'
import { executionLimitMs } from '../../services/execution-launch'

import type { ChildProcess } from 'node:child_process'
import type { AsyncDecision, Clock, LaunchEvent, PolicyInput, ProfileRequest, Result, SyncDecision } from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

export const branchStates = ['allow', 'denied', 'unavailable', 'pre-aborted', 'deadline-zero', 'delayed-cancel', 'exhausted'] as const
export type BranchState = typeof branchStates[number]
export type BranchFixture = ReturnType<typeof createToolchainBranchFixture>
export function hasLaunchFacts(event: LaunchEvent): event is Extract<LaunchEvent, { facts: unknown }> {
  return 'facts' in event
}

const ownedEvidenceBase = path.resolve(import.meta.dir, '../../../../docs/execution/body-roadmap/evidence/B19/implementation/branch-controls-r3/toolchain/runs')
const evidenceBase = process.env.B19_TOOLCHAIN_BRANCH_EVIDENCE_DIR ? path.resolve(process.env.B19_TOOLCHAIN_BRANCH_EVIDENCE_DIR) : undefined
if (evidenceBase && evidenceBase !== ownedEvidenceBase && !evidenceBase.startsWith(ownedEvidenceBase + path.sep)) throw new Error('Toolchain capture directory is outside the owned runs')
const processSpawn = childProcess.spawn
const processSpawnSync = childProcess.spawnSync

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}

/** Real SDK host composition and private authority; only policy/clock are controlled. */
export function createToolchainBranchFixture(options: {
  producerId: string
  branchId: string
  state: BranchState
  variant?: string
  evidenceKind?: string
  initiallyArmed?: boolean
  alwaysDenied?: readonly string[]
  matches?: (branchId: string) => boolean
  nativeRequired?: boolean
  realGit?: boolean
  exhaustAfterDispatchOf?: string
  waitForUseOfAction?: string
}) {
  const id = randomUUID()
  let now = 100
  const clock: Clock = { domainId: `toolchain-branch:${id}`, nowMs: () => now }
  const boundary = unwrap(captureRootDeadline({ clock, limit: { kind: 'finite', durationMs: 60_000 } }))
  const root = mkdtempSync(path.join(tmpdir(), 'openbuff-b19-toolchain-branch-'))
  const out = evidenceBase ? path.join(evidenceBase, id) : undefined
  if (out) mkdirSync(out, { recursive: true })
  const trace = path.join(root, 'child-events.jsonl')
  const binaryRoot = path.join(root, 'bin')
  mkdirSync(binaryRoot)
  const nodeExecutable = Bun.which('node')
  if (!nodeExecutable) throw new Error('The real toolchain fixture requires Node on PATH')
  const binarySource = `#!${nodeExecutable}\n` + readFileSync(path.join(import.meta.dir, 'toolchain-branch-peer.cjs'), 'utf8')
  for (const command of ['git', 'bun', 'node', 'python3', 'rustc', 'go', 'k6', 'cargo', 'uv', 'poetry', 'mvn', 'gradle', 'dotnet', 'blender', 'semgrep',
    'scip-typescript', 'scip-python', 'scip-rust', 'scip-java', 'scip-go', 'scip-clang', 'scip-dotnet', 'scip-ruby']) {
    const executable = path.join(binaryRoot, command)
    writeFileSync(executable, binarySource)
    chmodSync(executable, 0o755)
  }
  if (options.realGit) copyFileSync('/usr/bin/git', path.join(binaryRoot, 'git'))
  writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="branch-fixture"\nversion="0.1.0"\n')
  writeFileSync(path.join(root, 'go.mod'), 'module fixture.test/toolchain\n')
  writeFileSync(path.join(root, 'file.go'), 'package fixture\n')
  const config = path.join(root, 'openbuff.json')
  writeFileSync(config, JSON.stringify({ autoFileChangeHooks: false, providers: {
    fixture: { type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['fixture-model'], apiKeyEnv: 'CUSTOM_PROVIDER_KEY' },
  } }))
  const environment: Record<string, string | undefined> = {
    PATH: binaryRoot, PROJECT_VALUE: 'captured-public', DELETE_ME: 'remove-this', B19_CHILD_TRACE: trace,
    OPENAI_API_KEY: 'synthetic-canonical', CUSTOM_PROVIDER_KEY: 'synthetic-configured',
    OPENBUFF_TELEMETRY: '0', OPENBUFF_PROCESS_SUPERVISION: '0', DO_NOT_TRACK: '1',
    ...(options.realGit ? { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } : {}),
  }
  const loaded = loadHostConfigSnapshot({ inputs: {
    environment, platform: 'linux', invocationCwd: root, projectRoot: root,
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: config, required: true },
    trust: { ancestorConfig: false, projectReadableRoots: false },
  }, fs: nodeConfigReadFs })
  if (loaded.status !== 'complete') throw new Error(loaded.cause)
  const snapshot = loaded.snapshot
  const stop = new AbortController()
  const events: LaunchEvent[] = []
  const policy: Array<{ branchId: string; kind: 'async' | 'sync'; bindingDigest: string;
    target: PolicyInput['target']; classification: PolicyInput['classification']; facts: PolicyInput['facts'] }> = []
  const spawns: Array<{ kind: 'node' | 'spawn-sync'; command: string; argv: readonly string[]; cwd: string | undefined; env: NodeJS.ProcessEnv | undefined; timeout: number | undefined; signalAborted: boolean | null }> = []
  const children: Array<{ child: ChildProcess; closed: boolean; close: Promise<void> }> = []
  const delayed: Array<() => void> = []
  const dispatchWaiters: Array<{ branchId: string; resolve: () => void }> = []
  const clockTransitions: Array<{ beforeMs: number; afterMs: number; earlierDispatchIds: string[] }> = []
  const setupCommands: Array<{ command: string; argv: string[]; cwd: string; exitCode: number | null }> = []
  let lastResult: unknown
  let triggered = false
  let armed = options.initiallyArmed ?? true
  const selectedBranch = options.matches ?? ((branchId: string) => branchId === options.branchId)
  const matches = (branchId: string) => armed && selectedBranch(branchId)
  const advance = (milliseconds: number) => {
    const beforeMs = now
    now += milliseconds
    clockTransitions.push({ beforeMs, afterMs: now,
      earlierDispatchIds: events.filter(hasLaunchFacts).filter(event => event.phase === 'dispatched').map(event => event.facts.launchId) })
  }
  const decide = (input: PolicyInput, kind: 'async' | 'sync'): AsyncDecision | SyncDecision => {
    policy.push({ branchId: input.target.branchId, kind, bindingDigest: input.bindingDigest,
      target: input.target, classification: input.classification, facts: input.facts })
    if (options.alwaysDenied?.includes(input.target.branchId)) return { ok: false, reason: 'denied', cause: `Fixture requires a failed intermediate branch: ${input.target.branchId}` }
    if (matches(input.target.branchId) && (options.state === 'denied' || options.state === 'unavailable')) {
      return { ok: false, reason: options.state, cause: `Branch policy ${options.state}: ${input.target.branchId}` }
    }
    return kind === 'sync'
      ? { ok: true, basis: 'explicit-sync-policy', decisionId: `sync:${randomUUID()}` }
      : { ok: true, basis: 'explicit-policy', decisionId: `async:${randomUUID()}` }
  }
  const spawn: CodebuffSpawn = (command, argv = [], nativeOptions = {}) => {
    spawns.push({ kind: 'node', command, argv: [...argv], cwd: typeof nativeOptions.cwd === 'string' ? nativeOptions.cwd : undefined,
      env: nativeOptions.env && { ...nativeOptions.env }, timeout: nativeOptions.timeout, signalAborted: nativeOptions.signal?.aborted ?? null })
    const child = processSpawn(command, [...argv], nativeOptions)
    const entry = { child, closed: false, close: Promise.resolve() }
    entry.close = new Promise(resolve => child.once('close', () => { entry.closed = true; resolve() }))
    children.push(entry)
    return child
  }
  const profile: ProfileRequest = { policy: 'full-access', preferredBackend: options.nativeRequired ? 'native-exec' : 'portable-ts',
    required: ['exact-env'], allowBackendFallback: false }
  const hostOptions: HostExecutionOptions = { snapshot, boundary, clock, childInheritanceEnvironment: environment,
    env: { DELETE_ME: undefined, OPENAI_API_KEY: 'attempted-reinsert', CUSTOM_PROVIDER_KEY: 'attempted-reinsert' },
    signal: stop.signal, spawn, profile, approvalMode: 'allow-all',
    authorizeAsync: async input => {
      const decision = decide(input, 'async') as AsyncDecision
      if (options.waitForUseOfAction && input.facts.correlation.kind === 'action' &&
        input.facts.correlation.actionId === options.waitForUseOfAction && input.facts.profile.active !== null) {
        return new Promise<AsyncDecision>(resolve => delayed.push(() => resolve(decision)))
      }
      if (matches(input.target.branchId) && options.state === 'exhausted' && options.exhaustAfterDispatchOf) {
        const earlier = options.exhaustAfterDispatchOf
        if (!events.some(event => event.phase === 'dispatched' && event.facts.branchId === earlier)) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Earlier concurrent helper never dispatched: ${earlier}`)), 1_000)
            dispatchWaiters.push({ branchId: earlier, resolve: () => { clearTimeout(timer); resolve() } })
          })
        }
        advance(60_001)
      }
      if (matches(input.target.branchId) && options.state === 'delayed-cancel') {
        return new Promise<AsyncDecision>(resolve => {
          delayed.push(() => resolve(decision))
          queueMicrotask(() => stop.abort(new Error('Registered root cancelled while branch policy waits')))
        })
      }
      return decision
    },
    authorizeSync: input => matches(input.target.branchId) && options.state === 'delayed-cancel'
      ? Promise.resolve(decide(input, 'sync')) as unknown as SyncDecision
      : decide(input, 'sync') as SyncDecision,
    record: event => {
      events.push(event)
      if (event.phase === 'dispatched') {
        for (const waiter of dispatchWaiters.filter(waiter => waiter.branchId === event.facts.branchId)) waiter.resolve()
      }
      if (!triggered && event.phase === 'planned' && matches(event.facts.branchId)) {
        triggered = true
        if (options.state === 'exhausted' && !options.exhaustAfterDispatchOf) advance(60_001)
      }
    },
  }
  const host = unwrap(createHostExecutionServices(hostOptions))
  // Controlled time is supplied to the real host, which owns the actual timer
  // scheduler. Advancing this clock forces authority's absolute rechecks;
  // it does not claim a fake timer terminated an actual process.
  const jobOwner = { clientSessionId: id, rootRunId: id, parentRunId: id, parentAgentId: 'branch-control-strategy' }
  const scope = unwrap(host.registerRun(jobOwner))
  const baseContext = unwrap(scope.action({ actionId: `branch:${options.branchId}`, attemptId: 'attempt-1', basisId: 'fixture-basis' }))
  const zeroSelection = options.state === 'deadline-zero'
    ? executionLimitMs(0)
    : undefined
  if (zeroSelection?.ok) throw new Error('Literal zero SDK budget unexpectedly passed intake')
  const context = zeroSelection ? undefined : baseContext
  const syncSpy = spyOn(childProcess, 'spawnSync').mockImplementation(((command: string, argv?: readonly string[], nativeOptions?: childProcess.SpawnSyncOptions) => {
    if (nativeOptions?.cwd === root) spawns.push({ kind: 'spawn-sync', command, argv: [...argv ?? []], cwd: root,
      env: nativeOptions.env && { ...nativeOptions.env }, timeout: nativeOptions.timeout, signalAborted: null })
    return processSpawnSync(command, argv, nativeOptions)
  }) as typeof childProcess.spawnSync)
  function readChildren() {
    return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : []
  }
  function seedGitRepository() {
    if (!options.realGit) throw new Error('Repository setup requires the real Git fixture boundary')
    const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
    const git = (argv: string[]) => {
      const result = processSpawnSync('/usr/bin/git', argv, { cwd: root, env, encoding: 'utf8' })
      setupCommands.push({ command: '/usr/bin/git', argv, cwd: root, exitCode: result.status })
      if (result.status !== 0) throw new Error(`Git fixture setup failed: ${result.stderr}`)
    }
    writeFileSync(path.join(root, '.gitignore'), '*\n!file.go\n!.gitignore\n')
    git(['init', '--initial-branch=main', '--template='])
    git(['add', 'file.go', '.gitignore'])
    git(['commit', '-m', 'fixture base'])
    writeFileSync(path.join(root, 'file.go'), 'package fixture\nconst first = 1\n')
    git(['add', 'file.go'])
    git(['commit', '-m', 'fixture parent'])
    writeFileSync(path.join(root, 'file.go'), 'package fixture\nconst first = 2\n')
  }
  function settlePolicies() { for (const release of delayed.splice(0)) release() }
  function arm(immediate = false) {
    armed = true
    if (immediate && options.state === 'pre-aborted') stop.abort(new Error('Registered root aborted before resource reuse'))
    if (immediate && options.state === 'exhausted') advance(60_001)
  }
  function recordResult<T>(result: T): T { lastResult = result; return result }
  function persist(result: unknown, error?: unknown) {
    if (!out) return
    const value = { schemaVersion: 1, card: 'B19', producerId: options.producerId, branchId: options.branchId, state: options.state, variant: options.variant ?? 'default',
      status: error === undefined ? 'assertions-passed' : 'assertions-failed', error: error === undefined ? null : String(error),
      evidenceKind: options.evidenceKind ?? 'real-sdk-host-authority-and-actual-node-boundaries', clock: { domainId: clock.domainId, nowMs: now },
      configSnapshotId: snapshot.snapshotId, result: result ?? lastResult, events, policy, spawns, children: readChildren(),
      clockTransitions, exhaustedAfterDispatchOf: options.exhaustAfterDispatchOf ?? null, setupCommands,
      upstreamGate: zeroSelection ?? null,
      controlBoundary: options.state === 'deadline-zero' ? 'literal-zero-SDK-budget-intake-refuses-before-consumer'
        : options.state === 'pre-aborted' ? 'registered-root-aborted-before-consumer-or-reuse-invocation'
        : options.state === 'exhausted' ? 'existing-positive-budget-expires-before-selected-target-admission' : options.state,
      observationBeforeTeardown: children.map(entry => ({ pid: entry.child.pid, closed: entry.closed })),
      scope: 'B19 branch authority/options/consumer control; no B20 process-tree, B21 containment, B25 protocol, B28 full protocol, or B29 compiled equivalence proof' }
    writeFileSync(path.join(out, 'case.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
    console.log('B19_TOOLCHAIN_BRANCH_CASE', JSON.stringify({ path: path.join(out, 'case.json'), producerId: options.producerId, branchId: options.branchId, state: options.state, status: value.status }))
  }
  async function close() {
    settlePolicies()
    stop.abort(new Error('Branch fixture teardown'))
    for (const entry of children) if (!entry.closed) entry.child.kill('SIGKILL')
    await Promise.allSettled(children.map(entry => entry.close))
    syncSpy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
  if (armed && options.state === 'pre-aborted') stop.abort(new Error('Registered root is already aborted before the consumer invocation'))
  return { root, binaryRoot, config, environment, host, hostOptions, scope, context, baseContext, zeroSelection, stop, clock, events, policy, spawns, children, clockTransitions,
    readChildren, advance, arm, settlePolicies, recordResult, persist, close, matches, id, seedGitRepository }
}

export async function observeBranchCase(fixture: BranchFixture, body: () => unknown | Promise<unknown>) {
  let result: unknown
  try {
    result = await body()
    fixture.settlePolicies()
    await Promise.resolve(); await Promise.resolve()
    fixture.persist(result)
  } catch (error) {
    fixture.persist(result, error)
    throw error
  } finally {
    await fixture.close()
  }
}
