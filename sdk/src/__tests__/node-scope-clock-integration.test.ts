import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { registerInjectedNodeScopeDriver } from '@codebuff/common/util/node-process-scope'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { createHostExecutionServices, executionClock } from '../host-execution'
import { admitNodeLaunch, captureNodeTarget, deriveExecutionContext, dispatchNodeLaunch, prepareNodeLaunch } from '../services/execution-launch'
import { runTerminalCommand } from '../tools/run-terminal-command'
import type { ChildProcess } from 'node:child_process'
import type { Clock, ExecutionAdapterContext, Result } from '@codebuff/common/types/contracts/execution-context'

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}

function host(clock: Clock, options: { defaultClock?: boolean; unbounded?: boolean; boundaryClock?: Clock } = {}) {
  const root = process.cwd()
  const captured = loadHostConfigSnapshot({ fs: nodeConfigReadFs, inputs: {
    environment: {}, platform: process.platform, invocationCwd: root, projectRoot: root,
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'none' },
    trust: { ancestorConfig: false, projectReadableRoots: false },
  } })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  const boundary = value(captureRootDeadline({ clock: options.boundaryClock ?? clock, limit: options.unbounded
    ? { kind: 'unbounded' } : { kind: 'finite', durationMs: 1000 } }))
  const services = value(createHostExecutionServices({ snapshot: captured.snapshot, boundary,
    clock: options.defaultClock ? undefined : clock,
    childInheritanceEnvironment: {}, approvalMode: 'allow-all' }))
  return { services, context: value(services.directOperation({ mode: 'user' })).executionContext }
}

function input(context: ExecutionAdapterContext) {
  return { executionContext: context, executable: 'fixture', argv: [], cwd: context.projectRoot,
    branchId: 'terminal.sync', adapterOptions: { detached: false, shell: false } }
}

function childWithObservation(clock: Clock, observationClock: Clock = clock): ChildProcess {
  const child = Object.assign(new EventEmitter(), { pid: 43210, exitCode: null, signalCode: null,
    stdin: null, stdout: null, stderr: null, kill: () => true }) as unknown as ChildProcess
  const streams = { stdin: 'closed', stdout: 'drained', stderr: 'drained' } as const
  registerInjectedNodeScopeDriver(child, {
    leaderExited: new Promise(() => {}), streamsFinished: Promise.resolve(streams),
    observe: async () => ({ sampledAtMs: observationClock.nowMs(), clockDomainId: observationClock.domainId,
      leader: 'exited-reaped', scopePresence: 'absent', members: [], membershipComplete: true,
      identity: 'verified', streams }),
    signal: async signal => ({ signal, atMs: clock.nowMs(), targetTier: 'injected', result: 'already-absent' }),
    closeInput() {},
  })
  return child
}

describe('SDK Node scope clock integration', () => {
  test('uses the originating injected host clock for finite cleanup credit', async () => {
    const clock: Clock = { domainId: 'host-controlled', nowMs: () => 100_000 }
    const { context } = host(clock)
    const launch = value(prepareNodeLaunch(input(context)))
    const admitted = value(await admitNodeLaunch(launch))
    const child = childWithObservation(clock)
    const node = value(dispatchNodeLaunch(admitted, () => child))
    const cleanup = await node.scope.requestStop('owner-cancel')
    expect(cleanup.status).toBe('complete')
    expect(cleanup.originalDeadline).toMatchObject({ kind: 'finite', domainId: clock.domainId, expiresAtMs: 101_000 })
    expect(cleanup.firstStopAtMs).toBe(100_000)
    expect(cleanup.selectedLimitSatisfied).toBe(true)
  })

  test('uses the SDK default host clock when no clock is injected', async () => {
    const { context } = host(executionClock, { defaultClock: true })
    const launch = value(prepareNodeLaunch(input(context)))
    const node = value(dispatchNodeLaunch(value(await admitNodeLaunch(launch)), () => childWithObservation(executionClock)))
    const cleanup = await node.scope.requestStop('owner-cancel')
    expect(cleanup.originalDeadline).toMatchObject({ kind: 'finite', domainId: executionClock.domainId })
    expect(cleanup.finalObservation.clockDomainId).toBe(executionClock.domainId)
    expect(cleanup.selectedLimitSatisfied).toBe(true)
  })

  test('preserves the host clock through derived action ports', async () => {
    const clock: Clock = { domainId: 'derived-host', nowMs: () => 75_000 }
    const { context } = host(clock)
    const derived = value(deriveExecutionContext(context, 'derived', { kind: 'finite', durationMs: 400 }))
    const launch = value(prepareNodeLaunch(input(derived)))
    const node = value(dispatchNodeLaunch(value(await admitNodeLaunch(launch)), () => childWithObservation(clock)))
    const cleanup = await node.scope.requestStop('owner-cancel')
    expect(cleanup.originalDeadline).toMatchObject({ kind: 'finite', domainId: clock.domainId, expiresAtMs: 75_400 })
    expect(cleanup.firstStopAtMs).toBe(75_000)
    expect(cleanup.selectedLimitSatisfied).toBe(true)
  })

  test('keeps clocks distinct even if two hosts use the same domain label', async () => {
    const first: Clock = { domainId: 'shared-label', nowMs: () => 10_000 }
    const second: Clock = { domainId: 'shared-label', nowMs: () => 100_000 }
    const a = value(prepareNodeLaunch(input(host(first).context)))
    const b = value(prepareNodeLaunch(input(host(second).context)))
    const nodeA = value(dispatchNodeLaunch(value(await admitNodeLaunch(a)), () => childWithObservation(first)))
    const nodeB = value(dispatchNodeLaunch(value(await admitNodeLaunch(b)), () => childWithObservation(second)))
    const [cleanupA, cleanupB] = await Promise.all([nodeA.scope.requestStop('owner-cancel'), nodeB.scope.requestStop('owner-cancel')])
    expect([cleanupA.firstStopAtMs, cleanupB.firstStopAtMs]).toEqual([10_000, 100_000])
    expect([cleanupA.selectedLimitSatisfied, cleanupB.selectedLimitSatisfied]).toEqual([true, true])
  })

  test('denies credit for an observation in a different clock domain', async () => {
    const clock: Clock = { domainId: 'host-clock', nowMs: () => 100_000 }
    const observationClock: Clock = { domainId: 'different-clock', nowMs: () => 100_000 }
    const launch = value(prepareNodeLaunch(input(host(clock).context)))
    const node = value(dispatchNodeLaunch(value(await admitNodeLaunch(launch)), () => childWithObservation(clock, observationClock)))
    const cleanup = await node.scope.requestStop('owner-cancel')
    expect(cleanup.status).toBe('complete')
    expect(cleanup.finalObservation.clockDomainId).toBe('different-clock')
    expect(cleanup.selectedLimitSatisfied).toBe(false)
  })

  test('rejects a root deadline captured in a different domain', () => {
    const clock: Clock = { domainId: 'host-clock', nowMs: () => 100_000 }
    const boundaryClock: Clock = { domainId: 'foreign-clock', nowMs: () => 100_000 }
    expect(() => host(clock, { boundaryClock })).toThrow('invalid-context: Invalid root deadline boundary')
  })

  test('denies credit for a late observation or late stop', async () => {
    let now = 100_000
    const clock: Clock = { domainId: 'late-host', nowMs: () => now }
    const lateObservation: Clock = { domainId: clock.domainId, nowMs: () => 102_401 }
    const context = host(clock).context
    const first = value(prepareNodeLaunch(input(context)))
    const firstNode = value(dispatchNodeLaunch(value(await admitNodeLaunch(first)), () => childWithObservation(clock, lateObservation)))
    const second = value(prepareNodeLaunch(input(context)))
    const secondNode = value(dispatchNodeLaunch(value(await admitNodeLaunch(second)), () => childWithObservation(clock)))
    expect((await firstNode.scope.requestStop('owner-cancel')).selectedLimitSatisfied).toBe(false)
    now = 102_401
    const cleanup = await secondNode.scope.requestStop('owner-cancel')
    expect(cleanup.status).toBe('complete')
    expect(cleanup.selectedLimitSatisfied).toBe(false)
  })

  test('fails closed for an unregistered launch even when it claims the process default domain', async () => {
    const clock: Clock = { domainId: 'process-monotonic', nowMs: () => performance.now() }
    const { context } = host(clock)
    const target = value(captureNodeTarget(input(context)))
    const launch = value(context.execution.prepareTarget({ target }))
    const node = value(dispatchNodeLaunch(value(await admitNodeLaunch(launch)), () => childWithObservation(clock)))
    const cleanup = await node.scope.requestStop('owner-cancel')
    expect(cleanup.originalDeadline).toMatchObject({ kind: 'finite', domainId: 'process-monotonic' })
    expect(cleanup.status).toBe('complete')
    expect(cleanup.selectedLimitSatisfied).toBe(false)
  })

  test('unregistered unbounded launches retain the existing process clock behavior', async () => {
    const clock: Clock = { domainId: 'process-monotonic', nowMs: () => performance.now() }
    const { context } = host(clock, { unbounded: true })
    const target = value(captureNodeTarget(input(context)))
    const launch = value(context.execution.prepareTarget({ target }))
    const node = value(dispatchNodeLaunch(value(await admitNodeLaunch(launch)), () => childWithObservation(clock)))
    const cleanup = await node.scope.requestStop('owner-cancel')
    expect(cleanup.originalDeadline.kind).toBe('unbounded')
    expect(cleanup.selectedLimitSatisfied).toBe(true)
  })

  test('registers the receiving host clock for transferred background launches', async () => {
    const clock: Clock = { domainId: 'background-host', nowMs: () => 100_000 }
    const { services, context } = host(clock)
    const target = value(captureNodeTarget({ ...input(context), family: 'background-job', processType: 'BACKGROUND',
      branchId: 'background.transferred' }))
    const receiver = value(services.createBackgroundReceiver('clock-test'))
    const launch = value(receiver.prepareLaunch(context, target))
    const node = value(dispatchNodeLaunch(value(await admitNodeLaunch(launch)), () => childWithObservation(clock)))
    const cleanup = await node.scope.requestStop('owner-cancel')
    expect(cleanup.originalDeadline).toMatchObject({ kind: 'finite', domainId: clock.domainId, expiresAtMs: 101_000 })
    expect(cleanup.firstStopAtMs).toBe(100_000)
    expect(cleanup.selectedLimitSatisfied).toBe(true)
  })

  test.skipIf(process.platform === 'win32')('binds a finite SYNC terminal launch to the derived owner clock', async () => {
    const { context } = host(executionClock, { unbounded: true, defaultClock: true })
    const executable = "'" + process.execPath.replaceAll("'", "'\\''") + "'"
    const [output] = await runTerminalCommand({
      command: `exec ${executable} -e 'setInterval(() => {}, 1000)'`,
      cwd: context.projectRoot,
      process_type: 'SYNC',
      timeout_seconds: 0.25,
      executionContext: context,
    })
    expect(output!.value.executionRefusal?.reason).toBe('deadline-exhausted')
    const cleanup = output!.value.processCleanup!
    expect(cleanup.status).toBe('complete')
    expect(cleanup.originalDeadline).toMatchObject({ kind: 'finite', domainId: executionClock.domainId })
    expect(cleanup.finalObservation.clockDomainId).toBe(executionClock.domainId)
    expect(cleanup.selectedLimitSatisfied).toBe(true)
  })

  test('the actual Node driver samples the bound host clock', async () => {
    const clock: Clock = { domainId: 'real-node-host', nowMs: () => 100_000 }
    const context = host(clock).context
    const launch = value(prepareNodeLaunch({ ...input(context), executable: process.execPath,
      argv: ['-e', 'setInterval(() => {}, 1000)'] }))
    const node = value(dispatchNodeLaunch(value(await admitNodeLaunch(launch)), (captured) =>
      spawn(captured.executable, [...captured.argv], { cwd: captured.cwd, env: {}, stdio: 'ignore' })))
    try {
      expect((await node.scope.observe())).toMatchObject({ sampledAtMs: 100_000, clockDomainId: clock.domainId })
      const cleanup = await node.scope.requestStop('owner-cancel')
      expect(cleanup.status).toBe('complete')
      expect(cleanup.finalObservation.clockDomainId).toBe(clock.domainId)
      expect(cleanup.selectedLimitSatisfied).toBe(true)
    } finally {
      if (node.child.exitCode === null && node.child.signalCode === null) node.child.kill('SIGKILL')
    }
  })
})
