import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

import * as mainPrompt from '@codebuff/agent-runtime/main-prompt'
import { captureRootDeadline, isExecutionDeadlineSignal } from '@codebuff/common/util/execution-context'
import { OpenbuffClient } from '../client'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { createHostExecutionServices } from '../host-execution'
import * as database from '../impl/database'
import { getTrustedSessionClientId } from '../run'
import { admitNodeLaunch, ExecutionRefusalError, prepareNodeLaunch } from '../services/execution-launch'
import { __clearJobsForTest, __registerJobForTest, startBackgroundJob } from '../tools/background-jobs'
import * as checkJobModule from '../tools/check-job'
import { authenticatedHostFixture } from './authenticated-host-fixture'
import { beginSdkCallback, createSdkCallbackFixture, sdkCallbackOptions } from './sdk-callback-fixture'

import type { ChildProcess } from 'node:child_process'
import type { AsyncDecision, Clock, ExecutionAdapterContext, LaunchEvent, PolicyInput, Refusal, Result } from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { JobEvent, JobOwner } from '@codebuff/common/util/job-registry'
import type { BackgroundJob } from '../tools/background-jobs'

const fullAccess = {
  policy: 'full-access', preferredBackend: 'portable-ts',
  required: ['exact-env'], allowBackendFallback: false,
} as const
const owner: JobOwner = {
  clientSessionId: 'settlement-control-session', rootRunId: 'settlement-control-root',
  parentRunId: 'settlement-control-root', parentAgentId: 'settlement-control-agent',
}
const foreignOwner: JobOwner = { ...owner, clientSessionId: 'foreign-session', rootRunId: 'foreign-root' }
const settlementGitArgv = [
  '--no-pager', '--no-optional-locks', '--no-lazy-fetch',
  '-c', 'core.fsmonitor=false', 'status', '--porcelain', '-uall',
] as const
type ObservedHost = ReturnType<typeof authenticatedHostFixture> & {
  calls: ReturnType<typeof processRecorder>['calls']
}
type SpawnObservedEvent = Extract<LaunchEvent, { phase: 'spawn-observed' }>
const roots: string[] = []
const hosts: ObservedHost[] = []
const jobs: BackgroundJob[] = []
const restore: Array<() => void> = []
const cleanups: Array<() => void> = []
const children: Array<{ child: ChildProcess; closed: Promise<void> }> = []
let providerRequests = 0

type PollValue = {
  jobId: string; state: string; events: JobEvent[]; nextCursor: number
  touchedPaths?: string[]; errorMessage?: string; matched?: boolean; timedOut?: boolean
}
// Validate the wire fields these controls read, retaining extra fields in the evidence.
const jobStateSchema = z.enum(['queued', 'running', 'stopping', 'completed', 'error', 'stopped', 'lost', 'cancelled'])
const pollValueSchema = z.object({
  jobId: z.string(), state: jobStateSchema, nextCursor: z.number(),
  events: z.array(z.object({
    sequence: z.number(), jobId: z.string(), timestamp: z.number(),
    payload: z.discriminatedUnion('type', [
      z.object({ type: z.literal('output'), data: z.string() }).passthrough(),
      z.object({ type: z.literal('agent_chunk'), chunkType: z.string(), data: z.unknown() }).passthrough(),
      z.object({ type: z.literal('lifecycle'), state: jobStateSchema,
        exitCode: z.number().nullable().optional(), error: z.string().optional(), result: z.unknown().optional() }).passthrough(),
      z.object({ type: z.literal('status'), message: z.string().optional() }).passthrough(),
    ]),
  }).passthrough()),
  touchedPaths: z.array(z.string()).optional(), errorMessage: z.string().optional(),
  matched: z.boolean().optional(), timedOut: z.boolean().optional(),
}).passthrough()
const notFoundValueSchema = z.object({
  jobId: z.string(), errorMessage: z.string(), events: z.undefined(),
  state: z.undefined(), nextCursor: z.undefined(),
}).passthrough()
function jsonValue(output: Awaited<ReturnType<typeof checkJobModule.checkJob>>) {
  const part = output[0]
  if (part?.type !== 'json') throw new Error('Expected a check_job JSON observation')
  return part.value
}
function parsePollValue(raw: unknown): PollValue {
  return pollValueSchema.parse(raw)
}
function value(output: Awaited<ReturnType<typeof checkJobModule.checkJob>>): PollValue {
  return parsePollValue(jsonValue(output))
}
function notFoundValue(output: Awaited<ReturnType<typeof checkJobModule.checkJob>>) {
  return notFoundValueSchema.parse(jsonValue(output))
}
function outputText(observation: PollValue): string {
  return (observation.events ?? []).map(event => event.payload.type === 'output' ? event.payload.data : '').join('')
}
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

/** Observe the actual Node child; this recorder never emits synthetic runtime events. */
function processRecorder() {
  const calls: Array<{
    command: string; argv: readonly string[]; child: ChildProcess; pid?: number
    spawnObserved: boolean; closed: boolean; exitCode?: number | null; terminationSignal?: string | null
    close: Promise<void>
  }> = []
  const launch: CodebuffSpawn = (command, argv = [], options) => {
    const child = spawn(command, [...argv], options ?? {})
    const done = deferred<void>()
    const call: typeof calls[number] = {
      command, argv: [...argv], child, pid: child.pid,
      spawnObserved: false, closed: false, close: done.promise,
    }
    calls.push(call)
    children.push({ child, closed: done.promise })
    child.once('spawn', () => { call.spawnObserved = true; call.pid = child.pid })
    child.once('close', (code, signal) => {
      call.closed = true; call.exitCode = code; call.terminationSignal = signal; done.resolve()
    })
    return child
  }
  return { calls, launch }
}

function observedHost(projectRoot: string, options: {
  clock?: Clock
  authorize?: (input: PolicyInput) => Promise<AsyncDecision>
} = {}): ObservedHost {
  const recorder = processRecorder()
  const basic = options.clock || options.authorize ? (() => {
    // Expiry and authorization scheduling are controlled inputs to a real captured host.
    const configuration = sdkCallbackOptions(projectRoot).hostConfiguration!
    const captured = loadHostConfigSnapshot({ inputs: configuration, fs: nodeConfigReadFs })
    if (captured.status !== 'complete') throw new Error(captured.cause)
    const clock = options.clock ?? { domainId: `settlement-clock:${randomUUID()}`, nowMs: () => performance.now() }
    const stop = new AbortController()
    const host = unwrap(createHostExecutionServices({
      snapshot: captured.snapshot,
      boundary: unwrap(captureRootDeadline({ clock, limit: { kind: 'unbounded' } })),
      clock, childInheritanceEnvironment: configuration.environment,
      signal: stop.signal, spawn: recorder.launch, approvalMode: 'allow-all', profile: fullAccess,
      ...(options.authorize ? { authorizeAsync: options.authorize } : {}),
    }))
    const direct = unwrap(host.directOperation())
    return { host, context: direct.executionContext, resources: direct.resources, lspResources: direct.lspResources,
      close: () => stop.abort(new Error('Settlement test host disposed')) }
  })() : authenticatedHostFixture(projectRoot, { spawn: recorder.launch })
  const result: ObservedHost = { ...basic, calls: recorder.calls }
  hosts.push(result)
  return result
}

function workspace(git = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-settlement-controls-'))
  roots.push(root)
  const projectRoot = path.join(root, 'project'), stateRoot = path.join(root, 'state')
  fs.mkdirSync(projectRoot); fs.mkdirSync(stateRoot)
  if (git) {
    const initialized = spawnSync('git', ['init', '-q'], {
      cwd: projectRoot, encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    })
    expect(initialized.error).toBeUndefined()
    expect(initialized.status).toBe(0)
  }
  return { projectRoot, stateRoot, file: (name: string) => path.join(projectRoot, name) }
}

/** Terminal adapter fixture: only the dedicated live test supplies a real running child. */
function terminalJob(fixture: ReturnType<typeof workspace>, overrides: Partial<BackgroundJob> = {}) {
  const jobId = `settlement-${randomUUID()}`
  const logFile = path.join(fixture.stateRoot, `${jobId}.log`)
  fs.writeFileSync(logFile, '')
  const job: BackgroundJob = {
    jobId, command: 'completed fixture', child: {} as ChildProcess,
    logFile, metadataFile: `${logFile}.json`, status: 'completed', exitCode: 0,
    startedAt: Date.now(), readOffset: 0, owner,
    projectRoot: fixture.projectRoot, dirtyBeforePaths: [], ...overrides,
  }
  __registerJobForTest(job)
  jobs.push(job)
  return job
}

function contextRequest(host: ObservedHost, signal?: AbortSignal): ExecutionAdapterContext {
  return unwrap(host.host.directOperation({ ...(signal ? { signal } : {}) })).executionContext
}
function gitCalls(host: ObservedHost) {
  return host.calls.filter(call => call.command === 'git')
}
function isSettlementSpawn(event: LaunchEvent): event is SpawnObservedEvent {
  return event.phase === 'spawn-observed' && event.facts.branchId === 'terminal.legacy-dirty'
}
function observedGit(host: ObservedHost) {
  const calls = gitCalls(host)
  const starts = host.host.events.filter(isSettlementSpawn)
  expect(starts).toHaveLength(calls.length)
  for (const call of calls) {
    expect(call.argv).toEqual(settlementGitArgv)
    expect(call.spawnObserved).toBe(true)
    expect(call.pid).toBeGreaterThan(0)
    expect(call.closed).toBe(true)
  }
}
function retain(name: string, host: ObservedHost, observations: unknown) {
  console.log('B19_SETTLEMENT_CONTROL', JSON.stringify({
    name, observations, launches: host.calls.map(call => ({
      command: call.command, argv: call.argv, pid: call.pid, spawnObserved: call.spawnObserved,
      closed: call.closed, exitCode: call.exitCode, terminationSignal: call.terminationSignal,
    })), execution: host.host.events,
  }))
}
async function refusal(promise: Promise<unknown>, reason: Refusal['reason']) {
  const error = await promise.then(() => undefined, rejected => rejected as unknown)
  expect(error).toBeInstanceOf(ExecutionRefusalError)
  if (!(error instanceof ExecutionRefusalError)) throw new Error('Expected an authenticated execution refusal')
  expect(error.refusal.reason).toBe(reason)
  return error.refusal
}
async function elapsedFollow<T>(operation: () => Promise<T>): Promise<T> {
  const original = Date.now
  let reads = 0
  Date.now = () => ++reads === 1 ? 1_000 : 2_001
  try { return await operation() }
  finally { Date.now = original }
}

beforeEach(() => {
  providerRequests = 0
  const forbidden = () => { providerRequests++; throw new Error('Provider/network access is forbidden in settlement controls') }
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => forbidden(), { preconnect: forbidden }))
  restore.push(() => fetchSpy.mockRestore())
})
afterEach(async () => {
  for (const job of jobs.splice(0)) {
    if (job.killEscalationTimer) clearTimeout(job.killEscalationTimer)
  }
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(children.splice(0).map(entry => entry.closed))
  for (const host of hosts.splice(0)) host.close()
  for (const undo of restore.splice(0).reverse()) undo()
  __clearJobsForTest()
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  expect(providerRequests).toBe(0)
})

describe('B19 check_job settlement execution context', () => {
  test.skipIf(process.platform === 'win32')('settlement.kill: POSIX signal delivery leaves stopping until the actual child exits', async () => {
    const f = workspace(), host = observedHost(f.projectRoot)
    const readyFile = path.join(f.stateRoot, 'ready'), finishFile = path.join(f.stateRoot, 'finish')
    fs.writeFileSync(f.file('before.txt'), 'pre-start dirt\n')
    const script = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready'); process.stdout.write('READY\\n'); setInterval(() => { if (fs.existsSync(${JSON.stringify(finishFile)})) { fs.writeFileSync(${JSON.stringify(f.file('from-job.txt'))}, 'job final dirt'); process.stdout.write('FINAL\\n'); process.exit(0); } }, 5);`
    const launch = unwrap(prepareNodeLaunch({ executionContext: host.context, executable: process.execPath,
      argv: ['-e', script], cwd: f.projectRoot, branchId: 'terminal.background', family: 'background-job',
      processType: 'BACKGROUND', adapterOptions: { detached: true, shell: false, stdio: 'ignore-log-log' } }))
    const admittedLaunch = unwrap(await admitNodeLaunch(launch, host.context.signal))
    const job = startBackgroundJob({ command: 'owned settlement child', admittedLaunch,
      executionContext: host.context, owner, projectRoot: f.projectRoot, dirtyBeforePaths: ['before.txt'] })
    jobs.push(job)
    cleanups.push(() => {
      for (const file of [job.logFile, job.metadataFile]) fs.rmSync(file, { force: true })
    })
    const ready = value(await checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: host.context,
      signal: host.context.signal, wait_for: 'READY', timeout_seconds: 2 }))
    expect(ready.matched).toBe(true)
    expect(fs.existsSync(readyFile)).toBe(true)
    expect(job.nodeLaunch?.observation().ok).toBe(true)
    const stopping = value(await elapsedFollow(() => checkJobModule.checkJob({ jobId: job.jobId, owner,
      executionContext: host.context, signal: host.context.signal, timeout_seconds: 1, kill_on_timeout: true })))
    expect(stopping.state).toBe('stopping')
    expect(stopping.timedOut).toBe(true)
    expect(stopping.touchedPaths).toBeUndefined()
    expect(job.settlementTouchedPaths).toBeUndefined()
    expect(gitCalls(host)).toHaveLength(0)
    expect(() => process.kill(job.child.pid!, 0)).not.toThrow()
    fs.writeFileSync(finishFile, 'finish')
    await host.calls.find(call => call.child === job.child)!.close
    expect(job.status).toBe('stopped')
    const settled = value(await checkJobModule.checkJob({ jobId: job.jobId, owner,
      executionContext: contextRequest(host) }))
    expect(settled.state).toBe('stopped')
    expect(settled.touchedPaths).toEqual(['from-job.txt'])
    expect(outputText(settled)).toContain('FINAL\n')
    fs.writeFileSync(f.file('post-settle.txt'), 'later foreign dirt')
    const later = value(await checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: contextRequest(host) }))
    expect(later.touchedPaths).toBeUndefined()
    expect(gitCalls(host)).toHaveLength(1)
    observedGit(host)
    retain('stopping-then-real-exit', host, { stopping, settled, later })
  }, 20_000)

  test('settlement.kill: failed signal delivery leaves running without attributing dirt', async () => {
    const f = workspace(), host = observedHost(f.projectRoot)
    const recorder = processRecorder()
    const child = recorder.launch(process.execPath, ['-e', 'process.exit(0)'])
    await recorder.calls[0].close
    // The real child is dead; this intentionally stale running registry row exercises failed delivery.
    const job = terminalJob(f, { status: 'running', exitCode: null, child })
    fs.writeFileSync(f.file('unsettled.txt'), 'dirt')
    const result = value(await elapsedFollow(() => checkJobModule.checkJob({ jobId: job.jobId, owner,
      executionContext: host.context, timeout_seconds: 1, kill_on_timeout: true })))
    expect(result.state).toBe('running')
    expect(result.touchedPaths).toBeUndefined()
    expect(job.settlementTouchedPaths).toBeUndefined()
    expect(gitCalls(host)).toHaveLength(0)
    retain('failed-signal-delivery', host, result)
  })

  test.each(['missing', 'cancelled', 'expired'] as const)('settlement.refusal: %s current authority preserves final output and cursor for a fresh retry', async kind => {
    const f = workspace(), fresh = observedHost(f.projectRoot)
    const job = terminalJob(f)
    fs.writeFileSync(f.file('from-job.txt'), 'job dirt')
    fs.appendFileSync(job.logFile, 'FINAL OUTPUT\n')
    let context: ExecutionAdapterContext | undefined
    let refusedHost: ObservedHost | undefined
    if (kind === 'cancelled') {
      refusedHost = observedHost(f.projectRoot)
      context = refusedHost.context
      refusedHost.close()
    } else if (kind === 'expired') {
      let now = 100
      refusedHost = observedHost(f.projectRoot, { clock: { domainId: `expiry:${randomUUID()}`, nowMs: () => now } })
      context = unwrap(refusedHost.host.directOperation({ limit: { kind: 'finite', durationMs: 50 } })).executionContext
      now = 150
    }
    const denied = await refusal(checkJobModule.checkJob({ jobId: job.jobId, owner,
      ...(context ? { executionContext: context, signal: context.signal } : {}) }),
    kind === 'missing' ? 'unavailable' : kind === 'expired' ? 'deadline-exhausted' : 'cancelled')
    expect(job.lastCheckCursor).toBeUndefined()
    expect(job.settlementTouchedPaths).toBeUndefined()
    expect(gitCalls(fresh)).toHaveLength(0)
    if (refusedHost) expect(gitCalls(refusedHost)).toHaveLength(0)
    const first = value(await checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: fresh.context }))
    expect(outputText(first)).toBe('FINAL OUTPUT\n')
    expect(first.touchedPaths).toEqual(['from-job.txt'])
    expect(job.lastCheckCursor).toBe(first.nextCursor)
    expect(job.settlementTouchedPaths).toEqual(first.touchedPaths)
    const explicitReplay = value(await checkJobModule.checkJob({ jobId: job.jobId, owner, cursor: 0 }))
    expect(outputText(explicitReplay)).toBe('FINAL OUTPUT\n')
    expect(job.lastCheckCursor).toBe(first.nextCursor)
    const second = value(await checkJobModule.checkJob({ jobId: job.jobId, owner }))
    expect(outputText(second)).toBe('')
    expect(second.touchedPaths).toBeUndefined()
    expect(gitCalls(fresh)).toHaveLength(1)
    observedGit(fresh)
    retain(`${kind}-authority-retry`, fresh, { denied, first, explicitReplay, second })
  })

  test('settlement.authority: an expired job-stored context never substitutes for the current request', async () => {
    const f = workspace(), current = observedHost(f.projectRoot)
    let now = 100
    const prior = observedHost(f.projectRoot, { clock: { domainId: `old-job:${randomUUID()}`, nowMs: () => now } })
    const oldContext = unwrap(prior.host.directOperation({ limit: { kind: 'finite', durationMs: 50 } })).executionContext
    now = 150
    const job = terminalJob(f, { executionContext: oldContext })
    fs.writeFileSync(f.file('from-job.txt'), 'dirt')
    const denied = await refusal(checkJobModule.checkJob({ jobId: job.jobId, owner }), 'unavailable')
    expect(gitCalls(prior)).toHaveLength(0)
    expect(gitCalls(current)).toHaveLength(0)
    expect(job.settlementTouchedPaths).toBeUndefined()
    const result = value(await checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: current.context }))
    expect(result.touchedPaths).toEqual(['from-job.txt'])
    expect(gitCalls(prior)).toHaveLength(0)
    expect(gitCalls(current)).toHaveLength(1)
    observedGit(current)
    retain('expired-stored-job-context', current, { denied, result })
  })

  test('settlement.ownership: a foreign owner gets generic not-found with zero Git dispatch and no cursor change', async () => {
    const f = workspace(), host = observedHost(f.projectRoot), job = terminalJob(f)
    fs.appendFileSync(job.logFile, 'PRIVATE FINAL OUTPUT\n')
    const denied = notFoundValue(await checkJobModule.checkJob({ jobId: job.jobId, owner: foreignOwner, executionContext: host.context }))
    expect(denied.errorMessage).toBe(`No background job found with id "${job.jobId}".`)
    expect(denied.events).toBeUndefined()
    expect(job.lastCheckCursor).toBeUndefined()
    expect(job.settlementTouchedPaths).toBeUndefined()
    expect(gitCalls(host)).toHaveLength(0)
    retain('foreign-owner', host, denied)
  })

  test('settlement.soft-fail: an authenticated non-repository locks an empty attribution once', async () => {
    const f = workspace(false), host = observedHost(f.projectRoot), job = terminalJob(f)
    fs.writeFileSync(f.file('before-init.txt'), 'ordinary directory')
    const first = value(await checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: host.context }))
    expect(first.touchedPaths).toBeUndefined()
    expect(job.settlementTouchedPaths).toEqual([])
    expect(gitCalls(host)).toHaveLength(1)
    expect(gitCalls(host)[0].exitCode).not.toBe(0)
    expect(spawnSync('git', ['init', '-q'], { cwd: f.projectRoot }).status).toBe(0)
    fs.writeFileSync(f.file('post-settle.txt'), 'later dirt')
    const second = value(await checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: contextRequest(host) }))
    expect(second.touchedPaths).toBeUndefined()
    expect(gitCalls(host)).toHaveLength(1)
    observedGit(host)
    retain('ordinary-git-failure', host, { first, second })
  })

  test('settlement.soft-fail: absent snapshots lock an empty marker without execution authority', async () => {
    const f = workspace(), job = terminalJob(f, { dirtyBeforePaths: undefined })
    fs.appendFileSync(job.logFile, 'RECOVERED FINAL\n')
    const first = value(await checkJobModule.checkJob({ jobId: job.jobId, owner }))
    expect(outputText(first)).toBe('RECOVERED FINAL\n')
    expect(first.touchedPaths).toBeUndefined()
    expect(job.settlementTouchedPaths).toEqual([])
    expect(value(await checkJobModule.checkJob({ jobId: job.jobId, owner })).touchedPaths).toBeUndefined()
  })

  test('settlement.concurrent: two first observers dispatch Git once and retain the furthest successful cursor', async () => {
    const f = workspace(), entered = deferred<void>(), release = deferred<void>()
    let policies = 0
    const host = observedHost(f.projectRoot, { authorize: async () => {
      policies++; entered.resolve(); await release.promise
      return { ok: true, basis: 'explicit-policy', decisionId: randomUUID() }
    } })
    const job = terminalJob(f)
    fs.writeFileSync(f.file('from-job.txt'), 'dirt')
    fs.appendFileSync(job.logFile, 'FIRST\n')
    const first = checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: host.context })
    await entered.promise
    fs.appendFileSync(job.logFile, 'SECOND\n')
    const second = checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: contextRequest(host) })
    release.resolve()
    const observations = (await Promise.all([first, second])).map(value)
    expect(policies).toBe(1)
    expect(gitCalls(host)).toHaveLength(1)
    expect(observations.filter(result => result.touchedPaths !== undefined)).toHaveLength(1)
    expect(observations.find(result => result.touchedPaths)?.touchedPaths).toEqual(['from-job.txt'])
    expect(job.lastCheckCursor).toBe(Math.max(...observations.map(result => result.nextCursor)))
    expect(observations.some(result => outputText(result).includes('SECOND\n'))).toBe(true)
    observedGit(host)
    retain('concurrent-first-observers', host, observations)
  })

  test('settlement.concurrent: a refused first observer releases the slot for a fresh waiting request', async () => {
    const f = workspace(), entered = deferred<void>(), release = deferred<void>()
    let policies = 0
    const host = observedHost(f.projectRoot, { authorize: async () => {
      if (++policies === 1) {
        entered.resolve(); await release.promise
        return { ok: false, reason: 'denied', cause: 'First request deliberately refused' }
      }
      return { ok: true, basis: 'explicit-policy', decisionId: randomUUID() }
    } })
    const job = terminalJob(f)
    fs.writeFileSync(f.file('from-job.txt'), 'dirt')
    fs.appendFileSync(job.logFile, 'RETRY OUTPUT\n')
    const first = refusal(checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: host.context }), 'denied')
    await entered.promise
    const second = checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: contextRequest(host) })
    release.resolve()
    const [denied, output] = await Promise.all([first, second])
    const result = value(output)
    expect(outputText(result)).toBe('RETRY OUTPUT\n')
    expect(result.touchedPaths).toEqual(['from-job.txt'])
    expect(job.lastCheckCursor).toBe(result.nextCursor)
    expect(policies).toBe(2)
    expect(gitCalls(host)).toHaveLength(1)
    expect(host.host.events.filter(event => event.phase === 'no-launch')).toHaveLength(1)
    observedGit(host)
    retain('concurrent-refusal-then-fresh-request', host, { denied, result })
  })

  test('settlement.concurrent: a cancelled waiting request preserves its explicit cursor and returns before the first observer', async () => {
    const f = workspace(), entered = deferred<void>(), release = deferred<void>()
    const host = observedHost(f.projectRoot, { authorize: async () => {
      entered.resolve(); await release.promise
      return { ok: true, basis: 'explicit-policy', decisionId: randomUUID() }
    } })
    const job = terminalJob(f)
    fs.writeFileSync(f.file('from-job.txt'), 'dirt')
    fs.appendFileSync(job.logFile, 'FINAL\n')
    const first = checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: host.context })
    await entered.promise
    const cancelled = new AbortController()
    const secondContext = contextRequest(host, cancelled.signal)
    const second = refusal(checkJobModule.checkJob({ jobId: job.jobId, owner, cursor: 0,
      executionContext: secondContext, signal: secondContext.signal }), 'cancelled')
    cancelled.abort(new Error('Cancel only the waiting observation'))
    let denied: Awaited<ReturnType<typeof refusal>>
    try {
      denied = await second
      expect(gitCalls(host)).toHaveLength(0)
      expect(job.lastCheckCursor).toBeUndefined()
      expect(job.settlementTouchedPaths).toBeUndefined()
    } finally { release.resolve() }
    const result = value(await first)
    expect(result.touchedPaths).toEqual(['from-job.txt'])
    expect(gitCalls(host)).toHaveLength(1)
    observedGit(host)
    retain('cancelled-waiting-observer', host, { denied, result })
  })

  test('settlement.concurrent: an independent caller cancels its waiter without cancelling the active execution context or resolving observer', async () => {
    const f = workspace(), entered = deferred<void>(), release = deferred<void>()
    const host = observedHost(f.projectRoot, { authorize: async () => {
      entered.resolve(); await release.promise
      return { ok: true, basis: 'explicit-policy', decisionId: randomUUID() }
    } })
    const job = terminalJob(f)
    fs.writeFileSync(f.file('from-job.txt'), 'dirt')
    fs.appendFileSync(job.logFile, 'FINAL\n')
    let resolvingObserverFinished = false
    const first = checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: host.context })
      .finally(() => { resolvingObserverFinished = true })
    await entered.promise
    const caller = new AbortController()
    const secondContext = contextRequest(host)
    expect(secondContext.signal?.aborted).toBe(false)
    expect(secondContext.signal).not.toBe(caller.signal)
    const second = refusal(checkJobModule.checkJob({ jobId: job.jobId, owner,
      executionContext: secondContext, signal: caller.signal }), 'cancelled')
    caller.abort(new Error('Independent caller stopped only its observation'))
    let denied: Awaited<ReturnType<typeof refusal>>
    try {
      denied = await second
      expect(resolvingObserverFinished).toBe(false)
      expect(secondContext.signal?.aborted).toBe(false)
      expect(host.context.signal?.aborted).toBe(false)
      expect(host.host.rootSignal.aborted).toBe(false)
      expect(gitCalls(host)).toHaveLength(0)
      expect(job.lastCheckCursor).toBeUndefined()
      expect(job.settlementTouchedPaths).toBeUndefined()
    } finally { release.resolve() }
    const result = value(await first)
    expect(resolvingObserverFinished).toBe(true)
    expect(result.touchedPaths).toEqual(['from-job.txt'])
    expect(outputText(result)).toBe('FINAL\n')
    expect(job.lastCheckCursor).toBe(result.nextCursor)
    const later = value(await checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: contextRequest(host) }))
    expect(later.touchedPaths).toBeUndefined()
    expect(gitCalls(host)).toHaveLength(1)
    observedGit(host)
    retain('independent-caller-cancelled-waiter', host, { denied, result, later })
  })

  test('settlement.concurrent: a registered request deadline expires its waiter while an independent caller and resolving observer remain active', async () => {
    const f = workspace(), entered = deferred<void>(), release = deferred<void>()
    const host = observedHost(f.projectRoot, { authorize: async () => {
      entered.resolve(); await release.promise
      return { ok: true, basis: 'explicit-policy', decisionId: randomUUID() }
    } })
    const job = terminalJob(f)
    fs.writeFileSync(f.file('from-job.txt'), 'dirt')
    fs.appendFileSync(job.logFile, 'FINAL\n')
    let resolvingObserverFinished = false
    const first = checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: host.context })
      .finally(() => { resolvingObserverFinished = true })
    await entered.promise
    const caller = new AbortController()
    // The captured host's real scheduler owns this registered request's cancellation reason.
    const secondContext = unwrap(host.host.directOperation({ limit: { kind: 'finite', durationMs: 25 } })).executionContext
    expect(secondContext.signal?.aborted).toBe(false)
    expect(secondContext.signal).not.toBe(caller.signal)
    const second = refusal(checkJobModule.checkJob({ jobId: job.jobId, owner,
      executionContext: secondContext, signal: caller.signal }), 'deadline-exhausted')
    let denied: Awaited<ReturnType<typeof refusal>>
    try {
      denied = await second
      expect(resolvingObserverFinished).toBe(false)
      expect(secondContext.signal?.aborted).toBe(true)
      expect(isExecutionDeadlineSignal(secondContext.signal!)).toBe(true)
      expect(caller.signal.aborted).toBe(false)
      expect(host.context.signal?.aborted).toBe(false)
      expect(host.host.rootSignal.aborted).toBe(false)
      expect(gitCalls(host)).toHaveLength(0)
      expect(job.lastCheckCursor).toBeUndefined()
      expect(job.settlementTouchedPaths).toBeUndefined()
    } finally { release.resolve() }
    const result = value(await first)
    expect(resolvingObserverFinished).toBe(true)
    expect(result.touchedPaths).toEqual(['from-job.txt'])
    expect(outputText(result)).toBe('FINAL\n')
    expect(job.lastCheckCursor).toBe(result.nextCursor)
    const later = value(await checkJobModule.checkJob({ jobId: job.jobId, owner, executionContext: contextRequest(host) }))
    expect(later.touchedPaths).toBeUndefined()
    expect(gitCalls(host)).toHaveLength(1)
    observedGit(host)
    retain('registered-deadline-waiter', host, { denied, result, later })
  })

  test('settlement.sdk: actual SDK callbacks pin the current owner, signal and execution context over tool input', async () => {
    const f = createSdkCallbackFixture('settlement-pinning')
    cleanups.push(f.close)
    expect(spawnSync('git', ['init', '-q'], { cwd: f.cwd }).status).toBe(0)
    const stateRoot = path.dirname(f.harnessStateDir)
    const prior = observedHost(f.cwd)
    prior.close()
    const fakeSignal = new AbortController()
    fakeSignal.abort(new Error('Model-supplied cancelled signal'))
    const recorder = processRecorder()
    const execution: LaunchEvent[] = []
    const seen: Array<Parameters<typeof checkJobModule.checkJob>[0]> = []
    const outputs: PollValue[] = []
    const actualCheckJob = checkJobModule.checkJob
    const jobSpy = spyOn(checkJobModule, 'checkJob').mockImplementation(params => {
      seen.push(params); return actualCheckJob(params)
    })
    restore.push(() => jobSpy.mockRestore())
    const userSpy = spyOn(database, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'fixture-user', email: 'fixture@example.invalid', discord_id: null, stripe_customer_id: null,
      banned: false, created_at: new Date('2024-01-01T00:00:00Z'),
    })
    const agentSpy = spyOn(database, 'fetchAgentFromDatabase').mockResolvedValue(null)
    const startSpy = spyOn(database, 'startAgentRun').mockImplementation(async () => randomUUID())
    const finishSpy = spyOn(database, 'finishAgentRun').mockResolvedValue(undefined)
    const stepSpy = spyOn(database, 'addAgentStep').mockImplementation(async () => randomUUID())
    for (const current of [userSpy, agentSpy, startSpy, finishSpy, stepSpy]) restore.push(() => current.mockRestore())
    const promptSpy = spyOn(mainPrompt, 'callMainPrompt').mockImplementation(async params => {
      const callback = await beginSdkCallback(params)
      const registeredOwner: JobOwner = { clientSessionId: getTrustedSessionClientId(), rootRunId: callback.runId,
        parentRunId: callback.runId, parentAgentId: callback.agentId }
      const job = terminalJob({ projectRoot: f.cwd, stateRoot, file: f.file }, { owner: registeredOwner, executionContext: prior.context })
      fs.appendFileSync(job.logFile, 'SDK FINAL\n')
      fs.writeFileSync(f.file('from-job.txt'), 'SDK dirty observation')
      const handled = await callback.request({ toolName: 'check_job', input: {
        jobId: job.jobId, owner: foreignOwner, signal: fakeSignal.signal, executionContext: prior.context,
      } })
      const part = handled.output[0]
      if (part?.type !== 'json') throw new Error('SDK check_job response must be JSON')
      outputs.push(parsePollValue(part.value))
      const result = { sessionState: callback.sessionState, output: { type: 'lastMessage' as const, value: [] } }
      await params.sendAction({ action: { type: 'prompt-response', promptId: params.promptId, ...result } })
      return result
    })
    restore.push(() => promptSpy.mockRestore())
    const result = await new OpenbuffClient({ ...f.options, spawnSource: recorder.launch, recordExecution: event => execution.push(event),
      approvalMode: 'allow-all', executionProfile: fullAccess }).run({ agent: 'base2', prompt: 'settlement pinning control' })
    expect(result.output.type).toBe('lastMessage')
    expect(seen).toHaveLength(1)
    const request = seen[0]
    if (!request) throw new Error('SDK settlement did not capture its current request')
    const currentContext = request.executionContext
    if (!currentContext) throw new Error('SDK settlement did not supply its current execution context')
    const currentSignal = currentContext.signal
    if (!currentSignal || !request.signal) throw new Error('SDK settlement did not supply its current signal')
    const actualRunId = result.sessionState?.mainAgentState.runId
    if (typeof actualRunId !== 'string' || actualRunId.length === 0) throw new Error('SDK settlement did not retain its actual registered run id')
    expect(request.owner.clientSessionId).toBe(getTrustedSessionClientId())
    expect(request.owner.rootRunId).toBe(actualRunId)
    expect(currentContext).toBeDefined()
    expect(currentContext).not.toBe(prior.context)
    expect(currentContext.projectRoot).toBe(f.cwd)
    expect(request.signal).toBe(currentSignal)
    expect(request.signal).not.toBe(fakeSignal.signal)
    expect(request.owner).not.toEqual(foreignOwner)
    const output = outputs[0]
    if (!output) throw new Error('SDK settlement did not return its poll observation')
    expect(outputText(output)).toBe('SDK FINAL\n')
    expect(output.touchedPaths).toContain('from-job.txt')
    const actualGit = recorder.calls.filter(call => call.command === 'git' && JSON.stringify(call.argv) === JSON.stringify(settlementGitArgv))
    expect(actualGit).toHaveLength(1)
    expect(actualGit[0].spawnObserved).toBe(true)
    expect(actualGit[0].pid).toBeGreaterThan(0)
    expect(actualGit[0].closed).toBe(true)
    const settlementStarts = execution.filter(isSettlementSpawn)
    expect(settlementStarts).toHaveLength(1)
    const settlementStart = settlementStarts[0]
    if (!settlementStart) throw new Error('SDK settlement did not observe its Git process start')
    const correlation = settlementStart.facts.correlation
    expect(correlation.kind).toBe('action')
    if (correlation.kind !== 'action') throw new Error('SDK settlement must retain its actual registered action identity')
    expect(correlation.owner).toEqual(request.owner)
    expect(prior.calls).toHaveLength(0)
    console.log('B19_SETTLEMENT_SDK_PINNING', JSON.stringify({ observations: outputs,
      trustedOwner: request.owner, currentRoot: currentContext.projectRoot,
      launches: recorder.calls.map(call => ({ command: call.command, argv: call.argv, pid: call.pid,
        spawnObserved: call.spawnObserved, closed: call.closed, exitCode: call.exitCode })), execution, providerRequests }))
  }, 20_000)
})
