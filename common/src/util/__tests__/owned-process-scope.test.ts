import { describe, expect, test } from 'bun:test'
import { createOwnedProcessScope } from '../owned-process-scope'
import { parseProcStat } from '../linux-process-scope'
import type { ProcessScopeDriver, ScopeObservation } from '../../types/contracts/process-scope'

function fixture() {
  let observation: ScopeObservation = {
    sampledAtMs: 0, clockDomainId: 'injected', leader: 'running', scopePresence: 'living',
    members: [], membershipComplete: true, identity: 'verified',
    streams: { stdin: 'closed', stdout: 'drained', stderr: 'drained' },
  }
  const signals: string[] = []
  let onSignal: (() => void) | undefined
  const driver: ProcessScopeDriver = {
    leaderExited: new Promise(() => {}), streamsFinished: new Promise(() => {}),
    async observe() { return observation },
    async signal(signal) { signals.push(signal); onSignal?.(); return {
      signal, atMs: performance.now(), targetTier: 'injected', result: 'delivered',
    } }, closeInput() {},
  }
  return { driver, signals, update: (next: Partial<ScopeObservation>) => { observation = { ...observation, ...next } },
    onSignal: (callback: () => void) => { onSignal = callback } }
}
describe('owned process scope cleanup', () => {
  test('long TERM grace wakes in bounded chunks without renewing its escalation point', async () => {
    let now = 0, timerId = 0
    const timers = new Map<number, { delay: number; callback: () => void }>()
    const f = fixture(), grace = 2_147_483_647 + 25
    f.onSignal(() => { if (f.signals.includes('SIGKILL')) f.update({ leader: 'exited-reaped', scopePresence: 'absent' }) })
    const scope = createOwnedProcessScope({ scopeId: 'long-grace', tier: 'injected', driver: f.driver,
      clock: { domainId: 'injected', nowMs: () => now }, scheduler: {
        set(delay, callback) { timers.set(++timerId, { delay, callback }); return timerId },
        clear(timer) { timers.delete(timer as number) },
      }, termGraceMs: grace })
    const pending = scope.requestStop('owner-cancel')
    const first = timers.get(1)!
    expect(first.delay).toBe(2_147_483_647)
    expect(f.signals).toEqual(['SIGTERM'])
    now = 2_147_483_647
    timers.delete(1); first.callback()
    const remaining = [...timers.values()].find(timer => timer.delay === 25)
    expect(remaining).toBeDefined()
    expect(f.signals).toEqual(['SIGTERM'])
    // An explicit force request may finish early without changing the long
    // original grace; no real runtime timer or days-long sleep is required.
    expect(scope.requestStop('owner-cancel', true)).toBe(pending)
    const result = await pending
    expect(result.killAtMs).toBe(grace)
    expect(result.status).toBe('complete')
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(timers.size).toBe(0)
  })
  test('an unavailable observation cannot postpone the captured TERM grace', async () => {
    let now = 0, timerId = 0, killed = false, done = false
    const tasks = new Map<number, { at: number; callback: () => void }>()
    const f = fixture()
    f.driver.observe = () => killed ? Promise.resolve({
      sampledAtMs: now, clockDomainId: 'injected', leader: 'exited-reaped', scopePresence: 'absent',
      members: [], membershipComplete: true, identity: 'verified',
      streams: { stdin: 'closed', stdout: 'drained', stderr: 'drained' },
    }) : new Promise(() => {})
    f.driver.signal = async signal => {
      killed ||= signal === 'SIGKILL'
      return { signal, atMs: now, targetTier: 'injected', result: 'delivered' }
    }
    const scope = createOwnedProcessScope({ scopeId: 'async-probe-grace', tier: 'injected', driver: f.driver,
      clock: { domainId: 'injected', nowMs: () => now }, scheduler: {
        set(delay, callback) { tasks.set(++timerId, { at: now + delay, callback }); return timerId },
        clear(timer) { tasks.delete(timer as number) },
      }, termGraceMs: 200, killGraceMs: 200, observationMs: 1_000, probeTimeoutMs: 50, pollMs: 10 })
    const pending = scope.requestStop('owner-cancel').then(result => { done = true; return result })
    for (let iteration = 0; !done && iteration < 1_000; iteration++) {
      for (let tick = 0; tick < 25; tick++) await Promise.resolve()
      if (done) break
      const next = [...tasks.entries()].sort((left, right) => left[1].at - right[1].at)[0]
      if (!next) throw new Error('Cleanup stalled without a timer')
      now = next[1].at; tasks.delete(next[0]); next[1].callback()
    }
    expect(done).toBe(true)
    const result = await pending
    expect(result.signals.map(signal => [signal.signal, signal.atMs])).toEqual([['SIGTERM', 0], ['SIGKILL', 200]])
    expect(result.killAtMs).toBe(200)
    expect(result.observeUntilMs).toBe(1_400)
    expect(result.selectedLimitSatisfied).toBe(true)
    expect(tasks.size).toBe(0)
  })
  test('stop fencing precedes all reentrant driver callbacks and cannot prevent termination', async () => {
    const f = fixture(), order: string[] = []
    f.driver.closeInput = () => { order.push('input') }
    f.onSignal(() => { order.push('signal'); f.update({ leader: 'exited-reaped', scopePresence: 'absent' }) })
    const scope = createOwnedProcessScope({ scopeId: 'stop-fence', tier: 'injected', driver: f.driver,
      onStop() { order.push('fence'); throw new Error('Host fencing observer failed') } })
    expect((await scope.requestStop('owner-cancel')).status).toBe('complete')
    expect(order).toEqual(['fence', 'input', 'signal'])
  })
  test('leader exit alone retains escalation; force reentry joins one attempt', async () => {
    const f = fixture()
    const scope = createOwnedProcessScope({ scopeId: 'reentrant', tier: 'injected', driver: f.driver,
      termGraceMs: 200, killGraceMs: 10, observationMs: 20, pollMs: 1 })
    let joined: Promise<unknown> | undefined
    f.onSignal(() => {
      if (f.signals.length === 1) joined = scope.requestStop('job-kill', true)
      else f.update({ leader: 'exited-reaped', scopePresence: 'absent' })
    })
    const pending = scope.requestStop('owner-cancel')
    expect(joined).toBe(pending)
    const result = await pending
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(result.status).toBe('complete')
    expect(result.trigger).toBe('owner-cancel')
    expect(result.signals).toHaveLength(2)
    expect(await scope.requestStop('job-kill', true)).toBe(result)
    expect(f.signals).toHaveLength(2)
  })
  test('living descendants fail the fixed bound and retain cleanup authority', async () => {
    const f = fixture()
    f.update({ leader: 'exited-reaped' })
    const scope = createOwnedProcessScope({ scopeId: 'living', tier: 'injected', driver: f.driver,
      termGraceMs: 10, killGraceMs: 10, observationMs: 20, pollMs: 1 })
    const result = await scope.requestStop('deadline')
    expect(result.status).toBe('failed')
    expect(result.cleanupAuthorityRetained).toBe(true)
    expect(result.selectedLimitSatisfied).toBe(false)
    expect(result.observeUntilMs - result.firstStopAtMs).toBeCloseTo(40, 9)
    f.update({ scopePresence: 'absent' })
    const recovery = await scope.retryCleanup()
    expect(recovery.status).toBe('complete')
    expect(recovery.selectedLimitSatisfied).toBe(false)
    expect(result.status).toBe('failed')
  })
  test('never resolving probes and failed signals cannot hang cancellation', async () => {
    const f = fixture()
    f.driver.observe = () => new Promise(() => {})
    f.driver.signal = () => new Promise(() => {})
    const scope = createOwnedProcessScope({ scopeId: 'hung', tier: 'injected', driver: f.driver,
      termGraceMs: 10, killGraceMs: 10, observationMs: 20, probeTimeoutMs: 5, pollMs: 1 })
    const started = performance.now()
    const result = await scope.requestStop('owner-cancel')
    expect(performance.now() - started).toBeLessThan(200)
    expect(result.status).toBe('unknown')
    expect(result.cleanupAuthorityRetained).toBe(true)
    expect(result.signals.every(signal => signal.result === 'unknown')).toBe(true)
  })
  test('closed incomplete streams can release physical scope without output or limit credit', async () => {
    const f = fixture()
    f.update({ leader: 'exited-reaped', scopePresence: 'absent', streams: {
      stdin: 'closed', stdout: 'closed-incomplete', stderr: 'drained',
    } })
    const scope = createOwnedProcessScope({ scopeId: 'incomplete', tier: 'injected', driver: f.driver,
      output: () => ({ stdoutSeenBytes: 30, stderrSeenBytes: 0, retainedBytes: 10, droppedBytes: 20, complete: false }) })
    const result = await scope.requestStop('owner-cancel')
    expect(result.status).toBe('complete')
    expect(result.output.complete).toBe(false)
    expect(result.selectedLimitSatisfied).toBe(false)
  })
  test('a complete zero-member scan with unknown identity never grants completion', async () => {
    const f = fixture()
    f.update({ leader: 'exited-reaped', scopePresence: 'absent', identity: 'mismatch' })
    const scope = createOwnedProcessScope({ scopeId: 'mismatch', tier: 'injected', driver: f.driver,
      termGraceMs: 1, killGraceMs: 1, observationMs: 1 })
    expect((await scope.requestStop('job-kill')).cleanupAuthorityRetained).toBe(true)
  })
  test('Linux stat preserves starttime beyond number precision and unusual comm', () => {
    const fields = ['S', '1', '123', '123', ...Array(15).fill('0'), '90071992547409931234']
    expect(parseProcStat(`123 (command name) with parens)) ${fields.join(' ')}`)).toEqual({
      state: 'S', identity: { pid: 123, pgid: 123, sid: 123, startTime: '90071992547409931234' },
    })
    expect(() => parseProcStat('garbage')).toThrow()
  })
  test('unknown KILL can be retried within the same immutable attempt', async () => {
    const f = fixture()
    f.driver.signal = async signal => {
      f.signals.push(signal)
      if (f.signals.length === 2) f.update({ leader: 'exited-reaped', scopePresence: 'absent' })
      return { signal, atMs: performance.now(), targetTier: 'injected', result: f.signals.length === 1 ? 'unknown' : 'delivered' }
    }
    const scope = createOwnedProcessScope({ scopeId: 'retry-in-attempt', tier: 'injected', driver: f.driver,
      termGraceMs: 10, killGraceMs: 10, observationMs: 100, pollMs: 1 })
    const pending = scope.requestStop('owner-cancel', true)
    await Promise.resolve()
    await Promise.resolve()
    expect(scope.requestStop('owner-cancel', true)).toBe(pending)
    const result = await pending
    expect(result.status).toBe('complete')
    expect(result.signals.map(signal => signal.result)).toEqual(['unknown', 'delivered'])
    expect(result.observeUntilMs - result.firstStopAtMs).toBeCloseTo(120, 6)
  })
  test('late observations cannot redeem a valid zero cleanup bound', async () => {
    const f = fixture()
    f.update({ leader: 'exited-reaped', scopePresence: 'absent' })
    const original = f.driver.observe
    f.driver.observe = async () => { await Bun.sleep(10); return original() }
    const scope = createOwnedProcessScope({ scopeId: 'zero-bound', tier: 'injected', driver: f.driver,
      termGraceMs: 0, killGraceMs: 0, observationMs: 0 })
    const result = await scope.requestStop('owner-cancel', true)
    expect(result.selectedLimitSatisfied).toBe(false)
    expect(result.status).toBe('unknown')
    await Bun.sleep(20)
    expect(scope.currentCleanup()).toBe(result)
    expect(result.status).toBe('unknown')
  })
  test('default output and callback output never credit incomplete stream closure', async () => {
    for (const declared of [false, true]) {
      const f = fixture()
      f.update({ leader: 'exited-reaped', scopePresence: 'absent', streams: { stdin: 'closed', stdout: 'closed-incomplete', stderr: 'drained' } })
      const scope = createOwnedProcessScope({ scopeId: `default-output-${declared}`, tier: 'injected', driver: f.driver,
        ...(declared ? { output: () => ({ stdoutSeenBytes: 0, stderrSeenBytes: 0, retainedBytes: 0, droppedBytes: 0, complete: true }) } : {}) })
      const result = await scope.requestStop('owner-cancel')
      expect(result.status).toBe('complete')
      expect(result.output.complete).toBe(false)
      expect(result.selectedLimitSatisfied).toBe(false)
    }
  })
})
