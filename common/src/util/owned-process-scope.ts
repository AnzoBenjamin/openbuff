import type {
  CleanupResult, OwnedProcessScope, ProcessScopeOptions, ScopeObservation,
  SignalObservation, StopReason,
} from '../types/contracts/process-scope'
import { isExecutionDeadlineSignal } from './execution-context'

export const processScopeClock = {
  domainId: 'process-monotonic', nowMs: () => performance.now(),
}
const scheduler = {
  set: (ms: number, callback: () => void) => setTimeout(callback, ms),
  clear: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

/** Private in-process handle; serialized observations never authorize signals. */
export function createOwnedProcessScope(options: ProcessScopeOptions): OwnedProcessScope {
  const clock = options.clock ?? processScopeClock
  const timers = options.scheduler ?? scheduler
  const grace = options.termGraceMs ?? 200
  const killGrace = options.killGraceMs ?? 200
  const allowance = options.observationMs ?? 1_000
  for (const value of [grace, killGrace, allowance, options.probeTimeoutMs ?? 50, options.pollMs ?? 10]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid process cleanup policy')
  }
  let result: CleanupResult | undefined
  let inFlight: Promise<CleanupResult> | undefined
  let forceRequested = false
  let upgrade: (() => void) | undefined
  let attempt = 0
  let deadlineTimer: unknown
  let missedLimit = false
  let selectedLimitRequested = false
  const unknown = (): ScopeObservation => ({
    sampledAtMs: clock.nowMs(), clockDomainId: clock.domainId, leader: 'unknown',
    scopePresence: 'unknown', members: [], membershipComplete: false,
    identity: 'unknown', streams: { stdin: 'unknown', stdout: 'unknown', stderr: 'unknown' },
  })
  const bounded = <T>(operation: () => Promise<T>, ms: number, fallback: T): Promise<T> =>
    new Promise(resolve => {
      let done = false
      const finish = (value: T) => {
        if (done) return
        done = true
        timers.clear(timer)
        resolve(value)
      }
      const timer = timers.set(Math.max(0, ms), () => finish(fallback))
      try { void operation().then(finish, () => finish(fallback)) }
      catch { finish(fallback) }
    })
  const observe = () => bounded(() => options.driver.observe(), options.probeTimeoutMs ?? 50, unknown())
  const complete = (o: ScopeObservation) => o.identity === 'verified' && o.membershipComplete &&
    (o.scopePresence === 'absent' || o.scopePresence === 'zombie-only') &&
    o.leader === 'exited-reaped' && o.streams.stdin === 'closed' &&
    (o.streams.stdout === 'drained' || o.streams.stdout === 'closed-incomplete') &&
    (o.streams.stderr === 'drained' || o.streams.stderr === 'closed-incomplete')
  const removeLifetime = () => {
    if (deadlineTimer !== undefined) timers.clear(deadlineTimer)
    options.signal?.removeEventListener('abort', onAbort)
  }
  async function stop(reason: StopReason, retry: boolean): Promise<CleanupResult> {
    const firstStopAtMs = clock.nowMs()
    const killAtMs = firstStopAtMs + grace
    const observeUntilMs = killAtMs + killGrace + allowance
    try { options.onStop?.() } catch { /* fencing observation cannot prevent termination */ }
    const signals: SignalObservation[] = []
    const signalOperations: Promise<void>[] = []
    const attemptId = `${options.scopeId}:${++attempt}`
    const kill = { state: 'not-requested' as 'not-requested' | 'pending' | 'delivered' | 'failed' }
    let nextKillRetryAtMs = firstStopAtMs
    const signal = (name: 'SIGTERM' | 'SIGKILL'): Promise<void> => {
      if (name === 'SIGKILL') { kill.state = 'pending'; nextKillRetryAtMs = clock.nowMs() + 50 }
      const fallback: SignalObservation = { signal: name, atMs: clock.nowMs(),
        targetTier: options.tier, result: 'unknown' }
      const index = signals.push(fallback) - 1
      const operation = bounded(() => options.driver.signal(name),
        Math.min(options.probeTimeoutMs ?? 50, Math.max(0, observeUntilMs - clock.nowMs())), fallback)
        .then(value => {
          signals[index] = Object.freeze({ ...value })
          if (name === 'SIGKILL') kill.state = value.result === 'delivered' || value.result === 'already-absent' ? 'delivered' : 'failed'
        })
      signalOperations.push(operation)
      return operation
    }
    try { options.driver.closeInput() } catch { /* retained in stream observations */ }
    // Attempt TERM/KILL before waiting on a liveness probe. An unavailable
    // probe must not delay termination or acquire signal authority.
    upgrade = () => {
      if (clock.nowMs() <= observeUntilMs && (kill.state === 'not-requested' || kill.state === 'failed')) void signal('SIGKILL')
    }
    // Escalation owns its timer independently of in-flight observation probes.
    // A slow asynchronous inventory cannot postpone the captured TERM grace.
    let killTimer: unknown
    const armKill = () => {
      killTimer = timers.set(Math.max(0, Math.min(2_147_483_647, killAtMs - clock.nowMs())), () => {
        if (clock.nowMs() < killAtMs) armKill()
        else if (kill.state === 'not-requested' || kill.state === 'failed') upgrade?.()
      })
    }
    armKill()
    await signal(forceRequested ? 'SIGKILL' : 'SIGTERM')
    const sample = () => bounded(() => options.driver.observe(),
      Math.min(options.probeTimeoutMs ?? 50, Math.max(0, observeUntilMs - clock.nowMs())), unknown())
    let final = await sample()
    while (!complete(final) && clock.nowMs() < observeUntilMs) {
      if ((kill.state === 'not-requested' && (forceRequested || clock.nowMs() >= killAtMs)) ||
        (kill.state === 'failed' && clock.nowMs() >= nextKillRetryAtMs)) {
        await signal('SIGKILL')
      }
      final = await sample()
      if (complete(final) || clock.nowMs() >= observeUntilMs) break
      await new Promise<void>(resolve => timers.set(
        Math.max(1, Math.min(options.pollMs ?? 10, observeUntilMs - clock.nowMs(),
          kill.state === 'not-requested' ? Math.max(1, killAtMs - clock.nowMs()) : Infinity)), resolve))
    }
    timers.clear(killTimer)
    upgrade = undefined
    await Promise.all(signalOperations)
    final = Object.freeze({ ...final, streams: Object.freeze({ ...final.streams }),
      members: Object.freeze(final.members.map(member => Object.freeze({ ...member,
        identity: Object.freeze({ ...member.identity }) }))) })
    const satisfied = complete(final)
    const observedWithinBound = clock.nowMs() <= observeUntilMs && final.sampledAtMs <= observeUntilMs
    const selectedLimit = selectedLimitRequested
    if (selectedLimit && (!satisfied || !observedWithinBound)) missedLimit = true
    if (!satisfied) {
      try { options.driver.abandonStreams?.() } catch { /* no cleanup credit */ }
    } else removeLifetime()
    let output = { stdoutSeenBytes: 0, stderrSeenBytes: 0,
      retainedBytes: 0, droppedBytes: 0, complete: final.streams.stdout === 'drained' && final.streams.stderr === 'drained' }
    try { output = options.output?.() ?? output } catch { output.complete = false }
    output = { ...output, complete: output.complete && final.streams.stdout === 'drained' && final.streams.stderr === 'drained' }
    let launchFacts: CleanupResult['launchFacts']
    try { launchFacts = options.launchFacts?.() } catch { /* no fabricated identity */ }
    const next: CleanupResult = Object.freeze({
      attemptId, scopeId: options.scopeId, status: satisfied ? 'complete' : final.scopePresence === 'living' ? 'failed' : 'unknown',
      selectedTier: options.tier, observedTier: options.tier, satisfiesSelectedTier: satisfied,
      trigger: reason, originalDeadline: options.originalDeadline ?? { kind: 'unbounded' as const, limitId: options.scopeId },
      firstStopAtMs, killAtMs, observeUntilMs, signals: Object.freeze(signals), finalObservation: final,
      output: Object.freeze({ ...output }),
      cleanupAuthorityRetained: !satisfied,
      selectedLimitSatisfied: selectedLimit || (retry && missedLimit) ? satisfied && output.complete && !missedLimit : null,
      ...(!satisfied ? { cause: 'Covered scope cleanup was not fully observed within the fixed cleanup bound' } : {}),
      ...(launchFacts ? { launchFacts } : {}),
    })
    result = next
    inFlight = undefined
    // Observer callbacks cannot prevent cleanup result publication.
    try { options.onCleanup?.(next) } catch { /* host observation only */ }
    return next
  }
  const requestStop = (reason: StopReason, force = false, retry = false): Promise<CleanupResult> => {
    if (!result || retry) selectedLimitRequested ||= reason === 'deadline' || reason === 'owner-cancel' || reason === 'output-limit'
    forceRequested ||= force
    if (inFlight) { if (force) upgrade?.(); return inFlight }
    if (result && (!retry || result.status === 'complete')) return Promise.resolve(result)
    // Publish promise before any injected driver/callback can reenter.
    let resolve!: (result: CleanupResult) => void
    let reject!: (error: unknown) => void
    const pending = new Promise<CleanupResult>((yes, no) => { resolve = yes; reject = no })
    inFlight = pending
    void stop(reason, retry).then(resolve, reject)
    void pending.finally(() => { if (inFlight === pending) inFlight = undefined }).catch(() => undefined)
    return pending
  }
  const onAbort = () => {
    const deadline = (!!options.signal && isExecutionDeadlineSignal(options.signal)) ||
      options.remainingMs?.() === 0
    void requestStop(deadline ? 'deadline' : 'owner-cancel', deadline)
  }
  const armDeadline = () => {
    if (!options.remainingMs || result?.status === 'complete') return
    const remaining = options.remainingMs()
    if (remaining === null) return
    deadlineTimer = timers.set(Math.max(1, Math.min(2_147_483_647, Math.ceil(remaining))), () => {
      if ((options.remainingMs?.() ?? Infinity) <= 0) void requestStop('deadline', true)
      else armDeadline()
    })
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  armDeadline()
  if (options.signal?.aborted) onAbort()
  void options.driver.leaderExited.then(() => requestStop('normal-leader-exit'), () => requestStop('adapter-error'))
  return Object.freeze({ scopeId: options.scopeId, tier: options.tier, observe,
    requestStop: (reason: StopReason, force?: boolean) => requestStop(reason, force),
    retryCleanup: (force = true) => requestStop(result?.trigger ?? 'owner-shutdown', force, true),
    currentCleanup: () => result })
}
