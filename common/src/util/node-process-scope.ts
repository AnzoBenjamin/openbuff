import { randomUUID } from 'node:crypto'

import { captureLinuxProcessGroup } from './linux-process-scope'
import { createOwnedProcessScope, processScopeClock } from './owned-process-scope'

import type { ChildProcess } from 'node:child_process'
import type { OwnedProcessScope, ProcessScopeDriver, ProcessScopeOptions, ScopeObservation, ScopeStreams, ScopeTier } from '../types/contracts/process-scope'

export type NodeProcessScopeOptions = Omit<ProcessScopeOptions, 'scopeId' | 'tier' | 'driver'> & Readonly<{
  scopeId?: string
  /** Must come from the options captured before launch admission. */
  detached: boolean
}>

const injectedDrivers = new WeakMap<ChildProcess, ProcessScopeDriver>()
/** Trusted DI seam. Its receipts always say injected and grant no OS proof. */
export function registerInjectedNodeScopeDriver(child: ChildProcess, driver: ProcessScopeDriver): void {
  injectedDrivers.set(child, driver)
}

/** Attach inside dispatch, synchronously after obtaining the admitted child. */
export function createNodeProcessScope(child: ChildProcess, options: NodeProcessScopeOptions): OwnedProcessScope {
  const injected = injectedDrivers.get(child)
  if (injected) return createOwnedProcessScope({ ...options, scopeId: options.scopeId ?? randomUUID(),
    tier: 'injected', driver: injected })
  const clock = options.clock ?? processScopeClock
  const tier: ScopeTier = options.detached && process.platform === 'linux' ? 'posix-owned-group' : 'direct-child'
  const group = tier === 'posix-owned-group' && child.pid ? captureLinuxProcessGroup(child.pid) : undefined
  let reaped = child.exitCode !== null && child.exitCode !== undefined || child.signalCode !== null && child.signalCode !== undefined
  let closed = false
  let stdoutSeenBytes = 0
  let stderrSeenBytes = 0
  const streamState = { stdin: child.stdin ? 'open' : 'closed',
    stdout: child.stdout ? 'open' : 'drained', stderr: child.stderr ? 'open' : 'drained' } as {
      stdin: ScopeStreams['stdin']; stdout: ScopeStreams['stdout']; stderr: ScopeStreams['stderr']
    }
  let resolveExit!: (value: ScopeObservation['leader']) => void
  let resolveStreams!: (value: ScopeStreams) => void
  const leaderExited = new Promise<ScopeObservation['leader']>(resolve => { resolveExit = resolve })
  const streamsFinished = new Promise<ScopeStreams>(resolve => { resolveStreams = resolve })
  const checkStreams = () => {
    if (streamState.stdin === 'closed' && streamState.stdout !== 'open' && streamState.stderr !== 'open')
      resolveStreams({ ...streamState })
  }
  child.once('exit', () => { reaped = true; resolveExit('exited-reaped') })
  child.once('close', () => {
    closed = true
    // Node close follows exit or failed spawn. Runtime fake seams may only
    // emit close; that is direct-child evidence at their declared narrow tier.
    reaped = true
    resolveExit('exited-reaped')
    streamState.stdin = 'closed'
    for (const name of ['stdout', 'stderr'] as const) {
      if (streamState[name] === 'open') streamState[name] = child[name]?.readableEnded ? 'drained' : 'closed-incomplete'
    }
    checkStreams()
  })
  child.stdin?.once('close', () => { streamState.stdin = 'closed'; checkStreams() })
  for (const name of ['stdout', 'stderr'] as const) {
    const stream = child[name]
    stream?.on('data', (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      if (name === 'stdout') stdoutSeenBytes += bytes
      else stderrSeenBytes += bytes
    })
    stream?.once('end', () => { streamState[name] = 'drained'; checkStreams() })
    stream?.once('close', () => {
      if (streamState[name] === 'open') streamState[name] = stream?.readableEnded ? 'drained' : 'closed-incomplete'
      checkStreams()
    })
  }
  if (reaped) resolveExit('exited-reaped')
  const driver: ProcessScopeDriver = {
    leaderExited, streamsFinished,
    async observe() {
      const presence = group?.observe() ?? (tier === 'posix-owned-group'
        ? { scopePresence: 'unknown' as const, members: [], membershipComplete: false, identity: 'unknown' as const }
        : { scopePresence: reaped ? 'absent' as const : 'living' as const,
          members: [], membershipComplete: true, identity: 'verified' as const })
      if (group && reaped && presence.membershipComplete && presence.identity === 'verified' &&
        (presence.scopePresence === 'absent' || presence.scopePresence === 'zombie-only')) group.seal()
      return { sampledAtMs: clock.nowMs(), clockDomainId: clock.domainId,
        leader: reaped ? 'exited-reaped' : child.pid ? 'running' : closed ? 'exited-reaped' : 'not-started',
        ...presence, streams: { ...streamState } }
    },
    async signal(name) {
      if (group?.identity) return { ...group.signal(name), atMs: clock.nowMs() }
      const base: { signal: 'SIGTERM' | 'SIGKILL'; atMs: number; targetTier: ScopeTier } =
        { signal: name, atMs: clock.nowMs(), targetTier: tier }
      // The owned runtime handle still permits direct-child cancellation when
      // group identity was unavailable. This grants no broadcast authority or
      // selected-group completion evidence.
      if (tier === 'posix-owned-group') base.targetTier = 'direct-child'
      if (reaped) return { ...base, result: 'already-absent' }
      try { return { ...base, result: child.kill(name) ? 'delivered' : 'unknown' } }
      catch (error) { return { ...base, result: 'unknown', errorCode: (error as NodeJS.ErrnoException).code } }
    },
    closeInput() { child.stdin?.end?.(); if (!child.stdin) streamState.stdin = 'closed' },
    abandonStreams() {
      child.stdin?.destroy?.()
      child.stdout?.destroy?.()
      child.stderr?.destroy?.()
      if (streamState.stdout === 'open') streamState.stdout = 'closed-incomplete'
      if (streamState.stderr === 'open') streamState.stderr = 'closed-incomplete'
    },
  }
  return createOwnedProcessScope({ ...options, scopeId: options.scopeId ?? randomUUID(), tier, driver,
    output: options.output ?? (() => ({ stdoutSeenBytes, stderrSeenBytes, retainedBytes: 0,
      droppedBytes: 0, complete: streamState.stdout === 'drained' && streamState.stderr === 'drained' })) })
}
