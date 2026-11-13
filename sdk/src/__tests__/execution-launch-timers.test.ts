import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  admitNodeLaunch,
  dispatchNodeLaunch,
  ExecutionRefusalError,
  MAX_NODE_TIMER_DELAY_MS,
  prepareNodeLaunch,
  scheduleNodeDeadline,
} from '../services/execution-launch'
import { createDiagnosticCommandRunner } from '../services/diagnostic-delta-runner'
import { DIAGNOSTIC_COMMAND_INVOCATIONS } from '../services/diagnostic-delta'
import { getBackgroundJobAdapter, __clearJobsForTest } from '../tools/background-jobs'
import { hashIdentityFileBytes } from '../tools/get-change-review-bundle'
import { runGit, runGitBounded } from '../tools/git-status'
import { runTerminalCommand } from '../tools/run-terminal-command'
import {
  createControlledExecutionClock,
  createExecutionProcessRecorder,
  createRealExecutionProcessRecorder,
  createTerminalExecutionFixture,
  executionValue,
} from './fixtures/b19-terminal-execution'

import type { ChildProcess } from 'node:child_process'
import type { Scheduler } from '../../../common/src/types/contracts/execution-context'
import type { CodebuffSpawn } from '../../../common/src/types/spawn'

const LONG_MS = 3_000_000_000
const hosts: ReturnType<typeof createTerminalExecutionFixture>[] = []
const roots: string[] = []
const injected: ReturnType<typeof createExecutionProcessRecorder>[] = []
type CloseWatch = { closed: boolean; result: Promise<readonly [number | null, string | null]> }
const native = new Map<ChildProcess, CloseWatch>()

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function fixture(options: Parameters<typeof createTerminalExecutionFixture>[0]) {
  const host = createTerminalExecutionFixture(options)
  hosts.push(host)
  return host
}
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b19-r2-timer-'))
  roots.push(root)
  return root
}
function realRecorder() {
  const recorder = createRealExecutionProcessRecorder()
  const spawn: CodebuffSpawn = (executable, argv, options) => {
    const child = recorder.spawn(executable, argv, options)
    const watch = { closed: false } as CloseWatch
    watch.result = new Promise(resolve => child.once('close', (code, signal) => {
      watch.closed = true
      resolve([code, signal])
    }))
    native.set(child, watch)
    return child
  }
  return { ...recorder, spawn }
}
async function closeWithin(child: ChildProcess) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      native.get(child)!.result,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned timer child did not close within 1s')), 1_000) }),
    ])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
async function dispatchedSleep(durationMs: number) {
  const manual = createControlledExecutionClock()
  const abort = new AbortController()
  const processes = realRecorder()
  const host = fixture({ ...manual, signal: abort.signal, spawn: processes.spawn,
    projectRoot: scratch(), actionLimit: { kind: 'finite', durationMs } })
  const launch = executionValue(prepareNodeLaunch({
    executionContext: host.context, executable: '/usr/bin/sleep', argv: ['30'],
    cwd: host.context.projectRoot, branchId: 'terminal.sync',
    adapterOptions: { stdio: 'ignore', detached: false, shell: false },
  }))
  const admitted = executionValue(await admitNodeLaunch(launch, host.context.signal))
  const node = executionValue(dispatchNodeLaunch(admitted, input => processes.spawn(input.executable, input.argv, {
    cwd: input.cwd, env: input.env, signal: input.resourceSignal,
    stdio: 'ignore', detached: false, shell: false,
  })))
  expect(executionValue(await node.started).pid).toBeGreaterThan(0)
  return { manual, abort, processes, host, node, get kills() {
    return node.scope.currentCleanup()?.signals.filter(signal => signal.result === 'delivered').map(signal => signal.signal) ?? []
  } }
}
afterEach(async () => {
  for (const recorder of injected.splice(0)) for (const call of recorder.calls) call.finish()
  for (const host of hosts.splice(0)) host.dispose()
  for (const [child, watch] of native) {
    if (!watch.closed) child.kill('SIGKILL')
    await closeWithin(child)
  }
  native.clear()
  __clearJobsForTest()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('R2 bounded finite Node deadline scheduling', () => {
  test('long finite chunks retain the original deadline across the native maximum', () => {
    const manual = createControlledExecutionClock()
    const expiresAt = manual.clock.nowMs() + MAX_NODE_TIMER_DELAY_MS + 25
    const delays: number[] = []
    const scheduler: Scheduler = {
      set(ms, callback) { delays.push(ms); return manual.scheduler.set(ms, callback) },
      clear(timer) { manual.scheduler.clear(timer) },
    }
    const expired = mock(() => {})
    const cancel = scheduleNodeDeadline(() => Math.max(0, expiresAt - manual.clock.nowMs()), expired, scheduler)
    expect(delays).toEqual([MAX_NODE_TIMER_DELAY_MS])
    manual.advance(MAX_NODE_TIMER_DELAY_MS)
    expect(expired).not.toHaveBeenCalled()
    expect(delays).toEqual([MAX_NODE_TIMER_DELAY_MS, 25])
    manual.advance(24)
    expect(expired).not.toHaveBeenCalled()
    manual.advance(1)
    expect(expired).toHaveBeenCalledTimes(1)
    cancel()
    manual.advance(MAX_NODE_TIMER_DELAY_MS)
    expect(expired).toHaveBeenCalledTimes(1)
    expect(delays.every(ms => Number.isInteger(ms) && ms >= 1 && ms <= MAX_NODE_TIMER_DELAY_MS)).toBe(true)
  })

  test('early and late timer frames recheck fixed time without duration renewal', () => {
    let now = 100
    const expiresAt = now + MAX_NODE_TIMER_DELAY_MS + 25
    const callbacks: Array<() => void> = []
    const delays: number[] = []
    const scheduler: Scheduler = { set(ms, callback) { delays.push(ms); callbacks.push(callback); return callbacks.length }, clear() {} }
    const expired = mock(() => {})
    scheduleNodeDeadline(() => Math.max(0, expiresAt - now), expired, scheduler)
    callbacks[0]()
    expect(expired).not.toHaveBeenCalled()
    now += MAX_NODE_TIMER_DELAY_MS
    callbacks[1]()
    expect(delays.at(-1)).toBe(25)
    now = expiresAt + 1
    callbacks[2]()
    expect(expired).toHaveBeenCalledTimes(1)
    expect(delays).toHaveLength(3)
  })

  test('unbounded schedules nothing and exhausted callbacks remain asynchronous', () => {
    const manual = createControlledExecutionClock()
    const set = mock(manual.scheduler.set)
    const scheduler: Scheduler = { set, clear: manual.scheduler.clear }
    const expired = mock(() => {})
    const cancelUnbounded = scheduleNodeDeadline(() => null, expired, scheduler)
    expect(set).not.toHaveBeenCalled()
    cancelUnbounded()
    const cancelZero = scheduleNodeDeadline(() => 0, expired, scheduler)
    expect(expired).not.toHaveBeenCalled()
    expect(set.mock.calls[0][0]).toBe(1)
    manual.advance(1)
    expect(expired).toHaveBeenCalledTimes(1)
    cancelZero()
  })

  test('cancelled queued callbacks do nothing and clear is idempotent', () => {
    let callback!: () => void
    const clear = mock(() => {})
    const expired = mock(() => {})
    const set = mock((_ms: number, value: () => void) => { callback = value; return 'owned-timer' })
    const cancel = scheduleNodeDeadline(() => 20, expired, { set, clear })
    cancel()
    cancel()
    callback()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith('owned-timer')
    expect(set).toHaveBeenCalledTimes(1)
    expect(expired).not.toHaveBeenCalled()
  })

  test('actual helper long finite child survives the overflow window before cancellation', async () => {
    const control = await dispatchedSleep(LONG_MS)
    await delay(80)
    expect(native.get(control.node.child)!.closed).toBe(false)
    expect(control.kills).toEqual([])
    expect(control.node.resourceRefusal()).toBeUndefined()
    expect(control.node.remainingResourceMs()).toBeLessThan(LONG_MS)
    expect(control.processes.calls[0].options.env?.OPENAI_API_KEY).toBeUndefined()
    expect(control.processes.calls[0].options.env?.PROJECT_VALUE).toBe('captured-value')
    expect(control.processes.calls[0].options.signal).not.toBe(control.host.context.signal)
    control.abort.abort(new Error('cancel long finite helper'))
    await closeWithin(control.node.child)
    expect(control.node.resourceRefusal()).toMatchObject({ reason: 'cancelled', cause: 'cancel long finite helper' })
  })

  test('actual helper ordinary finite backstop expires without the controlled host clock', async () => {
    const control = await dispatchedSleep(100)
    const [, signal] = await closeWithin(control.node.child)
    await control.node.scope.requestStop('owner-shutdown')
    expect(signal).toBe('SIGKILL')
    expect(control.kills).toEqual(['SIGKILL'])
    expect(control.node.resourceRefusal()).toMatchObject({ reason: 'deadline-exhausted' })
    expect(control.node.input.resourceSignal.aborted).toBe(false)
    expect(control.manual.clock.nowMs()).toBe(100)
  })

  test.each([false, true])('actual helper distinguishes same-text cancellation from registered expiry=%s', async expired => {
    const control = await dispatchedSleep(5_000)
    if (expired) control.manual.advance(5_000)
    else control.abort.abort(new Error('Execution deadline exhausted'))
    await closeWithin(control.node.child)
    await control.node.scope.requestStop('owner-shutdown')
    expect(control.node.resourceRefusal()).toMatchObject({ reason: expired ? 'deadline-exhausted' : 'cancelled' })
    expect(control.kills).toEqual([expired ? 'SIGKILL' : 'SIGTERM'])
  })

  test('caller-constructed typed deadline refusal remains ordinary helper cancellation', async () => {
    const control = await dispatchedSleep(5_000)
    control.abort.abort(new ExecutionRefusalError({ ok: false, reason: 'deadline-exhausted', cause: 'Caller claimed expiry' }))
    await closeWithin(control.node.child)
    await control.node.scope.requestStop('owner-shutdown')
    expect(control.node.resourceRefusal()).toMatchObject({ reason: 'cancelled', cause: 'Caller claimed expiry' })
    expect(control.kills).toEqual(['SIGTERM'])
  })

  test('actual child close disarms a still-finite helper deadline', async () => {
    const manual = createControlledExecutionClock()
    const processes = realRecorder()
    // This case checks disarming after exit, so leave room for process startup
    // on loaded runners. The separate finite-backstop case checks prompt expiry.
    const host = fixture({ ...manual, projectRoot: scratch(), spawn: processes.spawn, actionLimit: { kind: 'finite', durationMs: 5_000 } })
    const launch = executionValue(prepareNodeLaunch({ executionContext: host.context,
      executable: '/usr/bin/printf', argv: ['timer-close'], cwd: host.context.projectRoot,
      branchId: 'terminal.sync', adapterOptions: { stdio: 'ignore', detached: false, shell: false } }))
    const node = executionValue(dispatchNodeLaunch(executionValue(await admitNodeLaunch(launch, host.context.signal)), input =>
      processes.spawn(input.executable, input.argv, { cwd: input.cwd, env: input.env, signal: input.resourceSignal, stdio: 'ignore' })))
    expect(executionValue(await node.started).pid).toBeGreaterThan(0)
    expect(await closeWithin(node.child)).toEqual([0, null])
    // Cross the captured native deadline without renewing its duration.
    await delay(Math.ceil(node.remainingResourceMs()!) + 30)
    expect(node.scope.currentCleanup()?.signals.filter(signal => signal.result === 'delivered')).toEqual([])
    expect(node.resourceRefusal()).toBeUndefined()
  }, 10_000)

  test('long finite cancellation grace survives native AbortError frames until close', async () => {
    const abort = new AbortController()
    const manual = createControlledExecutionClock()
    const processes = createExecutionProcessRecorder({ autoClose: false, closeOnKill: false })
    injected.push(processes)
    const host = fixture({ ...manual, signal: abort.signal, spawn: processes.spawn,
      projectRoot: '/timer-fixture', actionLimit: { kind: 'finite', durationMs: LONG_MS } })
    const launch = executionValue(prepareNodeLaunch({ executionContext: host.context,
      executable: '/usr/bin/sleep', argv: ['30'], cwd: '/timer-fixture', branchId: 'terminal.sync',
      adapterOptions: { stdio: 'pipe', detached: false, shell: false } }))
    const node = executionValue(dispatchNodeLaunch(executionValue(await admitNodeLaunch(launch, host.context.signal)), input => {
      const child = processes.spawn(input.executable, input.argv, { cwd: input.cwd, env: input.env, signal: input.resourceSignal })
      input.resourceSignal.addEventListener('abort', () => child.emit('error', Object.assign(new Error('native abort'), { name: 'AbortError', code: 'ABORT_ERR' })), { once: true })
      return child
    }, { sigtermGraceMs: MAX_NODE_TIMER_DELAY_MS + 25 }))
    expect(executionValue(await node.started).pid).toBeGreaterThan(0)
    abort.abort(new Error('long grace cancellation'))
    await delay(60)
    expect(processes.calls[0].signals).toEqual(['SIGTERM'])
    expect(node.resourceRefusal()).toMatchObject({ reason: 'cancelled', cause: 'long grace cancellation' })
    processes.calls[0].finish(undefined, 'SIGTERM')
  })

  test('core deadline cancels immediately and the finite backstop cannot add a kill', async () => {
    const control = await dispatchedSleep(100)
    control.manual.advance(100)
    await closeWithin(control.node.child)
    await delay(120)
    expect(control.kills).toEqual(['SIGKILL'])
    expect(control.node.resourceRefusal()).toMatchObject({ reason: 'deadline-exhausted' })
    expect(control.node.input.resourceSignal.aborted).toBe(true)
  })
})

describe('R2 timer consumer captures', () => {
  for (const bounded of [false, true]) for (const durationMs of [60, LONG_MS]) {
    test(`${bounded ? 'bounded' : 'legacy'} Git ${durationMs}ms retains exact captures and timeout semantics`, async () => {
      const manual = createControlledExecutionClock()
      const processes = createExecutionProcessRecorder({ autoClose: false, closeOnKill: false })
      injected.push(processes)
      let observeSignal!: () => void
      const signalRequested = new Promise<void>(resolve => { observeSignal = resolve })
      const spawn: CodebuffSpawn = (command, argv, options) => {
        const child = processes.spawn(command, argv, options)
        const kill = child.kill.bind(child)
        child.kill = signal => { const delivered = kill(signal); observeSignal(); return delivered }
        return child
      }
      const host = fixture({ ...manual, projectRoot: '/timer-fixture', spawn,
        actionLimit: { kind: 'finite', durationMs } })
      const options = { executionContext: host.context, branchId: bounded ? 'git-status.bounded.status.all' : 'git-status.legacy.status.all', phase: 'timer-control' }
      const pending = bounded
        ? runGitBounded(['status', '--porcelain'], '/timer-fixture', undefined, { ...options, timeoutMs: durationMs, maxOutputBytes: 4_096 })
        : runGit(['status', '--porcelain'], '/timer-fixture', undefined, options)
      let settled = false
      void pending.then(() => { settled = true }, () => { settled = true })
      for (let turn = 0; !processes.calls.length && turn < 30; turn++) await new Promise(resolve => setImmediate(resolve))
      const actual = processes.calls[0]
      expect(actual.argv).toEqual(['--no-pager', '--no-optional-locks', '--no-lazy-fetch', '-c', 'core.fsmonitor=false',
        'status', '--porcelain'])
      expect(actual.options).toMatchObject({ cwd: '/timer-fixture', shell: false, detached: false })
      expect(actual.options.env?.PROJECT_VALUE).toBe('captured-value')
      expect(actual.options.env?.OPENAI_API_KEY).toBeUndefined()
      expect(actual.options.signal).not.toBe(host.context.signal)
      expect(host.policyInputs[0].target.adapterOptions.phase).toBe('timer-control')
      if (durationMs === LONG_MS) {
        await delay(60)
        expect(settled).toBe(false)
        expect(actual.signals).toEqual([])
        actual.child.stdout?.emit('data', Buffer.from('retained-git\n'))
        actual.finish(0)
        expect(await pending).toMatchObject({ exitCode: 0, stdout: 'retained-git\n' })
        expect((await pending).executionRefusal).toBeUndefined()
      } else {
        expect((await pending).executionRefusal).toMatchObject({ reason: 'deadline-exhausted' })
        // Logical refusal can settle before the owned scope's signal callback.
        await signalRequested
        expect(actual.signals).toEqual(['SIGKILL'])
        actual.finish(undefined, 'SIGKILL')
      }
    })
  }

  for (const durationMs of [60, LONG_MS]) {
    test(`diagnostic ${durationMs}ms retains command phase, exact options and timeout semantics`, async () => {
      const manual = createControlledExecutionClock()
      const processes = createExecutionProcessRecorder({ autoClose: false, closeOnKill: false })
      injected.push(processes)
      const host = fixture({ ...manual, projectRoot: '/timer-fixture', spawn: processes.spawn,
        actionLimit: { kind: 'finite', durationMs } })
      const [command, invocation] = Object.entries(DIAGNOSTIC_COMMAND_INVOCATIONS).find(([, value]) => value.id === 'ruff')!
      const pending = createDiagnosticCommandRunner({ spawn: processes.spawn })({ command, cwd: '/timer-fixture',
        timeoutSeconds: durationMs / 1_000, executionContext: host.context, phase: 'after' })
      let settled = false
      void pending.then(() => { settled = true }, () => { settled = true })
      for (let turn = 0; !processes.calls.length && turn < 30; turn++) await new Promise(resolve => setImmediate(resolve))
      const actual = processes.calls[0]
      expect(actual.executable).toBe(invocation.executable)
      expect(actual.argv).toEqual(invocation.argv)
      expect(actual.options).toMatchObject({ cwd: '/timer-fixture', stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: false })
      expect(actual.options.env?.OPENAI_API_KEY).toBeUndefined()
      expect(actual.options.env?.CUSTOM_PROVIDER_KEY).toBeUndefined()
      expect(actual.options.signal).not.toBe(host.context.signal)
      expect(host.policyInputs[0].facts.branchId).toBe('diagnostic.ruff.after')
      if (durationMs === LONG_MS) {
        await delay(60)
        expect(settled).toBe(false)
        expect(actual.signals).toEqual([])
        actual.child.stdout?.emit('data', Buffer.from('[]'))
        actual.finish(0)
        expect(await pending).toMatchObject({ exitCode: 0, stdout: '[]', outputTruncated: false })
        expect((await pending).executionRefusal).toBeUndefined()
      } else {
        // Expire the captured host clock so settlement and physical termination
        // share its deadline, independent of the two native backstop wakeups.
        manual.advance(durationMs - 1)
        expect(settled).toBe(false)
        expect(actual.signals).toEqual([])
        manual.advance(1)
        expect(await pending).toMatchObject({ timedOut: true, executionRefusal: { reason: 'deadline-exhausted' } })
        expect(actual.signals).toEqual(['SIGKILL'])
        actual.finish(undefined, 'SIGKILL')
      }
    })
  }

  for (const background of [false, true]) {
    test(`actual ${background ? 'background' : 'SYNC'} local -1 preserves an inherited long finite cap`, async () => {
      const manual = createControlledExecutionClock()
      const abort = new AbortController()
      const processes = realRecorder()
      const host = fixture({ ...manual, signal: abort.signal, spawn: processes.spawn, projectRoot: scratch(),
        actionLimit: { kind: 'finite', durationMs: LONG_MS } })
      const pending = runTerminalCommand({ command: 'printf ready; exec /usr/bin/sleep 30',
        cwd: host.context.projectRoot, projectRoot: host.context.projectRoot, process_type: background ? 'BACKGROUND' : 'SYNC',
        timeout_seconds: -1, executionContext: host.context,
        terminalShell: { executable: '/bin/bash', args: ['-c'] }, getTerminalLaunchMetadata: host.getTerminalLaunchMetadata })
      let settled = false
      void pending.then(() => { settled = true }, () => { settled = true })
      for (let turn = 0; !processes.calls.some(call => call.executable === '/bin/bash' && call.spawnObserved) && turn < 100; turn++) await delay(2)
      const actual = processes.calls.find(call => call.executable === '/bin/bash')!
      expect(actual.spawnObserved).toBe(true)
      expect(actual.argv).toEqual(['-c', 'printf ready; exec /usr/bin/sleep 30'])
      expect(actual.options.env?.PROJECT_VALUE).toBe('captured-value')
      expect(actual.options.env?.OPENAI_API_KEY).toBeUndefined()
      expect(actual.options.signal).not.toBe(host.context.signal)
      const value = background ? (await pending)[0].value as { jobId: string } : undefined
      await delay(80)
      expect(native.get(actual.child)!.closed).toBe(false)
      if (background) expect(getBackgroundJobAdapter(value!.jobId)?.status).toBe('running')
      else expect(settled).toBe(false)
      abort.abort(new Error('cancel inherited long finite adapter'))
      await closeWithin(actual.child)
      if (background) await getBackgroundJobAdapter(value!.jobId)!.nodeLaunch!.scope.requestStop('owner-cancel')
      if (background) expect(getBackgroundJobAdapter(value!.jobId)?.status).toBe('stopped')
      else expect((await pending)[0].value).toMatchObject({ executionRefusal: { reason: 'cancelled' }, stdout: 'ready' })
    })
  }

  test('oversized explicit file-hash timeout preserves complete real file identity', async () => {
    const cwd = scratch()
    const file = path.join(cwd, 'large.bin')
    const size = 128 * 1024 * 1024
    const fd = fs.openSync(file, 'w+')
    try { fs.ftruncateSync(fd, size) } finally { fs.closeSync(fd) }
    const content = createHash('sha256')
    const zeros = Buffer.alloc(1024 * 1024)
    for (let offset = 0; offset < size; offset += zeros.length) content.update(zeros)
    const info = fs.lstatSync(file, { bigint: true })
    const expected = createHash('sha256').update(`${JSON.stringify('large.bin')}:mode:${info.mode}:size:${info.size}\0file:${content.digest('hex')}\0`).digest('hex')
    const actual = createHash('sha256')
    await hashIdentityFileBytes(actual, cwd, ['large.bin'], { timeoutMs: LONG_MS })
    expect(actual.digest('hex')).toBe(expected)
  })
})
