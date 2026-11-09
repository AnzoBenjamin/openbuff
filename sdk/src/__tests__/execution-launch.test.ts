import { once, EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, mock, test } from 'bun:test'

import {
  admitNodeLaunch,
  captureNodeTarget,
  deriveExecutionContext,
  dispatchNodeLaunch,
  executionLimitMs,
  executionLimitSeconds,
  executionRefusal,
  prepareNodeLaunch,
  trustedNodeSpawn,
} from '../services/execution-launch'
import { createTerminalExecutionFixture, executionValue } from './fixtures/b19-terminal-execution'

import type { ChildProcess } from 'node:child_process'
import type {
  AsyncDecision, Clock, ExecutionAdapterContext, ExactLaunchInput, Scheduler,
} from '../../../common/src/types/contracts/execution-context'

const fixtures: ReturnType<typeof createTerminalExecutionFixture>[] = []
function fixture(options: Parameters<typeof createTerminalExecutionFixture>[0] = {}) {
  const result = createTerminalExecutionFixture(options)
  fixtures.push(result)
  return result
}
afterEach(() => { for (const current of fixtures.splice(0)) current.dispose() })

function controlledClock() {
  let now = 100
  let nextId = 0
  const tasks = new Map<number, { at: number; callback: () => void }>()
  const clock: Clock = { domainId: 'terminal-controlled-clock', nowMs: () => now }
  const scheduler: Scheduler = {
    set(delay, callback) { tasks.set(++nextId, { at: now + delay, callback }); return nextId },
    clear(timer) { tasks.delete(timer as number) },
  }
  function advance(ms: number) {
    now += ms
    for (;;) {
      const due = [...tasks].find(([, task]) => task.at <= now)
      if (!due) return
      tasks.delete(due[0])
      due[1].callback()
    }
  }
  return { clock, scheduler, advance }
}

function fakeChild(pid: number | undefined = 42_424_001) {
  const events = new EventEmitter()
  const kills: string[] = []
  const child = Object.assign(events, {
    pid,
    kill(signal = 'SIGTERM') { kills.push(signal); return true },
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  }) as unknown as ChildProcess
  return { child, events, kills }
}

function target(executionContext?: ExecutionAdapterContext) {
  return {
    executionContext,
    executable: '/usr/bin/node', argv: ['--version'], cwd: process.cwd(),
    branchId: 'terminal.sync',
    adapterOptions: { stdio: 'pipe', detached: false, shell: false },
  }
}

describe('Node launch admission', () => {
  test('missing and fabricated mediation provide no launch', () => {
    expect(prepareNodeLaunch(target())).toMatchObject({ ok: false, reason: 'unavailable' })
    const h = fixture()
    const copied = { ...h.context, execution: { ...h.context.execution } }
    expect(prepareNodeLaunch(target(copied))).toMatchObject({ ok: false, reason: 'stale-authority' })
    expect(h.events.some(event => event.phase === 'dispatched')).toBe(false)
  })

  test.each(['denied', 'unavailable'] as const)('%s decisions never invoke spawn', async reason => {
    const h = fixture({ authorize: () => executionRefusal(reason, `fixture ${reason}`) })
    const launch = executionValue(prepareNodeLaunch(target(h.context)))
    const createChild = mock(() => fakeChild().child)
    const admitted = await admitNodeLaunch(launch, h.context.signal)
    if (admitted.ok) dispatchNodeLaunch(admitted.value, createChild)
    expect(admitted).toMatchObject({ ok: false, reason })
    expect(createChild).not.toHaveBeenCalled()
    expect(h.events.some(event => event.phase === 'spawn-observed')).toBe(false)
  })

  test('an unavailable requested backend refuses admission before policy or dispatch', async () => {
    const h = fixture({ resolveProfile: requested => ({
      requested, available: [], selected: null, active: null, enforced: [],
    }) })
    const launch = executionValue(prepareNodeLaunch(target(h.context)))
    expect(await admitNodeLaunch(launch, h.context.signal)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(h.policyInputs).toHaveLength(0)
  })

  test('an already aborted request never prepares a launch', () => {
    const abort = new AbortController()
    const h = fixture({ signal: abort.signal })
    abort.abort(new Error('fixture cancellation'))
    expect(prepareNodeLaunch(target(h.context))).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(h.events).toHaveLength(0)
  })

  test('a derived deadline reaches wait cancellation and cannot be restarted', () => {
    const manual = controlledClock()
    const h = fixture({ ...manual })
    const first = executionValue(deriveExecutionContext(h.context, 'local-cap', { kind: 'finite', durationMs: 40 }))
    expect(first.signal).toBe(first.execution.signal)
    expect(first.signal).not.toBe(h.context.signal)
    manual.advance(20)
    const repeated = executionValue(deriveExecutionContext(h.context, 'local-cap', { kind: 'finite', durationMs: 400 }))
    manual.advance(20)
    expect(first.signal?.aborted).toBe(true)
    expect(repeated.signal?.aborted).toBe(true)
    expect(prepareNodeLaunch(target(repeated))).toMatchObject({ ok: false, reason: 'deadline-exhausted' })
  })

  test('exhaustion between admission and dispatch invokes no child callback', async () => {
    const manual = controlledClock()
    const h = fixture({ ...manual, actionLimit: { kind: 'finite', durationMs: 40 } })
    const launch = executionValue(prepareNodeLaunch(target(h.context)))
    const admitted = executionValue(await admitNodeLaunch(launch, h.context.signal))
    manual.advance(40)
    const createChild = mock(() => fakeChild().child)
    expect(dispatchNodeLaunch(admitted, createChild)).toMatchObject({ ok: false, reason: 'deadline-exhausted' })
    expect(createChild).not.toHaveBeenCalled()
  })

  test('deferred policy sees immutable argv/env and dispatch receives the remaining cap', async () => {
    const manual = controlledClock()
    let resolvePolicy!: (decision: AsyncDecision) => void
    const policy = new Promise<AsyncDecision>(resolve => { resolvePolicy = resolve })
    const h = fixture({ ...manual, actionLimit: { kind: 'finite', durationMs: 100 }, authorize: () => policy })
    const argv = ['-e', 'process.exit(0)']
    const overlay = { PROJECT_VALUE: 'before-wait', OPENAI_API_KEY: 'fixture-reinsert-attempt' }
    const launch = executionValue(prepareNodeLaunch({ ...target(h.context), argv, environmentOverlay: overlay }))
    const pending = admitNodeLaunch(launch, h.context.signal)
    argv.push('late-argument')
    overlay.PROJECT_VALUE = 'late-value'
    h.environment.PROJECT_VALUE = 'late-inheritance'
    manual.advance(70)
    resolvePolicy({ ok: true, basis: 'explicit-policy', decisionId: 'controlled-allow' })
    const admitted = executionValue(await pending)
    const fake = fakeChild()
    let actual: ExactLaunchInput | undefined
    const node = executionValue(dispatchNodeLaunch(admitted, input => { actual = input; return fake.child }))
    expect(actual?.argv).toEqual(['-e', 'process.exit(0)'])
    expect(actual?.env.PROJECT_VALUE).toBe('before-wait')
    expect(actual?.env.OPENAI_API_KEY).toBeUndefined()
    expect(actual?.resourceRemainingMs).toBe(30)
    expect(h.policyInputs[0].target.argv).toEqual(actual!.argv)
    expect(Object.isFrozen(h.policyInputs[0].classification.effects)).toBe(true)
    fake.events.emit('spawn')
    expect(await node.started).toMatchObject({ ok: true })
    fake.events.emit('close', 0)
  })

  test('cancellation during deferred approval wins without a spawn', async () => {
    const abort = new AbortController()
    let resolvePolicy!: (decision: AsyncDecision) => void
    const h = fixture({ signal: abort.signal, authorize: () => new Promise(resolve => { resolvePolicy = resolve }) })
    const launch = executionValue(prepareNodeLaunch(target(h.context)))
    const pending = admitNodeLaunch(launch, h.context.signal)
    abort.abort(new Error('cancelled in controlled policy'))
    resolvePolicy({ ok: true, basis: 'explicit-policy', decisionId: 'late-allow' })
    expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(h.events.some(event => event.phase === 'dispatched')).toBe(false)
  })

  test('one admitted permit dispatches only once', async () => {
    const h = fixture()
    const launch = executionValue(prepareNodeLaunch(target(h.context)))
    const admitted = executionValue(await admitNodeLaunch(launch, h.context.signal))
    const fake = fakeChild()
    const createChild = mock(() => fake.child)
    executionValue(dispatchNodeLaunch(admitted, createChild))
    expect(dispatchNodeLaunch(admitted, createChild)).toMatchObject({ ok: false, reason: 'already-consumed' })
    expect(createChild).toHaveBeenCalledTimes(1)
    fake.events.emit('close', 0)
  })
})

describe('Node process observations and lifetime', () => {
  test('cancellation inside the spawn seam settles even when termination synchronously closes', async () => {
    const abort = new AbortController()
    const h = fixture({ signal: abort.signal })
    const launch = executionValue(prepareNodeLaunch(target(h.context)))
    const admitted = executionValue(await admitNodeLaunch(launch, h.context.signal))
    const fake = fakeChild()
    fake.child.kill = (() => { fake.events.emit('close', 0); return true }) as ChildProcess['kill']
    const node = executionValue(dispatchNodeLaunch(admitted, () => {
      abort.abort(new Error('cancelled inside spawn'))
      return fake.child
    }))
    expect(await node.started).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(node.facts().profile.active).toBeNull()
  })
  test.each(['close', 'error'] as const)('%s alone certifies no start', async kind => {
    const h = fixture()
    const launch = executionValue(prepareNodeLaunch(target(h.context)))
    const admitted = executionValue(await admitNodeLaunch(launch, h.context.signal))
    const fake = fakeChild()
    const node = executionValue(dispatchNodeLaunch(admitted, () => fake.child))
    if (kind === 'close') fake.events.emit('close', 0)
    else fake.events.emit('error', new Error('fixture spawn failure'))
    expect(await node.started).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(node.facts().profile.active).toBeNull()
    expect(h.events.some(event => event.phase === 'spawn-observed')).toBe(false)
    if (kind === 'error') fake.events.emit('close', -1)
  })

  test.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('a spawn event with invalid PID %s refuses', async pid => {
    const h = fixture()
    const launch = executionValue(prepareNodeLaunch(target(h.context)))
    const admitted = executionValue(await admitNodeLaunch(launch, h.context.signal))
    const fake = fakeChild(pid)
    if (pid === undefined) Object.defineProperty(fake.child, 'pid', { value: undefined })
    const node = executionValue(dispatchNodeLaunch(admitted, () => fake.child))
    fake.events.emit('spawn')
    expect(await node.started).toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(node.facts().profile.active).toBeNull()
    fake.events.emit('close', 0)
  })

  test('physical escalation survives synchronous native AbortError settlement until close', async () => {
    const abort = new AbortController()
    const h = fixture({ signal: abort.signal })
    const launch = executionValue(prepareNodeLaunch(target(h.context)))
    const admitted = executionValue(await admitNodeLaunch(launch, h.context.signal))
    const fake = fakeChild()
    const node = executionValue(dispatchNodeLaunch(admitted, input => {
      input.resourceSignal.addEventListener('abort', () => {
        fake.events.emit('error', Object.assign(new Error('native abort'), { name: 'AbortError', code: 'ABORT_ERR' }))
      }, { once: true })
      return fake.child
    }, { sigtermGraceMs: 15 }))
    fake.events.emit('spawn')
    expect(await node.started).toMatchObject({ ok: true })
    abort.abort(new Error('request cancelled'))
    expect(fake.kills[0]).toBe('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 35))
    expect(fake.kills).toContain('SIGKILL')
    expect(node.resourceRefusal()).toMatchObject({ reason: 'cancelled' })
    fake.events.emit('close', null)
  })

  test('a real child receives the captured scrubbed environment and an observed positive PID', async () => {
    const h = fixture()
    const recorded = path.join(process.env.B19_TERMINAL_EVIDENCE_DIR ?? h.home, `node-env-${randomUUID()}.json`)
    const launch = executionValue(prepareNodeLaunch({
      ...target(h.context),
      argv: [path.join(import.meta.dir, 'fixtures/b19-node-env-recorder.cjs'), recorded],
    }))
    const admitted = executionValue(await admitNodeLaunch(launch, h.context.signal))
    const node = executionValue(dispatchNodeLaunch(admitted, input => trustedNodeSpawn(h.context)(
      input.executable, input.argv, { cwd: input.cwd, env: input.env, signal: input.resourceSignal, stdio: 'pipe' },
    )))
    const closed = once(node.child, 'close')
    const observed = executionValue(await node.started)
    expect(observed.pid).toBeGreaterThan(0)
    expect((await closed)[0]).toBe(0)
    expect(JSON.parse(readFileSync(recorded, 'utf8'))).toEqual({ value: 'captured-value', home: h.home, xdg: h.xdg })
    expect(node.facts().profile.active?.backend).toBe('portable-ts')
    expect(h.events.filter(event => event.phase === 'spawn-observed')).toHaveLength(1)
    expect(JSON.stringify(h.events)).not.toContain('fixture-canonical-sentinel')
  })

  test('a real printf child streams stdout through the Node adapter', async () => {
    const h = fixture()
    const launch = executionValue(prepareNodeLaunch({ ...target(h.context), executable: '/usr/bin/printf', argv: ['output-sentinel'] }))
    const admitted = executionValue(await admitNodeLaunch(launch, h.context.signal))
    const node = executionValue(dispatchNodeLaunch(admitted, input => trustedNodeSpawn(h.context)(
      input.executable, input.argv, { cwd: input.cwd, env: input.env, signal: input.resourceSignal, stdio: 'pipe' },
    )))
    let stdout = ''
    node.child.stdout!.on('data', chunk => { stdout += chunk.toString() })
    const closed = once(node.child, 'close')
    expect(executionValue(await node.started).pid).toBeGreaterThan(0)
    expect((await closed)[0]).toBe(0)
    expect(stdout).toBe('output-sentinel')
  })
})

describe('captured Node target and limits', () => {
  test('copies policy-relevant target data before any wait and fixes the runtime tag', () => {
    const h = fixture()
    const argv = ['--version']
    const options = { runtime: 'caller-tag', stdio: 'pipe' }
    const captured = executionValue(captureNodeTarget({ ...target(h.context), argv, adapterOptions: options }))
    argv.push('late')
    options.stdio = 'late'
    expect(captured.argv).toEqual(['--version'])
    expect(captured.adapterOptions).toEqual({ runtime: 'node', stdio: 'pipe' })
    expect(Object.isFrozen(captured.argv)).toBe(true)
  })

  test('zero is exhausted; -1 is unbounded; fractional seconds must convert to whole milliseconds', () => {
    expect(executionLimitMs(0)).toMatchObject({ ok: false, reason: 'deadline-exhausted' })
    expect(executionLimitMs(-2)).toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(executionLimitMs(NaN)).toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(executionLimitMs(-1)).toEqual({ ok: true, value: { kind: 'unbounded' } })
    expect(executionLimitSeconds(0.05)).toEqual({ ok: true, value: { kind: 'finite', durationMs: 50 } })
    expect(executionLimitSeconds(0.0005)).toMatchObject({ ok: false, reason: 'invalid-context' })
  })
})
